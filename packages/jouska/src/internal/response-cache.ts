/**
 * Upstream response caching.
 *
 * Distinct from `../cache.ts`, which caches the *route table*. This caches what
 * the upstream sent, so a mirrored site's CSS, JavaScript and images are served
 * from the edge instead of costing a full edge-to-origin round trip per visitor.
 *
 * Three decisions shape everything here.
 *
 * **What is stored is the rewritten body, not the upstream's.** The alternative —
 * store the original and re-run the rewrite on every hit — saves the network and
 * spends the CPU, which is the half Workers bills for. The cost of storing the
 * rewritten form is that an entry is only valid for the configuration that
 * produced it, and that cost is paid by the key rather than by invalidation: the
 * key carries a fingerprint of the whole route, so a configuration change simply
 * produces different keys and the old entries expire unnoticed. Nothing has to be
 * enumerated and deleted, which the Cache API could not do anyway.
 *
 * **Freshness is TTL and nothing else.** A rewritten response has no `ETag` or
 * `Last-Modified` — `stripBodyValidators` removes them, because keeping them lets
 * a client answer its own next request with the *unrewritten* body — so there is
 * nothing to revalidate against. This is a direct consequence of the rewriting
 * design and is stated rather than worked around.
 *
 * **Age is computed here, not read from the platform.** Verified in workerd: the
 * `Age` header on a cache hit reads 0 no matter how long the entry has been
 * stored, and an entry the platform considers expired is invisible to `match`
 * rather than returned as stale. So the stored copy carries an explicit timestamp
 * and a lifetime covering the stale window too, and which part of the window an
 * entry is in is decided from that timestamp.
 */

import type { CacheConfig, Route } from '../config.js';
import { contentTypeAllowed, parseContentType } from './body.js';
import { isWebSocketUpgrade } from './forward.js';
import { readCookie } from './cookies.js';

/**
 * The slice of the Cache API this module needs.
 *
 * `caches.default` satisfies it structurally, so the production path passes it
 * directly; a test can pass a map. Narrow on purpose: `delete` is not here
 * because nothing invalidates by hand — see the module note on why the key does
 * that job instead.
 */
export interface ResponseCacheStore {
  match: (request: Request) => Promise<Response | undefined>;
  put: (request: Request, response: Response) => Promise<void>;
}

/** What the cache did with one request. Reported to the client and to `onProxy`. */
export type CacheState = 'hit' | 'stale' | 'miss' | 'bypass' | 'stale_error';

/**
 * Header naming the cache state on every response from a caching route.
 *
 * Whether a cache is working is otherwise unobservable from outside — the point
 * of a cache is that the response looks identical — and "is it even on?" is the
 * first question anyone tuning one asks.
 */
export const CACHE_STATE_HEADER = 'x-jouska-cache';

/** Epoch milliseconds at which an entry was stored. Internal; never sent on. */
const STORED_AT_HEADER = 'x-jouska-cached-at';

/**
 * The upstream's own `Cache-Control`, parked while the stored copy carries
 * jouska's. Internal; restored onto a hit and never sent on as itself.
 */
const ORIGIN_CACHE_CONTROL_HEADER = 'x-jouska-origin-cache-control';

/**
 * Query parameter that turns a request URL into a cache key.
 *
 * A synthetic host (`https://jouska.cache/...`) would read better and does work
 * locally — verified in workerd, an entry stored under a foreign host came back
 * on `match`. It is not used, because the Cloudflare docs make no promise about a
 * key outside the zone the Worker serves, and a cache that silently stops storing
 * in production is the worst way to find that out. Staying on the request's own
 * URL is provable on both.
 */
const KEY_PARAM = '__jouska_ck';

/**
 * Serialises a value with object keys in sorted order, so two spellings of one
 * configuration hash the same.
 *
 * `JSON.stringify` follows insertion order, and a route's key order depends on
 * which fields `defaults` filled in — so the same effective configuration,
 * written two ways, would otherwise fingerprint differently and cache twice.
 */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, entry]) => entry !== undefined,
  );
  // Sorted in place: `Object.entries` already returned a fresh array, so there is
  // nothing of anyone else's to mutate, and `toSorted` is not in the ES2022 lib
  // this package targets.
  // oxlint-disable-next-line no-array-sort
  entries.sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
};

/** FNV-1a, 32 bits. */
const fnv1a = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** djb2, 32 bits. An independent function, so the pair behaves as one 64-bit hash. */
const djb2 = (input: string): number => {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (Math.imul(hash, 33) + input.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
};

/**
 * Fingerprints are stable for the lifetime of a parsed route object, and a route
 * object lives as long as the config cache holds it — so this runs once per route
 * per isolate rather than once per request.
 */
const fingerprints = new WeakMap<object, string>();

/**
 * Fingerprint of everything about a route that could change the bytes it returns.
 *
 * It hashes the *whole* route rather than a curated list of response-affecting
 * fields. A curated list is a standing invitation to forget one, and a forgotten
 * field means two configurations sharing an entry — which is serving the wrong
 * bytes. Being wrong the other way costs a cold cache after an unrelated edit
 * like `timeoutMs`, which nobody notices.
 *
 * Two independent 32-bit hashes are concatenated, separated so the halves cannot
 * slide into one another and cost entropy. `crypto.subtle.digest` would be
 * stronger but is async, and 64 bits is enough for the only collision that
 * matters: two *successive* versions of one route id colliding, whose consequence
 * is serving the previous configuration's bytes until the TTL runs out.
 */
export const routeFingerprint = (route: Route): string => {
  const memoised = fingerprints.get(route);
  if (memoised !== undefined) {
    return memoised;
  }
  const serialised = stableStringify(route);
  const value = `${fnv1a(serialised).toString(36)}-${djb2(serialised).toString(36)}`;
  fingerprints.set(route, value);
  return value;
};

/**
 * Normalises the request's search string into the parameters that reach the key.
 *
 * Two spellings of one resource must produce one key or "ignoring noise" has
 * only reshaped the fragments. So: parameters are filtered by the configured
 * mode, then sorted, then exact duplicates collapsed. `URLSearchParams` decodes
 * on read and re-encodes on write, which folds the encoding spellings for free
 * — `%61=1` and `a=1` arrive here as the same pair — and folds `?a` and `?a=`
 * into the same empty value. Names stay case-sensitive: the query is opaque
 * bytes to HTTP, and an upstream may treat `Tab` and `tab` differently.
 *
 * `"all"` (the default) sorts too. Parameter order carrying into the key would
 * mean `?a=1&b=2` and `?b=2&a=1` cache twice for no benefit an upstream has
 * ever been shown to draw from parameter order.
 */
const keySearchParams = (url: URL, cache: CacheConfig): URLSearchParams => {
  const query = cache.key.query;
  const params = [...url.searchParams];
  const filtered =
    query === 'all'
      ? params
      : query === 'none'
        ? []
        : params.filter(([name]) =>
            query.include !== undefined
              ? query.include.includes(name)
              : query.ignore !== undefined && !query.ignore.includes(name),
          );
  // Sorted in place: `filter` returned a fresh array, and `params` is already
  // one this function owns. `toSorted` is not in the ES2022 lib this package
  // targets.
  // oxlint-disable-next-line no-array-sort
  filtered.sort(([aName, aValue], [bName, bValue]) =>
    aName === bName ? (aValue < bValue ? -1 : aValue > bValue ? 1 : 0) : aName < bName ? -1 : 1,
  );
  const out = new URLSearchParams();
  for (let index = 0; index < filtered.length; index += 1) {
    const [name, value] = filtered[index]!;
    if (index > 0) {
      const [previousName, previousValue] = filtered[index - 1]!;
      if (previousName === name && previousValue === value) {
        continue;
      }
    }
    out.append(name, value);
  }
  return out;
};

/**
 * How much of a header's value the key can distinguish.
 *
 * Folds the configured headers' request values into the discriminator hash. A
 * missing header is `null` — distinct from `""`, which is a header present and
 * empty — because collapsing them would hand two upstream-distinct requests one
 * entry. Headers that are not configured contribute nothing, so the fold is a
 * no-op hash for every route that has not opted in.
 */
const foldedHeaderHash = (requestHeaders: Headers, cache: CacheConfig): string => {
  const values = cache.key.headers.map((name) => requestHeaders.get(name) ?? null);
  const serialised = JSON.stringify(values);
  return `${fnv1a(serialised).toString(36)}-${djb2(serialised).toString(36)}`;
};

/**
 * Builds the cache key, or returns undefined when this URL cannot have one.
 *
 * The method goes into the key rather than into the `Request`: the Cache API
 * refuses a non-GET key outright — verified, `put` throws `Cannot cache response
 * to non-GET request` — and `match` misses on a HEAD request even when the entry
 * exists. Encoding it in the URL also keeps GET and HEAD in separate entries,
 * which they must be: a HEAD response has no body, and storing it under the GET
 * key hands the next GET an empty one (verified: `content-length: 0`).
 *
 * The discriminator carries the route fingerprint, the method, and a hash of
 * the configured headers' values. Everything configurable about identity lives
 * inside this one parameter's value, so no second reserved parameter exists to
 * collide with — and the route fingerprint already pins `cache.key` itself, so
 * changing the configuration cannot alias an old entry: different keys, old
 * entries expire unnoticed.
 *
 * A request that already carries the parameter gets no key at all. Overwriting it
 * would map two different requests onto one entry, and that is the one failure
 * this module must not have.
 */
export const cacheKey = (
  url: URL,
  method: string,
  fingerprint: string,
  cache: CacheConfig,
  requestHeaders: Headers,
): Request | undefined => {
  if (url.searchParams.has(KEY_PARAM)) {
    return undefined;
  }
  const key = new URL(url);
  key.search = '';
  key.search = keySearchParams(url, cache).toString();
  key.searchParams.set(
    KEY_PARAM,
    `${fingerprint}.${method}.${foldedHeaderHash(requestHeaders, cache)}`,
  );
  return new Request(key.toString(), { method: 'GET' });
};

/**
 * Part of the cache key contributed by the request's own header and cookie
 * values, or `''` when the route matches on neither.
 *
 * The route fingerprint pins the route's *configuration*, but a route whose
 * `match` branches on `x-internal` serves different bytes under one fingerprint
 * — the cache key must say which branch produced an entry or bucket A's bytes
 * get served to bucket B. Every name the match conditions read goes into the
 * key with the value this request actually carried, which is safe even where it
 * is redundant: an `equals` condition pins one value, and pinning it twice
 * costs only a slightly longer key. Query conditions need nothing here — the
 * query is already part of the URL.
 *
 * `''` for unconditioned routes keeps their keys identical to what they were
 * before this field existed, so existing entries survive a deploy.
 */
export const cacheVaryPart = (match: Route['match'], headers: Headers): string => {
  const headerConditions = match.headers ?? [];
  const cookieConditions = match.cookies ?? [];
  if (headerConditions.length === 0 && cookieConditions.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (const condition of headerConditions) {
    parts.push(`${condition.name}=${headers.get(condition.name) ?? ''}`);
  }
  // A cookie name is not a header name, so the value comes out of the parsed
  // `Cookie` header — the same parse route matching used to select this route.
  if (cookieConditions.length > 0) {
    const cookieHeader = headers.get('cookie') ?? '';
    for (const condition of cookieConditions) {
      parts.push(`${condition.name}=${readCookie(cookieHeader, condition.name) ?? ''}`);
    }
  }
  return parts.join(';');
};

/**
 * Whether this request may be served from, or stored in, a shared cache.
 *
 * `Authorization` and `Cookie` are refused because a response to a request
 * carrying either is probably about the person who sent it, and this cache is
 * keyed by URL alone. `Range` is refused because the answer is either a 206 —
 * which the Cache API rejects outright, verified — or a 200 the client will slice
 * itself, and neither belongs in an entry other visitors will read.
 *
 * A WebSocket handshake is refused because it is a GET that no stored response can
 * satisfy: serving one from an entry would hand the client a cached HTTP body where
 * it expected a socket. Rare — it takes a route serving both over one URL — but the
 * failure would be silent and baffling.
 *
 * The client's own `Cache-Control` is deliberately ignored. Honouring `no-cache`
 * from a request would let anyone bypass the cache at will and aim the full load at
 * the upstream, which is the load this exists to prevent.
 */
export const requestCacheable = (request: Request, method: string, cache: CacheConfig): boolean =>
  cache.methods.includes(method as 'GET' | 'HEAD') &&
  !isWebSocketUpgrade(request) &&
  !request.headers.has('authorization') &&
  !request.headers.has('cookie') &&
  !request.headers.has('range');

/** Directives under which a shared cache must not store the response. */
const NO_STORE_DIRECTIVES = new Set(['no-store', 'private', 'no-cache']);

/**
 * Whether a `Cache-Control` value forbids storing the response here.
 *
 * `no-cache` counts. Its actual meaning is "store it, but revalidate before every
 * reuse", and this cache cannot revalidate — the validators are gone — so
 * treating it as unstorable is the only honest reading.
 *
 * The directive name is taken before any `=`, so the `private="set-cookie"` form
 * is recognised rather than read as an unknown directive.
 */
const forbidsSharedCaching = (value: string | null): boolean =>
  value !== null &&
  value
    .toLowerCase()
    .split(',')
    .some((directive) => NO_STORE_DIRECTIVES.has(directive.trim().split('=')[0]!.trim()));

/**
 * Request headers a response may vary on while still being cacheable here.
 *
 * `accept-encoding` is provable rather than hopeful: `buildUpstreamHeaders`
 * deletes it from every upstream request, so the upstream sees the same absent
 * value every time and cannot vary its answer on it.
 */
const VARY_NAMES_ALREADY_FIXED = new Set(['accept-encoding']);

/**
 * Whether a `Vary` value is one this key covers.
 *
 * A varying response is cacheable exactly when every name the upstream points
 * at is already represented in the key. Two ways that can be true:
 *
 * - `accept-encoding`, which the upstream never sees vary (see above) — so the
 *   key does not need it.
 * - A header listed in `cache.key.headers`, whose request value is folded into
 *   the discriminator hash. Entries for differing values are distinct by
 *   construction, which is the same service `Vary` exists to request.
 *
 * Everything else is unrepresented — and the platform will not make up the
 * difference. Verified in workerd: an entry stored with `Vary: cookie` was
 * returned for a request carrying a *different* cookie, so `match` does not
 * honour `Vary` at all. That makes this check the only thing standing between a
 * varying response and one visitor being served another's. `*` names no header
 * at all, so nothing can fold it into a key.
 */
const varyIsCovered = (value: string | null, cache: CacheConfig): boolean => {
  if (value === null || value.trim() === '') {
    return true;
  }
  return value
    .toLowerCase()
    .split(',')
    .every((name) => {
      const trimmed = name.trim();
      return trimmed === '*'
        ? false
        : VARY_NAMES_ALREADY_FIXED.has(trimmed) || cache.key.headers.includes(trimmed);
    });
};

/**
 * The window a response with this status is served as fresh, in seconds.
 *
 * 200 keeps `ttlSeconds` unless `statusTtlSeconds` overrides it; every other
 * status is cached only when the operator named it, and then for the named
 * window. One lookup feeds both the store gate and the read windows below, so a
 * status cannot be stored under one lifetime and read back under another.
 */
const ttlForStatus = (status: number, cache: CacheConfig): number =>
  cache.statusTtlSeconds?.[String(status)] ?? (status === 200 ? cache.ttlSeconds : 0);

/**
 * How far past the TTL a stored entry is held at all, in seconds.
 *
 * The stale-while-revalidate and stale-if-error windows are both measured from
 * the TTL, and a stored copy carries whichever is longer — so an entry stays
 * visible to `match` for the whole span and this function says which part of
 * the span still means anything.
 */
const holdSeconds = (cache: CacheConfig): number =>
  Math.max(cache.staleWhileRevalidateSeconds, cache.staleIfError?.seconds ?? 0);

/**
 * Whether this response may be stored.
 *
 * Statuses first: 200 always, any other status only when `statusTtlSeconds`
 * names it. A 206 and a `Vary: *` make `put` throw; a 304, a 5xx and a
 * `private`/`no-store`/`no-cache` response are accepted by `put` and then
 * silently absent from `match` — all verified in workerd — so neither the throw
 * nor the silence is a check this can lean on. A 404, on the other hand, *is*
 * stored by the platform, which is what makes negative caching viable here at
 * all; the schema refuses the statuses the platform will not hand back.
 *
 * **Two header sources, on purpose.** `Cache-Control`, `Set-Cookie` and `Vary` are
 * read from what the upstream sent, not from the response as it will be delivered.
 * Those three are the upstream stating a fact about the response — this is
 * personalised, this varies on that — and an operator's `responseHeaders.remove`
 * can delete the statement without changing the fact. Reading them post-rule would
 * make `remove: ['vary']` or `remove: ['cache-control']` a way to cache a private
 * or varying response for every visitor. They apply to every stored status: an
 * opted-in 404 with `Set-Cookie` is refused exactly as a 200 would be.
 *
 * `status` and `Content-Type` are read from the delivered response, because a
 * content type is a label an operator may legitimately correct — an upstream
 * serving CSS as `application/octet-stream` is a real thing — and correcting it
 * says nothing about whether the body is safe to share. The content-type *list*
 * itself gates only 200s: it exists to keep personalised documents out of an
 * asset cache, and a status the operator opted into by code — the scanner 404,
 * the permanent redirect — is cached whatever body rides along, with the vetoes
 * above still standing guard.
 */
export const responseCacheable = (
  response: Response,
  upstreamHeaders: Headers,
  cache: CacheConfig,
): boolean =>
  ttlForStatus(response.status, cache) > 0 &&
  upstreamHeaders.getSetCookie().length === 0 &&
  !forbidsSharedCaching(upstreamHeaders.get('cache-control')) &&
  varyIsCovered(upstreamHeaders.get('vary'), cache) &&
  (response.status !== 200 ||
    contentTypeAllowed(parseContentType(response.headers.get('content-type')), cache.contentTypes));

export interface CachedResponse {
  /**
   * `hit` inside the TTL, `stale` inside the stale-while-revalidate window,
   * `stale_error` when an expired entry was served only because the upstream
   * could not answer — the state `onProxy` filters on to tell a degradation
   * apart from a healthy delivery.
   */
  state: 'hit' | 'stale' | 'stale_error';
  /** How long the entry has been stored, in whole seconds. */
  ageSeconds: number;
  response: Response;
}

export interface ReadCacheOptions {
  store: ResponseCacheStore;
  key: Request;
  cache: CacheConfig;
  /** Injected so the windows are testable without waiting them out. */
  now: number;
  /**
   * Whether the stale-if-error window counts. False on the healthy path, where
   * an entry past TTL and SWR is simply gone; true only on a failure path, and
   * then an entry inside that window is returned as `stale_error` instead of a
   * miss. Not a flag a caller can wave to serve stale on a whim: the caller has
   * just watched the upstream fail to answer.
   */
  allowStaleError?: boolean;
}

/**
 * Reads an entry, classifying it as fresh, stale or stale-from-error, or
 * reporting a miss.
 *
 * The internal metadata headers are stripped and the upstream's own
 * `Cache-Control` restored, so what reaches the client is what a miss would have
 * given it — plus an accurate `Age`, which a shared cache owes it.
 */
export const readCachedResponse = async ({
  store,
  key,
  cache,
  now,
  allowStaleError = false,
}: ReadCacheOptions): Promise<CachedResponse | undefined> => {
  const stored = await store.match(key);
  if (stored === undefined) {
    return undefined;
  }
  const raw = stored.headers.get(STORED_AT_HEADER);
  const storedAt = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(storedAt)) {
    // Metadata this module did not write, or wrote in a shape it no longer
    // understands. An entry of unknown vintage is precisely what a TTL exists to
    // bound, so it is a miss rather than a guess.
    return undefined;
  }
  const ageSeconds = Math.max(0, (now - storedAt) / 1000);
  const ttl = ttlForStatus(stored.status, cache);
  const swrHorizon = ttl + cache.staleWhileRevalidateSeconds;
  // The healthy path ends at the SWR horizon, exactly as it always has; the
  // failure path may reach into the stale-if-error window beyond it. Widening
  // the healthy horizon instead would quietly serve stale to every visitor the
  // moment `staleIfError` is configured, which is not what that knob buys.
  if (ageSeconds >= (allowStaleError ? ttl + holdSeconds(cache) : swrHorizon)) {
    // The platform still holds it, because the stored lifetime covers the whole
    // span, but by this route's configuration it is spent.
    return undefined;
  }

  const headers = new Headers(stored.headers);
  headers.delete(STORED_AT_HEADER);
  const originCacheControl = headers.get(ORIGIN_CACHE_CONTROL_HEADER);
  headers.delete(ORIGIN_CACHE_CONTROL_HEADER);
  if (originCacheControl === null) {
    // The stored value is jouska's own window, not something the upstream said;
    // passing it on would put words in the upstream's mouth.
    headers.delete('cache-control');
  } else {
    headers.set('cache-control', originCacheControl);
  }
  const whole = Math.floor(ageSeconds);
  headers.set('age', String(whole));

  // `stale_error` is reachable only past the SWR horizon and only with
  // `allowStaleError` — an entry the healthy path would still have served is
  // reported as `stale` even on a failure path, so a degradation is not
  // overstated: it names the entries that exist *only* because of the failure.
  const state: CachedResponse['state'] =
    ageSeconds < ttl ? 'hit' : ageSeconds < swrHorizon ? 'stale' : 'stale_error';
  headers.set(CACHE_STATE_HEADER, state);
  return {
    state,
    ageSeconds: whole,
    response: new Response(stored.body, {
      status: stored.status,
      statusText: stored.statusText,
      headers,
    }),
  };
};

export interface StoreCacheOptions {
  store: ResponseCacheStore;
  key: Request;
  /** The response whose bytes are to be stored. Cloned here when needed, not by the caller. */
  response: Response;
  cache: CacheConfig;
  now: number;
  /**
   * Whether this response is also going to a client.
   *
   * True on the request path, where the same response is being returned and a copy
   * has to be taken before the runtime reads it. False for a background refresh,
   * whose response goes nowhere: cloning there would leave a tee branch with no
   * reader, and the runtime buffers what one branch has read until the other
   * catches up.
   */
  alsoServed: boolean;
}

/**
 * Stores a copy of the response.
 *
 * When the response is also being served, the clone happens inside this function
 * and synchronously, so the copy is taken before the caller returns the original
 * and the runtime starts reading it. Verified in workerd: `put` on a body that has
 * already been read throws `Body has already been used`, while a clone taken first
 * streams to both consumers intact.
 *
 * A failed write is swallowed. It cannot be allowed to fail a response that has
 * already succeeded, and the symptom of a store that keeps refusing — an object
 * over the size limit, most likely — is a hit rate of zero, which both the
 * `x-jouska-cache` header and `onProxy` surface.
 */
export const storeCachedResponse = async ({
  store,
  key,
  response,
  cache,
  now,
  alsoServed,
}: StoreCacheOptions): Promise<void> => {
  const copy = alsoServed ? response.clone() : response;
  const headers = new Headers(copy.headers);
  // Read before writing, and cleared unconditionally, so an upstream that sends
  // these names cannot plant metadata that would be trusted on the way out.
  const originCacheControl = headers.get('cache-control');
  headers.delete(ORIGIN_CACHE_CONTROL_HEADER);
  headers.delete(CACHE_STATE_HEADER);
  if (originCacheControl !== null) {
    headers.set(ORIGIN_CACHE_CONTROL_HEADER, originCacheControl);
  }
  headers.set(STORED_AT_HEADER, String(now));
  // The Cache API stores nothing without an explicit lifetime — verified, a
  // response with no `Cache-Control` at all came back a miss — and an entry it
  // considers expired is invisible rather than stale, so the declared lifetime
  // has to cover every window this route may still read through: the TTL, the
  // stale-while-revalidate window and the stale-if-error one, whichever is
  // longer. Which part of the span an entry is in is decided from the timestamp
  // above, not from this number, and the per-status TTL — not `ttlSeconds`
  // directly — because a 404 stored under `statusTtlSeconds` reads back under
  // the same window it was stored with.
  headers.set('cache-control', `max-age=${ttlForStatus(copy.status, cache) + holdSeconds(cache)}`);
  try {
    await store.put(
      key,
      new Response(copy.body, {
        status: copy.status,
        statusText: copy.statusText,
        headers,
      }),
    );
  } catch {
    // See the note above: a cache write may not fail a served response.
  }
};

/**
 * Keys with a cold-miss flight in progress, per isolate.
 *
 * Same shape as `refreshing` below, but for the other herd: a cold cache turns
 * the first wave of traffic into one upstream request instead of one each, the
 * way nginx's `proxy_cache_lock` does. The entry carries the deferred and its
 * setter apart — the setter is the leader's handle, the deferred the waiters' —
 * so a caller can only ever release a flight it began.
 */
const flights = new Map<string, { done: Promise<void>; release: () => void }>();

/**
 * The waiter's side of a cold-miss flight.
 *
 * Resolves when the leader releases the flight, or after `totalTimeoutMs` —
 * whichever comes first. The bound is what keeps the lock from turning a slow
 * upstream into a pile of hung requests: a waiter that times out simply
 * fetches on its own, exactly as it would have without the lock. Resolving
 * says nothing about whether an entry appeared; the waiter re-reads the cache
 * and decides that for itself, which is why the flight carries no payload.
 */
export const joinFlight = (key: Request, totalTimeoutMs: number): Promise<void> => {
  const flight = flights.get(key.url);
  if (flight === undefined) {
    return Promise.resolve();
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    flight.done,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, totalTimeoutMs);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
};

/**
 * Begins a cold-miss flight for this key, unless one is already running.
 *
 * Returns the release function when this caller leads — it runs the fetch, the
 * cacheability check and the store, then releases once the write has landed
 * (release-after-write: a waiter woken any earlier would re-read a cache the
 * entry is not in yet and fetch from the upstream after all) — or undefined
 * when another caller already leads, and this one should `joinFlight` instead.
 * Releasing on every path, including a thrown fill, is the caller's duty: a
 * leader that dies holding the key pins every waiter to its own timeout.
 *
 * Releasing removes the key synchronously, so the next cold miss after this one
 * begins its own flight rather than joining a finished one; a second call is a
 * no-op, which makes `finally`-shaped callers safe.
 */
export const beginFlight = (key: Request): (() => void) | undefined => {
  if (flights.has(key.url)) {
    return undefined;
  }
  let resolve!: () => void;
  const done = new Promise<void>((set) => {
    resolve = set;
  });
  const release = (): void => {
    flights.delete(key.url);
    resolve();
  };
  flights.set(key.url, { done, release });
  return release;
};

/**
 * Keys with a background refresh in flight, per isolate.
 *
 * A burst of stale requests must trigger one revalidation, not one each — the
 * same collapse the config cache performs for its own loads, and for the same
 * reason: the thundering herd arrives exactly when the upstream is the thing
 * being protected.
 */
const refreshing = new Set<string>();

/**
 * Runs a background refresh unless one is already in flight for this key.
 *
 * Returns the promise to hand to `waitUntil`, or undefined when another refresh
 * has it covered. Errors are contained: a failed refresh leaves the stale entry
 * in place, which is the whole point of serving stale in the first place.
 */
export const refreshOnce = (
  key: Request,
  refresh: () => Promise<unknown>,
): Promise<void> | undefined => {
  if (refreshing.has(key.url)) {
    return undefined;
  }
  refreshing.add(key.url);
  return (async () => {
    try {
      await refresh();
    } catch {
      // The stale entry stays; the next request past the TTL tries again.
    } finally {
      refreshing.delete(key.url);
    }
  })();
};
