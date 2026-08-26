import { describe, expect, it } from 'vitest';
import { rewriteLocation, rewriteResponseHeaders, rewriteSetCookie } from '../../src/internal/headers';

describe('rewriteLocation', () => {
  it('moves an upstream absolute redirect onto the proxy', () => {
    expect(rewriteLocation('https://origin.test/next?a=1', 'origin.test', 'https://p.dev'))
      .toBe('https://p.dev/next?a=1');
  });

  it('leaves relative locations untouched', () => {
    expect(rewriteLocation('/next', 'origin.test', 'https://p.dev')).toBe('/next');
  });

  it('leaves third-party redirects untouched', () => {
    expect(rewriteLocation('https://other.test/x', 'origin.test', 'https://p.dev'))
      .toBe('https://other.test/x');
  });

  it('survives an unparseable value', () => {
    expect(rewriteLocation('https://', 'origin.test', 'https://p.dev')).toBe('https://');
  });
});

describe('rewriteSetCookie', () => {
  it('rewrites the Domain attribute', () => {
    expect(rewriteSetCookie('id=1; Domain=origin.test; Path=/; HttpOnly', 'p.dev'))
      .toBe('id=1; Domain=p.dev; Path=/; HttpOnly');
  });

  it('matches the attribute case-insensitively', () => {
    expect(rewriteSetCookie('id=1; domain=origin.test', 'p.dev')).toBe('id=1; Domain=p.dev');
  });

  it('leaves a host-only cookie alone', () => {
    expect(rewriteSetCookie('id=1; Path=/; Secure', 'p.dev')).toBe('id=1; Path=/; Secure');
  });

  it('does not confuse a cookie named domain', () => {
    // The cookie pair itself is the first attribute and must never be rewritten.
    expect(rewriteSetCookie('domain=abc; Path=/', 'p.dev')).toBe('domain=abc; Path=/');
  });
});

describe('rewriteResponseHeaders', () => {
  it('rewrites every Set-Cookie, not just the first', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'a=1; Domain=origin.test');
    headers.append('set-cookie', 'b=2; Domain=origin.test');
    const out = rewriteResponseHeaders(headers, 'origin.test', 'https://p.dev');
    expect(out.getSetCookie()).toEqual(['a=1; Domain=p.dev', 'b=2; Domain=p.dev']);
  });

  it('rewrites Location and preserves unrelated headers', () => {
    const headers = new Headers({ location: 'https://origin.test/a', 'x-keep': 'yes' });
    const out = rewriteResponseHeaders(headers, 'origin.test', 'https://p.dev');
    expect(out.get('location')).toBe('https://p.dev/a');
    expect(out.get('x-keep')).toBe('yes');
  });
});
