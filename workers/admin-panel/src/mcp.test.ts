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
    // downstream, which is a different — and weaker — guarantee. The status is
    // the part a client can act on: 403 with the missing scope named is what
    // RFC 6750 asks for, and what lets a caller ask for more permission.
    expect(denied.status).toBe(403);
    expect(denied.headers.get('www-authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="config:write"',
    );
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

/**
 * The transport half of MCP: what the endpoint owes a client before any tool
 * runs. These are the rules an intermediary also reads, which is why a
 * disagreement between header and body is refused rather than resolved.
 */
describe('MCP transport conformance', () => {
  const readToken = async (): Promise<string> => {
    const cookie = await loginCookie();
    const created = await request(
      'POST',
      '/api/mcp-tokens',
      { name: 'transport', scopes: ['config:read'] },
      { cookie },
    );
    return ((await created.json()) as { token: string }).token;
  };

  const bare = async (path: string, init: RequestInit): Promise<Response> =>
    worker.fetch(
      new Request(`${base}${path}`, init) as unknown as Parameters<typeof worker.fetch>[0],
      appEnv,
      {} as ExecutionContext,
    );

  it('answers 405 to the methods this revision removed, not 404', async () => {
    // A 404 reads as "no MCP endpoint here" and sends a dual-era client off to
    // probe the deprecated HTTP+SSE transport. 405 says the endpoint exists.
    for (const method of ['GET', 'DELETE', 'PUT', 'OPTIONS']) {
      const res = await bare('/mcp', { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('refuses a body that is not application/json before parsing it', async () => {
    const token = await readToken();
    const res = await bare('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'text/plain',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'ping',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: modernMeta }),
    });
    expect(res.status).toBe(415);
  });

  it('enforces the body cap by counting bytes, not by trusting content-length', async () => {
    // A chunked upload declares no length at all, so a limit that reads the
    // header and then buffers the stream stops nothing.
    const token = await readToken();
    const oversize = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { ...modernMeta, name: 'get_config', arguments: { pad: 'x'.repeat(512 * 1024) } },
    });
    const res = await bare('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'get_config',
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversize));
          controller.close();
        },
      }),
      // @ts-expect-error streaming upload is a workerd extension to RequestInit
      duplex: 'half',
    });
    expect(res.status).toBe(413);
  });
});

describe('MCP envelope and result shape', () => {
  const writeToken = async (): Promise<string> => {
    const cookie = await loginCookie();
    const created = await request(
      'POST',
      '/api/mcp-tokens',
      { name: 'shape', scopes: ['config:read', 'config:write'] },
      { cookie },
    );
    return ((await created.json()) as { token: string }).token;
  };

  const errorOf = async (res: Response): Promise<{ code?: number; data?: unknown }> =>
    ((await res.json()) as { error?: { code?: number; data?: unknown } }).error ?? {};

  it('rejects a missing version header as a header mismatch, not as a bad version', async () => {
    // The spec files a missing standard header under header validation (-32020).
    // -32022 is for a version the server does not implement, which is a
    // different thing to tell a client. Blank counts as missing.
    const token = await writeToken();
    const absent = await worker.fetch(
      new Request(`${base}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'Mcp-Method': 'ping',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: modernMeta }),
      }),
      appEnv,
      {} as ExecutionContext,
    );
    expect(absent.status).toBe(400);
    expect((await errorOf(absent)).code).toBe(-32020);

    const blank = await mcp(
      token,
      { jsonrpc: '2.0', id: 1, method: 'ping', params: modernMeta },
      { 'MCP-Protocol-Version': '' },
    );
    expect(blank.status).toBe(400);
    expect((await errorOf(blank)).code).toBe(-32020);
  });

  it('names what it speaks when asked for a version it does not implement', async () => {
    const token = await writeToken();
    const res = await mcp(
      token,
      { jsonrpc: '2.0', id: 1, method: 'ping', params: modernMeta },
      { 'MCP-Protocol-Version': '1900-01-01' },
    );
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe(-32022);
    expect(error.data).toEqual({ supported: ['2026-07-28'], requested: '1900-01-01' });
  });

  it('answers a handshake-era initialize with the version it speaks', async () => {
    // A 2025-era client cannot send the version header on its opening request,
    // so it must not be met with a complaint about the header: the version list
    // is the only diagnostic it can put in front of a human.
    const token = await writeToken();
    const res = await worker.fetch(
      new Request(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {} },
        }),
      }),
      appEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe(-32022);
    expect(error.data).toEqual({ supported: ['2026-07-28'], requested: '2025-11-25' });
  });

  it('treats a missing required _meta field as invalid params', async () => {
    const token = await writeToken();
    const res = await mcp(token, { jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe(-32602);
  });

  it('decodes a base64-sentinel Mcp-Name before comparing it to the body', async () => {
    // Encoding is how a client carries a name that is not header-safe. Comparing
    // the encoded form byte-for-byte would reject a conforming request.
    const token = await writeToken();
    const res = await mcp(
      token,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { ...modernMeta, name: 'get_config', arguments: {} },
      },
      { 'Mcp-Name': '=?base64?Z2V0X2NvbmZpZw==?=' },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { isError: boolean } }).result.isError).toBe(false);
  });

  it('carries resultType, server identity and caching hints on every result', async () => {
    const token = await writeToken();
    const discover = await mcp(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: modernMeta,
    });
    const discoverResult = ((await discover.json()) as { result: Record<string, unknown> }).result;
    expect(discoverResult.resultType).toBe('complete');
    // Cacheable results must carry both hints; discover is the same answer for
    // everyone, tools/list is filtered by the token's scopes and must not be
    // shared between callers.
    expect(discoverResult.ttlMs).toBe(3_600_000);
    expect(discoverResult.cacheScope).toBe('public');
    expect(discoverResult._meta).toEqual({
      'io.modelcontextprotocol/serverInfo': { name: 'jouska', version: '0.2.2' },
    });

    const list = await mcp(token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: modernMeta,
    });
    const listResult = ((await list.json()) as { result: Record<string, unknown> }).result;
    expect(listResult.ttlMs).toBe(300_000);
    expect(listResult.cacheScope).toBe('private');

    const ping = await mcp(token, { jsonrpc: '2.0', id: 3, method: 'ping', params: modernMeta });
    const pingResult = ((await ping.json()) as { result: Record<string, unknown> }).result;
    expect(pingResult.resultType).toBe('complete');
    expect(pingResult.ttlMs).toBeUndefined();
  });

  it('reports an unknown tool as a protocol error, not as a tool failure', async () => {
    // A model cannot recover from this by trying different arguments, which is
    // what `isError` is for, so it belongs in the JSON-RPC error channel.
    const token = await writeToken();
    const res = await mcp(
      token,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { ...modernMeta, name: 'publish_config', arguments: {} },
      },
      { 'Mcp-Name': 'publish_config' },
    );
    const body = (await res.json()) as { result?: unknown; error?: { code?: number } };
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32602);
  });
});

describe('MCP draft tools', () => {
  const writeToken = async (): Promise<string> => {
    const cookie = await loginCookie();
    const created = await request(
      'POST',
      '/api/mcp-tokens',
      { name: 'draft', scopes: ['config:read', 'config:write'] },
      { cookie },
    );
    return ((await created.json()) as { token: string }).token;
  };

  const callTool = async (
    token: string,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const res = await mcp(
      token,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { ...modernMeta, name, arguments: args },
      },
      { 'Mcp-Name': name },
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: { structuredContent: Record<string, unknown> } }).result
      .structuredContent;
  };

  it('shows an agent the same preview the panel shows, mirror advisory included', async () => {
    // The MCP preview used to be a hand-written copy of the panel's and had
    // already lost `mirrorWarnings`, so an agent reviewing its own draft could
    // not see that a whole-site route would ship without link rewriting — the
    // one warning it is best placed to report.
    const token = await writeToken();
    await callTool(token, 'update_route', { id: 'app', definition: theRoute });
    const preview = await callTool(token, 'preview_config');
    expect(preview.ok).toBe(true);
    expect(preview.mirrorWarnings).toEqual([
      { routeId: 'app', upstream: 'app.internal.example.com' },
    ]);
    expect(preview.dirty).toBe(true);
  });

  it('keeps a disabled route disabled when enabled is omitted', async () => {
    // Defaulting to `true` would put a route into production traffic as a side
    // effect of editing an unrelated field.
    const token = await writeToken();
    await callTool(token, 'update_route', { id: 'app', definition: theRoute, enabled: false });
    const edited = await callTool(token, 'update_route', {
      id: 'app',
      definition: { ...theRoute, timeoutMs: 9000 },
    });
    expect(edited.enabled).toBe(false);
    const row = await testEnv.DB.prepare('SELECT enabled FROM routes WHERE id = ?')
      .bind('app')
      .first<{ enabled: number }>();
    expect(row?.enabled).toBe(0);
  });
});
