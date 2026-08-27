import type { Config, Route } from './config.js';

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
 */
const hostMatches = (pattern: string, host: string): boolean => {
  if (pattern.startsWith('*.')) {
    // '*.example.com' matches any subdomain, but not the apex: the suffix
    // includes the leading dot, so 'example.com'.endsWith('.example.com')
    // is false, while 'a.example.com'.endsWith('.example.com') is true.
    const suffix = pattern.slice(1); // '.example.com', already lowercased
    return host.endsWith(suffix) && host.length > suffix.length;
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
 * Normalised variants of a request path, for matching only.
 *
 * The original is always first, so that {@link stripMatchedPrefix} can preserve
 * the client's encoding when stripping — `/%61dmin` decodes to `/admin` but
 * must be forwarded as `/%61dmin`, not re-encoded to `/admin` (which is a
 * different request to most upstreams).
 *
 * The variants defend against authorisation bypass: a guard on `/admin` must
 * also fire for `/%61dmin` (percent-decoded by every upstream), `//admin`
 * (separators collapsed by most servers), and `/admin;x` (path parameters
 * stripped by Tomcat and others).
 */
const pathCandidates = (path: string): string[] => {
  const candidates: string[] = [path];
  const seen = new Set([path]);

  const add = (p: string): void => {
    if (!seen.has(p)) {
      seen.add(p);
      candidates.push(p);
    }
  };

  // Decode percent-escapes: `/%61dmin` → `/admin`
  let decoded = path;
  try {
    decoded = decodeURI(path);
    add(decoded);
  } catch {
    // Invalid escape sequence — leave it encoded, it cannot be a bypass.
  }

  // Collapse repeated separators: `//admin` → `/admin`
  const collapsed = path.replace(/\/{2,}/g, '/');
  add(collapsed);

  // Strip path parameters: `/admin;x` → `/admin`
  const noParams = path.replace(/;[^/]*/g, '');
  add(noParams);

  // Fully normalised: decode → collapse → strip, applied in sequence
  let normalised = decoded;
  normalised = normalised.replace(/\/{2,}/g, '/');
  normalised = normalised.replace(/;[^/]*/g, '');
  add(normalised);

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
 */
export const matchUrl = (config: Config, url: URL, method: string): Match | undefined => {
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
    return { route, index: i, matchedPrefix: pathPrefix ?? '' };
  }
  return undefined;
};

/**
 * Wrapper for tests and callers that have a `Request` rather than a parsed
 * `URL`. Production code parses once and calls {@link matchUrl} directly.
 */
export const matchRoute = (config: Config, request: Request): Match | undefined =>
  matchUrl(config, new URL(request.url), request.method);

/**
 * Builds the absolute upstream URL, applying the base path and prefix strip.
 *
 * The scheme comes from the route config (`http` or `https`), not a hardcoded
 * `https://` — local and in-network origins were unreachable before. The
 * client's path encoding is preserved: `/%61dmin` is forwarded as
 * `/%61dmin`, not re-encoded.
 */
export const resolveUpstreamUrl = (match: Match, url: URL): URL => {
  const { route } = match;
  const { authority, basePath } = splitUpstream(route.upstream);

  const tail = route.stripPrefix
    ? stripMatchedPrefix(url.pathname, match.matchedPrefix)
    : url.pathname;

  const target = new URL(`${route.scheme}://${authority}`);
  target.pathname = `${basePath}${tail.startsWith('/') ? '' : '/'}${tail}`;
  target.search = url.search;
  return target;
};
