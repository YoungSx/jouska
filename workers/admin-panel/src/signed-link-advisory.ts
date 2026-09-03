import type { Config } from 'jouska';

/**
 * Signed-link cache advisory.
 *
 * A route that both caches and verifies signed links caches by the full URL,
 * signature and expiry included — the defaults. Every `exp` a link ever
 * carried becomes its own cache entry, so the hit rate collapses to however
 * long the panel's visitors happen to reuse one exact link, and the entries
 * for expired links are dead weight the route keeps serving nothing from.
 *
 * Correctness is not at stake: a signature is part of the URL, so one link's
 * cached response is never handed out under another's. What is at stake is
 * whether the cache is worth anything at all, which is why this is an
 * advisory rather than a validation error — `ignore: ['sig', 'exp']` on the
 * cache key folds the two parameters out of the key and is the fix, and an
 * operator who has already priced the hit rate can publish as is.
 *
 * This reads `key.query`, which always exists after parsing (`cache.key`
 * prefaults), so the check is a shape inspection rather than an absence test.
 */
export interface SignedLinkCacheWarning {
  /** The route whose cache key will include the link's own parameters. */
  readonly routeId: string;
  /** The signature parameter name the route's `signedLink` block declares. */
  readonly param: string;
  /** The expiry parameter name the route's `signedLink` block declares. */
  readonly expiresParam: string;
}

export const signedLinkCacheWarnings = (config: Config): SignedLinkCacheWarning[] =>
  config.routes.flatMap((route, index) => {
    const { param, expiresParam } = route.signedLink ?? {};
    if (param === undefined || expiresParam === undefined || route.cache?.enabled !== true) {
      return [];
    }
    const warning = { routeId: route.id ?? `#${index}`, param, expiresParam };
    const query = route.cache.key.query;
    if (query === 'all' || query === 'none') {
      return [warning];
    }
    // Only `ignore: [param, expiresParam]` folds both out. Missing either one
    // leaves that parameter in the key, which is the problem this warns about.
    const ignores =
      query.ignore !== undefined &&
      query.ignore.includes(param) &&
      query.ignore.includes(expiresParam);
    return ignores ? [] : [warning];
  });
