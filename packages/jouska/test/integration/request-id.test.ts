import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska, type ProxyEvent } from '../../src/middleware/jouska';

/**
 * The request ID is the one value that ties three copies of a request together:
 * the response the client holds, the request the upstream received and the
 * event the access log recorded. Each test here fails when two of those drift
 * apart — which is the only way this feature can be broken.
 *
 * workerd's test pool hands `app.request` a plain request with no `cf-ray`, so
 * the fallback to `crypto.randomUUID()` is the path exercised throughout; the
 * tests that need the edge's value inject `cf-ray` explicitly, which is
 * legitimate: the header is read off the request like any other.
 */

/** Echoes the ID it received, so an assertion can compare the two legs. */
const upstream: typeof fetch = async (input) => {
  const request = input instanceof Request ? input : new Request(input);
  const url = new URL(request.url);
  if (url.pathname === '/echo') {
    return Response.json({
      requestId: request.headers.get('x-request-id'),
      host: request.headers.get('host'),
    });
  }
  throw new Error('unreachable');
};

const appWith = (
  routes: ConfigInput['routes'],
  events: ProxyEvent[] = [],
  defaults?: ConfigInput['defaults'],
) => {
  const app = new Hono();
  app.use(
    '*',
    jouska({
      config: defineConfig({ ...(defaults !== undefined ? { defaults } : {}), routes }),
      fetchImpl: upstream,
      onProxy: (event) => events.push(event),
    }),
  );
  return app;
};

const get = (app: Hono, path: string, init?: RequestInit) =>
  app.request(new Request(`https://p.dev${path}`, init));

const echoed = async (res: Response): Promise<string | null> =>
  ((await res.json()) as Record<string, string | null>).requestId;

describe('request ID stamping', () => {
  // Every echo route strips the prefix so `/api/echo` reaches the upstream as
  // `/echo`, which is the only path the echo serves — a 502 there would carry
  // no echoed field to compare against.
  it('stamps the same value onto the upstream request and the response', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      [{ id: 'api', match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true }],
      events,
    );
    const res = await get(app, '/api/echo');

    const received = await echoed(res);
    expect(res.headers.get('x-request-id')).toBe(received);
    expect(events[0]?.requestId).toBe(received);
    // No cf-ray reaches the app in tests, so the value is the UUID fallback:
    // version 4, with the version nibble set.
    expect(received).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('adopts cf-ray as the ID before falling back to a UUID', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      [{ id: 'api', match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true }],
      events,
    );
    // The format is the edge's own: 16 hex digits, a dash, a PoP code.
    const res = await get(app, '/api/echo', {
      headers: { 'cf-ray': '8f14e45fceea167a-SJC' },
    });

    expect(res.headers.get('x-request-id')).toBe('8f14e45fceea167a-SJC');
    expect(events[0]?.requestId).toBe('8f14e45fceea167a-SJC');
  });

  it('ignores the caller-supplied value when trustInbound is off', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      [{ id: 'api', match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true }],
      events,
    );
    const res = await get(app, '/api/echo', {
      headers: { 'x-request-id': 'the-callers-own-id' },
    });

    const received = await echoed(res);
    expect(received).not.toBe('the-callers-own-id');
    expect(res.headers.get('x-request-id')).toBe(received);
    expect(events[0]?.requestId).toBe(received);
  });

  it('reuses a well-formed caller value when trustInbound is on', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      [
        {
          id: 'api',
          match: { path: '/api' },
          upstream: 'origin.test',
          stripPrefix: true,
          requestId: { trustInbound: true },
        },
      ],
      events,
    );
    const res = await get(app, '/api/echo', { headers: { 'x-request-id': 'trace-42_abc' } });

    const received = await echoed(res);
    expect(received).toBe('trace-42_abc');
    expect(res.headers.get('x-request-id')).toBe('trace-42_abc');
    expect(events[0]?.requestId).toBe('trace-42_abc');
  });

  it('replaces a caller value that could inject into a log line', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      [
        {
          id: 'api',
          match: { path: '/api' },
          upstream: 'origin.test',
          stripPrefix: true,
          requestId: { trustInbound: true },
        },
      ],
      events,
    );
    // CR and LF are rejected by the runtime before jouska ever sees them, but a
    // carriage return is not the only thing that can wreck a log line: ESC and
    // DEL both ride through the runtime's header validation and would corrupt
    // the JSON line (or the terminal reading it). The shape rule refuses both.
    const res = await get(app, '/api/echo', {
      headers: { 'x-request-id': 'ok\x1Binjected:y' },
    });

    const received = await echoed(res);
    expect(received).not.toContain('\x1B');
    expect(received).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('replaces a caller value that is only too long, keeping the whole shape rule', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      [
        {
          id: 'api',
          match: { path: '/api' },
          upstream: 'origin.test',
          stripPrefix: true,
          requestId: { trustInbound: true },
        },
      ],
      events,
    );
    const res = await get(app, '/api/echo', { headers: { 'x-request-id': 'a'.repeat(65) } });

    const received = await echoed(res);
    expect(received).not.toBe('a'.repeat(65));
    expect(received?.length).toBe(36);
  });

  it('takes trustInbound from the table defaults', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      [{ id: 'api', match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true }],
      events,
      { requestId: { trustInbound: true } },
    );
    const res = await get(app, '/api/echo', { headers: { 'x-request-id': 'from-the-table' } });
    expect(await echoed(res)).toBe('from-the-table');
  });

  it('cannot be forged through requestHeaders, which the schema refuses', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/api' },
            upstream: 'origin.test',
            requestHeaders: { set: { 'x-request-id': 'forged' } },
          },
        ],
      }),
    ).toThrow(/may not write/);
  });

  it('gives every failover candidate the same ID', async () => {
    const events: ProxyEvent[] = [];
    // The first candidate throws, so the walk hands the request to the second:
    // the echoed value proves the survivor was reached and names the ID every
    // attempt in that walk carried. The upstream records what it saw, per host.
    const seen: string[] = [];
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: [{ id: 'api', match: { path: '/api' }, upstreams: ['a.test', 'b.test'] }],
        }),
        fetchImpl: async (input) => {
          const request = input instanceof Request ? input : new Request(input);
          const url = new URL(request.url);
          if (url.host !== 'b.test') {
            throw new Error('unreachable');
          }
          seen.push(request.headers.get('x-request-id')!);
          return Response.json({ ok: true });
        },
        onProxy: (event) => events.push(event),
      }),
    );
    const res = await get(app, '/api/echo');

    expect(res.status).toBe(200);
    expect(seen).toEqual([events[0]?.requestId]);
  });

  it('stamps the ID onto a failure the upstream never answered', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      [{ id: 'api', match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true }],
      events,
    );
    const res = await get(app, '/api/anything');

    expect(res.status).toBe(502);
    const stamped = res.headers.get('x-request-id');
    expect(stamped).not.toBeNull();
    expect(events[0]?.requestId).toBe(stamped);
  });

  it('stamps the ID onto a refusal that never reached an upstream', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      [
        {
          id: 'api',
          match: { path: '/api' },
          upstream: 'origin.test',
          requestPolicy: { allowedMethods: ['GET'] },
        },
      ],
      events,
    );
    const res = await get(app, '/api/echo', { method: 'POST' });

    expect(res.status).toBe(405);
    const stamped = res.headers.get('x-request-id');
    expect(stamped).not.toBeNull();
    expect(events[0]?.requestId).toBe(stamped);
  });

  it('lets responseHeaders.remove take the header off the client response', async () => {
    // Deliberately allowed, and documented: an operator who removes it keeps
    // the value in the access log and on the upstream request, at the cost of
    // the client no longer being able to quote it back.
    const app = appWith([
      {
        id: 'api',
        match: { path: '/api' },
        upstream: 'origin.test',
        stripPrefix: true,
        responseHeaders: { remove: ['x-request-id'] },
      },
    ]);
    const res = await get(app, '/api/echo');
    expect(res.headers.get('x-request-id')).toBeNull();
  });

  it('resolves a fresh ID per request rather than reusing one', async () => {
    const events: ProxyEvent[] = [];
    const app = appWith(
      [{ id: 'api', match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true }],
      events,
    );
    const first = await echoed(await get(app, '/api/echo'));
    const second = await echoed(await get(app, '/api/echo'));
    expect(first).not.toBe(second);
  });
});
