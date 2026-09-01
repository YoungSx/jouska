import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryView } from './history-view';
import { ApiError, api, type RevisionEntry } from '@/lib/api';

/**
 * 历史页的焊接点：viewer 不得看到可用的回滚按钮（服务端有闸门，但「不摆假
 * 按钮」是前端的本分）；无快照的卡不可选、不可回滚；两段式确认把 confirm
 * 一路传到底。
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

describe('HistoryView 发布历史', () => {
  beforeEach(() => {
    vi.spyOn(api, 'listRevisions').mockResolvedValue(seeded());
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
    vi.mocked(api.listRevisions).mockResolvedValue([
      entry({ revision: 1, snapshot: 'none', routeCount: null }),
    ]);
    render(<HistoryView isAdmin onConfigChanged={() => {}} />);
    await waitFor(() => expect(screen.getByText('无快照')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '回滚' })).toBeNull();
    expect(screen.queryByRole('button', { name: '对比' })).toBeNull();
  });

  it('选两张卡触发 diff，diff 结果按服务端给的条目渲染', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'diffRevisions').mockResolvedValue([
      { path: 'routes.alpha.upstream', kind: 'changed', from: 'a', to: 'b' },
    ]);
    render(<HistoryView isAdmin onConfigChanged={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: '对比' })).toHaveLength(2));

    await user.click(screen.getAllByRole('button', { name: '对比' })[1]);
    await user.click(screen.getAllByRole('button', { name: /对比|取消/ })[0]);
    await waitFor(() => expect(api.diffRevisions).toHaveBeenCalledWith(1, 2));
    expect(await screen.findByText(/routes\.alpha\.upstream/)).toBeInTheDocument();
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

  it('加载失败显示错误文案，viewer 的 403 也不例外', async () => {
    vi.mocked(api.listRevisions).mockRejectedValue(new ApiError('forbidden', 403, {}));
    render(<HistoryView isAdmin={false} onConfigChanged={() => {}} />);
    expect(await screen.findByText(/历史加载失败/)).toBeInTheDocument();
  });
});
