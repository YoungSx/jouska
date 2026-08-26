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
  /** How long a loaded config is served before reloading. */
  ttlMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Called when a reload fails while a cached config is still being served. */
  onReloadError?: (error: unknown) => void;
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
}: CacheOptions): ConfigCache => {
  let entry: Entry | undefined;
  let inflight: Promise<Config> | undefined;

  const refresh = async (): Promise<Config> => {
    // Collapse concurrent misses onto a single load.
    inflight ??= (async () => {
      try {
        const config = await load();
        entry = { config, loadedAt: now() };
        return config;
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
    },
  };
};
