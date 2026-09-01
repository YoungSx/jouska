/**
 * User management endpoints (admin only).
 *
 * Mounted after the global requireUser, so every handler here already has
 * `c.var.user`; requireAdmin gates each one. The last-admin invariant is not
 * enforced here — it lives inside the store's guarded statements, where it is
 * evaluated atomically at write time.
 */
import { Hono } from 'hono';
import { readJsonObject } from '../body.js';
import type { AppEnv } from '../env.js';
import { requireAdmin } from '../middleware.js';
import { hashPassword } from '../password.js';
import {
  audit,
  deleteUserGuarded,
  insertUser,
  listUsers,
  updateUserGuarded,
  type UserUpdate,
} from '../store.js';
import {
  boundedString,
  isPlainObject,
  MAX_PASSWORD_LENGTH,
  MAX_SUBJECT_LENGTH,
  MIN_PASSWORD_LENGTH,
  strictBoolean,
} from '../validate.js';

export const userRoutes = new Hono<AppEnv>();

const bad = (detail: string) => ({ error: 'invalid_input', detail } as const);

/** Row ids are integers; anything else was never a user and is 404, not a bind error. */
const idParam = (raw: string | undefined): number | undefined =>
  raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;

const isRole = (value: unknown): value is 'admin' | 'viewer' =>
  value === 'admin' || value === 'viewer';

userRoutes.get('/users', requireAdmin, async (c) => {
  return c.json({ users: await listUsers(c.env.DB) });
});

// The endpoint's default role is 'viewer' — deliberately the opposite of the
// column's DEFAULT 'admin'. An account created by a click should err toward
// less power; the bootstrap path is the only place 'admin' is ever assumed.
userRoutes.post('/users', requireAdmin, async (c) => {
  const body = await readJsonObject(c);
  const subject = boundedString(body.subject, MAX_SUBJECT_LENGTH);
  const email = boundedString(body.email, MAX_SUBJECT_LENGTH);
  const password = typeof body.password === 'string' ? body.password : undefined;
  const role = body.role === undefined ? 'viewer' : isRole(body.role) ? body.role : undefined;
  if (
    subject === undefined ||
    password === undefined ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH ||
    role === undefined
  ) {
    return c.json(
      bad(
        `subject (1-${MAX_SUBJECT_LENGTH} chars, not blank), password (${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} chars) and role (admin|viewer) are required`,
      ),
      400,
    );
  }
  const passwordHash = await hashPassword(password);
  const id = await insertUser(c.env.DB, { subject, email, role, passwordHash });
  if (id === undefined) {
    return c.json({ error: 'subject_taken' }, 409);
  }
  await audit(c.env.DB, c.get('user').subject, 'user.create', subject, { id, role });
  // The password is deliberately not echoed back; the operator set it and can
  // hand it over out of band.
  return c.json({ ok: true, id }, 201);
});

userRoutes.patch('/users/:id', requireAdmin, async (c) => {
  const id = idParam(c.req.param('id'));
  if (id === undefined) {
    return c.json({ error: 'not_found' }, 404);
  }
  const body = await readJsonObject(c);
  if (!isPlainObject(body)) {
    return c.json(bad('a JSON object is required'), 400);
  }
  // A mistyped value (`disabled: 'yes'`) is a client bug and answers 400, not
  // a silent false. Absent is absent; all three absent means nothing to do.
  const role = body.role === undefined ? undefined : isRole(body.role) ? body.role : null;
  const disabled = body.disabled === undefined ? undefined : strictBoolean(body.disabled);
  const unlock = body.unlock === undefined ? undefined : strictBoolean(body.unlock);
  if (
    role === null ||
    (disabled === undefined && body.disabled !== undefined) ||
    (unlock === undefined && body.unlock !== undefined)
  ) {
    return c.json(bad('role must be admin|viewer; disabled and unlock must be booleans'), 400);
  }
  const update: UserUpdate = {
    ...(role !== undefined ? { role } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
    ...(unlock === true ? { unlock: true } : {}),
  };
  if (Object.keys(update).length === 0) {
    return c.json(bad('at least one of role, disabled, unlock is required'), 400);
  }

  // Guarded write: 0 rows means either no such row or the guard refused. The
  // distinction comes from a plain read afterwards — only for the status code,
  // never for the security decision.
  const changes = await updateUserGuarded(c.env.DB, id, update);
  if (changes === 0) {
    const exists = await c.env.DB.prepare('SELECT 1 AS x FROM users WHERE id = ?')
      .bind(id)
      .first<{ x: number }>();
    return exists === null
      ? c.json({ error: 'not_found' }, 404)
      : c.json({ error: 'last_admin' }, 409);
  }
  const updated = await c.env.DB.prepare('SELECT subject FROM users WHERE id = ?')
    .bind(id)
    .first<{ subject: string }>();
  await audit(c.env.DB, c.get('user').subject, 'user.update', updated?.subject ?? String(id), {
    ...update,
  });
  return c.json({ ok: true });
});

userRoutes.delete('/users/:id', requireAdmin, async (c) => {
  const id = idParam(c.req.param('id'));
  if (id === undefined) {
    return c.json({ error: 'not_found' }, 404);
  }
  // Read first only to tell 404 from 409 and to name the audit line; the guard
  // in the DELETE itself is the decision that matters.
  const target = await c.env.DB.prepare('SELECT subject, role FROM users WHERE id = ?')
    .bind(id)
    .first<{ subject: string; role: string }>();
  if (target === null) {
    return c.json({ error: 'not_found' }, 404);
  }
  const changes = await deleteUserGuarded(c.env.DB, id);
  if (changes === 0) {
    // Guard refused, row still there. Name which wall was hit: emptying the
    // table would reopen bootstrap, which is a different emergency than
    // "no admin left".
    const total = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    return c.json({ error: (total?.n ?? 0) === 1 ? 'last_user' : 'last_admin' }, 409);
  }
  await audit(c.env.DB, c.get('user').subject, 'user.delete', target.subject, {
    role: target.role,
  });
  return c.json({ ok: true });
});
