import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { ThemeProvider } from '@/components/theme-provider';
import { api } from '@/lib/api';

/*
 * 审计页换成一个「想崩就崩」的假组件：视图级兜底的承诺是「这一页崩了，头部还能用」，
 * 而这件事只能靠真的让某一页抛异常来证明。
 */
const crashFlags = vi.hoisted(() => ({ audit: false }));
vi.mock('@/views/audit-view', () => ({
  AuditView: () => {
    if (crashFlags.audit) {
      throw new Error('boom: 审计页炸了');
    }
    return <p>审计内容</p>;
  },
}));

/**
 * 应用外壳。这里只焊头部那个账号菜单，因为它是唯一一处「点了就没法自救」的地方：
 * 退出登录只在这个菜单里。
 *
 * 它曾经打不开——DropdownMenuLabel 包的是 Base UI 的 Menu.GroupLabel，脱离
 * DropdownMenuGroup 使用会在渲染期抛异常，React 随即卸载整棵树，面板变成一片纯
 * 黑，连退出登录都点不到。当时视图级测试全绿，因为没有任何测试渲染过 App 本身。
 */

const renderApp = () =>
  render(
    <ThemeProvider defaultTheme="dark">
      <App />
    </ThemeProvider>,
  );

const openAccountMenu = async () => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '账号菜单' }));
  // Base UI 的菜单内容走 portal 且异步挂载，getByRole 赶不上，必须 findBy。
  return screen.findByRole('menu');
};

describe('App', () => {
  beforeEach(() => {
    vi.spyOn(api, 'me').mockResolvedValue({
      user: { subject: 'op', role: 'admin' },
      bootstrapable: false,
    });
    vi.spyOn(api, 'listRoutes').mockResolvedValue([]);
    vi.spyOn(api, 'getDefaults').mockResolvedValue(null);
    vi.spyOn(api, 'preview').mockResolvedValue({ ok: true, empty: true, live: null });
    vi.spyOn(api, 'logout').mockResolvedValue({});
  });

  afterEach(() => {
    crashFlags.audit = false;
    vi.restoreAllMocks();
  });

  it('账号菜单打得开，身份、改密码、退出登录三样都在里面', async () => {
    renderApp();
    const menu = await openAccountMenu();

    // 触发器上的账号名被 truncate 截过，完整值只在菜单里，所以这一行必须存在。
    expect(within(menu).getByText('op')).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: '修改密码…' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: '退出登录' })).toBeInTheDocument();
  });

  it('菜单里的退出登录真的退出，界面回到登录页', async () => {
    const user = userEvent.setup();
    renderApp();
    const menu = await openAccountMenu();

    // 退出成功后 App 会重新问一次 me，此时服务端该说「没人登录」。
    vi.mocked(api.me).mockResolvedValue({ user: null, bootstrapable: false });
    await user.click(within(menu).getByRole('menuitem', { name: '退出登录' }));

    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument();
  });

  it('触发器把展开状态说出来——雪佛龙的翻转和读屏都靠它', async () => {
    renderApp();
    const trigger = await screen.findByRole('button', { name: '账号菜单' });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await openAccountMenu();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
  it('某一页崩了也不吃掉头部——退出登录永远点得到', async () => {
    const user = userEvent.setup();
    crashFlags.audit = true;
    // React 捕获后会自己往 console.error 打一屏，静音以免淹掉测试输出。
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    renderApp();
    await user.click(await screen.findByRole('tab', { name: '审计' }));

    expect(await screen.findByText('这一页崩了')).toBeInTheDocument();
    // 这是这一层兜底的全部意义：内容区没了，自救的入口还在。
    const menu = await openAccountMenu();
    expect(within(menu).getByRole('menuitem', { name: '退出登录' })).toBeInTheDocument();
  });
});
