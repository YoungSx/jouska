import { beforeEach, describe, expect, it } from 'vitest';
import { ledgerFor, resetOutlierLedgers } from '../../src/internal/outlier';

/**
 * The ledger is pure with respect to time: `now` is a parameter, so expiry is
 * tested by advancing a hand-held clock, not by sleeping.
 */
const now = 1_000_000;

const policy = { consecutiveFailures: 3, ejectSeconds: 30 } as const;

describe('outlier ledger', () => {
  beforeEach(() => {
    resetOutlierLedgers();
  });

  it('ejects only after the configured run of consecutive failures', () => {
    const ledger = ledgerFor('route', policy);
    ledger.recordFailure('a.test', now);
    ledger.recordFailure('a.test', now + 1);
    expect(ledger.isEjected('a.test', now + 2)).toBe(false);
    ledger.recordFailure('a.test', now + 3);
    expect(ledger.isEjected('a.test', now + 4)).toBe(true);
  });

  it('resets the count when a healthy answer arrives', () => {
    const ledger = ledgerFor('route', policy);
    ledger.recordFailure('a.test', now);
    ledger.recordFailure('a.test', now + 1);
    ledger.recordSuccess('a.test');
    ledger.recordFailure('a.test', now + 2);
    ledger.recordFailure('a.test', now + 3);
    expect(ledger.isEjected('a.test', now + 4)).toBe(false);
  });

  it('lifts the ejection when the window expires', () => {
    const ledger = ledgerFor('route', { consecutiveFailures: 3, ejectSeconds: 30 });
    ledger.recordFailure('a.test', now);
    ledger.recordFailure('a.test', now + 1);
    ledger.recordFailure('a.test', now + 2);
    expect(ledger.isEjected('a.test', now + 30_001)).toBe(true);
    // The window runs from the last failure, so it lifts at now + 30_002.
    expect(ledger.isEjected('a.test', now + 30_002)).toBe(false);
    // The expired entry is gone: the next failure starts a fresh count, and
    // one below the threshold means another look, not another ejection.
    ledger.recordFailure('a.test', now + 30_003);
    expect(ledger.isEjected('a.test', now + 30_004)).toBe(false);
  });

  it('keeps authorities and routes separate', () => {
    const ledger = ledgerFor('route', { consecutiveFailures: 2, ejectSeconds: 30 });
    ledger.recordFailure('a.test', now);
    // A different authority starts from zero.
    ledger.recordFailure('b.test', now);
    expect(ledger.isEjected('a.test', now + 1)).toBe(false);
    ledger.recordFailure('a.test', now + 1);
    expect(ledger.isEjected('a.test', now + 2)).toBe(true);
    expect(ledger.isEjected('b.test', now + 2)).toBe(false);
    // A different route key is a different ledger entirely.
    const other = ledgerFor('other-route', { consecutiveFailures: 2, ejectSeconds: 30 });
    other.recordFailure('a.test', now);
    expect(other.isEjected('a.test', now + 1)).toBe(false);
  });

  it('reuses the ledger for the same route key, and caps it at 256', () => {
    const again = ledgerFor('route', policy);
    again.recordFailure('a.test', now + 100);
    // Same key, same ledger: the earlier counts survived.
    expect(ledgerFor('route', policy).isEjected('a.test', now + 101)).toBe(false);

    const capped = ledgerFor('cap', { consecutiveFailures: 1, ejectSeconds: 30 });
    for (let i = 0; i < 256; i += 1) {
      capped.recordFailure(`h${i}.test`, now);
    }
    expect(capped.isEjected('h0.test', now + 1)).toBe(true);
    // The 257th evicts h0, the oldest.
    capped.recordFailure('h256.test', now + 1);
    expect(capped.isEjected('h0.test', now + 1)).toBe(false);
    expect(capped.isEjected('h256.test', now + 2)).toBe(true);
  });

  it('exposes a reset seam', () => {
    const ledger = ledgerFor('route', { consecutiveFailures: 1, ejectSeconds: 30 });
    ledger.recordFailure('a.test', now);
    expect(ledger.isEjected('a.test', now + 1)).toBe(true);
    resetOutlierLedgers();
    // The reset empties the registry, so the next request builds a fresh
    // ledger; a handle already held keeps its own copy, which is exactly the
    // "new isolate starts clean" behaviour the seam stands in for.
    const fresh = ledgerFor('route', { consecutiveFailures: 1, ejectSeconds: 30 });
    expect(fresh).not.toBe(ledger);
    expect(fresh.isEjected('a.test', now + 1)).toBe(false);
  });
});
