import type { Config } from './config.js';

/**
 * Config caching.
 *
 * Reading the config store on every request is not viable on the free tier:
 * Workers KV allows 100,000 reads per day, so a site doing two requests per
 * second would exhaust the allowance in half a day and then fail closed.
 *
 * Isolates are reused across requests, so a module-scope cache turns "one read
 * per request" into "one read per isolate per TTL" — several orders of
 * magnitude fewer. The cost is bounded staleness, which is acceptable because
 * KV is eventually consistent anyway: a write already takes time to propagate,
 * so the TTL makes an existing delay explicit rather than adding a new one.
 */

export interface CacheOptions {
  /** Loads and validates config. Called at most once per TTL per isolate. */
  load: () => Promise<Config>;
  /**
   * How long a loaded config is served before reloading. Defaults to 60 seconds
   * to match the platform: Cloudflare documents that a KV write may take "up to
   * 60 seconds or more" to become visible elsewhere, so a shorter TTL buys
   * little real freshness while multiplying reads.
   */
  ttlMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Called when a reload fails while a cached config is still being served. */
  onReloadError?: (error: unknown) => void;
  /**
   * How long a failed cold load is remembered before another is attempted.
   *
   * Zero by default, so a transient failure is retried immediately and a caller
   * gets the recovery it expects. Set it when the loader reads a metered store:
   * with nothing cached to fall back on, a store that is down turns every
   * request into a fresh read attempt, which burns the read allowance exactly
   * when the store can least afford it. A second or two is enough — a longer
   * window would outlast most outages and refuse to serve after recovery.
   */
  errorTtlMs?: number;
}

export interface ConfigCache {
  /** Returns the cached config, loading or refreshing it when needed. */
  get: () => Promise<Config>;
  /** Discards the cached value so the next `get` reloads. */
  invalidate: () => void;
}

interface Entry {
  config: Config;
  loadedAt: number;
}

/**
 * Creates a cache around a config loader.
 *
 * Two behaviours worth stating because they are load-bearing:
 *
 *  - Concurrent misses share one load. Without this, an isolate handling a
 *    burst of requests with a cold cache would issue one store read per
 *    request, which is exactly the cost the cache exists to avoid.
 *  - A failed refresh keeps serving the previous config. A config store that
 *    is briefly unreachable must not take the proxy down; the error is
 *    surfaced through `onReloadError` instead.
 */
export const createConfigCache = ({
  load,
  ttlMs = 60_000,
  now = Date.now,
  onReloadError,
  errorTtlMs = 0,
}: CacheOptions): ConfigCache => {
  let entry: Entry | undefined;
  let inflight: Promise<Config> | undefined;
  // Incremented by `invalidate`, so a load already in flight when it is called
  // cannot install its result afterwards. Without this, invalidating during a
  // load let the value it was meant to discard reappear a moment later.
  let generation = 0;
  let failedAt: number | undefined;

  const refresh = async (): Promise<Config> => {
    // Collapse concurrent misses onto a single load.
    inflight ??= (async () => {
      const started = generation;
      try {
        const config = await load();
        if (started === generation) {
          entry = { config, loadedAt: now() };
          failedAt = undefined;
        }
        return config;
      } catch (error) {
        if (started === generation) {
          // Remember the failure briefly. A cold cache whose loader is failing
          // would otherwise hit the store once per request — precisely the read
          // amplification this cache exists to prevent, arriving exactly when
          // the store is least able to serve it.
          failedAt = now();
        }
        throw error;
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  };

  return {
    get: async () => {
      const current = entry;
      if (current !== undefined && now() - current.loadedAt < ttlMs) {
        return current.config;
      }
      if (current === undefined) {
        // Nothing cached: the caller has to wait, and a failure must propagate.
        if (
          errorTtlMs > 0 &&
          failedAt !== undefined &&
          now() - failedAt < errorTtlMs &&
          inflight === undefined
        ) {
          throw new Error('config load failed recently; not retrying until the error TTL expires');
        }
        return refresh();
      }
      try {
        return await refresh();
      } catch (error) {
        // Stale config beats no config.
        onReloadError?.(error);
        return current.config;
      }
    },
    invalidate: () => {
      entry = undefined;
      failedAt = undefined;
      generation += 1;
    },
  };
};
