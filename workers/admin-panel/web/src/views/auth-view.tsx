import * as React from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ApiError, NetworkError, api, type MeResult } from '@/lib/api';
import { t } from '@/lib/messages';
import { AUTH_POLICY, LIMITS } from '@/lib/types';

/**
 * 登录 / 首次部署 / 带外恢复。
 *
 * 三个表单共用一个入口，因为它们是同一条时间线上的三种状态：库里没人 → 建号；
 * 有人但进不去 → 恢复令牌。服务端对恢复刻意只回答一个错误码，所以这里的失败
 * 文案只复述、不推断 —— 替服务端猜就把它刻意隐藏的信息泄回去了。
 */

interface AuthViewProps {
  readonly me: MeResult | null;
  readonly loading: boolean;
  readonly onSignedIn: () => void;
}

type AuthMode = 'login' | 'bootstrap';

/** 登录表单错误的展示形状：锁定态还要在下面补一行策略小字。 */
interface AuthFormError {
  readonly text: string;
  readonly locked: boolean;
}

/**
 * 服务端错误体里的 `detail` 是写给人看的补充说明，优先于错误码本身 ——
 * 对没有专属文案的未知码，一句服务端的原话比裸码更有用。
 */
const errorDetail = (error: ApiError): string => {
  const detail = error.body.detail;
  return typeof detail === 'string' && detail !== '' ? detail : error.message;
};

/** 服务端错误码 → 文案。码没覆盖到的走 unknown，不猜。 */
const loginErrorOf = (error: unknown): AuthFormError => {
  if (error instanceof NetworkError) {
    return { text: t.common.networkError, locked: false };
  }
  if (!(error instanceof ApiError)) {
    return { text: t.auth.errors.unknown(t.common.unknownError), locked: false };
  }
  switch (error.code) {
    case 'invalid_credentials':
      return { text: t.auth.errors.invalid_credentials, locked: false };
    case 'locked': {
      // 服务端给的是秒；文案要分钟。向上取整，避免「0 分钟后再试」。
      const seconds = error.body.retryAfterSeconds;
      const minutes =
        typeof seconds === 'number'
          ? Math.max(1, Math.ceil(seconds / 60))
          : AUTH_POLICY.lockoutMinutes;
      return { text: t.auth.errors.locked(minutes), locked: true };
    }
    case 'account_disabled':
      return { text: t.auth.errors.account_disabled, locked: false };
    case 'already_bootstrapped':
      return { text: t.auth.errors.already_bootstrapped, locked: false };
    case 'invalid_input':
      return { text: t.auth.errors.invalid_input(LIMITS.minPasswordLength), locked: false };
    case 'missing_origin':
    case 'cross_origin':
      return { text: t.auth.errors.missing_origin, locked: false };
    default:
      return { text: t.auth.errors.unknown(errorDetail(error)), locked: false };
  }
};

/** 恢复失败 → 文案。recovery_unavailable 必须全文照搬，四种可能一个都不能少。 */
const recoverErrorText = (error: unknown): string => {
  if (error instanceof NetworkError) {
    return t.common.networkError;
  }
  if (error instanceof ApiError) {
    if (error.code === 'recovery_unavailable') {
      return t.recover.errors.recovery_unavailable;
    }
    if (error.code === 'invalid_input') {
      return t.recover.errors.invalid_input(LIMITS.minPasswordLength);
    }
    return t.recover.errors.unknown(errorDetail(error));
  }
  return t.recover.errors.unknown(t.common.unknownError);
};

/**
 * 示例 SQL 是教学示意：占位用文案里的占位词标注，字段含义用注释写清。
 * 注释也是界面文案，所以同样取自 messages —— 未来加语言时这里不用改。
 */
const SQL_EXAMPLE = [
  `-- ${t.recover.sqlNote}`,
  'INSERT INTO settings (key, value) VALUES (',
  "  'recover',",
  `  '{ "token": "<${t.recover.sqlPlaceholderToken}>", "subject": "<${t.recover.sqlPlaceholderSubject}>", "expiresAt": 1735689600000 }'`,
  ');',
  t.recover.sqlTokenNote(t.recover.token, t.recover.tokenHint),
  `-- ${t.recover.subject}`,
  `-- ${t.recover.sqlExpiresAtNote}`,
].join('\n');

export const AuthView = ({ me, loading, onSignedIn }: AuthViewProps) => {
  // null = 用户还没选过形态；此时默认形态跟着服务端状态走（首次部署就先引导建号）。
  const [chosen, setChosen] = React.useState<AuthMode | null>(null);
  const [recoverOpen, setRecoverOpen] = React.useState(false);
  const bootstrapable = me?.bootstrapable === true;
  const mode: AuthMode = chosen ?? (bootstrapable ? 'bootstrap' : 'login');

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-sm px-4 py-16" aria-hidden>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16">
      <AuthCard
        mode={mode}
        bootstrapable={bootstrapable}
        onMode={setChosen}
        onSignedIn={onSignedIn}
      />

      {/* 已登录的人由调用方接管；恢复只对「有账号但进不去」的人有意义。 */}
      {mode === 'login' && (
        <div className="mt-3 flex flex-col items-center">
          <Button
            variant="link"
            size="sm"
            aria-expanded={recoverOpen}
            onClick={() => {
              setRecoverOpen((open) => !open);
            }}
          >
            {t.recover.toggle}
          </Button>
        </div>
      )}

      {mode === 'login' && recoverOpen && <RecoverCard onSignedIn={onSignedIn} />}
    </div>
  );
};

interface AuthCardProps {
  readonly mode: AuthMode;
  readonly bootstrapable: boolean;
  readonly onMode: (mode: AuthMode) => void;
  readonly onSignedIn: () => void;
}

const AuthCard = ({ mode, bootstrapable, onMode, onSignedIn }: AuthCardProps) => {
  const [subject, setSubject] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<AuthFormError | null>(null);

  // 形态切换时旧错误不再成立（比如 already_bootstrapped 只属于登录态）。
  React.useEffect(() => {
    setError(null);
  }, [mode]);

  const submit = (kind: 'login' | 'bootstrap') => {
    setPending(true);
    setError(null);
    void (async () => {
      try {
        if (kind === 'bootstrap') {
          await api.bootstrap(subject, password);
          // toast 必须在 onSignedIn 之前发：回调会让调用方卸掉这个入口。
          toast.success(t.auth.bootstrapOk);
        } else {
          await api.login(subject, password);
        }
        onSignedIn();
      } catch (cause) {
        setError(loginErrorOf(cause));
      } finally {
        setPending(false);
      }
    })();
  };

  const bootstrapping = mode === 'bootstrap' && bootstrapable;
  const busy = pending !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{bootstrapping ? t.auth.bootstrapTitle : t.auth.loginTitle}</CardTitle>
        {bootstrapping && <CardDescription>{t.auth.bootstrapLead}</CardDescription>}
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit(bootstrapping ? 'bootstrap' : 'login');
          }}
        >
          {error !== null && (
            <Alert variant="destructive">
              <AlertTitle>{error.text}</AlertTitle>
              {error.locked && (
                <AlertDescription>
                  {t.auth.lockoutNote(AUTH_POLICY.maxFailedAttempts, AUTH_POLICY.lockoutMinutes)}
                </AlertDescription>
              )}
            </Alert>
          )}

          <Field>
            <FieldLabel htmlFor="auth-subject">{t.auth.subject}</FieldLabel>
            <Input
              id="auth-subject"
              name="subject"
              autoComplete="username"
              value={subject}
              disabled={busy}
              onChange={(event) => {
                setSubject(event.target.value);
                setError(null);
              }}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="auth-password">{t.auth.password}</FieldLabel>
            <Input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={bootstrapping ? 'new-password' : 'current-password'}
              value={password}
              disabled={busy}
              onChange={(event) => {
                setPassword(event.target.value);
                setError(null);
              }}
            />
            <FieldDescription>{t.auth.passwordHint(LIMITS.minPasswordLength)}</FieldDescription>
          </Field>

          <Button type="submit" disabled={busy}>
            {busy ? <Spinner /> : null}
            {busy
              ? bootstrapping
                ? t.auth.bootstrapPending
                : t.auth.loginPending
              : bootstrapping
                ? t.auth.bootstrapAction
                : t.auth.loginAction}
          </Button>
        </form>

        {bootstrapable && (
          <>
            <Separator className="my-4" />
            <div className="flex justify-center">
              <Button
                variant="link"
                size="sm"
                onClick={() => {
                  onMode(bootstrapping ? 'login' : 'bootstrap');
                }}
              >
                {bootstrapping ? t.auth.toLogin : t.auth.toBootstrap}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
};

const RecoverCard = ({ onSignedIn }: { readonly onSignedIn: () => void }) => {
  const [subject, setSubject] = React.useState('');
  const [token, setToken] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = () => {
    setPending(true);
    setError(null);
    void (async () => {
      try {
        await api.recover(subject, token, newPassword);
        toast.success(t.recover.ok);
        onSignedIn();
      } catch (cause) {
        setError(recoverErrorText(cause));
      } finally {
        setPending(false);
      }
    })();
  };

  return (
    <Card className="mt-3">
      <CardHeader>
        <CardTitle>{t.recover.title}</CardTitle>
        <CardDescription>{t.recover.lead}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {error !== null && (
            <Alert variant="destructive">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          )}

          <details className="group rounded-md border">
            <summary className="hover:bg-muted/50 flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-sm font-medium">
              <ChevronRightIcon className="transition-transform group-open:rotate-90" />
              {t.recover.howToTitle}
            </summary>
            <div className="text-muted-foreground flex flex-col gap-2 border-t px-3 py-3 text-sm">
              <p>{t.recover.howToLead}</p>
              <p>{t.recover.howToCi}</p>
              <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs leading-relaxed text-foreground">
                <code>{SQL_EXAMPLE}</code>
              </pre>
            </div>
          </details>

          <Field>
            <FieldLabel htmlFor="recover-subject">{t.recover.subject}</FieldLabel>
            <Input
              id="recover-subject"
              name="subject"
              autoComplete="username"
              value={subject}
              disabled={pending}
              onChange={(event) => {
                setSubject(event.target.value);
                setError(null);
              }}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="recover-token">{t.recover.token}</FieldLabel>
            <Input
              id="recover-token"
              name="token"
              className="font-mono"
              spellCheck={false}
              value={token}
              disabled={pending}
              onChange={(event) => {
                setToken(event.target.value);
                setError(null);
              }}
            />
            <FieldDescription>{t.recover.tokenHint}</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="recover-password">{t.recover.newPassword}</FieldLabel>
            <Input
              id="recover-password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              disabled={pending}
              onChange={(event) => {
                setNewPassword(event.target.value);
                setError(null);
              }}
            />
          </Field>

          <Button type="submit" disabled={pending}>
            {pending ? <Spinner /> : null}
            {pending ? t.recover.pending : t.recover.submit}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};
