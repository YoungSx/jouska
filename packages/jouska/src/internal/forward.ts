import type { Route } from '../config.js';
import { HOP_BY_HOP, stripConnectionNamed } from './hop.js';

/** Methods safe to replay after a failure. */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export const isRetryable = (method: string): boolean => IDEMPOTENT.has(method.toUpperCase());

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
 */
export const buildUpstreamHeaders = (
  request: Request,
  route: Route,
  target: URL,
  requestUrl: URL,
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
  target: URL;
  request: Request;
  /** Parsed request URL, so callers that already have one need not re-parse. */
  requestUrl: URL;
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
}

/** Raised when the combined budget for all attempts is spent. */
export class TotalTimeoutError extends Error {
  override readonly name = 'TotalTimeoutError';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Forwards a request upstream with a per-attempt deadline, a total deadline and
 * bounded retries with backoff.
 *
 * Retrying requires both an idempotent method and no request body. The method
 * alone is not enough: `OPTIONS` and `TRACE` are idempotent and may still carry
 * one, and a body stream is consumed by the first attempt.
 */
export const forward = async ({
  route,
  target,
  request,
  requestUrl,
  fetchImpl,
  detached = false,
}: ForwardOptions): Promise<Response> => {
  const fetcher = fetchImpl ?? fetch;
  const headers = buildUpstreamHeaders(request, route, target, requestUrl);
  const upgrade = route.websocket && isWebSocketUpgrade(request);
  // A body rules out replay whatever the method says. `OPTIONS` and `TRACE` are
  // idempotent yet may carry one, and the first attempt consumes the stream: the
  // second then throws `This ReadableStream is disturbed` inside `attemptFetch`,
  // before the network is touched. Measured in workerd, that cost one real
  // attempt out of three and — the part that misleads whoever is debugging —
  // replaced the genuine network error with that TypeError, because the retry
  // loop rethrows whatever failed last.
  const replayable = isRetryable(request.method) && request.body === null;
  const attempts = replayable && !upgrade ? route.retries + 1 : 1;

  const startedAt = Date.now();
  const remaining = (): number => route.totalTimeoutMs - (Date.now() - startedAt);
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      // Exponential backoff. Retrying immediately was measured at a 0–1ms gap,
      // which is long enough for nothing: whatever failed is still failing.
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

    try {
      // Attempts are deliberately sequential: running them in parallel would
      // fire N simultaneous upstream requests, which is both wasteful and
      // counter to the 6-connection-per-request cap.
      // oxlint-disable-next-line no-await-in-loop
      return await attemptFetch({
        request,
        target,
        headers,
        route,
        budget,
        upgrade,
        fetcher,
        detached,
      });
    } catch (error) {
      lastError = error;
      // The client hanging up is not a fault to retry: nobody is waiting.
      if (error instanceof Error && error.name === 'AbortError') {
        break;
      }
    }
  }
  // Note: only network failures and timeouts throw. An HTTP 5xx from the
  // upstream is a normal Response and is never retried — replaying it would
  // pile load onto a struggling origin for no expected benefit.
  throw lastError;
};

interface AttemptOptions {
  request: Request;
  target: URL;
  headers: Headers;
  route: Route;
  budget: number;
  upgrade: boolean;
  fetcher: typeof fetch;
  detached: boolean;
}

/**
 * One upstream attempt.
 *
 * The deadline is combined with the client's own signal via `AbortSignal.any`,
 * so a visitor closing the tab cancels the upstream request instead of leaving
 * it to run out its full timeout — verified against workerd, passing only
 * `AbortSignal.timeout` left the upstream oblivious to a client abort. The two
 * are distinguishable afterwards: the reason is `AbortError` for the client and
 * `TimeoutError` for the deadline.
 */
const attemptFetch = async ({
  request,
  target,
  headers,
  route,
  budget,
  upgrade,
  fetcher,
  detached,
}: AttemptOptions): Promise<Response> => {
  const signals: AbortSignal[] = [AbortSignal.timeout(budget)];
  if (!detached && request.signal !== null && request.signal !== undefined) {
    signals.push(request.signal);
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

  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null) {
    init.body = request.body;
    // Required for a stream body: the request is sent before the response is read.
    (init as { duplex?: string }).duplex = 'half';
  }

  return fetcher(new Request(target.toString(), init));
};
