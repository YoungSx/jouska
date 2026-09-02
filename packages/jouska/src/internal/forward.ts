import type { Route } from '../config.js';
import { HOP_BY_HOP, stripConnectionNamed } from './hop.js';
import type { OutlierObserver } from './outlier.js';

/** Methods safe to replay after a failure. */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export const isRetryable = (method: string): boolean => IDEMPOTENT.has(method.toUpperCase());

/** Raised when a request body grew past the route's `maxBodyBytes` mid-upload. */
export class BodyLimitError extends Error {
  override readonly name = 'BodyLimitError';
  constructor(readonly limitBytes: number) {
    super(`request body exceeded maxBodyBytes=${limitBytes}`);
  }
}

/**
 * Wraps a request body in a counting stream, so a body that passes the ceiling
 * is cut off mid-flight.
 *
 * This is the only enforcement that works without `Content-Length` — a chunked
 * upload declares no size — and it never buffers: chunks pass through untouched
 * and are merely counted, so the memory cost is one chunk either way. What it
 * cannot do is unsend: bytes already handed to `fetch` before the ceiling was
 * crossed may reach the upstream, which is why a request that declares its size
 * is refused earlier, before anything is forwarded at all.
 */
const countedBody = (
  body: ReadableStream<Uint8Array>,
  limitBytes: number,
  onOverflow: () => void,
): ReadableStream<Uint8Array> => {
  let total = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > limitBytes) {
          onOverflow();
          // Erroring the readable side aborts the upstream upload; whatever the
          // runtime reports from that is replaced below by the shared flag,
          // because a body-stream failure does not reliably surface as the
          // error thrown here.
          controller.error(new BodyLimitError(limitBytes));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
};

/**
 * Builds the outbound headers.
 *
 * Starts from a copy of the client's own headers, which is the whole point:
 * passing a plain object to `new Request(raw, { headers })` *replaces* the set
 * rather than merging it — verified against workerd, the upstream then saw only
 * the three forwarding headers, with `authorization`, `cookie`, `content-type`
 * and `user-agent` all silently dropped. Any API needing a bearer token, and any
 * site needing a session, was broken by construction.
 *
 * Order matters: the route's own rules are applied first, then the forwarding
 * headers overwrite them, so a rule cannot forge `Host` or `X-Forwarded-For`. The
 * schema also refuses those names outright, making this belt and braces.
 *
 * Built per candidate, not once for the list: `host` names the target, so
 * forwarding a rebuilt header set at a different origin would announce the
 * wrong host to every upstream after the first.
 */
export const buildUpstreamHeaders = (
  request: Request,
  route: Route,
  target: URL,
  requestUrl: URL,
  authHeaders?: Headers,
): Headers => {
  const headers = new Headers(request.headers);

  // A client-supplied Connection header names further headers to drop. Honour
  // it before stripping, so a smuggled `Connection: X-Secret` cannot survive.
  stripConnectionNamed(headers);
  for (const name of HOP_BY_HOP) {
    headers.delete(name);
  }

  // A route with WebSockets off must not merely decline to special-case them:
  // relaying the handshake would still let the upstream answer 101, so the
  // option would have no effect. Removing the headers makes it a plain request.
  if (!route.websocket) {
    for (const name of [
      'upgrade',
      'sec-websocket-key',
      'sec-websocket-version',
      'sec-websocket-protocol',
      'sec-websocket-extensions',
    ] as const) {
      headers.delete(name);
    }
  }

  // Bodies must arrive uncompressed: the body rewriter would otherwise be
  // scanning compressed bytes and silently do nothing.
  headers.delete('accept-encoding');

  // The operator's declarative rules. Deletions run before writes: the schema
  // refuses a name that appears in both, so the order is not observable today,
  // but "clear it, then write it" is the only reading that stays correct if that
  // ever relaxes.
  const rules = route.requestHeaders;
  if (rules !== undefined) {
    for (const name of rules.remove) {
      headers.delete(name);
    }
    for (const [name, value] of Object.entries(rules.set)) {
      headers.set(name, value);
    }
  }

  // Identity headers the delegated-auth pass designated, written after the
  // route's own rules so the auth service's per-caller answer outranks a
  // blanket one. The schema refuses reserved names in `copyResponseHeaders`,
  // so these can never touch the forwarding headers written below.
  authHeaders?.forEach((value, name) => {
    headers.set(name, value);
  });

  headers.set('host', target.host);
  headers.set('x-forwarded-host', requestUrl.host);
  headers.set('x-forwarded-proto', requestUrl.protocol.replace(':', ''));

  // Cloudflare writes the visitor's real TCP source address into
  // `cf-connecting-ip`, which a client cannot forge. Forward it as
  // `x-forwarded-for`, overwriting any value the client sent: an untrusted XFF
  // chain is worse than none, and appending to it only helps if the upstream
  // knows to trust the rightmost entry — most do not.
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp !== null) {
    headers.set('x-forwarded-for', clientIp);
  } else {
    // No trustworthy value, so leave nothing behind that looks like one.
    headers.delete('x-forwarded-for');
  }
  return headers;
};

/** True when the request is a WebSocket upgrade handshake. */
export const isWebSocketUpgrade = (request: Request): boolean =>
  request.headers.get('upgrade')?.toLowerCase() === 'websocket';

export interface ForwardOptions {
  route: Route;
  /**
   * Ordered candidates: the first is the primary, the rest are backups the
   * failover walk may reach. A single-element list is the plain case.
   */
  targets: readonly URL[];
  request: Request;
  /** Parsed request URL, so callers that already have one need not re-parse. */
  requestUrl: URL;
  /**
   * Identity headers from a passed forward-auth check, written into every
   * upstream attempt after the route's own rules. Absent when the route does
   * not delegate auth, or the pass designated nothing.
   */
  authHeaders?: Headers;
  /** Overridable for tests; defaults to the runtime `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Ignore the client's abort signal.
   *
   * For work that must outlive the connection that triggered it — a
   * stale-while-revalidate refresh being the case this exists for. With the
   * client's signal attached, the visitor closing the tab would cancel the
   * revalidation and leave the stale entry to be served again.
   */
  detached?: boolean;
  /**
   * Cross-request failure memory, when the route has one. Absent for
   * single-upstream routes, where there is no backup to prefer.
   */
  outlier?: OutlierObserver;
}

export interface ForwardResult {
  response: Response;
  /**
   * The candidate that produced `response`. Response rewrites and failure
   * reports follow whichever candidate actually answered, not the one that
   * started the walk.
   */
  target: URL;
  /**
   * Cuts the connection this response is still streaming over.
   *
   * Handed out because the deadlines that apply to a body are the caller's to
   * enforce — it is the one that knows whether a byte has arrived — while the
   * socket belongs to the attempt that opened it. Without this the caller could
   * stop reading but not stop the upstream, which for a metered API means it
   * keeps generating, and paying, into a stream nobody will read.
   *
   * The reason's `name` reaches the body stream's error; its identity does not.
   * Verified in workerd: `abort(new IdleError())` surfaced with the right `name`
   * and `message` on the reader, but `instanceof` was false, because the runtime
   * rebuilds the error crossing that boundary. So a caller distinguishing its own
   * deadline from a client hang-up compares `name`, never `instanceof`.
   *
   * A no-op once the exchange is over, and safe to call twice.
   */
  abort: (reason: Error) => void;
}

/** Raised when the combined budget for all attempts is spent. */
export class TotalTimeoutError extends Error {
  override readonly name = 'TotalTimeoutError';
}

/**
 * Raised when an attempt did not produce response headers within `timeoutMs`.
 *
 * Named `TimeoutError` rather than after the class, because that name is what
 * `failover.on: ['timeout']` matches and what `AbortSignal.timeout` used to
 * produce here. The class exists so this file can raise the condition itself:
 * `AbortSignal.timeout` cannot be cancelled once created, so the signal that
 * bounded the headers went on to fire mid-body — see {@link attemptFetch}.
 */
class HeadTimeoutError extends Error {
  override readonly name = 'TimeoutError';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The attempt plan: which targets are tried, in order.
 *
 * A single target keeps the classic semantics — an idempotent, bodyless request
 * is retried against the same upstream `retries` times, whatever went wrong.
 * Several targets switch to failover semantics: each candidate is tried once
 * (listing the same upstream twice is how a same-upstream retry is spelled in a
 * failover list), capped by the policy's `maxAttempts`.
 *
 * A body or a WebSocket handshake gets one attempt regardless: the body stream
 * is consumed by the first attempt, and a socket is not replayable at all.
 */
const attemptPlan = (route: Route, targets: readonly URL[], walkable: boolean): URL[] => {
  if (!walkable) {
    return [targets[0]!];
  }
  if (targets.length > 1) {
    return targets.slice(
      0,
      Math.min(route.failover?.maxAttempts ?? targets.length, targets.length),
    );
  }
  return Array.from({ length: route.retries + 1 }, () => targets[0]!);
};

/**
 * Forwards a request upstream with a per-attempt deadline, a total deadline and
 * bounded retries — against one upstream, or walked across several in order.
 *
 * Failover is strictly sequential: the next candidate only sees the request
 * after the previous one failed with a condition the route's `failover.on`
 * names, and only while the request is still replayable. There is no racing —
 * Workers allows 6 concurrent outbound connections per request, and firing N
 * upstreams at once spends that budget on duplicates of the same request.
 *
 * An HTTP 5xx is a normal response and by default ends the walk; adding `'5xx'`
 * to `failover.on` opts in, and only while the request can still be replayed.
 * The latest 5xx seen is kept as a fallback, body included, so a walk that ends
 * without any candidate answering still returns a real upstream verdict rather
 * than inventing a 502 for one.
 *
 * When an `outlier` observer is supplied, candidates it reports as ejected are
 * removed from the plan before the walk, and every counted failure and every
 * healthy answer is reported back to it — the memory lives with the caller,
 * this file stays stateless.
 */
export const forward = async ({
  route,
  targets,
  request,
  requestUrl,
  authHeaders,
  fetchImpl,
  detached = false,
  outlier,
}: ForwardOptions): Promise<ForwardResult> => {
  const fetcher = fetchImpl ?? fetch;
  const upgrade = route.websocket && isWebSocketUpgrade(request);
  // A body rules out replay whatever the method says. `OPTIONS` and `TRACE` are
  // idempotent yet may carry one, and the first attempt consumes the stream: the
  // second then throws `This ReadableStream is disturbed` inside `attemptFetch`,
  // before the network is touched. Measured in workerd, that cost one real
  // attempt out of three and — the part that misleads whoever is debugging —
  // replaced the genuine network error with that TypeError, because the retry
  // loop rethrows whatever failed last.
  const replayable = isRetryable(request.method) && request.body === null;
  const walkable = replayable && !upgrade;
  const proposed = attemptPlan(route, targets, walkable);
  // Ejected candidates are removed from the walk, not merely deprioritised:
  // the point is that the survivor moves up without a second pass. When every
  // candidate is out, the filter alone would produce an empty walk, so the
  // declared head is restored — ejection only reorders, it must never make a
  // route unreachable. This is also why the removal happens here and not in
  // the caller: the non-empty guarantee is written once.
  const plan =
    outlier === undefined ? proposed : proposed.filter((target) => !outlier.isEjected(target.host));
  const live = plan.length > 0 ? plan : [proposed[0]!];
  const policy = route.failover?.on;
  // The switch conditions only govern movement between distinct candidates. A
  // single-upstream route has no `failover` policy at all, and its retries
  // repeat the same upstream on any failure — the behaviour this file has
  // always had.
  const switching = walkable && targets.length > 1;

  const startedAt = Date.now();
  const remaining = (): number => route.totalTimeoutMs - (Date.now() - startedAt);
  let lastError: unknown;
  let held: ForwardResult | undefined;

  // The body-size ceiling, watched on the stream itself. A body rules out replay
  // whatever the method says, so the counting wrapper is built at most once and
  // only the single attempt that carries a body can ever read it. An upgrade has
  // no body to count.
  const limit = route.requestPolicy?.maxBodyBytes;
  const carriesBody =
    request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null;
  let overflow: number | undefined;
  // Tripping the limit has to reach the outbound request as an abort, not merely
  // a flag: the upload is still in flight while `fetch` is awaiting the response,
  // and a flag alone leaves the bytes past the ceiling flowing to the upstream.
  // Aborting cuts the socket at the source. The flag is still kept — it is how
  // the error is identified as this condition and not a plain client hang-up.
  const overflowAbort = new AbortController();
  const outboundBody =
    limit !== undefined && carriesBody && !upgrade && request.body !== null
      ? countedBody(request.body, limit, () => {
          overflow = limit;
          overflowAbort.abort();
        })
      : request.body;

  for (let attempt = 0; attempt < live.length; attempt += 1) {
    const target = live[attempt]!;
    if (attempt > 0 && target.host === live[attempt - 1]!.host) {
      // Exponential backoff, and only when the previous attempt hit the same
      // origin: that is the case where "whatever failed is still failing" was
      // measured at a 0–1ms retry gap. A different candidate is a different
      // origin with a different failure — waiting before trying it only adds
      // latency to the recovery.
      const delay = route.retryBackoffMs * 2 ** (attempt - 1);
      if (delay >= remaining()) {
        break;
      }
      if (delay > 0) {
        // oxlint-disable-next-line no-await-in-loop
        await sleep(delay);
      }
    }

    const budget = Math.min(route.timeoutMs, remaining());
    if (budget <= 0) {
      lastError = new TotalTimeoutError(
        `upstream did not respond within totalTimeoutMs=${route.totalTimeoutMs}`,
      );
      break;
    }

    const headers = buildUpstreamHeaders(request, route, target, requestUrl, authHeaders);
    try {
      // Attempts are deliberately sequential: running them in parallel would
      // fire N simultaneous upstream requests, which is both wasteful and
      // counter to the 6-connection-per-request cap.
      // oxlint-disable-next-line no-await-in-loop
      const { response, abort } = await attemptFetch({
        request,
        body: outboundBody,
        target,
        headers,
        route,
        budget,
        upgrade,
        fetcher,
        detached,
        overflowSignal: overflowAbort.signal,
      });
      if (overflow !== undefined) {
        // Headers arrived before the ceiling was crossed — an upstream that
        // answered without reading the whole body. The body still grew past the
        // limit, so the verdict is ours to give rather than the upstream's:
        // drop what it sent and refuse.
        response.body?.cancel();
        lastError = new BodyLimitError(overflow);
        break;
      }
      if (
        switching &&
        policy?.includes('5xx') === true &&
        response.status >= 500 &&
        response.status <= 599
      ) {
        // Keep only the latest 5xx: if every candidate fails this way, the last
        // one is the real upstream verdict the client should see, body and all.
        // At most one stream is held during the walk, which totalTimeoutMs
        // bounds; the one it supersedes is released rather than leaked.
        if (outlier !== undefined) {
          outlier.onFailure(target.host);
        }
        held?.response.body?.cancel();
        held = { response, target, abort };
        continue;
      }
      // A candidate answered outside the held 5xx: the walk ends here, and the
      // held stream — never going to be read — has to be released before its
      // upstream connection sits idle until garbage collection.
      held?.response.body?.cancel();
      if (outlier !== undefined && response.status < 500) {
        // Only a sub-5xx answer is evidence of health: a 5xx is the same fault
        // the ejection exists to remember, whatever the route's switch policy
        // decided to do about it this request.
        outlier.onSuccess(target.host);
      }
      return { response, target, abort };
    } catch (error) {
      lastError = error;
      // An aborted upload surfaces as AbortError, which is otherwise the client
      // hanging up. The flag tells the two apart: a body past its ceiling is the
      // client's doing, and neither retrying nor failing over can make it smaller.
      if (overflow !== undefined) {
        lastError = new BodyLimitError(overflow);
        break;
      }
      // The client hanging up is not a fault to retry: nobody is waiting.
      if (error instanceof Error && error.name === 'AbortError') {
        break;
      }
      // A body past its ceiling is the client's doing, not the upstream's:
      // neither retrying nor failing over can make it smaller.
      if (error instanceof BodyLimitError) {
        break;
      }
      if (!switching) {
        // Same-upstream retries: every failure is worth another attempt, the
        // behaviour this loop had before failover existed.
        continue;
      }
      const condition =
        error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable';
      if (!policy?.includes(condition)) {
        break;
      }
      // Counted only when the failure actually moves the walk: a condition the
      // policy does not name stops this request anyway, so recording it would
      // eject a candidate over a fault the operator's own policy dismisses.
      // The client abort above broke out before this line — a visitor hanging
      // up says nothing about the upstream.
      if (outlier !== undefined) {
        outlier.onFailure(target.host);
      }
    }
  }
  if (held !== undefined) {
    return held;
  }
  throw lastError;
};

interface AttemptOptions {
  request: Request;
  /**
   * The body handed to the outbound request — the client's own, or a counting
   * wrapper around it when the route sets `maxBodyBytes`. Separate from
   * `request` because the wrapper may only be built once and may not be re-read
   * by a second attempt.
   */
  body: ReadableStream<Uint8Array> | null;
  target: URL;
  headers: Headers;
  route: Route;
  budget: number;
  upgrade: boolean;
  fetcher: typeof fetch;
  detached: boolean;
  /**
   * Aborts when the counted body trips its ceiling mid-upload. Unlike the
   * client's signal, it survives `detached`: cutting an oversized body is the
   * route's policy, not the visitor's presence.
   */
  overflowSignal?: AbortSignal;
}

/**
 * One upstream attempt, returning the response and the handle that cuts its
 * connection.
 *
 * The deadline is ours to fire rather than `AbortSignal.timeout`'s, because that
 * signal cannot be cancelled once created: it bounded the headers and then went
 * on to fire mid-body, cutting a streaming response at a deadline documented as
 * per-attempt. Verified — an 8-event SSE stream spanning 400ms under
 * `timeoutMs: 150` reached the client as `200 OK`, two events and a dead socket,
 * with the event reporting a successful 200. A timer we own is cleared the moment
 * headers arrive, and the same controller then stays available for the body's own
 * deadlines.
 *
 * The client's signal is combined in via `AbortSignal.any`, so a visitor closing
 * the tab cancels the upstream request instead of leaving it to run out its full
 * timeout — verified against workerd, passing only the deadline left the upstream
 * oblivious to a client abort. The two remain distinguishable afterwards:
 * `AbortError` for the client, `TimeoutError` for the deadline.
 */
const attemptFetch = async ({
  request,
  body,
  target,
  headers,
  route,
  budget,
  upgrade,
  fetcher,
  detached,
  overflowSignal,
}: AttemptOptions): Promise<{ response: Response; abort: (reason: Error) => void }> => {
  const controller = new AbortController();
  // Fires only while the headers are outstanding; cleared below the moment they
  // arrive, which is what makes this cancellable where `AbortSignal.timeout` is
  // not.
  let headDeadline: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    headDeadline = undefined;
    controller.abort(
      new HeadTimeoutError(`upstream did not send response headers within timeoutMs=${budget}`),
    );
  }, budget);
  const clearHeadDeadline = (): void => {
    if (headDeadline !== undefined) {
      clearTimeout(headDeadline);
      headDeadline = undefined;
    }
  };

  const signals: AbortSignal[] = [controller.signal];
  if (!detached && request.signal !== null && request.signal !== undefined) {
    signals.push(request.signal);
  }
  if (overflowSignal !== undefined) {
    signals.push(overflowSignal);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0]!,
    // Ask for the redirect rather than following it, so `Location` can be
    // rewritten onto the proxy. Verified against the real network: `fetch`
    // follows redirects by default, which meant the rewrite never ran and the
    // visitor silently ended up on the upstream origin.
    ...(route.manualRedirect && !upgrade ? { redirect: 'manual' as const } : {}),
  };

  if (request.method !== 'GET' && request.method !== 'HEAD' && body !== null) {
    init.body = body;
    // Required for a stream body: the request is sent before the response is read.
    (init as { duplex?: string }).duplex = 'half';
  }

  try {
    const response = await fetcher(new Request(target.toString(), init));
    // Headers are in. The head deadline has done its job and must not be left
    // armed: it would otherwise fire into the body that is still streaming.
    clearHeadDeadline();
    return {
      response,
      abort: (reason) => {
        controller.abort(reason);
      },
    };
  } catch (error) {
    // A failed attempt is followed by a retry or a throw; either way this timer
    // has nothing left to bound.
    clearHeadDeadline();
    throw error;
  }
};
