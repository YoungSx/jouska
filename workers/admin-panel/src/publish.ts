/**
 * The publish pipeline, shared by `POST /api/publish` and rollback.
 *
 * Publish is the only write to KV, and it is guarded three times: the document
 * must compile and validate (`configSchema`), dangerous switches require an
 * explicit `confirm`, and everything lands in the audit log. One publish is
 * exactly one KV write — the free tier's daily write allowance is not to be
 * sprayed. Rollback reaches the same function so it inherits every gate: a
 * restored snapshot is published like any other draft, as a new revision.
 */
import { compileConfig, type CompileIssue, type RouteRow } from './compile.js';
import { dangerFlags, type FieldRisk } from './danger.js';
import { documentDigest, LIVE_KEY } from './fingerprint.js';
import {
  auditStmt,
  getSetting,
  listEnabledRoutes,
  maxRevision,
  pruneRevisionsStmt,
  revisionStmt,
  settingStmt,
} from './store.js';
import type { ShadowWarning } from './shadow.js';

/**
 * How many revisions keep their snapshot. Old entries are pruned inside the
 * publish transaction, so history never advertises a snapshot the database has
 * already dropped. 50 publishes is months of operator activity; keeping more
 * would grow the D1 spend for documents nobody diffs.
 */
export const KEEP_REVISIONS = 50;

/** The KV key the reverse proxy reads via fromKV(..., CONFIG_KEY ?? 'routes'). */
const KV_KEY = 'routes';

export type PublishOutcome =
  | {
      readonly ok: true;
      readonly revision: number;
      readonly shadowWarnings: readonly ShadowWarning[];
      readonly dangers: Record<string, readonly FieldRisk[]>;
      readonly routeCount: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'compile_failed';
      readonly issues: readonly CompileIssue[];
      readonly empty?: true;
    }
  | {
      readonly ok: false;
      readonly reason: 'confirmation_required';
      readonly dangers: Record<string, readonly FieldRisk[]>;
      readonly shadowWarnings: readonly ShadowWarning[];
    };

interface PublishEnv {
  readonly DB: D1Database;
  readonly CONFIG_KV: KVNamespace;
}

const dangersOf = (rows: readonly RouteRow[]): Record<string, readonly FieldRisk[]> => {
  const dangers: Record<string, readonly FieldRisk[]> = {};
  for (const row of rows) {
    if (typeof row.definition === 'object' && row.definition !== null) {
      const flags = dangerFlags(row.definition as Record<string, unknown>);
      if (flags.length > 0) {
        dangers[row.id] = flags;
      }
    }
  }
  return dangers;
};

/**
 * Compiles the current draft, gates it, and ships it.
 *
 * `action` distinguishes a plain publish (`config.publish`) from a rollback
 * (`config.rollback`) in the audit log; `rollbackOf` records the source
 * revision on the snapshot row so the history can show the provenance.
 *
 * Ordering is deliberate: KV first, then one D1 batch (revision counter, live
 * fingerprint, snapshot row, audit, prune). A crash between the two leaves the
 * proxy already serving the new document while the panel still shows the old
 * revision — self-healing, because the next publish reads the counter from D1
 * and the duplicate revision number would be rejected by the primary key.
 */
export const publishDraft = async (
  env: PublishEnv,
  args: {
    readonly actor: string;
    readonly note?: string;
    readonly confirm?: boolean;
    readonly rollbackOf?: number;
    readonly action: 'config.publish' | 'config.rollback';
  },
): Promise<PublishOutcome> => {
  const rows: RouteRow[] = await listEnabledRoutes(env.DB);
  const defaults = await getSetting(env.DB, 'defaults');
  const compiled = compileConfig(rows, defaults);
  if (!compiled.ok) {
    return {
      ok: false,
      reason: 'compile_failed',
      issues: compiled.issues,
      ...(compiled.empty === true ? { empty: true } : {}),
    };
  }

  const dangers = dangersOf(rows);
  if (Object.keys(dangers).length > 0 && args.confirm !== true) {
    return {
      ok: false,
      reason: 'confirmation_required',
      dangers,
      shadowWarnings: compiled.shadowWarnings,
    };
  }

  // The counter normally lives in `settings`, but the snapshot table is the
  // ground truth it must never fall behind: if the setting was lost or
  // corrupted while revisions has rows, trusting the setting alone would
  // replay revision numbers — each attempt burning a KV write and then dying
  // on the snapshot row's primary key, a publish-killing loop until someone
  // noticed. Taking the max makes the counter self-healing. Both reads happen
  // before the write and the panel is single-operator, so no atomic increment
  // is needed beyond that.
  const stored = await getSetting(env.DB, 'revision');
  const counted =
    typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : 0;
  const previous = Math.max(counted, await maxRevision(env.DB));
  const revision = previous + 1;
  const meta = {
    updatedAt: new Date().toISOString(),
    updatedBy: args.actor,
    revision,
    ...(args.note === undefined ? {} : { note: args.note }),
  };
  const document = { ...compiled.document, meta };
  const digest = await documentDigest(compiled.document);

  // The one and only KV write in this worker.
  await env.CONFIG_KV.put(KV_KEY, JSON.stringify(document));

  const auditDetail = {
    revision,
    routeCount: rows.length,
    shadowWarnings: compiled.shadowWarnings,
    dangers,
    ...(args.rollbackOf === undefined ? {} : { rollbackOf: args.rollbackOf }),
    ...(args.note === undefined ? {} : { note: args.note }),
  };
  const statements = [
    settingStmt(env.DB, 'revision', revision),
    settingStmt(env.DB, LIVE_KEY, { revision, digest }),
    revisionStmt(env.DB, {
      revision,
      document: compiled.document,
      actor: args.actor,
      note: args.note,
      rollbackOf: args.rollbackOf,
      routeCount: rows.length,
    }),
    auditStmt(env.DB, args.actor, args.action, KV_KEY, auditDetail),
  ];
  const prune = pruneRevisionsStmt(env.DB, revision, KEEP_REVISIONS);
  if (prune !== undefined) {
    statements.push(prune);
  }
  await env.DB.batch(statements);

  return {
    ok: true,
    revision,
    shadowWarnings: compiled.shadowWarnings,
    dangers,
    routeCount: rows.length,
  };
};

export { KV_KEY };
