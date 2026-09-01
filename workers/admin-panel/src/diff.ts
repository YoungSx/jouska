/**
 * Field-level diff between two published documents.
 *
 * Diff is computed here (the panel), not in the browser: both sides come from
 * D1 snapshots and the comparison must be identical for every viewer and for
 * the tests, instead of re-derived client-side from two JSON blobs.
 *
 * Semantics: objects are compared key by key (insertion order is not a
 * change — the same rule the live digest follows, via the same canonicalize);
 * arrays are compared whole, except route arrays, which match by `id` so a
 * route that moved reports as `moved` rather than as a rewrite of every later
 * element.
 */
import { canonicalize } from './fingerprint.js';

export interface DiffEntry {
  /** Dot path into the document, e.g. `routes.api-gw.upstream`. */
  readonly path: string;
  /** 'changed' = same id, different value; 'added'/'removed' are whole-route. */
  readonly kind: 'added' | 'removed' | 'changed' | 'moved';
  /** The value on the `from` side; undefined for added routes. */
  readonly from?: unknown;
  /** The value on the `to` side; undefined for removed routes. */
  readonly to?: unknown;
  /** 0-based positions for `moved` entries. */
  readonly fromPosition?: number;
  readonly toPosition?: number;
}

/**
 * Order-insensitive deep equality. Both sides go through the digest's
 * canonicalization, so `{"a":1,"b":2}` equals `{"b":2,"a":1}` — raw
 * `JSON.stringify` would flag that as a change the proxy can't observe.
 */
const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));

const routeIdOf = (route: unknown): string | undefined =>
  typeof route === 'object' &&
  route !== null &&
  !Array.isArray(route) &&
  typeof (route as Record<string, unknown>)['id'] === 'string'
    ? ((route as Record<string, unknown>)['id'] as string)
    : undefined;

/** Recursively compares two JSON values; leaf differences yield `changed`. */
const diffValue = (path: string, from: unknown, to: unknown, out: DiffEntry[]): void => {
  if (sameValue(from, to)) {
    return;
  }
  // Equality has already weeded out both-not-objects; this branch is the
  // type-shape case (object vs scalar), reported as one changed leaf.
  const fromIsObject = typeof from === 'object' && from !== null && !Array.isArray(from);
  const toIsObject = typeof to === 'object' && to !== null && !Array.isArray(to);
  if (!fromIsObject || !toIsObject) {
    out.push({ path, kind: 'changed', from, to });
    return;
  }
  const a = from as Record<string, unknown>;
  const b = to as Record<string, unknown>;
  for (const key of Object.keys(a).toSorted()) {
    if (!(key in b)) {
      out.push({ path: `${path}.${key}`, kind: 'changed', from: a[key], to: undefined });
    } else {
      diffValue(`${path}.${key}`, a[key], b[key], out);
    }
  }
  for (const key of Object.keys(b).toSorted()) {
    if (!(key in a)) {
      out.push({ path: `${path}.${key}`, kind: 'changed', from: undefined, to: b[key] });
    }
  }
};

/** Diff for the table-wide defaults block; plain recursive key comparison. */
const diffDefaults = (from: unknown, to: unknown, out: DiffEntry[]): void => {
  const f =
    typeof from === 'object' && from !== null && !Array.isArray(from)
      ? (from as Record<string, unknown>)
      : undefined;
  const tt =
    typeof to === 'object' && to !== null && !Array.isArray(to)
      ? (to as Record<string, unknown>)
      : undefined;
  if (f === undefined && tt === undefined) {
    return;
  }
  if (f === undefined || tt === undefined) {
    // Whole block appeared or disappeared; one entry is enough to say so.
    out.push({ path: 'defaults', kind: 'changed', from, to });
    return;
  }
  diffValue('defaults', f, tt, out);
};

/** Diffs the routes array by `id`, the merge key the proxy itself resolves by.
 *  (A route id may itself contain dots — `routes.foo.bar` is route `foo.bar`'s
 *  subtree, not a nested path under route `foo`; clients match on the id after
 *  the first segment, the same way the compiler keyed the document.) */
const diffRoutes = (
  fromRoutes: readonly unknown[],
  toRoutes: readonly unknown[],
  out: DiffEntry[],
): void => {
  const fromById = new Map<string, { route: unknown; position: number }>();
  fromRoutes.forEach((route, position) => {
    const id = routeIdOf(route);
    if (id !== undefined) {
      fromById.set(id, { route, position });
    }
  });
  const toById = new Map<string, { route: unknown; position: number }>();
  toRoutes.forEach((route, position) => {
    const id = routeIdOf(route);
    if (id !== undefined) {
      toById.set(id, { route, position });
    }
  });

  for (const [id, entry] of fromById) {
    const target = toById.get(id);
    if (target === undefined) {
      out.push({ path: `routes.${id}`, kind: 'removed', from: entry.route, to: undefined });
      continue;
    }
    if (sameValue(entry.route, target.route)) {
      // Same content: still interesting if the publish order changed, because
      // order is priority — first match wins.
      if (entry.position !== target.position) {
        out.push({
          path: `routes.${id}`,
          kind: 'moved',
          fromPosition: entry.position,
          toPosition: target.position,
        });
      }
      continue;
    }
    // Content changed and it may also have moved. diffValue reports the field
    // changes; the moved entry is emitted alongside so "this route was also
    // re-ordered" is never lost behind the field diff.
    diffValue(`routes.${id}`, entry.route, target.route, out);
    if (entry.position !== target.position) {
      out.push({
        path: `routes.${id}`,
        kind: 'moved',
        fromPosition: entry.position,
        toPosition: target.position,
      });
    }
  }
  for (const [id, entry] of toById) {
    if (!fromById.has(id)) {
      out.push({ path: `routes.${id}`, kind: 'added', from: undefined, to: entry.route });
    }
  }
};

/** Pulls the three comparable sections out of a document; tolerant of junk. */
const unwrap = (
  doc: unknown,
): { version: unknown; defaults: unknown; routes: readonly unknown[] } => {
  if (typeof doc !== 'object' || doc === null) {
    return { version: undefined, defaults: undefined, routes: [] };
  }
  const record = doc as Record<string, unknown>;
  return {
    version: record['version'],
    defaults: record['defaults'],
    routes: Array.isArray(record['routes']) ? (record['routes'] as readonly unknown[]) : [],
  };
};

/**
 * Field-level diff between two snapshot documents (compiled ConfigInput,
 * without `meta` — see migrations/0003_revisions.sql for why meta is absent).
 *
 * Route identity is `id`; everything else is compared structurally, with
 * object key order ignored (matching the digest's canonicalization rule) and
 * array order treated as content.
 */
export const diffDocuments = (from: unknown, to: unknown): readonly DiffEntry[] => {
  const out: DiffEntry[] = [];
  if (sameValue(from, to)) {
    return out;
  }
  const a = unwrap(from);
  const b = unwrap(to);
  if (a.version !== b.version) {
    out.push({ path: 'version', kind: 'changed', from: a.version, to: b.version });
  }
  if (a.routes.length === 0 && b.routes.length === 0) {
    diffDefaults(a.defaults, b.defaults, out);
    return out;
  }
  diffRoutes(a.routes, b.routes, out);
  diffDefaults(a.defaults, b.defaults, out);
  return out;
};
