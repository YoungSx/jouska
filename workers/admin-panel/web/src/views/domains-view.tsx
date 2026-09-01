import * as React from 'react';
import { GlobeIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ApiError,
  NetworkError,
  api,
  type BindingKind,
  type DomainsResponse,
  type HostBinding,
  type UnconfiguredReason,
} from '@/lib/api';
import { t } from '@/lib/messages';

/**
 * 域名发现页。
 *
 * 回答操作者写 match.host 时的两个问题：我哪个域名没人接（表里的「没有路由接管」
 * 行），我哪条路由指着一个还不存在的域名（unmatched 告警）。这两件事必须同页可见，
 * 否则操作者要在 Cloudflare 控制台和路由表之间来回对。
 *
 * 数据自己拉：这页只读 Cloudflare，不碰草稿，与 useDraft 的状态无关。
 */

type LoadError =
  | { readonly kind: 'network' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'other'; readonly message: string };

const toLoadError = (cause: unknown): LoadError => {
  if (cause instanceof NetworkError) {
    return { kind: 'network' };
  }
  if (cause instanceof ApiError && cause.status === 401) {
    return { kind: 'unauthenticated' };
  }
  return {
    kind: 'other',
    message: cause instanceof Error ? cause.message : t.common.unknownError,
  };
};

const errorTitle = (error: LoadError): string => {
  switch (error.kind) {
    case 'network':
      return t.common.networkError;
    case 'unauthenticated':
      return t.common.sessionExpired;
    case 'other':
      return t.domains.loadFailed(error.message);
  }
};

/** kinds 表按 BindingKind 三键全覆盖，但服务端将来加新枚举时别渲染出 undefined。 */
const kindLabel = (kind: BindingKind): string => t.domains.kinds[kind] ?? kind;

export const DomainsView = () => {
  const [data, setData] = React.useState<DomainsResponse | null>(null);
  const [error, setError] = React.useState<LoadError | null>(null);
  // 初始加载也走 refreshing：失败后点重试走的是同一条路径，不该有第二套状态。
  const [refreshing, setRefreshing] = React.useState(true);

  const load = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await api.domains();
      setData(result);
      setError(null);
    } catch (cause) {
      setError(toLoadError(cause));
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.domains.title}</CardTitle>
        <CardDescription>{t.domains.description}</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void load()}>
            {refreshing ? <Spinner /> : <RefreshCwIcon />}
            {refreshing ? t.domains.refreshing : t.domains.refresh}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent>
        {error !== null ? (
          <ErrorState title={errorTitle(error)} onRetry={() => void load()} />
        ) : data === null ? (
          <div className="flex flex-col gap-2" aria-hidden>
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-9 w-full" />
            ))}
          </div>
        ) : data.configured ? (
          <ConfiguredState data={data} />
        ) : (
          <UnconfiguredState reason={data.reason ?? null} />
        )}
      </CardContent>
    </Card>
  );
};

/** 加载失败的整卡状态。带重试而不是静默变空 —— 清单可能不完整这件事必须让人看见。 */
const ErrorState = ({ title, onRetry }: { title: string; onRetry: () => void }) => (
  <Alert variant="destructive">
    <TriangleAlertIcon />
    <AlertTitle>{title}</AlertTitle>
    <AlertAction>
      <Button variant="destructive" size="sm" onClick={onRetry}>
        <RefreshCwIcon />
        {t.common.retry}
      </Button>
    </AlertAction>
  </Alert>
);

/**
 * 没配凭据是受支持的部署，不是错误：中性卡片、不报警。
 * 这页缺了它只是少一个视角，其他每一页照常工作。
 */
const UnconfiguredState = ({ reason }: { reason: UnconfiguredReason | null }) => (
  <div className="flex flex-col gap-4 py-2">
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium">{t.domains.unconfigured.title}</p>
      <p className="text-muted-foreground text-sm">{t.domains.unconfigured.description}</p>
    </div>

    {/* reason 省略时不替服务端猜缺哪一个 —— 猜错会把人引去查根本在的值。 */}
    {reason !== null && <p className="text-sm">{t.domains.unconfigured[reason]}</p>}

    <div className="bg-muted/40 flex flex-col gap-1 rounded-lg p-3">
      <p className="text-sm font-medium">{t.domains.unconfigured.tokenScopeTitle}</p>
      <p className="text-muted-foreground text-xs leading-relaxed">
        {t.domains.unconfigured.tokenScopeHint}
      </p>
    </div>

    <p className="text-muted-foreground text-xs">{t.domains.unconfigured.skipNote}</p>
  </div>
);

const ConfiguredState = ({ data }: { data: DomainsResponse }) => {
  // 可选字段服务端都可能整个省略（省略 ≠ 空数组），一律先判空。
  const hosts = data.hosts ?? [];
  const failures = data.failures ?? [];
  const unmatched = data.unmatchedRouteHosts ?? [];
  const skippedZones = data.skippedZones ?? [];

  return (
    <div className="flex flex-col gap-4">
      {/* 有来源读不到时清单必然缺角，先于表说明，否则数字会被当成完整的。 */}
      {failures.length > 0 && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>{t.domains.failuresTitle}</AlertTitle>
          <AlertDescription>
            <p>{t.domains.failuresHint}</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
              {failures.map((failure) => (
                <li key={`${failure.source}:${failure.message}`} className="text-xs">
                  <span className="font-mono">{failure.source}</span>
                  {' · '}
                  {failure.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {unmatched.length > 0 && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>{t.domains.unmatchedTitle}</AlertTitle>
          <AlertDescription>
            <p>{t.domains.unmatchedHint}</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 font-mono text-xs">
              {unmatched.map((item) => (
                <li key={`${item.routeId}:${item.host}`}>
                  {t.domains.unmatchedLine(item.routeId, item.host)}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {skippedZones.length > 0 && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>{t.domains.skippedZonesTitle}</AlertTitle>
          <AlertDescription>
            <p>{t.domains.skippedZonesHint}</p>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 font-mono text-xs">
              {skippedZones.map((zone) => (
                <li key={zone}>{zone}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {hosts.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GlobeIcon />
            </EmptyMedia>
            <EmptyTitle>{t.domains.empty.title}</EmptyTitle>
            <EmptyDescription>{t.domains.empty.description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <HostTable hosts={hosts} />
      )}

      <div className="text-muted-foreground flex flex-col gap-0.5 text-xs">
        {/* script 可能省略：查询的是哪个 Worker 的绑定只有服务端知道。 */}
        {data.script !== undefined && <p>{t.domains.scriptNote(data.script)}</p>}
        <p>{t.domains.readOnlyNote}</p>
      </div>
    </div>
  );
};

const HostTable = ({ hosts }: { hosts: readonly HostBinding[] }) => (
  // 窄屏横向滚动而不是折行：hostname 与 route 计数要逐字符核对。
  <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t.domains.columns.host}</TableHead>
          <TableHead className="w-28">{t.domains.columns.kind}</TableHead>
          <TableHead className="w-40">{t.domains.columns.zone}</TableHead>
          <TableHead className="w-40">{t.domains.columns.routes}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {hosts.map((host) => (
          <HostRow key={host.host} binding={host} />
        ))}
      </TableBody>
    </Table>
  </div>
);

const HostRow = ({ binding }: { binding: HostBinding }) => {
  // 能打到反代却没路由接：流量会穿过去，整行轻警示而不是只改一个格子。
  const orphaned = binding.routeIds.length === 0;

  return (
    <TableRow className={orphaned ? 'bg-destructive/5' : undefined}>
      <TableCell className="font-mono text-xs">{binding.host}</TableCell>

      <TableCell>
        {/* secondary：来源是分类信息，destructive 留给真正的问题（见右列）。 */}
        <Badge variant="secondary">{kindLabel(binding.kind)}</Badge>
      </TableCell>

      <TableCell className="text-muted-foreground text-xs">
        {/* zone 只对 zone route 有意义，workers.dev / 自定义域没有 —— 不是漏配。 */}
        {binding.zone ?? t.common.unset}
      </TableCell>

      <TableCell>
        {orphaned ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge variant="destructive">
                  <TriangleAlertIcon />
                  {t.domains.noRoute}
                </Badge>
              }
            />
            <TooltipContent className="max-w-72">{t.domains.noRouteHint}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs tabular">{t.domains.matchesAll(binding.routeIds.length)}</span>
        )}
      </TableCell>
    </TableRow>
  );
};
