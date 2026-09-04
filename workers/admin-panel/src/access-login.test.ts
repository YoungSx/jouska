/**
 * Login through Cloudflare Access.
 *
 * The happy path is the least interesting part — the platform authenticated the
 * caller before this Worker ran. What is worth testing is everything around
 * that:
 *
 *   - a refusal is final: with the password door gone there is nothing left for a
 *     failed or absent token to fall through to, and these cases are what keeps
 *     a second door from quietly growing back;
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
import {
  ACCESS_AUD,
  accessClaims as claims,
  deadFetch,
  jwksFetch,
  makeSigner,
} from './test-access.js';

const testEnv = env as unknown as Env;
const base = 'https://panel.test';

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

/** Env with Access on, pointed at a stub certs endpoint. */
const accessEnv = (team: string, fetchImpl: typeof fetch): AppEnv =>
  envWith({ ACCESS_TEAM: team, ACCESS_AUD: ACCESS_AUD, ACCESS_JWKS_FETCH: fetchImpl });

const userRow = async (subject: string) =>
  testEnv.DB.prepare('SELECT id, subject, role, disabled, last_seen FROM users WHERE subject = ?')
    .bind(subject)
    .first<{
      id: number;
      subject: string;
      role: string;
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
    'INSERT INTO users (subject, email, role, disabled, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(subject, subject, role, disabled ? 1 : 0, Math.floor(Date.now() / 1000))
    .run();
};

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, TEST_MIGRATIONS);
  for (const table of ['audit_log', 'routes', 'settings', 'users']) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe('Access off', () => {
  it('refuses everyone, because there is no other door', async () => {
    // The whole point of this migration: with ACCESS_TEAM unset there is no
    // credential this panel knows how to read, so the answer is 401 and stays
    // 401. A deployment that forgets to attach its Access application is locked
    // out, not softly downgraded to something an attacker can reach.
    const appEnv = envWith({});

    for (const path of ['/api/auth/me', '/api/routes', '/api/users']) {
      const res = await request('GET', path, appEnv);
      // /me answers its own shape: 200 with a null user, so the SPA can render.
      expect(path === '/api/auth/me' ? 200 : 401).toBe(res.status);
    }
    expect(await userCount()).toBe(0);
  });

  it('does not provision anybody on the way past', async () => {
    await request('GET', '/api/routes', envWith({}));
    expect(await userCount()).toBe(0);
  });
});

describe('Access on, first run', () => {
  it('provisions the first caller as admin', async () => {
    const { jwk, sign } = await makeSigner();
    const appEnv = accessEnv('acme-first', jwksFetch([jwk]).impl);

    const res = await request('GET', '/api/auth/me', appEnv, {
      'cf-access-jwt-assertion': await sign(claims('ops@example.com')),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({
      user: { subject: 'ops@example.com', role: 'admin' },
    });

    const row = await userRow('ops@example.com');
    expect(row?.role).toBe('admin');
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

describe('a refusal has nothing to fall through to', () => {
  // These cases used to prove that a failed Access token could not reach the
  // cookie door. The cookie door is gone, so what they prove now is narrower and
  // more permanent: a token that does not hold up produces a refusal, full stop,
  // and no request-shaped input downgrades that.

  it('a forged signature is refused', async () => {
    const real = await makeSigner();
    const impostor = await makeSigner();
    // The certs endpoint publishes the real key; the token is signed by the other.
    const appEnv = accessEnv('acme-forged', jwksFetch([real.jwk]).impl);

    const res = await request('GET', '/api/routes', appEnv, {
      'cf-access-jwt-assertion': await impostor.sign(claims('root')),
    });
    expect(res.status).toBe(401);
    expect(await userCount()).toBe(0);
  });

  it('a token for another application is 403', async () => {
    const { jwk, sign } = await makeSigner();
    const appEnv = accessEnv('acme-aud', jwksFetch([jwk]).impl);

    const res = await request('GET', '/api/routes', appEnv, {
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

  it('an absent token is unauthenticated, cookies on the request or not', async () => {
    const { jwk } = await makeSigner();
    const appEnv = accessEnv('acme-nofallthrough', jwksFetch([jwk]).impl);

    // A leftover `jouska_session` cookie from before the migration is just bytes
    // now. Nothing reads it, and the reply must not hint that something might.
    const res = await request('GET', '/api/routes', appEnv, {
      cookie: 'jouska_session=whatever-used-to-work',
    });
    expect(res.status).toBe(401);
    expect((await res.json()) as unknown).toMatchObject({ error: 'unauthenticated' });
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
      ACCESS_AUD,
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
    // Access counts as off without an audience, and off means refused. What it
    // must not do is admit a token whose audience nobody checked.
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
      user: { subject: 'dev@example.com', role: 'admin' },
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

  it('still answers when the team name cannot produce a URL', async () => {
    // ACCESS_TEAM unset: nothing to sign out of on the platform side, and the
    // endpoint says so by omission rather than by inventing a destination.
    const res = await request('POST', '/api/auth/logout', envWith({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not invent a URL from a team name that could not be one', async () => {
    // Reachable only through the dev context, where the team name never went
    // through JWT verification — and this string is handed to a browser to
    // navigate to, so a malformed name would be an open redirect.
    const appEnv = envWith({
      ACCESS_TEAM: 'evil.example.com/..',
      ACCESS_AUD,
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
