/**
 * 展示用的格式化。
 *
 * 都是纯函数，因为它们要在表格的每一行上跑，也要在测试里被单独验证。
 */
import { t } from './messages';
import type { RouteDefinition } from './types';

const relativeTime = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
const absoluteTime = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** 秒级时间戳 → 「3 分钟前」。审计与路由表都用相对时间，扫读更快。 */
export const timeAgo = (seconds: number): string => {
  const deltaSeconds = seconds - Date.now() / 1000;
  const steps: [limit: number, divisor: number, unit: Intl.RelativeTimeFormatUnit][] = [
    [60, 1, 'second'],
    [3600, 60, 'minute'],
    [86_400, 3600, 'hour'],
    [604_800, 86_400, 'day'],
    [2_592_000, 604_800, 'week'],
    [31_536_000, 2_592_000, 'month'],
  ];
  for (const [limit, divisor, unit] of steps) {
    if (Math.abs(deltaSeconds) < limit) {
      return relativeTime.format(Math.round(deltaSeconds / divisor), unit);
    }
  }
  return relativeTime.format(Math.round(deltaSeconds / 31_536_000), 'year');
};

/** 秒级时间戳 → 完整时间，给 title 属性用（相对时间要能查到确切值）。 */
export const timeExact = (seconds: number): string => absoluteTime.format(seconds * 1000);

/** 一条路由的匹配条件，压缩成一行可扫读的文本。 */
export const matchSummary = (definition: RouteDefinition): string => {
  const match = definition.match ?? {};
  const host = match.host ?? t.routes.anyHost;
  const path = match.path ?? t.routes.anyPath;
  const methods =
    match.methods !== undefined && match.methods.length > 0 ? ` [${match.methods.join(' ')}]` : '';
  return `${host}${path}${methods}`;
};

/** 上游连同 scheme，`https` 是默认值所以省略不写，`http` 必须显示出来。 */
export const upstreamSummary = (definition: RouteDefinition): string => {
  const upstream = definition.upstream;
  if (typeof upstream !== 'string' || upstream === '') {
    return '—';
  }
  return definition.scheme === 'http' ? `http://${upstream}` : upstream;
};

/** 服务端读不出 JSON 时 definition 不是对象；这一行必须显示成"数据损坏"。 */
export const isUsableDefinition = (definition: unknown): definition is RouteDefinition =>
  typeof definition === 'object' && definition !== null && !Array.isArray(definition);

/** 键排序的递归遍历；不捕获外部变量，所以放在模块层而不是每次调用重建。 */
const walk = (node: unknown): unknown => {
  if (Array.isArray(node)) {
    return node.map(walk);
  }
  if (typeof node === 'object' && node !== null) {
    const record = node as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).toSorted()) {
      sorted[key] = walk(record[key]);
    }
    return sorted;
  }
  return node;
};

/** 稳定序列化：键排序，所以「只是键顺序不同」不会被算成一次改动。 */
export const stableStringify = (value: unknown): string => JSON.stringify(walk(value));

/** JSON 字节数，用来在超过服务端上限之前提示。 */
export const jsonByteLength = (value: unknown): number => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : new TextEncoder().encode(serialized).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/** 逗号或空白分隔的输入 → 去空的数组。国家码、CIDR、content-type 都用它。 */
export const parseList = (raw: string): string[] =>
  raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
