import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { MeResult } from '@/lib/api';
import { t } from '@/lib/messages';

/**
 * 「进不来」的那一屏，三种原因，三句不同的话。
 *
 * 这个面板已经没有登录表单了 —— Cloudflare Access 在 Worker 跑起来之前就把人认完
 * 了，能改变现状的动作全都不在这一页上。所以这里的每条路径都必须指向别处：要么是
 * 别人的账号（管理员把地址加进来），要么是部署配置（把 Access 接上）。
 *
 * 「门没接上」那张卡是给部署者看的，说得出下一步；另外两张卡可能被任何扫到这个
 * 域名的陌生人看到，所以只说这个面板要什么，不解释内部如何接线。
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

  // 服务端明说了：这次部署还没接 Access。这页多半正开在部署者的浏览器里，
  // 给出接线步骤是唯一能改变现状的动作。
  if (me?.identityNotConfigured === true) {
    return (
      <div className="mx-auto w-full max-w-sm px-4 py-16">
        <AccessSetupCard />
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

  // 接了线，但这条请求没有 Access 身份：可能是被绕过的路径，也可能是陌生人。
  // 一句「这个面板要什么」就是全部 —— 内部怎么接线的细节不在这里。
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

/**
 * 「这个部署压根没接 Access」的接线卡。
 *
 * 受众是部署者本人：卡片能改变现状（照步骤接线），所以步骤写全。接上之后这页
 * 就到头了 —— 过门的人由 Cloudflare 登录页接管，这张卡不会再见到。
 */
const AccessSetupCard = () => (
  <Card>
    <CardHeader>
      <CardTitle>{t.accessSetup.title}</CardTitle>
      <CardDescription>{t.accessSetup.lead}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {t.accessSetup.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <Alert>
        <AlertTitle>{t.accessSetup.hint}</AlertTitle>
      </Alert>
    </CardContent>
  </Card>
);
