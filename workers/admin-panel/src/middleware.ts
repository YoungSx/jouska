/**
 * Auth and CSRF middleware for the admin API.
 *
 * CSRF posture: the SPA and the API share an origin, and every mutating
 * request must carry a same-origin `Origin` header. The check is a deny on
 * mismatch *and on absence* — some simple cross-site form posts omit Origin
 * entirely, which is exactly why absence is not accepted.
 */
import { createMiddleware } from 'hono/factory';
import { resolveSession } from './auth.js';
import type { AppEnv } from './env.js';

/** Same-origin enforcement for mutating requests; GET/HEAD pass through. */
export const requireSameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    return next();
  }
  const origin = c.req.header('origin');
  if (origin === undefined) {
    return c.json({ error: 'missing_origin' }, 403);
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return c.json({ error: 'bad_origin' }, 403);
  }
  // The request URL is the authoritative target host (the Host header can be
  // absent for internally-constructed requests); PANEL_URL covers deployments
  // behind a proxy that rewrites both.
  const allowed = [
    new URL(c.req.url).host,
    ...(c.env.PANEL_URL !== undefined ? [new URL(c.env.PANEL_URL).host] : []),
  ];
  if (!allowed.includes(originHost)) {
    return c.json({ error: 'cross_origin' }, 403);
  }
  return next();
});

/** Resolves the session cookie to `c.var.user`, or 401. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  // resolveSession does its own cookie-name matching, so it wants the raw
  // Cookie header — getCookie would strip the name it needs to see.
  const user = await resolveSession(c.env.DB, c.req.header('cookie'));
  if (user === undefined) {
    return c.json({ error: 'unauthenticated' }, 401);
  }
  c.set('user', user);
  return next();
});

/** Gates a route to admins; must run after requireUser. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('user').role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  return next();
});
