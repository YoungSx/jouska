/**
 * Unit tests for diffDocuments — the shape rules the history view renders.
 *
 * Key-order insensitivity lives here because it is a property of the shared
 * canonicalization (the same rule the publish no-op guard digests with), not
 * of any HTTP surface: two documents that differ only in key order are the
 * same document, so the diff between them is empty.
 */
import { describe, expect, it } from 'vitest';
import { diffDocuments } from './diff.js';

describe('diffDocuments', () => {
  it('ignores key order — same content in opposite key order diffs empty', () => {
    const a = {
      defaults: { timeoutMs: 5000, retries: 2 },
      routes: [{ id: 'a', upstream: 'u.example.com', match: { host: 'a.example.com' } }],
    };
    const b = {
      routes: [{ match: { host: 'a.example.com' }, upstream: 'u.example.com', id: 'a' }],
      defaults: { retries: 2, timeoutMs: 5000 },
    };
    expect(diffDocuments(a, b)).toEqual([]);
  });

  it('reports a changed scalar', () => {
    const entries = diffDocuments(
      { routes: [{ id: 'a', timeoutMs: 5000 }] },
      { routes: [{ id: 'a', timeoutMs: 8000 }] },
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'changed', path: 'routes.a.timeoutMs' });
  });
});
