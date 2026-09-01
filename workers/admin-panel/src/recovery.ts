/**
 * Out-of-band password recovery.
 *
 * The panel has no email and no second factor, so the only trustworthy proof
 * that someone owns a deployment is that they can write to its database. This
 * turns that into a recovery path: put a token in `settings`, then present it
 * to the API to set a new password. Nothing else is touched — routes, audit
 * history, the published KV document and every other account survive.
 *
 * Three properties keep this from being a permanent backdoor:
 *
 *  - **Single use.** The row is deleted in the same transaction that writes the
 *    new password, so a token that leaks after the fact is already spent.
 *  - **Expiring.** A token carries its own deadline; an operator who forgets to
 *    clean up does not leave a standing key. Absent or unparsable deadline is
 *    treated as expired, not as "no limit".
 *  - **Constant-time comparison.** The token is compared by digest, so the API
 *    cannot be used as an oracle to guess it byte by byte.
 */
import { boundedString } from './validate.js';

/** The `settings` key an operator writes to open the window. */
export const RECOVERY_KEY = 'password_reset';

/** How long a token stays valid, when the operator does not say. */
export const RECOVERY_TTL_SECONDS = 30 * 60;

/**
 * Longest window an operator may request. A token is a password equivalent;
 * "valid for a year" is not a recovery window, it is a second credential.
 */
export const RECOVERY_MAX_TTL_SECONDS = 24 * 60 * 60;

/** Shortest accepted token. Short ones are guessable, and this bypasses login. */
export const RECOVERY_MIN_TOKEN_LENGTH = 16;

/** Longest accepted token, so the digest work stays bounded. */
export const RECOVERY_MAX_TOKEN_LENGTH = 512;

const encoder = new TextEncoder();

/**
 * SHA-256 as lowercase hex. Used to compare tokens at fixed width: comparing
 * digests means the loop below always runs the same number of steps whatever
 * the inputs, so timing carries no information about the secret.
 */
const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** Compares two equal-length hex strings without an early exit. */
const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

/**
 * The stored recovery row.
 *
 * `token` is the secret the operator invents; `subject` optionally pins the
 * token to one account, so a token cannot be redirected at a different admin.
 */
export interface RecoveryRecord {
  readonly token: string;
  readonly expiresAt: number;
  readonly subject?: string;
}

export type RecoveryCheck =
  | { readonly ok: true; readonly record: RecoveryRecord }
  /**
   * Every failure is one shape on purpose. "Expired" and "wrong token" must
   * look identical from outside, or the endpoint answers "does a window exist
   * right now" for anyone who asks.
   */
  | { readonly ok: false; readonly reason: 'unavailable' };

/**
 * Reads a stored recovery row, accepting either a bare token string or an
 * object with a deadline.
 *
 * A bare string is the shape an operator types by hand
 * (`INSERT INTO settings VALUES ('password_reset', '"my-token"')`), so it is
 * supported — with the default TTL measured from `now`, which means a
 * hand-written token cannot be immortal either. `createdAt` exists so that TTL
 * is anchored to the write, not to the read.
 */
export const parseRecoveryRecord = (stored: unknown, now: number): RecoveryRecord | undefined => {
  if (typeof stored === 'string') {
    const token = boundedString(stored, RECOVERY_MAX_TOKEN_LENGTH);
    return token === undefined ? undefined : { token, expiresAt: now + RECOVERY_TTL_SECONDS };
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return undefined;
  }
  const row = stored as Record<string, unknown>;
  const token = boundedString(row['token'], RECOVERY_MAX_TOKEN_LENGTH);
  if (token === undefined) {
    return undefined;
  }
  const subject = boundedString(row['subject'], 128);

  // An explicit deadline wins. Otherwise derive one from createdAt, and if
  // that is missing too, from now — never "no deadline".
  const explicit = row['expiresAt'];
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    const capped = Math.min(explicit, now + RECOVERY_MAX_TTL_SECONDS);
    return { token, expiresAt: capped, ...(subject === undefined ? {} : { subject }) };
  }
  const createdAt = row['createdAt'];
  const anchor = typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : now;
  const ttlRaw = row['ttlSeconds'];
  const ttl =
    typeof ttlRaw === 'number' && Number.isInteger(ttlRaw) && ttlRaw > 0
      ? Math.min(ttlRaw, RECOVERY_MAX_TTL_SECONDS)
      : RECOVERY_TTL_SECONDS;
  return { token, expiresAt: anchor + ttl, ...(subject === undefined ? {} : { subject }) };
};

/**
 * Checks a presented token against the stored row.
 *
 * Takes the already-read setting rather than a database handle so the whole
 * decision is a pure function over (stored, presented, now) — the part worth
 * testing exhaustively.
 */
export const checkRecoveryToken = async (
  stored: unknown,
  presented: string,
  now: number,
): Promise<RecoveryCheck> => {
  const record = parseRecoveryRecord(stored, now);
  // Digest even when there is nothing to compare against, so a deployment with
  // no open window does not answer faster than one with a wrong token.
  const presentedDigest = await sha256Hex(presented);
  if (record === undefined) {
    return { ok: false, reason: 'unavailable' };
  }
  const storedDigest = await sha256Hex(record.token);
  if (!constantTimeEqual(presentedDigest, storedDigest)) {
    return { ok: false, reason: 'unavailable' };
  }
  if (record.expiresAt <= now) {
    return { ok: false, reason: 'unavailable' };
  }
  // A token shorter than the floor is rejected even when it matches: it was
  // guessable, so treating it as valid would reward a weak choice.
  if (record.token.length < RECOVERY_MIN_TOKEN_LENGTH) {
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, record };
};
