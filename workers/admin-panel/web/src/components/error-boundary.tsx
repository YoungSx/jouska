import * as React from 'react';
import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { t } from '@/lib/messages';

/**
 * 渲染期异常的兜底。
 *
 * 为什么必须有：React 对没人接住的渲染异常只有一种处理方式 —— 卸载整棵树。于是
 * `#root` 变空，页面上只剩深色的 body，看起来就是一片纯黑（这条路真的走过一次：
 * DropdownMenuLabel 放在 DropdownMenuGroup 外面，点一下账号菜单整个面板消失，
 * 连退出登录都点不到）。一个组件的 a11y 结构写错，代价不该是操作者失去对生产配
 * 置的全部可见性。
 *
 * 分两层是有意的：
 *   - RootErrorBoundary 兜外壳，任何东西崩了至少有一句话和一个「重新加载」。
 *   - ViewErrorBoundary 只兜 <main> 里的视图，头部与发布栏留在 boundary 外面，
 *     所以「某一页崩了」不等于「退出登录点不到」。
 *
 * error boundary 至今只能用 class 组件实现（React 19 依然如此）—— 这是这个仓库里
 * 唯一的 class 组件，不是遗留写法。
 */

interface ErrorBoundaryProps {
  readonly children: React.ReactNode;
  /** 兜底 UI。`reset` 清掉错误状态、重新挂载 children。 */
  readonly fallback: (error: Error, reset: () => void) => React.ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    // throw 的不一定是 Error（Base UI 抛的是 Error，但第三方代码什么都可能抛）。
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // 面板没有前端错误上报通道，控制台就是唯一的现场。组件栈必须一起打出来：
    // 生产构建里 error.stack 全是 mangle 过的名字，只有组件栈还能读。
    console.error('[jouska] 界面渲染异常：', error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): React.ReactNode {
    const { error } = this.state;
    return error === null ? this.props.children : this.props.fallback(error, this.reset);
  }
}

/** 两层兜底共用的那张卡片：说清坏了什么、给一个出路、附上能贴进 issue 的原文。 */
const CrashCard = ({
  title,
  lead,
  actionLabel,
  onAction,
  error,
}: {
  readonly title: string;
  readonly lead: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
  readonly error: Error;
}) => (
  // 「崩了」不是「空的」：实线边框 + card 底色，让它明确是一张卡片。Empty 默认那圈
  // 虚线是给「还没开始」用的，摆在全屏纯黑上会让人以为界面只是没加载完。
  // flex-none 也是必需的：Empty 自带 flex-1，放进 RootErrorBoundary 那个 min-h-dvh
  // 的纵向 flex 容器里会被拉成一个整屏高的空盒子。
  <Empty className="mx-auto max-w-lg flex-none border border-solid bg-card">
    <EmptyHeader>
      <EmptyMedia variant="icon">
        <TriangleAlertIcon />
      </EmptyMedia>
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{lead}</EmptyDescription>
    </EmptyHeader>
    <EmptyContent>
      <Button onClick={onAction}>
        <RefreshCwIcon />
        {actionLabel}
      </Button>
    </EmptyContent>
    {/* 原生 details：折叠、键盘可达、读屏可用，一行组件都不用写。默认收起，
        因为堆栈对绝大多数人是噪音；但它必须能拿到，否则报 bug 只能靠描述。 */}
    <details className="w-full text-left">
      <summary className="cursor-default text-xs text-muted-foreground">{t.crash.details}</summary>
      <p className="mt-2 text-xs text-muted-foreground">{t.crash.detailsHint}</p>
      <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-muted p-2.5 font-mono text-xs whitespace-pre-wrap">
        {error.stack ?? `${error.name}: ${error.message}`}
      </pre>
    </details>
  </Empty>
);

/**
 * 最外一层。放在 ThemeProvider 外面，所以连 ThemeProvider 自己崩了也还有话说 ——
 * 代价是这里不能用 useTheme，配色只能靠 index.html 写死在 <html> 上的那个 class。
 */
export const RootErrorBoundary = ({ children }: { readonly children: React.ReactNode }) => (
  <ErrorBoundary
    fallback={(error) => (
      <div className="flex min-h-dvh flex-col items-center justify-center p-6">
        <CrashCard
          title={t.crash.title}
          lead={t.crash.lead}
          actionLabel={t.crash.reload}
          // 重挂载救不了外壳级的崩溃（状态从哪来的还在那），整页重载才是诚实的出路。
          onAction={() => window.location.reload()}
          error={error}
        />
      </div>
    )}
  >
    {children}
  </ErrorBoundary>
);

/**
 * 视图层。用在 <main> 里面，头部和发布栏留在外面。
 *
 * 调用方必须给 `key={view}`：error boundary 不会自己复位，换页时靠 key 变化重建
 * 整个 boundary，否则崩过一次的内容区会一直停在错误卡片上。
 */
export const ViewErrorBoundary = ({ children }: { readonly children: React.ReactNode }) => (
  <ErrorBoundary
    fallback={(error, reset) => (
      <CrashCard
        title={t.crash.viewTitle}
        lead={t.crash.viewLead}
        actionLabel={t.crash.retry}
        onAction={reset}
        error={error}
      />
    )}
  >
    {children}
  </ErrorBoundary>
);
