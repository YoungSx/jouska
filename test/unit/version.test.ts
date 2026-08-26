import { describe, expect, it } from 'vitest';
import { CONFIG_VERSION, defineConfig } from '../../src/config';
import { resolveConfig } from '../../src/resolve';

const routes = [{ match: { path: '/a' }, upstream: 'o.test' }] as const;

describe('config version', () => {
  it('defaults to the current version when omitted', () => {
    // Documents written before versioning existed must stay valid.
    expect(defineConfig({ routes: [...routes] }).version).toBe(CONFIG_VERSION);
  });

  it('accepts an explicit current version', () => {
    expect(defineConfig({ version: 1, routes: [...routes] }).version).toBe(1);
  });

  it('rejects a version it cannot read rather than reinterpreting it', () => {
    // The whole point: a future document must fail loudly, not parse into
    // something subtly different under the current schema.
    expect(() =>
      // @ts-expect-error exercising runtime rejection of a future version
      defineConfig({ version: 2, routes: [...routes] }),
    ).toThrow();
  });

  it('rejects a non-numeric version', () => {
    // @ts-expect-error exercising runtime validation
    expect(() => defineConfig({ version: '1', routes: [...routes] })).toThrow();
  });
});

describe('version handling in resolveConfig', () => {
  it('discards remote config with an unreadable version and falls back to code', () => {
    let reported: unknown;
    const config = resolveConfig({
      code: { routes: [{ id: 'core', match: { path: '/a' }, upstream: 'code.test' }] },
      remote: { version: 99, routes: [{ match: { path: '/a' }, upstream: 'remote.test' }] },
      onRemoteError: (e) => {
        reported = e;
      },
    });
    expect(config.routes[0]!.upstream).toBe('code.test');
    expect(reported).toBeDefined();
  });

  it('throws when remote is the only source and its version is unreadable', () => {
    // Nothing usable remains, and silently serving no routes would be worse.
    expect(() =>
      resolveConfig({
        remote: { version: 99, routes: [{ match: { path: '/a' }, upstream: 'r.test' }] },
      }),
    ).toThrow(/no usable config/);
  });

  it('carries the version through a byId merge', () => {
    const config = resolveConfig({
      code: { routes: [{ id: 'c', match: { path: '/a' }, upstream: 'code.test' }] },
      remote: { routes: [{ id: 'r', match: { path: '/b' }, upstream: 'remote.test' }] },
      merge: 'byId',
    });
    expect(config.version).toBe(CONFIG_VERSION);
  });

  it('accepts an unversioned remote document', () => {
    const config = resolveConfig({
      remote: { routes: [{ match: { path: '/a' }, upstream: 'r.test' }] },
    });
    expect(config.version).toBe(CONFIG_VERSION);
  });
});
