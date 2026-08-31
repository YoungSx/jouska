/**
 * PBKDF2 parameters, pinned by measurement.
 *
 * `iterations` was set in the real runtime, not from a datasheet: 100 000
 * measured at ~14 ms in workerd on this machine — over the free plan's 10 ms
 * CPU ceiling for the whole request, before Hono, D1 and serialization take
 * their share. 30 000 measured at ~4 ms, which fits with headroom. The budget
 * assertion in `password.test.ts` fails if this constant drifts out of budget,
 * so editing the number forces a re-measure.
 */
export const ITERATIONS = 30_000;

/** 32 bytes = 256-bit key; matches the session token length too. */
export const PBKDF2_KEYLEN_BYTES = 32;

/** Session lifetime, sliding: refreshed on use up to this hard cap. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A session may not be extended past this age, however active it is. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'jouska_session';
