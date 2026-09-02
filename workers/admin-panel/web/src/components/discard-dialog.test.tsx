import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscardDialog } from './discard-dialog';
import { ApiError, api } from '@/lib/api';

/**
 * 舍弃草稿弹窗。要守住的两件事：文案把「线上不受影响、恢复到哪一版」说清，
 * 错误码按服务端的三种 409 如实转述 —— 不猜服务端没说的话。
 *
 * 错误与成功都走 sonner 的 toast，而测试环境没挂 Toaster —— 沿本仓库惯例断
 * toast 调用本身（spy），不试图渲染 portal。
 */

const renderDialog = (liveRevision = 1, onDiscarded = vi.fn()) => ({
  onDiscarded,
  ...render(
    <DiscardDialog
      open
      onOpenChange={() => {}}
      liveRevision={liveRevision}
      onDiscarded={onDiscarded}
    />,
  ),
});

describe('DiscardDialog', () => {
  beforeEach(() => {
    vi.spyOn(toast, 'success').mockImplementation(() => 1);
    vi.spyOn(toast, 'error').mockImplementation(() => 1);
    vi.spyOn(api, 'discardDraft').mockResolvedValue({ sourceRevision: 1 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('正文说明恢复到哪一版、线上不受影响；成功后 toast + 回调', async () => {
    const user = userEvent.setup();
    const { onDiscarded } = renderDialog(3);

    expect(screen.getByText(/正在服务的 revision 3/)).toBeInTheDocument();
    expect(screen.getByText(/线上流量的走向不受影响/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '舍弃草稿' }));
    expect(api.discardDraft).toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('草稿已恢复为 revision 1 的内容。'),
    );
    expect(onDiscarded).toHaveBeenCalled();
  });

  it.each([
    ['nothing_published', '还没有发布过任何配置'],
    ['snapshot_unavailable', '没有可用的快照'],
    ['already_clean', '已经和线上一致'],
  ] as const)('409 %s 转成对应的中文文案，弹窗保持打开', async (code, fragment) => {
    const user = userEvent.setup();
    const { onDiscarded } = renderDialog();
    vi.mocked(api.discardDraft).mockRejectedValueOnce(new ApiError(code, 409, {}));

    await user.click(screen.getByRole('button', { name: '舍弃草稿' }));
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining(fragment)),
    );
    expect(onDiscarded).not.toHaveBeenCalled();
  });
});
