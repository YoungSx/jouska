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
   * What the weighted hash was taken over.
   *
   * `'ip'` is the default key. `'path'`, `'url'`, `'header'`, `'cookie'` and
   * `'query'` name the content key `hashBy` selected. `'none'` means there was
   * no key at all — an address-less caller hashing on the default, which puts
   * every such request in the same bucket: deterministic and explicable where
   * a random draw would be neither.
   *
   * A content key that turns up missing falls back to the address, and `scope`
   * then reads `'ip'` because that is what was actually hashed — the field
   * describes the request, not the configuration, so a distribution skewed
   * toward `'ip'` on a header-keyed route points at callers missing the header
   * rather than at the weights.
   */
  scope: 'ip' | 'path' | 'url' | 'header' | 'cookie' | 'query' | 'none';
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
 * Virtual nodes per unit of weight on the consistent ring.
 *
 * 160, inside the 100–160 range the ketama convention settled on. The number
 * trades how closely a ring tracks its declared weights against the cost of
 * building it: 160 points per unit of weight, sorted once per configuration,
 * is microseconds and a few kilobytes, while a ring built from tens of points
 * deviates by double-digit percentages of a candidate's share. Scaling by
 * weight rather than by candidate count is what lets a 95/5 ring give the 5%
 * candidate a smooth distribution of its own without handing it points it did
 * not declare.
 *
 * Not a tunable. A knob here invites a number chosen to fix one operator's
 * distribution and silently re-shuffles every other deployment's — the
 * re-shuffling this feature exists to make unnecessary.
 */
const VIRTUAL_NODES = 160;

/** One point on the ring: where it sits, and the split entry it stands for. */
interface RingPoint {
  point: number;
  index: number;
}

/**
 * The consistent rings, keyed by route object.
 *
 * Building a ring hashes and sorts `VIRTUAL_NODES × Σweight` points, which is
 * per-configuration work, not per-request work — and the route object lives as
 * long as the config cache does, the same lifetime the route fingerprints in
 * `response-cache.ts` lean on. A `WeakMap` on the route object therefore builds
 * each ring once per isolate, and a config change replaces the route object and
 * drops the old ring with it: no eviction policy, no TTL to get wrong.
 */
const rings = new WeakMap<object, readonly RingPoint[]>();

/**
 * Builds the ring for one split, in the declared order.
 *
 * The same {@link hash} the modulo assignment below uses, deliberately: the
 * ring replaces that assignment's *mapping*, not its arithmetic, and the
 * cross-deployment stability the FNV-1a comment promises is exactly what makes
 * the ring's own assignments stable across a redeploy too.
 *
 * Each point hashes the entry's **authority** together with the point number.
 * The authority, not the entry's position in the array, is what has to be
 * stable: the ring's whole point is that removing an entry removes only its
 * own points, and points derived from the array position would be re-derived
 * for every entry after the removed one — re-shuffling callers that the
 * property promised to leave alone. Hashing a bare name would cluster all of
 * an entry's points into one arc, so the point number interleaves them around
 * the circle. The authority rather than the whole upstream URL is what keeps
 * stickiness and the ring telling the same story: a base path is irrelevant to
 * the cookie, so it is irrelevant here too, and editing an entry's path alone
 * does not evict its callers. Duplicated authorities within one split are
 * refused by the config, so the identity is unique.
 *
 * The point seed is hashed **twice**. FNV-1a is affine in its input: a seed
 * whose only variation is a trailing counter lands on an arithmetic lattice —
 * measured, `a.test:0` and `a.test:1` hash exactly one FNV prime apart — and a
 * lattice of points hands arcs to candidates by where the lumps happen to
 * interleave rather than by their density, skewing a declared 3:1 to a measured
 * 54/46. The second pass re-avalanches a value that is by then indistinguishable
 * from noise, and the same {@link hash} the assignment uses stays the only
 * primitive: no second algorithm to keep stable across runtimes, just the same
 * one run again.
 */
const buildRing = (
  split: readonly { upstream: string; weight: number }[],
): readonly RingPoint[] => {
  const points: RingPoint[] = [];
  for (let index = 0; index < split.length; index += 1) {
    const authority = splitUpstream(split[index]!.upstream).authority;
    for (let v = 0; v < VIRTUAL_NODES * split[index]!.weight; v += 1) {
      points.push({ point: hash(String(hash(`${authority}:${v}`))), index });
    }
  }
  points.sort((a, b) => a.point - b.point);
  return points;
};

/**
 * Walks the ring for a key: the first point at or past the key's own hash
 * serves it. Removing an entry removes only its points, so the arc it owned
 * passes to whichever entry holds the next point clockwise, and every other
 * entry's callers keep their assignments — the property the modulo mapping
 * cannot offer and the reason `consistent` exists.
 */
const ringLookup = (points: readonly RingPoint[], key: string): number => {
  const target = hash(key);
  // Binary search for the first point at or past the key's hash. A key hashing
  // past every point wraps to the first one on the ring, which is where the
  // search has already stopped when it never advanced.
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (points[mid]!.point < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return points[low]!.index;
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

/** What `hashBy` can be: the union the config schema declares. */
type SplitSource = NonNullable<Route['hashBy']>;

/**
 * The key this request hashes on, and the `scope` that describes it.
 *
 * The address is both the default key and the fallback for a content key found
 * missing. A header, cookie or parameter that is absent has to fall back to
 * *something*, and a constant would pile every such request into one bucket —
 * the exact flaw `scope: 'none'` was introduced to name. The address keeps
 * those callers spread out, at the cost that their assignment then depends on
 * where they called from, which `scope: 'ip'` reports honestly.
 *
 * A present-but-empty value is a real value (`X-Foo:` hashes on `''`, `?id=`
 * likewise), the same reading `match.headers` gives the empty `equals` — only
 * absence falls back.
 */
const hashKeyOf = (
  request: Request,
  source: SplitSource,
): { key: string; scope: Selection['scope'] } => {
  const address = (): { key: string; scope: Selection['scope'] } => {
    const ip = request.headers.get('cf-connecting-ip');
    return ip !== null ? { key: ip, scope: 'ip' } : { key: '', scope: 'none' };
  };
  switch (source.source) {
    case 'ip':
      return address();
    case 'path':
      return { key: new URL(request.url).pathname, scope: 'path' };
    case 'url':
      return { key: request.url, scope: 'url' };
    case 'header': {
      // `Headers.get` is case-insensitive already, so the configured name needs
      // no normalising of its own here.
      const value = request.headers.get(source.header);
      return value !== null ? { key: value, scope: 'header' } : address();
    }
    case 'cookie': {
      const raw = request.headers.get('cookie');
      const value = raw === null ? undefined : readCookie(raw, source.cookie);
      return value !== undefined ? { key: value, scope: 'cookie' } : address();
    }
    case 'query': {
      const value = new URL(request.url).searchParams.get(source.query);
      return value !== null ? { key: value, scope: 'query' } : address();
    }
  }
};

/**
 * Picks the split entry this request belongs to.
 *
 * A caller presenting a sticky cookie naming one of the split's own upstreams
 * goes straight back to it. Everyone else is assigned by hashing a stable key
 * into the weight space, so the same key lands in the same bucket without any
 * state — the assignment is reproducible from the request alone, which is what
 * makes it attributable. Which key (`hashBy`) and how it is mapped onto the
 * entries (`hashType`) are the route's to state, and both default to this
 * function's original behaviour so an upgrade re-shuffles nothing.
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

  const { key, scope } = hashKeyOf(request, route.hashBy ?? { source: 'ip' });

  if (route.hashType === 'consistent') {
    // Cached on the route object (see `rings` above): the ring is
    // per-configuration work, and the route object is what turns over when
    // the configuration does.
    const cached = rings.get(route);
    const points = cached ?? buildRing(split);
    if (cached === undefined) {
      rings.set(route, points);
    }
    return { index: ringLookup(points, key), reason: 'weighted', scope };
  }

  const total = split.reduce((sum, entry) => sum + entry.weight, 0);
  let bucket = hash(`${route.id ?? ''} ${key}`) % total;
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
