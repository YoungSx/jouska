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
    const out = rewriteResponseHeaders({
      headers,
      upstreamHost: 'origin.test',
      proxyOrigin: 'https://p.dev',
      bodyRewritten: false,
    });
    expect(out.getSetCookie()).toEqual(['a=1; Domain=p.dev', 'b=2; Domain=p.dev']);
  });

  it('rewrites Location and preserves unrelated headers', () => {
    const headers = new Headers({ location: 'https://origin.test/a', 'x-keep': 'yes' });
    const out = rewriteResponseHeaders({
      headers,
      upstreamHost: 'origin.test',
      proxyOrigin: 'https://p.dev',
      bodyRewritten: false,
    });
    expect(out.get('location')).toBe('https://p.dev/a');
    expect(out.get('x-keep')).toBe('yes');
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

  it('ignores a trailing dot on either side', () => {
    expect(upstreamHostMatcher('origin.test.')('origin.test')).toBe(true);
    expect(upstreamHostMatcher('origin.test')('www.origin.test.')).toBe(true);
  });
});
