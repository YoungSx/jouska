import { PlusIcon, RefreshCwIcon, RouteIcon, TriangleAlertIcon, UploadIcon } from 'lucide-react';
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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import type { PreviewResult } from '@/lib/api';
import { t } from '@/lib/messages';
import { DANGER_REASONS, type FieldRisk, type Issue } from '@/lib/types';

/**
 * 发布预览。
 *
 * 这个页面的职责只有一件：把「按下发布之后会发生什么」全部摊开 —— 会上线几条路
 * 由、哪些危险开关需要亲手认一次、哪些路由被前面的收走了流量、最终写进 KV 的
 * JSON 长什么样。预览本身不写任何东西（preview.description 说的就是这个），所以
 * 这里的每个块都是只读的；唯一两个动作是重新检查和打开发布弹窗。
 */

interface PreviewViewProps {
  readonly preview: PreviewResult | null;
  readonly loading: boolean;
  readonly isAdmin: boolean;
  /**
   * 线上正在服务的 revision；仅当闸门处于 clean 态（草稿与线上一致）时非空。
   * App 从 gate.kind 推导后传下来 —— 指纹比对的判定在 use-draft 里只算一次，
   * 这里不重算。用 `number | null` 而不是布尔值：非 null 本身就是「已上线」
   * 的证明，headline 和按钮说明都从它取数，不存在「clean 为真却拿不到
   * revision」的分支可写。
   */
  readonly liveRevision: number | null;
  /** 触发草稿重新检查（useDraft 的 recheck，不重拉路由表）。 */
  readonly onRefresh: () => void;
  /** 打开发布弹窗；发布本身在弹窗里完成，这里不直接调 api.publish。 */
  readonly onPublish: () => void;
  /** 空草稿时引导去路由页 —— 空是「还没开始」，不是「配置有错」。 */
  readonly onGoRoutes: () => void;
}

/** 服务端的 reason 是英文；DANGER_REASONS 是面板自己的说法（types.ts 注明了这一点），优先用它。 */
const reasonOf = (risk: FieldRisk): string => DANGER_REASONS[risk.path] ?? risk.reason;

/**
 * 一条校验问题的定位。
 *
 * 「(root)」是调用方约定的哨兵：这个错不归属任何一条路由。服务端对 defaults /
 * 路由表级别的错会送出 routeId === undefined，此时只能原样展示它的 path ——
 * 编一个路由名出来就是把定位信息做假。
 */
const issueLabel = (issue: Issue): string => {
  if (issue.path === '(root)') {
    return t.preview.issueTable;
  }
  if (issue.routeId === undefined) {
    return issue.path;
  }
  return t.preview.issueAt(issue.routeId, issue.path);
};

const SectionHeader = ({ title, hint }: { readonly title: string; readonly hint: string }) => (
  <div>
    <h3 className="text-sm font-medium">{title}</h3>
    <p className="text-muted-foreground text-xs">{hint}</p>
  </div>
);

const PreviewSkeleton = () => (
  // 形状对齐正常内容：一行摘要、两个大块、一个矮块，加载完不会跳版。
  <div className="flex flex-col gap-3" aria-hidden>
    <Skeleton className="h-4 w-40" />
    <Skeleton className="h-20 w-full" />
    <Skeleton className="h-20 w-full" />
    <Skeleton className="h-10 w-full" />
  </div>
);

/**
 * 预览拉取失败的分支。
 *
 * 注意：NetworkError 与 401 的区分发生在调用方（App 层的离线页 / 登录页），
 * 走到这里说明是 gate 级的服务端错误，错误码没有随 preview 传进来，所以只能
 * 给出诚实的兜底文案，不能假装知道是哪种失败。
 */
const LoadFailed = ({ onRetry }: { readonly onRetry: () => void }) => (
  <div className="flex flex-col items-start gap-3">
    <p className="text-destructive text-sm">{t.preview.loadFailed(t.common.unknownError)}</p>
    <Button variant="outline" onClick={onRetry}>
      <RefreshCwIcon />
      {t.common.retry}
    </Button>
  </div>
);

const PreviewEmpty = ({ onGoRoutes }: { readonly onGoRoutes: () => void }) => (
  <Empty>
    <EmptyHeader>
      <EmptyMedia variant="icon">
        <RouteIcon />
      </EmptyMedia>
      <EmptyTitle>{t.preview.empty.title}</EmptyTitle>
      <EmptyDescription>{t.preview.empty.description}</EmptyDescription>
    </EmptyHeader>
    <EmptyContent>
      {/* 观察者也能点：只是跳页，路由页自己会说清「需要管理员才能新建」。 */}
      <Button onClick={onGoRoutes}>
        <PlusIcon />
        {t.preview.empty.action}
      </Button>
    </EmptyContent>
  </Empty>
);

const IssueList = ({ issues }: { readonly issues: readonly Issue[] }) => (
  <ul className="mt-2 flex flex-col gap-1.5">
    {issues.map((issue, index) => (
      // 服务端的 issue 没有稳定 ID；这是一份静态列表，下标做 key 足够。
      <li key={index}>
        <code className="font-mono text-xs">{issueLabel(issue)}</code>
        <span className="ml-2 text-xs">{issue.message}</span>
      </li>
    ))}
  </ul>
);

/** blocked 分支：校验用的一定是线上同一份 schema，这里报什么线上就是什么。 */
const IssueAlert = ({ issues }: { readonly issues: readonly Issue[] }) => (
  <Alert variant="destructive">
    <TriangleAlertIcon />
    <AlertTitle>{t.preview.issuesTitle}</AlertTitle>
    <AlertDescription>
      {t.preview.issuesHint}
      <IssueList issues={issues} />
    </AlertDescription>
  </Alert>
);

const DangerCard = ({
  routeId,
  risks,
}: {
  readonly routeId: string;
  readonly risks: readonly FieldRisk[];
}) => (
  // danger-surface 标出「要亲手确认一次」的区域，不是装饰 —— 与发布弹窗里的
  // 危险清单同一底色，操作者能把两处对上。
  <div className="danger-surface flex flex-col gap-2 rounded-lg border p-3">
    <p className="font-mono text-xs font-medium">{routeId}</p>
    <ul className="flex flex-col gap-2">
      {risks.map((risk) => (
        <li key={risk.path} className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-xs">{risk.path}</code>
            <Badge variant={risk.level === 'high' ? 'destructive' : 'secondary'}>
              {risk.level === 'high' ? t.preview.dangerHigh : t.preview.dangerMedium}
            </Badge>
          </div>
          <p className="text-muted-foreground text-xs">{reasonOf(risk)}</p>
        </li>
      ))}
    </ul>
  </div>
);

const DocumentDetails = ({ doc }: { readonly doc: unknown }) => (
  <details className="rounded-lg border p-3">
    <summary className="cursor-pointer text-sm font-medium select-none">
      {t.preview.documentTitle}
    </summary>
    <p className="text-muted-foreground mt-1 text-xs">{t.preview.documentHint}</p>
    {/* 反代热路径读的就是这份 JSON，逐字符可核对，所以要等宽与横向滚动。 */}
    <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
      {JSON.stringify(doc, null, 2)}
    </pre>
  </details>
);

const PreviewOk = ({
  preview,
  liveRevision,
}: {
  readonly preview: PreviewResult;
  readonly liveRevision: number | null;
}) => {
  const dangers = Object.entries(preview.dangers ?? {});
  const shadowWarnings = preview.shadowWarnings ?? [];
  const mirrorWarnings = preview.mirrorWarnings ?? [];
  // ok 的响应按契约不该带 issues；带着就照实列出来，而不是静默吞掉。
  const issues = preview.issues ?? [];
  const routeCount = preview.routeCount ?? 0;

  return (
    <div className="flex flex-col gap-6">
      {/* 同一份文档的两种命运：liveRevision 非空是「已经在跑」，空是「还没上
          去」。clean 蕴含 live !== null，非空分支的取值由类型保证。 */}
      {liveRevision !== null ? (
        <p className="text-sm font-medium">{t.preview.routeCountLive(routeCount, liveRevision)}</p>
      ) : (
        <p className="text-sm font-medium">{t.preview.routeCount(routeCount)}</p>
      )}

      {dangers.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionHeader title={t.preview.dangerTitle} hint={t.preview.dangerHint} />
          {dangers.map(([routeId, risks]) => (
            <DangerCard key={routeId} routeId={routeId} risks={risks} />
          ))}
        </section>
      )}

      {shadowWarnings.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionHeader title={t.preview.shadowTitle} hint={t.preview.shadowHint} />
          <ul className="flex flex-col gap-2">
            {shadowWarnings.map((warning) => (
              <li key={`${warning.shadowedId}-${warning.byId}`} className="flex flex-col gap-0.5">
                <p className="text-sm">{t.preview.shadowLine(warning.shadowedId, warning.byId)}</p>
                <p className="text-muted-foreground font-mono text-xs">
                  {t.preview.shadowProbe(warning.probe)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/*
        整站代理没开改写。放在遮蔽之后：遮蔽是「这条路由根本不跑」，这里是「路由在
        跑，但访客一点链接就走了」—— 后者按下发布仍然合法，所以只提示，不拦。
      */}
      {mirrorWarnings.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionHeader title={t.preview.mirrorTitle} hint={t.preview.mirrorHint} />
          <ul className="flex flex-col gap-2">
            {mirrorWarnings.map((warning) => (
              <li key={warning.routeId}>
                <p className="text-sm">{t.preview.mirrorLine(warning.routeId, warning.upstream)}</p>
              </li>
            ))}
          </ul>
          {/* 文案如实：开了也有覆盖不到的地方，别让提示变成一句承诺。 */}
          <p className="text-muted-foreground text-xs">{t.preview.mirrorScope}</p>
        </section>
      )}

      {issues.length > 0 && (
        <section className="flex flex-col gap-2">
          <SectionHeader title={t.preview.issuesTitle} hint={t.preview.issuesHint} />
          <IssueList issues={issues} />
        </section>
      )}

      {preview.document !== undefined && <DocumentDetails doc={preview.document} />}
    </div>
  );
};

export const PreviewView = ({
  preview,
  loading,
  isAdmin,
  liveRevision,
  onRefresh,
  onPublish,
  onGoRoutes,
}: PreviewViewProps) => {
  const body = (() => {
    if (loading && preview === null) {
      return <PreviewSkeleton />;
    }
    if (preview === null) {
      return <LoadFailed onRetry={onRefresh} />;
    }
    if (preview.empty === true) {
      return <PreviewEmpty onGoRoutes={onGoRoutes} />;
    }
    if (preview.ok) {
      return <PreviewOk preview={preview} liveRevision={liveRevision} />;
    }
    return <IssueAlert issues={preview.issues ?? []} />;
  })();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.preview.title}</CardTitle>
        <CardDescription>{t.preview.description}</CardDescription>
        <CardAction className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
            {loading ? <Spinner /> : <RefreshCwIcon />}
            {loading ? t.preview.refreshing : t.preview.refresh}
          </Button>
          {preview !== null && preview.ok && preview.empty !== true && (
            <Button
              size="sm"
              onClick={onPublish}
              // clean 态没有可发布的东西：放行会原样多写一个 revision，白烧一次
              // KV 写额度。按钮留着（配 title 说明），和观察者的处理方式一致。
              // title 的优先级：先解释角色门槛（对所有页一致的禁用理由），再
              // 解释内容门槛——观察者在 clean 态看到的仍是「需要管理员」。
              disabled={!isAdmin || liveRevision !== null}
              title={
                !isAdmin
                  ? t.publish.forbidden
                  : liveRevision !== null
                    ? t.preview.alreadyLive
                    : undefined
              }
            >
              <UploadIcon />
              {t.publishBar.publish}
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
};
