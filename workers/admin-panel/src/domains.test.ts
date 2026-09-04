/**
 * Tests for the discovery endpoint, against the real workerd runtime and real
 * D1 — the cross-reference between discovered hostnames and the route table is
 * the part worth testing end to end, because it is what the operator reads.
 *
 * The Cloudflare API itself is stubbed through the `CF_API_FETCH` seam; the
 * shapes it returns are the ones asserted in `cloudflare.test.ts`.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from './index.js';
import { __resetDomainCache, type DomainsResponse } from './api/domains.js';
import type { AppEnv, Env } from './env.js';
import { openAccessDoor, type AccessDoor } from './test-access.js';

const testEnv = env as unknown as Env;
const base = 'https://panel.test';
const SCRIPT = 'jouska';
const ROOT = 'root@example.com';
const WATCHER = 'watcher@example.com';

let door: AccessDoor;

interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/**
 * Env for one case: the real bindings plus discovery config and the stub.
 *
 * Access is wired in here rather than per case because every authenticated call
 * in this file needs it, and a case that quietly lost it would fail as a 401 in
 * the middle of a discovery assertion.
 */
const envWith = (overrides: Record<string, unknown>): AppEnv => door.env(overrides);

const call = async (
  method: string,
  path: string,
  appEnv: AppEnv,
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

const ok = (result: unknown): Response =>
  new Response(JSON.stringify({ success: true, errors: [], result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const fail = (message: string): Response =>
  new Response(JSON.stringify({ success: false, errors: [{ message }], result: null }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  });

interface ApiState {
  /** workers.dev enabled for the script. */
  readonly workersDev?: boolean;
  readonly subdomain?: string;
  readonly customDomains?: readonly Record<string, unknown>[];
  readonly zones?: readonly { id: string; name: string }[];
  readonly routes?: Readonly<Record<string, readonly Record<string, unknown>[]>>;
  /** Sources that answer with a permission error. */
  readonly deny?: readonly ('workers_dev' | 'custom_domain' | 'zones')[];
}

/** A stub Cloudflare API assembled from a declarative state. */
const apiStub = (state: ApiState): { fetch: typeof fetch; calls: string[] } => {
  const calls: string[] = [];
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const deny = state.deny ?? [];
    if (url.includes(`/workers/scripts/${SCRIPT}/subdomain`)) {
      return deny.includes('workers_dev')
        ? fail('Workers Scripts Read required')
        : ok({ enabled: state.workersDev ?? false });
    }
    if (url.includes('/workers/subdomain')) {
      return ok({ subdomain: state.subdomain ?? 'team' });
    }
    if (url.includes('/workers/domains')) {
      return deny.includes('custom_domain')
        ? fail('Workers Scripts Read required')
        : ok(state.customDomains ?? []);
    }
    if (url.includes('/zones?')) {
      return deny.includes('zones') ? fail('Zone Read required') : ok(state.zones ?? []);
    }
    const zoneMatch = /\/zones\/([^/]+)\/workers\/routes/.exec(url);
    if (zoneMatch !== null) {
      const zoneId = zoneMatch[1] ?? '';
      return ok(state.routes?.[zoneId] ?? []);
    }
    return fail(`unstubbed: ${url}`);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
};

/** Discovery env with credentials present and the API stubbed. */
const configured = (state: ApiState, extra: Record<string, unknown> = {}): AppEnv =>
  envWith({
    CF_ACCOUNT_ID: 'acct-1',
    CF_API_TOKEN: 'read-only-token',
    CF_API_FETCH: apiStub(state).fetch,
    ...extra,
  });

/** Admin headers; the first request on an empty table provisions the row. */
const adminAuth = async (appEnv: AppEnv): Promise<Record<string, string>> => {
  const auth = await door.headers(ROOT);
  const res = await call('GET', '/api/auth/me', appEnv, undefined, auth);
  expect(res.status).toBe(200);
  return auth;
};

const putRoute = async (
  appEnv: AppEnv,
  auth: Record<string, string>,
  id: string,
  definition: unknown,
  enabled = true,
): Promise<void> => {
  const res = await call('PUT', `/api/routes/${id}`, appEnv, { definition, enabled }, auth);
  expect(res.status, `route ${id} should save`).toBe(200);
};

const domains = async (appEnv: AppEnv, auth: Record<string, string>): Promise<DomainsResponse> => {
  const res = await call('GET', '/api/domains', appEnv, undefined, auth);
  expect(res.status).toBe(200);
  return (await res.json()) as DomainsResponse;
};

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, TEST_MIGRATIONS);
  for (const table of ['audit_log', 'routes', 'settings', 'mcp_tokens', 'users']) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
  __resetDomainCache();
});

describe('GET /api/domains', () => {
  it('requires a session', async () => {
    const appEnv = configured({ workersDev: true });
    const res = await call('GET', '/api/domains', appEnv);
    expect(res.status).toBe(401);
  });

  it('is readable by a viewer: hostnames are public by construction', async () => {
    const appEnv = configured({ workersDev: true, subdomain: 'team' });
    // The admin goes through the door first, so the viewer row is added to a
    // table that is no longer empty — the point under test is the role gate on
    // this endpoint, not user management.
    const auth = await adminAuth(appEnv);
    await testEnv.DB.prepare(
      "INSERT INTO users (subject, role, created_at) VALUES (?, 'viewer', 0)",
    )
      .bind(WATCHER)
      .run();
    const asViewer = await call(
      'GET',
      '/api/domains',
      appEnv,
      undefined,
      await door.headers(WATCHER),
    );
    expect(asViewer.status).toBe(200);
    expect(((await asViewer.json()) as DomainsResponse).configured).toBe(true);
    // And the admin sees the same thing.
    expect((await domains(appEnv, auth)).configured).toBe(true);
  });

  it('reports unconfigured, not an error, when no credentials are set', async () => {
    const appEnv = envWith({ CF_ACCOUNT_ID: undefined, CF_API_TOKEN: undefined });
    const auth = await adminAuth(appEnv);
    const body = await domains(appEnv, auth);
    expect(body.configured).toBe(false);
    expect(body.reason).toBe('missing_both');
    // The script name is still reported, so the UI can name what it would look up.
    expect(body.script).toBe(SCRIPT);
    expect(body.hosts).toBeUndefined();
  });

  it('names which credential is missing', async () => {
    const withToken = envWith({ CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: undefined });
    const auth = await adminAuth(withToken);
    expect((await domains(withToken, auth)).reason).toBe('missing_account_id');

    const withAccount = envWith({ CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: undefined });
    expect((await domains(withAccount, auth)).reason).toBe('missing_token');
  });

  it('treats a blank credential as absent rather than sending an empty token', async () => {
    const appEnv = envWith({ CF_ACCOUNT_ID: '  ', CF_API_TOKEN: '  ' });
    const auth = await adminAuth(appEnv);
    expect((await domains(appEnv, auth)).reason).toBe('missing_both');
  });

  it('never echoes the token', async () => {
    const appEnv = configured({ workersDev: true });
    const auth = await adminAuth(appEnv);
    const res = await call('GET', '/api/domains', appEnv, undefined, auth);
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain('read-only-token');
  });

  it('marks a discovered host with the route ids that claim it', async () => {
    const appEnv = configured({
      customDomains: [{ hostname: 'mirror.example.com', service: SCRIPT }],
    });
    const auth = await adminAuth(appEnv);
    await putRoute(appEnv, auth, 'r1', {
      match: { host: 'mirror.example.com', path: '/' },
      upstream: 'up.example.com',
    });
    const body = await domains(appEnv, auth);
    const host = body.hosts?.find((h) => h.host === 'mirror.example.com');
    expect(host?.routeIds).toEqual(['r1']);
    expect(body.unmatchedRouteHosts).toEqual([]);
  });

  it('reports a bound host that no route claims', async () => {
    const appEnv = configured({
      customDomains: [{ hostname: 'orphan.example.com', service: SCRIPT }],
    });
    const auth = await adminAuth(appEnv);
    await putRoute(appEnv, auth, 'r1', {
      match: { host: 'other.example.com', path: '/' },
      upstream: 'up.example.com',
    });
    const body = await domains(appEnv, auth);
    expect(body.hosts?.find((h) => h.host === 'orphan.example.com')?.routeIds).toEqual([]);
  });

  it('reports a route whose host is not bound anywhere', async () => {
    const appEnv = configured({ customDomains: [] });
    const auth = await adminAuth(appEnv);
    await putRoute(appEnv, auth, 'typo', {
      match: { host: 'mirrror.example.com', path: '/' },
      upstream: 'up.example.com',
    });
    const body = await domains(appEnv, auth);
    expect(body.unmatchedRouteHosts).toEqual([{ routeId: 'typo', host: 'mirrror.example.com' }]);
  });

  it('does not flag a disabled route as unmatched: it is not live', async () => {
    const appEnv = configured({ customDomains: [] });
    const auth = await adminAuth(appEnv);
    await putRoute(
      appEnv,
      auth,
      'parked',
      { match: { host: 'parked.example.com', path: '/' }, upstream: 'up.example.com' },
      false,
    );
    const body = await domains(appEnv, auth);
    expect(body.unmatchedRouteHosts).toEqual([]);
  });

  it('counts a route with no match.host as claiming every bound host', async () => {
    const appEnv = configured({
      customDomains: [{ hostname: 'a.example.com', service: SCRIPT }],
    });
    const auth = await adminAuth(appEnv);
    await putRoute(appEnv, auth, 'catchall', {
      match: { path: '/' },
      upstream: 'up.example.com',
    });
    const body = await domains(appEnv, auth);
    expect(body.hosts?.find((h) => h.host === 'a.example.com')?.routeIds).toEqual(['catchall']);
    // A route with no host cannot be unmatched, so it must not be listed.
    expect(body.unmatchedRouteHosts).toEqual([]);
  });

  it('matches a wildcard route host against a bound subdomain, but not the apex', async () => {
    const appEnv = configured({
      customDomains: [
        { hostname: 'a.example.com', service: SCRIPT },
        { hostname: 'example.com', service: SCRIPT },
      ],
    });
    const auth = await adminAuth(appEnv);
    await putRoute(appEnv, auth, 'wild', {
      match: { host: '*.example.com', path: '/' },
      upstream: 'up.example.com',
    });
    const body = await domains(appEnv, auth);
    expect(body.hosts?.find((h) => h.host === 'a.example.com')?.routeIds).toEqual(['wild']);
    // The apex is not a subdomain: the same rule the router applies.
    expect(body.hosts?.find((h) => h.host === 'example.com')?.routeIds).toEqual([]);
  });

  it('refuses a wildcard match for a host with an empty label', async () => {
    // workerd's URL parser keeps `..example.com` verbatim, so a host like this
    // does reach the comparison; `*.example.com` must not claim it.
    const appEnv = configured({
      customDomains: [{ hostname: '..example.com', service: SCRIPT }],
    });
    const auth = await adminAuth(appEnv);
    await putRoute(appEnv, auth, 'wild', {
      match: { host: '*.example.com', path: '/' },
      upstream: 'up.example.com',
    });
    const body = await domains(appEnv, auth);
    expect(body.hosts?.find((h) => h.host === '..example.com')?.routeIds).toEqual([]);
  });

  it('refuses a wildcard match when the wildcard consumed nothing', async () => {
    // `.example.com` ends with the suffix but leaves an empty label behind.
    const appEnv = configured({
      customDomains: [{ hostname: '.example.com', service: SCRIPT }],
    });
    const auth = await adminAuth(appEnv);
    await putRoute(appEnv, auth, 'wild', {
      match: { host: '*.example.com', path: '/' },
      upstream: 'up.example.com',
    });
    const body = await domains(appEnv, auth);
    expect(body.hosts?.find((h) => h.host === '.example.com')?.routeIds).toEqual([]);
  });

  it('does not let a narrow wildcard route claim a broader one', async () => {
    // Cloudflare reports `*.example.com`; a route written for `*.a.example.com`
    // does not cover that pattern's own apex, so it must not claim it.
    const appEnv = configured({
      zones: [{ id: 'z1', name: 'example.com' }],
      routes: { z1: [{ id: 'cf1', pattern: '*.example.com/*', script: SCRIPT }] },
    });
    const auth = await adminAuth(appEnv);
    await putRoute(appEnv, auth, 'narrow', {
      match: { host: '*.a.example.com', path: '/' },
      upstream: 'up.example.com',
    });
    const body = await domains(appEnv, auth);
    expect(body.hosts?.find((h) => h.host === '*.example.com')?.routeIds).toEqual([]);
    expect(body.unmatchedRouteHosts).toEqual([{ routeId: 'narrow', host: '*.a.example.com' }]);
  });

  it('matches an exact route host against a wildcard route pattern from Cloudflare', async () => {
    // Cloudflare returns `*.example.com/*` as a route pattern; a route written
    // against the concrete `a.example.com` is covered by it.
    const appEnv = configured({
      zones: [{ id: 'z1', name: 'example.com' }],
      routes: { z1: [{ id: 'cf1', pattern: '*.example.com/*', script: SCRIPT }] },
    });
    const auth = await adminAuth(appEnv);
    await putRoute(appEnv, auth, 'exact', {
      match: { host: 'a.example.com', path: '/' },
      upstream: 'up.example.com',
    });
    const body = await domains(appEnv, auth);
    expect(body.hosts?.find((h) => h.host === '*.example.com')?.routeIds).toEqual(['exact']);
    expect(body.unmatchedRouteHosts).toEqual([]);
  });

  it('keeps the route pattern so the path part stays visible', async () => {
    const appEnv = configured({
      zones: [{ id: 'z1', name: 'example.com' }],
      routes: { z1: [{ id: 'cf1', pattern: 'example.com/api/*', script: SCRIPT }] },
    });
    const auth = await adminAuth(appEnv);
    const body = await domains(appEnv, auth);
    const host = body.hosts?.find((h) => h.kind === 'route');
    expect(host?.pattern).toBe('example.com/api/*');
    expect(host?.zone).toBe('example.com');
  });

  it('names a failed source and still answers from the others', async () => {
    const appEnv = configured({
      workersDev: true,
      subdomain: 'team',
      deny: ['zones'],
    });
    const auth = await adminAuth(appEnv);
    const body = await domains(appEnv, auth);
    expect(body.hosts?.map((h) => h.host)).toEqual(['jouska.team.workers.dev']);
    expect(body.failures).toEqual([{ source: 'route', message: 'Zone Read required' }]);
  });

  it('withholds unmatched routes when every source failed: nothing was compared', async () => {
    const appEnv = configured({ deny: ['workers_dev', 'custom_domain', 'zones'] });
    const auth = await adminAuth(appEnv);
    await putRoute(appEnv, auth, 'r1', {
      match: { host: 'a.example.com', path: '/' },
      upstream: 'up.example.com',
    });
    const body = await domains(appEnv, auth);
    expect(body.failures?.length).toBe(3);
    // Reporting every route as unmatched here would be a false alarm.
    expect(body.unmatchedRouteHosts).toBeUndefined();
  });

  it('withholds unmatched routes when the route source failed and nothing was found', async () => {
    // The least-privilege token this code explicitly supports: Workers Scripts
    // Read without Zone Read. With workers.dev off and no Custom Domains, every
    // source that answered found nothing and the one that would have found the
    // routes could not be read — so "your routes match nothing" is a false
    // alarm, not a finding.
    const appEnv = configured({ workersDev: false, customDomains: [], deny: ['zones'] });
    const auth = await adminAuth(appEnv);
    await putRoute(appEnv, auth, 'r1', {
      match: { host: 'mirror.example.com', path: '/' },
      upstream: 'up.example.com',
    });
    const body = await domains(appEnv, auth);
    expect(body.hosts).toEqual([]);
    expect(body.failures).toEqual([{ source: 'route', message: 'Zone Read required' }]);
    expect(body.unmatchedRouteHosts).toBeUndefined();
  });

  it('honours PROXY_SCRIPT_NAME so a renamed proxy is still found', async () => {
    const stub = apiStub({ customDomains: [] });
    const appEnv = envWith({
      CF_ACCOUNT_ID: 'acct-1',
      CF_API_TOKEN: 'tok',
      CF_API_FETCH: stub.fetch,
      PROXY_SCRIPT_NAME: 'my-proxy',
    });
    const auth = await adminAuth(appEnv);
    const body = await domains(appEnv, auth);
    expect(body.script).toBe('my-proxy');
    expect(stub.calls.some((u) => u.includes('service=my-proxy'))).toBe(true);
  });

  it('serves a second request from the isolate cache, without a second API call', async () => {
    const stub = apiStub({ workersDev: true });
    const appEnv = envWith({
      CF_ACCOUNT_ID: 'acct-1',
      CF_API_TOKEN: 'tok',
      CF_API_FETCH: stub.fetch,
    });
    const auth = await adminAuth(appEnv);
    await domains(appEnv, auth);
    const first = stub.calls.length;
    expect(first).toBeGreaterThan(0);
    await domains(appEnv, auth);
    expect(stub.calls.length).toBe(first);
  });

  it('does not reuse a cached answer after the token is rotated', async () => {
    const before = apiStub({ customDomains: [{ hostname: 'old.example.com', service: SCRIPT }] });
    const envBefore = envWith({
      CF_ACCOUNT_ID: 'acct-1',
      CF_API_TOKEN: 'old-token',
      CF_API_FETCH: before.fetch,
    });
    const auth = await adminAuth(envBefore);
    expect((await domains(envBefore, auth)).hosts?.[0]?.host).toBe('old.example.com');

    const after = apiStub({ customDomains: [{ hostname: 'new.example.com', service: SCRIPT }] });
    const envAfter = envWith({
      CF_ACCOUNT_ID: 'acct-1',
      CF_API_TOKEN: 'new-token',
      CF_API_FETCH: after.fetch,
    });
    expect((await domains(envAfter, auth)).hosts?.[0]?.host).toBe('new.example.com');
  });

  it('writes nothing: no audit entry for opening the screen', async () => {
    const appEnv = configured({ workersDev: true });
    const auth = await adminAuth(appEnv);
    const before = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{
      n: number;
    }>();
    await domains(appEnv, auth);
    const after = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{
      n: number;
    }>();
    expect(after?.n).toBe(before?.n);
  });

  it('tolerates a route row whose definition will not parse', async () => {
    const appEnv = configured({ customDomains: [] });
    const auth = await adminAuth(appEnv);
    await testEnv.DB.prepare(
      'INSERT INTO routes (id, definition, enabled, position, updated_at, updated_by) VALUES (?, ?, 1, 0, 0, ?)',
    )
      .bind('broken', '{not json', 'test')
      .run();
    // The screen must still open: a corrupt row is a compile problem, reported
    // on the preview screen, not a reason for this lookup to 500.
    const body = await domains(appEnv, auth);
    expect(body.configured).toBe(true);
    expect(body.unmatchedRouteHosts).toEqual([]);
  });
});

beforeAll(async () => {
  door = await openAccessDoor('domains-suite');
});
