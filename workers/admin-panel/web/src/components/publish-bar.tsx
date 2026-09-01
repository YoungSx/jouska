import * as React from 'react';
import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, UploadIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { PublishGate } from '@/hooks/use-draft';
import { t } from '@/lib/messages';
import { cn } from '@/lib/utils';

/**
 * 常驻发布栏 —— 这个面板的论点本身。
 *
 * 它永远在屏幕底部，永远回答同一个问题：线上正在服务哪一版，草稿差了多少。
 * 之所以常驻而不是只出现在发布页：「保存不等于上线」这件事只有在改动发生的那个
 * 屏幕上说出来才有用，事后到另一个页面才提醒等于没提醒。
 *
 * 四种状态各自的措辞在 messages.ts 里，因为它们必须彼此一致 —— 「一致 / 待发布 /
 * 有错 / 空」这四个词是操作者判断能不能下班的依据。
 */

interface PublishBarProps {
  readonly gate: PublishGate;
  readonly canPublish: boolean;
  readonly publishing: boolean;
  readonly onPublish: () => void;
  readonly onReview: () => void;
}

interface BarFace {
  readonly icon: typeof CircleCheckIcon;
  readonly tone: 'neutral' | 'pending' | 'bad';
  readonly headline: string;
  readonly detail: string;
  /** 发布按钮是否有意义 —— 没东西可发或发不出去时它不该是可点的。 */
  readonly actionable: boolean;
}

const faceFor = (gate: PublishGate): BarFace => {
  switch (gate.kind) {
    case 'loading':
      return {
        icon: CircleDashedIcon,
        tone: 'neutral',
        headline: t.common.loading,
        detail: '',
        actionable: false,
      };
    case 'clean':
      return {
        icon: CircleCheckIcon,
        tone: 'neutral',
        headline: t.publishBar.clean,
        detail: t.publishBar.cleanDetail(gate.live),
        actionable: false,
      };
    case 'empty':
      return {
        icon: CircleDashedIcon,
        tone: 'neutral',
        headline: t.publishBar.empty,
        detail: t.publishBar.emptyDetail,
        actionable: false,
      };
    case 'blocked':
      return {
        icon: CircleAlertIcon,
        tone: 'bad',
        headline: t.publishBar.blocked,
        detail: t.publishBar.blockedDetail,
        actionable: false,
      };
    case 'dirty': {
      // 从未发布过与「改了 N 项」是两句不同的话：前者说明反代现在不代理任何流量。
      if (gate.live === null) {
        return {
          icon: CircleAlertIcon,
          tone: 'pending',
          headline: t.publishBar.neverPublished,
          detail: t.publishBar.neverPublishedDetail,
          actionable: true,
        };
      }
      return {
        icon: CircleAlertIcon,
        tone: 'pending',
        headline: t.publishBar.dirty,
        detail: t.publishBar.dirtyDetail(gate.preview.routeCount ?? 0),
        actionable: true,
      };
    }
    case 'error':
      return {
        icon: CircleAlertIcon,
        tone: 'bad',
        headline: t.preview.loadFailed(gate.code),
        detail: '',
        actionable: false,
      };
  }
};

export const PublishBar = ({
  gate,
  canPublish,
  publishing,
  onPublish,
  onReview,
}: PublishBarProps) => {
  const face = faceFor(gate);
  const Icon = face.icon;
  const live = gate.kind === 'error' || gate.kind === 'loading' ? null : gate.live;

  /* 落位动画只属于「闸门移动」，首次挂载不播：bump 从 0 起、effect 跳过首跑，
     动画类只在 bump > 0 时挂上。每次翻转 key 变化重放一次。 */
  const [bump, setBump] = React.useState(0);
  const prevKind = React.useRef(gate.kind);
  React.useEffect(() => {
    if (prevKind.current === gate.kind) return;
    prevKind.current = gate.kind;
    setBump((n) => n + 1);
  }, [gate.kind]);

  return (
    <div
      // sticky 而非 fixed：fixed 会盖住页面最后一行内容，而这个面板的最后一行
      // 常常正是刚改的那条路由。
      className="bg-background/95 sticky bottom-0 z-20 border-t backdrop-blur"
      // 状态变化要被读屏软件念出来 —— 发布栏是操作者判断改动是否上线的唯一依据。
      role="status"
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
        {/* key = 翻转序号：每次闸门移动重挂图标、重放落位动画；挂载时序号为 0，
            无动画类，页面加载不抖。 */}
        <Icon
          key={bump}
          className={cn(
            'size-4 shrink-0',
            bump > 0 && 'gate-icon',
            face.tone === 'bad' && 'text-destructive',
            face.tone === 'pending' && 'text-foreground',
            face.tone === 'neutral' && 'text-muted-foreground',
          )}
          aria-hidden
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{face.headline}</span>
            {live !== null && gate.kind !== 'clean' && (
              <Badge variant="outline" className="tabular">
                {t.publishBar.liveRevision(live)}
              </Badge>
            )}
          </div>
          {face.detail !== '' && (
            <p className="text-muted-foreground mt-0.5 text-xs">{face.detail}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {(gate.kind === 'dirty' || gate.kind === 'blocked') && (
            <Button variant="ghost" size="sm" onClick={onReview}>
              {gate.kind === 'blocked' ? t.publishBar.seeIssues : t.publishBar.review}
            </Button>
          )}
          <Button
            size="sm"
            onClick={onPublish}
            disabled={!face.actionable || !canPublish || publishing}
            // 观察者看得见这颗按钮但按不动，并且知道为什么 —— 藏起来只会让人以为
            // 面板坏了。
            title={canPublish ? undefined : t.publish.forbidden}
          >
            {publishing ? <Spinner /> : <UploadIcon />}
            {publishing ? t.publishBar.publishing : t.publishBar.publish}
          </Button>
        </div>
      </div>
    </div>
  );
};
