import { describe, expect, it } from 'vitest';
import { defineConfig, type CacheConfig, type Route } from '../../src/config';
import { cacheVaryPart } from '../../src/internal/response-cache';
import {
  CACHE_STATE_HEADER,
  beginFlight,
  cacheKey,
  joinFlight,
  readCachedResponse,
  refreshOnce,
  requestCacheable,
  responseCacheable,
  routeFingerprint,
  storeCachedResponse,
  type ResponseCacheStore,
} from '../../src/internal/response-cache';

/** A route parsed by the real schema, so fingerprints see the real shape. */
const routeWith = (extra: Record<string, unknown> = {}): Route =>
  defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', ...extra }] }).routes[0]!;

const cacheWith = (extra: Partial<CacheConfig> = {}): CacheConfig => ({
  ...routeWith({ cache: {} }).cache!,
  ...extra,
});

/** Builds a key through the real default configuration, with optional overrides. */
const keyFor = (
  url: string,
  { cache = cacheWith(), headers = {} as Record<string, string> } = {},
): Request => cacheKey(new URL(url), 'GET', 'fp', cache, new Headers(headers))!;

/** The discriminator value jouska appends: fingerprint, method, folded-header hash. */
const discriminator = (key: Request): string => new URL(key.url).searchParams.get('__jouska_ck')!;

/**
 * An in-memory store. Bodies are buffered so an entry can be read more than
 * once, which the Cache API also allows and a stored `Response` object would not.
 */
const memoryStore = (): ResponseCacheStore & { entries: Map<string, ArrayBuffer> } => {
  const meta = new Map<
    string,
    { status: number; statusText: string; headers: [string, string][] }
  >();
  const entries = new Map<string, ArrayBuffer>();
  return {
    entries,
    match: async (key) => {
      const body = entries.get(key.url);
      const head = meta.get(key.url);
      if (body === undefined || head === undefined) {
        return undefined;
      }
      return new Response(body, { ...head, headers: head.headers });
    },
    put: async (key, response) => {
      meta.set(key.url, {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers],
      });
      entries.set(key.url, await response.arrayBuffer());
    },
  };
};

const cacheable = (headers: Record<string, string> = {}) =>
  new Response('body', { headers: { 'content-type': 'text/css', ...headers } });

describe('routeFingerprint', () => {
  it('is stable for the same configuration', () => {
    expect(routeFingerprint(routeWith())).toBe(routeFingerprint(routeWith()));
  });

  it('changes when a field that shapes the response changes', () => {
    expect(routeFingerprint(routeWith({ bodyRewrite: {} }))).not.toBe(
      routeFingerprint(routeWith()),
    );
    expect(routeFingerprint(routeWith({ rewriteHeaders: false }))).not.toBe(
      routeFingerprint(routeWith()),
    );
    expect(routeFingerprint(routeWith({ upstream: 'other.test' }))).not.toBe(
      routeFingerprint(routeWith()),
    );
    expect(routeFingerprint(routeWith({ responseHeaders: { set: { 'x-a': '1' } } }))).not.toBe(
      routeFingerprint(routeWith()),
    );
  });

  it('ignores the order fields were written in', () => {
    const a = defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', retries: 1 }] });
    const b = defineConfig({ routes: [{ retries: 1, upstream: 'o.test', match: { path: '/a' } }] });
    expect(routeFingerprint(a.routes[0]!)).toBe(routeFingerprint(b.routes[0]!));
  });

  it('changes when the cache key configuration changes', () => {
    // Different keys are how an old entry expires: the fingerprint pins the key
    // shape itself, so a configuration change cannot alias a stored response.
    expect(
      routeFingerprint(routeWith({ cache: { key: { query: 'none', headers: [] } } })),
    ).not.toBe(routeFingerprint(routeWith({ cache: {} })));
    expect(
      routeFingerprint(
        routeWith({ cache: { key: { query: 'all', headers: ['accept-language'] } } }),
      ),
    ).not.toBe(routeFingerprint(routeWith({ cache: {} })));
  });
});

describe('cache.key schema', () => {
  it('defaults to keeping everything and folding nothing', () => {
    const route = routeWith({ cache: {} });
    expect(route.cache!.key).toEqual({ query: 'all', headers: [] });
  });

  it('rejects naming ignore and include together', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'o.test',
            cache: { key: { query: { ignore: ['utm_source'], include: ['v'] } } },
          },
        ],
      }),
    ).toThrow(/one selection/);
  });

  it('rejects an empty selection object', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'o.test', cache: { key: { query: {} } } }],
      }),
    ).toThrow(/name parameters/);
  });

  it('rejects an empty ignore or include list', () => {
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/a' }, upstream: 'o.test', cache: { key: { query: { ignore: [] } } } },
        ],
      }),
    ).toThrow();
  });

  it('rejects folding cookie or authorization into the key', () => {
    // A request carrying either is never cached at all, so the entry would be
    // dead configuration with nothing to fold.
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'o.test',
            cache: { key: { query: 'all', headers: ['cookie'] } },
          },
        ],
      }),
    ).toThrow(/never cached/);
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'o.test',
            cache: { key: { query: 'all', headers: ['Authorization'] } },
          },
        ],
      }),
    ).toThrow(/never cached/);
  });

  it('lowercases and deduplicates the header list', () => {
    const route = routeWith({
      cache: { key: { query: 'all', headers: ['Accept-Language', 'ACCEPT-LANGUAGE', 'X-Seg'] } },
    });
    expect(route.cache!.key.headers).toEqual(['accept-language', 'x-seg']);
  });
});

describe('cacheKey', () => {
  it('keeps the request URL and adds a discriminator', () => {
    const url = new URL(keyFor('https://p.dev/a.css?v=1').url);
    expect(url.host).toBe('p.dev');
    expect(url.pathname).toBe('/a.css');
    expect(url.searchParams.get('v')).toBe('1');
    expect(discriminator(keyFor('https://p.dev/a.css?v=1'))).toMatch(/^fp\.GET\./);
    // The Cache API refuses a non-GET key, so the method lives in the URL.
    expect(keyFor('https://p.dev/a.css?v=1').method).toBe('GET');
  });

  it('separates GET from HEAD, whose response has no body', () => {
    const url = new URL('https://p.dev/a.css');
    const headers = new Headers();
    const cache = cacheWith();
    expect(cacheKey(url, 'GET', 'fp', cache, headers)!.url).not.toBe(
      cacheKey(url, 'HEAD', 'fp', cache, headers)!.url,
    );
  });

  it('separates two fingerprints', () => {
    const url = new URL('https://p.dev/a.css');
    const headers = new Headers();
    const cache = cacheWith();
    expect(cacheKey(url, 'GET', 'one', cache, headers)!.url).not.toBe(
      cacheKey(url, 'GET', 'two', cache, headers)!.url,
    );
  });

  it('declines a URL that already carries the parameter, rather than overwriting it', () => {
    // Overwriting would map two different requests onto one entry.
    expect(
      cacheKey(
        new URL('https://p.dev/a.css?__jouska_ck=x'),
        'GET',
        'fp',
        cacheWith(),
        new Headers(),
      ),
    ).toBeUndefined();
  });

  it('keeps the discriminator stable while folded headers are unconfigured', () => {
    // A header the key does not name must not touch the key, or every request
    // with a different User-Agent would fragment the cache for nothing.
    expect(discriminator(keyFor('https://p.dev/a.css', { headers: { 'user-agent': 'a' } }))).toBe(
      discriminator(keyFor('https://p.dev/a.css', { headers: { 'user-agent': 'b' } })),
    );
  });

  it('folds a configured header value into the discriminator', () => {
    const cache = cacheWith({ key: { query: 'all', headers: ['accept-language'] } });
    const zh = keyFor('https://p.dev/a.css', { cache, headers: { 'accept-language': 'zh' } });
    const en = keyFor('https://p.dev/a.css', { cache, headers: { 'accept-language': 'en' } });
    expect(discriminator(zh)).not.toBe(discriminator(en));
  });

  it('distinguishes a missing configured header from one present and empty', () => {
    // Collapsing them would hand two upstream-distinct requests one entry.
    const cache = cacheWith({ key: { query: 'all', headers: ['x-seg'] } });
    const absent = keyFor('https://p.dev/a.css', { cache });
    const empty = keyFor('https://p.dev/a.css', { cache, headers: { 'x-seg': '' } });
    expect(discriminator(absent)).not.toBe(discriminator(empty));
  });
});

describe('cacheKey query normalisation', () => {
  it('keeps every parameter by default, in sorted order', () => {
    const url = new URL(keyFor('https://p.dev/a.css?b=2&a=1').url);
    url.searchParams.delete('__jouska_ck');
    expect(url.toString()).toBe('https://p.dev/a.css?a=1&b=2');
  });

  it('maps twenty tracking-parameter spellings onto one entry', () => {
    const cache = cacheWith({ key: { query: { ignore: ['utm_source'] }, headers: [] } });
    const first = keyFor('https://p.dev/a.css?utm_source=1', { cache });
    for (let index = 2; index <= 20; index += 1) {
      const key = keyFor(`https://p.dev/a.css?utm_source=${index}`, { cache });
      expect(key.url).toBe(first.url);
    }
  });

  it('keeps only the parameters an include list names', () => {
    const cache = cacheWith({ key: { query: { include: ['v'] }, headers: [] } });
    const url = new URL(keyFor('https://p.dev/a.css?v=1&page=3', { cache }).url);
    expect(url.searchParams.get('v')).toBe('1');
    expect(url.searchParams.has('page')).toBe(false);
  });

  it('drops the whole search string under none', () => {
    const cache = cacheWith({ key: { query: 'none', headers: [] } });
    const url = new URL(keyFor('https://p.dev/a.css?v=1&page=3', { cache }).url);
    expect(url.search).toBe(
      `?__jouska_ck=${discriminator(keyFor('https://p.dev/a.css?v=1&page=3', { cache }))}`,
    );
  });

  it('folds equivalent encodings and an empty value spelling into one key', () => {
    const cache = cacheWith({ key: { query: 'all', headers: [] } });
    const spelled = keyFor('https://p.dev/a.css?%61=1&a', { cache });
    const plain = keyFor('https://p.dev/a.css?a=1&a=', { cache });
    expect(spelled.url).toBe(plain.url);
  });

  it('treats parameter names as case-sensitive', () => {
    const cache = cacheWith({ key: { query: { ignore: ['Tab'] }, headers: [] } });
    const dropped = keyFor('https://p.dev/a.css?Tab=1', { cache });
    const kept = keyFor('https://p.dev/a.css?tab=1', { cache });
    expect(dropped.url).not.toBe(kept.url);
    // A hit against one entry is not a hit against the other.
    expect(
      keyFor('https://p.dev/a.css?tab=1', {
        cache: cacheWith({ key: { query: { ignore: ['Tab'] }, headers: [] } }),
      }).url,
    ).toBe(kept.url);
  });

  it('collapses exactly duplicated pairs but keeps genuinely repeated ones', () => {
    const cache = cacheWith({ key: { query: 'all', headers: [] } });
    const deduplicated = keyFor('https://p.dev/a.css?a=1&a=1', { cache });
    const distinct = keyFor('https://p.dev/a.css?a=1&a=2', { cache });
    expect(new URL(deduplicated.url).searchParams.getAll('a')).toEqual(['1']);
    expect(new URL(distinct.url).searchParams.getAll('a')).toEqual(['1', '2']);
  });
});

describe('requestCacheable', () => {
  const cache = cacheWith();
  const request = (headers: Record<string, string> = {}) =>
    new Request('https://p.dev/a.css', { headers });

  it('admits a plain GET', () => {
    expect(requestCacheable(request(), 'GET', cache)).toBe(true);
  });

  it('refuses a method the cache does not cover', () => {
    expect(requestCacheable(request(), 'POST', cache)).toBe(false);
    expect(requestCacheable(request(), 'HEAD', cacheWith({ methods: ['GET'] }))).toBe(false);
  });

  it('refuses a request carrying credentials', () => {
    expect(requestCacheable(request({ cookie: 'a=1' }), 'GET', cache)).toBe(false);
    expect(requestCacheable(request({ authorization: 'Bearer x' }), 'GET', cache)).toBe(false);
  });

  it('refuses a range request', () => {
    expect(requestCacheable(request({ range: 'bytes=0-99' }), 'GET', cache)).toBe(false);
  });

  it('refuses a WebSocket handshake, which no stored response can satisfy', () => {
    expect(requestCacheable(request({ upgrade: 'websocket' }), 'GET', cache)).toBe(false);
    expect(requestCacheable(request({ upgrade: 'WebSocket' }), 'GET', cache)).toBe(false);
  });
});

describe('responseCacheable', () => {
  const cache = cacheWith();
  /** The common case: nothing was rewritten, so both views agree. */
  const asIs = (response: Response) => responseCacheable(response, response.headers, cache);

  it('admits a static asset', () => {
    expect(asIs(cacheable())).toBe(true);
  });

  it('refuses anything without a window, 200 included', () => {
    for (const status of [204, 206, 301, 304, 404, 500]) {
      expect(asIs(new Response(null, { status, headers: { 'content-type': 'text/css' } }))).toBe(
        false,
      );
    }
    // An entry for 200 whose window the operator closed with 0 is refused too.
    expect(
      responseCacheable(
        cacheable(),
        cacheable().headers,
        cacheWith({ statusTtlSeconds: { 200: 0 } }),
      ),
    ).toBe(false);
  });

  it('admits a status the operator gave a window, with the vetoes still standing', () => {
    const optedIn = cacheWith({ statusTtlSeconds: { 301: 3600, 404: 60, 410: 60 } });
    for (const status of [301, 404, 410]) {
      expect(
        responseCacheable(
          new Response(null, { status, headers: { 'content-type': 'text/css' } }),
          new Headers({ 'content-type': 'text/css' }),
          optedIn,
        ),
      ).toBe(true);
    }
    // Opting in by code does not lift the upstream's veto: an opted-in 404 that
    // sets a cookie or varies is still refused, exactly as a 200 would be.
    const cookied = new Headers({ 'content-type': 'text/css' });
    cookied.append('set-cookie', 'a=1');
    expect(responseCacheable(new Response(null, { status: 404 }), cookied, optedIn)).toBe(false);
    expect(
      responseCacheable(
        new Response(null, { status: 404 }),
        new Headers({ 'content-type': 'text/css', vary: 'cookie' }),
        optedIn,
      ),
    ).toBe(false);
  });

  it('refuses a response that sets a cookie', () => {
    const headers = new Headers({ 'content-type': 'text/css' });
    headers.append('set-cookie', 'a=1');
    expect(asIs(new Response('b', { headers }))).toBe(false);
  });

  it('honours the upstream refusing a shared cache', () => {
    for (const value of [
      'no-store',
      'private',
      'no-cache',
      'private="set-cookie"',
      'max-age=60, no-store',
    ]) {
      expect(asIs(cacheable({ 'cache-control': value }))).toBe(false);
    }
  });

  it('ignores an upstream max-age: the operator sets the window', () => {
    expect(asIs(cacheable({ 'cache-control': 'max-age=0' }))).toBe(true);
  });

  it('refuses a Vary this key does not cover', () => {
    expect(asIs(cacheable({ vary: 'cookie' }))).toBe(false);
    expect(asIs(cacheable({ vary: '*' }))).toBe(false);
    expect(asIs(cacheable({ vary: 'accept-encoding, cookie' }))).toBe(false);
  });

  it('admits Vary: accept-encoding, which the upstream never sees vary', () => {
    expect(asIs(cacheable({ vary: 'Accept-Encoding' }))).toBe(true);
  });

  it('admits a Vary the key headers list, case-insensitively', () => {
    const varyCache = cacheWith({ key: { query: 'all', headers: ['accept-language'] } });
    expect(
      responseCacheable(
        cacheable({ vary: 'accept-language' }),
        cacheable({ vary: 'accept-language' }).headers,
        varyCache,
      ),
    ).toBe(true);
    expect(
      responseCacheable(
        cacheable({ vary: 'Accept-Language, Accept-Encoding' }),
        cacheable({ vary: 'Accept-Language, Accept-Encoding' }).headers,
        varyCache,
      ),
    ).toBe(true);
  });

  it('refuses a Vary only partly covered, star included', () => {
    const varyCache = cacheWith({ key: { query: 'all', headers: ['accept-language'] } });
    expect(
      responseCacheable(
        cacheable({ vary: 'accept-language, user-agent' }),
        cacheable({ vary: 'accept-language, user-agent' }).headers,
        varyCache,
      ),
    ).toBe(false);
    expect(
      responseCacheable(cacheable({ vary: '*' }), cacheable({ vary: '*' }).headers, varyCache),
    ).toBe(false);
  });

  it('refuses a content type outside the list, HTML included by default', () => {
    expect(asIs(cacheable({ 'content-type': 'text/html' }))).toBe(false);
    expect(asIs(cacheable({ 'content-type': 'application/json' }))).toBe(false);
    expect(asIs(new Response('b'))).toBe(false);
  });

  it('matches a content type by prefix', () => {
    expect(asIs(cacheable({ 'content-type': 'image/avif' }))).toBe(true);
    expect(asIs(cacheable({ 'content-type': 'text/css; charset=utf-8' }))).toBe(true);
  });

  it('reads the upstream statement, not the delivered one', () => {
    // A `responseHeaders.remove` that deleted the upstream's own words must not be
    // able to make a private or varying response look shareable.
    const upstream = new Headers({ 'content-type': 'text/css', 'cache-control': 'private' });
    expect(responseCacheable(cacheable(), upstream, cache)).toBe(false);
    const varying = new Headers({ 'content-type': 'text/css', vary: 'cookie' });
    expect(responseCacheable(cacheable(), varying, cache)).toBe(false);
    const cookied = new Headers({ 'content-type': 'text/css' });
    cookied.append('set-cookie', 'a=1');
    expect(responseCacheable(cacheable(), cookied, cache)).toBe(false);
  });

  it('reads the delivered content type, which an operator may legitimately correct', () => {
    const mislabelled = new Headers({ 'content-type': 'application/octet-stream' });
    expect(responseCacheable(cacheable(), mislabelled, cache)).toBe(true);
  });
});

describe('store and read round trip', () => {
  const cache = cacheWith({ ttlSeconds: 100, staleWhileRevalidateSeconds: 50 });
  const key = cacheKey(new URL('https://p.dev/a.css'), 'GET', 'fp', cache, new Headers())!;

  const store = async (response: Response, now = 1_000_000) => {
    const target = memoryStore();
    await storeCachedResponse({ store: target, key, response, cache, now, alsoServed: true });
    return target;
  };

  it('serves a fresh entry with the upstream Cache-Control restored', async () => {
    const target = await store(cacheable({ 'cache-control': 'max-age=5, must-revalidate' }));
    const found = (await readCachedResponse({ store: target, key, cache, now: 1_010_000 }))!;
    expect(found.state).toBe('hit');
    expect(await found.response.text()).toBe('body');
    expect(found.response.headers.get('cache-control')).toBe('max-age=5, must-revalidate');
    expect(found.response.headers.get(CACHE_STATE_HEADER)).toBe('hit');
    // A shared cache owes the client an accurate Age; workerd's own reads 0.
    expect(found.response.headers.get('age')).toBe('10');
  });

  it('does not pass off its own window as the upstream saying something', async () => {
    const target = await store(cacheable());
    const found = (await readCachedResponse({ store: target, key, cache, now: 1_000_000 }))!;
    expect(found.response.headers.get('cache-control')).toBeNull();
  });

  it('declares a lifetime covering the stale window, so match can still see it', async () => {
    const target = await store(cacheable());
    const stored = (await target.match(key))!;
    expect(stored.headers.get('cache-control')).toBe('max-age=150');
    expect(stored.headers.get('x-jouska-cached-at')).toBe('1000000');
  });

  it('turns stale past the TTL and disappears past the stale window', async () => {
    const target = await store(cacheable());
    expect((await readCachedResponse({ store: target, key, cache, now: 1_099_000 }))!.state).toBe(
      'hit',
    );
    const stale = (await readCachedResponse({ store: target, key, cache, now: 1_120_000 }))!;
    expect(stale.state).toBe('stale');
    expect(stale.response.headers.get(CACHE_STATE_HEADER)).toBe('stale');
    expect(await readCachedResponse({ store: target, key, cache, now: 1_151_000 })).toBeUndefined();
  });

  it('refuses to trust metadata an upstream planted', async () => {
    const target = await store(
      cacheable({
        'x-jouska-cached-at': '1',
        'x-jouska-origin-cache-control': 'max-age=999999',
        [CACHE_STATE_HEADER]: 'hit',
      }),
    );
    const found = (await readCachedResponse({ store: target, key, cache, now: 1_000_000 }))!;
    // The forged timestamp would have aged the entry out of existence, and the
    // forged origin value would have been handed to the client as gospel.
    expect(found.state).toBe('hit');
    expect(found.response.headers.get('cache-control')).toBeNull();
  });

  it('does not store the diagnostic header, which describes a delivery not an entry', async () => {
    const target = await store(cacheable({ [CACHE_STATE_HEADER]: 'miss' }));
    expect((await target.match(key))!.headers.get(CACHE_STATE_HEADER)).toBeNull();
  });

  it('treats an entry without our metadata as a miss', async () => {
    const target = memoryStore();
    await target.put(key, cacheable());
    expect(await readCachedResponse({ store: target, key, cache, now: 1_000_000 })).toBeUndefined();
  });

  it('leaves the client response readable after storing a copy', async () => {
    const target = memoryStore();
    const response = cacheable();
    await storeCachedResponse({
      store: target,
      key,
      response,
      cache,
      now: 1_000_000,
      alsoServed: true,
    });
    expect(await response.text()).toBe('body');
    expect(await (await target.match(key))!.text()).toBe('body');
  });

  it('consumes the response itself for a background refresh, leaving no unread branch', async () => {
    const target = memoryStore();
    const response = cacheable();
    await storeCachedResponse({
      store: target,
      key,
      response,
      cache,
      now: 1_000_000,
      alsoServed: false,
    });
    expect(await (await target.match(key))!.text()).toBe('body');
    // The same stream went into the store rather than a clone, so there is no
    // second branch for the runtime to buffer for while nobody reads it.
    await expect(response.text()).rejects.toThrow();
  });

  it('swallows a store that refuses the write', async () => {
    const failing: ResponseCacheStore = {
      match: async () => undefined,
      put: async () => {
        throw new Error('too large');
      },
    };
    await expect(
      storeCachedResponse({
        store: failing,
        key,
        response: cacheable(),
        cache,
        now: 1,
        alsoServed: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('per-status lifetimes', () => {
  // SWR zeroed so the 404's own window is the only one in play: the default
  // SWR would keep the entry readable for a minute past its named lifetime.
  const cache = cacheWith({
    staleWhileRevalidateSeconds: 0,
    statusTtlSeconds: { 301: 3600, 404: 60 },
  });
  const key = cacheKey(new URL('https://p.dev/nf.css'), 'GET', 'fp', cache, new Headers())!;

  const store = async (response: Response) => {
    const target = memoryStore();
    await storeCachedResponse({
      store: target,
      key,
      response,
      cache,
      now: 1_000_000,
      alsoServed: true,
    });
    return target;
  };

  it('stores and serves an opted-in 404 inside its window', async () => {
    const target = await store(
      new Response('nope', { status: 404, headers: { 'content-type': 'text/css' } }),
    );
    const found = (await readCachedResponse({ store: target, key, cache, now: 1_030_000 }))!;
    expect(found.state).toBe('hit');
    expect(found.response.status).toBe(404);
    expect(await found.response.text()).toBe('nope');
    // The stored lifetime covers the entry's own window, so the platform holds it.
    expect((await target.match(key))!.headers.get('cache-control')).toBe('max-age=60');
  });

  it('drops the 404 once its window ends, on the healthy path', async () => {
    const target = await store(
      new Response('nope', { status: 404, headers: { 'content-type': 'text/css' } }),
    );
    expect(await readCachedResponse({ store: target, key, cache, now: 1_060_000 })).toBeUndefined();
  });

  it('keeps 301 under its own, longer window', async () => {
    const target = await store(
      new Response(null, { status: 301, headers: { location: '/b.css' } }),
    );
    expect((await readCachedResponse({ store: target, key, cache, now: 4_000_000 }))!.state).toBe(
      'hit',
    );
  });
});

describe('stale-if-error window', () => {
  // SWR is zeroed so the failure path is the only way past the TTL: otherwise a
  // wide default SWR window would swallow the case this describes.
  const cache = cacheWith({
    ttlSeconds: 100,
    staleWhileRevalidateSeconds: 0,
    staleIfError: { seconds: 3600, on: ['timeout', 'unreachable', '5xx'] },
  });
  const key = cacheKey(new URL('https://p.dev/a.css'), 'GET', 'fp', cache, new Headers())!;
  const fill = async (now = 1_000_000) => {
    const target = memoryStore();
    await storeCachedResponse({
      store: target,
      key,
      response: cacheable(),
      cache,
      now,
      alsoServed: true,
    });
    return target;
  };

  it('serves an expired entry as stale_error past the SWR horizon, on the failure path', async () => {
    const target = await fill();
    const found = (await readCachedResponse({
      store: target,
      key,
      cache,
      now: 1_500_000,
      allowStaleError: true,
    }))!;
    expect(found.state).toBe('stale_error');
    expect(found.response.headers.get(CACHE_STATE_HEADER)).toBe('stale_error');
    expect(found.response.headers.get('age')).toBe('500');
  });

  it('still reports a miss on the healthy path, even with the window configured', async () => {
    const target = await fill();
    // Same instant, same entry: the difference is whether the caller has watched
    // the upstream fail, which is exactly what allowStaleError encodes.
    expect(await readCachedResponse({ store: target, key, cache, now: 1_500_000 })).toBeUndefined();
  });

  it('reaches only to the end of the stale-if-error window', async () => {
    const target = await fill();
    expect(
      await readCachedResponse({
        store: target,
        key,
        cache,
        now: 4_700_000,
        allowStaleError: true,
      }),
    ).toBeUndefined();
  });

  it('does not widen the healthy horizon by configuring the window', async () => {
    // The stored lifetime covers both windows, but the healthy read stops at SWR.
    const target = await fill();
    expect(await readCachedResponse({ store: target, key, cache, now: 1_100_000 })).toBeUndefined();
  });
});

describe('cold-miss flights', () => {
  const key = (path: string) => new Request(`https://p.dev${path}?__jouska_ck=fp.GET`);

  it('lets one caller lead and the rest join', () => {
    const k = key('/lead');
    const release = beginFlight(k);
    expect(release).toBeDefined();
    expect(beginFlight(k)).toBeUndefined();
    release?.();
  });

  it('wakes the waiter when the leader releases, and releases the slot', async () => {
    const k = key('/wake');
    const release = beginFlight(k)!;
    const joined = joinFlight(k, 5_000);
    release();
    await expect(joined).resolves.toBeUndefined();
    // The slot is gone, so a later miss begins its own flight.
    expect(beginFlight(k)).toBeDefined();
  });

  it('joins instantly when no flight is running', async () => {
    await expect(joinFlight(key('/idle'), 5_000)).resolves.toBeUndefined();
  });

  it('bounds the wait, rather than pinning the waiter to a dead leader', async () => {
    const k = key('/bound');
    beginFlight(k);
    const started = Date.now();
    await expect(joinFlight(k, 20)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });

  it('treats a second release as a no-op, so finally-shaped callers are safe', async () => {
    const k = key('/twice');
    const release = beginFlight(k)!;
    release();
    expect(() => release()).not.toThrow();
    expect(beginFlight(k)).toBeDefined();
  });
});

describe('refreshOnce', () => {
  it('collapses a burst of stale requests onto one refresh', async () => {
    const key = new Request('https://p.dev/collapse?__jouska_ck=fp.GET');
    let running: (() => void) | undefined;
    let calls = 0;
    const first = refreshOnce(key, () => {
      calls += 1;
      return new Promise<void>((resolve) => {
        running = resolve;
      });
    });
    expect(first).toBeDefined();
    expect(refreshOnce(key, async () => calls++)).toBeUndefined();
    running!();
    await first;
    expect(calls).toBe(1);
    // Released once it finished, so the next window past the TTL tries again.
    expect(refreshOnce(key, async () => calls++)).toBeDefined();
  });

  it('contains a failing refresh, leaving the stale entry in place', async () => {
    const key = new Request('https://p.dev/failing?__jouska_ck=fp.GET');
    await expect(
      refreshOnce(key, () => Promise.reject(new Error('upstream down'))),
    ).resolves.toBeUndefined();
    expect(refreshOnce(key, async () => undefined)).toBeDefined();
  });
});

describe('cacheVaryPart', () => {
  const headers = (init: Record<string, string> = {}) => new Headers(init);
  const routeFrom = (matchExtra: Record<string, unknown>): Route =>
    defineConfig({
      routes: [{ match: { path: '/a', ...matchExtra }, upstream: 'o.test' }],
    }).routes[0]!;

  it('is empty when the route matches on nothing finer than the URL', () => {
    expect(cacheVaryPart(routeFrom({}).match, headers({ 'x-env': 'prod' }))).toBe('');
  });

  it('folds the request value of every named header, verbatim', () => {
    const match = routeFrom({ headers: [{ name: 'x-env', equals: 'prod' }] }).match;
    expect(cacheVaryPart(match, headers({ 'x-env': 'prod' }))).toBe('x-env=prod');
    // A missing header folds as the empty value — the same value an empty
    // header carries, which is correct for equals:'' and harmless otherwise.
    expect(cacheVaryPart(match, headers())).toBe('x-env=');
  });

  it('reads cookies by name out of the parsed Cookie header', () => {
    const match = routeFrom({ cookies: [{ name: 'beta', present: true }] }).match;
    expect(cacheVaryPart(match, headers({ Cookie: 'sid=1; beta=on' }))).toBe('beta=on');
    expect(cacheVaryPart(match, headers({ Cookie: 'sid=1' }))).toBe('beta=');
  });

  it('folds header and cookie conditions into one discriminating string', () => {
    const match = routeFrom({
      headers: [{ name: 'x-env', equals: 'prod' }],
      cookies: [{ name: 'beta', present: true }],
    }).match;
    expect(cacheVaryPart(match, headers({ 'x-env': 'prod', Cookie: 'beta=on' }))).toBe(
      'x-env=prod;beta=on',
    );
  });

  it('produces different keys for different branch values', () => {
    const match = routeFrom({ headers: [{ name: 'x-env', equals: 'prod' }] }).match;
    expect(cacheVaryPart(match, headers({ 'x-env': 'prod' }))).not.toBe(
      cacheVaryPart(match, headers({ 'x-env': 'staging' })),
    );
  });
});
