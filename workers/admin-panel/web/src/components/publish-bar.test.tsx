import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PublishBar } from './publish-bar';
import type { PublishGate } from '@/hooks/use-draft';
import type { PreviewResult } from '@/lib/api';

/**
 * 发布栏的舍弃按钮。它的可见性本身就是语义：只有「有线上版本、草稿又改了/坏了」
 * 才有可弃的东西 —— 从未发布过、clean、观察者，都不该看见这颗按钮。
 */

const preview: PreviewResult = { ok: true, dirty: true, routeCount: 2, live: { revision: 1 } };

const renderBar = (gate: PublishGate, canPublish = true, onDiscard = vi.fn()) => ({
  onDiscard,
  ...render(
    <PublishBar
      gate={gate}
      canPublish={canPublish}
      publishing={false}
      onPublish={() => {}}
      onReview={() => {}}
      onDiscard={onDiscard}
    />,
  ),
});

describe('PublishBar 舍弃按钮', () => {
  it('dirty 且已发布过：可见，点击回调', async () => {
    const user = userEvent.setup();
    const { onDiscard } = renderBar({ kind: 'dirty', preview, live: 1 });

    const button = screen.getByRole('button', { name: /舍弃草稿/ });
    await user.click(button);
    expect(onDiscard).toHaveBeenCalled();
  });

  it('blocked：也可见（逃生舱）', () => {
    renderBar({
      kind: 'blocked',
      preview: { ok: false, issues: [] },
      live: 1,
    });
    expect(screen.getByRole('button', { name: /舍弃草稿/ })).toBeInTheDocument();
  });

  it('dirty 但从未发布过：不可见（没有线上版本可恢复）', () => {
    renderBar({ kind: 'dirty', preview, live: null });
    expect(screen.queryByRole('button', { name: /舍弃草稿/ })).not.toBeInTheDocument();
  });

  it('clean / empty：不可见', () => {
    renderBar({ kind: 'clean', preview, live: 1 });
    renderBar({ kind: 'empty', live: null });
    expect(screen.queryByRole('button', { name: /舍弃草稿/ })).not.toBeInTheDocument();
  });

  it('观察者不可见', () => {
    renderBar({ kind: 'dirty', preview, live: 1 }, false);
    expect(screen.queryByRole('button', { name: /舍弃草稿/ })).not.toBeInTheDocument();
  });
});
