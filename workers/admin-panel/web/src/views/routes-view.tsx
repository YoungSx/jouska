import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RouteIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { RouteEntry } from '@/lib/api';
import {
  isUsableDefinition,
  matchSummary,
  timeAgo,
  timeExact,
  upstreamSummary,
} from '@/lib/format';
import { t } from '@/lib/messages';

import { DefaultsCard } from './defaults-card';

/**
 * 路由表。
 *
 * 顺序即优先级，所以「#」列不是装饰性行号而是真实的匹配顺序，上下移动就是改优先
 * 级。用上下按钮而不是拖拽：拖拽在键盘和读屏下需要一整套额外实现，而这张表通常
 * 只有几条到几十条，两个按钮已经够用且天然可达。
 *
 * 损坏的行必须显示出来而不是跳过 —— 操作者要在界面里看见并修好它（PRODUCT.md
 * 的产品原则之一）。
 */

interface RoutesViewProps {
  readonly routes: readonly RouteEntry[];
  readonly defaults: Record<string, unknown> | null;
  readonly loading: boolean;
  readonly isAdmin: boolean;
  /** 每条路由上命中的危险字段路径，来自预览。行内就地标出，不等到发布才说。 */
  readonly dangersByRoute: Record<string, readonly string[]>;
  readonly onCreate: () => void;
  readonly onEdit: (route: RouteEntry) => void;
  readonly onDuplicate: (route: RouteEntry) => void;
  readonly onDelete: (route: RouteEntry) => void;
  readonly onMove: (index: number, direction: -1 | 1) => void;
  readonly onSaveDefaults: (defaults: Record<string, unknown>) => Promise<void>;
}

export const RoutesView = ({
  routes,
  defaults,
  loading,
  isAdmin,
  dangersByRoute,
  onCreate,
  onEdit,
  onDuplicate,
  onDelete,
  onMove,
  onSaveDefaults,
}: RoutesViewProps) => {
  const enabledCount = routes.filter((route) => route.enabled).length;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t.routes.title}</CardTitle>
          <CardDescription>{t.routes.orderNote}</CardDescription>
          <CardAction className="flex items-center gap-2">
            {routes.length > 0 && (
              <span className="text-muted-foreground tabular hidden text-xs sm:inline">
                {t.routes.enabledCount(enabledCount, routes.length)}
              </span>
            )}
            {isAdmin && (
              <Button size="sm" onClick={onCreate}>
                <PlusIcon />
                {t.routes.create}
              </Button>
            )}
          </CardAction>
        </CardHeader>

        <CardContent>
          {loading && routes.length === 0 ? (
            <RouteSkeleton />
          ) : routes.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RouteIcon />
                </EmptyMedia>
                <EmptyTitle>
                  {isAdmin ? t.routes.empty.title : t.routes.emptyViewer.title}
                </EmptyTitle>
                <EmptyDescription>
                  {isAdmin ? t.routes.empty.description : t.routes.emptyViewer.description}
                </EmptyDescription>
              </EmptyHeader>
              {isAdmin && (
                <EmptyContent>
                  <Button onClick={onCreate}>
                    <PlusIcon />
                    {t.routes.empty.action}
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          ) : (
            <RouteTable
              routes={routes}
              isAdmin={isAdmin}
              dangersByRoute={dangersByRoute}
              onEdit={onEdit}
              onDuplicate={onDuplicate}
              onDelete={onDelete}
              onMove={onMove}
            />
          )}
        </CardContent>
      </Card>

      {/* key 让服务端的 defaults 变化重挂卡片，编辑器内的本地状态随之重置。 */}
      <DefaultsCard
        key={JSON.stringify(defaults)}
        defaults={defaults}
        isAdmin={isAdmin}
        onSave={onSaveDefaults}
      />
    </div>
  );
};

const RouteSkeleton = () => (
  <div className="flex flex-col gap-2" aria-hidden>
    {[0, 1, 2].map((row) => (
      <Skeleton key={row} className="h-9 w-full" />
    ))}
  </div>
);

interface RouteTableProps {
  readonly routes: readonly RouteEntry[];
  readonly isAdmin: boolean;
  readonly dangersByRoute: Record<string, readonly string[]>;
  readonly onEdit: (route: RouteEntry) => void;
  readonly onDuplicate: (route: RouteEntry) => void;
  readonly onDelete: (route: RouteEntry) => void;
  readonly onMove: (index: number, direction: -1 | 1) => void;
}

const RouteTable = ({
  routes,
  isAdmin,
  dangersByRoute,
  onEdit,
  onDuplicate,
  onDelete,
  onMove,
}: RouteTableProps) => (
  // 窄屏时表格横向滚动而不是把列挤成两行 —— 这些值要逐字符核对，换行会读错。
  <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">{t.routes.columns.order}</TableHead>
          <TableHead>{t.routes.columns.id}</TableHead>
          <TableHead>{t.routes.columns.match}</TableHead>
          <TableHead>{t.routes.columns.upstream}</TableHead>
          <TableHead className="w-24">{t.routes.columns.status}</TableHead>
          <TableHead className="w-28">{t.routes.columns.updated}</TableHead>
          <TableHead className="w-10">
            <span className="sr-only">{t.routes.columns.actions}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {routes.map((route, index) => (
          <RouteRow
            key={route.id}
            route={route}
            index={index}
            total={routes.length}
            isAdmin={isAdmin}
            dangers={dangersByRoute[route.id] ?? []}
            onEdit={onEdit}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            onMove={onMove}
          />
        ))}
      </TableBody>
    </Table>
  </div>
);

interface RouteRowProps {
  readonly route: RouteEntry;
  readonly index: number;
  readonly total: number;
  readonly isAdmin: boolean;
  readonly dangers: readonly string[];
  readonly onEdit: (route: RouteEntry) => void;
  readonly onDuplicate: (route: RouteEntry) => void;
  readonly onDelete: (route: RouteEntry) => void;
  readonly onMove: (index: number, direction: -1 | 1) => void;
}

const RouteRow = ({
  route,
  index,
  total,
  isAdmin,
  dangers,
  onEdit,
  onDuplicate,
  onDelete,
  onMove,
}: RouteRowProps) => {
  const usable = isUsableDefinition(route.definition);

  return (
    <TableRow className={route.enabled ? undefined : 'opacity-60'}>
      <TableCell className="text-muted-foreground tabular text-xs">{index + 1}</TableCell>

      <TableCell className="font-mono text-xs">{route.id}</TableCell>

      {usable ? (
        <>
          <TableCell className="font-mono text-xs">{matchSummary(route.definition)}</TableCell>
          <TableCell className="font-mono text-xs">{upstreamSummary(route.definition)}</TableCell>
        </>
      ) : (
        <TableCell colSpan={2}>
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge variant="destructive">
                  <TriangleAlertIcon />
                  {t.routes.corrupt}
                </Badge>
              }
            />
            <TooltipContent>{t.routes.corruptHint}</TooltipContent>
          </Tooltip>
        </TableCell>
      )}

      <TableCell>
        <div className="flex items-center gap-1.5">
          <Badge variant={route.enabled ? 'default' : 'secondary'}>
            {route.enabled ? t.routes.enabled : t.routes.disabled}
          </Badge>
          {dangers.length > 0 && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Badge variant="destructive" aria-label={t.preview.dangerTitle}>
                    <TriangleAlertIcon />
                    {dangers.length}
                  </Badge>
                }
              />
              <TooltipContent className="max-w-72">
                <p className="font-medium">{t.preview.dangerTitle}</p>
                <ul className="mt-1 list-disc pl-4">
                  {dangers.map((path) => (
                    <li key={path} className="font-mono text-xs">
                      {path}
                    </li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </TableCell>

      <TableCell className="text-muted-foreground text-xs">
        <Tooltip>
          <TooltipTrigger render={<span>{timeAgo(route.updatedAt)}</span>} />
          <TooltipContent>
            {t.routes.updatedBy(route.updatedBy, timeExact(route.updatedAt))}
          </TooltipContent>
        </Tooltip>
      </TableCell>

      <TableCell>
        {isAdmin && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={t.routes.rowMenu(route.id)}>
                  <MoreHorizontalIcon />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem onClick={() => onEdit(route)} disabled={!usable}>
                <PencilIcon />
                {t.routes.edit}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDuplicate(route)} disabled={!usable}>
                <CopyIcon />
                {t.routes.duplicate}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onMove(index, -1)} disabled={index === 0}>
                <ArrowUpIcon />
                {t.routes.moveUp}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onMove(index, 1)} disabled={index === total - 1}>
                <ArrowDownIcon />
                {t.routes.moveDown}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(route)}>
                <Trash2Icon />
                {t.routes.remove}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
};
