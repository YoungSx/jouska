import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { BuildTag, pageBuildId } from './build-tag';

/**
 * 页脚那行构建标识只有一个职责：回答「拦我的是哪个构建」。
 *
 * 关键行为不是「能显示」，而是显示谁——服务端在场以服务端为准（拒绝请求的是它），
 * 两串不一致才并排（那本身是缓存旧页面的证据），一致与缺席时一个串，不折腾。
 */

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('BuildTag', () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it('测试环境兜出 dev，不编一个版本出来', () => {
    // jsdom 走不到 vite 的 define 注入，typeof 守卫落 'dev'。
    expect(pageBuildId()).toBe('dev');
  });

  it('服务端在场：只显示服务端一串，拒绝你的那一方才有署名权', () => {
    // 测试环境本页兜 'dev'，与服务端串必然不一致 —— 想测「一致」分支只能配平它。
    vi.stubGlobal('__BUILD_ID__', 'v0.16.0');
    render(<BuildTag serverBuild="v0.16.0" />);
    expect(screen.getByText('v0.16.0')).toBeInTheDocument();
    // 一致时不是「本页本页」叠两个前缀。
    expect(screen.queryByText(/本页/)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('服务端缺席：只剩本页一串，前缀说清来源', () => {
    render(<BuildTag />);
    expect(screen.getByText(/本页 dev/)).toBeInTheDocument();
  });

  it('两串不一致才并排，一眼看出浏览器在跑旧页面', () => {
    render(<BuildTag serverBuild="v0.16.0" />);
    // serverBuild 与测试环境兜出的 'dev' 必然不一致 → 并排。
    expect(screen.getByText(/面板 v0\.16\.0 · 本页 dev/)).toBeInTheDocument();
  });

  it('点击复制的是整条 label（并排时两条都带上）', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    const { unmount } = render(<BuildTag serverBuild="v0.16.0" />);
    await user.click(screen.getByText(/面板 v0\.16\.0/));

    expect(writeText).toHaveBeenCalledWith('面板 v0.16.0 · 本页 dev');
    expect(screen.getByText('已复制')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('已复制');
    unmount();
    vi.unstubAllGlobals();
  });

  it('复制失败给出手动路径，而不是静默', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });

    render(<BuildTag />);
    await user.click(screen.getByText(/本页 dev/));

    expect(toast.error).toHaveBeenCalledWith('复制失败，请手动选中');
    vi.unstubAllGlobals();
  });
});
