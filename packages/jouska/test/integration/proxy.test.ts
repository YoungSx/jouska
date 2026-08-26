import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska } from '../../src/middleware/jouska';

/**
 * A controlled upstream. Everything runs inside workerd, so these exercise the
 * real runtime (HTMLRewriter, streams, AbortSignal) without touching the network.
 */
const upstream: typeof fetch = async (input) => {
  const request = input instanceof Request ? input : new Request(input);
  const url = new URL(request.url);

  switch (url.pathname) {
    case '/echo':
      return new Response(
        JSON.stringify({
          method: request.method,
          path: url.pathname + url.search,
          host: request.headers.get('host'),
          forwardedHost: request.headers.get('x-forwarded-host'),
          forwardedFor: request.headers.get('x-forwarded-for'),
          injected: request.headers.get('x-injected'),
          body: await request.text(),
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    case '/page':
      return new Response(
        '<html><body><a href="https://origin.test/next">n</a><p>origin.test in text</p></body></html>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    case '/css':
      return new Response('body{background:url(https://origin.test/bg.png)}', {
        headers: { 'content-type': 'text/css' },
      });
    case '/csp':
      return new Response('<html><body><img src="https://origin.test/x.png"></body></html>', {
        headers: {
          'content-type': 'text/html',
          'content-security-policy': "default-src 'self'; img-src https://origin.test",
          'content-security-policy-report-only': "default-src 'self'",
        },
      });
    case '/binary':
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        headers: { 'content-type': 'image/png' },
      });
    case '/redirect':
      return new Response(null, {
        status: 302,
        headers: { location: 'https://origin.test/landed' },
      });
    case '/cookies': {
      const headers = new Headers({ 'content-type': 'text/plain' });
      headers.append('set-cookie', 'a=1; Domain=origin.test; Path=/');
      headers.append('set-cookie', 'b=2; Domain=origin.test; HttpOnly');
      return new Response('ok', { headers });
    }
    case '/slow':
      // Honour the signal the way a real fetch does, so the deadline is
      // genuinely exercised rather than merely outlasted.
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('late')), 2_000);
        request.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted', 'TimeoutError'));
        });
      });
    case '/boom':
      throw new Error('upstream exploded');
    default:
      return new Response('not found', { status: 404 });
  }
};

const appWith = (routes: ConfigInput['routes']) => {
  const app = new Hono();
  app.use('*', jouska({ config: defineConfig({ routes }), fetchImpl: upstream }));
  app.get('/local', (c) => c.text('handled locally'));
  return app;
};

const get = (app: Hono, path: string, init?: RequestInit) =>
  app.request(new Request(`https://p.dev${path}`, init));

describe('forwarding', () => {
  const app = appWith([{ match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true }]);

  it('forwards the path, query and method', async () => {
    const res = await get(app, '/api/echo?q=1', { method: 'POST', body: 'hi' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.path).toBe('/echo?q=1');
    expect(body.method).toBe('POST');
    expect(body.body).toBe('hi');
  });

  it('sets Host to the upstream and forwards the original host', async () => {
    const body = (await (await get(app, '/api/echo')).json()) as Record<string, string>;
    expect(body.host).toBe('origin.test');
    expect(body.forwardedHost).toBe('p.dev');
  });

  it('forwards cf-connecting-ip as x-forwarded-for, overwriting a forged value', async () => {
    const res = await get(app, '/api/echo', {
      headers: { 'cf-connecting-ip': '203.0.113.10', 'x-forwarded-for': '1.1.1.1' },
    });
    const body = (await res.json()) as Record<string, string>;
    expect(body.forwardedFor).toBe('203.0.113.10');
  });

  it('omits x-forwarded-for when cf-connecting-ip is absent', async () => {
    const body = (await (await get(app, '/api/echo')).json()) as Record<string, string>;
    expect(body.forwardedFor).toBeNull();
  });

  it('lets upstreamHeaders set arbitrary headers but not override forwarded ones', async () => {
    const withHeader = appWith([
      {
        match: { path: '/api' },
        upstream: 'origin.test',
        stripPrefix: true,
        // A user trying to forge XFF or Host via upstreamHeaders must lose to
        // the values jouska sets: their position after the spread is wrong.
        upstreamHeaders: { 'x-injected': 'yes', host: 'evil.test', 'x-forwarded-for': '9.9.9.9' },
      },
    ]);
    const body = (await (
      await get(withHeader, '/api/echo', {
        headers: { 'cf-connecting-ip': '203.0.113.10' },
      })
    ).json()) as Record<string, string>;
    expect(body.injected).toBe('yes');
    expect(body.host).toBe('origin.test');
    expect(body.forwardedFor).toBe('203.0.113.10');
  });

  it('passes binary bodies through untouched', async () => {
    const res = await get(app, '/api/binary');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it('falls through to the app when no route matches', async () => {
    expect(await (await get(app, '/local')).text()).toBe('handled locally');
  });
});

describe('header rewriting', () => {
  const app = appWith([{ match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true }]);

  it('keeps redirects on the proxy', async () => {
    const res = await get(app, '/api/redirect');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://p.dev/landed');
  });

  it('rescopes every cookie to the proxy host', async () => {
    const res = await get(app, '/api/cookies');
    expect(res.headers.getSetCookie()).toEqual([
      'a=1; Domain=p.dev; Path=/',
      'b=2; Domain=p.dev; HttpOnly',
    ]);
  });

  it('leaves headers alone when rewriting is off', async () => {
    const raw = appWith([
      {
        match: { path: '/api' },
        upstream: 'origin.test',
        stripPrefix: true,
        rewriteHeaders: false,
      },
    ]);
    expect((await get(raw, '/api/redirect')).headers.get('location')).toBe(
      'https://origin.test/landed',
    );
  });
});

describe('body rewriting', () => {
  it('rewrites HTML attributes but not text', async () => {
    const app = appWith([
      { match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true, bodyRewrite: {} },
    ]);
    const html = await (await get(app, '/api/page')).text();
    expect(html).toContain('href="https://p.dev/next"');
    expect(html).toContain('origin.test in text');
  });

  it('rewrites non-HTML text when its type is allowed', async () => {
    const app = appWith([
      {
        match: { path: '/api' },
        upstream: 'origin.test',
        stripPrefix: true,
        bodyRewrite: { contentTypes: ['text/css'] },
      },
    ]);
    expect(await (await get(app, '/api/css')).text()).toBe(
      'body{background:url(https://p.dev/bg.png)}',
    );
  });

  it('never rewrites a type outside the allow-list', async () => {
    const app = appWith([
      { match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true, bodyRewrite: {} },
    ]);
    // content-type is text/css, allow-list defaults to text/html only
    expect(await (await get(app, '/api/css')).text()).toContain('origin.test');
  });

  it('applies extra literal replacements', async () => {
    const app = appWith([
      {
        match: { path: '/api' },
        upstream: 'origin.test',
        stripPrefix: true,
        bodyRewrite: {
          rewriteLinks: false,
          contentTypes: ['text/css'],
          replace: [{ from: 'background', to: 'color' }],
        },
      },
    ]);
    expect(await (await get(app, '/api/css')).text()).toContain('color:url');
  });

  it('drops content-length once the body changes', async () => {
    const app = appWith([
      { match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true, bodyRewrite: {} },
    ]);
    expect((await get(app, '/api/page')).headers.get('content-length')).toBeNull();
  });

  it('strips CSP headers when the body is rewritten', async () => {
    const app = appWith([
      { match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true, bodyRewrite: {} },
    ]);
    const res = await get(app, '/api/csp');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('content-security-policy-report-only')).toBeNull();
    // The rewrite itself still happened: the img src now points at the proxy.
    expect(await res.text()).toContain('https://p.dev/x.png');
  });

  it('leaves CSP intact when body rewriting is off', async () => {
    const app = appWith([{ match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true }]);
    expect((await get(app, '/api/csp')).headers.get('content-security-policy')).toBe(
      "default-src 'self'; img-src https://origin.test",
    );
  });
});

describe('failure handling', () => {
  it('reports a timeout as 504', async () => {
    const app = appWith([
      { match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true, timeoutMs: 50 },
    ]);
    const res = await get(app, '/api/slow');
    expect(res.status).toBe(504);
    expect(((await res.json()) as Record<string, string>).error).toBe('upstream_timeout');
  });

  it('reports an unreachable upstream as 502', async () => {
    const app = appWith([{ match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true }]);
    const res = await get(app, '/api/boom');
    expect(res.status).toBe(502);
    expect(((await res.json()) as Record<string, string>).error).toBe('upstream_unreachable');
  });
});
