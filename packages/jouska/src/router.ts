import type { Config, Route } from './config.js';
import { readCookie } from './internal/cookies.js';

/**
 * Splits an upstream string into its authority and base path.
 *
 * `api.example.com/openai-compatible` → `{ authority: 'api.example.com', basePath: '/openai-compatible' }`.
 * `api.example.com:8443/v1` → `{ authority: 'api.example.com:8443', basePath: '/v1' }`.
 * `api.example.com` → `{ authority: 'api.example.com', basePath: '' }`.
 */
export const splitUpstream = (upstream: string): { authority: string; basePath: string } => {
  const slash = upstream.indexOf('/');
  if (slash === -1) {
    return { authority: upstream, basePath: '' };
  }
  const authority = upstream.slice(0, slash);
  const basePath = upstream.slice(slash).replace(/\/$/, '');
  return { authority, basePath };
};

/**
 * Stable label for a route, used to namespace rate-limit buckets.
 *
 * Prefers the route's own `id` when set. Otherwise derives from the match
 * pattern and the route's position in the table, so two routes that differ
 * only in method — which share the same host+path — do not share a bucket.
 */
export const routeId = (route: Route, index: number): string =>
  route.id ?? `${route.match.host ?? '*'}${route.match.path ?? '/*'}#${index}`;

export interface Match {
  route: Route;
  /** Position in the route table, for stable per-route labelling. */
  index: number;
  /** The path prefix that matched, or '' when the route matched on host only. */
  matchedPrefix: string;
}

/**
 * Whether a host pattern matches the request host.
 *
 * The schema already lowercases the pattern and requires `*.` for wildcards,
 * so a bare `*example.com` that would match `evilexample.com` cannot reach
 * this function. The request host is lowercased by the caller.
 *
 * Exported because it is the only host matcher in this repo: `match.host` uses
 * it, and the `referer` guard must compare against exactly the same rules, so
 * an allow-list entry and a match entry mean the same thing.
 */
export const hostMatches = (pattern: string, host: string): boolean => {
  if (pattern.startsWith('*.')) {
    // '*.example.com' matches any subdomain, but not the apex: the suffix
    // includes the leading dot, so 'example.com'.endsWith('.example.com')
    // is false, while 'a.example.com'.endsWith('.example.com') is true.
    const suffix = pattern.slice(1); // '.example.com', already lowercased
    if (!host.endsWith(suffix) || host.length <= suffix.length) {
      return false;
    }
    // What the '*' consumed has to be a real subdomain, not merely non-empty.
    // A length check alone accepted '..example.com', whose leading label is
    // empty — verified in workerd, the URL parser keeps that hostname verbatim,
    // so it arrives here rather than being rejected upstream. Requiring every
    // label to be non-empty is the check that says what was meant.
    const consumed = host.slice(0, host.length - suffix.length);
    return consumed.split('.').every((label) => label !== '');
  }
  return pattern === host;
};

/** Matches on segment boundaries so `/openai` does not match `/openai-beta`. */
const pathMatches = (prefix: string, path: string): boolean => {
  if (!path.startsWith(prefix)) {
    return false;
  }
  const rest = path.slice(prefix.length);
  return rest === '' || rest.startsWith('/') || prefix.endsWith('/');
};

/**
 * Whether a value condition holds, for any family that reads a value out of the
 * request. `present` does not consult the value at all: an empty value is a
 * value, so `present: true` matches `X-Foo:` and only an absent name satisfies
 * `present: false`.
 */
const valueConditionHolds = (
  condition: { equals?: string; prefix?: string; present?: boolean },
  value: string | undefined,
): boolean => {
  if (condition.present !== undefined) {
    return condition.present ? value !== undefined : value === undefined;
  }
  if (value === undefined) {
    return false;
  }
  if (condition.equals !== undefined) {
    return value === condition.equals;
  }
  return value.startsWith(condition.prefix!);
};

/**
 * Whether a route's `match` conditions on headers, query and cookies all hold.
 *
 * Within and across the three families everything is AND. OR is expressed by
 * writing two routes — the table is ordered and first match wins, so a route
 * per branch is the honest spelling of "either".
 *
 * Header values come from `Headers.get`, which per the fetch spec is the
 * combined value: repeated headers arrive as one comma-joined string. The same
 * applies to `searchParams.get` and `readCookie` — each family reads the first
 * value under the name. Matching on a repeated name is therefore a match
 * against its first occurrence, which the README states rather than leaves to
 * be discovered.
 */
const conditionsHold = (route: Route, url: URL, headers: Headers): boolean => {
  const { headers: headerConditions, query, cookies } = route.match;
  if (headerConditions !== undefined) {
    for (const condition of headerConditions) {
      const value = headers.get(condition.name);
      if (!valueConditionHolds(condition, value === null ? undefined : value)) {
        return false;
      }
    }
  }
  if (query !== undefined) {
    for (const condition of query) {
      const value = url.searchParams.get(condition.name);
      if (!valueConditionHolds(condition, value === null ? undefined : value)) {
        return false;
      }
    }
  }
  if (cookies !== undefined) {
    const cookieHeader = headers.get('cookie');
    for (const condition of cookies) {
      const value = cookieHeader === null ? undefined : readCookie(cookieHeader, condition.name);
      if (!valueConditionHolds(condition, value)) {
        return false;
      }
    }
  }
  return true;
};

/**
 * Separators an upstream may decode after jouska has finished matching.
 *
 * `decodeURI` deliberately leaves these alone — it is the inverse of
 * `encodeURI`, which never produces them — so a candidate built with it can
 * never turn `/%2fadmin` back into `/admin`. Verified in workerd: a guarded
 * `/admin` route did not match `/%2fadmin`, `/%5cadmin`, `/admin%3fx` or
 * `/admin%23x`, so each one slipped past the guard and reached a laxer route
 * while the upstream still saw a path it would decode to `/admin`.
 *
 * `%5c` is included because Windows-hosted and JVM upstreams treat a backslash
 * as a path separator. `%3f` and `%23` cut a path short at a query or fragment,
 * which reaches the same handler by a different route.
 */
const ENCODED_SEPARATORS: readonly [RegExp, string][] = [
  [/%2f/gi, '/'],
  [/%5c/gi, '/'],
  [/%3f/gi, '?'],
  [/%23/gi, '#'],
];

/** Applies one normalisation round: decode, then collapse the forms it exposed. */
const normaliseOnce = (path: string): string => {
  let out = path;
  // Percent-decoding first, so an escape that hides a separator or a dot
  // segment is visible to the rules below.
  try {
    out = decodeURI(out);
  } catch {
    // Invalid escape sequence; keep going with what we have.
  }
  for (const [pattern, replacement] of ENCODED_SEPARATORS) {
    out = out.replace(pattern, replacement);
  }
  // A path cut short at a query or fragment reaches the same handler.
  out = out.split(/[?#]/)[0]!;
  // Backslash as a separator, for upstreams that accept it.
  out = out.replaceAll('\\', '/');
  // Path parameters: `/admin;x` → `/admin`.
  out = out.replace(/;[^/]*/g, '');
  // Dot segments, which only appear once the escapes above are decoded.
  out = collapseDotSegments(out);
  // Repeated separators, last: the rules above can expose new ones.
  out = out.replace(/\/{2,}/g, '/');
  return out;
};

/**
 * Resolves `.` and `..` segments.
 *
 * The URL parser does this for the literal forms, so only the percent-encoded
 * spellings reach here — `/a/%2e%2e/admin` decodes to `/a/../admin` in the round
 * above, and without this it would stay that way and match no route while the
 * upstream resolved it to `/admin`.
 */
const collapseDotSegments = (path: string): string => {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '.') {
      continue;
    }
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/') || '/';
};

/** Bound on normalisation rounds, so a crafted path cannot spin here. */
const MAX_NORMALISE_ROUNDS = 8;

/**
 * Normalised variants of a request path, for matching only.
 *
 * The original is always first, so that {@link stripMatchedPrefix} can preserve
 * the client's encoding when stripping — `/%61dmin` decodes to `/admin` but
 * must be forwarded as `/%61dmin`, not re-encoded to `/admin` (which is a
 * different request to most upstreams).
 *
 * The variants defend against authorisation bypass: a guard on `/admin` must
 * also fire for every spelling an upstream would resolve to `/admin`. Which
 * spellings those are is not a list anyone can finish from memory, so this
 * applies the rules repeatedly until the path stops changing rather than once in
 * a fixed order. A single pass is what let `/;x/admin` through: stripping `;x`
 * produced `//admin`, but the separator-collapsing step had already run, so
 * nothing collapsed it. Verified in workerd, along with `/%252fadmin`, where one
 * decode leaves `%2f` and only a second turns it into a separator.
 *
 * Every intermediate form is offered as a candidate, not just the fixed point:
 * upstreams normalise to differing depths, and a guard has to fire for whichever
 * one the upstream lands on.
 */
const pathCandidates = (path: string): string[] => {
  const candidates: string[] = [path];
  const seen = new Set([path]);

  let current = path;
  for (let round = 0; round < MAX_NORMALISE_ROUNDS; round += 1) {
    const next = normaliseOnce(current);
    if (next === current) {
      break;
    }
    if (!seen.has(next)) {
      seen.add(next);
      candidates.push(next);
    }
    current = next;
  }

  return candidates;
};

/**
 * Strips the matched prefix from the path, preserving the client's encoding.
 *
 * Tries each candidate in order: the original path first (so `%20` stays
 * `%20`), then normalised forms. Returns `/` when the prefix consumes the
 * whole path. If no candidate matches (should not happen, as the route was
 * already matched), falls back to the original path unstripped.
 */
const stripMatchedPrefix = (path: string, prefix: string): string => {
  for (const candidate of pathCandidates(path)) {
    if (pathMatches(prefix, candidate)) {
      return candidate.slice(prefix.length) || '/';
    }
  }
  return path;
};

/**
 * First matching route wins, so ordering in the config is significant.
 *
 * Host is read from `url.hostname` (not the `Host` header) and compared
 * case-insensitively, without its port. Reading the URL rather than the
 * header prevents a forged `Host` from selecting a different route.
 *
 * The request headers are required rather than optional. A route may match on
 * them, so a caller that cannot supply real headers must say so with an empty
 * `Headers` rather than have conditions silently treated as unmet — which
 * would turn a header-qualified route into one that matches nothing.
 */
export const matchUrl = (
  config: Config,
  url: URL,
  method: string,
  headers: Headers,
): Match | undefined => {
  const host = url.hostname.toLowerCase();

  for (let i = 0; i < config.routes.length; i++) {
    const route = config.routes[i]!;
    const { host: hostPattern, path: pathPrefix, methods } = route.match;

    if (hostPattern !== undefined && !hostMatches(hostPattern, host)) {
      continue;
    }
    if (
      pathPrefix !== undefined &&
      !pathCandidates(url.pathname).some((c) => pathMatches(pathPrefix, c))
    ) {
      continue;
    }
    if (methods !== undefined && !methods.some((m) => m.toUpperCase() === method.toUpperCase())) {
      continue;
    }
    if (!conditionsHold(route, url, headers)) {
      continue;
    }
    return { route, index: i, matchedPrefix: pathPrefix ?? '' };
  }
  return undefined;
};

/**
 * Wrapper for tests and callers that have a `Request` rather than a parsed
 * `URL`. Production code parses once and calls {@link matchUrl} directly.
 */
export const matchRoute = (config: Config, request: Request): Match | undefined =>
  matchUrl(config, new URL(request.url), request.method, request.headers);

/**
 * The candidates a request may be sent to, preferred one first.
 *
 * `upstreams` is already an order. `trafficSplit` is not — its entries are a
 * distribution — so the walk order is the declared order rotated to put the
 * selected entry first: failover from the winner moves on to the other split
 * participants in the order they were written. `primaryIndex` therefore only
 * means something for a split; the other forms ignore it. The config's
 * cross-field check guarantees exactly one of the three forms parsed.
 */
export const upstreamCandidates = (route: Route, primaryIndex = 0): string[] => {
  if (route.upstreams !== undefined) {
    return route.upstreams;
  }
  if (route.trafficSplit !== undefined) {
    const split = route.trafficSplit.map((entry) => entry.upstream);
    const start = Math.min(Math.max(primaryIndex, 0), split.length - 1);
    return [...split.slice(start), ...split.slice(0, start)];
  }
  return [route.upstream!];
};

/**
 * Builds the absolute upstream URL, applying the base path and prefix strip.
 *
 * The candidate is passed explicitly rather than read from the route: with a
 * failover list or a split there is no single `upstream` to read, and the
 * caller — which picked the candidate — is the authority on which one is being
 * resolved.
 *
 * The scheme comes from the route config (`http` or `https`), not a hardcoded
 * `https://` — local and in-network origins were unreachable before. The
 * client's path encoding is preserved: `/%61dmin` is forwarded as
 * `/%61dmin`, not re-encoded.
 */
export const resolveUpstreamUrl = (match: Match, url: URL, upstream: string): URL => {
  const { route } = match;
  const { authority, basePath } = splitUpstream(upstream);

  const tail = route.stripPrefix
    ? stripMatchedPrefix(url.pathname, match.matchedPrefix)
    : url.pathname;

  const target = new URL(`${route.scheme}://${authority}`);
  target.pathname = `${basePath}${tail.startsWith('/') ? '' : '/'}${tail}`;
  target.search = url.search;
  return target;
};
