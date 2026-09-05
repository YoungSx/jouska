import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryView } from './history-view';
import { ApiError, api, type RevisionEntry } from '@/lib/api';

/**
 * 历史页的焊接点：viewer 不得看到可用的回滚按钮（服务端有闸门，但「不摆假
 * 按钮」是前端的本分）；无快照的卡不可选、不可回滚；两段式确认把 confirm
 * 一路传到底。
 *
 * 另外三条是回归测试，各自钉住一个曾经真实存在的缺陷：
 * - 「回滚」必须能用键盘打开（从前卡片的 onKeyDown 把 Enter 吃掉，变成勾选）；
 * - diff 方向必须是时间序，不看勾选顺序（从前自上而下勾会得到反向 diff）；
 * - 同一对 revision 失败之后必须能重试（从前 effect 依赖不变，重试无门）。
 */

const entry = (overrides: Partial<RevisionEntry>): RevisionEntry => ({
  revision: 2,
  at: 1_800_000_000,
  actor: 'op',
  note: null,
  rollbackOf: null,
  routeCount: 1,
  snapshot: 'full',
  live: false,
  ...overrides,
});

const seeded = (): RevisionEntry[] => [
  entry({ revision: 2, live: true }),
  entry({ revision: 1, note: 'first' }),
];

const pick = (revision: number): HTMLElement =>
  screen.getByRole('checkbox', { name: `把 revision ${String(revision)} 选进对比` });

describe('HistoryView 发布历史', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listRevisions').mockResolvedValue({ entries: seeded(), liveRevision: 2 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('管理员能看到回滚按钮，viewer 看不到', async () => {
    const { rerender } = render(<HistoryView isAdmin onConfigChanged={() => {}} />);
    await waitFor(() => expect(api.listRevisions).toHaveBeenCalledOnce());
    // 两张卡、live 卡被禁用，另一张可用。
    const buttons = screen.getAllByRole('button', { name: '回滚' });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toBeDisabled();

    rerender(<HistoryView isAdmin={false} onConfigChanged={() => {}} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: '回滚' })).toBeNull());
  });

  it('无快照的卡没有动作按钮，也不能选进对比', async () => {
    vi.mocked(api.listRevisions).mockResolvedValue({
      entries: [entry({ revision: 1, snapshot: 'none', routeCount: null })],
      liveRevision: null,
    });
    render(<HistoryView isAdmin onConfigChanged={() => {}} />);
    await waitFor(() => expect(screen.getByText('无快照')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '回滚' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('勾两个 revision 触发 diff，方向按时间序而不是勾选顺序', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'diffRevisions').mockResolvedValue([
      {
        path: 'routes.alpha.upstream',
        kind: 'changed',
        from: 'a',
        to: 'b',
        routeId: 'alpha',
        field: 'upstream',
      },
    ]);
    render(<HistoryView isAdmin onConfigChanged={() => {}} />);
    await waitFor(() => expect(pick(2)).toBeInTheDocument());

    // 自上而下勾：先较新的 #2，再较旧的 #1。from 仍必须是 1。
    await user.click(pick(2));
    expect(screen.getByText('已选 #2 —— 再勾一个 revision 就开始对比。')).toBeInTheDocument();
    await user.click(pick(1));
    await waitFor(() => expect(api.diffRevisions).toHaveBeenCalledWith(1, 2));

    expect(await screen.findByText('对比 #1 → #2')).toBeInTheDocument();
    // 路由为分组标题，行里只留字段名。
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('upstream')).toBeInTheDocument();
    // 两侧用绝对指称，不用「原值 / 新值」。
    expect(screen.getByText('#1 的值')).toBeInTheDocument();
    expect(screen.getByText('#2 的值')).toBeInTheDocument();
  });

  it('危险字段带上服务端的判定与面板自己的中文后果', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'diffRevisions').mockResolvedValue([
      {
        path: 'routes.alpha.allowPrivateUpstream',
        kind: 'changed',
        from: false,
        to: true,
        routeId: 'alpha',
        field: 'allowPrivateUpstream',
        risk: { path: 'allowPrivateUpstream', level: 'high', reason: 'english fallback' },
      },
    ]);
    render(<HistoryView isAdmin onConfigChanged={() => {}} />);
    await waitFor(() => expect(pick(2)).toBeInTheDocument());
    await user.click(pick(2));
    await user.click(pick(1));

    expect(await screen.findByText(/放行 loopback、内网和云元数据地址/)).toBeInTheDocument();
    expect(screen.getByText(/其中 1 项危险/)).toBeInTheDocument();
  });

  it('对比失败给出服务端的 detail，并且同一对能重试', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'diffRevisions').mockRejectedValueOnce(
      new ApiError('snapshot_unavailable', 409, { detail: 'revision 1 has no snapshot' }),
    );
    vi.mocked(api.diffRevisions).mockResolvedValueOnce([]);
    render(<HistoryView isAdmin onConfigChanged={() => {}} />);
    await waitFor(() => expect(pick(2)).toBeInTheDocument());
    await user.click(pick(2));
    await user.click(pick(1));

    expect(await screen.findByText('有一侧没有快照，对比不了。')).toBeInTheDocument();
    expect(screen.getByText('revision 1 has no snapshot')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(api.diffRevisions).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/两版内容完全一致/)).toBeInTheDocument();
  });

  it('回滚可以用键盘打开 —— Enter 不会被卡片吃成勾选', async () => {
    const user = userEvent.setup();
    render(<HistoryView isAdmin onConfigChanged={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '回滚' })).toHaveLength(2));

    // [0] 是 live 那一版（禁用），[1] 是 #1。
    const rollback = screen.getAllByRole('button', { name: '回滚' })[1];
    rollback.focus();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('button', { name: '确认回滚' })).toBeInTheDocument();
    // 而且它没有顺手把这张卡勾进对比。弹窗开着时背景被 Base UI 标了
    // aria-hidden，所以这一句要 hidden: true 才查得到。
    expect(
      screen.getByRole('checkbox', { name: '把 revision 1 选进对比', hidden: true }),
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('回滚走两段式：先 409 拿危险清单，勾选确认后 confirm 为 true 重提', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'rollback').mockRejectedValueOnce(
      new ApiError('confirmation_required', 409, {
        dangers: { risky: [{ path: 'allowPrivateUpstream', level: 'high', reason: 'r' }] },
      }),
    );
    vi.mocked(api.rollback).mockResolvedValueOnce({ revision: 3 });
    render(<HistoryView isAdmin onConfigChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '回滚' })).toHaveLength(2));

    await user.click(screen.getAllByRole('button', { name: '回滚' })[1]);
    const submit = await screen.findByRole('button', { name: '确认回滚' });
    await user.click(submit);

    // 第一段（confirm=false）已被拒，弹窗进入确认段。
    await waitFor(() => expect(api.rollback).toHaveBeenCalledWith(1, undefined, false));
    const checkbox = await screen.findByRole('switch');
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: /确认/ }));
    await waitFor(() => expect(api.rollback).toHaveBeenCalledWith(1, undefined, true));
  });

  it('加载失败显示错误文案与重试按钮，viewer 的 403 也不例外', async () => {
    vi.mocked(api.listRevisions).mockRejectedValue(new ApiError('forbidden', 403, {}));
    render(<HistoryView isAdmin={false} onConfigChanged={() => {}} />);
    expect(await screen.findByText(/历史加载失败/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });
});
