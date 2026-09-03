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
/** Set by a test that needs the upstream to answer with a 5xx instead of failing. */
let fivehundreds = false;
/** Set by a test that needs the upstream to start answering 404 where it answered 200. */
let answering404 = false;

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
  if (fivehundreds) {
    // An answer, not an outage: the upstream is alive and saying something.
    return new Response('down', { status: 503, headers: { 'content-type': 'text/css' } });
  }
  if (answering404) {
    return new Response('gone', { status: 404, headers: { 'content-type': 'text/css' } });
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
    // The body follows the request's language, which is what `Vary` warns about;
    // a cached zh entry served to an en visitor is the failure this guards.
    case '/lang.css':
      return new Response(`body{--lang:${request.headers.get('accept-language') ?? 'none'}}`, {
        headers: { 'content-type': 'text/css', vary: 'accept-language' },
      });
    case '/missing':
      return new Response('nope', { status: 404, headers: { 'content-type': 'text/css' } });
    case '/cookie-missing': {
      const headers = new Headers({ 'content-type': 'text/css' });
      headers.append('set-cookie', 'a=1');
      return new Response('nope', { status: 404, headers });
    }
    default:
      return new Response('not found', { status: 404 });
  }
};

/**
 * An in-memory store, so most cases run without depending on the platform cache.
 * One case below deliberately uses `caches.default` instead.
 */
const memoryStore = (): ResponseCacheStore & { urls: Set<string> } => {
  const meta = new Map<
    string,
    { status: number; statusText: string; headers: [string, string][] }
  >();
  const bodies = new Map<string, ArrayBuffer>();
  const urls = new Set<string>();
  return {
    urls,
    match: async (key) => {
      const body = bodies.get(key.url);
      const head = meta.get(key.url);
      return body === undefined || head === undefined
        ? undefined
        : new Response(body, { ...head, headers: head.headers });
    },
    put: async (key, response) => {
      urls.add(key.url);
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
  fivehundreds = false;
  answering404 = false;
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

describe('the configurable key', () => {
  it('serves twenty tracking-parameter spellings from one upstream trip', async () => {
    const app = appWith(
      cachedRoute({ cache: { ttlSeconds: 300, key: { query: { ignore: ['utm_source'] } } } }),
      memoryStore(),
    );
    const first = await fetchWith(app, '/a.css?utm_source=newsletter');
    expect(first.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    revision = 1;
    for (let index = 2; index <= 20; index += 1) {
      const response = await fetchWith(app, `/a.css?utm_source=variant-${index}`);
      expect(response.headers.get(CACHE_STATE_HEADER)).toBe('hit');
      expect(await response.text()).toBe('body{--r:0}');
    }
    expect(trips).toBe(1);
  });

  it('keeps a varying response per covered header value', async () => {
    // The upstream sends `Vary: accept-language`; folding that header into the
    // key is what makes storing the response correct instead of a cross-visitor leak.
    const store = memoryStore();
    const app = appWith(
      cachedRoute({ cache: { ttlSeconds: 300, key: { headers: ['accept-language'] } } }),
      store,
    );
    const zh = await fetchWith(app, '/lang.css', { headers: { 'accept-language': 'zh' } });
    expect(zh.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(await zh.text()).toBe('body{--lang:zh}');

    const en = await fetchWith(app, '/lang.css', { headers: { 'accept-language': 'en' } });
    expect(en.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(await en.text()).toBe('body{--lang:en}');

    // Two entries, one per language: distinct keys, distinct bodies, both served
    // from the store on a repeat.
    expect(store.urls.size).toBe(2);
    const zhAgain = await fetchWith(app, '/lang.css', { headers: { 'accept-language': 'zh' } });
    expect(zhAgain.headers.get(CACHE_STATE_HEADER)).toBe('hit');
    expect(await zhAgain.text()).toBe('body{--lang:zh}');
    expect(trips).toBe(2);
  });

  it('refuses the same varying response while headers stay unconfigured', async () => {
    const app = appWith(cachedRoute(), memoryStore());
    for (const language of ['zh', 'en']) {
      const response = await fetchWith(app, '/lang.css', {
        headers: { 'accept-language': language },
      });
      expect(response.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    }
    expect(trips).toBe(2);
  });

  it('reports a Vary refusal as a miss, not a bypass', async () => {
    // The plan existed — the request could take part — so this is a miss. `bypass`
    // is reserved for requests that could never take part at all.
    const app = appWith(cachedRoute(), memoryStore());
    await fetchWith(app, '/lang.css', { headers: { 'accept-language': 'zh' } });
    expect(events[0]!.cache).toBe('miss');
  });
});

describe('caching a signed-link route', () => {
  const secret = 'link-secret-0123456789abcdef';
  const sign = async (path: string, expires: number): Promise<string> => {
    const message = new Uint8Array([
      ...new TextEncoder().encode(path),
      ...new TextEncoder().encode('\n'),
      ...new TextEncoder().encode(String(expires)),
    ]);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const raw = await crypto.subtle.sign('HMAC', key, message);
    return btoa(String.fromCharCode(...new Uint8Array(raw)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
  };

  /** A signed route with the cache on and both link parameters folded out. */
  const signedCachedRoute = () => [
    {
      match: { path: '/' },
      upstream: 'origin.test',
      signedLink: { secretBinding: 'KEY' },
      cache: { ttlSeconds: 300, key: { query: { ignore: ['sig', 'exp'] } } },
    },
  ];

  const fetchWithSigned = async (app: Hono, path: string): Promise<Response> => {
    const scheduled: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (work: Promise<unknown>) => scheduled.push(work),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
    const response = await app.fetch(new Request(`https://p.dev${path}`), { KEY: secret }, ctx);
    const buffered = new Response(await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    await Promise.all(scheduled);
    return buffered;
  };

  it('serves a fresh expiry from the same entry once the key folds sig and exp out', async () => {
    const app = appWith(signedCachedRoute(), memoryStore());
    const farFuture = Math.floor(Date.now() / 1000) + 3600;
    const later = farFuture + 600;
    const first = await fetchWithSigned(
      app,
      `/a.css?sig=${await sign('/a.css', farFuture)}&exp=${farFuture}`,
    );
    expect(first.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    // A different expiry is a different link; with the two parameters out of
    // the key it is still one cache entry, which is the point of folding them.
    const second = await fetchWithSigned(
      app,
      `/a.css?sig=${await sign('/a.css', later)}&exp=${later}`,
    );
    expect(second.headers.get(CACHE_STATE_HEADER)).toBe('hit');
    expect(trips).toBe(1);
  });
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

  it('stores the injected bytes, and an inject edit starts a new entry', async () => {
    // What is stored must be the post-injection document — the cache sits
    // outside the rewriter, so the entry is the last place the injection could
    // be lost. And since the key carries a fingerprint of the whole route,
    // editing `inject` is a different key: the old entry is unreachable by
    // construction, with no invalidation sweep needed.
    const store = memoryStore();
    const route = (headEnd: string) =>
      cachedRoute({
        // bodyStart, not headEnd: the stub page has no `<head>`, and an anchor
        // that misses is a real miss, not an insertion.
        bodyRewrite: { rewriteLinks: false, inject: { bodyStart: headEnd } },
        cache: { ttlSeconds: 300, contentTypes: ['text/html'] },
      })[0]!;

    const first = await fetchWith(appWith([route('<B1>')], store), '/page.html');
    expect(first.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(await first.text()).toContain('<B1>');

    const hit = await fetchWith(appWith([route('<B1>')], store), '/page.html');
    expect(hit.headers.get(CACHE_STATE_HEADER)).toBe('hit');
    expect(await hit.text()).toContain('<B1>');

    // One anchor edited — the case an operator hits when they retune a banner.
    const edited = await fetchWith(appWith([route('<B2>')], store), '/page.html');
    expect(edited.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    const text = await edited.text();
    expect(text).toContain('<B2>');
    expect(text).not.toContain('<B1>');
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

describe('the cold-miss lock', () => {
  /**
   * Fires `count` requests at once and reads every body, the way a burst of
   * visitors arrives: all before the first has been stored.
   */
  const burst = async (app: Hono, count: number): Promise<Response[]> =>
    Promise.all(Array.from({ length: count }, () => fetchWith(app, '/a.css')));

  it('collapses a burst of cold misses onto one upstream request', async () => {
    const app = appWith(cachedRoute(), memoryStore());
    const responses = await burst(app, 50);
    expect(trips).toBe(1);
    // Every visitor gets the same bytes, whichever path delivered them.
    for (const response of responses) {
      expect(await response.text()).toBe('body{--r:0}');
    }
  });

  it('degrades to per-request fetching when the route opts out', async () => {
    const app = appWith(
      cachedRoute({ cache: { ttlSeconds: 300, lockMisses: false } }),
      memoryStore(),
    );
    await burst(app, 5);
    expect(trips).toBe(5);
  });

  it('reports what happened on both sides of the lock', async () => {
    const app = appWith(cachedRoute(), memoryStore());
    await burst(app, 3);
    const states = events.map((event) => event.cache);
    // Exactly one caller missed and filled; the rest were served from the entry
    // the leader put there.
    expect(states.filter((state) => state === 'miss')).toHaveLength(1);
    expect(states.filter((state) => state === 'hit')).toHaveLength(2);
    expect(events.every((event) => event.attempts <= 1)).toBe(true);
  });
});

describe('stale-if-error', () => {
  // SWR zeroed so the failure path is the only way past the TTL: with the
  // default window this route would still be serving stale for another minute,
  // and the test would pass without exercising the code it is here for.
  const errorRoute = () =>
    cachedRoute({
      cache: { ttlSeconds: 1, staleWhileRevalidateSeconds: 0, staleIfError: { seconds: 3600 } },
    });

  const agePastTtl = () => new Promise((resolve) => setTimeout(resolve, 1_100));

  it('serves the expired entry when the upstream refuses to answer', async () => {
    const app = appWith(errorRoute(), memoryStore());
    await fetchWith(app, '/a.css');
    await agePastTtl();

    failing = true;
    const served = await fetchWith(app, '/a.css');
    expect(served.headers.get(CACHE_STATE_HEADER)).toBe('stale_error');
    expect(await served.text()).toBe('body{--r:0}');
    // Named so it can be filtered: the cache, not the origin, kept the site up.
    expect(events[1]!.cache).toBe('stale_error');
    // The delivery succeeded and carries the real attempt count, but the event
    // keeps nothing of the upstream's failure — the state is the signal for that.
    expect(events[1]!.outcome).toBe('ok');
    expect(events[1]!.attempts).toBe(1);
  });

  it('does not serve stale on a failure the route did not opt into', async () => {
    const app = appWith(
      cachedRoute({
        cache: {
          ttlSeconds: 1,
          staleWhileRevalidateSeconds: 0,
          staleIfError: { seconds: 3600, on: ['timeout'] },
        },
      }),
      memoryStore(),
    );
    await fetchWith(app, '/a.css');
    await agePastTtl();

    failing = true;
    const served = await fetchWith(app, '/a.css');
    expect(served.headers.get(CACHE_STATE_HEADER)).toBeNull();
    expect(served.status).not.toBe(200);
  });

  it('treats a 5xx as an answer unless the route opted in', async () => {
    const app = appWith(errorRoute(), memoryStore());
    await fetchWith(app, '/a.css');
    await agePastTtl();

    fivehundreds = true;
    // The upstream spoke — a 503 is an answer, and jouska's own 5xx relays it
    // rather than covering it with yesterday's page.
    const served = await fetchWith(app, '/a.css');
    expect(served.status).toBe(503);
    expect(served.headers.get(CACHE_STATE_HEADER)).toBe('miss');
  });

  it('serves stale on a 5xx when the route opted in', async () => {
    const app = appWith(
      cachedRoute({
        cache: {
          ttlSeconds: 1,
          staleWhileRevalidateSeconds: 0,
          staleIfError: { seconds: 3600, on: ['timeout', 'unreachable', '5xx'] },
        },
      }),
      memoryStore(),
    );
    await fetchWith(app, '/a.css');
    await agePastTtl();

    fivehundreds = true;
    const served = await fetchWith(app, '/a.css');
    expect(served.status).toBe(200);
    expect(served.headers.get(CACHE_STATE_HEADER)).toBe('stale_error');
    expect(await served.text()).toBe('body{--r:0}');
  });

  it('drops the expired entry once the stale-if-error window ends', async () => {
    // A one-second window, so the test can wait it out: the memory store never
    // evicts on its own, so the only thing ending this entry's life is the
    // read's own arithmetic.
    const app = appWith(
      cachedRoute({
        cache: { ttlSeconds: 1, staleWhileRevalidateSeconds: 0, staleIfError: { seconds: 1 } },
      }),
      memoryStore(),
    );
    await fetchWith(app, '/a.css');
    await agePastTtl();

    failing = true;
    const inside = await fetchWith(app, '/a.css');
    expect(inside.headers.get(CACHE_STATE_HEADER)).toBe('stale_error');
    // Past ttl + the window, the entry no longer serves even on the failure path.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const outside = await fetchWith(app, '/a.css');
    expect(outside.headers.get(CACHE_STATE_HEADER)).toBeNull();
    expect(outside.status).not.toBe(200);
  });

  it('keeps serving stale when the upstream keeps failing, one visitor after another', async () => {
    const app = appWith(errorRoute(), memoryStore());
    await fetchWith(app, '/a.css');
    await agePastTtl();

    failing = true;
    const first = await fetchWith(app, '/a.css');
    const second = await fetchWith(app, '/a.css');
    expect(first.headers.get(CACHE_STATE_HEADER)).toBe('stale_error');
    expect(second.headers.get(CACHE_STATE_HEADER)).toBe('stale_error');
    expect(events[1]!.attempts).toBe(1);
    expect(events[2]!.attempts).toBe(1);
  });
});

describe('negative caching', () => {
  it('caches an opted-in 404 for its window, then goes back to the upstream', async () => {
    const app = appWith(
      cachedRoute({
        cache: { ttlSeconds: 300, staleWhileRevalidateSeconds: 0, statusTtlSeconds: { 404: 1 } },
      }),
      memoryStore(),
    );
    const first = await fetchWith(app, '/missing');
    expect(first.status).toBe(404);
    expect(first.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    const second = await fetchWith(app, '/missing');
    expect(second.status).toBe(404);
    expect(second.headers.get(CACHE_STATE_HEADER)).toBe('hit');
    expect(trips).toBe(1);

    // Past the scanner's window, the next request asks the upstream again.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const third = await fetchWith(app, '/missing');
    expect(third.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(trips).toBe(2);
  });

  it('refuses a 404 whose response sets a cookie, as it would a 200', async () => {
    const app = appWith(
      cachedRoute({ cache: { ttlSeconds: 300, statusTtlSeconds: { 404: 60 } } }),
      memoryStore(),
    );
    await fetchWith(app, '/cookie-missing');
    const second = await fetchWith(app, '/cookie-missing');
    expect(second.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(trips).toBe(2);
  });

  it('does not cache 404s at all when no window was named', async () => {
    const app = appWith(cachedRoute(), memoryStore());
    for (let i = 0; i < 3; i += 1) {
      const response = await fetchWith(app, '/missing');
      expect(response.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    }
    expect(trips).toBe(3);
  });

  it('cannot cover an upstream 404 with a previously stored 200', async () => {
    // A 200 is stored; the upstream then answers 404 for the same URL past the
    // healthy window. A 404 is an answer, not an outage, so stale-if-error does
    // not fire for it even though the route opted in — the old 200 is not dug
    // out to cover it, and the 404 itself is uncached (no window named).
    const app = appWith(
      cachedRoute({
        cache: {
          ttlSeconds: 1,
          staleWhileRevalidateSeconds: 0,
          staleIfError: { seconds: 3600 },
        },
      }),
      memoryStore(),
    );
    await fetchWith(app, '/a.css');
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    answering404 = true;
    const served = await fetchWith(app, '/a.css');
    expect(served.status).toBe(404);
    expect(served.headers.get(CACHE_STATE_HEADER)).toBe('miss');
    expect(await served.text()).toBe('gone');
    expect(trips).toBe(2);
  });
});
