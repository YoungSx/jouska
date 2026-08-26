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
    ...(config.allowMethods ? { allowMethods: config.allowMethods } : {}),
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
export const rateLimitKey = (config: RateLimitConfig, c: Context, routeId: string): string => {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  switch (config.by) {
    case 'ip':
      return `${routeId}:${ip}`;
    case 'path':
      return `${routeId}:${ip}:${new URL(c.req.url).pathname}`;
    case 'route':
      return routeId;
  }
};

/**
 * Consults the native rate limit binding. Returns `true` when the request may
 * proceed. A missing binding is a configuration error and is reported as such
 * rather than silently admitting traffic.
 */
export const checkRateLimit = async (
  config: RateLimitConfig,
  c: Context,
  routeId: string,
): Promise<{ ok: true } | { ok: false; reason: 'exceeded' | 'misconfigured' }> => {
  const binding = (c.env as Record<string, unknown> | undefined)?.[config.binding];
  if (!isRateLimiter(binding)) {
    return { ok: false, reason: 'misconfigured' };
  }
  const { success } = await binding.limit({ key: rateLimitKey(config, c, routeId) });
  return success ? { ok: true } : { ok: false, reason: 'exceeded' };
};
