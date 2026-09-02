import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreviewView } from './preview-view';
import type { PreviewResult } from '@/lib/api';

/**
 * 预览页的发布语义：同一份文档，clean 态说「正在服务流量」，dirty 态说「将上
 * 线」—— 已发布的草稿再说「将上线」等于骗一次发布。clean 时发布按钮按不动，
 * 放行会原样多写一个 revision。
 */

const okPreview = (): PreviewResult => ({
  ok: true,
  routeCount: 3,
  document: { routes: [] },
  dangers: {},
  shadowWarnings: [],
  issues: [],
});

const props = (overrides: {
  readonly liveRevision?: number | null;
  readonly isAdmin?: boolean;
  readonly live?: { readonly revision: number };
}) => ({
  preview: overrides.live === undefined ? okPreview() : { ...okPreview(), live: overrides.live },
  loading: false,
  isAdmin: overrides.isAdmin ?? true,
  liveRevision: overrides.liveRevision ?? null,
  onRefresh: () => {},
  onPublish: vi.fn(),
  onGoRoutes: () => {},
});

describe('PreviewView 发布状态', () => {
  it('dirty 态说「将上线」，发布按钮可用', () => {
    render(<PreviewView {...props({})} />);
    expect(screen.getByText('3 条路由将上线')).toBeInTheDocument();
    const publish = screen.getByRole('button', { name: '发布到反代' });
    expect(publish).toBeEnabled();
  });

  it('dirty 且线上有 revision（发布过又改了草稿）仍说「将上线」——clean 判断丢失时这条会红', () => {
    // 真实世界最常见的状态：以前发布过（live 存在），草稿又改了（dirty）。
    // 若 clean 判断被误删、只剩 live 判断，这一行会被错误说成「正在服务流量」。
    render(<PreviewView {...props({ live: { revision: 5 } })} />);
    expect(screen.getByText('3 条路由将上线')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发布到反代' })).toBeEnabled();
  });

  it('clean 态说「正在服务流量」，发布按钮禁用并说明原因', () => {
    render(<PreviewView {...props({ liveRevision: 7, live: { revision: 7 } })} />);
    expect(screen.getByText('这 3 条路由正在服务流量（revision 7）')).toBeInTheDocument();
    const publish = screen.getByRole('button', { name: '发布到反代' });
    expect(publish).toBeDisabled();
    expect(publish).toHaveAccessibleDescription('线上已是这版内容，不用再发布');
  });

  it('观察者在 clean 态看到的仍是角色门槛——title 先解释权限再解释内容', () => {
    render(<PreviewView {...props({ liveRevision: 7, live: { revision: 7 } })} isAdmin={false} />);
    expect(screen.getByRole('button', { name: '发布到反代' })).toHaveAccessibleDescription(
      '只有管理员能发布。',
    );
  });
});
