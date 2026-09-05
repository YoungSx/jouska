import * as React from 'react';
import { ArrowDownUpIcon, MinusIcon, PencilIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { t } from '@/lib/messages';
import { dangerReason } from '@/lib/types';
import type { DiffEntry } from '@/lib/api';

/**
 * 服务端 diff 的渲染。判定全在服务端（`src/diff.ts` 的 `diffDocuments`），这里
 * 只负责摆出来 —— 不在浏览器里重新比较两份 JSON，也不重新判断哪个字段危险，
 * 否则面板自己就成了第二套真相。
 *
 * 摆法按**路由**分组而不是按动词分组：操作者问的是「api-gw 怎么了」，而一条
 * 路由的六个字段改动散在「新增/删除/修改/移序」四个块里回答不了这个问题。
 * 归属由服务端的 `routeId` 给定 —— 路由 id 本身可以含点，`routes.foo.bar` 在
 * 浏览器里切不开。
 */

/** 值一律走紧凑 JSON：diff 的两侧是快照里的原值，形状随字段而异。 */
const MAX_VALUE_CHARS = 120;

interface FormattedValue {
  readonly text: string;
  readonly full: string;
  readonly truncated: boolean;
  readonly absent: boolean;
}

/**
 * 按 code point 截断，不按 UTF-16 code unit —— `slice` 会把星形字符切在代理对
 * 中间，剩下半个字符。全文永远留着：被截断的往往正是哈希与改写规则，那是必须
 * 逐字符核对的东西。
 */
const formatValue = (value: unknown): FormattedValue => {
  if (value === undefined) {
    return {
      text: t.history.diff.absent,
      full: t.history.diff.absent,
      truncated: false,
      absent: true,
    };
  }
  const full = JSON.stringify(value) ?? String(value);
  const points = Array.from(full);
  return points.length > MAX_VALUE_CHARS
    ? { text: points.slice(0, MAX_VALUE_CHARS).join(''), full, truncated: true, absent: false }
    : { text: full, full, truncated: false, absent: false };
};

/**
 * 一侧的值。等宽、不换行、横向可滚 —— 换行会让 64 位哈希在任意位置断开，而
 * 这些值存在的意义就是被逐字符核对（DESIGN.md：等宽值换行会读错）。
 */
const ValueLine = ({ label, value }: { readonly label: string; readonly value: unknown }) => {
  const formatted = formatValue(value);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-1.5">
        <span className="text-muted-foreground shrink-0 text-xs">{label}</span>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <code
            className={
              formatted.absent
                ? 'text-muted-foreground text-xs whitespace-pre'
                : 'text-foreground font-mono text-xs whitespace-pre'
            }
            title={formatted.absent ? undefined : formatted.full}
          >
            {formatted.text}
          </code>
        </div>
      </div>
      {formatted.truncated && (
        <details className="bg-muted/40 rounded-md border">
          <summary className="text-muted-foreground cursor-pointer px-2 py-1 text-xs">
            {t.history.diff.showFull}
            <span className="ml-1">{t.history.diff.truncated}</span>
          </summary>
          <pre className="overflow-x-auto px-2 pb-2 font-mono text-xs whitespace-pre">
            {formatted.full}
          </pre>
        </details>
      )}
    </div>
  );
};

/**
 * 动词标记。`删除` 是唯一带色相的一档，因为删掉一条路由是这里最能改变生产
 * 行为的事；其余三种靠图标与字区分。（从前 `新增` 用 primary 实底，等于把
 * 全系统最重的视觉给了破坏性最小的动作。）
 */
const KIND_META = {
  added: { label: t.history.diff.groups.added, icon: PlusIcon, variant: 'secondary' as const },
  removed: {
    label: t.history.diff.groups.removed,
    icon: MinusIcon,
    variant: 'destructive' as const,
  },
  changed: {
    label: t.history.diff.groups.changed,
    icon: PencilIcon,
    variant: 'secondary' as const,
  },
  moved: { label: t.history.diff.groups.moved, icon: ArrowDownUpIcon, variant: 'outline' as const },
} as const;

const KindBadge = ({ kind }: { readonly kind: DiffEntry['kind'] }) => {
  const meta = KIND_META[kind];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className="gap-1">
      <Icon aria-hidden />
      {meta.label}
    </Badge>
  );
};

/** 危险说明：底色 + 那句写给人看的后果，与发布弹窗里的危险清单同一张脸。 */
const DangerNote = ({ entry }: { readonly entry: DiffEntry }) => {
  if (entry.risk === undefined) {
    return null;
  }
  return (
    <p className="text-destructive flex items-start gap-1.5 text-xs">
      <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>
        {entry.riskCount !== undefined && entry.riskCount > 1 && (
          <span className="font-medium">{t.history.diff.addedDangerCount(entry.riskCount)} · </span>
        )}
        {dangerReason(entry.risk)}
      </span>
    </p>
  );
};

/** 一行字段级改动。两侧用绝对指称（`#45 的值`），因为方向永远是时间序。 */
const DiffRow = ({
  entry,
  older,
  newer,
}: {
  readonly entry: DiffEntry;
  readonly older: number;
  readonly newer: number;
}) => {
  const dangerous = entry.risk !== undefined;
  return (
    <li
      className={
        dangerous
          ? 'danger-surface flex flex-col gap-1 rounded-lg border p-2'
          : 'flex flex-col gap-1 px-2 py-1.5'
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <KindBadge kind={entry.kind} />
        {/* 整条路由的行不写 path —— 块标题已经是那个 id，再抄一遍只是噪声。 */}
        {entry.field !== undefined && (
          <code className="font-mono text-xs break-all">{entry.field}</code>
        )}
        {entry.field === undefined && entry.routeId === undefined && (
          <code className="font-mono text-xs break-all">{entry.path}</code>
        )}
        {entry.kind === 'moved' &&
          entry.fromPosition !== undefined &&
          entry.toPosition !== undefined && (
            <span className="text-muted-foreground text-xs">
              {t.history.diff.positionLabel(entry.fromPosition, entry.toPosition)}
            </span>
          )}
      </div>
      <DangerNote entry={entry} />
      {entry.field === undefined && entry.routeId !== undefined && entry.kind === 'added' && (
        <p className="text-muted-foreground text-xs">{t.history.diff.routeAdded}</p>
      )}
      {entry.field === undefined && entry.routeId !== undefined && entry.kind === 'removed' && (
        <p className="text-muted-foreground text-xs">{t.history.diff.routeRemoved}</p>
      )}
      {entry.kind !== 'moved' && (
        <div className="grid gap-0.5 pl-1">
          {entry.kind !== 'added' && (
            <ValueLine label={t.history.diff.valueOf(older)} value={entry.from} />
          )}
          {entry.kind !== 'removed' && (
            <ValueLine label={t.history.diff.valueOf(newer)} value={entry.to} />
          )}
        </div>
      )}
    </li>
  );
};

/** 一条路由的全部改动，破坏性最大的在先。 */
const KIND_RANK: Readonly<Record<DiffEntry['kind'], number>> = {
  removed: 0,
  added: 1,
  changed: 2,
  moved: 3,
};

interface Block {
  readonly key: string;
  readonly label: string;
  readonly mono: boolean;
  readonly entries: readonly DiffEntry[];
  readonly danger: number;
}

const sortRows = (entries: readonly DiffEntry[]): DiffEntry[] =>
  entries.toSorted(
    (a, b) =>
      // 危险在先，与块之间的排序同一条判据；然后按破坏性，最后按字段名。
      Number(b.risk !== undefined) - Number(a.risk !== undefined) ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      (a.field ?? '').localeCompare(b.field ?? ''),
  );

/** 按 owner 切块。归属只认服务端给的 `routeId`，不解析 path。 */
const blocksOf = (
  entries: readonly DiffEntry[],
): { routes: Block[]; defaults: Block | null; other: Block | null } => {
  const byRoute = new Map<string, DiffEntry[]>();
  const defaults: DiffEntry[] = [];
  const other: DiffEntry[] = [];
  for (const entry of entries) {
    if (entry.routeId !== undefined) {
      const bucket = byRoute.get(entry.routeId) ?? [];
      bucket.push(entry);
      byRoute.set(entry.routeId, bucket);
    } else if (entry.path === 'defaults' || entry.path.startsWith('defaults.')) {
      defaults.push(entry);
    } else {
      other.push(entry);
    }
  }
  const toBlock = (
    key: string,
    label: string,
    mono: boolean,
    rows: readonly DiffEntry[],
  ): Block => ({
    key,
    label,
    mono,
    entries: sortRows(rows),
    danger: rows.filter((entry) => entry.risk !== undefined).length,
  });
  const routes = [...byRoute.entries()]
    .map(([id, rows]) => toBlock(`route:${id}`, id, true, rows))
    // 有危险开关的路由排在最前：扫读时最该先看的就是它。其余按破坏性、再按 id。
    .toSorted(
      (a, b) =>
        Number(b.danger > 0) - Number(a.danger > 0) ||
        KIND_RANK[a.entries[0].kind] - KIND_RANK[b.entries[0].kind] ||
        a.label.localeCompare(b.label),
    );
  return {
    routes,
    defaults:
      defaults.length > 0
        ? toBlock('defaults', t.history.diff.defaultsTitle, false, defaults)
        : null,
    other: other.length > 0 ? toBlock('other', t.history.diff.otherTitle, false, other) : null,
  };
};

const BlockView = ({
  block,
  older,
  newer,
  heading,
}: {
  readonly block: Block;
  readonly older: number;
  readonly newer: number;
  readonly heading: boolean;
}) => (
  <div className="flex flex-col gap-1">
    {heading && (
      <div className="flex flex-wrap items-center gap-2">
        <h4 className={block.mono ? 'font-mono text-xs font-medium' : 'text-xs font-medium'}>
          {block.label}
        </h4>
        {block.danger > 0 && (
          <Badge variant="destructive">
            <TriangleAlertIcon aria-hidden />
            {t.history.diff.dangerBadge(block.danger)}
          </Badge>
        )}
      </div>
    )}
    <ul className="divide-y">
      {block.entries.map((entry) => (
        <DiffRow key={`${entry.kind}.${entry.path}`} entry={entry} older={older} newer={newer} />
      ))}
    </ul>
  </div>
);

const Section = ({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) => (
  <section className="flex flex-col gap-2">
    <div className="flex flex-col gap-0.5">
      <h3 className="text-muted-foreground text-xs font-medium">{title}</h3>
      {hint !== undefined && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
    {children}
  </section>
);

export const RevisionDiff = ({
  entries,
  loading,
  older,
  newer,
}: {
  readonly entries: readonly DiffEntry[] | null;
  readonly loading: boolean;
  readonly older: number;
  readonly newer: number;
}) => {
  if (loading) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner />
        {t.history.diff.loading}
      </p>
    );
  }
  if (entries === null) {
    return null;
  }
  if (entries.length === 0) {
    return <p className="text-muted-foreground text-sm">{t.history.diff.empty}</p>;
  }
  const { routes, defaults, other } = blocksOf(entries);
  const moved = entries.some((entry) => entry.kind === 'moved');
  return (
    <div className="flex flex-col gap-5">
      {routes.length > 0 && (
        <Section
          title={t.history.diff.routesTitle}
          hint={moved ? t.history.diff.positionHint : undefined}
        >
          <div className="flex flex-col gap-4">
            {routes.map((block) => (
              <BlockView key={block.key} block={block} older={older} newer={newer} heading />
            ))}
          </div>
        </Section>
      )}
      {defaults !== null && (
        <Section title={t.history.diff.defaultsTitle}>
          <BlockView block={defaults} older={older} newer={newer} heading={false} />
        </Section>
      )}
      {other !== null && (
        <Section title={t.history.diff.otherTitle}>
          <BlockView block={other} older={older} newer={newer} heading={false} />
        </Section>
      )}
    </div>
  );
};
