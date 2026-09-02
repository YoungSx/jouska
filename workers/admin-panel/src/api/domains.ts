/**
 * Hostname discovery endpoint: where is the proxy actually reachable?
 *
 * An operator writing `match.host` has to know which hostnames arrive at the
 * proxy Worker. That fact lives in the Cloudflare account, so it is read from
 * there — and then matched against the route table, so the screen answers the
 * two questions the operator actually has: which of my hostnames has no route,
 * and which of my routes matches no hostname.
 *
 * Read-only throughout. Discovery writes nothing: not to D1, not to KV, not to
 * the audit log. It is a lookup, and a lookup that recorded itself would turn
 * opening a screen into a write.
 */
import { Hono } from 'hono';
import { discoverBoundHosts, type BoundHost, type DiscoveryResult } from '../cloudflare.js';
import { listAllRoutes } from '../store.js';
import type { AppEnv, Env } from '../env.js';

/** Script name of the reference reverse proxy, per its wrangler.jsonc. */
const DEFAULT_PROXY_SCRIPT = 'jouska';

/**
 * How long a discovery answer is reused.
 *
 * Isolate memory, not KV or D1: the answer is an external fact that can always
 * be re-fetched, so persisting it would add a write per lookup and a staleness
 * problem on top. Sixty seconds keeps a burst of screen-opens to one API call
 * while staying fresh enough that an operator who just bound a domain in the
 * dashboard sees it on a second look rather than a second deploy.
 */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  /** Identifies the credentials and script the answer was fetched for. */
  readonly key: string;
  readonly at: number;
  readonly result: DiscoveryResult;
}

/**
 * Module scope, so a burst of requests in one isolate shares one API call.
 *
 * Keyed by what it was fetched for rather than closing over the first `env`
 * seen: a rotated token or a renamed proxy must produce a fresh answer, not a
 * cached one from the old configuration.
 */
let cache: CacheEntry | undefined;

/** Discards the cache. Exported for tests, which need each case to start cold. */
export const __resetDomainCache = (): void => {
  cache = undefined;
};

/**
 * Test-only seam. Kept off `Env` so a production binding cannot supply it: an
 * environment variable that replaces the Cloudflare API fetch would let a
 * deployment be told an arbitrary set of hostnames is bound, which is exactly
 * the claim this endpoint exists to make trustworthy.
 */
export interface DiscoveryOverrides {
  CF_API_FETCH?: typeof fetch;
}

/** Why discovery is unavailable, phrased for an operator, not a log. */
export type UnconfiguredReason = 'missing_account_id' | 'missing_token' | 'missing_both';

/** How a host relates to the route table. */
export interface HostBinding extends BoundHost {
  /**
   * Route ids whose `match.host` would accept this host. Empty means the host
   * reaches the proxy but no route claims it — traffic falls through.
   */
  readonly routeIds: readonly string[];
}

export interface DomainsResponse {
  /** False when no credentials are configured; `reason` says which are missing. */
  readonly configured: boolean;
  readonly reason?: UnconfiguredReason;
  /** Script name the answer is about, so the UI never has to guess. */
  readonly script?: string;
  readonly hosts?: readonly HostBinding[];
  /** Sources that could not be read, named individually. */
  readonly failures?: readonly { readonly source: string; readonly message: string }[];
  readonly skippedZones?: readonly string[];
  /**
   * Route `match.host` values that no discovered host satisfies. A route here
   * is either waiting on a binding that has not been made, or a typo.
   *
   * Absent — not empty — when no source could be read: with nothing to compare
   * against, every route would look unmatched, which is a false alarm.
   */
  readonly unmatchedRouteHosts?: readonly { readonly routeId: string; readonly host: string }[];
}

/**
 * Whether a route's `match.host` pattern accepts a discovered host.
 *
 * Mirrors the library's own `hostMatches`: `*.example.com` matches subdomains
 * but not the apex, and every consumed label must be non-empty. Duplicated
 * rather than imported because the library does not export it, and because the
 * inputs differ — here the *host* may itself be a wildcard, from a route
 * pattern like `*.example.com/*`.
 */
const coveredByWildcard = (wildcard: string, candidate: string): boolean => {
  // The suffix keeps the leading dot, so `example.com` does not end with
  // `.example.com` and the apex is excluded — the rule the router applies.
  const suffix = wildcard.slice(1);
  if (!candidate.endsWith(suffix)) {
    return false;
  }
  // What the `*` consumed must be real labels, not merely non-empty: workerd's
  // URL parser keeps `..example.com` verbatim, so an empty label reaches here.
  // This also rejects the equal-length case, where nothing was consumed.
  return candidate
    .slice(0, candidate.length - suffix.length)
    .split('.')
    .every((label) => label !== '');
};

const hostSatisfies = (pattern: string, host: string): boolean => {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === h) {
    return true;
  }
  // A wildcard `match.host` against a discovered host.
  if (p.startsWith('*.')) {
    return coveredByWildcard(p, h);
  }
  // The discovered "host" is itself a wildcard, from a route pattern like
  // `*.example.com/*`, and the route names a concrete host inside it.
  if (h.startsWith('*.')) {
    return coveredByWildcard(h, p);
  }
  return false;
};

/** Every route's `match.host`, paired with its id. Routes without one match any host. */
interface RouteHost {
  readonly routeId: string;
  readonly host: string | undefined;
  readonly enabled: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const routeHosts = (
  routes: readonly { id: string; definition: unknown; enabled: boolean }[],
): RouteHost[] =>
  routes.map((route) => {
    const definition = isRecord(route.definition) ? route.definition : {};
    const match = isRecord(definition['match']) ? definition['match'] : {};
    const host = match['host'];
    return {
      routeId: route.id,
      host: typeof host === 'string' && host !== '' ? host.toLowerCase() : undefined,
      enabled: route.enabled,
    };
  });

/** Resolves credentials, or names what is missing. */
const credentialsFrom = (
  env: Env,
):
  | { readonly ok: true; readonly accountId: string; readonly apiToken: string }
  | { readonly ok: false; readonly reason: UnconfiguredReason } => {
  const accountId = typeof env.CF_ACCOUNT_ID === 'string' ? env.CF_ACCOUNT_ID.trim() : '';
  const apiToken = typeof env.CF_API_TOKEN === 'string' ? env.CF_API_TOKEN.trim() : '';
  if (accountId === '' && apiToken === '') {
    return { ok: false, reason: 'missing_both' };
  }
  if (accountId === '') {
    return { ok: false, reason: 'missing_account_id' };
  }
  if (apiToken === '') {
    return { ok: false, reason: 'missing_token' };
  }
  return { ok: true, accountId, apiToken };
};

export const domainRoutes = new Hono<AppEnv>();

/** Bound hostnames, cross-referenced against the route table. */
export const discoverDomains = async (env: Env, db: D1Database): Promise<DomainsResponse> => {
  const credentials = credentialsFrom(env);
  const script =
    typeof env.PROXY_SCRIPT_NAME === 'string' && env.PROXY_SCRIPT_NAME.trim() !== ''
      ? env.PROXY_SCRIPT_NAME.trim()
      : DEFAULT_PROXY_SCRIPT;

  if (!credentials.ok) {
    // Not an error: a deployment without the token is a supported deployment,
    // and every other screen works. The UI explains rather than alarms.
    return { configured: false, reason: credentials.reason, script };
  }

  // NUL separates the parts because it cannot occur in an account id, a script
  // name or a token, so no two distinct credentials can collide on one key.
  // Spelled as an escape, not a literal byte: a raw NUL in the first 8KB makes
  // git treat the file as binary, and the diff for this file disappears.
  const key = `${credentials.accountId}\u0000${script}\u0000${credentials.apiToken}`;
  const now = Date.now();
  const fetchImpl = (env as Env & DiscoveryOverrides).CF_API_FETCH;
  let result: DiscoveryResult;
  if (cache !== undefined && cache.key === key && now - cache.at < CACHE_TTL_MS) {
    result = cache.result;
  } else {
    result = await discoverBoundHosts(
      { accountId: credentials.accountId, apiToken: credentials.apiToken },
      script,
      ...(fetchImpl === undefined ? [] : ([fetchImpl] as const)),
    );
    cache = { key, at: now, result };
  }

  const routes = routeHosts(await listAllRoutes(db));
  const hosts: HostBinding[] = result.hosts.map((host) => ({
    ...host,
    // A route with no `match.host` matches every host, so it claims this one
    // too — leaving it out would report a false "no route claims this".
    routeIds: routes
      .filter((route) => route.host === undefined || hostSatisfies(route.host, host.host))
      .map((route) => route.routeId),
  }));

  // A route whose host no discovered host satisfies. Disabled routes are
  // excluded: they are not live, so an unmatched host is not a live problem.
  //
  // Withheld when the comparison had nothing to stand on: a source failed and
  // the sources that did answer found nothing. The realistic case is the
  // least-privilege token this client is built for — `Workers Scripts Read`
  // without `Zone Read` — on a deployment whose only binding is a zone route.
  // Counting failures instead of reasoning about them reported every route as
  // unmatched there, which is the alarm this suppression exists to prevent.
  const comparisonIsBlind = result.failures.length > 0 && result.hosts.length === 0;
  const unmatchedRouteHosts = routes
    .filter(
      (route): route is RouteHost & { host: string } => route.enabled && route.host !== undefined,
    )
    .filter((route) => !result.hosts.some((host) => hostSatisfies(route.host, host.host)))
    .map((route) => ({ routeId: route.routeId, host: route.host }));

  return {
    configured: true,
    script,
    hosts,
    ...(result.failures.length > 0 ? { failures: result.failures } : {}),
    ...(result.skippedZones === undefined ? {} : { skippedZones: result.skippedZones }),
    ...(comparisonIsBlind ? {} : { unmatchedRouteHosts }),
  };
};

/**
 * Readable by signed-in users and by MCP tokens with `domains:read`.
 * The Cloudflare credential is never part of the response.
 */
domainRoutes.get('/domains', async (c) => c.json(await discoverDomains(c.env, c.env.DB)));
