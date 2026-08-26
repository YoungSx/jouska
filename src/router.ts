import type { Config, Route } from './config';

/**
 * A stable label for a route, derived from what it matches rather than a
 * user-maintained id. Used to namespace rate-limit buckets so two routes never
 * share a budget by accident.
 */
export const routeId = (route: Route): string =>
  `${route.match.host ?? '*'}${route.match.path ?? '/*'}`;

export interface Match {
  route: Route;
  /** The path prefix that matched, or '' when the route matched on host only. */
  matchedPrefix: string;
}

const hostMatches = (pattern: string, host: string): boolean => {
  if (pattern.startsWith('*')) {
    // '*.example.com' matches any subdomain, but not the apex.
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return pattern.toLowerCase() === host;
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
 * First matching route wins, so ordering in the config is significant.
 * Host is compared case-insensitively and without its port.
 */
export const matchRoute = (config: Config, request: Request): Match | undefined => {
  const url = new URL(request.url);
  const host = (request.headers.get('host') ?? url.host).split(':')[0]!.toLowerCase();

  for (const route of config.routes) {
    const { host: hostPattern, path: pathPrefix, methods } = route.match;

    if (hostPattern !== undefined && !hostMatches(hostPattern, host)) {
      continue;
    }
    if (pathPrefix !== undefined && !pathMatches(pathPrefix, url.pathname)) {
      continue;
    }
    if (methods !== undefined && !methods.some((m) => m.toUpperCase() === request.method)) {
      continue;
    }
    return { route, matchedPrefix: pathPrefix ?? '' };
  }
  return undefined;
};

/** Builds the absolute upstream URL, applying the base path and prefix strip. */
export const resolveUpstreamUrl = (match: Match, request: Request): URL => {
  const url = new URL(request.url);
  const slash = match.route.upstream.indexOf('/');
  const host = slash === -1 ? match.route.upstream : match.route.upstream.slice(0, slash);
  const base = slash === -1 ? '' : match.route.upstream.slice(slash).replace(/\/$/, '');

  const tail = match.route.stripPrefix
    ? url.pathname.slice(match.matchedPrefix.length) || '/'
    : url.pathname;

  const target = new URL(`https://${host}`);
  target.pathname = `${base}${tail.startsWith('/') ? '' : '/'}${tail}`;
  target.search = url.search;
  return target;
};
