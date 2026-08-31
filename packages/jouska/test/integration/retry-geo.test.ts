import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska } from '../../src/middleware/jouska';

/** Fails the first `failures` attempts, then succeeds. Counts every attempt. */
const flakyUpstream = (failures: number) => {
  let attempts = 0;
  const fetchImpl: typeof fetch = async () => {
    attempts += 1;
    if (attempts <= failures) {
      throw new Error('transient');
    }
    return new Response(`ok after ${attempts}`);
  };
  return { fetchImpl, attempts: () => attempts };
};

const appWith = (routes: ConfigInput['routes'], fetchImpl: typeof fetch) => {
  const app = new Hono();
  app.use('*', jouska({ config: defineConfig({ routes }), fetchImpl }));
  return app;
};

describe('retries', () => {
  it('retries an idempotent request up to the configured limit', async () => {
    const up = flakyUpstream(2);
    const app = appWith([{ match: { path: '/x' }, upstream: 'o.test', retries: 2 }], up.fetchImpl);
    const res = await app.request('https://p.dev/x');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok after 3');
    expect(up.attempts()).toBe(3);
  });

  it('gives up once retries are exhausted', async () => {
    const up = flakyUpstream(99);
    const app = appWith([{ match: { path: '/x' }, upstream: 'o.test', retries: 1 }], up.fetchImpl);
    expect((await app.request('https://p.dev/x')).status).toBe(502);
    expect(up.attempts()).toBe(2);
  });

  it('never retries a non-idempotent method', async () => {
    // A consumed request body cannot be replayed, so POST must attempt once.
    const up = flakyUpstream(99);
    const app = appWith([{ match: { path: '/x' }, upstream: 'o.test', retries: 3 }], up.fetchImpl);
    await app.request('https://p.dev/x', { method: 'POST', body: 'data' });
    expect(up.attempts()).toBe(1);
  });

  /**
   * An idempotent method is not on its own enough to replay: `OPTIONS` and
   * `TRACE` may carry a body, and the first attempt consumes its stream.
   *
   * Verified in workerd before the fix: the second attempt threw `This
   * ReadableStream is disturbed` inside the attempt itself, so only one request
   * ever reached the network — and the error the caller finally saw was that
   * TypeError rather than the network failure that actually happened, because
   * the loop rethrows whatever failed last.
   */
  it('never retries an idempotent method that carries a body', async () => {
    const up = flakyUpstream(99);
    const app = appWith([{ match: { path: '/x' }, upstream: 'o.test', retries: 3 }], up.fetchImpl);
    const res = await app.request('https://p.dev/x', { method: 'OPTIONS', body: 'data' });
    expect(up.attempts()).toBe(1);
    // The real failure, not the disturbed-stream TypeError that used to mask it.
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_unreachable', upstream: 'o.test' });
  });

  it('still retries an idempotent method with no body', async () => {
    // The guard above must not be satisfied by refusing to retry anything.
    const up = flakyUpstream(1);
    const app = appWith([{ match: { path: '/x' }, upstream: 'o.test', retries: 2 }], up.fetchImpl);
    const res = await app.request('https://p.dev/x', { method: 'OPTIONS' });
    expect(res.status).toBe(200);
    expect(up.attempts()).toBe(2);
  });

  it('makes a single attempt when retries are zero', async () => {
    const up = flakyUpstream(99);
    const app = appWith([{ match: { path: '/x' }, upstream: 'o.test' }], up.fetchImpl);
    await app.request('https://p.dev/x');
    expect(up.attempts()).toBe(1);
  });
});

describe('country blocking', () => {
  const ok: typeof fetch = async () => new Response('upstream reached');

  const withCountry = (app: Hono, code?: string) => {
    const request = new Request('https://p.dev/x');
    if (code !== undefined) {
      Object.defineProperty(request, 'cf', { value: { country: code } });
    }
    return app.request(request);
  };

  it('refuses a blocked country', async () => {
    const app = appWith(
      [{ match: { path: '/x' }, upstream: 'o.test', blockCountries: ['CU'] }],
      ok,
    );
    expect((await withCountry(app, 'CU')).status).toBe(403);
  });

  it('admits other countries', async () => {
    const app = appWith(
      [{ match: { path: '/x' }, upstream: 'o.test', blockCountries: ['CU'] }],
      ok,
    );
    expect((await withCountry(app, 'US')).status).toBe(200);
  });

  it('admits a request with no country signal', async () => {
    // Fail-open: an unknown origin must not be mistaken for a blocked one.
    const app = appWith(
      [{ match: { path: '/x' }, upstream: 'o.test', blockCountries: ['CU'] }],
      ok,
    );
    expect((await withCountry(app)).status).toBe(200);
  });
});
