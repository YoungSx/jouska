/**
 * Local validation and error dispatch.
 *
 * Everything here answers one of two questions: "what is wrong with this draft"
 * (collectErrors, reservedHeaderNames, dangerousSubPaths) or "how do we phrase a
 * failed write" (saveErrorMessage). The authoritative verdict still lives on the
 * server at /api/preview — these checks only spare the operator a round trip.
 */
import { ApiError, NetworkError } from '@/lib/api';
import { t } from '@/lib/messages';
import {
  ACCESS_KEY_DIGEST_PATTERN,
  ACCESS_TEAM_PATTERN,
  DANGEROUS_PATHS,
  HEADER_TOKEN_PATTERN,
  LIMITS,
  NUMERIC_BOUNDS,
  RESERVED_REQUEST_HEADERS,
  ROUTE_ID_PATTERN,
} from '@/lib/types';
import type { RouteDefinition } from '@/lib/types';
import { NUMERIC_FIELDS, NUMERIC_KEYS } from './constants';
import type { AdvancedItem, FieldErrors, GuardsItem } from './constants';

/** 报错里回显条目时截短到这个长度 —— 定位够了，又不至于把消息撑爆。 */
const brief = (value: string): string => (value.length > 20 ? `${value.slice(0, 20)}…` : value);

/** 把明显的错拦在一次网络往返之前；权威判定在服务端 /api/preview。 */
export const collectErrors = (
  createMode: boolean,
  id: string,
  definition: RouteDefinition,
): FieldErrors => {
  const errors: FieldErrors = {};
  if (createMode && !ROUTE_ID_PATTERN.test(id)) {
    errors.id = t.editor.idInvalid;
  }
  // 服务端 schema 要求 upstream 非空且不能带协议（`//`），错着存会让发布预览报错。
  // 用 error 而不是 help：这条也进页脚摘要，得自报家门且不带反引号。
  const upstream = typeof definition.upstream === 'string' ? definition.upstream.trim() : '';
  if (upstream === '' || upstream.includes('//')) {
    errors.upstream = t.fields.upstream.error;
  }
  // 条件行直接落 definition，所以会有「刚加还没填」的行：名称为空、或选了
  // 「值开头是」却没写值。这些条目服务端 schema 一律拒绝，先在这里点名。
  const conditions = [
    ...(definition.match?.headers ?? []),
    ...(definition.match?.query ?? []),
    ...(definition.match?.cookies ?? []),
  ];
  if (
    conditions.some(
      (condition) =>
        condition.name.trim() === '' || (condition.prefix !== undefined && condition.prefix === ''),
    )
  ) {
    errors.matchConditions = t.fields.matchConditions.conditionError;
  }
  if (
    definition.scheme !== undefined &&
    definition.scheme !== 'http' &&
    definition.scheme !== 'https'
  ) {
    errors.scheme = `${t.fields.scheme.label}: http | https`;
  }
  for (const key of NUMERIC_KEYS) {
    const value = definition[key];
    if (value === undefined) {
      continue;
    }
    const bound = NUMERIC_BOUNDS[key];
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < bound.min ||
      value > bound.max
    ) {
      const unit = NUMERIC_FIELDS[key].unit;
      errors[key] = `${NUMERIC_FIELDS[key].label}：${String(bound.min)} – ${String(bound.max)}${
        unit === undefined ? '' : ` ${unit}`
      }`;
    }
  }
  // access 块的凭据格式。team/keys/header 是与服务端一字不差的精确正则，本地
  // 给出的意见与线上一致；邮箱只拦一眼能看出来的错 —— 邮箱合法性存在 IDN、
  // 加号地址这类边缘，学 ip 规则的先例不装权威，判定归 /api/preview。
  const access = definition.access;
  if (access !== undefined) {
    const team = access.cloudflare?.team;
    if (team !== undefined && !ACCESS_TEAM_PATTERN.test(team)) {
      errors.accessTeam = t.fields.access.teamError;
    }
    const emails = access.cloudflare?.emails;
    if (emails !== undefined) {
      const bad = emails.find((email) => !/\S+@\S+\.\S+/.test(email));
      if (bad !== undefined) {
        errors.accessEmails = t.fields.access.emailsError(bad);
      }
    }
    const keys = access.keys;
    if (keys !== undefined) {
      const bad = keys.find((key) => !ACCESS_KEY_DIGEST_PATTERN.test(key));
      if (bad !== undefined) {
        errors.accessKeys = t.fields.access.keysError(brief(bad));
      }
    }
    const header = access.header;
    if (header !== undefined && !HEADER_TOKEN_PATTERN.test(header)) {
      errors.accessHeader = t.fields.access.headerError(header);
    }
  }
  return errors;
};

/**
 * 保存失败的分派：按错误码选文案，不去匹配服务端的句子（那种匹配在后端改一个字
 * 时会静默失效）。detail 是服务端给出的人话，比错误码可读。
 */
export const saveErrorMessage = (error: unknown): string => {
  if (error instanceof ApiError) {
    if (error.code === 'too_large') {
      return t.editor.tooBig(LIMITS.definitionBytes / 1024);
    }
    if (error.status === 401) {
      return t.common.sessionExpired;
    }
    if (error.code === 'forbidden') {
      return t.common.forbidden;
    }
    const detail = error.body.detail;
    if (typeof detail === 'string' && detail !== '') {
      return detail;
    }
  }
  if (error instanceof NetworkError) {
    return t.common.networkError;
  }
  return t.editor.saveFailed(error instanceof Error ? error.message : t.common.unknownError);
};

/**
 * upstreamHeaders 里出现的保留头名 —— jouska 自己推导，或运行时掌管，schema 会拒。
 *
 * 只覆盖表单在编辑的这个字段。`requestHeaders` 走 JSON 视图，它的同类错误由服务端
 * 预览报出来；把那份错误挂在这个控件下面只会指错地方。
 */
export const reservedHeaderNames = (definition: RouteDefinition): string[] =>
  Object.keys(definition.upstreamHeaders ?? {}).filter((name) =>
    RESERVED_REQUEST_HEADERS.has(name.trim().toLowerCase()),
  );

/** 名单里命中的保留头名 —— forwardAuth 的两份抄送名单用它检查。 */
export const reservedNamesIn = (names: readonly string[] | undefined): string[] =>
  (names ?? []).filter((name) => RESERVED_REQUEST_HEADERS.has(name.trim().toLowerCase()));

/**
 * 未覆盖字段里命中的危险子路径。
 *
 * 让 JSON 视图里手写的 `responseHeaders.set` 之类在表单视图也开口说话，而不是安静
 * 地躺在一行值预览里 —— 表单不认识一个字段，不等于它不危险。
 */
export const dangerousSubPaths = (key: string, value: unknown): string[] => {
  if (DANGEROUS_PATHS.has(key)) {
    return [key];
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value)
    .map((child) => `${key}.${child}`)
    .filter((path) => DANGEROUS_PATHS.has(path));
};

/* ---------- 错误 → 它在页面上的位置 ---------- */

/** 一条错误要把人送到哪儿。 */
export interface ErrorTarget {
  /** 出错控件（或它的容器）的 DOM id。 */
  readonly fieldId: string;
  /** 错误所在的手风琴卡；收起时得先展开，否则聚焦落在不可见元素上等于没跳。 */
  readonly card?: AdvancedItem | GuardsItem;
  /** 人能认出的字段名 —— 错误原文里已含字段名，这里是清单的标题。 */
  readonly label: string;
}

/**
 * 每个本地校验错误的落点。
 *
 * 手工维护而不是从 JSX 里推导：id 是 DOM 契约，让它显式可查比让它跟着组件树漂移
 * 安全。键少一个编译不过（Record 是全量的），所以新增校验项时这里会拦住人。
 */
export const ERROR_TARGETS: Record<keyof FieldErrors, ErrorTarget> = {
  id: { fieldId: 'route-editor-id', label: t.editor.idLabel },
  upstream: { fieldId: 'route-editor-upstream', label: t.fields.upstream.label },
  scheme: { fieldId: 'route-editor-scheme', label: t.fields.scheme.label },
  matchConditions: {
    fieldId: 'route-editor-conditions',
    label: t.fields.matchConditions.label,
  },
  timeoutMs: {
    fieldId: 'route-editor-timeoutMs',
    card: 'timing',
    label: NUMERIC_FIELDS.timeoutMs.label,
  },
  totalTimeoutMs: {
    fieldId: 'route-editor-totalTimeoutMs',
    card: 'timing',
    label: NUMERIC_FIELDS.totalTimeoutMs.label,
  },
  firstChunkTimeoutMs: {
    fieldId: 'route-editor-firstChunkTimeoutMs',
    card: 'timing',
    label: NUMERIC_FIELDS.firstChunkTimeoutMs.label,
  },
  streamIdleTimeoutMs: {
    fieldId: 'route-editor-streamIdleTimeoutMs',
    card: 'timing',
    label: NUMERIC_FIELDS.streamIdleTimeoutMs.label,
  },
  retries: {
    fieldId: 'route-editor-retries',
    card: 'timing',
    label: NUMERIC_FIELDS.retries.label,
  },
  retryBackoffMs: {
    fieldId: 'route-editor-retryBackoffMs',
    card: 'timing',
    label: NUMERIC_FIELDS.retryBackoffMs.label,
  },
  accessKeys: { fieldId: 'route-editor-access-keys', card: 'access', label: t.fields.access.keys },
  accessTeam: { fieldId: 'route-editor-access-team', card: 'access', label: t.fields.access.team },
  accessEmails: {
    fieldId: 'route-editor-access-emails',
    card: 'access',
    label: t.fields.access.emails,
  },
  accessHeader: {
    fieldId: 'route-editor-access-header',
    card: 'access',
    label: t.fields.access.header,
  },
};
