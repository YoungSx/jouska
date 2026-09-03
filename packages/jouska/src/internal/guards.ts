import { cors as honoCors } from 'hono/cors';
import { getConnInfo } from 'hono/cloudflare-workers';
import { ipRestriction } from 'hono/ip-restriction';
import type { Context, MiddlewareHandler } from 'hono';
import type { CorsConfig, RateLimitConfig, RefererConfig, Route } from '../config.js';
import { hostMatches } from '../router.js';

/**
 * Thin adapters that translate route config into Hono's own middleware, plus
 * the guards that have no library behind them. CORS, CIDR matching and rate
 * limiting are solved elsewhere, so those only wire arguments through; the
 * referer check is this repo's own logic, so it lives here whole.
 */

/**
 * Builds `hono/cors` options. When no origin list is given the caller's origin
 * is reflected, which is what makes credentialed requests work — `*` is illegal
 * next to `Access-Control-Allow-Credentials` and browsers reject the response.
 */
export const corsMiddleware = (config: CorsConfig): MiddlewareHandler =>
  honoCors({
    origin: config.origins ?? ((origin) => origin),
    ...(config.allowMethods ? { allowMethods: [...config.allowMethods] } : {}),
    allowHeaders: config.allowHeaders,
    exposeHeaders: config.exposeHeaders,
    credentials: config.credentials,
    ...(config.maxAge !== undefined ? { maxAge: config.maxAge } : {}),
  });

/** Builds `hono/ip-restriction` with the route's allow/deny lists. */
export const ipMiddleware = (rules: NonNullable<Route['ip']>): MiddlewareHandler =>
  ipRestriction(getConnInfo, {
    ...(rules.allow.length > 0 ? { allowList: rules.allow } : {}),
    ...(rules.deny.length > 0 ? { denyList: rules.deny } : {}),
  });

/** The subset of the Cloudflare `ratelimit` binding this code depends on. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const isRateLimiter = (value: unknown): value is RateLimiter =>
  typeof value === 'object' && value !== null && typeof (value as RateLimiter).limit === 'function';

/**
 * Derives the counting key. `ip` is per-caller, `path` adds the path so one
 * endpoint cannot exhaust another's budget, and `route` shares one bucket
 * across the whole route.
 */
export const rateLimitKey = (
  config: RateLimitConfig,
  c: Context,
  routeId: string,
  clientIp: string | undefined,
): string => {
  switch (config.by) {
    case 'ip':
      return `${routeId}:${clientIp ?? 'unknown'}`;
    case 'path':
      return `${routeId}:${clientIp ?? 'unknown'}:${new URL(c.req.url).pathname}`;
    case 'route':
      return routeId;
  }
};

export type RateLimitVerdict =
  { ok: true } | { ok: false; reason: 'exceeded' | 'misconfigured' | 'unidentifiable' };

/**
 * Consults the native rate limit binding.
 *
 * Two failures are refused rather than admitted. A missing binding is a
 * configuration error, and a per-caller limit with no identifiable caller would
 * put every such request into one shared `unknown` bucket — which either lets
 * one client exhaust everyone's budget or, worse, lets an attacker evade the
 * limit entirely by suppressing whatever identifies them. On Cloudflare
 * `cf-connecting-ip` is always present, so its absence means the proxy is not
 * running where it thinks it is.
 */
export const checkRateLimit = async (
  config: RateLimitConfig,
  c: Context,
  routeId: string,
  clientIp: string | undefined,
): Promise<RateLimitVerdict> => {
  const binding = (c.env as Record<string, unknown> | undefined)?.[config.binding];
  if (!isRateLimiter(binding)) {
    return { ok: false, reason: 'misconfigured' };
  }
  if (clientIp === undefined && config.by !== 'route') {
    return { ok: false, reason: 'unidentifiable' };
  }
  const { success } = await binding.limit({ key: rateLimitKey(config, c, routeId, clientIp) });
  return success ? { ok: true } : { ok: false, reason: 'exceeded' };
};

export type RefererVerdict = { ok: true } | { ok: false; status: 403 | 404 };

/**
 * Which guard refused a request, reported on `ProxyEvent.guardReason`. A guard
 * refusal is already visible as `attempts: 0`; the name is what turns a count
 * of refusals into an answer to "which one".
 */
export type GuardReason =
  | 'method'
  | 'body_size'
  | 'geo'
  | 'ip'
  | 'referer'
  | 'rate_limit'
  | 'signed_link'
  | 'access'
  | 'forward_auth';

/**
 * Checks the `Referer` allow-list.
 *
 * The comparison reuses `hostMatches`, the same matcher `match.host` runs, so
 * an allow-list entry means exactly what the same string means as a match
 * entry — including the `*.` rule that never admits the apex and never matches
 * a merely similar suffix like `evilexample.com`. Only the hostname is read:
 * the port, scheme and path are not part of the claim, and `match.host` does
 * not consult them either.
 *
 * Absence and unattributability are different things. A missing header — or a
 * blank one — is direct navigation, and `allowEmpty` answers it. A value that
 * is there but cannot be attributed (`Referer: blocked` from a privacy
 * extension, gibberish, `about:blank`, whose hostname parses to the empty
 * string) carries a claim that nothing on the list could satisfy, and is
 * refused regardless of `allowEmpty`: admitting it would mean an unparseable
 * referer is worth more than no referer at all.
 *
 * The header is forgeable by any non-browser client, so this is a fence
 * against other sites embedding assets, not an access control.
 */
export const checkReferer = (config: RefererConfig, request: Request): RefererVerdict => {
  const raw = request.headers.get('referer');
  if (raw === null || raw === '') {
    return config.allowEmpty ? { ok: true } : { ok: false, status: config.onRefuse };
  }
  let referer: URL;
  try {
    referer = new URL(raw);
  } catch {
    return { ok: false, status: config.onRefuse };
  }
  if (referer.protocol !== 'http:' && referer.protocol !== 'https:') {
    return { ok: false, status: config.onRefuse };
  }
  const hostname = referer.hostname.toLowerCase();
  const matched = config.allow.some((pattern) => hostMatches(pattern, hostname));
  return matched ? { ok: true } : { ok: false, status: config.onRefuse };
};
