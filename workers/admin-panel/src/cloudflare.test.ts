/**
 * Tests for the Cloudflare discovery client.
 *
 * Every case drives a stub `fetch`, so the shapes asserted here are the shapes
 * the real API documents — and the failure cases are the ones a real token
 * produces: a scope it lacks, an account with more zones than the budget, an
 * envelope that says `success: false` with HTTP 200.
 */
import { describe, expect, it } from 'vitest';
import { discoverBoundHosts, type CloudflareCredentials } from './cloudflare.js';

const credentials: CloudflareCredentials = {
  accountId: 'acct-1',
  apiToken: 'secret-token-value',
};

const SCRIPT = 'jouska';

/** A successful Cloudflare envelope. */
const ok = (result: unknown): Response =>
  new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** A failure envelope. Cloudflare answers some of these with HTTP 200. */
const fail = (message: string, status = 403): Response =>
  new Response(
    JSON.stringify({ success: false, errors: [{ code: 10000, message }], result: null }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );

interface StubRoute {
  /** Substring matched against the request URL. */
  readonly match: string;
  readonly respond: () => Response;
}

/** Records every URL requested, so call counts can be asserted. */
interface Stub {
  readonly fetch: typeof fetch;
  readonly urls: string[];
  readonly authorizations: (string | null)[];
}

const stub = (routes: readonly StubRoute[]): Stub => {
  const urls: string[] = [];
  const authorizations: (string | null)[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const headers = new Headers(init?.headers ?? {});
    authorizations.push(headers.get('authorization'));
    for (const route of routes) {
      if (url.includes(route.match)) {
        return route.respond();
      }
    }
    return fail(`unstubbed URL: ${url}`, 404);
  };
  return { fetch: impl as unknown as typeof fetch, urls, authorizations };
};

/** The happy path for all three sources, so cases can override one at a time. */
const allSources = (overrides: readonly StubRoute[] = []): StubRoute[] => [
  ...overrides,
  { match: `/workers/scripts/${SCRIPT}/subdomain`, respond: () => ok({ enabled: true }) },
  { match: '/workers/subdomain', respond: () => ok({ subdomain: 'my-team' }) },
  { match: '/workers/domains', respond: () => ok([]) },
  { match: '/zones?', respond: () => ok([]) },
];

describe('discoverBoundHosts', () => {
  it('builds the workers.dev hostname from the script switch and account subdomain', async () => {
    const s = stub(allSources());
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.hosts).toEqual([{ kind: 'workers_dev', host: 'jouska.my-team.workers.dev' }]);
    expect(result.failures).toEqual([]);
  });

  it('omits workers.dev entirely when the script has it disabled', async () => {
    // The account subdomain exists regardless; inventing a hostname from it
    // would advertise one that answers nothing.
    const s = stub(
      allSources([
        { match: `/workers/scripts/${SCRIPT}/subdomain`, respond: () => ok({ enabled: false }) },
      ]),
    );
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.hosts).toEqual([]);
    expect(result.failures).toEqual([]);
    // And the account-level call is not even made.
    expect(s.urls.some((u) => u.endsWith('/workers/subdomain'))).toBe(false);
  });

  it('lists custom domains with their zone, filtered to this script', async () => {
    const s = stub(
      allSources([
        {
          match: '/workers/domains',
          respond: () =>
            ok([
              { hostname: 'proxy.example.com', service: SCRIPT, zone_name: 'example.com' },
              // Server-side filtering is requested, but a mismatch must not be
              // attributed to this script.
              { hostname: 'other.example.com', service: 'someone-else', zone_name: 'example.com' },
            ]),
        },
      ]),
    );
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.hosts).toContainEqual({
      kind: 'custom_domain',
      host: 'proxy.example.com',
      zone: 'example.com',
    });
    expect(result.hosts.some((h) => h.host === 'other.example.com')).toBe(false);
  });

  it('passes the script name as the service filter', async () => {
    const s = stub(allSources());
    await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(s.urls.some((u) => u.includes(`/workers/domains?service=${SCRIPT}`))).toBe(true);
  });

  it('keeps a route pattern verbatim alongside the host it implies', async () => {
    const s = stub(
      allSources([
        { match: '/zones?', respond: () => ok([{ id: 'z1', name: 'example.com' }]) },
        {
          match: '/zones/z1/workers/routes',
          respond: () =>
            ok([
              { id: 'r1', pattern: 'mirror.example.com/*', script: SCRIPT },
              { id: 'r2', pattern: 'other.example.com/*', script: 'someone-else' },
            ]),
        },
      ]),
    );
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.hosts).toContainEqual({
      kind: 'route',
      host: 'mirror.example.com',
      pattern: 'mirror.example.com/*',
      zone: 'example.com',
    });
    expect(result.hosts.some((h) => h.host === 'other.example.com')).toBe(false);
  });

  it('reports a wildcard route pattern as the wildcard it is, not a hostname', async () => {
    const s = stub(
      allSources([
        { match: '/zones?', respond: () => ok([{ id: 'z1', name: 'example.com' }]) },
        {
          match: '/zones/z1/workers/routes',
          respond: () => ok([{ id: 'r1', pattern: '*.example.com/api/*', script: SCRIPT }]),
        },
      ]),
    );
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.hosts).toContainEqual({
      kind: 'route',
      host: '*.example.com',
      pattern: '*.example.com/api/*',
      zone: 'example.com',
    });
  });

  it('handles a bare route pattern with no path', async () => {
    const s = stub(
      allSources([
        { match: '/zones?', respond: () => ok([{ id: 'z1', name: 'example.com' }]) },
        {
          match: '/zones/z1/workers/routes',
          respond: () => ok([{ id: 'r1', pattern: 'example.com', script: SCRIPT }]),
        },
      ]),
    );
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.hosts).toContainEqual({
      kind: 'route',
      host: 'example.com',
      pattern: 'example.com',
      zone: 'example.com',
    });
  });

  it('keeps the other sources when one scope is missing', async () => {
    // A token with Workers Scripts Read but no Zone Read is a realistic
    // least-privilege token; it must still answer the two cheap questions.
    const s = stub(
      allSources([{ match: '/zones?', respond: () => fail('Zone Read permission required') }]),
    );
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.hosts).toEqual([{ kind: 'workers_dev', host: 'jouska.my-team.workers.dev' }]);
    expect(result.failures).toEqual([
      { source: 'route', message: 'Zone Read permission required' },
    ]);
  });

  it('treats HTTP 200 with success:false as a failure', async () => {
    const s = stub(
      allSources([{ match: '/workers/domains', respond: () => fail('Authentication error', 200) }]),
    );
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.failures).toEqual([{ source: 'custom_domain', message: 'Authentication error' }]);
  });

  it('reports a non-JSON body as a status, not a parse crash', async () => {
    const s = stub(
      allSources([
        {
          match: '/workers/domains',
          respond: () => new Response('<html>gateway error</html>', { status: 502 }),
        },
      ]),
    );
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.failures).toEqual([
      { source: 'custom_domain', message: 'HTTP 502 (response was not JSON)' },
    ]);
  });

  it('names the zones it did not examine instead of reporting an empty answer', async () => {
    // 15 zones against a budget of 12: the last three must be reported, or
    // "no routes" would be indistinguishable from "did not look".
    const zones = Array.from({ length: 15 }, (_, i) => ({ id: `z${i}`, name: `zone${i}.com` }));
    const s = stub(
      allSources([
        { match: '/zones?', respond: () => ok(zones) },
        { match: '/workers/routes', respond: () => ok([]) },
      ]),
    );
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.skippedZones).toEqual(['zone12.com', 'zone13.com', 'zone14.com']);
    // And exactly 12 route calls were spent, not 15.
    expect(s.urls.filter((u) => u.includes('/workers/routes')).length).toBe(12);
  });

  it('records a zone the token cannot read as skipped rather than failing the source', async () => {
    const s = stub(
      allSources([
        {
          match: '/zones?',
          respond: () =>
            ok([
              { id: 'z1', name: 'readable.com' },
              { id: 'z2', name: 'forbidden.com' },
            ]),
        },
        {
          match: '/zones/z1/workers/routes',
          respond: () => ok([{ id: 'r1', pattern: 'readable.com/*', script: SCRIPT }]),
        },
        { match: '/zones/z2/workers/routes', respond: () => fail('not permitted') },
      ]),
    );
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.hosts.some((h) => h.host === 'readable.com')).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.skippedZones).toEqual(['forbidden.com']);
  });

  it('de-duplicates a hostname repeated within a source but keeps it across kinds', async () => {
    // The same hostname legitimately appears as a Custom Domain and a route;
    // collapsing them would hide that both exist.
    const s = stub(
      allSources([
        {
          match: '/workers/domains',
          respond: () => ok([{ hostname: 'dual.example.com', service: SCRIPT }]),
        },
        { match: '/zones?', respond: () => ok([{ id: 'z1', name: 'example.com' }]) },
        {
          match: '/zones/z1/workers/routes',
          respond: () =>
            ok([
              { id: 'r1', pattern: 'dual.example.com/*', script: SCRIPT },
              { id: 'r2', pattern: 'dual.example.com/*', script: SCRIPT },
            ]),
        },
      ]),
    );
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.hosts.filter((h) => h.host === 'dual.example.com').length).toBe(2);
    expect(result.hosts.filter((h) => h.kind === 'route').length).toBe(1);
  });

  it('lowercases hostnames so they compare against match.host', async () => {
    // The router lowercases both the pattern and the request host, so an
    // upper-case answer here would look like a mismatch that is not one.
    const s = stub(
      allSources([
        {
          match: '/workers/domains',
          respond: () => ok([{ hostname: 'Proxy.EXAMPLE.com', service: SCRIPT }]),
        },
      ]),
    );
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.hosts.some((h) => h.host === 'proxy.example.com')).toBe(true);
  });

  it('ignores malformed entries instead of turning null into a hostname', async () => {
    const s = stub(
      allSources([
        {
          match: '/workers/domains',
          respond: () =>
            ok([
              { hostname: null, service: SCRIPT },
              { hostname: '', service: SCRIPT },
              'not an object',
              { service: SCRIPT },
              { hostname: 'good.example.com', service: SCRIPT },
            ]),
        },
      ]),
    );
    const result = await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(result.hosts.filter((h) => h.kind === 'custom_domain')).toEqual([
      { kind: 'custom_domain', host: 'good.example.com' },
    ]);
  });

  it('sends the token as a bearer header and never in a URL', async () => {
    const s = stub(allSources());
    await discoverBoundHosts(credentials, SCRIPT, s.fetch);
    expect(s.authorizations.every((a) => a === `Bearer ${credentials.apiToken}`)).toBe(true);
    expect(s.urls.some((u) => u.includes(credentials.apiToken))).toBe(false);
  });

  it('escapes a script name so it cannot alter the request path', async () => {
    const s = stub([{ match: 'api.cloudflare.com', respond: () => ok({ enabled: false }) }]);
    await discoverBoundHosts(credentials, '../../evil', s.fetch);
    // The slashes are percent-encoded, so the traversal stays one path segment.
    expect(s.urls[0]).toContain('/workers/scripts/..%2F..%2Fevil/subdomain');
    expect(s.urls[0]).not.toContain('/../');
  });
});
