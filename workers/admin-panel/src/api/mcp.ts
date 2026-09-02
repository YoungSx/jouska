/** Stateless Streamable HTTP MCP endpoint. */
import { Hono } from 'hono';
import { compileConfig, type RouteRow } from '../compile.js';
import { dangerFlags } from '../danger.js';
import { documentDigest, LIVE_KEY, asLiveState } from '../fingerprint.js';
import { discoverDomains } from './domains.js';
import type { AppEnv } from '../env.js';
import {
  audit,
  deleteRoute,
  getRoute,
  getSetting,
  listAllRoutes,
  listAudit,
  listEnabledRoutes,
  putSetting,
  reorderRoutes,
  resolveMcpToken,
  touchMcpToken,
  upsertRoute,
} from '../store.js';
import { actorForMcp, sha256Hex, tokenLooksValid, type McpScope } from '../mcp-token.js';
import {
  isPlainObject,
  jsonByteLength,
  MAX_DEFAULTS_BYTES,
  MAX_DEFINITION_BYTES,
  strictBoolean,
} from '../validate.js';

const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSION = '2025-11-25';
const SUPPORTED_VERSIONS = [MODERN_VERSION, LEGACY_VERSION] as const;
const JSON_RPC = '2.0';
const MCP_ERROR_HEADER_MISMATCH = -32020;
const MCP_ERROR_UNSUPPORTED_VERSION = -32022;
const APP_ERROR_FORBIDDEN = -32803;
const MAX_MCP_BODY_BYTES = 256 * 1024;

type RpcId = string | number;
type RpcRequest = {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
};

interface AuthenticatedMcp {
  readonly id: string;
  readonly userId: number;
  readonly subject: string;
  readonly scopes: readonly McpScope[];
}

const response = (
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extraHeaders },
  });

const rpcResult = (id: RpcId, result: Record<string, unknown>): Response =>
  response({ jsonrpc: JSON_RPC, id, result });

const rpcError = (
  id: RpcId | undefined,
  code: number,
  message: string,
  data?: unknown,
  status = 200,
): Response =>
  response(
    {
      jsonrpc: JSON_RPC,
      ...(id === undefined ? {} : { id }),
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
    status,
  );

const invalidRequest = (message: string, id?: RpcId): Response =>
  rpcError(id, -32600, message, undefined, 400);

const isRpcId = (value: unknown): value is RpcId =>
  (typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))) &&
  value !== null;

const record = (value: unknown): Record<string, unknown> | undefined =>
  isPlainObject(value) ? value : undefined;

const hasScope = (auth: AuthenticatedMcp, scope: McpScope): boolean => auth.scopes.includes(scope);

const requireScope = (auth: AuthenticatedMcp, scope: McpScope): Response | undefined =>
  hasScope(auth, scope)
    ? undefined
    : rpcError(undefined, APP_ERROR_FORBIDDEN, 'Insufficient scope', { required: scope });

const contentResult = (value: unknown, isError = false): Record<string, unknown> => ({
  resultType: 'complete',
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : { isError: false }),
  structuredContent: value,
});

const mcpOriginAllowed = (request: Request, panelUrl: string | undefined): boolean => {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    const originHost = new URL(origin).host;
    const allowed = new Set([new URL(request.url).host]);
    if (panelUrl !== undefined) allowed.add(new URL(panelUrl).host);
    return allowed.has(originHost);
  } catch {
    return false;
  }
};

const authenticate = async (
  request: Request,
  env: AppEnv['Bindings'],
): Promise<AuthenticatedMcp | Response> => {
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (match === null || !tokenLooksValid(match[1]!)) {
    return response({ error: 'invalid_token' }, 401, {
      'www-authenticate': `Bearer realm="jouska-mcp", error="invalid_token"`,
    });
  }
  const auth = await resolveMcpToken(
    env.DB,
    await sha256Hex(match[1]!),
    Math.floor(Date.now() / 1000),
  );
  if (auth === undefined) {
    return response({ error: 'invalid_token' }, 401, {
      'www-authenticate': `Bearer realm="jouska-mcp", error="invalid_token"`,
    });
  }
  return auth;
};

const toolDefinitions = (auth: AuthenticatedMcp): readonly Record<string, unknown>[] => {
  const tools: Record<string, unknown>[] = [];
  if (hasScope(auth, 'config:read')) {
    tools.push(
      {
        name: 'get_config',
        title: '读取草稿配置',
        description: '读取当前路由草稿和全局默认值。草稿不会自动上线。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'preview_config',
        title: '预览配置',
        description: '编译并检查草稿，返回校验问题、遮蔽警告和危险字段。不会发布。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    );
  }
  if (hasScope(auth, 'config:write')) {
    tools.push(
      {
        name: 'update_route',
        title: '修改路由草稿',
        description: '创建或修改一条路由草稿。保存后仍需人在 dashboard 中发布。',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
            definition: { type: 'object' },
            enabled: { type: 'boolean' },
          },
          required: ['id', 'definition'],
          additionalProperties: false,
        },
      },
      {
        name: 'delete_route',
        title: '删除路由草稿',
        description: '从草稿中删除一条路由；线上配置在人工发布前不变。',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      {
        name: 'reorder_routes',
        title: '调整路由顺序',
        description: '按给定 ID 顺序调整草稿优先级。',
        inputSchema: {
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1 } },
          required: ['ids'],
          additionalProperties: false,
        },
      },
      {
        name: 'update_defaults',
        title: '修改全局默认值',
        description: '替换草稿的全局默认值；线上配置在人工发布前不变。',
        inputSchema: {
          type: 'object',
          properties: { defaults: { type: 'object' } },
          required: ['defaults'],
          additionalProperties: false,
        },
      },
    );
  }
  if (hasScope(auth, 'domains:read')) {
    tools.push({
      name: 'list_domains',
      title: '读取绑定域名',
      description: '读取反代 Worker 当前可达的 workers.dev、自定义域和 zone route。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    });
  }
  if (hasScope(auth, 'audit:read')) {
    tools.push({
      name: 'list_audit',
      title: '读取审计日志',
      description: '读取最近的配置与凭据生命周期审计记录。',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
        additionalProperties: false,
      },
    });
  }
  return tools;
};

const preview = async (env: AppEnv['Bindings']): Promise<Record<string, unknown>> => {
  const rows: RouteRow[] = await listEnabledRoutes(env.DB);
  const defaults = await getSetting(env.DB, 'defaults');
  const live = asLiveState(await getSetting(env.DB, LIVE_KEY));
  const compiled = compileConfig(rows, defaults);
  if (!compiled.ok) {
    return {
      ok: false,
      issues: compiled.issues,
      ...(compiled.empty === true ? { empty: true } : {}),
      live: live === undefined ? null : { revision: live.revision },
      dirty: !(compiled.empty === true && live === undefined),
    };
  }
  const dangers: Record<string, unknown> = {};
  for (const row of rows) {
    if (isPlainObject(row.definition)) {
      const flags = dangerFlags(row.definition);
      if (flags.length > 0) dangers[row.id] = flags;
    }
  }
  const digest = await documentDigest(compiled.document);
  return {
    ok: true,
    document: compiled.document,
    shadowWarnings: compiled.shadowWarnings,
    dangers,
    routeCount: rows.length,
    live: live === undefined ? null : { revision: live.revision },
    dirty: live === undefined || live.digest !== digest,
  };
};

const callTool = async (
  env: AppEnv['Bindings'],
  auth: AuthenticatedMcp,
  name: string,
  argumentsValue: unknown,
): Promise<Record<string, unknown>> => {
  const args = record(argumentsValue) ?? {};
  const actor = actorForMcp(auth.id, auth.subject);
  if (name === 'get_config') {
    const denied = requireScope(auth, 'config:read');
    if (denied) throw denied;
    return contentResult({
      routes: await listAllRoutes(env.DB),
      defaults: (await getSetting(env.DB, 'defaults')) ?? null,
    });
  }
  if (name === 'preview_config') {
    const denied = requireScope(auth, 'config:read');
    if (denied) throw denied;
    return contentResult(await preview(env));
  }
  if (name === 'update_route') {
    const denied = requireScope(auth, 'config:write');
    if (denied) throw denied;
    const id =
      typeof args.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(args.id)
        ? args.id
        : undefined;
    const definition = args.definition;
    const enabled = args.enabled === undefined ? true : strictBoolean(args.enabled);
    if (id === undefined || !isPlainObject(definition) || enabled === undefined) {
      return contentResult(
        {
          error: 'invalid_input',
          detail: 'id, object definition and boolean enabled are required',
        },
        true,
      );
    }
    const size = jsonByteLength(definition);
    if (size === undefined || size > MAX_DEFINITION_BYTES) {
      return contentResult(
        {
          error: 'invalid_input',
          detail: `definition must be at most ${MAX_DEFINITION_BYTES} bytes`,
        },
        true,
      );
    }
    const existing = await getRoute(env.DB, id);
    const position =
      existing === undefined ? (await listAllRoutes(env.DB)).length : existing.position;
    await upsertRoute(env.DB, id, definition, enabled, position, actor);
    await audit(env.DB, actor, existing === undefined ? 'route.create' : 'route.update', id, {
      via: 'mcp',
      tokenId: auth.id,
      definition,
      enabled,
    });
    return contentResult({ ok: true, id, enabled });
  }
  if (name === 'delete_route') {
    const denied = requireScope(auth, 'config:write');
    if (denied) throw denied;
    const id =
      typeof args.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(args.id)
        ? args.id
        : undefined;
    if (id === undefined) return contentResult({ error: 'invalid_input' }, true);
    const existing = await getRoute(env.DB, id);
    if (existing === undefined) return contentResult({ error: 'not_found' }, true);
    await deleteRoute(env.DB, id);
    await audit(env.DB, actor, 'route.delete', id, {
      via: 'mcp',
      tokenId: auth.id,
      definition: existing.definition,
    });
    return contentResult({ ok: true, id });
  }
  if (name === 'reorder_routes') {
    const denied = requireScope(auth, 'config:write');
    if (denied) throw denied;
    if (!Array.isArray(args.ids) || !args.ids.every((id) => typeof id === 'string')) {
      return contentResult({ error: 'invalid_input' }, true);
    }
    const ids = args.ids as string[];
    const known = new Set((await listAllRoutes(env.DB)).map((route) => route.id));
    if (
      ids.length !== known.size ||
      new Set(ids).size !== ids.length ||
      !ids.every((id) => known.has(id))
    ) {
      return contentResult(
        { error: 'invalid_input', detail: 'ids must be a permutation of all route ids' },
        true,
      );
    }
    await reorderRoutes(env.DB, ids, actor);
    await audit(env.DB, actor, 'routes.reorder', undefined, { via: 'mcp', tokenId: auth.id, ids });
    return contentResult({ ok: true });
  }
  if (name === 'update_defaults') {
    const denied = requireScope(auth, 'config:write');
    if (denied) throw denied;
    const defaults = args.defaults;
    const size = jsonByteLength(defaults);
    if (!isPlainObject(defaults) || size === undefined || size > MAX_DEFAULTS_BYTES) {
      return contentResult({ error: 'invalid_input' }, true);
    }
    await putSetting(env.DB, 'defaults', defaults);
    await audit(env.DB, actor, 'defaults.update', undefined, {
      via: 'mcp',
      tokenId: auth.id,
      defaults,
    });
    return contentResult({ ok: true });
  }
  if (name === 'list_domains') {
    const denied = requireScope(auth, 'domains:read');
    if (denied) throw denied;
    return contentResult(await discoverDomains(env, env.DB));
  }
  if (name === 'list_audit') {
    const denied = requireScope(auth, 'audit:read');
    if (denied) throw denied;
    const rawLimit = args.limit;
    const limit =
      typeof rawLimit === 'number' && Number.isInteger(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 200)
        : 50;
    return contentResult({ entries: await listAudit(env.DB, limit) });
  }
  return contentResult({ error: 'unknown_tool', name }, true);
};

export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.post('/mcp', async (c) => {
  if (!mcpOriginAllowed(c.req.raw, c.env.PANEL_URL))
    return response({ error: 'forbidden_origin' }, 403);
  const contentLength = Number(c.req.header('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_MCP_BODY_BYTES) {
    return response({ error: 'request_too_large' }, 413);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth instanceof Response) return auth;

  const version = c.req.header('MCP-Protocol-Version');
  if (
    version === undefined ||
    !SUPPORTED_VERSIONS.includes(version as (typeof SUPPORTED_VERSIONS)[number])
  ) {
    return rpcError(
      undefined,
      MCP_ERROR_UNSUPPORTED_VERSION,
      'Unsupported protocol version',
      {
        supported: SUPPORTED_VERSIONS,
        requested: version ?? null,
      },
      400,
    );
  }
  let body: RpcRequest;
  try {
    const parsed: unknown = await c.req.json();
    if (!isPlainObject(parsed)) return invalidRequest('Request must be a JSON object');
    body = parsed as RpcRequest;
  } catch {
    return response({ jsonrpc: JSON_RPC, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  const method = typeof body.method === 'string' ? body.method : undefined;
  const id = isRpcId(body.id) ? body.id : undefined;
  if (
    body.jsonrpc !== JSON_RPC ||
    method === undefined ||
    (body.id !== undefined && !isRpcId(body.id))
  ) {
    return invalidRequest('Invalid JSON-RPC request', id);
  }

  const meta = record(record(body.params)?._meta);
  if (version === MODERN_VERSION) {
    const metaVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
    const capabilities = meta?.['io.modelcontextprotocol/clientCapabilities'];
    if (metaVersion !== version) {
      return response(
        {
          jsonrpc: JSON_RPC,
          ...(id === undefined ? {} : { id }),
          error: {
            code: MCP_ERROR_HEADER_MISMATCH,
            message: 'Header does not match request metadata protocol version',
          },
        },
        400,
      );
    }
    if (!isPlainObject(capabilities)) {
      return rpcError(id, -32602, 'Missing or mismatched request metadata', undefined, 400);
    }
  }
  if (version === MODERN_VERSION && c.req.header('Mcp-Method') !== method) {
    return response(
      {
        jsonrpc: JSON_RPC,
        ...(id === undefined ? {} : { id }),
        error: {
          code: MCP_ERROR_HEADER_MISMATCH,
          message: 'Header does not match request method',
        },
      },
      400,
    );
  }
  const name = record(body.params)?.name;
  if (method === 'tools/call') {
    if (typeof name !== 'string') {
      return rpcError(id, -32602, 'Tool name is required', undefined, 400);
    }
    if (version === MODERN_VERSION && c.req.header('Mcp-Name') !== name) {
      return response(
        {
          jsonrpc: JSON_RPC,
          ...(id === undefined ? {} : { id }),
          error: {
            code: MCP_ERROR_HEADER_MISMATCH,
            message: 'Header does not match tool name',
          },
        },
        400,
      );
    }
  }
  if (id === undefined) {
    // Notifications are accepted by the transport and have no response body.
    return new Response(null, { status: 202 });
  }

  if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
    c.executionCtx.waitUntil(
      touchMcpToken(c.env.DB, auth.id, Math.floor(Date.now() / 1000)).catch(() => undefined),
    );
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'jouska', version: '0.2.2' } },
      instructions: '读取或修改 jouska 草稿配置。修改不会自动发布到生产。',
    });
  }
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'jouska', version: '0.2.2' },
    });
  }
  if (method === 'ping') return rpcResult(id, { resultType: 'complete' });
  if (method === 'tools/list') {
    return rpcResult(id, {
      resultType: 'complete',
      tools: toolDefinitions(auth),
      ttlMs: 300000,
      cacheScope: 'private',
    });
  }
  if (method === 'tools/call') {
    try {
      const params = record(body.params);
      const result = await callTool(c.env, auth, name as string, params?.arguments);
      return rpcResult(id, result);
    } catch (error) {
      if (error instanceof Response)
        return response({ ...((await error.json()) as Record<string, unknown>), id }, 200);
      console.error('admin-panel: mcp tool error', error);
      return rpcError(id, -32603, 'Internal error');
    }
  }
  return response(
    { jsonrpc: JSON_RPC, id, error: { code: -32601, message: 'Method not found' } },
    404,
  );
});
