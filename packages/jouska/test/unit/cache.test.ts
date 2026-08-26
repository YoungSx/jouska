/* oxlint-disable no-await-in-loop -- sequential awaits are the behavior under test (one KV read per TTL window) */
import { describe, expect, it } from 'vitest';
import { createConfigCache } from '../../src/cache';
import { defineConfig, type Config } from '../../src/config';

const config = (upstream: string): Config =>
  defineConfig({ routes: [{ match: { path: '/x' }, upstream }] });

/** A loader that counts calls, standing in for a KV read. */
const counting = (value = 'first.test') => {
  let calls = 0;
  return {
    calls: () => calls,
    load: async () => {
      calls += 1;
      return config(value);
    },
  };
};

/** Controllable clock so TTL expiry is exact rather than timing-dependent. */
const clock = (start = 0) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('read amplification', () => {
  it('serves many requests from a single load', async () => {
    const store = counting();
    const cache = createConfigCache({ load: store.load, now: clock().now });
    for (let i = 0; i < 1000; i += 1) {
      await cache.get();
    }
    // This ratio is the whole point: 1000 requests must not mean 1000 KV reads.
    expect(store.calls()).toBe(1);
  });

  it('collapses concurrent cold-start misses onto one load', async () => {
    const store = counting();
    const cache = createConfigCache({ load: store.load, now: clock().now });
    await Promise.all(Array.from({ length: 50 }, () => cache.get()));
    expect(store.calls()).toBe(1);
  });

  it('reloads once per TTL window, not once per request', async () => {
    const store = counting();
    const time = clock();
    const cache = createConfigCache({ load: store.load, ttlMs: 60_000, now: time.now });

    for (let minute = 0; minute < 5; minute += 1) {
      for (let i = 0; i < 100; i += 1) {
        await cache.get();
      }
      time.advance(60_000);
    }
    // 500 requests across five TTL windows: five loads, not 500.
    expect(store.calls()).toBe(5);
  });
});

describe('freshness', () => {
  it('serves the cached value before the TTL expires', async () => {
    let value = 'first.test';
    const time = clock();
    const cache = createConfigCache({
      load: async () => config(value),
      ttlMs: 60_000,
      now: time.now,
    });
    expect((await cache.get()).routes[0]!.upstream).toBe('first.test');

    value = 'second.test';
    time.advance(59_999);
    expect((await cache.get()).routes[0]!.upstream).toBe('first.test');
  });

  it('picks up a new value once the TTL expires', async () => {
    let value = 'first.test';
    const time = clock();
    const cache = createConfigCache({
      load: async () => config(value),
      ttlMs: 60_000,
      now: time.now,
    });
    await cache.get();
    value = 'second.test';
    time.advance(60_000);
    expect((await cache.get()).routes[0]!.upstream).toBe('second.test');
  });

  it('reloads immediately after invalidate', async () => {
    let value = 'first.test';
    const cache = createConfigCache({ load: async () => config(value), now: clock().now });
    await cache.get();
    value = 'second.test';
    cache.invalidate();
    expect((await cache.get()).routes[0]!.upstream).toBe('second.test');
  });
});

describe('failure handling', () => {
  it('keeps serving stale config when a refresh fails', async () => {
    let fail = false;
    const time = clock();
    const cache = createConfigCache({
      load: async () => {
        if (fail) {
          throw new Error('store unreachable');
        }
        return config('good.test');
      },
      ttlMs: 60_000,
      now: time.now,
    });
    await cache.get();

    fail = true;
    time.advance(60_000);
    // A briefly unreachable store must not take the proxy down.
    expect((await cache.get()).routes[0]!.upstream).toBe('good.test');
  });

  it('reports a failed refresh to the caller', async () => {
    let fail = false;
    let reported: unknown;
    const time = clock();
    const cache = createConfigCache({
      load: async () => {
        if (fail) {
          throw new Error('store unreachable');
        }
        return config('good.test');
      },
      ttlMs: 60_000,
      now: time.now,
      onReloadError: (e) => {
        reported = e;
      },
    });
    await cache.get();
    fail = true;
    time.advance(60_000);
    await cache.get();
    expect(reported).toBeInstanceOf(Error);
  });

  it('propagates a failure when nothing is cached yet', async () => {
    // With no previous config there is nothing to fall back to, so the caller
    // must learn that the proxy cannot start.
    const cache = createConfigCache({
      load: async () => {
        throw new Error('cold failure');
      },
      now: clock().now,
    });
    await expect(cache.get()).rejects.toThrow('cold failure');
  });

  it('recovers on the next attempt after a cold failure', async () => {
    let fail = true;
    const cache = createConfigCache({
      load: async () => {
        if (fail) {
          throw new Error('cold failure');
        }
        return config('recovered.test');
      },
      now: clock().now,
    });
    await expect(cache.get()).rejects.toThrow();
    fail = false;
    // The inflight promise must have been cleared, not left poisoned.
    expect((await cache.get()).routes[0]!.upstream).toBe('recovered.test');
  });
});
