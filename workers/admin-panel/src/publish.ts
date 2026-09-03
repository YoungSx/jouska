/**
 * The publish pipeline, shared by `POST /api/publish` and rollback.
 *
 * Publish is the only write to KV, and it is guarded four times: the document
 * must compile and validate (`configSchema`), a no-op (KV already serves the
 * exact same content) is refused before anything is spent, dangerous switches
 * require an explicit `confirm`, and everything lands in the audit log. One publish is
 * exactly one KV write — the free tier's daily write allowance is not to be
 * sprayed. Rollback reaches the same function so it inherits every gate: a
 * restored snapshot is published like any other draft, as a new revision.
 */
import type { CacheVaryWarning } from './cache-advisory.js';
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
import type { MirrorWarning } from './mirror.js';
import type { SignedLinkCacheWarning } from './signed-link-advisory.js';
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
      /** Whole-site routes that will not rewrite their links. Advisory only. */
      readonly mirrorWarnings: readonly MirrorWarning[];
      /** Caching routes that match on headers or cookies. Advisory only. */
      readonly cacheVaryWarnings: readonly CacheVaryWarning[];
      /** Caching routes whose key keeps the signed link's parameters. Advisory only. */
      readonly signedLinkCacheWarnings: readonly SignedLinkCacheWarning[];
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
      readonly mirrorWarnings: readonly MirrorWarning[];
      readonly cacheVaryWarnings: readonly CacheVaryWarning[];
      readonly signedLinkCacheWarnings: readonly SignedLinkCacheWarning[];
    }
  | {
      /** `revision` 是线上 meta 里记录的版本；KV 值没有可信 meta 时为 null。 */
      readonly ok: false;
      readonly reason: 'already_live';
      readonly revision: number | null;
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
 * Reports the revision a stored KV document is serving when its content — meta
 * excluded, since updatedAt and note change on every publish — digests the same
 * as the draft. Malformed values return undefined so the publish proceeds and
 * repairs the key instead of being blocked by garbage it is about to overwrite.
 */
const liveRevisionIfSame = async (
  served: string,
  digest: string,
): Promise<number | null | undefined> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(served);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const content = { ...(parsed as Record<string, unknown>) };
  delete content.meta;
  if ((await documentDigest(content)) !== digest) {
    return undefined;
  }
  const meta = (parsed as { meta?: unknown }).meta;
  const revision =
    typeof meta === 'object' && meta !== null
      ? (meta as { revision?: unknown }).revision
      : undefined;
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0
    ? revision
    : null;
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

  // No-op guard, before the confirm gate: a refused no-op must not demand a
  // danger confirmation first. The comparison reads KV itself rather than the
  // D1 live fingerprint on purpose — KV is the ground truth the proxy serves,
  // and publishing identical content is the recovery tool when the key was
  // wiped out of band; a D1-fingerprint block would deadlock that repair. The
  // guard fails open: an unparsable value or an eventual-consistency read that
  // still returns the previous document costs one redundant write — exactly the
  // behaviour of having no guard at all.
  const digest = await documentDigest(compiled.document);
  const served = await env.CONFIG_KV.get(KV_KEY);
  if (served !== null) {
    const live = await liveRevisionIfSame(served, digest);
    if (live !== undefined) {
      return { ok: false, reason: 'already_live', revision: live };
    }
  }

  const dangers = dangersOf(rows);
  if (Object.keys(dangers).length > 0 && args.confirm !== true) {
    return {
      ok: false,
      reason: 'confirmation_required',
      dangers,
      shadowWarnings: compiled.shadowWarnings,
      mirrorWarnings: compiled.mirrorWarnings,
      cacheVaryWarnings: compiled.cacheVaryWarnings,
      signedLinkCacheWarnings: compiled.signedLinkCacheWarnings,
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

  // The one and only KV write in this worker.
  await env.CONFIG_KV.put(KV_KEY, JSON.stringify(document));

  const auditDetail = {
    revision,
    routeCount: rows.length,
    shadowWarnings: compiled.shadowWarnings,
    mirrorWarnings: compiled.mirrorWarnings,
    cacheVaryWarnings: compiled.cacheVaryWarnings,
    signedLinkCacheWarnings: compiled.signedLinkCacheWarnings,
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
    mirrorWarnings: compiled.mirrorWarnings,
    cacheVaryWarnings: compiled.cacheVaryWarnings,
    signedLinkCacheWarnings: compiled.signedLinkCacheWarnings,
    dangers,
    routeCount: rows.length,
  };
};

export { KV_KEY };
