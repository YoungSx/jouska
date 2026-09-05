/**
 * Authentication endpoints: logout, whoami.
 *
 * Authentication is Cloudflare Access, and only Cloudflare Access. Nothing here
 * accepts a credential: `/logout` hands back the same-origin path a browser has to
 * visit for the edge to revoke, because that navigation is the only logout there
 * is, and `/me` reports the verdict the middleware would reach. Whether an
 * unknown-but-vouched address gets a row is the standing policy in
 * `ACCESS_PROVISION_ROLE` (see `provisionAccessUser`); it is off by default.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env.js';
import { authenticate } from '../middleware.js';

export const authRoutes = new Hono<AppEnv>();

/**
 * Where to go to actually sign out.
 *
 * Same-origin on purpose. Cloudflare documents this path on the application's own
 * hostname and on the team domain as equivalent in effect — both revoke the
 * session across every Access application, and previously issued tokens stop
 * being accepted 20-30 seconds later — but the application's own hostname is the
 * better of the two here. It additionally drops the app cookie on this host,
 * which is what makes the sign-out feel immediate instead of "still signed in for
 * another twenty seconds"; and being a path rather than a hostname built from
 * configuration, it cannot become a redirect to somewhere else however wrong
 * `ACCESS_TEAM` is.
 */
const ACCESS_LOGOUT_PATH = '/cdn-cgi/access/logout';

authRoutes.post('/logout', async (c) => {
  // Nothing server-side to destroy — that is the whole shape of this endpoint now.
  // What it owes the SPA is a destination, because a panel that answered "logged
  // out" and stayed put would put the operator straight back in on the next
  // reload: the session lives at the edge, not in this Worker.
  //
  // Access off means there is no session to end, and a path nothing intercepts
  // would be a dead end dressed up as an action — so the answer is silence rather
  // than a link. Both vars, matching `resolveIdentity`: a team without an audience
  // is Access off, not Access half-on.
  const configured =
    (c.env.ACCESS_TEAM ?? '').trim() !== '' && (c.env.ACCESS_AUD ?? '').trim() !== '';
  return c.json(configured ? { ok: true, accessLogout: ACCESS_LOGOUT_PATH } : { ok: true });
});

authRoutes.get('/me', async (c) => {
  // This group is mounted before the global requireUser, so /me guards
  // itself — it is the endpoint the SPA pings to discover login state. It runs
  // the same `authenticate` the middleware does, because a discovery endpoint
  // that reached a different verdict than the gate would be worse than none.
  //
  // Every branch carries the build identity: whoever /me refuses is stuck on a
  // screen with no other way to ask which build is refusing them. CI injects
  // it at deploy time; local dev answers 'dev', which is the honest value.
  const build = c.env.BUILD_ID ?? 'dev';
  const outcome = await authenticate(c);
  if (outcome.ok) {
    return c.json({ user: outcome.user, build });
  }

  // Access vouched for someone the panel has never heard of. Whether that can
  // ever change depends on the standing policy: with `ACCESS_PROVISION_ROLE`
  // set the caller would have been provisioned a line above, so reaching here
  // means the policy is off (or typo'd) and the row must come from somebody who
  // already has one. The SPA is told the address so it can name who needs
  // adding instead of offering a form that cannot help.
  if (outcome.error === 'no_panel_account') {
    return c.json({ user: null, accessEmail: outcome.accessEmail, build }, 200);
  }

  // A refusal that is about *this* caller has to be reported as itself: a
  // disabled account or an unverifiable Access token must not be flattened into
  // a generic auth error, which would send the operator into a loop.
  if (outcome.status !== 401) {
    return c.json({ error: outcome.error, build }, outcome.status);
  }

  // No Access identity and no valid authentication. When the deployment has no
  // Access wiring at all, that fact rides along: the SPA's refusal screen is
  // then addressed to whoever deploys this panel. The endpoint still answers
  // 200 with `user: null`, so a stranger probing it learns nothing beyond what
  // any 401 would have said.
  return c.json(
    outcome.notConfigured === true
      ? { user: null, identity: 'not_configured', build }
      : { user: null, build },
    200,
  );
});
