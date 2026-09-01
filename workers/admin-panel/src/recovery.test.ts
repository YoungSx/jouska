/**
 * Recovery-token coverage.
 *
 * This endpoint is reachable unauthenticated and writes a password, so the
 * tests here are about what it must *refuse*. Each case names the specific way
 * the window could become a standing backdoor.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from './index.js';
import type { AppEnv, Env } from './env.js';
import { verifyPassword } from './password.js';
import {
  checkRecoveryToken,
  parseRecoveryRecord,
  RECOVERY_KEY,
  RECOVERY_MAX_TTL_SECONDS,
  RECOVERY_TTL_SECONDS,
} from './recovery.js';

const testEnv = env as unknown as Env;
const appEnv = testEnv as unknown as AppEnv;
const base = 'https://panel.test';

interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ResponseLike> =>
  worker.fetch(
    new Request(`${base}${path}`, {
      method,
      headers: { origin: base, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    appEnv,
    {} as ExecutionContext,
  ) as unknown as Promise<ResponseLike>;

const OLD_PASSWORD = 'the-original-password';
const NEW_PASSWORD = 'the-recovered-password';
const TOKEN = 'a-sufficiently-long-recovery-token';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Writes a recovery row exactly as an operator would, via SQL. */
const openWindow = async (value: unknown): Promise<void> => {
  await testEnv.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  )
    .bind(RECOVERY_KEY, JSON.stringify(value))
    .run();
};

const storedRows = async (): Promise<number> => {
  const row = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM settings WHERE key = ?')
    .bind(RECOVERY_KEY)
    .first<{ n: number }>();
  return row?.n ?? 0;
};

const login = async (password: string): Promise<number> =>
  (await call('POST', '/api/auth/login', { subject: 'admin1', password })).status;

const cookieFrom = (res: ResponseLike): string =>
  `jouska_session=${/jouska_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? ''}`;

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, TEST_MIGRATIONS);
  for (const table of ['audit_log', 'sessions', 'routes', 'settings', 'users']) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await call('POST', '/api/auth/bootstrap', { subject: 'admin1', password: OLD_PASSWORD });
});

describe('record parsing', () => {
  it('gives a hand-written bare token a deadline rather than immortality', () => {
    // `INSERT INTO settings VALUES ('password_reset', '"token"')` is the
    // shape an operator types. It must not mean "valid forever".
    const record = parseRecoveryRecord('a-hand-written-token-value', 1000);
    expect(record?.expiresAt).toBe(1000 + RECOVERY_TTL_SECONDS);
  });

  it('caps an absurd deadline instead of honouring it', () => {
    const record = parseRecoveryRecord({ token: TOKEN, expiresAt: 1000 + 400 * 86_400 }, 1000);
    expect(record?.expiresAt).toBe(1000 + RECOVERY_MAX_TTL_SECONDS);
  });

  it('anchors a ttl to createdAt, not to the moment of reading', () => {
    // Anchoring to read time would refresh the window on every request,
    // turning a 30-minute token into a permanent one.
    const record = parseRecoveryRecord({ token: TOKEN, createdAt: 500, ttlSeconds: 60 }, 10_000);
    expect(record?.expiresAt).toBe(560);
  });

  it('rejects a row with no token at all', () => {
    expect(parseRecoveryRecord({ expiresAt: 9_999_999_999 }, 1000)).toBeUndefined();
    expect(parseRecoveryRecord({ token: '   ' }, 1000)).toBeUndefined();
    expect(parseRecoveryRecord([TOKEN], 1000)).toBeUndefined();
    expect(parseRecoveryRecord(null, 1000)).toBeUndefined();
  });
});

describe('token check', () => {
  const now = 1_000_000;

  it('accepts the matching token inside the window', async () => {
    const stored = { token: TOKEN, expiresAt: now + 60 };
    await expect(checkRecoveryToken(stored, TOKEN, now)).resolves.toMatchObject({ ok: true });
  });

  it('refuses an expired token', async () => {
    const stored = { token: TOKEN, expiresAt: now - 1 };
    await expect(checkRecoveryToken(stored, TOKEN, now)).resolves.toMatchObject({ ok: false });
  });

  it('refuses a token that is too short to resist guessing', async () => {
    const short = 'short';
    const stored = { token: short, expiresAt: now + 60 };
    // Matches exactly, and is still refused: rewarding a weak token would
    // make the floor advisory.
    await expect(checkRecoveryToken(stored, short, now)).resolves.toMatchObject({ ok: false });
  });

  it('refuses when no window is open', async () => {
    await expect(checkRecoveryToken(undefined, TOKEN, now)).resolves.toMatchObject({ ok: false });
  });

  it('refuses a prefix of the real token', async () => {
    const stored = { token: TOKEN, expiresAt: now + 60 };
    await expect(checkRecoveryToken(stored, TOKEN.slice(0, -1), now)).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('the endpoint', () => {
  it('sets the new password and leaves the old one dead', async () => {
    await openWindow({ token: TOKEN, expiresAt: nowSeconds() + 600 });
    const res = await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'admin1',
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    await expect(login(NEW_PASSWORD)).resolves.toBe(200);
    await expect(login(OLD_PASSWORD)).resolves.toBe(401);
  });

  it('spends the token, so the same one cannot be replayed', async () => {
    await openWindow({ token: TOKEN, expiresAt: nowSeconds() + 600 });
    await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'admin1',
      password: NEW_PASSWORD,
    });
    expect(await storedRows()).toBe(0);
    const replay = await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'admin1',
      password: 'yet-another-password',
    });
    expect(replay.status).toBe(401);
    // The replay must not have changed anything either.
    await expect(login(NEW_PASSWORD)).resolves.toBe(200);
  });

  it('answers identically whether the window is closed or the token is wrong', async () => {
    const closed = await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'admin1',
      password: NEW_PASSWORD,
    });
    await openWindow({ token: TOKEN, expiresAt: nowSeconds() + 600 });
    const wrong = await call('POST', '/api/auth/recover', {
      token: 'a-different-but-long-enough-token',
      subject: 'admin1',
      password: NEW_PASSWORD,
    });
    // Same status and same body: the endpoint is not an oracle for "is a
    // recovery window open right now".
    expect(closed.status).toBe(wrong.status);
    expect(await closed.json()).toEqual(await wrong.json());
  });

  it('refuses an expired window', async () => {
    await openWindow({ token: TOKEN, expiresAt: nowSeconds() - 1 });
    const res = await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'admin1',
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(401);
    await expect(login(OLD_PASSWORD)).resolves.toBe(200);
  });

  it('honours a token pinned to a different account', async () => {
    await testEnv.DB.prepare(
      'INSERT INTO users (subject, role, password, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind('admin2', 'admin', 'pbkdf2$1$aa$bb', nowSeconds())
      .run();
    await openWindow({ token: TOKEN, subject: 'admin2', expiresAt: nowSeconds() + 600 });
    // The token was opened for admin2; it must not be redirected at admin1.
    const res = await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'admin1',
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(401);
    await expect(login(OLD_PASSWORD)).resolves.toBe(200);
    // And the token is still there to be used correctly.
    expect(await storedRows()).toBe(1);
  });

  it('enforces the password floor before touching the token', async () => {
    await openWindow({ token: TOKEN, expiresAt: nowSeconds() + 600 });
    const res = await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'admin1',
      password: 'short',
    });
    expect(res.status).toBe(400);
    // A rejected attempt must not have burned the window.
    expect(await storedRows()).toBe(1);
  });

  it('refuses a password long enough to be a CPU lever', async () => {
    await openWindow({ token: TOKEN, expiresAt: nowSeconds() + 600 });
    const res = await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'admin1',
      password: 'x'.repeat(200_000),
    });
    expect(res.status).toBe(400);
    expect(await storedRows()).toBe(1);
  });

  it('clears the lockout, so a locked-out admin is actually let back in', async () => {
    // Being locked out is a common reason to reach for recovery; leaving
    // locked_until set would hand back a password that still cannot be used.
    await testEnv.DB.prepare('UPDATE users SET failed_attempts = 5, locked_until = ? WHERE id = 1')
      .bind(nowSeconds() + 900)
      .run();
    await openWindow({ token: TOKEN, expiresAt: nowSeconds() + 600 });
    await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'admin1',
      password: NEW_PASSWORD,
    });
    await expect(login(NEW_PASSWORD)).resolves.toBe(200);
  });

  it('invalidates existing sessions of the recovered account', async () => {
    const first = await call('POST', '/api/auth/login', {
      subject: 'admin1',
      password: OLD_PASSWORD,
    });
    const cookie = first.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect((await call('GET', '/api/routes', undefined, { cookie })).status).toBe(200);
    await openWindow({ token: TOKEN, expiresAt: nowSeconds() + 600 });
    await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'admin1',
      password: NEW_PASSWORD,
    });
    // A recovery whose old cookies keep working has recovered nothing.
    expect((await call('GET', '/api/routes', undefined, { cookie })).status).toBe(401);
  });

  it('stores a real hash, not the password', async () => {
    await openWindow({ token: TOKEN, expiresAt: nowSeconds() + 600 });
    await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'admin1',
      password: NEW_PASSWORD,
    });
    const row = await testEnv.DB.prepare('SELECT password FROM users WHERE subject = ?')
      .bind('admin1')
      .first<{ password: string }>();
    expect(row?.password).not.toContain(NEW_PASSWORD);
    await expect(verifyPassword(NEW_PASSWORD, row?.password ?? '')).resolves.toBe(true);
  });

  it('records the recovery in the audit log', async () => {
    await openWindow({ token: TOKEN, expiresAt: nowSeconds() + 600 });
    await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'admin1',
      password: NEW_PASSWORD,
    });
    const row = await testEnv.DB.prepare('SELECT action, actor FROM audit_log WHERE action = ?')
      .bind('auth.recover')
      .first<{ action: string; actor: string }>();
    expect(row?.actor).toBe('admin1');
  });

  it('does not reveal whether an account exists', async () => {
    await openWindow({ token: TOKEN, expiresAt: nowSeconds() + 600 });
    const missing = await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'nobody-here',
      password: NEW_PASSWORD,
    });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'recovery_unavailable' });
  });

  it('still enforces same-origin, so a cross-site page cannot drive it', async () => {
    await openWindow({ token: TOKEN, expiresAt: nowSeconds() + 600 });
    const res = await worker.fetch(
      new Request(`${base}/api/auth/recover`, {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, subject: 'admin1', password: NEW_PASSWORD }),
      }),
      appEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
    expect(await storedRows()).toBe(1);
  });

  it('still works after a self-service password change', async () => {
    // The recovery token lives in settings, untouched by the password change —
    // which is the point: the self-change path must not be able to disable the
    // out-of-band lifeline.
    const loginRes = await call('POST', '/api/auth/login', {
      subject: 'admin1',
      password: OLD_PASSWORD,
    });
    await call(
      'POST',
      '/api/auth/password',
      { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD },
      { cookie: cookieFrom(loginRes) },
    );

    await openWindow({ token: TOKEN, expiresAt: nowSeconds() + 600 });
    const recover = await call('POST', '/api/auth/recover', {
      token: TOKEN,
      subject: 'admin1',
      password: OLD_PASSWORD,
    });
    expect(recover.status).toBe(200);
    expect(await login(OLD_PASSWORD)).toBe(200);
  });

  it('revokes every session including the one that drove the recovery', async () => {
    // Contrast with POST /api/auth/password, which keeps the caller's session:
    // recovery rides an unauthenticated request, so there is nothing to keep,
    // and a token spent from a stolen channel must leave nothing alive.
    const cookie = cookieFrom(
      await call('POST', '/api/auth/login', { subject: 'admin1', password: OLD_PASSWORD }),
    );
    await openWindow({ token: TOKEN, expiresAt: nowSeconds() + 600 });
    expect(
      (
        await call('POST', '/api/auth/recover', {
          token: TOKEN,
          subject: 'admin1',
          password: NEW_PASSWORD,
        })
      ).status,
    ).toBe(200);

    expect(await login(OLD_PASSWORD)).toBe(401);
    // The pre-recovery cookie is dead — this session was alive before the
    // recover call and must not have survived it. (/me always answers 200; it
    // is the SPA's login-state ping and says "no session" in the body.)
    const me = await call('GET', '/api/auth/me', undefined, { cookie });
    expect(((await me.json()) as { user: unknown }).user).toBeNull();
  });
});
