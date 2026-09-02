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
  const calls = vi.mocked(api.putRoute).mock.calls;
  const before = calls.length;
  await user.click(screen.getByRole('button', { name: '保存到草稿' }));
  await waitFor(() => expect(api.putRoute).toHaveBeenCalledTimes(before + 1));
  return calls.at(-1)?.[1];
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

/**
 * 注入请求头这一段。
 *
 * 焊住的是一个真实症状：点「加一行」毫无反应。
 *
 * 病因不在按钮上。空行不产生任何有效头，于是编辑器上报 `undefined`（空对象不落
 * 盘）；但它记下的回声指纹曾是 `JSON.stringify({})`，而下一次渲染按 `value ?? null`
 * 算出的 signature 是 `"null"` —— 两者不等，编辑器把自己的回声当成「外部改了值」，
 * 在同一次渲染里就把刚加的空行复位抹掉。
 *
 * 凡是「有效头归零」的编辑都会撞上同一处：加第一行、把唯一那行的头名删空。所以这
 * 里焊的不只是按钮有反应，还有「正在输入的行不许自己消失」。
 */
describe('RouteEditor 注入请求头', () => {
  beforeEach(() => {
    vi.spyOn(api, 'domains').mockResolvedValue(configured([]));
    vi.spyOn(api, 'putRoute').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('点「加一行」就出现一行空输入 —— 第一行也不例外', async () => {
    const user = userEvent.setup();
    renderEditor();

    expect(screen.queryByLabelText('头名 1')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '加一行' }));

    expect(screen.getByLabelText('头名 1')).toHaveValue('');
    expect(screen.getByLabelText('值 1')).toHaveValue('');
  });

  it('连点两次就是两行，第二行不吃掉第一行', async () => {
    const user = userEvent.setup();
    renderEditor();

    const addRow = screen.getByRole('button', { name: '加一行' });
    await user.click(addRow);
    await user.type(screen.getByLabelText('头名 1'), 'x-first');
    await user.click(addRow);

    expect(screen.getByLabelText('头名 1')).toHaveValue('x-first');
    expect(screen.getByLabelText('头名 2')).toHaveValue('');
  });

  it('加行后打的字落进草稿', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole('button', { name: '加一行' }));
    await user.type(screen.getByLabelText('头名 1'), 'x-api-key');
    await user.type(screen.getByLabelText('值 1'), 'secret');

    expect(await saveDraft(user)).toMatchObject({ upstreamHeaders: { 'x-api-key': 'secret' } });
  });

  it('只写了头名的行照样落盘，值是空串 —— 先写名再补值是正常输入顺序', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole('button', { name: '加一行' }));
    await user.type(screen.getByLabelText('头名 1'), 'x-trace');

    expect(await saveDraft(user)).toMatchObject({ upstreamHeaders: { 'x-trace': '' } });
  });

  it('把唯一一行的头名删空：行留在原地，键从草稿里消失', async () => {
    const user = userEvent.setup();
    renderEditor(true, {
      upstream: 'origin.example.com',
      upstreamHeaders: { 'x-api-key': 'secret' },
    });

    await user.clear(screen.getByLabelText('头名 1'));

    // 行还在，值也还在 —— 改头名要先删空，这一步不能把人正在编辑的行抽走。
    expect(screen.getByLabelText('头名 1')).toHaveValue('');
    expect(screen.getByLabelText('值 1')).toHaveValue('secret');
    // 但草稿里不留空对象：一个有效头都没有 = 没设置这个键。
    expect(await saveDraft(user)).not.toHaveProperty('upstreamHeaders');
  });

  it('删到最后一行也能再加回来 —— 复位逻辑不会卡住空态', async () => {
    const user = userEvent.setup();
    renderEditor(true, {
      upstream: 'origin.example.com',
      upstreamHeaders: { 'x-api-key': 'secret' },
    });

    await user.click(screen.getByRole('button', { name: '删掉这一行' }));
    expect(screen.queryByLabelText('头名 1')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '加一行' }));
    expect(screen.getByLabelText('头名 1')).toHaveValue('');
  });
});

/**
 * CORS 与字面替换这两个 P1 子段（issue #38）。
 *
 * 焊的是同一类病：schema 里的子键掉进表单与「表单未覆盖」区之间的缝 —— 表单不
 * 渲染它，未覆盖区只看顶层键也不列它。JSON 里写 `cors: { credentials: true }` 切
 * 回表单，那个键就彻底隐形：数据还在，但没人看得见自己开着什么。
 *
 * credentials 单独焊一条「等于默认值不落键、段壳保留」—— 默认 false，开是落
 * true，关是删键；删到空对象等于把 CORS 整段关掉，是完全不同的一件事。
 *
 * replace 的 `from` 是 `z.string().min(1)`，空查找必被服务端拒。编辑器的选择是
 * 不把空 from 的行发出去，同时行留在原地 —— 「先写查找再补替换」是正常输入顺序，
 * 不许把人正在编辑的行抽走（与注入请求头同一教训）。
 */
describe('RouteEditor CORS 子段（issue #38）', () => {
  beforeEach(() => {
    vi.spyOn(api, 'domains').mockResolvedValue(configured([]));
    vi.spyOn(api, 'putRoute').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('JSON 里写的 credentials 切回表单看得见，改回来删键、段壳留着', async () => {
    const user = userEvent.setup();
    renderEditor(true, {
      upstream: 'origin.example.com',
      cors: { credentials: true },
    });

    const toggle = screen.getByRole('switch', { name: '允许携带凭据' });
    expect(toggle).toBeChecked();

    await user.click(toggle);
    const draft = await saveDraft(user);
    expect(draft).not.toHaveProperty('cors.credentials');
    expect(draft).toMatchObject({ cors: {} });
  });

  it('打开 credentials 落 true', async () => {
    const user = userEvent.setup();
    renderEditor(true, { upstream: 'origin.example.com', cors: {} });

    await user.click(screen.getByRole('switch', { name: '允许携带凭据' }));

    expect(await saveDraft(user)).toMatchObject({ cors: { credentials: true } });
  });

  it('maxAge 落数字，清空删键', async () => {
    const user = userEvent.setup();
    renderEditor(true, { upstream: 'origin.example.com', cors: {} });

    const input = screen.getByLabelText('预检结果缓存（秒）');
    await user.type(input, '600');
    expect(await saveDraft(user)).toMatchObject({ cors: { maxAge: 600 } });

    await user.clear(input);
    expect(await saveDraft(user)).not.toHaveProperty('cors.maxAge');
  });

  it('allowHeaders 逗号分隔落列表，清空删键', async () => {
    const user = userEvent.setup();
    renderEditor(true, { upstream: 'origin.example.com', cors: {} });

    const input = screen.getByLabelText('允许的请求头');
    await user.type(input, 'x-token, x-trace');
    expect(await saveDraft(user)).toMatchObject({
      cors: { allowHeaders: ['x-token', 'x-trace'] },
    });

    await user.clear(input);
    expect(await saveDraft(user)).not.toHaveProperty('cors.allowHeaders');
  });
});

describe('RouteEditor 字面替换（issue #38）', () => {
  beforeEach(() => {
    vi.spyOn(api, 'domains').mockResolvedValue(configured([]));
    vi.spyOn(api, 'putRoute').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('加一行写好查找与替换，落进草稿', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole('switch', { name: '改写响应体' }));
    await user.click(screen.getByRole('button', { name: '加一行替换' }));
    await user.type(screen.getByLabelText('查找 1'), 'cdn.origin.dev');
    await user.type(screen.getByLabelText('替换为 1'), 'proxy.example.com');

    expect(await saveDraft(user)).toMatchObject({
      bodyRewrite: {
        replace: [{ from: 'cdn.origin.dev', to: 'proxy.example.com' }],
      },
    });
  });

  it('查找为空的行不发出去，行也不消失 —— 先写查找再补替换是正常顺序', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(screen.getByRole('switch', { name: '改写响应体' }));
    await user.click(screen.getByRole('button', { name: '加一行替换' }));

    // 行还在原地可以继续打字；但草稿里没有这个键。
    expect(screen.getByLabelText('查找 1')).toHaveValue('');
    await user.type(screen.getByLabelText('替换为 1'), 'half-typed');
    expect(await saveDraft(user)).not.toHaveProperty('bodyRewrite.replace');

    expect(screen.getByLabelText('替换为 1')).toHaveValue('half-typed');
    await user.type(screen.getByLabelText('查找 1'), 'from');
    expect(await saveDraft(user)).toMatchObject({
      bodyRewrite: { replace: [{ from: 'from', to: 'half-typed' }] },
    });
  });

  it('JSON 里已有的 replace 原样显示，加一行接着写不吃掉已有行', async () => {
    const user = userEvent.setup();
    renderEditor(true, {
      upstream: 'origin.example.com',
      bodyRewrite: { replace: [{ from: 'a', to: 'b' }] },
    });

    expect(screen.getByLabelText('查找 1')).toHaveValue('a');
    await user.click(screen.getByRole('button', { name: '加一行替换' }));
    await user.type(screen.getByLabelText('查找 2'), 'c');
    await user.type(screen.getByLabelText('替换为 2'), 'd');

    expect(await saveDraft(user)).toMatchObject({
      bodyRewrite: {
        replace: [
          { from: 'a', to: 'b' },
          { from: 'c', to: 'd' },
        ],
      },
    });
  });

  it('把唯一一行的查找删空：行留着，键从草稿里消失', async () => {
    const user = userEvent.setup();
    renderEditor(true, {
      upstream: 'origin.example.com',
      bodyRewrite: { replace: [{ from: 'a', to: 'b' }] },
    });

    await user.clear(screen.getByLabelText('查找 1'));

    expect(screen.getByLabelText('替换为 1')).toHaveValue('b');
    expect(await saveDraft(user)).not.toHaveProperty('bodyRewrite.replace');
  });
});

/**
 * 访问控制这一段（issue #34）。
 *
 * 焊住三件事：
 * 1. 段的存在就是开关状态，与 cors/ip 同一套语义；CF 子表单的 team/audience
 *    要能一路落进草稿。
 * 2. keys 输入框粘哈希就地警示 —— 「存的是哈希不是 key 本身」必须发生在按下
 *    之前，而不是发布被服务端拦下之后。
 * 3. 关掉整段就不留空壳：`access: {}` 过不了 schema（两种机制至少配一种），
 *    留在草稿里只会把错误推迟到发布前才被人看见。
 */
describe('RouteEditor 访问控制（issue #34）', () => {
  const DIGEST = 'a'.repeat(64);

  beforeEach(() => {
    vi.spyOn(api, 'domains').mockResolvedValue(configured([]));
    vi.spyOn(api, 'putRoute').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('开启 CF 校验：team 与 audience 落进草稿', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('switch', { name: '身份验证（你是谁）' }));
    await user.click(screen.getByRole('switch', { name: '校验 Cloudflare Access 的 JWT' }));
    await user.type(screen.getByLabelText('team 名'), 'acme');
    await user.type(screen.getByLabelText('audience（AUD tag）'), 'app-aud');

    expect(await saveDraft(user)).toMatchObject({
      access: { cloudflare: { team: 'acme', audience: 'app-aud' } },
    });
  });

  it('粘哈希进 keys：警示就地出现，草稿存的就是这串哈希', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('switch', { name: '身份验证（你是谁）' }));
    await user.type(screen.getByLabelText('API key 的 SHA-256 哈希'), DIGEST);

    expect(screen.getByRole('alert')).toHaveTextContent('哈希，不是 key 本身');
    expect(await saveDraft(user)).toMatchObject({ access: { keys: [DIGEST] } });
  });

  it('关掉身份验证整段消失，草稿里不留过不了 schema 的空壳', async () => {
    const user = userEvent.setup();
    renderEditor(true, { upstream: 'origin.example.com', access: { keys: [DIGEST] } });

    const access = screen.getByRole('switch', { name: '身份验证（你是谁）' });
    expect(access).toBeChecked();
    await user.click(access);

    expect(await saveDraft(user)).not.toHaveProperty('access');
  });
});
