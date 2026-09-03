import type { Route } from '../config.js';

/** The limits policy a candidate route carries. */
export type LimitsPolicy = NonNullable<Route['limits']>;

/**
 * How long one counting bucket stays open.
 *
 * Two buckets are kept — the one being written and the one just closed — so the
 * retry ratio reads over roughly the last two seconds. Buckets rather than a
 * sliding window of timestamps: the memory cost is four numbers whatever the
 * traffic, and the CPU cost is one comparison per request. A window array would
 * put a growing allocation and a scan on the hot path instead, and CPU is the
 * half of Workers metering the proxy cannot amortise.
 */
const BUCKET_MS = 1_000;

/** Ceiling on the in-flight map. The same bound the outlier ledger uses, for
 * the same reason: the authorities a route can name are bounded by its config
 * in practice, but the config is runtime-editable through KV, and a route
 * churned through distinct hosts would otherwise grow the map without limit.
 * Evicting the oldest entry undercounts the fuse — it opens less, never leaks —
 * which is the safe direction for availability.
 */
const MAX_ENTRIES = 256;

/** Both counters one bucket accumulates. */
interface Bucket {
  /** Proxied requests seen. */
  total: number;
  /** Retries actually performed. */
  retries: number;
}

const emptyBucket = (): Bucket => ({ total: 0, retries: 0 });

/** Everything one route's ledger remembers, per isolate. */
interface Entry {
  current: Bucket;
  previous: Bucket;
  /** When `current` opened. */
  openedAt: number;
  /** In-flight seats, per authority. */
  inFlight: Map<string, number>;
}

/**
 * The ledger one route keeps. Pure with respect to time: `now` is passed in by
 * the caller, so the buckets rotate in tests without a fake clock or a sleep.
 */
export interface LimitsLedger {
  /** True when a walk may still make one more attempt at an upstream it has tried. */
  retryAllowed(now: number): boolean;
  /** Counts one proxied request. */
  recordRequest(now: number): void;
  /** Counts one retry actually performed. */
  recordRetry(now: number): void;
  /**
   * Takes an in-flight seat on `authority`, up to the policy's `maxInFlight`.
   * False — and nothing taken — when the fuse is full.
   */
  tryEnter(authority: string): boolean;
  /** Returns a seat `tryEnter` took. A seat that was never taken is a no-op. */
  leave(authority: string): void;
}

/** Per-route ledgers, per isolate. One entry per candidate route's id. */
const ledgers = new Map<string, LimitsLedger>();

const createLedger = (policy: LimitsPolicy): LimitsLedger => {
  const entry: Entry = {
    current: emptyBucket(),
    previous: emptyBucket(),
    openedAt: 0,
    inFlight: new Map(),
  };

  const rotate = (now: number): void => {
    // A clock that has not reached the next bucket yet, or one that went
    // backwards, leaves the buckets exactly as they are.
    if (now < entry.openedAt + BUCKET_MS) {
      return;
    }
    // The just-closed bucket is carried as the previous one — but only when it
    // closed recently. A gap longer than two buckets means nothing was seen for
    // a while, and carrying that silence would let an old burst hold the budget
    // shut for requests arriving now.
    entry.previous = now < entry.openedAt + 2 * BUCKET_MS ? entry.current : emptyBucket();
    entry.current = emptyBucket();
    entry.openedAt = now;
  };

  return {
    retryAllowed(now) {
      const { retryRatio } = policy;
      if (retryRatio === undefined) {
        return true;
      }
      rotate(now);
      const total = entry.current.total + entry.previous.total;
      // Nothing seen yet is nothing spent: the first requests of a cold isolate
      // always get their retries.
      if (total === 0) {
        return true;
      }
      const retries = entry.current.retries + entry.previous.retries;
      // "Exceeds", not "meets": a ratio sitting exactly on the limit is the
      // operator's stated tolerance, not a breach of it.
      return retries / total <= retryRatio;
    },
    recordRequest(now) {
      rotate(now);
      entry.current.total += 1;
    },
    recordRetry(now) {
      rotate(now);
      entry.current.retries += 1;
    },
    tryEnter(authority) {
      const { maxInFlight } = policy;
      if (maxInFlight === undefined) {
        return true;
      }
      const taken = entry.inFlight.get(authority) ?? 0;
      if (taken >= maxInFlight) {
        return false;
      }
      entry.inFlight.set(authority, taken + 1);
      if (entry.inFlight.size > MAX_ENTRIES) {
        // Map iteration is insertion order, so the first key is the oldest.
        entry.inFlight.delete(entry.inFlight.keys().next().value!);
      }
      return true;
    },
    leave(authority) {
      const taken = entry.inFlight.get(authority) ?? 0;
      if (taken <= 1) {
        entry.inFlight.delete(authority);
      } else {
        entry.inFlight.set(authority, taken - 1);
      }
    },
  };
};

/**
 * The ledger for one candidate route, created on first use and reused for every
 * request after — the memory the fuses exist to provide. `routeKey` must
 * already be unique per route: the id the router derives, not the config field.
 *
 * Each route holds its own counts, so two routes naming the same origin hold
 * two fuses over it. That is the same per-isolate, per-route approximation the
 * outlier ledger makes, and it is what keeps the bookkeeping to one map lookup
 * per request.
 */
export const limitsFor = (routeKey: string, policy: LimitsPolicy): LimitsLedger => {
  let ledger = ledgers.get(routeKey);
  if (ledger === undefined) {
    ledger = createLedger(policy);
    ledgers.set(routeKey, ledger);
  }
  return ledger;
};

/** Clears every ledger. A test seam; the runtime never has a reason to call it. */
export const resetLimitsLedgers = (): void => {
  ledgers.clear();
};

/**
 * What one request needs from the route's fuses: a retry verdict per attempt, a
 * seat on the primary, and the notifications that keep the counters honest.
 *
 * The seat is bound by `tryEnter` and released by `leave`, so the caller's
 * `finally` needs no authority and cannot release the wrong one — and `leave`
 * is safe to call when nothing was taken, which is what lets one `finally`
 * cover every exit path including the refusal itself.
 */
export interface LimitsObserver {
  /** Counts this request itself. Called once per walk. */
  onRequest(): void;
  /** True when one more attempt at an already-tried upstream is still in budget. */
  retryAllowed(): boolean;
  /** Counts one retry actually performed. */
  onRetry(): void;
  /** True when the budget refused this walk a retry. */
  retryDenied(): boolean;
  /** Takes an in-flight seat on `authority`. False when the fuse is full. */
  tryEnter(authority: string): boolean;
  /** Returns the seat taken, if any. Safe to call more than once. */
  leave(): void;
}

/**
 * Builds the per-request view over a route's ledger, remembering the walk's own
 * verdict: whether the budget denied it. Like the outlier observer's `skipped`,
 * the fact is recorded when the decision happens rather than derived afterwards,
 * so the event reports it even when the walk then throws.
 */
export const limitsObserver = (
  ledger: LimitsLedger,
  now: () => number = Date.now,
): LimitsObserver => {
  let denied = false;
  let seated: string | undefined;
  return {
    onRequest: () => ledger.recordRequest(now()),
    retryAllowed(): boolean {
      const ok = ledger.retryAllowed(now());
      if (!ok) {
        denied = true;
      }
      return ok;
    },
    onRetry: () => ledger.recordRetry(now()),
    retryDenied: () => denied,
    tryEnter(authority) {
      const taken = ledger.tryEnter(authority);
      if (taken) {
        seated = authority;
      }
      return taken;
    },
    leave() {
      if (seated !== undefined) {
        ledger.leave(seated);
        seated = undefined;
      }
    },
  };
};
