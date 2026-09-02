import type { Config } from 'jouska';

/**
 * Cache-variant advisory.
 *
 * A route that both caches and matches on request headers or cookies makes its
 * cache key vary with those values: every distinct `X-Env` the panel's
 * condition ever saw becomes its own cache entry. Correctness is not at stake —
 * the key folding is what keeps one branch's cached response from being served
 * to another — but hit rate is. The advisory says so before the operator
 * wonders why the cache never seems to hit.
 *
 * Query conditions are deliberately absent: a query parameter is already part
 * of the URL, so it already separates cache entries and this changes nothing.
 *
 * This is an advisory, not a validation error. Per-variant caching is a
 * legitimate configuration — header-selected canaries that also cache — and
 * refusing to publish one would block a working setup in order to warn about
 * a cost its operator may have already priced in.
 */

export interface CacheVaryWarning {
  /** The route whose cache key will vary with request values. */
  readonly routeId: string;
  /** Header and cookie names the values of which join the cache key. */
  readonly names: readonly string[];
}

export const cacheVaryWarnings = (config: Config): CacheVaryWarning[] =>
  config.routes.flatMap((route, index) => {
    if (route.cache?.enabled !== true) {
      return [];
    }
    const names = [
      ...(route.match.headers ?? []),
      ...(route.match.cookies ?? []),
    ].map((condition) => condition.name);
    return names.length > 0 ? [{ routeId: route.id ?? `#${index}`, names: [...new Set(names)] }] : [];
  });
