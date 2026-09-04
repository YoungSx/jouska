/**
 * Input bounds shared by every endpoint.
 *
 * These are not schema validation — `configSchema` does that for route
 * *shape*. These are the limits that keep unbounded input from becoming a
 * resource problem: a 200 kB route definition is a KV document that stops
 * fitting, and a 200 kB login name is an audit row nobody can read.
 * Rejecting at the edge costs one length check.
 */

/** Longest accepted login name. Generous for an email, far below a payload. */
export const MAX_SUBJECT_LENGTH = 128;

/**
 * Longest accepted single route definition, serialized. The KV value limit is
 * 25 MiB for the whole document; a single route this large is a mistake long
 * before it is a limit.
 */
export const MAX_DEFINITION_BYTES = 64 * 1024;

/** Longest accepted table-wide defaults object, serialized. */
export const MAX_DEFAULTS_BYTES = 64 * 1024;

/** Longest accepted publish note. */
export const MAX_NOTE_LENGTH = 500;

/**
 * A non-empty, bounded, non-blank string, or undefined.
 *
 * Blank-but-present is the case worth naming: `subject: "   "` is truthy, has
 * a length, and would become an account nobody can name or audit.
 */
export const boundedString = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '' || value.length > maxLength) {
    return undefined;
  }
  return trimmed;
};

/**
 * A route id, or undefined.
 *
 * Shared by every writer — the panel API and the MCP tools — because two copies
 * of this pattern is two answers to "what is a route id", and the looser one
 * wins by accident.
 */
export const routeIdFrom = (raw: unknown): string | undefined =>
  typeof raw === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw) ? raw : undefined;

/**
 * Serialized size of a JSON value, in UTF-8 bytes, or undefined when it cannot
 * be serialized at all (a cycle, or a BigInt) — both of which are rejections.
 */
export const jsonByteLength = (value: unknown): number | undefined => {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (serialized === undefined) {
    return undefined;
  }
  return new TextEncoder().encode(serialized).length;
};

/** A plain object: not null, not an array. Arrays are the trap `typeof` misses. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A strict boolean, or undefined. `enabled: 'yes'` must not silently read as
 * false — that would park a route out of production on a typo.
 */
export const strictBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/**
 * A positive integer within bounds, falling back to `fallback` for anything
 * absent or unusable. Fractions and negatives are the cases that reach SQL as
 * `LIMIT 1.5` (an error) or `LIMIT -5` (silently unbounded).
 */
export const boundedInteger = (raw: string | undefined, fallback: number, max: number): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, max);
};

/**
 * JSON.parse that reports failure instead of throwing.
 *
 * Stored columns are parsed on the way out, and a column that cannot parse
 * must degrade to a reported problem — a 500 on `GET /api/routes` would lock
 * the operator out of the very screen where they would fix it.
 */
export const parseJsonSafe = (raw: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
};

/**
 * Marker for a stored JSON column that will not parse.
 *
 * Columns are written as JSON by this worker, so an unparsable one means
 * external tampering or a failed migration. Throwing on read would 500 the
 * very screens an operator needs in order to fix it, so the corruption is
 * carried as a value: `compileConfig` turns it into a per-route issue naming
 * the broken row, and publish refuses. Lives here rather than in `store` so
 * both the reader and the compiler can see it without an import cycle.
 */
export const CORRUPT = Symbol('corrupt-json');
