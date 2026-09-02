import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { resetJwksCacheForTest } from '../../src/internal/access';
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

describe('access control', () => {
  const KEY = 'k9v3r8wq2p5m7x1z4c6b0n8d2f4h6j0l'; // high-entropy; only its digest is configured
  const encoder = new TextEncoder();

  const sha256Hex = async (value: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  /** Builds the app for a route with the given access block. */
  const appWithAccess = (
    access: NonNullable<ConfigInput['routes'][number]['access']>,
    fetchImpl: typeof fetch = reached,
  ) => {
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({ routes: [{ match: { path: '/x' }, upstream: 'o.test', access }] }),
        fetchImpl,
      }),
    );
    return app;
  };

  beforeEach(() => {
    resetJwksCacheForTest();
  });

  describe('API key', () => {
    it('admits a caller presenting the key as Bearer', async () => {
      const app = appWithAccess({ keys: [await sha256Hex(KEY)] });
      const res = await app.request(
        new Request('https://p.dev/x', { headers: { authorization: `Bearer ${KEY}` } }),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('upstream reached');
    });

    it('admits a caller presenting the key in a custom header, raw', async () => {
      const app = appWithAccess({ keys: [await sha256Hex(KEY)], header: 'x-api-key' });
      const res = await app.request(
        new Request('https://p.dev/x', { headers: { 'x-api-key': KEY } }),
      );
      expect(res.status).toBe(200);
    });

    it('refuses a missing key, a wrong key, and an over-long key with 401', async () => {
      const app = appWithAccess({ keys: [await sha256Hex(KEY)] });
      const missing = await app.request(new Request('https://p.dev/x'));
      expect(missing.status).toBe(401);
      expect(((await missing.json()) as Record<string, string>).error).toBe('access_missing');

      const wrong = await app.request(
        new Request('https://p.dev/x', { headers: { authorization: 'Bearer not-the-key' } }),
      );
      expect(wrong.status).toBe(401);
      expect(((await wrong.json()) as Record<string, string>).error).toBe('access_invalid');

      // Refused before hashing — the length cap is what keeps an oversized
      // credential from becoming a CPU bill.
      const overLong = await app.request(
        new Request('https://p.dev/x', { headers: { authorization: `Bearer ${'k'.repeat(513)}` } }),
      );
      expect(overLong.status).toBe(401);
      expect(((await overLong.json()) as Record<string, string>).error).toBe('access_too_long');
    });

    it('treats a bare Authorization value as no credential, not as the key', async () => {
      const app = appWithAccess({ keys: [await sha256Hex(KEY)] });
      const res = await app.request(
        new Request('https://p.dev/x', { headers: { authorization: KEY } }),
      );
      expect(res.status).toBe(401);
    });

    it('never reaches the upstream for a refused key', async () => {
      let calls = 0;
      const counting: typeof fetch = async () => {
        calls += 1;
        return new Response('nope');
      };
      const app = appWithAccess({ keys: [await sha256Hex(KEY)] }, counting);
      await app.request(new Request('https://p.dev/x'));
      expect(calls).toBe(0);
    });
  });

  describe('Cloudflare Access JWT', () => {
    const base64Url = (bytes: Uint8Array): string =>
      btoa([...bytes].map((b) => String.fromCharCode(b)).join(''))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');

    const encodeSegment = (value: unknown): string =>
      base64Url(encoder.encode(JSON.stringify(value)));

    const makeSigner = async () => {
      const pair = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      );
      const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey & {
        kid?: string;
      };
      jwk.kid = 'test-key';
      const sign = async (claims: Record<string, unknown>): Promise<string> => {
        const header = encodeSegment({ alg: 'RS256', typ: 'JWT', kid: 'test-key' });
        const payload = encodeSegment(claims);
        const signature = await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          pair.privateKey,
          encoder.encode(`${header}.${payload}`),
        );
        return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
      };
      return { jwk, sign };
    };

    /** Fetch stub: answers the certs endpoint with the given JWKS, everything else as the upstream. */
    const jwksFetch = (keys: JsonWebKey[]) => {
      const certsCalls: string[] = [];
      const impl: typeof fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.endsWith('/cdn-cgi/access/certs')) {
          certsCalls.push(url);
          return Response.json({ keys });
        }
        return new Response('upstream reached');
      };
      return { impl, certsCalls };
    };

    const validClaims = () => ({
      aud: 'app-audience',
      exp: Math.floor(Date.now() / 1000) + 300,
      email: 'alice@example.com',
    });

    it('admits a valid token and reaches the upstream', async () => {
      const { jwk, sign } = await makeSigner();
      const { impl } = jwksFetch([jwk]);
      const app = appWithAccess({ cloudflare: { team: 'acme', audience: 'app-audience' } }, impl);
      const res = await app.request(
        new Request('https://p.dev/x', {
          headers: { 'cf-access-jwt-assertion': await sign(validClaims()) },
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('upstream reached');
    });

    it('refuses a missing or over-long token with 401', async () => {
      const app = appWithAccess({ cloudflare: { team: 'acme', audience: 'app-audience' } });
      const missing = await app.request(new Request('https://p.dev/x'));
      expect(missing.status).toBe(401);
      expect(((await missing.json()) as Record<string, string>).error).toBe('access_missing');

      const overLong = await app.request(
        new Request('https://p.dev/x', {
          headers: { 'cf-access-jwt-assertion': 'a'.repeat(4097) },
        }),
      );
      expect(overLong.status).toBe(401);
      expect(((await overLong.json()) as Record<string, string>).error).toBe('access_too_long');
    });

    it('refuses an expired token with 401', async () => {
      const { jwk, sign } = await makeSigner();
      const { impl } = jwksFetch([jwk]);
      const app = appWithAccess({ cloudflare: { team: 'acme', audience: 'app-audience' } }, impl);
      const res = await app.request(
        new Request('https://p.dev/x', {
          headers: {
            'cf-access-jwt-assertion': await sign({
              ...validClaims(),
              exp: Math.floor(Date.now() / 1000) - 10,
            }),
          },
        }),
      );
      expect(res.status).toBe(401);
      expect(((await res.json()) as Record<string, string>).error).toBe('access_invalid');
    });

    it('refuses a token signed by another key with 401', async () => {
      const { jwk } = await makeSigner();
      const impostor = await makeSigner();
      const { impl } = jwksFetch([jwk]);
      const app = appWithAccess({ cloudflare: { team: 'acme', audience: 'app-audience' } }, impl);
      const res = await app.request(
        new Request('https://p.dev/x', {
          headers: { 'cf-access-jwt-assertion': await impostor.sign(validClaims()) },
        }),
      );
      expect(res.status).toBe(401);
      expect(((await res.json()) as Record<string, string>).error).toBe('access_invalid');
    });

    it('refuses a token for a different audience with 403', async () => {
      const { jwk, sign } = await makeSigner();
      const { impl } = jwksFetch([jwk]);
      const app = appWithAccess({ cloudflare: { team: 'acme', audience: 'app-audience' } }, impl);
      const res = await app.request(
        new Request('https://p.dev/x', {
          headers: {
            'cf-access-jwt-assertion': await sign({ ...validClaims(), aud: 'other-app' }),
          },
        }),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as Record<string, string>).error).toBe('access_forbidden');
    });

    it('refuses a valid token from an email outside the allow-list with 403', async () => {
      const { jwk, sign } = await makeSigner();
      const { impl } = jwksFetch([jwk]);
      const app = appWithAccess(
        {
          cloudflare: {
            team: 'acme',
            audience: 'app-audience',
            emails: ['alice@example.com'],
          },
        },
        impl,
      );
      const res = await app.request(
        new Request('https://p.dev/x', {
          headers: {
            'cf-access-jwt-assertion': await sign({
              ...validClaims(),
              email: 'mallory@example.com',
            }),
          },
        }),
      );
      expect(res.status).toBe(403);
    });

    it('fails closed with 503 when the JWKS endpoint is down', async () => {
      const impl: typeof fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.endsWith('/cdn-cgi/access/certs')) {
          return new Response('oops', { status: 500 });
        }
        return new Response('upstream reached');
      };
      const app = appWithAccess({ cloudflare: { team: 'acme', audience: 'app-audience' } }, impl);
      const res = await app.request(
        new Request('https://p.dev/x', {
          headers: { 'cf-access-jwt-assertion': await (await makeSigner()).sign(validClaims()) },
        }),
      );
      expect(res.status).toBe(503);
      expect(((await res.json()) as Record<string, string>).error).toBe('access_jwks_unavailable');
    });

    it('hits the certs endpoint once for several requests, thanks to the cache', async () => {
      const { jwk, sign } = await makeSigner();
      const { impl, certsCalls } = jwksFetch([jwk]);
      const app = appWithAccess({ cloudflare: { team: 'acme', audience: 'app-audience' } }, impl);
      const token = await sign(validClaims());
      for (let i = 0; i < 3; i += 1) {
        const res = await app.request(
          new Request('https://p.dev/x', { headers: { 'cf-access-jwt-assertion': token } }),
        );
        expect(res.status).toBe(200);
      }
      expect(certsCalls).toHaveLength(1);
    });
  });

  it('runs access after the rate limiter: an over-limit caller never pays for crypto', async () => {
    let certsCalls = 0;
    const impl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/cdn-cgi/access/certs')) {
        certsCalls += 1;
        return Response.json({ keys: [] });
      }
      return new Response('upstream reached');
    };
    const binding = {
      limit: async () => ({ success: false }),
    };
    const app = new Hono();
    app.use(
      '*',
      jouska({
        config: defineConfig({
          routes: [
            {
              match: { path: '/x' },
              upstream: 'o.test',
              rateLimit: { binding: 'RL' },
              access: { cloudflare: { team: 'acme', audience: 'app-audience' } },
            },
          ],
        }),
        fetchImpl: impl,
      }),
    );
    const res = await app.fetch(from('203.0.113.1'), { RL: binding });
    expect(res.status).toBe(429);
    expect(certsCalls).toBe(0);
  });
});
