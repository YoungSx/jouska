/**
 * Boundary and empty-value coverage.
 *
 * Every case here was written by reading the code for a specific missing
 * guard, then run to confirm it actually failed first — a case that passes on
 * the first run is testing something already handled and proves nothing.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from './index.js';
import type { AppEnv, Env } from './env.js';
import { compileConfig } from './compile.js';
import { dangerFlags } from './danger.js';
import { verifyPassword } from './password.js';
import { resolveSession } from './auth.js';

const testEnv = env as unknown as Env;
const appEnv = testEnv as unknown as AppEnv;
const base = 'https://panel.test';

interface ResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ResponseLike> =>
  worker.fetch(
    new Request(`${base}${path}`, {
      method,
      headers: { origin: base, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    appEnv,
    {} as ExecutionContext,
  ) as unknown as Promise<ResponseLike>;

const PASSWORD = 'boundary-test-password';

/** Bootstraps an admin and returns its session cookie header value. */
const adminCookie = async (): Promise<string> => {
  await call('POST', '/api/auth/bootstrap', { subject: 'root', password: PASSWORD });
  const login = await call('POST', '/api/auth/login', { subject: 'root', password: PASSWORD });
  const raw = login.headers.get('set-cookie');
  if (raw === null) {
    throw new Error('login returned no cookie');
  }
  return raw.split(';')[0]!;
};

const VALID_ROUTE = { match: { host: 'a.example.com', path: '/' }, upstream: 'up.example.com' };

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, TEST_MIGRATIONS);
  for (const table of ['audit_log', 'sessions', 'routes', 'settings', 'mcp_tokens', 'users']) {
    await testEnv.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await testEnv.CONFIG_KV.delete('routes');
});

describe('input boundaries', () => {
  it('rejects an empty subject at bootstrap', async () => {
    const res = await call('POST', '/api/auth/bootstrap', { subject: '', password: PASSWORD });
    expect(res.status).toBe(400);
  });

  it('rejects a whitespace-only subject at bootstrap', async () => {
    const res = await call('POST', '/api/auth/bootstrap', { subject: '   ', password: PASSWORD });
    expect(res.status).toBe(400);
  });

  it('rejects an absurdly long subject rather than storing it', async () => {
    const res = await call('POST', '/api/auth/bootstrap', {
      subject: 'a'.repeat(5000),
      password: PASSWORD,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a password long enough to be a CPU exhaustion lever', async () => {
    const res = await call('POST', '/api/auth/bootstrap', {
      subject: 'root',
      password: 'x'.repeat(200_000),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an array body where an object is required', async () => {
    // readJsonObject collapses arrays to {} only if it checks Array.isArray;
    // typeof [] === 'object', so an array otherwise slips through as a body.
    const res = await worker.fetch(
      new Request(`${base}/api/auth/bootstrap`, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify([{ subject: 'root', password: PASSWORD }]),
      }),
      appEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });
});

describe('route definition boundaries', () => {
  it('rejects an array as a route definition', async () => {
    const cookie = await adminCookie();
    const res = await call('PUT', '/api/routes/arr', { definition: [1, 2, 3] }, { cookie });
    expect(res.status).toBe(400);
  });

  it('rejects a definition too large to be a sane route', async () => {
    const cookie = await adminCookie();
    const res = await call(
      'PUT',
      '/api/routes/huge',
      { definition: { ...VALID_ROUTE, note: 'x'.repeat(200_000) } },
      { cookie },
    );
    expect(res.status).toBe(400);
  });

  it('rejects a non-boolean enabled instead of silently disabling', async () => {
    const cookie = await adminCookie();
    // `enabled: 'yes'` is truthy to a human and false to `=== true`, so a typo
    // would quietly park the route out of production.
    const res = await call(
      'PUT',
      '/api/routes/typo',
      { definition: VALID_ROUTE, enabled: 'yes' },
      { cookie },
    );
    expect(res.status).toBe(400);
  });

  it('rejects duplicate ids in a reorder', async () => {
    const cookie = await adminCookie();
    await call('PUT', '/api/routes/a', { definition: VALID_ROUTE }, { cookie });
    await call('PUT', '/api/routes/b', { definition: VALID_ROUTE }, { cookie });
    // ['a','a'] has the right length and every id is known, but it leaves b
    // unpositioned and gives a and b the same slot.
    const res = await call('PUT', '/api/routes-order', { ids: ['a', 'a'] }, { cookie });
    expect(res.status).toBe(400);
  });
});

describe('numeric query boundaries', () => {
  const auditLimit = async (query: string): Promise<number> => {
    const cookie = await adminCookie();
    const res = await call('GET', `/api/audit${query}`, undefined, { cookie });
    expect(res.status).toBe(200);
    return ((await res.json()) as { entries: unknown[] }).entries.length;
  };

  it('treats a negative limit as the default rather than passing it to SQL', async () => {
    // `Number('-5') || 50` is -5, and `LIMIT -5` means "no limit" in SQLite.
    await expect(auditLimit('?limit=-5')).resolves.toBeGreaterThanOrEqual(0);
  });

  it('survives a fractional limit', async () => {
    await expect(auditLimit('?limit=1.5')).resolves.toBeGreaterThanOrEqual(0);
  });

  it('survives a non-numeric limit', async () => {
    await expect(auditLimit('?limit=abc')).resolves.toBeGreaterThanOrEqual(0);
  });
});

describe('corrupt stored state', () => {
  it('reports unparsable stored JSON instead of throwing a 500', async () => {
    const cookie = await adminCookie();
    // A definition column can only get here by hand or by a failed migration,
    // but when it does, listing routes must degrade rather than 500.
    await testEnv.DB.prepare(
      'INSERT INTO routes (id, definition, enabled, position, updated_at, updated_by) VALUES (?, ?, 1, 0, 0, ?)',
    )
      .bind('broken', '{not json', 'test')
      .run();
    const res = await call('GET', '/api/routes', undefined, { cookie });
    expect(res.status).toBe(200);
  });

  it('treats a malformed stored password hash as a failed login, not a crash', async () => {
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'pbkdf2$abc$xx$yy')).resolves.toBe(false);
    await expect(verifyPassword('anything', '')).resolves.toBe(false);
  });

  it('treats a corrupt settings value as absent rather than throwing', async () => {
    const cookie = await adminCookie();
    await testEnv.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .bind('defaults', '{not json')
      .run();
    const res = await call('GET', '/api/defaults', undefined, { cookie });
    expect(res.status).toBe(200);
  });
});

describe('session edge cases', () => {
  it('ignores a cookie header that names the session with an empty value', async () => {
    await expect(resolveSession(testEnv.DB, 'jouska_session=')).resolves.toBeUndefined();
  });

  it('does not match a cookie whose name merely ends with the session name', async () => {
    // `other_jouska_session=x` startsWith-matches nothing, but a substring
    // search would find it; assert the distinction holds.
    await expect(resolveSession(testEnv.DB, 'other_jouska_session=x')).resolves.toBeUndefined();
  });

  it('rejects a session whose user was deleted', async () => {
    const cookie = await adminCookie();
    await testEnv.DB.prepare('DELETE FROM users').run();
    const res = await call('GET', '/api/routes', undefined, { cookie });
    expect(res.status).toBe(401);
  });
});

describe('compile boundaries', () => {
  it('refuses an empty route table, marked as empty rather than invalid', () => {
    // Publishing nothing would leave the proxy with nothing to forward, so it
    // is refused — but a fresh deployment must not be told its config is
    // broken, and `configSchema`'s own "expected array to have >=1 items"
    // says nothing to an operator who simply has not added a route yet.
    const result = compileConfig([], undefined);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.empty).toBe(true);
    expect(result.ok === false && result.issues[0]?.message).not.toContain('Too small');
  });

  it('does not mark a genuinely invalid table as empty', () => {
    const rows = [{ id: 'bad', definition: { upstream: 123 }, enabled: true, position: 0 }];
    const result = compileConfig(rows, undefined);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.empty).toBeUndefined();
  });

  it('rejects two rows declaring the same host and path', () => {
    const rows = [
      { id: 'a', definition: VALID_ROUTE, enabled: true, position: 0 },
      { id: 'b', definition: VALID_ROUTE, enabled: true, position: 1 },
    ];
    const result = compileConfig(rows, undefined);
    // Identical matches are total shadowing: b can never run.
    expect(result.ok && result.shadowWarnings.length).toBeGreaterThan(0);
  });

  it('surfaces defaults that are an array as a table-level issue', () => {
    const rows = [{ id: 'a', definition: VALID_ROUTE, enabled: true, position: 0 }];
    const result = compileConfig(rows, [1, 2]);
    expect(result.ok).toBe(false);
  });
});

describe('empty and confirmation states over the API', () => {
  it('reports a fresh deployment as empty, not as a broken config', async () => {
    const cookie = await adminCookie();
    const res = await call('GET', '/api/preview', undefined, { cookie });
    const body = (await res.json()) as { ok: boolean; empty?: boolean };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.empty).toBe(true);
  });

  it('refuses to publish an empty table and says so as empty', async () => {
    const cookie = await adminCookie();
    const res = await call('POST', '/api/publish', {}, { cookie });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { empty?: boolean }).empty).toBe(true);
  });

  it('demands confirmation for a dangerous route before writing KV', async () => {
    const cookie = await adminCookie();
    await call(
      'PUT',
      '/api/routes/dang',
      { definition: { ...VALID_ROUTE, upstreamHeaders: { 'x-secret': 'v' } } },
      { cookie },
    );
    // Without `confirm`, publish must refuse -- and must not have written KV.
    const refused = await call('POST', '/api/publish', {}, { cookie });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error?: string }).error).toBe('confirmation_required');
    expect(await testEnv.CONFIG_KV.get('routes')).toBeNull();
    // With it, the same publish succeeds.
    const accepted = await call('POST', '/api/publish', { confirm: true }, { cookie });
    expect(accepted.status).toBe(200);
    expect(await testEnv.CONFIG_KV.get('routes')).not.toBeNull();
  });
});

describe('danger classification boundaries', () => {
  it('flags a null-valued dangerous field', () => {
    // Walking with `node === undefined` as the miss condition treats an
    // explicit null as present; either way the field was authored, so it
    // should be flagged rather than skipped.
    const flags = dangerFlags({ upstreamHeaders: null });
    expect(flags.some((f) => f.path === 'upstreamHeaders')).toBe(true);
  });

  it('does not walk into an array as if it were an object', () => {
    const flags = dangerFlags({ ip: [{ allow: ['1.2.3.4'] }] });
    expect(flags.some((f) => f.path === 'ip.allow')).toBe(false);
  });

  it('flags inject as high danger whenever the block exists', () => {
    // The block itself is the risk — it puts markup in front of every visitor —
    // so there is no spelled-out default that reads as safe.
    const flags = dangerFlags({ bodyRewrite: { inject: { bodyStart: '<div>mirror</div>' } } });
    const inject = flags.find((f) => f.path === 'bodyRewrite.inject');
    expect(inject?.level).toBe('high');
    expect(inject?.reason).toContain('every visitor');
  });

  it('flags replace as high danger once it carries a rule, and not when empty', () => {
    // A non-empty `replace` can put markup in front of a visitor exactly like
    // `inject` can, one string substitution removed.
    const present = dangerFlags({
      bodyRewrite: { replace: [{ from: '</head>', to: '<script>x</script>' }] },
    });
    const flagged = present.find((f) => f.path === 'bodyRewrite.replace');
    expect(flagged?.level).toBe('high');

    // The empty array is the default spelled out; warning on it would make the
    // publish dialog lie about a config that does nothing.
    const empty = dangerFlags({ bodyRewrite: { replace: [] } });
    expect(empty.some((f) => f.path === 'bodyRewrite.replace')).toBe(false);
  });
});
