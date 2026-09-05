/**
 * Route editor field metadata: copy and schema bounds in one place, not scattered
 * across JSX. Every table here is keyed by the same identifiers the reverse proxy's
 * own zod schema uses, so a library-side rename breaks the build instead of drifting.
 */
import { TIMING_PRESETS } from '@jouska/timing-presets';
import { t } from '@/lib/messages';
import { PRESET_NUMERIC_KEYS } from '@/lib/types';
import type { RouteDefinition } from '@/lib/types';

/** 数值字段：retries 没有 unit，所以这里显式写 undefined，不能用索引访问去猜形状。 */
export const NUMERIC_KEYS = [
  'timeoutMs',
  'totalTimeoutMs',
  'firstChunkTimeoutMs',
  'streamIdleTimeoutMs',
  'retries',
  'retryBackoffMs',
] as const;
export type NumericKey = (typeof NUMERIC_KEYS)[number];

export const NUMERIC_FIELDS: Record<
  NumericKey,
  { readonly label: string; readonly unit: string | undefined }
> = {
  timeoutMs: { label: t.fields.timeoutMs.label, unit: t.fields.timeoutMs.unit },
  totalTimeoutMs: { label: t.fields.totalTimeoutMs.label, unit: t.fields.totalTimeoutMs.unit },
  firstChunkTimeoutMs: {
    label: t.fields.firstChunkTimeoutMs.label,
    unit: t.fields.firstChunkTimeoutMs.unit,
  },
  streamIdleTimeoutMs: {
    label: t.fields.streamIdleTimeoutMs.label,
    unit: t.fields.streamIdleTimeoutMs.unit,
  },
  retries: { label: t.fields.retries.label, unit: undefined },
  retryBackoffMs: { label: t.fields.retryBackoffMs.label, unit: t.fields.retryBackoffMs.unit },
};

/**
 * 预设按钮的元数据：名字与描述进按钮，数字从库里的 TIMING_PRESETS 取。
 *
 * 「填哪几个框」由 types.ts 的 PRESET_NUMERIC_KEYS 声明 —— 库加字段时编译会
 * 在这里报错，逼着人确认新字段要不要进预设按钮，而不是静默漏掉。
 */
export const TIMING_PRESET_BUTTONS = (
  ['llm', 'streaming'] as const satisfies readonly (keyof typeof TIMING_PRESETS)[]
).map((name) => ({
  name,
  keys: PRESET_NUMERIC_KEYS[name],
  values: TIMING_PRESETS[name],
  label: name === 'llm' ? t.fields.sections.presetLlm : t.fields.sections.presetStreaming,
  description:
    name === 'llm' ? t.fields.sections.presetLlmDesc : t.fields.sections.presetStreamingDesc,
}));

export const BOOLEAN_KEYS = [
  'stripPrefix',
  'rewriteHeaders',
  'manualRedirect',
  'websocket',
] as const;
export type BooleanKey = (typeof BOOLEAN_KEYS)[number];

/**
 * bodyRewrite 子段里的两个开关。
 *
 * 单独列出来是因为方向相反：这两个默认 true，所以它们是「关掉」用的。顶层那批默认
 * false 的开关是「打开」用的，混在一起会让默认值提示失去意义。
 */
export const BODY_REWRITE_BOOLEAN_KEYS = ['rewriteLinks', 'rewriteStyles'] as const;
export type BodyRewriteBooleanKey = (typeof BODY_REWRITE_BOOLEAN_KEYS)[number];

export const BODY_REWRITE_BOOLEAN_FIELDS: Record<
  BodyRewriteBooleanKey,
  { readonly id: string; readonly label: string; readonly help: string }
> = {
  rewriteLinks: {
    id: 'route-editor-body-rewrite-links',
    label: t.fields.bodyRewrite.rewriteLinks,
    help: t.fields.bodyRewrite.rewriteLinksHelp,
  },
  rewriteStyles: {
    id: 'route-editor-body-rewrite-styles',
    label: t.fields.bodyRewrite.rewriteStyles,
    help: t.fields.bodyRewrite.rewriteStylesHelp,
  },
};

export const BOOLEAN_FIELDS: Record<
  BooleanKey,
  { readonly id: string; readonly label: string; readonly help: string }
> = {
  stripPrefix: {
    id: 'route-editor-strip-prefix',
    label: t.fields.stripPrefix.label,
    help: t.fields.stripPrefix.help,
  },
  rewriteHeaders: {
    id: 'route-editor-rewrite-headers',
    label: t.fields.rewriteHeaders.label,
    help: t.fields.rewriteHeaders.help,
  },
  manualRedirect: {
    id: 'route-editor-manual-redirect',
    label: t.fields.manualRedirect.label,
    help: t.fields.manualRedirect.help,
  },
  websocket: {
    id: 'route-editor-websocket',
    label: t.fields.websocket.label,
    help: t.fields.websocket.help,
  },
};

/** Select 里「未设置」的哨兵值，区别于显式写 https —— 写了 https 就要存 https。 */
export const SCHEME_UNSET = 'unset';

/** 开关型子段：这一段存不存在，本身就是开关状态。 */
export type SectionKey = 'bodyRewrite' | 'cors' | 'ip' | 'access' | 'forwardAuth';

/** 本地校验的错误集：键是字段，值是直接展示的文案。 */
export type FieldErrors = Partial<
  Record<'id' | 'upstream' | 'scheme' | 'matchConditions' | NumericKey, string>
>;

/**
 * 「谁能来」手风琴的卡片：一个 SectionKey 一张卡。
 * 手风琴而非单选，因为「段存在即开关」——用户可以同时配 IP 规则和身份验证，
 * 单选会逼着做假取舍。
 */
export const GUARDS_ITEMS = ['countries', 'cors', 'ip', 'access', 'forwardAuth'] as const;
export type GuardsItem = (typeof GUARDS_ITEMS)[number];

/** 「高级」手风琴的卡片。 */
export const ADVANCED_ITEMS = ['timing', 'rewrite', 'headers'] as const;
export type AdvancedItem = (typeof ADVANCED_ITEMS)[number];

/** 谁能来各卡是否已设置：只看 definition 里有没有对应的键。 */
export const guardsItemSet = (definition: RouteDefinition, item: GuardsItem): boolean => {
  switch (item) {
    case 'countries':
      return definition.blockCountries !== undefined || definition.allowCountries !== undefined;
    case 'cors':
    case 'ip':
    case 'access':
    case 'forwardAuth':
      return definition[item] !== undefined;
  }
};

/** 高级各卡是否已设置。 */
export const advancedItemSet = (definition: RouteDefinition, item: AdvancedItem): boolean => {
  switch (item) {
    case 'timing':
      return NUMERIC_KEYS.some((key) => definition[key] !== undefined);
    case 'rewrite':
      return (
        BOOLEAN_KEYS.some((key) => definition[key] !== undefined) ||
        definition.bodyRewrite !== undefined
      );
    case 'headers':
      return definition.upstreamHeaders !== undefined;
  }
};

/**
 * 手风琴初始展开集合：定义里已有内容的卡自动展开。
 * 已有键的区块藏起来等于把数据藏起来；没配过的收着，页面才不吓人。
 */
export const initialOpenFor = (definition: RouteDefinition): string[] => {
  const open: string[] = [];
  for (const item of GUARDS_ITEMS) {
    if (guardsItemSet(definition, item)) {
      open.push(item);
    }
  }
  for (const item of ADVANCED_ITEMS) {
    if (advancedItemSet(definition, item)) {
      open.push(item);
    }
  }
  return open;
};
