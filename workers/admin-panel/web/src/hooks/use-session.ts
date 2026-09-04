/**
 * 会话状态。
 *
 * `/api/auth/me` 是这个 SPA 唯一的登录态来源。它跑的是中间件同一套 `authenticate`,
 * 所以「这一页该显示什么」和「下一个请求会不会被拒」永远是同一个答案 —— 两套实现
 * 迟早会分叉，而分叉出来的那一面一定是误导人的那一面。
 */
import * as React from 'react';
import { api, ApiError, NetworkError, type User } from '@/lib/api';

export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'authed'; readonly user: User }
  | {
      readonly status: 'anonymous';
      /**
       * Access 放进来了，但 users 表里没这个地址。界面要说「找管理员加一下」——
       * 这个状态只有别人的账号能解开。
       */
      readonly accessEmail?: string;
    }
  /** 连不上服务器 —— 区别于"未登录"，因为该给的是重试而不是登录表单。 */
  | { readonly status: 'offline' };

export interface Session {
  readonly state: SessionState;
  readonly refresh: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  /** 任何请求撞上 401 时调用：把界面拉回登录页，而不是留在一个全是错误的页面上。 */
  readonly onUnauthenticated: () => void;
}

export const useSession = (): Session => {
  const [state, setState] = React.useState<SessionState>({ status: 'loading' });

  const refresh = React.useCallback(async () => {
    try {
      const { user, accessEmail } = await api.me();
      setState(
        user === null
          ? { status: 'anonymous', ...(accessEmail === undefined ? {} : { accessEmail }) }
          : { status: 'authed', user },
      );
    } catch (error) {
      // 网络不通与"服务端说未登录"是两件事：前者给重试，后者给登录表单。
      setState(error instanceof NetworkError ? { status: 'offline' } : { status: 'anonymous' });
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = React.useCallback(async () => {
    try {
      const { accessLogout } = await api.logout();
      if (accessLogout !== undefined) {
        // 真正的退出是这一跳：撤销发生在边缘，要浏览器带着 CF_Authorization 走一趟。
        // 服务端替你 fetch 一下是不算的。注意它是**全局**的——Access 不支持只退出
        // 单个应用，所以这一跳会把这个人从组织里所有 Access 应用退出。
        globalThis.location.assign(accessLogout);
        return;
      }
    } catch (error) {
      // 会话本来就无效也无妨，目标是回到登录页。只有网络故障值得让用户知道。
      if (error instanceof NetworkError) {
        setState({ status: 'offline' });
        return;
      }
    }
    // 没有 accessLogout（Access 没配，也就没有会话可退）时至少把状态问回来，
    // 让界面停在「需要 Access」而不是假装还登录着。
    await refresh();
  }, [refresh]);

  const onUnauthenticated = React.useCallback(() => {
    setState({ status: 'anonymous' });
  }, []);

  return { state, refresh, signOut, onUnauthenticated };
};

/** 把 API 异常翻成一个稳定的错误码，供文案表查找。 */
export const errorCode = (error: unknown): string => {
  if (error instanceof ApiError) {
    return error.code;
  }
  if (error instanceof NetworkError) {
    return 'network_error';
  }
  return 'unknown';
};
