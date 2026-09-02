import { configSchema, matchUrl, type Config } from 'jouska';
import { describe, expect, it } from 'vitest';
import { compileConfig, type RouteRow } from './compile.js';
import { dangerFlags } from './danger.js';
import { mirrorWarnings } from './mirror.js';
import { shadowWarnings } from './shadow.js';

const row = (id: string, definition: unknown, position = 0, enabled = true): RouteRow => ({
  id,
  definition,
  enabled,
  position,
});

const validRoute = {
  match: { host: 'api.example.com', path: '/v1' },
  upstream: 'upstream.example.com',
};

describe('compileConfig', () => {
  it('compiles rows into a validated document with row ids injected', () => {
    const result = compileConfig([row('r1', validRoute, 0)], undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.document.routes).toEqual([{ ...validRoute, id: 'r1' }]);
    expect(result.document.version).toBe(1);
  });

  it('keeps table defaults where the operator wrote them', () => {
    const result = compileConfig([row('r1', validRoute, 0)], { timeoutMs: 5000 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.document.defaults).toEqual({ timeoutMs: 5000 });
  });

  it('rejects a definition that declares a conflicting id', () => {
    const result = compileConfig([row('r1', { ...validRoute, id: 'other' }, 0)], undefined);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.issues.some((i) => i.path === 'definition.id')).toBe(true);
  });

  it('rejects the "/*" path that reads as a wildcard but matches as a literal prefix', () => {
    const result = compileConfig(
      [row('r1', { match: { host: 'a.example.com', path: '/*' }, upstream: 'u.example.com' }, 0)],
      undefined,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.issues[0]?.path).toBe('definition.match.path');
  });

  it('skips disabled rows entirely', () => {
    const result = compileConfig(
      [row('off', validRoute, 0, false), row('on', validRoute, 1)],
      undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.document.routes).toEqual([{ ...validRoute, id: 'on' }]);
  });

  it('reports an empty table as an issue, not a document', () => {
    const result = compileConfig([], undefined);
    expect(result.ok).toBe(false);
  });

  it('maps a nested zod failure back to its row', () => {
    const bad = { match: { host: 'api.example.com', path: '/v1' }, upstream: 'https://nope.com' };
    const result = compileConfig([row('bad', bad, 0)], undefined);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    const issue = result.issues.find((i) => i.path !== '' && i.path !== 'defaults');
    expect(issue?.routeId).toBe('bad');
  });

  it('refuses a private upstream unless the route opts in', () => {
    const private_ = { match: { path: '/' }, upstream: '127.0.0.1:8080' };
    const refused = compileConfig([row('p', private_, 0)], undefined);
    expect(refused.ok).toBe(false);

    const allowed = compileConfig(
      [row('p', { ...private_, allowPrivateUpstream: true }, 0)],
      undefined,
    );
    expect(allowed.ok).toBe(true);
  });

  it('surfaces table-level defaults type errors', () => {
    const result = compileConfig([row('r1', validRoute, 0)], 'not-an-object');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.issues.some((i) => i.path === 'defaults')).toBe(true);
  });
});

describe('shadowWarnings', () => {
  const configOf = (routes: unknown[]): Config => configSchema.parse({ routes }) as Config;

  it('flags a later route fully caught by an earlier one', () => {
    const config = configOf([
      { id: 'wide', match: { host: 'a.com' }, upstream: 'u1.com' },
      { id: 'narrow', match: { host: 'a.com', path: '/v1' }, upstream: 'u2.com' },
    ]);
    const warnings = shadowWarnings(config);
    expect(warnings).toContainEqual(
      expect.objectContaining({ shadowedId: 'narrow', byId: 'wide' }),
    );
  });

  it('does not flag routes that reach disjoint traffic', () => {
    const config = configOf([
      { id: 'api', match: { host: 'a.com', path: '/api' }, upstream: 'u1.com' },
      { id: 'web', match: { host: 'b.com' }, upstream: 'u2.com' },
    ]);
    expect(shadowWarnings(config)).toEqual([]);
  });

  it('does not flag the later route that is the only match', () => {
    const config = configOf([{ id: 'only', match: { path: '/' }, upstream: 'u.com' }]);
    expect(shadowWarnings(config)).toEqual([]);
  });

  it('flags a wildcard-shadowing pattern via a subdomain probe', () => {
    const config = configOf([
      { id: 'wild', match: { host: '*.a.com' }, upstream: 'u1.com' },
      { id: 'sub', match: { host: 'x.a.com' }, upstream: 'u2.com' },
    ]);
    const warnings = shadowWarnings(config);
    expect(warnings.some((w) => w.shadowedId === 'sub' && w.byId === 'wild')).toBe(true);
    const warning = warnings.find((w) => w.shadowedId === 'sub');
    expect(warning?.probe).toContain('x.a.com');
  });

  it('catches a shadow where the earlier route is method-restricted', () => {
    const config = configOf([
      { id: 'post', match: { host: 'a.com', methods: ['POST'] }, upstream: 'u1.com' },
      { id: 'get', match: { host: 'a.com' }, upstream: 'u2.com' },
    ]);
    // GET on a.com is not shadowed (the POST route ignores it), so the only
    // warnings, if any, must be POST probes.
    const warnings = shadowWarnings(config);
    for (const warning of warnings) {
      expect(new URL(warning.probe).pathname).toBeDefined();
    }
  });

  it('flags a hostless later route shadowed by an earlier host route', () => {
    const config = configOf([
      { id: 'host', match: { host: 'a.com' }, upstream: 'u1.com' },
      { id: 'catchall', match: { path: '/' }, upstream: 'u2.com' },
    ]);
    const warnings = shadowWarnings(config);
    expect(warnings.some((w) => w.shadowedId === 'catchall' && w.byId === 'host')).toBe(true);
  });

  it('probes use matchUrl itself — the same matcher the proxy runs', () => {
    // Cross-validate: the warning's probe really hits `byId` when matched.
    const config = configOf([
      { id: 'first', match: { host: 'a.com', path: '/x' }, upstream: 'u1.com' },
      { id: 'second', match: { host: 'a.com', path: '/x' }, upstream: 'u2.com' },
    ]);
    const warnings = shadowWarnings(config);
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) {
      const match = matchUrl(config, new URL(warning.probe), 'GET');
      expect(match).toBeDefined();
      expect(config.routes[match!.index]?.id).toBe(warning.byId);
    }
  });
});

describe('mirrorWarnings', () => {
  const parseConfig = (routes: unknown[], defaults?: unknown): Config =>
    configSchema.parse({ routes, ...(defaults === undefined ? {} : { defaults }) }) as Config;

  it('flags a host route with no path — the whole-site mirror', () => {
    const config = parseConfig([
      { id: 'gh', match: { host: 'gh.example.com' }, upstream: 'github.com' },
    ]);
    expect(mirrorWarnings(config)).toEqual([{ routeId: 'gh', upstream: 'github.com' }]);
  });

  it('flags a route whose path is "/" — the same intent written out', () => {
    const config = parseConfig([{ id: 'all', match: { path: '/' }, upstream: 'origin.com' }]);
    expect(mirrorWarnings(config)).toEqual([{ routeId: 'all', upstream: 'origin.com' }]);
  });

  it('says nothing about a prefix route', () => {
    // The judgement that keeps this advisory worth reading: an API gateway is
    // not supposed to rewrite bodies, and a warning on every one of them is a
    // warning operators stop seeing.
    const config = parseConfig([
      { id: 'api', match: { host: 'a.com', path: '/api' }, upstream: 'origin.com' },
      { id: 'assets', match: { path: '/static' }, upstream: 'cdn.com' },
    ]);
    expect(mirrorWarnings(config)).toEqual([]);
  });

  it('says nothing once the route rewrites its body', () => {
    const config = parseConfig([
      { id: 'gh', match: { host: 'gh.example.com' }, upstream: 'github.com', bodyRewrite: {} },
    ]);
    expect(mirrorWarnings(config)).toEqual([]);
  });

  it('counts a bodyRewrite supplied by table defaults', () => {
    // Reads the parsed document, so `defaults` are folded in exactly as the
    // proxy will fold them. Checking the raw row would have warned about a route
    // that does rewrite.
    const config = parseConfig(
      [{ id: 'gh', match: { host: 'gh.example.com' }, upstream: 'github.com' }],
      { bodyRewrite: {} },
    );
    expect(mirrorWarnings(config)).toEqual([]);
  });

  it('says nothing when the route opened the section and turned rewriteLinks off', () => {
    // Navigation lands in the same place, but somebody went in and decided this.
    // The advisory is for the operator who never saw the switch.
    const config = parseConfig([
      {
        id: 'gh',
        match: { host: 'gh.example.com' },
        upstream: 'github.com',
        bodyRewrite: { rewriteLinks: false },
      },
    ]);
    expect(mirrorWarnings(config)).toEqual([]);
  });

  it('reports the authority alone, without the upstream base path', () => {
    const config = parseConfig([
      { id: 'gh', match: { host: 'g.com' }, upstream: 'github.com/org' },
    ]);
    expect(mirrorWarnings(config)[0]?.upstream).toBe('github.com');
  });

  it('labels an id-less route by position, matching shadowWarnings', () => {
    const config = parseConfig([{ match: { host: 'a.com' }, upstream: 'origin.com' }]);
    expect(mirrorWarnings(config)[0]?.routeId).toBe('#0');
  });

  it('reaches the compile result, so preview and publish both carry it', () => {
    const result = compileConfig(
      [row('gh', { match: { host: 'gh.example.com' }, upstream: 'github.com' })],
      undefined,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.mirrorWarnings).toEqual([{ routeId: 'gh', upstream: 'github.com' }]);
  });
});

describe('dangerFlags', () => {
  it('flags allowPrivateUpstream and http scheme', () => {
    const flags = dangerFlags({
      allowPrivateUpstream: true,
      scheme: 'http',
      match: { path: '/' },
      upstream: '10.0.0.1',
    });
    expect(flags.map((f) => f.path)).toContain('allowPrivateUpstream');
    expect(flags.map((f) => f.path)).toContain('scheme');
  });

  it('flags upstreamHeaders at the top level only when present', () => {
    expect(
      dangerFlags({ match: { path: '/' }, upstream: 'a.com' }).map((f) => f.path),
    ).not.toContain('upstreamHeaders');
    expect(
      dangerFlags({
        match: { path: '/' },
        upstream: 'a.com',
        upstreamHeaders: { 'x-key': 'v' },
      }).map((f) => f.path),
    ).toContain('upstreamHeaders');
  });

  it('flags cors.origins only when cors is configured without origins', () => {
    const withCors = dangerFlags({
      match: { path: '/' },
      upstream: 'a.com',
      cors: { allowMethods: ['GET'] },
    });
    expect(withCors.map((f) => f.path)).toContain('cors.origins (absent)');

    const withOrigins = dangerFlags({
      match: { path: '/' },
      upstream: 'a.com',
      cors: { origins: ['https://app.com'] },
    });
    expect(withOrigins.map((f) => f.path)).not.toContain('cors.origins (absent)');

    // No cors at all: nothing to flag.
    expect(
      dangerFlags({ match: { path: '/' }, upstream: 'a.com' }).map((f) => f.path),
    ).not.toContain('cors.origins (absent)');
  });

  it('flags both spellings of the injected request headers', () => {
    // `upstreamHeaders` is an alias for `requestHeaders.set`; a warning on only
    // one of them would be a warning an operator can route around by renaming.
    const paths = dangerFlags({
      match: { path: '/' },
      upstream: 'a.com',
      requestHeaders: { set: { 'x-key': 'v' }, remove: ['cookie'] },
    }).map((f) => f.path);
    expect(paths).toContain('requestHeaders.set');
    expect(paths).toContain('requestHeaders.remove');
    expect(dangerFlags({ requestHeaders: { set: { 'x-key': 'v' } } }).map((f) => f.path)).toEqual([
      'requestHeaders.set',
    ]);
  });

  it('flags writing response headers but not deleting them', () => {
    // Deleting is already bounded by the schema, which refuses the headers the
    // proxy depends on; writing is where the sharp edges are.
    const paths = dangerFlags({
      match: { path: '/' },
      upstream: 'a.com',
      responseHeaders: {
        set: { 'content-security-policy': "default-src 'self'" },
        remove: ['server'],
      },
    }).map((f) => f.path);
    expect(paths).toContain('responseHeaders.set');
    expect(paths).not.toContain('responseHeaders.remove');
  });

  it('flags a cache whose content types were widened, not one on its defaults', () => {
    expect(
      dangerFlags({ match: { path: '/' }, upstream: 'a.com', cache: { ttlSeconds: 300 } }).map(
        (f) => f.path,
      ),
    ).not.toContain('cache.contentTypes');
    expect(
      dangerFlags({
        match: { path: '/' },
        upstream: 'a.com',
        cache: { contentTypes: ['text/html'] },
      }).map((f) => f.path),
    ).toContain('cache.contentTypes');
  });

  it('does not flag anything on a plain safe route', () => {
    const flags = dangerFlags({ match: { host: 'a.com' }, upstream: 'b.com' });
    expect(flags).toEqual([]);
  });
});
