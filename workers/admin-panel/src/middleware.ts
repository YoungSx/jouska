/**
 * Auth and CSRF middleware for the admin API.
 *
 * One door: Cloudflare Access. With `ACCESS_TEAM` and `ACCESS_AUD` set, the
 * platform has already authenticated every request before this Worker ran, and
 * the panel only has to decide what that identity is allowed to do. There is no
 * second credential to fall through to, which is the point — nothing an
 * attacker presents can shop for a softer opinion, and no per-request input can
 * turn authentication off.
 *
 * CSRF posture: the SPA and the API share an origin, and every mutating
 * request must carry a same-origin `Origin` header. The check is a deny on
 * mismatch *and on absence* — some simple cross-site form posts omit Origin
 * entirely, which is exactly why absence is not accepted.
 */
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv, Vars } from './env.js';
import { resolveIdentity, type AccessIdentity, type AccessOverrides } from './identity.js';
import { findUserBySubject, provisionAccessUser, touchLastSeen, type UserRecord } from './store.js';

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

/**
 * `c.executionCtx` throws when the host did not supply one, which is a shape
 * question rather than an error worth propagating: no context simply means no
 * `ctx.access` to read.
 */
const executionCtxOf = (c: Context<AppEnv>): unknown => {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
};

/**
 * What `ACCESS_PROVISION_ROLE` says, strictly. Unset means the founding
 * posture: unknown addresses stay unknown. A set-but-unrecognised value — a
 * typo — must not soften into the widest role, so it is reported and treated
 * as unset: admission closes rather than opens.
 */
const provisionRoleOf = (value: string | undefined): 'admin' | 'viewer' | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'admin' || trimmed === 'viewer') {
    return trimmed;
  }
  console.error(
    `ACCESS_PROVISION_ROLE=${JSON.stringify(value)} is not 'admin' or 'viewer'; treating as unset (admission closed).`,
  );
  return undefined;
};

/**
 * The panel account behind an Access identity, provisioning it only when the
 * standing policy says to. Access answers *who*; the users table still answers
 * *what they may do* — but now the gap between the two is an explicit,
 * reviewed knob (`ACCESS_PROVISION_ROLE` in wrangler.jsonc) rather than a
 * silent one. Whatever the knob says, an empty table bootstraps its first
 * caller as admin: that is the operator's recovery path, not a policy leak.
 */
const accountFor = async (
  db: D1Database,
  env: Pick<AppEnv['Bindings'], 'ACCESS_PROVISION_ROLE'>,
  identity: AccessIdentity,
): Promise<UserRecord | undefined> => {
  const role = provisionRoleOf(env.ACCESS_PROVISION_ROLE);
  return (
    (await findUserBySubject(db, identity.email)) ??
    // role is conditionally present rather than explicitly undefined: the
    // signature declares `role?: 'admin' | 'viewer'`, and under
    // exactOptionalPropertyTypes an explicit undefined is a type error, not a
    // synonym for omitting the key.
    (await provisionAccessUser(db, {
      subject: identity.email,
      email: identity.email,
      ...(role === undefined ? {} : { role }),
    }))
  );
};

export type AuthOutcome =
  | { readonly ok: true; readonly user: Vars['user'] }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 503;
      readonly error: string;
      /**
       * Set when Access vouched for someone the panel has never heard of. The
       * SPA needs it to say "ask an admin to add this address" instead of
       * showing a login form the platform already answered.
       */
      readonly accessEmail?: string;
      /**
       * Set when the deployment itself never wired Access in (`not_configured`),
       * alongside the same 401 as every other refusal. It describes the
       * deployment, not the caller, which is why the SPA may know it — that
       * refusal has to point at configuration, and its audience is whoever
       * deploys this panel. API 401s elsewhere stay uniform.
       */
      readonly notConfigured?: true;
    };

/**
 * Resolves the request to a panel user.
 *
 * Shared by `requireUser` and `/api/auth/me`: the endpoint the SPA pings to
 * discover its own state has to reach the same verdict as the middleware
 * gating every other call, and two implementations of that would drift.
 */
export const authenticate = async (c: Context<AppEnv>): Promise<AuthOutcome> => {
  const access = await resolveIdentity(
    c.req.raw,
    executionCtxOf(c),
    { team: c.env.ACCESS_TEAM, audience: c.env.ACCESS_AUD },
    (c.env as typeof c.env & AccessOverrides).ACCESS_JWKS_FETCH,
  );

  if (access.ok) {
    const record = await accountFor(c.env.DB, c.env, access.identity);
    if (record === undefined) {
      // Through the door, but not on the list. With the founding posture (or a
      // typo'd policy value) this is how unknown addresses are refused: a 403
      // to be granted deliberately, never a row created automatically.
      return {
        ok: false,
        status: 403,
        error: 'no_panel_account',
        accessEmail: access.identity.email,
      };
    }
    if (record.disabled) {
      return { ok: false, status: 403, error: 'account_disabled' };
    }
    await touchLastSeen(c.env.DB, record.id);
    return {
      ok: true,
      user: { userId: record.id, subject: record.subject, role: record.role },
    };
  }

  // A presented credential that failed is final. `unavailable` fails closed the
  // same way the proxy's own guard does when it cannot obtain the JWKS: without
  // verification material there is no safe way to say yes.
  if (access.reason === 'unavailable') {
    return { ok: false, status: 503, error: 'access_unavailable' };
  }
  if (access.reason === 'forbidden') {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  // Everything still standing answers the same way, because there is nothing
  // else to try: a token that did not verify (`invalid`, `too_long`) or no
  // token at all (`missing`). One refusal, no second door to hint at. The one
  // exception rides on the same 401: `not_configured` is not about this caller
  // at all, so /api/auth/me may name the real problem without telling a
  // stranger probing the endpoints anything they can use.
  return access.reason === 'not_configured'
    ? { ok: false, status: 401, error: 'unauthenticated', notConfigured: true }
    : { ok: false, status: 401, error: 'unauthenticated' };
};

/** Resolves the caller to `c.var.user`, or refuses with the reason why. */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const outcome = await authenticate(c);
  if (!outcome.ok) {
    return c.json(
      outcome.accessEmail === undefined
        ? { error: outcome.error }
        : { error: outcome.error, accessEmail: outcome.accessEmail },
      outcome.status,
    );
  }
  c.set('user', outcome.user);
  return next();
});

/** Gates a route to admins; must run after requireUser. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('user').role !== 'admin') {
    return c.json({ error: 'forbidden' }, 403);
  }
  return next();
});
