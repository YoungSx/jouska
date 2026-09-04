/**
 * Draft discard, tested against real workerd + D1 + KV.
 *
 * Discard is publish's draft-only sibling: it resets the draft to the live
 * snapshot without a KV write, a revision, or the publish gates. These tests
 * run through the worker's own fetch handler with the same reset ritual as the
 * history suite, so what they see is what publish actually wrote.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from './index.js';
import type { AppEnv, Env } from './env.js';
import { openAccessDoor, type AccessDoor } from './test-access.js';

const testEnv = env as unknown as Env;
let door: AccessDoor;
let appEnv: AppEnv;

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

const ROOT = 'root@example.com';
const VIEWER = 'viewer@example.com';

/**
 * The admin's headers, provisioning the row on the first call.
 *
 * Must run before anything else writes to `users`: first-run provisioning only
 * fires on an empty table, so a viewer inserted first would leave the admin
 * unrecognised — which is the behaviour under test elsewhere, not here.
 */
const signInAdmin = async (): Promise<Record<string, string>> => {
  const auth = await door.headers(ROOT);
  const res = await get('/api/auth/me', auth);
  expect(res.status, await res.text()).toBe(200);
  return auth;
};

/** A viewer row, added the way an admin would add one: no credential of its own. */
const viewerAuth = async (): Promise<Record<string, string>> => {
  await testEnv.DB.prepare("INSERT INTO users (subject, role, created_at) VALUES (?, 'viewer', ?)")
    .bind(VIEWER, Math.floor(Date.now() / 1000))
    .run();
  return await door.headers(VIEWER);
};

/** Puts one route into the draft. */
const putRoute = async (
  auth: Record<string, string>,
  id: string,
  definition: unknown,
  enabled = true,
): Promise<ResponseLike> => call('PUT', `/api/routes/${id}`, { definition, enabled }, auth);

const putDefaults = async (
  auth: Record<string, string>,
  defaults: unknown,
): Promise<ResponseLike> => call('PUT', '/api/defaults', { defaults }, auth);

const routeFor = (host: string, upstream: string, extra: Record<string, unknown> = {}) => ({
  match: { host, path: '/' },
  upstream,
  timeoutMs: 5000,
  ...extra,
});

const publish = async (auth: Record<string, string>, body: unknown = {}): Promise<ResponseLike> =>
  call('POST', '/api/publish', body, auth);

const discard = async (auth: Record<string, string>): Promise<ResponseLike> =>
  call('POST', '/api/discard', undefined, auth);

/** Publishes one route, then dirties the draft with a second one on top. */
const publishThenDirty = async (auth: Record<string, string>): Promise<void> => {
  await putRoute(auth, 'alpha', routeFor('a.example.com', 'a.internal.example.com'));
  expect((await publish(auth, { note: 'live' })).status).toBe(200);
  await putRoute(auth, 'beta', routeFor('b.example.com', 'b.internal.example.com'));
};

describe('draft discard', () => {
  beforeEach(async () => {
    await applyD1Migrations(testEnv.DB, TEST_MIGRATIONS);
    for (const table of ['audit_log', 'routes', 'settings', 'users', 'revisions']) {
      await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await testEnv.CONFIG_KV.delete('routes');
  });

  it('requires authentication', async () => {
    expect((await discard({})).status).toBe(401);
  });

  it('viewers cannot discard', async () => {
    const auth = await signInAdmin();
    const asViewer = await viewerAuth();
    await publishThenDirty(auth);

    const res = await discard(asViewer);
    expect(res.status).toBe(403);
    // The draft survives the refused attempt.
    const preview = await (await get('/api/preview', asViewer)).json();
    expect(preview.dirty).toBe(true);
  });

  it('refuses when nothing has ever been published', async () => {
    const auth = await signInAdmin();
    await putRoute(auth, 'alpha', routeFor('a.example.com', 'a.internal.example.com'));

    const res = await discard(auth);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('nothing_published');

    // And the draft is untouched.
    const routes = await (await get('/api/routes', auth)).json();
    expect(routes.routes.map((r: any) => r.id)).toEqual(['alpha']);
  });

  it('resets the draft to the live snapshot without a new revision or KV write', async () => {
    const auth = await signInAdmin();
    await publishThenDirty(auth);
    const kvBefore = await testEnv.CONFIG_KV.get('routes');

    const res = await discard(auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sourceRevision).toBe(1);

    // The draft is the live content again: alpha restored, beta parked
    // (disabled, definition kept) — the restore never destroys a route the
    // snapshot does not mention.
    const routes = await (await get('/api/routes', auth)).json();
    expect(routes.routes.map((r: any) => r.id)).toEqual(['alpha', 'beta']);
    expect(routes.routes[0]).toMatchObject({ enabled: true, position: 0 });
    expect(routes.routes[0].definition.upstream).toBe('a.internal.example.com');
    expect(routes.routes[1]).toMatchObject({ enabled: false, position: 1 });
    expect(routes.routes[1].definition.upstream).toBe('b.internal.example.com');

    // Preview agrees: clean, still serving revision 1.
    const preview = await (await get('/api/preview', auth)).json();
    expect(preview.ok).toBe(true);
    expect(preview.dirty).toBe(false);
    expect(preview.live.revision).toBe(1);

    // No KV write, no revision row: history still ends at 1.
    expect(await testEnv.CONFIG_KV.get('routes')).toBe(kvBefore);
    const history = await (await get('/api/revisions', auth)).json();
    expect(history.liveRevision).toBe(1);
    expect(history.entries.map((e: any) => e.revision)).toEqual([1]);
  });

  it('restores defaults along with the routes', async () => {
    const auth = await signInAdmin();
    await putRoute(auth, 'alpha', routeFor('a.example.com', 'a.internal.example.com'));
    await putDefaults(auth, { timeoutMs: 7000 });
    expect((await publish(auth)).status).toBe(200);

    // Dirty both: a new route and changed defaults.
    await putRoute(auth, 'beta', routeFor('b.example.com', 'b.internal.example.com'));
    await putDefaults(auth, { timeoutMs: 9999 });

    expect((await discard(auth)).status).toBe(200);
    const defaults = await (await get('/api/defaults', auth)).json();
    expect(defaults.defaults).toEqual({ timeoutMs: 7000 });
  });

  it('discards a draft that will not compile — the escape hatch', async () => {
    const auth = await signInAdmin();
    await publishThenDirty(auth);
    // A route the schema rejects: the draft is now blocked, preview says so.
    await putRoute(auth, 'bad', { upstream: '', match: {} });
    const blocked = await (await get('/api/preview', auth)).json();
    expect(blocked.ok).toBe(false);

    const res = await discard(auth);
    expect(res.status).toBe(200);

    const preview = await (await get('/api/preview', auth)).json();
    expect(preview.ok).toBe(true);
    expect(preview.dirty).toBe(false);
  });

  it('refuses an already-clean draft as a concurrency backstop', async () => {
    const auth = await signInAdmin();
    await publishThenDirty(auth);
    expect((await discard(auth)).status).toBe(200);

    // A second tab's stale gate still thinks the draft is dirty; the server
    // compares digests and refuses rather than rewriting identical rows.
    const res = await discard(auth);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_clean');

    // The refused no-op leaves no audit entry behind.
    const audit = await (await get('/api/audit?limit=50', auth)).json();
    expect(audit.entries.filter((e: any) => e.action === 'config.discard')).toHaveLength(1);
  });

  it('refuses when the live revision has no usable snapshot', async () => {
    const auth = await signInAdmin();
    await publishThenDirty(auth);
    // Simulate a pre-history-feature deployment: publish happened, snapshots
    // did not exist yet.
    await testEnv.DB.prepare('DELETE FROM revisions').run();

    const res = await discard(auth);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('snapshot_unavailable');
  });

  it('audits a discard with its source revision', async () => {
    const auth = await signInAdmin();
    await publishThenDirty(auth);
    expect((await discard(auth)).status).toBe(200);

    const audit = await (await get('/api/audit?limit=10', auth)).json();
    const entry = audit.entries.find((e: any) => e.action === 'config.discard');
    expect(entry).toBeDefined();
    expect(entry.actor).toBe(ROOT);
    expect(entry.target).toBe('draft');
    expect(JSON.parse(entry.detail).sourceRevision).toBe(1);
  });
});

beforeAll(async () => {
  door = await openAccessDoor('discard-suite');
  appEnv = door.env();
});
