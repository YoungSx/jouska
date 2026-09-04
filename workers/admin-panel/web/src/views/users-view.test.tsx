import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersView } from './users-view';
import { ApiError, api, type UserEntry } from '@/lib/api';

/**
 * 用户管理页。焊三类行为：挂载即拉数据、self 行的删除被禁用（防呆在行内，
 * 不等服务端 409）、写操作成功后重拉列表。
 */

const NOW = 1_700_000_000;

// 工厂不叫 user——测试体里的 userEvent.setup() 惯用这个名字，别撞。
const makeUser = (over: Partial<UserEntry>): UserEntry => ({
  id: 1,
  subject: 'op',
  email: null,
  role: 'admin',
  disabled: false,
  createdAt: NOW - 86400,
  lastSeen: NOW - 60,
  ...over,
});

const renderView = (onSelfRoleChanged = vi.fn()) =>
  render(<UsersView selfSubject="op" onSelfRoleChanged={onSelfRoleChanged} />);

const openRowMenu = async (subject: string) => {
  const user = userEvent.setup();
  const row = screen.getByText(subject).closest('tr');
  if (row === null) {
    throw new Error(`row for ${subject} not found`);
  }
  await user.click(within(row as HTMLElement).getByRole('button'));
  // Base UI 的菜单内容走 portal 且异步挂载，getByRole 赶不上，必须 findBy。
  return screen.findByRole('menu');
};

const clickMenuItem = async (name: string) => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('menuitem', { name }));
};

describe('UsersView', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listUsers').mockResolvedValue([
      makeUser({ id: 1, subject: 'op', role: 'admin' }),
      makeUser({ id: 2, subject: 'guest', role: 'viewer', lastSeen: null }),
    ]);
    vi.spyOn(api, 'deleteUser').mockResolvedValue(undefined);
    vi.spyOn(api, 'updateUser').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('挂载即拉数据：两行都进表，从未登录的账号有说法', async () => {
    renderView();

    expect(await screen.findByText('guest')).toBeInTheDocument();
    expect(screen.getByText('从未登录')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '账号' })).toBeInTheDocument();
  });

  it('self 行的删除在菜单里就是禁的，别人可以删', async () => {
    renderView();
    await screen.findByText('guest');

    await openRowMenu('op');
    // Base UI 用 div 渲染菜单项，禁用走 aria-disabled 而非 disabled 属性。
    const selfDelete = await screen.findByRole('menuitem', { name: '删除' });
    expect(selfDelete).toHaveAttribute('aria-disabled', 'true');

    // 换一行前先把菜单关掉，避免同一屏幕里两个「删除」。
    await userEvent.keyboard('{Escape}');
    await openRowMenu('guest');
    expect(await screen.findByRole('menuitem', { name: '删除' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it('删除确认后发请求、关弹窗、重拉列表', async () => {
    renderView();
    await screen.findByText('guest');

    const user = userEvent.setup();
    await openRowMenu('guest');
    await clickMenuItem('删除');
    await user.click(await screen.findByRole('button', { name: '删除' }));

    expect(api.deleteUser).toHaveBeenCalledWith(2);
    // onDelete 成功后 reload —— listUsers 的调用次数从 1 涨到 2。
    expect(api.listUsers).toHaveBeenCalledTimes(2);
  });

  it('刷新按钮重拉列表', async () => {
    renderView();
    await screen.findByText('guest');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '刷新' }));
    expect(api.listUsers).toHaveBeenCalledTimes(2);
  });

  it('列表加载失败给重试，重试真的重拉', async () => {
    vi.mocked(api.listUsers).mockRejectedValueOnce(new ApiError('forbidden', 403, {}));
    renderView();

    expect(await screen.findByText(/加载用户列表失败/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('guest')).toBeInTheDocument();
  });
});
