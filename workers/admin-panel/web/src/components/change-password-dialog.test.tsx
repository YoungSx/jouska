import { act } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangePasswordDialog } from './change-password-dialog';
import { ApiError, api } from '@/lib/api';

/**
 * 与 auth-view 同一条焊法：busy 状态曾让控件一出生就锁死，所以每个用例先断言
 * 挂载即可交互。断言全走 messages.ts 的中文文案 —— 文案改名时测试会跟着断，
 * 组件里写死的句子则不会。
 */

const renderDialog = () => render(<ChangePasswordDialog open onOpenChange={() => {}} />);

describe('ChangePasswordDialog', () => {
  beforeEach(() => {
    vi.spyOn(api, 'changePassword').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('挂载即可交互：三个输入框和提交按钮都是活的', async () => {
    const user = userEvent.setup();
    renderDialog();

    const current = screen.getByLabelText('当前密码');
    expect(current).toBeEnabled();
    await user.type(current, 'old-password-123');

    expect(screen.getByLabelText('新密码')).toBeEnabled();
    expect(screen.getByLabelText('再输一遍新密码')).toBeEnabled();

    // 三栏没填齐之前不许提交 —— 这是前端能挡住的第一道门。
    expect(screen.getByRole('button', { name: '确认修改' })).toBeDisabled();
  });

  it('两遍新密码不一致：不发请求，提交保持禁用', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('当前密码'), 'old-password-123');
    await user.type(screen.getByLabelText('新密码'), 'brand-new-password-1');
    await user.type(screen.getByLabelText('再输一遍新密码'), 'brand-new-password-2');

    expect(screen.getByText('两次输入的新密码不一样')).toBeInTheDocument();
    expect(api.changePassword).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '确认修改' })).toBeDisabled();
  });

  it('当前密码不对：401 wrong_password 转成中文文案，弹窗保持打开', async () => {
    const user = userEvent.setup();
    let rejectCall!: (cause: unknown) => void;
    vi.mocked(api.changePassword).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCall = reject;
        }),
    );
    const onOpenChange = vi.fn();
    render(<ChangePasswordDialog open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText('当前密码'), 'wrong-old-12345');
    await user.type(screen.getByLabelText('新密码'), 'brand-new-password-1');
    await user.type(screen.getByLabelText('再输一遍新密码'), 'brand-new-password-1');
    await user.click(screen.getByRole('button', { name: '确认修改' }));

    await act(async () => {
      rejectCall(new ApiError('wrong_password', 401, {}));
    });
    expect(screen.getByText('当前密码不对。')).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('成功：发的是当前密码与新密码，toast 后关弹窗', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<ChangePasswordDialog open onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText('当前密码'), 'old-password-123');
    await user.type(screen.getByLabelText('新密码'), 'brand-new-password-1');
    await user.type(screen.getByLabelText('再输一遍新密码'), 'brand-new-password-1');
    await user.click(screen.getByRole('button', { name: '确认修改' }));

    expect(api.changePassword).toHaveBeenCalledWith('old-password-123', 'brand-new-password-1');
    // 成功的信号交给回调：toast 走 sonner 的 portal，在测试里断它不可靠。
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
