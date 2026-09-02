import type { Context, MiddlewareHandler } from 'hono';
import type { Config, Route } from '../config.js';
import {
  contentTypeAllowed,
  htmlRewriter,
  parseContentType,
  resolveCharset,
  textRewriteStream,
  type ContentType,
  type Replacement,
} from '../internal/body.js';
import { forward } from '../internal/forward.js';
import { checkRateLimit, corsMiddleware, ipMiddleware } from '../internal/guards.js';
import {
  rewriteResponseHeaders,
  stripBodyValidators,
  stripHopByHop,
  upstreamHostMatcher,
} from '../internal/headers.js';
import { matchUrl, resolveUpstreamUrl, routeId, splitUpstream, type Match } from '../router.js';

/**
 * Why a response body was relayed instead of rewritten.
 *
 * Each of these was silent, and that silence is the whole problem: a mirrored
 * site whose links still point at the origin is indistinguishable from one whose
 * links were rewritten until a visitor clicks one and leaves. Five different
 * causes used to collapse into the same absence of any signal.
 *
 * - `not_configured` — the route has no `bodyRewrite` at all.
 * - `bodyless_status` — 204, 206 or 304; see {@link NO_REWRITE_STATUSES}.
 * - `no_body` — the response carried no body stream, as the answer to a HEAD
 *   does. Distinct from `bodyless_status`, where the status itself forbids a
 *   body: here the status permits one and none arrived.
 * - `content_type` — the type is outside `bodyRewrite.contentTypes`.
 * - `charset_undecodable` — a declared charset this runtime cannot decode, with
 *   no usable `fallbackCharset`. The hardest of the five to diagnose: the config
 *   reads correctly, the page renders, and the links simply do not change.
 */
export type RewriteSkipReason =
  'not_configured' | 'bodyless_status' | 'no_body' | 'content_type' | 'charset_undecodable';

/** What happened to one proxied request. Passed to `onProxy`. */
export interface ProxyEvent {
  /** The route that matched, labelled the way rate-limit buckets are. */
  routeId: string;
  /** Upstream authority the request was sent to. */
  upstream: string;
  method: string;
  /** Path as the client wrote it, before any normalisation. */
  path: string;
  /** Status returned to the client, including jouska's own 4xx/5xx. */
  status: number;
  /** Wall-clock milliseconds from match to response. */
  durationMs: number;
  /** Attempts made against the upstream, including the first. */
  attempts: number;
  /** Set when the request never reached a normal response. */
  outcome: 'ok' | 'refused' | 'timeout' | 'unreachable' | 'client_closed';
  /**
   * True when the body was handed to the rewriter.
   *
   * States that the transform was installed, not that it finished: the body is
   * streamed, and reporting after it drained would hold the event until the
   * client had already read the response.
   */
  bodyRewritten: boolean;
  /**
   * Why the body was relayed untouched. Absent when it was rewritten, and also
   * absent when nothing was proxied — a guard refusal, an upstream that never
   * answered, or a 101 has no rewrite decision to report, and naming a reason
   * would describe a response that does not exist.
   */
  rewriteSkipped?: RewriteSkipReason;
  /**
   * True when the `Location` sent to the client differs from the upstream's, so
   * the redirect stayed on the proxy. False when there was no `Location`, when
   * it named a host outside the upstream, or when `rewriteHeaders` is off.
   */
  redirectRewritten: boolean;
}

export interface JouskaOptions {
  config: Config;
  /** Overridable for tests; defaults to the runtime `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Called once per proxied request, after the response is decided.
   *
   * Deliberately a callback rather than a binding: writing to Analytics Engine,
   * a log line, or nothing at all is a deployment decision, and a library that
   * picked one would either pull in a binding nobody asked for or invent a
   * config surface for something the host already has. Errors thrown here are
   * swallowed — observability must not be able to fail a request.
   *
   * Wrap the body in `ctx.waitUntil` if it does I/O, so the response is not held
   * waiting on it.
   *
   * Not called for a CORS preflight that `hono/cors` answers itself: nothing was
   * proxied, so there is no upstream, status or duration to report. Verified — a
   * preflight against a route with `cors` set produces a 204 and no event. Note
   * the asymmetry with rate limiting, which can be told to count preflights via
   * `countPreflight`; if you need them in your metrics, count them at the app
   * level rather than expecting them here.
   */
  onProxy?: (event: ProxyEvent) => void;
}

/** Cloudflare request metadata this middleware reads. Isolated for clarity. */
interface CloudflareRequest {
  cf?: { country?: string };
}

/** Reads the visitor's country. Cloudflare reports it uppercased. */
const country = (request: Request): string | undefined =>
  (request as CloudflareRequest).cf?.country;

/**
 * Statuses whose body must not be rewritten.
 *
 * A 206 carries a byte range, so changing its length contradicts the
 * `Content-Range` the client used to assemble the whole resource — verified: a
 * rewritten 206 kept `bytes 0-31/1000` while the body became 30 bytes. 304 and
 * 204 have no body at all.
 */
const NO_REWRITE_STATUSES = new Set([204, 206, 304]);

/**
 * Reverse-proxy middleware. Resolves the request against the route table and,
 * on a match, forwards it upstream and rewrites the response. On no match it
 * calls `next()`, so an app can mix proxied routes with its own handlers.
 */
export const jouska = ({ config, fetchImpl, onProxy }: JouskaOptions): MiddlewareHandler => {
  return async (c, next) => {
    const startedAt = Date.now();
    // Parsed once and threaded through: the URL was previously re-parsed four
    // or five times per request, all to read the same three fields.
    const url = new URL(c.req.url);
    const match = matchUrl(config, url, c.req.method);
    if (match === undefined) {
      return next();
    }
    const { route } = match;

    // Guards run cheapest-first, so a request that will be refused never
    // reaches the upstream. Geo and IP are local checks; rate limiting costs a
    // binding call; forwarding costs a network round trip.
    const report: Report = (status, outcome, attempts, rewrite): void => {
      if (onProxy === undefined) {
        return;
      }
      try {
        onProxy({
          routeId: routeId(route, match.index),
          upstream: splitUpstream(route.upstream).authority,
          method: c.req.method,
          path: url.pathname,
          status,
          durationMs: Date.now() - startedAt,
          attempts,
          outcome,
          // Omitted `rewrite` means the request never reached the point of
          // deciding, so both flags are false and no reason is named.
          bodyRewritten: rewrite?.bodyRewritten ?? false,
          // Spread rather than assigned `undefined`: under
          // exactOptionalPropertyTypes a consumer distinguishes an absent key
          // from a present undefined one, and "no decision" is an absent key.
          ...(rewrite?.rewriteSkipped !== undefined
            ? { rewriteSkipped: rewrite.rewriteSkipped }
            : {}),
          redirectRewritten: rewrite?.redirectRewritten ?? false,
        });
      } catch {
        // Observability must not be able to fail a request.
      }
    };

    const geo = checkGeo(route, c.req.raw);
    if (geo !== undefined) {
      report(403, 'refused', 0);
      return c.text(geo, 403);
    }

    if (route.ip !== undefined) {
      const refused = await runGuard(ipMiddleware(route.ip), c);
      if (refused !== undefined) {
        report(refused.status, 'refused', 0);
        return refused;
      }
    }

    const isPreflight = c.req.method === 'OPTIONS' && c.req.header('origin') !== undefined;
    if (route.rateLimit !== undefined && (route.rateLimit.countPreflight || !isPreflight)) {
      const verdict = await checkRateLimit(
        route.rateLimit,
        c,
        routeId(route, match.index),
        c.req.header('cf-connecting-ip'),
      );
      if (!verdict.ok) {
        if (verdict.reason === 'exceeded') {
          report(429, 'refused', 0);
          return c.json({ error: 'rate_limited' }, 429);
        }
        if (verdict.reason === 'unidentifiable') {
          // Fail closed: see checkRateLimit for why one shared bucket is worse.
          report(403, 'refused', 0);
          return c.json({ error: 'rate_limit_unidentifiable' }, 403);
        }
        report(500, 'refused', 0);
        return c.json({ error: 'rate_limit_misconfigured', binding: route.rateLimit.binding }, 500);
      }
    }

    // CORS wraps the forward so preflights are answered without a round trip
    // and the response carries the negotiated headers.
    if (route.cors !== undefined) {
      return corsMiddleware(route.cors)(c, async () => {
        c.res = await proxyRequest(match, c, url, fetchImpl, report);
      });
    }
    return proxyRequest(match, c, url, fetchImpl, report);
  };
};

/**
 * Applies the country rules, returning a refusal reason or undefined.
 *
 * `blockCountries` fails open on an unknown origin — an absent signal must not
 * be mistaken for a blocked one. `allowCountries` fails closed, because an
 * allow-list that admits unknowns is not an allow-list. Codes are uppercased by
 * the schema, so these are exact comparisons; the previous lowercase-tolerant
 * config silently admitted everything.
 */
const checkGeo = (route: Route, request: Request): string | undefined => {
  if (route.blockCountries.length === 0 && route.allowCountries === undefined) {
    return undefined;
  }
  const from = country(request);
  if (from !== undefined && route.blockCountries.includes(from)) {
    return 'Forbidden';
  }
  if (
    route.allowCountries !== undefined &&
    (from === undefined || !route.allowCountries.includes(from))
  ) {
    return 'Forbidden';
  }
  return undefined;
};

/**
 * Runs a Hono middleware purely as a gate: returns its response when it refuses
 * the request, or `undefined` when it calls `next()` and the request may go on.
 */
const runGuard = async (guard: MiddlewareHandler, c: Context): Promise<Response | undefined> => {
  let passed = false;
  const result = await guard(c, async () => {
    passed = true;
  });
  if (passed) {
    return undefined;
  }
  return result instanceof Response ? result : c.res;
};

/**
 * The rewrite conclusions one event carries. Separate from the positional
 * arguments because most report sites — every guard refusal, every upstream
 * failure — have no rewrite to describe and pass nothing.
 */
interface RewriteReport {
  readonly bodyRewritten: boolean;
  readonly rewriteSkipped?: RewriteSkipReason;
  readonly redirectRewritten: boolean;
}

/** Reports the outcome of one proxied request. */
type Report = (
  status: number,
  outcome: ProxyEvent['outcome'],
  attempts: number,
  rewrite?: RewriteReport,
) => void;

/** Forwards the request upstream and rewrites the response. */
const proxyRequest = async (
  match: Match,
  c: Context,
  url: URL,
  fetchImpl: typeof fetch | undefined,
  report: Report,
): Promise<Response> => {
  const { route } = match;
  const target = resolveUpstreamUrl(match, url);
  // Counted by forward itself, so a retry is visible to the caller rather than
  // hidden inside a single reported request.
  let attempts = 0;
  const counting: typeof fetch = (input, init) => {
    attempts += 1;
    return (fetchImpl ?? fetch)(input as RequestInfo, init);
  };

  let upstream: Response;
  try {
    upstream = await forward({
      route,
      target,
      request: c.req.raw,
      requestUrl: url,
      fetchImpl: counting,
    });
  } catch (error) {
    const failure = upstreamFailure(error, c, target);
    report(failure.status, failureOutcome(error), attempts);
    return failure;
  }

  // A 101 carries the socket itself and cannot be reconstructed: `new Response`
  // refuses any status outside 200–599, and rewrapping would drop the
  // `webSocket` property even if it did not. Verified against workerd, both.
  if (upstream.status === 101) {
    report(101, 'ok', attempts);
    return upstream;
  }

  const { authority } = splitUpstream(route.upstream);
  const contentType = parseContentType(upstream.headers.get('content-type'));
  const decision = decideRewrite(route.bodyRewrite, upstream, contentType);

  const { headers, redirectRewritten } = route.rewriteHeaders
    ? rewriteResponseHeaders({
        headers: upstream.headers,
        upstreamHost: authority,
        proxyOrigin: url.origin,
        bodyRewritten: decision.rewrite,
      })
    : // Nothing was rewritten, so nothing is claimed: `stripHopByHop` does not
      // touch `Location`.
      { headers: stripHopByHop(upstream.headers), redirectRewritten: false };

  // Reported before `rewriteBody`, deliberately. The rewrite is a stream
  // transform, so a report that waited for its result would hold the event —
  // and any `waitUntil` the host queued from it — until the client had finished
  // reading the body. Everything the event states is already known here.
  report(upstream.status, 'ok', attempts, {
    bodyRewritten: decision.rewrite,
    ...(decision.rewrite ? {} : { rewriteSkipped: decision.skipped }),
    redirectRewritten,
  });

  if (!decision.rewrite) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  // With rewriting off, the validators were left intact above; they still have
  // to go once the body changes.
  if (!route.rewriteHeaders) {
    stripBodyValidators(headers);
  }
  // Output is always UTF-8, so a declared charset that is no longer accurate
  // would make the browser decode correct bytes with the wrong table.
  if (decision.transcoded && contentType !== undefined) {
    headers.set('content-type', `${contentType.type}; charset=utf-8`);
  }

  return rewriteBody({
    upstream,
    headers,
    rewrite: decision.config,
    charset: decision.charset,
    isHtml: contentType?.type === 'text/html',
    upstreamHost: authority,
    target,
    proxyHost: url.host,
  });
};

/**
 * Whether this response's body is rewritten, and if not, which of the five
 * reasons applies.
 *
 * A discriminated union rather than the chain of `&&` this replaces: that chain
 * computed one boolean out of conditions that meant entirely different things to
 * whoever was debugging a mirror whose links never changed, and reported none of
 * them. The order runs from the route's own configuration outward to this one
 * response, so the reason named is the outermost thing an operator can change.
 */
type RewriteDecision =
  | {
      readonly rewrite: true;
      /** The config that applies, carried so the caller need not re-narrow it. */
      readonly config: NonNullable<Route['bodyRewrite']>;
      readonly charset: string;
      /** True when the body is re-encoded, so `Content-Type` must be corrected. */
      readonly transcoded: boolean;
    }
  | { readonly rewrite: false; readonly skipped: RewriteSkipReason };

const decideRewrite = (
  config: Route['bodyRewrite'],
  upstream: Response,
  contentType: ContentType | undefined,
): RewriteDecision => {
  if (config === undefined) {
    return { rewrite: false, skipped: 'not_configured' };
  }
  if (NO_REWRITE_STATUSES.has(upstream.status)) {
    return { rewrite: false, skipped: 'bodyless_status' };
  }
  if (upstream.body === null) {
    return { rewrite: false, skipped: 'no_body' };
  }
  if (!contentTypeAllowed(contentType, config.contentTypes)) {
    return { rewrite: false, skipped: 'content_type' };
  }
  // The charset decides whether rewriting is even safe: an encoding this runtime
  // cannot decode would be corrupted rather than rewritten, so the body passes
  // through untouched instead.
  const charset = resolveCharset(contentType?.charset, config.fallbackCharset);
  if (charset === undefined) {
    return { rewrite: false, skipped: 'charset_undecodable' };
  }
  return { rewrite: true, config, charset: charset.charset, transcoded: charset.transcoded };
};

/** Classifies a forward failure for reporting. */
const failureOutcome = (error: unknown): ProxyEvent['outcome'] => {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError') {
    return 'client_closed';
  }
  return name === 'TimeoutError' || name === 'TotalTimeoutError' ? 'timeout' : 'unreachable';
};

/** Maps a forward failure onto a status the caller can act on. */
const upstreamFailure = (error: unknown, c: Context, target: URL): Response => {
  const name = error instanceof Error ? error.name : '';
  // Distinguish a deadline from a genuine failure, and both from the client
  // simply hanging up — which is nobody's fault and not worth a 5xx.
  if (name === 'AbortError') {
    // 499 is nginx's non-standard "client closed request"; nothing is listening
    // for it, but it keeps client aborts out of the upstream error rate. Built
    // directly because Hono's `c.json` types only admit registered statuses.
    return Response.json({ error: 'client_closed_request' }, { status: 499 });
  }
  const timedOut = name === 'TimeoutError' || name === 'TotalTimeoutError';
  return c.json(
    { error: timedOut ? 'upstream_timeout' : 'upstream_unreachable', upstream: target.host },
    timedOut ? 504 : 502,
  );
};

interface RewriteBodyOptions {
  upstream: Response;
  headers: Headers;
  rewrite: NonNullable<Route['bodyRewrite']>;
  charset: string;
  isHtml: boolean;
  upstreamHost: string;
  target: URL;
  proxyHost: string;
}

/** Streams the body through the appropriate rewriter. */
const rewriteBody = ({
  upstream,
  headers,
  rewrite,
  charset,
  isHtml,
  upstreamHost,
  target,
  proxyHost,
}: RewriteBodyOptions): Response => {
  const base = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  if (isHtml && rewrite.rewriteLinks) {
    // Native HTMLRewriter streams, so the document is never materialised. It
    // also assumes UTF-8 input, so a transcoding body is decoded first.
    const decoded =
      charset === 'utf-8'
        ? base
        : new Response(transcode(base.body, charset), {
            status: base.status,
            statusText: base.statusText,
            headers: base.headers,
          });
    const transformed = htmlRewriter({
      isUpstreamHost: upstreamHostMatcher(upstreamHost),
      proxyHost,
      base: target.toString(),
      rewriteStyles: rewrite.rewriteStyles,
    }).transform(decoded);
    return rewrite.replace.length > 0
      ? pipeText(transformed, rewrite.replace, undefined)
      : transformed;
  }

  // Text bodies get URL-aware host rewriting rather than a literal substitution:
  // substituting the host as a substring turned `https://o.test.evil.com/b` in a
  // stylesheet into `https://p.dev.evil.com/b`.
  const hostRewrite = rewrite.rewriteLinks
    ? { isUpstreamHost: upstreamHostMatcher(upstreamHost), proxyHost }
    : undefined;
  if (hostRewrite === undefined && rewrite.replace.length === 0 && charset === 'utf-8') {
    return base;
  }
  return pipeText(base, rewrite.replace, hostRewrite, charset);
};

/** Re-encodes a body from `charset` into UTF-8 without buffering it. */
const transcode = (
  body: ReadableStream<Uint8Array> | null,
  charset: string,
): ReadableStream<Uint8Array> | null =>
  body === null ? null : body.pipeThrough(textRewriteStream([], undefined, charset));

/** Streams a body through host rewriting and literal replacements. */
const pipeText = (
  response: Response,
  replacements: readonly Replacement[],
  hostRewrite: { isUpstreamHost: (host: string) => boolean; proxyHost: string } | undefined,
  charset = 'utf-8',
): Response =>
  new Response(
    response.body?.pipeThrough(textRewriteStream(replacements, hostRewrite, charset)) ?? null,
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
