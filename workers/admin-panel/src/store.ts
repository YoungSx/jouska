/**
 * D1 access for the admin panel: settings, routes, audit.
 *
 * Kept as plain functions over D1PreparedStatement rather than an ORM — the
 * queries are few and the SQL is the documentation.
 */
import type { RouteRow } from './compile.js';
import { CORRUPT, parseJsonSafe } from './validate.js';
import type { McpScope } from './mcp-token.js';

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
  await settingStmt(db, key, value).run();
};

/** Statement form of `putSetting`, for composing into a `db.batch` transaction. */
export const settingStmt = (db: D1Database, key: string, value: unknown): D1PreparedStatement =>
  db
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    )
    .bind(key, JSON.stringify(value));

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
  await auditStmt(db, actor, action, target, detail).run();
};

/** Statement form of `audit`, for composing into a `db.batch` transaction. */
export const auditStmt = (
  db: D1Database,
  actor: string,
  action: string,
  target: string | undefined,
  detail: unknown,
): D1PreparedStatement =>
  db
    .prepare('INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(
      nowSeconds(),
      actor,
      action,
      // D1 rejects `undefined` outright (the vitest D1 shim does not, so only
      // a real workerd run catches this); NULL is what the column wants.
      target === undefined ? null : target,
      detail === undefined ? null : JSON.stringify(detail),
    );

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

/**
 * Publish-shaped audit entries only (config.publish / config.rollback), oldest
 * first. The history list backfills pre-feature revisions from these; unlike
 * `listAudit` the filter runs in SQL, so a long-lived log's route edits cannot
 * crowd the publish entries out of the result.
 */
export const listPublishAudit = async (db: D1Database, limit: number): Promise<AuditEntry[]> => {
  const { results } = await db
    .prepare(
      "SELECT id, at, actor, action, target, detail FROM audit_log WHERE action IN ('config.publish', 'config.rollback') ORDER BY id ASC LIMIT ?",
    )
    .bind(limit)
    .all<AuditEntry>();
  return results;
};

/* ---------- users (account management) ----------
 *
 * The last-admin invariant lives *inside* the write statement, not in a
 * check-then-act pair around it: the guard subqueries are evaluated against
 * the table as it stands at write time, so two concurrent requests cannot
 * both pass a read-side check and jointly brick the panel. (First-run
 * provisioning only opens on an empty table and there is no password path left
 * to climb back in through, so a table with no usable admin has no way back.)
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
}

/**
 * The user list for the admin screen.
 *
 * Column list, never `SELECT *`: what this table holds is the panel's
 * authorization state, and a forgotten `*` is how a column added later leaks
 * into a 200 response nobody re-reviewed.
 */
export const listUsers = async (db: D1Database): Promise<UserListEntry[]> => {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.subject, u.email, u.role, u.disabled, u.created_at, u.last_seen
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
    }>();
  return results.map((r) => ({
    id: r.id,
    subject: r.subject,
    email: r.email,
    role: r.role === 'viewer' ? 'viewer' : 'admin',
    disabled: r.disabled === 1,
    createdAt: r.created_at,
    lastSeen: r.last_seen,
  }));
};

/**
 * Creates a user. Returns the new id, or undefined when the subject's unique
 * index rejected the insert.
 */
export const insertUser = async (
  db: D1Database,
  args: {
    readonly subject: string;
    readonly email: string | undefined;
    readonly role: 'admin' | 'viewer';
  },
): Promise<number | undefined> => {
  try {
    const res = await db
      .prepare('INSERT INTO users (subject, email, role, created_at) VALUES (?, ?, ?, ?)')
      .bind(args.subject, args.email ?? null, args.role, nowSeconds())
      .run();
    return res.meta.last_row_id;
  } catch {
    // The unique index on subject is the only realistic rejection here.
    return undefined;
  }
};

/** A user row as the auth path needs it: identity, role, and the off switch. */
export interface UserRecord {
  readonly id: number;
  readonly subject: string;
  readonly role: 'admin' | 'viewer';
  readonly disabled: boolean;
}

/** An unrecognised role is read as the powerless one, never as admin. */
const asRole = (value: unknown): 'admin' | 'viewer' => (value === 'admin' ? 'admin' : 'viewer');

/**
 * Looks a user up by their stable external identity.
 *
 * Returns the row even when it is disabled — the caller decides between "not
 * yours" and "switched off", and can audit the attempt either way. Flattening
 * the two here would cost the middleware the only signal it has for saying
 * which one happened.
 */
export const findUserBySubject = async (
  db: D1Database,
  subject: string,
): Promise<UserRecord | undefined> => {
  const row = await db
    .prepare('SELECT id, subject, role, disabled FROM users WHERE subject = ?')
    .bind(subject)
    .first<{ id: number; subject: string; role: string; disabled: number }>();
  return row === null
    ? undefined
    : { id: row.id, subject: row.subject, role: asRole(row.role), disabled: row.disabled !== 0 };
};

/**
 * First-run provisioning for a caller Cloudflare Access already vouched for.
 *
 * This is now the only way the first account comes into being — there is no
 * `/auth/bootstrap` form behind it — and it is closed the same way that form
 * was: the guard is inside the statement, so the INSERT only fires while
 * `users` is empty and two concurrent first requests cannot both mint an admin.
 * The unique index on `subject` closes what is left.
 *
 * Deliberately only the *first* caller. Access policies are frequently written
 * wider than the panel's intent — a whole email domain, a whole Cloudflare
 * account — so auto-creating a row for everyone who passes the door would hand
 * the route table to a group the operator never enumerated. Everybody after the
 * first is added on purpose, through the users screen.
 */
export const provisionFirstAdmin = async (
  db: D1Database,
  args: { readonly subject: string; readonly email?: string },
): Promise<UserRecord | undefined> => {
  try {
    await db
      .prepare(
        `INSERT INTO users (subject, email, role, created_at)
         SELECT ?, ?, 'admin', ?
         WHERE NOT EXISTS (SELECT 1 FROM users)`,
      )
      .bind(args.subject, args.email ?? null, nowSeconds())
      .run();
  } catch {
    // Lost the race: the unique index means the table is no longer empty.
    return undefined;
  }
  return await findUserBySubject(db, args.subject);
};

/**
 * Records that the caller was seen, at most once an hour.
 *
 * The freshness test is part of the UPDATE rather than a read followed by a
 * write: one statement, no race, and — the reason it matters here — one D1
 * write per hour per user instead of one per request. Publishes are supposed to
 * be this Worker's expensive writes; a liveness timestamp is not.
 */
export const touchLastSeen = async (db: D1Database, id: number): Promise<void> => {
  const now = nowSeconds();
  await db
    .prepare('UPDATE users SET last_seen = ? WHERE id = ? AND (last_seen IS NULL OR last_seen < ?)')
    .bind(now, id, now - 3600)
    .run();
};

export interface UserUpdate {
  readonly role?: 'admin' | 'viewer';
  readonly disabled?: boolean;
}

/**
 * Partial update of one user, guarded when the change could shrink the admin
 * pool. Returns the number of rows written: 0 means the guard refused.
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

/* ---------- Revisions: the snapshot of every publish. ---------- */

export interface RevisionRow {
  readonly revision: number;
  /** Compiled document exactly as published, minus `meta` (regenerated per publish). */
  readonly document: unknown;
  readonly actor: string;
  readonly at: number;
  readonly note: string | null;
  /** Set when this revision was produced by a rollback to another revision. */
  readonly rollbackOf: number | null;
  readonly routeCount: number;
}

/** Newest first. Ordering is by revision, which is the publish sequence. */
export const listRevisions = async (db: D1Database, limit: number, offset: number) => {
  const { results } = await db
    .prepare(
      'SELECT revision, document, actor, at, note, rollback_of, route_count FROM revisions ORDER BY revision DESC LIMIT ? OFFSET ?',
    )
    .bind(limit, offset)
    .all<{
      revision: number;
      document: string;
      actor: string;
      at: number;
      note: string | null;
      rollback_of: number | null;
      route_count: number;
    }>();
  return results.map((r): RevisionRow => ({
    revision: r.revision,
    document: parseColumn(r.document),
    actor: r.actor,
    at: r.at,
    note: r.note,
    rollbackOf: r.rollback_of,
    routeCount: r.route_count,
  }));
};

/**
 * Highest revision recorded in the snapshot table, 0 when empty.
 *
 * The publish counter normally lives in `settings`, but this is the ground
 * truth it must never fall behind — publish takes the max of the two so a
 * lost or corrupted counter cannot replay revision numbers.
 */
export const maxRevision = async (db: D1Database): Promise<number> => {
  const row = await db.prepare('SELECT MAX(revision) AS max FROM revisions').first<{
    max: number | null;
  }>();
  return row?.max ?? 0;
};

export const getRevision = async (
  db: D1Database,
  revision: number,
): Promise<RevisionRow | undefined> => {
  const row = await db
    .prepare(
      'SELECT revision, document, actor, at, note, rollback_of, route_count FROM revisions WHERE revision = ?',
    )
    .bind(revision)
    .first<{
      revision: number;
      document: string;
      actor: string;
      at: number;
      note: string | null;
      rollback_of: number | null;
      route_count: number;
    }>();
  if (row === null) {
    return undefined;
  }
  return {
    revision: row.revision,
    document: parseColumn(row.document),
    actor: row.actor,
    at: row.at,
    note: row.note,
    rollbackOf: row.rollback_of,
    routeCount: row.route_count,
  };
};

export const insertRevision = async (
  db: D1Database,
  args: {
    readonly revision: number;
    readonly document: unknown;
    readonly actor: string;
    readonly note: string | undefined;
    readonly rollbackOf: number | undefined;
    readonly routeCount: number;
  },
): Promise<void> => {
  await revisionStmt(db, args).run();
};

/** Statement form of `insertRevision`, for composing into a `db.batch` transaction. */
export const revisionStmt = (
  db: D1Database,
  args: {
    readonly revision: number;
    readonly document: unknown;
    readonly actor: string;
    readonly note: string | undefined;
    readonly rollbackOf: number | undefined;
    readonly routeCount: number;
  },
): D1PreparedStatement =>
  db
    .prepare(
      'INSERT INTO revisions (revision, document, actor, at, note, rollback_of, route_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      args.revision,
      JSON.stringify(args.document),
      args.actor,
      nowSeconds(),
      args.note ?? null,
      args.rollbackOf ?? null,
      args.routeCount,
    );

/**
 * Statement that drops everything older than `keep` revisions, or undefined
 * when there is nothing to prune.
 *
 * Composed into the publish batch, so history and live state agree on what
 * exists. Called with the freshly written revision; the newest `keep` rows
 * survive.
 */
export const pruneRevisionsStmt = (
  db: D1Database,
  latest: number,
  keep: number,
): D1PreparedStatement | undefined =>
  latest <= keep
    ? undefined
    : db.prepare('DELETE FROM revisions WHERE revision <= ?').bind(latest - keep);

/**
 * Replaces the whole draft with a snapshot's content: one batch, so there is
 * no window where the draft is half old and half restored (the position index
 * would reject that anyway, mid-transaction as it may be).
 *
 * Every restored route is enabled and repositioned from zero — the snapshot
 * holds only the routes that were live, and publish order is priority. The
 * operator performing the rollback becomes the last editor of every row, which
 * is what the audit trail should show.
 */
export const restoreDraftFromSnapshot = async (
  db: D1Database,
  routes: readonly { readonly id: string; readonly definition: unknown }[],
  defaults: unknown,
  actor: string,
): Promise<void> => {
  const now = nowSeconds();
  const insert = db.prepare(
    'INSERT INTO routes (id, definition, enabled, position, updated_at, updated_by) VALUES (?, ?, 1, ?, ?, ?)',
  );
  // Snapshots only contain enabled routes (compile output), so a blind
  // DELETE+INSERT would permanently destroy disabled rows — templates the
  // operator parked on purpose. Instead: upsert the snapshot routes at the
  // front and park every route the snapshot does not mention as disabled,
  // preserving its definition for the next re-enable.
  const snapshotIds = routes.map((route) => route.id);
  const statements: D1PreparedStatement[] = [];
  let placeholders = '';
  const params: (string | number)[] = [];
  for (const [i, id] of snapshotIds.entries()) {
    placeholders += i === 0 ? '?' : ', ?';
    params.push(id);
  }
  if (placeholders !== '') {
    statements.push(db.prepare(`DELETE FROM routes WHERE id IN (${placeholders})`).bind(...params));
  }
  statements.push(
    ...routes.map((route, position) =>
      insert.bind(route.id, JSON.stringify(route.definition), position, now, actor),
    ),
    // An empty snapshot disables everything; `NOT IN ()` is not valid SQL, so
    // the two shapes need separate statements.
    placeholders === ''
      ? db
          .prepare('UPDATE routes SET enabled = 0, position = ?, updated_at = ?, updated_by = ?')
          .bind(0, now, actor)
      : db
          .prepare(
            `UPDATE routes SET enabled = 0, position = ?, updated_at = ?, updated_by = ? WHERE id NOT IN (${placeholders})`,
          )
          .bind(snapshotIds.length, now, actor, ...params),
    // Absent defaults are stored as null: getSetting then reads null, which
    // compile treats as "no table-wide defaults", matching the snapshot.
    settingStmt(db, 'defaults', defaults ?? null),
  );
  await db.batch(statements);
};
export interface McpTokenListEntry {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly ownerUserId: number;
  readonly issuedByUserId: number;
  readonly scopes: readonly McpScope[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly revokeReason: string | null;
  readonly lastUsedAt: number | null;
}

export interface McpTokenAuth {
  readonly id: string;
  readonly subject: string;
  readonly userId: number;
  readonly scopes: readonly McpScope[];
  readonly tokenPrefix: string;
}

const parseScopesColumn = (raw: string): McpScope[] => {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is McpScope =>
        entry === 'config:read' ||
        entry === 'config:write' ||
        entry === 'domains:read' ||
        entry === 'audit:read',
    );
  } catch {
    return [];
  }
};

export const listMcpTokens = async (db: D1Database): Promise<McpTokenListEntry[]> => {
  const { results } = await db
    .prepare(
      `SELECT id, name, token_prefix, owner_user_id, issued_by_user_id, scopes,
              created_at, expires_at, revoked_at, revoke_reason, last_used_at
       FROM mcp_tokens ORDER BY created_at DESC, id DESC`,
    )
    .all<{
      id: string;
      name: string;
      token_prefix: string;
      owner_user_id: number;
      issued_by_user_id: number;
      scopes: string;
      created_at: number;
      expires_at: number;
      revoked_at: number | null;
      revoke_reason: string | null;
      last_used_at: number | null;
    }>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    ownerUserId: row.owner_user_id,
    issuedByUserId: row.issued_by_user_id,
    scopes: parseScopesColumn(row.scopes),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    lastUsedAt: row.last_used_at,
  }));
};

export const insertMcpToken = async (
  db: D1Database,
  token: {
    readonly id: string;
    readonly hash: string;
    readonly prefix: string;
    readonly name: string;
    readonly ownerUserId: number;
    readonly issuedByUserId: number;
    readonly scopes: readonly McpScope[];
    readonly createdAt: number;
    readonly expiresAt: number;
  },
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO mcp_tokens
       (id, token_hash, token_prefix, name, owner_user_id, issued_by_user_id, scopes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      token.id,
      token.hash,
      token.prefix,
      token.name,
      token.ownerUserId,
      token.issuedByUserId,
      JSON.stringify(token.scopes),
      token.createdAt,
      token.expiresAt,
    )
    .run();
};

export const revokeMcpToken = async (
  db: D1Database,
  id: string,
  revokedByUserId: number,
  at: number,
  reason: string | null,
): Promise<boolean> => {
  const result = await db
    .prepare(
      `UPDATE mcp_tokens SET revoked_at = ?, revoked_by_user_id = ?, revoke_reason = ?
       WHERE id = ? AND revoked_at IS NULL`,
    )
    .bind(at, revokedByUserId, reason, id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
};

export const resolveMcpToken = async (
  db: D1Database,
  hash: string,
  now: number,
): Promise<McpTokenAuth | undefined> => {
  const row = await db
    .prepare(
      `SELECT t.id, t.token_prefix, t.scopes, u.id AS user_id, u.subject
       FROM mcp_tokens t JOIN users u ON u.id = t.owner_user_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ? AND u.disabled = 0`,
    )
    .bind(hash, now)
    .first<{
      id: string;
      token_prefix: string;
      scopes: string;
      user_id: number;
      subject: string;
    }>();
  if (row === null) return undefined;
  const scopes = parseScopesColumn(row.scopes);
  if (scopes.length === 0) return undefined;
  return {
    id: row.id,
    tokenPrefix: row.token_prefix,
    scopes,
    userId: row.user_id,
    subject: row.subject,
  };
};

export const touchMcpToken = async (db: D1Database, id: string, at: number): Promise<void> => {
  await db
    .prepare(
      `UPDATE mcp_tokens SET last_used_at = ?
       WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
    )
    .bind(at, id, at - 15 * 60)
    .run();
};
