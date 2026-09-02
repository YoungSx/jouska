/**
 * 路由定义的前端类型与字段元数据。
 *
 * 这里的字段、默认值与取值范围逐条对齐 `packages/jouska/src/config.ts` 的 zod
 * schema。前端不做第二套校验 —— 权威判定永远在服务端 `/api/preview` 上，用的是
 * 反代运行时的同一份 schema。这里的边界只用来提前给出提示（number input 的
 * min/max、表单里的默认值占位），把明显的错拦在一次网络往返之前。
 *
 * 后果：schema 改了这里也要改。所以每个约束都注明它对应的 schema 行为，让漂移
 * 在 code review 时看得见。
 */

/**
 * 一条 `match` 条件：名 + 三选一的算子。三个族（headers/query/cookies）共用这个
 * 形状，与 `packages/jouska/src/config.ts` 的 schema 一致 —— 算子互斥由服务端
 * superRefine 判定，这里只承载字段。
 */
export interface MatchCondition {
  name: string;
  equals?: string;
  prefix?: string;
  present?: boolean;
}

export interface RouteMatch {
  host?: string;
  path?: string;
  methods?: string[];
  /** 头条件，全部 AND。头名在服务端会折成小写。 */
  headers?: MatchCondition[];
  /** 查询参数条件，全部 AND。参数名大小写敏感。 */
  query?: MatchCondition[];
  /** cookie 条件，全部 AND。cookie 名大小写敏感。 */
  cookies?: MatchCondition[];
}

export interface BodyRewrite {
  rewriteLinks?: boolean;
  replace?: { from: string; to: string }[];
  contentTypes?: string[];
  rewriteStyles?: boolean;
  fallbackCharset?: string;
}

export interface CorsRules {
  origins?: string[];
  allowMethods?: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

export interface IpRules {
  allow?: string[];
  deny?: string[];
}

export interface RateLimitRules {
  binding?: string;
  by?: 'ip' | 'path' | 'route';
  countPreflight?: boolean;
}

/**
 * 路由级访问控制。对齐 `packages/jouska/src/config.ts` 的 access 块：cloudflare
 * 与 keys 至少要有一个（空块守不住任何东西），这个交叉检查在服务端执行。
 *
 * keys 存的是 SHA-256 hex 哈希，key 本身从不进配置 —— 前端同样不收明文。
 */
export interface AccessRules {
  cloudflare?: {
    team?: string;
    audience?: string;
    emails?: string[];
  };
  keys?: string[];
  header?: string;
}

/** 一个方向上的声明式头规则：写哪些、删哪些。 */
export interface HeaderRules {
  set?: Record<string, string>;
  remove?: string[];
}

export interface CacheRules {
  enabled?: boolean;
  methods?: ('GET' | 'HEAD')[];
  ttlSeconds?: number;
  staleWhileRevalidateSeconds?: number;
  contentTypes?: string[];
  /** 冷缓存单飞：同 key 的并发 miss 只放一个去上游（isolate 级，非分布式）。 */
  lockMisses?: boolean;
  /** 上游失败时交付过期条目的窗口与失败模式；`5xx` 需显式 opt-in。 */
  staleIfError?: { seconds: number; on: ('timeout' | 'unreachable' | '5xx')[] };
  /** 按状态码的缓存窗口，秒；`0` 表示该码不存，未写的码回落到 `ttlSeconds`（仅 200）。 */
  statusTtlSeconds?: Record<string, number>;
}

/**
 * 请求策略：命中路由后是否转发、body 多大。
 *
 * `allowedMethods` 不命中 → 405 + Allow 头，这与 `match.methods` 不同 ——
 * 后者不命中是交回应用（不匹配），前者是匹配了但拒绝转发。
 */
export interface RequestPolicyRules {
  allowedMethods?: string[];
  maxBodyBytes?: number;
}

/**
 * 委托鉴权：把「你是谁」交给一个 URL（nginx `auth_request` 语义）。
 *
 * 2xx 放行，其他状态原样回传给调用方。`failOpen` 只接受 `true` —— 缺省即
 * fail-closed，schema 不给「关掉一个不存在的东西」留位置。
 */
export interface ForwardAuthRules {
  url?: string;
  copyRequestHeaders?: string[];
  copyResponseHeaders?: string[];
  timeoutMs?: number;
  failOpen?: true;
}

/**
 * 一条路由的定义。
 *
 * 全部字段可选 —— 编辑器要能承载一份不完整的草稿，用户填到一半时不该被类型拒
 * 绝。是否合法由服务端说。索引签名让 JSON 视图里手写的、表单不认识的字段能被
 * 原样保留，而不是保存时被静默丢掉。
 */
export interface RouteDefinition {
  match?: RouteMatch;
  upstream?: string;
  /** 与 `upstream`/`trafficSplit` 三选一；schema 的交叉检查在服务端执行。 */
  upstreams?: string[];
  /** 加权分流条目；权重 1–1000，条目至多 6 个。 */
  trafficSplit?: { upstream: string; weight: number }[];
  /** 故障转移策略，仅 `upstreams`/`trafficSplit` 路由可写，路由级、不能进 defaults。 */
  failover?: { on: ('timeout' | 'unreachable' | '5xx')[]; maxAttempts: number };
  /** 粘性分流：`'cookie'` 时新分配的调用方收到 `__jouska_upstream` cookie。 */
  stickyBy?: 'cookie';
  scheme?: 'https' | 'http';
  allowPrivateUpstream?: true;
  stripPrefix?: boolean;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  firstChunkTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  retries?: number;
  retryBackoffMs?: number;
  rewriteHeaders?: boolean;
  manualRedirect?: boolean;
  websocket?: boolean;
  blockCountries?: string[];
  allowCountries?: string[];
  /** `requestHeaders.set` 的旧名；schema 把它折进前者，两处写同一个头名且值不同会被拒。 */
  upstreamHeaders?: Record<string, string>;
  requestHeaders?: HeaderRules;
  responseHeaders?: HeaderRules;
  cache?: CacheRules;
  requestPolicy?: RequestPolicyRules;
  bodyRewrite?: BodyRewrite;
  cors?: CorsRules;
  ip?: IpRules;
  rateLimit?: RateLimitRules;
  access?: AccessRules;
  /** 委托鉴权（nginx `auth_request` 语义）。与 `cache` 互斥（schema 交叉检查）。 */
  forwardAuth?: ForwardAuthRules;
  [key: string]: unknown;
}

/** 预览里的一条校验问题，来自 compileConfig。 */
export interface Issue {
  readonly routeId: string | undefined;
  readonly path: string;
  readonly message: string;
}

/** 遮蔽警告：`shadowedId` 收不到流量，被 `byId` 抢先匹配，`probe` 是证据 URL。 */
export interface ShadowWarning {
  readonly shadowedId: string;
  readonly byId: string;
  readonly probe: string;
  /** 探测请求携带的头（含 route 条件要求的 `cookie`）；无条件时缺省，URL 即证据。 */
  readonly probeHeaders?: readonly { name: string; value: string }[];
}

/**
 * 缓存折变提示：这条路由开了缓存、又用头或 cookie 做条件，缓存键会随请求值变。
 *
 * 来自服务端 cache-advisory.ts。它是提示不是错误 —— 键折变保证了正确性（一个
 * 分支的缓存响应不会发给另一个分支），这里说的是命中率。query 不在其中：参数
 * 本来就在 URL 里，天然分键。
 */
export interface CacheVaryWarning {
  readonly routeId: string;
  readonly names: readonly string[];
}

/**
 * 整站镜像提示：这条路由把整站代理过来，但没开正文改写。
 *
 * 来自服务端 mirror.ts。它是提示不是错误 —— 整站不改写完全合法（纯 API 网关、
 * 只做资源代理），所以发布从不因它被拦。
 */
export interface MirrorWarning {
  readonly routeId: string;
  readonly upstream: string;
}

/** 危险字段，来自服务端 danger.ts。`path` 是点号路径，reason 是英文原文。 */
export interface FieldRisk {
  readonly path: string;
  readonly level: 'high' | 'medium';
  readonly reason: string;
}

/* ---------- schema 边界（对齐 config.ts） ---------- */

/** number 字段的取值范围与默认值，与 routeBehaviour 一致。 */
export const NUMERIC_BOUNDS = {
  timeoutMs: { min: 1, max: 120_000, default: 10_000 },
  totalTimeoutMs: { min: 1, max: 300_000, default: 30_000 },
  firstChunkTimeoutMs: { min: 1, max: 600_000, default: 60_000 },
  streamIdleTimeoutMs: { min: 1, max: 600_000, default: 60_000 },
  retries: { min: 0, max: 100, default: 0 },
  retryBackoffMs: { min: 0, max: 5_000, default: 100 },
  /** 委托鉴权子请求的时限；schema 上限 5000，默认 2000。 */
  authTimeoutMs: { min: 1, max: 5_000, default: 2_000 },
} as const;

/** boolean 字段的 schema 默认值，用来在表单上显示"默认 X"。 */
export const BOOLEAN_DEFAULTS = {
  stripPrefix: false,
  rewriteHeaders: true,
  manualRedirect: true,
  websocket: true,
} as const;

/**
 * bodyRewrite 子段里 boolean 字段的 schema 默认值。
 *
 * 两个都默认 true：`bodyRewrite: {}` 就已经在改链接和样式了。所以这两个开关是
 * 「关掉」用的，与顶层那批「打开」用的开关方向相反 —— 表单上要显示默认值，不然
 * 没人记得空对象到底做了什么。
 */
export const BODY_REWRITE_BOOLEAN_DEFAULTS = {
  rewriteLinks: true,
  rewriteStyles: true,
} as const;

export const SCHEME_DEFAULT = 'https' as const;

/** methods 字段可选的值。schema 接受任意 token，这几个覆盖实际用法。 */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** 路由 ID 的合法形状，与服务端 `routeIdFrom` 的正则一致。 */
export const ROUTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 服务端 validate.ts 的输入上限。 */
export const LIMITS = {
  definitionBytes: 64 * 1024,
  defaultsBytes: 64 * 1024,
  noteLength: 500,
  minPasswordLength: 12,
  maxPasswordLength: 1024,
  maxSubjectLength: 128,
} as const;

/** 认证策略，用于登录页的说明文案。与 api/auth.ts 的常量一致。 */
export const AUTH_POLICY = {
  maxFailedAttempts: 5,
  lockoutMinutes: 15,
} as const;

/**
 * 表单视图覆盖到的顶层字段。其余字段落到「表单未覆盖」区，保存时原样保留。
 *
 * 这里只许写表单真的渲染了的键 —— 多上游三件套（upstreams/trafficSplit/failover）
 * 与 stickyBy 还没有表单 UI，写进来会让它们两头隐形：未覆盖区不列、表单也没有。
 */
export const FORM_COVERED_KEYS: readonly string[] = [
  'match',
  'upstream',
  'scheme',
  'allowPrivateUpstream',
  'stripPrefix',
  'timeoutMs',
  'totalTimeoutMs',
  'firstChunkTimeoutMs',
  'streamIdleTimeoutMs',
  'retries',
  'retryBackoffMs',
  'rewriteHeaders',
  'manualRedirect',
  'websocket',
  'blockCountries',
  'allowCountries',
  'upstreamHeaders',
  'bodyRewrite',
  'cors',
  'ip',
  'requestPolicy',
  'access',
  'forwardAuth',
];

/**
 * 危险字段的点号路径集合，与服务端 danger.ts 的 RULES 一致。
 *
 * 表单用它在对应控件旁边就地显示警示，而不是等发布时才说 —— 让手指在按下之前
 * 就变重。`cors.origins` 不在这里：它的危险状态是"缺失"而不是"存在"，由表单
 * 自己判断。
 */
export const DANGEROUS_PATHS = new Set([
  'allowPrivateUpstream',
  'scheme',
  'bodyRewrite.contentTypes',
  'bodyRewrite.fallbackCharset',
  'ip.allow',
  'ip.deny',
  'access.keys',
  'upstreamHeaders',
  'requestHeaders.set',
  'requestHeaders.remove',
  'responseHeaders.set',
  'cache.contentTypes',
  'requestPolicy.allowedMethods',
  'forwardAuth.url',
  'forwardAuth.failOpen',
]);

/** 危险字段的中文说明。服务端 reason 是英文，面板要用自己的语言说清后果。 */
export const DANGER_REASONS: Record<string, string> = {
  allowPrivateUpstream:
    '放行 loopback、内网和云元数据地址。一个被改坏的上游值就能把代理变成内网探测器。',
  scheme: '选 http 意味着边缘到上游这一段是明文传输。',
  'cors.origins':
    '没有列出 origin 会反射任何调用方的 origin，等于让别的站点通过这个代理读取带凭据的响应。',
  'cors.origins (absent)':
    '没有列出 origin 会反射任何调用方的 origin，等于让别的站点通过这个代理读取带凭据的响应。',
  'bodyRewrite.contentTypes': '列表写宽了会把非文本响应改写成乱码。',
  'bodyRewrite.fallbackCharset': '用错的字符集解码会把响应体弄坏；猜错比不改写更糟。',
  'ip.allow': 'allow 列表写错一个字符，就会放进本想排除的地址。',
  'ip.deny': 'deny 列表写错一个字符，就会挡掉正常的调用方。',
  'access.keys':
    '这里要粘的是 key 的 SHA-256 哈希，不是 key 本身。粘错了真 key 的主人从此被挡在门外，而哈希对应的明文从此属于粘上来的人。',
  upstreamHeaders: '这些头会原样发给上游。凭据类或身份伪装类的头写在这里等于交给第三方。',
  'requestHeaders.set': '这些头会原样发给上游。凭据类或身份伪装类的头写在这里等于交给第三方。',
  'requestHeaders.remove': '删掉 cookie 或 authorization，上游的会话和认证会静默失效。',
  'responseHeaders.set':
    '这些规则在代理改写之后跑，所以能把 Location 指回上游、能加回一条让改写后页面加载不了自己资源的 CSP、也能加回让客户端从自己缓存里取未改写正文的校验头。',
  'cache.contentTypes':
    '默认只缓存静态资源。把文档类型加进来，一个没带 cookie、也没标 private 的个性化页面就会被发给下一个访客。',
  'requestPolicy.allowedMethods':
    '列表写漏一个方法，用它的调用方全部收到 405 —— 拒绝是显式的，不会悄悄放行去别处。',
  'forwardAuth.url':
    '写 `http://` 意味着 cookie 和 authorization 以明文发往鉴权端点。',
  'forwardAuth.failOpen':
    '打开后鉴权端点挂了所有请求直接放行 —— 可用性高于准入，故障会变成全场免票。',
};

/**
 * 请求方向的保留头：写或删都会被 schema 拒绝。
 *
 * 三组，各有各的原因（详见 `packages/jouska/src/config.ts`）：jouska 自己从请求推导
 * 的转发头；描述这一跳连接与分帧、由运行时掌管的传输头；以及 jouska 已经替你决定
 * 的协商头 —— `accept-encoding` 被删掉才让改写看得见明文，WebSocket 握手头由
 * `websocket` 开关决定。
 */
export const RESERVED_REQUEST_HEADERS = new Set([
  'host',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-for',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'content-length',
  'accept-encoding',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
]);
