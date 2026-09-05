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
    expect(entries[0]).toMatchObject({
      kind: 'changed',
      path: 'routes.a.timeoutMs',
      routeId: 'a',
      field: 'timeoutMs',
    });
    expect(entries[0]?.risk).toBeUndefined();
  });

  it('names the owning route even when the id contains dots', () => {
    const entries = diffDocuments(
      { routes: [{ id: 'foo.bar', timeoutMs: 1000 }] },
      { routes: [{ id: 'foo.bar', timeoutMs: 2000 }] },
    );
    // `routes.foo.bar.timeoutMs` is unparseable without the id list; the entry
    // carries both halves so no reader has to guess where the id ends.
    expect(entries[0]).toMatchObject({ routeId: 'foo.bar', field: 'timeoutMs' });
  });

  it('stamps the danger classification the publish gate would give the `to` side', () => {
    const flipped = diffDocuments(
      { routes: [{ id: 'a', allowPrivateUpstream: false }] },
      { routes: [{ id: 'a', allowPrivateUpstream: true }] },
    );
    expect(flipped[0]?.risk).toMatchObject({ path: 'allowPrivateUpstream', level: 'high' });

    // `allowPrivateUpstream` is a presence rule, so the row stays flagged even
    // turning it back off: on a history surface "somebody touched this switch"
    // is the thing worth seeing, and the publish dialog says the same.
    const restored = diffDocuments(
      { routes: [{ id: 'a', allowPrivateUpstream: true }] },
      { routes: [{ id: 'a', allowPrivateUpstream: false }] },
    );
    expect(restored[0]?.risk).toMatchObject({ path: 'allowPrivateUpstream' });

    // A guarded rule only fires on the state that qualifies, so the safe
    // direction leaves the row plain — again matching the publish gate.
    const disarmed = diffDocuments(
      { routes: [{ id: 'a', mirror: { includeBody: true } }] },
      { routes: [{ id: 'a', mirror: { includeBody: false } }] },
    );
    expect(disarmed[0]?.risk).toBeUndefined();
  });

  it('lets a nested field inherit the risk its ancestor names', () => {
    const entries = diffDocuments(
      { routes: [{ id: 'a', bodyRewrite: { inject: { head: '<b>' } } }] },
      { routes: [{ id: 'a', bodyRewrite: { inject: { head: '<script>' } } }] },
    );
    expect(entries[0]).toMatchObject({ field: 'bodyRewrite.inject.head' });
    expect(entries[0]?.risk).toMatchObject({ path: 'bodyRewrite.inject' });
  });

  it('counts the dangerous switches an added route arrives with', () => {
    const entries = diffDocuments(
      { routes: [] },
      {
        routes: [
          {
            id: 'a',
            allowPrivateUpstream: true,
            upstreamHeaders: { authorization: 'x' },
            timeoutMs: 1000,
          },
        ],
      },
    );
    expect(entries[0]).toMatchObject({ kind: 'added', routeId: 'a', riskCount: 2 });
    // The high-level rule is the one worth naming on a single row.
    expect(entries[0]?.risk).toMatchObject({ level: 'high' });
  });

  it('classifies defaults with the same rules — they fill the same fields', () => {
    const entries = diffDocuments(
      { defaults: { allowPrivateUpstream: false }, routes: [{ id: 'a' }] },
      { defaults: { allowPrivateUpstream: true }, routes: [{ id: 'a' }] },
    );
    expect(entries[0]).toMatchObject({
      path: 'defaults.allowPrivateUpstream',
      field: 'allowPrivateUpstream',
    });
    expect(entries[0]?.routeId).toBeUndefined();
    expect(entries[0]?.risk).toMatchObject({ level: 'high' });
  });

  it('leaves `version` unowned — it is not a route and not a default', () => {
    const entries = diffDocuments(
      { version: 1, routes: [{ id: 'a' }] },
      { version: 2, routes: [{ id: 'a' }] },
    );
    expect(entries[0]).toMatchObject({ path: 'version', kind: 'changed' });
    expect(entries[0]?.routeId).toBeUndefined();
    expect(entries[0]?.field).toBeUndefined();
  });
});
