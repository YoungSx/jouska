import * as React from 'react';
import { toast } from 'sonner';
import { MoreHorizontalIcon, PencilIcon, RefreshCwIcon, Trash2Icon, UsersIcon } from 'lucide-react';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { ApiError, NetworkError, api, type UserEntry } from '@/lib/api';
import { timeAgo, timeExact } from '@/lib/format';
import { t } from '@/lib/messages';
import { UserCreateDialog } from '@/components/user-create-dialog';
import { UserDeleteDialog } from '@/components/user-delete-dialog';
import { UserEditDialog } from '@/components/user-edit-dialog';

/**
 * 用户管理页(admin only)。
 *
 * 与 AuditView 同一自拉数据模式：列表没有本地可改的草稿，每次进来都该是服务端
 * 的当前事实。写操作全部通过弹窗进行，成功后重拉 —— 这张表上的每一行都关乎
 * 谁能进这扇门，不缓存。
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
      return t.users.loadFailed(failure.text);
  }
};

/** 服务端错误体里的 `detail` 是写给人看的，优先于裸错误码。 */
const errorDetail = (error: ApiError): string => {
  const detail = error.body.detail;
  return typeof detail === 'string' && detail !== '' ? detail : error.message;
};

const deleteMessageFor = (error: ApiError): string => {
  const errors = t.users.errors;
  switch (error.code) {
    case 'last_admin':
      return errors.last_admin;
    case 'last_user':
      return errors.last_user;
    case 'not_found':
      return errors.not_found;
    case 'forbidden':
      return errors.forbidden;
    default:
      return errors.unknown(error.code);
  }
};

/** 锁定与停用是两种不同的病：前者是服务的保护，后者是人的决定 —— 不共用文案。 */
const statusBadge = (user: UserEntry) => {
  if (user.lockedUntil !== null && user.lockedUntil * 1000 > Date.now()) {
    return (
      <Badge variant="destructive">
        <span title={t.users.status.lockedUntil(timeExact(user.lockedUntil))}>{t.users.status.locked}</span>
      </Badge>
    );
  }
  if (user.disabled) {
    return <Badge variant="secondary">{t.users.status.disabled}</Badge>;
  }
  return <Badge variant="outline">{t.users.status.normal}</Badge>;
};

interface UsersViewProps {
  readonly selfSubject: string;
  /** 自己的角色被改掉之后 SPA 缓存的身份已经陈旧，调用方负责刷新会话。 */
  readonly onSelfRoleChanged: () => void;
}

export const UsersView = ({ selfSubject, onSelfRoleChanged }: UsersViewProps) => {
  const [users, setUsers] = React.useState<readonly UserEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [failure, setFailure] = React.useState<LoadFailure | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<UserEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<UserEntry | null>(null);
  const [reloadToken, setReloadToken] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailure(null);
    void api
      .listUsers()
      .then((rows) => {
        if (!cancelled) {
          setUsers(rows);
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
  }, [reloadToken]);

  /** 弹窗成功后的统一出口：重拉列表。失败由弹窗自己用 handleWriteError 的套路报。 */
  const reload = () => {
    setReloadToken((token) => token + 1);
  };

  const onDelete = async (target: UserEntry) => {
    try {
      await api.deleteUser(target.id);
      toast.success(t.users.deleted(target.subject));
      setDeleteTarget(null);
      reload();
    } catch (cause) {
      setDeleteTarget(null);
      if (cause instanceof NetworkError) {
        toast.error(t.common.networkError);
      } else if (cause instanceof ApiError && cause.status === 401) {
        toast.error(t.common.sessionExpired);
      } else if (cause instanceof ApiError) {
        toast.error(deleteMessageFor(cause));
      } else {
        toast.error(t.users.errors.unknown(t.common.unknownError));
      }
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t.users.title}</CardTitle>
          <CardDescription>{t.users.description}</CardDescription>
          <CardAction className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => {
                setReloadToken((token) => token + 1);
              }}
            >
              {loading ? <Spinner /> : <RefreshCwIcon />}
              {t.users.refresh}
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              {t.users.create}
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
          ) : loading && users.length === 0 ? (
            <div className="flex flex-col gap-2" aria-hidden>
              {[0, 1, 2, 3].map((row) => (
                <Skeleton key={row} className="h-9 w-full" />
              ))}
            </div>
          ) : users.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UsersIcon />
                </EmptyMedia>
                <EmptyTitle>{t.users.empty.title}</EmptyTitle>
                <EmptyDescription>{t.users.empty.description}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <UsersTable
              users={users}
              selfSubject={selfSubject}
              onEdit={setEditTarget}
              onDelete={setDeleteTarget}
            />
          )}
        </CardContent>
      </Card>

      <UserCreateDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={reload} />

      <UserEditDialog
        target={editTarget}
        selfSubject={selfSubject}
        onClose={() => setEditTarget(null)}
        onSaved={() => {
          // 自己的角色改了，SPA 缓存的身份就是旧的了 —— 交回给 App 刷会话。
          if (editTarget !== null && editTarget.subject === selfSubject) {
            onSelfRoleChanged();
          }
          reload();
        }}
      />

      <UserDeleteDialog
        target={deleteTarget}
        selfSubject={selfSubject}
        onDismiss={() => setDeleteTarget(null)}
        onConfirm={(target) => void onDelete(target)}
      />
    </div>
  );
};

interface UsersTableProps {
  readonly users: readonly UserEntry[];
  readonly selfSubject: string;
  readonly onEdit: (user: UserEntry) => void;
  readonly onDelete: (user: UserEntry) => void;
}

const UsersTable = ({ users, selfSubject, onEdit, onDelete }: UsersTableProps) => (
  <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-36">{t.users.columns.subject}</TableHead>
          <TableHead className="w-20">{t.users.columns.role}</TableHead>
          <TableHead className="w-24">{t.users.columns.status}</TableHead>
          <TableHead className="w-16">{t.users.columns.sessions}</TableHead>
          <TableHead className="w-36">{t.users.columns.createdAt}</TableHead>
          <TableHead className="w-36">{t.users.columns.lastSeen}</TableHead>
          <TableHead className="w-12">
            <span className="sr-only">{t.users.columns.actions}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => {
          const isSelf = user.subject === selfSubject;
          return (
            <TableRow key={String(user.id)}>
              <TableCell className="text-xs">
                <span className="flex items-center gap-1.5">
                  {user.subject}
                  {isSelf && <Badge variant="secondary">{t.users.selfNote}</Badge>}
                </span>
              </TableCell>
              <TableCell className="text-xs">
                {user.role === 'admin' ? t.users.roleAdmin : t.users.roleViewer}
              </TableCell>
              <TableCell>{statusBadge(user)}</TableCell>
              <TableCell className="text-xs">{String(user.sessions)}</TableCell>
              <TableCell className="text-muted-foreground text-xs">
                <Tooltip>
                  <TooltipTrigger render={<span>{timeAgo(user.createdAt)}</span>} />
                  <TooltipContent>{timeExact(user.createdAt)}</TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell className="text-muted-foreground text-xs">
                {user.lastSeen === null ? (
                  <span>{t.users.status.never}</span>
                ) : (
                  <Tooltip>
                    <TooltipTrigger render={<span>{timeAgo(user.lastSeen)}</span>} />
                    <TooltipContent>{timeExact(user.lastSeen)}</TooltipContent>
                  </Tooltip>
                )}
              </TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="ghost" size="icon-sm" aria-label={t.users.rowMenu(user.subject)}>
                        <MoreHorizontalIcon />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" className="min-w-44">
                    <DropdownMenuItem onClick={() => onEdit(user)}>
                      <PencilIcon />
                      {t.users.edit}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      // 删自己等于亲手拆掉自己站的地面；服务端 last_user 会挡最后一行，这里挡得更早。
                      disabled={isSelf}
                      onClick={() => onDelete(user)}
                    >
                      <Trash2Icon />
                      {t.users.remove}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  </div>
);
