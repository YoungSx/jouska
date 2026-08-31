/**
 * Password hashing on the free tier.
 *
 * The free plan gives a Worker 10 ms of CPU per request, and login is where a
 * password hash spends it. Iterations are therefore not a security-theatre
 * number: they are pinned by a measurement in the real runtime (see
 * password.test.ts), which asserts the budget instead of trusting a datasheet.
 *
 * Format: `pbkdf2$<iterations>$<salt b64url>$<hash b64url>` — self-describing,
 * so iterations can rise later without a migration; verification reads the
 * count from the stored string.
 */
import { ITERATIONS, PBKDF2_KEYLEN_BYTES } from './iterations.js';

const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

/** A stored hash that fails to parse is a failed verification, not a 500. */
const parseStored = (
  stored: string,
): { iterations: number; salt: Uint8Array; expected: Uint8Array } | undefined => {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') {
    return undefined;
  }
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1) {
    return undefined;
  }
  try {
    return {
      iterations,
      salt: fromB64url(parts[2]!),
      expected: fromB64url(parts[3]!),
    };
  } catch {
    return undefined;
  }
};

const derive = async (
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    PBKDF2_KEYLEN_BYTES * 8,
  );
  return new Uint8Array(bits);
};

export const hashPassword = async (password: string): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
};

/**
 * Verification walks the stored parameters, so a hash written with more (or
 * fewer) iterations verifies correctly rather than failing to parse.
 */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parsed = parseStored(stored);
  if (parsed === undefined) {
    return false;
  }
  const actual = await derive(password, parsed.salt, parsed.iterations);
  // Constant-time compare: same length always, same work either way.
  if (actual.length !== parsed.expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual[i]! ^ parsed.expected[i]!;
  }
  return diff === 0;
};
