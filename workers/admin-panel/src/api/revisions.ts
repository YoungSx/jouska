/**
 * Revision history endpoints: list, diff, rollback.
 *
 * Reads are viewer-readable like every other GET; rollback is admin-only and
 * inherits the publish gates by routing through `publishDraft`, so a restored
 * snapshot is published like any other draft — as a new revision, never by
 * rewinding the counter.
 *
 * The rollback is deliberately two separate steps (restore draft, then
 * publish) with a gap that is safe in one direction only: if the publish
 * fails after the draft was restored, the draft differs from live and the
 * preview shows it as dirty — inviting exactly the republish or re-rollback
 * that repairs the state. The reverse order (publish first) would leave the
 * panel claiming "clean" while KV serves something else, which is a lie the
 * panel must never tell.
 */
import { Hono } from 'hono';
import { configSchema } from 'jouska';
import { compileConfig, type RouteRow } from '../compile.js';
import { readJsonObject } from '../body.js';
import { diffDocuments } from '../diff.js';
import { documentDigest, LIVE_KEY, asLiveState } from '../fingerprint.js';
import { publishDraft } from '../publish.js';
import { dangerFlags, type FieldRisk } from '../danger.js';
import { requireAdmin } from '../middleware.js';
import {
  getRevision,
  getSetting,
  listPublishAudit,
  listRevisions,
  restoreDraftFromSnapshot,
} from '../store.js';
import { CORRUPT, boundedInteger, MAX_NOTE_LENGTH, boundedString } from '../validate.js';
import type { AppEnv } from '../env.js';

export const revisionRoutes = new Hono<AppEnv>();

/** Snapshot availability, as the history list reports it. */
type SnapshotState = 'full' | 'none';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface HistoryEntry {
  readonly revision: number;
  readonly at: number;
  readonly actor: string;
  readonly note: string | null;
  readonly rollbackOf: number | null;
  readonly routeCount: number | null;
  readonly snapshot: SnapshotState;
  readonly live: boolean;
}

/**
 * GET /api/revisions — the publish history, newest first.
 *
 * Rows come from the `revisions` table; pre-feature publishes have no row, so
 * the audit log fills them in as `snapshot: 'none'` entries. Publishing after
 * the feature keeps writing both, and the audit side is only used for
 * revisions the table has never seen, so nothing appears twice.
 */
revisionRoutes.get('/revisions', async (c) => {
  const limit = boundedInteger(c.req.query('limit'), 50, 200);
  const offsetRaw = c.req.query('offset');
  const offset = typeof offsetRaw === 'string' && /^\d+$/.test(offsetRaw) ? Number(offsetRaw) : 0;

  const rows = await listRevisions(c.env.DB, limit, offset);
  const live = asLiveState(await getSetting(c.env.DB, LIVE_KEY));

  // Pre-feature history: audit entries carry the revision in their detail.
  // The query filters to publish-shaped actions and reads oldest first, so the
  // window covers the oldest revisions the retention window may still need —
  // `listAudit`'s newest-200 would let route edits crowd publishes out.
  const auditEntries = await listPublishAudit(c.env.DB, 200);
  const known = new Set(rows.map((r) => r.revision));
  const fromAudit: HistoryEntry[] = [];
  for (const entry of auditEntries) {
    // `detail` is stored JSON (see auditStmt); a broken row degrades to a
    // snapshot-less entry with no note, not a skipped one.
    let detail: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = entry.detail === null ? null : JSON.parse(entry.detail);
      if (isRecord(parsed)) {
        detail = parsed;
      }
    } catch {
      detail = undefined;
    }
    const revision = detail?.['revision'];
    if (typeof revision !== 'number' || known.has(revision)) {
      continue;
    }
    known.add(revision);
    fromAudit.push({
      revision,
      at: entry.at,
      actor: entry.actor,
      note: typeof detail?.['note'] === 'string' ? (detail['note'] as string) : null,
      rollbackOf:
        typeof detail?.['rollbackOf'] === 'number' ? (detail['rollbackOf'] as number) : null,
      routeCount:
        typeof detail?.['routeCount'] === 'number' ? (detail['routeCount'] as number) : null,
      snapshot: 'none',
      live: live?.revision === revision,
    });
  }

  const entries: HistoryEntry[] = [
    ...rows.map((r): HistoryEntry => ({
      revision: r.revision,
      at: r.at,
      actor: r.actor,
      note: r.note,
      rollbackOf: r.rollbackOf,
      routeCount: r.document === CORRUPT ? null : r.routeCount,
      snapshot: 'full',
      live: live?.revision === r.revision,
    })),
    ...fromAudit,
  ].toSorted((a, b) => b.revision - a.revision);

  return c.json({ entries, liveRevision: live?.revision ?? null });
});

/**
 * GET /api/revisions/diff?from=N&to=M — structured diff between two snapshots.
 *
 * Direction is free: comparing newer→older is exactly what the rollback
 * dialog needs ("what changes if I go back"), so no ordering is enforced.
 * A revision without a snapshot cannot be diffed — 409, not 500.
 */
revisionRoutes.get('/revisions/diff', async (c) => {
  // Strict digits: `Number('')` is 0 and `Number('3x')` is NaN is easy to get
  // backwards — a bare `?from` must be a 400, not a diff against revision 0.
  const from = /^\d+$/.test(c.req.query('from') ?? '') ? Number(c.req.query('from')) : NaN;
  const to = /^\d+$/.test(c.req.query('to') ?? '') ? Number(c.req.query('to')) : NaN;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
    return c.json({ error: 'invalid_input', detail: 'from and to must be revision numbers' }, 400);
  }
  const [fromRow, toRow] = await Promise.all([
    getRevision(c.env.DB, from),
    getRevision(c.env.DB, to),
  ]);
  if (fromRow === undefined || toRow === undefined) {
    return c.json(
      {
        error: 'snapshot_unavailable',
        detail: fromRow === undefined ? `revision ${from}` : `revision ${to}`,
      },
      409,
    );
  }
  if (fromRow.document === CORRUPT || toRow.document === CORRUPT) {
    return c.json(
      {
        error: 'snapshot_corrupt',
        detail: fromRow.document === CORRUPT ? `revision ${from}` : `revision ${to}`,
      },
      409,
    );
  }
  return c.json({ from, to, entries: diffDocuments(fromRow.document, toRow.document) });
});

/**
 * POST /api/revisions/rollback — publish a snapshot again, as a new revision,
 * with the draft reset to it first (the two must not drift apart: the draft is
 * the next publish's source, and leaving the broken draft in place would put
 * the accident one click away from happening again).
 *
 * Gates run in full before anything is written: the snapshot must still parse
 * under the current schema, and its dangerous switches require the same
 * explicit confirm a publish would.
 */
revisionRoutes.post('/revisions/rollback', requireAdmin, async (c) => {
  const body = await readJsonObject(c);
  const sourceRevision = body['sourceRevision'];
  if (
    typeof sourceRevision !== 'number' ||
    !Number.isInteger(sourceRevision) ||
    sourceRevision < 1
  ) {
    return c.json(
      { error: 'invalid_input', detail: 'sourceRevision must be a revision number' },
      400,
    );
  }
  const note = boundedString(body['note'], MAX_NOTE_LENGTH);

  const source = await getRevision(c.env.DB, sourceRevision);
  if (source === undefined) {
    return c.json(
      {
        error: 'snapshot_unavailable',
        detail: `revision ${sourceRevision} has no snapshot — it predates the history feature or was pruned`,
      },
      409,
    );
  }
  if (source.document === CORRUPT) {
    return c.json(
      {
        error: 'snapshot_corrupt',
        detail: `revision ${sourceRevision}'s stored JSON will not parse`,
      },
      409,
    );
  }
  const doc = source.document;
  if (!isRecord(doc)) {
    // parseColumn hands back CORRUPT for unparseable JSON; a parsed-but-not-
    // object document cannot exist in practice, and refusing is the safe read.
    return c.json(
      { error: 'snapshot_corrupt', detail: `revision ${sourceRevision} is not a JSON object` },
      409,
    );
  }

  // The snapshot was valid when it was published, but the schema may have
  // moved since. Refusing here keeps an old document from reaching KV in a
  // shape the proxy would reject — which would 503 the whole table.
  const parsed = configSchema.safeParse(doc);
  if (!parsed.success) {
    return c.json(
      {
        error: 'revision_not_compatible',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      },
      422,
    );
  }

  // Rolling back to what is already being served would write a no-op revision
  // into history. The digests are on hand, so refuse instead.
  const live = asLiveState(await getSetting(c.env.DB, LIVE_KEY));
  const sourceDigest = await documentDigest(doc);
  if (live !== undefined && live.digest === sourceDigest) {
    return c.json(
      { error: 'already_live', detail: `revision ${sourceRevision} is identical to what is live` },
      409,
    );
  }

  const routesDoc = Array.isArray(doc['routes']) ? (doc['routes'] as readonly unknown[]) : [];
  const routes: { readonly id: string; readonly definition: unknown }[] = [];
  for (const route of routesDoc) {
    if (!isRecord(route) || typeof route['id'] !== 'string') {
      continue;
    }
    // The row id is the identity; a definition that carries `id` too is the
    // snapshot's compiled shape, and the routes table stores the definition
    // without it (compile re-injects the row id).
    const { id: _rowId, ...rest } = route;
    routes.push({ id: route['id'], definition: rest });
  }

  // The snapshot must also survive today's compile, not just today's schema —
  // compile can reject what zod accepts. Running it on the in-memory routes
  // before `restoreDraftFromSnapshot` keeps the restore from deleting the
  // draft and only then finding out the publish below would fail, which would
  // strand the operator with a wiped draft.
  const snapshotRoutes: RouteRow[] = routes.map((route, index) => ({
    id: route.id,
    definition: route.definition,
    enabled: true,
    position: index,
  }));
  const compiled = compileConfig(snapshotRoutes, doc['defaults']);
  if (!compiled.ok) {
    return c.json(
      {
        error: 'revision_not_compatible',
        issues: compiled.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      },
      422,
    );
  }

  const dangers: Record<string, readonly FieldRisk[]> = {};
  for (const route of routes) {
    if (isRecord(route.definition)) {
      const flags = dangerFlags(route.definition);
      if (flags.length > 0) {
        dangers[route.id] = flags;
      }
    }
  }
  if (Object.keys(dangers).length > 0 && body['confirm'] !== true) {
    return c.json({ error: 'confirmation_required', dangers, shadowWarnings: [] }, 409);
  }

  // Draft first (one batch, so it cannot be half old and half restored), then
  // the publish pipeline — which re-validates what it reads and writes KV,
  // the revision row, live fingerprint, audit and the prune.
  await restoreDraftFromSnapshot(c.env.DB, routes, doc['defaults'], c.get('user').subject);

  const user = c.get('user');
  const result = await publishDraft(c.env, {
    actor: user.subject,
    ...(note === undefined ? {} : { note }),
    confirm: true,
    rollbackOf: sourceRevision,
    action: 'config.rollback',
  });
  if (!result.ok) {
    // Only reachable if the restored draft somehow fails to compile, e.g. a
    // schema tightening between snapshot and rollback — the parse above
    // already ruled out the normal path.
    return c.json(
      {
        error: 'revision_not_compatible',
        issues: result.reason === 'compile_failed' ? result.issues : [],
      },
      422,
    );
  }
  return c.json({
    ok: true,
    revision: result.revision,
    sourceRevision,
    routeCount: result.routeCount,
    shadowWarnings: result.shadowWarnings,
    // Rolling back to a snapshot can restore a whole-site route that never had
    // body rewriting, so the advisory travels with the rollback too.
    mirrorWarnings: result.mirrorWarnings,
  });
});
