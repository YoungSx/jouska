import { splitUpstream, upstreamCandidates, type Config, type Route } from 'jouska';

/**
 * Whole-site mirror advisory.
 *
 * A route that takes an entire site and does not rewrite the response body
 * forwards perfectly and still walks the visitor off the proxy on their first
 * click: the upstream's own HTML says `href="https://origin.example/x"`, and
 * nothing rewrote it. The panel never said so, because `bodyRewrite` is an
 * off-by-default switch whose help text is only read once somebody turns it on.
 *
 * This is an advisory, not a validation error. A whole-site route with no body
 * rewriting is a legitimate configuration — a pure API gateway, an asset proxy —
 * and refusing to publish one would block a common case in order to warn about
 * another.
 *
 * It is also not a default. Rewriting strips `ETag`, `Last-Modified` and the
 * upstream's CSP, so switching it on for every new route would silently downgrade
 * client caching and the upstream's own security headers. The operator presses it,
 * knowing the cost.
 */

export interface MirrorWarning {
  /** The whole-site route whose links will not be rewritten. */
  readonly routeId: string;
  /** Authority the visitor's next click sends them to. */
  readonly upstream: string;
}

/**
 * Whether a route takes a whole site rather than a path beneath one.
 *
 * An absent `match.path` matches every path; `/` is the same intent written out.
 * Anything longer is a prefix route — `/api` and its kind — where rewriting the
 * body is not wanted at all, so an advisory there would be pure noise. Noise is
 * the failure mode that matters: a warning that fires on every API route is one
 * operators learn to scroll past, and scrolling past it costs the whole-site case
 * its only signal.
 */
const isWholeSite = (route: Route): boolean =>
  route.match.path === undefined || route.match.path === '/';

/**
 * Flags whole-site routes that will hand the visitor back to the upstream.
 *
 * Reads the parsed config, so table-wide `defaults` are already folded in: a
 * `bodyRewrite` written once under `defaults` counts for every route that did not
 * state its own, which is exactly what the proxy will do with it.
 *
 * Deliberately not flagged: a route that sets `bodyRewrite` but turns
 * `rewriteLinks` off, or narrows `contentTypes` away from HTML. Navigation ends up
 * in the same place, but both mean somebody opened that section and decided
 * something inside it. This advisory is for the operator who never saw the switch.
 */
export const mirrorWarnings = (config: Config): MirrorWarning[] =>
  config.routes.flatMap((route, index) =>
    isWholeSite(route) && route.bodyRewrite === undefined
      ? [
          {
            routeId: route.id ?? `#${index}`,
            // Not `route.upstream` directly: a route may name its upstreams as a
            // failover list or a split, and the advisory names the primary.
            upstream: splitUpstream(upstreamCandidates(route)[0] ?? '').authority,
          },
        ]
      : [],
  );
