import { act } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthView } from './auth-view';
import { ApiError, api, type MeResult } from '@/lib/api';

/**
 * 这份测试焊的是一条教训：`busy = pending !== null` 让布尔值永远"不等于 null"，
 * 页面一出生就判定为登录中，控件永久禁用。回归断言因此从"初始态"入手——
 * 刚挂载、还没点任何东西时，表单必须是可交互的。
 */

const me = (bootstrapable: boolean): MeResult => ({ user: null, bootstrapable });

describe('AuthView 登录表单', () => {
  beforeEach(() => {
    vi.spyOn(api, 'login').mockResolvedValue({ subject: 'op', role: 'admin' });
    vi.spyOn(api, 'bootstrap').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('挂载后控件可用：输入框能打字、按钮能提交', async () => {
    const user = userEvent.setup();
    render(<AuthView me={me(false)} loading={false} onSignedIn={() => {}} />);

    const subject = screen.getByLabelText('账号');
    expect(subject).toBeEnabled();
    await user.type(subject, 'op');
    expect(subject).toHaveValue('op');

    expect(screen.getByLabelText('密码')).toBeEnabled();
    const submit = screen.getByRole('button', { name: '登录' });
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(api.login).toHaveBeenCalledOnce();
  });

  it('提交中禁用，失败后立即释放并显示错误', async () => {
    const user = userEvent.setup();
    // 用 deferred 手动掐住请求的挂起窗口：组件在 pending 期间必须锁死。
    let rejectLogin!: (cause: unknown) => void;
    vi.mocked(api.login).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectLogin = reject;
        }),
    );
    const onSignedIn = vi.fn();
    render(<AuthView me={me(false)} loading={false} onSignedIn={onSignedIn} />);

    await user.type(screen.getByLabelText('账号'), 'op');
    await user.type(screen.getByLabelText('密码'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    // spinner 自带 aria-label "Loading"，会拼进按钮名，所以用正则匹配尾部文案。
    const pending = screen.getByRole('button', { name: /登录中…$/ });
    expect(pending).toBeDisabled();
    expect(screen.getByLabelText('账号')).toBeDisabled();

    await act(async () => {
      rejectLogin(new ApiError('invalid_credentials', 401, {}));
    });
    expect(screen.getByRole('button', { name: '登录' })).toBeEnabled();
    expect(screen.getByText('账号或密码不对。')).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});
