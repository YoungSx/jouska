import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config';

describe('requestPolicy config', () => {
  it('leaves the block undefined when not configured', () => {
    const route = defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test' }] })
      .routes[0]!;
    expect(route.requestPolicy).toBeUndefined();
  });

  it('passes an allowedMethods list through', () => {
    const config = defineConfig({
      routes: [
        {
          match: { path: '/a' },
          upstream: 'o.test',
          requestPolicy: { allowedMethods: ['GET', 'POST'] },
        },
      ],
    });
    expect(config.routes[0]!.requestPolicy).toEqual({ allowedMethods: ['GET', 'POST'] });
  });

  it('rejects a maxBodyBytes that is not a positive integer', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'o.test', requestPolicy: { maxBodyBytes: 0 } }],
      }),
    ).toThrow();
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/a' }, upstream: 'o.test', requestPolicy: { maxBodyBytes: 1.5 } },
        ],
      }),
    ).toThrow();
  });

  it('rejects a maxBodyBytes above the platform ceiling', () => {
    // 500 MiB is the largest value the platform could act on; anything larger
    // can only produce a limit that never fires, which reads as working.
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'o.test',
            requestPolicy: { maxBodyBytes: 524_288_001 },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'o.test',
            requestPolicy: { maxBodyBytes: 524_288_000 },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects allowedMethods sharing nothing with match.methods', () => {
    // Every request match.methods lets in, allowedMethods refuses with 405.
    // The block reads as an extra guard but works as a full stop.
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a', methods: ['GET'] },
            upstream: 'o.test',
            requestPolicy: { allowedMethods: ['POST'] },
          },
        ],
      }),
    ).toThrow(/nothing in common/);
  });

  it('catches the same contradiction split across defaults and a route', () => {
    // The check runs after defaults are folded in: neither half is wrong alone.
    expect(() =>
      defineConfig({
        defaults: { requestPolicy: { allowedMethods: ['PUT'] } },
        routes: [{ match: { path: '/a', methods: ['GET'] }, upstream: 'o.test' }],
      }),
    ).toThrow(/nothing in common/);
  });

  it('accepts allowedMethods that overlap match.methods', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a', methods: ['GET', 'POST'] },
            upstream: 'o.test',
            requestPolicy: { allowedMethods: ['GET'] },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('accepts allowedMethods without match.methods', () => {
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/a' }, upstream: 'o.test', requestPolicy: { allowedMethods: ['GET'] } },
        ],
      }),
    ).not.toThrow();
  });
});
