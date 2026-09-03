/**
 * Login through Cloudflare Access.
 *
 * The happy path is the least interesting part — the platform authenticated the
 * caller before this Worker ran. What is worth testing is everything around
 * that:
 *
 *   - the two doors never add up to a bypass: a token that was presented and
 *     failed must not be able to fall through to the cookie, or turning Access
 *     off becomes something an attacker does per-request;
 *   - provisioning happens exactly once, because Access policies are routinely
 *     written wider than the panel's intent;
 *   - `role` and `disabled` still come from the panel's own table, so the
 *     last-admin guard keeps meaning something;
 *   - the environment that has no `ctx.access` (production, with static assets)
 *     and the one that has nothing else (`wrangler dev`) both work.
 *
 * Each JWT case uses its own team name: the JWKS cache is keyed by team and
 * lives at module scope, so distinct names are what keeps one case's keys out
 * of the next one's verification.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from './index.js';
import type { AppEnv, Env } from './env.js';

const testEnv = env as unknown as Env;
const base = 'https://panel.test';
const AUD = 'panel-audience';
const ROOT_PW = 'correct-horse-battery';

interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

const envWith = (overrides: Record<string, unknown>): AppEnv =>
  ({ ...testEnv, ...overrides }) as unknown as AppEnv;

const request = async (
  method: string,
  path: string,
  appEnv: AppEnv,
  headers: Record<string, string> = {},
  ctx: unknown = {},
  body?: unknown,
): Promise<ResponseLike> =>
  worker.fetch(
    new Request(`${base}${path}`, {
      method,
      headers: { origin: base, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    appEnv,
    ctx as ExecutionContext,
  ) as unknown as Promise<ResponseLike>;

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
const makeSigner = async () => {
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
const jwksFetch = (keys: JsonWebKey[]) => {
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

const deadFetch: typeof fetch = async () => new Response('nope', { status: 500 });

const claims = (email: string, overrides: Record<string, unknown> = {}) => ({
  aud: AUD,
  exp: Math.floor(Date.now() / 1000) + 300,
  email,
  ...overrides,
});

/** Env with Access on, pointed at a stub certs endpoint. */
const accessEnv = (team: string, fetchImpl: typeof fetch): AppEnv =>
  envWith({ ACCESS_TEAM: team, ACCESS_AUD: AUD, ACCESS_JWKS_FETCH: fetchImpl });

const userRow = async (subject: string) =>
  testEnv.DB.prepare(
    'SELECT id, subject, role, password, disabled, last_seen FROM users WHERE subject = ?',
  )
    .bind(subject)
    .first<{
      id: number;
      subject: string;
      role: string;
      password: string | null;
      disabled: number;
      last_seen: number | null;
    }>();

const userCount = async (): Promise<number> =>
  (await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n ?? 0;

const insertUser = async (
  subject: string,
  role: 'admin' | 'viewer',
  disabled = false,
): Promise<void> => {
  await testEnv.DB.prepare(
    'INSERT INTO users (subject, email, role, password, disabled, created_at) VALUES (?, ?, ?, NULL, ?, ?)',
  )
    .bind(subject, subject, role, disabled ? 1 : 0, Math.floor(Date.now() / 1000))
    .run();
};

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, TEST_MIGRATIONS);
  for (const table of ['audit_log', 'sessions', 'routes', 'settings', 'users']) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe('Access off', () => {
  it('leaves the password door exactly as it was', async () => {
    const appEnv = envWith({});
    const boot = await request(
      'POST',
      '/api/auth/bootstrap',
      appEnv,
      {},
      {},
      {
        subject: 'root',
        password: ROOT_PW,
      },
    );
    expect(boot.status).toBe(201);

    const login = await request(
      'POST',
      '/api/auth/login',
      appEnv,
      {},
      {},
      {
        subject: 'root',
        password: ROOT_PW,
      },
    );
    expect(login.status).toBe(200);
    const cookie = `jouska_session=${/jouska_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]}`;

    const me = await request('GET', '/api/auth/me', appEnv, { cookie });
    expect(me.status).toBe(200);
    // `via` is what the audit log will lean on to tell the two doors apart.
    expect((await me.json()) as unknown).toMatchObject({
      user: { subject: 'root', via: 'session' },
    });
  });

  it('still refuses an anonymous caller', async () => {
    const res = await request('GET', '/api/routes', envWith({}));
    expect(res.status).toBe(401);
  });
});

describe('Access on, first run', () => {
  it('provisions the first caller as admin, with no password', async () => {
    const { jwk, sign } = await makeSigner();
    const appEnv = accessEnv('acme-first', jwksFetch([jwk]).impl);

    const res = await request('GET', '/api/auth/me', appEnv, {
      'cf-access-jwt-assertion': await sign(claims('ops@example.com')),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      user: { subject: 'ops@example.com', role: 'admin', via: 'access' },
      bootstrapable: false,
    });

    const row = await userRow('ops@example.com');
    expect(row?.role).toBe('admin');
    // The column's NULL is the whole point: this account has no password to
    // verify, so there is nothing for a stolen hash to be.
    expect(row?.password).toBeNull();
    expect(row?.last_seen).not.toBeNull();
  });

  it('provisions once — the second Access identity is refused, not created', async () => {
    const { jwk, sign } = await makeSigner();
    const appEnv = accessEnv('acme-once', jwksFetch([jwk]).impl);

    const first = await request('GET', '/api/auth/me', appEnv, {
      'cf-access-jwt-assertion': await sign(claims('ops@example.com')),
    });
    expect(first.status).toBe(200);

    const second = await request('GET', '/api/routes', appEnv, {
      'cf-access-jwt-assertion': await sign(claims('stranger@example.com')),
    });
    expect(second.status).toBe(403);
    expect((await second.json()) as unknown).toMatchObject({
      error: 'no_panel_account',
      accessEmail: 'stranger@example.com',
    });
    expect(await userCount()).toBe(1);
  });

  it('tells /me the address, so the SPA can say who to ask', async () => {
    await insertUser('someone@example.com', 'admin');
    const { jwk, sign } = await makeSigner();
    const appEnv = accessEnv('acme-unknown', jwksFetch([jwk]).impl);

    const res = await request('GET', '/api/auth/me', appEnv, {
      'cf-access-jwt-assertion': await sign(claims('stranger@example.com')),
    });
    // Not a login problem — the platform already answered that — so 200 with
    // the address rather than a 401 the login form cannot resolve.
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      user: null,
      bootstrapable: false,
      accessEmail: 'stranger@example.com',
    });
  });
});

describe('Access on, the panel table still decides', () => {
  it('honours the row role: a viewer stays a viewer', async () => {
    await insertUser('reader@example.com', 'viewer');
    const { jwk, sign } = await makeSigner();
    const appEnv = accessEnv('acme-role', jwksFetch([jwk]).impl);
    const token = await sign(claims('reader@example.com'));

    const read = await request('GET', '/api/routes', appEnv, { 'cf-access-jwt-assertion': token });
    expect(read.status).toBe(200);

    const write = await request('GET', '/api/users', appEnv, { 'cf-access-jwt-assertion': token });
    expect(write.status).toBe(403);
  });

  it('refuses a disabled account even though Access let it in', async () => {
    await insertUser('gone@example.com', 'admin', true);
    const { jwk, sign } = await makeSigner();
    const appEnv = accessEnv('acme-disabled', jwksFetch([jwk]).impl);

    const res = await request('GET', '/api/routes', appEnv, {
      'cf-access-jwt-assertion': await sign(claims('gone@example.com')),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as unknown).toMatchObject({ error: 'account_disabled' });
  });
});

describe('the two doors do not add up to a bypass', () => {
  /** A live password session, so every refusal below has something to fall to. */
  const withSession = async (): Promise<string> => {
    const plain = envWith({});
    await request(
      'POST',
      '/api/auth/bootstrap',
      plain,
      {},
      {},
      {
        subject: 'root',
        password: ROOT_PW,
      },
    );
    const login = await request(
      'POST',
      '/api/auth/login',
      plain,
      {},
      {},
      {
        subject: 'root',
        password: ROOT_PW,
      },
    );
    return `jouska_session=${/jouska_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]}`;
  };

  it('a forged signature is refused, cookie or no cookie', async () => {
    const cookie = await withSession();
    const real = await makeSigner();
    const impostor = await makeSigner();
    // The certs endpoint publishes the real key; the token is signed by the other.
    const appEnv = accessEnv('acme-forged', jwksFetch([real.jwk]).impl);

    const res = await request('GET', '/api/routes', appEnv, {
      cookie,
      'cf-access-jwt-assertion': await impostor.sign(claims('root')),
    });
    expect(res.status).toBe(401);
  });

  it("a token for another application is 403, not somebody else's session", async () => {
    const cookie = await withSession();
    const { jwk, sign } = await makeSigner();
    const appEnv = accessEnv('acme-aud', jwksFetch([jwk]).impl);

    const res = await request('GET', '/api/routes', appEnv, {
      cookie,
      'cf-access-jwt-assertion': await sign(claims('root', { aud: 'some-other-app' })),
    });
    expect(res.status).toBe(403);
  });

  it('an expired token is refused', async () => {
    const { jwk, sign } = await makeSigner();
    const appEnv = accessEnv('acme-expired', jwksFetch([jwk]).impl);

    const res = await request('GET', '/api/routes', appEnv, {
      'cf-access-jwt-assertion': await sign(
        claims('ops@example.com', { exp: Math.floor(Date.now() / 1000) - 1 }),
      ),
    });
    expect(res.status).toBe(401);
  });

  it('a token proving no email proves nothing this panel can key a row on', async () => {
    const { jwk, sign } = await makeSigner();
    const appEnv = accessEnv('acme-noemail', jwksFetch([jwk]).impl);
    const payload = claims('unused');
    delete (payload as { email?: unknown }).email;

    const res = await request('GET', '/api/routes', appEnv, {
      'cf-access-jwt-assertion': await sign(payload),
    });
    expect(res.status).toBe(401);
    expect(await userCount()).toBe(0);
  });

  it('an absent token does fall through to the cookie — that is the migration path', async () => {
    const cookie = await withSession();
    const { jwk } = await makeSigner();
    const appEnv = accessEnv('acme-fallthrough', jwksFetch([jwk]).impl);

    const res = await request('GET', '/api/auth/me', appEnv, { cookie });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      user: { subject: 'root', via: 'session' },
    });
  });
});

describe('fail closed', () => {
  it('answers 503 when the JWKS cannot be obtained', async () => {
    const { sign } = await makeSigner();
    const appEnv = accessEnv('acme-nojwks', deadFetch);

    const res = await request('GET', '/api/routes', appEnv, {
      'cf-access-jwt-assertion': await sign(claims('ops@example.com')),
    });
    // Not 401: nothing was wrong with the credential, we simply had no material
    // to check it against. Saying "unauthenticated" would invite a retry loop.
    expect(res.status).toBe(503);
  });

  it('answers 503 for a team name that could never name a certs endpoint', async () => {
    const { jwk, sign } = await makeSigner();
    const appEnv = envWith({
      ACCESS_TEAM: 'evil.example.com/..',
      ACCESS_AUD: AUD,
      ACCESS_JWKS_FETCH: jwksFetch([jwk]).impl,
    });

    const res = await request('GET', '/api/routes', appEnv, {
      'cf-access-jwt-assertion': await sign(claims('ops@example.com')),
    });
    expect(res.status).toBe(503);
  });

  it('a team without an audience is Access off, not Access half-on', async () => {
    const { jwk, sign } = await makeSigner();
    const appEnv = envWith({
      ACCESS_TEAM: 'acme-halfon',
      ACCESS_JWKS_FETCH: jwksFetch([jwk]).impl,
    });

    const res = await request('GET', '/api/routes', appEnv, {
      'cf-access-jwt-assertion': await sign(claims('ops@example.com')),
    });
    // Falls through to the cookie path, finds none, and refuses. What it must
    // not do is admit a token whose audience nobody checked.
    expect(res.status).toBe(401);
    expect(await userCount()).toBe(0);
  });
});

describe('ctx.access, the local-development door', () => {
  const ctxWith = (email: string): unknown => ({
    access: { getIdentity: async () => ({ email }) },
  });

  it('accepts an identity the platform put on the context', async () => {
    const appEnv = accessEnv('acme-ctx', deadFetch);

    const res = await request('GET', '/api/auth/me', appEnv, {}, ctxWith('dev@example.com'));
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      user: { subject: 'dev@example.com', role: 'admin', via: 'access' },
    });
  });

  it('is not consulted when a header was presented and failed', async () => {
    const real = await makeSigner();
    const impostor = await makeSigner();
    const appEnv = accessEnv('acme-ctx-forged', jwksFetch([real.jwk]).impl);

    const res = await request(
      'GET',
      '/api/routes',
      appEnv,
      { 'cf-access-jwt-assertion': await impostor.sign(claims('dev@example.com')) },
      ctxWith('dev@example.com'),
    );
    expect(res.status).toBe(401);
  });

  it('ignores a context that offers the call but answers nothing', async () => {
    const appEnv = accessEnv('acme-ctx-empty', deadFetch);
    const res = await request(
      'GET',
      '/api/routes',
      appEnv,
      {},
      {
        access: { getIdentity: async () => ({}) },
      },
    );
    expect(res.status).toBe(401);
  });
});

describe('signing out', () => {
  it('hands back the platform sign-out URL for an Access session', async () => {
    const { jwk, sign } = await makeSigner();
    const appEnv = accessEnv('acme-logout', jwksFetch([jwk]).impl);
    const token = await sign(claims('ops@example.com'));

    const res = await request('POST', '/api/auth/logout', appEnv, {
      'cf-access-jwt-assertion': token,
    });
    expect(res.status).toBe(200);
    // Clearing this Worker's cookie is not a sign-out: CF_Authorization lives on
    // the team domain, so the caller has to be sent there or the next reload
    // walks straight back in.
    expect((await res.json()) as unknown).toMatchObject({
      ok: true,
      accessLogout: 'https://acme-logout.cloudflareaccess.com/cdn-cgi/access/logout',
    });
  });

  it('says nothing about Access when the session was the cookie', async () => {
    const plain = envWith({});
    await request(
      'POST',
      '/api/auth/bootstrap',
      plain,
      {},
      {},
      {
        subject: 'root',
        password: ROOT_PW,
      },
    );
    const login = await request(
      'POST',
      '/api/auth/login',
      plain,
      {},
      {},
      {
        subject: 'root',
        password: ROOT_PW,
      },
    );
    const cookie = `jouska_session=${/jouska_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]}`;

    const res = await request('POST', '/api/auth/logout', plain, { cookie });
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not invent a URL from a team name that could not be one', async () => {
    // Reachable only through the dev context, where the team name never went
    // through JWT verification — and this string is handed to a browser to
    // navigate to, so a malformed name would be an open redirect.
    const appEnv = envWith({
      ACCESS_TEAM: 'evil.example.com/..',
      ACCESS_AUD: AUD,
      ACCESS_JWKS_FETCH: deadFetch,
    });
    const res = await request(
      'POST',
      '/api/auth/logout',
      appEnv,
      {},
      {
        access: { getIdentity: async () => ({ email: 'dev@example.com' }) },
      },
    );
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('liveness', () => {
  it('records last_seen at most once an hour, not once a request', async () => {
    const { jwk, sign } = await makeSigner();
    const appEnv = accessEnv('acme-lastseen', jwksFetch([jwk]).impl);
    const token = await sign(claims('ops@example.com'));

    await request('GET', '/api/auth/me', appEnv, { 'cf-access-jwt-assertion': token });
    const first = (await userRow('ops@example.com'))?.last_seen ?? 0;
    expect(first).toBeGreaterThan(0);

    // Backdate by well over the window, then confirm the next call moves it.
    const stale = first - 7200;
    await testEnv.DB.prepare('UPDATE users SET last_seen = ? WHERE subject = ?')
      .bind(stale, 'ops@example.com')
      .run();
    await request('GET', '/api/auth/me', appEnv, { 'cf-access-jwt-assertion': token });
    expect((await userRow('ops@example.com'))?.last_seen).toBeGreaterThan(stale);

    // Fresh timestamp: the guard inside the UPDATE leaves it alone.
    const fresh = (await userRow('ops@example.com'))?.last_seen ?? 0;
    await request('GET', '/api/auth/me', appEnv, { 'cf-access-jwt-assertion': token });
    expect((await userRow('ops@example.com'))?.last_seen).toBe(fresh);
  });
});
