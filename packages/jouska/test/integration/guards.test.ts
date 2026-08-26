import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { jouska } from '../../src/middleware/jouska';

const reached: typeof fetch = async () => new Response('upstream reached');

const appWith = (routes: ConfigInput['routes']) => {
  const app = new Hono();
  app.use('*', jouska({ config: defineConfig({ routes }), fetchImpl: reached }));
  return app;
};

/** Attaches the Cloudflare-provided client IP the way the platform does. */
const from = (ip: string, init?: RequestInit) =>
  new Request('https://p.dev/x', {
    ...init,
    headers: { ...init?.headers, 'cf-connecting-ip': ip },
  });

describe('CORS', () => {
  it('reflects the caller origin so credentialed requests work', async () => {
    const app = appWith([
      { match: { path: '/x' }, upstream: 'o.test', cors: { credentials: true } },
    ]);
    const res = await app.request(
      new Request('https://p.dev/x', { headers: { origin: 'https://app.test' } }),
    );
    // `*` is illegal beside allow-credentials, so the exact origin must come back.
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.test');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(await res.text()).toBe('upstream reached');
  });

  it('answers a preflight without contacting the upstream', async () => {
    let calls = 0;
    const counting: typeof fetch = async () => {
      calls += 1;
      return new Response('should not happen');
    };
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: [{ match: { path: '/x' }, upstream: 'o.test', cors: { allowMethods: ['POST'] } }],
        }),
        fetchImpl: counting,
      }),
    );
    const res = await app.request(
      new Request('https://p.dev/x', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.test', 'access-control-request-method': 'POST' },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(calls).toBe(0);
  });

  it('restricts to an allow-list when origins are given', async () => {
    const app = appWith([
      { match: { path: '/x' }, upstream: 'o.test', cors: { origins: ['https://ok.test'] } },
    ]);
    const allowed = await app.request(
      new Request('https://p.dev/x', { headers: { origin: 'https://ok.test' } }),
    );
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://ok.test');

    const denied = await app.request(
      new Request('https://p.dev/x', { headers: { origin: 'https://evil.test' } }),
    );
    expect(denied.headers.get('access-control-allow-origin')).not.toBe('https://evil.test');
  });

  it('leaves responses untouched when CORS is not configured', async () => {
    const app = appWith([{ match: { path: '/x' }, upstream: 'o.test' }]);
    const res = await app.request(
      new Request('https://p.dev/x', { headers: { origin: 'https://app.test' } }),
    );
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('IP restriction', () => {
  it('admits an address inside the allow-list CIDR', async () => {
    const app = appWith([
      { match: { path: '/x' }, upstream: 'o.test', ip: { allow: ['203.0.113.0/24'] } },
    ]);
    const res = await app.request(from('203.0.113.9'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('upstream reached');
  });

  it('refuses an address outside the allow-list', async () => {
    const app = appWith([
      { match: { path: '/x' }, upstream: 'o.test', ip: { allow: ['203.0.113.0/24'] } },
    ]);
    expect((await app.request(from('198.51.100.7'))).status).toBe(403);
  });

  it('refuses an address in the deny-list', async () => {
    const app = appWith([
      { match: { path: '/x' }, upstream: 'o.test', ip: { deny: ['198.51.100.0/24'] } },
    ]);
    expect((await app.request(from('198.51.100.7'))).status).toBe(403);
    expect((await app.request(from('203.0.113.1'))).status).toBe(200);
  });

  it('never reaches the upstream for a refused address', async () => {
    let calls = 0;
    const counting: typeof fetch = async () => {
      calls += 1;
      return new Response('nope');
    };
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: [{ match: { path: '/x' }, upstream: 'o.test', ip: { deny: ['198.51.100.7'] } }],
        }),
        fetchImpl: counting,
      }),
    );
    await app.request(from('198.51.100.7'));
    expect(calls).toBe(0);
  });
});

describe('rate limiting', () => {
  /** Stands in for the Cloudflare binding, recording the keys it is asked about. */
  const limiter = (allow: number) => {
    const keys: string[] = [];
    let seen = 0;
    return {
      keys,
      binding: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          seen += 1;
          return { success: seen <= allow };
        },
      },
    };
  };

  const appWithLimiter = (routes: ConfigInput['routes'], binding: unknown) => {
    const app = new Hono();
    app.use('*', jouska({ config: defineConfig({ routes }), fetchImpl: reached }));
    return (request: Request) => app.fetch(request, { RL: binding });
  };

  it('admits requests under the limit and refuses beyond it', async () => {
    const { binding } = limiter(1);
    const call = appWithLimiter(
      [{ match: { path: '/x' }, upstream: 'o.test', rateLimit: { binding: 'RL' } }],
      binding,
    );
    expect((await call(from('203.0.113.1'))).status).toBe(200);
    const refused = await call(from('203.0.113.1'));
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as Record<string, string>).error).toBe('rate_limited');
  });

  it('keys by caller IP by default', async () => {
    const { binding, keys } = limiter(99);
    const call = appWithLimiter(
      [{ match: { path: '/x' }, upstream: 'o.test', rateLimit: { binding: 'RL' } }],
      binding,
    );
    await call(from('203.0.113.1'));
    expect(keys[0]).toContain('203.0.113.1');
  });

  it('includes the path when keying by path', async () => {
    const { binding, keys } = limiter(99);
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: [
            { match: { path: '/x' }, upstream: 'o.test', rateLimit: { binding: 'RL', by: 'path' } },
          ],
        }),
        fetchImpl: reached,
      }),
    );
    await app.fetch(
      new Request('https://p.dev/x/deep', { headers: { 'cf-connecting-ip': '203.0.113.1' } }),
      { RL: binding },
    );
    expect(keys[0]).toContain('/x/deep');
  });

  it('shares one bucket across callers when keying by route', async () => {
    const { binding, keys } = limiter(99);
    const call = appWithLimiter(
      [{ match: { path: '/x' }, upstream: 'o.test', rateLimit: { binding: 'RL', by: 'route' } }],
      binding,
    );
    await call(from('203.0.113.1'));
    await call(from('198.51.100.2'));
    expect(keys[0]).toBe(keys[1]);
  });

  it('reports a missing binding as a server error rather than admitting traffic', async () => {
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: [{ match: { path: '/x' }, upstream: 'o.test', rateLimit: { binding: 'ABSENT' } }],
        }),
        fetchImpl: reached,
      }),
    );
    const res = await app.fetch(from('203.0.113.1'), {});
    expect(res.status).toBe(500);
    expect(((await res.json()) as Record<string, string>).error).toBe('rate_limit_misconfigured');
  });

  it('never reaches the upstream once the limit is exceeded', async () => {
    let calls = 0;
    const counting: typeof fetch = async () => {
      calls += 1;
      return new Response('nope');
    };
    const { binding } = limiter(0);
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: [{ match: { path: '/x' }, upstream: 'o.test', rateLimit: { binding: 'RL' } }],
        }),
        fetchImpl: counting,
      }),
    );
    await app.fetch(from('203.0.113.1'), { RL: binding });
    expect(calls).toBe(0);
  });
});
