import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { MeResult } from '@/lib/api';
import { t } from '@/lib/messages';

/**
 * 「进不来」的那一屏，两种原因，两句不同的话。
 *
 * 这个面板已经没有登录表单了 —— Cloudflare Access 在 Worker 跑起来之前就把人认完
 * 了，能改变现状的动作全都不在这一页上。所以这里的每条路径都必须指向别处：要么是
 * 别人的账号（管理员把地址加进来），要么是别处的配置（把 Access 应用接上）。给一
 * 张表单反而是最坏的选择，因为它一定失败。
 */

interface AuthViewProps {
  readonly me: MeResult | null;
  readonly loading: boolean;
}

export const AuthView = ({ me, loading }: AuthViewProps) => {
  // Access 已经放人进来了，只是 users 表里没有这个地址。
  if (me?.accessEmail !== undefined) {
    return (
      <div className="mx-auto w-full max-w-sm px-4 py-16">
        <AccessPendingCard email={me.accessEmail} />
      </div>
    );
  }

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

  // 连 Access 身份都没有：要么这个部署还没接上 Access 应用，要么请求绕过了它
  // （比如直连 workers.dev 而策略没覆盖到）。两种都只有配置能修。
  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>{t.accessRequired.title}</CardTitle>
          <CardDescription>{t.accessRequired.lead}</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertTitle>{t.accessRequired.hint}</AlertTitle>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
};

/**
 * 「Access 认了你，面板还不认你」的终点页。
 *
 * 刻意没有表单：唯一能改变这个状态的动作发生在别人的账号里。刷新按钮是为了
 * 管理员加完之后不用解释「关掉标签页再打开」。
 */
const AccessPendingCard = ({ email }: { readonly email: string }) => (
  <Card>
    <CardHeader>
      <CardTitle>{t.accessPending.title}</CardTitle>
      <CardDescription>{t.accessPending.lead(email)}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      <Alert>
        <AlertTitle>{t.accessPending.hint}</AlertTitle>
      </Alert>
      <Button
        variant="outline"
        onClick={() => {
          globalThis.location.reload();
        }}
      >
        {t.accessPending.refresh}
      </Button>
    </CardContent>
  </Card>
);
