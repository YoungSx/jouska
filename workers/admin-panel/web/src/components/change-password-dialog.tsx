import * as React from 'react';
import { KeyRoundIcon } from 'lucide-react';
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
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, NetworkError, api } from '@/lib/api';
import { t } from '@/lib/messages';
import { LIMITS } from '@/lib/types';

/**
 * 修改自己的密码。
 *
 * 这里的防线在服务端手里（旧密码必须验对、失败计入锁定计数、其他会话被吊销），
 * 前端只提前挡两类不用出门就能发现的错：新密码太短、两遍输得不一样。长度上限
 * 交给服务端 —— 在这里截断等于悄悄改了用户的密码。
 */

interface ChangePasswordDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** 429 的 retryAfterSeconds 是秒；文案要的是分钟，与登录页同一口径。 */
const minutesFrom = (seconds: unknown): number =>
  typeof seconds === 'number' && seconds > 0 ? Math.max(1, Math.ceil(seconds / 60)) : 1;

const messageFor = (error: ApiError): string => {
  const errors = t.changePassword.errors;
  switch (error.code) {
    case 'wrong_password':
      return errors.wrong_password;
    case 'no_password':
      return errors.no_password;
    case 'locked':
      return errors.locked(minutesFrom(error.body.retryAfterSeconds));
    case 'invalid_input':
      return errors.invalid_input(LIMITS.minPasswordLength, LIMITS.maxPasswordLength);
    default:
      return errors.unknown(error.code);
  }
};

export const ChangePasswordDialog = ({ open, onOpenChange }: ChangePasswordDialogProps) => {
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      // 关闭即归位：密码框里的明文不留到下一次打开。
      setCurrent('');
      setNext('');
      setConfirm('');
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const mismatch = confirm !== '' && next !== confirm;
  const tooShort = next.length > 0 && next.length < LIMITS.minPasswordLength;
  const canSubmit = current !== '' && next !== '' && confirm !== '' && !mismatch && !tooShort;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      toast.success(t.changePassword.ok);
      onOpenChange(false);
    } catch (cause) {
      if (cause instanceof NetworkError) {
        setError(t.common.networkError);
      } else if (
        cause instanceof ApiError &&
        cause.status === 401 &&
        cause.code !== 'wrong_password'
      ) {
        // 会话过期撞上了同一状态码：文案得说的是「先去登录」而不是「密码不对」。
        setError(t.common.sessionExpired);
        onOpenChange(false);
      } else if (cause instanceof ApiError) {
        setError(messageFor(cause));
      } else {
        setError(t.changePassword.errors.unknown(t.common.unknownError));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t.changePassword.title}</DialogTitle>
          <DialogDescription>{t.changePassword.lead}</DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit && !busy) {
              void submit();
            }
          }}
        >
          <Field>
            <FieldLabel htmlFor="pw-current">{t.changePassword.current}</FieldLabel>
            <Input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              value={current}
              maxLength={LIMITS.maxPasswordLength}
              disabled={busy}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="pw-next">{t.changePassword.new}</FieldLabel>
            <Input
              id="pw-next"
              type="password"
              autoComplete="new-password"
              value={next}
              maxLength={LIMITS.maxPasswordLength}
              disabled={busy}
              aria-invalid={tooShort ? true : undefined}
              onChange={(event) => setNext(event.target.value)}
            />
            {tooShort && (
              <FieldError>
                {t.changePassword.errors.invalid_input(
                  LIMITS.minPasswordLength,
                  LIMITS.maxPasswordLength,
                )}
              </FieldError>
            )}
          </Field>

          <Field>
            <FieldLabel htmlFor="pw-confirm">{t.changePassword.confirm}</FieldLabel>
            <Input
              id="pw-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              maxLength={LIMITS.maxPasswordLength}
              disabled={busy}
              aria-invalid={mismatch ? true : undefined}
              onChange={(event) => setConfirm(event.target.value)}
            />
            {mismatch && <FieldError>{t.changePassword.mismatch}</FieldError>}
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
            <Button type="submit" disabled={busy || !canSubmit}>
              {busy ? <Spinner /> : <KeyRoundIcon />}
              {busy ? t.changePassword.pending : t.changePassword.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
