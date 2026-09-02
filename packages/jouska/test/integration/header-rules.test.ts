import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska } from '../../src/middleware/jouska';

/**
 * A controlled upstream that reports the headers it received and hands back the
 * ones an operator typically wants to strip.
 */
const upstream: typeof fetch = async (input) => {
  const request = input instanceof Request ? input : new Request(input);
  const url = new URL(request.url);
  if (url.pathname === '/redirect') {
    return new Response(null, {
      status: 302,
      headers: { location: 'https://origin.test/landed', server: 'nginx/1.25' },
    });
  }
  if (url.pathname === '/page') {
    return new Response('<html><body><img src="https://origin.test/x.png"></body></html>', {
      headers: {
        'content-type': 'text/html',
        'content-security-policy': "default-src 'self'; img-src https://origin.test",
      },
    });
  }
  if (url.pathname === '/leaky') {
    return new Response('ok', {
      headers: {
        'content-type': 'text/plain',
        server: 'nginx/1.25',
        'x-powered-by': 'PHP/8.2',
        'x-request-id': 'abc',
      },
    });
  }
  return Response.json({
    version: request.headers.get('x-api-version'),
    legacy: request.headers.get('x-legacy-client'),
    cookie: request.headers.get('cookie'),
    userAgent: request.headers.get('user-agent'),
    host: request.headers.get('host'),
  });
};

const appWith = (routes: ConfigInput['routes'], defaults?: ConfigInput['defaults']) => {
  const app = new Hono();
  app.use(
    '*',
    jouska({
      config: defineConfig({ ...(defaults !== undefined ? { defaults } : {}), routes }),
      fetchImpl: upstream,
    }),
  );
  return app;
};

const get = (app: Hono, path: string, init?: RequestInit) =>
  app.request(new Request(`https://p.dev${path}`, init));

describe('requestHeaders', () => {
  it('writes and deletes headers on the way to the upstream', async () => {
    const app = appWith([
      {
        match: { path: '/api' },
        upstream: 'origin.test',
        stripPrefix: true,
        requestHeaders: { set: { 'X-Api-Version': '2026-09' }, remove: ['X-Legacy-Client'] },
      },
    ]);
    const body = (await (
      await get(app, '/api/echo', { headers: { 'x-legacy-client': 'yes', 'user-agent': 'ua' } })
    ).json()) as Record<string, string | null>;
    expect(body.version).toBe('2026-09');
    expect(body.legacy).toBeNull();
    // Everything not named by a rule is still forwarded.
    expect(body.userAgent).toBe('ua');
  });

  it('cannot forge Host, whatever a rule tried', async () => {
    // The schema refuses the name outright; this pins the second line of defence,
    // which is that the forwarding headers are written after the rules.
    const app = appWith([{ match: { path: '/api' }, upstream: 'origin.test', stripPrefix: true }]);
    const body = (await (await get(app, '/api/echo')).json()) as Record<string, string>;
    expect(body.host).toBe('origin.test');
  });

  it('can strip the visitor cookie before it reaches a third-party upstream', async () => {
    const app = appWith([
      {
        match: { path: '/api' },
        upstream: 'origin.test',
        stripPrefix: true,
        requestHeaders: { remove: ['cookie'] },
      },
    ]);
    const body = (await (
      await get(app, '/api/echo', { headers: { cookie: 'session=1' } })
    ).json()) as Record<string, string | null>;
    expect(body.cookie).toBeNull();
  });

  it('accepts the legacy upstreamHeaders spelling unchanged', async () => {
    const app = appWith([
      {
        match: { path: '/api' },
        upstream: 'origin.test',
        stripPrefix: true,
        upstreamHeaders: { 'x-api-version': 'legacy' },
      },
    ]);
    const body = (await (await get(app, '/api/echo')).json()) as Record<string, string>;
    expect(body.version).toBe('legacy');
  });
});

describe('responseHeaders', () => {
  it('writes and deletes headers on the way back to the client', async () => {
    const app = appWith([
      {
        match: { path: '/leaky' },
        upstream: 'origin.test',
        responseHeaders: {
          set: { 'X-Content-Type-Options': 'nosniff' },
          remove: ['Server', 'X-Powered-By'],
        },
      },
    ]);
    const res = await get(app, '/leaky');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('server')).toBeNull();
    expect(res.headers.get('x-powered-by')).toBeNull();
    // Untouched headers survive.
    expect(res.headers.get('x-request-id')).toBe('abc');
  });

  it('runs after the proxy rewrote Location, so a rule wins', async () => {
    // Without a rule the redirect lands back on the proxy.
    const plain = appWith([{ match: { path: '/redirect' }, upstream: 'origin.test' }]);
    expect((await get(plain, '/redirect')).headers.get('location')).toBe('https://p.dev/landed');

    // The value below names the *upstream*, which is precisely what the proxy
    // rewrites. Surviving intact is the only observable difference between the
    // rules running last and running first, and it is the documented trade-off:
    // a rule can send the visitor off the proxy. A value naming some third host
    // would prove nothing, since the rewrite would leave that alone either way.
    const overridden = appWith([
      {
        match: { path: '/redirect' },
        upstream: 'origin.test',
        responseHeaders: { set: { location: 'https://origin.test/elsewhere' } },
      },
    ]);
    expect((await get(overridden, '/redirect')).headers.get('location')).toBe(
      'https://origin.test/elsewhere',
    );
  });

  it('can put back a CSP the rewrite dropped, for better or worse', async () => {
    // The other half of "last wins": rewriting deletes the upstream CSP, because
    // it names the upstream's own origin and would block the rewritten page from
    // loading its own assets. A rule can add one back — which the panel flags —
    // and it only survives because the rules run after that deletion.
    const app = appWith([
      {
        match: { path: '/page' },
        upstream: 'origin.test',
        bodyRewrite: {},
        responseHeaders: { set: { 'content-security-policy': "default-src 'self'" } },
      },
    ]);
    const res = await get(app, '/page');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    // And the body really was rewritten, so this is the post-strip path.
    expect(await res.text()).toContain('src="https://p.dev/x.png"');
  });

  it('drops the upstream CSP when no rule puts one back', async () => {
    const app = appWith([{ match: { path: '/page' }, upstream: 'origin.test', bodyRewrite: {} }]);
    expect((await get(app, '/page')).headers.get('content-security-policy')).toBeNull();
  });

  it('still applies with header rewriting turned off', async () => {
    const app = appWith([
      {
        match: { path: '/leaky' },
        upstream: 'origin.test',
        rewriteHeaders: false,
        responseHeaders: { remove: ['server'] },
      },
    ]);
    expect((await get(app, '/leaky')).headers.get('server')).toBeNull();
  });

  it('applies on a rewritten body too, after the validators are stripped', async () => {
    const app = appWith([
      {
        match: { path: '/leaky' },
        upstream: 'origin.test',
        bodyRewrite: { contentTypes: ['text/plain'] },
        responseHeaders: { set: { 'x-content-type-options': 'nosniff' }, remove: ['server'] },
      },
    ]);
    const res = await get(app, '/leaky');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('server')).toBeNull();
    expect(await res.text()).toBe('ok');
  });

  it('takes table-wide rules from defaults', async () => {
    const app = appWith([{ match: { path: '/leaky' }, upstream: 'origin.test' }], {
      responseHeaders: { remove: ['server', 'x-powered-by'] },
    });
    const res = await get(app, '/leaky');
    expect(res.headers.get('server')).toBeNull();
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});
