/**
 * 面板 API 客户端。
 *
 * 面板与 API 同源部署，所以 Cookie 自动携带，浏览器自动加 Origin，CSRF 由服务端
 * 的同源校验把关 —— 这里不需要也不应该自己造 token。
 *
 * 服务端的错误形状是统一的 `{ error, detail?, ... }`，所以失败一律抛
 * `ApiError`，把 `error` 码原样带出来；调用方按码分派文案，而不是去匹配人类可读
 * 的句子（那种匹配会在后端改一个字时静默失效）。
 */
import type {
  CacheVaryWarning,
  FieldRisk,
  Issue,
  MirrorWarning,
  RouteDefinition,
  ShadowWarning,
} from './types';

export class ApiError extends Error {
  /** 服务端的错误码，例如 invalid_credentials、confirmation_required。 */
  readonly code: string;
  readonly status: number;
  /** 完整响应体，供需要 dangers / retryAfterSeconds 等字段的调用方读取。 */
  readonly body: Record<string, unknown>;

  constructor(code: string, status: number, body: Record<string, unknown>) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

/** 网络层就没走通（离线、面板正在部署），区别于服务端返回了错误。 */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('network_error');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

const request = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> => {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      // 同源，Cookie 自动带；显式写上以防将来被部署到子路径时行为漂移。
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }

  // 204 和非 JSON 响应（例如 SPA 兜底返回的 index.html）都不能直接 .json()。
  let payload: Record<string, unknown> = {};
  const text = await res.text();
  if (text !== '') {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      /* 非 JSON：下面按状态码处理，payload 留空 */
    }
  }

  if (!res.ok) {
    const code = typeof payload.error === 'string' ? payload.error : `http_${res.status}`;
    throw new ApiError(code, res.status, payload);
  }
  return payload;
};

/* ---------- 认证 ---------- */

export type Role = 'admin' | 'viewer';

export interface User {
  readonly subject: string;
  readonly role: Role;
}

export interface MeResult {
  readonly user: User | null;
  /** 只在 users 表为空时为 true —— 首次部署的引导表单靠它决定是否出现。 */
  readonly bootstrapable: boolean;
}

const asUser = (raw: unknown): User | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.subject !== 'string') {
    return null;
  }
  return { subject: record.subject, role: record.role === 'viewer' ? 'viewer' : 'admin' };
};

export const api = {
  me: async (): Promise<MeResult> => {
    const data = await request('GET', '/api/auth/me');
    return { user: asUser(data.user), bootstrapable: data.bootstrapable === true };
  },

  /**
   * 修改自己的密码。成功后当前会话保留（服务端只吊销其他会话），所以不重置
   * 会话状态 —— SPA 缓存的身份仍然有效，弹窗自己负责把结果说清楚。
   */
  changePassword: async (currentPassword: string, newPassword: string): Promise<void> => {
    await request('POST', '/api/auth/password', { currentPassword, newPassword });
  },

  bootstrap: async (subject: string, password: string): Promise<void> => {
    await request('POST', '/api/auth/bootstrap', { subject, password });
  },

  login: async (subject: string, password: string): Promise<User> => {
    const data = await request('POST', '/api/auth/login', { subject, password });
    // 角色以服务端返回为准；bootstrap 刚建的号也不假设一定是 admin。
    return asUser(data.user) ?? { subject, role: 'admin' };
  },

  logout: async (): Promise<void> => {
    await request('POST', '/api/auth/logout');
  },

  /**
   * 带外恢复：用 settings 表里的一次性令牌重置密码。
   *
   * 服务端刻意不区分「没开窗口 / 令牌不对 / 已过期 / 账号名不对」，全部回
   * `recovery_unavailable` —— 前端也不能替它猜，否则就把它刻意隐藏的信息泄回去了。
   */
  recover: async (subject: string, token: string, password: string): Promise<void> => {
    await request('POST', '/api/auth/recover', { subject, token, password });
  },

  /* ---------- 路由 ---------- */

  listRoutes: async (): Promise<RouteEntry[]> => {
    const data = await request('GET', '/api/routes');
    return Array.isArray(data.routes) ? (data.routes as RouteEntry[]) : [];
  },

  putRoute: async (id: string, definition: RouteDefinition, enabled: boolean): Promise<void> => {
    await request('PUT', `/api/routes/${encodeURIComponent(id)}`, { definition, enabled });
  },

  deleteRoute: async (id: string): Promise<void> => {
    await request('DELETE', `/api/routes/${encodeURIComponent(id)}`);
  },

  reorderRoutes: async (ids: readonly string[]): Promise<void> => {
    await request('PUT', '/api/routes-order', { ids });
  },

  /* ---------- defaults ---------- */

  getDefaults: async (): Promise<Record<string, unknown> | null> => {
    const data = await request('GET', '/api/defaults');
    const value = data.defaults;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  },

  putDefaults: async (defaults: Record<string, unknown>): Promise<void> => {
    await request('PUT', '/api/defaults', { defaults });
  },

  /* ---------- 预览与发布 ---------- */

  preview: async (): Promise<PreviewResult> => {
    return (await request('GET', '/api/preview')) as unknown as PreviewResult;
  },

  /**
   * 发布。`confirm` 只有在用户已经在弹窗里认过危险开关之后才为 true ——
   * 第一次就带 true 等于把服务端的二次确认绕过去了。
   */
  publish: async (note: string | undefined, confirm: boolean): Promise<{ revision: number }> => {
    const data = await request('POST', '/api/publish', {
      ...(note === undefined || note === '' ? {} : { note }),
      ...(confirm ? { confirm: true } : {}),
    });
    return { revision: typeof data.revision === 'number' ? data.revision : 0 };
  },

  /* ---------- 用户管理（admin only） ---------- */

  listUsers: async (): Promise<UserEntry[]> => {
    const data = await request('GET', '/api/users');
    return Array.isArray(data.users) ? (data.users as UserEntry[]) : [];
  },

  /** role 不传时服务端缺省 viewer：一次点击不该造出一个管理员。 */
  createUser: async (subject: string, password: string, role: Role): Promise<void> => {
    await request('POST', '/api/users', { subject, password, role });
  },

  updateUser: async (
    id: number,
    patch: { readonly role?: Role; readonly disabled?: boolean; readonly unlock?: boolean },
  ): Promise<void> => {
    await request('PATCH', `/api/users/${String(id)}`, patch);
  },

  deleteUser: async (id: number): Promise<void> => {
    await request('DELETE', `/api/users/${String(id)}`);
  },

  /* ---------- 审计 ---------- */

  audit: async (limit: number): Promise<AuditEntry[]> => {
    const data = await request('GET', `/api/audit?limit=${String(limit)}`);
    return Array.isArray(data.entries) ? (data.entries as AuditEntry[]) : [];
  },

  /* ---------- 发布历史与回滚 ---------- */

  listRevisions: async (): Promise<RevisionEntry[]> => {
    const data = await request('GET', '/api/revisions');
    return Array.isArray(data.entries) ? asRevisions(data.entries) : [];
  },

  diffRevisions: async (from: number, to: number): Promise<DiffEntry[]> => {
    const data = await request('GET', `/api/revisions/diff?from=${String(from)}&to=${String(to)}`);
    return Array.isArray(data.entries) ? asDiffEntries(data.entries) : [];
  },

  /**
   * 回滚。`confirm` 语义与发布完全相同：只有用户已在弹窗里认过危险开关之后
   * 才为 true —— 第一次就带 true 等于把服务端的二次确认绕过去了。
   */
  rollback: async (
    sourceRevision: number,
    note: string | undefined,
    confirm: boolean,
  ): Promise<{ revision: number }> => {
    const data = await request('POST', '/api/revisions/rollback', {
      sourceRevision,
      ...(note === undefined || note === '' ? {} : { note }),
      ...(confirm ? { confirm: true } : {}),
    });
    return { revision: typeof data.revision === 'number' ? data.revision : 0 };
  },

  /**
   * 舍弃草稿：把草稿重置为线上正在服务的那一版。不写 KV、不产生 revision、
   * 不过发布闸 —— 是发布的草稿侧镜像，不是一次发布。
   */
  discardDraft: async (): Promise<{ sourceRevision: number }> => {
    const data = await request('POST', '/api/discard');
    return { sourceRevision: typeof data.sourceRevision === 'number' ? data.sourceRevision : 0 };
  },

  /* ---------- 域名发现 ---------- */

  /**
   * 从 Cloudflare 账号读出真正能打到反代的 hostname，并与路由表交叉比对。
   *
   * 只读，不写 D1/KV/审计。`configured: false` 不是错误 —— 没配 token 的部署是
   * 受支持的部署，界面该解释而不是报警。
   */
  domains: async (): Promise<DomainsResponse> => {
    return (await request('GET', '/api/domains')) as unknown as DomainsResponse;
  },

  /* ---------- MCP 令牌 ---------- */

  listMcpTokens: async (): Promise<McpTokenEntry[]> => {
    const data = await request('GET', '/api/mcp-tokens');
    return Array.isArray(data.tokens) ? (data.tokens as McpTokenEntry[]) : [];
  },

  createMcpToken: async (input: {
    name: string;
    scopes: readonly string[];
    expiresInDays: number;
  }): Promise<McpTokenCreated> => {
    const data = await request('POST', '/api/mcp-tokens', input);
    return {
      token: typeof data.token === 'string' ? data.token : '',
      tokenInfo: data.tokenInfo as McpTokenEntry,
    };
  },

  revokeMcpToken: async (id: string, reason?: string): Promise<void> => {
    await request('DELETE', `/api/mcp-tokens/${encodeURIComponent(id)}`, reason ? { reason } : {});
  },
};

/* ---------- 服务端返回的形状 ---------- */

export interface RouteEntry {
  readonly id: string;
  /** 服务端读不出 JSON 时这里不是对象 —— UI 必须把它当"数据损坏"显示而不是崩掉。 */
  readonly definition: unknown;
  readonly enabled: boolean;
  readonly position: number;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

export interface PreviewResult {
  readonly ok: boolean;
  readonly issues?: readonly Issue[];
  readonly shadowWarnings?: readonly ShadowWarning[];
  /** 整站代理但没开正文改写的路由。提示性质，不影响能不能发布。 */
  readonly mirrorWarnings?: readonly MirrorWarning[];
  /** 开了缓存、条件又用头或 cookie 的路由：键随值变，命中率会降。提示性质。 */
  readonly cacheVaryWarnings?: readonly CacheVaryWarning[];
  readonly dangers?: Record<string, readonly FieldRisk[]>;
  readonly document?: unknown;
  readonly routeCount?: number;
  readonly error?: string;
  /** 「还没开始」而不是「配置有错」：刚部署完的空表走这一支。 */
  readonly empty?: true;
  /** 线上正在服务的 revision；null = 从未发布过。 */
  readonly live?: { readonly revision: number } | null;
  /** 服务端用文档指纹比对草稿与线上；老版本服务端不返回这个字段。 */
  readonly dirty?: boolean;
}

export interface AuditEntry {
  readonly id: number;
  readonly at: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string | null;
  readonly detail: string | null;
}

/**
 * GET /api/users 的行。形状逐字段对齐 store.ts 的 listUsers —— 密码哈希列从不
 * 出现在这份响应里，那是服务端 SELECT 清单的责任，前端类型只认这些字段。
 */
export interface UserEntry {
  readonly id: number;
  readonly subject: string;
  readonly email: string | null;
  readonly role: Role;
  readonly disabled: boolean;
  /** 秒级时间戳，与 RouteEntry.updatedAt 同一纪元。 */
  readonly createdAt: number;
  /** null = 从未登录过（只创建还没用过的账号）。 */
  readonly lastSeen: number | null;
  readonly failedAttempts: number;
  /** null = 没有被锁。 */
  readonly lockedUntil: number | null;
  readonly sessions: number;
}

/* ---------- 发布历史与回滚 ---------- */

/** 历史列表的一条。snapshot: 'none' = 该次发布早于历史功能，没有快照可对比或回滚。 */
export interface RevisionEntry {
  readonly revision: number;
  readonly at: number;
  readonly actor: string;
  readonly note: string | null;
  /** 回滚产生的新版本会带上它复制的那个 revision。 */
  readonly rollbackOf: number | null;
  readonly routeCount: number | null;
  readonly snapshot: 'full' | 'none';
  readonly live: boolean;
}

/**
 * 服务端 diff 的一个字段。from/to 是快照里的原值（可能不是字符串），moved 的
 * 两侧是 0 起始的数组下标。值一律由调用方按需格式化，这里不做形状假设。
 */
export interface DiffEntry {
  readonly path: string;
  readonly kind: 'added' | 'removed' | 'changed' | 'moved';
  readonly from?: unknown;
  readonly to?: unknown;
  readonly fromPosition?: number;
  readonly toPosition?: number;
}

const asRevisions = (raw: readonly unknown[]): RevisionEntry[] => {
  const entries: RevisionEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.revision !== 'number' || typeof record.at !== 'number') {
      continue;
    }
    entries.push({
      revision: record.revision,
      at: record.at,
      actor: typeof record.actor === 'string' ? record.actor : '',
      note: typeof record.note === 'string' ? record.note : null,
      rollbackOf: typeof record.rollbackOf === 'number' ? record.rollbackOf : null,
      routeCount: typeof record.routeCount === 'number' ? record.routeCount : null,
      snapshot: record.snapshot === 'full' ? 'full' : 'none',
      live: record.live === true,
    });
  }
  return entries;
};

const asDiffEntries = (raw: readonly unknown[]): DiffEntry[] => {
  const entries: DiffEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.path !== 'string') {
      continue;
    }
    const kind = record.kind;
    entries.push({
      path: record.path,
      kind:
        kind === 'added' || kind === 'removed' || kind === 'changed' || kind === 'moved'
          ? kind
          : 'changed',
      ...(record.from === undefined ? {} : { from: record.from }),
      ...(record.to === undefined ? {} : { to: record.to }),
      ...(typeof record.fromPosition === 'number' ? { fromPosition: record.fromPosition } : {}),
      ...(typeof record.toPosition === 'number' ? { toPosition: record.toPosition } : {}),
    });
  }
  return entries;
};

/** 一个绑定来源：workers.dev 子域、自定义域，或 zone route（可能是通配）。 */
export type BindingKind = 'workers_dev' | 'custom_domain' | 'route';

export interface HostBinding {
  readonly kind: BindingKind;
  readonly host: string;
  readonly zone?: string;
  readonly pattern?: string;
  /** 哪些路由的 match.host 接受这个 host；空数组表示流量会穿过去没人接。 */
  readonly routeIds: readonly string[];
}

export type UnconfiguredReason = 'missing_account_id' | 'missing_token' | 'missing_both';

export interface DomainsResponse {
  readonly configured: boolean;
  readonly reason?: UnconfiguredReason;
  readonly script?: string;
  readonly hosts?: readonly HostBinding[];
  readonly failures?: readonly { readonly source: string; readonly message: string }[];
  readonly skippedZones?: readonly string[];
  /**
   * 路由写了 host 但没有任何已发现的 hostname 满足它 —— 要么绑定还没做，要么是
   * 错字。当所有来源都读不到时服务端会**省略**这个字段（而不是给空数组），因为
   * 那时每条路由都会显得没匹配，是虚假警报。
   */
  readonly unmatchedRouteHosts?: readonly { readonly routeId: string; readonly host: string }[];
}

export type McpScope = 'config:read' | 'config:write' | 'domains:read' | 'audit:read';

export interface McpTokenEntry {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly ownerUserId?: number;
  readonly issuedByUserId?: number;
  readonly scopes: readonly McpScope[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly revokeReason: string | null;
  readonly lastUsedAt: number | null;
}

export interface McpTokenCreated {
  readonly token: string;
  readonly tokenInfo: McpTokenEntry;
}
