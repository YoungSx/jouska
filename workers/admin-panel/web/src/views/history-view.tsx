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
import { Checkbox } from '@/components/ui/checkbox';
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
 * 发布历史：视觉化时间轴 + 两版对比。
 *
 * 三个形态上的决定，每一个都是为了回答值班的人那两个问题（上次改了什么、能不能
 * 退回去）：
 *
 * 1. **对比区在时间轴之前**。结果排在 50 张卡之后等于没有结果 —— 勾完两个
 *    revision，视口里必须立刻有东西变。
 * 2. **方向永远是时间序**，不看勾选顺序：`from` 取较小的 revision，两侧因此可以
 *    用绝对指称（「#45 的值」）而不是「原值 / 新值」这种会读反的相对词。
 * 3. **勾选用真的 Checkbox**，卡片不是按钮。整卡可点换来的是嵌套交互控件、上百
 *    字的可访问名，以及键盘上按不动的「回滚」—— 那个代价太大。
 *
 * 这个视图自己拉数据（与审计页同一模式：历史是服务端的事实，不接草稿状态）。
 * 无快照的条目照样上墙，但不可勾选、不可回滚，只说明原因 —— 只说实话，不做假
 * 按钮。revision 编号断档时插入一句说明。
 */

/** 一屏先给多少张卡。滚动保留 50 版，一次全铺开等于让人滚过整部历史找结果。 */
const PAGE_SIZE = 20;

/** 已勾选的 revision，按勾选顺序，最多两个 —— diff 本来就是两侧的事。 */
type Selection = readonly number[];

type LoadFailure =
  | { readonly kind: 'network' }
  | { readonly kind: 'session' }
  | { readonly kind: 'message'; readonly text: string };

/** 对比失败：`text` 是面板的说法，`detail` 是服务端多说的那一句（哪一侧、为什么）。 */
interface DiffFailure {
  readonly text: string;
  readonly detail?: string;
}

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

/** 服务端 409 的 `detail` 说了是哪一侧没快照；只取字符串，不猜形状。 */
const detailOf = (error: unknown): string | undefined => {
  if (!(error instanceof ApiError)) {
    return undefined;
  }
  const detail = (error.body as Record<string, unknown>).detail;
  return typeof detail === 'string' ? detail : undefined;
};

/** 时间轴卡：一张 revision。无快照的卡不可勾选，说明行写明原因。 */
const RevisionCard = ({
  entry,
  role,
  isAdmin,
  onToggleSelect,
  onRollback,
}: {
  readonly entry: RevisionEntry;
  /** 这张卡在当前对比里的位置：未选中 / 只选了它 / 原始侧 / 较新侧。 */
  readonly role: 'none' | 'only' | 'older' | 'newer';
  readonly isAdmin: boolean;
  readonly onToggleSelect: () => void;
  readonly onRollback: () => void;
}) => {
  const hasSnapshot = entry.snapshot === 'full';
  const selected = role !== 'none';
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

      <Card className={selected ? 'w-full ring-2 ring-primary/40' : 'w-full'}>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            {hasSnapshot ? (
              <Checkbox
                checked={selected}
                onCheckedChange={onToggleSelect}
                aria-label={t.history.diff.selectLabel(entry.revision)}
              />
            ) : (
              // 占位让所有卡的 revision 号对齐一列；无快照的卡本来就选不了。
              <span className="size-4 shrink-0" aria-hidden />
            )}
            <CardTitle className="font-mono" role="heading" aria-level={3}>
              #{entry.revision}
            </CardTitle>
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
            {role === 'only' && (
              <Badge variant="secondary">{t.history.diff.selected(entry.revision)}</Badge>
            )}
            {role === 'older' && <Badge variant="secondary">{t.history.diff.olderSide}</Badge>}
            {role === 'newer' && <Badge variant="secondary">{t.history.diff.newerSide}</Badge>}
          </div>
          <CardDescription className="flex flex-wrap items-baseline gap-x-1.5">
            <span>{timeAgo(entry.at)}</span>
            <span aria-hidden>·</span>
            {/* 确切时间是要被逐字符核对的数据：等宽 + 等宽数字，整列才对得齐。 */}
            <span className="font-mono tabular-nums">{timeExact(entry.at)}</span>
            <span aria-hidden>·</span>
            <span className="font-mono break-all">{entry.actor}</span>
          </CardDescription>
          {isAdmin && hasSnapshot && (
            <CardAction>
              <Button
                variant="outline"
                size="sm"
                disabled={entry.live}
                title={entry.live ? t.history.rollback.errors.already_live : undefined}
                onClick={onRollback}
              >
                <RotateCcwIcon aria-hidden />
                {t.history.rollback.action}
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">
            {entry.routeCount === null
              ? t.history.routesUnknown
              : t.history.routes(entry.routeCount)}
          </p>
          {entry.note !== null && <p className="text-foreground text-sm">{entry.note}</p>}
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
  const [entries, setEntries] = React.useState<readonly RevisionEntry[] | null>(null);
  const [liveRevision, setLiveRevision] = React.useState<number | null>(null);
  const [failure, setFailure] = React.useState<LoadFailure | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [shown, setShown] = React.useState(PAGE_SIZE);
  /** 勾选的 revision，按勾选顺序，最多两个。 */
  const [selection, setSelection] = React.useState<Selection>([]);
  const [diffEntries, setDiffEntries] = React.useState<readonly DiffEntry[] | null>(null);
  const [diffLoading, setDiffLoading] = React.useState(false);
  const [diffFailure, setDiffFailure] = React.useState<DiffFailure | null>(null);
  /** 重试计数：同一对 revision 失败之后必须能再问一次，否则只能取消重勾。 */
  const [diffAttempt, setDiffAttempt] = React.useState(0);
  const [rollbackTarget, setRollbackTarget] = React.useState<RevisionEntry | null>(null);
  const compareRef = React.useRef<HTMLDivElement | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listRevisions();
      setEntries(list.entries);
      setLiveRevision(list.liveRevision);
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

  /**
   * 方向永远是时间序：`from` 取较小的 revision。勾选顺序只决定「再勾一个替换
   * 谁」，不决定 diff 读法 —— 自上而下勾（列表从新到旧）不该得到一个反向的 diff。
   */
  const pair = React.useMemo(() => {
    if (selection.length < 2) {
      return null;
    }
    const [a, b] = selection;
    return { older: Math.min(a, b), newer: Math.max(a, b) };
  }, [selection]);

  React.useEffect(() => {
    if (pair === null) {
      setDiffEntries(null);
      setDiffFailure(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffFailure(null);
    api
      .diffRevisions(pair.older, pair.newer)
      .then((result) => {
        if (!cancelled) {
          setDiffEntries(result);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const detail = detailOf(error);
        const known =
          error instanceof ApiError && error.code === 'snapshot_unavailable'
            ? t.history.diff.unavailable
            : error instanceof ApiError && error.code === 'snapshot_corrupt'
              ? t.history.diff.corrupt
              : error instanceof NetworkError
                ? t.common.networkError
                : t.history.diff.failed(
                    error instanceof ApiError ? error.code : t.common.unknownError,
                  );
        setDiffFailure({ text: known, ...(detail === undefined ? {} : { detail }) });
      })
      .finally(() => {
        if (!cancelled) {
          setDiffLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pair, diffAttempt]);

  /* 勾满两个就把对比区带进视口 —— 它在列表之前，人可能正停在第 30 张卡上。
     `nearest` 已经在视野里就不动，不会把人从他正在看的地方弹开。
     可选调用是给 jsdom 的：那里没有 scrollIntoView，而这不是测试该崩的理由。 */
  const complete = pair !== null;
  React.useEffect(() => {
    if (complete) {
      compareRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [complete]);

  const toggleSelect = (revision: number): void => {
    setSelection((current) => {
      if (current.includes(revision)) {
        return current.filter((value) => value !== revision);
      }
      // 先进先出：再勾一个替换先勾的那个。可预测，且与界面上那句提示一致。
      const next = [...current, revision];
      return next.length > 2 ? next.slice(next.length - 2) : next;
    });
  };

  const roleOf = (revision: number): 'none' | 'only' | 'older' | 'newer' => {
    if (pair !== null) {
      return pair.older === revision ? 'older' : pair.newer === revision ? 'newer' : 'none';
    }
    return selection[0] === revision ? 'only' : 'none';
  };

  const onRolledBack = (): void => {
    setRollbackTarget(null);
    setSelection([]);
    setShown(PAGE_SIZE);
    void load();
    onConfigChanged();
  };

  const dangerCount = diffEntries?.filter((entry) => entry.risk !== undefined).length ?? 0;

  /**
   * 对比区的状态句，只说一次。
   *
   * 它同时是可见文案和 live region：容器常驻（读屏才播报得到新内容），句子是
   * 这一句的唯一副本 —— 再抄一份 sr-only 的等于让读屏把同一句听两遍。
   */
  const statusText = ((): string => {
    if (pair === null) {
      return selection.length === 1 ? t.history.diff.pickedOne(selection[0]) : '';
    }
    if (diffLoading) {
      return t.history.diff.loading;
    }
    if (diffFailure !== null) {
      // 失败由那张 Alert 自己播报（`role="alert"` 是刚挂载也读得到的那种活区），
      // 状态行不再抄一遍 —— 同一句话在屏幕上出现两次比不出现更糟。
      return '';
    }
    if (diffEntries === null) {
      return '';
    }
    // 「两版完全一致」由卡里那句话解释成因，状态行只报计数 —— 一句话不出现两次。
    return t.history.diff.summary(diffEntries.length);
  })();

  /** 危险从句单独拆出来染色：全系统唯一的色相，在这里赚到了位置。 */
  const statusDanger =
    pair !== null && !diffLoading && diffFailure === null && dangerCount > 0
      ? t.history.diff.summaryDanger(dangerCount)
      : '';

  const visible = entries?.slice(0, shown) ?? [];
  const remaining = (entries?.length ?? 0) - visible.length;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <HistoryIcon aria-hidden />
            <CardTitle role="heading" aria-level={2}>
              {t.history.title}
            </CardTitle>
          </div>
          <CardDescription>{t.history.description}</CardDescription>
          <CardAction>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Spinner /> : <RefreshCwIcon aria-hidden />}
              {t.history.refresh}
            </Button>
          </CardAction>
        </CardHeader>
        {entries !== null && entries.length > 0 && (
          <CardContent className="flex flex-col gap-1">
            <p className="text-muted-foreground text-xs">{t.history.total(entries.length)}</p>
            {liveRevision !== null && !entries.some((entry) => entry.live) && (
              <p className="text-muted-foreground text-xs">
                {t.history.liveNotListed(liveRevision)}
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {failure !== null && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{failureText(failure)}</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t.common.retry}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* 对比区在时间轴之前：勾完两个 revision，结果就在眼前，不在 6 屏之外。 */}
      <div ref={compareRef} className="flex flex-col gap-4">
        {/* 常驻的状态行 —— 容器不卸载，读屏才收得到「勾了一个」「13 项差异」。 */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p
            role="status"
            aria-live="polite"
            className="text-muted-foreground flex items-center gap-2 text-sm"
          >
            {statusText !== '' && <GitCompareIcon className="size-4 shrink-0" aria-hidden />}
            {statusText}
            {statusDanger !== '' && (
              <span className="text-destructive font-medium">· {statusDanger}</span>
            )}
          </p>
          {selection.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setSelection([])}>
              {t.history.diff.clear}
            </Button>
          )}
        </div>

        {pair !== null && (
          <Card>
            <CardHeader>
              <CardTitle className="font-mono" role="heading" aria-level={2}>
                {t.history.diff.title(pair.older, pair.newer)}
              </CardTitle>
              <CardDescription>{t.history.diff.evictHint}</CardDescription>
            </CardHeader>
            <CardContent>
              {diffFailure !== null ? (
                <Alert variant="destructive" role="alert">
                  <AlertTitle>{diffFailure.text}</AlertTitle>
                  <AlertDescription className="flex flex-col items-start gap-2">
                    {diffFailure.detail !== undefined && (
                      <span className="font-mono text-xs break-all">{diffFailure.detail}</span>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDiffAttempt((attempt) => attempt + 1)}
                    >
                      {t.common.retry}
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : (
                <RevisionDiff
                  entries={diffEntries}
                  loading={diffLoading}
                  older={pair.older}
                  newer={pair.newer}
                />
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {loading && entries === null ? (
        <div className="flex flex-col gap-3 pl-6" aria-hidden>
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : entries !== null && entries.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HistoryIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>{t.history.empty.title}</EmptyTitle>
            <EmptyDescription>{t.history.empty.description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : entries !== null ? (
        <div className="flex flex-col gap-4">
          <ol className="flex flex-col gap-3">
            {visible.map((entry, index) => (
              <React.Fragment key={entry.revision}>
                {index > 0 && entry.revision < visible[index - 1].revision - 1 && (
                  <GapRow before={entry.revision} after={visible[index - 1].revision} />
                )}
                <RevisionCard
                  entry={entry}
                  role={roleOf(entry.revision)}
                  isAdmin={isAdmin}
                  onToggleSelect={() => toggleSelect(entry.revision)}
                  onRollback={() => setRollbackTarget(entry)}
                />
              </React.Fragment>
            ))}
          </ol>
          {remaining > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="self-center"
              onClick={() => setShown((current) => current + PAGE_SIZE)}
            >
              {t.history.showOlder(remaining)}
            </Button>
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
