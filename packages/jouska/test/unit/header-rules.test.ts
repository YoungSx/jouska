import { describe, expect, it } from 'vitest';
import { defineConfig, type ConfigInput } from '../../src/config';
import { applyResponseHeaderRules } from '../../src/internal/headers';

const withRoute = (extra: Record<string, unknown>): ConfigInput => ({
  routes: [{ match: { path: '/a' }, upstream: 'o.test', ...extra }],
});
const parse = (extra: Record<string, unknown>) => defineConfig(withRoute(extra)).routes[0]!;

describe('requestHeaders schema', () => {
  it('canonicalises names to lower case on both operations', () => {
    const route = parse({
      requestHeaders: { set: { 'X-Api-Version': '2026-09' }, remove: ['X-Legacy-Client'] },
    });
    expect(route.requestHeaders).toEqual({
      set: { 'x-api-version': '2026-09' },
      remove: ['x-legacy-client'],
    });
  });

  it('collapses duplicate removals rather than deleting twice', () => {
    expect(parse({ requestHeaders: { remove: ['X-A', 'x-a'] } }).requestHeaders?.remove).toEqual([
      'x-a',
    ]);
  });

  it('refuses a name written in two cases, which would depend on key order', () => {
    expect(() => parse({ requestHeaders: { set: { 'X-A': '1', 'x-a': '2' } } })).toThrow(
      /case-insensitive/,
    );
  });

  it('refuses the forwarding headers, in both directions of the rule', () => {
    for (const name of ['host', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) {
      expect(() => parse({ requestHeaders: { set: { [name]: 'v' } } })).toThrow(/may not write/);
      expect(() => parse({ requestHeaders: { remove: [name] } })).toThrow(/may not delete/);
    }
  });

  it('refuses x-request-id, which the proxy resolves itself', () => {
    // The proxy stamps the ID it resolved onto every attempt; a rule that wrote
    // one would be silently discarded per candidate while reading as live.
    expect(() => parse({ requestHeaders: { set: { 'x-request-id': 'forged' } } })).toThrow(
      /may not write/,
    );
    expect(() => parse({ requestHeaders: { remove: ['X-Request-Id'] } })).toThrow(/may not delete/);
  });

  it('refuses accept-encoding, which would silently disable body rewriting', () => {
    expect(() => parse({ requestHeaders: { set: { 'accept-encoding': 'gzip' } } })).toThrow(
      /may not write/,
    );
  });

  it('refuses the hop-by-hop set and content-length', () => {
    for (const name of ['connection', 'transfer-encoding', 'te', 'content-length']) {
      expect(() => parse({ requestHeaders: { set: { [name]: 'v' } } })).toThrow(/may not write/);
    }
  });

  it('refuses the WebSocket handshake headers, which the websocket flag governs', () => {
    expect(() => parse({ requestHeaders: { set: { upgrade: 'websocket' } } })).toThrow(
      /may not write/,
    );
    expect(() => parse({ requestHeaders: { set: { 'sec-websocket-key': 'k' } } })).toThrow(
      /may not write/,
    );
  });

  it('refuses writing and deleting the same header', () => {
    expect(() => parse({ requestHeaders: { set: { 'x-a': '1' }, remove: ['X-A'] } })).toThrow(
      /both writes and deletes/,
    );
  });

  it('refuses a name that is not an RFC 9110 token', () => {
    expect(() => parse({ requestHeaders: { set: { 'x a': '1' } } })).toThrow();
    expect(() => parse({ requestHeaders: { remove: ['x a'] } })).toThrow();
  });
});

describe('responseHeaders schema', () => {
  it('accepts the everyday case', () => {
    expect(
      parse({
        responseHeaders: {
          set: { 'X-Content-Type-Options': 'nosniff' },
          remove: ['Server', 'X-Powered-By'],
        },
      }).responseHeaders,
    ).toEqual({
      set: { 'x-content-type-options': 'nosniff' },
      remove: ['server', 'x-powered-by'],
    });
  });

  it('refuses deleting the headers the proxy rewrote', () => {
    for (const name of ['location', 'content-location', 'refresh', 'set-cookie']) {
      expect(() => parse({ responseHeaders: { remove: [name] } })).toThrow(/may not delete/);
    }
  });

  it('permits writing Location, which is the documented trade-off', () => {
    expect(
      parse({ responseHeaders: { set: { location: 'https://elsewhere.test/' } } }).responseHeaders
        ?.set,
    ).toEqual({ location: 'https://elsewhere.test/' });
  });

  it('refuses writing set-cookie, because Headers.set replaces every value', () => {
    expect(() => parse({ responseHeaders: { set: { 'set-cookie': 'a=1' } } })).toThrow(
      /may not write/,
    );
  });

  it('refuses writing the transport headers', () => {
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'connection']) {
      expect(() => parse({ responseHeaders: { set: { [name]: 'v' } } })).toThrow(/may not write/);
    }
  });

  it('permits writing a CSP, which is flagged rather than forbidden', () => {
    expect(
      parse({
        responseHeaders: { set: { 'content-security-policy': "default-src 'self'" } },
      }).responseHeaders?.set['content-security-policy'],
    ).toBe("default-src 'self'");
  });
});

describe('upstreamHeaders as an alias', () => {
  it('folds into requestHeaders.set and does not survive as its own field', () => {
    const route = parse({ upstreamHeaders: { 'X-Key': 'v' } });
    expect(route.requestHeaders).toEqual({ set: { 'x-key': 'v' }, remove: [] });
    expect('upstreamHeaders' in route).toBe(false);
  });

  it('leaves requestHeaders undefined when the alias is empty', () => {
    expect(parse({}).requestHeaders).toBeUndefined();
  });

  it('merges with an explicit requestHeaders block', () => {
    const route = parse({
      upstreamHeaders: { 'x-from-alias': 'a' },
      requestHeaders: { set: { 'x-from-field': 'b' }, remove: ['x-drop'] },
    });
    expect(route.requestHeaders).toEqual({
      set: { 'x-from-alias': 'a', 'x-from-field': 'b' },
      remove: ['x-drop'],
    });
  });

  it('accepts the same name written twice with the same value', () => {
    expect(
      parse({ upstreamHeaders: { 'x-a': '1' }, requestHeaders: { set: { 'x-a': '1' } } })
        .requestHeaders?.set,
    ).toEqual({ 'x-a': '1' });
  });

  it('refuses the same name written twice with different values', () => {
    expect(() =>
      parse({ upstreamHeaders: { 'x-a': '1' }, requestHeaders: { set: { 'X-A': '2' } } }),
    ).toThrow(/state it once/);
  });

  it('refuses a name the alias writes and requestHeaders deletes', () => {
    expect(() =>
      parse({ upstreamHeaders: { 'x-a': '1' }, requestHeaders: { remove: ['x-a'] } }),
    ).toThrow(/both writes and deletes/);
  });

  it('applies the same refusals as the field it aliases', () => {
    // Previously only the four forwarding headers were refused here, so an alias
    // could set accept-encoding and silently disable body rewriting.
    expect(() => parse({ upstreamHeaders: { 'accept-encoding': 'gzip' } })).toThrow(
      /may not write/,
    );
    expect(() => parse({ upstreamHeaders: { host: 'x' } })).toThrow(/may not write/);
  });
});

describe('defaults folding for header rules', () => {
  it('merges writes entry by entry and unions deletions', () => {
    const config = defineConfig({
      defaults: {
        responseHeaders: { set: { 'x-shared': 's' }, remove: ['server'] },
      },
      routes: [
        {
          match: { path: '/a' },
          upstream: 'o.test',
          responseHeaders: { set: { 'x-own': 'o' }, remove: ['x-powered-by'] },
        },
      ],
    });
    expect(config.routes[0]!.responseHeaders).toEqual({
      set: { 'x-shared': 's', 'x-own': 'o' },
      remove: ['server', 'x-powered-by'],
    });
  });

  it("lets the route's own value win a name the table also writes", () => {
    const config = defineConfig({
      defaults: { requestHeaders: { set: { 'x-a': 'table' } } },
      routes: [
        { match: { path: '/a' }, upstream: 'o.test', requestHeaders: { set: { 'x-a': 'route' } } },
      ],
    });
    expect(config.routes[0]!.requestHeaders?.set).toEqual({ 'x-a': 'route' });
  });

  it('takes the table-wide block whole when the route states none', () => {
    const config = defineConfig({
      defaults: { requestHeaders: { remove: ['x-legacy'] } },
      routes: [{ match: { path: '/a' }, upstream: 'o.test' }],
    });
    expect(config.routes[0]!.requestHeaders).toEqual({ set: {}, remove: ['x-legacy'] });
  });

  it('catches a contradiction split across the table and the route', () => {
    // Neither half is invalid alone, which is why this check cannot live on the
    // route schema.
    expect(() =>
      defineConfig({
        defaults: { requestHeaders: { remove: ['x-a'] } },
        routes: [
          { match: { path: '/a' }, upstream: 'o.test', requestHeaders: { set: { 'x-a': '1' } } },
        ],
      }),
    ).toThrow(/both writes and deletes/);
  });

  it('catches an alias in the table contradicting a route deletion', () => {
    expect(() =>
      defineConfig({
        defaults: { upstreamHeaders: { 'x-a': '1' } },
        routes: [
          { match: { path: '/a' }, upstream: 'o.test', requestHeaders: { remove: ['x-a'] } },
        ],
      }),
    ).toThrow(/both writes and deletes/);
  });
});

describe('applyResponseHeaderRules', () => {
  it('does nothing without rules', () => {
    const headers = new Headers({ server: 'nginx' });
    applyResponseHeaderRules(headers, undefined);
    expect(headers.get('server')).toBe('nginx');
  });

  it('deletes then writes', () => {
    const headers = new Headers({ server: 'nginx', 'x-powered-by': 'php' });
    applyResponseHeaderRules(headers, {
      set: { 'x-content-type-options': 'nosniff' },
      remove: ['server', 'x-powered-by'],
    });
    expect(headers.get('server')).toBeNull();
    expect(headers.get('x-powered-by')).toBeNull();
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('overwrites a value the proxy already rewrote', () => {
    // The ordering trade-off, pinned: the operator's rule runs last and wins.
    const headers = new Headers({ location: 'https://p.dev/next' });
    applyResponseHeaderRules(headers, { set: { location: 'https://o.test/next' }, remove: [] });
    expect(headers.get('location')).toBe('https://o.test/next');
  });
});
