import { beforeEach, describe, expect, it } from 'vitest';
import {
  limitsFor,
  limitsObserver,
  resetLimitsLedgers,
  type LimitsLedger,
} from '../../src/internal/limits';

/**
 * The ledger is pure with respect to time: `now` is a parameter, so the
 * counting buckets rotate by advancing a hand-held clock, not by sleeping.
 */
const now = 1_000_000;

const budget = (retryRatio: number): LimitsLedger =>
  limitsFor(`budget-${retryRatio}`, { retryRatio });

describe('retry budget', () => {
  beforeEach(() => {
    resetLimitsLedgers();
  });

  it('allows retries while the window holds no evidence', () => {
    const ledger = budget(0.2);
    expect(ledger.retryAllowed(now)).toBe(true);
    // One request that never retried says nothing about whether the next one
    // may: a cold isolate always gets its retries.
    ledger.recordRequest(now);
    expect(ledger.retryAllowed(now)).toBe(true);
  });

  it('denies retries once they exceed the configured share', () => {
    const ledger = budget(0.2);
    for (let i = 0; i < 10; i += 1) {
      ledger.recordRequest(now);
    }
    // 2 of 10 is exactly the limit — the operator's stated tolerance, not a
    // breach of it.
    ledger.recordRetry(now);
    ledger.recordRetry(now);
    expect(ledger.retryAllowed(now)).toBe(true);
    ledger.recordRetry(now);
    expect(ledger.retryAllowed(now)).toBe(false);
  });

  it('lets the first retry of a window through even at a zero ratio', () => {
    const ledger = budget(0);
    ledger.recordRequest(now);
    // The budget counts retries performed, and none has been yet — the verdict
    // is asked before the retry it governs exists to be counted. A zero ratio
    // therefore lets one retry per window through and reads the next as a
    // breach; the direction of that imprecision is more retries, never fewer.
    expect(ledger.retryAllowed(now)).toBe(true);
    ledger.recordRetry(now);
    expect(ledger.retryAllowed(now)).toBe(false);
  });

  it('leaves retries unbounded when no ratio is configured', () => {
    const ledger = limitsFor('unbounded', { maxInFlight: 5 });
    for (let i = 0; i < 100; i += 1) {
      ledger.recordRetry(now);
    }
    expect(ledger.retryAllowed(now)).toBe(true);
  });

  it('recovers when the window drains', () => {
    const ledger = budget(0.2);
    for (let i = 0; i < 10; i += 1) {
      ledger.recordRequest(now);
    }
    for (let i = 0; i < 5; i += 1) {
      ledger.recordRetry(now);
    }
    expect(ledger.retryAllowed(now)).toBe(false);
    // One bucket later, the spent bucket is the only history left — and it is
    // still dense enough to keep the budget shut.
    expect(ledger.retryAllowed(now + 1_500)).toBe(false);
    // Two buckets later, everything the window holds is silence.
    expect(ledger.retryAllowed(now + 2_500)).toBe(true);
  });

  it('forgets a window closed longer than two buckets ago', () => {
    const ledger = budget(0.2);
    for (let i = 0; i < 10; i += 1) {
      ledger.recordRequest(now);
    }
    for (let i = 0; i < 5; i += 1) {
      ledger.recordRetry(now);
    }
    // An idle gap long enough that nothing recent is left must not let the old
    // burst hold the budget shut for requests arriving now.
    expect(ledger.retryAllowed(now + 3_000)).toBe(true);
  });

  it('carries the previous bucket so the ratio reads over both', () => {
    const ledger = budget(0.5);
    // Window one: 10 requests, 4 retries — inside the budget.
    for (let i = 0; i < 10; i += 1) {
      ledger.recordRequest(now);
    }
    for (let i = 0; i < 4; i += 1) {
      ledger.recordRetry(now);
    }
    // Window two: 2 requests, 2 retries. Alone that is 100%; over the two
    // windows together it is 6 of 12 — exactly half, which the limit admits.
    ledger.recordRequest(now + 1_100);
    ledger.recordRequest(now + 1_100);
    expect(ledger.retryAllowed(now + 1_100)).toBe(true);
    ledger.recordRetry(now + 1_100);
    expect(ledger.retryAllowed(now + 1_100)).toBe(true);
    ledger.recordRetry(now + 1_100);
    expect(ledger.retryAllowed(now + 1_100)).toBe(true);
    // A seventh retry would be 7 of 12 — over half — and is refused.
    ledger.recordRetry(now + 1_100);
    expect(ledger.retryAllowed(now + 1_100)).toBe(false);
  });
});

describe('in-flight fuse', () => {
  beforeEach(() => {
    resetLimitsLedgers();
  });

  it('admits up to the limit and refuses past it', () => {
    const ledger = limitsFor('fuse', { maxInFlight: 2 });
    expect(ledger.tryEnter('o.test')).toBe(true);
    expect(ledger.tryEnter('o.test')).toBe(true);
    expect(ledger.tryEnter('o.test')).toBe(false);
  });

  it('returns the seat when a request leaves', () => {
    const ledger = limitsFor('fuse-return', { maxInFlight: 1 });
    expect(ledger.tryEnter('o.test')).toBe(true);
    expect(ledger.tryEnter('o.test')).toBe(false);
    ledger.leave('o.test');
    expect(ledger.tryEnter('o.test')).toBe(true);
  });

  it('never counts below zero', () => {
    const ledger = limitsFor('fuse-floor', { maxInFlight: 1 });
    ledger.leave('o.test');
    ledger.leave('o.test');
    expect(ledger.tryEnter('o.test')).toBe(true);
    expect(ledger.tryEnter('o.test')).toBe(false);
  });

  it('keeps authorities separate', () => {
    const ledger = limitsFor('fuse-hosts', { maxInFlight: 1 });
    expect(ledger.tryEnter('a.test')).toBe(true);
    expect(ledger.tryEnter('b.test')).toBe(true);
    expect(ledger.tryEnter('a.test')).toBe(false);
  });

  it('is a no-op when no limit is configured', () => {
    const ledger = limitsFor('fuse-off', { retryRatio: 0.5 });
    for (let i = 0; i < 10; i += 1) {
      expect(ledger.tryEnter('o.test')).toBe(true);
    }
    ledger.leave('o.test');
  });

  it('caps its map at 256 authorities, undercounting rather than leaking', () => {
    const ledger = limitsFor('fuse-cap', { maxInFlight: 1 });
    for (let i = 0; i < 256; i += 1) {
      expect(ledger.tryEnter(`h${i}.test`)).toBe(true);
    }
    // The 257th authority evicts the oldest seat, so the fuse opens for h0 —
    // degraded protection, never a leak.
    expect(ledger.tryEnter('new.test')).toBe(true);
    expect(ledger.tryEnter('h0.test')).toBe(true);
  });
});

describe('per-request observer', () => {
  beforeEach(() => {
    resetLimitsLedgers();
  });

  it('remembers the verdict it gave, for the ProxyEvent', () => {
    const observer = limitsObserver(budget(0.2));
    observer.onRequest();
    expect(observer.retryDenied()).toBe(false);
    for (let i = 0; i < 10; i += 1) {
      observer.onRequest();
    }
    for (let i = 0; i < 3; i += 1) {
      expect(observer.retryAllowed()).toBe(true);
      observer.onRetry();
    }
    expect(observer.retryAllowed()).toBe(false);
    expect(observer.retryDenied()).toBe(true);
  });

  it('binds the seat it took, so leave needs no authority', () => {
    const ledger = limitsFor('observer-seat', { maxInFlight: 1 });
    const observer = limitsObserver(ledger);
    expect(observer.tryEnter('o.test')).toBe(true);
    expect(observer.tryEnter('o.test')).toBe(false);
    observer.leave();
    // A second leave is harmless — one finally clause may run on paths that
    // never took a seat.
    observer.leave();
    expect(ledger.tryEnter('o.test')).toBe(true);
  });

  it('leaves nothing behind when the seat was refused', () => {
    const ledger = limitsFor('observer-refused', { maxInFlight: 1 });
    expect(ledger.tryEnter('o.test')).toBe(true);
    const refused = limitsObserver(ledger);
    expect(refused.tryEnter('o.test')).toBe(false);
    refused.leave();
    // The refusal must not have returned a seat it never held.
    expect(ledger.tryEnter('o.test')).toBe(false);
  });

  it('reuses the ledger for the same route key', () => {
    const first = limitsObserver(limitsFor('route-shared', { retryRatio: 0.2 }));
    first.onRequest();
    const second = limitsObserver(limitsFor('route-shared', { retryRatio: 0.2 }));
    second.onRequest();
    // Both observers see one shared window of two requests, so a retry is half
    // of it — at the limit, allowed; another one breaches it.
    expect(second.retryAllowed()).toBe(true);
    second.onRetry();
    expect(second.retryAllowed()).toBe(false);
  });

  it('exposes a reset seam', () => {
    const ledger = limitsFor('route-reset', { maxInFlight: 1 });
    expect(ledger.tryEnter('o.test')).toBe(true);
    resetLimitsLedgers();
    const fresh = limitsFor('route-reset', { maxInFlight: 1 });
    expect(fresh).not.toBe(ledger);
    expect(fresh.tryEnter('o.test')).toBe(true);
  });
});
