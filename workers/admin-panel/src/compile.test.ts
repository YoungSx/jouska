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

  it('accepts the form-shaped delegated auth as written by the editor', () => {
    // 表单落盘的形状：failOpen 只有开着才写、copyResponseHeaders 只在有值时写。
    const result = compileConfig(
      [
        row(
          'auth',
          {
            match: { path: '/private' },
            upstream: 'app.example.com',
            forwardAuth: {
              url: 'https://sso.example.com/check',
              copyResponseHeaders: ['x-user-id'],
            },
          },
          0,
        ),
      ],
      undefined,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses auth routes that also configure cache', () => {
    const result = compileConfig(
      [
        row(
          'c',
          {
            match: { path: '/private' },
            upstream: 'app.example.com',
            forwardAuth: { url: 'https://sso.example.com/check' },
            cache: { ttlSeconds: 300 },
          },
          0,
        ),
      ],
      undefined,
    );
    expect(result.ok).toBe(false);
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

  it('flags a later upstream route shadowed by an earlier respond route', () => {
    // Shadowing is a property of `match` alone, so an edge-answering route
    // shadows exactly like a forwarding one — and here it is worse: the shadowed
    // route never runs at all, so the visitor gets the maintenance answer.
    const config = configOf([
      { id: 'maintenance', match: { host: 'a.com' }, respond: { status: 503 } },
      { id: 'real', match: { host: 'a.com', path: '/api' }, upstream: 'u2.com' },
    ]);
    expect(shadowWarnings(config)).toContainEqual(
      expect.objectContaining({ shadowedId: 'real', byId: 'maintenance' }),
    );
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
      const match = matchUrl(
        config,
        new URL(warning.probe),
        'GET',
        new Headers(warning.probeHeaders?.map(({ name, value }) => [name, value]) ?? []),
      );
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

  it('does not flag scheme spelled out as https — the value, not the field, is the risk', () => {
    const flags = dangerFlags({ match: { path: '/' }, upstream: 'a.com', scheme: 'https' });
    expect(flags.map((f) => f.path)).not.toContain('scheme');
  });

  it('leaks no classification internals into the reported risks', () => {
    const flags = dangerFlags({ match: { path: '/' }, upstream: 'a.com', scheme: 'http' });
    expect(
      flags.every((f) => Object.keys(f).every((k) => k in { path: 1, level: 1, reason: 1 })),
    ).toBe(true);
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

  it('flags cache key headers that were named, not an empty list', () => {
    expect(
      dangerFlags({
        match: { path: '/' },
        upstream: 'a.com',
        cache: { key: { query: 'none' } },
      }).map((f) => f.path),
    ).not.toContain('cache.key.headers');
    expect(
      dangerFlags({
        match: { path: '/' },
        upstream: 'a.com',
        cache: { key: { headers: ['user-agent'] } },
      }).map((f) => f.path),
    ).toContain('cache.key.headers');
  });

  it('does not flag anything on a plain safe route', () => {
    const flags = dangerFlags({ match: { host: 'a.com' }, upstream: 'b.com' });
    expect(flags).toEqual([]);
  });

  it('flags delegated auth: failOpen on presence, http url on value', () => {
    const paths = dangerFlags({
      match: { path: '/' },
      upstream: 'a.com',
      forwardAuth: { url: 'https://sso.example.com/check', failOpen: true },
    }).map((f) => f.path);
    expect(paths).toContain('forwardAuth.failOpen');
    // https url 是慎重写出的默认，不是风险。
    expect(paths).not.toContain('forwardAuth.url');

    const plain = dangerFlags({
      match: { path: '/' },
      upstream: 'a.com',
      forwardAuth: { url: 'http://sso.example.com/check' },
    }).map((f) => f.path);
    expect(plain).toContain('forwardAuth.url');
  });

  it('flags a respond route as high danger, and the external-redirect switch beside it', () => {
    // A whole-site 503 answered at the edge is the "left the maintenance page
    // on" shape; it takes real traffic offline with no upstream to notice.
    const maintenance = dangerFlags({
      match: { path: '/' },
      respond: { status: 503, contentType: 'text/html', body: '<p>back soon</p>' },
    });
    expect(maintenance).toContainEqual(expect.objectContaining({ path: 'respond', level: 'high' }));

    const external = dangerFlags({
      match: { path: '/' },
      respond: {
        redirect: { to: 'https://elsewhere.test', allowExternal: true },
      },
    });
    expect(external.map((f) => f.path)).toContain('respond');
    expect(external).toContainEqual(
      expect.objectContaining({ path: 'respond.redirect.allowExternal', level: 'high' }),
    );

    // A relative redirect carries no host risk; the respond rule still fires.
    const internal = dangerFlags({
      match: { path: '/old' },
      respond: { redirect: { to: '/new' } },
    });
    expect(internal.map((f) => f.path)).toEqual(['respond']);
    expect(internal.map((f) => f.level)).toEqual(['high']);

    // A forwarding route is not a respond route.
    expect(
      dangerFlags({ match: { path: '/' }, upstream: 'a.com' }).map((f) => f.path),
    ).not.toContain('respond');
  });

  it('flags mirroring a non-idempotent method or a body, and neither on the defaults', () => {
    // The schema defaults the list to GET and HEAD; writing POST in is the
    // deliberate widening the panel must ask twice about.
    const post = dangerFlags({
      match: { path: '/' },
      upstream: 'a.com',
      mirror: { upstream: 'b.com', methods: ['POST'] },
    }).map((f) => f.path);
    expect(post).toContain('mirror.methods');

    // The other idempotent methods ride the same guard, and a value that only
    // re-states the defaults raises nothing — a warning on `GET` would make the
    // publish dialog lie.
    expect(
      dangerFlags({
        match: { path: '/' },
        upstream: 'a.com',
        mirror: { upstream: 'b.com', methods: ['GET', 'DELETE'] },
      }).map((f) => f.path),
    ).toContain('mirror.methods');
    expect(
      dangerFlags({
        match: { path: '/' },
        upstream: 'a.com',
        mirror: { upstream: 'b.com' },
      }).map((f) => f.path),
    ).toEqual([]);

    // Bodies off is the default spelled out and warns on nothing; `true` is the
    // acceptance of a second host seeing the payload.
    expect(
      dangerFlags({
        match: { path: '/' },
        upstream: 'a.com',
        mirror: { upstream: 'b.com', includeBody: false },
      }).map((f) => f.path),
    ).toEqual([]);
    expect(
      dangerFlags({
        match: { path: '/' },
        upstream: 'a.com',
        mirror: { upstream: 'b.com', includeBody: true },
      }).map((f) => f.path),
    ).toContain('mirror.includeBody');

    // A body mirror is memory and reach, but not a re-run of the method.
    expect(
      dangerFlags({
        match: { path: '/' },
        upstream: 'a.com',
        mirror: { upstream: 'b.com', includeBody: true },
      }).map((f) => f.path),
    ).not.toContain('mirror.methods');
  });
});

describe('shadowWarnings with match conditions', () => {
  const configOf = (routes: unknown[]): Config => configSchema.parse({ routes }) as Config;

  it('flags a header-conditional route fully shadowed by an earlier unconditional route (acceptance #3)', () => {
    const config = configOf([
      { id: 'wide', match: { host: 'a.com' }, upstream: 'u1.com' },
      {
        id: 'canary',
        match: { host: 'a.com', headers: [{ name: 'x-canary', present: true }] },
        upstream: 'u2.com',
      },
    ]);
    const warnings = shadowWarnings(config);
    expect(warnings).toContainEqual(
      expect.objectContaining({ shadowedId: 'canary', byId: 'wide' }),
    );
    // The probe must carry the header the condition demands — a bare URL could
    // not have proven this shadow.
    const warning = warnings.find((w) => w.shadowedId === 'canary');
    expect(warning?.probeHeaders).toContainEqual({ name: 'x-canary', value: 'shadow-probe' });
  });

  it('stays quiet when the conditional route is reachable through its probe', () => {
    const config = configOf([
      {
        id: 'canary',
        match: { host: 'a.com', headers: [{ name: 'x-canary', present: true }] },
        upstream: 'u2.com',
      },
      { id: 'wide', match: { host: 'a.com' }, upstream: 'u1.com' },
    ]);
    expect(shadowWarnings(config)).toEqual([]);
  });

  it('probes with header conditions satisfy every family via matchUrl', () => {
    const config = configOf([
      { id: 'wide', match: { host: 'a.com' }, upstream: 'u1.com' },
      {
        id: 'narrow',
        match: {
          host: 'a.com',
          headers: [{ name: 'x-canary', prefix: 'on' }],
          cookies: [{ name: 'beta', present: true }],
        },
        upstream: 'u2.com',
      },
    ]);
    const warnings = shadowWarnings(config);
    expect(warnings.some((w) => w.shadowedId === 'narrow' && w.byId === 'wide')).toBe(true);
    const warning = warnings.find((w) => w.shadowedId === 'narrow')!;
    const match = matchUrl(
      config,
      new URL(warning.probe),
      'GET',
      new Headers(warning.probeHeaders?.map(({ name, value }) => [name, value]) ?? []),
    );
    // Production-same-code proof: the probe is the evidence, run through the
    // matcher the proxy runs.
    expect(config.routes[match!.index]?.id).toBe('wide');
  });

  it('skips the route whose header condition names cookie alongside cookie conditions', () => {
    // No single probe can satisfy a header named `cookie` and a parsed cookie
    // condition at once; the detector prefers a missed warning over a false one.
    const config = configOf([
      { id: 'wide', match: { host: 'a.com' }, upstream: 'u1.com' },
      {
        id: 'tangled',
        match: {
          host: 'a.com',
          headers: [{ name: 'cookie', equals: 'beta=on' }],
          cookies: [{ name: 'beta', present: true }],
        },
        upstream: 'u2.com',
      },
    ]);
    expect(shadowWarnings(config)).toEqual([]);
  });
});

describe('cacheVaryWarnings', () => {
  const compile = (routes: unknown[]) =>
    compileConfig(
      routes.map((definition, index) => row(`r${index}`, definition, index)),
      undefined,
    );

  it('advises a caching route that matches on headers or cookies (acceptance #4)', () => {
    const result = compile([
      {
        match: { host: 'a.com', headers: [{ name: 'x-env', equals: 'prod' }] },
        upstream: 'u1.com',
        cache: { enabled: true },
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.cacheVaryWarnings).toEqual([{ routeId: 'r0', names: ['x-env'] }]);
  });

  it('stays silent for caching routes that branch on nothing finer than the URL', () => {
    const result = compile([
      { match: { host: 'a.com' }, upstream: 'u1.com', cache: { enabled: true } },
      {
        match: { host: 'b.com', query: [{ name: 'debug', present: true }] },
        upstream: 'u2.com',
        cache: { enabled: true },
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // Query parameters live in the URL, so they never need the advisory.
    expect(result.cacheVaryWarnings).toEqual([]);
  });

  it('does not advise a conditional route that does not cache', () => {
    const result = compile([
      {
        match: { host: 'a.com', headers: [{ name: 'x-env', present: true }] },
        upstream: 'u1.com',
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.cacheVaryWarnings).toEqual([]);
  });
});

describe('signedLinkCacheWarnings', () => {
  const compile = (routes: unknown[]) =>
    compileConfig(
      routes.map((definition, index) => row(`r${index}`, definition, index)),
      undefined,
    );

  const signedRoute = (cache: unknown) => ({
    match: { host: 'a.com' },
    upstream: 'u1.com',
    signedLink: { secretBinding: 'KEY' },
    cache,
  });

  it('advises a caching signed-link route whose key keeps the link parameters', () => {
    const result = compile([signedRoute({ enabled: true })]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // The defaults fold nothing out, so sig and exp both land in the key.
    expect(result.signedLinkCacheWarnings).toEqual([
      { routeId: 'r0', param: 'sig', expiresParam: 'exp' },
    ]);
  });

  it('stays silent when the key ignores both the signature and expiry parameters', () => {
    const result = compile([
      signedRoute({ enabled: true, key: { query: { ignore: ['sig', 'exp'] } } }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.signedLinkCacheWarnings).toEqual([]);
  });

  it('still advises when only one of the two parameters is folded out', () => {
    const result = compile([signedRoute({ enabled: true, key: { query: { ignore: ['sig'] } } })]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // A key that still varies with `exp` is still one entry per link.
    expect(result.signedLinkCacheWarnings).toEqual([
      { routeId: 'r0', param: 'sig', expiresParam: 'exp' },
    ]);
  });

  it('says nothing about a signed route that does not cache', () => {
    const result = compile([signedRoute(undefined)]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.signedLinkCacheWarnings).toEqual([]);
  });

  it('says nothing about a caching route with no signedLink block', () => {
    const result = compile([
      { match: { host: 'a.com' }, upstream: 'u1.com', cache: { enabled: true } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.signedLinkCacheWarnings).toEqual([]);
  });
});
