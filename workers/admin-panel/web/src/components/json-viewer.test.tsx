import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JsonViewer } from './json-viewer';

const doc = {
  version: 3,
  routes: {
    'api-gw': {
      upstream: 'https://api.example.com',
    },
  },
  flags: null,
};

describe('JsonViewer', () => {
  it('顶层默认展开，深层默认收起，摘牌给出数量', () => {
    render(<JsonViewer value={doc} />);
    // 顶层键可见
    expect(screen.getByText('"version"')).toBeInTheDocument();
    // routes 的深层子键收起不可见
    expect(screen.queryByText('"upstream"')).not.toBeInTheDocument();
    // 收起摘牌（省略号和数字在 JSX 里是分开的文本节点，用正则匹配）
    expect(screen.getByText(/… 1 个键/)).toBeInTheDocument();
  });

  it('点击容器行展开子层', async () => {
    const user = userEvent.setup();
    render(<JsonViewer value={doc} />);
    await user.click(screen.getByText(/… 1 个键/));
    expect(screen.getByText('"upstream"')).toBeInTheDocument();
  });

  it('全部展开把深层也打开，收起全部回到仅顶层', async () => {
    const user = userEvent.setup();
    render(<JsonViewer value={doc} />);
    await user.click(screen.getByText('全部展开'));
    expect(screen.getByText('"upstream"')).toBeInTheDocument();
    await user.click(screen.getByText('收起全部'));
    expect(screen.queryByText('"upstream"')).not.toBeInTheDocument();
  });

  it('收起的数组给「项」摘牌；空容器与标量不折叠', async () => {
    const user = userEvent.setup();
    // list 包一层才落到默认收起的深度（≤1 层都展开）。
    render(<JsonViewer value={{ outer: { list: ['a', 'b'] }, empty: {}, none: null }} />);
    // 二层默认收起，摘牌可见；点开后果真两子项。
    expect(screen.getByText(/… 2 项/)).toBeInTheDocument();
    await user.click(screen.getByText(/… 2 项/));
    expect(screen.getByText('"a"')).toBeInTheDocument();
    expect(screen.getByText('"b"')).toBeInTheDocument();
    // 空对象/标量没有展开开关，值直接可见
    expect(screen.getByText('{}')).toBeInTheDocument();
    expect(screen.getByText('null')).toBeInTheDocument();
  });

  it('aria-expanded 随折叠状态翻转', async () => {
    const user = userEvent.setup();
    render(<JsonViewer value={doc} />);
    const row = screen.getByRole('button', { name: /routes/ });
    expect(row).toHaveAttribute('aria-expanded', 'true');
    await user.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
  });

  it('复制按钮写原文到剪贴板', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    // clipboard 是只读 getter，只能整个换掉属性（jsdom 没给实现，装 mock 是惯例）。
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<JsonViewer value={{ a: 1 }} />);
    await user.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledWith('{\n  "a": 1\n}');
  });
});
