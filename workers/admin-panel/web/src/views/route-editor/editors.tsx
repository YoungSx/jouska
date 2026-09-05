/**
 * Row-pair editors: conditions, headers, and generic two-column row lists.
 * These are compound controls that manage arrays of {first, second} pairs.
 */
import * as React from 'react';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { t } from '@/lib/messages';
import { RESERVED_REQUEST_HEADERS } from '@/lib/types';
import type { MatchCondition, RouteDefinition } from '@/lib/types';

export interface RowPair {
  readonly first: string;
  readonly second: string;
}

export interface RowPairListProps {
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
export const RowPairList = ({
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
      // 比例列不钉死宽度：窄屏（编辑器全屏接管时）名字列自动让位给值列，
      // 不再是「固定 11rem + 挤扁的 flex-1」。
      <div
        key={index}
        className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-center gap-2"
      >
        <Input
          className="min-w-0 font-mono text-xs"
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
          className="min-w-0 font-mono text-xs"
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
export const HeadersEditor = ({
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
export const ReplaceEditor = ({
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
export interface ConditionRow {
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
export const conditionFromRow = (row: ConditionRow): MatchCondition => {
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
export const ConditionsEditor = ({
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
        // 窄屏排成两行（family+name / op+value，删除钮跨行居中），够宽才收成一行
        // —— flex-wrap 的换行点看内容脸色，网格的换行点自己定：语义顺序不散架。
        <div
          key={index}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto]"
        >
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
              className="w-28"
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
            className="min-w-0 font-mono text-xs"
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
              className="w-32"
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
            className="min-w-0 font-mono text-xs"
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
            className="col-start-3 row-span-2 self-center sm:col-auto sm:row-auto"
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
