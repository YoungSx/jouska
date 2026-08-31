/**
 * Authentication endpoints: bootstrap, login, logout, whoami.
 *
 * Bootstrap is the first-run path: when `users` is empty, the first caller
 * creates the initial admin. After that it is closed forever — the row count
 * check and the unique index together close the race.
 */
import { Hono } from 'hono';
import { readJsonObject } from '../body.js';
import {
  clearCookieHeader,
  createSession,
  destroySession,
  resolveSession,
  sessionCookieHeader,
} from '../auth.js';
import type { AppEnv } from '../env.js';
import { hashPassword, verifyPassword } from '../password.js';

/** Consecutive failures before the account parks until locked_until. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 15 * 60;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

interface UserRow {
  id: number;
  subject: string;
  role: string;
  password: string | null;
  disabled: number;
  failed_attempts: number;
  locked_until: number | null;
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/bootstrap', async (c) => {
  const body = await readJsonObject(c);
  if (
    typeof body.subject !== 'string' ||
    typeof body.password !== 'string' ||
    body.password.length < 12
  ) {
    return c.json(
      { error: 'invalid_input', detail: 'subject and password (min 12 chars) are required' },
      400,
    );
  }
  const existing = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    return c.json({ error: 'already_bootstrapped' }, 409);
  }
  const passwordHash = await hashPassword(body.password);
  try {
    await c.env.DB.prepare(
      'INSERT INTO users (subject, role, password, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(body.subject, 'admin', passwordHash, nowSeconds())
      .run();
  } catch {
    // Lost the bootstrap race: the unique index means the table is no longer empty.
    return c.json({ error: 'already_bootstrapped' }, 409);
  }
  return c.json({ ok: true }, 201);
});

authRoutes.post('/login', async (c) => {
  const body = await readJsonObject(c);
  if (typeof body.subject !== 'string' || typeof body.password !== 'string') {
    return c.json({ error: 'invalid_input' }, 400);
  }
  const user = await c.env.DB.prepare(
    'SELECT id, subject, role, password, disabled, failed_attempts, locked_until FROM users WHERE subject = ?',
  )
    .bind(body.subject)
    .first<UserRow>();

  const now = nowSeconds();
  // Uniform failure shape: a wrong subject and a wrong password look the same.
  if (user === null || user.password === null) {
    return c.json({ error: 'invalid_credentials' }, 401);
  }
  if (user.disabled) {
    return c.json({ error: 'account_disabled' }, 403);
  }
  if (user.locked_until !== null && user.locked_until > now) {
    return c.json({ error: 'locked', retryAfterSeconds: user.locked_until - now }, 429);
  }

  const ok = await verifyPassword(body.password, user.password);
  if (!ok) {
    const failed = user.failed_attempts + 1;
    const lock = failed >= MAX_FAILED_ATTEMPTS ? now + LOCKOUT_SECONDS : null;
    await c.env.DB.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .bind(failed, lock, user.id)
      .run();
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  await c.env.DB.prepare(
    'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_seen = ? WHERE id = ?',
  )
    .bind(now, user.id)
    .run();
  const { token, expiresAt } = await createSession(c.env.DB, { id: user.id });
  c.header('set-cookie', sessionCookieHeader(token, expiresAt, true));
  return c.json({
    user: { subject: user.subject, role: user.role === 'viewer' ? 'viewer' : 'admin' },
  });
});

authRoutes.post('/logout', async (c) => {
  await destroySession(c.env.DB, c.req.header('cookie'));
  c.header('set-cookie', clearCookieHeader());
  return c.json({ ok: true });
});

authRoutes.get('/me', async (c) => {
  // This group is mounted before the global requireUser, so /me guards
  // itself — it is the endpoint the SPA pings to discover login state.
  // bootstrapable lets the SPA show the first-run form only while the
  // endpoint could actually succeed, without the SPA probing POSTs.
  const user = await resolveSession(c.env.DB, c.req.header('cookie'));
  if (user === undefined) {
    const existing = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{
      n: number;
    }>();
    return c.json({ user: null, bootstrapable: (existing?.n ?? 0) === 0 }, 200);
  }
  return c.json({ user, bootstrapable: false });
});
