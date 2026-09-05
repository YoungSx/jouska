import type { AccessConfig } from '../config.js';
import { base64UrlBytes } from './base64url.js';
import { sha256Hex } from './digest.js';

/**
 * Route-level identity checks: the CF Access JWT and the API key.
 *
 * These are guards, not a login system. Every failure is a refusal — the
 * request never reaches the upstream — and the statuses mean exactly three
 * things: 401 no usable credential, 403 a credential that does not grant this
 * route, 503 the verification material itself could not be obtained (the
 * proxy fails closed).
 *
 * Length is capped before anything is parsed or hashed. A 200 kB credential is
 * a CPU bill on the free tier's 10 ms budget before it is anything else, and
 * the cap costs one comparison — the same ordering the panel applies to
 * passwords before PBKDF2.
 *
 * Cost, pinned by measurement in the real runtime rather than a datasheet (the
 * panel's PBKDF2 precedent in `workers/admin-panel/src/iterations.ts`): with a
 * warm JWKS cache, a full RS256 verify measured ~0.2 ms per request and the
 * SHA-256 key comparison ~0.05 ms — both one to two orders of magnitude under
 * the free plan's 10 ms CPU ceiling, before geo/IP/rate-limit even run (they
 * run first, so an unauthenticated flood is billed a 429, not a verify). The
 * cold path adds one network round trip for the JWKS, which is wait, not CPU.
 * Numbers are from workerd on the author's machine with the assertion checked
 * per call — they drift with platform and shape, and the ceiling is what
 * regresses: if the access block ever grows expensive work, re-measure.
 */

/** A presented credential longer than this is refused before any parsing. */
export const MAX_KEY_LENGTH = 512;

/** A presented JWT longer than this is refused before any parsing. */
export const MAX_JWT_LENGTH = 4096;

/** How long a fetched JWKS is trusted before it is fetched again. */
const JWKS_TTL_MS = 60 * 60 * 1000;

/**
 * Minimum age a cached JWKS must reach before an unknown `kid` triggers a
 * re-fetch. Without it, requests carrying fabricated key ids each cost a
 * network round trip to the team's certs endpoint — a refillable bucket the
 * caller can keep topping up.
 */
const JWKS_REFRESH_MIN_AGE_MS = 60 * 1000;

export type AccessRefusal = 'missing' | 'too_long' | 'invalid' | 'forbidden' | 'jwks_unavailable';

export type AccessVerdict =
  { ok: true } | { ok: false; status: 401 | 403 | 503; reason: AccessRefusal };

const refused = (status: 401 | 403 | 503, reason: AccessRefusal): AccessVerdict => ({
  ok: false,
  status,
  reason,
});

/** The header Cloudflare Access puts its JWT in on every request to the origin. */
const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

interface JsonWebKeyWithKid {
  kid?: string;
  [key: string]: unknown;
}

interface CachedJwks {
  keys: JsonWebKeyWithKid[];
  fetchedAt: number;
  /** Set when the last fetch failed, so the outage is not re-tried per request. */
  failed?: boolean;
}

/**
 * JWKS per team, cached at module scope.
 *
 * Per-isolate rather than `caches.default` deliberately: the payload is a few
 * hundred bytes, and a response-cache entry would make its TTL the cache's
 * business instead of ours. An isolate that lives an hour fetches each team's
 * certs once.
 */
const jwksCache = new Map<string, CachedJwks>();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Byte-level comparison between the presented digest and a configured one.
 *
 * `crypto.subtle.timingSafeEqual` is workerd's non-standard extension; where it
 * exists it is used, because it is one call. The fallback is exact-length
 * iteration. Either way the comparison operates on two SHA-256 digests — the
 * attacker must still produce a preimage — so what the timing channel could
 * teach an eavesdropper about leading digest bytes does not shorten that
 * search.
 */
const digestsMatch = async (presented: string, configured: string): Promise<boolean> => {
  const subtle = crypto.subtle as typeof crypto.subtle & {
    timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(encoder.encode(presented), encoder.encode(configured));
  }
  if (presented.length !== configured.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < presented.length; i += 1) {
    difference |= presented.charCodeAt(i) ^ configured.charCodeAt(i);
  }
  return difference === 0;
};

/**
 * Reads the API key from the request. The default header is `authorization`
 * with a `Bearer ` prefix — the shape every HTTP client produces without
 * configuration. A custom header carries the key as its raw value, for clients
 * that cannot set `Authorization` at all.
 */
const presentedKey = (config: AccessConfig, request: Request): string | undefined => {
  const header = (config.header ?? 'authorization').toLowerCase();
  const value = request.headers.get(header);
  if (value === null) {
    return undefined;
  }
  if (header === 'authorization') {
    return value.startsWith('Bearer ') ? value.slice(7) : undefined;
  }
  return value;
};

const checkKey = async (config: AccessConfig, request: Request): Promise<AccessVerdict> => {
  const presented = presentedKey(config, request);
  if (presented === undefined) {
    return refused(401, 'missing');
  }
  // Before hashing, not after: hashing is the work the length cap exists to
  // make cheap, and a cap applied to the digest would cap nothing.
  if (presented.length > MAX_KEY_LENGTH) {
    return refused(401, 'too_long');
  }
  const digest = await sha256Hex(presented);
  for (const configured of config.keys ?? []) {
    if (await digestsMatch(digest, configured)) {
      return { ok: true };
    }
  }
  return refused(401, 'invalid');
};

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
};

const fetchJwks = async (team: string, fetchImpl: typeof fetch): Promise<JsonWebKeyWithKid[]> => {
  const cached = jwksCache.get(team);
  if (
    cached !== undefined &&
    Date.now() - cached.fetchedAt < (cached.failed ? JWKS_REFRESH_MIN_AGE_MS : JWKS_TTL_MS)
  ) {
    // A remembered outage also answers from here: without the cooldown, every
    // request during one re-tried the fetch and the team's certs endpoint
    // became the thing this route rate-limits least.
    if (cached.failed) {
      throw new Error('jwks fetch previously failed; cooling down');
    }
    return cached.keys;
  }
  // The team name's shape is pinned by the config schema, so this URL can only
  // ever name a cloudflareaccess.com host — the JWKS a corrupted config would
  // redirect elsewhere is the failure that check exists to prevent.
  let keys: JsonWebKeyWithKid[];
  try {
    const response = await fetchImpl(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
    if (!response.ok) {
      throw new Error(`jwks request failed with ${response.status}`);
    }
    const body = (await response.json()) as { keys?: JsonWebKeyWithKid[] };
    if (!Array.isArray(body.keys)) {
      throw new Error('jwks response has no keys array');
    }
    keys = body.keys;
  } catch (error) {
    // Remember the failure briefly so an outage is one fetch, not one per
    // request; the caller turns this into a fail-closed refusal.
    jwksCache.set(team, { keys: [], fetchedAt: Date.now(), failed: true });
    throw error;
  }
  jwksCache.set(team, { keys, fetchedAt: Date.now() });
  return keys;
};

/** Verifies an RS256 signature over `signingInput` with the JWK named `kid`. */
const verifySignature = async (
  signingInput: string,
  signature: Uint8Array,
  jwk: JsonWebKeyWithKid,
): Promise<boolean> => {
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk as unknown as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      signature,
      encoder.encode(signingInput),
    );
  } catch {
    // An unusable key is a refusal, not an exception that escapes the guard.
    return false;
  }
};

/** The claims a verified Access JWT carries. */
export interface AccessClaims {
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  email?: string;
}

/**
 * Why a token could not be turned into claims.
 *
 * Deliberately the vocabulary the route-level guard already speaks, so the
 * wrapper below is a status mapping and not a translation layer.
 */
export type AccessJwtRefusal =
  'missing' | 'too_long' | 'invalid' | 'forbidden' | 'jwks_unavailable';

export type AccessJwtResult =
  { ok: true; claims: AccessClaims } | { ok: false; reason: AccessJwtRefusal };

/**
 * The shape a team name may have.
 *
 * The config schema pins this for the proxy's own `access` block, but this
 * function is also reached from the admin panel, where the name arrives from a
 * wrangler var. Checking it here means the JWKS URL can only ever name a
 * `cloudflareaccess.com` host regardless of which caller got it wrong — a
 * malformed name has to fail as a refused fetch, never as a request to a host
 * somebody else controls.
 */
const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

const audienceMatches = (claims: AccessClaims, audience: string): boolean =>
  Array.isArray(claims.aud) ? claims.aud.includes(audience) : claims.aud === audience;

/**
 * Verifies a Cloudflare Access JWT and hands back the claims it proved.
 *
 * Shared between the proxy's route-level guard and the admin panel's own
 * login: the panel runs behind Access on a Static-Assets Worker, where
 * `ctx.access` is never populated (measured in production, not inferred), so
 * reading and verifying this header is the only way it can learn who called.
 * One implementation, two callers — the same reason the panel and the proxy
 * share `configSchema` rather than approximating each other.
 *
 * Verification is RS256 only: the key comes from the team's own JWKS, so the
 * algorithm is fixed by the key type and an `alg: none` header has nothing to
 * verify against. Nothing in the token is acted on before the signature over
 * it is checked — an unverified `exp` or `aud` is attacker-chosen text, and
 * letting it decide the outcome would let a crafted payload pick between the
 * caller's branches.
 */
export const verifyAccessJwt = async (
  token: string | null,
  options: { team: string; audience: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AccessJwtResult> => {
  if (token === null) {
    return { ok: false, reason: 'missing' };
  }
  if (token.length > MAX_JWT_LENGTH) {
    return { ok: false, reason: 'too_long' };
  }
  // A malformed team name is a broken configuration, not a bad credential:
  // there is no material to verify against, so it fails closed the same way an
  // unreachable JWKS does.
  if (!TEAM_NAME_PATTERN.test(options.team)) {
    return { ok: false, reason: 'jwks_unavailable' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'invalid' };
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = parseJson(base64UrlBytes(headerPart) ?? new Uint8Array()) as
    { alg?: string; kid?: string } | undefined;
  const signature = base64UrlBytes(signaturePart);
  if (header === undefined || signature === undefined) {
    return { ok: false, reason: 'invalid' };
  }

  const keys = await (async () => {
    try {
      return await fetchJwks(options.team, fetchImpl);
    } catch {
      return undefined;
    }
  })();
  if (keys === undefined) {
    return { ok: false, reason: 'jwks_unavailable' };
  }

  let jwk = header.kid === undefined ? undefined : keys.find((k) => k.kid === header.kid);
  if (jwk === undefined) {
    // Rotation: the key that signed this token arrived after the cached JWKS.
    // Re-fetch once, but only from a cache old enough to make rotation the
    // plausible explanation — see JWKS_REFRESH_MIN_AGE_MS.
    const cached = jwksCache.get(options.team);
    if (cached === undefined || Date.now() - cached.fetchedAt > JWKS_REFRESH_MIN_AGE_MS) {
      jwksCache.delete(options.team);
      try {
        const refreshed = await fetchJwks(options.team, fetchImpl);
        jwk = header.kid === undefined ? undefined : refreshed.find((k) => k.kid === header.kid);
      } catch {
        return { ok: false, reason: 'jwks_unavailable' };
      }
    }
  }
  if (jwk === undefined || !verifyKeyShape(jwk)) {
    return { ok: false, reason: 'invalid' };
  }
  if (!(await verifySignature(`${headerPart}.${payloadPart}`, signature, jwk))) {
    return { ok: false, reason: 'invalid' };
  }

  // The signature vouches for this payload; now, and only now, its claims can
  // decide anything.
  const claims = parseJson(base64UrlBytes(payloadPart) ?? new Uint8Array()) as
    AccessClaims | undefined;
  if (claims === undefined) {
    return { ok: false, reason: 'invalid' };
  }

  const now = Date.now() / 1000;
  if (claims.exp !== undefined && claims.exp <= now) {
    return { ok: false, reason: 'invalid' };
  }
  if (claims.nbf !== undefined && claims.nbf > now) {
    return { ok: false, reason: 'invalid' };
  }
  if (!audienceMatches(claims, options.audience)) {
    // Signed by the team, just not for this application: an identity question,
    // so the caller answers 403 rather than 401.
    return { ok: false, reason: 'forbidden' };
  }
  return { ok: true, claims };
};

/**
 * The route-level guard over `verifyAccessJwt`: a status for every refusal,
 * plus the one condition that belongs to the route rather than to the token —
 * the email allowlist.
 */
const checkJwt = async (
  config: NonNullable<AccessConfig['cloudflare']>,
  request: Request,
  fetchImpl: typeof fetch,
): Promise<AccessVerdict> => {
  const result = await verifyAccessJwt(
    request.headers.get(ACCESS_JWT_HEADER),
    { team: config.team, audience: config.audience },
    fetchImpl,
  );
  if (!result.ok) {
    if (result.reason === 'jwks_unavailable') {
      return refused(503, 'jwks_unavailable');
    }
    if (result.reason === 'forbidden') {
      return refused(403, 'forbidden');
    }
    return refused(401, result.reason);
  }
  if (
    config.emails !== undefined &&
    (result.claims.email === undefined || !config.emails.includes(result.claims.email))
  ) {
    return refused(403, 'forbidden');
  }
  return { ok: true };
};

/** A JWKS entry this module can verify with is an RSA public key, nothing else. */
const verifyKeyShape = (jwk: JsonWebKeyWithKid): boolean =>
  jwk.kty === 'RSA' && typeof jwk.n === 'string' && typeof jwk.e === 'string';

/**
 * Runs every access mechanism the route configured. Configured mechanisms all
 * have to pass — a route asking for both a key and a valid Access JWT is
 * asking for a caller that carries both, and running the cheap local check
 * first means a caller missing that one never starts a JWKS fetch.
 */
export const checkAccess = async (
  config: AccessConfig,
  request: Request,
  fetchImpl: typeof fetch,
): Promise<AccessVerdict> => {
  if (config.keys !== undefined) {
    const key = await checkKey(config, request);
    if (!key.ok) {
      return key;
    }
  }
  if (config.cloudflare !== undefined) {
    return checkJwt(config.cloudflare, request, fetchImpl);
  }
  return { ok: true };
};

/** Test hook: drops the JWKS cache, so one test's team cannot leak into the next. */
export const resetJwksCacheForTest = (): void => {
  jwksCache.clear();
};
