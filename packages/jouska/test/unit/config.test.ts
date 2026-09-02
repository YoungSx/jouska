import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/config';

describe('defineConfig', () => {
  it('applies defaults', () => {
    const config = defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test' }] });
    const route = config.routes[0]!;
    expect(route.stripPrefix).toBe(false);
    expect(route.timeoutMs).toBe(10_000);
    expect(route.retries).toBe(0);
    expect(route.rewriteHeaders).toBe(true);
    expect(route.bodyRewrite).toBeUndefined();
  });

  it('defaults bodyRewrite fields when the block is present', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/a' }, upstream: 'o.test', bodyRewrite: {} }],
    });
    expect(config.routes[0]!.bodyRewrite).toEqual({
      rewriteLinks: true,
      replace: [],
      contentTypes: ['text/html'],
      rewriteStyles: true,
    });
  });

  it('rejects an upstream with a scheme', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'https://o.test' }] }),
    ).toThrow();
  });

  it('rejects a route that matches nothing', () => {
    expect(() => defineConfig({ routes: [{ match: {}, upstream: 'o.test' }] })).toThrow();
  });

  it('rejects an empty route table', () => {
    expect(() => defineConfig({ routes: [] })).toThrow();
  });

  it('rejects a path without a leading slash', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: 'api' }, upstream: 'o.test' }] }),
    ).toThrow();
  });

  it('rejects a timeout beyond the platform CPU limit', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', timeoutMs: 60_000 }] }),
    ).toThrow();
  });

  it('rejects an unbounded retry count', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', retries: 99 }] }),
    ).toThrow();
  });

  it('accepts an upstream base path', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test/v1/base' }] }),
    ).not.toThrow();
  });

  it('rejects a two-letter country code of the wrong length', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'o.test', blockCountries: ['USA'] }],
      }),
    ).toThrow();
  });

  /**
   * A per-attempt deadline above the combined one is a contradiction: `forward`
   * clamps the attempt to whatever the total has left, so the config says one
   * thing and the proxy does another. It used to be accepted silently.
   */
  it('rejects a per-attempt timeout above the total', () => {
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/a' }, upstream: 'o.test', timeoutMs: 30_000, totalTimeoutMs: 1000 },
        ],
      }),
    ).toThrow(/timeoutMs .* exceeds totalTimeoutMs/);
  });

  it('rejects the same contradiction split across defaults and a route', () => {
    // The check has to run after defaults are folded in: neither half is
    // invalid on its own, and this spelling was accepted before the fix.
    expect(() =>
      defineConfig({
        defaults: { totalTimeoutMs: 1000 },
        routes: [{ match: { path: '/a' }, upstream: 'o.test', timeoutMs: 30_000 }],
      }),
    ).toThrow(/timeoutMs .* exceeds totalTimeoutMs/);
  });

  it('accepts a per-attempt timeout equal to the total', () => {
    // One attempt using the whole budget is coherent, so the check must be
    // strictly greater-than rather than any overlap.
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/a' }, upstream: 'o.test', timeoutMs: 5000, totalTimeoutMs: 5000 },
        ],
      }),
    ).not.toThrow();
  });

  it('accepts the defaults, which leave room for retries', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test' }] }),
    ).not.toThrow();
  });
});

describe('guard config', () => {
  it('defaults CORS fields', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/a' }, upstream: 'o.test', cors: {} }],
    });
    expect(config.routes[0]!.cors).toEqual({
      allowHeaders: [],
      exposeHeaders: [],
      credentials: false,
    });
  });

  it('rejects an ip block with no rules', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', ip: {} }] }),
    ).toThrow();
  });

  it('accepts an ip block with only a deny list', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'o.test', ip: { deny: ['10.0.0.0/8'] } }],
      }),
    ).not.toThrow();
  });

  it('defaults the rate limit key to ip', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/a' }, upstream: 'o.test', rateLimit: { binding: 'RL' } }],
    });
    expect(config.routes[0]!.rateLimit).toEqual({ binding: 'RL', by: 'ip', countPreflight: false });
  });

  it('rejects an unknown rate limit key strategy', () => {
    expect(() =>
      defineConfig({
        // @ts-expect-error exercising runtime validation with an invalid value
        routes: [
          { match: { path: '/a' }, upstream: 'o.test', rateLimit: { binding: 'RL', by: 'header' } },
        ],
      }),
    ).toThrow();
  });

  it('rejects an empty binding name', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'o.test', rateLimit: { binding: '' } }],
      }),
    ).toThrow();
  });

  it('leaves guards undefined when not configured', () => {
    const route = defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test' }] })
      .routes[0]!;
    expect(route.cors).toBeUndefined();
    expect(route.ip).toBeUndefined();
    expect(route.rateLimit).toBeUndefined();
  });
});

describe('multiple upstream strategies', () => {
  it('keeps the ordered list and the failover policy', () => {
    const config = defineConfig({
      routes: [
        {
          match: { path: '/a' },
          upstreams: ['a.test', 'b.test'],
          failover: { on: ['timeout', 'unreachable'], maxAttempts: 2 },
        },
      ],
    });
    expect(config.routes[0]!.upstreams).toEqual(['a.test', 'b.test']);
    expect(config.routes[0]!.failover).toEqual({
      on: ['timeout', 'unreachable'],
      maxAttempts: 2,
    });
  });

  it('defaults the failover policy', () => {
    // timeout and unreachable are safe to switch on without an explicit opt-in;
    // 5xx is not, so it must stay out of the default set.
    const config = defineConfig({
      routes: [{ match: { path: '/a' }, upstreams: ['a.test', 'b.test'] }],
    });
    expect(config.routes[0]!.failover).toEqual({
      on: ['timeout', 'unreachable'],
      maxAttempts: 6,
    });
  });

  it('rejects two strategies on one route', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'a.test', upstreams: ['a.test', 'b.test'] }],
      }),
    ).toThrow(/exactly one of upstream, upstreams or trafficSplit/);
  });

  it('rejects a route that names no upstream at all', () => {
    // `upstream` became optional to admit the list and split forms; the
    // exclusivity check has to catch the zero case or an empty route parses.
    expect(() => defineConfig({ routes: [{ match: { path: '/a' } }] })).toThrow(
      /exactly one of upstream, upstreams or trafficSplit/,
    );
  });

  it('rejects failover without candidates', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'a.test', failover: {} }],
      }),
    ).toThrow(/failover requires upstreams or trafficSplit/);
  });

  it('rejects stickyBy without a split', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstreams: ['a.test', 'b.test'], stickyBy: 'cookie' }],
      }),
    ).toThrow(/stickyBy requires trafficSplit/);
  });

  it('accepts stickyBy on a split route', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            trafficSplit: [
              { upstream: 'a.test', weight: 95 },
              { upstream: 'b.test', weight: 5 },
            ],
            stickyBy: 'cookie',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects a split whose weights are not integers in range', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            trafficSplit: [
              { upstream: 'a.test', weight: 0 },
              { upstream: 'b.test', weight: 5 },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects a private upstream hidden in the second candidate', () => {
    // The array must be screened entry by entry: only checking the first would
    // let the second become a route around the SSRF refusal.
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstreams: ['a.test', '169.254.169.254'] }],
      }),
    ).toThrow();
  });

  it('rejects a private upstream hidden in a split entry', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            trafficSplit: [
              { upstream: 'a.test', weight: 1 },
              { upstream: '10.0.0.1', weight: 1 },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it('accepts a private-upstream list behind the explicit flag', () => {
    const config = defineConfig({
      routes: [
        {
          match: { path: '/a' },
          allowPrivateUpstream: true,
          upstreams: ['10.0.0.1', '192.168.1.1'],
        },
      ],
    });
    expect(config.routes[0]!.upstreams).toEqual(['10.0.0.1', '192.168.1.1']);
  });

  it('keeps the exclusivity check valid after defaults folding', () => {
    // The strategy checks run on the folded document, so folding must not leave
    // a single-upstream route looking like two strategies.
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'a.test' }],
        defaults: { retries: 2 },
      }),
    ).not.toThrow();
  });
});

describe('match conditions (headers / query / cookies)', () => {
  it('accepts every operator on every family, including an empty equals', () => {
    const config = defineConfig({
      routes: [
        {
          match: {
            path: '/a',
            headers: [
              { name: 'X-Env', equals: 'prod' },
              { name: 'X-Canary', present: true },
            ],
            query: [
              { name: 'debug', equals: '' },
              { name: 'v', prefix: '2' },
            ],
            cookies: [{ name: 'beta', present: false }],
          },
          upstream: 'o.test',
        },
      ],
    });
    const match = config.routes[0]!.match;
    expect(match.headers).toEqual([
      { name: 'x-env', equals: 'prod' },
      { name: 'x-canary', present: true },
    ]);
    expect(match.query).toEqual([
      { name: 'debug', equals: '' },
      { name: 'v', prefix: '2' },
    ]);
    expect(match.cookies).toEqual([{ name: 'beta', present: false }]);
  });

  it('lowercases header names but leaves query and cookie names alone', () => {
    // Header names are case-insensitive; query and cookie names are not, and
    // folding them would silently change what the route matches.
    const config = defineConfig({
      routes: [
        {
          match: {
            path: '/a',
            headers: [{ name: 'X-Env', present: true }],
            query: [{ name: 'Debug', present: true }],
            cookies: [{ name: 'Beta', present: true }],
          },
          upstream: 'o.test',
        },
      ],
    });
    const match = config.routes[0]!.match;
    expect(match.headers![0]!.name).toBe('x-env');
    expect(match.query![0]!.name).toBe('Debug');
    expect(match.cookies![0]!.name).toBe('Beta');
  });

  it('rejects a condition with no operator or more than one', () => {
    for (const operators of [
      {},
      { equals: 'a', prefix: 'b' },
      { equals: 'a', present: true },
      { prefix: 'b', present: false },
    ]) {
      expect(
        () =>
          defineConfig({
            routes: [
              // @ts-expect-error exercising runtime validation with invalid shapes
              {
                match: { path: '/a', headers: [{ name: 'x-env', ...operators }] },
                upstream: 'o.test',
              },
            ],
          }),
        JSON.stringify(operators),
      ).toThrow();
    }
  });

  it('rejects an empty prefix, which would be present:true spelled twice', () => {
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/a', headers: [{ name: 'x-env', prefix: '' }] }, upstream: 'o.test' },
        ],
      }),
    ).toThrow();
  });

  it('rejects invalid header, query and cookie names', () => {
    // Header and cookie names are RFC tokens; a query name may not carry the
    // characters a URL parser would read as separators.
    const cases: { family: string; name: string }[] = [
      { family: 'headers', name: 'x env' },
      { family: 'headers', name: '' },
      { family: 'cookies', name: 'be ta' },
      { family: 'query', name: 'a=b' },
      { family: 'query', name: 'a&b' },
      { family: 'query', name: 'a b' },
    ];
    for (const { family, name } of cases) {
      expect(
        () =>
          defineConfig({
            routes: [
              {
                match: { path: '/a', [family]: [{ name, equals: '' }] },
                upstream: 'o.test',
              },
            ],
          }),
        `${family} name ${JSON.stringify(name)}`,
      ).toThrow();
    }
  });

  it('caps conditions per family at 16', () => {
    const header = { name: 'x-a', equals: '1' };
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a', headers: Array.from({ length: 16 }, () => header) },
            upstream: 'o.test',
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a', headers: Array.from({ length: 17 }, () => header) },
            upstream: 'o.test',
          },
        ],
      }),
    ).toThrow();
  });

  it('does not fold value case: Prod and prod stay two values', () => {
    const config = defineConfig({
      routes: [
        { match: { path: '/a', headers: [{ name: 'x-env', equals: 'Prod' }] }, upstream: 'o.test' },
      ],
    });
    expect(config.routes[0]!.match.headers![0]!.equals).toBe('Prod');
  });
});
