import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska, type ProxyEvent } from '../../src/middleware/jouska';

/** A fetch that records every attempt and fails loudly if one happens. */
let upstreamCalls: Request[] = [];
const counting: typeof fetch = async (input, init) => {
  upstreamCalls.push(new Request(input, init));
  return new Response('upstream reached');
};

const appWith = (
  routes: ConfigInput['routes'],
  events: ProxyEvent[] = [],
  fetchImpl: typeof fetch = counting,
): Hono => {
  const app = new Hono();
  app.use(
    '*',
    jouska({ config: defineConfig({ routes }), fetchImpl, onProxy: (e) => events.push(e) }),
  );
  return app;
};

const before = (): void => {
  upstreamCalls = [];
};

/** Attaches the Cloudflare-provided client IP the way the platform does. */
const from = (ip: string, init?: RequestInit) =>
  new Request('https://p.dev/x', {
    ...init,
    headers: { ...init?.headers, 'cf-connecting-ip': ip },
  });

describe('respond routes', () => {
  it('answers a redirect without contacting any upstream', async () => {
    before();
    const events: ProxyEvent[] = [];
    const app = appWith(
      [{ match: { path: '/old' }, respond: { redirect: { to: '/new', status: 301 } } }],
      events,
    );
    const res = await app.request('https://p.dev/old/a?b=1');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/new');
    expect(await res.text()).toBe('');
    expect(upstreamCalls).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'responded',
      status: 301,
      attempts: 0,
      upstream: '',
    });
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('defaults the redirect status to 301 and honours the written one', async () => {
    before();
    const app = appWith([
      { match: { path: '/a' }, respond: { redirect: { to: '/x' } } },
      {
        match: { path: '/b' },
        respond: { redirect: { to: 'https://moved.test/y', status: 302, allowExternal: true } },
      },
    ]);
    expect((await app.request('https://p.dev/a')).headers.get('location')).toBe('/x');
    const moved = await app.request('https://p.dev/b');
    expect(moved.status).toBe(302);
    expect(moved.headers.get('location')).toBe('https://moved.test/y');
  });

  it('serves a fixed status, body, type and headers', async () => {
    before();
    const events: ProxyEvent[] = [];
    const app = appWith(
      [
        {
          match: { path: '/x' },
          respond: {
            status: 503,
            contentType: 'text/html; charset=utf-8',
            body: '<p>back soon</p>',
            headers: { 'retry-after': '1800' },
          },
        },
      ],
      events,
    );
    const res = await app.request('https://p.dev/x');
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('retry-after')).toBe('1800');
    expect(await res.text()).toBe('<p>back soon</p>');
    expect(upstreamCalls).toEqual([]);
    expect(events[0]).toMatchObject({ outcome: 'responded', status: 503, attempts: 0 });
  });

  it('answers a HEAD with the status and headers and no body', async () => {
    before();
    const app = appWith([
      { match: { path: '/x' }, respond: { status: 503, contentType: 'text/plain', body: 'down' } },
    ]);
    const res = await app.request(new Request('https://p.dev/x', { method: 'HEAD' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('');
    expect(upstreamCalls).toEqual([]);
  });

  it('keeps the guard chain ahead of the answer', async () => {
    before();
    const events: ProxyEvent[] = [];
    const app = appWith(
      [
        {
          match: { path: '/x' },
          respond: { status: 200, contentType: 'text/plain', body: 'ok' },
          blockCountries: ['CU'],
        },
      ],
      events,
    );
    const blocked = new Request('https://p.dev/x');
    Object.defineProperty(blocked, 'cf', { value: { country: 'CU' } });
    const refused = await app.request(blocked);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe('Forbidden');
    expect(events[0]).toMatchObject({ status: 403, outcome: 'refused', attempts: 0 });

    const admitted = await app.request('https://p.dev/x');
    expect(admitted.status).toBe(200);
    expect(await admitted.text()).toBe('ok');
    expect(events[1]).toMatchObject({ status: 200, outcome: 'responded', attempts: 0 });
  });

  it('still rate-limits a respond route', async () => {
    before();
    let seen = 0;
    const binding = {
      limit: async () => ({ success: (seen += 1) <= 1 }),
    };
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: [
            {
              match: { path: '/x' },
              respond: { status: 200, contentType: 'text/plain', body: 'ok' },
              rateLimit: { binding: 'RL' },
            },
          ],
        }),
        fetchImpl: counting,
      }),
    );
    const call = (request: Request) => app.fetch(request, { RL: binding });
    expect((await call(from('203.0.113.1'))).status).toBe(200);
    expect((await call(from('203.0.113.1'))).status).toBe(429);
  });

  it('wraps the answer in CORS when the route has a cors block', async () => {
    before();
    const app = appWith([
      {
        match: { path: '/x' },
        respond: { status: 200, contentType: 'text/plain', body: 'ok' },
        cors: { origins: ['https://app.test'] },
      },
    ]);
    const res = await app.request(
      new Request('https://p.dev/x', { headers: { origin: 'https://app.test' } }),
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.test');
    expect(await res.text()).toBe('ok');
  });

  it('answers a bodyless 204 without inventing a content-type', async () => {
    before();
    const app = appWith([{ match: { path: '/x' }, respond: { status: 204 } }]);
    const res = await app.request('https://p.dev/x');
    expect(res.status).toBe(204);
    expect(res.headers.get('content-type')).toBeNull();
  });
});

describe('errorPages', () => {
  const failing: typeof fetch = async () => {
    throw new Error('connection refused');
  };

  const appWithFailure = (events: ProxyEvent[]): Hono =>
    appWith(
      [
        {
          match: { path: '/x' },
          upstream: 'origin.test',
          errorPages: {
            502: {
              body: '<h1>down for maintenance</h1>',
              contentType: 'text/html; charset=utf-8',
              headers: { 'retry-after': '300' },
            },
          },
        },
      ],
      events,
      failing,
    );

  it('replaces the payload of a 502 but not the status', async () => {
    before();
    const events: ProxyEvent[] = [];
    const app = appWithFailure(events);
    const res = await app.request('https://p.dev/x');
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('retry-after')).toBe('300');
    expect(await res.text()).toBe('<h1>down for maintenance</h1>');
    expect(events[0]).toMatchObject({ status: 502, outcome: 'unreachable', attempts: 1 });
  });

  it('leaves the JSON error when the status has no page', async () => {
    before();
    const app = appWith(
      [
        {
          match: { path: '/x' },
          upstream: 'origin.test',
          errorPages: { 504: { body: 'timeout', contentType: 'text/plain' } },
        },
      ],
      [],
      failing,
    );
    const res = await app.request('https://p.dev/x');
    // The failure is an unreachable upstream — 502, and the table only names 504.
    expect(res.status).toBe(502);
    expect(((await res.json()) as Record<string, string>).error).toBe('upstream_unreachable');
  });

  it('does not touch the refusals the guards produce', async () => {
    before();
    const app = appWith(
      [
        {
          match: { path: '/x' },
          upstream: 'origin.test',
          errorPages: { 502: { body: 'page', contentType: 'text/html' } },
          requestPolicy: { allowedMethods: ['GET'] },
        },
      ],
      [],
      failing,
    );
    const refused = await app.request(new Request('https://p.dev/x', { method: 'POST' }));
    expect(refused.status).toBe(405);
    expect(((await refused.json()) as Record<string, string>).error).toBe('method_not_allowed');
  });

  it('serves a HEAD the headers without the body, status intact', async () => {
    before();
    const app = appWithFailure([]);
    const res = await app.request(new Request('https://p.dev/x', { method: 'HEAD' }));
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('');
  });
});
