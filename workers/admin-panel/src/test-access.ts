/**
 * The Access door, in tests.
 *
 * Every authenticated endpoint on this panel is behind Cloudflare Access, so
 * every test that touches one needs a token the verifier will actually accept:
 * a real RS256 signature over real claims, checked against a certs endpoint that
 * really answers. Faking the verification instead — stubbing `resolveIdentity`,
 * or trusting a header — would leave the one part worth testing untested, and
 * this file exists so that eight test files do not each grow their own copy of
 * the crypto.
 *
 * Not a test file: the runner's include glob is `src/**\/*.test.ts`. It does
 * import `cloudflare:test`, which resolves only inside the Workers pool, so a
 * production module that ever imports this fails loudly at build time rather
 * than shipping test scaffolding.
 */
import { env } from 'cloudflare:test';
import type { AppEnv, Env } from './env.js';

const testEnv = env as unknown as Env;

/** The audience every token in the suite is minted for. */
export const ACCESS_AUD = 'panel-test-audience';

const ACCESS_HEADER = 'cf-access-jwt-assertion';

/** Headers that authenticate one request; spread straight into a `Request`. */
export type AuthHeaders = Readonly<Record<string, string>>;

const encoder = new TextEncoder();

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

const encodeSegment = (value: unknown): string => base64Url(encoder.encode(JSON.stringify(value)));

/** An RS256 signer plus the public JWK a certs endpoint would publish for it. */
export const makeSigner = async (): Promise<{
  readonly jwk: JsonWebKey;
  readonly sign: (claims: Record<string, unknown>) => Promise<string>;
}> => {
  // `generateKey` is typed as `CryptoKey | CryptoKeyPair`; an RSA algorithm only
  // ever yields the pair, and the assertion is what lets the two halves be named.
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey & {
    kid?: string;
  };
  jwk.kid = 'panel-key';
  const sign = async (claims: Record<string, unknown>): Promise<string> => {
    const header = encodeSegment({ alg: 'RS256', typ: 'JWT', kid: 'panel-key' });
    const payload = encodeSegment(claims);
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      pair.privateKey,
      encoder.encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
  };
  return { jwk, sign };
};

/** Answers the team's certs endpoint with `keys`; anything else is a failure. */
export const jwksFetch = (
  keys: JsonWebKey[],
): { readonly impl: typeof fetch; readonly calls: string[] } => {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.endsWith('/cdn-cgi/access/certs')) {
      calls.push(url);
      return Response.json({ keys });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  return { impl, calls };
};

/** A certs endpoint that is reachable but broken — the fail-closed case. */
export const deadFetch: typeof fetch = async () => new Response('nope', { status: 500 });

/** Claims for a token this suite's audience will accept, five minutes fresh. */
export const accessClaims = (
  email: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  aud: ACCESS_AUD,
  exp: Math.floor(Date.now() / 1000) + 300,
  email,
  ...overrides,
});

/**
 * A team name no other door will collide with.
 *
 * The JWKS cache in `jouska` is keyed by team name and outlives a single test,
 * so two doors sharing a name would have one door's tokens checked against the
 * other's key — a failure that looks like a signature bug and is not one. The
 * random suffix is what makes that impossible; the label is only there so a
 * stack trace says which door.
 */
export const uniqueTeam = (label: string): string =>
  `${label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;

/** One test's Access door: its own team, its own key, its own certs endpoint. */
export interface AccessDoor {
  readonly team: string;
  readonly jwk: JsonWebKey;
  /** Certs-endpoint URLs this door was asked for; length is the cache probe. */
  readonly jwksCalls: readonly string[];
  /** Real bindings plus Access on and the certs endpoint stubbed. */
  readonly env: (overrides?: Record<string, unknown>) => AppEnv;
  /** A token this door's certs endpoint vouches for. */
  readonly token: (email: string, claimOverrides?: Record<string, unknown>) => Promise<string>;
  /** The same token, as the header that carries it. */
  readonly headers: (
    email: string,
    claimOverrides?: Record<string, unknown>,
  ) => Promise<AuthHeaders>;
}

/** Opens a door: fresh key pair, fresh team, certs endpoint wired to both. */
export const openAccessDoor = async (label: string): Promise<AccessDoor> => {
  const { jwk, sign } = await makeSigner();
  const { impl, calls } = jwksFetch([jwk]);
  const team = uniqueTeam(label);
  const token = async (email: string, claimOverrides: Record<string, unknown> = {}) =>
    await sign(accessClaims(email, claimOverrides));
  return {
    team,
    jwk,
    jwksCalls: calls,
    env: (overrides: Record<string, unknown> = {}) =>
      ({
        // wrangler.jsonc's own vars ride into `env` through the Workers pool, so
        // the repo-level provision policy would arrive in every test. Stripped
        // here: a case that wants a posture states it, so flipping the
        // deployment's policy cannot silently rewrite what these suites prove.
        ...testEnv,
        ACCESS_PROVISION_ROLE: undefined,
        ACCESS_TEAM: team,
        ACCESS_AUD: ACCESS_AUD,
        ACCESS_JWKS_FETCH: impl,
        ...overrides,
      }) as unknown as AppEnv,
    token,
    headers: async (email, claimOverrides = {}) => accessHeader(await token(email, claimOverrides)),
  };
};

/** Wraps a raw token in the header Cloudflare Access sets on every request. */
export const accessHeader = (token: string): AuthHeaders => ({ [ACCESS_HEADER]: token });
