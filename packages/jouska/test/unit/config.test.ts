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

  it('accepts a retry count the walk could plausibly use', () => {
    // Bounded only because the plan is materialised as an array; `totalTimeoutMs`
    // is what actually ends the walk. nginx leaves the equivalent unbounded.
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'o.test', retries: 20, retryBackoffMs: 0 }],
      }),
    ).not.toThrow();
  });

  it('rejects a retry count past the size the plan is allocated at', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', retries: 101 }] }),
    ).toThrow();
  });

  it('accepts the timeouts a streamed upstream needs', () => {
    // A cold-starting upstream can take a minute to send headers; a reasoning
    // model can take five to send its first token; the answer itself is bounded
    // by silence between bytes, not by total duration.
    const config = defineConfig({
      routes: [
        {
          match: { path: '/v1' },
          upstream: 'o.test',
          timeoutMs: 60_000,
          totalTimeoutMs: 60_000,
          firstChunkTimeoutMs: 300_000,
          streamIdleTimeoutMs: 60_000,
        },
      ],
    });
    expect(config.routes[0]!.firstChunkTimeoutMs).toBe(300_000);
    expect(config.routes[0]!.streamIdleTimeoutMs).toBe(60_000);
  });

  it('defaults both body deadlines to a minute', () => {
    const config = defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test' }] });
    // The same figure nginx uses for `proxy_read_timeout`, measured the same way.
    expect(config.routes[0]!.firstChunkTimeoutMs).toBe(60_000);
    expect(config.routes[0]!.streamIdleTimeoutMs).toBe(60_000);
  });

  it('takes body deadlines from the defaults block', () => {
    const config = defineConfig({
      defaults: { firstChunkTimeoutMs: 120_000, streamIdleTimeoutMs: 30_000 },
      routes: [
        { match: { path: '/a' }, upstream: 'o.test' },
        { match: { path: '/b' }, upstream: 'o.test', streamIdleTimeoutMs: 5_000 },
      ],
    });
    expect(config.routes[0]!.firstChunkTimeoutMs).toBe(120_000);
    expect(config.routes[0]!.streamIdleTimeoutMs).toBe(30_000);
    expect(config.routes[1]!.streamIdleTimeoutMs).toBe(5_000);
  });

  it('accepts a traffic split wider than six buckets', () => {
    // A split picks one candidate and never walks, so it has no multi-attempt
    // worst case that a bound of six was protecting.
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            trafficSplit: Array.from({ length: 8 }, (_, i) => ({
              upstream: `v${i}.test`,
              weight: 1,
            })),
          },
        ],
      }),
    ).not.toThrow();
  });

  it('accepts more failover candidates than the platform connection cap', () => {
    // The walk is sequential, so the six-concurrent-connection limit never
    // applied to it.
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstreams: Array.from({ length: 10 }, (_, i) => `u${i}.test`),
          },
        ],
      }),
    ).not.toThrow();
  });

  it('accepts a year-long cache lifetime', () => {
    // The lifetime immutable assets already use. The route fingerprint is in the
    // key, so no lifetime can serve another configuration's bytes.
    const config = defineConfig({
      routes: [
        {
          match: { path: '/static' },
          upstream: 'o.test',
          cache: { ttlSeconds: 31_536_000, staleWhileRevalidateSeconds: 604_800 },
        },
      ],
    });
    expect(config.routes[0]!.cache?.ttlSeconds).toBe(31_536_000);
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

  it('rejects an access block guarding nothing', () => {
    expect(() =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test', access: {} }] }),
    ).toThrow();
  });

  it('rejects an access key that is not a 64-character hex digest', () => {
    expect(() =>
      defineConfig({
        // A raw key must never reach the config — only its SHA-256 digest does.
        routes: [{ match: { path: '/a' }, upstream: 'o.test', access: { keys: ['hunter2'] } }],
      }),
    ).toThrow();
  });

  it('rejects a Cloudflare Access team name that could not be a subdomain', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'o.test',
            access: { cloudflare: { team: '../evil', audience: 'app' } },
          },
        ],
      }),
    ).toThrow();
  });

  it('requires an audience when Cloudflare Access is configured', () => {
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/a' }, upstream: 'o.test', access: { cloudflare: { team: 'acme' } } },
        ],
      }),
    ).toThrow();
  });

  it('leaves guards undefined when not configured', () => {
    const route = defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test' }] })
      .routes[0]!;
    expect(route.cors).toBeUndefined();
    expect(route.ip).toBeUndefined();
    expect(route.rateLimit).toBeUndefined();
    expect(route.access).toBeUndefined();
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
      // Every candidate the route declares; clamped to the list's length at walk
      // time, so the number is a ceiling rather than a count of attempts.
      maxAttempts: 64,
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

  it('rejects outlier without candidates', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'a.test', outlier: {} }],
      }),
    ).toThrow(/outlier requires upstreams or trafficSplit/);
  });

  it('defaults the outlier policy on a candidate route', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/a' }, upstreams: ['a.test', 'b.test'] }],
    });
    expect(config.routes[0]!.outlier).toEqual({ consecutiveFailures: 3, ejectSeconds: 30 });
  });

  it('leaves outlier absent on a single-upstream route and out of defaults', () => {
    const config = defineConfig({
      routes: [
        { match: { path: '/a' }, upstream: 'a.test' },
        { match: { path: '/b' }, upstreams: ['a.test', 'b.test'], outlier: { ejectSeconds: 5 } },
      ],
    });
    expect(config.routes[0]!.outlier).toBeUndefined();
    // A partial policy keeps the caller's value and folds in the rest.
    expect(config.routes[1]!.outlier).toEqual({ consecutiveFailures: 3, ejectSeconds: 5 });
    expect(config.defaults?.outlier).toBeUndefined();
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
});

describe('access control config', () => {
  it('refuses forwardAuth without a url', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'a.test',
            // @ts-expect-error exercising runtime validation with an invalid value
            forwardAuth: {},
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    ['http://localhost:8080/auth'],
    ['https://127.0.0.1/auth'],
    ['http://169.254.169.254/metadata'],
    ['http://10.0.0.5/auth'],
    ['https://192.168.1.1/auth'],
  ])('refuses the auth url %s', (url) => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'a.test', forwardAuth: { url } }],
      }),
    ).toThrow();
  });

  it('refuses a forwardAuth url that is not a parseable http url', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'a.test',
            forwardAuth: { url: 'not-a-url' },
          },
        ],
      }),
    ).toThrow();
  });

  it('refuses a forwardAuth url with a non-http scheme', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'a.test',
            forwardAuth: { url: 'ftp://auth.test/check' },
          },
        ],
      }),
    ).toThrow();
  });

  it('permits a private auth url on a route that opted into private upstreams', () => {
    const config = defineConfig({
      routes: [
        {
          match: { path: '/a' },
          upstream: '10.0.0.5',
          allowPrivateUpstream: true,
          forwardAuth: { url: 'http://10.0.0.5:8080/auth' },
        },
      ],
    });
    expect(config.routes[0]!.forwardAuth!.url).toBe('http://10.0.0.5:8080/auth');
  });

  it('refuses a reserved name in copyRequestHeaders', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'a.test',
            forwardAuth: {
              url: 'https://auth.test/check',
              copyRequestHeaders: ['host'],
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('refuses a reserved name in copyResponseHeaders', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'a.test',
            forwardAuth: {
              url: 'https://auth.test/check',
              copyResponseHeaders: ['x-forwarded-for'],
            },
          },
        ],
      }),
    ).toThrow();
  });

  it('defaults the forward auth exchange fields and leaves failOpen closed', () => {
    const config = defineConfig({
      routes: [
        {
          match: { path: '/a' },
          upstream: 'a.test',
          forwardAuth: { url: 'https://auth.test/check' },
        },
      ],
    });
    expect(config.routes[0]!.forwardAuth).toEqual({
      url: 'https://auth.test/check',
      copyRequestHeaders: ['authorization', 'cookie'],
      copyResponseHeaders: [],
      timeoutMs: 2000,
    });
    expect(config.routes[0]!.forwardAuth!.failOpen).toBeUndefined();
  });

  it('keeps an explicit failOpen', () => {
    const config = defineConfig({
      routes: [
        {
          match: { path: '/a' },
          upstream: 'a.test',
          forwardAuth: { url: 'https://auth.test/check', failOpen: true },
        },
      ],
    });
    expect(config.routes[0]!.forwardAuth!.failOpen).toBe(true);
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

  it('caps conditions per family at the shared list bound', () => {
    const header = { name: 'x-a', equals: '1' };
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a', headers: Array.from({ length: 64 }, () => header) },
            upstream: 'o.test',
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a', headers: Array.from({ length: 65 }, () => header) },
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

describe('access control config (cache cross-check)', () => {
  it('refuses cache alongside delegated auth', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'a.test',
            cache: { enabled: true },
            forwardAuth: { url: 'https://auth.test/check' },
          },
        ],
      }),
    ).toThrow(/cache is refused/);
  });

  it('folds a table-wide forwardAuth into routes that state none', () => {
    const config = defineConfig({
      defaults: { forwardAuth: { url: 'https://auth.test/check' } },
      routes: [{ match: { path: '/a' }, upstream: 'a.test' }],
    });
    expect(config.routes[0]!.forwardAuth!.url).toBe('https://auth.test/check');
  });

  it('replaces the table-wide forwardAuth whole when a route states its own', () => {
    // Auth blocks are not in the per-key merge set, so a route's own block
    // starts from scratch — a table-level failOpen or timeout must not leak
    // into a route that declared its own exchange.
    const config = defineConfig({
      defaults: {
        forwardAuth: { url: 'https://auth.test/check', timeoutMs: 5000, failOpen: true },
      },
      routes: [
        {
          match: { path: '/a' },
          upstream: 'a.test',
          forwardAuth: { url: 'https://route.test/auth' },
        },
      ],
    });
    expect(config.routes[0]!.forwardAuth).toEqual({
      url: 'https://route.test/auth',
      copyRequestHeaders: ['authorization', 'cookie'],
      copyResponseHeaders: [],
      timeoutMs: 2000,
    });
  });

  it('refuses a cached route once the table-wide forwardAuth folds onto it', () => {
    expect(() =>
      defineConfig({
        defaults: { forwardAuth: { url: 'https://auth.test/check' } },
        routes: [{ match: { path: '/a' }, upstream: 'a.test', cache: { enabled: true } }],
      }),
    ).toThrow(/cache is refused/);
  });
});
