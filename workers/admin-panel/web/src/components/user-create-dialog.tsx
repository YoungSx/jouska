import * as React from 'react';
import { UserPlusIcon } from 'lucide-react';
import { toast } from 'sonner';
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, NetworkError, api, type Role } from '@/lib/api';
import { t } from '@/lib/messages';
import { LIMITS } from '@/lib/types';

/**
 * 新建用户。
 *
 * 角色缺省「观察者」且界面上明摆着这个缺省 —— 与服务端一致的取向：一次点击
 * 造出来的账号宁可选权限小的那头。
 *
 * 这里不设任何凭据：账号名必须与 Cloudflare Access 认到的邮箱一字不差，因为那
 * 就是服务端拿来查这一行的键。打错一个字符的后果不是报错，是对方进来之后被告知
 * 查无此人 —— 所以字段说明把这件事写在了输入框底下。
 */

interface UserCreateDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 创建成功后由调用方关弹窗、刷列表。 */
  readonly onCreated: (subject: string) => void;
}

const messageFor = (error: ApiError): string => {
  const errors = t.users.errors;
  switch (error.code) {
    case 'subject_taken':
      return errors.subject_taken;
    case 'forbidden':
      return errors.forbidden;
    case 'invalid_input':
      return errors.invalid_input;
    default:
      return errors.unknown(error.code);
  }
};

export const UserCreateDialog = ({ open, onOpenChange, onCreated }: UserCreateDialogProps) => {
  const [subject, setSubject] = React.useState('');
  const [role, setRole] = React.useState<Role>('viewer');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setSubject('');
      setRole('viewer');
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const subjectOk = subject.trim().length > 0 && subject.trim().length <= LIMITS.maxSubjectLength;
  const canSubmit = subjectOk && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const trimmed = subject.trim();
    try {
      await api.createUser(trimmed, role);
      toast.success(t.users.created(trimmed));
      onCreated(trimmed);
      onOpenChange(false);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t.users.createTitle}</DialogTitle>
          <DialogDescription>{t.users.createDescription}</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) {
              void submit();
            }
          }}
        >
          <Field>
            <FieldLabel htmlFor="user-subject">{t.users.subject}</FieldLabel>
            <Input
              id="user-subject"
              value={subject}
              maxLength={LIMITS.maxSubjectLength}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setSubject(event.target.value)}
            />
            <FieldDescription>{t.users.subjectHint}</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="user-role">{t.users.columns.role}</FieldLabel>
            <Select
              value={role}
              onValueChange={(value) => setRole(value === 'admin' ? 'admin' : 'viewer')}
            >
              <SelectTrigger id="user-role" disabled={busy} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">{t.users.roleViewer}</SelectItem>
                <SelectItem value="admin">{t.users.roleAdmin}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {error !== null && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {busy ? <Spinner /> : <UserPlusIcon />}
              {busy ? t.common.loading : t.users.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
