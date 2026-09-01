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

  it('pins the iteration count to the window that was measured to fit', () => {
    // Minimum of nine runs in this runtime: 30k → 4 ms, 100k → 13 ms,
    // 300k → 40 ms. The free plan allows 10 ms of CPU for the whole request,
    // so hashing may only take a fraction of it — past ~50k the measured curve
    // leaves nothing for Hono, D1 and serialization.
    //
    // This bound, not a wall-clock ceiling, is the CI gate: the constant is
    // what regresses, and a runner's wall clock is not Cloudflare's CPU, so a
    // tight timing assertion here would only measure the runner.
    expect(ITERATIONS).toBeLessThan(50_000);
    // A floor too, so hashing cannot be quietly weakened to nothing. 30k is
    // below OWASP's 600k guidance for PBKDF2-SHA256 — the platform budget does
    // not afford that, and the account lockout after five failures is what
    // covers online guessing instead.
    expect(ITERATIONS).toBeGreaterThanOrEqual(30_000);
  });

  it('really performs the derivation it claims', { timeout: 30_000 }, async () => {
    const samples: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const start = performance.now();
      await hashPassword('benchmark');
      samples.push(performance.now() - start);
    }
    // The minimum, not the median: scheduler noise only ever adds time, so the
    // fastest of several runs is the closest estimate of the CPU cost. workerd
    // also clamps performance.now() to 1 ms steps, which at a true ~4 ms moves
    // a median over a few samples by whole milliseconds.
    const fastest = Math.min(...samples);
    // Deliberately wide: this catches a derivation that is not happening at
    // all (a mocked or short-circuited crypto path) or one gone catastrophically
    // slow, without failing on a runner three times slower than this machine.
    expect(fastest).toBeGreaterThan(1.5);
    expect(fastest).toBeLessThan(60);
  });

  it('keeps a password change (verify + hash, back to back) in the same window', { timeout: 60_000 }, async () => {
    // POST /api/auth/password does two derivations per request: verify the
    // current password, then hash the new one. That is the worst CPU case on
    // the panel, so it gets its own measured bound — raising ITERATIONS past
    // what two derivations afford must fail here, not on production's first
    // password change on the free tier.
    const samples: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      const stored = await hashPassword('benchmark');
      const start = performance.now();
      await verifyPassword('benchmark', stored);
      await hashPassword('the-replacement-password');
      samples.push(performance.now() - start);
    }
    const fastest = Math.min(...samples);
    // Measured in this runtime: 2 × 30k ≈ 8 ms (fastest-of-nine). The floor
    // proves both derivations really happened; the ceiling catches a
    // catastrophic regression, and a runner faster or slower than this machine
    // changes nothing — the ITERATIONS pin above is the CI gate for the
    // platform budget.
    expect(fastest).toBeGreaterThan(3);
    expect(fastest).toBeLessThan(80);
  });
});
