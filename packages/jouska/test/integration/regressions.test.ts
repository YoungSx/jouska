import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska } from '../../src/middleware/jouska';

/**
 * One case per defect found in the reverse-proxy audit.
 *
 * These are separated from the feature tests deliberately. Every one of them
 * failed against a build whose 160 other tests passed, because each defect sat
 * in a gap the feature tests did not reach — mostly by asserting on jouska's own
 * output rather than on what the upstream or the client actually received.
 */

const appWith = (routes: ConfigInput['routes'], fetchImpl: typeof fetch) => {
  const app = new Hono();
  app.use('*', jouska({ config: defineConfig({ routes }), fetchImpl }));
  return app;
};

/** Records everything the upstream was sent. */
const spy = () => {
  let request: Request | undefined;
  const fetchImpl: typeof fetch = async (input) => {
    request = input instanceof Request ? input : new Request(input);
    return new Response('ok');
  };
  return { fetchImpl, seen: () => request! };
};

describe('client request headers reach the upstream', () => {
  // Passing a plain object to `new Request(raw, { headers })` replaces the
  // header set rather than merging it, so the upstream saw only the three
  // forwarding headers. Every bearer token and session cookie was dropped.
  it('forwards authorization, cookie and content-type', async () => {
    const upstream = spy();
    const app = appWith([{ match: { path: '/' }, upstream: 'o.test' }], upstream.fetchImpl);
    await app.request(
      new Request('https://p.dev/x', {
        method: 'POST',
        body: '{}',
        headers: {
          authorization: 'Bearer secret',
          cookie: 'session=abc',
          'content-type': 'application/json',
          'user-agent': 'probe/1.0',
          'x-custom': 'keep-me',
        },
      }),
    );
    const seen = upstream.seen();
    expect(seen.headers.get('authorization')).toBe('Bearer secret');
    expect(seen.headers.get('cookie')).toBe('session=abc');
    expect(seen.headers.get('content-type')).toBe('application/json');
    expect(seen.headers.get('user-agent')).toBe('probe/1.0');
    expect(seen.headers.get('x-custom')).toBe('keep-me');
  });

  it('still sets the forwarding headers', async () => {
    const upstream = spy();
    const app = appWith([{ match: { path: '/' }, upstream: 'o.test' }], upstream.fetchImpl);
    await app.request(
      new Request('https://p.dev/x', { headers: { 'cf-connecting-ip': '203.0.113.9' } }),
    );
    const seen = upstream.seen();
    expect(seen.headers.get('host')).toBe('o.test');
    expect(seen.headers.get('x-forwarded-host')).toBe('p.dev');
    expect(seen.headers.get('x-forwarded-for')).toBe('203.0.113.9');
  });

  it('drops hop-by-hop headers and anything Connection names', async () => {
    const upstream = spy();
    const app = appWith([{ match: { path: '/' }, upstream: 'o.test' }], upstream.fetchImpl);
    await app.request(
      new Request('https://p.dev/x', {
        headers: { connection: 'keep-alive, X-Smuggled', 'x-smuggled': 'value', te: 'trailers' },
      }),
    );
    const seen = upstream.seen();
    expect(seen.headers.get('connection')).toBeNull();
    expect(seen.headers.get('te')).toBeNull();
    // A header named by Connection is scoped to that one hop by definition.
    expect(seen.headers.get('x-smuggled')).toBeNull();
  });

  it('does not leave a forged x-forwarded-for behind', async () => {
    const upstream = spy();
    const app = appWith([{ match: { path: '/' }, upstream: 'o.test' }], upstream.fetchImpl);
    // No cf-connecting-ip, so there is no trustworthy value to forward.
    await app.request(
      new Request('https://p.dev/x', { headers: { 'x-forwarded-for': '1.1.1.1' } }),
    );
    expect(upstream.seen().headers.get('x-forwarded-for')).toBeNull();
  });
});

describe('path normalisation cannot bypass a guard', () => {
  /** A guarded route followed by a permissive one — the shape a bypass exploits. */
  const guarded = (fetchImpl: typeof fetch) =>
    appWith(
      [
        { match: { path: '/admin' }, upstream: 'o.test', ip: { allow: ['10.0.0.1'] } },
        { match: { path: '/' }, upstream: 'public.test' },
      ],
      fetchImpl,
    );

  const attempt = (app: Hono, path: string) =>
    app.request(
      new Request(`https://p.dev${path}`, { headers: { 'cf-connecting-ip': '203.0.113.9' } }),
    );

  it.each([
    ['/admin', 'the literal path'],
    ['/%61dmin', 'percent-encoded, which every upstream decodes'],
    ['/%61%64min', 'more than one encoded character'],
    ['//admin', 'repeated separators, collapsed by most servers'],
    ['/admin;x', 'a path parameter, stripped by Tomcat and others'],
    ['///%61dmin;y', 'all three at once'],
  ])('refuses %s (%s)', async (path) => {
    const app = guarded(async () => new Response('upstream reached'));
    expect((await attempt(app, path)).status).toBe(403);
  });

  it('does not over-match a longer path', async () => {
    // `/administrator` is a different resource and must not inherit the guard.
    const app = guarded(async () => new Response('upstream reached'));
    expect((await attempt(app, '/administrator')).status).toBe(200);
  });

  it('forwards the path exactly as the client wrote it', async () => {
    // Re-encoding a decoded path is not round-trip safe: `/%61dmin` decodes to
    // `/admin`, which re-encodes to `/admin` — a different request.
    const upstream = spy();
    const app = appWith(
      [{ match: { path: '/api' }, upstream: 'o.test/v1', stripPrefix: true }],
      upstream.fetchImpl,
    );
    await app.request('https://p.dev/api/a%20b?q=1');
    expect(upstream.seen().url).toBe('https://o.test/v1/a%20b?q=1');
  });
});

describe('country rules are case-normalised', () => {
  const withCountry = (app: Hono, code?: string) => {
    const request = new Request('https://p.dev/x');
    if (code !== undefined) {
      Object.defineProperty(request, 'cf', { value: { country: code } });
    }
    return app.request(request);
  };

  // Cloudflare reports the country uppercased, so a lowercase config compared
  // unequal and admitted every request — a security control failing silently.
  it('blocks a country configured in lowercase', async () => {
    const app = appWith(
      [{ match: { path: '/' }, upstream: 'o.test', blockCountries: ['cu'] }],
      async () => new Response('upstream reached'),
    );
    expect((await withCountry(app, 'CU')).status).toBe(403);
  });

  it('refuses a code that is not ISO 3166-1 alpha-2', () => {
    for (const code of ['中国', 'c1', '12']) {
      expect(() =>
        defineConfig({
          routes: [{ match: { path: '/' }, upstream: 'o.test', blockCountries: [code] }],
        }),
      ).toThrow();
    }
  });

  it('fails closed on an allow-list with no country signal', async () => {
    // An allow-list that admits unknowns is not an allow-list.
    const app = appWith(
      [{ match: { path: '/' }, upstream: 'o.test', allowCountries: ['jp'] }],
      async () => new Response('upstream reached'),
    );
    expect((await withCountry(app)).status).toBe(403);
    expect((await withCountry(app, 'JP')).status).toBe(200);
    expect((await withCountry(app, 'US')).status).toBe(403);
  });
});

describe('wildcard hosts', () => {
  const reached: typeof fetch = async () => new Response('upstream reached');

  it('matches regardless of the case the pattern was written in', async () => {
    const app = appWith([{ match: { host: '*.Example.com' }, upstream: 'o.test' }], reached);
    expect((await app.request('https://a.example.com/x')).status).toBe(200);
  });

  it('refuses a wildcard without the separating dot', () => {
    // `*example.com` reads like a subdomain rule but matched `evilexample.com`.
    expect(() =>
      defineConfig({ routes: [{ match: { host: '*example.com' }, upstream: 'o.test' }] }),
    ).toThrow();
  });

  it('does not match the apex', async () => {
    const app = appWith([{ match: { host: '*.example.com' }, upstream: 'o.test' }], reached);
    expect((await app.request('https://example.com/x')).status).toBe(404);
  });

  it('matches on the URL host, not a client-supplied Host header', async () => {
    // Trusting the header let a request pick a route meant for an internal name.
    const app = appWith(
      [
        { match: { host: 'internal.test' }, upstream: 'secret.test' },
        { match: { path: '/' }, upstream: 'public.test' },
      ],
      async (input) => new Response(new URL((input as Request).url).host),
    );
    const res = await app.request(
      new Request('https://p.dev/x', { headers: { host: 'internal.test' } }),
    );
    expect(await res.text()).toBe('public.test');
  });
});

describe('body rewriting invalidates the response', () => {
  const page: typeof fetch = async () =>
    new Response('<a href="https://o.test/a">x</a>', {
      headers: {
        'content-type': 'text/html',
        etag: 'W/"abc123"',
        'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
        'cache-control': 'public, max-age=3600',
      },
    });

  // Keeping the upstream's etag means the client's next request carries
  // If-None-Match, the upstream answers 304, and the client then serves the
  // *unrewritten* body from its own cache — the rewrite silently undone.
  it('drops the validators once the body changes', async () => {
    const app = appWith([{ match: { path: '/' }, upstream: 'o.test', bodyRewrite: {} }], page);
    const res = await app.request('https://p.dev/x');
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('last-modified')).toBeNull();
    // Caching itself is still fine; only the body-specific validators go.
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
  });

  it('keeps the validators when the body is untouched', async () => {
    const app = appWith([{ match: { path: '/' }, upstream: 'o.test' }], page);
    expect((await app.request('https://p.dev/x')).headers.get('etag')).toBe('W/"abc123"');
  });

  it('leaves a 206 alone', async () => {
    // The body length is what Content-Range describes, so rewriting it would
    // contradict the range the client is assembling.
    const partial: typeof fetch = async () =>
      new Response('<a href="https://o.test/z">p</a>', {
        status: 206,
        headers: {
          'content-type': 'text/html',
          'content-range': 'bytes 0-31/1000',
          'content-length': '32',
        },
      });
    const app = appWith([{ match: { path: '/' }, upstream: 'o.test', bodyRewrite: {} }], partial);
    const res = await app.request('https://p.dev/x');
    expect(res.headers.get('content-range')).toBe('bytes 0-31/1000');
    expect(await res.text()).toContain('https://o.test/z');
  });
});

describe('non-UTF-8 bodies', () => {
  // 0xC4 0xE3 0xBA 0xC3 is "你好" in GB2312, and invalid UTF-8. Decoding it as
  // UTF-8 turned every character into U+FFFD.
  const gb2312 = new Uint8Array([0x3c, 0x70, 0x3e, 0xc4, 0xe3, 0xba, 0xc3, 0x3c, 0x2f, 0x70, 0x3e]);

  it('transcodes a declared charset instead of corrupting it', async () => {
    const app = appWith(
      [{ match: { path: '/' }, upstream: 'o.test', bodyRewrite: {} }],
      async () =>
        new Response(gb2312, { headers: { 'content-type': 'text/html; charset=gb2312' } }),
    );
    const res = await app.request('https://p.dev/x');
    expect(await res.text()).toBe('<p>你好</p>');
    // The bytes are UTF-8 now, so the declared charset has to say so.
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('passes a body through untouched when the charset is unknown', async () => {
    // Rewriting would mean decoding with the wrong table, which corrupts more
    // than it fixes, so the bytes are relayed verbatim.
    const app = appWith(
      [{ match: { path: '/' }, upstream: 'o.test', bodyRewrite: {} }],
      async () =>
        new Response(gb2312, { headers: { 'content-type': 'text/html; charset=x-nonsense' } }),
    );
    const res = await app.request('https://p.dev/x');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(gb2312);
  });
});

describe('cookies are only rescoped when they belong to the upstream', () => {
  const cookies: typeof fetch = async () => {
    const headers = new Headers({ 'content-type': 'text/plain' });
    headers.append('set-cookie', 'a=1; Domain=o.test; Path=/');
    headers.append('set-cookie', 'b=2; Domain=other.test');
    headers.append('set-cookie', 'c=3; Domain=www.o.test');
    return new Response('ok', { headers });
  };

  it('rescopes the upstream cookies and leaves a third party out of it', async () => {
    // Rewriting every Domain hijacked third-party cookies onto the proxy, which
    // both breaks them and attaches a value the third party set to requests it
    // never expected to see.
    const app = appWith([{ match: { path: '/' }, upstream: 'o.test' }], cookies);
    const set = (await app.request('https://p.dev/x')).headers.getSetCookie();
    expect(set).toContain('a=1; Domain=p.dev; Path=/');
    // Sibling subdomains of the upstream are the same site, so they rescope too.
    expect(set).toContain('c=3; Domain=p.dev');
    // The third-party cookie keeps its value but becomes host-only.
    expect(set).toContain('b=2');
  });
});

describe('redirects that leave the upstream host', () => {
  it('keeps a sibling-subdomain redirect on the proxy', async () => {
    // An exact host comparison passed `www.o.test` through untouched, walking
    // the visitor straight off the proxy on the first redirect.
    const app = appWith(
      [{ match: { path: '/' }, upstream: 'o.test' }],
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://www.o.test/landed' } }),
    );
    expect((await app.request('https://p.dev/x')).headers.get('location')).toBe(
      'https://p.dev/landed',
    );
  });

  it('rewrites the Refresh header, which browsers honour like a redirect', async () => {
    const app = appWith(
      [{ match: { path: '/' }, upstream: 'o.test' }],
      async () => new Response('x', { headers: { refresh: '3; url=https://o.test/next' } }),
    );
    expect((await app.request('https://p.dev/x')).headers.get('refresh')).toBe(
      '3; url=https://p.dev/next',
    );
  });

  it('asks for the redirect rather than following it', async () => {
    // `fetch` follows redirects by default, so without this the rewrite never
    // ran and the visitor silently ended up on the upstream origin.
    let mode: RequestRedirect | undefined;
    const app = appWith([{ match: { path: '/' }, upstream: 'o.test' }], async (input) => {
      mode = (input as Request).redirect;
      return new Response('ok');
    });
    await app.request('https://p.dev/x');
    expect(mode).toBe('manual');
  });
});

describe('HTML rewriting coverage', () => {
  const render = async (html: string, routes?: Partial<ConfigInput['routes'][number]>) => {
    const app = appWith(
      [{ match: { path: '/' }, upstream: 'o.test', bodyRewrite: {}, ...routes }],
      async () => new Response(html, { headers: { 'content-type': 'text/html' } }),
    );
    return (await app.request('https://p.dev/x')).text();
  };

  it.each([
    ['<meta http-equiv="refresh" content="0;url=https://o.test/r">', 'https://p.dev/r'],
    ['<style>a{background:url(https://o.test/b.png)}</style>', 'https://p.dev/b.png'],
    ['<div style="background:url(https://o.test/i.png)"></div>', 'https://p.dev/i.png'],
    ['<object data="https://o.test/o"></object>', 'https://p.dev/o'],
    ['<a href="/a" ping="https://o.test/p">x</a>', 'https://p.dev/p'],
    ['<blockquote cite="https://o.test/c">q</blockquote>', 'https://p.dev/c'],
    ['<link imagesrcset="https://o.test/a.png 1x">', 'https://p.dev/a.png'],
  ])('rewrites %s', async (html, expected) => {
    expect(await render(html)).toContain(expected);
  });

  it('preserves srcset descriptors', async () => {
    const out = await render('<img srcset="https://o.test/a.png 1x, https://o.test/b.png 2x">');
    expect(out).toContain('https://p.dev/a.png 1x');
    expect(out).toContain('https://p.dev/b.png 2x');
  });

  it('leaves a lookalike host alone', async () => {
    // Substring substitution turned `o.test.evil.com` into `p.dev.evil.com`,
    // which both breaks the link and puts the proxy's name in someone's domain.
    const out = await render('<a href="https://o.test.evil.com/b">x</a>');
    expect(out).toContain('https://o.test.evil.com/b');
    expect(out).not.toContain('p.dev.evil.com');
  });

  it('leaves non-HTTP schemes alone', async () => {
    const out = await render('<a href="mailto:a@o.test">m</a><img src="data:image/gif;base64,AA">');
    expect(out).toContain('mailto:a@o.test');
    expect(out).toContain('data:image/gif;base64,AA');
  });

  it.each([
    ['<img src="https://o.test/img,1.png">', 'https://p.dev/img,1.png', 'a comma in the path'],
    ['<a href="https://o.test/p?a=1,2">x</a>', 'https://p.dev/p?a=1,2', 'a comma in the query'],
    ['<a href="//o.test/x">x</a>', '//p.dev/x', 'a protocol-relative reference'],
    [
      '<a href="/a" ping="https://o.test/p1 https://o.test/p2">x</a>',
      'ping="https://p.dev/p1 https://p.dev/p2"',
      'a space-separated ping list',
    ],
  ])('handles %s', async (html, expected) => {
    // Candidate URLs are split on whitespace and commas to cover srcset, which
    // risks cutting a URL that contains one of those itself.
    expect(await render(html)).toContain(expected);
  });

  it('leaves a data URL containing a comma intact', async () => {
    const html = '<img src="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\'/>">';
    expect(await render(html)).toContain('data:image/svg+xml,<svg');
  });

  it.each([
    ["a{background:url('https://o.test/b.png')}", "url('https://p.dev/b.png')"],
    ['a{background:url( "https://o.test/b.png" )}', 'url("https://p.dev/b.png")'],
    ['@import url("https://o.test/s.css");', 'url("https://p.dev/s.css")'],
    ['a{background:url(data:image/gif;base64,AAA)}', 'url(data:image/gif;base64,AAA)'],
    ['a{background:url(/rel.png)}', 'url(/rel.png)'],
  ])('rewrites the CSS form %s', async (css, expected) => {
    expect(await render(`<style>${css}</style>`)).toContain(expected);
  });

  it('rewrites every url() in one style block', async () => {
    const out = await render(
      '<style>a{background:url(https://o.test/a)}b{background:url(https://o.test/b)}</style>',
    );
    expect(out).toContain('url(https://p.dev/a)');
    expect(out).toContain('url(https://p.dev/b)');
  });

  it('can be told not to touch styles', async () => {
    const out = await render('<style>a{background:url(https://o.test/b.png)}</style>', {
      bodyRewrite: { rewriteStyles: false },
    });
    expect(out).toContain('https://o.test/b.png');
  });

  /**
   * Rewriting a `<style>` node requires accumulating it, because a `url(...)` can
   * straddle two chunks. Accumulating without a bound is the whole-body
   * buffering this module opens by ruling out — verified in workerd, a 4.2MB
   * node was held complete in a JS string, with nothing to stop it being 60MB
   * inside a 128MB isolate.
   *
   * Past the cap the node is emitted unrewritten. What must not happen is losing
   * any of it: a dropped fragment would corrupt the stylesheet silently, which
   * is worse than not rewriting it.
   */
  describe('oversized style nodes', () => {
    const oversizedCss = (bytes: number) => `a{color:red}`.repeat(Math.ceil(bytes / 12));

    it('emits an oversized style node whole, without rewriting it', async () => {
      const css = `${oversizedCss(300 * 1024)}b{background:url(https://o.test/b.png)}`;
      const out = await render(`<html><style>${css}</style></html>`);
      // Every byte survives.
      expect(out).toContain(css);
      // And the tradeoff is the documented one: the url() is left alone.
      expect(out).toContain('url(https://o.test/b.png)');
    });

    it('still rewrites a style node under the cap', async () => {
      // The cap must not be satisfied by giving up on everything.
      const css = `${oversizedCss(100 * 1024)}b{background:url(https://o.test/b.png)}`;
      const out = await render(`<html><style>${css}</style></html>`);
      expect(out).toContain('url(https://p.dev/b.png)');
    });

    it('recovers for the next node after one overflows', async () => {
      // The overflow flag is per node; a following style block must be rewritten
      // normally rather than inheriting the giving-up state.
      const out = await render(
        `<html><style>${oversizedCss(300 * 1024)}</style>` +
          `<style>b{background:url(https://o.test/small.png)}</style></html>`,
      );
      expect(out).toContain('url(https://p.dev/small.png)');
    });
  });
});

describe('deadlines and retries', () => {
  /** Rejects only when its signal aborts, the way a real fetch does. */
  const neverResponds: typeof fetch = async (input) =>
    new Promise<Response>((_, reject) => {
      const request = input as Request;
      request.signal.addEventListener('abort', () => reject(request.signal.reason));
    });

  it('cancels the upstream when the client hangs up', async () => {
    // Passing only AbortSignal.timeout left the upstream oblivious to a client
    // abort, so a closed tab still occupied the proxy for the full timeout.
    let reason = '';
    const app = appWith(
      [{ match: { path: '/' }, upstream: 'o.test', timeoutMs: 5_000 }],
      async (input) => {
        const request = input as Request;
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => {
            reason = (request.signal.reason as Error).name;
            reject(request.signal.reason);
          });
        });
      },
    );
    const controller = new AbortController();
    const pending = app.request(new Request('https://p.dev/x', { signal: controller.signal }));
    controller.abort();
    const res = await pending;
    expect(reason).toBe('AbortError');
    // Not the upstream's fault and nobody is waiting, so not a 5xx.
    expect(res.status).toBe(499);
  });

  it('bounds every attempt by a total deadline', async () => {
    // retries: 3 with timeoutMs: 30000 could otherwise occupy the proxy for two
    // minutes before giving up.
    const app = appWith(
      [
        {
          match: { path: '/' },
          upstream: 'o.test',
          timeoutMs: 100,
          retries: 3,
          totalTimeoutMs: 250,
          retryBackoffMs: 0,
        },
      ],
      neverResponds,
    );
    const startedAt = Date.now();
    const res = await app.request('https://p.dev/x');
    expect(res.status).toBe(504);
    expect(Date.now() - startedAt).toBeLessThan(400);
  });

  it('waits between retries', async () => {
    // Retrying with no gap was measured at 0–1ms, which is long enough for
    // nothing: whatever failed is almost certainly still failing.
    const stamps: number[] = [];
    const app = appWith(
      [{ match: { path: '/' }, upstream: 'o.test', retries: 2, retryBackoffMs: 50 }],
      async () => {
        stamps.push(Date.now());
        throw new Error('transient');
      },
    );
    await app.request('https://p.dev/x');
    expect(stamps).toHaveLength(3);
    // Exponential: roughly 50ms then 100ms.
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(40);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(90);
  });
});

describe('rate limiting', () => {
  const limiter = () => {
    const keys: string[] = [];
    return {
      keys,
      binding: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) },
    };
  };

  const call = (routes: ConfigInput['routes'], request: Request, binding: unknown) => {
    const app = new Hono();
    app.use(
      '*',
      jouska({ config: defineConfig({ routes }), fetchImpl: async () => new Response('up') }),
    );
    return app.fetch(request, { RL: binding });
  };

  it('does not spend budget on a CORS preflight', async () => {
    // A browser issues one preflight per cross-origin call, so counting both
    // halves the effective limit for exactly the callers behaving correctly.
    const { binding, keys } = limiter();
    await call(
      [
        {
          match: { path: '/x' },
          upstream: 'o.test',
          cors: { allowMethods: ['POST'] },
          rateLimit: { binding: 'RL' },
        },
      ],
      new Request('https://p.dev/x', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://a.test',
          'access-control-request-method': 'POST',
          'cf-connecting-ip': '203.0.113.1',
        },
      }),
      binding,
    );
    expect(keys).toHaveLength(0);
  });

  it('counts a preflight when asked to', async () => {
    const { binding, keys } = limiter();
    await call(
      [
        {
          match: { path: '/x' },
          upstream: 'o.test',
          cors: { allowMethods: ['POST'] },
          rateLimit: { binding: 'RL', countPreflight: true },
        },
      ],
      new Request('https://p.dev/x', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://a.test',
          'access-control-request-method': 'POST',
          'cf-connecting-ip': '203.0.113.1',
        },
      }),
      binding,
    );
    expect(keys).toHaveLength(1);
  });

  it('refuses a per-caller limit it cannot key', async () => {
    // One shared `unknown` bucket either lets a single client exhaust everyone's
    // budget, or lets an attacker evade the limit by suppressing what identifies
    // them. On Cloudflare the header is always present, so its absence means the
    // proxy is not running where it thinks it is.
    const { binding } = limiter();
    const res = await call(
      [{ match: { path: '/x' }, upstream: 'o.test', rateLimit: { binding: 'RL' } }],
      new Request('https://p.dev/x'),
      binding,
    );
    expect(res.status).toBe(403);
  });

  it('still allows a route-wide limit with no caller identity', async () => {
    const { binding, keys } = limiter();
    const res = await call(
      [{ match: { path: '/x' }, upstream: 'o.test', rateLimit: { binding: 'RL', by: 'route' } }],
      new Request('https://p.dev/x'),
      binding,
    );
    expect(res.status).toBe(200);
    expect(keys).toHaveLength(1);
  });

  it('gives routes that differ only by method separate buckets', async () => {
    // The derived label ignored methods, so two distinct routes silently shared
    // one budget — the opposite of what namespacing exists for.
    const { binding, keys } = limiter();
    const routes: ConfigInput['routes'] = [
      { match: { path: '/a', methods: ['GET'] }, upstream: 'x.test', rateLimit: { binding: 'RL' } },
      {
        match: { path: '/a', methods: ['POST'] },
        upstream: 'y.test',
        rateLimit: { binding: 'RL' },
      },
    ];
    const headers = { 'cf-connecting-ip': '203.0.113.1' };
    await call(routes, new Request('https://p.dev/a', { headers }), binding);
    await call(routes, new Request('https://p.dev/a', { method: 'POST', headers }), binding);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('uses the author-supplied id when there is one', async () => {
    const { binding, keys } = limiter();
    await call(
      [{ id: 'search', match: { path: '/a' }, upstream: 'x.test', rateLimit: { binding: 'RL' } }],
      new Request('https://p.dev/a', { headers: { 'cf-connecting-ip': '203.0.113.1' } }),
      binding,
    );
    expect(keys[0]).toBe('search:203.0.113.1');
  });
});

describe('config refuses what it cannot honour', () => {
  it('refuses a private or metadata upstream', () => {
    // The upstream is runtime-editable through KV, so an unconstrained value
    // turns a corrupted config into an internal network probe. Verified from
    // workerd: a fetch to 169.254.169.254 completes rather than being blocked.
    for (const upstream of [
      '127.0.0.1',
      '192.168.1.1',
      '10.0.0.5',
      '172.16.0.1',
      '169.254.169.254',
      'localhost',
      'metadata.google.internal',
    ]) {
      expect(() => defineConfig({ routes: [{ match: { path: '/' }, upstream }] })).toThrow();
    }
  });

  it.each([
    ['127.1', 'a short-form dotted address'],
    ['127.0.1', 'three octets'],
    ['2130706433', 'the whole address as one decimal'],
    ['0x7f000001', 'hexadecimal'],
    ['0177.0.0.1', 'a leading zero, read as octal'],
    ['012.0.0.1', 'octal reaching a private range'],
    ['0', 'zero, which resolves to 0.0.0.0'],
    ['2852039166', 'the metadata endpoint as one decimal'],
    ['127.0.0.1.', 'the fully-qualified form'],
  ])('refuses %s (%s)', (upstream) => {
    // Pattern-matching dotted-quad form let all of these through, and the URL
    // parser then resolved them to the address they were spelling around.
    expect(() => defineConfig({ routes: [{ match: { path: '/' }, upstream }] })).toThrow();
  });

  it.each([
    ['[::1]', 'bracketed loopback'],
    ['[::1]:8080', 'bracketed loopback with a port'],
    ['[fc00::1]', 'a unique-local address'],
    ['[fe80::1]', 'a link-local address'],
    ['[::ffff:127.0.0.1]', 'loopback in IPv4-mapped form'],
    ['[64:ff9b::a9fe:a9fe]', 'the metadata endpoint via NAT64'],
    ['[2002:7f00:1::]', 'loopback via 6to4'],
    ['::1', 'an unbracketed loopback'],
    ['fc00::1', 'an unbracketed unique-local address'],
  ])('refuses the IPv6 literal %s (%s)', (upstream) => {
    // Every one of these is refused by the `upstream` pattern, before any
    // address classification runs. There used to be a bracket branch in
    // `isForbiddenHost` intended to catch some of them; it was unreachable for
    // exactly this reason, and it recognised only `::1`, `fe80:` and `fc`/`fd`
    // prefixes — so the mapped, NAT64 and 6to4 rows here would have passed it.
    // Refusing the whole family at the pattern is what can be proved, and this
    // pins it so widening the pattern cannot quietly reopen the hole.
    expect(() => defineConfig({ routes: [{ match: { path: '/' }, upstream }] })).toThrow();
  });

  it('still admits a public address that merely looks unusual', () => {
    // `010.0.0.1` is octal for 8.0.0.1, which is routable. Refusing it would be
    // a false positive, and the check is meant to follow the parser, not guess.
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/' }, upstream: '010.0.0.1' }] }),
    ).not.toThrow();
  });

  it('permits one when the route opts in', () => {
    const config = defineConfig({
      routes: [
        {
          match: { path: '/' },
          upstream: 'localhost:8787',
          allowPrivateUpstream: true,
          scheme: 'http',
        },
      ],
    });
    expect(config.routes[0].upstream).toBe('localhost:8787');
  });

  it('refuses a header name that is not a token', () => {
    // `Headers.set` throws on an invalid name, and that surfaced as
    // `502 upstream_unreachable` — a config mistake disguised as an upstream
    // fault, sending whoever debugs it in entirely the wrong direction.
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/' }, upstream: 'o.test', upstreamHeaders: { 'bad header': 'v' } },
        ],
      }),
    ).toThrow();
  });

  it('refuses upstreamHeaders that would forge a forwarding header', () => {
    for (const name of ['host', 'X-Forwarded-For', 'x-forwarded-host', 'x-forwarded-proto']) {
      expect(() =>
        defineConfig({
          routes: [
            { match: { path: '/' }, upstream: 'o.test', upstreamHeaders: { [name]: 'evil' } },
          ],
        }),
      ).toThrow();
    }
  });
});

describe('table-wide defaults', () => {
  it('fills gaps without overriding a route that states its own value', () => {
    // A table of twenty routes otherwise repeats timeoutMs twenty times, and the
    // twenty-first is forgotten.
    const config = defineConfig({
      defaults: { timeoutMs: 5_000, retries: 2 },
      routes: [
        { match: { path: '/a' }, upstream: 'a.test' },
        { match: { path: '/b' }, upstream: 'b.test', timeoutMs: 999 },
      ],
    });
    expect(config.routes[0].timeoutMs).toBe(5_000);
    expect(config.routes[0].retries).toBe(2);
    expect(config.routes[1]!.timeoutMs).toBe(999);
    expect(config.routes[1]!.retries).toBe(2);
  });

  it('cannot be forged through the internal bookkeeping field', () => {
    // The field carrying "which keys did this route state" is overwritten during
    // preprocessing, so a stored document cannot use it to influence anything.
    const config = defineConfig({
      defaults: { timeoutMs: 5_000 },
      routes: [{ match: { path: '/a' }, upstream: 'a.test' }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ __jouskaStatedKeys: [['timeoutMs']] } as Record<string, unknown>),
    } as Parameters<typeof defineConfig>[0]);
    expect(config.routes[0].timeoutMs).toBe(5_000);
  });
});

describe('WebSocket upgrades', () => {
  it('forwards the upgrade headers rather than stripping them', async () => {
    // `upgrade` was treated as hop-by-hop and deleted, so the handshake reached
    // the upstream as a plain GET and the socket silently became a 200.
    const upstream = spy();
    const app = appWith([{ match: { path: '/' }, upstream: 'o.test' }], upstream.fetchImpl);
    await app.request(
      new Request('https://p.dev/ws', {
        headers: {
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': 'abc',
        },
      }),
    );
    const seen = upstream.seen();
    expect(seen.headers.get('upgrade')).toBe('websocket');
    expect(seen.headers.get('sec-websocket-key')).toBe('abc');
  });

  it('relays a 101 response without rewrapping it', async () => {
    // `new Response` refuses any status outside 200–599, and rewrapping would
    // drop the `webSocket` property even if it did not. Verified against workerd.
    const app = appWith(
      [{ match: { path: '/' }, upstream: 'o.test', bodyRewrite: {} }],
      async () => {
        const pair = new WebSocketPair();
        return new Response(null, { status: 101, webSocket: pair[1] } as ResponseInit);
      },
    );
    const res = await app.request(
      new Request('https://p.dev/ws', { headers: { upgrade: 'websocket' } }),
    );
    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();
  });

  it('never retries an upgrade', async () => {
    // A handshake cannot be replayed: the client is waiting on one socket.
    let attempts = 0;
    const app = appWith([{ match: { path: '/' }, upstream: 'o.test', retries: 3 }], async () => {
      attempts += 1;
      throw new Error('transient');
    });
    await app.request(new Request('https://p.dev/ws', { headers: { upgrade: 'websocket' } }));
    expect(attempts).toBe(1);
  });

  it('strips the handshake when the route has WebSockets off', async () => {
    // Declining to special-case an upgrade is not the same as disabling it: the
    // upstream would still see the handshake and could still answer 101, leaving
    // the option with no observable effect.
    const upstream = spy();
    const app = appWith(
      [{ match: { path: '/' }, upstream: 'o.test', websocket: false }],
      upstream.fetchImpl,
    );
    await app.request(
      new Request('https://p.dev/ws', {
        headers: {
          upgrade: 'websocket',
          'sec-websocket-key': 'abc',
          'sec-websocket-version': '13',
        },
      }),
    );
    const seen = upstream.seen();
    expect(seen.headers.get('upgrade')).toBeNull();
    expect(seen.headers.get('sec-websocket-key')).toBeNull();
  });
});

describe('an http upstream', () => {
  it('uses the scheme the route asked for', async () => {
    // Every upstream was forced to https, so a local or in-network origin was
    // unreachable.
    const upstream = spy();
    const app = appWith(
      [
        {
          match: { path: '/' },
          upstream: 'localhost:8787',
          allowPrivateUpstream: true,
          scheme: 'http',
        },
      ],
      upstream.fetchImpl,
    );
    await app.request('https://p.dev/x');
    expect(upstream.seen().url).toBe('http://localhost:8787/x');
  });
});

describe('observability', () => {
  const record = () => {
    const events: Record<string, unknown>[] = [];
    return { events, onProxy: (event: Record<string, unknown>) => events.push(event) };
  };

  const run = async (
    routes: ConfigInput['routes'],
    fetchImpl: typeof fetch,
    onProxy: (event: never) => void,
    request = new Request('https://p.dev/x', { headers: { 'cf-connecting-ip': '203.0.113.1' } }),
  ) => {
    const app = new Hono();
    app.use('*', jouska({ config: defineConfig({ routes }), fetchImpl, onProxy }));
    return app.fetch(request, {});
  };

  it('reports a successful proxy', async () => {
    const { events, onProxy } = record();
    await run(
      [{ id: 'api', match: { path: '/' }, upstream: 'o.test' }],
      async () => new Response('ok', { status: 201 }),
      onProxy as (event: never) => void,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      routeId: 'api',
      upstream: 'o.test',
      method: 'GET',
      path: '/x',
      status: 201,
      attempts: 1,
      outcome: 'ok',
    });
  });

  it('counts every attempt, so a retry is visible', async () => {
    const { events, onProxy } = record();
    let calls = 0;
    await run(
      [{ match: { path: '/' }, upstream: 'o.test', retries: 2, retryBackoffMs: 0 }],
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error('transient');
        }
        return new Response('ok');
      },
      onProxy as (event: never) => void,
    );
    expect(events[0]).toMatchObject({ attempts: 3, outcome: 'ok' });
  });

  it('reports a refusal without an upstream attempt', async () => {
    const { events, onProxy } = record();
    await run(
      [{ match: { path: '/' }, upstream: 'o.test', blockCountries: ['CU'] }],
      async () => new Response('should not happen'),
      onProxy as (event: never) => void,
      (() => {
        const request = new Request('https://p.dev/x');
        Object.defineProperty(request, 'cf', { value: { country: 'CU' } });
        return request;
      })(),
    );
    expect(events[0]).toMatchObject({ status: 403, outcome: 'refused', attempts: 0 });
  });

  it('classifies a timeout separately from an unreachable upstream', async () => {
    const { events, onProxy } = record();
    await run(
      [{ match: { path: '/' }, upstream: 'o.test', timeoutMs: 40 }],
      async (input) =>
        new Promise<Response>((_, reject) => {
          const request = input as Request;
          request.signal.addEventListener('abort', () => reject(request.signal.reason));
        }),
      onProxy as (event: never) => void,
    );
    expect(events[0]).toMatchObject({ status: 504, outcome: 'timeout' });
  });

  it('cannot fail the request by throwing', async () => {
    const res = await run(
      [{ match: { path: '/' }, upstream: 'o.test' }],
      async () => new Response('ok'),
      (() => {
        throw new Error('observability exploded');
      }) as unknown as (event: never) => void,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('guard ordering and composition', () => {
  it('refuses before spending a binding call or a round trip', async () => {
    // Guards run cheapest-first so a request that will be refused never costs
    // the things that are metered.
    let upstreamCalls = 0;
    let limiterCalls = 0;
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: [
            {
              match: { path: '/' },
              upstream: 'o.test',
              blockCountries: ['CU'],
              rateLimit: { binding: 'RL' },
            },
          ],
        }),
        fetchImpl: async () => {
          upstreamCalls += 1;
          return new Response('up');
        },
      }),
    );
    const request = new Request('https://p.dev/x', { headers: { 'cf-connecting-ip': '5.6.7.8' } });
    Object.defineProperty(request, 'cf', { value: { country: 'CU' } });
    await app.fetch(request, {
      RL: {
        limit: async () => {
          limiterCalls += 1;
          return { success: true };
        },
      },
    });
    expect(limiterCalls).toBe(0);
    expect(upstreamCalls).toBe(0);
  });

  it('rewrites the body and negotiates CORS in the same response', async () => {
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: [
            {
              match: { path: '/' },
              upstream: 'o.test',
              bodyRewrite: {},
              cors: { credentials: true },
            },
          ],
        }),
        fetchImpl: async () =>
          new Response('<a href="https://o.test/a">x</a>', {
            headers: { 'content-type': 'text/html' },
          }),
      }),
    );
    const res = await app.request(
      new Request('https://p.dev/x', { headers: { origin: 'https://a.test' } }),
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('https://a.test');
    expect(await res.text()).toContain('https://p.dev/a');
  });

  it('still sends CORS headers on an upstream failure', async () => {
    // Without them the browser reports a CORS error rather than the 502, which
    // sends whoever is debugging it after the wrong problem.
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: [{ match: { path: '/' }, upstream: 'o.test', cors: { credentials: true } }],
        }),
        fetchImpl: async () => {
          throw new Error('down');
        },
      }),
    );
    const res = await app.request(
      new Request('https://p.dev/x', { headers: { origin: 'https://a.test' } }),
    );
    expect(res.status).toBe(502);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://a.test');
  });

  it('falls through to the app when the method does not match', async () => {
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: [{ match: { path: '/api', methods: ['GET'] }, upstream: 'o.test' }],
        }),
        fetchImpl: async () => new Response('up'),
      }),
    );
    app.delete('/api', (c) => c.text('handled locally'));
    const res = await app.request(new Request('https://p.dev/api', { method: 'DELETE' }));
    expect(await res.text()).toBe('handled locally');
  });
});

describe('a full site mirror, end to end', () => {
  /** The scenario the library exists for: every layer has to cooperate. */
  const origin: typeof fetch = async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    const url = new URL(request.url);
    if (url.pathname === '/login') {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://www.origin.test/dash' },
      });
    }
    const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', etag: '"v1"' });
    headers.append('set-cookie', 'sid=abc; Domain=origin.test; Path=/; Secure; HttpOnly');
    headers.append('set-cookie', 'ga=1; Domain=analytics.example; Path=/');
    return new Response(
      [
        '<link rel="stylesheet" href="https://origin.test/s.css">',
        '<style>body{background:url(https://origin.test/bg.png)}</style>',
        '<a href="https://origin.test/about">About</a>',
        '<a href="https://other.test/ext">External</a>',
        '<img srcset="https://origin.test/a.png 1x, https://origin.test/b.png 2x">',
        '<form action="https://origin.test/search"><input name=q></form>',
        '<p>Visit origin.test for more</p>',
      ].join('\n'),
      { headers },
    );
  };

  const mirror = () =>
    appWith([{ match: { path: '/' }, upstream: 'origin.test', bodyRewrite: {} }], origin);

  it('points every navigable URL at the mirror', async () => {
    const html = await (await mirror().request('https://mirror.test/')).text();
    expect(html).toContain('href="https://mirror.test/s.css"');
    expect(html).toContain('url(https://mirror.test/bg.png)');
    expect(html).toContain('href="https://mirror.test/about"');
    expect(html).toContain('action="https://mirror.test/search"');
    expect(html).toContain('https://mirror.test/a.png 1x, https://mirror.test/b.png 2x');
  });

  it('leaves external links and prose alone', async () => {
    const html = await (await mirror().request('https://mirror.test/')).text();
    expect(html).toContain('href="https://other.test/ext"');
    // Rewriting prose would corrupt the page for no navigational benefit.
    expect(html).toContain('Visit origin.test for more');
  });

  it('rescopes the site cookie and not the third-party one', async () => {
    const set = (await mirror().request('https://mirror.test/')).headers.getSetCookie();
    expect(set).toContain('sid=abc; Domain=mirror.test; Path=/; Secure; HttpOnly');
    expect(set).toContain('ga=1; Path=/');
  });

  it('drops the validator so a later 304 cannot undo the rewrite', async () => {
    expect((await mirror().request('https://mirror.test/')).headers.get('etag')).toBeNull();
  });

  it('keeps a redirect to a sibling subdomain on the mirror', async () => {
    const res = await mirror().request('https://mirror.test/login');
    expect(res.headers.get('location')).toBe('https://mirror.test/dash');
  });
});

describe('charset correctness', () => {
  /** 0x41 0xE9 0x42 — "A", a high byte, "B". */
  const highByte = new Uint8Array([0x41, 0xe9, 0x42]);

  const serve = (contentType: string) =>
    appWith(
      [{ match: { path: '/' }, upstream: 'o.test', bodyRewrite: { contentTypes: ['text/plain'] } }],
      async () => new Response(highByte, { headers: { 'content-type': contentType } }),
    );

  it.each([
    ['text/plain; charset=us-ascii', 'us-ascii'],
    ['text/plain; charset=iso-8859-1', 'iso-8859-1'],
    ['text/plain; charset=windows-1252', 'windows-1252'],
  ])('corrects the declared charset for %s', async (contentType) => {
    // workerd decodes all of these with a windows-1252 table, so the high byte
    // becomes a character that re-encodes as two UTF-8 bytes. Treating any of
    // them as pass-through changed the body while leaving Content-Type claiming
    // the original charset — so the browser would decode correct bytes wrongly.
    const res = await serve(contentType).request('https://p.dev/x');
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe('AéB');
  });

  it('leaves a UTF-8 body and its header alone', async () => {
    const res = await serve('text/plain; charset=utf-8').request('https://p.dev/x');
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('assumes UTF-8 when nothing is declared', async () => {
    const utf8 = new TextEncoder().encode('héllo');
    const app = appWith(
      [{ match: { path: '/' }, upstream: 'o.test', bodyRewrite: { contentTypes: ['text/plain'] } }],
      async () => new Response(utf8, { headers: { 'content-type': 'text/plain' } }),
    );
    expect(await (await app.request('https://p.dev/x')).text()).toBe('héllo');
  });
});

describe('non-HTML text bodies get the same URL awareness as HTML', () => {
  const serve = (body: string, contentType: string) =>
    appWith(
      [
        {
          match: { path: '/' },
          upstream: 'o.test',
          bodyRewrite: { contentTypes: [contentType.split(';')[0]!] },
        },
      ],
      async () => new Response(body, { headers: { 'content-type': contentType } }),
    );

  it('leaves a lookalike host alone in a stylesheet', async () => {
    // The HTML path parses attribute values, so it was safe. Text bodies were
    // handed `{from: upstreamHost, to: proxyHost}` as a literal replacement,
    // which turned `o.test.evil.com` into `p.dev.evil.com` — breaking the URL and
    // putting the proxy's name inside a domain someone else controls.
    const css =
      '.a{background:url(https://o.test.evil.com/b)} .c{background:url(https://o.test/d)}';
    const out = await (await serve(css, 'text/css').request('https://p.dev/x')).text();
    expect(out).toContain('https://o.test.evil.com/b');
    expect(out).toContain('https://p.dev/d');
  });

  it('leaves a lookalike host alone in a script', async () => {
    const js = 'fetch("https://o.test.evil.com/steal"); fetch("https://o.test/ok");';
    const out = await (await serve(js, 'application/javascript').request('https://p.dev/x')).text();
    expect(out).toContain('https://o.test.evil.com/steal');
    expect(out).toContain('https://p.dev/ok');
  });

  it('rewrites a subdomain of the upstream', async () => {
    const css = '.a{background:url(https://cdn.o.test/b.png)}';
    const out = await (await serve(css, 'text/css').request('https://p.dev/x')).text();
    expect(out).toContain('https://p.dev/b.png');
  });

  it('leaves a bare hostname in text alone', async () => {
    // Only scheme-qualified and protocol-relative references are rewritten, the
    // same restraint the HTML path shows with text nodes.
    const js = 'const host = "o.test"; log("visit o.test");';
    const out = await (await serve(js, 'application/javascript').request('https://p.dev/x')).text();
    expect(out).toBe(js);
  });

  it('resolves a URL split across chunk boundaries', async () => {
    // The host pass runs on tail-buffered chunks, so an authority arriving in two
    // pieces still has to be recognised.
    const encoder = new TextEncoder();
    const app = appWith(
      [{ match: { path: '/' }, upstream: 'o.test', bodyRewrite: { contentTypes: ['text/css'] } }],
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('.a{background:url(https://o.te'));
              controller.enqueue(encoder.encode('st/b.png)}'));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/css' } },
        ),
    );
    expect(await (await app.request('https://p.dev/x')).text()).toBe(
      '.a{background:url(https://p.dev/b.png)}',
    );
  });
});

describe('defaults are validated exactly as a route is', () => {
  it('refuses a reserved header in the defaults block', () => {
    // `removeDefault()` returns the inner record and drops the refinement, so a
    // reserved header written here was accepted and then folded into every route
    // — validated in one place and silently ignored in the other.
    for (const name of ['host', 'x-forwarded-for', 'X-Forwarded-Host', 'x-forwarded-proto']) {
      expect(() =>
        defineConfig({
          defaults: { upstreamHeaders: { [name]: 'evil' } },
          routes: [{ match: { path: '/' }, upstream: 'o.test' }],
        }),
      ).toThrow();
    }
  });

  it('refuses a malformed header name in the defaults block', () => {
    expect(() =>
      defineConfig({
        defaults: { upstreamHeaders: { 'bad header': 'v' } },
        routes: [{ match: { path: '/' }, upstream: 'o.test' }],
      }),
    ).toThrow();
  });

  it.each([
    ['blockCountries', { blockCountries: ['中国'] }],
    ['timeoutMs', { timeoutMs: 99_999 }],
    ['retries', { retries: 99 }],
    ['ip', { ip: { allow: [], deny: [] } }],
  ])('refuses an invalid %s in either place', (_label, value) => {
    const asDefaults = () =>
      defineConfig({
        defaults: value as never,
        routes: [{ match: { path: '/' }, upstream: 'o.test' }],
      });
    const asRoute = () =>
      defineConfig({ routes: [{ match: { path: '/' }, upstream: 'o.test', ...value } as never] });
    expect(asDefaults).toThrow();
    expect(asRoute).toThrow();
  });

  it('normalises a defaults value the same way a route value is normalised', () => {
    const config = defineConfig({
      defaults: { blockCountries: ['cu'] },
      routes: [{ match: { path: '/' }, upstream: 'o.test' }],
    });
    expect(config.routes[0].blockCountries).toEqual(['CU']);
  });
});
