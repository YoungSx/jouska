/**
 * Authentication endpoints: bootstrap, login, logout, whoami.
 *
 * Bootstrap is the first-run path: when `users` is empty, the first caller
 * creates the initial admin. After that it is closed forever — the row count
 * check and the unique index together close the race.
 */
import { Hono } from 'hono';
import { accessLogoutUrl } from 'jouska';
import { readJsonObject } from '../body.js';
import {
  clearCookieHeader,
  createSession,
  destroySession,
  sessionCookieHeader,
  sessionTokenHashFromCookie,
} from '../auth.js';
import type { AppEnv } from '../env.js';
import { authenticate, requireUser } from '../middleware.js';
import { hashPassword, verifyPassword } from '../password.js';
import {
  boundedString,
  MAX_PASSWORD_LENGTH,
  MAX_SUBJECT_LENGTH,
  MIN_PASSWORD_LENGTH,
  parseJsonSafe,
} from '../validate.js';
import { checkRecoveryToken, RECOVERY_KEY, RECOVERY_MAX_TOKEN_LENGTH } from '../recovery.js';
import {
  audit,
  changePasswordAndRevokeOthers,
  consumeRecoveryAndSetPassword,
  getSettingRaw,
} from '../store.js';

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
  // Bounds before work: the password is about to be hashed, and an unbounded
  // one is the cheapest way to spend this request's whole CPU budget.
  const subject = boundedString(body.subject, MAX_SUBJECT_LENGTH);
  const password = typeof body.password === 'string' ? body.password : undefined;
  if (
    subject === undefined ||
    password === undefined ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return c.json(
      {
        error: 'invalid_input',
        detail: `subject (1-${MAX_SUBJECT_LENGTH} chars, not blank) and password (${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} chars) are required`,
      },
      400,
    );
  }
  const existing = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    return c.json({ error: 'already_bootstrapped' }, 409);
  }
  const passwordHash = await hashPassword(password);
  try {
    await c.env.DB.prepare(
      'INSERT INTO users (subject, role, password, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(subject, 'admin', passwordHash, nowSeconds())
      .run();
  } catch {
    // Lost the bootstrap race: the unique index means the table is no longer empty.
    return c.json({ error: 'already_bootstrapped' }, 409);
  }
  return c.json({ ok: true }, 201);
});

authRoutes.post('/login', async (c) => {
  const body = await readJsonObject(c);
  // Login is reachable unauthenticated, so the bounds matter more here than at
  // bootstrap: without them anyone can make this worker hash arbitrarily long
  // input on demand. Rejected before the lookup, let alone the hash.
  const subject = boundedString(body.subject, MAX_SUBJECT_LENGTH);
  const password = typeof body.password === 'string' ? body.password : undefined;
  if (subject === undefined || password === undefined || password.length > MAX_PASSWORD_LENGTH) {
    return c.json({ error: 'invalid_input' }, 400);
  }
  const user = await c.env.DB.prepare(
    'SELECT id, subject, role, password, disabled, failed_attempts, locked_until FROM users WHERE subject = ?',
  )
    .bind(subject)
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

  const ok = await verifyPassword(password, user.password);
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
  // Dropping this Worker's cookie does not end an Access session: the platform's
  // own `CF_Authorization` lives on the team domain, and without visiting the
  // team's sign-out endpoint the operator is signed straight back in on reload.
  // So the caller is told where to go, and told it before the local session is
  // destroyed — afterwards there is nothing left to identify which door they
  // came through.
  const outcome = await authenticate(c);
  const accessLogout =
    outcome.ok && outcome.user.via === 'access' ? accessLogoutUrl(c.env.ACCESS_TEAM) : undefined;
  await destroySession(c.env.DB, c.req.header('cookie'));
  c.header('set-cookie', clearCookieHeader());
  return c.json(accessLogout === undefined ? { ok: true } : { ok: true, accessLogout });
});

/**
 * Out-of-band password recovery: spend a token an operator wrote into
 * `settings` and set a new password. Reachable unauthenticated by necessity —
 * whoever needs it cannot log in.
 *
 * Every failure returns the same 401 `recovery_unavailable`. Distinguishing
 * "no window open" from "wrong token" from "expired" would let anyone poll this
 * endpoint to learn when an operator opens a window, which is exactly the
 * moment worth attacking.
 */
authRoutes.post('/recover', async (c) => {
  const body = await readJsonObject(c);
  const token = boundedString(body.token, RECOVERY_MAX_TOKEN_LENGTH);
  const subject = boundedString(body.subject, MAX_SUBJECT_LENGTH);
  const password = typeof body.password === 'string' ? body.password : undefined;
  const unavailable = { error: 'recovery_unavailable' } as const;

  // Shape errors answer 400 — they say nothing about whether a window is open.
  if (
    password === undefined ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return c.json(
      {
        error: 'invalid_input',
        detail: `password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`,
      },
      400,
    );
  }
  if (token === undefined || subject === undefined) {
    return c.json({ error: 'invalid_input', detail: 'token and subject are required' }, 400);
  }

  const stored = await getSettingRaw(c.env.DB, RECOVERY_KEY);
  const parsed = stored === undefined ? undefined : parseJsonSafe(stored);
  const check = await checkRecoveryToken(
    parsed !== undefined && parsed.ok ? parsed.value : undefined,
    token,
    nowSeconds(),
  );
  if (!check.ok) {
    return c.json(unavailable, 401);
  }
  // A token may be pinned to one account, so a leaked token cannot be
  // redirected at a different admin than the operator intended.
  if (check.record.subject !== undefined && check.record.subject !== subject) {
    return c.json(unavailable, 401);
  }

  const user = await c.env.DB.prepare('SELECT id, subject FROM users WHERE subject = ?')
    .bind(subject)
    .first<{ id: number; subject: string }>();
  if (user === null) {
    return c.json(unavailable, 401);
  }

  const passwordHash = await hashPassword(password);
  // One transaction: spend the token and write the password together, so a
  // second concurrent request finds nothing to spend.
  const spent = await consumeRecoveryAndSetPassword(c.env.DB, {
    recoveryKey: RECOVERY_KEY,
    expectedValue: stored as string,
    userId: user.id,
    passwordHash,
  });
  if (!spent) {
    return c.json(unavailable, 401);
  }
  // Audited under the recovered account: the log must show that this password
  // came in through the out-of-band path, not through a normal change.
  await audit(c.env.DB, user.subject, 'auth.recover', user.subject, {
    via: 'settings-token',
  });
  return c.json({ ok: true });
});

authRoutes.get('/me', async (c) => {
  // This group is mounted before the global requireUser, so /me guards
  // itself — it is the endpoint the SPA pings to discover login state. It runs
  // the same `authenticate` the middleware does, because a discovery endpoint
  // that reached a different verdict than the gate would be worse than none.
  const outcome = await authenticate(c);
  if (outcome.ok) {
    return c.json({ user: outcome.user, bootstrapable: false });
  }

  // Access vouched for someone the panel has never heard of. Not a login
  // problem — the platform already answered that — so the SPA is told the
  // address and can say who to ask, instead of showing a form.
  if (outcome.error === 'no_panel_account') {
    return c.json({ user: null, bootstrapable: false, accessEmail: outcome.accessEmail }, 200);
  }
  // A refusal that is about *this* caller has to be reported as itself: a
  // disabled account or an unverifiable Access token must not be flattened into
  // "please log in", which would send the operator round a loop the login form
  // cannot break.
  if (outcome.status !== 401) {
    return c.json({ error: outcome.error }, outcome.status);
  }

  // bootstrapable lets the SPA show the first-run form only while the endpoint
  // could actually succeed, without the SPA probing POSTs.
  const existing = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{
    n: number;
  }>();
  return c.json({ user: null, bootstrapable: (existing?.n ?? 0) === 0 }, 200);
});

/**
 * Change the caller's own password.
 *
 * Mounted in this group — before the global requireUser — so it carries its
 * own guard. The current password is verified first: a stolen session cookie
 * alone must not be able to lock the owner out.
 */
authRoutes.post('/password', requireUser, async (c) => {
  const body = await readJsonObject(c);
  // Passwords are never run through boundedString: it trims, and a leading or
  // trailing space is part of the password. Same checks as bootstrap/login.
  const currentPassword =
    typeof body.currentPassword === 'string' ? body.currentPassword : undefined;
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : undefined;
  if (
    currentPassword === undefined ||
    newPassword === undefined ||
    currentPassword.length > MAX_PASSWORD_LENGTH ||
    newPassword.length < MIN_PASSWORD_LENGTH ||
    newPassword.length > MAX_PASSWORD_LENGTH
  ) {
    return c.json(
      {
        error: 'invalid_input',
        detail: `currentPassword is required (<= ${MAX_PASSWORD_LENGTH} chars) and newPassword must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`,
      },
      400,
    );
  }

  const user = await c.env.DB.prepare('SELECT id, password, locked_until FROM users WHERE id = ?')
    .bind(c.get('user').userId)
    .first<{ id: number; password: string | null; locked_until: number | null }>();

  // An account without a password is one an SSO/Access flow owns; it has no
  // current password to verify, so the change is refused, not bypassed.
  if (user === null || user.password === null) {
    return c.json({ error: 'no_password' }, 409);
  }

  // The lockout is checked before any hashing: a locked account must not be
  // able to spend CPU verifying anything, correctly or not.
  const now = nowSeconds();
  if (user.locked_until !== null && user.locked_until > now) {
    return c.json({ error: 'locked', retryAfterSeconds: user.locked_until - now }, 429);
  }

  // One wrong current password counts exactly as one failed login: the same
  // counter, the same ceiling, the same lockout. Copying the constants would
  // let the two drift.
  const ok = await verifyPassword(currentPassword, user.password);
  if (!ok) {
    const existing = await c.env.DB.prepare('SELECT failed_attempts FROM users WHERE id = ?')
      .bind(user.id)
      .first<{ failed_attempts: number }>();
    const failed = (existing?.failed_attempts ?? 0) + 1;
    const lock = failed >= MAX_FAILED_ATTEMPTS ? now + LOCKOUT_SECONDS : null;
    await c.env.DB.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .bind(failed, lock, user.id)
      .run();
    return c.json({ error: 'wrong_password' }, 401);
  }

  const passwordHash = await hashPassword(newPassword);
  // Keep the current session by its hash — the D1-side identity the cookie
  // resolves to. No new cookie is set: the session that proved itself lives on.
  const revoked = await changePasswordAndRevokeOthers(c.env.DB, {
    userId: user.id,
    passwordHash,
    keepTokenHash: (await sessionTokenHashFromCookie(c.req.header('cookie'))) ?? '',
  });
  await audit(c.env.DB, c.get('user').subject, 'auth.password', c.get('user').subject, {
    revokedSessions: revoked,
  });
  return c.json({ ok: true, revokedSessions: revoked });
});
