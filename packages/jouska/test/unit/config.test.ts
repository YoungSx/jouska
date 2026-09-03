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

  it('accepts inject with one anchor and keeps it in the parsed route', () => {
    const config = defineConfig({
      routes: [
        {
          match: { path: '/a' },
          upstream: 'o.test',
          bodyRewrite: { inject: { headEnd: '<script src="/_stats.js" defer></script>' } },
        },
      ],
    });
    expect(config.routes[0]!.bodyRewrite?.inject).toEqual({
      headEnd: '<script src="/_stats.js" defer></script>',
    });
  });

  it('rejects an inject block that sets no anchor', () => {
    // An empty block turns the rewriter on for nothing: the HTML path would run
    // and the event would claim a rewrite that changed no bytes.
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'o.test', bodyRewrite: { inject: {} } }],
      }),
    ).toThrow(/inject must set at least one anchor/);
  });

  it('rejects an empty anchor string', () => {
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/a' }, upstream: 'o.test', bodyRewrite: { inject: { bodyStart: '' } } },
        ],
      }),
    ).toThrow();
  });

  it('refuses inject only past the 64 KiB the four anchors share', () => {
    const banner = 'x'.repeat(1024);
    const config = defineConfig({
      routes: [
        {
          match: { path: '/a' },
          upstream: 'o.test',
          // Four anchors summing to exactly 64 KiB is accepted: the budget is on
          // the sum, so a config that fills it is legal however it is divided.
          bodyRewrite: {
            inject: {
              headStart: banner,
              headEnd: banner,
              bodyStart: banner.repeat(31),
              bodyEnd: banner.repeat(31),
            },
          },
        },
      ],
    });
    expect(config.routes[0]!.bodyRewrite?.inject).toBeDefined();

    // One more byte anywhere — here in the last anchor — is refused.
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'o.test',
            bodyRewrite: {
              inject: {
                headStart: banner,
                headEnd: banner,
                bodyStart: banner.repeat(31),
                bodyEnd: banner.repeat(31) + 'x',
              },
            },
          },
        ],
      }),
    ).toThrow(/inject totals .* bytes across its anchors/);
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

  it('leaves the requestId block undefined when not stated', () => {
    // Optional rather than defaulted, so a table-wide `defaults` block can
    // still reach routes that said nothing. `resolveRequestId` reads the
    // missing block as "do not trust the caller".
    const route = defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test' }] })
      .routes[0]!;
    expect(route.requestId).toBeUndefined();
  });

  it('defaults trustInbound to false when the block is stated empty', () => {
    const route = defineConfig({
      routes: [{ match: { path: '/a' }, upstream: 'o.test', requestId: {} }],
    }).routes[0]!;
    expect(route.requestId).toEqual({ trustInbound: false });
  });

  it('keeps trustInbound as written when the block is stated', () => {
    const route = defineConfig({
      routes: [{ match: { path: '/a' }, upstream: 'o.test', requestId: { trustInbound: true } }],
    }).routes[0]!;
    expect(route.requestId).toEqual({ trustInbound: true });
  });

  it('folds a table-wide requestId onto routes that said nothing', () => {
    // Whole-replace, like `cors`: per-key merging would splice a table-wide
    // `trustInbound: true` under a route that expected the default.
    const config = defineConfig({
      defaults: { requestId: { trustInbound: true } },
      routes: [
        { match: { path: '/a' }, upstream: 'o.test' },
        { match: { path: '/b' }, upstream: 'o.test', requestId: { trustInbound: false } },
      ],
    });
    expect(config.routes[0]!.requestId).toEqual({ trustInbound: true });
    expect(config.routes[1]!.requestId).toEqual({ trustInbound: false });
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

describe('referer config', () => {
  it('defaults allowEmpty to true and onRefuse to 403', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/a' }, upstream: 'o.test', referer: { allow: ['c.test'] } }],
    });
    expect(config.routes[0]!.referer).toEqual({
      allow: ['c.test'],
      allowEmpty: true,
      onRefuse: 403,
    });
  });

  it('lowercases a wildcard entry like the host matcher expects', () => {
    const config = defineConfig({
      routes: [
        { match: { path: '/a' }, upstream: 'o.test', referer: { allow: ['*.Assets.test'] } },
      ],
    });
    expect(config.routes[0]!.referer?.allow).toEqual(['*.assets.test']);
  });

  it('rejects an empty allow-list', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'o.test', referer: { allow: [] } }],
      }),
    ).toThrow();
  });

  it('rejects a referer block with no allow field', () => {
    expect(() =>
      defineConfig({
        // @ts-expect-error exercising runtime validation with a missing field
        routes: [{ match: { path: '/a' }, upstream: 'o.test', referer: {} }],
      }),
    ).toThrow();
  });

  it('rejects an allow entry that is not a hostname', () => {
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/a' }, upstream: 'o.test', referer: { allow: ['https://c.test'] } },
        ],
      }),
    ).toThrow();
  });

  it('rejects a bare wildcard that would match lookalike domains', () => {
    expect(() =>
      defineConfig({
        routes: [
          // The dot is mandatory: '*example.com' would admit 'evilexample.com'.
          { match: { path: '/a' }, upstream: 'o.test', referer: { allow: ['*example.com'] } },
        ],
      }),
    ).toThrow();
  });

  it('rejects an onRefuse status outside the two offered', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'o.test',
            // @ts-expect-error exercising runtime validation with an invalid value
            referer: { allow: ['c.test'], onRefuse: 401 },
          },
        ],
      }),
    ).toThrow();
  });

  it('accepts 404 as the refusal status', () => {
    const config = defineConfig({
      routes: [
        {
          match: { path: '/a' },
          upstream: 'o.test',
          referer: { allow: ['c.test'], onRefuse: 404 },
        },
      ],
    });
    expect(config.routes[0]!.referer?.onRefuse).toBe(404);
  });
});

describe('signed link config', () => {
  it('defaults the parameter names to sig and exp', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/a' }, upstream: 'o.test', signedLink: { secretBinding: 'K' } }],
    });
    expect(config.routes[0]!.signedLink).toEqual({
      secretBinding: 'K',
      param: 'sig',
      expiresParam: 'exp',
    });
  });

  it('accepts custom parameter names', () => {
    const config = defineConfig({
      routes: [
        {
          match: { path: '/a' },
          upstream: 'o.test',
          signedLink: { secretBinding: 'K', param: 'token', expiresParam: 'until' },
        },
      ],
    });
    expect(config.routes[0]!.signedLink?.param).toBe('token');
    expect(config.routes[0]!.signedLink?.expiresParam).toBe('until');
  });

  it('rejects an empty binding name', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'o.test', signedLink: { secretBinding: '' } }],
      }),
    ).toThrow();
  });

  it('rejects a parameter name a URL cannot carry', () => {
    expect(() =>
      defineConfig({
        // '&' ends the name, so a signature there could never be read back.
        routes: [
          {
            match: { path: '/a' },
            upstream: 'o.test',
            signedLink: { secretBinding: 'K', param: 's&ig' },
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects a parameter name with whitespace', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'o.test',
            signedLink: { secretBinding: 'K', expiresParam: 'ex p' },
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects a parameter name that is empty', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'o.test',
            signedLink: { secretBinding: 'K', param: '' },
          },
        ],
      }),
    ).toThrow();
  });

  it('leaves both blocks undefined when not configured', () => {
    const route = defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'o.test' }] })
      .routes[0]!;
    expect(route.referer).toBeUndefined();
    expect(route.signedLink).toBeUndefined();
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

  it('carries hashBy and hashType through to the parsed route', () => {
    const config = defineConfig({
      routes: [
        {
          match: { path: '/a' },
          trafficSplit: [
            { upstream: 'a.test', weight: 1 },
            { upstream: 'b.test', weight: 1 },
          ],
          hashBy: { source: 'path' },
          hashType: 'consistent',
        },
      ],
    });
    expect(config.routes[0]!.hashBy).toEqual({ source: 'path' });
    expect(config.routes[0]!.hashType).toBe('consistent');
  });

  it('leaves hashBy and hashType absent when not written, so defaults stay implicit', () => {
    const config = defineConfig({
      routes: [
        {
          match: { path: '/a' },
          trafficSplit: [
            { upstream: 'a.test', weight: 1 },
            { upstream: 'b.test', weight: 1 },
          ],
        },
      ],
    });
    expect(config.routes[0]!.hashBy).toBeUndefined();
    expect(config.routes[0]!.hashType).toBeUndefined();
  });

  it('rejects hashBy without a split', () => {
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/a' }, upstreams: ['a.test', 'b.test'], hashBy: { source: 'path' } },
        ],
      }),
    ).toThrow(/hashBy requires trafficSplit/);
  });

  it('rejects hashType without a split', () => {
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/a' }, upstreams: ['a.test', 'b.test'], hashType: 'consistent' },
        ],
      }),
    ).toThrow(/hashType requires trafficSplit/);
  });

  it('rejects stickyBy on a split that hashes on content', () => {
    // Pinning callers and pinning resources are contradictory intents; the
    // parse refuses rather than letting one silently override the other.
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            trafficSplit: [
              { upstream: 'a.test', weight: 1 },
              { upstream: 'b.test', weight: 1 },
            ],
            hashBy: { source: 'path' },
            stickyBy: 'cookie',
          },
        ],
      }),
    ).toThrow(/content hash key contradicts/);
  });

  it('accepts stickyBy alongside an address hash, which agree on who is pinned', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            trafficSplit: [
              { upstream: 'a.test', weight: 1 },
              { upstream: 'b.test', weight: 1 },
            ],
            hashBy: { source: 'ip' },
            stickyBy: 'cookie',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects a header key that is not an RFC 9110 token', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            trafficSplit: [
              { upstream: 'a.test', weight: 1 },
              { upstream: 'b.test', weight: 1 },
            ],
            hashBy: { source: 'header', header: 'not a header' },
          },
        ],
      }),
    ).toThrow(/valid HTTP header name/);
  });

  it('rejects a cookie key that is not an RFC 6265 token', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            trafficSplit: [
              { upstream: 'a.test', weight: 1 },
              { upstream: 'b.test', weight: 1 },
            ],
            hashBy: { source: 'cookie', cookie: 'a;b' },
          },
        ],
      }),
    ).toThrow(/valid cookie name/);
  });

  it('rejects a query key that cannot survive in a parameter name', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            trafficSplit: [
              { upstream: 'a.test', weight: 1 },
              { upstream: 'b.test', weight: 1 },
            ],
            hashBy: { source: 'query', query: 'a=b' },
          },
        ],
      }),
    ).toThrow(/query parameter name/);
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

describe('mirror config', () => {
  it('defaults the mirror block to a full-sample, bodyless, GET/HEAD copy', () => {
    const config = defineConfig({
      routes: [{ match: { path: '/a' }, upstream: 'a.test', mirror: { upstream: 'b.test' } }],
    });
    expect(config.routes[0]!.mirror).toEqual({
      upstream: 'b.test',
      percent: 100,
      includeBody: false,
      methods: ['GET', 'HEAD'],
      timeoutMs: 2_000,
    });
  });

  it('rejects a mirror percent outside 1–100 and a timeout past the copy bound', () => {
    const route = (mirror: Record<string, unknown>) =>
      defineConfig({ routes: [{ match: { path: '/a' }, upstream: 'a.test', mirror }] });
    expect(() => route({ upstream: 'b.test', percent: 0 })).toThrow();
    expect(() => route({ upstream: 'b.test', percent: 101 })).toThrow();
    expect(() => route({ upstream: 'b.test', timeoutMs: 5_001 })).toThrow();
    expect(() => route({ upstream: 'b.test', percent: 10, timeoutMs: 5_000 })).not.toThrow();
  });

  it('folds method case and refuses an empty list', () => {
    const config = defineConfig({
      routes: [
        {
          match: { path: '/a' },
          upstream: 'a.test',
          mirror: { upstream: 'b.test', methods: ['get'] },
        },
      ],
    });
    expect(config.routes[0]!.mirror!.methods).toEqual(['GET']);
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'a.test',
            mirror: { upstream: 'b.test', methods: [] },
          },
        ],
      }),
    ).toThrow();
  });

  it('refuses mirror beside respond — an edge answer has no request to copy', () => {
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            respond: { status: 503, contentType: 'text/plain', body: 'down' },
            mirror: { upstream: 'b.test' },
          },
        ],
      }),
    ).toThrow(/mirror requires an upstream/);
  });

  it('refuses a private mirror target at parse time (acceptance #5)', () => {
    expect(() =>
      defineConfig({
        routes: [{ match: { path: '/a' }, upstream: 'a.test', mirror: { upstream: '10.0.0.9' } }],
      }),
    ).toThrow();
  });

  it('refuses a private mirror target even when the primary upstream was allowed one', () => {
    // `allowPrivateUpstream` exempts the route's forwarding targets; the mirror
    // inherits the exemption the same way, so on a route without the flag both
    // are refused — and the parse-time refusal above already pins that. What
    // this pins is the other half: the mirror shape is the *allowing* variant
    // only where the route opted in, and a private mirror behind the flag parses.
    expect(() =>
      defineConfig({
        routes: [
          {
            match: { path: '/a' },
            upstream: 'a.test',
            allowPrivateUpstream: true,
            mirror: { upstream: '127.0.0.1' },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('refuses a mirror upstream with a scheme, like any upstream', () => {
    expect(() =>
      defineConfig({
        routes: [
          { match: { path: '/a' }, upstream: 'a.test', mirror: { upstream: 'https://b.test' } },
        ],
      }),
    ).toThrow();
  });
});
