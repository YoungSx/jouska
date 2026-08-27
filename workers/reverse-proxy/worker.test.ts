import { beforeEach, describe, expect, it } from 'vitest';
import worker, { __resetConfigCache } from './index.js';

/**
 * Covers the reference Worker's own wiring: config sourcing, the isolate cache,
 * and the failure path. The library is tested elsewhere; what is under test here
 * is that the assembly is correct.
 */
const ctx = {} as ExecutionContext;

/** Stands in for the upstream so no test touches the public network. */
const upstream: typeof fetch = async (input) => {
  const request = input instanceof Request ? input : new Request(input);
  return new Response(`reached ${new URL(request.url).host}`);
};

const table = {
  version: 1,
  routes: [{ id: 'api', match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true }],
};

describe('reference worker', () => {
  // Each case needs a cold isolate; a real deployment gets that from a restart.
  beforeEach(() => __resetConfigCache());

  it('reports 503 when no config is available at all', async () => {
    // An empty route table would otherwise surface as a puzzling 404.
    const res = await worker.fetch(new Request('https://p.dev/'), {}, ctx);
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, string>).error).toBe('config_unavailable');
  });

  it('reads the route table from an environment variable', async () => {
    const res = await worker.fetch(
      new Request('https://p.dev/api/models'),
      { JOUSKA_CONFIG: table, UPSTREAM_FETCH: upstream },
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('reached origin.test');
  });

  it('accepts a stringified table, as a dashboard-added variable would be', async () => {
    const res = await worker.fetch(
      new Request('https://p.dev/api/models'),
      { JOUSKA_CONFIG: JSON.stringify(table), UPSTREAM_FETCH: upstream },
      ctx,
    );
    expect(await res.text()).toBe('reached origin.test');
  });

  it('prefers KV over the environment variable when a namespace is bound', async () => {
    let kvReads = 0;
    const env = {
      CONFIG: {
        get: async () => {
          kvReads += 1;
          return table;
        },
      },
      JOUSKA_CONFIG: { version: 1, routes: [{ match: { path: '/env' }, upstream: 'env.test' }] },
      UPSTREAM_FETCH: upstream,
    };
    const res = await worker.fetch(new Request('https://p.dev/api/x'), env, ctx);
    expect(kvReads).toBeGreaterThan(0);
    // The KV table routes /api; the variable's table does not, so reaching
    // origin.test proves KV won.
    expect(await res.text()).toBe('reached origin.test');
  });

  it('falls back to the variable when the KV key is empty', async () => {
    const env = {
      CONFIG: { get: async () => null },
      JOUSKA_CONFIG: table,
      UPSTREAM_FETCH: upstream,
    };
    const res = await worker.fetch(new Request('https://p.dev/api/x'), env, ctx);
    expect(await res.text()).toBe('reached origin.test');
  });

  it('honours CONFIG_KEY when reading from KV', async () => {
    let seenKey: string | undefined;
    const env = {
      CONFIG: {
        get: async (key: string) => {
          seenKey = key;
          return table;
        },
      },
      CONFIG_KEY: 'custom-routes',
      UPSTREAM_FETCH: upstream,
    };
    await worker.fetch(new Request('https://p.dev/api/x'), env, ctx);
    expect(seenKey).toBe('custom-routes');
  });
});

describe('isolate reuse', () => {
  beforeEach(() => __resetConfigCache());

  it('reads the store once for many requests', async () => {
    // This ratio is what keeps the proxy inside the free tier's 100k daily KV
    // reads: one read per isolate per TTL, not one per request.
    let reads = 0;
    const env = {
      CONFIG: {
        get: async () => {
          reads += 1;
          return table;
        },
      },
      UPSTREAM_FETCH: upstream,
    };
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await worker.fetch(new Request('https://p.dev/api/x'), env, ctx);
    }
    expect(reads).toBe(1);
  });

  it('does not reuse a cache built from different bindings', async () => {
    // Closing over the first request's env would pin the isolate to it, so a
    // cold start during a brief outage would leave it broken for its whole life.
    const first = {
      CONFIG: { get: async () => table },
      UPSTREAM_FETCH: upstream,
    };
    const second = {
      CONFIG: {
        get: async () => ({
          version: 1,
          routes: [{ match: { path: '/other' }, upstream: 'b.test' }],
        }),
      },
      CONFIG_KEY: 'other-key',
      UPSTREAM_FETCH: upstream,
    };
    expect((await worker.fetch(new Request('https://p.dev/api/x'), first, ctx)).status).toBe(200);
    // The second table does not route /api, so a 404 proves the reload happened.
    expect((await worker.fetch(new Request('https://p.dev/api/x'), second, ctx)).status).toBe(404);
  });
});
