import { describe, expect, it } from 'vitest';
import {
  rewriteLocation,
  rewriteResponseHeaders,
  rewriteSetCookie,
  upstreamHostMatcher,
} from '../../src/internal/headers';

/** Cookies scoped to this upstream are the ones eligible for rescoping. */
const fromOrigin = upstreamHostMatcher('origin.test');

describe('rewriteLocation', () => {
  it('moves an upstream absolute redirect onto the proxy', () => {
    expect(rewriteLocation('https://origin.test/next?a=1', 'origin.test', 'https://p.dev')).toBe(
      'https://p.dev/next?a=1',
    );
  });

  it('leaves relative locations untouched', () => {
    expect(rewriteLocation('/next', 'origin.test', 'https://p.dev')).toBe('/next');
  });

  it('leaves third-party redirects untouched', () => {
    expect(rewriteLocation('https://other.test/x', 'origin.test', 'https://p.dev')).toBe(
      'https://other.test/x',
    );
  });

  it('survives an unparseable value', () => {
    expect(rewriteLocation('https://', 'origin.test', 'https://p.dev')).toBe('https://');
  });
});

describe('rewriteSetCookie', () => {
  it('rewrites the Domain attribute', () => {
    expect(
      rewriteSetCookie('id=1; Domain=origin.test; Path=/; HttpOnly', 'p.dev', fromOrigin),
    ).toBe('id=1; Domain=p.dev; Path=/; HttpOnly');
  });

  it('matches the attribute case-insensitively', () => {
    expect(rewriteSetCookie('id=1; domain=origin.test', 'p.dev', fromOrigin)).toBe(
      'id=1; Domain=p.dev',
    );
  });

  it('leaves a host-only cookie alone', () => {
    expect(rewriteSetCookie('id=1; Path=/; Secure', 'p.dev', fromOrigin)).toBe(
      'id=1; Path=/; Secure',
    );
  });

  it('does not confuse a cookie named domain', () => {
    // The cookie pair itself is the first attribute and must never be rewritten.
    expect(rewriteSetCookie('domain=abc; Path=/', 'p.dev', fromOrigin)).toBe('domain=abc; Path=/');
  });
});

describe('rewriteResponseHeaders', () => {
  it('rewrites every Set-Cookie, not just the first', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Domain=origin.test');
    headers.append('set-cookie', 'b=2; Domain=origin.test');
    const { headers: out } = rewriteResponseHeaders({
      headers,
      upstreamHost: 'origin.test',
      proxyOrigin: 'https://p.dev',
      bodyRewritten: false,
    });
    expect(out.getSetCookie()).toEqual(['a=1; Domain=p.dev', 'b=2; Domain=p.dev']);
  });

  it('rewrites Location and preserves unrelated headers', () => {
    const headers = new Headers({ location: 'https://origin.test/a', 'x-keep': 'yes' });
    const { headers: out, redirectRewritten } = rewriteResponseHeaders({
      headers,
      upstreamHost: 'origin.test',
      proxyOrigin: 'https://p.dev',
      bodyRewritten: false,
    });
    expect(out.get('location')).toBe('https://p.dev/a');
    expect(out.get('x-keep')).toBe('yes');
    expect(redirectRewritten).toBe(true);
  });

  it('reports no redirect rewrite when the Location was left alone', () => {
    // A redirect to a host outside the upstream, and one that is already
    // relative, both reach the client exactly as the upstream wrote them.
    for (const location of ['https://other.test/a', '/a']) {
      const { headers: out, redirectRewritten } = rewriteResponseHeaders({
        headers: new Headers({ location }),
        upstreamHost: 'origin.test',
        proxyOrigin: 'https://p.dev',
        bodyRewritten: false,
      });
      expect(out.get('location')).toBe(location);
      expect(redirectRewritten).toBe(false);
    }
  });

  it('does not count a Content-Location rewrite as a redirect', () => {
    // It labels the body, it does not navigate — so a true value would stop
    // meaning "the redirect stayed on the proxy".
    const { headers: out, redirectRewritten } = rewriteResponseHeaders({
      headers: new Headers({ 'content-location': 'https://origin.test/canonical' }),
      upstreamHost: 'origin.test',
      proxyOrigin: 'https://p.dev',
      bodyRewritten: false,
    });
    expect(out.get('content-location')).toBe('https://p.dev/canonical');
    expect(redirectRewritten).toBe(false);
  });
});

describe('upstreamHostMatcher', () => {
  it('covers the upstream host and anything beneath it', () => {
    const match = upstreamHostMatcher('origin.test');
    expect(match('origin.test')).toBe(true);
    expect(match('www.origin.test')).toBe(true);
    expect(match('cdn.a.origin.test')).toBe(true);
    // A port never changes which site a host belongs to.
    expect(match('origin.test:8443')).toBe(true);
  });

  it('does not treat a lookalike as the upstream', () => {
    const match = upstreamHostMatcher('origin.test');
    expect(match('origin.test.evil.com')).toBe(false);
    expect(match('notorigin.test')).toBe(false);
    expect(match('other.test')).toBe(false);
  });

  it('does not walk up to a registrable suffix', () => {
    // Approximating a public-suffix list by taking the last two labels made
    // `origin.co.uk` match every `.co.uk` host, so an unrelated site's cookies
    // were rescoped onto the proxy and its redirects hijacked.
    const match = upstreamHostMatcher('origin.co.uk');
    expect(match('origin.co.uk')).toBe(true);
    expect(match('www.origin.co.uk')).toBe(true);
    expect(match('evil.co.uk')).toBe(false);
    expect(match('totally-unrelated.co.uk')).toBe(false);
  });

  it('does not treat an empty label as a subdomain', () => {
    // `endsWith('.origin.test')` alone accepted all of these. They are reachable:
    // verified in workerd, `new URL('https://..origin.test/x').hostname` is
    // `..origin.test` verbatim, and a `Location` or `Set-Cookie` naming such a
    // host arrives here. Calling it a subdomain would rescope that cookie onto
    // the proxy for a name the upstream's registrant does not own.
    const match = upstreamHostMatcher('origin.test');
    for (const host of ['.origin.test', '..origin.test', 'a..origin.test']) {
      expect(match(host), host).toBe(false);
    }
    // The rows that must keep matching, so the guard cannot pass by rejecting all.
    expect(match('origin.test')).toBe(true);
    expect(match('www.origin.test')).toBe(true);
    expect(match('cdn.a.origin.test')).toBe(true);
  });

  it('ignores a trailing dot on either side', () => {
    expect(upstreamHostMatcher('origin.test.')('origin.test')).toBe(true);
    expect(upstreamHostMatcher('origin.test')('www.origin.test.')).toBe(true);
  });
});
