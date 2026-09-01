import * as React from 'react';
import { GitCompareIcon, HistoryIcon, RefreshCwIcon, RotateCcwIcon, TimerIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { RevisionDiff } from '@/components/revision-diff';
import { RollbackDialog } from '@/components/rollback-dialog';
import { ApiError, NetworkError, api, type DiffEntry, type RevisionEntry } from '@/lib/api';
import { timeAgo, timeExact } from '@/lib/format';
import { t } from '@/lib/messages';

/**
 * 发布历史：视觉化时间轴。
 *
 * 每一次发布是一张卡，竖向轨道从新到旧。这个视图自己拉数据（与审计页同一模式：
 * 历史是服务端的事实，不接草稿状态），对比与回滚在卡上就地展开。
 *
 * 无快照的条目（早于历史功能的发布）照样上墙，但对比/回滚不出按钮、只说明原因
 * —— 只说实话，不做假按钮。revision 编号断档时插入一句说明：那次发布改动
 * 已上线、面板记录没写成，历史无法补记。
 */

/** 已勾选待对比的 revision；最多两个，够了 —— diff 本来就是两侧的事。 */
type Selection = readonly [number | null, number | null];

type LoadFailure =
  | { readonly kind: 'network' }
  | { readonly kind: 'session' }
  | { readonly kind: 'message'; readonly text: string };

const failureText = (failure: LoadFailure): string => {
  switch (failure.kind) {
    case 'network':
      return t.common.networkError;
    case 'session':
      return t.common.sessionExpired;
    case 'message':
      return t.history.loadFailed(failure.text);
  }
};

/** 时间轴卡：一张 revision。无快照的卡整张不可点，说明行写明原因。 */
const RevisionCard = ({
  entry,
  selected,
  isAdmin,
  onToggleSelect,
  onRollback,
}: {
  readonly entry: RevisionEntry;
  readonly selected: boolean;
  readonly isAdmin: boolean;
  readonly onToggleSelect: () => void;
  readonly onRollback: () => void;
}) => {
  const hasSnapshot = entry.snapshot === 'full';
  return (
    <li className="relative flex gap-3">
      {/* 轨道：竖线 + 圆点。圆点是整条时间轴的视觉锚，正在服务的版本换主色。 */}
      <div className="flex flex-col items-center pt-5" aria-hidden>
        <span
          className={
            entry.live
              ? 'bg-primary size-3 rounded-full ring-4 ring-primary/20'
              : 'bg-border size-3 rounded-full ring-4 ring-transparent'
          }
        />
        <span className="bg-border w-px grow" />
      </div>

      <Card
        role="button"
        tabIndex={hasSnapshot ? 0 : undefined}
        aria-pressed={hasSnapshot ? selected : undefined}
        onClick={() => {
          if (hasSnapshot) {
            onToggleSelect();
          }
        }}
        onKeyDown={(event) => {
          if (hasSnapshot && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            onToggleSelect();
          }
        }}
        className={
          selected
            ? 'border-primary w-full cursor-pointer ring-2 ring-primary/30'
            : hasSnapshot
              ? 'hover:border-ring w-full cursor-pointer'
              : 'w-full'
        }
      >
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="font-mono">#{entry.revision}</CardTitle>
            {entry.live && (
              <Badge>
                <TimerIcon aria-hidden />
                {t.history.liveBadge}
              </Badge>
            )}
            {entry.rollbackOf !== null && (
              <Badge variant="secondary">{t.history.rolledBackFrom(entry.rollbackOf)}</Badge>
            )}
            {!hasSnapshot && <Badge variant="outline">{t.history.snapshotNone}</Badge>}
            {selected && (
              <Badge variant="secondary">{t.history.diff.selected(entry.revision)}</Badge>
            )}
          </div>
          <CardDescription>
            {timeAgo(entry.at)} · {timeExact(entry.at)} · {entry.actor}
          </CardDescription>
          <CardAction className="flex items-center gap-1.5">
            {hasSnapshot && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleSelect();
                  }}
                >
                  <GitCompareIcon aria-hidden />
                  {selected ? '' : t.history.diff.select}
                </Button>
                {isAdmin && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={entry.live}
                    title={entry.live ? t.history.rollback.errors.already_live : undefined}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRollback();
                    }}
                  >
                    <RotateCcwIcon aria-hidden />
                    {t.history.rollback.action}
                  </Button>
                )}
              </>
            )}
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          <p className="text-muted-foreground text-sm">
            {entry.routeCount === null
              ? t.history.routesUnknown
              : t.history.routes(entry.routeCount)}
            {entry.note !== null && <span className="text-foreground"> · {entry.note}</span>}
          </p>
          {!hasSnapshot && (
            <p className="text-muted-foreground text-xs">{t.history.snapshotNoneReason}</p>
          )}
        </CardContent>
      </Card>
    </li>
  );
};

/** 相邻两个 revision 断档时的说明行：那次发布只改了线上，没写成面板记录。 */
const GapRow = ({ before, after }: { readonly before: number; readonly after: number }) => (
  <li className="text-muted-foreground flex items-center gap-3 pl-9 text-xs">
    <span className="bg-border h-px w-4" aria-hidden />
    <span>
      {t.history.gap(before, after)} · {t.history.gapReason}
    </span>
  </li>
);

export interface HistoryViewProps {
  readonly isAdmin: boolean;
  /** 回滚成功后通知外壳：草稿被重置了，闸门轨道必须重算。 */
  readonly onConfigChanged: () => void;
}

export const HistoryView = ({ isAdmin, onConfigChanged }: HistoryViewProps) => {
  const [entries, setEntries] = React.useState<RevisionEntry[] | null>(null);
  const [failure, setFailure] = React.useState<LoadFailure | null>(null);
  const [loading, setLoading] = React.useState(true);
  /** 勾选待对比的 revision，最多两个；勾齐两个就拉 diff。 */
  const [selection, setSelection] = React.useState<Selection>([null, null]);
  const [diffEntries, setDiffEntries] = React.useState<readonly DiffEntry[] | null>(null);
  const [diffLoading, setDiffLoading] = React.useState(false);
  const [diffFailure, setDiffFailure] = React.useState<string | null>(null);
  const [rollbackTarget, setRollbackTarget] = React.useState<RevisionEntry | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await api.listRevisions());
      setFailure(null);
    } catch (error) {
      if (error instanceof NetworkError) {
        setFailure({ kind: 'network' });
      } else if (error instanceof ApiError && error.status === 401) {
        setFailure({ kind: 'session' });
      } else {
        setFailure({
          kind: 'message',
          text: error instanceof ApiError ? error.code : t.common.unknownError,
        });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const [from, to] = selection;
  React.useEffect(() => {
    if (from === null || to === null) {
      setDiffEntries(null);
      setDiffFailure(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffFailure(null);
    api
      .diffRevisions(from, to)
      .then((result) => {
        if (!cancelled) {
          setDiffEntries(result);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        if (error instanceof ApiError && error.code === 'snapshot_unavailable') {
          setDiffFailure(t.history.diff.unavailable);
        } else if (error instanceof ApiError && error.code === 'snapshot_corrupt') {
          setDiffFailure(t.history.diff.corrupt);
        } else if (error instanceof NetworkError) {
          setDiffFailure(t.common.networkError);
        } else {
          setDiffFailure(error instanceof ApiError ? error.code : t.common.unknownError);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDiffLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [from, to]);

  const toggleSelect = (revision: number): void => {
    setSelection(([a, b]) => {
      // 点已选中的取消它；否则挤掉最早的那个，保持「最多两个」。
      if (a === revision) {
        return [b, null];
      }
      if (b === revision) {
        return [a, null];
      }
      return a === null ? [revision, b] : [a, revision];
    });
  };

  const onRolledBack = (): void => {
    setRollbackTarget(null);
    setSelection([null, null]);
    void load();
    onConfigChanged();
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <HistoryIcon aria-hidden />
            <CardTitle>{t.history.title}</CardTitle>
          </div>
          <CardDescription>{t.history.description}</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Spinner /> : <RefreshCwIcon aria-hidden />}
              {t.history.refresh}
            </Button>
          </CardAction>
        </CardHeader>
      </Card>

      {failure !== null && (
        <Alert>
          <AlertTitle>{failureText(failure)}</AlertTitle>
          <AlertDescription />
        </Alert>
      )}

      {loading && entries === null ? (
        <div className="flex flex-col gap-3 pl-6">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : entries !== null && entries.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia>
              <HistoryIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{t.history.empty.title}</EmptyTitle>
            <EmptyDescription>{t.history.empty.description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : entries !== null ? (
        <div className="flex flex-col gap-4">
          <ol className="flex flex-col gap-3">
            {entries.map((entry, index) => (
              <React.Fragment key={entry.revision}>
                {index > 0 && entry.revision < entries[index - 1].revision - 1 && (
                  <GapRow before={entry.revision} after={entries[index - 1].revision} />
                )}
                <RevisionCard
                  entry={entry}
                  selected={entry.revision === from || entry.revision === to}
                  isAdmin={isAdmin}
                  onToggleSelect={() => toggleSelect(entry.revision)}
                  onRollback={() => setRollbackTarget(entry)}
                />
              </React.Fragment>
            ))}
          </ol>

          {from !== null && to !== null && (
            <Card>
              <CardHeader>
                <CardTitle className="font-mono text-base">
                  {t.history.diff.title(from, to)}
                </CardTitle>
                <CardAction>
                  <Button variant="ghost" size="sm" onClick={() => setSelection([null, null])}>
                    {t.history.diff.clear}
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                {diffFailure !== null ? (
                  <p className="text-destructive text-sm">{diffFailure}</p>
                ) : (
                  <RevisionDiff entries={diffEntries} loading={diffLoading} />
                )}
              </CardContent>
            </Card>
          )}
        </div>
      ) : null}

      {rollbackTarget !== null && isAdmin && (
        <RollbackDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRollbackTarget(null);
            }
          }}
          source={rollbackTarget}
          onRolledBack={onRolledBack}
        />
      )}
    </div>
  );
};
