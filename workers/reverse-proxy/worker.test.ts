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
