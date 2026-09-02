/**
 * Revision history and rollback, tested against real workerd + D1 + KV.
 *
 * These run through the worker's own fetch handler with the same reset ritual
 * as the e2e suite; the point is that the history endpoints see exactly what
 * publish wrote, not a test double's idea of it.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from './index.js';
import proxy, { __resetConfigCache } from '../../reverse-proxy/index.js';
import type { AppEnv, Env } from './env.js';

const testEnv = env as unknown as Env;
const appEnv = testEnv as unknown as AppEnv;

interface HeadersLike {
  get(name: string): string | null;
}

interface ResponseLike {
  status: number;
  headers: HeadersLike;
  json(): Promise<any>;
  text(): Promise<string>;
}

const base = 'https://panel.test';
const ORIGIN = { origin: base, 'content-type': 'application/json' };

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

const createViewer = async (): Promise<void> => {
  const { hashPassword } = await import('./password.js');
  const hash = await hashPassword('viewer-password-123');
  await testEnv.DB.prepare(
    "INSERT INTO users (subject, role, password, created_at) VALUES ('viewer', 'viewer', ?, ?)",
  )
    .bind(hash, Math.floor(Date.now() / 1000))
    .run();
};

const loginAdmin = async (): Promise<Record<string, string>> => {
  adminCookie = cookieFrom(await login('root', 'correct-horse-battery'));
  return { cookie: adminCookie };
};

/** Puts one route into the draft. */
const putRoute = async (
  auth: Record<string, string>,
  id: string,
  definition: unknown,
  enabled = true,
): Promise<ResponseLike> => call('PUT', `/api/routes/${id}`, { definition, enabled }, auth);

const routeFor = (host: string, upstream: string, extra: Record<string, unknown> = {}) => ({
  match: { host, path: '/' },
  upstream,
  timeoutMs: 5000,
  ...extra,
});

const publish = async (auth: Record<string, string>, body: unknown = {}): Promise<ResponseLike> =>
  call('POST', '/api/publish', body, auth);

/** Publishes the given revision sequence and returns nothing; failures throw. */
const seedHistory = async (auth: Record<string, string>): Promise<void> => {
  await putRoute(auth, 'alpha', routeFor('a.example.com', 'a.internal.example.com'));
  const p1 = await publish(auth, { note: 'first' });
  expect(p1.status).toBe(200);
  await putRoute(auth, 'beta', routeFor('b.example.com', 'b.internal.example.com'));
  const p2 = await publish(auth, { note: 'second' });
  expect(p2.status).toBe(200);
  // Revision 3 changes alpha's upstream — the field a rollback would restore.
  await putRoute(auth, 'alpha', routeFor('a.example.com', 'a2.internal.example.com'));
  const p3 = await publish(auth, { note: 'third' });
  expect(p3.status).toBe(200);
};

describe('revision history and rollback', () => {
  beforeEach(async () => {
    await applyD1Migrations(testEnv.DB, TEST_MIGRATIONS);
    for (const table of ['audit_log', 'sessions', 'routes', 'settings', 'users', 'revisions']) {
      await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await testEnv.CONFIG_KV.delete('routes');
    adminCookie = '';
    __resetConfigCache();
  });

  it('lists published revisions newest first, marking the live one', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    await seedHistory(auth);

    const res = await get('/api/revisions', auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.liveRevision).toBe(3);
    expect(body.entries.map((e: any) => e.revision)).toEqual([3, 2, 1]);
    expect(body.entries.map((e: any) => e.note)).toEqual(['third', 'second', 'first']);
    expect(body.entries.every((e: any) => e.snapshot === 'full')).toBe(true);
    expect(body.entries.find((e: any) => e.revision === 3).live).toBe(true);
    expect(body.entries.find((e: any) => e.revision === 1).routeCount).toBe(1);
    expect(body.entries.find((e: any) => e.revision === 2).routeCount).toBe(2);
  });

  it('shows pre-feature publishes as snapshot-less entries from the audit log', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    // History without ever publishing through the feature's code path is the
    // old-deployment case: publish once, then wipe the revisions table the
    // way a pre-feature deployment would never have had it.
    await seedHistory(auth);
    await testEnv.DB.prepare('DELETE FROM revisions').run();

    const res = await get('/api/revisions', auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.map((e: any) => e.revision)).toEqual([3, 2, 1]);
    expect(body.entries.every((e: any) => e.snapshot === 'none')).toBe(true);
    expect(
      body.entries.every((e: any) => e.live === false || body.liveRevision === e.revision),
    ).toBe(true);
  });

  it('requires authentication for history reads', async () => {
    expect((await get('/api/revisions')).status).toBe(401);
  });

  it('viewers can read history but cannot roll back', async () => {
    await bootstrapAdmin();
    await createViewer();
    await loginAdmin();
    const auth = { cookie: adminCookie };
    await seedHistory(auth);
    const viewerLogin = await login('viewer', 'viewer-password-123');
    const viewerAuth = { cookie: cookieFrom(viewerLogin) };

    expect((await get('/api/revisions', viewerAuth)).status).toBe(200);
    const rollback = await call(
      'POST',
      '/api/revisions/rollback',
      { sourceRevision: 1 },
      viewerAuth,
    );
    expect(rollback.status).toBe(403);
  });

  it('diffs two snapshots at field level, by route id', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    await seedHistory(auth);

    // 1 → 3: alpha's upstream changed, beta appeared.
    const res = await get('/api/revisions/diff?from=1&to=3', auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    const changed = body.entries.filter((e: any) => e.kind === 'changed');
    expect(changed).toContainEqual({
      path: 'routes.alpha.upstream',
      kind: 'changed',
      from: 'a.internal.example.com',
      to: 'a2.internal.example.com',
    });
    expect(body.entries.filter((e: any) => e.kind === 'added')).toContainEqual({
      path: 'routes.beta',
      kind: 'added',
      to: {
        id: 'beta',
        match: { host: 'b.example.com', path: '/' },
        upstream: 'b.internal.example.com',
        timeoutMs: 5000,
      },
    });

    // Reverse direction is free — the rollback dialog asks exactly this.
    const back = await get('/api/revisions/diff?from=3&to=1', auth);
    expect(back.status).toBe(200);
    const backBody = await back.json();
    expect(
      backBody.entries.some(
        (e: any) =>
          e.kind === 'changed' &&
          e.path === 'routes.alpha.upstream' &&
          e.from === 'a2.internal.example.com' &&
          e.to === 'a.internal.example.com',
      ),
    ).toBe(true);
  });

  it('reports moved routes instead of rewriting every later element', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    await putRoute(auth, 'one', routeFor('1.example.com', '1.internal.example.com'));
    await putRoute(auth, 'two', routeFor('2.example.com', '2.internal.example.com'));
    await publish(auth);
    // Same routes, opposite order.
    await call('PUT', '/api/routes-order', { ids: ['two', 'one'] }, auth);
    const p2 = await publish(auth);
    expect(p2.status).toBe(200);

    const body = await (await get('/api/revisions/diff?from=1&to=2', auth)).json();
    const moved = body.entries.filter((e: any) => e.kind === 'moved');
    expect(moved).toHaveLength(2);
    const two = moved.find((e: any) => e.path === 'routes.two');
    expect(two.fromPosition).toBe(1);
    expect(two.toPosition).toBe(0);
    expect(body.entries.filter((e: any) => e.kind === 'changed')).toHaveLength(0);
  });

  it('reports a move alongside field changes when both happen to one route', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    await putRoute(auth, 'one', routeFor('1.example.com', '1.internal.example.com'));
    await putRoute(auth, 'two', routeFor('2.example.com', '2.internal.example.com'));
    await publish(auth);
    // two moves to the front AND changes its upstream in the same publish.
    await putRoute(auth, 'two', routeFor('2.example.com', '2b.internal.example.com'));
    await call('PUT', '/api/routes-order', { ids: ['two', 'one'] }, auth);
    const p2 = await publish(auth);
    expect(p2.status).toBe(200);

    const body = await (await get('/api/revisions/diff?from=1&to=2', auth)).json();
    expect(
      body.entries.some((e: any) => e.kind === 'changed' && e.path === 'routes.two.upstream'),
    ).toBe(true);
    expect(
      body.entries.some(
        (e: any) =>
          e.kind === 'moved' &&
          e.path === 'routes.two' &&
          e.fromPosition === 1 &&
          e.toPosition === 0,
      ),
    ).toBe(true);
  });

  it('refuses a republish whose only difference is key order', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    await putRoute(auth, 'a', {
      upstream: 'u.example.com',
      match: { host: 'a.example.com', path: '/' },
      timeoutMs: 5000,
    });
    await publish(auth);
    // Same content, keys typed in the opposite order — canonicalization makes
    // this the identical document, so the no-op guard refuses it rather than
    // minting a second identical revision. (diffDocuments' key-order
    // insensitivity itself is pinned in diff.test.ts, where it lives.)
    await putRoute(auth, 'a', {
      timeoutMs: 5000,
      match: { path: '/', host: 'a.example.com' },
      upstream: 'u.example.com',
    });
    const p2 = await publish(auth);
    expect(p2.status).toBe(409);
    expect((await p2.json()).error).toBe('already_live');
  });

  it('refuses to diff across a missing snapshot', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    await seedHistory(auth);
    await testEnv.DB.prepare('DELETE FROM revisions WHERE revision = 2').run();

    const missing = await get('/api/revisions/diff?from=1&to=2', auth);
    expect(missing.status).toBe(409);
    expect((await missing.json()).error).toBe('snapshot_unavailable');

    const nonexistent = await get('/api/revisions/diff?from=1&to=99', auth);
    expect(nonexistent.status).toBe(409);
    expect((await nonexistent.json()).error).toBe('snapshot_unavailable');

    const malformed = await get('/api/revisions/diff?from=x&to=1', auth);
    expect(malformed.status).toBe(400);
  });

  it('rolls back: draft is replaced, KV serves the old content, new revision records provenance', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    await seedHistory(auth);

    const res = await call('POST', '/api/revisions/rollback', { sourceRevision: 1 }, auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sourceRevision).toBe(1);
    expect(body.revision).toBe(4);

    // The draft is revision 1's content: alpha restored to its old upstream,
    // beta parked as disabled — history only snapshots enabled routes, and the
    // restore keeps its definition rather than destroying it.
    const routes = await (await get('/api/routes', auth)).json();
    expect(routes.routes.map((r: any) => r.id)).toEqual(['alpha', 'beta']);
    expect(routes.routes[0]).toMatchObject({ enabled: true, position: 0 });
    expect(routes.routes[0].definition.upstream).toBe('a.internal.example.com');
    expect(routes.routes[1]).toMatchObject({ enabled: false, position: 1 });

    // A new revision appeared in history with the provenance and it is live.
    const history = await (await get('/api/revisions', auth)).json();
    expect(history.liveRevision).toBe(4);
    const entry = history.entries.find((e: any) => e.revision === 4);
    expect(entry.rollbackOf).toBe(1);
    expect(entry.note).toBe(null);
    expect(entry.snapshot).toBe('full');
    expect(entry.live).toBe(true);

    // And the proxy really serves what revision 1 served.
    const proxyRes = await proxy.fetch(
      new Request('https://a.example.com/anything'),
      {
        CONFIG: testEnv.CONFIG_KV,
        CONFIG_KEY: 'routes',
        UPSTREAM_FETCH: async () => new Response('upstream', { status: 200 }),
      },
      {} as ExecutionContext,
    );
    expect(proxyRes.status).toBe(200);
    const kv = (await testEnv.CONFIG_KV.get('routes', { type: 'json' })) as any;
    expect(kv.routes.map((r: any) => r.id)).toEqual(['alpha']);
    expect(kv.meta.revision).toBe(4);
    expect(kv.meta.updatedBy).toBe('root');
  });

  it('rolls back through the same danger gate — 409 first, confirm then success', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    // Revision 1: dangerous switch, published with confirm. Revision 2: the
    // operator removes it. Rolling back re-introduces the risk, so the gate
    // must fire on the *target* snapshot — the draft is what the rollback
    // replaces, and it is currently the safe one.
    await putRoute(
      auth,
      'risky',
      routeFor('r.example.com', 'r.example.com', { allowPrivateUpstream: true }),
    );
    await publish(auth, { confirm: true });
    await putRoute(auth, 'risky', routeFor('r.example.com', 'r.internal.example.com'));
    await publish(auth);

    const blocked = await call('POST', '/api/revisions/rollback', { sourceRevision: 1 }, auth);
    expect(blocked.status).toBe(409);
    const blockedBody = await blocked.json();
    expect(blockedBody.error).toBe('confirmation_required');
    expect(Object.keys(blockedBody.dangers)).toContain('risky');

    // Nothing was written by the refused attempt.
    const before = await (await get('/api/revisions', auth)).json();
    expect(before.liveRevision).toBe(2);

    const allowed = await call(
      'POST',
      '/api/revisions/rollback',
      { sourceRevision: 1, confirm: true },
      auth,
    );
    expect(allowed.status).toBe(200);
    const history = await (await get('/api/revisions', auth)).json();
    expect(history.liveRevision).toBe(3);
    expect(history.entries.find((e: any) => e.revision === 3).rollbackOf).toBe(1);
  });

  it('refuses to roll back to what is already live', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    await seedHistory(auth);

    const res = await call('POST', '/api/revisions/rollback', { sourceRevision: 3 }, auth);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_live');
    const history = await (await get('/api/revisions', auth)).json();
    expect(history.liveRevision).toBe(3);
  });

  it('refuses a nonexistent or pruned source revision', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    await seedHistory(auth);

    const ghost = await call('POST', '/api/revisions/rollback', { sourceRevision: 9 }, auth);
    expect(ghost.status).toBe(409);
    expect((await ghost.json()).error).toBe('snapshot_unavailable');

    await testEnv.DB.prepare('DELETE FROM revisions WHERE revision = 1').run();
    const pruned = await call('POST', '/api/revisions/rollback', { sourceRevision: 1 }, auth);
    expect(pruned.status).toBe(409);
    expect((await pruned.json()).error).toBe('snapshot_unavailable');
  });

  it('validates the input shape before touching anything', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    expect((await call('POST', '/api/revisions/rollback', {}, auth)).status).toBe(400);
    expect(
      (await call('POST', '/api/revisions/rollback', { sourceRevision: 0 }, auth)).status,
    ).toBe(400);
    expect(
      (await call('POST', '/api/revisions/rollback', { sourceRevision: 'one' }, auth)).status,
    ).toBe(400);
  });

  it('audits rollback as config.rollback with provenance', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    await seedHistory(auth);
    const res = await call(
      'POST',
      '/api/revisions/rollback',
      { sourceRevision: 1, note: 'undo the change' },
      auth,
    );
    expect(res.status).toBe(200);

    const audit = await (await get('/api/audit?limit=10', auth)).json();
    const entry = audit.entries.find((e: any) => e.action === 'config.rollback');
    expect(entry).toBeDefined();
    expect(entry.actor).toBe('root');
    const detail = JSON.parse(entry.detail);
    expect(detail.rollbackOf).toBe(1);
    expect(detail.revision).toBe(4);
    expect(detail.note).toBe('undo the change');
  });

  it('prunes history down to the retention window', async () => {
    await bootstrapAdmin();
    const auth = await loginAdmin();
    // KEEP_REVISIONS is 50; 52 publishes must leave 3..52.
    for (let i = 1; i <= 52; i += 1) {
      await putRoute(auth, 'churn', routeFor('c.example.com', `c${i}.internal.example.com`));
      const res = await publish(auth);
      expect(res.status).toBe(200);
    }
    const body = await (await get('/api/revisions?limit=200', auth)).json();
    const revisions = body.entries.map((e: any) => e.revision);
    // The snapshots for 1..2 are gone from the table — but the audit log still
    // holds their publishes, so they stay listed as snapshot-less history
    // rather than vanishing.
    expect(
      revisions
        .filter((r: any) => r <= 2)
        .map((r: any) => body.entries.find((e: any) => e.revision === r).snapshot),
    ).toEqual(['none', 'none']);
    expect(body.entries.find((e: any) => e.revision === 3).snapshot).toBe('full');
    expect(body.entries.filter((e: any) => e.snapshot === 'full')).toHaveLength(50);
    expect(body.entries).toHaveLength(52);
  });
});
