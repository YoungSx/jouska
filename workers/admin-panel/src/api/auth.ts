/**
 * Authentication endpoints: logout, whoami.
 *
 * Authentication is Cloudflare Access, and only Cloudflare Access. Nothing here
 * accepts a credential: `/logout` hands back the platform's sign-out URL because
 * that is the only logout there is, and `/me` reports the verdict the middleware
 * would reach. The very first caller through Access provisions the sole admin row
 * (see `provisionFirstAdmin`); everyone after that is added from the users screen.
 */
import { Hono } from 'hono';
import { accessLogoutUrl } from 'jouska';
import type { AppEnv } from '../env.js';
import { authenticate } from '../middleware.js';

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/logout', async (c) => {
  // There is no server-side session left to destroy, and that is exactly why this
  // endpoint still exists: the session that matters is the platform's own
  // `CF_Authorization` on the team domain. A panel that answered "logged out"
  // without saying where to go would put the operator straight back in on the
  // next reload. So the whole job is handing over the team's sign-out URL —
  // undefined when `ACCESS_TEAM` is unset or not a legal team name, which the SPA
  // reads as "nothing further to visit".
  const accessLogout = accessLogoutUrl(c.env.ACCESS_TEAM);
  return c.json(accessLogout === undefined ? { ok: true } : { ok: true, accessLogout });
});

authRoutes.get('/me', async (c) => {
  // This group is mounted before the global requireUser, so /me guards
  // itself — it is the endpoint the SPA pings to discover login state. It runs
  // the same `authenticate` the middleware does, because a discovery endpoint
  // that reached a different verdict than the gate would be worse than none.
  const outcome = await authenticate(c);
  if (outcome.ok) {
    return c.json({ user: outcome.user });
  }

  // Access vouched for someone the panel has never heard of, and past first run
  // nothing this caller does will change that — the row has to be created by
  // somebody who already has one. The SPA is told the address so it can name who
  // needs adding instead of offering a form that cannot help.
  if (outcome.error === 'no_panel_account') {
    return c.json({ user: null, accessEmail: outcome.accessEmail }, 200);
  }

  // A refusal that is about *this* caller has to be reported as itself: a
  // disabled account or an unverifiable Access token must not be flattened into
  // a generic auth error, which would send the operator into a loop.
  if (outcome.status !== 401) {
    return c.json({ error: outcome.error }, outcome.status);
  }

  // No Access identity and no valid authentication.
  return c.json({ user: null }, 200);
});
