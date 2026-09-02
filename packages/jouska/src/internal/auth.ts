import type { Route } from '../config.js';
import { HOP_BY_HOP, stripConnectionNamed } from './hop.js';

/**
 * Route-level access control: the delegated-auth guard that answers "who are
 * you", after the earlier guards answered "where are you from" and "how fast".
 *
 * Local signature checks (API key digests, Cloudflare Access JWT verification)
 * live in `internal/access.ts` alongside the `access` config block they serve;
 * this file is only the guard that leaves the isolate and asks a URL.
 */

/** Outcome of the delegated-auth exchange. */
type ForwardAuthVerdict =
  | { verdict: 'pass'; headers: Headers }
  | { verdict: 'pass_open' }
  | { verdict: 'refuse'; response: Response };

/**
 * The delegated-auth guard, in the nginx `auth_request` shape.
 *
 * The subrequest carries the original method and only the headers
 * `copyRequestHeaders` names — never the body, which is a one-shot stream the
 * proxy still needs for the upstream, and which no auth service reads. The
 * five `x-forwarded-*` values are jouska's own statement about the original
 * request, written after the copies so a client-supplied value cannot survive.
 *
 * A 2xx admits the request; every other status is the auth service's own
 * verdict and is relayed verbatim — status, headers, body — so a login
 * redirect or a `WWW-Authenticate` challenge arrives exactly as the service
 * wrote it. Only transport failure is jouska's to answer, and it fails closed
 * unless the config explicitly opted into `failOpen`.
 */
const runForwardAuth = async (
  config: NonNullable<Route['forwardAuth']>,
  request: Request,
  requestUrl: URL,
  fetcher: typeof fetch,
): Promise<ForwardAuthVerdict> => {
  const headers = new Headers();
  for (const name of config.copyRequestHeaders) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  // The proxy's own account of the original request, overwriting anything the
  // client sent — these describe the connection to the *proxy*, and the auth
  // service must not be told the client's version of it. `copyRequestHeaders`
  // cannot have carried any of these names: the schema refuses them.
  headers.set('x-forwarded-host', requestUrl.host);
  headers.set('x-forwarded-proto', requestUrl.protocol.replace(':', ''));
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp !== null) {
    headers.set('x-forwarded-for', clientIp);
  }
  headers.set('x-forwarded-method', request.method);
  headers.set('x-forwarded-uri', `${requestUrl.pathname}${requestUrl.search}`);

  const signals: AbortSignal[] = [AbortSignal.timeout(config.timeoutMs)];
  if (request.signal !== null && request.signal !== undefined) {
    signals.push(request.signal);
  }

  let response: Response;
  try {
    response = await fetcher(
      new Request(config.url, {
        method: request.method,
        headers,
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0]!,
      }),
    );
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    // The caller is gone; nobody is waiting for a verdict either way.
    if (name === 'AbortError') {
      return {
        verdict: 'refuse',
        response: Response.json({ error: 'client_closed_request' }, { status: 499 }),
      };
    }
    if (config.failOpen === true) {
      return { verdict: 'pass_open' };
    }
    return {
      verdict: 'refuse',
      response: Response.json({ error: 'forward_auth_unavailable' }, { status: 503 }),
    };
  }

  if (response.status >= 200 && response.status < 300) {
    const copied = new Headers();
    for (const name of config.copyResponseHeaders) {
      const value = response.headers.get(name);
      if (value !== null) {
        copied.set(name, value);
      }
    }
    return { verdict: 'pass', headers: copied };
  }

  // Relay the service's verdict verbatim, minus the hop-by-hop framing of the
  // connection that delivered it.
  const relayed = new Headers(response.headers);
  stripConnectionNamed(relayed);
  for (const name of HOP_BY_HOP) {
    relayed.delete(name);
  }
  return {
    verdict: 'refuse',
    response: new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: relayed,
    }),
  };
};

/**
 * What one pass of the access-control stage decided: refuse with a Response,
 * or continue — carrying the stage's latency either way, so a slow auth
 * endpoint is visible in the event whether it admitted or refused.
 */
export interface AuthResult {
  /** The guard's refusal, ready to return to the client verbatim. */
  refusal?: Response;
  /**
   * The authority the refusal was earned from — the auth endpoint, for a
   * delegated verdict or a failed exchange. Absent when the check was local
   * and nothing left the isolate, so the event keeps attributing the request
   * to the upstream it would have reached.
   */
  refusalUpstream?: string;
  /** Wall-clock milliseconds the stage spent. */
  authMs?: number;
  /**
   * Headers a forward-auth pass designated for the upstream request. Absent
   * when no pass produced any.
   */
  authHeaders?: Headers;
}

/**
 * Whether the route delegates its authentication — the one condition the
 * middleware and the cache backstop must agree on, so this is shared rather
 * than restated and the two cannot drift.
 */
export const routeAuthenticates = (route: Route): boolean =>
  route.forwardAuth !== undefined;

/**
 * Runs the route's delegated-auth guard. Returns undefined when the route
 * declares none, so a request without auth spends nothing here — not even an
 * await: the middleware gates the call on this same check, because an await
 * for an answer that is statically `undefined` would still hand the event
 * loop a turn and desync the request from the guards ahead of it.
 */
export const runAuthGuards = async (
  route: Route,
  request: Request,
  requestUrl: URL,
  fetchImpl?: typeof fetch,
): Promise<AuthResult | undefined> => {
  if (route.forwardAuth === undefined) {
    return undefined;
  }
  const fetcher = fetchImpl ?? fetch;
  const startedAt = Date.now();

  const verdict = await runForwardAuth(route.forwardAuth, request, requestUrl, fetcher);
  switch (verdict.verdict) {
    case 'refuse':
      return {
        refusal: verdict.response,
        refusalUpstream: new URL(route.forwardAuth.url).host,
        authMs: Date.now() - startedAt,
      };
    case 'pass':
      return { authMs: Date.now() - startedAt, authHeaders: verdict.headers };
    case 'pass_open':
      // The config's explicit choice: an unreachable endpoint is not proof
      // the caller is legitimate, but this route would rather stay up.
      return { authMs: Date.now() - startedAt };
  }
};
