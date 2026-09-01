/**
 * PBKDF2 parameters, pinned by measurement.
 *
 * `iterations` was set in the real runtime, not from a datasheet: 100 000
 * measured at ~14 ms in workerd on this machine — over the free plan's 10 ms
 * CPU ceiling for the whole request, before Hono, D1 and serialization take
 * their share. 30 000 measured at ~4 ms, which fits with headroom (300 000 was
 * 40 ms). The worst request on the panel is a password change, which does two
 * derivations back to back (verify current, hash new) and measured at a
 * fastest-of-nine 8 ms — still inside the ceiling. `password.test.ts` asserts
 * on this constant rather than on a wall-clock reading, because the constant is
 * what regresses and a CI runner's clock is not Cloudflare's CPU — so editing
 * the number forces a re-measure and a matching edit to that bound.
 */
export const ITERATIONS = 30_000;

/** 32 bytes = 256-bit key; matches the session token length too. */
export const PBKDF2_KEYLEN_BYTES = 32;

/** Session lifetime, sliding: refreshed on use up to this hard cap. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A session may not be extended past this age, however active it is. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'jouska_session';
