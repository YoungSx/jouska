import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config';
import { matchRoute, resolveUpstreamUrl } from '../../src/router';

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
    return resolveUpstreamUrl(matchRoute(config, request)!, new URL(request.url)).toString();
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
});
