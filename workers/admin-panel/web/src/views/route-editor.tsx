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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  RESERVED_REQUEST_HEADERS,
  ROUTE_ID_PATTERN,
  SCHEME_DEFAULT,
} from '@/lib/types';
import type { RouteDefinition } from '@/lib/types';

/* ---------- 字段元数据：文案与 schema 边界放一处，不散在 JSX 里。 ---------- */

/** 数值字段：retries 没有 unit，所以这里显式写 undefined，不能用索引访问去猜形状。 */
const NUMERIC_KEYS = ['timeoutMs', 'totalTimeoutMs', 'retries', 'retryBackoffMs'] as const;
type NumericKey = (typeof NUMERIC_KEYS)[number];

const NUMERIC_FIELDS: Record<
  NumericKey,
  { readonly label: string; readonly unit: string | undefined }
> = {
  timeoutMs: { label: t.fields.timeoutMs.label, unit: t.fields.timeoutMs.unit },
  totalTimeoutMs: { label: t.fields.totalTimeoutMs.label, unit: t.fields.totalTimeoutMs.unit },
  retries: { label: t.fields.retries.label, unit: undefined },
  retryBackoffMs: { label: t.fields.retryBackoffMs.label, unit: t.fields.retryBackoffMs.unit },
};

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
type SectionKey = 'bodyRewrite' | 'cors' | 'ip';

/** 本地校验的错误集：键是字段，值是直接展示的文案。 */
type FieldErrors = Partial<Record<'id' | 'upstream' | 'scheme' | NumericKey, string>>;

/* ---------- 展示件 ---------- */

/**
 * help 文案里的反引号片段排成等宽字：操作者要逐字符抄写的就是这些片段（`/*`、
 * `*.example.com`），普通正文把它们淹没会直接造成写错。
 */
const Hint = ({ text }: { readonly text: string }) => (
  <>
    {text.split('`').map((part, index) =>
      index % 2 === 1 ? (
        <code key={index} className="bg-muted rounded px-1 font-mono text-xs">
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

/* ---------- 单字段控件 ---------- */

interface TextPropertyProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
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
  placeholder,
  value,
  mono,
  error,
  onChange,
}: TextPropertyProps) => (
  <Field data-invalid={hasText(error) ? true : undefined}>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
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
  readonly max: number;
  readonly error?: string;
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
  onChange,
}: NumberPropertyProps) => (
  <Field data-invalid={hasText(error) ? true : undefined}>
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
  readonly placeholder?: string;
  readonly value: readonly string[] | undefined;
  readonly onChange: (value: readonly string[] | undefined) => void;
}

/**
 * 逗号/空白分隔的列表输入。每次按键都会归一化并上报，但**不回写显示文本** ——
 * 否则刚打完一个逗号光标就被弹回去。列表语义以保存时的归一化结果为准。
 */
const ListProperty = ({ id, label, hint, placeholder, value, onChange }: ListPropertyProps) => {
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
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
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

/* ---------- 请求头行编辑 ---------- */

interface HeaderRow {
  readonly name: string;
  readonly value: string;
}

const rowsToHeaders = (rows: readonly HeaderRow[]): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    // 同名行以后写的为准，与 JSON.parse 对对象字面量的语义一致。
    if (name !== '') {
      record[name] = row.value;
    }
  }
  return record;
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
  const [rows, setRows] = React.useState<readonly HeaderRow[]>(() =>
    Object.entries(value ?? {}).map(([name, entry]) => ({ name, value: entry })),
  );
  const signature = JSON.stringify(value ?? null);
  const emitted = React.useRef(signature);
  if (emitted.current !== signature) {
    emitted.current = signature;
    setRows(Object.entries(value ?? {}).map(([name, entry]) => ({ name, value: entry })));
  }

  const write = (next: readonly HeaderRow[]) => {
    setRows(next);
    const record = rowsToHeaders(next);
    // 一行有效数据都没有 = 未设置：删键而不是留 {}。
    const emit = Object.keys(record).length === 0 ? undefined : record;
    // 回声指纹必须和 signature 同口径（`?? null`）。写 `JSON.stringify(record)` 时，
    // 「一行有效数据都没有」上报的是 undefined、下一次渲染的 signature 是 `"null"`，
    // 而指纹留着 `"{}"` —— 自己的回声被当成「外部改了值」，刚加的空行在同一次渲染
    // 里就被复位抹掉。表现为点「加一行」毫无反应，以及把最后一个头名删空时整行消失。
    emitted.current = JSON.stringify(emit ?? null);
    onChange(emit);
  };

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => {
        const reserved = RESERVED_REQUEST_HEADERS.has(row.name.trim().toLowerCase());
        return (
          <div key={index} className="flex items-center gap-2">
            <Input
              className="w-44 shrink-0 font-mono text-xs"
              placeholder={t.fields.upstreamHeaders.name}
              aria-label={`${t.fields.upstreamHeaders.name} ${String(index + 1)}`}
              aria-invalid={reserved}
              value={row.name}
              onChange={(event) =>
                write(
                  rows.map((entry, i) =>
                    i === index ? { ...entry, name: event.target.value } : entry,
                  ),
                )
              }
            />
            <Input
              className="min-w-0 flex-1 font-mono text-xs"
              placeholder={t.fields.upstreamHeaders.value}
              aria-label={`${t.fields.upstreamHeaders.value} ${String(index + 1)}`}
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
              aria-label={t.fields.upstreamHeaders.removeRow}
              onClick={() => write(rows.filter((_, i) => i !== index))}
            >
              <Trash2Icon />
            </Button>
          </div>
        );
      })}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => write([...rows, { name: '', value: '' }])}
        >
          <PlusIcon />
          {t.fields.upstreamHeaders.addRow}
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
  const upstream = typeof definition.upstream === 'string' ? definition.upstream.trim() : '';
  if (upstream === '' || upstream.includes('//')) {
    errors.upstream = t.fields.upstream.help;
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
}

export const RouteEditor = ({
  open,
  onOpenChange,
  initial,
  createMode,
  onSaved,
}: RouteEditorProps) => {
  const initialId = initial?.id ?? '';
  const initialEnabled = initial?.enabled ?? true;
  const initialDefinition = initial?.definition ?? {};

  const [id, setId] = React.useState(initialId);
  const [enabled, setEnabled] = React.useState(initialEnabled);
  const [definition, setDefinition] = React.useState<RouteDefinition>(initialDefinition);
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
    // JSON 没修好之前回表单，只会看到上一次成功解析的旧数据 —— 不许切。
    if (jsonError !== null) {
      return;
    }
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
      setJsonError(t.editor.jsonInvalid);
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
    toast.success(t.editor.saved(savedId));
    onSaved(savedId);
  };

  const unknownKeys = Object.keys(definition).filter((key) => !FORM_COVERED_KEYS.includes(key));
  const reservedHeaders = reservedHeaderNames(definition);

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
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-4 py-4">
          <DialogTitle>
            {createMode ? t.editor.createTitle : t.editor.editTitle(initialId)}
          </DialogTitle>
          <DialogDescription>{t.editor.description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-4 pt-4">
          <Field data-invalid={errors.id !== undefined ? true : undefined}>
            <FieldLabel htmlFor="route-editor-id">{t.editor.idLabel}</FieldLabel>
            {createMode ? (
              <Input
                id="route-editor-id"
                className="font-mono"
                value={id}
                aria-invalid={errors.id !== undefined}
                onChange={(event) => setId(event.target.value)}
              />
            ) : (
              <Input id="route-editor-id" className="font-mono" value={id} readOnly />
            )}
            <FieldDescription>
              <Hint text={createMode ? t.editor.idHint : t.editor.idImmutable} />
            </FieldDescription>
            {errors.id !== undefined && <FieldError>{errors.id}</FieldError>}
          </Field>

          <Field orientation="horizontal">
            <Switch
              id="route-editor-enabled"
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(checked)}
            />
            <FieldContent>
              <FieldLabel htmlFor="route-editor-enabled">{t.editor.enabledLabel}</FieldLabel>
              <FieldDescription>
                <Hint text={t.editor.enabledHint} />
              </FieldDescription>
            </FieldContent>
          </Field>
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

          {/* 滚动发生在当前视图里：头部与开关常驻可见，长表单也不会把保存按钮顶走。 */}
          <TabsContent value="form" className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="flex flex-col gap-6">
              <FieldSet>
                <FieldLegend>{t.fields.sections.match}</FieldLegend>
                <FieldDescription>
                  <Hint text={t.fields.sections.matchHint} />
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
                      <label key={method} className="flex items-center gap-2">
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
              </FieldSet>

              <FieldSet>
                <FieldLegend>{t.fields.sections.upstream}</FieldLegend>
                <FieldDescription>
                  <Hint text={t.fields.sections.upstreamHint} />
                </FieldDescription>

                <TextProperty
                  id="route-editor-upstream"
                  label={t.fields.upstream.label}
                  hint={t.fields.upstream.help}
                  placeholder={t.fields.upstream.placeholder}
                  mono
                  error={errors.upstream}
                  value={typeof definition.upstream === 'string' ? definition.upstream : ''}
                  onChange={(value) => {
                    // upstream 里空格永远是错字，输入时就去掉；协议头交给校验拦。
                    const next = value.trim();
                    setTopLevel('upstream', next === '' ? undefined : next);
                  }}
                />

                <Field data-invalid={errors.scheme !== undefined ? true : undefined}>
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
                    <SelectTrigger
                      id="route-editor-scheme"
                      className="w-44"
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
                  {errors.scheme !== undefined && <FieldError>{errors.scheme}</FieldError>}
                </Field>
                {definition.scheme === 'http' && <DangerNote path="scheme" />}

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

              <FieldSet>
                <FieldLegend>{t.fields.sections.timing}</FieldLegend>
                <FieldDescription>
                  <Hint text={t.fields.sections.timingHint} />
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
                    error={errors[key]}
                    onChange={(raw) => {
                      // 数字直接存，越界与非整数交给校验就地说清；空串 = 未设置。
                      const next = raw === '' ? undefined : Number(raw);
                      setTopLevel(key, next !== undefined && Number.isNaN(next) ? undefined : next);
                    }}
                  />
                ))}
              </FieldSet>

              <FieldSet>
                <FieldLegend>{t.fields.sections.rewrite}</FieldLegend>
                <FieldDescription>
                  <Hint text={t.fields.sections.rewriteHint} />
                </FieldDescription>

                {BOOLEAN_KEYS.map((key) => (
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
                      onChange={(value) => setSectionKey('bodyRewrite', 'contentTypes', value)}
                    />
                    {(definition.bodyRewrite.contentTypes?.length ?? 0) > 0 && (
                      <DangerNote path="bodyRewrite.contentTypes" />
                    )}
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
              </FieldSet>

              <FieldSet>
                <FieldLegend>{t.fields.sections.guards}</FieldLegend>
                <FieldDescription>
                  <Hint text={t.fields.sections.guardsHint} />
                </FieldDescription>

                <ListProperty
                  id="route-editor-block-countries"
                  label={t.fields.blockCountries.label}
                  hint={t.fields.blockCountries.help}
                  placeholder={t.fields.blockCountries.placeholder}
                  value={definition.blockCountries}
                  onChange={(value) => setTopLevel('blockCountries', value)}
                />
                <ListProperty
                  id="route-editor-allow-countries"
                  label={t.fields.allowCountries.label}
                  hint={t.fields.allowCountries.help}
                  placeholder={t.fields.allowCountries.placeholder}
                  value={definition.allowCountries}
                  onChange={(value) => setTopLevel('allowCountries', value)}
                />

                <Field orientation="horizontal">
                  <Switch
                    id="route-editor-cors"
                    checked={definition.cors !== undefined}
                    onCheckedChange={(checked) =>
                      checked ? setSectionOn('cors') : setSectionOff('cors')
                    }
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="route-editor-cors">{t.fields.cors.label}</FieldLabel>
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
                  </>
                )}

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
                      value={definition.ip.allow}
                      onChange={(value) => setSectionKey('ip', 'allow', value)}
                    />
                    {(definition.ip.allow?.length ?? 0) > 0 && <DangerNote path="ip.allow" />}
                    <ListProperty
                      id="route-editor-ip-deny"
                      label={t.fields.ip.deny}
                      hint={t.fields.ip.denyHelp}
                      value={definition.ip.deny}
                      onChange={(value) => setSectionKey('ip', 'deny', value)}
                    />
                    {(definition.ip.deny?.length ?? 0) > 0 && <DangerNote path="ip.deny" />}
                  </>
                )}
              </FieldSet>

              <FieldSet data-invalid={reservedHeaders.length > 0 ? true : undefined}>
                <FieldLegend>{t.fields.sections.headers}</FieldLegend>
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
              </FieldSet>

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
                        {key === 'rateLimit' && (
                          <dd className="text-muted-foreground text-xs">
                            {t.fields.rateLimit.help}
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

          <TabsContent value="json" className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <Field data-invalid={jsonError !== null ? true : undefined}>
              <FieldLabel htmlFor="route-editor-json">{t.editor.jsonLabel}</FieldLabel>
              <Textarea
                id="route-editor-json"
                className="min-h-72 font-mono text-xs"
                spellCheck={false}
                value={jsonText}
                aria-invalid={jsonError !== null}
                onChange={(event) => handleJsonChange(event.target.value)}
              />
              {jsonError !== null ? (
                <FieldError>{jsonError}</FieldError>
              ) : (
                <FieldDescription>
                  <Hint text={t.editor.jsonHint} />
                </FieldDescription>
              )}
            </Field>
          </TabsContent>
        </Tabs>

        {tooBig && (
          <p role="alert" className="border-t px-4 py-2 text-sm text-destructive">
            {t.editor.tooBig(LIMITS.definitionBytes / 1024)}
          </p>
        )}

        <DialogFooter className="mx-0 mb-0">
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
