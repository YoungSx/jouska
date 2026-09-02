import type { Route } from '../config.js';

/** The outlier policy a candidate route carries. */
export type OutlierPolicy = NonNullable<Route['outlier']>;

/**
 * Failure counts and ejection windows, per authority, per isolate.
 *
 * The entry is the whole memory the walk has of an upstream: how many counted
 * failures it has in a row, and — once ejected — the wall-clock time it comes
 * back. Nothing here outlives the isolate, which is the deliberate
 * approximation (see the config field's documentation).
 */
interface Entry {
  failures: number;
  /** Epoch ms after which the ejection lifts. 0 while not ejected. */
  until: number;
}

/**
 * The ledger one route keeps. Pure with respect to time: `now` is passed in by
 * the caller, so expiry is testable without a fake clock.
 */
export interface OutlierLedger {
  isEjected(authority: string, now: number): boolean;
  recordFailure(authority: string, now: number): void;
  /** A response under 500 is the only accepted evidence of health. */
  recordSuccess(authority: string, now: number): void;
}

/** Per-route ledgers, per isolate. One entry per candidate route's id. */
const ledgers = new Map<string, OutlierLedger>();

/**
 * Ceiling on one ledger's size.
 *
 * The authorities a ledger can name are bounded by its route's config in
 * practice, but the config is runtime-editable through KV, and a route that
 * churns through distinct hosts (a mirror pointing at ephemeral origins) would
 * otherwise grow its ledger without limit. Evicting the oldest entry on
 * overflow keeps the memory flat; at worst a evicted count restarts from zero,
 * which is one extra timeout for one request.
 */
const MAX_ENTRIES = 256;

const createLedger = (policy: OutlierPolicy): OutlierLedger => {
  const entries = new Map<string, Entry>();
  return {
    isEjected(authority, now) {
      const entry = entries.get(authority);
      if (entry === undefined) {
        return false;
      }
      if (entry.until === 0) {
        return false;
      }
      if (now >= entry.until) {
        // The window has passed: the count served its purpose and a fresh one
        // starts from zero, so one good request — or even one more counted
        // failure — is what the next judgement is based on.
        entries.delete(authority);
        return false;
      }
      return true;
    },
    recordFailure(authority, now) {
      const entry = entries.get(authority);
      // An entry whose ejection window has passed is stale — its failures were
      // already punished — so the count restarts from one. An active entry,
      // whether still counting up or mid-ejection, extends the run.
      const stale = entry !== undefined && entry.until !== 0 && entry.until <= now;
      const failures = entry === undefined || stale ? 1 : entry.failures + 1;
      if (failures >= policy.consecutiveFailures) {
        entries.set(authority, { failures, until: now + policy.ejectSeconds * 1000 });
      } else {
        entries.set(authority, { failures, until: 0 });
      }
      if (entries.size > MAX_ENTRIES) {
        // Map iteration is insertion order, so the first key is the oldest.
        entries.delete(entries.keys().next().value!);
      }
    },
    recordSuccess(authority) {
      entries.delete(authority);
    },
  };
};

/**
 * The ledger for one candidate route, created on first use and reused for
 * every request after — the memory the ejection exists to provide. `routeKey`
 * must already be unique per route: the id the router derives, not the config
 * field, since routes without an `id` are distinct routes all the same.
 */
export const ledgerFor = (routeKey: string, policy: OutlierPolicy): OutlierLedger => {
  let ledger = ledgers.get(routeKey);
  if (ledger === undefined) {
    ledger = createLedger(policy);
    ledgers.set(routeKey, ledger);
  }
  return ledger;
};

/** Clears every ledger. A test seam; the runtime never has a reason to call it. */
export const resetOutlierLedgers = (): void => {
  ledgers.clear();
};

/**
 * What one request needs from the ejection memory: which candidates are out,
 * and the notifications the walk sends as it goes.
 *
 * The failure notifications are forwarded unconditionally by the caller —
 * forward has already classified the failure and knows whether the policy
 * counted it — so the observer itself holds no policy and cannot drift from
 * the walk's own rules.
 */
export interface OutlierObserver {
  isEjected(authority: string): boolean;
  onFailure(authority: string): void;
  onSuccess(authority: string): void;
  /** The authorities this request skipped, for the `ProxyEvent`. */
  ejected(): string[];
}

/**
 * Builds the per-request observer over a route's ledger.
 *
 * `skipped` is recorded at read time — when the walk filters its plan — rather
 * than derived after the fact, so the event reports exactly the candidates
 * this request declined to try, even when the walk then throws.
 */
export const outlierObserver = (ledger: OutlierLedger, now: () => number = Date.now) => {
  const skipped: string[] = [];
  return {
    isEjected(authority: string): boolean {
      const out = ledger.isEjected(authority, now());
      if (out) {
        skipped.push(authority);
      }
      return out;
    },
    onFailure(authority: string): void {
      ledger.recordFailure(authority, now());
    },
    onSuccess(authority: string): void {
      ledger.recordSuccess(authority, now());
    },
    ejected: (): string[] => skipped,
  } satisfies OutlierObserver;
};
