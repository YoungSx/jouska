import { describe, expect, it } from 'vitest';
import type { ConfigInput } from '../../src/config';
import { resolveConfig } from '../../src/resolve';

const codeTable: ConfigInput = {
  routes: [{ id: 'api', match: { path: '/api' }, upstream: 'code.test' }],
};
const remoteTable = {
  routes: [
    { id: 'api', match: { path: '/api' }, upstream: 'remote.test' },
    { id: 'extra', match: { path: '/extra' }, upstream: 'remote.test' },
  ],
};

describe('resolveConfig precedence', () => {
  it('lets code replace the remote table wholesale by default', () => {
    const config = resolveConfig({ code: codeTable, remote: remoteTable });
    expect(config.routes).toHaveLength(1);
    expect(config.routes[0]!.upstream).toBe('code.test');
  });

  it('uses remote config when no code config is given', () => {
    const config = resolveConfig({ remote: remoteTable });
    expect(config.routes.map((r) => r.upstream)).toEqual(['remote.test', 'remote.test']);
  });

  it('uses code config when no remote config is given', () => {
    expect(resolveConfig({ code: codeTable }).routes[0]!.upstream).toBe('code.test');
  });

  it('treats a null remote the same as absent', () => {
    expect(resolveConfig({ code: codeTable, remote: null }).routes).toHaveLength(1);
  });
});

describe('resolveConfig merge byId', () => {
  it('lets a code route override the remote route with the same id', () => {
    const config = resolveConfig({ code: codeTable, remote: remoteTable, merge: 'byId' });
    const api = config.routes.filter((r) => r.id === 'api');
    expect(api).toHaveLength(1);
    expect(api[0]!.upstream).toBe('code.test');
  });

  it('keeps remote routes that code does not define', () => {
    const config = resolveConfig({ code: codeTable, remote: remoteTable, merge: 'byId' });
    expect(config.routes.map((r) => r.id)).toEqual(['api', 'extra']);
  });

  it('puts code routes first so they also win match ordering', () => {
    const config = resolveConfig({
      code: { routes: [{ id: 'c', match: { path: '/x' }, upstream: 'code.test' }] },
      remote: { routes: [{ id: 'r', match: { path: '/x' }, upstream: 'remote.test' }] },
      merge: 'byId',
    });
    // Both match /x; first wins, and that must be the code-defined one.
    expect(config.routes[0]!.upstream).toBe('code.test');
  });

  it('keeps remote routes without an id, since they cannot collide', () => {
    const config = resolveConfig({
      code: codeTable,
      remote: { routes: [{ match: { path: '/anon' }, upstream: 'remote.test' }] },
      merge: 'byId',
    });
    expect(config.routes).toHaveLength(2);
  });
});

describe('resolveConfig failure handling', () => {
  it('falls back to code when remote config is invalid', () => {
    // A corrupt remote table must not take the proxy down.
    const config = resolveConfig({ code: codeTable, remote: { routes: 'not an array' } });
    expect(config.routes[0]!.upstream).toBe('code.test');
  });

  it('reports the remote validation error to the caller', () => {
    let reported: unknown;
    resolveConfig({
      code: codeTable,
      remote: { routes: [{ match: {}, upstream: 'x.test' }] },
      onRemoteError: (e) => {
        reported = e;
      },
    });
    expect(reported).toBeDefined();
  });

  it('throws on invalid code config rather than silently degrading', () => {
    // A mistake in code is a programming error and must surface immediately.
    expect(() => resolveConfig({ code: { routes: [] } })).toThrow();
  });

  it('throws when neither source yields a usable table', () => {
    expect(() => resolveConfig({})).toThrow(/no usable config/);
    expect(() => resolveConfig({ remote: { routes: [] } })).toThrow(/no usable config/);
  });

  it('applies defaults to remote config the same as code config', () => {
    const config = resolveConfig({
      remote: { routes: [{ match: { path: '/r' }, upstream: 'r.test' }] },
    });
    expect(config.routes[0]!.timeoutMs).toBe(10_000);
  });
});

describe('remote config cannot widen what code refuses', () => {
  it('rejects a stored route whose upstream resolves to a private address', () => {
    // KV is the runtime-editable half, so it is the entry point that matters: a
    // stored table is exactly where a tampered upstream would arrive.
    let reported: unknown;
    const config = resolveConfig({
      code: { routes: [{ id: 'api', match: { path: '/api' }, upstream: 'api.example.com' }] },
      // 2852039166 is 169.254.169.254 written as one decimal.
      remote: {
        version: 1,
        routes: [{ id: 'evil', match: { path: '/' }, upstream: '2852039166' }],
      },
      merge: 'byId',
      onRemoteError: (error) => {
        reported = error;
      },
    });
    expect(reported).toBeDefined();
    // The whole remote document is discarded, so the proxy keeps serving code.
    expect(config.routes.map((route) => route.upstream)).toEqual(['api.example.com']);
  });

  it('keeps each half of a byId merge on its own defaults', () => {
    const config = resolveConfig({
      code: {
        defaults: { timeoutMs: 1_000 },
        routes: [{ id: 'a', match: { path: '/a' }, upstream: 'a.test' }],
      },
      remote: {
        version: 1,
        defaults: { timeoutMs: 9_999 },
        routes: [{ id: 'b', match: { path: '/b' }, upstream: 'b.test' }],
      },
      merge: 'byId',
    });
    expect(config.routes.find((r) => r.id === 'a')?.timeoutMs).toBe(1_000);
    expect(config.routes.find((r) => r.id === 'b')?.timeoutMs).toBe(9_999);
  });
});
