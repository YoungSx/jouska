import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserCreateDialog } from './user-create-dialog';
import { ApiError, api } from '@/lib/api';

/**
 * 新建用户弹窗。两条回归：角色缺省必须是「观察者」（与服务端一致的取向，一次点击
 * 造出来的账号宁可选权限小的那头），以及这张表单里不能再出现凭据 —— 门在 Access
 * 那边，面板这边多一个输入框就是多一个假承诺。
 */

const renderDialog = (onCreated = vi.fn()) => ({
  onCreated,
  ...render(<UserCreateDialog open onOpenChange={() => {}} onCreated={onCreated} />),
});

describe('UserCreateDialog', () => {
  beforeEach(() => {
    vi.spyOn(api, 'createUser').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('挂载即可交互；角色缺省是观察者', async () => {
    const user = userEvent.setup();
    const { onCreated } = renderDialog();

    const subject = screen.getByLabelText('账号');
    expect(subject).toBeEnabled();
    await user.type(subject, 'newcomer@example.com');
    // 否定断言：这张表单不设凭据，密码框出现就是设计错了。
    expect(screen.queryByLabelText('密码')).toBeNull();

    // 缺省角色直接提交：服务端收到的必须是 viewer。
    await user.click(screen.getByRole('button', { name: /新建用户$/ }));
    expect(api.createUser).toHaveBeenCalledWith('newcomer@example.com', 'viewer');
    // 成功的信号交给回调：toast 走 sonner 的 portal，在测试里断它不可靠。
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('newcomer@example.com'));
  });

  it('账号名空着前端先挡：不发请求', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: /新建用户$/ })).toBeDisabled();
    expect(api.createUser).not.toHaveBeenCalled();
  });

  it('账号名已被占用：409 subject_taken 转成中文文案', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('账号'), 'taken@example.com');
    vi.mocked(api.createUser).mockRejectedValueOnce(new ApiError('subject_taken', 409, {}));

    await user.click(screen.getByRole('button', { name: /新建用户$/ }));
    expect(await screen.findByText('这个账号名已经有人用了。')).toBeInTheDocument();
  });
});
