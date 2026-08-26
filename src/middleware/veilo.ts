import type { Context, MiddlewareHandler } from 'hono';
import type { Config } from '../config.js';
import { htmlRewriter, shouldRewrite, textReplaceStream } from '../internal/body.js';
import { forward } from '../internal/forward.js';
import { checkRateLimit, corsMiddleware, ipMiddleware } from '../internal/guards.js';
import { rewriteResponseHeaders } from '../internal/headers.js';
import { matchRoute, resolveUpstreamUrl, routeId, type Match } from '../router.js';

export interface VeiloOptions {
  config: Config;
  /** Overridable for tests; defaults to the runtime `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Reads the visitor's country. Cloudflare-specific, hence isolated here. */
const country = (request: Request): string | undefined =>
  (request as { cf?: { country?: string } }).cf?.country;

/**
 * Reverse-proxy middleware. Resolves the request against the route table and,
 * on a match, forwards it upstream and rewrites the response. On no match it
 * calls `next()`, so an app can mix proxied routes with its own handlers.
 */
export const veilo = ({ config, fetchImpl }: VeiloOptions): MiddlewareHandler => {
  return async (c, next) => {
    const match = matchRoute(config, c.req.raw);
    if (match === undefined) {
      return next();
    }
    const { route } = match;

    // Guards run cheapest-first, so a request that will be refused never
    // reaches the upstream. Geo and IP are local checks; rate limiting costs a
    // binding call; forwarding costs a network round trip.
    if (route.blockCountries.length > 0) {
      const from = country(c.req.raw);
      if (from !== undefined && route.blockCountries.includes(from)) {
        return c.text('Forbidden', 403);
      }
    }

    if (route.ip !== undefined) {
      const refused = await runGuard(ipMiddleware(route.ip), c);
      if (refused !== undefined) {
        return refused;
      }
    }

    if (route.rateLimit !== undefined) {
      const verdict = await checkRateLimit(route.rateLimit, c, routeId(route));
      if (!verdict.ok) {
        return verdict.reason === 'exceeded'
          ? c.json({ error: 'rate_limited' }, 429)
          : c.json({ error: 'rate_limit_misconfigured', binding: route.rateLimit.binding }, 500);
      }
    }

    // CORS wraps the forward so preflights are answered without a round trip
    // and the response carries the negotiated headers.
    if (route.cors !== undefined) {
      return corsMiddleware(route.cors)(c, async () => {
        c.res = await proxyRequest(match, c, fetchImpl);
      });
    }
    return proxyRequest(match, c, fetchImpl);
  };
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

/** Forwards the request upstream and rewrites the response. */
const proxyRequest = async (
  match: Match,
  c: Context,
  fetchImpl: typeof fetch | undefined,
): Promise<Response> => {
  const { route } = match;
  const target = resolveUpstreamUrl(match, c.req.raw);

  let upstream: Response;
  try {
    upstream = await forward({ route, target, request: c.req.raw, fetchImpl });
  } catch (error) {
    // Distinguish a deadline from a genuine upstream failure so callers can
    // tell "too slow" from "broken".
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return c.json(
      { error: timedOut ? 'upstream_timeout' : 'upstream_unreachable', upstream: target.host },
      timedOut ? 504 : 502,
    );
  }

  const proxyOrigin = new URL(c.req.url).origin;
  const headers = route.rewriteHeaders
    ? rewriteResponseHeaders(upstream.headers, target.host, proxyOrigin)
    : new Headers(upstream.headers);

  const rewrite = route.bodyRewrite;
  if (rewrite === undefined || upstream.body === null) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }
  if (!shouldRewrite(headers.get('content-type'), rewrite.contentTypes)) {
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  // Length changes once the body is rewritten; a stale value breaks the client.
  headers.delete('content-length');
  const proxyHost = new URL(proxyOrigin).host;
  const base = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });

  const isHtml = shouldRewrite(headers.get('content-type'), ['text/html']);
  if (isHtml && rewrite.rewriteLinks) {
    // Native HTMLRewriter streams, so the document is never materialised.
    const transformed = htmlRewriter(target.host, proxyHost).transform(base);
    return rewrite.replace.length > 0 ? withTextReplace(transformed, rewrite.replace) : transformed;
  }

  const replacements = [
    ...(rewrite.rewriteLinks ? [{ from: target.host, to: proxyHost }] : []),
    ...rewrite.replace,
  ];
  return replacements.length > 0 ? withTextReplace(base, replacements) : base;
};

const withTextReplace = (
  response: Response,
  replacements: { from: string; to: string }[],
): Response =>
  new Response(response.body?.pipeThrough(textReplaceStream(replacements)) ?? null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
