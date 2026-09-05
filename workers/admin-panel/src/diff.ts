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
 *
 * Every entry that belongs to a route or to `defaults` is stamped with its
 * owner (`routeId`), its in-definition `field`, and — when the `to` state trips
 * a rule — the `dangerFlags` classification. The panel's danger vocabulary is
 * therefore delivered with the diff instead of re-derived from path strings in
 * the browser: one classifier, one answer, and it is the classifier the publish
 * gate already runs.
 */
import { dangerFlags, type FieldRisk } from './danger.js';
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
  /**
   * Owning route id, resolved here rather than parsed from `path`: a route id
   * may contain dots, so `routes.foo.bar` is ambiguous to every reader except
   * the one holding the id list. Absent for `defaults` and `version`.
   */
  readonly routeId?: string;
  /**
   * Path inside the route definition (or inside `defaults`) — the same shape
   * `dangerFlags` classifies. Absent for whole-route and top-level entries.
   */
  readonly field?: string;
  /**
   * Danger classification of the `to` state, from the same `dangerFlags` the
   * publish gate runs. Sent with the diff so the history view never has to
   * re-derive "is this field dangerous" — one classifier, one answer.
   *
   * The rule's own shape decides what that answer means: presence rules
   * (`allowPrivateUpstream`) flag a field the publish touched at all, guarded
   * rules (`mirror.includeBody`) only flag the state that qualifies. Both are
   * what the publish dialog would have said about the same document.
   */
  readonly risk?: FieldRisk;
  /** For an added route: how many dangerous switches the new definition carries. */
  readonly riskCount?: number;
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

/**
 * Danger rules that fire on one side's definition, keyed by field path.
 *
 * `cors.origins (absent)` is reported by `dangerFlags` under a path that names
 * its own absence; the diff keys by the field the operator sees, so the suffix
 * is stripped here and nowhere else.
 */
const riskIndex = (definition: unknown): ReadonlyMap<string, FieldRisk> => {
  const index = new Map<string, FieldRisk>();
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    return index;
  }
  for (const risk of dangerFlags(definition as Record<string, unknown>)) {
    index.set(risk.path.replace(' (absent)', ''), risk);
  }
  return index;
};

/** The risk a field inherits: itself, or the closest ancestor a rule names. */
const riskFor = (index: ReadonlyMap<string, FieldRisk>, field: string): FieldRisk | undefined => {
  let probe = field;
  for (;;) {
    const hit = index.get(probe);
    if (hit !== undefined) {
      return hit;
    }
    const cut = probe.lastIndexOf('.');
    if (cut < 0) {
      return undefined;
    }
    probe = probe.slice(0, cut);
  }
};

/**
 * Stamps ownership and risk onto entries a generic walker produced.
 *
 * `prefix` is the path the walker was seeded with, so `field` is what remains
 * after it — never a re-parse of the id, which may itself contain dots.
 */
const attribute = (
  entries: readonly DiffEntry[],
  prefix: string,
  index: ReadonlyMap<string, FieldRisk>,
  routeId?: string,
): DiffEntry[] =>
  entries.map((entry) => {
    const field = entry.path.startsWith(`${prefix}.`)
      ? entry.path.slice(prefix.length + 1)
      : undefined;
    const risk = field === undefined ? undefined : riskFor(index, field);
    return {
      ...entry,
      ...(routeId === undefined ? {} : { routeId }),
      ...(field === undefined ? {} : { field }),
      ...(risk === undefined ? {} : { risk }),
    };
  });

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

/** Diff for the table-wide defaults block; plain recursive key comparison.
 *  Defaults are definition-shaped and fill per-field gaps, so a dangerous
 *  switch is exactly as dangerous here as inside a route — same classifier. */
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
  const local: DiffEntry[] = [];
  diffValue('defaults', f, tt, local);
  out.push(...attribute(local, 'defaults', riskIndex(tt)));
};

/** Diffs the routes array by `id`, the merge key the proxy itself resolves by.
 *  Each entry carries its `routeId` and in-route `field` explicitly, because a
 *  route id may itself contain dots — `routes.foo.bar` is unparseable without
 *  the id list, and only this function holds it. */
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
      out.push({
        path: `routes.${id}`,
        kind: 'removed',
        from: entry.route,
        to: undefined,
        routeId: id,
      });
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
          routeId: id,
        });
      }
      continue;
    }
    // Content changed and it may also have moved. diffValue reports the field
    // changes; the moved entry is emitted alongside so "this route was also
    // re-ordered" is never lost behind the field diff.
    const local: DiffEntry[] = [];
    diffValue(`routes.${id}`, entry.route, target.route, local);
    out.push(...attribute(local, `routes.${id}`, riskIndex(target.route), id));
    if (entry.position !== target.position) {
      out.push({
        path: `routes.${id}`,
        kind: 'moved',
        fromPosition: entry.position,
        toPosition: target.position,
        routeId: id,
      });
    }
  }
  for (const [id, entry] of toById) {
    if (!fromById.has(id)) {
      // A whole new route: its dangerous switches are the operator's business
      // even though no single field row exists to hang them on.
      const risks = [...riskIndex(entry.route).values()];
      const worst = risks.find((risk) => risk.level === 'high') ?? risks[0];
      out.push({
        path: `routes.${id}`,
        kind: 'added',
        from: undefined,
        to: entry.route,
        routeId: id,
        ...(worst === undefined ? {} : { risk: worst, riskCount: risks.length }),
      });
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
