import * as React from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ApiError, NetworkError, api, type Role, type UserEntry } from '@/lib/api';
import { t } from '@/lib/messages';

/**
 * 编辑用户：角色、停用、解锁。
 *
 * 打开时的值就是列表此刻的快照；提交发 PATCH。服务端的 last-admin 守卫是权威
 * （写在 SQL 里，check-then-act 根本不存在），这里不预判 —— 409 回来原样转述。
 */

interface UserEditDialogProps {
  readonly target: UserEntry | null;
  /** 当前登录者自己的 subject —— self 的角色改动之后 SPA 缓存的会话已经陈旧。 */
  readonly selfSubject: string;
  readonly onClose: () => void;
  /** 保存成功（可能改了自己的角色）后由调用方刷新列表，必要时刷新会话。 */
  readonly onSaved: () => void;
}

const messageFor = (error: ApiError): string => {
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

export const UserEditDialog = ({ target, selfSubject, onClose, onSaved }: UserEditDialogProps) => {
  const [role, setRole] = React.useState<Role>('viewer');
  const [disabled, setDisabled] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // target 从 null 变成一个人时，把快照抄进本地状态 —— 不跟着列表实时动，
  // 编辑到一半列表刷新了也不会把没确认的值悄悄换掉。
  React.useEffect(() => {
    if (target !== null) {
      setRole(target.role);
      setDisabled(target.disabled);
      setBusy(false);
      setError(null);
    }
  }, [target]);

  if (target === null) {
    return null;
  }
  const isSelf = target.subject === selfSubject;
  const hasChanges = role !== target.role || (!isSelf && disabled !== target.disabled);

  const submit = async () => {
    const patch: { role?: Role; disabled?: boolean } = {};
    if (role !== target.role) {
      patch.role = role;
    }
    if (!isSelf && disabled !== target.disabled) {
      patch.disabled = disabled;
    }
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateUser(target.id, patch);
      toast.success(t.users.updated(target.subject));
      onSaved();
      onClose();
    } catch (cause) {
      if (cause instanceof NetworkError) {
        setError(t.common.networkError);
      } else if (cause instanceof ApiError && cause.status === 401) {
        setError(t.common.sessionExpired);
      } else if (cause instanceof ApiError) {
        setError(messageFor(cause));
      } else {
        setError(t.users.errors.unknown(t.common.unknownError));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t.users.editTitle(target.subject)}
            {isSelf && <Badge variant="secondary">{t.users.selfNote}</Badge>}
          </DialogTitle>
          <DialogDescription>{t.users.description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="user-edit-role">{t.users.editRole}</FieldLabel>
            <Select
              value={role}
              onValueChange={(value) => setRole(value === 'admin' ? 'admin' : 'viewer')}
            >
              <SelectTrigger id="user-edit-role" disabled={busy} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">{t.users.roleAdmin}</SelectItem>
                <SelectItem value="viewer">{t.users.roleViewer}</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>{t.users.editRoleHint}</FieldDescription>
          </Field>

          {isSelf ? (
            // 自己停用自己没有出口 —— 服务端守卫会挡，但界面不该先把人领进死胡同。
            <p className="text-muted-foreground text-sm">{t.users.selfNote}</p>
          ) : (
            <label className="flex items-start gap-2 text-sm">
              <Switch checked={disabled} onCheckedChange={setDisabled} disabled={busy} />
              <span className="flex flex-col gap-0.5">
                <span>{t.users.editDisabled}</span>
                <span className="text-muted-foreground text-xs">{t.users.editDisabledHint}</span>
              </span>
            </label>
          )}

          {error !== null && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !hasChanges}>
            {busy ? <Spinner /> : undefined}
            {busy ? t.common.loading : t.users.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
