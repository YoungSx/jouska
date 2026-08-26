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
    const config = defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', bodyRewrite: {} }] });
    expect(config.routes[0]!.bodyRewrite).toEqual({
      rewriteLinks: true,
      replace: [],
      contentTypes: ['text/html'],
    });
  });

  it('rejects an upstream with a scheme', () => {
    expect(() => defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'https://o.test' }] })).toThrow();
  });

  it('rejects a route that matches nothing', () => {
    expect(() => defineConfig({ routes: [{ match: {}, upstream: 'o.test' }] })).toThrow();
  });

  it('rejects an empty route table', () => {
    expect(() => defineConfig({ routes: [] })).toThrow();
  });

  it('rejects a path without a leading slash', () => {
    expect(() => defineConfig({ routes: [{ match: { path: 'api' }, upstream: 'o.test' }] })).toThrow();
  });

  it('rejects a timeout beyond the platform CPU limit', () => {
    expect(() => defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', timeoutMs: 60_000 }] })).toThrow();
  });

  it('rejects an unbounded retry count', () => {
    expect(() => defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', retries: 99 }] })).toThrow();
  });

  it('accepts an upstream base path', () => {
    expect(() => defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test/v1/base' }] })).not.toThrow();
  });

  it('rejects a two-letter country code of the wrong length', () => {
    expect(() => defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', blockCountries: ['USA'] }] })).toThrow();
  });
});
