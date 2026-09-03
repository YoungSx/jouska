import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config';
import { hostMatches, matchRoute, resolveUpstreamUrl, upstreamCandidates } from '../../src/router';

const req = (url: string, init?: RequestInit) => new Request(url, init);

describe('matchRoute', () => {
  it('matches on path prefix at segment boundaries', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/openai' }, upstream: 'api.openai.com' }],
    });
    expect(matchRoute(config, req('https://p.dev/openai/v1/models'))?.matchedPrefix).toBe(
      '/openai',
    );
    expect(matchRoute(config, req('https://p.dev/openai'))?.matchedPrefix).toBe('/openai');
    // must not match a longer sibling segment
    expect(matchRoute(config, req('https://p.dev/openai-beta/v1'))).toBeUndefined();
  });

  it('matches wildcard hosts on subdomains but not the apex', () => {
    const config = defineConfig({
      routes: [{ match: { host: '*.example.com' }, upstream: 'origin.test' }],
    });
    expect(matchRoute(config, req('https://a.example.com/'))).toBeDefined();
    expect(matchRoute(config, req('https://example.com/'))).toBeUndefined();
  });

  it('refuses the empty-label host a wildcard route appears to cover', () => {
    // `.example.com` parses: `new URL('https://.example.com/x').hostname` is
    // `.example.com` verbatim, so this host is reachable, not hypothetical.
    // It must not match `*.example.com` — there is no subdomain, and treating
    // the empty label as one would route a host nobody registered.
    //
    // This is pinned because the obvious alternatives get it wrong. Verified in
    // workerd: `URLPattern` with `{hostname: '*.example.com'}` returns true for
    // both `.example.com` and `..example.com`, MDN's `{*.}?example.com` leaks the
    // same way, and `wildcard-match` also admits it. The `host.length >
    // suffix.length` guard in `hostMatches` is the whole difference.
    const config = defineConfig({
      routes: [{ match: { host: '*.example.com' }, upstream: 'origin.test' }],
    });
    for (const host of ['.example.com', '..example.com', '...example.com', 'a..example.com']) {
      expect(matchRoute(config, req(`https://${host}/x`)), host).toBeUndefined();
    }
    // The cases that must keep working, so the guard cannot be satisfied by
    // rejecting everything.
    expect(matchRoute(config, req('https://a.example.com/x'))).toBeDefined();
    expect(matchRoute(config, req('https://a.b.example.com/x'))).toBeDefined();
  });

  it('ignores the port when comparing hosts', () => {
    const config = defineConfig({
      routes: [{ match: { host: 'p.dev' }, upstream: 'origin.test' }],
    });
    expect(matchRoute(config, req('https://p.dev:8443/x'))).toBeDefined();
  });

  it('filters by method', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/w', methods: ['POST'] }, upstream: 'origin.test' }],
    });
    expect(matchRoute(config, req('https://p.dev/w', { method: 'POST' }))).toBeDefined();
    expect(matchRoute(config, req('https://p.dev/w'))).toBeUndefined();
  });

  /**
   * Every spelling an upstream would resolve to `/admin` has to match the
   * `/admin` route, or a guard on that route is bypassed by writing the path
   * differently and letting a laxer route take the request.
   *
   * All of these were verified failing in workerd before the fix: `decodeURI`
   * does not decode `%2f`, `%5c`, `%3f` or `%23` (it is the inverse of
   * `encodeURI`, which never emits them), `/;x/admin` became `//admin` after the
   * separator-collapsing step had already run, and `/%252fadmin` needs two
   * decode rounds before the separator appears.
   */
  it('matches every spelling an upstream would decode to the guarded path', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/admin' }, upstream: 'origin.test' }],
    });
    for (const path of [
      '/admin',
      '/%61dmin', // percent-encoded letter
      '//admin', // repeated separator
      '/./admin', // dot segment (normalised by the URL parser)
      '/admin;x', // path parameter
      '/;x/admin', // parameter whose removal exposes a repeated separator
      '/%2fadmin', // encoded separator
      '/%2Fadmin', // ...in upper case
      '/%5cadmin', // backslash as separator
      '/admin%3fx', // cut short at a query
      '/admin%23x', // cut short at a fragment
      '/a%2f..%2fadmin', // traversal via encoded separators
      '/a/%2e%2e/admin', // traversal via encoded dots
      '/%252fadmin', // double-encoded separator
    ]) {
      expect(matchRoute(config, req(`https://p.dev${path}`)), path).toBeDefined();
    }
  });

  /**
   * The other half of the same guarantee: normalising aggressively must not
   * start matching paths that share a prefix by coincidence, or the fix trades a
   * bypass for an outage.
   */
  it('does not match paths that merely look like the guarded one', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/admin' }, upstream: 'origin.test' }],
    });
    for (const path of ['/administrator', '/admin-beta', '/public/adminx', '/notadmin']) {
      expect(matchRoute(config, req(`https://p.dev${path}`)), path).toBeUndefined();
    }
  });

  /**
   * A crafted path must not be able to spin in the normalisation loop. 200
   * nested `%25` escapes resolve in bounded time because the loop stops after a
   * fixed number of rounds rather than running to a true fixed point.
   */
  it('bounds the normalisation loop', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/x' }, upstream: 'origin.test' }],
    });
    const nested = `/${'%25'.repeat(200)}2fadmin`;
    const startedAt = Date.now();
    matchRoute(config, req(`https://p.dev${nested}`));
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('returns the first matching route', () => {
    const config = defineConfig({
      routes: [
        { match: { path: '/a' }, upstream: 'first.test' },
        { match: { path: '/a' }, upstream: 'second.test' },
      ],
    });
    expect(matchRoute(config, req('https://p.dev/a'))?.route.upstream).toBe('first.test');
  });
});

describe('resolveUpstreamUrl', () => {
  const resolve = (route: Parameters<typeof defineConfig>[0]['routes'][number], url: string) => {
    const config = defineConfig({ routes: [route] });
    const request = req(url);
    // Single-upstream routes: the one candidate is the route's own upstream.
    const [candidate] = upstreamCandidates(matchRoute(config, request)!.route);
    return resolveUpstreamUrl(
      matchRoute(config, request)!,
      new URL(request.url),
      candidate,
    ).toString();
  };

  it('preserves the path by default', () => {
    expect(
      resolve(
        { match: { path: '/openai' }, upstream: 'api.openai.com' },
        'https://p.dev/openai/v1/models',
      ),
    ).toBe('https://api.openai.com/openai/v1/models');
  });

  it('strips the matched prefix when asked', () => {
    expect(
      resolve(
        { match: { path: '/openai' }, upstream: 'api.openai.com', stripPrefix: true },
        'https://p.dev/openai/v1/models',
      ),
    ).toBe('https://api.openai.com/v1/models');
  });

  it('prepends the upstream base path', () => {
    expect(
      resolve(
        {
          match: { path: '/ai' },
          upstream: 'api.example.com/openai-compatible',
          stripPrefix: true,
        },
        'https://p.dev/ai/chat',
      ),
    ).toBe('https://api.example.com/openai-compatible/chat');
  });

  it('keeps the query string', () => {
    expect(
      resolve(
        { match: { path: '/s' }, upstream: 'origin.test', stripPrefix: true },
        'https://p.dev/s/find?q=1&r=2',
      ),
    ).toBe('https://origin.test/find?q=1&r=2');
  });

  it('yields / when stripping consumes the whole path', () => {
    expect(
      resolve(
        { match: { path: '/s' }, upstream: 'origin.test', stripPrefix: true },
        'https://p.dev/s',
      ),
    ).toBe('https://origin.test/');
  });

  /**
   * Matching normalises aggressively; forwarding must not. The escapes below all
   * mean something different to an upstream once decoded, so re-encoding or
   * decoding them here would send a different request than the client made.
   */
  it('forwards the client encoding untouched when stripping a prefix', () => {
    const route = {
      match: { path: '/api' },
      upstream: 'origin.test/v1',
      stripPrefix: true,
    } as const;
    expect(resolve(route, 'https://p.dev/api/a%20b')).toBe('https://origin.test/v1/a%20b');
    expect(resolve(route, 'https://p.dev/api/%61bc')).toBe('https://origin.test/v1/%61bc');
    // An encoded separator inside a path segment is data, not structure.
    expect(resolve(route, 'https://p.dev/api/a%2fb')).toBe('https://origin.test/v1/a%2fb');
  });

  it('forwards the client encoding untouched with no prefix strip', () => {
    const route = { match: { path: '/api' }, upstream: 'origin.test' } as const;
    expect(resolve(route, 'https://p.dev/api/a%20b')).toBe('https://origin.test/api/a%20b');
    expect(resolve(route, 'https://p.dev/api/a%2fb')).toBe('https://origin.test/api/a%2fb');
  });
});

describe('match conditions (headers / query / cookies)', () => {
  const configWith = (routes: unknown[]) => defineConfig({ routes: routes as never[] });

  /**
   * Acceptance: two routes that share host and path, told apart by a header
   * value alone, each serve their own traffic no matter which one is written
   * first — the condition participates in the walk, it is not decoration that
   * only works in one table order.
   */
  it('routes by header alone, order-independently (acceptance #1)', () => {
    const prod = {
      match: { path: '/api', headers: [{ name: 'X-Env', equals: 'prod' }] },
      upstream: 'prod.test',
    };
    const staging = {
      match: { path: '/api', headers: [{ name: 'X-Env', equals: 'staging' }] },
      upstream: 'staging.test',
    };
    for (const routes of [
      [prod, staging],
      [staging, prod],
    ]) {
      const config = configWith(routes);
      expect(
        matchRoute(config, req('https://p.dev/api', { headers: { 'X-Env': 'prod' } }))?.route
          .upstream,
      ).toBe('prod.test');
      expect(
        matchRoute(config, req('https://p.dev/api', { headers: { 'X-Env': 'staging' } }))?.route
          .upstream,
      ).toBe('staging.test');
    }
  });

  it('lets an earlier unconditional route take the header traffic — that is shadowing, and the detector warns about it', () => {
    const base = { match: { path: '/api' }, upstream: 'o.test' };
    const canary = {
      match: { path: '/api', headers: [{ name: 'X-Canary', present: true }] },
      upstream: 'canary.test',
    };
    const config = configWith([base, canary]);
    // First-match-wins is still the law: the plain route reads everything.
    expect(matchRoute(config, req('https://p.dev/api'))?.route.upstream).toBe('o.test');
    expect(
      matchRoute(config, req('https://p.dev/api', { headers: { 'X-Canary': '1' } }))?.route
        .upstream,
    ).toBe('o.test');
    // Reordering makes the canary reachable again.
    const reordered = configWith([canary, base]);
    expect(
      matchRoute(reordered, req('https://p.dev/api', { headers: { 'X-Canary': '1' } }))?.route
        .upstream,
    ).toBe('canary.test');
    expect(matchRoute(reordered, req('https://p.dev/api'))?.route.upstream).toBe('o.test');
  });

  it('matches equals and prefix on header values case-sensitively', () => {
    const config = configWith([
      {
        match: { path: '/a', headers: [{ name: 'x-env', equals: 'Prod' }] },
        upstream: 'o.test',
      },
    ]);
    expect(
      matchRoute(config, req('https://p.dev/a', { headers: { 'X-ENV': 'Prod' } })),
    ).toBeDefined();
    expect(
      matchRoute(config, req('https://p.dev/a', { headers: { 'x-env': 'prod' } })),
    ).toBeUndefined();
    expect(
      matchRoute(config, req('https://p.dev/a', { headers: { 'x-env': 'Production' } })),
    ).toBeUndefined();
  });

  it('treats present as existence: an empty value exists (acceptance #2)', () => {
    // `X-Foo:` carries an empty value, which is a header, not the absence of
    // one — so `present: true` matches it and `present: false` does not.
    const config = configWith([
      { match: { path: '/a', headers: [{ name: 'x-foo', present: true }] }, upstream: 'yes.test' },
      { match: { path: '/b', headers: [{ name: 'x-foo', present: false }] }, upstream: 'no.test' },
    ]);
    expect(matchRoute(config, req('https://p.dev/a', { headers: { 'X-Foo': '' } }))).toBeDefined();
    expect(
      matchRoute(config, req('https://p.dev/b', { headers: { 'X-Foo': '' } })),
    ).toBeUndefined();
  });

  it('matches query parameters on the parsed search params', () => {
    const config = configWith([
      {
        match: { path: '/a', query: [{ name: 'debug', equals: '1' }] },
        upstream: 'o.test',
      },
    ]);
    expect(matchRoute(config, req('https://p.dev/a?debug=1'))).toBeDefined();
    expect(matchRoute(config, req('https://p.dev/a?debug=2'))).toBeUndefined();
    expect(matchRoute(config, req('https://p.dev/a'))).toBeUndefined();
    // Presence without a value: `?debug` is a name with an empty value.
    const bare = configWith([
      {
        match: { path: '/a', query: [{ name: 'debug', present: true }] },
        upstream: 'o.test',
      },
    ]);
    expect(matchRoute(bare, req('https://p.dev/a?debug'))).toBeDefined();
  });

  it('reads cookies from the Cookie header, not from Headers.get', () => {
    // A cookie name is not a header name; the only way to see one is to parse
    // the `Cookie` header the same way selection does.
    const config = configWith([
      {
        match: { path: '/a', cookies: [{ name: 'beta', equals: 'on' }] },
        upstream: 'o.test',
      },
    ]);
    expect(
      matchRoute(config, req('https://p.dev/a', { headers: { Cookie: 'sid=x; beta=on' } })),
    ).toBeDefined();
    expect(
      matchRoute(config, req('https://p.dev/a', { headers: { Cookie: 'beta=off' } })),
    ).toBeUndefined();
    expect(matchRoute(config, req('https://p.dev/a'))).toBeUndefined();
    // An empty cookie value parses as present.
    expect(
      matchRoute(config, req('https://p.dev/a', { headers: { Cookie: 'beta=' } })),
    ).toBeUndefined();
  });

  it('requires every condition across families to hold (AND)', () => {
    const config = configWith([
      {
        match: {
          path: '/a',
          headers: [{ name: 'x-env', equals: 'prod' }],
          query: [{ name: 'v', prefix: '2' }],
          cookies: [{ name: 'beta', present: false }],
        },
        upstream: 'o.test',
      },
    ]);
    const ok = req('https://p.dev/a?v=2', { headers: { 'x-env': 'prod' } });
    expect(matchRoute(config, ok)).toBeDefined();
    // Each violation alone sinks the route.
    expect(
      matchRoute(config, req('https://p.dev/a?v=3', { headers: { 'x-env': 'prod' } })),
    ).toBeUndefined();
    expect(matchRoute(config, req('https://p.dev/a?v=2'))).toBeUndefined();
    expect(
      matchRoute(
        config,
        req('https://p.dev/a?v=2', { headers: { 'x-env': 'prod', Cookie: 'beta=1' } }),
      ),
    ).toBeUndefined();
  });
});

describe('hostMatches', () => {
  // The referer guard compares against this same matcher, so its rules are
  // asserted here directly rather than only through route matching.
  it('matches a wildcard on subdomains but not the apex', () => {
    expect(hostMatches('*.example.com', 'a.example.com')).toBe(true);
    expect(hostMatches('*.example.com', 'example.com')).toBe(false);
  });

  it('never matches a merely similar suffix', () => {
    expect(hostMatches('*.example.com', 'evilexample.com')).toBe(false);
    expect(hostMatches('example.com', 'evilexample.com')).toBe(false);
  });

  it('refuses the empty-label host a wildcard route appears to cover', () => {
    expect(hostMatches('*.example.com', '..example.com')).toBe(false);
  });

  it('compares exactly against a literal pattern', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true);
    expect(hostMatches('example.com', 'a.example.com')).toBe(false);
  });

  it('matches case-insensitively on the caller-lowered host', () => {
    expect(hostMatches('*.example.com', 'A.Example.com'.toLowerCase())).toBe(true);
  });
});
