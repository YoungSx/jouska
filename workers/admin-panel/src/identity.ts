/**
 * Who the platform says the caller is, before the panel's own `users` table
 * has any opinion about them.
 *
 * Cloudflare Access authenticates in front of this Worker, so when it is
 * configured the panel never sees an unauthenticated request. What it does see
 * depends on where it runs, and the two environments do not overlap — measured,
 * not assumed:
 *
 * | environment                            | `ctx.access` | `cf-access-jwt-assertion` |
 * | -------------------------------------- | ------------ | ------------------------- |
 * | `wrangler dev` with an `access.dev` block | present   | absent                    |
 * | production, Static-Assets Worker       | `undefined`  | present                   |
 *
 * The production column is the one that forces the design: a Worker with
 * static assets executes behind an internal router that does not pass
 * `ctx.access` through, and `run_worker_first` does not change that. The panel
 * needs its assets (the SPA fallback is what serves the UI), so verifying the
 * header is the only path that works where it matters — and `ctx.access` is
 * the only path that works locally. Hence both.
 *
 * The JWT is verified by `verifyAccessJwt` from the jouska library, the same
 * function the proxy's route-level `access` guard is built on. A second,
 * approximate verifier beside it is what sharing exists to prevent.
 */
import { verifyAccessJwt } from 'jouska';

/** Header Cloudflare Access attaches to every request it has authenticated. */
const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

/** An identity the platform vouched for, and which path proved it. */
export interface AccessIdentity {
  readonly email: string;
  /** `jwt` in production, `ctx` under `wrangler dev`. Audited, not decorative. */
  readonly via: 'jwt' | 'ctx';
}

/**
 * Why no identity came back.
 *
 * `not_configured` is the deployment that has not turned Access on. It used to be
 * the door to the panel's own cookie session; with that door gone it is simply
 * another refusal, and the panel is unreachable until the vars are set. Kept
 * distinct from the rest because the reasons differ in kind: everything else here
 * means a credential *was* presented and did not hold up.
 */
export type IdentityRefusal =
  'not_configured' | 'missing' | 'too_long' | 'invalid' | 'forbidden' | 'unavailable';

export type IdentityOutcome =
  | { readonly ok: true; readonly identity: AccessIdentity }
  | { readonly ok: false; readonly reason: IdentityRefusal };

/**
 * The two vars that turn Access on for the panel. Both, or neither.
 *
 * Typed as explicitly-nullable rather than optional: callers read them off
 * `env`, where absence is a value they are holding, not a key they can omit.
 */
export interface AccessSettings {
  readonly team: string | undefined;
  readonly audience: string | undefined;
}

/**
 * Test-only seam, following the one `api/domains.ts` uses for the Cloudflare
 * API. Kept off `Env` on purpose: an environment variable that could replace
 * the JWKS fetch would let a deployment be handed an arbitrary set of signing
 * keys, which is the one thing this verification exists to make trustworthy.
 */
export interface AccessOverrides {
  ACCESS_JWKS_FETCH?: typeof fetch;
}

/**
 * Reads `ctx.access` if the platform populated it.
 *
 * `Object.keys(ctx)` lists `access` even when it holds nothing, so `'access' in
 * ctx` answers true on a Worker that will never be given an identity. The
 * value is the only honest test.
 */
const identityFromCtx = async (ctx: unknown): Promise<string | undefined> => {
  const access = (ctx as { access?: { getIdentity?: () => Promise<unknown> } } | undefined)?.access;
  if (access === undefined || typeof access.getIdentity !== 'function') {
    return undefined;
  }
  try {
    const identity = (await access.getIdentity()) as { email?: unknown } | null;
    return typeof identity?.email === 'string' && identity.email !== ''
      ? identity.email
      : undefined;
  } catch {
    // A platform that offers the call but cannot answer it is not an identity.
    return undefined;
  }
};

/**
 * Resolves the caller to an Access identity.
 *
 * Order is not arbitrary: production is asked first, so a deployment cannot be
 * talked into trusting a development shim. `ctx.access` is only consulted when
 * the header is absent entirely — a header that was presented and failed is a
 * refusal, and answering it from a second source would be a bypass.
 */
export const resolveIdentity = async (
  request: Request,
  ctx: unknown,
  settings: AccessSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<IdentityOutcome> => {
  const { team, audience } = settings;
  if (team === undefined || team === '' || audience === undefined || audience === '') {
    return { ok: false, reason: 'not_configured' };
  }

  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (token !== null) {
    const verified = await verifyAccessJwt(token, { team, audience }, fetchImpl);
    if (verified.ok) {
      const email = verified.claims.email;
      // A token that proves no email proves nothing this panel can act on: the
      // `users` row is keyed by it, and the audit log names it.
      return email === undefined || email === ''
        ? { ok: false, reason: 'invalid' }
        : { ok: true, identity: { email, via: 'jwt' } };
    }
    return {
      ok: false,
      reason: verified.reason === 'jwks_unavailable' ? 'unavailable' : verified.reason,
    };
  }

  const local = await identityFromCtx(ctx);
  if (local !== undefined) {
    return { ok: true, identity: { email: local, via: 'ctx' } };
  }
  return { ok: false, reason: 'missing' };
};
