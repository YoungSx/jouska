import * as React from 'react';
import { RefreshCwIcon, ScrollTextIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { ApiError, NetworkError, api, type AuditEntry } from '@/lib/api';
import { timeAgo, timeExact } from '@/lib/format';
import { t } from '@/lib/messages';

/**
 * 审计日志。
 *
 * 只读、自己拉数据：这张表没有本地可改的状态，每一次进来都该是服务端的当前事实，
 * 所以它不接外部状态，也不缓存 —— 变更 limit 或点刷新就重拉。
 */

/** 面板自己定的档位；服务端接受任意 limit，LIMITS 里没有审计条数的键。 */
const LIMIT_CHOICES = [50, 100, 200] as const;
const DEFAULT_LIMIT = 100;

/**
 * 加载失败分三类，因为该给的下一步不一样：网络不通给刷新，会话过期给重登，
 * 其余给服务端的原话。401 在这里不是「重新探测会话」—— 操作者手上有刷新按钮。
 */
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
      return t.audit.loadFailed(failure.text);
  }
};

/** 服务端错误体里的 `detail` 是写给人看的，优先于裸错误码。 */
const errorDetail = (error: ApiError): string => {
  const detail = error.body.detail;
  return typeof detail === 'string' && detail !== '' ? detail : error.message;
};

export const AuditView = () => {
  const [limit, setLimit] = React.useState<number>(DEFAULT_LIMIT);
  const [entries, setEntries] = React.useState<readonly AuditEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [failure, setFailure] = React.useState<LoadFailure | null>(null);
  const [detailEntry, setDetailEntry] = React.useState<AuditEntry | null>(null);
  // 变更 limit 或点刷新都靠它重触发拉取 —— 一个依赖数组，一条数据流。
  const [reloadToken, setReloadToken] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailure(null);
    void api
      .audit(limit)
      .then((rows) => {
        if (!cancelled) {
          setEntries(rows);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        if (cause instanceof NetworkError) {
          setFailure({ kind: 'network' });
        } else if (cause instanceof ApiError && cause.status === 401) {
          setFailure({ kind: 'session' });
        } else if (cause instanceof ApiError) {
          setFailure({ kind: 'message', text: errorDetail(cause) });
        } else {
          setFailure({ kind: 'message', text: t.common.unknownError });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [limit, reloadToken]);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t.audit.title}</CardTitle>
          <CardDescription>{t.audit.description}</CardDescription>
          <CardAction className="flex items-center gap-2">
            <Label htmlFor="audit-limit" className="text-muted-foreground text-xs">
              {t.audit.limitLabel}
            </Label>
            <Select
              value={String(limit)}
              onValueChange={(value) => {
                setLimit(Number(value));
              }}
            >
              <SelectTrigger id="audit-limit" size="sm" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMIT_CHOICES.map((choice) => (
                  <SelectItem key={choice} value={String(choice)}>
                    {String(choice)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => {
                setReloadToken((token) => token + 1);
              }}
            >
              {loading ? <Spinner /> : <RefreshCwIcon />}
              {t.audit.refresh}
            </Button>
          </CardAction>
        </CardHeader>

        <CardContent>
          {failure !== null ? (
            <Alert variant="destructive">
              <AlertTitle>{failureText(failure)}</AlertTitle>
              <AlertDescription>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setReloadToken((token) => token + 1);
                  }}
                >
                  {t.common.retry}
                </Button>
              </AlertDescription>
            </Alert>
          ) : loading && entries.length === 0 ? (
            <div className="flex flex-col gap-2" aria-hidden>
              {[0, 1, 2, 3].map((row) => (
                <Skeleton key={row} className="h-9 w-full" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ScrollTextIcon />
                </EmptyMedia>
                <EmptyTitle>{t.audit.empty.title}</EmptyTitle>
                <EmptyDescription>{t.audit.empty.description}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <AuditTable entries={entries} onViewDetail={setDetailEntry} />
          )}
        </CardContent>
      </Card>

      <AuditDetailDialog entry={detailEntry} onClose={() => setDetailEntry(null)} />
    </div>
  );
};

interface AuditTableProps {
  readonly entries: readonly AuditEntry[];
  readonly onViewDetail: (entry: AuditEntry) => void;
}

const AuditTable = ({ entries, onViewDetail }: AuditTableProps) => (
  // 时间与对象要逐字符核对，窄屏横向滚动而不是把列挤成两行。
  <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-32">{t.audit.columns.at}</TableHead>
          <TableHead className="w-36">{t.audit.columns.actor}</TableHead>
          <TableHead className="w-32">{t.audit.columns.action}</TableHead>
          <TableHead>{t.audit.columns.target}</TableHead>
          <TableHead>{t.audit.columns.detail}</TableHead>
          <TableHead className="w-20">
            <span className="sr-only">{t.audit.viewDetail}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell className="text-muted-foreground text-xs">
              <Tooltip>
                <TooltipTrigger render={<span>{timeAgo(entry.at)}</span>} />
                <TooltipContent>{timeExact(entry.at)}</TooltipContent>
              </Tooltip>
            </TableCell>

            <TableCell className="text-xs">{entry.actor}</TableCell>

            <TableCell className="text-xs">
              {/* 未收录的动作原样显示英文码：编一个中文词比露出真码更难排障。 */}
              {t.audit.actions[entry.action] ?? entry.action}
            </TableCell>

            <TableCell className="font-mono text-xs">{entry.target ?? t.common.unset}</TableCell>

            <TableCell className="max-w-56">
              {entry.detail === null ? (
                <span className="text-muted-foreground text-xs">{t.common.unset}</span>
              ) : (
                <span className="block truncate font-mono text-xs">{entry.detail}</span>
              )}
            </TableCell>

            <TableCell>
              {entry.detail !== null && (
                <Button variant="ghost" size="xs" onClick={() => onViewDetail(entry)}>
                  {t.audit.viewDetail}
                </Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </div>
);

interface AuditDetailDialogProps {
  readonly entry: AuditEntry | null;
  readonly onClose: () => void;
}

const AuditDetailDialog = ({ entry, onClose }: AuditDetailDialogProps) => (
  <Dialog open={entry !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t.audit.detailTitle}</DialogTitle>
      </DialogHeader>
      <pre className="bg-muted max-h-96 overflow-auto rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap">
        {entry?.detail}
      </pre>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>{t.common.close}</DialogClose>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
