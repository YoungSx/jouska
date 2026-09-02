import type { Route } from '../config.js';
import { splitUpstream } from '../router.js';
import { readCookie } from './cookies.js';

/**
 * How a split route picked this request's upstream. Emitted on `ProxyEvent`
 * so the question "why did this request go to v2" has an answer in the
 * telemetry rather than only in the source.
 */
export interface Selection {
  /** Position in the declared `trafficSplit` order of the entry that won. */
  index: number;
  /** The sticky cookie decided, or the weighted hash did. */
  reason: 'sticky' | 'weighted';
  /**
   * What the weighted hash was taken over. `'ip'` when the client had an
   * address to hash; `'none'` otherwise, which puts every such request in the
   * same bucket — deterministic and explicable where a random draw would be
   * neither.
   */
  scope: 'ip' | 'none';
}

/** Name of the stickiness cookie. Unique enough not to collide with an upstream's own. */
export const STICKY_COOKIE = '__jouska_upstream';

/**
 * FNV-1a, 32-bit. Small, dependency-free, and stable across runtimes — the
 * assignment a client received must not change when the worker is redeployed,
 * so the hash has to be spelled out here rather than delegated to anything
 * whose behaviour may drift.
 */
const hash = (input: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/**
 * The stickiness cookie the proxy sets when a caller without one is assigned.
 *
 * Host-only (no `Domain`): stickiness is a property of this proxy host, and
 * leaving the attribute out means the rewriter never has reason to touch it.
 * `HttpOnly` because nothing client-side reads it. No `Secure` so it also
 * works on plain-HTTP local origins.
 */
export const stickyCookie = (upstream: string): string =>
  `${STICKY_COOKIE}=${upstream}; Path=/; HttpOnly; SameSite=Lax`;

/**
 * Picks the split entry this request belongs to.
 *
 * A caller presenting a sticky cookie naming one of the split's own upstreams
 * goes straight back to it. Everyone else is assigned by hashing a stable
 * per-client key into the weight space, so the same caller lands in the same
 * bucket without any state — the assignment is reproducible from the request
 * alone, which is what makes it attributable.
 *
 * The decision happens before any request is sent: the winner is the primary
 * candidate the failover walk starts from, not a post-hoc relabelling of
 * wherever the request happened to land.
 */
export const selectUpstream = (route: Route, request: Request): Selection => {
  const split = route.trafficSplit;
  if (split === undefined) {
    // Not a split route: the caller resolves the only candidate directly.
    return { index: 0, reason: 'weighted', scope: 'none' };
  }

  const cookie = request.headers.get('cookie');
  const sticky = cookie === null ? undefined : readCookie(cookie, STICKY_COOKIE);
  if (sticky !== undefined) {
    // The cookie stores an authority (`target.host`), and entries are compared
    // by theirs: a base path is irrelevant to stickiness, and matching on it
    // would drop every caller when only an entry's path changed.
    const index = split.findIndex((entry) => splitUpstream(entry.upstream).authority === sticky);
    if (index !== -1) {
      return { index, reason: 'sticky', scope: 'none' };
    }
    // A cookie naming an upstream this split no longer lists is stale — the
    // caller is re-assigned below and the response sets a fresh cookie.
  }

  const ip = request.headers.get('cf-connecting-ip');
  const scope: Selection['scope'] = ip !== null ? 'ip' : 'none';
  const total = split.reduce((sum, entry) => sum + entry.weight, 0);
  let bucket = hash(`${route.id ?? ''} ${ip ?? ''}`) % total;
  let index = 0;
  for (let i = 0; i < split.length; i += 1) {
    bucket -= split[i]!.weight;
    if (bucket < 0) {
      index = i;
      break;
    }
  }
  return { index, reason: 'weighted', scope };
};
