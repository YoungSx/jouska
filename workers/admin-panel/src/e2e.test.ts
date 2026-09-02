/**
 * End-to-end tests against the real workerd runtime: real D1 (migrations
 * applied), real KV, the worker's own fetch handler, and finally the reverse
 * proxy reading what publish wrote — the full operator path with no mocks in
 * the middle.
 *
 * `cloudflare:test`'s per-test storage isolation is not assumed here (its
 * semantics changed across pool versions); state is reset explicitly instead,
 * so the tests also document what a clean slate means for this schema.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from './index.js';
import proxy, { __resetConfigCache } from '../../reverse-proxy/index.js';
import type { AppEnv, Env } from './env.js';

/**
 * The pool types `env` from the wrangler config; without generated
 * worker-configuration types that surface is the empty `Cloudflare.Env`, so
 * the test states the shape it relies on in exactly one cast.
 */
const testEnv = env as unknown as Env;
/** Hono's typed env; the Variables bag is empty until the auth middleware runs. */
const appEnv = testEnv as unknown as AppEnv;

interface HeadersLike {
  get(name: string): string | null;
}

interface ResponseLike {
  status: number;
  headers: HeadersLike;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

const base = 'https://panel.test';
const ORIGIN = { origin: base, 'content-type': 'application/json' };

/** POST/PUT with the same-origin Origin header the CSRF middleware demands. */
const call = async (
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ResponseLike> =>
  worker.fetch(
    new Request(`${base}${path}`, {
      method,
      headers: {
        ...ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    appEnv,
    {} as ExecutionContext,
  ) as unknown as Promise<ResponseLike>;

const get = async (path: string, headers: Record<string, string> = {}): Promise<ResponseLike> =>
  worker.fetch(
    new Request(`${base}${path}`, { headers }),
    appEnv,
    {} as ExecutionContext,
  ) as unknown as Promise<ResponseLike>;

let adminCookie = '';
let viewerCookie = '';

const login = async (subject: string, password: string): Promise<ResponseLike> => {
  const res = await call('POST', '/api/auth/login', { subject, password });
  const setCookie = res.headers.get('set-cookie') ?? '';
  expect(/jouska_session=([^;]+)/.test(setCookie), 'login must set the session cookie').toBe(true);
  return {
    status: res.status,
    headers: {
      get: (n: string) => (n.toLowerCase() === 'set-cookie' ? setCookie : res.headers.get(n)),
    },
    json: () => res.json(),
    text: () => res.text(),
  };
};

const cookieFrom = (res: ResponseLike): string => {
  const raw = res.headers.get('set-cookie') ?? '';
  return `jouska_session=${/jouska_session=([^;]+)/.exec(raw)?.[1] ?? ''}`;
};

const bootstrapAdmin = async (): Promise<void> => {
  const res = await call('POST', '/api/auth/bootstrap', {
    subject: 'root',
    password: 'correct-horse-battery',
  });
  expect(res.status, JSON.stringify(await res.json())).toBe(201);
};

/** Creates the viewer through the panel's own admin API — the operator path. */
// 参数名避开模块级 adminCookie（no-shadow）：这里直接收 auth 对象，与测试体同款。
const createViewer = async (auth: { cookie: string }): Promise<void> => {
  const res = await call(
    'POST',
    '/api/users',
    { subject: 'viewer', password: 'viewer-password-123', role: 'viewer' },
    auth,
  );
  expect(res.status, JSON.stringify(await res.json())).toBe(201);
};

const theRoute = {
  // Path patterns are plain prefixes in jouska: '/' matches every path.
  match: { host: 'app.example.com', path: '/' },
  upstream: 'app.internal.example.com',
  timeoutMs: 5000,
};

describe('admin panel end-to-end', () => {
  beforeEach(async () => {
    await applyD1Migrations(testEnv.DB, TEST_MIGRATIONS);
    // Fresh slate for every case: remove what earlier cases (or earlier
    // migrations applied to a live database) may have left behind.
    for (const table of ['audit_log', 'sessions', 'routes', 'settings', 'mcp_tokens', 'users']) {
      await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
    }
    // D1 is not the only durable state: publish writes KV, and a leftover
    // document would make the "nothing stored" assertions below lie.
    await testEnv.CONFIG_KV.delete('routes');
    adminCookie = '';
    viewerCookie = '';
    __resetConfigCache();
  });

  it('health is open, everything else needs a session', async () => {
    expect((await get('/api/health')).status).toBe(200);
    expect((await get('/api/routes')).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { subject: 'x', password: 'y' })).status).toBe(
      401,
    );
  });

  it('bootstrap is once-only and enforces the password floor', async () => {
    expect(
      (await call('POST', '/api/auth/bootstrap', { subject: 'root', password: 'short' })).status,
    ).toBe(400);
    await bootstrapAdmin();
    expect(
      (
        await call('POST', '/api/auth/bootstrap', {
          subject: 'eve',
          password: 'another-long-password',
        })
      ).status,
    ).toBe(409);
  });

  it('/me reports login state and whether bootstrap is still open', async () => {
    const before = (await get('/api/auth/me')).json() as Promise<{
      user: unknown;
      bootstrapable?: boolean;
    }>;
    expect((await before).user).toBeNull();
    expect((await before).bootstrapable).toBe(true);

    await bootstrapAdmin();
    const after = (await get('/api/auth/me')).json() as Promise<{
      user: unknown;
      bootstrapable?: boolean;
    }>;
    expect((await after).user).toBeNull();
    expect((await after).bootstrapable).toBe(false);
  });

  it('wrong passwords never reveal which part was wrong', async () => {
    await bootstrapAdmin();
    expect(
      (
        await call('POST', '/api/auth/login', {
          subject: 'nobody',
          password: 'correct-horse-battery',
        })
      ).status,
    ).toBe(401);
    expect(
      (await call('POST', '/api/auth/login', { subject: 'root', password: 'wrong-password-long' }))
        .status,
    ).toBe(401);
  });

  it('locks the account after five consecutive failures and unlocks on success', async () => {
    await bootstrapAdmin();
    for (let i = 0; i < 5; i += 1) {
      expect(
        (
          await call('POST', '/api/auth/login', {
            subject: 'root',
            password: 'wrong-password-long',
          })
        ).status,
      ).toBe(401);
    }
    const locked = await call('POST', '/api/auth/login', {
      subject: 'root',
      password: 'correct-horse-battery',
    });
    expect(locked.status).toBe(429);
    const body = (await locked.json()) as { retryAfterSeconds?: number };
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);

    // An operator clears the lockout; the next good password works and resets
    // the counter.
    await testEnv.DB.prepare(
      'UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE subject = ?',
    )
      .bind('root')
      .run();
    const ok = await login('root', 'correct-horse-battery');
    expect(ok.status).toBe(200);
    adminCookie = cookieFrom(ok);

    // Wrong password again: the counter starts from zero, so no lock.
    expect(
      (await call('POST', '/api/auth/login', { subject: 'root', password: 'wrong-password-long' }))
        .status,
    ).toBe(401);
  });

  it('rejects cross-origin and missing-Origin mutations, login included', async () => {
    await bootstrapAdmin();
    const noOrigin = (await worker.fetch(
      new Request(`${base}/api/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ subject: 'root', password: 'correct-horse-battery' }),
      }),
      appEnv,
      {} as ExecutionContext,
    )) as unknown as ResponseLike;
    expect(noOrigin.status).toBe(403);

    const evil = await call(
      'POST',
      '/api/auth/login',
      { subject: 'root', password: 'correct-horse-battery' },
      { origin: 'https://evil.test' },
    );
    expect(evil.status).toBe(403);
  });

  it('runs the full operator loop and the proxy serves what was published', async () => {
    await bootstrapAdmin();
    const loginRes = await login('root', 'correct-horse-battery');
    expect(loginRes.status).toBe(200);
    adminCookie = cookieFrom(loginRes);
    const auth = { cookie: adminCookie };

    // Unauthenticated reads are still closed even after bootstrap.
    expect((await get('/api/routes')).status).toBe(401);

    // A route whose id would collide with the definition's own id is still
    // stored; compile forces the row id at publish time.
    expect((await call('PUT', '/api/routes/app', { definition: theRoute }, auth)).status).toBe(200);
    expect((await get('/api/routes', auth)).status).toBe(200);

    // Preview: compiles, validates, reports no shadows or dangers.
    const preview = await get('/api/preview', auth);
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      ok: boolean;
      routeCount?: number;
      document?: { version?: number };
      mirrorWarnings?: readonly { routeId: string; upstream: string }[];
    };
    expect(previewBody.ok).toBe(true);
    expect(previewBody.routeCount).toBe(1);
    expect(previewBody.document?.version).toBe(1);
    // `theRoute` takes the whole site with no `bodyRewrite`, so the mirror
    // advisory travels the whole way out to the response — and, being an
    // advisory, changes nothing about whether this publishes.
    expect(previewBody.mirrorWarnings).toEqual([
      { routeId: 'app', upstream: 'app.internal.example.com' },
    ]);

    // Publish: one KV write, revision 1.
    const publish = await call('POST', '/api/publish', { note: 'first' }, auth);
    expect(publish.status).toBe(200);
    const publishBody = (await publish.json()) as {
      ok: boolean;
      revision?: number;
      mirrorWarnings?: readonly { routeId: string }[];
    };
    expect(publishBody.ok).toBe(true);
    expect(publishBody.revision).toBe(1);
    // Advisory, not a gate: it is reported alongside a successful publish.
    expect(publishBody.mirrorWarnings).toEqual([
      { routeId: 'app', upstream: 'app.internal.example.com' },
    ]);

    // The proxy reads the same KV namespace under the same key. jouska
    // matches on the request URL's host (in production that is the real host),
    // so the probe puts app.example.com in the URL itself. The upstream is
    // faked through the proxy's own test seam — the point is the wiring from
    // publish → KV → proxy config, not the network.
    const proxyRes = await proxy.fetch(
      new Request('https://app.example.com/anything'),
      {
        CONFIG: testEnv.CONFIG_KV,
        CONFIG_KEY: 'routes',
        UPSTREAM_FETCH: async () =>
          new Response('served by app.internal.example.com', { status: 200 }),
      },
      {} as ExecutionContext,
    );
    expect(proxyRes.status).toBe(200);
    expect(await proxyRes.text()).toContain('app.internal.example.com');

    // Audit trail records the whole loop.
    const audit = await get('/api/audit?limit=10', auth);
    const auditBody = (await audit.json()) as { entries: { action: string }[] };
    const actions = auditBody.entries.map((e) => e.action);
    expect(actions).toContain('route.create');
    expect(actions).toContain('config.publish');
  });

  it('viewers may read but not write', async () => {
    await bootstrapAdmin();
    adminCookie = cookieFrom(await login('root', 'correct-horse-battery'));
    await createViewer({ cookie: adminCookie });
    const viewerLogin = await login('viewer', 'viewer-password-123');
    expect(viewerLogin.status).toBe(200);
    viewerCookie = cookieFrom(viewerLogin);
    const vAuth = { cookie: viewerCookie };
    const aAuth = { cookie: adminCookie };

    expect((await get('/api/routes', vAuth)).status).toBe(200);
    expect((await call('PUT', '/api/routes/app', { definition: theRoute }, vAuth)).status).toBe(
      403,
    );
    expect((await call('POST', '/api/publish', {}, vAuth)).status).toBe(403);
    // The user list is admin-only too — a viewer must not even read it.
    expect((await get('/api/users', vAuth)).status).toBe(403);
    // Admin can still write.
    expect((await call('PUT', '/api/routes/app', { definition: theRoute }, aAuth)).status).toBe(
      200,
    );
  });

  it('dangerous switches block publish without confirm', async () => {
    await bootstrapAdmin();
    adminCookie = cookieFrom(await login('root', 'correct-horse-battery'));
    const auth = { cookie: adminCookie };
    await call(
      'PUT',
      '/api/routes/risky',
      {
        definition: {
          match: { host: 'r.example.com', path: '/' },
          upstream: 'r.example.com',
          allowPrivateUpstream: true,
        },
      },
      auth,
    );

    const blocked = await call('POST', '/api/publish', {}, auth);
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as {
      error?: string;
      dangers?: Record<string, unknown>;
    };
    expect(blockedBody.error).toBe('confirmation_required');
    expect(Object.keys(blockedBody.dangers ?? {})).toContain('risky');

    const allowed = await call('POST', '/api/publish', { confirm: true }, auth);
    expect(allowed.status).toBe(200);
  });

  it('invalid routes fail preview and publish with row-mapped issues', async () => {
    await bootstrapAdmin();
    adminCookie = cookieFrom(await login('root', 'correct-horse-battery'));
    const auth = { cookie: adminCookie };
    // `/*` trips the panel's own prefix-semantics guard; a route with no host
    // and no path would fail the schema. Either must block publish.
    await call(
      'PUT',
      '/api/routes/bad',
      { definition: { match: { host: 'b.example.com', path: '/*' }, upstream: 'b.example.com' } },
      auth,
    );

    for (const path of ['/api/preview', '/api/publish']) {
      const res =
        path === '/api/preview' ? await get(path, auth) : await call('POST', path, {}, auth);
      const body = (await res.json()) as { issues?: { routeId?: string }[] };
      expect(body.issues?.some((i) => i.routeId === 'bad')).toBe(true);
    }
    // Nothing half-broken was stored to KV.
    const kv = (await testEnv.CONFIG_KV.get('routes', { type: 'json' })) as {
      routes?: unknown[];
    } | null;
    expect(kv).toBeNull();
  });

  it('logout invalidates the session server-side', async () => {
    await bootstrapAdmin();
    adminCookie = cookieFrom(await login('root', 'correct-horse-battery'));
    const auth = { cookie: adminCookie };
    expect((await get('/api/routes', auth)).status).toBe(200);
    expect((await call('POST', '/api/auth/logout', undefined, auth)).status).toBe(200);
    expect((await get('/api/routes', auth)).status).toBe(401);
  });
});
