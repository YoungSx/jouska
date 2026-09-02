import type { Route } from '../config.js';
import { HOP_BY_HOP, stripConnectionNamed } from './hop.js';

/**
 * Route-level access control: the three guards that answer "who are you",
 * after the earlier guards answered "where are you from" and "how fast".
 *
 * Each guard is independent and optional; a route listing several requires all
 * of them to pass (AND). The order below is cheapest first — a local hash, then
 * a local signature check, then the network round trip — so a request that will
 * be refused by an early guard never spends the later ones' latency.
 */

/** Ceiling on the Access token accepted for parsing, in characters. */
const JWT_MAX_CHARS = 4096;

/** How long a fetched team JWKS is trusted before it is fetched again. */
const JWKS_TTL_MS = 60 * 60 * 1000;

/** Verifies the token's ES256 signature against this team's published keys. */
interface TeamJwks {
  fetchedAt: number;
  keys: Map<string, CryptoKey>;
}

/**
 * Module-level JWKS cache, keyed by team domain.
 *
 * A per-request fetch would put a Cloudflare round trip in front of every
 * proxied call — the very cost delegating auth was meant to avoid. Sixty
 * minutes bounds how long a rotated key stays trusted: Access rotates rarely,
 * and a revoked token's expiry is checked independently, so the window is a
 * staleness trade, not an authorisation one. The cache lives per isolate, so a
 * cold start is one extra fetch per team, not per request.
 */
const jwksCache = new Map<string, TeamJwks>();

/** Test seam: clears the module-level JWKS cache. */
export const resetJwksCache = (): void => {
  jwksCache.clear();
};

/** Hex-encodes a digest, lowercase, for comparison against configured digests. */
const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Whether `presented` matches any configured digest, without saying which or
 * where.
 *
 * The whole set is always scanned: exiting on the first match would make the
 * comparison time betray how far into the list the key sits. With at most 100
 * digests the scan is nanoseconds; the information it refuses to leak is not
 * recoverable any other way.
 */
const matchesAnyDigest = (presented: string, digests: readonly string[]): boolean => {
  let anyMatch = 0;
  for (const digest of digests) {
    let diff = digest.length === presented.length ? 0 : 1;
    for (let i = 0; diff === 0 && i < presented.length; i += 1) {
      diff |= presented.charCodeAt(i) ^ digest.charCodeAt(i);
    }
    anyMatch |= diff === 0 ? 1 : 0;
  }
  return anyMatch === 1;
};

/**
 * The API-key guard. Returns undefined to admit, or a refusal Response.
 *
 * The presented key is hashed and compared against the configured SHA-256
 * digests; plaintext never exists in the route table, so nothing here needs to
 * hold it either. A key on `authorization` may arrive with the `Bearer` prefix,
 * which is stripped before hashing — the digest of the token is what the
 * operator computed, and the scheme word is framing, not part of the secret.
 */
const checkApiKey = async (
  config: NonNullable<Route['apiKey']>,
  request: Request,
): Promise<Response | undefined> => {
  const presented = request.headers.get(config.header);
  if (presented === null || presented.length === 0) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const token =
    config.header === 'authorization' && presented.slice(0, 7).toLowerCase() === 'bearer '
      ? presented.slice(7)
      : presented;
  const digest = toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  if (!matchesAnyDigest(digest, config.keys)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return undefined;
};

/** Decodes the base64url parts of a JWT. `atob` is available in workerd. */
const base64UrlDecode = (value: string): Uint8Array => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/** Fetches the team's key set and imports every P-256 key for verification. */
const fetchJwks = async (
  team: string,
  fetcher: typeof fetch,
): Promise<Map<string, CryptoKey>> => {
  const response = await fetcher(`https://${team}/cdn-cgi/access/certs`);
  if (!response.ok) {
    throw new Error(`jwks fetch returned ${response.status}`);
  }
  const body = (await response.json()) as { keys?: Array<JsonWebKey & { kid?: unknown }> };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.kid !== 'string') {
      continue;
    }
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      ),
    );
  }
  if (keys.size === 0) {
    throw new Error('jwks contained no P-256 keys');
  }
  return keys;
};

/**
 * The Cloudflare Access guard. Returns undefined to admit, or a refusal
 * Response.
 *
 * The token is verified locally — signature against the team's published keys,
 * then expiry, audience and issuer — so the upstream can trust the identity
 * without doing any crypto. Reaching the JWKS endpoint is the one network cost,
 * paid once per team per isolate hour; when that fetch fails with nothing
 * cached, the verdict is 503 rather than 401, because "cannot check" is not
 * "not authorised" and the two must not be reported the same way.
 *
 * The length ceiling runs before any parsing: a token is attacker-supplied
 * input, and whatever the parser costs, it costs on input we have already
 * bounded.
 */
const checkAccessJwt = async (
  config: NonNullable<Route['accessJwt']>,
  request: Request,
  fetcher: typeof fetch,
): Promise<Response | undefined> => {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (token === null || token.length === 0 || token.length > JWT_MAX_CHARS) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let header: { alg?: string; kid?: string };
  let claims: { exp?: number; aud?: string | string[]; iss?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]!)));
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]!)));
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Only the shape Access publishes is supported; a `kid` outside it cannot be
  // verified and is refused rather than skipped, because skipping would make a
  // second, unknown key type a way past the check.
  if (header.alg !== 'ES256' || typeof header.kid !== 'string') {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const cached = jwksCache.get(config.team);
  let keys: Map<string, CryptoKey>;
  if (cached !== undefined && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    keys = cached.keys;
  } else {
    try {
      keys = await fetchJwks(config.team, fetcher);
      jwksCache.set(config.team, { keys, fetchedAt: Date.now() });
    } catch {
      return Response.json({ error: 'auth_unavailable' }, { status: 503 });
    }
  }

  const key = keys.get(header.kid);
  if (key === undefined) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    base64UrlDecode(parts[2]!),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Signature proves who signed it; these prove what it is for. Every check is
  // exact — `aud` matches the configured application tag (membership, since
  // Access may list several), `iss` names the team, and the token has not
  // expired — because a JWT that verifies for another team or another app must
  // not open this route.
  if (
    claims.exp === undefined ||
    typeof claims.exp !== 'number' ||
    claims.exp * 1000 <= Date.now()
  ) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(config.audience)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (claims.iss !== `https://${config.team}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return undefined;
};

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
 * Whether the route declares any access control at all — the one condition the
 * middleware and the cache backstop must agree on, so this is shared rather
 * than restated and the two cannot drift.
 */
export const routeAuthenticates = (route: Route): boolean =>
  route.forwardAuth !== undefined ||
  route.accessJwt !== undefined ||
  route.apiKey !== undefined;

/**
 * Runs the route's access-control guards in cost order: API key, Access JWT,
 * forward auth. Returns undefined when the route declares none, so a request
 * without auth spends nothing here — not even an await: the middleware gates
 * the call on this same check, because an await for an answer that is
 * statically `undefined` would still hand the event loop a turn and desync the
 * request from the guards ahead of it.
 */
export const runAuthGuards = async (
  route: Route,
  request: Request,
  requestUrl: URL,
  fetchImpl?: typeof fetch,
): Promise<AuthResult | undefined> => {
  if (!routeAuthenticates(route)) {
    return undefined;
  }
  const fetcher = fetchImpl ?? fetch;
  const startedAt = Date.now();

  if (route.apiKey !== undefined) {
    const refused = await checkApiKey(route.apiKey, request);
    if (refused !== undefined) {
      return { refusal: refused, authMs: Date.now() - startedAt };
    }
  }
  if (route.accessJwt !== undefined) {
    const refused = await checkAccessJwt(route.accessJwt, request, fetcher);
    if (refused !== undefined) {
      return { refusal: refused, authMs: Date.now() - startedAt };
    }
  }
  if (route.forwardAuth !== undefined) {
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
  }
  return { authMs: Date.now() - startedAt };
};
