/**
 * Account management: change own password, list, create, update, delete.
 *
 * The interesting surface here is not the happy path but the ways this could
 * brick the panel: demoting or disabling the last admin, deleting every row
 * (which would reopen bootstrap to the public), or a password change that
 * lets a stolen cookie lock the owner out. Each guarded refusal is asserted
 * against the database, not just the status code.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from './index.js';
import type { AppEnv, Env } from './env.js';
import { verifyPassword } from './password.js';
import { MAX_PASSWORD_LENGTH, MAX_SUBJECT_LENGTH, MIN_PASSWORD_LENGTH } from './validate.js';

const testEnv = env as unknown as Env;
const appEnv = testEnv as unknown as AppEnv;
const base = 'https://panel.test';

interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

const call = async (
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ResponseLike> =>
  worker.fetch(
    new Request(`${base}${path}`, {
      method,
      headers: {
        origin: base,
        'content-type': 'application/json',
        ...(body === undefined ? {} : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    appEnv,
    {} as ExecutionContext,
  ) as unknown as Promise<ResponseLike>;

const get = async (path: string, headers: Record<string, string> = {}): Promise<ResponseLike> =>
  worker.fetch(
    new Request(`${base}${path}`, { headers }),
    appEnv,
    {} as ExecutionContext,
  ) as unknown as Promise<ResponseLike>;

const login = (subject: string, password: string): Promise<ResponseLike> =>
  call('POST', '/api/auth/login', { subject, password });

/** Logs in and unwraps the session cookie. Intentional-failure logins use the raw one. */
const loginCookie = async (subject: string, password: string): Promise<string> => {
  const res = await login(subject, password);
  const setCookie = res.headers.get('set-cookie') ?? '';
  expect(/jouska_session=([^;]+)/.test(setCookie), 'login must set a cookie').toBe(true);
  return `jouska_session=${/jouska_session=([^;]+)/.exec(setCookie)![1]}`;
};

const bootstrapAdmin = async (): Promise<void> => {
  const res = await call('POST', '/api/auth/bootstrap', { subject: 'root', password: ROOT_PW });
  expect(res.status, JSON.stringify(await res.json())).toBe(201);
};

const ROOT_PW = 'correct-horse-battery';
const OTHER_PW = 'a-different-long-password';
const NEW_PW = 'the-replacement-password';

const userRow = async (subject: string): Promise<{
  id: number;
  password: string | null;
  failed_attempts: number;
  locked_until: number | null;
  disabled: number;
  role: string;
} | null> =>
  testEnv.DB.prepare(
    'SELECT id, password, failed_attempts, locked_until, disabled, role FROM users WHERE subject = ?',
  )
    .bind(subject)
    .first();

const auditActions = async (): Promise<string[]> => {
  const { results } = await testEnv.DB.prepare('SELECT action FROM audit_log').all<{
    action: string;
  }>();
  return results.map((r) => r.action);
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** A second admin created through the API, with its own live session. */
const secondAdmin = async (adminCookie: string): Promise<{ cookie: string; id: number }> => {
  const res = await call(
    'POST',
    '/api/users',
    { subject: 'deputy', password: OTHER_PW, role: 'admin' },
    { cookie: adminCookie },
  );
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { id: number }).id;
  return { cookie: await loginCookie('deputy', OTHER_PW), id };
};

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, TEST_MIGRATIONS);
  for (const table of ['audit_log', 'sessions', 'routes', 'settings', 'users']) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await bootstrapAdmin();
});

describe('POST /api/auth/password', () => {
  it('refuses a wrong current password and counts the failure', async () => {
    const cookie = await loginCookie('root', ROOT_PW);
    const before = await userRow('root');

    const res = await call(
      'POST',
      '/api/auth/password',
      { currentPassword: 'a-wrong-guess-long', newPassword: NEW_PW },
      { cookie },
    );
    expect(res.status).toBe(401);

    const after = await userRow('root');
    expect(after?.failed_attempts).toBe((before?.failed_attempts ?? 0) + 1);
    expect(after?.password).toBe(before?.password); // hash untouched
  });

  it('changes the password, kills other sessions, keeps the current one', async () => {
    const current = await loginCookie('root', ROOT_PW);
    const other = await loginCookie('root', ROOT_PW); // second session
    expect((await get('/api/routes', { cookie: other })).status).toBe(200);

    const res = await call(
      'POST',
      '/api/auth/password',
      { currentPassword: ROOT_PW, newPassword: NEW_PW },
      { cookie: current },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revokedSessions?: number };
    expect(body.revokedSessions).toBe(1);

    // Current session survives; the other one is dead.
    expect((await get('/api/routes', { cookie: current })).status).toBe(200);
    expect((await get('/api/routes', { cookie: other })).status).toBe(401);

    // The stored hash flipped with it.
    const row = await userRow('root');
    expect(await verifyPassword(NEW_PW, row?.password ?? '')).toBe(true);
    expect(await verifyPassword(ROOT_PW, row?.password ?? '')).toBe(false);

    // Old password can no longer log in; new one can.
    expect((await login('root', ROOT_PW)).status).toBe(401);
    expect((await login('root', NEW_PW)).status).toBe(200);
  });

  it('enforces the password floor and ceiling without counting it as a failure', async () => {
    const cookie = await loginCookie('root', ROOT_PW);
    const before = await userRow('root');

    expect(
      (await call('POST', '/api/auth/password', { currentPassword: ROOT_PW, newPassword: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) }, { cookie })).status,
    ).toBe(400);
    expect(
      (await call('POST', '/api/auth/password', { currentPassword: ROOT_PW, newPassword: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) }, { cookie })).status,
    ).toBe(400);
    expect(
      (await call('POST', '/api/auth/password', { currentPassword: 'x'.repeat(MAX_PASSWORD_LENGTH + 1), newPassword: NEW_PW }, { cookie })).status,
    ).toBe(400);

    const after = await userRow('root');
    expect(after?.failed_attempts).toBe(before?.failed_attempts); // shape errors are not guesses
    // The floor itself still works: exactly MIN chars goes through.
    expect(
      (await call('POST', '/api/auth/password', { currentPassword: ROOT_PW, newPassword: 'x'.repeat(MIN_PASSWORD_LENGTH) }, { cookie })).status,
    ).toBe(200);
  });

  it('shares the login lockout: five wrong current passwords lock both endpoints', async () => {
    const cookie = await loginCookie('root', ROOT_PW);
    for (let i = 0; i < 5; i += 1) {
      expect(
        (
          await call(
            'POST',
            '/api/auth/password',
            { currentPassword: 'a-wrong-guess-long', newPassword: NEW_PW },
            { cookie },
          )
        ).status,
      ).toBe(401);
    }
    const locked = await call(
      'POST',
      '/api/auth/password',
      { currentPassword: ROOT_PW, newPassword: NEW_PW },
      { cookie },
    );
    expect(locked.status).toBe(429);
    const body = (await locked.json()) as { retryAfterSeconds?: number };
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    // The lock is the account's, so login is locked out by the same window.
    expect((await login('root', ROOT_PW)).status).toBe(429);
  });

  it('answers 409 for an account that has no password to verify', async () => {
    await testEnv.DB.prepare(
      "INSERT INTO users (subject, role, created_at) VALUES ('sso-user', 'admin', ?)",
    )
      .bind(nowSeconds())
      .run();
    const sso = await testEnv.DB.prepare('SELECT id FROM users WHERE subject = ?')
      .bind('sso-user')
      .first<{ id: number }>();
    // Fabricate a session for the passwordless account directly.
    const { createSession } = await import('./auth.js');
    const { token } = await createSession(testEnv.DB, { id: sso!.id });
    const cookie = `jouska_session=${token}`;

    const res = await call(
      'POST',
      '/api/auth/password',
      { currentPassword: ROOT_PW, newPassword: NEW_PW },
      { cookie },
    );
    expect(res.status).toBe(409);
  });

  it('stays behind the same-origin gate and records the change', async () => {
    const cookie = await loginCookie('root', ROOT_PW);
    const evil = await worker.fetch(
      new Request(`${base}/api/auth/password`, {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json', cookie },
        body: JSON.stringify({ currentPassword: ROOT_PW, newPassword: NEW_PW }),
      }),
      appEnv,
      {} as ExecutionContext,
    );
    expect(evil.status).toBe(403);

    await call('POST', '/api/auth/password', { currentPassword: ROOT_PW, newPassword: NEW_PW }, {
      cookie,
    });
    expect(await auditActions()).toContain('auth.password');
  });
});

describe('GET /api/users', () => {
  it('lists users with session counts and never leaks the hash column', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    await call('POST', '/api/users', { subject: 'scout', password: OTHER_PW, role: 'viewer' }, { cookie: adminCookie });
    await login('scout', OTHER_PW); // one live session for scout
    await login('scout', OTHER_PW); // second one

    const res = await get('/api/users', { cookie: adminCookie });
    expect(res.status).toBe(200);
    // The raw body, not a parsed projection: a stray `*` in the SQL would only
    // be visible here.
    const raw = await res.text();
    expect(raw).not.toContain('pbkdf2$');
    const body = JSON.parse(raw) as {
      users: {
        subject: string;
        role: string;
        disabled: boolean;
        sessions: number;
        createdAt: number;
        lastSeen: number | null;
      }[];
    };
    const scout = body.users.find((u) => u.subject === 'scout');
    expect(scout?.role).toBe('viewer');
    expect(scout?.disabled).toBe(false);
    expect(scout?.sessions).toBe(2);
    expect(scout?.createdAt).toBeGreaterThan(0);
    expect(scout?.lastSeen).not.toBeNull();
  });

  it('is admin-only and requires a session', async () => {
    expect((await get('/api/users')).status).toBe(401);
    const adminCookie = await loginCookie('root', ROOT_PW);
    await call('POST', '/api/users', { subject: 'scout', password: OTHER_PW, role: 'viewer' }, { cookie: adminCookie });
    const viewerCookie = await loginCookie('scout', OTHER_PW);
    expect((await get('/api/users', { cookie: viewerCookie })).status).toBe(403);
  });
});

describe('POST /api/users', () => {
  it('creates a viewer by default with a verifiable hash and no echo of the password', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    const res = await call(
      'POST',
      '/api/users',
      { subject: 'scout', password: OTHER_PW, email: 'scout@example.com' },
      { cookie: adminCookie },
    );
    expect(res.status).toBe(201);
    expect(await res.text()).not.toContain(OTHER_PW);

    const row = await userRow('scout');
    expect(row?.role).toBe('viewer'); // default, not the column's 'admin'
    expect(row?.disabled).toBe(0);
    expect(await verifyPassword(OTHER_PW, row?.password ?? '')).toBe(true);
    expect((await login('scout', OTHER_PW)).status).toBe(200);
  });

  it('rejects duplicates, bad shapes, and invalid roles as 400/409 — never 500', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    const create = (body: unknown) => call('POST', '/api/users', body, { cookie: adminCookie });

    expect((await create({ subject: 'root', password: OTHER_PW })).status).toBe(409);
    expect((await create({ subject: '', password: OTHER_PW })).status).toBe(400);
    expect(
      (await create({ subject: 'x'.repeat(MAX_SUBJECT_LENGTH + 1), password: OTHER_PW })).status,
    ).toBe(400);
    expect((await create({ subject: 'scout', password: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) })).status).toBe(
      400,
    );
    expect((await create({ subject: 'scout', password: OTHER_PW, role: 'superadmin' })).status).toBe(
      400,
    );
  });

  it('is admin-only', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    await call('POST', '/api/users', { subject: 'scout', password: OTHER_PW, role: 'viewer' }, { cookie: adminCookie });
    const viewerCookie = await loginCookie('scout', OTHER_PW);
    expect(
      (
        await call(
          'POST',
          '/api/users',
          { subject: 'scout2', password: OTHER_PW },
          { cookie: viewerCookie },
        )
      ).status,
    ).toBe(403);
  });
});

describe('PATCH /api/users/:id', () => {
  it('demotes a second admin and the new role applies to their next request', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    const deputy = await secondAdmin(adminCookie);

    expect(
      (await call('PATCH', `/api/users/${String(deputy.id)}`, { role: 'viewer' }, { cookie: adminCookie })).status,
    ).toBe(200);
    // resolveSession joins the role per request, so this is immediate — no
    // re-login, no grace period.
    expect((await get('/api/users', { cookie: deputy.cookie })).status).toBe(403);
  });

  it('refuses to demote or disable the only admin', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    const row = await userRow('root');
    const id = String(row!.id);

    const demote = await call('PATCH', `/api/users/${id}`, { role: 'viewer' }, { cookie: adminCookie });
    expect(demote.status).toBe(409);
    expect(((await demote.json()) as { error: string }).error).toBe('last_admin');

    expect((await call('PATCH', `/api/users/${id}`, { disabled: true }, { cookie: adminCookie })).status).toBe(409);
    // The row must be untouched by both refusals.
    expect((await userRow('root'))?.role).toBe('admin');
    expect((await userRow('root'))?.disabled).toBe(0);
  });

  it('holds both invariants: a disabled admin does not count as a spare', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    const deputy = await secondAdmin(adminCookie);
    // Park the deputy first; now root is the only *enabled* admin.
    expect(
      (await call('PATCH', `/api/users/${String(deputy.id)}`, { disabled: true }, { cookie: adminCookie })).status,
    ).toBe(200);

    // Root cannot be disabled or demoted — deputy does not count as a spare.
    const row = await userRow('root');
    const id = String(row!.id);
    expect((await call('PATCH', `/api/users/${id}`, { disabled: true }, { cookie: adminCookie })).status).toBe(409);
    expect((await call('PATCH', `/api/users/${id}`, { role: 'viewer' }, { cookie: adminCookie })).status).toBe(409);

    // But the parked deputy can still be demoted: that only shrinks the row
    // count, not the enabled pool.
    expect(
      (await call('PATCH', `/api/users/${String(deputy.id)}`, { role: 'viewer' }, { cookie: adminCookie })).status,
    ).toBe(200);
  });

  it('unlocks by clearing the lockout and the counter together', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    await call('POST', '/api/users', { subject: 'scout', password: OTHER_PW }, { cookie: adminCookie });
    const scout = await userRow('scout');
    await testEnv.DB.prepare('UPDATE users SET failed_attempts = 5, locked_until = ? WHERE id = ?')
      .bind(nowSeconds() + 900, scout!.id)
      .run();

    const res = await call(
      'PATCH',
      `/api/users/${String(scout!.id)}`,
      { unlock: true },
      { cookie: adminCookie },
    );
    expect(res.status).toBe(200);
    const after = await userRow('scout');
    expect(after?.failed_attempts).toBe(0);
    expect(after?.locked_until).toBeNull();
    // The point of unlocking: the account can actually log in again.
    expect((await login('scout', OTHER_PW)).status).toBe(200);
  });

  it('updates only the named fields, refuses nonsense, and audits', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    await call('POST', '/api/users', { subject: 'scout', password: OTHER_PW, role: 'viewer' }, { cookie: adminCookie });
    const scout = await userRow('scout');
    const id = String(scout!.id);

    // Role-only change must not touch disabled.
    await call('PATCH', `/api/users/${id}`, { role: 'admin' }, { cookie: adminCookie });
    expect((await userRow('scout'))?.role).toBe('admin');
    expect((await userRow('scout'))?.disabled).toBe(0);

    expect((await call('PATCH', `/api/users/${id}`, {}, { cookie: adminCookie })).status).toBe(400);
    expect(
      (await call('PATCH', `/api/users/${id}`, { disabled: 'yes' }, { cookie: adminCookie })).status,
    ).toBe(400);
    expect((await call('PATCH', '/api/users/999', { role: 'viewer' }, { cookie: adminCookie })).status).toBe(404);
    expect((await call('PATCH', '/api/users/root', { role: 'viewer' }, { cookie: adminCookie })).status).toBe(404);

    expect(await auditActions()).toContain('user.update');
  });
});

describe('DELETE /api/users/:id', () => {
  it('deletes a viewer and cascades their sessions out from under the cookie', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    await call('POST', '/api/users', { subject: 'scout', password: OTHER_PW }, { cookie: adminCookie });
    const scoutCookie = await loginCookie('scout', OTHER_PW);
    expect((await get('/api/routes', { cookie: scoutCookie })).status).toBe(200);
    const scout = await userRow('scout');

    expect(
      (await call('DELETE', `/api/users/${String(scout!.id)}`, undefined, { cookie: adminCookie })).status,
    ).toBe(200);
    expect((await get('/api/routes', { cookie: scoutCookie })).status).toBe(401);
    expect(await userRow('scout')).toBeNull();
  });

  it('re-evaluates the guard at write time, so the last admin cannot be deleted', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    const deputy = await secondAdmin(adminCookie);

    // One of two admins goes.
    expect(
      (await call('DELETE', `/api/users/${String(deputy.id)}`, undefined, { cookie: adminCookie })).status,
    ).toBe(200);
    // Now the same request shape hits a different table state: refused, and
    // the remaining admin is still there.
    const root = await userRow('root');
    const refused = await call(
      'DELETE',
      `/api/users/${String(root!.id)}`,
      undefined,
      { cookie: adminCookie },
    );
    expect(refused.status).toBe(409);
    // Root is now the only row left, so the endpoint names the stricter wall:
    // deleting it would empty the table and reopen bootstrap.
    expect(((await refused.json()) as { error: string }).error).toBe('last_user');
    expect(await userRow('root')).not.toBeNull();
  });

  it('refuses to empty the table: bootstrap must not reopen', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    // A second admin, parked, so its deletion leaves exactly one row.
    const deputy = await secondAdmin(adminCookie);
    await call('PATCH', `/api/users/${String(deputy.id)}`, { disabled: true }, { cookie: adminCookie });
    expect((await call('DELETE', `/api/users/${String(deputy.id)}`, undefined, { cookie: adminCookie })).status).toBe(200);

    const root = await userRow('root');
    const refused = await call(
      'DELETE',
      `/api/users/${String(root!.id)}`,
      undefined,
      { cookie: adminCookie },
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('last_user');
    const count = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('lets an admin delete themselves when a spare admin exists, and dies with their session', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    const deputy = await secondAdmin(adminCookie);
    // Deputy lists users to learn its own id, then deletes itself.
    const list = await get('/api/users', { cookie: deputy.cookie });
    const self = (
      (await list.json()) as { users: { id: number; subject: string }[] }
    ).users.find((u) => u.subject === 'deputy');

    expect(
      (await call('DELETE', `/api/users/${String(self!.id)}`, undefined, { cookie: deputy.cookie })).status,
    ).toBe(200);
    // The cascade removed the session the request itself was riding on.
    expect((await get('/api/users', { cookie: deputy.cookie })).status).toBe(401);
    // The other admin survives.
    expect((await get('/api/users', { cookie: adminCookie })).status).toBe(200);
  });

  it('answers 404 for unknown and malformed ids, and audits real deletions', async () => {
    const adminCookie = await loginCookie('root', ROOT_PW);
    expect((await call('DELETE', '/api/users/999', undefined, { cookie: adminCookie })).status).toBe(404);
    expect((await call('DELETE', '/api/users/root', undefined, { cookie: adminCookie })).status).toBe(404);

    await call('POST', '/api/users', { subject: 'scout', password: OTHER_PW }, { cookie: adminCookie });
    const scout = await userRow('scout');
    await call('DELETE', `/api/users/${String(scout!.id)}`, undefined, { cookie: adminCookie });
    expect(await auditActions()).toContain('user.delete');
  });
});
