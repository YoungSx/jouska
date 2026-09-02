import { describe, expect, it } from 'vitest';
import type { Route } from '../../src/config';
import { STICKY_COOKIE, selectUpstream, stickyCookie } from '../../src/internal/selection';

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

describe('stickyCookie', () => {
  it('carries host-only attributes the rewriter has no reason to touch', () => {
    const cookie = stickyCookie('b.test');
    expect(cookie).toBe(`${STICKY_COOKIE}=b.test; Path=/; HttpOnly; SameSite=Lax`);
    expect(cookie).not.toContain('Domain');
  });
});
