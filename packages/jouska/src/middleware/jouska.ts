import type { Context, MiddlewareHandler } from 'hono';
import type { CacheConfig, Config, Route } from '../config.js';
import {
  contentTypeAllowed,
  htmlRewriter,
  isStreamingMedia,
  parseContentType,
  resolveCharset,
  textRewriteStream,
  type ContentType,
  type Replacement,
} from '../internal/body.js';
import { checkAccess } from '../internal/access.js';
import { routeAuthenticates, runAuthGuards } from '../internal/auth.js';
import { BodyLimitError, forward } from '../internal/forward.js';
import { checkRateLimit, corsMiddleware, ipMiddleware } from '../internal/guards.js';
import { ledgerFor, outlierObserver } from '../internal/outlier.js';
import { resolveRequestId, stampRequestId } from '../internal/request-id.js';
import { limitsFor, limitsObserver } from '../internal/limits.js';
import type { LimitsObserver } from '../internal/limits.js';
import {
  applyResponseHeaderRules,
  rewriteResponseHeaders,
  stripBodyValidators,
  stripHopByHop,
  upstreamHostMatcher,
} from '../internal/headers.js';
import {
  CACHE_STATE_HEADER,
  cacheKey,
  readCachedResponse,
  beginFlight,
  joinFlight,
  refreshOnce,
  requestCacheable,
  responseCacheable,
  routeFingerprint,
  storeCachedResponse,
  cacheVaryPart,
  type CacheState,
  type CachedResponse,
  type ResponseCacheStore,
} from '../internal/response-cache.js';
import { stickyCookie, selectUpstream, type Selection } from '../internal/selection.js';
import { watchStream, type StreamReport } from '../internal/stream-watch.js';
import {
  matchUrl,
  resolveUpstreamUrl,
  routeId,
  splitUpstream,
  upstreamCandidates,
  type Match,
} from '../router.js';

/**
 * Why a response body was relayed instead of rewritten.
 *
 * Each of these was silent, and that silence is the whole problem: a mirrored
 * site whose links still point at the origin is indistinguishable from one whose
 * links were rewritten until a visitor clicks one and leaves. Five different
 * causes used to collapse into the same absence of any signal.
 *
 * - `not_configured` — the route has no `bodyRewrite` at all.
 * - `bodyless_status` — 204, 206 or 304; see {@link NO_REWRITE_STATUSES}.
 * - `no_body` — the response carried no body stream, as the answer to a HEAD
 *   does. Distinct from `bodyless_status`, where the status itself forbids a
 *   body: here the status permits one and none arrived.
 * - `content_type` — the type is outside `bodyRewrite.contentTypes`.
 * - `streaming_media` — the type is one whose whole value is arriving
 *   incrementally; see `isStreamingMedia`. Refused whatever the
 *   route's `contentTypes` says, which is why it is a reason of its own.
 * - `charset_undecodable` — a declared charset this runtime cannot decode, with
 *   no usable `fallbackCharset`. The hardest of the five to diagnose: the config
 *   reads correctly, the page renders, and the links simply do not change.
 * - `served_from_cache` — the response came from the route's response cache, so
 *   no rewrite ran on this request. The bytes were rewritten when the entry was
 *   stored, under the configuration that produced it; the cache key carries a
 *   fingerprint of that configuration, so an entry cannot outlive it. This reason
 *   exists so a caching route's rewrite rate does not read as broken: without it,
 *   every hit would report `bodyRewritten: false` with no way to tell that apart
 *   from a rewrite that never got configured.
 */
export type RewriteSkipReason =
  | 'not_configured'
  | 'bodyless_status'
  | 'no_body'
  | 'content_type'
  | 'streaming_media'
  | 'charset_undecodable'
  | 'served_from_cache';

/**
 * Why this request's walk made fewer attempts than `retries` would have allowed,
 * or was refused at the in-flight gate. Absent when the route states no
 * `limits`, and absent when nothing was held back — a degradation that cannot be
 * told apart from `retries: 0` is the exact "config written but not in effect"
 * silence this field exists to end.
 */
export type LimitReason = 'retry_budget' | 'in_flight';

/** What happened to one proxied request. Passed to `onProxy`. */
export interface ProxyEvent {
  /** The route that matched, labelled the way rate-limit buckets are. */
  routeId: string;
  /**
   * The ID the request is identified by — the value the client received, the
   * value the upstream received, and the key that ties the access log to both.
   *
   * `cf-ray` when the edge supplied one, otherwise a UUID, unless the route
   * opted into `trustInbound` and the caller sent a value of the accepted
   * shape. It lives here and in the access log only: analytics indexes it, and
   * per-request cardinality there would make every query one of two shapes —
   * "this exact request" or "nothing". A `respond` route still resolves one,
   * so an edge answer is traceable the same way a forwarded request is.
   */
  requestId: string;
  /**
   * Upstream authority the request was sent to. Empty for a `respond` route,
   * which answered at the edge and contacted nothing — an empty authority is
   * the event's own statement that there is no upstream to blame or probe.
   */
  upstream: string;
  method: string;
  /** Path as the client wrote it, before any normalisation. */
  path: string;
  /** Status returned to the client, including jouska's own 4xx/5xx. */
  status: number;
  /** Wall-clock milliseconds from match to response. */
  durationMs: number;
  /** Attempts made against the upstream, including the first. */
  attempts: number;
  /**
   * Set when the request never reached a normal response, plus `responded` for
   * a `respond` route, which produced a normal response without one.
   */
  outcome: 'ok' | 'refused' | 'timeout' | 'unreachable' | 'client_closed' | 'responded';
  /**
   * True when the body was handed to the rewriter.
   *
   * States that the transform was installed, not that it finished: the body is
   * streamed, and reporting after it drained would hold the event until the
   * client had already read the response.
   */
  bodyRewritten: boolean;
  /**
   * Why the body was relayed untouched. Absent when it was rewritten, and also
   * absent when nothing was proxied — a guard refusal, an upstream that never
   * answered, or a 101 has no rewrite decision to report, and naming a reason
   * would describe a response that does not exist.
   */
  rewriteSkipped?: RewriteSkipReason;
  /**
   * True when the `Location` sent to the client differs from the upstream's, so
   * the redirect stayed on the proxy. False when there was no `Location`, when
   * it named a host outside the upstream, or when `rewriteHeaders` is off.
   */
  redirectRewritten: boolean;
  /**
   * What the response cache did, when the route has one enabled.
   *
   * `bypass` means the request was never a candidate — a method the cache does
   * not cover, or credentials in the request — as opposed to `miss`, where it was
   * a candidate and no entry was there. Tuning a hit rate needs those apart.
   *
   * `stale_error` is a degradation worth alerting on: an entry already past the
   * stale-while-revalidate window, served only because the upstream failed and
   * the route opted into `staleIfError`. Filter on it to know when the cache,
   * not the origin, is what kept the site up.
   *
   * Absent on a route without caching, and on a refusal that never got that far.
   */
  cache?: CacheState | undefined;
  /**
   * How the request's upstream was picked, when the route splits traffic.
   * Absent for routes with a fixed upstream, where there is nothing to explain.
   */
  selection?: Selection;
  /**
   * Candidates the outlier memory removed from the walk before the first
   * attempt, as authorities. The answer to "why did this request go straight
   * to B" — without it, a healthy backup answering first reads as a primary
   * that was never configured. Absent when nothing was skipped, and on routes
   * without an outlier policy.
   */
  ejected?: string[];
  /**
   * Why the route's `limits` held this request back, when it did.
   *
   * `retry_budget` — the route's retry share was spent, so the walk stopped
   * after the attempts it had already made rather than taking the extras
   * `retries` allowed. The request itself still went out, so `attempts` reads
   * 1 or more; what is missing is the amplification, and only this field says
   * the budget, not the upstream, is what cut it.
   *
   * `in_flight` — the route's in-flight fuse on the assigned upstream was full,
   * so the request was refused with 503 before anything was forwarded and
   * `attempts` reads 0. The one reason that means a client-visible refusal
   * rather than a quieter walk.
   *
   * Absent on routes without a `limits` block, and whenever nothing was held
   * back — so a field that is present is always an answer to "why did this
   * request do less than its config said".
   */
  limitReason?: LimitReason;
  /**
   * How the response body stream ended, resolved once it has.
   *
   * A promise rather than a second callback, and rather than delaying this event
   * until the body drained. Delaying it would hold every `waitUntil` the host
   * queued from here until the client had finished reading — on a streamed answer
   * that is minutes. A second callback would fire for every response with a body,
   * including every static asset, doubling the event volume to say "it finished"
   * about responses that finish in one chunk.
   *
   * So the fact is offered, not pushed: a host that wants it awaits this inside
   * `ctx.waitUntil`, and one that does not simply ignores it. It never rejects —
   * an ignored rejected promise is an unhandled rejection — so every ending,
   * deadline and reset included, arrives as a resolved value.
   *
   * Absent when nothing streamed from an upstream: a guard refusal, a 101
   * handshake, a bodyless response, a cache hit, or jouska's own error page.
   *
   * `outcome` is the one to alert on. `idle_timeout` and `first_chunk_timeout`
   * mean this proxy cut a response the client had already been told was `200 OK`
   * — unrecoverable by construction, because the headers are long gone, and
   * invisible in `status`, which will read 200 for it.
   */
  stream?: Promise<StreamReport>;
  /**
   * Wall-clock milliseconds the access-control stage spent, when the route has
   * auth fields configured. Absent on routes without them, and on preflights,
   * which skip the stage. Includes a refusal's own latency: a slow auth
   * endpoint shows up here whether it admitted or refused.
   */
  authDurationMs?: number;
}

export interface JouskaOptions {
  config: Config;
  /** Overridable for tests; defaults to the runtime `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Store backing the response cache. Defaults to `caches.default`.
   *
   * Overridable for tests, and for a deployment that wants a named cache. Only
   * consulted by routes with a `cache` block.
   */
  cacheImpl?: ResponseCacheStore;
  /**
   * Called once per proxied request, after the response is decided.
   *
   * Deliberately a callback rather than a binding: writing to Analytics Engine,
   * a log line, or nothing at all is a deployment decision, and a library that
   * picked one would either pull in a binding nobody asked for or invent a
   * config surface for something the host already has. Errors thrown here are
   * swallowed — observability must not be able to fail a request.
   *
   * Wrap the body in `ctx.waitUntil` if it does I/O, so the response is not held
   * waiting on it.
   *
   * Not called for a CORS preflight that `hono/cors` answers itself: nothing was
   * proxied, so there is no upstream, status or duration to report. Verified — a
   * preflight against a route with `cors` set produces a 204 and no event. Note
   * the asymmetry with rate limiting, which can be told to count preflights via
   * `countPreflight`; if you need them in your metrics, count them at the app
   * level rather than expecting them here.
   */
  onProxy?: (event: ProxyEvent) => void;
}

/** Cloudflare request metadata this middleware reads. Isolated for clarity. */
interface CloudflareRequest {
  cf?: { country?: string };
}

/** Reads the visitor's country. Cloudflare reports it uppercased. */
const country = (request: Request): string | undefined =>
  (request as CloudflareRequest).cf?.country;

/**
 * Statuses whose body must not be rewritten.
 *
 * A 206 carries a byte range, so changing its length contradicts the
 * `Content-Range` the client used to assemble the whole resource — verified: a
 * rewritten 206 kept `bytes 0-31/1000` while the body became 30 bytes. 304 and
 * 204 have no body at all.
 */
const NO_REWRITE_STATUSES = new Set([204, 206, 304]);

/**
 * Reverse-proxy middleware. Resolves the request against the route table and,
 * on a match, forwards it upstream and rewrites the response. On no match it
 * calls `next()`, so an app can mix proxied routes with its own handlers.
 */
export const jouska = ({
  config,
  fetchImpl,
  cacheImpl,
  onProxy,
}: JouskaOptions): MiddlewareHandler => {
  return async (c, next) => {
    const startedAt = Date.now();
    // Parsed once and threaded through: the URL was previously re-parsed four
    // or five times per request, all to read the same three fields.
    const url = new URL(c.req.url);
    const match = matchUrl(config, url, c.req.method, c.req.raw.headers);
    if (match === undefined) {
      return next();
    }
    const { route } = match;

    // Resolved once, before anything can return: a guard refusal carries the
    // same ID as a proxied response and the event reports it, so a refusal in
    // the access log is still findable from the value the client holds.
    const requestId = resolveRequestId(route, c.req.raw);
    /**
     * Stamps the ID onto a response jouska built itself — a guard refusal
     * below, or a preflight answered by `corsMiddleware`. Proxied, cached and
     * failure responses are stamped where they are assembled instead, because
     * they also reach the upstream and must agree with it.
     */
    const stamped = (response: Response): Response => {
      stampRequestId(response.headers, requestId);
      return response;
    };

    // Split routes resolve their bucket up front. The pick is deterministic from
    // the request alone, so it holds even when a guard refuses the request
    // before any upstream sees it — the event can still say where it *would*
    // have gone and why.
    const selection =
      route.trafficSplit !== undefined ? selectUpstream(route, c.req.raw) : undefined;
    const primary = splitUpstream(
      upstreamCandidates(route, selection?.index ?? 0)[0] ?? '',
    ).authority;

    // Guards run cheapest-first, so a request that will be refused never
    // reaches the upstream. Geo and IP are local checks; rate limiting costs a
    // binding call; access control costs crypto (and, on a cold JWKS, a fetch);
    // forwarding costs a network round trip.
    const report: Report = (
      status,
      outcome,
      attempts,
      upstream = primary,
      rewrite,
      cache,
      ejected,
      stream,
      authMs,
      limitReason,
    ): void => {
      if (onProxy === undefined) {
        return;
      }
      try {
        onProxy({
          routeId: routeId(route, match.index),
          requestId,
          upstream,
          method: c.req.method,
          path: url.pathname,
          status,
          durationMs: Date.now() - startedAt,
          attempts,
          outcome,
          // Omitted `rewrite` means the request never reached the point of
          // deciding, so both flags are false and no reason is named.
          bodyRewritten: rewrite?.bodyRewritten ?? false,
          // Spread rather than assigned `undefined`: under
          // exactOptionalPropertyTypes a consumer distinguishes an absent key
          // from a present undefined one, and "no decision" is an absent key.
          ...(rewrite?.rewriteSkipped !== undefined
            ? { rewriteSkipped: rewrite.rewriteSkipped }
            : {}),
          redirectRewritten: rewrite?.redirectRewritten ?? false,
          cache,
          // Spread like `rewriteSkipped` above: no split, no key.
          ...(selection !== undefined ? { selection } : {}),
          ...(ejected !== undefined && ejected.length > 0 ? { ejected } : {}),
          ...(stream !== undefined ? { stream } : {}),
          ...(authMs !== undefined ? { authDurationMs: authMs } : {}),
          ...(limitReason !== undefined ? { limitReason } : {}),
        });
      } catch {
        // Observability must not be able to fail a request.
      }
    };

    // Method refusal is the cheapest guard there is — a set lookup, no header
    // reads, no I/O — so it runs before the guards below. `match.methods` chose
    // whether this route matched at all; `requestPolicy.allowedMethods` chooses
    // whether a matched request is forwarded. A miss on the latter is a refusal,
    // not a pass-through: handing it back to the app would make the allow-list
    // read as "these methods are free" while every other method wandered off to
    // whatever the app does next.
    //
    // The one exemption is a CORS preflight on a route that has `cors`: the
    // preflight is answered by jouska itself and never reaches the upstream, so
    // refusing it with 405 would break cross-origin calls to every method the
    // allow-list does permit. Without `cors` there is no such negotiation — the
    // OPTIONS would be forwarded verbatim — so it is subject to the list like
    // any other method.
    const isPreflight = c.req.method === 'OPTIONS' && c.req.header('origin') !== undefined;
    const policy = route.requestPolicy;
    const preflightExempt = isPreflight && route.cors !== undefined;
    if (
      policy?.allowedMethods !== undefined &&
      !preflightExempt &&
      !policy.allowedMethods.includes(c.req.method)
    ) {
      report(405, 'refused', 0);
      // RFC 9110 §15.5.5: the response to a refused method names what is
      // allowed. Empty allow-lists cannot occur — the schema requires nonempty.
      c.header('allow', policy.allowedMethods.join(', '));
      return stamped(c.json({ error: 'method_not_allowed', allow: policy.allowedMethods }, 405));
    }

    // A declared size is refused before anything is forwarded; the undetectable
    // case — a chunked body, which declares no length — is caught on the stream
    // by the counting wrapper in `forward`, and surfaces here as BodyLimitError.
    const maxBody = policy?.maxBodyBytes;
    if (maxBody !== undefined) {
      const declared = contentLength(c.req.raw);
      if (declared !== undefined && declared > maxBody) {
        report(413, 'refused', 0);
        return stamped(c.json({ error: 'payload_too_large', maxBodyBytes: maxBody }, 413));
      }
    }

    const geo = checkGeo(route, c.req.raw);
    if (geo !== undefined) {
      report(403, 'refused', 0);
      return stamped(c.text(geo, 403));
    }

    if (route.ip !== undefined) {
      const refused = await runGuard(ipMiddleware(route.ip), c);
      if (refused !== undefined) {
        report(refused.status, 'refused', 0);
        return stamped(refused);
      }
    }

    // The preflight check computed above for the method guard decides rate-limit
    // accounting too, so it is not re-derived here.
    if (route.rateLimit !== undefined && (route.rateLimit.countPreflight || !isPreflight)) {
      const verdict = await checkRateLimit(
        route.rateLimit,
        c,
        routeId(route, match.index),
        c.req.header('cf-connecting-ip'),
      );
      if (!verdict.ok) {
        if (verdict.reason === 'exceeded') {
          report(429, 'refused', 0);
          return stamped(c.json({ error: 'rate_limited' }, 429));
        }
        if (verdict.reason === 'unidentifiable') {
          // Fail closed: see checkRateLimit for why one shared bucket is worse.
          report(403, 'refused', 0);
          return stamped(c.json({ error: 'rate_limit_unidentifiable' }, 403));
        }
        report(500, 'refused', 0);
        return stamped(
          c.json({ error: 'rate_limit_misconfigured', binding: route.rateLimit.binding }, 500),
        );
      }
    }

    if (route.access !== undefined) {
      // Local signature checks first, deliberately. Crypto costs CPU, and a
      // JWKS fetch costs a round trip; running the local and binding-backed
      // checks before the delegated one means a request that geo, IP or the
      // rate limiter would refuse never pays for either. Without that ordering,
      // an unauthenticated caller could reach the signature verification on
      // every request — a CPU amplifier with nothing between it and the
      // internet but the length caps.
      const verdict = await checkAccess(route.access, c.req.raw, fetchImpl ?? fetch);
      if (!verdict.ok) {
        const status = verdict.status;
        report(status, 'refused', 0);
        return stamped(c.json({ error: `access_${verdict.reason}` }, status));
      }
    }

    // Delegated auth answers "who are you" last among the guards — it is the
    // only one that costs a network round trip, so everything cheaper filters
    // first. The gate is the same check the guards themselves run, so a route
    // without a `forwardAuth` block skips the stage entirely — including the
    // await, which would otherwise hand the event loop a turn on every request
    // to say "nothing to do". Preflights carry no credentials — the browser
    // sends none on an OPTIONS — so running the guard would refuse every
    // cross-origin call before its real request could ever pass; the preflight
    // is answered below by `cors` or forwarded verbatim, as before. (`access`
    // above has no such exemption: #69's local checks apply to preflights too.)
    let authMs: number | undefined;
    let authHeaders: Headers | undefined;
    if (!isPreflight && routeAuthenticates(route)) {
      const auth = await runAuthGuards(route, c.req.raw, url, fetchImpl);
      if (auth !== undefined) {
        if (auth.refusal !== undefined) {
          // Attempts 0: nothing reached the upstream, the same accounting every
          // guard refusal above uses. A delegated verdict is attributed to the
          // auth endpoint that gave it; a local check keeps the default.
          report(
            auth.refusal.status,
            'refused',
            0,
            auth.refusalUpstream,
            undefined,
            undefined,
            undefined,
            undefined,
            auth.authMs,
          );
          return stamped(auth.refusal);
        }
        // Authed and admitted — keep the designated headers for the forward,
        // and the spent latency for the event.
        authMs = auth.authMs;
        authHeaders = auth.authHeaders;
      }
    }

    // A route that answers for itself stops here. Every guard above has run
    // unchanged — a `respond` route still geo-blocks, rate-limits and
    // authenticates like any other — but nothing below is for it: CORS wraps
    // the forward, and everything past that exists to describe a response that
    // came from an upstream, which this one never had. `attempts: 0` is the
    // same accounting every guard refusal uses, and `upstream` stays empty
    // because there is no authority to blame or probe.
    if (route.respond !== undefined) {
      // An edge answer is still a response the client holds and a line in the
      // access log, so it carries the ID like anything else this proxy makes.
      const answer = stamped(respondAnswer(route.respond, c.req.method));
      report(answer.status, 'responded', 0, '');
      if (route.cors !== undefined) {
        // CORS still negotiates for the answer itself: a browser fetches a
        // `respond` reply cross-origin exactly as it would a proxied one.
        return corsMiddleware(route.cors)(c, async () => {
          c.res = answer;
        });
      }
      return answer;
    }

    // The in-flight fuse, when the route has one, is checked inside
    // `proxyRequest` — after the cache, so a hit is never turned into a 503 by
    // a saturated origin, and before the walk, so a refusal costs nothing but
    // the lookup. A `respond` route never reaches it: the answer above left
    // before the walk existed, so the fuse has nothing to count.
    const limits =
      route.limits === undefined
        ? undefined
        : limitsObserver(limitsFor(routeId(route, match.index), route.limits));

    // CORS wraps the forward so preflights are answered without a round trip
    // and the response carries the negotiated headers.
    if (route.cors !== undefined) {
      const corsResponse = await corsMiddleware(route.cors)(c, async () => {
        c.res = await proxyRequest(
          match,
          c,
          url,
          fetchImpl,
          cacheImpl,
          report,
          requestId,
          selection,
          authMs,
          authHeaders,
          limits,
        );
      });
      // A preflight is answered by the CORS middleware itself — the one
      // jouska-made response that never flows through the forward, so it is
      // stamped here, like the refusals above. A proxied response comes back as
      // `undefined` here, already stamped where it was assembled.
      return corsResponse instanceof Response ? stamped(corsResponse) : corsResponse;
    }
    return proxyRequest(
      match,
      c,
      url,
      fetchImpl,
      cacheImpl,
      report,
      requestId,
      selection,
      authMs,
      authHeaders,
      limits,
    );
  };
};

/**
 * Applies the country rules, returning a refusal reason or undefined.
 *
 * `blockCountries` fails open on an unknown origin — an absent signal must not
 * be mistaken for a blocked one. `allowCountries` fails closed, because an
 * allow-list that admits unknowns is not an allow-list. Codes are uppercased by
 * the schema, so these are exact comparisons; the previous lowercase-tolerant
 * config silently admitted everything.
 */
const checkGeo = (route: Route, request: Request): string | undefined => {
  if (route.blockCountries.length === 0 && route.allowCountries === undefined) {
    return undefined;
  }
  const from = country(request);
  if (from !== undefined && route.blockCountries.includes(from)) {
    return 'Forbidden';
  }
  if (
    route.allowCountries !== undefined &&
    (from === undefined || !route.allowCountries.includes(from))
  ) {
    return 'Forbidden';
  }
  return undefined;
};

/**
 * Runs a Hono middleware purely as a gate: returns its response when it refuses
 * the request, or `undefined` when it calls `next()` and the request may go on.
 */
const runGuard = async (guard: MiddlewareHandler, c: Context): Promise<Response | undefined> => {
  let passed = false;
  const result = await guard(c, async () => {
    passed = true;
  });
  if (passed) {
    return undefined;
  }
  return result instanceof Response ? result : c.res;
};

/**
 * The rewrite conclusions one event carries. Separate from the positional
 * arguments because most report sites — every guard refusal, every upstream
 * failure — have no rewrite to describe and pass nothing.
 */
interface RewriteReport {
  readonly bodyRewritten: boolean;
  readonly rewriteSkipped?: RewriteSkipReason;
  readonly redirectRewritten: boolean;
}

/**
 * Reports the outcome of one proxied request. `upstream` is the authority that
 * actually answered — or, on a failure, the last one tried; refusals before any
 * forward use the caller's assigned bucket.
 */
type Report = (
  status: number,
  outcome: ProxyEvent['outcome'],
  attempts: number,
  upstream?: string,
  rewrite?: RewriteReport,
  cache?: CacheState,
  ejected?: string[],
  stream?: Promise<StreamReport>,
  authMs?: number,
  limitReason?: LimitReason,
) => void;

/**
 * The default response store: the runtime's own cache.
 *
 * Resolved defensively rather than at module load. `caches` is a Workers global,
 * and a route table that turns caching on in an environment without it should
 * degrade to not caching rather than throw on the first request.
 */
const defaultCacheStore = (): ResponseCacheStore | undefined =>
  typeof caches === 'undefined' ? undefined : caches.default;

/** Everything a caching route needs for one request, resolved once. */
interface CachePlan {
  config: CacheConfig;
  store: ResponseCacheStore;
  key: Request;
}

/**
 * Builds the caching plan, or returns undefined when this request cannot take
 * part — nothing is read, nothing is stored, and `bypass` is reported.
 */
const buildCachePlan = (
  config: CacheConfig,
  fingerprint: string,
  request: Request,
  url: URL,
  method: string,
  cacheImpl: ResponseCacheStore | undefined,
): CachePlan | undefined => {
  const store = cacheImpl ?? defaultCacheStore();
  if (store === undefined || !requestCacheable(request, method, config)) {
    return undefined;
  }
  const key = cacheKey(url, method, fingerprint, config, request.headers);
  return key === undefined ? undefined : { config, store, key };
};

/**
 * Schedules work that must not hold the response.
 *
 * Hono throws from `executionCtx` when there is none — verified, `app.request()`
 * in a test raises `This context has no ExecutionContext` — so the fallback runs
 * the work detached. In a real deployment that risks cancellation once the
 * response completes, and for a cache write the only consequence is a missing
 * entry.
 */
const inBackground = (c: Context, work: Promise<unknown> | undefined): void => {
  if (work === undefined) {
    return;
  }
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    void work.catch(() => {
      // Detached: nothing is waiting on the result, and see above for the cost.
    });
  }
};

/**
 * Serves one matched request, through the response cache when the route has one,
 * and otherwise from the upstream.
 *
 * The cache is consulted before the upstream and written after it. A stale entry
 * is served immediately and revalidated behind the response, so the visitor who
 * happened to arrive past the TTL does not pay for the refresh.
 *
 * Rewrites and reports follow the candidate that actually answered, not the one
 * the walk started from: a response reached through failover carries the
 * backup's host in `Location`/`Set-Cookie`, and crediting the primary would
 * rewrite the visitor onto a server that never served them.
 */
const proxyRequest = async (
  match: Match,
  c: Context,
  url: URL,
  fetchImpl: typeof fetch | undefined,
  cacheImpl: ResponseCacheStore | undefined,
  report: Report,
  /** The ID stamped onto the upstream request, the response and the event. */
  requestId: string,
  selection?: Selection,
  authMs?: number,
  authHeaders?: Headers,
  limits?: LimitsObserver,
): Promise<Response> => {
  const { route } = match;
  // The bucket this caller was assigned to, as an authority. The cache key
  // cannot say which upstream produced its entry, so a hit reports this bucket —
  // also what the sticky cookie below names.
  const assigned = splitUpstream(
    upstreamCandidates(route, selection?.index ?? 0)[0] ?? '',
  ).authority;
  // Configuration refuses `cache` on a route that authenticates — a cached
  // response is keyed by URL and would hand one caller's authorised answer to
  // the next — and this is the runtime backstop for a document that somehow
  // still carries the pairing. Dropping the block reads as "not configured":
  // nothing is read, nothing is stored.
  const authenticates = routeAuthenticates(route);
  const caching = route.cache?.enabled === true && !authenticates ? route.cache : undefined;
  const plan =
    caching === undefined
      ? undefined
      : buildCachePlan(
          caching,
          // The bucket belongs in the key: split upstreams may serve different
          // bytes, and one shared key would hand bucket A's cached entry to
          // bucket B's caller. The fingerprint already pins the route config;
          // the index pins which slice of it produced the bytes. Headers and
          // cookies the route matched on belong in too — same argument, one
          // level up: two branches of one route must not share an entry.
          // `cacheVaryPart` returns '' for an unconditional route, keeping the
          // key — and every entry already stored under it — exactly as before.
          `${routeFingerprint(route)}.${selection?.index ?? 0}.${cacheVaryPart(
            route.match,
            c.req.raw.headers,
          )}`,
          c.req.raw,
          url,
          c.req.method,
          cacheImpl,
        );

  /**
   * Delivers an entry found in the store — whichever read found it: the healthy
   * one before the upstream, a waiter's re-read after a joined flight, or the
   * stale-if-error fallback after a failure. One copy of the header rules, the
   * report shape and the sticky-cookie logic, and the cache state comes from
   * the entry as read, never from what the caller expected to find.
   *
   * `tried` is set only by the stale-if-error caller, whose event must say what
   * the delivery cost — the attempts the failure spent and the authority that
   * failed — rather than the zero attempts a healthy hit reports.
   */
  const deliverFromCache = (
    cache: CachePlan,
    cached: CachedResponse,
    tried?: { attempts: number; upstream: string },
  ): Response => {
    // The rules already ran on the bytes that were stored — a change to them
    // changes the fingerprint and so the key — but the diagnostic headers
    // `readCachedResponse` just wrote did not exist then, and an operator who
    // asked for one of those to be removed meant it on a hit too.
    //
    // The ID is stamped before the rules, not after: removing it is a decision
    // the operator is allowed to make, and a rule that asked for that must win
    // over the stamp.
    stampRequestId(cached.response.headers, requestId);
    applyResponseHeaderRules(cached.response.headers, route.responseHeaders);
    report(
      cached.response.status,
      'ok',
      tried?.attempts ?? 0,
      tried?.upstream,
      {
        bodyRewritten: false,
        // A route with no rewrite configured keeps saying so, so "which routes
        // forgot to turn rewriting on" stays answerable through a cache. Only a
        // route that does rewrite reports the cache as the reason this request
        // did not.
        rewriteSkipped: route.bodyRewrite === undefined ? 'not_configured' : 'served_from_cache',
        // What is stored is already the rewritten bytes — the fingerprint in
        // the key guarantees it — and a stored 301 carries the rewritten
        // Location. Nothing re-rewrites on a delivery, so false is a fact.
        redirectRewritten: false,
      },
      cached.state,
    );
    if (cached.state === 'stale') {
      inBackground(
        c,
        refreshOnce(cache.key, async () => {
          const refreshed = await produceResponse({
            match,
            c,
            url,
            fetchImpl,
            detached: true,
            cacheState: undefined,
            selection,
            requestId,
          });
          if (
            refreshed.fromUpstream &&
            responseCacheable(refreshed.response, refreshed.upstreamHeaders, cache.config)
          ) {
            await storeCachedResponse({
              store: cache.store,
              key: cache.key,
              response: refreshed.response,
              cache: cache.config,
              now: Date.now(),
              alsoServed: false,
            });
          }
        }),
      );
    }
    // A hit still hands a newly-assigned caller its cookie: the cache answered
    // this request, but the next one goes upstream, and pinning it now keeps
    // the bucket from drifting mid-session.
    return withStickyCookie(cached.response, route, selection, assigned);
  };

  if (plan !== undefined) {
    const cached = await readCachedResponse({
      store: plan.store,
      key: plan.key,
      cache: plan.config,
      now: Date.now(),
    });
    if (cached !== undefined) {
      return deliverFromCache(plan, cached);
    }
  }

  const cacheState: CacheState | undefined =
    caching === undefined ? undefined : plan === undefined ? 'bypass' : 'miss';

  // The cold-miss lock, when the route asked for one. This caller may lead the
  // flight — it fetches, fills and settles — or join one already running: it
  // waits, bounded by the route's own `totalTimeoutMs`, and a fill that landed
  // is re-read and delivered exactly as a hit would be. A waiter whose wait ran
  // out, or whose leader's fill produced nothing cacheable, falls through and
  // fetches on its own, exactly as it would have without the lock.
  let settleFlight: (() => void) | undefined;
  if (cacheState === 'miss' && plan !== undefined && caching?.lockMisses === true) {
    settleFlight = beginFlight(plan.key);
    if (settleFlight === undefined) {
      await joinFlight(plan.key, route.totalTimeoutMs);
      // Re-read whether or not the flight reports a fill: a join that began
      // after the leader settled sees no flight at all, yet the entry is in the
      // store by then — and the waiter does not trust a hand-off anyway, it
      // re-derives the state through the shared delivery path.
      const found = await readCachedResponse({
        store: plan.store,
        key: plan.key,
        cache: plan.config,
        now: Date.now(),
      });
      if (found !== undefined) {
        return deliverFromCache(plan, found);
      }
      // Nothing to serve from the cache: proceed as the leader would have.
    }
  }

  let produced: Produced;
  try {
    // The seat is taken as late as this — a hit or a joined flight above never
    // reaches the upstream, so it never holds a seat — and released by the
    // `finally` below, which is the only structure that covers every exit: a
    // thrown walk, a client hang-up, a deadline, and the normal return alike.
    // A seat leaked here is a fuse that never reopens, so this is the one
    // placement that cannot be traded for a tidier-looking one.
    if (limits !== undefined && !limits.tryEnter(assigned)) {
      // Refused rather than queued: queueing would move the pile-up from the
      // origin to the proxy, where the requests still cost the origin the
      // moment a seat frees. 503 is the honest status — the service is
      // temporarily unable to take this request.
      report(
        503,
        'refused',
        0,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'in_flight',
      );
      settleFlight?.();
      settleFlight = undefined;
      // Stamped here rather than through the caller's `stamped` closure, which
      // is out of scope: every response jouska builds itself carries the ID,
      // so the 503 in the client's hand matches the `refused` line in the log.
      // Built directly: `c.json` types only admit registered statuses.
      const response = c.json({ error: 'in_flight_limit', upstream: assigned }, 503);
      stampRequestId(response.headers, requestId);
      return response;
    }
    try {
      produced = await produceResponse({
        match,
        c,
        url,
        fetchImpl,
        detached: false,
        cacheState,
        selection,
        authHeaders,
        requestId,
        limits,
      });
    } finally {
      // The seat names the response headers' arrival, not the body's: a stream
      // that runs for minutes holds nothing after this. Released on every
      // path, including the throw that `produceResponse` re-raises below.
      limits?.leave();
    }
  } catch (error) {
    // The fill died before it could decide anything about the cache: release
    // the waiters so they fetch on their own rather than hang until their bound.
    settleFlight?.();
    throw error;
  }

  // An expired entry beats a failure, when the route opted into stale-if-error
  // and this failure is one it counts. The upstream never answering — a timeout
  // or a refusal — counts by default; a 5xx counts only when listed, because a
  // maintenance page served stale is a choice; a client hang-up counts never,
  // because nobody is left to serve.
  if (plan !== undefined) {
    const onError = plan.config.staleIfError;
    const countsAsError =
      onError !== undefined &&
      (produced.fromUpstream
        ? produced.status >= 500 && onError.on.includes('5xx')
        : (produced.outcome === 'timeout' || produced.outcome === 'unreachable') &&
          onError.on.includes(produced.outcome));
    if (countsAsError) {
      const stale = await readCachedResponse({
        store: plan.store,
        key: plan.key,
        cache: plan.config,
        now: Date.now(),
        allowStaleError: true,
      });
      if (stale !== undefined) {
        // The entry is in the store — this read just found it — so any waiters
        // still on the flight may join it, and they re-read the same way.
        settleFlight?.();
        return deliverFromCache(plan, stale, {
          attempts: produced.attempts,
          upstream: produced.authority,
        });
      }
    }
  }

  // Reported before the body is read, deliberately. The rewrite is a stream
  // transform, so a report that waited for its result would hold the event — and
  // any `waitUntil` the host queued from it — until the client had finished
  // reading. Everything the event states is already known, and what is not yet
  // known — how the stream ends — is carried as a promise rather than waited on.
  report(
    produced.status,
    produced.outcome,
    produced.attempts,
    produced.authority,
    produced.rewrite,
    cacheState,
    produced.ejected,
    produced.stream,
    authMs,
    produced.limitReason,
  );

  const cacheableFill =
    plan !== undefined &&
    produced.fromUpstream &&
    responseCacheable(produced.response, produced.upstreamHeaders, plan.config);
  if (cacheableFill && plan !== undefined) {
    // Called before the response is returned, so the clone inside is taken while
    // the body is still unread — `put` on a consumed body throws.
    const written = storeCachedResponse({
      store: plan.store,
      key: plan.key,
      response: produced.response,
      cache: plan.config,
      now: Date.now(),
      alsoServed: true,
    });
    inBackground(c, written);
    if (settleFlight !== undefined) {
      const settle = settleFlight;
      settleFlight = undefined;
      // Settle-after-write: the waiters are released only once the entry is
      // actually in the store. Released any earlier, a woken waiter would
      // re-read a cache the entry is not in yet and fetch from the upstream
      // after all — which is the herd the lock exists to stop. A write that
      // fails resolves the same way a non-cacheable fill does: the waiters
      // fetch on their own.
      void written.then(
        () => settle(),
        () => settle(),
      );
    }
  } else {
    // Nothing cacheable came back — a failure, a refused status, an uncacheable
    // body — so the waiters are released at once and fetch on their own.
    settleFlight?.();
    settleFlight = undefined;
  }
  // The cookie rides only on a response the upstream itself produced: a 101's
  // headers are spent on the handshake, and jouska's own 5xx never reached the
  // bucket it would name.
  return produced.fromUpstream && produced.status !== 101
    ? withStickyCookie(produced.response, route, selection, produced.authority)
    : produced.response;
};

interface ProduceOptions {
  match: Match;
  c: Context;
  url: URL;
  fetchImpl: typeof fetch | undefined;
  /** True for a background refresh, which must outlive the client's connection. */
  detached: boolean;
  /** Recorded on the response, so a caching route's behaviour is visible from outside. */
  cacheState: CacheState | undefined;
  /** The traffic-split pick, rotating the candidate order so it comes first. */
  selection: Selection | undefined;
  /**
   * Identity headers from a passed forward-auth check. Always undefined on the
   * background-refresh path: a route that authenticates cannot have a cache,
   * so nothing ever refreshes there.
   */
  authHeaders?: Headers;
  /** The request ID, carried onto the upstream request and the response. */
  requestId: string;
  /**
   * The route's retry budget, when it has one. Absent on the background-refresh
   * path, which is bounded by `refreshOnce` already and must not be refused by
   * a fuse the served request was admitted under — the refresh exists because
   * that request asked for one.
   */
  limits?: LimitsObserver;
}

/** One trip to the upstream and the rewriting of what comes back. */
interface Produced {
  response: Response;
  status: number;
  outcome: ProxyEvent['outcome'];
  attempts: number;
  /**
   * Authorities the outlier memory removed before the walk, when the route
   * ejects. Read from the observer's closure, which survives even a thrown
   * walk — the skipping happened before the walk, not inside it.
   */
  ejected?: string[];
  /**
   * Why the retry budget held this walk back, when it did. Read from the
   * observer after the walk — whether it returned or threw — so the fact is
   * reported even when the budget cut the walk short mid-failure.
   */
  limitReason?: LimitReason;
  /**
   * The candidate that answered, as an authority — or, on a failure, the last
   * one tried. Rewrites and reports follow it: crediting the primary would
   * point a failover-served visitor at a server that never served them.
   */
  authority: string;
  /**
   * False when the response is jouska's own error rather than the upstream's, so
   * a 502 for an unreachable origin is never mistaken for something to cache.
   */
  fromUpstream: boolean;
  /**
   * The upstream's own headers, before any rewriting.
   *
   * Carried through because cacheability is partly the upstream's statement about
   * the response — `Cache-Control`, `Set-Cookie`, `Vary` — and an operator rule
   * that deleted the statement must not be able to change the answer. See
   * `responseCacheable`.
   */
  upstreamHeaders: Headers;
  /** Absent when nothing was proxied, which is what `report` expects. */
  rewrite?: RewriteReport;
  /**
   * How the body stream ended. Absent for a bodyless response and for jouska's
   * own error responses, neither of which streams anything from an upstream.
   */
  stream?: Promise<StreamReport>;
}

/** Forwards the request upstream and rewrites the response. */
const produceResponse = async ({
  match,
  c,
  url,
  fetchImpl,
  detached,
  cacheState,
  selection,
  authHeaders,
  requestId,
  limits,
}: ProduceOptions): Promise<Produced> => {
  const { route } = match;
  // The per-request view over the route's failure memory. Filtered targets
  // are handed to `forward` whole: the non-empty guarantee (all candidates
  // ejected) belongs to the walker, and writing it in two places is a way to
  // let them drift.
  const outlier =
    route.outlier === undefined
      ? undefined
      : outlierObserver(ledgerFor(routeId(route, match.index), route.outlier));
  const targets = upstreamCandidates(route, selection?.index ?? 0).map((upstream) =>
    resolveUpstreamUrl(match, url, upstream),
  );
  // Counted by forward itself, so a retry is visible to the caller rather than
  // hidden inside a single reported request.
  let attempts = 0;
  let lastTarget = targets[0]!;
  const counting: typeof fetch = (input, init) => {
    attempts += 1;
    lastTarget = input instanceof Request ? new URL(input.url) : lastTarget;
    return (fetchImpl ?? fetch)(input as RequestInfo, init);
  };

  let result: Awaited<ReturnType<typeof forward>>;
  try {
    result = await forward({
      route,
      targets,
      request: c.req.raw,
      requestUrl: url,
      requestId,
      authHeaders,
      fetchImpl: counting,
      detached,
      outlier,
      limits,
    });
  } catch (error) {
    // Attributed to the last candidate actually tried: with no response there is
    // no `result.target`, and the walk's stopping point is where the fault is.
    const failure = upstreamFailure(error, c, lastTarget, route);
    // A failure is still a response the client holds, and still one line in the
    // access log — the ID on it is what ties the two to the attempt that died.
    stampRequestId(failure.headers, requestId);
    return {
      response: failure,
      status: failure.status,
      outcome: failureOutcome(error),
      attempts,
      authority: lastTarget.host,
      fromUpstream: false,
      upstreamHeaders: new Headers(),
      ...(outlier !== undefined && outlier.ejected().length > 0
        ? { ejected: outlier.ejected() }
        : {}),
      ...(limits?.retryDenied() === true ? { limitReason: 'retry_budget' as const } : {}),
    };
  }

  // A 101 carries the socket itself and cannot be reconstructed: `new Response`
  // refuses any status outside 200–599, and rewrapping would drop the
  // `webSocket` property even if it did not. Verified against workerd, both.
  if (result.response.status === 101) {
    return {
      response: result.response,
      status: 101,
      outcome: 'ok',
      attempts,
      authority: result.target.host,
      fromUpstream: true,
      upstreamHeaders: result.response.headers,
      ...(outlier !== undefined && outlier.ejected().length > 0
        ? { ejected: outlier.ejected() }
        : {}),
      ...(limits?.retryDenied() === true ? { limitReason: 'retry_budget' as const } : {}),
    };
  }

  // The body's own deadlines go on here, before anything else touches the
  // stream. The monitor measures whether the *upstream* is still sending, so it
  // has to sit against the upstream body: stacked outside the rewriter it would
  // measure what the rewriter had released, and a rewriter legitimately holds
  // bytes back across a chunk boundary — a live stream would read as idle.
  //
  // A response with no body has nothing to wait for; the 101 handshake returned
  // above, before this.
  const watch =
    result.response.body === null ? undefined : watchBody(result.response, route, result.abort);
  const upstream = watch?.response ?? result.response;
  const target = result.target;
  const authority = target.host;
  const contentType = parseContentType(upstream.headers.get('content-type'));
  const decision = decideRewrite(route.bodyRewrite, upstream, contentType);

  // Every change to the headers happens here, in order, so "who runs last" is
  // readable rather than inferred from two return paths.
  const { headers, redirectRewritten } = route.rewriteHeaders
    ? rewriteResponseHeaders({
        headers: upstream.headers,
        upstreamHost: authority,
        proxyOrigin: url.origin,
        bodyRewritten: decision.rewrite,
      })
    : // Nothing was rewritten, so nothing is claimed: `stripHopByHop` does not
      // touch `Location`.
      { headers: stripHopByHop(upstream.headers), redirectRewritten: false };

  // With header rewriting off, the validators were left intact above; they still
  // have to go once the body changes.
  if (decision.rewrite && !route.rewriteHeaders) {
    stripBodyValidators(headers);
  }
  // Output is always UTF-8, so a declared charset that is no longer accurate
  // would make the browser decode correct bytes with the wrong table.
  if (decision.rewrite && decision.transcoded && contentType !== undefined) {
    headers.set('content-type', `${contentType.type}; charset=utf-8`);
  }
  if (cacheState !== undefined) {
    headers.set(CACHE_STATE_HEADER, cacheState);
  }
  // The same ID the upstream received, so a log line on either side finds the
  // other. Before the rules, not after: `responseHeaders` may remove it, and an
  // operator who asked for that means it — the event still reports the ID.
  stampRequestId(headers, requestId);
  // Last, deliberately: the operator's rules can override anything above,
  // including the proxy's own rewrites. See `applyResponseHeaderRules`.
  applyResponseHeaderRules(headers, route.responseHeaders);

  const response = decision.rewrite
    ? rewriteBody({
        upstream,
        headers,
        rewrite: decision.config,
        charset: decision.charset,
        isHtml: contentType?.type === 'text/html',
        upstreamHost: authority,
        target,
        proxyHost: url.host,
      })
    : new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
  return {
    response,
    status: upstream.status,
    outcome: 'ok',
    attempts,
    authority,
    fromUpstream: true,
    upstreamHeaders: upstream.headers,
    ...(outlier !== undefined && outlier.ejected().length > 0
      ? { ejected: outlier.ejected() }
      : {}),
    ...(limits?.retryDenied() === true ? { limitReason: 'retry_budget' as const } : {}),
    ...(watch !== undefined ? { stream: watch.report } : {}),
    rewrite: {
      bodyRewritten: decision.rewrite,
      ...(decision.rewrite ? {} : { rewriteSkipped: decision.skipped }),
      redirectRewritten,
    },
  };
};

/**
 * Puts the body's deadlines on a response, returning it rebuilt around the
 * monitored stream plus the promise of how that stream ended.
 *
 * The promise never rejects: it is handed to an observer that may well ignore
 * it, and an ignored rejected promise is an unhandled rejection in the isolate.
 * Every ending — including a deadline and a reset — arrives as a resolved
 * {@link StreamReport}.
 */
const watchBody = (
  upstream: Response,
  route: Route,
  abort: (reason: Error) => void,
): { response: Response; report: Promise<StreamReport> } | undefined => {
  const body = upstream.body;
  if (body === null) {
    return undefined;
  }
  let settle: (report: StreamReport) => void;
  const report = new Promise<StreamReport>((resolve) => {
    settle = resolve;
  });
  const monitored = watchStream({
    body,
    firstChunkTimeoutMs: route.firstChunkTimeoutMs,
    streamIdleTimeoutMs: route.streamIdleTimeoutMs,
    abort,
    // Assigned synchronously by the Promise executor above, so this is defined
    // by the time any chunk can arrive.
    onEnd: (ended) => settle(ended),
  });
  return {
    response: new Response(monitored, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    }),
    report,
  };
};

/**
 * Tells a newly-assigned caller which upstream it landed on, so its next request
 * resolves straight back to that bucket instead of being re-drawn.
 *
 * Only weighted assignments get the cookie — a caller that already presented a
 * valid one is keeping it. Appended to the finished response, after header
 * rewriting: the rewriter only touches the `Domain` attribute of upstream
 * cookies, and this one carries none, so it can never be renamed or moved.
 * The 101 handshake and jouska's own error responses return before this runs —
 * see the caller for why.
 */
const withStickyCookie = (
  response: Response,
  route: Route,
  selection: Selection | undefined,
  authority: string,
): Response => {
  if (route.stickyBy === 'cookie' && selection?.reason === 'weighted') {
    response.headers.append('set-cookie', stickyCookie(authority));
  }
  return response;
};

/**
 * Whether this response's body is rewritten, and if not, which of the five
 * reasons applies.
 *
 * A discriminated union rather than the chain of `&&` this replaces: that chain
 * computed one boolean out of conditions that meant entirely different things to
 * whoever was debugging a mirror whose links never changed, and reported none of
 * them. The order runs from the route's own configuration outward to this one
 * response, so the reason named is the outermost thing an operator can change.
 */
type RewriteDecision =
  | {
      readonly rewrite: true;
      /** The config that applies, carried so the caller need not re-narrow it. */
      readonly config: NonNullable<Route['bodyRewrite']>;
      readonly charset: string;
      /** True when the body is re-encoded, so `Content-Type` must be corrected. */
      readonly transcoded: boolean;
    }
  | { readonly rewrite: false; readonly skipped: RewriteSkipReason };

const decideRewrite = (
  config: Route['bodyRewrite'],
  upstream: Response,
  contentType: ContentType | undefined,
): RewriteDecision => {
  if (config === undefined) {
    return { rewrite: false, skipped: 'not_configured' };
  }
  if (NO_REWRITE_STATUSES.has(upstream.status)) {
    return { rewrite: false, skipped: 'bodyless_status' };
  }
  if (upstream.body === null) {
    return { rewrite: false, skipped: 'no_body' };
  }
  // Before the operator's own list, because this one is not theirs to override.
  if (isStreamingMedia(contentType)) {
    return { rewrite: false, skipped: 'streaming_media' };
  }
  if (!contentTypeAllowed(contentType, config.contentTypes)) {
    return { rewrite: false, skipped: 'content_type' };
  }
  // The charset decides whether rewriting is even safe: an encoding this runtime
  // cannot decode would be corrupted rather than rewritten, so the body passes
  // through untouched instead.
  const charset = resolveCharset(contentType?.charset, config.fallbackCharset);
  if (charset === undefined) {
    return { rewrite: false, skipped: 'charset_undecodable' };
  }
  return { rewrite: true, config, charset: charset.charset, transcoded: charset.transcoded };
};

/**
 * The declared request-body size, or undefined when the header is absent or not
 * a plain integer. A chunked upload carries no such header, which is why a
 * `maxBodyBytes` route also counts on the stream — see `forward`.
 */
const contentLength = (request: Request): number | undefined => {
  const raw = request.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
};

/**
 * Builds the response a `respond` route answers with.
 *
 * A redirect is answered with `Location` alone and no body — the body is the
 * browser's business, and the statuses a redirect may carry (301–308) are
 * bodyless by convention even when the platform would construct one. A fixed
 * answer serves its body verbatim under the headers the route names, with
 * `content-type` set last so a route cannot contradict itself between the
 * dedicated field and the map.
 *
 * A `HEAD` gets the status and the headers and no body, per RFC 9110 §9.3.2:
 * the server must not send one, and the headers still describe what a `GET`
 * would have received. The empty answer is built rather than stripped, so a
 * `Content-Length` from `respond.headers` (if an operator wrote one) stays
 * truthful about the GET.
 */
const respondAnswer = (respond: NonNullable<Route['respond']>, method: string): Response => {
  const headers = new Headers(respond.headers);
  const redirect = respond.redirect;
  if (redirect !== undefined) {
    headers.set('location', redirect.to);
    return new Response(null, { status: redirect.status, headers });
  }
  if (respond.contentType !== undefined) {
    headers.set('content-type', respond.contentType);
  }
  return new Response(method === 'HEAD' ? null : (respond.body ?? null), {
    status: respond.status!,
    headers,
  });
};

/** Classifies a forward failure for reporting. */
const failureOutcome = (error: unknown): ProxyEvent['outcome'] => {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError') {
    return 'client_closed';
  }
  // The client's body outgrew the route's ceiling: a refusal, not a fault.
  if (error instanceof BodyLimitError) {
    return 'refused';
  }
  return name === 'TimeoutError' || name === 'TotalTimeoutError' ? 'timeout' : 'unreachable';
};

/** Maps a forward failure onto a status the caller can act on. */
const upstreamFailure = (error: unknown, c: Context, target: URL, route: Route): Response => {
  const name = error instanceof Error ? error.name : '';
  // Distinguish a deadline from a genuine failure, and both from the client
  // simply hanging up — which is nobody's fault and not worth a 5xx.
  if (name === 'AbortError') {
    // 499 is nginx's non-standard "client closed request"; nothing is listening
    // for it, but it keeps client aborts out of the upstream error rate. Built
    // directly because Hono's `c.json` types only admit registered statuses.
    return Response.json({ error: 'client_closed_request' }, { status: 499 });
  }
  const timedOut = name === 'TimeoutError' || name === 'TotalTimeoutError';
  const status = timedOut ? 504 : 502;
  // A chunked body that grew past `maxBodyBytes` mid-upload. Not an upstream
  // fault, so it must not read as one: it is the client's body that is too
  // large, and 413 says so rather than 502.
  if (error instanceof BodyLimitError) {
    return c.json({ error: 'payload_too_large', maxBodyBytes: error.limitBytes }, 413);
  }
  // The route's own page replaces the JSON payload only. The status passes
  // through untouched — a maintenance page served as 200 defeats every probe
  // that keys on status, and the two statuses this lookup can see are exactly
  // the two `errorPages` keys the schema admits.
  const page = route.errorPages?.[String(status)];
  if (page !== undefined) {
    const headers = new Headers(page.headers);
    headers.set('content-type', page.contentType);
    return new Response(c.req.method === 'HEAD' ? null : page.body, { status, headers });
  }
  return c.json(
    { error: timedOut ? 'upstream_timeout' : 'upstream_unreachable', upstream: target.host },
    status,
  );
};

interface RewriteBodyOptions {
  upstream: Response;
  headers: Headers;
  rewrite: NonNullable<Route['bodyRewrite']>;
  charset: string;
  isHtml: boolean;
  upstreamHost: string;
  target: URL;
  proxyHost: string;
}

/** Streams the body through the appropriate rewriter. */
const rewriteBody = ({
  upstream,
  headers,
  rewrite,
  charset,
  isHtml,
  upstreamHost,
  target,
  proxyHost,
}: RewriteBodyOptions): Response => {
  const base = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  if (isHtml && rewrite.rewriteLinks) {
    // Native HTMLRewriter streams, so the document is never materialised. It
    // also assumes UTF-8 input, so a transcoding body is decoded first.
    const decoded =
      charset === 'utf-8'
        ? base
        : new Response(transcode(base.body, charset), {
            status: base.status,
            statusText: base.statusText,
            headers: base.headers,
          });
    const transformed = htmlRewriter({
      isUpstreamHost: upstreamHostMatcher(upstreamHost),
      proxyHost,
      base: target.toString(),
      rewriteStyles: rewrite.rewriteStyles,
    }).transform(decoded);
    return rewrite.replace.length > 0
      ? pipeText(transformed, rewrite.replace, undefined)
      : transformed;
  }

  // Text bodies get URL-aware host rewriting rather than a literal substitution:
  // substituting the host as a substring turned `https://o.test.evil.com/b` in a
  // stylesheet into `https://p.dev.evil.com/b`.
  const hostRewrite = rewrite.rewriteLinks
    ? { isUpstreamHost: upstreamHostMatcher(upstreamHost), proxyHost }
    : undefined;
  if (hostRewrite === undefined && rewrite.replace.length === 0 && charset === 'utf-8') {
    return base;
  }
  return pipeText(base, rewrite.replace, hostRewrite, charset);
};

/** Re-encodes a body from `charset` into UTF-8 without buffering it. */
const transcode = (
  body: ReadableStream<Uint8Array> | null,
  charset: string,
): ReadableStream<Uint8Array> | null =>
  body === null ? null : body.pipeThrough(textRewriteStream([], undefined, charset));

/** Streams a body through host rewriting and literal replacements. */
const pipeText = (
  response: Response,
  replacements: readonly Replacement[],
  hostRewrite: { isUpstreamHost: (host: string) => boolean; proxyHost: string } | undefined,
  charset = 'utf-8',
): Response =>
  new Response(
    response.body?.pipeThrough(textRewriteStream(replacements, hostRewrite, charset)) ?? null,
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
