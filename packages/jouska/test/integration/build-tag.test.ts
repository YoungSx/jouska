import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska } from '../../src/middleware/jouska';

/**
 * The build tag (`x-jouska-build`) answers one question: *which build refused
 * me?* The tag is a claim of authorship, so it follows the request ID's
 * precedent exactly — added to responses jouska assembled itself (guard
 * refusals, relayed forward-auth verdicts, assembled upstream failures), never
 * to a body, and never onto a response the upstream produced. Every test below
 * fails when the tag lands on the wrong side of that line.
 */

const route: ConfigInput['routes'][number] = {
  match: { path: '/a' },
  upstream: 'o.test',
};

/** A guard that refuses everything, exercising the jouska-made refusal path. */
const guarded: ConfigInput['routes'][number] = {
  ...route,
  access: { cloudflare: { team: 'acme', audience: 'aud' } },
};

const appWith = (
  routes: ConfigInput['routes'],
  options: { buildId?: string; fetchImpl?: typeof fetch } = {},
) => {
  const app = new Hono();
  app.use(
    '*',
    jouska({
      config: defineConfig({ routes }),
      fetchImpl: options.fetchImpl ?? (() => new Response('from upstream')),
      ...(options.buildId !== undefined ? { buildId: options.buildId } : {}),
    }),
  );
  return app;
};

const CF_JWT = 'eyJhbGciOiJFUzI1NiIsImtpZCI6ImtleSJ9.eyJhdWQiOiJhdWQifQ.sig';

/**
 * An upstream that never answers but honours the abort signal, as in
 * limits.test.ts — it holds a seat without ever hanging the test.
 */
const neverResponds: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  if (request.signal.aborted) {
    throw request.signal.reason;
  }
  return new Promise<Response>((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason));
  });
};

describe('build tag', () => {
  it('stamps a guard refusal with the build id', async () => {
    const app = appWith([guarded], { buildId: 'v1.2.3-4-gdeadbee' });
    const res = await app.request('https://p.dev/a');
    expect(res.status).toBe(401);
    expect(res.headers.get('x-jouska-build')).toBe('v1.2.3-4-gdeadbee');
  });

  it('stamps a relayed forward-auth verdict without touching its body', async () => {
    const app = appWith(
      [
        {
          ...route,
          forwardAuth: { url: 'https://auth.test/check' },
        },
      ],
      {
        buildId: 'v1.2.3-4-gdeadbee',
        fetchImpl: () => new Response('denied', { status: 401 }),
      },
    );
    const res = await app.request('https://p.dev/a');
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('denied');
    expect(res.headers.get('x-jouska-build')).toBe('v1.2.3-4-gdeadbee');
  });

  it('stamps an assembled upstream failure but not an upstream success', async () => {
    const app = appWith([route], {
      buildId: 'v1.2.3-4-gdeadbee',
      fetchImpl: () => Promise.reject(new Error('unreachable')),
    });
    const failure = await app.request('https://p.dev/a');
    expect(failure.status).toBe(502);
    expect(failure.headers.get('x-jouska-build')).toBe('v1.2.3-4-gdeadbee');

    const ok = await appWith([route], { buildId: 'v1.2.3-4-gdeadbee' }).request('https://p.dev/a');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-jouska-build')).toBeNull();
    expect(await ok.text()).toBe('from upstream');
  });

  it('stamps the in-flight-limit 503', async () => {
    // The upstream hangs but honours the abort signal, so the first request
    // holds its seat for the whole test without hanging the test itself.
    const app = appWith([{ ...route, limits: { maxInFlight: 1 } }], {
      buildId: 'v1.2.3-4-gdeadbee',
      fetchImpl: neverResponds,
    });
    const first = app.request('https://p.dev/a');
    const second = await app.request('https://p.dev/a');
    expect(second.status).toBe(503);
    expect(second.headers.get('x-jouska-build')).toBe('v1.2.3-4-gdeadbee');
    first.then(
      (res) => void res.body?.cancel(),
      () => {},
    );
  });

  it('leaves every response untouched when unset', async () => {
    const refusal = await appWith([guarded]).request('https://p.dev/a', {
      headers: { 'cf-access-jwt-assertion': CF_JWT },
    });
    expect(refusal.headers.get('x-jouska-build')).toBeNull();
    const ok = await appWith([route]).request('https://p.dev/a');
    expect(ok.headers.get('x-jouska-build')).toBeNull();
  });
});
