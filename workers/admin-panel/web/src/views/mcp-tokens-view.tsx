import * as React from 'react';
import {
  CheckIcon,
  ClipboardIcon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from 'lucide-react';
import { toast } from 'sonner';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { ApiError, api, type McpScope, type McpTokenEntry } from '@/lib/api';
import { timeAgo, timeExact } from '@/lib/format';
import { t } from '@/lib/messages';

const SCOPES: readonly McpScope[] = ['config:read', 'config:write', 'domains:read', 'audit:read'];
const EXPIRY_DAYS = [30, 90, 180, 365] as const;

interface McpTokensViewProps {
  readonly onUnauthenticated: () => void;
}

export const McpTokensView = ({ onUnauthenticated }: McpTokensViewProps) => {
  const [tokens, setTokens] = React.useState<readonly McpTokenEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [reloadToken, setReloadToken] = React.useState(0);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [revokeTarget, setRevokeTarget] = React.useState<McpTokenEntry | null>(null);
  const [newToken, setNewToken] = React.useState<McpTokenCreatedState | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .listMcpTokens()
      .then((result) => {
        if (!cancelled) setTokens(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          onUnauthenticated();
        } else {
          toast.error(
            t.mcp.loadFailed(error instanceof Error ? error.message : t.common.unknownError),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onUnauthenticated, reloadToken]);

  const create = async (input: {
    name: string;
    scopes: readonly McpScope[];
    expiresInDays: number;
  }) => {
    try {
      const created = await api.createMcpToken(input);
      setNewToken({ token: created.token, info: created.tokenInfo });
      setCreateOpen(false);
      setTokens((current) => [created.tokenInfo, ...current]);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthenticated();
        return;
      }
      toast.error(
        t.mcp.createFailed(error instanceof Error ? error.message : t.common.unknownError),
      );
    }
  };

  const revoke = async () => {
    const target = revokeTarget;
    if (target === null) return;
    setRevokeTarget(null);
    try {
      await api.revokeMcpToken(target.id);
      setTokens((current) =>
        current.map((entry) =>
          entry.id === target.id ? { ...entry, revokedAt: Math.floor(Date.now() / 1000) } : entry,
        ),
      );
      toast.success(t.mcp.revoked);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onUnauthenticated();
        return;
      }
      toast.error(
        t.mcp.revokeFailed(error instanceof Error ? error.message : t.common.unknownError),
      );
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t.mcp.title}</CardTitle>
          <CardDescription>{t.mcp.description}</CardDescription>
          <p className="text-muted-foreground text-xs">
            {t.mcp.endpoint} <code className="font-mono">{window.location.origin}/mcp</code>
          </p>
          <CardAction className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => setReloadToken((value) => value + 1)}
            >
              {loading ? <Spinner /> : <RefreshCwIcon />}
              {t.mcp.refresh}
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              {t.mcp.create}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {loading && tokens.length === 0 ? (
            <div className="flex flex-col gap-2" aria-hidden>
              {[0, 1, 2].map((row) => (
                <Skeleton key={row} className="h-12 w-full" />
              ))}
            </div>
          ) : tokens.length === 0 ? (
            <div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-center">
              <KeyRoundIcon className="size-8" />
              <p className="text-foreground font-medium">{t.mcp.empty}</p>
              <p className="text-sm">{t.mcp.emptyDescription}</p>
            </div>
          ) : (
            <TokenTable tokens={tokens} onRevoke={setRevokeTarget} />
          )}
        </CardContent>
      </Card>

      <CreateTokenDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={create} />
      <CreatedTokenDialog token={newToken} onClose={() => setNewToken(null)} />
      <Dialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {revokeTarget === null ? '' : t.mcp.revokeTitle(revokeTarget.name)}
            </DialogTitle>
            <DialogDescription>{t.mcp.revokeBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)}>
              {t.mcp.cancel}
            </Button>
            <Button variant="destructive" onClick={() => void revoke()}>
              <Trash2Icon />
              {t.mcp.revokeAction}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

/**
 * 状态徽标。`owner_deleted` 是删除主人账号时的连带吊销，普通「已撤销」看不出
 * 钥匙为什么死了——单独给一行文案，归属列的「主人已删除」配合着读才完整。
 */
const statusOf = (token: McpTokenEntry): 'active' | 'revoked' | 'owner_deleted' | 'expired' => {
  if (token.revokedAt != null) {
    return token.revokeReason === 'owner_deleted' ? 'owner_deleted' : 'revoked';
  }
  return token.expiresAt <= Date.now() / 1000 ? 'expired' : 'active';
};

const statusLabel = (token: McpTokenEntry): string => {
  const status = statusOf(token);
  return status === 'active'
    ? t.mcp.active
    : status === 'revoked'
      ? t.mcp.revoked
      : status === 'owner_deleted'
        ? t.mcp.revokedOwnerDeleted
        : t.mcp.expired;
};

const TokenTable = ({
  tokens,
  onRevoke,
}: {
  tokens: readonly McpTokenEntry[];
  onRevoke: (token: McpTokenEntry) => void;
}) => (
  <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t.mcp.columns.name}</TableHead>
          <TableHead>{t.mcp.columns.prefix}</TableHead>
          <TableHead>{t.mcp.columns.owner}</TableHead>
          <TableHead>{t.mcp.columns.scopes}</TableHead>
          <TableHead>{t.mcp.columns.expires}</TableHead>
          <TableHead>{t.mcp.columns.lastUsed}</TableHead>
          <TableHead>{t.mcp.columns.status}</TableHead>
          <TableHead className="w-20">
            <span className="sr-only">{t.mcp.columns.actions}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tokens.map((token) => {
          const status = statusOf(token);
          return (
            <TableRow key={token.id} className={status === 'active' ? undefined : 'opacity-60'}>
              <TableCell className="font-medium">{token.name}</TableCell>
              <TableCell className="font-mono text-xs">{token.tokenPrefix}…</TableCell>
              <TableCell className="text-xs">{token.ownerSubject ?? t.mcp.ownerDeleted}</TableCell>
              <TableCell>
                <div className="flex max-w-64 flex-wrap gap-1">
                  {token.scopes.map((scope) => (
                    <Badge key={scope} variant="secondary">
                      {scope}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="text-xs">
                <span title={timeExact(token.expiresAt)}>{timeAgo(token.expiresAt)}</span>
              </TableCell>
              <TableCell className="text-xs">
                {token.lastUsedAt == null ? (
                  t.mcp.neverUsed
                ) : (
                  <span title={timeExact(token.lastUsedAt)}>{timeAgo(token.lastUsedAt)}</span>
                )}
              </TableCell>
              <TableCell>
                <Badge variant={status === 'active' ? 'default' : 'secondary'}>
                  {statusLabel(token)}
                </Badge>
              </TableCell>
              <TableCell>
                {status === 'active' && (
                  <Button variant="ghost" size="xs" onClick={() => onRevoke(token)}>
                    <Trash2Icon />
                    <span className="sr-only">{t.mcp.revoke}</span>
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  </div>
);

interface McpTokenCreatedState {
  readonly token: string;
  readonly info: McpTokenEntry;
}

const CreatedTokenDialog = ({
  token,
  onClose,
}: {
  token: McpTokenCreatedState | null;
  onClose: () => void;
}) => {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => setCopied(false), [token]);
  if (token === null) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
      toast.success(t.mcp.copied);
    } catch {
      toast.error(t.common.copyFailed);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.mcp.tokenTitle}</DialogTitle>
          <DialogDescription>{t.mcp.tokenBody}</DialogDescription>
        </DialogHeader>
        <Alert>
          <ShieldAlertIcon />
          <AlertTitle>{t.mcp.onlyOnce}</AlertTitle>
          <AlertDescription>{token.info.name}</AlertDescription>
        </Alert>
        <Field>
          <FieldLabel htmlFor="mcp-token-endpoint">{t.mcp.endpoint}</FieldLabel>
          <Input
            id="mcp-token-endpoint"
            value={`${window.location.origin}/mcp`}
            readOnly
            className="font-mono text-xs"
          />
        </Field>
        <div className="flex items-center gap-2">
          <Input
            value={token.token}
            readOnly
            className="font-mono text-xs"
            aria-label={t.mcp.tokenTitle}
          />
          <Button
            variant="outline"
            size="icon"
            onClick={() => void copy()}
            aria-label={t.mcp.copyToken}
          >
            {copied ? <CheckIcon /> : <ClipboardIcon />}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t.mcp.saved}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const CreateTokenDialog = ({
  open,
  onOpenChange,
  onCreate,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (input: {
    name: string;
    scopes: readonly McpScope[];
    expiresInDays: number;
  }) => Promise<void>;
}) => {
  const [name, setName] = React.useState('');
  const [days, setDays] = React.useState(90);
  const [scopes, setScopes] = React.useState<McpScope[]>(['config:read']);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) {
      setName('');
      setDays(90);
      setScopes(['config:read']);
      setError(null);
      setSaving(false);
    }
  }, [open]);
  const submit = async () => {
    if (name.trim() === '') {
      setError(t.mcp.invalidName);
      return;
    }
    if (scopes.length === 0) {
      setError(t.mcp.invalidScopes);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), scopes, expiresInDays: days });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.mcp.createTitle}</DialogTitle>
          <DialogDescription>{t.mcp.createBody}</DialogDescription>
        </DialogHeader>
        {error !== null && (
          <Alert variant="destructive">
            <AlertTitle>{error}</AlertTitle>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="mcp-token-name">{t.mcp.name}</FieldLabel>
          <Input
            id="mcp-token-name"
            value={name}
            placeholder={t.mcp.namePlaceholder}
            onChange={(event) => setName(event.target.value)}
          />
          <FieldDescription>{t.mcp.onlyOnce}</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="mcp-token-expires">{t.mcp.expires}</FieldLabel>
          <Select value={String(days)} onValueChange={(value) => setDays(Number(value))}>
            <SelectTrigger id="mcp-token-expires" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_DAYS.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {t.mcp.days(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t.mcp.scopes}</legend>
          {SCOPES.map((scope) => (
            <label key={scope} className="flex items-start gap-2 rounded-lg border p-2.5 text-sm">
              <Checkbox
                checked={scopes.includes(scope)}
                onCheckedChange={(checked) =>
                  setScopes((current) =>
                    checked === true
                      ? [...new Set([...current, scope])]
                      : current.filter((entry) => entry !== scope),
                  )
                }
              />
              <span>
                <span className="block font-medium">{t.mcp.scopeLabels[scope]}</span>
                <span className="text-muted-foreground text-xs">{t.mcp.scopeHints[scope]}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.mcp.cancel}
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving ? <Spinner /> : <KeyRoundIcon />}
            {saving ? t.mcp.creating : t.mcp.createAction}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
