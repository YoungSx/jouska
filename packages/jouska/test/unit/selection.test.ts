import { describe, expect, it } from 'vitest';
import type { Route } from '../../src/config';
import {
  inSample,
  STICKY_COOKIE,
  selectUpstream,
  stickyCookie,
} from '../../src/internal/selection';

const splitRoute = (weights: number[]): Route =>
  ({
    match: {},
    trafficSplit: weights.map((weight, i) => ({
      upstream: `${String.fromCharCode(97 + i)}.test`,
      weight,
    })),
  }) as unknown as Route;

const req = (headers: Record<string, string> = {}): Request =>
  new Request('https://p.dev/x', { headers });

/** A split route with a `hashBy` source and `hashType` set. */
const hashRoute = (hashBy: Route['hashBy'], weights: number[]): Route =>
  ({
    ...splitRoute(weights),
    hashBy,
    hashType: 'consistent',
  }) as unknown as Route;

/** A consistent-hashed split naming its candidates explicitly. */
const ringRoute = (upstreams: string[]): Route =>
  ({
    match: {},
    trafficSplit: upstreams.map((upstream) => ({ upstream, weight: 1 })),
    hashBy: { source: 'ip' },
    hashType: 'consistent',
  }) as unknown as Route;

describe('selectUpstream', () => {
  it('returns the only candidate for a non-split route', () => {
    const route = { match: {}, upstream: 'a.test' } as unknown as Route;
    expect(selectUpstream(route, req())).toEqual({ index: 0, reason: 'weighted', scope: 'none' });
  });

  it('is deterministic: the same IP always lands in the same bucket', () => {
    const route = splitRoute([1, 1, 1]);
    const first = selectUpstream(route, req({ 'cf-connecting-ip': '203.0.113.9' }));
    for (let i = 0; i < 10; i += 1) {
      expect(selectUpstream(route, req({ 'cf-connecting-ip': '203.0.113.9' })).index).toBe(
        first.index,
      );
    }
  });

  it('keeps the assignment stable across redeploys of the hash input', () => {
    // FNV-1a is spelled out precisely so this cannot drift: pin a known value.
    const index = selectUpstream(
      splitRoute([1, 1, 1]),
      req({ 'cf-connecting-ip': '198.51.100.4' }),
    ).index;
    expect(index).toBe(0);
  });

  it('honours weights: a 3:1 split draws roughly three to one', () => {
    const route = splitRoute([3, 1]);
    const counts = [0, 0];
    for (let i = 0; i < 4000; i += 1) {
      counts[
        selectUpstream(
          route,
          req({ 'cf-connecting-ip': `10.0.${Math.floor(i / 256)}.${i % 256}` }),
        )!.index
      ] += 1;
    }
    // Weights decide the share, not the order of visits; 4x over 4000 IPs is
    // far too many to plausibly land outside a 60/40 band for a 75/25 split.
    const share = counts[0]! / (counts[0]! + counts[1]!);
    expect(share).toBeGreaterThan(0.6);
    expect(share).toBeLessThan(0.9);
  });

  it('routes every IP-less caller to one bucket rather than a random one', () => {
    const route = splitRoute([1, 1]);
    const first = selectUpstream(route, req());
    for (let i = 0; i < 5; i += 1) {
      expect(selectUpstream(route, req()).index).toBe(first.index);
    }
  });

  it('returns a caller presenting a sticky cookie to its entry', () => {
    expect(selectUpstream(splitRoute([1, 1]), req({ cookie: `${STICKY_COOKIE}=b.test` }))).toEqual({
      index: 1,
      reason: 'sticky',
      scope: 'none',
    });
  });

  it('re-assigns a cookie naming an upstream the split no longer lists', () => {
    const route = splitRoute([1, 1]);
    const selection = selectUpstream(route, req({ cookie: `${STICKY_COOKIE}=retired.test` }));
    expect(selection.reason).toBe('weighted');
    expect([0, 1]).toContain(selection.index);
  });

  it('matches a sticky cookie by authority, ignoring a base path', () => {
    const route = {
      match: {},
      trafficSplit: [
        { upstream: 'a.test/v1', weight: 1 },
        { upstream: 'b.test', weight: 1 },
      ],
    } as unknown as Route;
    expect(selectUpstream(route, req({ cookie: `${STICKY_COOKIE}=a.test` })).index).toBe(0);
  });
});

describe('selectUpstream hash key (hashBy)', () => {
  it('hashes on the configured header and ignores the address', () => {
    const route = hashRoute({ source: 'header', header: 'x-tenant' }, [1, 1]);
    const onA = selectUpstream(
      route,
      req({ 'x-tenant': 'acme', 'cf-connecting-ip': '203.0.113.1' }),
    );
    // A different caller address with the same header value must land together:
    // the key is the tenant, not who is asking.
    const onAagain = selectUpstream(
      route,
      req({ 'x-tenant': 'acme', 'cf-connecting-ip': '198.51.100.9' }),
    );
    expect(onA.index).toBe(onAagain.index);
    expect(onA.scope).toBe('header');
  });

  it('falls back to the address when the header is absent, reported as ip', () => {
    const route = hashRoute({ source: 'header', header: 'x-tenant' }, [1, 1]);
    const selection = selectUpstream(route, req({ 'cf-connecting-ip': '203.0.113.7' }));
    expect(selection.scope).toBe('ip');
  });

  it('reads a cookie value through the same reader the sticky branch uses', () => {
    const route = hashRoute({ source: 'cookie', cookie: 'uid' }, [1, 1]);
    const selection = selectUpstream(route, req({ cookie: 'other=1; uid=acme' }));
    expect(selection.scope).toBe('cookie');
    expect(selection.index).toBe(selectUpstream(route, req({ cookie: 'uid=acme' })).index);
  });

  it('falls back to the address when the cookie is absent, reported as ip', () => {
    const route = hashRoute({ source: 'cookie', cookie: 'uid' }, [1, 1]);
    expect(selectUpstream(route, req({ 'cf-connecting-ip': '203.0.113.7' })).scope).toBe('ip');
  });

  it('treats a present-but-empty value as a value, not an absence', () => {
    const route = hashRoute({ source: 'header', header: 'x-tenant' }, [1, 1]);
    const empty = selectUpstream(route, req({ 'x-tenant': '', 'cf-connecting-ip': '203.0.113.1' }));
    expect(empty.scope).toBe('header');
    expect(empty.index).toBe(
      selectUpstream(route, req({ 'x-tenant': '', 'cf-connecting-ip': '198.51.100.1' })).index,
    );
  });

  it('hashes on the pathname for source: path', () => {
    const route = hashRoute({ source: 'path' }, [1, 1]);
    const one = selectUpstream(
      route,
      new Request('https://p.dev/assets/a.png', { headers: { 'cf-connecting-ip': '203.0.113.1' } }),
    );
    expect(one.scope).toBe('path');
    // The path decides, not the caller: the same URL from another address lands
    // together with this one.
    expect(one.index).toBe(
      selectUpstream(
        route,
        new Request('https://p.dev/assets/a.png', {
          headers: { 'cf-connecting-ip': '198.51.100.1' },
        }),
      ).index,
    );
    // And across a sweep of paths both candidates see traffic — two specific
    // paths are free to collide on a two-way split, so a spread is the
    // assertable claim.
    const hits = new Set(
      Array.from(
        { length: 20 },
        (_, i) =>
          selectUpstream(
            route,
            new Request(`https://p.dev/assets/${i}.png`, {
              headers: { 'cf-connecting-ip': '203.0.113.1' },
            }),
          ).index,
      ),
    );
    expect(hits.size).toBe(2);
  });

  it('hashes on the whole URL for source: url, so the query discriminates', () => {
    const route = hashRoute({ source: 'url' }, [1, 1]);
    const selection = selectUpstream(
      route,
      new Request('https://p.dev/x?tenant=acme', {
        headers: { 'cf-connecting-ip': '203.0.113.1' },
      }),
    );
    expect(selection.scope).toBe('url');
    expect(selection.index).toBe(
      selectUpstream(
        route,
        new Request('https://p.dev/x?tenant=acme', {
          headers: { 'cf-connecting-ip': '198.51.100.1' },
        }),
      ).index,
    );
  });

  it('reads a named query parameter for source: query', () => {
    const route = hashRoute({ source: 'query', query: 'tenant' }, [1, 1]);
    const selection = selectUpstream(
      route,
      new Request('https://p.dev/x?tenant=acme&other=z', {
        headers: { 'cf-connecting-ip': '203.0.113.1' },
      }),
    );
    expect(selection.scope).toBe('query');
    expect(selection.index).toBe(
      selectUpstream(
        route,
        new Request('https://p.dev/x?other=z&tenant=acme', {
          headers: { 'cf-connecting-ip': '198.51.100.1' },
        }),
      ).index,
    );
  });

  it('keeps the addressless bucket at scope none for the default key', () => {
    const route = splitRoute([1, 1]);
    expect(selectUpstream(route, req()).scope).toBe('none');
  });
});

describe('selectUpstream modulo mapping (the default, pinned)', () => {
  /** The original behaviour, spelled out so a refactor cannot drift past it. */
  const legacy = (routeId: string, weights: number[], key: string): number => {
    const hash = (input: string): number => {
      let h = 0x811c9dc5;
      for (let i = 0; i < input.length; i += 1) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return h >>> 0;
    };
    const total = weights.reduce((sum, w) => sum + w, 0);
    let bucket = hash(`${routeId} ${key}`) % total;
    for (let i = 0; i < weights.length; i += 1) {
      bucket -= weights[i]!;
      if (bucket < 0) {
        return i;
      }
    }
    throw new Error('unreachable');
  };

  it('matches the original modulo arithmetic bit for bit across a key sweep', () => {
    const route = splitRoute([3, 2, 1]);
    (route as unknown as { id: string }).id = 'canary';
    const keys: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      keys.push(`10.0.${Math.floor(i / 256)}.${i % 256}`);
    }
    keys.push(''); // the addressless caller
    for (const key of keys) {
      const request = key === '' ? req() : req({ 'cf-connecting-ip': key });
      expect(selectUpstream(route, request).index).toBe(legacy('canary', [3, 2, 1], key));
    }
  });

  it('is still modulo when hashType is named explicitly', () => {
    const route = { ...splitRoute([1, 1]), hashType: 'modulo' } as unknown as Route;
    (route as unknown as { id: string }).id = 'canary';
    expect(selectUpstream(route, req({ 'cf-connecting-ip': '198.51.100.4' })).index).toBe(
      legacy('canary', [1, 1], '198.51.100.4'),
    );
  });

  it('routes every IP-less caller to one bucket rather than a random one', () => {
    const route = splitRoute([1, 1]);
    const first = selectUpstream(route, req());
    for (let i = 0; i < 5; i += 1) {
      expect(selectUpstream(route, req()).index).toBe(first.index);
    }
  });
});

describe('selectUpstream consistent ring', () => {
  it('is deterministic and independent of the caller address for a content key', () => {
    const route = hashRoute({ source: 'header', header: 'x-tenant' }, [1, 1]);
    const first = selectUpstream(route, req({ 'x-tenant': 'acme' })).index;
    for (let i = 0; i < 10; i += 1) {
      expect(selectUpstream(route, req({ 'x-tenant': 'acme' })).index).toBe(first);
    }
  });

  it('re-assigns only the removed candidate’s share, fixed key set', () => {
    // The acceptance table: three equal candidates, remove the middle one, and
    // every key that was on a or c keeps its assignment. The surviving route
    // lists a and c — the ring is identified by authority, so dropping
    // `b.test` leaves a's and c's points untouched, and deleting the middle
    // *entry* must not re-derive the others' points from array position.
    const three = ringRoute(['a.test', 'b.test', 'c.test']);
    const two = ringRoute(['a.test', 'c.test']);
    const keys = Array.from({ length: 60 }, (_, i) => `203.0.113.${i}`);
    const before = keys.map((ip) => selectUpstream(three, req({ 'cf-connecting-ip': ip })).index);
    // Sanity: the table really spans all three candidates, or the assertion
    // below would be vacuous.
    expect(new Set(before).size).toBe(3);

    const after = keys.map((ip) => selectUpstream(two, req({ 'cf-connecting-ip': ip })).index);
    keys.forEach((_, i) => {
      if (before[i] === 1) {
        expect([0, 1]).toContain(after[i]);
      } else {
        expect(after[i]).toBe(before[i] === 0 ? 0 : 1);
      }
    });
  });

  it('tracks the declared weights approximately, not exactly', () => {
    // 160 virtual nodes per unit of weight gives a distribution that hovers
    // around the declared share without landing on it — this is an
    // approximation, and the bound here is the honest one.
    const route = hashRoute({ source: 'ip' }, [3, 1]);
    const counts = [0, 0];
    for (let i = 0; i < 4000; i += 1) {
      counts[
        selectUpstream(
          route,
          req({ 'cf-connecting-ip': `10.0.${Math.floor(i / 256)}.${i % 256}` }),
        )!.index
      ] += 1;
    }
    const share = counts[0]! / (counts[0]! + counts[1]!);
    expect(share).toBeGreaterThan(0.65);
    expect(share).toBeLessThan(0.85);
  });

  it('caches the ring on the route object and rebuilds on a new one', () => {
    const route = hashRoute({ source: 'ip' }, [1, 1]);
    const keys = Array.from({ length: 40 }, (_, i) => `203.0.113.${i}`);
    const first = keys.map((ip) => selectUpstream(route, req({ 'cf-connecting-ip': ip })).index);
    // Same object: identical results, no rebuild.
    const again = keys.map((ip) => selectUpstream(route, req({ 'cf-connecting-ip': ip })).index);
    expect(again).toEqual(first);
    // A fresh object with the same weights is a fresh ring build; same shape,
    // because the ring is a function of the split alone.
    const rebuilt = { ...route } as unknown as Route;
    const fresh = keys.map((ip) => selectUpstream(rebuilt, req({ 'cf-connecting-ip': ip })).index);
    expect(fresh).toEqual(first);
  });

  it('still honours the sticky cookie ahead of the ring', () => {
    const route = hashRoute({ source: 'path' }, [1, 1]);
    expect(
      selectUpstream(
        route,
        new Request('https://p.dev/x', { headers: { cookie: `${STICKY_COOKIE}=b.test` } }),
      ),
    ).toEqual({ index: 1, reason: 'sticky', scope: 'none' });
  });

  it('wraps keys hashing past the ring ceiling back to the first point', () => {
    // The ring covers [minPoint, maxPoint] only, and a key hashing above
    // maxPoint is a wrap-around key, not a member of the last point's arc.
    // Whether this ever bites depends on who owns the first and last points —
    // same owner makes the mistake invisible, which is exactly why the
    // ordinary test rings hide it. `n0.test`/`n4.test` is measured to end on
    // different owners (first point owned by entry 1, ceiling point by entry
    // 0), and `198.51.100.7240` is measured to hash above that ceiling —
    // both pinned here so the regression cannot drift back in.
    const route = ringRoute(['n0.test', 'n4.test']);
    const past = req({ 'cf-connecting-ip': '198.51.100.7240' });
    expect(selectUpstream(route, past)).toEqual({
      index: 1, // the first point's owner, not the ceiling's
      reason: 'weighted',
      scope: 'ip',
    });
    // And the ceiling's owner keeps its own arc: a key just *below* the
    // ceiling still belongs to the last point, which is what the wrap must
    // not steal from it.
    const justBelow = req({ 'cf-connecting-ip': '198.51.100.7239' });
    expect(selectUpstream(route, justBelow).index).not.toBe(1);
  });
});

describe('stickyCookie', () => {
  it('carries host-only attributes the rewriter has no reason to touch', () => {
    const cookie = stickyCookie('b.test');
    expect(cookie).toBe(`${STICKY_COOKIE}=b.test; Path=/; HttpOnly; SameSite=Lax`);
    expect(cookie).not.toContain('Domain');
  });
});

describe('inSample (mirror sampling)', () => {
  it('is deterministic: the same request ID samples the same way every time', () => {
    // The property mirroring inherits from the split hash: "why was this request
    // mirrored" is answerable from the request alone, after the fact.
    for (const id of ['req-a', 'req-b', 'req-c', 'req-d']) {
      expect(inSample(id, 25)).toBe(inSample(id, 25));
    }
  });

  it('puts 100 percent of everything in, and keeps the empty key in too', () => {
    for (const id of ['req-a', 'req-b', 'req-c', 'req-d', '']) {
      expect(inSample(id, 100)).toBe(true);
    }
  });

  it('admits a share that tracks the percent and never exceeds it', () => {
    // Not a distribution guarantee over four keys — the assertion is the
    // monotonicity: a wider sample contains the narrower one, because the
    // boundary moves one way through the hash space.
    for (const id of ['req-a', 'req-b', 'req-c', 'req-d']) {
      const decisions = [1, 10, 25, 50, 75, 99].map((percent) => inSample(id, percent));
      expect(decisions).toEqual(decisions.toSorted());
      expect(inSample(id, 1)).toBe(false);
    }
  });
});
