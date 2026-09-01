import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteEditor } from './route-editor';
import { api, type DomainsResponse, type HostBinding } from '@/lib/api';

/**
 * 焊两条教训与一个承诺：
 *
 * 1. 「挂载即锁死」——host 输入框从挂载那一刻起必须能打字，候选还在读（或读
 *    不到）都不能拦住自由输入。降级是"少一个下拉"，不是"多一道锁"。
 * 2. 候选永远来自 /api/domains，且弹窗每次打开都重读（绑定可能在中途变了）。
 * 3. 选候选与手输是同一个值通道：选中项要写进草稿，与手打的 host 无异。
 */

const binding = (host: string, kind: HostBinding['kind'], pattern?: string): HostBinding => ({
  kind,
  host,
  ...(pattern === undefined ? {} : { pattern }),
  routeIds: [],
});

const configured = (hosts: HostBinding[]): DomainsResponse => ({ configured: true, hosts });

const renderEditor = (createMode = true) =>
  render(
    <RouteEditor
      open
      onOpenChange={() => {}}
      initial={{
        id: 'new-route',
        definition: { upstream: 'origin.example.com' },
        enabled: true,
      }}
      createMode={createMode}
      onSaved={() => {}}
    />,
  );

describe('RouteEditor host 字段（issue #19）', () => {
  beforeEach(() => {
    vi.spyOn(api, 'domains').mockResolvedValue(
      configured([
        binding('app.example.com', 'custom_domain'),
        binding('*.wild.example.com', 'route', '*.wild.example.com/*'),
      ]),
    );
    vi.spyOn(api, 'putRoute').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('挂载即可自由输入：候选未返回时 host 输入框也不锁、能打字', async () => {
    let resolveDomains!: (value: DomainsResponse) => void;
    vi.mocked(api.domains).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDomains = resolve;
        }),
    );
    const user = userEvent.setup();
    renderEditor();

    const host = screen.getByLabelText('host');
    expect(host).toBeEnabled();
    await user.type(host, 'my.custom.dev');
    expect(host).toHaveValue('my.custom.dev');

    // 候选迟到了也不改写用户已经打进去的字。
    await waitFor(() => resolveDomains(configured([binding('late.example.com', 'workers_dev')])));
    await waitFor(() => expect(api.domains).toHaveBeenCalled());
    expect(screen.getByLabelText('host')).toHaveValue('my.custom.dev');
  });

  it('从下拉选一项：input 与草稿同步，route 来源标注 pattern 原文', async () => {
    const user = userEvent.setup();
    renderEditor();

    // 候选返回后 chevron 才出现（showTrigger 依赖非空 options）；用它等加载完成。
    const hostGroup = screen.getByLabelText('host').closest('[data-slot="input-group"]');
    await waitFor(() => expect(hostGroup?.querySelector('button')).not.toBeNull());
    // openOnInputClick 默认 false：点框不弹。jsdom 的 InputEvent 无 inputType，
    // 会被库当 autofill，打字也不弹 —— 测试走 chevron 这条真实打开路径。
    await user.click(hostGroup?.querySelector('button') ?? new HTMLElement());
    // 浮层经 Portal 挂载晚一帧，用会重试的 findByText。
    await user.click(await screen.findByText('*.wild.example.com'));

    expect(screen.getByLabelText('host')).toHaveValue('*.wild.example.com');

    // 保存成功 = 草稿里就是选中的 host（onSaved 的 id 参数由 putRoute 路径验证）。
    await user.click(screen.getByRole('button', { name: '保存到草稿' }));
    await waitFor(() =>
      expect(api.putRoute).toHaveBeenCalledWith(
        'new-route',
        expect.objectContaining({ match: { host: '*.wild.example.com' } }),
        true,
      ),
    );
  });

  it('configured: false 降级安静：能输入、无候选、留一行小字不报警', async () => {
    vi.mocked(api.domains).mockResolvedValue({ configured: false });
    const user = userEvent.setup();
    renderEditor();

    const host = screen.getByLabelText('host');
    await waitFor(() => expect(api.domains).toHaveBeenCalled());
    await user.type(host, 'manual.example.com');
    expect(host).toHaveValue('manual.example.com');
    expect(screen.queryByText('*.wild.example.com')).not.toBeInTheDocument();
    expect(screen.getByText('读不到已绑定的域名，仍可直接输入。')).toBeInTheDocument();
    // 降级是安静的一行字，不是 destructive 警报。
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('拉取失败同样降级：不弹错、不锁输入', async () => {
    vi.mocked(api.domains).mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderEditor();

    await waitFor(() => expect(api.domains).toHaveBeenCalled());
    const host = screen.getByLabelText('host');
    await user.type(host, 'offline.example.com');
    expect(host).toHaveValue('offline.example.com');
    expect(screen.getByText('读不到已绑定的域名，仍可直接输入。')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('每次打开弹窗都重新拉取候选', async () => {
    const { rerender } = renderEditor();
    await waitFor(() => expect(api.domains).toHaveBeenCalledTimes(1));

    rerender(
      <RouteEditor
        open={false}
        onOpenChange={() => {}}
        initial={{
          id: 'new-route',
          definition: { upstream: 'origin.example.com' },
          enabled: true,
        }}
        createMode
        onSaved={() => {}}
      />,
    );
    rerender(
      <RouteEditor
        open
        onOpenChange={() => {}}
        initial={{
          id: 'new-route',
          definition: { upstream: 'origin.example.com' },
          enabled: true,
        }}
        createMode
        onSaved={() => {}}
      />,
    );
    await waitFor(() => expect(api.domains).toHaveBeenCalledTimes(2));
  });
});
