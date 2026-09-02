import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska, type ProxyEvent } from '../../src/middleware/jouska';
import { CACHE_STATE_HEADER, type ResponseCacheStore } from '../../src/internal/response-cache';

/** Counts upstream trips, so "served from cache" is proved rather than assumed. */
let trips = 0;
/** Bumped by a test that needs the upstream's answer to change between calls. */
let revision = 0;

/** Set by a test that needs the upstream to start failing. */
let failing = false;

const answer = (request: Request, body: string | null, init: ResponseInit): Response =>
  // A real `fetch` answers HEAD with no body. Without this the HEAD cases would
  // store a body that a real deployment never has.
  new Response(request.method === 'HEAD' ? null : body, init);

const upstream: typeof fetch = async (input) => {
  const request = input instanceof Request ? input : new Request(input);
  const url = new URL(request.url);
  trips += 1;
  if (failing) {
    throw new Error('upstream down');
  }
  switch (url.pathname) {
    case '/a.css':
      return answer(request, `body{--r:${revision}}`, { headers: { 'content-type': 'text/css' } });
    case '/linked.css':
      return new Response('body{background:url(https://origin.test/bg.png)}', {
        headers: { 'content-type': 'text/css' },
      });
    case '/page.html':
      return new Response(
        `<html><body><a href="https://origin.test/r:${revision}">n</a></body></html>`,
        {
          headers: { 'content-type': 'text/html' },
        },
      );
    case '/private.css':
      return new Response('body{}', {
        headers: { 'content-type': 'text/css', 'cache-control': 'private, max-age=600' },
      });
    case '/cookie.css': {
      const headers = new Headers({ 'content-type': 'text/css' });
      headers.append('set-cookie', 'a=1');
      return new Response('body{}', { headers });
    }
    case '/varying.css':
      return new Response('body{}', {
        headers: { 'content-type': 'text/css', vary: 'cookie' },
      });
    case '/missing':
      return new Response('nope', { status: 404, headers: { 'content-type': 'text/css' } });
    default:
      return new Response('not found', { status: 404 });
  }
};

/**
 * An in-memory store, so most cases run without depending on the platform cache.
 * One case below deliberately uses `caches.default` instead.
 */
const memoryStore = (): ResponseCacheStore => {
  const meta = new Map<
    string,
    { status: number; statusText: string; headers: [string, string][] }
  >();
  const bodies = new Map<string, ArrayBuffer>();
  return {
    match: async (key) => {
      const body = bodies.get(key.url);
      const head = meta.get(key.url);
      return body === undefined || head === undefined
        ? undefined
        : new Response(body, { ...head, headers: head.headers });
    },
    put: async (key, response) => {
      meta.set(key.url, {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
      });
      bodies.set(key.url, await response.arrayBuffer());
    },
  };
};

const events: ProxyEvent[] = [];

const appWith = (routes: ConfigInput['routes'], store?: ResponseCacheStore) => {
  const app = new Hono();
  app.use(
    '*',
    jouska({
      config: defineConfig({ routes }),
      fetchImpl: upstream,
      ...(store !== undefined ? { cacheImpl: store } : {}),
      onProxy: (event) => events.push(event),
    }),
  );
  return app;
};

/**
 * Issues a request with a real `ExecutionContext` and waits for whatever it
 * scheduled.
 *
 * Cache writes and background refreshes go through `waitUntil`, so a test that
 * did not await them would race its own next request. Verified: Hono throws
 * `This context has no ExecutionContext` from `app.request()`, which is why the
 * context is supplied here rather than relying on the middleware's fallback.
 */
const fetchWith = async (app: Hono, path: string, init?: RequestInit): Promise<Response> => {
  const scheduled: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (work: Promise<unknown>) => scheduled.push(work),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const response = await app.fetch(new Request(`https://p.dev${path}`, init), {}, ctx);
  // Read the body before awaiting the writes: a cache write reads the clone, and
  // holding both open is exactly what the streaming path has to survive.
  const buffered = new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  await Promise.all(scheduled);
  return buffered;
};

const cachedRoute = (extra: Record<string, unknown> = {}) => [
  { match: { path: '/' }, upstream: 'origin.test', cache: { ttlSeconds: 300 }, ...extra },
];

beforeEach(() => {
  trips = 0;
  revision = 0;
  failing = false;
  events.length = 0;
});

describe('serving from the cache', () => {
  it('goes to the upstream once and serves the second request from the entry', async () => {
    const app = appWith(cachedRoute(), memoryStore());
    const first = await fetchWith(app, '/a.css');
    expect(first.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(await first.text()).toBe('body{--r:0}');

    revision = 1;
    const second = await fetchWith(app, '/a.css');
    expect(second.headers.get(CACHE_STATE_HEADER)).toBe('hit');
    // The upstream's answer changed and the visitor still gets the cached one,
    // which is the only proof that nothing went out.
    expect(await second.text()).toBe('body{--r:0}');
    expect(trips).toBe(1);
    expect(second.headers.get('age')).toBe('0');
  });

  it('reports hit and miss to onProxy, with no upstream attempt on a hit', async () => {
    const app = appWith(cachedRoute(), memoryStore());
    await fetchWith(app, '/a.css');
    await fetchWith(app, '/a.css');
    expect(events.map((event) => event.cache)).toEqual(['miss', 'hit']);
    expect(events[1]!.attempts).toBe(0);
    expect(events[1]!.status).toBe(200);
  });

  it('says nothing at all on a route without caching', async () => {
    const app = appWith([{ match: { path: '/' }, upstream: 'origin.test' }], memoryStore());
    const response = await fetchWith(app, '/a.css');
    expect(response.headers.get(CACHE_STATE_HEADER)).toBeNull();
    expect(events[0]!.cache).toBeUndefined();
  });

  it('does nothing when the block is present but switched off', async () => {
    const app = appWith(cachedRoute({ cache: { enabled: false, ttlSeconds: 300 } }), memoryStore());
    await fetchWith(app, '/a.css');
    await fetchWith(app, '/a.css');
    expect(trips).toBe(2);
    expect(events[0]!.cache).toBeUndefined();
  });

  it('caches the rewritten bytes, so a hit needs no second rewrite', async () => {
    const app = appWith(
      cachedRoute({ bodyRewrite: { contentTypes: ['text/css'] } }),
      memoryStore(),
    );
    const first = await fetchWith(app, '/linked.css');
    expect(await first.text()).toBe('body{background:url(https://p.dev/bg.png)}');
    const second = await fetchWith(app, '/linked.css');
    expect(second.headers.get(CACHE_STATE_HEADER)).toBe('hit');
    expect(await second.text()).toBe('body{background:url(https://p.dev/bg.png)}');
    expect(trips).toBe(1);
  });

  it('keeps GET and HEAD in separate entries, so a HEAD cannot empty a GET', async () => {
    const app = appWith(
      cachedRoute({ cache: { ttlSeconds: 300, methods: ['GET', 'HEAD'] } }),
      memoryStore(),
    );
    const head = await fetchWith(app, '/a.css', { method: 'HEAD' });
    expect(head.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    const get = await fetchWith(app, '/a.css');
    expect(get.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(await get.text()).toBe('body{--r:0}');
  });
});

describe('what is not cached', () => {
  const cases: [string, string][] = [
    ['a document, absent from the default content types', '/page.html'],
    ['a response the upstream marked private', '/private.css'],
    ['a response that sets a cookie', '/cookie.css'],
    ['a response varying on a header this key does not cover', '/varying.css'],
    ['a 404, because negative caching is not on offer', '/missing'],
  ];

  for (const [label, path] of cases) {
    it(`refuses ${label}`, async () => {
      const app = appWith(cachedRoute(), memoryStore());
      await fetchWith(app, path);
      const second = await fetchWith(app, path);
      expect(second.headers.get(CACHE_STATE_HEADER)).toBe('miss');
      expect(trips).toBe(2);
    });
  }

  it('bypasses a request carrying credentials, and says so', async () => {
    const app = appWith(cachedRoute(), memoryStore());
    const withCookie = await fetchWith(app, '/a.css', { headers: { cookie: 'session=1' } });
    expect(withCookie.headers.get(CACHE_STATE_HEADER)).toBe('bypass');
    // And nothing was stored for the next visitor to pick up.
    const anonymous = await fetchWith(app, '/a.css');
    expect(anonymous.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(events.map((event) => event.cache)).toEqual(['bypass', 'miss']);
  });

  it('bypasses a range request', async () => {
    const app = appWith(cachedRoute(), memoryStore());
    const response = await fetchWith(app, '/a.css', { headers: { range: 'bytes=0-3' } });
    expect(response.headers.get(CACHE_STATE_HEADER)).toBe('bypass');
  });

  it('bypasses a URL that already carries the key parameter', async () => {
    const app = appWith(cachedRoute(), memoryStore());
    const response = await fetchWith(app, '/a.css?__jouska_ck=forged');
    expect(response.headers.get(CACHE_STATE_HEADER)).toBe('bypass');
  });

  it('does not let one configuration read another entry', async () => {
    // The fingerprint in the key is what makes storing rewritten bytes safe.
    const store = memoryStore();
    const plain = appWith(cachedRoute(), store);
    const rewriting = appWith(cachedRoute({ bodyRewrite: { contentTypes: ['text/css'] } }), store);
    await fetchWith(plain, '/linked.css');
    const other = await fetchWith(rewriting, '/linked.css');
    expect(other.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(await other.text()).toBe('body{background:url(https://p.dev/bg.png)}');
    expect(trips).toBe(2);
  });
});

describe('rules cannot widen what is cacheable', () => {
  // Each endpoint carries exactly one uncacheable signal, so deleting that signal
  // leaves nothing else to do the refusing — otherwise the test would pass for the
  // wrong reason.
  for (const [label, removed, path] of [
    ['the upstream saying private', 'cache-control', '/private.css'],
    ['the upstream saying it varies', 'vary', '/varying.css'],
  ] as const) {
    it(`still refuses when a rule deletes ${label}`, async () => {
      // The rule removes the upstream's own statement about the response; the fact
      // it stated is unchanged, so the decision reads the upstream's headers.
      const app = appWith(cachedRoute({ responseHeaders: { remove: [removed] } }), memoryStore());
      await fetchWith(app, path);
      const second = await fetchWith(app, path);
      expect(second.headers.get(removed)).toBeNull();
      expect(second.headers.get(CACHE_STATE_HEADER)).toBe('miss');
      expect(trips).toBe(2);
    });
  }
});

describe('caching a rewritten document', () => {
  it('survives cloning the HTMLRewriter output', async () => {
    // Not the default — HTML is deliberately absent from `contentTypes` — but an
    // operator can add it, and that path tees a native HTMLRewriter stream into
    // both the client and the cache.
    const app = appWith(
      cachedRoute({
        bodyRewrite: {},
        cache: { ttlSeconds: 300, contentTypes: ['text/html'] },
      }),
      memoryStore(),
    );
    const first = await fetchWith(app, '/page.html');
    expect(await first.text()).toContain('href="https://p.dev/r:0"');
    revision = 1;
    const second = await fetchWith(app, '/page.html');
    expect(second.headers.get(CACHE_STATE_HEADER)).toBe('hit');
    expect(await second.text()).toContain('href="https://p.dev/r:0"');
    expect(trips).toBe(1);
  });
});

describe('HEAD entries', () => {
  it('serves a later HEAD from its own entry, body-less both times', async () => {
    const app = appWith(
      cachedRoute({ cache: { ttlSeconds: 300, methods: ['GET', 'HEAD'] } }),
      memoryStore(),
    );
    const first = await fetchWith(app, '/a.css', { method: 'HEAD' });
    expect(await first.text()).toBe('');
    const second = await fetchWith(app, '/a.css', { method: 'HEAD' });
    expect(second.headers.get(CACHE_STATE_HEADER)).toBe('hit');
    expect(await second.text()).toBe('');
    expect(trips).toBe(1);

    // And the GET that follows is not handed the empty body.
    const get = await fetchWith(app, '/a.css');
    expect(get.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(await get.text()).toBe('body{--r:0}');
  });
});

describe('stale-while-revalidate', () => {
  it('serves the stale entry and refreshes behind it', async () => {
    const app = appWith(
      cachedRoute({ cache: { ttlSeconds: 1, staleWhileRevalidateSeconds: 60 } }),
      memoryStore(),
    );
    expect((await fetchWith(app, '/a.css')).headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(trips).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    revision = 1;

    const stale = await fetchWith(app, '/a.css');
    expect(stale.headers.get(CACHE_STATE_HEADER)).toBe('stale');
    // The visitor past the TTL gets the old bytes immediately, not the wait.
    expect(await stale.text()).toBe('body{--r:0}');
    expect(trips).toBe(2);

    const refreshed = await fetchWith(app, '/a.css');
    expect(refreshed.headers.get(CACHE_STATE_HEADER)).toBe('hit');
    expect(await refreshed.text()).toBe('body{--r:1}');
    expect(trips).toBe(2);
  });

  it('keeps serving the stale entry when the refresh fails', async () => {
    const app = appWith(
      cachedRoute({ cache: { ttlSeconds: 1, staleWhileRevalidateSeconds: 60 } }),
      memoryStore(),
    );
    await fetchWith(app, '/a.css');
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    failing = true;
    const stale = await fetchWith(app, '/a.css');
    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe('body{--r:0}');

    // The failed refresh released its slot, so the next request past the TTL tries
    // again rather than being locked out of revalidating for good.
    failing = false;
    revision = 1;
    const retried = await fetchWith(app, '/a.css');
    expect(retried.headers.get(CACHE_STATE_HEADER)).toBe('stale');
    expect((await fetchWith(app, '/a.css')).headers.get(CACHE_STATE_HEADER)).toBe('hit');
  });

  it('goes to the upstream itself when the stale window is zero', async () => {
    const app = appWith(
      cachedRoute({ cache: { ttlSeconds: 1, staleWhileRevalidateSeconds: 0 } }),
      memoryStore(),
    );
    await fetchWith(app, '/a.css');
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    revision = 1;
    const second = await fetchWith(app, '/a.css');
    expect(second.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(await second.text()).toBe('body{--r:1}');
  });
});

describe('against the platform cache', () => {
  it('stores and serves through caches.default with the key jouska builds', async () => {
    // The rest of this file runs on an in-memory store; this case is what proves
    // the key is one the real Cache API accepts. Storage is isolated per test
    // file by the pool, so the entry cannot leak into another case.
    const app = appWith(cachedRoute());
    const first = await fetchWith(app, '/a.css');
    expect(first.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    revision = 1;
    const second = await fetchWith(app, '/a.css');
    expect(second.headers.get(CACHE_STATE_HEADER)).toBe('hit');
    expect(await second.text()).toBe('body{--r:0}');
    expect(trips).toBe(1);
  });

  it('is not fooled by the platform silently dropping a Set-Cookie entry', async () => {
    // workerd accepts the `put` and then answers `match` with a miss, so a
    // proxy that trusted `put` would report a hit rate it does not have.
    const app = appWith(cachedRoute());
    await fetchWith(app, '/cookie.css');
    const second = await fetchWith(app, '/cookie.css');
    expect(second.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(trips).toBe(2);
  });
});
