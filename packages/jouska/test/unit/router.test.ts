import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config';
import { matchRoute, resolveUpstreamUrl, upstreamCandidates } from '../../src/router';

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
