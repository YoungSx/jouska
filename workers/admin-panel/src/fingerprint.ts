/**
 * Draft-vs-live comparison.
 *
 * The panel's central claim is that saving is not publishing, so it has to be
 * able to say whether the draft differs from what the proxy is actually serving.
 * Reading KV back to answer that would spend a read on every page load, and KV
 * is eventually consistent — a read straight after a publish can still return
 * the previous value, which would render as "unpublished changes" seconds after
 * a successful publish.
 *
 * So the fingerprint of the published document is recorded in D1 at publish
 * time, next to the revision it belongs to. D1 is the panel's own source of
 * truth and is read-your-writes, so the comparison is exact and costs no KV
 * quota.
 *
 * The digest covers the document *without* `meta`: `meta.updatedAt` changes on
 * every publish, so including it would make every draft differ from every
 * published document, which is the same as having no comparison at all.
 */

/** Settings key holding `{ revision, digest }` for the live document. */
export const LIVE_KEY = 'live';

export interface LiveState {
  readonly revision: number;
  readonly digest: string;
}

/**
 * Serializes with sorted keys so a document that differs only in key order
 * produces the same digest. `JSON.stringify` preserves insertion order, and
 * route definitions are stored as operator-authored JSON, so key order is not
 * stable across an edit that changed nothing semantically.
 *
 * Exported because the revision diff must apply the exact same rule: "does
 * this differ" has one answer, whether asked by the digest or the diff.
 */
export const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    // Array order is meaningful here (route order is priority), so it is kept.
    return value.map(canonicalize);
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).toSorted()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
};

/** SHA-256, hex, of the canonical serialization. */
export const documentDigest = async (document: unknown): Promise<string> => {
  const canonical = JSON.stringify(canonicalize(document));
  const bytes = new TextEncoder().encode(canonical ?? 'null');
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Reads the recorded live state, or undefined when nothing has been published.
 *
 * A stored value that is not the expected shape reads as "never published"
 * rather than throwing: the panel must stay usable on a hand-edited or
 * partially-migrated row, and treating it as unpublished is the conservative
 * reading — it shows the draft as unpublished and invites a publish, which is
 * exactly what would repair the record.
 */
export const asLiveState = (stored: unknown): LiveState | undefined => {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    return undefined;
  }
  const record = stored as Record<string, unknown>;
  const { revision, digest } = record;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    return undefined;
  }
  if (typeof digest !== 'string' || digest === '') {
    return undefined;
  }
  return { revision, digest };
};
