import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska, type ProxyEvent } from '../../src/middleware/jouska';
import type { ResponseCacheStore } from '../../src/internal/response-cache';
import { MIRROR_BODY_MAX_BYTES, MIRROR_HEADER } from '../../src/internal/traffic-mirror';

/**
 * Traffic mirroring, end to end.
 *
 * The whole point of a mirror is that the visitor cannot tell it is running, so
 * every test here is an assertion in two directions at once: what v2 received,
 * and what the visitor got anyway. The six acceptance criteria from issue #58
 * each have one test below.
 */

type RouteInput = ConfigInput['routes'][number];

/** A deferred, for tests that need to decide when the mirror target answers. */
const gate = (): { promise: Promise<Response>; open: (response: Response) => void } => {
  let open!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/** What the two upstreams saw, recorded per call. */
interface Sighting {
  host: string;
  method: string;
  path: string;
  mirrorHeader: string | null;
  requestId: string | null;
  body: string;
}

const sightings: Sighting[] = [];

/**
 * v1 answers instantly with its own payload; v2 records what it was sent and
 * answers, or does whatever the test asked of it. Everything else is 404.
 */
const fetchImpl: typeof fetch = async (input) => {
  const request = input instanceof Request ? input : new Request(input);
  const url = new URL(request.url);
  sightings.push({
    host: url.host,
    method: request.method,
    path: url.pathname + url.search,
    mirrorHeader: request.headers.get(MIRROR_HEADER),
    requestId: request.headers.get('x-request-id'),
    body: await request.text(),
  });
  if (url.host === 'v2.test') {
    return new Response('v2 payload', { headers: { 'content-type': 'text/plain' } });
  }
  if (url.pathname === '/api/echo') {
    return new Response('v1 payload', { headers: { 'content-type': 'text/plain' } });
  }
  return new Response('not found', { status: 404 });
};

const events: ProxyEvent[] = [];

const appWith = (routes: RouteInput[], store?: ResponseCacheStore) => {
  const app = new Hono();
  app.use(
    '*',
    jouska({
      config: defineConfig({ routes }),
      fetchImpl,
      ...(store !== undefined ? { cacheImpl: store } : {}),
      onProxy: (event) => events.push(event),
    }),
  );
  return app;
};

/** Issues a request with a real `ExecutionContext`, so background work is awaitable. */
const fetchWith = async (app: Hono, path: string, init?: RequestInit): Promise<Response> => {
  const scheduled: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (work: Promise<unknown>) => scheduled.push(work),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const response = await app.fetch(new Request(`https://p.dev${path}`, init), {}, ctx);
  const buffered = new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  await Promise.all(scheduled);
  return buffered;
};

/** The plain mirroring route the first criteria run against. */
const mirrored = (mirror: Record<string, unknown> = {}): RouteInput[] => [
  { match: { path: '/api' }, upstream: 'v1.test', mirror: { upstream: 'v2.test', ...mirror } },
];

beforeEach(() => {
  sightings.length = 0;
  events.length = 0;
});

describe('traffic mirroring', () => {
  it('mirrors a GET: the visitor gets v1, v2 gets the equivalent request, and v2 cannot be blamed for the wait (acceptance #1)', async () => {
    // The mirror target does not answer until the test lets it — if the visitor's
    // response waited on the copy, this test would deadlock rather than pass,
    // which is a stronger statement than any wall-clock measurement.
    const hold = gate();
    const mirrorFetch: typeof fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      sightings.push({
        host: url.host,
        method: request.method,
        path: url.pathname + url.search,
        mirrorHeader: request.headers.get(MIRROR_HEADER),
        requestId: request.headers.get('x-request-id'),
        body: await request.text(),
      });
      if (url.host === 'v2.test') {
        const response = await hold.promise;
        return response;
      }
      return new Response('v1 payload', { headers: { 'content-type': 'text/plain' } });
    };
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: mirrored() as ConfigInput['routes'],
        }),
        fetchImpl: mirrorFetch,
        onProxy: (event) => events.push(event),
      }),
    );

    const scheduled: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (work: Promise<unknown>) => scheduled.push(work),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
    const response = await app.fetch(new Request('https://p.dev/api/echo?q=1'), {}, ctx);
    // The visitor has their answer while the copy is still hanging on v2 — the
    // response headers are back, and nothing has opened the gate yet.
    expect(response.status).toBe(200);

    // Now let v2 answer, and only then wait out the background work: awaiting
    // it before the gate would deadlock on the very coupling this test forbids.
    hold.open(new Response('v2 payload'));
    await Promise.all(scheduled);
    expect(await response.text()).toBe('v1 payload');

    const event = events[0]!;
    const mirror = await event.mirror;
    expect(mirror).toMatchObject({ upstream: 'v2.test', outcome: 'answered' });

    // Two upstreams saw one request each: the primary and the copy.
    expect(sightings.map((s) => s.host).toSorted()).toEqual(['v1.test', 'v2.test']);
    const copy = sightings.find((s) => s.host === 'v2.test')!;
    expect(copy.method).toBe('GET');
    expect(copy.path).toBe('/api/echo?q=1');
    // The marker names the copy as a copy, and the request ID on it is the same
    // one the event reports — what makes the two upstreams' logs correlate.
    expect(copy.mirrorHeader).toBe('1');
    expect(copy.requestId).toBe(event.requestId);
    // The visitor's own response never carried the marker.
    expect(response.headers.get(MIRROR_HEADER)).toBeNull();
  });

  it('keeps the visitor untouched when the mirror target refuses, and says so on the event (acceptance #2)', async () => {
    const refusingMirror: typeof fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (new URL(request.url).host === 'v2.test') {
        throw new Error('connection refused');
      }
      return new Response('v1 payload', { headers: { 'content-type': 'text/plain' } });
    };
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({ routes: mirrored() as ConfigInput['routes'] }),
        fetchImpl: refusingMirror,
        onProxy: (event) => events.push(event),
      }),
    );
    const response = await fetchWith(app, '/api/echo');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('v1 payload');
    expect(events[0]).toMatchObject({ status: 200, outcome: 'ok' });
    expect(await events[0]!.mirror).toMatchObject({
      upstream: 'v2.test',
      outcome: 'unreachable',
    });
  });

  it('reports a timeout as its own outcome, still without touching the visitor (acceptance #2)', async () => {
    // Never resolves; only `AbortSignal.timeout` can end this request, which is
    // what makes the copy's independent short deadline the thing under test.
    const hangingMirror: typeof fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (new URL(request.url).host === 'v2.test') {
        // Hangs, and honours the signal the way a real fetch would — which is
        // what lets the copy's own short deadline be the thing that ends it.
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'TimeoutError'));
          });
        });
      }
      return new Response('v1 payload', { headers: { 'content-type': 'text/plain' } });
    };
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: mirrored({ timeoutMs: 50 }) as ConfigInput['routes'],
        }),
        fetchImpl: hangingMirror,
        onProxy: (event) => events.push(event),
      }),
    );
    const response = await fetchWith(app, '/api/echo');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('v1 payload');
    expect(await events[0]!.mirror).toMatchObject({ outcome: 'timeout' });
  });

  it('does not mirror a POST under the default methods list (acceptance #3)', async () => {
    const app = appWith(mirrored() as ConfigInput['routes']);
    const response = await fetchWith(app, '/api/echo', { method: 'POST', body: 'charge once' });
    expect(response.status).toBe(200);
    // v1 only: the method list defaults to GET and HEAD, and a mirrored POST
    // would charge twice — which is why the default is this narrow.
    expect(sightings.map((s) => `${s.host} ${s.method}`)).toEqual(['v1.test POST']);
    expect(sightings[0]!.body).toBe('charge once');
    expect(events[0]!.mirror).toBeUndefined();
  });

  it('abandons the copy, never the request, when a mirrored body passes the buffer bound (acceptance #4)', async () => {
    const app = appWith(
      mirrored({ includeBody: true, methods: ['POST'] }) as ConfigInput['routes'],
    );
    // One byte past the cap, so the test fails if the bound ever moves silently.
    const body = 'x'.repeat(MIRROR_BODY_MAX_BYTES + 1);
    const response = await fetchWith(app, '/api/echo', { method: 'POST', body });
    // The main request carried every byte the visitor sent.
    expect(response.status).toBe(200);
    expect(sightings.map((s) => `${s.host} ${s.method}`)).toEqual(['v1.test POST']);
    expect(sightings[0]!.body.length).toBe(body.length);
    // The copy never left: over the bound is a report, not a truncated request.
    expect(await events[0]!.mirror).toMatchObject({ outcome: 'body_over_limit' });
    expect(events[0]!.mirror).toBeDefined();
  });

  it('mirrors a body at or under the cap intact', async () => {
    const app = appWith(
      mirrored({ includeBody: true, methods: ['POST'] }) as ConfigInput['routes'],
    );
    const body = 'y'.repeat(MIRROR_BODY_MAX_BYTES);
    await fetchWith(app, '/api/echo', { method: 'POST', body });
    expect(sightings.map((s) => `${s.host} ${s.method}`).toSorted()).toEqual([
      'v1.test POST',
      'v2.test POST',
    ]);
    const copy = sightings.find((s) => s.host === 'v2.test')!;
    expect(copy.body).toBe(body);
  });

  it('refuses a private mirror target at parse time (acceptance #5)', () => {
    // The same SSRF screen the primary upstream passes: parse time, not runtime.
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/api' }, upstream: 'v1.test', mirror: { upstream: '169.254.169.254' } },
        ],
      }),
    ).toThrow();
  });

  it('leaves the cache holding only v1 bytes — the copy never becomes an entry (acceptance #6)', async () => {
    const store: ResponseCacheStore & { urls: Set<string>; bodies: Map<string, ArrayBuffer> } =
      (() => {
        const meta = new Map<string, { status: number; headers: [string, string][] }>();
        const bodies = new Map<string, ArrayBuffer>();
        const urls = new Set<string>();
        return {
          urls,
          bodies,
          match: async (key) => {
            const body = bodies.get(key.url);
            const head = meta.get(key.url);
            return body === undefined || head === undefined
              ? undefined
              : new Response(body, { ...head, headers: head.headers });
          },
          put: async (key, response) => {
            urls.add(key.url);
            meta.set(key.url, { status: response.status, headers: [...response.headers] });
            bodies.set(key.url, await response.arrayBuffer());
          },
        };
      })();
    const app = appWith(
      [
        {
          match: { path: '/api' },
          upstream: 'v1.test',
          cache: { ttlSeconds: 300, contentTypes: ['text/plain'] },
          mirror: { upstream: 'v2.test' },
        },
      ] as ConfigInput['routes'],
      store,
    );

    const first = await fetchWith(app, '/api/echo');
    const second = await fetchWith(app, '/api/echo');
    expect(second.headers.get('x-jouska-cache')).toBe('hit');
    expect(await first.text()).toBe('v1 payload');
    expect(await second.text()).toBe('v1 payload');

    // One key, stored under the proxy's own URL, holding v1's bytes and
    // v1's content type — a mirror response is discarded unread, so it never
    // had a chance to become an entry.
    expect(store.urls.size).toBe(1);
    const [key] = store.urls;
    expect(new URL(key!).host).toBe('p.dev');
    expect(new TextDecoder().decode(store.bodies.get(key!)!)).toBe('v1 payload');
    expect(v2Trips()).toBe(2);

    // And the copy ran on the hit too: "what would v2 have made of this
    // request" is the question a mirror exists to answer, cache or no cache.
    expect(await events[0]!.mirror).toMatchObject({ outcome: 'answered' });
    expect(await events[1]!.mirror).toMatchObject({ outcome: 'answered' });
  });
});

/** How many of the recorded sightings were copies sent to v2. */
const v2Trips = (): number => sightings.filter((s) => s.host === 'v2.test').length;

describe('the mirror marker is a reserved name', () => {
  it('refuses a route that would write x-jouska-mirror itself', () => {
    // A route that could stamp the marker could disguise a real request as a
    // copy at the upstream that filters on it.
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/api' },
            upstream: 'v1.test',
            upstreamHeaders: { 'x-jouska-mirror': '0' },
          },
        ],
      }),
    ).toThrow(/x-jouska-mirror/);
  });

  it('does not stamp the marker on the primary request', async () => {
    const app = appWith(mirrored() as ConfigInput['routes']);
    await fetchWith(app, '/api/echo');
    expect(sightings.map((s) => `${s.host} ${s.mirrorHeader}`).toSorted()).toEqual([
      'v1.test null',
      'v2.test 1',
    ]);
  });
});
