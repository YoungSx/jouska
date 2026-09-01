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
