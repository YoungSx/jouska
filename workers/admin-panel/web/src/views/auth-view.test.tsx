import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthView } from './auth-view';
import type { MeResult } from '@/lib/api';

/**
 * 这一页只剩三种「进不来」，而三种都必须指向别处。
 *
 * 焊住的是同一条教训的两半：绝不能给一张解不开当前状态的表单。密码那扇门关掉之后
 * 面板连登录接口都没有了，所以任何账号/密码输入框、任何「登录」按钮出现在这里，
 * 都不是文案问题而是设计错了 —— 否定断言因此写得比正向断言还密。
 *
 * 页脚构建标识在生产里两串出自同一条 `git describe`、几乎总是一致，裸串是常态；
 * jsdom 没有构建注入，本页兜 'dev' 就永远和服务端串并排。这里配平它，让三张卡
 * 各自证明「服务端报的版本真的传到了页脚」——并排那个分支归 build-tag 自己的测试。
 */

beforeEach(() => {
  vi.stubGlobal('__BUILD_ID__', 'v0.16.0');
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthView：Access 已放行但面板还没这一行', () => {
  const pending: MeResult = { user: null, accessEmail: 'ops@example.com', build: 'v0.16.0' };

  it('说出是哪个地址、下一步找谁，并且没有任何表单', () => {
    render(<AuthView me={pending} loading={false} />);

    expect(screen.getByText(/ops@example\.com/)).toBeInTheDocument();
    expect(screen.getByText('还没有面板账号')).toBeInTheDocument();
    expect(screen.getByText(/让面板的管理员/)).toBeInTheDocument();
    // 这个状态只有别人的账号能解开，所以这里只该有一个「刷新」。
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled();
    // 页脚那行是服务端报的构建——被挡住的人唯一问得出口的版本问题在这。
    expect(screen.getByText('v0.16.0')).toBeInTheDocument();
    expect(screen.queryByLabelText('账号')).toBeNull();
    expect(screen.queryByLabelText('密码')).toBeNull();
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull();
  });

  it('这条路径压过 loading：地址已经知道了，就不该再显示骨架', () => {
    render(<AuthView me={pending} loading />);
    expect(screen.getByText('还没有面板账号')).toBeInTheDocument();
  });
});

describe('AuthView：这次部署没接上 Access', () => {
  const setup: MeResult = { user: null, identityNotConfigured: true, build: 'v0.16.0' };

  it('给部署者接线步骤，并且没有任何表单', () => {
    render(<AuthView me={setup} loading={false} />);

    expect(screen.getByText('面板的门还没接上')).toBeInTheDocument();
    expect(screen.getByText(/GitHub secrets/)).toBeInTheDocument();
    expect(screen.getByText(/ACCESS_TEAM/)).toBeInTheDocument();
    expect(screen.getByText(/ACCESS_AUD/)).toBeInTheDocument();
    expect(screen.getByText(/重新部署一次/)).toBeInTheDocument();
    // 部署者重部署后对版就靠这一串：卡上说的与页脚报的必须是同一个构建。
    expect(screen.getByText('v0.16.0')).toBeInTheDocument();
    // 步骤是给能改配置的人的；这里同样不该有登录表单或别的可解动作。
    expect(screen.queryByLabelText('账号')).toBeNull();
    expect(screen.queryByLabelText('密码')).toBeNull();
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull();
  });

  it('这条路径也压过 loading：服务端已经给出结论，骨架是倒退', () => {
    render(<AuthView me={setup} loading />);
    expect(screen.getByText('面板的门还没接上')).toBeInTheDocument();
  });
});

describe('AuthView：接了线，但这条请求没有 Access 身份', () => {
  it('只剩一句极简拒绝，不向陌生人解释内部接线', () => {
    render(<AuthView me={{ user: null, build: 'v0.16.0' }} loading={false} />);

    expect(screen.getByText('没有可用的入口')).toBeInTheDocument();
    expect(screen.getByText(/只对通过 Cloudflare Access 认证的人开放/)).toBeInTheDocument();
    // 陌生人的页面上不该出现内部细节：team 域名、变量名、找谁。
    expect(screen.queryByText(/GitHub secrets/)).toBeNull();
    expect(screen.queryByText(/ACCESS_/)).toBeNull();
    expect(screen.queryByText(/找部署的人/)).toBeNull();
    // 没有可点的动作：能改变这个状态的东西不在这个浏览器里。页脚那行构建除外
    // ——它不是接线细节，而是被拒者报问题时该带上的版本串。
    expect(screen.getByText('v0.16.0')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(/拦住你的服务/);
    expect(screen.queryByLabelText('账号')).toBeNull();
    expect(screen.queryByLabelText('密码')).toBeNull();
  });

  it('还在问 /me 的时候给骨架，不先扣一顶错误的帽子', () => {
    render(<AuthView me={null} loading />);
    expect(screen.queryByText('没有可用的入口')).toBeNull();
    expect(screen.queryByText('面板的门还没接上')).toBeNull();
  });
});
