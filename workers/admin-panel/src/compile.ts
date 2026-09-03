import { CONFIG_VERSION, configSchema, type ConfigInput, type RouteInput } from 'jouska';
import { cacheVaryWarnings, type CacheVaryWarning } from './cache-advisory.js';
import { mirrorWarnings, type MirrorWarning } from './mirror.js';
import { signedLinkCacheWarnings, type SignedLinkCacheWarning } from './signed-link-advisory.js';
import { shadowWarnings, type ShadowWarning } from './shadow.js';
import { CORRUPT } from './validate.js';

/**
 * Compiles the admin panel's rows into a route-table document.
 *
 * The document that lands in KV is the *input* shape, not the parsed output:
 * table-wide `defaults` stay where the operator wrote them, so the stored
 * document stays small and the proxy re-applies them on load. Validation
 * against `configSchema` happens here — a document that cannot parse must
 * never reach KV, where it would silently fall back to code config.
 */

/** One row of the `routes` table, already read and JSON-parsed. */
export interface RouteRow {
  readonly id: string;
  readonly definition: unknown;
  readonly enabled: boolean;
  readonly position: number;
}

export interface CompileIssue {
  /** Row the issue belongs to; undefined for table-level issues. */
  readonly routeId: string | undefined;
  /** Zod issue path, joined — e.g. `routes.2.upstream`. */
  readonly path: string;
  readonly message: string;
}

export type CompileResult =
  | {
      readonly ok: true;
      /** Validated input document — what gets written to KV (plus `meta`). */
      readonly document: ConfigInput;
      readonly shadowWarnings: readonly ShadowWarning[];
      /**
       * Whole-site routes that will not rewrite their links. An advisory, so it
       * sits beside `shadowWarnings` rather than among `issues`: publishing one
       * is legitimate, and the operator only has to know what it means.
       */
      readonly mirrorWarnings: readonly MirrorWarning[];
      /**
       * Caching routes that match on headers or cookies, so their cache key
       * varies per value. Same advisory tier as `mirrorWarnings`: publishing
       * one is legitimate, the operator only has to know what it costs.
       */
      readonly cacheVaryWarnings: readonly CacheVaryWarning[];
      /**
       * Caching routes that verify signed links without folding the link's own
       * parameters out of the cache key. Same advisory tier as the two above:
       * the key folding is what keeps it correct, this is about hit rate.
       */
      readonly signedLinkCacheWarnings: readonly SignedLinkCacheWarning[];
      /** Parsed output, for previews: defaults folded in, stated keys resolved. */
      readonly parsed: ReturnType<typeof configSchema.parse>;
    }
  | {
      readonly ok: false;
      readonly issues: readonly CompileIssue[];
      /**
       * True when the only thing wrong is that there is nothing to publish.
       *
       * A fresh deployment has no routes, and that is not a misconfiguration —
       * it is the starting state. Callers separate the two so the UI can guide
       * ("add your first route") instead of alarming ("your config is broken"),
       * while publish still refuses either way.
       */
      readonly empty?: true;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Assembles one route definition, rejecting a conflicting `id` up front. */
const assembleRoute = (
  row: RouteRow,
): { readonly route?: RouteInput; readonly issue?: CompileIssue } => {
  if (row.definition === CORRUPT) {
    return {
      issue: {
        routeId: row.id,
        path: 'definition',
        message:
          'stored JSON will not parse — the row was written outside this panel or a migration failed; re-save the route to replace it',
      },
    };
  }
  if (!isRecord(row.definition)) {
    return { issue: { routeId: row.id, path: 'definition', message: 'must be a JSON object' } };
  }
  const declared = row.definition['id'];
  if (declared !== undefined && declared !== row.id) {
    return {
      issue: {
        routeId: row.id,
        path: 'definition.id',
        message: `declares id "${String(declared)}" but the route is stored as "${row.id}" — the row id wins, so remove the field`,
      },
    };
  }
  // Path matching is plain prefix matching: `pathMatches` does startsWith, so
  // '/*' is a literal '/*' prefix that almost nothing ever hits. The
  // match-everything path is '/'.
  const match = row.definition['match'];
  if (isRecord(match) && match['path'] === '/*') {
    return {
      issue: {
        routeId: row.id,
        path: 'definition.match.path',
        message: `"/*" is not a wildcard — paths match as plain prefixes, so "/*" only matches paths starting with "/*". Use "/" to match every path.`,
      },
    };
  }
  // `id` comes from the row: it is the merge key in resolveConfig and the
  // rate-limit bucket prefix, so a definition could not be allowed to drift.
  const { id: _ignored, ...rest } = row.definition;
  return { route: { ...(rest as RouteInput), id: row.id } };
};

const compileIssuePath = (issuePath: readonly PropertyKey[]): string =>
  issuePath.map(String).join('.');

/**
 * Maps a Zod issue onto the row it belongs to. Paths look like
 * `routes.2.upstream`; index 2 is the third *enabled* route, which is the
 * third row in the caller's ordering.
 */
const issueToCompile = (
  issue: { path: readonly PropertyKey[]; message: string },
  rows: readonly RouteRow[],
): CompileIssue => {
  if (issue.path[0] !== 'routes' || typeof issue.path[1] !== 'number') {
    return {
      routeId: undefined,
      path: compileIssuePath(issue.path),
      message: issue.message,
    };
  }
  const row = rows[issue.path[1]];
  return {
    routeId: row?.id,
    path: compileIssuePath(issue.path.slice(2)),
    message: issue.message,
  };
};

/**
 * Extracts the draft rows a snapshot document describes: `{ id, definition }`
 * pairs where the row id is the identity and a definition carrying `id` too is
 * the compiled shape — the routes table stores definitions without it, and
 * compile re-injects the row id.
 *
 * Returns `undefined` when `routes` is not an array (a corrupt or foreign
 * document); malformed entries are skipped rather than failed, matching how
 * the publish-history list degrades.
 */
export const routesFromSnapshot = (
  doc: Record<string, unknown>,
): readonly { readonly id: string; readonly definition: unknown }[] | undefined => {
  const routesDoc = doc['routes'];
  if (!Array.isArray(routesDoc)) {
    return undefined;
  }
  const routes: { readonly id: string; readonly definition: unknown }[] = [];
  for (const route of routesDoc as readonly unknown[]) {
    if (!isRecord(route) || typeof route['id'] !== 'string') {
      continue;
    }
    const { id: _rowId, ...rest } = route;
    routes.push({ id: route['id'], definition: rest });
  }
  return routes;
};

export const compileConfig = (rows: readonly RouteRow[], defaults: unknown): CompileResult => {
  const routes: RouteInput[] = [];
  const issues: CompileIssue[] = [];
  // No enabled routes: publishing would leave the proxy with nothing to
  // forward, so it is still refused — but flagged as `empty` rather than
  // dressed up as a validation failure. `configSchema` would reject this too
  // (`routes` is `.nonempty()`), with a message about array length that says
  // nothing to an operator who simply has not added a route yet.
  if (rows.length === 0) {
    return {
      ok: false,
      empty: true,
      issues: [
        {
          routeId: undefined,
          path: 'routes',
          message: 'no routes yet — add one, then publish to send it to the proxy',
        },
      ],
    };
  }
  for (const row of rows) {
    // Disabled rows are dead config: they parse fine but must not ship to the
    // proxy, where they would take live traffic.
    if (!row.enabled) {
      continue;
    }
    const assembled = assembleRoute(row);
    if (assembled.issue !== undefined) {
      issues.push(assembled.issue);
    } else if (assembled.route !== undefined) {
      routes.push(assembled.route);
    }
  }
  if (!isRecord(defaults) && defaults !== undefined && defaults !== null) {
    issues.push({
      routeId: undefined,
      path: 'defaults',
      message: 'must be a JSON object',
    });
  }

  const document: ConfigInput = {
    version: CONFIG_VERSION,
    routes,
    ...(isRecord(defaults) ? { defaults: defaults as ConfigInput['defaults'] } : {}),
  };

  const result = configSchema.safeParse(document);
  if (!result.success) {
    return {
      ok: false,
      issues: [...issues, ...result.error.issues.map((issue) => issueToCompile(issue, rows))],
    };
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    document,
    parsed: result.data,
    // Both read the parsed document, so defaults are folded in and every check
    // sees what the proxy will see.
    shadowWarnings: shadowWarnings(result.data),
    mirrorWarnings: mirrorWarnings(result.data),
    cacheVaryWarnings: cacheVaryWarnings(result.data),
    signedLinkCacheWarnings: signedLinkCacheWarnings(result.data),
  };
};
