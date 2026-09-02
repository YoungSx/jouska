import type { Context, MiddlewareHandler } from 'hono';
import type { CacheConfig, Config, Route } from '../config.js';
import {
  contentTypeAllowed,
  htmlRewriter,
  parseContentType,
  resolveCharset,
  textRewriteStream,
  type ContentType,
  type Replacement,
} from '../internal/body.js';
import { checkAccess } from '../internal/access.js';
import { BodyLimitError, forward } from '../internal/forward.js';
import { checkRateLimit, corsMiddleware, ipMiddleware } from '../internal/guards.js';
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
  | 'charset_undecodable'
  | 'served_from_cache';

/** What happened to one proxied request. Passed to `onProxy`. */
export interface ProxyEvent {
  /** The route that matched, labelled the way rate-limit buckets are. */
  routeId: string;
  /** Upstream authority the request was sent to. */
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
  /** Set when the request never reached a normal response. */
  outcome: 'ok' | 'refused' | 'timeout' | 'unreachable' | 'client_closed';
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
    ): void => {
      if (onProxy === undefined) {
        return;
      }
      try {
        onProxy({
          routeId: routeId(route, match.index),
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
      return c.json({ error: 'method_not_allowed', allow: policy.allowedMethods }, 405);
    }

    // A declared size is refused before anything is forwarded; the undetectable
    // case — a chunked body, which declares no length — is caught on the stream
    // by the counting wrapper in `forward`, and surfaces here as BodyLimitError.
    const maxBody = policy?.maxBodyBytes;
    if (maxBody !== undefined) {
      const declared = contentLength(c.req.raw);
      if (declared !== undefined && declared > maxBody) {
        report(413, 'refused', 0);
        return c.json({ error: 'payload_too_large', maxBodyBytes: maxBody }, 413);
      }
    }

    const geo = checkGeo(route, c.req.raw);
    if (geo !== undefined) {
      report(403, 'refused', 0);
      return c.text(geo, 403);
    }

    if (route.ip !== undefined) {
      const refused = await runGuard(ipMiddleware(route.ip), c);
      if (refused !== undefined) {
        report(refused.status, 'refused', 0);
        return refused;
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
          return c.json({ error: 'rate_limited' }, 429);
        }
        if (verdict.reason === 'unidentifiable') {
          // Fail closed: see checkRateLimit for why one shared bucket is worse.
          report(403, 'refused', 0);
          return c.json({ error: 'rate_limit_unidentifiable' }, 403);
        }
        report(500, 'refused', 0);
        return c.json({ error: 'rate_limit_misconfigured', binding: route.rateLimit.binding }, 500);
      }
    }

    if (route.access !== undefined) {
      // Last guard, deliberately. Crypto costs CPU, and a JWKS fetch costs a
      // round trip; running the local and binding-backed checks first means a
      // request that geo, IP or the rate limiter would refuse never pays for
      // either. Without that ordering, an unauthenticated caller could reach
      // the signature verification on every request — a CPU amplifier with
      // nothing between it and the internet but the length caps.
      const verdict = await checkAccess(route.access, c.req.raw, fetchImpl ?? fetch);
      if (!verdict.ok) {
        const status = verdict.status;
        report(status, 'refused', 0);
        return c.json({ error: `access_${verdict.reason}` }, status);
      }
    }

    // CORS wraps the forward so preflights are answered without a round trip
    // and the response carries the negotiated headers.
    if (route.cors !== undefined) {
      return corsMiddleware(route.cors)(c, async () => {
        c.res = await proxyRequest(match, c, url, fetchImpl, cacheImpl, report, selection);
      });
    }
    return proxyRequest(match, c, url, fetchImpl, cacheImpl, report, selection);
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
  const key = cacheKey(url, method, fingerprint);
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
  selection?: Selection,
): Promise<Response> => {
  const { route } = match;
  // The bucket this caller was assigned to, as an authority. The cache key
  // cannot say which upstream produced its entry, so a hit reports this bucket —
  // also what the sticky cookie below names.
  const assigned = splitUpstream(
    upstreamCandidates(route, selection?.index ?? 0)[0] ?? '',
  ).authority;
  const caching = route.cache?.enabled === true ? route.cache : undefined;
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
    produced = await produceResponse({
      match,
      c,
      url,
      fetchImpl,
      detached: false,
      cacheState,
      selection,
    });
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
  // reading. Everything the event states is already known.
  report(
    produced.status,
    produced.outcome,
    produced.attempts,
    produced.authority,
    produced.rewrite,
    cacheState,
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
}

/** One trip to the upstream and the rewriting of what comes back. */
interface Produced {
  response: Response;
  status: number;
  outcome: ProxyEvent['outcome'];
  attempts: number;
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
}: ProduceOptions): Promise<Produced> => {
  const { route } = match;
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
      fetchImpl: counting,
      detached,
    });
  } catch (error) {
    // Attributed to the last candidate actually tried: with no response there is
    // no `result.target`, and the walk's stopping point is where the fault is.
    const failure = upstreamFailure(error, c, lastTarget);
    return {
      response: failure,
      status: failure.status,
      outcome: failureOutcome(error),
      attempts,
      authority: lastTarget.host,
      fromUpstream: false,
      upstreamHeaders: new Headers(),
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
    };
  }

  const upstream = result.response;
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
    rewrite: {
      bodyRewritten: decision.rewrite,
      ...(decision.rewrite ? {} : { rewriteSkipped: decision.skipped }),
      redirectRewritten,
    },
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
const upstreamFailure = (error: unknown, c: Context, target: URL): Response => {
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
  // A chunked body that grew past `maxBodyBytes` mid-upload. Not an upstream
  // fault, so it must not read as one: it is the client's body that is too
  // large, and 413 says so rather than 502.
  if (error instanceof BodyLimitError) {
    return c.json({ error: 'payload_too_large', maxBodyBytes: error.limitBytes }, 413);
  }
  return c.json(
    { error: timedOut ? 'upstream_timeout' : 'upstream_unreachable', upstream: target.host },
    timedOut ? 504 : 502,
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
