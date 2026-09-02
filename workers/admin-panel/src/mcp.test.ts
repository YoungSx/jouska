import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from './index.js';
import type { AppEnv, Env } from './env.js';

const testEnv = env as unknown as Env;
const appEnv = testEnv as unknown as AppEnv;
const base = 'https://panel.test';
const password = 'mcp-boundary-password';

const request = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  worker.fetch(
    new Request(`${base}${path}`, {
      method,
      headers: { origin: base, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    appEnv,
    {} as ExecutionContext,
  );

const loginCookie = async (): Promise<string> => {
  await request('POST', '/api/auth/bootstrap', { subject: 'root', password });
  const login = await request('POST', '/api/auth/login', { subject: 'root', password });
  return `jouska_session=${login.headers.get('set-cookie')?.split('=')[1]?.split(';')[0] ?? ''}`;
};

const mcp = async (
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> =>
  worker.fetch(
    new Request(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': String(body.method),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    appEnv,
    {} as ExecutionContext,
  );

const modernMeta = {
  _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
  },
};

const theRoute = {
  // Path patterns are plain prefixes in jouska: '/' matches every path.
  match: { host: 'app.example.com', path: '/' },
  upstream: 'app.internal.example.com',
  timeoutMs: 5000,
};

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, TEST_MIGRATIONS);
  await Promise.all(
    ['audit_log', 'sessions', 'routes', 'settings', 'mcp_tokens', 'users'].map((table) =>
      testEnv.DB.prepare(`DELETE FROM ${table}`).run(),
    ),
  );
});

describe('MCP token lifecycle', () => {
  it('returns a generated secret once, stores only its digest, and authenticates MCP', async () => {
    const cookie = await loginCookie();
    const created = await request(
      'POST',
      '/api/mcp-tokens',
      {
        name: 'Claude Code',
        scopes: ['config:read'],
        expiresInDays: 30,
      },
      { cookie },
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      token: string;
      tokenInfo: { id: string; tokenPrefix: string };
    };
    expect(createdBody.token).toMatch(/^jska_mcp_[A-Za-z0-9_-]{43}$/);
    expect(createdBody.tokenInfo.tokenPrefix).toBe(createdBody.token.slice(0, 17));
    const row = await testEnv.DB.prepare('SELECT token_hash FROM mcp_tokens WHERE id = ?')
      .bind(createdBody.tokenInfo.id)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toBeTruthy();
    expect(row?.token_hash).not.toContain(createdBody.token);

    const listed = await request('GET', '/api/mcp-tokens', undefined, { cookie });
    const listBody = (await listed.json()) as { tokens: Array<{ id: string; token?: string }> };
    expect(listBody.tokens[0]?.id).toBe(createdBody.tokenInfo.id);
    expect(listBody.tokens[0]?.token).toBeUndefined();

    const discover = await mcp(createdBody.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: modernMeta,
    });
    expect(discover.status).toBe(200);
    expect(
      ((await discover.json()) as { result: { supportedVersions: string[] } }).result
        .supportedVersions,
    ).toContain('2026-07-28');
  });

  it('accepts missing Origin for Bearer MCP but never falls back to a Cookie session', async () => {
    const cookie = await loginCookie();
    const created = await request('POST', '/api/mcp-tokens', { name: 'probe' }, { cookie });
    const token = ((await created.json()) as { token: string }).token;
    const noOrigin = await mcp(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: modernMeta,
    });
    expect(noOrigin.status).toBe(200);
    const cookieOnly = await worker.fetch(
      new Request(`${base}/mcp`, {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          'MCP-Protocol-Version': '2026-07-28',
          'Mcp-Method': 'ping',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: modernMeta }),
      }),
      appEnv,
      {} as ExecutionContext,
    );
    expect(cookieOnly.status).toBe(401);
  });

  it('enforces scopes, credits token creation to the admin, and honours revocation', async () => {
    const cookie = await loginCookie();
    const created = await request(
      'POST',
      '/api/mcp-tokens',
      { name: 'read-only', scopes: ['config:read'] },
      { cookie },
    );
    const token = (await created.json()) as { token: string; tokenInfo: { id: string } };
    const denied = await mcp(
      token.token,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { ...modernMeta, name: 'update_route', arguments: {} },
      },
      { 'Mcp-Name': 'update_route' },
    );
    const deniedBody = (await denied.json()) as {
      result?: unknown;
      error?: { code?: number; data?: { required?: string } };
    };
    // Refused at the scope gate, not merely told the arguments were wrong: a
    // tool-level `isError` would mean the write was attempted and declined
    // downstream, which is a different — and weaker — guarantee.
    expect(denied.status).toBe(200);
    expect(deniedBody.result).toBeUndefined();
    expect(deniedBody.error?.code).toBe(-32803);
    expect(deniedBody.error?.data?.required).toBe('config:write');
    const untouched = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM routes').first<{
      n: number;
    }>();
    expect(untouched?.n).toBe(0);

    const revoked = await request(
      'DELETE',
      `/api/mcp-tokens/${token.tokenInfo.id}`,
      {},
      { cookie },
    );
    expect(revoked.status).toBe(200);
    const after = await mcp(token.token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'ping',
      params: modernMeta,
    });
    expect(after.status).toBe(401);
    const audit = await testEnv.DB.prepare(
      "SELECT actor FROM audit_log WHERE action = 'mcp.token.create'",
    ).first<{ actor: string }>();
    expect(audit?.actor).toBe('root');
  });
  it('attributes writes to the acting token, not to an anonymous MCP client', async () => {
    const cookie = await loginCookie();
    const created = await request(
      'POST',
      '/api/mcp-tokens',
      { name: 'writer', scopes: ['config:read', 'config:write'] },
      { cookie },
    );
    const token = (await created.json()) as { token: string; tokenInfo: { id: string } };
    const wrote = await mcp(
      token.token,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          ...modernMeta,
          name: 'update_route',
          arguments: { id: 'app', definition: theRoute },
        },
      },
      { 'Mcp-Name': 'update_route' },
    );
    expect(wrote.status).toBe(200);
    const wroteBody = (await wrote.json()) as {
      result?: { isError?: boolean; structuredContent?: { ok?: boolean } };
    };
    expect(wroteBody.result?.isError).toBe(false);
    expect(wroteBody.result?.structuredContent?.ok).toBe(true);

    // Revoking a token only means something if its past writes can be traced
    // back to it, so the trail must carry the token id — in the actor and in
    // the row it touched, not just in the detail blob.
    const actor = `mcp:${token.tokenInfo.id}:root`;
    const entry = await testEnv.DB.prepare(
      "SELECT actor, detail FROM audit_log WHERE action = 'route.create'",
    ).first<{ actor: string; detail: string }>();
    expect(entry?.actor).toBe(actor);
    expect(JSON.parse(entry?.detail ?? '{}')).toMatchObject({
      via: 'mcp',
      tokenId: token.tokenInfo.id,
    });
    const row = await testEnv.DB.prepare('SELECT updated_by FROM routes WHERE id = ?')
      .bind('app')
      .first<{ updated_by: string }>();
    expect(row?.updated_by).toBe(actor);
  });
});
