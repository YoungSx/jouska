/**
 * D1 access for the admin panel: settings, routes, audit.
 *
 * Kept as plain functions over D1PreparedStatement rather than an ORM — the
 * queries are few and the SQL is the documentation.
 */
import type { RouteRow } from './compile.js';
import { CORRUPT, parseJsonSafe } from './validate.js';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const parseColumn = (raw: string): unknown => {
  const parsed = parseJsonSafe(raw);
  return parsed.ok ? parsed.value : CORRUPT;
};

export const getSetting = async (db: D1Database, key: string): Promise<unknown> => {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  if (row === null) {
    return undefined;
  }
  const parsed = parseJsonSafe(row.value);
  // A corrupt setting reads as absent: settings all have working defaults, so
  // "unset" is a safe interpretation, unlike a route definition.
  return parsed.ok ? parsed.value : undefined;
};

export const putSetting = async (db: D1Database, key: string, value: unknown): Promise<void> => {
  await db
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    )
    .bind(key, JSON.stringify(value))
    .run();
};

/**
 * Sets a password and spends the recovery token in one batch.
 *
 * `db.batch` is a single transaction, which is the point: deleting the token in
 * a second round-trip would leave a window where two concurrent requests both
 * see a live token and both set a password. The DELETE is conditional on the
 * value still being the one that was checked, so the loser of a race writes
 * nothing and its own delete affects zero rows.
 *
 * Sessions of the target account go too — a recovery whose old cookies keep
 * working has not recovered anything.
 */
export const consumeRecoveryAndSetPassword = async (
  db: D1Database,
  args: {
    readonly recoveryKey: string;
    readonly expectedValue: string;
    readonly userId: number;
    readonly passwordHash: string;
  },
): Promise<boolean> => {
  const [deleted] = await db.batch([
    db
      .prepare('DELETE FROM settings WHERE key = ? AND value = ?')
      .bind(args.recoveryKey, args.expectedValue),
    db
      .prepare(
        'UPDATE users SET password = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?',
      )
      .bind(args.passwordHash, args.userId),
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(args.userId),
  ]);
  // meta.changes === 0 means another request spent the same token first.
  return (deleted?.meta.changes ?? 0) > 0;
};

/** Raw stored text for a setting, for callers that must compare it verbatim. */
export const getSettingRaw = async (db: D1Database, key: string): Promise<string | undefined> => {
  const row = await db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row === null ? undefined : row.value;
};

/** Enabled routes in publish order. */
export const listEnabledRoutes = async (db: D1Database): Promise<RouteRow[]> => {
  const { results } = await db
    .prepare(
      'SELECT id, definition, enabled, position FROM routes WHERE enabled = 1 ORDER BY position',
    )
    .all<{ id: string; definition: string; enabled: number; position: number }>();
  return results.map((r) => ({
    id: r.id,
    definition: parseColumn(r.definition),
    enabled: r.enabled === 1,
    position: r.position,
  }));
};

export interface RouteListEntry {
  readonly id: string;
  readonly definition: unknown;
  readonly enabled: boolean;
  readonly position: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

export const listAllRoutes = async (db: D1Database): Promise<RouteListEntry[]> => {
  const { results } = await db
    .prepare(
      'SELECT id, definition, enabled, position, updated_at, updated_by FROM routes ORDER BY position',
    )
    .all<{
      id: string;
      definition: string;
      enabled: number;
      position: number;
      updated_at: number;
      updated_by: string;
    }>();
  return results.map((r) => ({
    id: r.id,
    definition: parseColumn(r.definition),
    enabled: r.enabled === 1,
    position: r.position,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  }));
};

export const getRoute = async (db: D1Database, id: string): Promise<RouteListEntry | undefined> => {
  const row = await db
    .prepare(
      'SELECT id, definition, enabled, position, updated_at, updated_by FROM routes WHERE id = ?',
    )
    .bind(id)
    .first<{
      id: string;
      definition: string;
      enabled: number;
      position: number;
      updated_at: number;
      updated_by: string;
    }>();
  if (row === null) {
    return undefined;
  }
  return {
    id: row.id,
    definition: parseColumn(row.definition),
    enabled: row.enabled === 1,
    position: row.position,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
};

export const upsertRoute = async (
  db: D1Database,
  id: string,
  definition: unknown,
  enabled: boolean,
  position: number,
  actor: string,
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO routes (id, definition, enabled, position, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         definition = excluded.definition, enabled = excluded.enabled,
         position = excluded.position, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
    .bind(id, JSON.stringify(definition), enabled ? 1 : 0, position, nowSeconds(), actor)
    .run();
};

export const deleteRoute = async (db: D1Database, id: string): Promise<void> => {
  await db.prepare('DELETE FROM routes WHERE id = ?').bind(id).run();
};

/** Assigns 0..n-1 positions in the given order; used by the reorder endpoint. */
export const reorderRoutes = async (
  db: D1Database,
  ids: readonly string[],
  actor: string,
): Promise<void> => {
  const stmt = db.prepare(
    'UPDATE routes SET position = ?, updated_at = ?, updated_by = ? WHERE id = ?',
  );
  const now = nowSeconds();
  const updates = ids.map((id, index) => stmt.bind(index, now, actor, id));
  await db.batch(updates);
};

export const audit = async (
  db: D1Database,
  actor: string,
  action: string,
  target: string | undefined,
  detail: unknown,
): Promise<void> => {
  await db
    .prepare('INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(nowSeconds(), actor, action, target, detail === undefined ? null : JSON.stringify(detail))
    .run();
};

export interface AuditEntry {
  readonly id: number;
  readonly at: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  readonly detail: string | null;
}

export const listAudit = async (db: D1Database, limit: number): Promise<AuditEntry[]> => {
  const { results } = await db
    .prepare('SELECT id, at, actor, action, target, detail FROM audit_log ORDER BY id DESC LIMIT ?')
    .bind(limit)
    .all<AuditEntry>();
  return results;
};

/* ---------- users (account management) ----------
 *
 * The last-admin invariant lives *inside* the write statement, not in a
 * check-then-act pair around it: the guard subqueries are evaluated against
 * the table as it stands at write time, so two concurrent requests cannot
 * both pass a read-side check and jointly brick the panel. (Recovery only
 * rewrites passwords and bootstrap only opens on an empty table, so a table
 * with no usable admin has no way back.)
 *
 * Two invariants, both required:
 *   - at least one admin row exists, AND
 *   - at least one enabled (disabled = 0) admin exists.
 * Checking only the enabled count lets "A enabled + B disabled, demote A"
 * through, and that state has no exit.
 */

export interface UserListEntry {
  readonly id: number;
  readonly subject: string;
  readonly email: string | null;
  readonly role: 'admin' | 'viewer';
  readonly disabled: boolean;
  readonly createdAt: number;
  readonly lastSeen: number | null;
  readonly failedAttempts: number;
  readonly lockedUntil: number | null;
  readonly sessions: number;
}

/**
 * The user list for the admin screen.
 *
 * Column list, never `SELECT *`: the `password` hash lives in this table and
 * must not be one forgotten `*` away from a 200 response.
 */
export const listUsers = async (db: D1Database): Promise<UserListEntry[]> => {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.subject, u.email, u.role, u.disabled, u.created_at, u.last_seen,
              u.failed_attempts, u.locked_until,
              (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions
       FROM users u
       ORDER BY u.id`,
    )
    .all<{
      id: number;
      subject: string;
      email: string | null;
      role: string;
      disabled: number;
      created_at: number;
      last_seen: number | null;
      failed_attempts: number;
      locked_until: number | null;
      sessions: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    subject: r.subject,
    email: r.email,
    role: r.role === 'viewer' ? 'viewer' : 'admin',
    disabled: r.disabled === 1,
    createdAt: r.created_at,
    lastSeen: r.last_seen,
    failedAttempts: r.failed_attempts,
    lockedUntil: r.locked_until,
    sessions: r.sessions,
  }));
};

/**
 * Creates a user with an admin-set password. Returns the new id, or undefined
 * when the subject's unique index rejected the insert.
 */
export const insertUser = async (
  db: D1Database,
  args: {
    readonly subject: string;
    readonly email: string | undefined;
    readonly role: 'admin' | 'viewer';
    readonly passwordHash: string;
  },
): Promise<number | undefined> => {
  try {
    const res = await db
      .prepare(
        'INSERT INTO users (subject, email, role, password, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(args.subject, args.email ?? null, args.role, args.passwordHash, nowSeconds())
      .run();
    return res.meta.last_row_id;
  } catch {
    // The unique index on subject is the only realistic rejection here.
    return undefined;
  }
};

export interface UserUpdate {
  readonly role?: 'admin' | 'viewer';
  readonly disabled?: boolean;
  /** Clears the login lockout: locked_until and the failure counter together. */
  readonly unlock?: boolean;
}

/**
 * Partial update of one user, guarded when the change could shrink the admin
 * pool. Returns the number of rows written: 0 means the guard refused.
 *
 * `unlock` gets its own SET clause rather than always clearing the lock — an
 * unlock bundled into an unrelated role change would silently un-lock an
 * account the operator never asked about.
 */
export const updateUserGuarded = async (
  db: D1Database,
  id: number,
  update: UserUpdate,
): Promise<number> => {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (update.role !== undefined) {
    sets.push('role = ?');
    binds.push(update.role);
  }
  if (update.disabled !== undefined) {
    sets.push('disabled = ?');
    binds.push(update.disabled ? 1 : 0);
  }
  if (update.unlock === true) {
    sets.push('locked_until = NULL, failed_attempts = 0');
  }
  // Dangerous = this request could shrink the enabled-admin pool. Decided from
  // the requested fields alone, never from a stale read of the row: the guard
  // below re-derives the row's actual state atomically at write time, so a
  // request that looks like a no-op ("disable an already-disabled user") is
  // still guarded if the row has been enabled again in between.
  const dangerous = update.role === 'viewer' || update.disabled === true;
  const guard = dangerous
    ? ` AND ( role != 'admin'
        OR ( (SELECT COUNT(*) FROM users a WHERE a.role = 'admin') > 1
             AND ( (SELECT COUNT(*) FROM users a WHERE a.role = 'admin' AND a.disabled = 0) > 1
                   OR disabled = 1 ) ) )`
    : '';
  const res = await db
    .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?${guard}`)
    .bind(...binds, id)
    .run();
  return res.meta.changes;
};

/**
 * Deletes one user, guarded on both invariants plus a floor of one row.
 *
 * The row floor is not sentiment: emptying `users` reopens bootstrap, which
 * would let anyone on the public internet create the next admin. The guard is
 * part of the DELETE itself, so re-running it after the state has changed
 * re-evaluates it — the second attempt finds the guard no longer satisfied and
 * writes nothing.
 *
 * Sessions of the deleted user go via ON DELETE CASCADE.
 */
export const deleteUserGuarded = async (db: D1Database, id: number): Promise<number> => {
  const res = await db
    .prepare(
      `DELETE FROM users
       WHERE id = ?
         AND (SELECT COUNT(*) FROM users) > 1
         AND ( role != 'admin'
               OR (disabled = 1 AND (SELECT COUNT(*) FROM users a WHERE a.role = 'admin') > 1)
               OR (SELECT COUNT(*) FROM users a WHERE a.role = 'admin' AND a.disabled = 0) > 1 )`,
    )
    .bind(id)
    .run();
  return res.meta.changes;
};

/**
 * Sets the caller's own new password and revokes every other session in one
 * transaction. The current session (identified by its token hash) is kept, so
 * the request that changed the password does not log itself out.
 *
 * The UPDATE is unconditional on purpose — the caller has already verified the
 * current password — so this batch cannot silently write zero rows, which is
 * why the audit row for a successful change may live outside it.
 */
export const changePasswordAndRevokeOthers = async (
  db: D1Database,
  args: {
    readonly userId: number;
    readonly passwordHash: string;
    /** SHA-256 of the current request's own session token. */
    readonly keepTokenHash: string;
  },
): Promise<number> => {
  const [, revoked] = await db.batch([
    db
      .prepare(
        'UPDATE users SET password = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?',
      )
      .bind(args.passwordHash, args.userId),
    db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
      .bind(args.userId, args.keepTokenHash),
  ]);
  return revoked?.meta.changes ?? 0;
};
