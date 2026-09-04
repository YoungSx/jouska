/**
 * 路由编辑器：表单与 JSON 两个视图共享同一份 definition 草稿。
 *
 * 保存写的是**草稿**：toast 只说存进草稿，绝不暗示线上已经改变 —— 那是发布页的
 * 职责。本地校验只拦「明显写错」（ID 形状、upstream 带协议、数值越界、定义超上
 * 限），权威判定永远在服务端 /api/preview，用的是反代运行时的同一份 schema。
 *
 * 两个不变式：
 * - 表单覆盖不到的键**原样保留**。definition 有索引签名，手写字段会被写回而不是
 *   在保存时被静默丢掉 —— 「表单不认识」不等于「数据有错」。
 * - 等于 schema 默认值的键**不落盘**。JSON 里只保留与默认不同的决定，diff 才可读。
 */

import * as React from 'react';
import { Autocomplete } from '@base-ui/react';
import { InfoIcon, PlusIcon, SaveIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Accordion,
  AccordionContent,
  AccordionHeader,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
// 预设数字的唯一源头是 jouska 库（README 与面板共用一份），别名指到库源码，
// 库改数字这里自动跟上。别处的 jouska import 一律不走这条路 —— 那个文件依赖
// workers-types，面板的 tsc 没有它。
import { TIMING_PRESETS } from '@jouska/timing-presets';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, NetworkError } from '@/lib/api';
import type { HostBinding } from '@/lib/api';
import { jsonByteLength, parseList, stableStringify } from '@/lib/format';
import { t } from '@/lib/messages';
import {
  BODY_REWRITE_BOOLEAN_DEFAULTS,
  BOOLEAN_DEFAULTS,
  DANGEROUS_PATHS,
  DANGER_REASONS,
  FORM_COVERED_KEYS,
  HTTP_METHODS,
  LIMITS,
  NUMERIC_BOUNDS,
  PRESET_NUMERIC_KEYS,
  RESERVED_REQUEST_HEADERS,
  ROUTE_ID_PATTERN,
  SCHEME_DEFAULT,
} from '@/lib/types';
import type { MatchCondition, RouteDefinition } from '@/lib/types';

/* ---------- 字段元数据：文案与 schema 边界放一处，不散在 JSX 里。 ---------- */

/** 数值字段：retries 没有 unit，所以这里显式写 undefined，不能用索引访问去猜形状。 */
const NUMERIC_KEYS = [
  'timeoutMs',
  'totalTimeoutMs',
  'firstChunkTimeoutMs',
  'streamIdleTimeoutMs',
  'retries',
  'retryBackoffMs',
] as const;
type NumericKey = (typeof NUMERIC_KEYS)[number];

const NUMERIC_FIELDS: Record<
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
const TIMING_PRESET_BUTTONS = (
  ['llm', 'streaming'] as const satisfies readonly (keyof typeof TIMING_PRESETS)[]
).map((name) => ({
  name,
  keys: PRESET_NUMERIC_KEYS[name],
  values: TIMING_PRESETS[name],
  label: name === 'llm' ? t.fields.sections.presetLlm : t.fields.sections.presetStreaming,
  description:
    name === 'llm' ? t.fields.sections.presetLlmDesc : t.fields.sections.presetStreamingDesc,
}));

const BOOLEAN_KEYS = ['stripPrefix', 'rewriteHeaders', 'manualRedirect', 'websocket'] as const;
type BooleanKey = (typeof BOOLEAN_KEYS)[number];

/**
 * bodyRewrite 子段里的两个开关。
 *
 * 单独列出来是因为方向相反：这两个默认 true，所以它们是「关掉」用的。顶层那批默认
 * false 的开关是「打开」用的，混在一起会让默认值提示失去意义。
 */
const BODY_REWRITE_BOOLEAN_KEYS = ['rewriteLinks', 'rewriteStyles'] as const;
type BodyRewriteBooleanKey = (typeof BODY_REWRITE_BOOLEAN_KEYS)[number];

const BODY_REWRITE_BOOLEAN_FIELDS: Record<
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

const BOOLEAN_FIELDS: Record<
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
const SCHEME_UNSET = 'unset';

/** 开关型子段：这一段存不存在，本身就是开关状态。 */
type SectionKey = 'bodyRewrite' | 'cors' | 'ip' | 'access' | 'forwardAuth';

/** 本地校验的错误集：键是字段，值是直接展示的文案。 */
type FieldErrors = Partial<
  Record<'id' | 'upstream' | 'scheme' | 'matchConditions' | NumericKey, string>
>;

/**
 * 「谁能来」手风琴的卡片：一个 SectionKey 一张卡。
 * 手风琴而非单选，因为「段存在即开关」——用户可以同时配 IP 规则和身份验证，
 * 单选会逼着做假取舍。
 */
const GUARDS_ITEMS = ['countries', 'cors', 'ip', 'access', 'forwardAuth'] as const;
type GuardsItem = (typeof GUARDS_ITEMS)[number];

/** 「高级」手风琴的卡片。 */
const ADVANCED_ITEMS = ['timing', 'rewrite', 'headers'] as const;
type AdvancedItem = (typeof ADVANCED_ITEMS)[number];

/** 谁能来各卡是否已设置：只看 definition 里有没有对应的键。 */
const guardsItemSet = (definition: RouteDefinition, item: GuardsItem): boolean => {
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
const advancedItemSet = (definition: RouteDefinition, item: AdvancedItem): boolean => {
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
const initialOpenFor = (definition: RouteDefinition): string[] => {
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

/* ---------- 展示件 ---------- */

/**
 * help 文案里的反引号片段排成等宽字：操作者要逐字符抄写的就是这些片段（`/*`、
 * `*.example.com`），普通正文把它们淹没会直接造成写错。
 */
const Hint = ({ text }: { readonly text: string }) => (
  <>
    {text.split('`').map((part, index) =>
      index % 2 === 1 ? (
        <code key={index} className="text-foreground bg-muted rounded px-1 font-mono text-xs">
          {part}
        </code>
      ) : (
        <React.Fragment key={index}>{part}</React.Fragment>
      ),
    )}
  </>
);

/**
 * 危险字段的就地警示。只对 types.ts 登记过的路径渲染 —— 路径拼错时不显示，
 * 比显示一句错误文案更早暴露「新增了危险字段但没登记」。
 */
const DangerNote = ({ path }: { readonly path: string }) => {
  if (!DANGEROUS_PATHS.has(path)) {
    return null;
  }
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertDescription>{DANGER_REASONS[path]}</AlertDescription>
    </Alert>
  );
};

/**
 * 打开正文改写之后立刻要看见的两件事：代价，与覆盖不到的地方。
 *
 * 不是 DangerNote —— 它不需要发布时确认，配置本身也没有危险。但也不能只当一行小
 * 字：改写会静默剥掉上游的验证器和 CSP，而「开了就全都留在代理上」是不成立的，两
 * 件事都得在按下开关的那一刻摊开，而不是等页面出问题再回来查。
 */
const RewriteNote = () => (
  <Alert>
    <InfoIcon />
    <AlertDescription className="flex flex-col gap-1">
      <span>
        <Hint text={t.fields.bodyRewrite.cost} />
      </span>
      <span>
        <Hint text={t.fields.bodyRewrite.scope} />
      </span>
    </AlertDescription>
  </Alert>
);

/** 表单未覆盖字段的值预览：只求认得出是什么，不求完整。 */
const previewValue = (value: unknown): string => {
  const raw = JSON.stringify(value) ?? 'undefined';
  return raw.length > 120 ? `${raw.slice(0, 119)}…` : raw;
};

const hasText = (value: string | undefined | null): boolean =>
  value !== undefined && value !== null && value !== '';

/**
 * JSON 错误定位：权威判定是 JSON.parse，这里只用 jsonc-parser 的容错扫描把
 * 第一个错定位到行列（1 起始）。两者的判定口径不同 —— jsonc 容忍注释与尾逗号
 * —— 所以它的解析结果一个字都不能用，只取 offset。
 */
const jsonErrorLocation = (text: string): string => {
  const errors: ParseError[] = [];
  parseJsonc(text, errors);
  const first = errors[0];
  if (first === undefined) {
    return '';
  }
  const beforeError = text.slice(0, first.offset);
  const line = (beforeError.match(/\n/g)?.length ?? 0) + 1;
  const column = first.offset - (beforeError.lastIndexOf('\n') + 1) + 1;
  return `${printParseErrorCode(first.error)}（${t.editor.jsonErrorAt(line, column)}）`;
};

/**
 * 字段标签旁的术语提示：label 保留原词（host、CIDR、AUD tag），解释进 tooltip。
 * 悬停/聚焦都触发 —— 触屏之外的两条路径都得能打开它。
 */
const TermTip = ({ text }: { readonly text: string }) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <button
          type="button"
          aria-label={text}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-2 inline-flex cursor-pointer items-center outline-none"
        >
          <InfoIcon aria-hidden className="size-3.5" />
        </button>
      }
    />
    <TooltipContent className="max-w-64">{text}</TooltipContent>
  </Tooltip>
);

/** 标签 + 可选术语提示的共用排版。 */
const PropertyLabel = ({
  htmlFor,
  label,
  tip,
}: {
  readonly htmlFor?: string;
  readonly label: string;
  readonly tip?: string;
}) => (
  <span className="inline-flex items-center gap-1.5">
    <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
    {tip !== undefined && <TermTip text={tip} />}
  </span>
);

/**
 * 手风琴卡头：卡名 + 这一组配没配过的状态徽章。状态是小白的地图——不用展开
 * 五张卡也能知道这条路由挡了谁；needsFix（有错误要修）盖过一切。守卫卡
 * （kind="guard"）配置过读「已启用」——守卫生效就是这条意思；高级卡配置过读
 * 「已设置」——那不是开关，是自定义值。没配一律读「默认」。
 */
const SectionCardTrigger = ({
  label,
  set,
  needsFix = false,
  kind,
}: {
  readonly label: string;
  readonly set: boolean;
  readonly needsFix?: boolean;
  readonly kind?: 'guard';
}) => (
  <AccordionTrigger>
    <span>{label}</span>
    {needsFix ? (
      <Badge variant="destructive">{t.fields.sections.sectionNeedsFix}</Badge>
    ) : set ? (
      <Badge variant="secondary">
        {kind === 'guard' ? t.fields.sections.sectionEnabled : t.fields.sections.sectionSet}
      </Badge>
    ) : (
      <Badge variant="ghost" className="text-muted-foreground">
        {t.fields.sections.sectionEmpty}
      </Badge>
    )}
  </AccordionTrigger>
);

/* ---------- 单字段控件 ---------- */

interface TextPropertyProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** 术语解释，进 tooltip；label 保留原词。 */
  readonly tip?: string;
  readonly placeholder?: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly error?: string;
  readonly onChange: (value: string) => void;
}

const TextProperty = ({
  id,
  label,
  hint,
  tip,
  placeholder,
  value,
  mono,
  error,
  onChange,
}: TextPropertyProps) => (
  <Field data-invalid={hasText(error) ? true : undefined}>
    <PropertyLabel htmlFor={id} label={label} tip={tip} />
    <Input
      id={id}
      className={mono === true ? 'font-mono' : undefined}
      value={value}
      placeholder={placeholder}
      aria-invalid={hasText(error)}
      onChange={(event) => onChange(event.target.value)}
    />
    {hasText(hint) && (
      <FieldDescription>
        <Hint text={hint as string} />
      </FieldDescription>
    )}
    {hasText(error) && <FieldError>{error}</FieldError>}
  </Field>
);

/**
 * host 候选项：host 本身是值，来源与 pattern 只做标注（issue #19）。同一 host
 * 可能来自多个 kind，去重后以第一次出现的为准，保持 Cloudflare 返回的顺序。
 */
interface HostOption {
  readonly value: string;
  readonly kind: HostBinding['kind'];
  readonly pattern?: string;
}

const toHostOptions = (bindings: readonly HostBinding[]): readonly HostOption[] =>
  [...new Map(bindings.map((binding) => [binding.host, binding])).values()].map((binding) => ({
    value: binding.host,
    kind: binding.kind,
    pattern: binding.pattern,
  }));

interface HostPropertyProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
  readonly value: string;
  /** 已绑定域名候选；空数组 = 无候选，控件退化为纯输入框，手输照常。 */
  readonly options: readonly HostOption[];
  /** 候选读不到时的一行低调说明；undefined = 不显示。 */
  readonly fallbackNote?: string;
  readonly onChange: (value: string) => void;
}

/**
 * host 字段：下拉选已绑定域名，同时保留自由输入（issue #19）。
 *
 * 单一受控通道：input 文本本身就是值。根件用 Base UI 的 Autocomplete.Root ——
 * 官方 base-nova 的 Combobox Root 是纯选择模型，类型层面没有 inputValue /
 * onInputValueChange，既回填不了既有 host 也观察不了打字；Autocomplete 与它
 * 共享同一套部件 context，官方 shadcn 的 Input/List/Item 原样可用。value +
 * onValueChange 是文本通道，「选」和「打」是同一控件的两条路径，不同步两份
 * 状态。过滤不需要自定义 —— Autocomplete 默认就是大小写不敏感的 contains，
 * 打 `example.com` 搜得到 `*.example.com`。
 *
 * 无候选时只藏下拉的装饰（chevron 与浮层），输入路径原封不动 —— 降级绝不
 * 锁输入（auth-view「挂载即锁死」的教训）。
 */
const HostProperty = ({
  id,
  label,
  hint,
  placeholder,
  value,
  options,
  fallbackNote,
  onChange,
}: HostPropertyProps) => {
  const hasOptions = options.length > 0;

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Autocomplete.Root items={options} value={value} onValueChange={onChange}>
        <ComboboxInput
          id={id}
          className="w-full font-mono"
          placeholder={placeholder}
          showTrigger={hasOptions}
        />
        {hasOptions && (
          <ComboboxContent>
            <ComboboxList>
              <ComboboxEmpty>{t.editor.hostEmpty}</ComboboxEmpty>
              <ComboboxCollection>
                {(option) => (
                  <ComboboxItem key={option.value} value={option}>
                    <div className="flex min-w-0 flex-col">
                      <span className="font-mono text-xs">{option.value}</span>
                      {option.kind === 'route' && option.pattern !== undefined && (
                        <span className="text-muted-foreground truncate text-xs">
                          {t.domains.kinds.route} · {option.pattern}
                        </span>
                      )}
                    </div>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxList>
          </ComboboxContent>
        )}
      </Autocomplete.Root>
      <FieldDescription>
        <Hint text={hint} />
        {fallbackNote !== undefined && <span className="mt-1 block">{fallbackNote}</span>}
      </FieldDescription>
    </Field>
  );
};

interface NumberPropertyProps {
  readonly id: string;
  readonly label: string;
  readonly unit: string | undefined;
  readonly hint: string;
  readonly value: string;
  readonly min: number;
  /** schema 没有上限时不传，属性整个省掉。 */
  readonly max?: number;
  readonly error?: string;
  /** 刚被（比如预设按钮）外部改写时的灰阶闪烁标记；true 只维持一瞬。 */
  readonly flashed?: boolean;
  readonly onChange: (value: string) => void;
}

const NumberProperty = ({
  id,
  label,
  unit,
  hint,
  value,
  min,
  max,
  error,
  flashed,
  onChange,
}: NumberPropertyProps) => (
  <Field data-invalid={hasText(error) ? true : undefined} data-flashed={flashed || undefined}>
    <FieldLabel htmlFor={id}>
      {label}
      {/* 单位挂在标签上而不是占位符里：填完之后依然看得见。 */}
      {unit !== undefined && <span className="text-muted-foreground font-normal">（{unit}）</span>}
    </FieldLabel>
    <Input
      id={id}
      type="number"
      className="font-mono"
      min={min}
      max={max}
      step={1}
      value={value}
      aria-invalid={hasText(error)}
      onChange={(event) => onChange(event.target.value)}
    />
    <FieldDescription>
      <Hint text={hint} />
    </FieldDescription>
    {hasText(error) && <FieldError>{error}</FieldError>}
  </Field>
);

interface ListPropertyProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** 术语解释，进 tooltip；label 保留原词。 */
  readonly tip?: string;
  readonly placeholder?: string;
  readonly value: readonly string[] | undefined;
  readonly onChange: (value: readonly string[] | undefined) => void;
}

/**
 * 逗号/空白分隔的列表输入。每次按键都会归一化并上报，但**不回写显示文本** ——
 * 否则刚打完一个逗号光标就被弹回去。列表语义以保存时的归一化结果为准。
 */
const ListProperty = ({
  id,
  label,
  hint,
  tip,
  placeholder,
  value,
  onChange,
}: ListPropertyProps) => {
  const signature = JSON.stringify(value ?? null);
  const [text, setText] = React.useState(() => (value ?? []).join(', '));
  const emitted = React.useRef(signature);
  // 外部值变了（JSON 视图改的、或初始值到了）才重放；自报的回声不算变化。
  if (emitted.current !== signature) {
    emitted.current = signature;
    setText((value ?? []).join(', '));
  }

  return (
    <Field>
      <PropertyLabel htmlFor={id} label={label} tip={tip} />
      <Input
        id={id}
        className="font-mono"
        value={text}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const list = parseList(next);
          // 空列表 = 未设置：删键，别把空数组存进草稿。
          emitted.current = JSON.stringify(list.length === 0 ? null : list);
          onChange(list.length === 0 ? undefined : list);
        }}
      />
      <FieldDescription>
        <Hint text={hint} />
      </FieldDescription>
    </Field>
  );
};

interface SwitchPropertyProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** schema 默认值的说明；布尔开关的中间态最容易让人忘记默认是什么。 */
  readonly defaultNote?: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}

const SwitchProperty = ({
  id,
  label,
  hint,
  defaultNote,
  checked,
  onCheckedChange,
}: SwitchPropertyProps) => (
  <Field orientation="horizontal">
    <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    <FieldContent>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {hasText(hint) && (
        <FieldDescription>
          <Hint text={hint as string} />
        </FieldDescription>
      )}
      {defaultNote !== undefined && (
        <FieldDescription className="text-xs">{defaultNote}</FieldDescription>
      )}
    </FieldContent>
  </Field>
);

/* ---------- 两列行编辑 ---------- */

interface RowPair {
  readonly first: string;
  readonly second: string;
}

interface RowPairListProps {
  readonly rows: readonly RowPair[];
  readonly firstLabel: string;
  readonly secondLabel: string;
  /** 增删按钮的可访问名：页面上同时有多个行编辑器时，光说「加一行」分不清是谁。 */
  readonly addRowLabel: string;
  readonly removeRowLabel: string;
  /** 第一列的就地标记（如保留头名）；返回 true 时该输入框标红，不拦保存。 */
  readonly firstInvalid?: (value: string) => boolean;
  readonly onRowsChange: (rows: readonly RowPair[]) => void;
}

/** 两列行编辑的共用骨架：行输入、增删按钮。rows ↔ 值的换算归各编辑器。 */
const RowPairList = ({
  rows,
  firstLabel,
  secondLabel,
  addRowLabel,
  removeRowLabel,
  firstInvalid,
  onRowsChange,
}: RowPairListProps) => (
  <div className="flex flex-col gap-2">
    {rows.map((row, index) => (
      <div key={index} className="flex items-center gap-2">
        <Input
          className="w-44 shrink-0 font-mono text-xs"
          placeholder={firstLabel}
          aria-label={`${firstLabel} ${String(index + 1)}`}
          aria-invalid={firstInvalid?.(row.first) ?? false}
          value={row.first}
          onChange={(event) =>
            onRowsChange(
              rows.map((entry, i) =>
                i === index ? { ...entry, first: event.target.value } : entry,
              ),
            )
          }
        />
        <Input
          className="min-w-0 flex-1 font-mono text-xs"
          placeholder={secondLabel}
          aria-label={`${secondLabel} ${String(index + 1)}`}
          value={row.second}
          onChange={(event) =>
            onRowsChange(
              rows.map((entry, i) =>
                i === index ? { ...entry, second: event.target.value } : entry,
              ),
            )
          }
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={removeRowLabel}
          onClick={() => onRowsChange(rows.filter((_, i) => i !== index))}
        >
          <Trash2Icon />
        </Button>
      </div>
    ))}
    <div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onRowsChange([...rows, { first: '', second: '' }])}
      >
        <PlusIcon />
        {addRowLabel}
      </Button>
    </div>
  </div>
);

/**
 * 行编辑的共享状态：行数组 + 回声指纹。外部值变了才重放；自报的回声不算变化。
 *
 * 指纹必须和 signature 同口径（`?? null`）。写 `JSON.stringify(emit)` 时，
 * 「上报了 undefined」的编辑下一次渲染的 signature 是 `"null"`，而指纹留着别的
 * 字符串 —— 自己的回声被当成「外部改了值」，刚加的行在同一次渲染里就被复位抹掉。
 * 表现为点「加一行」毫无反应，以及把唯一一行删空时整行消失。
 */
const useRowPairEditor = <T,>(
  value: T | undefined,
  toRows: (value: T | undefined) => readonly RowPair[],
  toEmit: (rows: readonly RowPair[]) => T | undefined,
  onChange: (value: T | undefined) => void,
) => {
  const [rows, setRows] = React.useState(() => toRows(value));
  const signature = JSON.stringify(value ?? null);
  const emitted = React.useRef(signature);
  if (emitted.current !== signature) {
    emitted.current = signature;
    setRows(toRows(value));
  }

  const write = (next: readonly RowPair[]) => {
    setRows(next);
    const emit = toEmit(next);
    emitted.current = JSON.stringify(emit ?? null);
    onChange(emit);
  };

  return { rows, write };
};

/**
 * 请求头按行编辑。空行（头名和值都空）不产生任何键；只有头名的行也保留 ——
 * 「先写头名再补值」是正常输入顺序，保存时值就是空串。
 */
const HeadersEditor = ({
  value,
  onChange,
}: {
  readonly value: Record<string, string> | undefined;
  readonly onChange: (value: Record<string, string> | undefined) => void;
}) => {
  const { rows, write } = useRowPairEditor<Record<string, string>>(
    value,
    (v) => Object.entries(v ?? {}).map(([name, entry]) => ({ first: name, second: entry })),
    (next) => {
      const record: Record<string, string> = {};
      for (const row of next) {
        const name = row.first.trim();
        // 同名行以后写的为准，与 JSON.parse 对对象字面量的语义一致。
        if (name !== '') {
          record[name] = row.second;
        }
      }
      // 一行有效数据都没有 = 未设置：删键而不是留 {}。
      return Object.keys(record).length === 0 ? undefined : record;
    },
    onChange,
  );

  return (
    <RowPairList
      rows={rows}
      firstLabel={t.fields.upstreamHeaders.name}
      secondLabel={t.fields.upstreamHeaders.value}
      addRowLabel={t.common.addRow}
      removeRowLabel={t.common.removeRow}
      firstInvalid={(first) => RESERVED_REQUEST_HEADERS.has(first.trim().toLowerCase())}
      onRowsChange={write}
    />
  );
};

/**
 * 字面替换按行编辑。from 为空的行不发出去：schema 是 `min(1)`，发了必被拒。
 * 行留在原地不消失 —— 「先写查找再补替换」是正常输入顺序；提示文案如实说了
 * 「查找为空的行不保存」，不是静默丢弃。
 */
const ReplaceEditor = ({
  value,
  onChange,
}: {
  readonly value: readonly { from: string; to: string }[] | undefined;
  readonly onChange: (value: readonly { from: string; to: string }[] | undefined) => void;
}) => {
  const { rows, write } = useRowPairEditor<readonly { from: string; to: string }[]>(
    value,
    (v) => (v ?? []).map((entry) => ({ first: entry.from, second: entry.to })),
    (next) => {
      // from 不 trim：它是字面查找文本，首尾空格可能是本意。
      const entries = next
        .filter((row) => row.first !== '')
        .map((row) => ({ from: row.first, to: row.second }));
      return entries.length === 0 ? undefined : entries;
    },
    onChange,
  );

  return (
    <RowPairList
      rows={rows}
      firstLabel={t.fields.bodyRewrite.replaceFrom}
      secondLabel={t.fields.bodyRewrite.replaceTo}
      addRowLabel={t.fields.bodyRewrite.addRow}
      removeRowLabel={t.fields.bodyRewrite.removeRow}
      onRowsChange={write}
    />
  );
};

/* ---------- 匹配条件行编辑 ---------- */

/**
 * 一行条件的表单形态。三个族共用一行模型：`present` 拆成「存在/不存在」两个
 * 下拉项——四项比「算子三选一 + 布尔翻转」少一次 mental gymnastics；`value`
 * 在 present 两个算子下是隐藏态，切回来还能找回刚打的字。
 */
interface ConditionRow {
  readonly family: 'headers' | 'query' | 'cookies';
  readonly name: string;
  readonly op: 'equals' | 'prefix' | 'present' | 'absent';
  readonly value: string;
}

/**
 * definition 里的条件没有行身份，下标就是行的 key——行只能整行增删，不能排序，
 * 所以不会出现键控下标的老毛病。条件从 definition 直接读，没有本地副本：表单与
 * JSON 视图共享同一份草稿（文件头注释的约定），JSON 里手改条件立即出现在表单。
 */
const rowsFromMatch = (match: RouteDefinition['match']): readonly ConditionRow[] => {
  const rows: ConditionRow[] = [];
  const read = (family: ConditionRow['family'], conditions?: readonly MatchCondition[]) => {
    for (const condition of conditions ?? []) {
      const op =
        condition.present !== undefined
          ? condition.present
            ? ('present' as const)
            : ('absent' as const)
          : condition.prefix !== undefined
            ? ('prefix' as const)
            : ('equals' as const);
      rows.push({
        family,
        name: condition.name,
        op,
        value: op === 'prefix' ? (condition.prefix ?? '') : (condition.equals ?? ''),
      });
    }
  };
  read('headers', match?.headers);
  read('query', match?.query);
  read('cookies', match?.cookies);
  return rows;
};

/** 名字 trim：token 名不允许空格，末尾空格永远是没打完的字。大小写原样上交。 */
const conditionFromRow = (row: ConditionRow): MatchCondition => {
  const name = row.name.trim();
  if (row.op === 'present') {
    return { name, present: true };
  }
  if (row.op === 'absent') {
    return { name, present: false };
  }
  if (row.op === 'prefix') {
    return { name, prefix: row.value };
  }
  // equals 允许空串：`X-Foo:` 与 `?debug=` 是真实流量。
  return { name, equals: row.value };
};

/**
 * 条件编辑器：行直接落在 definition 上，不设「草稿态」。加一行立刻写入
 * `{name:'', equals:''}`，由 collectErrors 拦住保存——与 upstream 的处理一致
 * （不完整就存，存了就明说哪没写完），而不是造第二份状态。
 */
const ConditionsEditor = ({
  match,
  onChange,
}: {
  readonly match: RouteDefinition['match'];
  readonly onChange: (rows: readonly ConditionRow[]) => void;
}) => {
  const rows = rowsFromMatch(match);
  const write = onChange;

  const familyPlaceholder: Record<ConditionRow['family'], string> = {
    headers: t.fields.matchConditions.nameHeader,
    query: t.fields.matchConditions.nameQuery,
    cookies: t.fields.matchConditions.nameCookie,
  };

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <Select
            value={row.family}
            onValueChange={(value) =>
              write(
                rows.map((entry, i) =>
                  i === index ? { ...entry, family: value as ConditionRow['family'] } : entry,
                ),
              )
            }
          >
            <SelectTrigger
              className="w-28 shrink-0"
              aria-label={`${t.fields.matchConditions.family} ${String(index + 1)}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="headers">{t.fields.matchConditions.familyHeader}</SelectItem>
              <SelectItem value="query">{t.fields.matchConditions.familyQuery}</SelectItem>
              <SelectItem value="cookies">{t.fields.matchConditions.familyCookie}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="w-44 shrink-0 font-mono text-xs"
            placeholder={familyPlaceholder[row.family]}
            aria-label={`${t.fields.matchConditions.name} ${String(index + 1)}`}
            aria-invalid={row.name.trim() === ''}
            value={row.name}
            onChange={(event) =>
              write(
                rows.map((entry, i) =>
                  i === index ? { ...entry, name: event.target.value } : entry,
                ),
              )
            }
          />
          <Select
            value={row.op}
            onValueChange={(value) =>
              write(
                rows.map((entry, i) =>
                  i === index ? { ...entry, op: value as ConditionRow['op'] } : entry,
                ),
              )
            }
          >
            <SelectTrigger
              className="w-32 shrink-0"
              aria-label={`${t.fields.matchConditions.op} ${String(index + 1)}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="equals">{t.fields.matchConditions.opEquals}</SelectItem>
              <SelectItem value="prefix">{t.fields.matchConditions.opPrefix}</SelectItem>
              <SelectItem value="present">{t.fields.matchConditions.opPresent}</SelectItem>
              <SelectItem value="absent">{t.fields.matchConditions.opAbsent}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="min-w-0 flex-1 font-mono text-xs"
            placeholder={
              row.op === 'present' || row.op === 'absent'
                ? t.fields.matchConditions.valueHidden
                : t.fields.matchConditions.value
            }
            aria-label={`${t.fields.matchConditions.value} ${String(index + 1)}`}
            aria-disabled={row.op === 'present' || row.op === 'absent'}
            disabled={row.op === 'present' || row.op === 'absent'}
            value={row.value}
            onChange={(event) =>
              write(
                rows.map((entry, i) =>
                  i === index ? { ...entry, value: event.target.value } : entry,
                ),
              )
            }
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`${t.fields.matchConditions.removeRow} ${String(index + 1)}`}
            onClick={() => write(rows.filter((_, i) => i !== index))}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => write([...rows, { family: 'headers', name: '', op: 'equals', value: '' }])}
        >
          <PlusIcon />
          {t.fields.matchConditions.add}
        </Button>
      </div>
    </div>
  );
};

/* ---------- 校验与错误分派 ---------- */

/** 把明显的错拦在一次网络往返之前；权威判定在服务端 /api/preview。 */
const collectErrors = (
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
  return errors;
};

/**
 * 保存失败的分派：按错误码选文案，不去匹配服务端的句子（那种匹配在后端改一个字
 * 时会静默失效）。detail 是服务端给出的人话，比错误码可读。
 */
const saveErrorMessage = (error: unknown): string => {
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

/* ---------- 编辑器本体 ---------- */

export interface RouteEditorProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 预填数据；createMode 时 definition 可能来自「复制」或全默认。 */
  readonly initial: { id: string; definition: RouteDefinition; enabled: boolean } | null;
  /** true：ID 可编辑；false：ID 只读显示。 */
  readonly createMode: boolean;
  /** 保存成功后回调（调用方负责刷新草稿与关弹窗）。 */
  readonly onSaved: (id: string) => void;
  /** 保存成功 toast 上的「去发布」动作；undefined = 不显示该按钮。 */
  readonly onGoPublish?: () => void;
}

export const RouteEditor = ({
  open,
  onOpenChange,
  initial,
  createMode,
  onSaved,
  onGoPublish,
}: RouteEditorProps) => {
  const initialId = initial?.id ?? '';
  const initialEnabled = initial?.enabled ?? true;
  const initialDefinition = initial?.definition ?? {};

  const [id, setId] = React.useState(initialId);
  const [enabled, setEnabled] = React.useState(initialEnabled);
  const [definition, setDefinitionState] = React.useState<RouteDefinition>(initialDefinition);
  /**
   * 「用户动过这个表单没有」——任何一次写入（definition、id、enabled）都置位，
   * 且不回头。不能拿 dirty 代替：新建模式 definition 初始为空对象，打一个字再
   * 清掉就回到初始签名，dirty 变 false，错误会重新藏起来——但用户确实动过手，
   * 错误该继续见人。也不用「点了保存」当信号：保存按钮在有错时是禁用的，
   * 点击根本不会触发。
   */
  const [formTouched, setFormTouched] = React.useState(false);
  /** 所有写入走这一扇门：写 definition 的同时标记「动过」。 */
  const setDefinition: React.Dispatch<React.SetStateAction<RouteDefinition>> = (update) => {
    setFormTouched(true);
    setDefinitionState(update);
  };
  const [tab, setTab] = React.useState<'form' | 'json'>('form');
  // JSON 文本是 definition 的投影：进入 JSON 视图时按需生成，编辑时逐键解析。
  const [jsonText, setJsonText] = React.useState('');
  const [jsonError, setJsonError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  /**
   * 已绑定域名候选（issue #19）。null = 还在读。读不到的原因（未配凭据、接口
   * 失败、账号没绑定）不在这里区分 —— UI 结果一样：没候选 + 一行低调小字，
   * 原因的解释是域名页的职责。
   */
  const [hostBindings, setHostBindings] = React.useState<readonly HostBinding[] | null>(null);

  /**
   * 两组手风琴的展开集合。初始值 = 已有内容的卡自动展开；之后由用户自由收展，
   * 徽章始终报状态，收起不丢数据。
   */
  const [guardsOpen, setGuardsOpen] = React.useState<string[]>(() =>
    initialOpenFor(initialDefinition),
  );
  const [advancedOpen, setAdvancedOpen] = React.useState<string[]>(() =>
    initialOpenFor(initialDefinition).filter((item): item is AdvancedItem =>
      (ADVANCED_ITEMS as readonly string[]).includes(item),
    ),
  );

  /** jsonText 反映的是哪个版本的 definition（稳定序列化签名）。 */
  const jsonSignature = React.useRef<string | null>(null);

  const initialSignature = React.useMemo(
    () => stableStringify(initialDefinition),
    [initialDefinition],
  );
  // 键顺序不算改动，所以脏检查用稳定序列化。
  const dirty =
    stableStringify(definition) !== initialSignature ||
    id !== initialId ||
    enabled !== initialEnabled;

  /** 弹窗每开一次都重读：绑定可能在上次关闭后变了；服务端有 60s 缓存兜底。 */
  React.useEffect(() => {
    if (!open) {
      return;
    }
    // 先清掉上一次打开留下的候选，别让旧数据顶在新弹窗里。
    setHostBindings(null);
    let cancelled = false;
    api.domains().then(
      (result) => {
        if (!cancelled) {
          setHostBindings(result.configured ? (result.hosts ?? []) : []);
        }
      },
      () => {
        if (!cancelled) {
          setHostBindings([]);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 同一 host 可能来自多个 kind：Map 去重以第一次出现的为准，保 API 顺序。
  const hostOptions = hostBindings === null ? [] : toHostOptions(hostBindings);

  const errors = collectErrors(createMode, id, definition);
  const hasErrors = Object.keys(errors).length > 0;
  const tooBig = jsonByteLength(definition) > LIMITS.definitionBytes;
  // JSON 没修好 / 校验没过 / 超上限，三者都会被服务端或预览拒绝，先在这里拦住。
  const blocked = saving || jsonError !== null || hasErrors || tooBig;
  /**
   * 亮不亮是展示，拦不拦是规则：blocked 用全量 errors（保存必须真被拦），
   * 展示层（红框、卡徽章、页脚摘要）用 shownErrors。新建模式第一屏还没有用户
   * 输入，id/upstream 的「还没写」错误先静音——pristine 时也只可能有这两种错
   * （其余错误都需要先写内容），静音零损失。编辑模式永远全显：那里的数据是
   * 真实存在的，有问题该立刻见人。
   */
  const shownErrors: FieldErrors = createMode && !formTouched ? {} : errors;
  /**
   * 保存禁用时页脚的一句话摘要，引用第一条错误原文（错误文本自报家门）。
   * jsonError 不参与静音：在 textarea 里打坏字不走 setDefinition，但用户确实
   * 动过手——不过 JSON 页自己已经亮着带行列位置的 alert，页脚不复读；
   * 切回表单页后字段都还停在上次成功的定义上，这时页脚是唯一的解释。
   * tooBig 有自己的警示行，也不在这里重复。
   */
  const firstBlocker =
    jsonError !== null
      ? tab === 'json'
        ? null
        : t.editor.jsonInvalid
      : (Object.values(shownErrors)[0] ?? null);

  /* ---------- 写 definition 的统一出口：空值删键，不落空串与空对象。 ---------- */

  const setTopLevel = (key: string, value: unknown) =>
    setDefinition((prev) => {
      const next = { ...prev };
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });

  /** 一次写多个顶层键（undefined 删键）—— 预设按钮是唯一的调用方。 */
  const setTopLevelFields = (fields: Record<string, unknown>) =>
    setDefinition((prev) => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) {
          delete next[key];
        } else {
          next[key] = value;
        }
      }
      return next;
    });

  /** 刚被预设写过的框闪一下（index.css 的 field-flash），400ms 后复位。 */
  const [flashedKeys, setFlashedKeys] = React.useState<readonly string[]>([]);
  const flashFields = (keys: readonly string[]) => {
    setFlashedKeys(keys);
    window.setTimeout(() => setFlashedKeys([]), 400);
  };

  const setMatchKey = (key: 'host' | 'path', value: string | undefined) =>
    setDefinition((prev) => {
      const match: Record<string, unknown> = { ...prev.match };
      if (value === undefined) {
        delete match[key];
      } else {
        match[key] = value;
      }
      const next = { ...prev };
      // match 空了连壳一起删：空对象没有任何语义。
      if (Object.keys(match).length === 0) {
        delete next.match;
      } else {
        next.match = match as RouteDefinition['match'];
      }
      return next;
    });

  const toggleMethod = (method: string, on: boolean) =>
    setDefinition((prev) => {
      const current = prev.match?.methods ?? [];
      const methods = on
        ? [...new Set([...current, method])]
        : current.filter((entry) => entry !== method);
      const match: Record<string, unknown> = { ...prev.match };
      if (methods.length === 0) {
        delete match.methods;
      } else {
        match.methods = methods;
      }
      const next = { ...prev };
      if (Object.keys(match).length === 0) {
        delete next.match;
      } else {
        next.match = match as RouteDefinition['match'];
      }
      return next;
    });

  /**
   * 条件行写回：按行里的族重建三个数组，各自的空数组删键、match 空了连壳删。
   * host/path/methods 等其余 match 键原样保留。
   */
  const setConditionRows = (rows: readonly ConditionRow[]) =>
    setDefinition((prev) => {
      const match: Record<string, unknown> = { ...prev.match };
      const families: Record<ConditionRow['family'], MatchCondition[]> = {
        headers: [],
        query: [],
        cookies: [],
      };
      for (const row of rows) {
        families[row.family].push(conditionFromRow(row));
      }
      for (const key of ['headers', 'query', 'cookies'] as const) {
        if (families[key].length === 0) {
          delete match[key];
        } else {
          match[key] = families[key];
        }
      }
      const next = { ...prev };
      if (Object.keys(match).length === 0) {
        delete next.match;
      } else {
        next.match = match as RouteDefinition['match'];
      }
      return next;
    });

  /** 等于 schema 默认值的布尔不落键，JSON 里只保留与默认不同的决定。 */
  const setBoolean = (key: BooleanKey, checked: boolean) =>
    setDefinition((prev) => {
      const next = { ...prev };
      if (checked === BOOLEAN_DEFAULTS[key]) {
        delete next[key];
      } else {
        next[key] = checked;
      }
      return next;
    });

  /** 三段开关：开启时保留已有子键，关闭时整段删除（段的存在就是开关状态）。 */
  const setSectionOn = (section: SectionKey) =>
    setDefinition((prev) => {
      const next = { ...prev };
      if (next[section] === undefined) {
        next[section] = {};
      }
      return next;
    });
  const setSectionOff = (section: SectionKey) =>
    setDefinition((prev) => {
      const next = { ...prev };
      delete next[section];
      return next;
    });
  const setSectionKey = (section: SectionKey, key: string, value: unknown) =>
    setDefinition((prev) => {
      const current: Record<string, unknown> = {
        ...((prev[section] ?? {}) as Record<string, unknown>),
      };
      if (value === undefined) {
        delete current[key];
      } else {
        current[key] = value;
      }
      const next = { ...prev };
      next[section] = current as RouteDefinition[typeof section];
      return next;
    });

  const boolValue = (key: BooleanKey): boolean => {
    const value = definition[key];
    return typeof value === 'boolean' ? value : BOOLEAN_DEFAULTS[key];
  };

  /**
   * access.cloudflare 子段里的键。子段删空就连键一起删掉 —— `cloudflare: {}` 过不了
   * schema（audience 必填），而空段留在草稿里只会把错误推迟到发布前才被人看见。
   */
  const setAccessCloudflareKey = (key: 'team' | 'audience' | 'emails', value: unknown) =>
    setDefinition((prev) => {
      const current: Record<string, unknown> = {
        ...((prev.access?.cloudflare ?? {}) as Record<string, unknown>),
      };
      if (value === undefined) {
        delete current[key];
      } else {
        current[key] = value;
      }
      const access: Record<string, unknown> = { ...prev.access };
      if (Object.keys(current).length === 0) {
        delete access.cloudflare;
      } else {
        access.cloudflare = current;
      }
      const next = { ...prev };
      if (Object.keys(access).length === 0) {
        delete next.access;
      } else {
        next.access = access as RouteDefinition['access'];
      }
      return next;
    });

  /**
   * bodyRewrite 子段里的布尔。与 setBoolean 同样的「等于默认值不落键」语义，但
   * 不能复用它：段壳必须留下来，删到空对象就等于把整个改写关掉了。
   */
  const setBodyRewriteBoolean = (key: BodyRewriteBooleanKey, checked: boolean) =>
    setSectionKey(
      'bodyRewrite',
      key,
      checked === BODY_REWRITE_BOOLEAN_DEFAULTS[key] ? undefined : checked,
    );

  const bodyRewriteBoolValue = (key: BodyRewriteBooleanKey): boolean => {
    const value = definition.bodyRewrite?.[key];
    return typeof value === 'boolean' ? value : BODY_REWRITE_BOOLEAN_DEFAULTS[key];
  };

  /* ---------- 视图与保存 ---------- */

  const handleTabChange = (nextTab: string) => {
    if (nextTab === tab) {
      return;
    }
    if (nextTab === 'json') {
      const signature = stableStringify(definition);
      if (jsonSignature.current !== signature) {
        jsonSignature.current = signature;
        setJsonText(JSON.stringify(definition, null, 2));
        setJsonError(null);
      }
      setTab('json');
      return;
    }
    // JSON 有错也放行切回表单：表单显示的是最后一次成功解析的定义， Escape 按钮随时
    // 能把 JSON 退回那份定义 —— 锁死切换只会把人困在坏掉的 JSON 里。
    setTab('form');
  };

  const handleJsonChange = (text: string) => {
    setJsonText(text);
    const trimmed = text.trim();
    if (trimmed === '') {
      // 空文本是「还没写」：按空定义处理，报错反而把人吓退（与 defaults 卡一致）。
      setJsonError(null);
      jsonSignature.current = stableStringify({});
      setDefinition({});
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // JSON.parse 是权威判定；jsonc-parser 只用来把错误定位到行列。
      setJsonError(t.editor.jsonInvalid + ' ' + jsonErrorLocation(text));
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setJsonError(t.editor.jsonInvalid);
      return;
    }
    setJsonError(null);
    // 记下这次解析的签名：修好之后用户的排版不会被重新生成冲掉。
    jsonSignature.current = stableStringify(parsed);
    setDefinition(parsed as RouteDefinition);
  };

  /**
   * 逃生门：JSON 改坏了，退回最后一次成功解析的定义。
   * 表单视图还停在那份定义上，这里只是把 JSON 文本也对齐回来 —— 两个视图重新
   * 共享同一份数据。
   */
  const escapeJson = () => {
    setJsonText(JSON.stringify(definition, null, 2));
    jsonSignature.current = stableStringify(definition);
    setJsonError(null);
  };

  /** 关闭请求（×、Esc、遮罩、取消按钮）都要先过这一关。 */
  const requestClose = () => {
    if (saving) {
      return;
    }
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(false);
  };

  const save = async () => {
    if (blocked) {
      return;
    }
    setSaving(true);
    const savedId = id;
    try {
      await api.putRoute(savedId, definition, enabled);
    } catch (error) {
      setSaving(false);
      toast.error(saveErrorMessage(error));
      return;
    }
    // 先落 saving 再回调：回调会把本组件卸载，别在卸载之后 setState。
    setSaving(false);
    // 保存只写草稿；「去发布」把下一步顺手递到手上，不接也不会丢。
    toast.success(t.editor.saved(savedId), {
      action:
        onGoPublish !== undefined ? { label: t.editor.goPublish, onClick: onGoPublish } : undefined,
    });
    onSaved(savedId);
  };

  const unknownKeys = Object.keys(definition).filter((key) => !FORM_COVERED_KEYS.includes(key));
  const reservedHeaders = reservedHeaderNames(definition);
  // 鉴权段的保留名检查：抄回头最终写进上游请求，与 requestHeaders 同一套拒绝表。
  const forwardAuthReservedRequest = reservedNamesIn(definition.forwardAuth?.copyRequestHeaders);
  const forwardAuthReservedResponse = reservedNamesIn(definition.forwardAuth?.copyResponseHeaders);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen: boolean) => {
        // 打开由父组件决定；关闭请求先过「放弃改动」这一关。
        if (nextOpen) {
          onOpenChange(true);
          return;
        }
        requestClose();
      }}
    >
      {/*
        小屏改用贯通上下的全高 sheet，不是居中卡片。居中卡片在 375×667 上只剩 153px
        表单区（实测），键盘一弹更归零；把上下 127px 留白还给表单之后是 449px。

        水平方向始终居中限宽：横屏 844×390 也走全高（roomy 要求同时够宽够高），若再
        放开宽度，一行 host 输入框会拉到 812px —— 全高解决的是高度，不是让字变长。
        sm:max-w-none 那一档必须显式关掉：nova 基类带着 sm:max-w-sm（384px），先前是
        被 sm:max-w-2xl 压住的，换成 roomy 之后它会在横屏区间冒出来（实测弹窗塌到
        384px 宽）。
      */}
      <DialogContent className="top-0 left-1/2 flex h-dvh max-h-none w-full max-w-none -translate-x-1/2 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-w-2xl roomy:top-1/2 roomy:h-auto roomy:max-h-[85dvh] roomy:-translate-y-1/2 roomy:rounded-xl">
        <DialogHeader className="border-b px-4 py-4">
          <DialogTitle>
            {createMode ? t.editor.createTitle : t.editor.editTitle(initialId)}
          </DialogTitle>
          <DialogDescription>{t.editor.description}</DialogDescription>
        </DialogHeader>

        {/*
          常驻草稿条：和标题一样在滚动容器外，滚到哪一行都看得见「这是草稿」。
          产品不变式：保存绝不暗示上线 —— 这一条就是那句话的 UI 形态。
        */}
        <div className="bg-muted/40 flex items-center gap-2 border-b px-4 py-1.5">
          <Badge variant="secondary" className="shrink-0">
            {t.editor.draftBanner}
          </Badge>
          <span className="text-muted-foreground truncate text-xs">{t.editor.draftBannerHint}</span>
        </div>

        <Tabs
          value={tab}
          onValueChange={handleTabChange}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="px-4 py-2">
            <TabsList>
              <TabsTrigger value="form">{t.editor.tabForm}</TabsTrigger>
              <TabsTrigger value="json">{t.editor.tabJson}</TabsTrigger>
            </TabsList>
          </div>

          {/*
            唯一的滚动容器。标识（ID 与启用开关）从前常驻在这上面，占 183px 固定高度
            —— 而 ID 已经写在标题里了，窄屏拿掉重复的那一份，表单区从 153px 涨到
            477px（375×667 实测）。常驻的只剩标题、视图切换与页脚这三样非它不可的。
          */}
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-4 py-4">
            <FieldSet>
              <FieldLegend>{t.fields.sections.identity}</FieldLegend>
              <FieldDescription>
                <Hint text={t.fields.sections.identityHint} />
              </FieldDescription>

              <Field data-invalid={shownErrors.id !== undefined ? true : undefined}>
                <FieldLabel htmlFor="route-editor-id">{t.editor.idLabel}</FieldLabel>
                {createMode ? (
                  <Input
                    id="route-editor-id"
                    className="font-mono"
                    value={id}
                    aria-invalid={shownErrors.id !== undefined}
                    onChange={(event) => {
                      setFormTouched(true);
                      setId(event.target.value);
                    }}
                  />
                ) : (
                  <Input id="route-editor-id" className="font-mono" value={id} readOnly />
                )}
                <FieldDescription>
                  <Hint text={createMode ? t.editor.idHint : t.editor.idImmutable} />
                </FieldDescription>
                {shownErrors.id !== undefined && <FieldError>{shownErrors.id}</FieldError>}
              </Field>

              <Field orientation="horizontal">
                <Switch
                  id="route-editor-enabled"
                  checked={enabled}
                  onCheckedChange={(checked) => {
                    setFormTouched(true);
                    setEnabled(checked);
                  }}
                />
                <FieldContent>
                  <FieldLabel htmlFor="route-editor-enabled">{t.editor.enabledLabel}</FieldLabel>
                  <FieldDescription>
                    <Hint text={t.editor.enabledHint} />
                  </FieldDescription>
                </FieldContent>
              </Field>
            </FieldSet>

            <TabsContent value="form" className="min-h-0">
              <div className="flex flex-col gap-6">
                {/*
                  「去哪里」= 原来的匹配 + 上游两层并成一层：这两组问题（什么请求、
                  去哪儿）在脑中是一件事，分两个标题反而要人来回翻页对齐。
                */}
                <FieldSet>
                  <FieldLegend>{t.fields.sections.destination}</FieldLegend>
                  <FieldDescription>
                    <Hint text={t.fields.sections.destinationHint} />
                  </FieldDescription>

                  <HostProperty
                    id="route-editor-match-host"
                    label={t.fields.matchHost.label}
                    hint={t.fields.matchHost.help}
                    placeholder={t.fields.matchHost.placeholder}
                    value={definition.match?.host ?? ''}
                    options={hostOptions}
                    fallbackNote={
                      hostBindings !== null && hostOptions.length === 0
                        ? t.editor.hostFallbackNote
                        : undefined
                    }
                    onChange={(value) => setMatchKey('host', value === '' ? undefined : value)}
                  />
                  <TextProperty
                    id="route-editor-match-path"
                    label={t.fields.matchPath.label}
                    hint={t.fields.matchPath.help}
                    placeholder={t.fields.matchPath.placeholder}
                    mono
                    value={definition.match?.path ?? ''}
                    onChange={(value) => setMatchKey('path', value === '' ? undefined : value)}
                  />

                  <Field>
                    <FieldLabel>{t.fields.matchMethods.label}</FieldLabel>
                    <FieldDescription>
                      <Hint text={t.fields.matchMethods.help} />
                    </FieldDescription>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {HTTP_METHODS.map((method) => (
                        /*
                        触摸下靠 label 自己长到 44px，而不是给复选框铺一层看不见的
                        命中面：这一组在窄屏要换到三行，看不见的命中面会上下叠在一
                        起，点第二行会命中第一行。label 长高会把行推开，是真的变大。
                      */
                        <label key={method} className="flex items-center gap-2 touch:py-3.5">
                          <Checkbox
                            checked={definition.match?.methods?.includes(method) ?? false}
                            aria-label={method}
                            onCheckedChange={(checked) => toggleMethod(method, checked)}
                          />
                          <span className="font-mono text-xs">{method}</span>
                        </label>
                      ))}
                    </div>
                  </Field>

                  <Field
                    data-invalid={shownErrors.matchConditions !== undefined ? true : undefined}
                  >
                    <FieldLabel>{t.fields.matchConditions.label}</FieldLabel>
                    <FieldDescription>
                      <Hint text={t.fields.matchConditions.help} />
                    </FieldDescription>
                    <ConditionsEditor match={definition.match} onChange={setConditionRows} />
                    {shownErrors.matchConditions !== undefined && (
                      <FieldError>{shownErrors.matchConditions}</FieldError>
                    )}
                  </Field>
                  <TextProperty
                    id="route-editor-upstream"
                    label={t.fields.upstream.label}
                    hint={t.fields.upstream.help}
                    placeholder={t.fields.upstream.placeholder}
                    mono
                    error={shownErrors.upstream}
                    value={typeof definition.upstream === 'string' ? definition.upstream : ''}
                    onChange={(value) => {
                      // upstream 里空格永远是错字，输入时就去掉；协议头交给校验拦。
                      const next = value.trim();
                      setTopLevel('upstream', next === '' ? undefined : next);
                    }}
                  />

                  <Field data-invalid={shownErrors.scheme !== undefined ? true : undefined}>
                    <FieldLabel htmlFor="route-editor-scheme">{t.fields.scheme.label}</FieldLabel>
                    <Select
                      value={definition.scheme ?? SCHEME_UNSET}
                      onValueChange={(value) =>
                        setTopLevel(
                          'scheme',
                          value === 'http' || value === 'https' ? value : undefined,
                        )
                      }
                    >
                      {/*
                      Field vertical 的 `*:w-full` 与 w-44 同特异性且排在后面，普通
                      w-44 是死代码（实测桌面下这个下拉是 640px 宽，不是 176px），所
                      以要 important。窄屏留全宽：触摸目标越宽越好按。
                    */}
                      <SelectTrigger
                        id="route-editor-scheme"
                        className="sm:w-44!"
                        aria-label={t.fields.scheme.label}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SCHEME_UNSET}>{t.common.unset}</SelectItem>
                        <SelectItem value="https">https</SelectItem>
                        <SelectItem value="http">http</SelectItem>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      <Hint text={t.fields.scheme.help} /> {t.common.defaultValue(SCHEME_DEFAULT)}
                    </FieldDescription>
                    {shownErrors.scheme !== undefined && (
                      <FieldError>{shownErrors.scheme}</FieldError>
                    )}
                  </Field>
                  {definition.scheme === 'http' && <DangerNote path="scheme" />}

                  {/* stripPrefix 跟着 path 走：它决定转发时保不保留匹配前缀，是「去哪里」
                      这条链路的最后一站。放在改写区会让人在错误的层找它。 */}
                  <SwitchProperty
                    id={BOOLEAN_FIELDS.stripPrefix.id}
                    label={BOOLEAN_FIELDS.stripPrefix.label}
                    hint={BOOLEAN_FIELDS.stripPrefix.help}
                    defaultNote={t.common.defaultValue(String(BOOLEAN_DEFAULTS.stripPrefix))}
                    checked={boolValue('stripPrefix')}
                    onCheckedChange={(checked) => setBoolean('stripPrefix', checked)}
                  />

                  <SwitchProperty
                    id="route-editor-allow-private"
                    label={t.fields.allowPrivateUpstream.label}
                    hint={t.fields.allowPrivateUpstream.help}
                    checked={definition.allowPrivateUpstream === true}
                    onCheckedChange={(checked) =>
                      setTopLevel('allowPrivateUpstream', checked ? true : undefined)
                    }
                  />
                  {definition.allowPrivateUpstream === true && (
                    <DangerNote path="allowPrivateUpstream" />
                  )}
                </FieldSet>

                {/* 「谁能来」用手风琴而不是平铺：五组守卫各自独立，小白一眼只该看到
                    「都没开」这个事实，而不是五组填不完的输入框。初始只展开已经配过
                    的卡 —— 藏起已配置的区块等于藏起数据；用户收起不丢内容。 */}
                <div className="flex flex-col gap-2">
                  <FieldLegend>{t.fields.sections.guards}</FieldLegend>
                  <FieldDescription>
                    <Hint text={t.fields.sections.guardsHint} />
                  </FieldDescription>
                </div>
                <Accordion value={guardsOpen} onValueChange={setGuardsOpen}>
                  <AccordionItem value="countries">
                    <AccordionHeader>
                      <SectionCardTrigger
                        label={t.fields.sections.countries}
                        set={guardsItemSet(definition, 'countries')}
                        kind="guard"
                      />
                    </AccordionHeader>
                    <AccordionContent>
                      <div className="flex flex-col gap-4">
                        <ListProperty
                          id="route-editor-block-countries"
                          label={t.fields.blockCountries.label}
                          hint={t.fields.blockCountries.help}
                          placeholder={t.fields.blockCountries.placeholder}
                          tip={t.fields.blockCountries.tip}
                          value={definition.blockCountries}
                          onChange={(value) => setTopLevel('blockCountries', value)}
                        />
                        <ListProperty
                          id="route-editor-allow-countries"
                          label={t.fields.allowCountries.label}
                          hint={t.fields.allowCountries.help}
                          placeholder={t.fields.allowCountries.placeholder}
                          tip={t.fields.allowCountries.tip}
                          value={definition.allowCountries}
                          onChange={(value) => setTopLevel('allowCountries', value)}
                        />
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="cors">
                    <AccordionHeader>
                      <SectionCardTrigger
                        label={t.fields.cors.label}
                        kind="guard"
                        set={definition.cors !== undefined}
                      />
                    </AccordionHeader>
                    <AccordionContent>
                      <div className="flex flex-col gap-4">
                        <Field orientation="horizontal">
                          <Switch
                            id="route-editor-cors"
                            checked={definition.cors !== undefined}
                            onCheckedChange={(checked) =>
                              checked ? setSectionOn('cors') : setSectionOff('cors')
                            }
                          />
                          <FieldContent>
                            <FieldLabel htmlFor="route-editor-cors">
                              {t.fields.cors.label}
                            </FieldLabel>
                          </FieldContent>
                        </Field>

                        {definition.cors !== undefined && (
                          <>
                            <ListProperty
                              id="route-editor-cors-origins"
                              label={t.fields.cors.origins}
                              hint={t.fields.cors.originsHelp}
                              placeholder={t.fields.cors.originsPlaceholder}
                              value={definition.cors.origins}
                              onChange={(value) => setSectionKey('cors', 'origins', value)}
                            />
                            {/* 这一项的危险状态是「缺失」而不是「存在」。 */}
                            {(definition.cors.origins?.length ?? 0) === 0 && (
                              <DangerNote path="cors.origins (absent)" />
                            )}
                            <ListProperty
                              id="route-editor-cors-allow-methods"
                              label={t.fields.cors.allowMethods}
                              hint={t.fields.cors.allowMethodsHelp}
                              placeholder="GET, POST"
                              value={definition.cors.allowMethods}
                              onChange={(value) => setSectionKey('cors', 'allowMethods', value)}
                            />
                            <ListProperty
                              id="route-editor-cors-allow-headers"
                              label={t.fields.cors.allowHeaders}
                              hint={t.fields.cors.allowHeadersHelp}
                              value={definition.cors.allowHeaders}
                              onChange={(value) => setSectionKey('cors', 'allowHeaders', value)}
                            />
                            <ListProperty
                              id="route-editor-cors-expose-headers"
                              label={t.fields.cors.exposeHeaders}
                              hint={t.fields.cors.exposeHeadersHelp}
                              value={definition.cors.exposeHeaders}
                              onChange={(value) => setSectionKey('cors', 'exposeHeaders', value)}
                            />
                            <SwitchProperty
                              id="route-editor-cors-credentials"
                              label={t.fields.cors.credentials}
                              hint={t.fields.cors.credentialsHelp}
                              defaultNote={t.common.defaultValue('false')}
                              checked={definition.cors.credentials === true}
                              onCheckedChange={(checked) =>
                                // 默认 false：等于默认值不落键，段壳保留。
                                setSectionKey('cors', 'credentials', checked ? true : undefined)
                              }
                            />
                            <NumberProperty
                              id="route-editor-cors-max-age"
                              label={t.fields.cors.maxAge}
                              unit="秒"
                              hint={t.fields.cors.maxAgeHelp}
                              value={
                                definition.cors.maxAge === undefined
                                  ? ''
                                  : String(definition.cors.maxAge)
                              }
                              min={0}
                              onChange={(raw) => {
                                // schema 只要求非负整数；没有上限常量就不假装有，交给服务端判。
                                const next = raw === '' ? undefined : Number(raw);
                                setSectionKey(
                                  'cors',
                                  'maxAge',
                                  next !== undefined &&
                                    (Number.isNaN(next) || !Number.isInteger(next) || next < 0)
                                    ? undefined
                                    : next,
                                );
                              }}
                            />
                          </>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="ip">
                    <AccordionHeader>
                      <SectionCardTrigger
                        label={t.fields.ip.label}
                        kind="guard"
                        set={definition.ip !== undefined}
                      />
                    </AccordionHeader>
                    <AccordionContent>
                      <div className="flex flex-col gap-4">
                        <Field orientation="horizontal">
                          <Switch
                            id="route-editor-ip"
                            checked={definition.ip !== undefined}
                            onCheckedChange={(checked) =>
                              checked ? setSectionOn('ip') : setSectionOff('ip')
                            }
                          />
                          <FieldContent>
                            <FieldLabel htmlFor="route-editor-ip">{t.fields.ip.label}</FieldLabel>
                          </FieldContent>
                        </Field>

                        {definition.ip !== undefined && (
                          <>
                            <ListProperty
                              id="route-editor-ip-allow"
                              label={t.fields.ip.allow}
                              hint={t.fields.ip.allowHelp}
                              tip={t.fields.ip.tip}
                              value={definition.ip.allow}
                              onChange={(value) => setSectionKey('ip', 'allow', value)}
                            />
                            {(definition.ip.allow?.length ?? 0) > 0 && (
                              <DangerNote path="ip.allow" />
                            )}
                            <ListProperty
                              id="route-editor-ip-deny"
                              label={t.fields.ip.deny}
                              hint={t.fields.ip.denyHelp}
                              tip={t.fields.ip.tip}
                              value={definition.ip.deny}
                              onChange={(value) => setSectionKey('ip', 'deny', value)}
                            />
                            {(definition.ip.deny?.length ?? 0) > 0 && <DangerNote path="ip.deny" />}
                          </>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="access">
                    <AccordionHeader>
                      <SectionCardTrigger
                        label={t.fields.access.label}
                        kind="guard"
                        set={definition.access !== undefined}
                      />
                    </AccordionHeader>
                    <AccordionContent>
                      <div className="flex flex-col gap-4">
                        <Field orientation="horizontal">
                          <Switch
                            id="route-editor-access"
                            checked={definition.access !== undefined}
                            onCheckedChange={(checked) =>
                              checked ? setSectionOn('access') : setSectionOff('access')
                            }
                          />
                          <FieldContent>
                            <FieldLabel htmlFor="route-editor-access">
                              {t.fields.access.label}
                            </FieldLabel>
                          </FieldContent>
                        </Field>

                        {definition.access !== undefined && (
                          <>
                            <p className="text-muted-foreground text-xs">{t.fields.access.hint}</p>

                            <Field orientation="horizontal">
                              <Switch
                                id="route-editor-access-cf"
                                checked={definition.access.cloudflare !== undefined}
                                onCheckedChange={(checked) =>
                                  setSectionKey(
                                    'access',
                                    'cloudflare',
                                    // `cloudflare: {}` 与 ip: {} 一样是半成品草稿：audience
                                    // 必填这条由服务端在发布前指出。
                                    checked ? {} : undefined,
                                  )
                                }
                              />
                              <FieldContent>
                                <FieldLabel htmlFor="route-editor-access-cf">
                                  {t.fields.access.cfEnable}
                                </FieldLabel>
                              </FieldContent>
                            </Field>

                            {definition.access.cloudflare !== undefined && (
                              <>
                                <TextProperty
                                  id="route-editor-access-team"
                                  label={t.fields.access.team}
                                  hint={t.fields.access.teamHelp}
                                  value={definition.access.cloudflare.team ?? ''}
                                  mono
                                  onChange={(value) =>
                                    setAccessCloudflareKey('team', value === '' ? undefined : value)
                                  }
                                />
                                <TextProperty
                                  id="route-editor-access-audience"
                                  label={t.fields.access.audience}
                                  hint={t.fields.access.audienceHelp}
                                  tip={t.fields.access.audienceTip}
                                  value={definition.access.cloudflare.audience ?? ''}
                                  mono
                                  onChange={(value) =>
                                    setAccessCloudflareKey(
                                      'audience',
                                      value === '' ? undefined : value,
                                    )
                                  }
                                />
                                <ListProperty
                                  id="route-editor-access-emails"
                                  label={t.fields.access.emails}
                                  hint={t.fields.access.emailsHelp}
                                  placeholder={t.fields.access.emailsPlaceholder}
                                  value={definition.access.cloudflare.emails}
                                  onChange={(value) => setAccessCloudflareKey('emails', value)}
                                />
                              </>
                            )}

                            <ListProperty
                              id="route-editor-access-keys"
                              label={t.fields.access.keys}
                              hint={t.fields.access.keysHelp}
                              placeholder={t.fields.access.keysPlaceholder}
                              value={definition.access.keys}
                              onChange={(value) => setSectionKey('access', 'keys', value)}
                            />
                            {(definition.access.keys?.length ?? 0) > 0 && (
                              <DangerNote path="access.keys" />
                            )}

                            <TextProperty
                              id="route-editor-access-header"
                              label={t.fields.access.header}
                              hint={t.fields.access.headerHelp}
                              value={definition.access.header ?? ''}
                              mono
                              onChange={(value) =>
                                setSectionKey('access', 'header', value === '' ? undefined : value)
                              }
                            />
                          </>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="forwardAuth">
                    <AccordionHeader>
                      <SectionCardTrigger
                        label={t.fields.forwardAuth.label}
                        kind="guard"
                        set={definition.forwardAuth !== undefined}
                        needsFix={
                          forwardAuthReservedRequest.length > 0 ||
                          forwardAuthReservedResponse.length > 0
                        }
                      />
                    </AccordionHeader>
                    <AccordionContent>
                      <div className="flex flex-col gap-4">
                        <Field orientation="horizontal">
                          <Switch
                            id="route-editor-forward-auth"
                            checked={definition.forwardAuth !== undefined}
                            onCheckedChange={(checked) =>
                              checked ? setSectionOn('forwardAuth') : setSectionOff('forwardAuth')
                            }
                          />
                          <FieldContent>
                            <FieldLabel htmlFor="route-editor-forward-auth">
                              {t.fields.forwardAuth.label}
                            </FieldLabel>
                          </FieldContent>
                        </Field>

                        {definition.forwardAuth !== undefined && (
                          <>
                            <TextProperty
                              id="route-editor-forward-auth-url"
                              label={t.fields.forwardAuth.url}
                              hint={t.fields.forwardAuth.urlHelp}
                              value={definition.forwardAuth.url ?? ''}
                              mono
                              onChange={(value) =>
                                setSectionKey(
                                  'forwardAuth',
                                  'url',
                                  value === '' ? undefined : value,
                                )
                              }
                            />
                            {/* 只有明文方案才值得警示，与 danger.ts 的 guard 同口径。 */}
                            {(definition.forwardAuth.url?.startsWith('http://') ?? false) && (
                              <DangerNote path="forwardAuth.url" />
                            )}
                            <ListProperty
                              id="route-editor-forward-auth-request-headers"
                              label={t.fields.forwardAuth.copyRequestHeaders}
                              hint={t.fields.forwardAuth.copyRequestHeadersHelp}
                              value={definition.forwardAuth.copyRequestHeaders}
                              onChange={(value) =>
                                setSectionKey('forwardAuth', 'copyRequestHeaders', value)
                              }
                            />
                            {forwardAuthReservedRequest.length > 0 && (
                              <FieldError>
                                {t.fields.forwardAuth.reserved(
                                  forwardAuthReservedRequest.join(', '),
                                )}
                              </FieldError>
                            )}
                            <ListProperty
                              id="route-editor-forward-auth-response-headers"
                              label={t.fields.forwardAuth.copyResponseHeaders}
                              hint={t.fields.forwardAuth.copyResponseHeadersHelp}
                              value={definition.forwardAuth.copyResponseHeaders}
                              onChange={(value) =>
                                setSectionKey('forwardAuth', 'copyResponseHeaders', value)
                              }
                            />
                            {forwardAuthReservedResponse.length > 0 && (
                              <FieldError>
                                {t.fields.forwardAuth.reserved(
                                  forwardAuthReservedResponse.join(', '),
                                )}
                              </FieldError>
                            )}
                            <NumberProperty
                              id="route-editor-forward-auth-timeout"
                              label={t.fields.forwardAuth.timeoutMs}
                              unit="毫秒"
                              hint={t.fields.forwardAuth.timeoutMsHelp}
                              value={
                                definition.forwardAuth.timeoutMs === undefined
                                  ? ''
                                  : String(definition.forwardAuth.timeoutMs)
                              }
                              min={NUMERIC_BOUNDS.authTimeoutMs.min}
                              max={NUMERIC_BOUNDS.authTimeoutMs.max}
                              onChange={(raw) => {
                                const next = raw === '' ? undefined : Number(raw);
                                setSectionKey(
                                  'forwardAuth',
                                  'timeoutMs',
                                  next !== undefined &&
                                    (Number.isNaN(next) ||
                                      !Number.isInteger(next) ||
                                      next < NUMERIC_BOUNDS.authTimeoutMs.min ||
                                      next > NUMERIC_BOUNDS.authTimeoutMs.max)
                                    ? undefined
                                    : next,
                                );
                              }}
                            />
                            <SwitchProperty
                              id="route-editor-forward-auth-fail-open"
                              label={t.fields.forwardAuth.failOpen}
                              hint={t.fields.forwardAuth.failOpenHelp}
                              defaultNote={t.fields.forwardAuth.failOpenDefault}
                              checked={definition.forwardAuth.failOpen === true}
                              onCheckedChange={(checked) =>
                                setSectionKey('forwardAuth', 'failOpen', checked ? true : undefined)
                              }
                            />
                            {definition.forwardAuth.failOpen === true && (
                              <DangerNote path="forwardAuth.failOpen" />
                            )}
                          </>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>

                {/* 「高级」三卡：默认值已经够用的人永远不需要展开这里。 */}
                <div className="flex flex-col gap-2">
                  <FieldLegend>{t.fields.sections.advanced}</FieldLegend>
                  <FieldDescription>
                    <Hint text={t.fields.sections.advancedHint} />
                  </FieldDescription>
                </div>
                <Accordion value={advancedOpen} onValueChange={setAdvancedOpen}>
                  <AccordionItem value="timing">
                    <AccordionHeader>
                      <SectionCardTrigger
                        label={t.fields.sections.timing}
                        set={advancedItemSet(definition, 'timing')}
                        needsFix={NUMERIC_KEYS.some((key) => shownErrors[key] !== undefined)}
                      />
                    </AccordionHeader>
                    <AccordionContent>
                      <div className="flex flex-col gap-4">
                        {/* 预设行：一次性模板。点按只填该预设覆盖的框，之后它们就是
                      普通数字，随便改 —— 配置里永远没有「指向预设」的引用。
                      闪烁只标记刚写过的框，不抢焦点：焦点属于用户。 */}
                        <div className="flex flex-wrap items-start gap-2">
                          {TIMING_PRESET_BUTTONS.map((preset) => (
                            <Button
                              key={preset.name}
                              type="button"
                              variant="outline"
                              size="sm"
                              title={preset.description}
                              onClick={() => {
                                const values: Record<string, unknown> = preset.values;
                                setTopLevelFields(
                                  Object.fromEntries(preset.keys.map((key) => [key, values[key]])),
                                );
                                flashFields(preset.keys);
                              }}
                            >
                              {preset.label}
                            </Button>
                          ))}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            title={t.fields.sections.presetClearDesc}
                            onClick={() => {
                              setTopLevelFields(
                                Object.fromEntries(NUMERIC_KEYS.map((key) => [key, undefined])),
                              );
                              flashFields([...NUMERIC_KEYS]);
                            }}
                          >
                            {t.fields.sections.presetClear}
                          </Button>
                        </div>
                        <FieldDescription>
                          <Hint text={t.fields.sections.presetHint} />
                        </FieldDescription>

                        {NUMERIC_KEYS.map((key) => (
                          <NumberProperty
                            key={key}
                            id={`route-editor-${key}`}
                            label={NUMERIC_FIELDS[key].label}
                            unit={NUMERIC_FIELDS[key].unit}
                            hint={t.fields[key].help}
                            value={definition[key] === undefined ? '' : String(definition[key])}
                            min={NUMERIC_BOUNDS[key].min}
                            max={NUMERIC_BOUNDS[key].max}
                            error={shownErrors[key]}
                            flashed={flashedKeys.includes(key)}
                            onChange={(raw) => {
                              // 数字直接存，越界与非整数交给校验就地说清；空串 = 未设置。
                              const next = raw === '' ? undefined : Number(raw);
                              setTopLevel(
                                key,
                                next !== undefined && Number.isNaN(next) ? undefined : next,
                              );
                            }}
                          />
                        ))}
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="rewrite">
                    <AccordionHeader>
                      <SectionCardTrigger
                        label={t.fields.sections.rewrite}
                        set={advancedItemSet(definition, 'rewrite')}
                      />
                    </AccordionHeader>
                    <AccordionContent>
                      <div className="flex flex-col gap-4">
                        <FieldDescription>
                          <Hint text={t.fields.sections.rewriteHint} />
                        </FieldDescription>

                        {/* stripPrefix 已随 path 搬去「去哪里」：它只改转发路径，不属于改写。 */}
                        {BOOLEAN_KEYS.filter((key) => key !== 'stripPrefix').map((key) => (
                          <SwitchProperty
                            key={key}
                            id={BOOLEAN_FIELDS[key].id}
                            label={BOOLEAN_FIELDS[key].label}
                            hint={BOOLEAN_FIELDS[key].help}
                            defaultNote={t.common.defaultValue(String(BOOLEAN_DEFAULTS[key]))}
                            checked={boolValue(key)}
                            onCheckedChange={(checked) => setBoolean(key, checked)}
                          />
                        ))}

                        <Field orientation="horizontal">
                          <Switch
                            id="route-editor-body-rewrite"
                            checked={definition.bodyRewrite !== undefined}
                            onCheckedChange={(checked) =>
                              checked ? setSectionOn('bodyRewrite') : setSectionOff('bodyRewrite')
                            }
                          />
                          <FieldContent>
                            <FieldLabel htmlFor="route-editor-body-rewrite">
                              {t.fields.bodyRewrite.label}
                            </FieldLabel>
                            <FieldDescription>
                              <Hint text={t.fields.bodyRewrite.help} />
                            </FieldDescription>
                          </FieldContent>
                        </Field>

                        {definition.bodyRewrite !== undefined && (
                          <>
                            <RewriteNote />
                            {BODY_REWRITE_BOOLEAN_KEYS.map((key) => (
                              <SwitchProperty
                                key={key}
                                id={BODY_REWRITE_BOOLEAN_FIELDS[key].id}
                                label={BODY_REWRITE_BOOLEAN_FIELDS[key].label}
                                hint={BODY_REWRITE_BOOLEAN_FIELDS[key].help}
                                defaultNote={t.common.defaultValue(
                                  String(BODY_REWRITE_BOOLEAN_DEFAULTS[key]),
                                )}
                                checked={bodyRewriteBoolValue(key)}
                                onCheckedChange={(checked) => setBodyRewriteBoolean(key, checked)}
                              />
                            ))}
                            <ListProperty
                              id="route-editor-body-rewrite-content-types"
                              label={t.fields.bodyRewrite.contentTypes}
                              hint={t.fields.bodyRewrite.contentTypesHelp}
                              value={definition.bodyRewrite.contentTypes}
                              onChange={(value) =>
                                setSectionKey('bodyRewrite', 'contentTypes', value)
                              }
                            />
                            {(definition.bodyRewrite.contentTypes?.length ?? 0) > 0 && (
                              <DangerNote path="bodyRewrite.contentTypes" />
                            )}
                            <Field>
                              <FieldLabel>{t.fields.bodyRewrite.replace}</FieldLabel>
                              <FieldDescription>
                                <Hint text={t.fields.bodyRewrite.replaceHelp} />
                              </FieldDescription>
                              <ReplaceEditor
                                value={definition.bodyRewrite.replace}
                                onChange={(value) => setSectionKey('bodyRewrite', 'replace', value)}
                              />
                            </Field>
                            <TextProperty
                              id="route-editor-body-rewrite-fallback-charset"
                              label={t.fields.bodyRewrite.fallbackCharset}
                              hint={t.fields.bodyRewrite.fallbackCharsetHelp}
                              mono
                              value={definition.bodyRewrite.fallbackCharset ?? ''}
                              onChange={(value) =>
                                setSectionKey(
                                  'bodyRewrite',
                                  'fallbackCharset',
                                  value === '' ? undefined : value,
                                )
                              }
                            />
                            {hasText(definition.bodyRewrite.fallbackCharset) && (
                              <DangerNote path="bodyRewrite.fallbackCharset" />
                            )}
                          </>
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="headers">
                    <AccordionHeader>
                      <SectionCardTrigger
                        label={t.fields.sections.headers}
                        set={advancedItemSet(definition, 'headers')}
                        needsFix={reservedHeaders.length > 0}
                      />
                    </AccordionHeader>
                    <AccordionContent>
                      <div className="flex flex-col gap-4">
                        <FieldDescription>
                          <Hint text={t.fields.sections.headersHint} />
                        </FieldDescription>

                        <Field>
                          <FieldLabel>{t.fields.upstreamHeaders.label}</FieldLabel>
                          <FieldDescription>
                            <Hint text={t.fields.upstreamHeaders.help} />
                          </FieldDescription>
                          <HeadersEditor
                            value={definition.upstreamHeaders}
                            onChange={(value) => setTopLevel('upstreamHeaders', value)}
                          />
                          {reservedHeaders.length > 0 && (
                            <FieldError>
                              {t.fields.upstreamHeaders.reserved(reservedHeaders.join(', '))}
                            </FieldError>
                          )}
                        </Field>
                        {Object.keys(definition.upstreamHeaders ?? {}).length > 0 && (
                          <DangerNote path="upstreamHeaders" />
                        )}
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>

                {unknownKeys.length > 0 && (
                  <div className="bg-muted/40 rounded-lg border p-3">
                    <div className="text-sm font-medium">{t.fields.unknownFields.label}</div>
                    <p className="text-muted-foreground mt-1 text-xs">
                      <Hint text={t.fields.unknownFields.help} />
                    </p>
                    <dl className="mt-2 flex flex-col gap-2">
                      {unknownKeys.map((key) => (
                        <div key={key} className="flex flex-col gap-0.5">
                          <dt className="font-mono text-xs">{key}</dt>
                          <dd className="text-muted-foreground font-mono text-xs break-all">
                            {previewValue(definition[key])}
                          </dd>
                          {t.fields.unknownFields.keyHelp[key] !== undefined && (
                            <dd className="text-muted-foreground text-xs">
                              {t.fields.unknownFields.keyHelp[key]}
                            </dd>
                          )}
                          {dangerousSubPaths(key, definition[key]).map((path) => (
                            <dd key={path}>
                              <DangerNote path={path} />
                            </dd>
                          ))}
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="json" className="min-h-0">
              <Field data-invalid={jsonError !== null ? true : undefined}>
                <FieldLabel htmlFor="route-editor-json">{t.editor.jsonLabel}</FieldLabel>
                {/* 小屏收一档：288px 的编辑框在窄屏或横屏上把 JSON 之外的东西全顶出可视区。 */}
                <Textarea
                  id="route-editor-json"
                  className="min-h-48 font-mono text-xs roomy:min-h-72"
                  spellCheck={false}
                  value={jsonText}
                  aria-invalid={jsonError !== null}
                  onChange={(event) => handleJsonChange(event.target.value)}
                />
                {jsonError !== null ? (
                  <>
                    <FieldError>{jsonError}</FieldError>
                    {/* 逃生门：JSON 改坏了不必手工逐字修——丢掉 JSON 里的改动，回表单继续。 */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="self-start"
                      onClick={escapeJson}
                    >
                      {t.editor.jsonEscape}
                    </Button>
                  </>
                ) : (
                  <FieldDescription>
                    <Hint text={t.editor.jsonHint} />
                  </FieldDescription>
                )}
              </Field>
            </TabsContent>
          </div>
        </Tabs>

        {/*
          保存被拦时禁用按钮旁的一句话摘要。错误大多藏在收起的手风琴卡里，只给一个
          灰按钮等于让人翻五张卡找原因；这条用错误原文点名，原文自报家门
          （collectErrors 的每条文案都含字段名）。jsonError 与 tooBig 之外的
          shownErrors 才走这里。
        */}
        {firstBlocker !== null && !tooBig && (
          <p role="alert" className="border-t px-4 py-2 text-sm text-destructive">
            {t.editor.saveBlocked(firstBlocker)}
          </p>
        )}
        {tooBig && (
          <p role="alert" className="border-t px-4 py-2 text-sm text-destructive">
            {t.editor.tooBig(LIMITS.definitionBytes / 1024)}
          </p>
        )}

        {/*
          窄屏也横排：竖排两枚全宽按钮要 105px 高度，那是从表单区借来的。
          bg-muted 覆盖出厂的 bg-muted/50 —— 页脚下面正滚着表单，半透明会让被切一半
          的那行字从按钮背后透出来。
        */}
        <DialogFooter className="mx-0 mb-0 flex-row justify-end bg-muted">
          <Button variant="outline" onClick={requestClose} disabled={saving}>
            {t.editor.cancel}
          </Button>
          <Button onClick={() => void save()} disabled={blocked}>
            {saving ? <Spinner /> : <SaveIcon />}
            {saving ? t.editor.saving : t.editor.save}
          </Button>
        </DialogFooter>

        {/* 嵌在外层弹窗里：Base UI 会把 Esc 先派给这层，关掉它才轮到外层。 */}
        <Dialog
          open={confirmDiscard}
          onOpenChange={(nextOpen: boolean) => {
            if (!nextOpen) {
              setConfirmDiscard(false);
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t.editor.discardTitle}</DialogTitle>
              <DialogDescription>{t.editor.discardBody}</DialogDescription>
            </DialogHeader>
            <DialogFooter className="mx-0 mb-0">
              <Button variant="outline" onClick={() => setConfirmDiscard(false)}>
                {t.editor.discardCancel}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmDiscard(false);
                  onOpenChange(false);
                }}
              >
                {t.editor.discardConfirm}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
};

/**
 * upstreamHeaders 里出现的保留头名 —— jouska 自己推导，或运行时掌管，schema 会拒。
 *
 * 只覆盖表单在编辑的这个字段。`requestHeaders` 走 JSON 视图，它的同类错误由服务端
 * 预览报出来；把那份错误挂在这个控件下面只会指错地方。
 */
const reservedHeaderNames = (definition: RouteDefinition): string[] =>
  Object.keys(definition.upstreamHeaders ?? {}).filter((name) =>
    RESERVED_REQUEST_HEADERS.has(name.trim().toLowerCase()),
  );

/** 名单里命中的保留头名 —— forwardAuth 的两份抄送名单用它检查。 */
const reservedNamesIn = (names: readonly string[] | undefined): string[] =>
  (names ?? []).filter((name) => RESERVED_REQUEST_HEADERS.has(name.trim().toLowerCase()));

/**
 * 未覆盖字段里命中的危险子路径。
 *
 * 让 JSON 视图里手写的 `responseHeaders.set` 之类在表单视图也开口说话，而不是安静
 * 地躺在一行值预览里 —— 表单不认识一个字段，不等于它不危险。
 */
const dangerousSubPaths = (key: string, value: unknown): string[] => {
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
