/**
 * Single-field controls: text, number, switch, select, host, list.
 * Each exported component is a controlled input that reports value changes via
 * onChange callback. Errors are shown inline when present.
 */
import * as React from 'react';
import { Autocomplete } from '@base-ui/react';
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from '@/components/ui/combobox';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { HostBinding } from '@/lib/api';
import { COUNTRY_OPTIONS, countryOption } from '@/lib/countries';
import type { CountryOption } from '@/lib/countries';
import { parseList } from '@/lib/format';
import { t } from '@/lib/messages';
import { Hint, PropertyLabel, hasText } from './parts';

export interface TextPropertyProps {
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

export const TextProperty = ({
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

export const toHostOptions = (bindings: readonly HostBinding[]): readonly HostOption[] =>
  [...new Map(bindings.map((binding) => [binding.host, binding])).values()].map((binding) => ({
    value: binding.host,
    kind: binding.kind,
    pattern: binding.pattern,
  }));

export interface HostPropertyProps {
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
export const HostProperty = ({
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

export interface NumberPropertyProps {
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

export const NumberProperty = ({
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

export interface ListPropertyProps {
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
export const ListProperty = ({
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

export interface SwitchPropertyProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** schema 默认值的说明；布尔开关的中间态最容易让人忘记默认是什么。 */
  readonly defaultNote?: string;
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}

export const SwitchProperty = ({
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

/* ---------- 国家选择器 ---------- */

interface CountryPropertyProps {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly tip?: string;
  /** 已选代码，直接来自 definition（可能含库不认识的值）。 */
  readonly value: readonly string[] | undefined;
  readonly onChange: (codes: readonly string[] | undefined) => void;
}

/**
 * 国家/地区多选。
 *
 * 从前这里是一个逗号分隔的文本框，hint 里写着「ISO 3166-1 alpha-2」并举两个例子。
 * 那个字段是对的，同时也是不可用的：没人记得 249 个两字母码，而记不住的人只能去
 * 别处查完再回来抄。
 *
 * 官方 Combobox 的 chips 形态换掉它：搜中文名或代码都命中（label 里同时含两者），
 * 选中的变成能一个个删的 chip，写回 definition 的仍然是那串大写代码本身 —— 存的
 * 东西一个字节都没变，只是不再要求人背下来。
 */
export const CountryProperty = ({
  id,
  label,
  hint,
  tip,
  value,
  onChange,
}: CountryPropertyProps) => {
  const selected = (value ?? []).map(countryOption);
  return (
    <Field>
      <PropertyLabel htmlFor={id} label={label} tip={tip} />
      <Combobox
        items={COUNTRY_OPTIONS}
        multiple
        value={selected}
        onValueChange={(next: readonly CountryOption[]) => {
          const codes = next.map((option) => option.value);
          // 空数组连键一起删：`blockCountries: []` 与「没配过」在语义上是一件事。
          onChange(codes.length === 0 ? undefined : codes);
        }}
      >
        <ComboboxValue>
          {(current: readonly CountryOption[]) => (
            <ComboboxChips aria-label={current.length > 0 ? label : undefined}>
              {current.map((option) => (
                <ComboboxChip
                  key={option.value}
                  aria-label={option.label}
                  aria-description={t.fields.countryPicker.chipHint}
                >
                  {option.label}
                </ComboboxChip>
              ))}
              <ComboboxChipsInput
                id={id}
                placeholder={current.length > 0 ? '' : t.fields.countryPicker.placeholder}
                aria-description={
                  current.length > 0 ? t.fields.countryPicker.selected(current.length) : undefined
                }
              />
            </ComboboxChips>
          )}
        </ComboboxValue>
        <ComboboxContent>
          <ComboboxList>
            <ComboboxEmpty>{t.fields.countryPicker.empty}</ComboboxEmpty>
            <ComboboxCollection>
              {(option: CountryOption) => (
                <ComboboxItem key={option.value} value={option}>
                  {option.label}
                </ComboboxItem>
              )}
            </ComboboxCollection>
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <FieldDescription>
        <Hint text={hint} />
      </FieldDescription>
    </Field>
  );
};
