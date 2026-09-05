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
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from './index.js';
import proxy, { __resetConfigCache } from '../../reverse-proxy/index.js';
import type { AppEnv, Env } from './env.js';
import { openAccessDoor, type AccessDoor } from './test-access.js';

/**
 * The pool types `env` from the wrangler config; without generated
 * worker-configuration types that surface is the empty `Cloudflare.Env`, so
 * the test states the shape it relies on in exactly one cast.
 */
const testEnv = env as unknown as Env;
/** Hono's typed env; the Variables bag is empty until the auth middleware runs. */
let door: AccessDoor;
let appEnv: AppEnv;

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

const ROOT = 'root@example.com';
const VIEWER = 'viewer@example.com';

/** Admin headers; the first request on an empty table provisions the row. */
const signInAdmin = async (): Promise<Record<string, string>> => {
  const auth = await door.headers(ROOT);
  const res = await get('/api/auth/me', auth);
  expect(res.status, await res.text()).toBe(200);
  return auth;
};

/** Creates the viewer through the panel's own admin API — the operator path. */
const createViewer = async (auth: Record<string, string>): Promise<Record<string, string>> => {
  const res = await call('POST', '/api/users', { subject: VIEWER, role: 'viewer' }, auth);
  expect(res.status, JSON.stringify(await res.json())).toBe(201);
  return await door.headers(VIEWER);
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
    // `revisions` belongs here too: publish writes a row per revision, and a
    // leftover row makes the next test's counter start one higher — the
    // "revision 2" assertion below would red on the whole-file run only.
    for (const table of ['audit_log', 'routes', 'settings', 'mcp_tokens', 'users', 'revisions']) {
      await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
    }
    // D1 is not the only durable state: publish writes KV, and a leftover
    // document would make the "nothing stored" assertions below lie.
    await testEnv.CONFIG_KV.delete('routes');
    __resetConfigCache();
  });

  it('health is open, everything else needs an Access identity', async () => {
    // Health answers even with no BUILD_ID var set — tests run without CI's
    // injection, so the fallback string is what the refusal screens would show.
    const health = (await (await get('/api/health')).json()) as { ok: boolean; build: string };
    expect(health.ok).toBe(true);
    expect(health.build).toBe('dev');
    expect((await get('/api/routes')).status).toBe(401);
    // No endpoint accepts a credential any more, so there is nothing to POST at.
    expect((await call('POST', '/api/publish', {})).status).toBe(401);
  });

  it('provisions the first identity only, and refuses the second by name', async () => {
    const auth = await signInAdmin();
    expect((await get('/api/routes', auth)).status).toBe(200);

    const stranger = await get('/api/routes', await door.headers('eve@example.com'));
    expect(stranger.status).toBe(403);
    expect((await stranger.json()) as unknown).toMatchObject({ error: 'no_panel_account' });
  });

  it('/me reports login state without asking the caller for anything', async () => {
    // The anonymous refusal carries the build too: whoever /me refuses is stuck
    // on a screen whose only version question is answered right there.
    const before = (await (await get('/api/auth/me')).json()) as { user: unknown; build: string };
    expect(before.user).toBeNull();
    expect(before.build).toBe('dev');

    const auth = await signInAdmin();
    const after = (await (await get('/api/auth/me', auth)).json()) as {
      user: { subject: string; role: string } | null;
      build: string;
    };
    expect(after.user).toMatchObject({ subject: ROOT, role: 'admin' });
    expect(after.build).toBe('dev');
  });

  it('rejects cross-origin and missing-Origin mutations, Access token or not', async () => {
    const auth = await signInAdmin();
    const noOrigin = (await worker.fetch(
      new Request(`${base}/api/routes/app`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ definition: theRoute }),
      }),
      appEnv,
      {} as ExecutionContext,
    )) as unknown as ResponseLike;
    expect(noOrigin.status).toBe(403);

    const evil = await call(
      'PUT',
      '/api/routes/app',
      { definition: theRoute },
      { ...auth, origin: 'https://evil.test' },
    );
    expect(evil.status).toBe(403);
    // Neither attempt wrote anything.
    const after = (await (await get('/api/routes', auth)).json()) as { routes: unknown[] };
    expect(after.routes).toHaveLength(0);
  });

  it('runs the full operator loop and the proxy serves what was published', async () => {
    const auth = await signInAdmin();

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

  it('refuses a no-op publish, still publishes real changes, and self-heals a wiped KV', async () => {
    const auth = await signInAdmin();
    expect((await call('PUT', '/api/routes/app', { definition: theRoute }, auth)).status).toBe(200);
    const first = await call('POST', '/api/publish', { note: 'first' }, auth);
    expect(first.status).toBe(200);

    // Republishing identical content is a no-op: 409 already_live, no new
    // revision, no audit row — one publish stays exactly one KV write. A
    // different note alone does not make the content different.
    const noop = await call('POST', '/api/publish', { note: 'same content' }, auth);
    expect(noop.status).toBe(409);
    expect(((await noop.json()) as { error?: string }).error).toBe('already_live');
    const audit = (await (await get('/api/audit?limit=50', auth)).json()) as {
      entries: { action: string }[];
    };
    expect(audit.entries.filter((e) => e.action === 'config.publish')).toHaveLength(1);

    // A real change is not blocked by the guard.
    expect(
      (await call('PUT', '/api/routes/app', { definition: { ...theRoute, timeoutMs: 8000 } }, auth))
        .status,
    ).toBe(200);
    const second = await call('POST', '/api/publish', { note: 'timeout bump' }, auth);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { revision?: number }).revision).toBe(2);

    // A key wiped out of band is the disaster this guard must not deadlock:
    // publishing identical content is the repair, so it goes through and the
    // revision counter keeps walking forward.
    await testEnv.CONFIG_KV.delete('routes');
    const heal = await call('POST', '/api/publish', { note: 'repair after wipe' }, auth);
    expect(heal.status).toBe(200);
    expect(((await heal.json()) as { revision?: number }).revision).toBe(3);
    const served = await testEnv.CONFIG_KV.get('routes', { type: 'json' });
    expect(served).not.toBeNull();
  });

  it('viewers may read but not write', async () => {
    const aAuth = await signInAdmin();
    const vAuth = await createViewer(aAuth);

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
    const auth = await signInAdmin();
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
    const auth = await signInAdmin();
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

  it('logout points at the platform, because that is where the session lives', async () => {
    const auth = await signInAdmin();
    expect((await get('/api/routes', auth)).status).toBe(200);

    const out = await call('POST', '/api/auth/logout', undefined, auth);
    expect(out.status).toBe(200);
    expect((await out.json()) as unknown).toEqual({
      ok: true,
      accessLogout: '/cdn-cgi/access/logout',
    });

    // And the token still works after the call, which is the honest part. Ending
    // the session is a browser navigation to that path — the edge is what revokes,
    // and it needs the request to arrive with the user's cookie. A `fetch` from
    // this handler is not that, so the endpoint must not pretend the call did it.
    expect((await get('/api/routes', auth)).status).toBe(200);
  });
});

beforeAll(async () => {
  door = await openAccessDoor('e2e-suite');
  appEnv = door.env();
});
