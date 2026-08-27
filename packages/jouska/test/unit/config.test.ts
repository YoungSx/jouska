import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config';

describe('defineConfig', () => {
  it('applies defaults', () => {
    const config = defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test' }] });
    const route = config.routes[0]!;
    expect(route.stripPrefix).toBe(false);
    expect(route.timeoutMs).toBe(10_000);
    expect(route.retries).toBe(0);
    expect(route.rewriteHeaders).toBe(true);
    expect(route.bodyRewrite).toBeUndefined();
  });

  it('defaults bodyRewrite fields when the block is present', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/a' }, upstream: 'o.test', bodyRewrite: {} }],
    });
    expect(config.routes[0]!.bodyRewrite).toEqual({
      rewriteLinks: true,
      replace: [],
      contentTypes: ['text/html'],
      rewriteStyles: true,
    });
  });

  it('rejects an upstream with a scheme', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'https://o.test' }] }),
    ).toThrow();
  });

  it('rejects a route that matches nothing', () => {
    expect(() => defineConfig({ routes: [{ match: {}, upstream: 'o.test' }] })).toThrow();
  });

  it('rejects an empty route table', () => {
    expect(() => defineConfig({ routes: [] })).toThrow();
  });

  it('rejects a path without a leading slash', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: 'api' }, upstream: 'o.test' }] }),
    ).toThrow();
  });

  it('rejects a timeout beyond the platform CPU limit', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', timeoutMs: 60_000 }] }),
    ).toThrow();
  });

  it('rejects an unbounded retry count', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', retries: 99 }] }),
    ).toThrow();
  });

  it('accepts an upstream base path', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test/v1/base' }] }),
    ).not.toThrow();
  });

  it('rejects a two-letter country code of the wrong length', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'o.test', blockCountries: ['USA'] }],
      }),
    ).toThrow();
  });
});

describe('guard config', () => {
  it('defaults CORS fields', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/a' }, upstream: 'o.test', cors: {} }],
    });
    expect(config.routes[0]!.cors).toEqual({
      allowHeaders: [],
      exposeHeaders: [],
      credentials: false,
    });
  });

  it('rejects an ip block with no rules', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', ip: {} }] }),
    ).toThrow();
  });

  it('accepts an ip block with only a deny list', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'o.test', ip: { deny: ['10.0.0.0/8'] } }],
      }),
    ).not.toThrow();
  });

  it('defaults the rate limit key to ip', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/a' }, upstream: 'o.test', rateLimit: { binding: 'RL' } }],
    });
    expect(config.routes[0]!.rateLimit).toEqual({ binding: 'RL', by: 'ip', countPreflight: false });
  });

  it('rejects an unknown rate limit key strategy', () => {
    expect(() =>
      defineConfig({
        // @ts-expect-error exercising runtime validation with an invalid value
        routes: [
          { match: { path: '/a' }, upstream: 'o.test', rateLimit: { binding: 'RL', by: 'header' } },
        ],
      }),
    ).toThrow();
  });

  it('rejects an empty binding name', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'o.test', rateLimit: { binding: '' } }],
      }),
    ).toThrow();
  });

  it('leaves guards undefined when not configured', () => {
    const route = defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test' }] })
      .routes[0]!;
    expect(route.cors).toBeUndefined();
    expect(route.ip).toBeUndefined();
    expect(route.rateLimit).toBeUndefined();
  });
});
