/**
 * Account management: list, create, update, delete.
 *
 * The interesting surface here is not the happy path but the ways this could
 * brick the panel: demoting or disabling the last admin, or deleting every row —
 * which would reopen first-run provisioning to whichever address the Access
 * policy admits next. Each guarded refusal is asserted against the database, not
 * just the status code.
 *
 * Authentication is Cloudflare Access, so "acting as X" below means "holding a
 * token this suite's certs endpoint vouches for". That distinction has teeth
 * after a deletion: Access keeps vouching for the address, so what the panel
 * loses is recognition, not authentication — the refusal is 403
 * `no_panel_account`, never 401.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from './index.js';
import type { AppEnv, Env } from './env.js';
import { MAX_SUBJECT_LENGTH } from './validate.js';
import { openAccessDoor, type AccessDoor, type AuthHeaders } from './test-access.js';

const testEnv = env as unknown as Env;
const base = 'https://panel.test';

/** The first address through the door, and therefore the sole provisioned admin. */
const ROOT = 'root@example.com';
const DEPUTY = 'deputy@example.com';
const SCOUT = 'scout@example.com';

let door: AccessDoor;
let appEnv: AppEnv;
let asRoot: AuthHeaders;

interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

const call = async (
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ResponseLike> =>
  worker.fetch(
    new Request(`${base}${path}`, {
      method,
      headers: { origin: base, 'content-type': 'application/json', ...headers },
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

const userRow = async (
  subject: string,
): Promise<{ id: number; disabled: number; role: string } | null> =>
  testEnv.DB.prepare('SELECT id, disabled, role FROM users WHERE subject = ?')
    .bind(subject)
    .first();

const userCount = async (): Promise<number> =>
  (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n ?? 0;

const auditActions = async (): Promise<string[]> => {
  const { results } = await testEnv.DB.prepare('SELECT action FROM audit_log').all<{
    action: string;
  }>();
  return results.map((r) => r.action);
};

/** A second admin, created through the API and holding its own Access token. */
const secondAdmin = async (): Promise<{ headers: AuthHeaders; id: number }> => {
  const res = await call('POST', '/api/users', { subject: DEPUTY, role: 'admin' }, asRoot);
  const body = await res.text();
  expect(res.status, body).toBe(201);
  return { headers: await door.headers(DEPUTY), id: (JSON.parse(body) as { id: number }).id };
};

/** An account created by root, so its own requests come back as a viewer. */
const viewer = async (subject = SCOUT): Promise<AuthHeaders> => {
  const res = await call('POST', '/api/users', { subject, role: 'viewer' }, asRoot);
  expect(res.status, await res.text()).toBe(201);
  return await door.headers(subject);
};

beforeAll(async () => {
  door = await openAccessDoor('users-suite');
  appEnv = door.env();
  asRoot = await door.headers(ROOT);
});

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, TEST_MIGRATIONS);
  // mcp_tokens before users: its foreign keys are ON DELETE RESTRICT, so a
  // leftover token row would refuse the users wipe rather than cascade.
  for (const table of ['audit_log', 'mcp_tokens', 'routes', 'settings', 'users']) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // One request through the door on an empty table provisions the sole admin, so
  // every test below starts from "exactly one admin exists, and it is root".
  const boot = await get('/api/auth/me', asRoot);
  expect(boot.status, await boot.text()).toBe(200);
  expect(await userRow(ROOT)).not.toBeNull();
  await testEnv.DB.prepare('DELETE FROM audit_log').run();
});

describe('GET /api/users', () => {
  it('lists what the column list names, and nothing the schema grows later', async () => {
    await viewer();
    await get('/api/routes', await door.headers(SCOUT)); // gives scout a last_seen

    const res = await get('/api/users', asRoot);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Record<string, unknown>[] };
    const scout = body.users.find((u) => u.subject === SCOUT);
    expect(scout).toBeDefined();
    expect(scout?.role).toBe('viewer');
    expect(scout?.disabled).toBe(false);
    expect(scout?.createdAt as number).toBeGreaterThan(0);
    expect(scout?.lastSeen).not.toBeNull();
    // The exact key set, not a subset: `SELECT *` plus a column added by a later
    // migration is how a private field ends up in a 200 that nobody re-reviewed.
    expect(Object.keys(scout ?? {}).toSorted()).toEqual([
      'createdAt',
      'disabled',
      'email',
      'id',
      'lastSeen',
      'role',
      'subject',
    ]);
  });

  it('separates "we do not know you" from "you may not"', async () => {
    // No token at all: the platform never vouched, so this is 401.
    expect((await get('/api/users')).status).toBe(401);
    // A vouched-for viewer: recognised, and refused for what they are — 403.
    expect((await get('/api/users', await viewer())).status).toBe(403);
  });
});

describe('POST /api/users', () => {
  it('creates a viewer by default, and that address can then walk in', async () => {
    const res = await call('POST', '/api/users', { subject: SCOUT, email: SCOUT }, asRoot);
    expect(res.status).toBe(201);

    const row = await userRow(SCOUT);
    expect(row?.role).toBe('viewer'); // the endpoint default, not the column's 'admin'
    expect(row?.disabled).toBe(0);

    // The row is the whole credential story: no secret was set, and Access
    // vouching for the same address is now enough to be recognised.
    const asScout = await door.headers(SCOUT);
    expect((await get('/api/routes', asScout)).status).toBe(200);
    expect((await get('/api/users', asScout)).status).toBe(403);
  });

  it('rejects duplicates, bad shapes, and invalid roles as 400/409 — never 500', async () => {
    const create = (body: unknown) => call('POST', '/api/users', body, asRoot);

    expect((await create({ subject: ROOT })).status).toBe(409);
    expect((await create({ subject: '' })).status).toBe(400);
    expect((await create({ subject: '   ' })).status).toBe(400);
    expect((await create({ subject: 'x'.repeat(MAX_SUBJECT_LENGTH + 1) })).status).toBe(400);
    expect((await create({ subject: SCOUT, role: 'superadmin' })).status).toBe(400);
    expect(await userCount()).toBe(1);
  });

  it('is admin-only', async () => {
    const asViewer = await viewer();
    const res = await call('POST', '/api/users', { subject: 'other@example.com' }, asViewer);
    expect(res.status).toBe(403);
    expect(await userRow('other@example.com')).toBeNull();
  });
});

describe('PATCH /api/users/:id', () => {
  it('demotes a second admin and the new role applies to their next request', async () => {
    const deputy = await secondAdmin();

    const res = await call('PATCH', `/api/users/${String(deputy.id)}`, { role: 'viewer' }, asRoot);
    expect(res.status).toBe(200);
    // The role is joined per request from the row, so this is immediate — no
    // token to re-mint, no grace period while an old claim is still valid.
    expect((await get('/api/users', deputy.headers)).status).toBe(403);
  });

  it('refuses to demote or disable the only admin', async () => {
    const id = String((await userRow(ROOT))!.id);

    const demote = await call('PATCH', `/api/users/${id}`, { role: 'viewer' }, asRoot);
    expect(demote.status).toBe(409);
    expect(((await demote.json()) as { error: string }).error).toBe('last_admin');

    expect((await call('PATCH', `/api/users/${id}`, { disabled: true }, asRoot)).status).toBe(409);
    // The row must be untouched by both refusals.
    expect((await userRow(ROOT))?.role).toBe('admin');
    expect((await userRow(ROOT))?.disabled).toBe(0);
  });

  it('holds both invariants: a disabled admin does not count as a spare', async () => {
    const deputy = await secondAdmin();
    // Park the deputy first; now root is the only *enabled* admin.
    const park = await call('PATCH', `/api/users/${String(deputy.id)}`, { disabled: true }, asRoot);
    expect(park.status).toBe(200);
    // And a parked account is refused even though Access still lets it through.
    expect((await get('/api/routes', deputy.headers)).status).toBe(403);

    const id = String((await userRow(ROOT))!.id);
    expect((await call('PATCH', `/api/users/${id}`, { disabled: true }, asRoot)).status).toBe(409);
    expect((await call('PATCH', `/api/users/${id}`, { role: 'viewer' }, asRoot)).status).toBe(409);

    // But the parked deputy can still be demoted: that shrinks the admin row
    // count, not the enabled pool.
    const demote = await call(
      'PATCH',
      `/api/users/${String(deputy.id)}`,
      { role: 'viewer' },
      asRoot,
    );
    expect(demote.status).toBe(200);
  });

  it('updates only the named fields, refuses nonsense, and audits', async () => {
    await viewer();
    const id = String((await userRow(SCOUT))!.id);

    // Role-only change must not touch disabled.
    await call('PATCH', `/api/users/${id}`, { role: 'admin' }, asRoot);
    expect((await userRow(SCOUT))?.role).toBe('admin');
    expect((await userRow(SCOUT))?.disabled).toBe(0);

    expect((await call('PATCH', `/api/users/${id}`, {}, asRoot)).status).toBe(400);
    expect((await call('PATCH', `/api/users/${id}`, { disabled: 'yes' }, asRoot)).status).toBe(400);
    // A field the password door used to own is now just an unknown key, and an
    // unknown key alone is nothing to do — not a silent success.
    expect((await call('PATCH', `/api/users/${id}`, { unlock: true }, asRoot)).status).toBe(400);
    expect((await call('PATCH', '/api/users/999', { role: 'viewer' }, asRoot)).status).toBe(404);
    expect((await call('PATCH', '/api/users/root', { role: 'viewer' }, asRoot)).status).toBe(404);

    expect(await auditActions()).toContain('user.update');
  });
});

describe('DELETE /api/users/:id', () => {
  it('deletes a viewer, and Access alone no longer gets them in', async () => {
    const asScout = await viewer();
    expect((await get('/api/routes', asScout)).status).toBe(200);
    const id = String((await userRow(SCOUT))!.id);

    expect((await call('DELETE', `/api/users/${id}`, undefined, asRoot)).status).toBe(200);
    expect(await userRow(SCOUT)).toBeNull();

    // The same token still verifies — the platform's opinion did not change —
    // but the panel has no row to key a role on, so it refuses by name.
    const after = await get('/api/routes', asScout);
    expect(after.status).toBe(403);
    expect((await after.json()) as unknown).toMatchObject({
      error: 'no_panel_account',
      accessEmail: SCOUT,
    });
    // And the refusal must not quietly re-provision: the table is not empty.
    expect(await userCount()).toBe(1);
  });

  it('re-evaluates the guard at write time, so the last admin cannot be deleted', async () => {
    const deputy = await secondAdmin();

    // One of two admins goes.
    expect(
      (await call('DELETE', `/api/users/${String(deputy.id)}`, undefined, asRoot)).status,
    ).toBe(200);
    // Now the same request shape meets a different table state: refused, and the
    // remaining admin is still there.
    const refused = await call(
      'DELETE',
      `/api/users/${String((await userRow(ROOT))!.id)}`,
      undefined,
      asRoot,
    );
    expect(refused.status).toBe(409);
    // Root is the only row left, so the endpoint names the stricter wall.
    expect(((await refused.json()) as { error: string }).error).toBe('last_user');
    expect(await userRow(ROOT)).not.toBeNull();
  });

  it('refuses to empty the table: first-run provisioning must not reopen', async () => {
    // An emptied table hands admin to whatever address Access admits next, so
    // this refusal is the one standing between a mis-scoped policy and the route
    // table. A parked second admin, so its deletion leaves exactly one row.
    const deputy = await secondAdmin();
    await call('PATCH', `/api/users/${String(deputy.id)}`, { disabled: true }, asRoot);
    expect(
      (await call('DELETE', `/api/users/${String(deputy.id)}`, undefined, asRoot)).status,
    ).toBe(200);

    const refused = await call(
      'DELETE',
      `/api/users/${String((await userRow(ROOT))!.id)}`,
      undefined,
      asRoot,
    );
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('last_user');
    expect(await userCount()).toBe(1);
  });

  it('lets an admin delete themselves when a spare exists, losing the panel with the row', async () => {
    const deputy = await secondAdmin();
    // Deputy lists users to learn its own id, then deletes itself.
    const list = await get('/api/users', deputy.headers);
    const self = ((await list.json()) as { users: { id: number; subject: string }[] }).users.find(
      (u) => u.subject === DEPUTY,
    );

    expect(
      (await call('DELETE', `/api/users/${String(self!.id)}`, undefined, deputy.headers)).status,
    ).toBe(200);
    // The row the request was authorised by is gone, so the next one is 403.
    expect((await get('/api/users', deputy.headers)).status).toBe(403);
    // The other admin survives.
    expect((await get('/api/users', asRoot)).status).toBe(200);
  });

  it('answers 404 for unknown and malformed ids, and audits real deletions', async () => {
    expect((await call('DELETE', '/api/users/999', undefined, asRoot)).status).toBe(404);
    expect((await call('DELETE', '/api/users/root', undefined, asRoot)).status).toBe(404);

    await viewer();
    const id = String((await userRow(SCOUT))!.id);
    expect((await call('DELETE', `/api/users/${id}`, undefined, asRoot)).status).toBe(200);
    expect(await auditActions()).toContain('user.delete');
  });
});

describe('the same-origin gate', () => {
  it('refuses a mutating request that arrives without an Origin', async () => {
    // A cross-site form post omits Origin entirely, and a valid Access token
    // does not make that request the operator's intent.
    const res = await worker.fetch(
      new Request(`${base}/api/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...asRoot },
        body: JSON.stringify({ subject: SCOUT }),
      }),
      appEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
    expect(await userRow(SCOUT)).toBeNull();
  });
});
