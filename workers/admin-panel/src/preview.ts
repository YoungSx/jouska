/**
 * Dry-run of the draft: compile, validate, shadow- and mirror-check.
 *
 * One implementation, two callers — `GET /api/preview` for the panel and the
 * `preview_config` MCP tool. It used to be two: the MCP copy was written by
 * hand from the panel's and had already drifted, silently dropping
 * `mirrorWarnings`, so an agent reviewing its own draft never saw that a
 * whole-site route would ship without link rewriting.
 */
import { compileConfig, type RouteRow } from './compile.js';
import { dangerFlags, type FieldRisk } from './danger.js';
import { asLiveState, documentDigest, LIVE_KEY } from './fingerprint.js';
import type { ShadowWarning } from './shadow.js';
import { getSetting, listEnabledRoutes } from './store.js';
import { isPlainObject } from './validate.js';

export interface PreviewResult {
  readonly ok: boolean;
  readonly issues?: readonly { routeId: string | undefined; path: string; message: string }[];
  readonly shadowWarnings?: readonly ShadowWarning[];
  /**
   * Whole-site routes that will not rewrite their links. Advisory: publish is
   * never gated on it, unlike `dangers`.
   */
  readonly mirrorWarnings?: readonly { routeId: string; upstream: string }[];
  /**
   * Caching routes that match on headers or cookies, so their cache key varies
   * per value. Advisory: correctness is guaranteed by the key folding, this is
   * about hit rate.
   */
  readonly cacheVaryWarnings?: readonly { routeId: string; names: readonly string[] }[];
  /**
   * Caching routes that verify signed links without folding the link's own
   * parameters out of the cache key. Same advisory tier as `cacheVaryWarnings`:
   * the key folding guarantees correctness, this is about hit rate.
   */
  readonly signedLinkCacheWarnings?: readonly {
    routeId: string;
    param: string;
    expiresParam: string;
  }[];
  readonly dangers?: Record<string, readonly FieldRisk[]>;
  readonly document?: unknown;
  readonly routeCount?: number;
  readonly error?: string;
  /**
   * Nothing to publish yet, as opposed to something wrong. A fresh deployment
   * is `ok: false, empty: true` — the UI guides instead of alarming.
   */
  readonly empty?: true;
  /**
   * What the proxy is serving right now, and whether the draft differs from it.
   *
   * Present on every preview, including a failing one: an operator looking at a
   * broken draft still needs to know that the previous revision is live and
   * unaffected. `null` live means nothing has ever been published.
   */
  readonly live?: { readonly revision: number } | null;
  readonly dirty?: boolean;
}

export const previewDraft = async (db: D1Database): Promise<PreviewResult> => {
  const rows: RouteRow[] = await listEnabledRoutes(db);
  const defaults = await getSetting(db, 'defaults');
  const live = asLiveState(await getSetting(db, LIVE_KEY));
  const liveField = live === undefined ? null : { revision: live.revision };
  const compiled = compileConfig(rows, defaults);
  if (!compiled.ok) {
    return {
      ok: false,
      issues: compiled.issues,
      ...(compiled.empty === true ? { empty: true } : {}),
      live: liveField,
      // A draft that will not compile can never equal what is live, so it is
      // dirty by definition — unless nothing was ever published and the draft
      // is empty, which is the untouched first-run state, not a pending change.
      dirty: !(compiled.empty === true && live === undefined),
    };
  }
  const dangers: Record<string, readonly FieldRisk[]> = {};
  for (const row of rows) {
    if (isPlainObject(row.definition)) {
      const flags = dangerFlags(row.definition);
      if (flags.length > 0) {
        dangers[row.id] = flags;
      }
    }
  }
  // Digest the same document publish would write, minus `meta` — see
  // fingerprint.ts for why `meta` is excluded.
  const digest = await documentDigest(compiled.document);
  return {
    ok: true,
    document: compiled.document,
    shadowWarnings: compiled.shadowWarnings,
    mirrorWarnings: compiled.mirrorWarnings,
    cacheVaryWarnings: compiled.cacheVaryWarnings,
    signedLinkCacheWarnings: compiled.signedLinkCacheWarnings,
    dangers,
    routeCount: rows.length,
    live: liveField,
    dirty: live === undefined || live.digest !== digest,
  };
};
