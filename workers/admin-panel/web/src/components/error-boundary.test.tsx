import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootErrorBoundary, ViewErrorBoundary } from './error-boundary';

/**
 * 渲染期异常的兜底。
 *
 * 这里要证的不是「能显示一张卡片」，而是**抛完异常之后 DOM 里还有东西**——没有这
 * 一层时 React 的行为是卸载整棵树，留下一个空的 `#root`，在面板上看就是一片纯黑。
 */

const Boom = ({ live }: { readonly live: boolean }) => {
  if (!live) {
    throw new Error('boom: 上游炸了');
  }
  return <p>视图内容</p>;
};

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React 捕获异常后自己会往 console.error 打一屏。静音它，顺带验我们真的记了日志。
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('没有异常时原样透传 children', () => {
    render(
      <ViewErrorBoundary>
        <Boom live />
      </ViewErrorBoundary>,
    );

    expect(screen.getByText('视图内容')).toBeInTheDocument();
  });

  it('视图抛异常时给出错误卡片，而不是空 DOM', () => {
    const { container } = render(
      <ViewErrorBoundary>
        <Boom live={false} />
      </ViewErrorBoundary>,
    );

    expect(screen.getByText('这一页崩了')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试这一页' })).toBeInTheDocument();
    // 兜底页也报构建：崩掉的是本页 JS,版本串帮人把「哪个构建在崩」说进 issue。
    // 不传 serverBuild——服务端没问题,也没人替它答话。
    expect(screen.getByText(/本页 dev/)).toBeInTheDocument();
    expect(container).not.toBeEmptyDOMElement();
  });

  it('原始异常进得了技术细节——报 bug 时有东西可贴', () => {
    render(
      <ViewErrorBoundary>
        <Boom live={false} />
      </ViewErrorBoundary>,
    );

    expect(screen.getByText(/boom: 上游炸了/)).toBeInTheDocument();
  });

  it('异常和组件栈落进控制台（面板没有别的上报通道）', () => {
    render(
      <ViewErrorBoundary>
        <Boom live={false} />
      </ViewErrorBoundary>,
    );

    const logged = vi
      .mocked(console.error)
      .mock.calls.some((call) => call[0] === '[jouska] 界面渲染异常：' && call[1] instanceof Error);
    expect(logged).toBe(true);
  });

  it('重试会重新挂载 children', async () => {
    const user = userEvent.setup();
    // 第一次渲染抛，重试时组件已经能正常返回——模拟「刚才那下是偶发」。
    let live = false;
    const Flaky = () => <Boom live={live} />;

    render(
      <ViewErrorBoundary>
        <Flaky />
      </ViewErrorBoundary>,
    );
    expect(screen.getByText('这一页崩了')).toBeInTheDocument();

    live = true;
    await user.click(screen.getByRole('button', { name: '重试这一页' }));

    expect(screen.getByText('视图内容')).toBeInTheDocument();
  });

  it('外壳崩了给的是整页重载，而且先说清线上没事', () => {
    render(
      <RootErrorBoundary>
        <Boom live={false} />
      </RootErrorBoundary>,
    );

    expect(screen.getByText('这个界面崩了')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新加载面板' })).toBeInTheDocument();
    // 第一句必须先回答操作者此刻唯一想知道的事：线上的反代是不是也挂了。
    expect(screen.getByText(/线上的反向代理不受影响/)).toBeInTheDocument();
  });
});
