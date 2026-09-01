import { ArrowDownUpIcon, MinusIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { t } from '@/lib/messages';
import type { DiffEntry } from '@/lib/api';

/**
 * 服务端 diff 的渲染。判定全在服务端（api/revisions.ts 的 diffDocuments），
 * 这里只负责把字段摆出来 —— 不在浏览器里重新比较两份 JSON，否则面板自己
 * 就成了第二套真相。
 */

/** 值一律走紧凑 JSON：diff 的两侧是快照里的原值，形状随字段而异。 */
const MAX_VALUE_CHARS = 120;

const formatValue = (value: unknown): string => {
  if (value === undefined) {
    return '∅';
  }
  const text = JSON.stringify(value) ?? String(value);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
};

/** path 的首段决定归属：defaults.* 是表级默认值，其余（routes.*、version）都算表结构。 */
const isDefaultsPath = (path: string): boolean => path.startsWith('defaults');

const KIND_META = {
  added: { label: t.history.diff.groups.added, icon: PlusIcon, variant: 'default' as const },
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

const DiffRow = ({ entry }: { readonly entry: DiffEntry }) => {
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  return (
    <li className="flex flex-col gap-0.5 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={meta.variant} className="gap-1">
          <Icon aria-hidden />
          {meta.label}
        </Badge>
        <code className="font-mono text-xs break-all">{entry.path}</code>
        {entry.kind === 'moved' &&
          entry.fromPosition !== undefined &&
          entry.toPosition !== undefined && (
            <span className="text-muted-foreground text-xs">
              {t.history.diff.positionLabel(entry.fromPosition, entry.toPosition)}
            </span>
          )}
      </div>
      {entry.kind === 'moved' ? null : (
        <div className="text-muted-foreground grid gap-0.5 pl-1 text-xs">
          {entry.kind !== 'added' && (
            <span className="break-all">
              {t.history.diff.fromLabel}：
              <code className="font-mono">{formatValue(entry.from)}</code>
            </span>
          )}
          {entry.kind !== 'removed' && (
            <span className="break-all">
              {t.history.diff.toLabel}：<code className="font-mono">{formatValue(entry.to)}</code>
            </span>
          )}
        </div>
      )}
    </li>
  );
};

const DiffSection = ({
  title,
  entries,
}: {
  readonly title: string;
  readonly entries: readonly DiffEntry[];
}) => {
  if (entries.length === 0) {
    return null;
  }
  // 组内按新增→删除→修改→移序摆，扫读时破坏性最大的在先。
  const order: readonly DiffEntry['kind'][] = ['removed', 'added', 'changed', 'moved'];
  const sorted = entries.toSorted((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</h4>
      <ul className="divide-y">
        {sorted.map((entry) => (
          <DiffRow key={`${entry.kind}.${entry.path}`} entry={entry} />
        ))}
      </ul>
    </section>
  );
};

export const RevisionDiff = ({
  entries,
  loading,
}: {
  readonly entries: readonly DiffEntry[] | null;
  readonly loading: boolean;
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
  const defaults = entries.filter((entry) => isDefaultsPath(entry.path));
  const rest = entries.filter((entry) => !isDefaultsPath(entry.path));
  return (
    <div className="flex flex-col gap-4">
      <DiffSection title={t.history.diff.routesTitle} entries={rest} />
      <DiffSection title={t.history.diff.defaultsTitle} entries={defaults} />
      {(defaults.length > 0 || rest.length > 0) && <Separator />}
    </div>
  );
};
