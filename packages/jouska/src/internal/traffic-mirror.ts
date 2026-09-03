import type { MirrorConfig, Route } from '../config.js';
import { buildUpstreamHeaders, isWebSocketUpgrade } from './forward.js';
import { inSample } from './selection.js';
import { resolveUpstreamUrl, type Match } from '../router.js';

/**
 * Name of the marker stamped onto every mirrored request, so an upstream can
 * tell the copy from the real one. A constant here rather than a config field
 * for the reason `x-request-id` is: the name is reserved
 * (`RESERVED_REQUEST_HEADERS`), and a reserved name must be pinned where the
 * schema that refuses it can see it as a literal.
 */
export const MIRROR_HEADER = 'x-jouska-mirror';

/**
 * The memory a mirrored body may occupy per request.
 *
 * 256 KiB. Copying a body means buffering it: the request body is a one-shot
 * stream the primary walk consumes, so the mirror needs its own copy, and
 * `tee()` does not buffer for free — an unread branch holds whatever the source
 * pushes. A hundred concurrent uploads at the cap are 25 MB against the 128MB
 * isolate, and the paid plan does not raise that. Past the cap the *mirror* is
 * abandoned, never the request: the whole point of mirroring is that the copy
 * cannot take the visitor down with it.
 */
export const MIRROR_BODY_MAX_BYTES = 262_144;

/** How one mirrored request ended, as carried on `ProxyEvent.mirror`. */
export interface MirrorReport {
  /** The mirror target, as an authority. */
  readonly upstream: string;
  /**
   * `answered` when the target responded at all — its status code is its own
   * business and the copy's response is discarded either way; `timeout` when
   * `mirror.timeoutMs` expired; `unreachable` when it could not be reached;
   * `body_over_limit` when the copy was abandoned for want of a bounded body.
   */
  readonly outcome: 'answered' | 'timeout' | 'unreachable' | 'body_over_limit';
  /** Wall-clock milliseconds from start to the outcome above. */
  readonly durationMs: number;
}

/**
 * Everything one mirrored request needs. Built once per request, on the path
 * that decided to mirror, and handed to {@link startMirror} to run detached.
 */
export interface MirrorPlan {
  route: Route;
  /** The mirror block, parsed. */
  config: MirrorConfig;
  /** The client request, whose method and headers the copy inherits. */
  request: Request;
  /** The path and query the copy is sent to. */
  target: URL;
  /** The request ID, stamped so both upstreams' logs correlate. */
  requestId: string;
  /**
   * The tee'd body copy, when the route mirrors bodies. Buffering it is the
   * pump's job, and only the caller knows the primary walk is about to consume
   * the other branch.
   */
  body?: ReadableStream<Uint8Array>;
  /** Injected in tests; production uses the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * True when the method carries a body worth copying. GET and HEAD are the
 * mirror defaults precisely because they answer "no" here, which is what keeps
 * `tee()` off the hot path until someone opts into bodies.
 */
const carriesBody = (request: Request): boolean =>
  request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null;

/**
 * Drains a tee'd branch into memory, up to {@link MIRROR_BODY_MAX_BYTES}.
 *
 * Eagerly, not lazily: `tee()` couples the branches' backpressure, so a copy
 * nobody reads would stall the primary the moment its buffer filled. This pump
 * runs in the background from the moment the mirror is planned, which keeps the
 * client's upload moving at its own pace regardless of how slow the mirror
 * target is.
 *
 * Streaming the branch straight into the mirror fetch was considered and
 * rejected for the same coupling: a mirror target slower than the client would
 * throttle the visitor's upload, which is the exact risk mirroring exists to
 * avoid.
 *
 * Resolves `undefined` on both failures — past the cap, and on a read that
 * rejects (a client hang-up mid-upload does that) — because from the report's
 * point of view both mean "there was no body worth sending". Cancelling the
 * branch is safe for the other one: that is what `tee()` guarantees.
 */
const pumpBody = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array | undefined> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MIRROR_BODY_MAX_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel();
    return undefined;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

/**
 * Sends the copy and reports how it went. Resolved, never rejected: a mirror
 * failure is the one thing the design refuses to let reach anything that
 * matters, and a rejecting promise riding on `ProxyEvent` would punish whoever
 * awaited it — the same discipline that keeps `onProxy` throws swallowed.
 *
 * The copy is a deliberately minimal request. It carries the client's headers
 * (minus hop-by-hop, built by the same builder the primary uses, so the strips
 * cannot drift between them) and the client's identity via delegated auth is
 * absent by design — the mirror does not run the auth exchange again, and a
 * target that rejects unauthenticated copies is telling the operator something
 * useful about itself. It follows no redirects (`redirect: 'manual'`, so a
 * 302 is recorded rather than chased into a host nobody validated), joins no
 * cache, writes no sticky cookie and participates in no failover. Its response
 * body is cancelled unread: reading it would spend memory on bytes whose only
 * consumer is a decision to throw them away.
 *
 * The client's abort signal is deliberately not attached. The copy is detached
 * by construction — a visitor who hangs up mid-request has no interest in
 * whether v2 saw their upload, and attaching the signal would make the mirror's
 * own `timeoutMs` the only deadline a hang-up cannot outrun.
 */
export const startMirror = (plan: MirrorPlan): Promise<MirrorReport> => {
  const startedAt = Date.now();
  return new Promise<MirrorReport>((resolve) => {
    void (async () => {
      const finish = (outcome: MirrorReport['outcome']): void =>
        resolve({
          upstream: plan.target.host,
          outcome,
          durationMs: Date.now() - startedAt,
        });

      const headers = buildUpstreamHeaders(
        plan.request,
        plan.route,
        plan.target,
        new URL(plan.request.url),
        undefined,
        plan.requestId,
      );
      headers.set(MIRROR_HEADER, '1');

      // A bodyless copy of a bodied request must not claim a length it has: the
      // copied `content-length` would describe bytes that never arrive, and the
      // target is within its rights to hang waiting for them.
      const hadBody = carriesBody(plan.request);
      let body: Uint8Array | undefined;
      if (plan.body !== undefined) {
        body = await pumpBody(plan.body);
        if (body === undefined) {
          finish('body_over_limit');
          return;
        }
      } else if (hadBody) {
        headers.delete('content-length');
      }

      try {
        const init: RequestInit = {
          method: plan.request.method,
          headers,
          signal: AbortSignal.timeout(plan.config.timeoutMs),
          redirect: 'manual',
          ...(hadBody && body !== undefined ? { body } : {}),
        };
        // Required for a stream body; a buffered one does not need it, but the
        // runtime accepts it and one spelling for every body is less to drift.
        if (hadBody && body !== undefined) {
          (init as { duplex?: string }).duplex = 'half';
        }
        const response = await (plan.fetchImpl ?? fetch)(new Request(plan.target.toString(), init));
        // Discarded unread, on purpose and on every status: the mirror's status
        // code is a fact about v2 that only v2's own metrics can explain.
        try {
          await response.body?.cancel();
        } catch {
          // Cancelling an already-closed body throws harmlessly.
        }
        finish('answered');
      } catch (error) {
        // `AbortSignal.timeout` aborts with a `TimeoutError` DOMException; a
        // refusal is anything else.
        finish(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable');
      }
    })();
  });
};

/**
 * Decides whether one request is mirrored, and plans the copy if so.
 *
 * Every condition here narrows, never widens: the route must carry a `mirror`
 * block, the method must be one the operator listed, a WebSocket upgrade is
 * never copied (its body is the socket, and `tee()` has no answer for that),
 * and the request must fall inside `percent`. The sample is hashed over the
 * request ID — per-request uniform, and recomputable from the event afterwards.
 *
 * Called after the guards on purpose: a refused request is not traffic, and
 * mirroring what jouska itself would not forward would be sending an attacker's
 * probe to a second host for no reason. The body tee, when it happens, happens
 * here and synchronously — after this point the primary walk consumes the
 * request body and there is nothing left to copy.
 */
export const planMirror = (
  match: Match,
  request: Request,
  requestId: string,
  fetchImpl: typeof fetch | undefined,
): { plan: MirrorPlan; request: Request } | undefined => {
  const { route } = match;
  const mirror = route.mirror;
  if (
    mirror === undefined ||
    !mirror.methods.includes(request.method) ||
    isWebSocketUpgrade(request) ||
    !inSample(requestId, mirror.percent)
  ) {
    return undefined;
  }

  if (mirror.includeBody && carriesBody(request)) {
    // The main branch goes on serving the primary walk; the copy is drained in
    // the background. Rebuilt rather than mutated, because `request.body` is a
    // one-shot stream and handing forward the tee'd branch is the only way both
    // sides read the same bytes.
    const [main, copy] = request.body!.tee();
    return {
      plan: {
        route,
        config: mirror,
        request,
        target: resolveUpstreamUrl(match, new URL(request.url), mirror.upstream),
        requestId,
        body: copy,
        ...(fetchImpl !== undefined ? { fetchImpl } : {}),
      },
      request: (() => {
        const init: RequestInit = {
          method: request.method,
          headers: request.headers,
          body: main,
          signal: request.signal,
        };
        // Required for a stream body: the request is sent before the response
        // is read.
        (init as { duplex?: string }).duplex = 'half';
        return new Request(request.url, init);
      })(),
    };
  }

  return {
    plan: {
      route,
      config: mirror,
      request,
      target: resolveUpstreamUrl(match, new URL(request.url), mirror.upstream),
      requestId,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    },
    request,
  };
};
