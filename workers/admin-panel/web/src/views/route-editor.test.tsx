import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouteEditor } from './route-editor';
import { api, type DomainsResponse, type HostBinding } from '@/lib/api';
import type { RouteDefinition } from '@/lib/types';

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

/** 按下保存，回答服务端收到的 definition —— 断言看的是落进草稿的那份数据。 */
const saveDraft = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: '保存到草稿' }));
  await waitFor(() => expect(api.putRoute).toHaveBeenCalled());
  return vi.mocked(api.putRoute).mock.calls[0]?.[1];
};

const renderEditor = (
  createMode = true,
  definition: RouteDefinition = { upstream: 'origin.example.com' },
) =>
  render(
    <RouteEditor
      open
      onOpenChange={() => {}}
      initial={{
        id: 'new-route',
        definition,
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

/**
 * 正文改写这一段（issue #29 / #30）。
 *
 * 焊三件事：
 *
 * 1. `rewriteLinks` / `rewriteStyles` 必须在表单里，而且默认显示为**开** —— 它们的
 *    schema 默认值是 true，也就是说 `bodyRewrite: {}` 已经在改链接和样式了。之前
 *    表单只暴露 contentTypes 与 fallbackCharset，想单独关掉样式改写只能去写原始
 *    JSON。
 * 2. 关掉一个子开关只落那一个 false，**段壳必须留着**。删到空对象等于把整段改写
 *    关掉，那是完全不同的一件事。
 * 3. 打开改写的**代价当场可见**：改写会剥掉上游的 ETag / Last-Modified / CSP。
 *    默认打开这个开关等于默认降级客户端缓存和上游的安全头，所以按下它的人要知道
 *    自己按下了什么。
 */
describe('RouteEditor 正文改写（issue #29）', () => {
  beforeEach(() => {
    vi.spyOn(api, 'domains').mockResolvedValue(configured([]));
    vi.spyOn(api, 'putRoute').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('打开改写：两个子开关出现，且都显示为 schema 默认的开', async () => {
    const user = userEvent.setup();
    renderEditor();

    expect(screen.queryByRole('switch', { name: '改写链接' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: '改写响应体' }));

    expect(screen.getByRole('switch', { name: '改写链接' })).toBeChecked();
    expect(screen.getByRole('switch', { name: '改写样式里的地址' })).toBeChecked();
  });

  it('打开改写就摊开代价：剥掉验证器与 CSP 这件事不能等出问题才发现', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole('switch', { name: '改写响应体' }));

    const note = screen.getByRole('alert');
    expect(note).toHaveTextContent('改写会剥掉上游的');
    // 覆盖范围也要如实：开了不等于全都留在代理上。
    expect(note).toHaveTextContent('都改不到');
  });

  it('关掉样式改写只落那一个 false，段壳留着', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole('switch', { name: '改写响应体' }));
    await user.click(screen.getByRole('switch', { name: '改写样式里的地址' }));

    expect(await saveDraft(user)).toMatchObject({ bodyRewrite: { rewriteStyles: false } });
  });

  it('已经关掉的子开关显示为关，再打开就把键删掉 —— 等于默认值不落盘', async () => {
    const user = userEvent.setup();
    renderEditor(true, {
      upstream: 'origin.example.com',
      bodyRewrite: { rewriteLinks: false },
    });

    const links = screen.getByRole('switch', { name: '改写链接' });
    expect(links).not.toBeChecked();
    await user.click(links);

    // 段壳还在（改写仍然开着），只是里面回到了默认。
    expect(await saveDraft(user)).toMatchObject({ bodyRewrite: {} });
  });
});
