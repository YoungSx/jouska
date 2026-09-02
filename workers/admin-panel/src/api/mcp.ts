/**
 * Stateless Streamable HTTP MCP endpoint, protocol revision 2026-07-28.
 *
 * The wire rules live in `mcp-protocol.ts`; this file is the surface: which
 * tools exist, which scope each one costs, and what they do to the draft. No
 * tool publishes — that stays behind a Cookie session, an admin, and a human
 * confirmation.
 */
import { Hono } from 'hono';
import { discoverDomains } from './domains.js';
import { previewDraft } from '../preview.js';
import type { AppEnv } from '../env.js';
import {
  audit,
  deleteRoute,
  getRoute,
  getSetting,
  listAllRoutes,
  listAudit,
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
  routeIdFrom,
  strictBoolean,
} from '../validate.js';
import {
  INSUFFICIENT_SCOPE,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  isJsonMediaType,
  MCP_BODY_MAX_BYTES,
  MCP_SUPPORTED_VERSIONS,
  mcpJson,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  readBoundedBody,
  record,
  rpcError,
  rpcResult,
  validateEnvelope,
} from '../mcp-protocol.js';

interface AuthenticatedMcp {
  readonly id: string;
  readonly userId: number;
  readonly subject: string;
  readonly scopes: readonly McpScope[];
}

/**
 * One tool, one required scope, one definition.
 *
 * The table is the single source of truth for both `tools/list` and the gate in
 * front of `tools/call`. Kept as one list because the failure mode of two lists
 * is a tool that is advertised but ungated, or gated but invisible — and both
 * read as working.
 */
interface ToolSpec {
  readonly name: string;
  readonly scope: McpScope;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const NO_ARGUMENTS = { type: 'object', properties: {}, additionalProperties: false } as const;

const TOOLS: readonly ToolSpec[] = [
  {
    name: 'get_config',
    scope: 'config:read',
    title: '读取草稿配置',
    description: '读取当前路由草稿和全局默认值。草稿不会自动上线。',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'preview_config',
    scope: 'config:read',
    title: '预览配置',
    description:
      '编译并检查草稿，返回校验问题、遮蔽警告、整站代理未开改写的告警和危险字段。不会发布。',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'update_route',
    scope: 'config:write',
    title: '修改路由草稿',
    description:
      '创建或修改一条路由草稿。省略 enabled 时保留该路由现有的启用状态，新建时默认启用。保存后仍需人在 dashboard 中发布。',
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
    scope: 'config:write',
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
    scope: 'config:write',
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
    scope: 'config:write',
    title: '修改全局默认值',
    description: '替换草稿的全局默认值；线上配置在人工发布前不变。',
    inputSchema: {
      type: 'object',
      properties: { defaults: { type: 'object' } },
      required: ['defaults'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_domains',
    scope: 'domains:read',
    title: '读取绑定域名',
    description: '读取反代 Worker 当前可达的 workers.dev、自定义域和 zone route。',
    inputSchema: NO_ARGUMENTS,
  },
  {
    name: 'list_audit',
    scope: 'audit:read',
    title: '读取审计日志',
    description: '读取最近的配置与凭据生命周期审计记录。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/**
 * Tools the calling token may see. The spec allows the list to vary by the
 * authorization on the request — it must not vary by anything else, which is
 * why `tools/list` is cached `private`.
 */
const toolDefinitions = (auth: AuthenticatedMcp): readonly Record<string, unknown>[] =>
  TOOLS.filter((tool) => auth.scopes.includes(tool.scope)).map(
    ({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }),
  );

/**
 * What a tool call produced. `denied` and `unknown` are separated from `result`
 * because they leave the tool: an insufficient scope is an HTTP 403 with a
 * challenge, and an unknown tool is a protocol error — neither is something a
 * model can fix by adjusting arguments, which is what `isError` is for.
 */
type ToolOutcome =
  | { readonly kind: 'result'; readonly value: Record<string, unknown> }
  | { readonly kind: 'denied'; readonly scope: McpScope }
  | { readonly kind: 'unknown'; readonly name: string };

const contentResult = (value: unknown, isError = false): ToolOutcome => ({
  kind: 'result',
  value: {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    isError,
    structuredContent: value,
  },
});

/** Input the model can correct: reported inside the result, per the spec. */
const inputError = (detail?: string): ToolOutcome =>
  contentResult({ error: 'invalid_input', ...(detail === undefined ? {} : { detail }) }, true);

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

const unauthorized = (): Response =>
  mcpJson({ error: 'invalid_token' }, 401, {
    'www-authenticate': 'Bearer realm="jouska-mcp", error="invalid_token"',
  });

const authenticate = async (
  request: Request,
  env: AppEnv['Bindings'],
): Promise<AuthenticatedMcp | Response> => {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '');
  if (match === null || !tokenLooksValid(match[1]!)) return unauthorized();
  const auth = await resolveMcpToken(
    env.DB,
    await sha256Hex(match[1]!),
    Math.floor(Date.now() / 1000),
  );
  return auth ?? unauthorized();
};

const callTool = async (
  env: AppEnv['Bindings'],
  auth: AuthenticatedMcp,
  name: string,
  argumentsValue: unknown,
): Promise<ToolOutcome> => {
  const spec = TOOLS_BY_NAME.get(name);
  if (spec === undefined) return { kind: 'unknown', name };
  if (!auth.scopes.includes(spec.scope)) return { kind: 'denied', scope: spec.scope };
  const args = record(argumentsValue) ?? {};
  const actor = actorForMcp(auth.id, auth.subject);

  if (name === 'get_config') {
    return contentResult({
      routes: await listAllRoutes(env.DB),
      defaults: (await getSetting(env.DB, 'defaults')) ?? null,
    });
  }
  if (name === 'preview_config') {
    return contentResult(await previewDraft(env.DB));
  }
  if (name === 'update_route') {
    const id = routeIdFrom(args.id);
    const definition = args.definition;
    if (id === undefined || !isPlainObject(definition)) {
      return inputError('id and an object definition are required');
    }
    const size = jsonByteLength(definition);
    if (size === undefined || size > MAX_DEFINITION_BYTES) {
      return inputError(`definition must be at most ${MAX_DEFINITION_BYTES} bytes`);
    }
    const existing = await getRoute(env.DB, id);
    // Omitted `enabled` keeps whatever the route has now. Defaulting to `true`
    // would let an edit to a disabled route put it into production traffic as a
    // side effect of touching an unrelated field.
    const enabled =
      args.enabled === undefined ? (existing?.enabled ?? true) : strictBoolean(args.enabled);
    if (enabled === undefined) return inputError('enabled must be a boolean');
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
    const id = routeIdFrom(args.id);
    if (id === undefined) return inputError('id is required');
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
    if (!Array.isArray(args.ids) || !args.ids.every((id) => typeof id === 'string')) {
      return inputError('ids must be an array of route ids');
    }
    const ids = args.ids as string[];
    const known = new Set((await listAllRoutes(env.DB)).map((route) => route.id));
    if (
      ids.length !== known.size ||
      new Set(ids).size !== ids.length ||
      !ids.every((id) => known.has(id))
    ) {
      return inputError('ids must be a permutation of all route ids');
    }
    await reorderRoutes(env.DB, ids, actor);
    await audit(env.DB, actor, 'routes.reorder', undefined, { via: 'mcp', tokenId: auth.id, ids });
    return contentResult({ ok: true });
  }
  if (name === 'update_defaults') {
    const defaults = args.defaults;
    const size = jsonByteLength(defaults);
    if (!isPlainObject(defaults) || size === undefined || size > MAX_DEFAULTS_BYTES) {
      return inputError(`defaults must be an object of at most ${MAX_DEFAULTS_BYTES} bytes`);
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
    return contentResult(await discoverDomains(env, env.DB));
  }
  if (name === 'list_audit') {
    const rawLimit = args.limit;
    const limit =
      typeof rawLimit === 'number' && Number.isInteger(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 200)
        : 50;
    return contentResult({ entries: await listAudit(env.DB, limit) });
  }
  // Unreachable: the table gate above rejects any name without a branch here.
  // Reported as unknown rather than falling through to a neighbouring tool,
  // which is how a new entry in the table would otherwise misbehave.
  return { kind: 'unknown', name };
};

export const mcpRoutes = new Hono<AppEnv>();

/**
 * This revision removed the GET stream and protocol-level sessions, so GET and
 * DELETE are answered `405` — "the endpoint is here, it just does not do that".
 * A `404` would read as "no MCP endpoint" and send a dual-era client off to
 * probe the deprecated HTTP+SSE transport instead.
 */
mcpRoutes.on(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], '/mcp', () =>
  mcpJson({ error: 'method_not_allowed' }, 405, { allow: 'POST' }),
);

mcpRoutes.post('/mcp', async (c) => {
  const request = c.req.raw;
  if (!mcpOriginAllowed(request, c.env.PANEL_URL)) {
    return mcpJson({ error: 'forbidden_origin' }, 403);
  }
  if (!isJsonMediaType(request.headers.get('content-type'))) {
    return mcpJson(
      { error: 'unsupported_media_type', detail: 'content-type must be application/json' },
      415,
    );
  }
  // Authenticate before reading the body: an unauthenticated caller must not be
  // able to make this Worker buffer and decode 256 kB.
  const auth = await authenticate(request, c.env);
  if (auth instanceof Response) return auth;

  const read = await readBoundedBody(request, MCP_BODY_MAX_BYTES);
  if (!read.ok) {
    return read.reason === 'too_large'
      ? mcpJson(
          {
            error: 'request_too_large',
            detail: `body must be at most ${MCP_BODY_MAX_BYTES} bytes`,
          },
          413,
        )
      : rpcError(undefined, PARSE_ERROR, 'Parse error', undefined, 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return rpcError(undefined, PARSE_ERROR, 'Parse error', undefined, 400);
  }
  const envelope = validateEnvelope(request, parsed);
  if (envelope instanceof Response) return envelope;
  const { id, method, params, toolName } = envelope;
  // A notification carries no id and gets no body — only an acknowledgement.
  if (id === undefined) return new Response(null, { status: 202 });

  if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
    c.executionCtx.waitUntil(
      touchMcpToken(c.env.DB, auth.id, Math.floor(Date.now() / 1000)).catch(() => undefined),
    );
  }

  if (method === 'server/discover') {
    return rpcResult(id, method, {
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      instructions: '读取或修改 jouska 草稿配置。修改不会自动发布到生产。',
    });
  }
  if (method === 'ping') return rpcResult(id, method, {});
  if (method === 'tools/list') return rpcResult(id, method, { tools: toolDefinitions(auth) });
  if (method === 'tools/call' && toolName !== undefined) {
    let outcome: ToolOutcome;
    try {
      outcome = await callTool(c.env, auth, toolName, params?.arguments);
    } catch (error) {
      console.error('admin-panel: mcp tool error', error);
      return rpcError(id, INTERNAL_ERROR, 'Internal error');
    }
    if (outcome.kind === 'denied') {
      // 403 with the scope named, per RFC 6750: a client that can ask for more
      // permission needs to be told which one, and a 200 tells it nothing.
      return rpcError(
        id,
        INSUFFICIENT_SCOPE,
        'Insufficient scope',
        { required: outcome.scope },
        403,
        {
          'www-authenticate': `Bearer error="insufficient_scope", scope="${outcome.scope}"`,
        },
      );
    }
    if (outcome.kind === 'unknown') {
      return rpcError(id, INVALID_PARAMS, `Unknown tool: ${outcome.name}`);
    }
    return rpcResult(id, method, outcome.value);
  }
  return rpcError(id, METHOD_NOT_FOUND, 'Method not found', undefined, 404);
});
