import { cors as honoCors } from 'hono/cors';
import { getConnInfo } from 'hono/cloudflare-workers';
import { ipRestriction } from 'hono/ip-restriction';
import type { Context, MiddlewareHandler } from 'hono';
import type { CorsConfig, RateLimitConfig, Route } from '../config.js';

/**
 * Thin adapters that translate route config into Hono's own middleware.
 * No policy logic lives here: CORS, CIDR matching and rate limiting are all
 * solved elsewhere, so this only wires arguments through.
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
