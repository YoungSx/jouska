import { describe, expect, it } from 'vitest';
import { ITERATIONS, PBKDF2_KEYLEN_BYTES } from './iterations.js';
import { hashPassword, verifyPassword } from './password.js';

/**
 * These run in the real workerd, so the timings are the platform's, not a
 * datasheet's. The budget assertion is the point: it fails if someone raises
 * ITERATIONS past what the free tier's 10 ms CPU limit allows.
 */
describe('password hashing', () => {
  it('produces a self-describing hash and verifies round-trip', async () => {
    const stored = await hashPassword('correct horse');
    expect(stored.startsWith(`pbkdf2$${ITERATIONS}$`)).toBe(true);
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('verifies a hash stored with different iterations (forward compatibility)', async () => {
    // Hand-rolled hash at a different iteration count than the current constant.
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', encoder.encode('pw'), 'PBKDF2', false, [
      'deriveBits',
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: 1234 },
      key,
      PBKDF2_KEYLEN_BYTES * 8,
    );
    const b64 = (bytes: Uint8Array): string =>
      btoa(String.fromCodePoint(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const stored = `pbkdf2$1234$${b64(salt)}$${b64(new Uint8Array(bits))}`;
    expect(await verifyPassword('pw', stored)).toBe(true);
    expect(await verifyPassword('other', stored)).toBe(false);
  });

  it('rejects malformed stored hashes without throwing', async () => {
    expect(await verifyPassword('pw', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('pw', 'pbkdf2$x$y$z')).toBe(false);
    expect(await verifyPassword('pw', 'scrypt$1$a$b')).toBe(false);
  });

  it('stays inside the free-tier CPU budget', { timeout: 30_000 }, async () => {
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      await hashPassword('benchmark');
      samples.push(performance.now() - start);
    }
    const median = samples.toSorted((a, b) => a - b)[1]!;
    // 10 ms is the platform ceiling for the whole request; hashing must
    // leave the bulk of it for Hono, D1 and serialization.
    expect(median).toBeLessThan(6);
    // And a floor: a number this cheap is not doing the work.
    expect(median).toBeGreaterThan(0.5);
  });
});
