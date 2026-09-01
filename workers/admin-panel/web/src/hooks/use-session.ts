/**
 * 会话状态。
 *
 * `/api/auth/me` 是这个 SPA 唯一的登录态来源，它同时回答两个问题：谁登录了，
 * 以及首次部署的引导表单该不该出现。两个答案必须一起拿，否则会出现"已经有账号
 * 了却还显示创建管理员"这种既误导又必然失败的状态。
 */
import * as React from 'react';
import { api, ApiError, NetworkError, type User } from '@/lib/api';

export type SessionState =
  | { readonly status: 'loading' }
  | { readonly status: 'authed'; readonly user: User }
  | { readonly status: 'anonymous'; readonly bootstrapable: boolean }
  /** 连不上服务器 —— 区别于"未登录"，因为该给的是重试而不是登录表单。 */
  | { readonly status: 'offline' };

export interface Session {
  readonly state: SessionState;
  readonly refresh: () => Promise<void>;
  readonly signIn: (user: User) => void;
  readonly signOut: () => Promise<void>;
  /** 任何请求撞上 401 时调用：把界面拉回登录页，而不是留在一个全是错误的页面上。 */
  readonly onUnauthenticated: () => void;
}

export const useSession = (): Session => {
  const [state, setState] = React.useState<SessionState>({ status: 'loading' });

  const refresh = React.useCallback(async () => {
    try {
      const { user, bootstrapable } = await api.me();
      setState(user === null ? { status: 'anonymous', bootstrapable } : { status: 'authed', user });
    } catch (error) {
      // 网络不通与"服务端说未登录"是两件事：前者给重试，后者给登录表单。
      setState(
        error instanceof NetworkError
          ? { status: 'offline' }
          : { status: 'anonymous', bootstrapable: false },
      );
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = React.useCallback((user: User) => {
    setState({ status: 'authed', user });
  }, []);

  const signOut = React.useCallback(async () => {
    try {
      await api.logout();
    } catch (error) {
      // 会话本来就无效也无妨，目标是回到登录页。只有网络故障值得让用户知道。
      if (error instanceof NetworkError) {
        setState({ status: 'offline' });
        return;
      }
    }
    // 退出后再问一次 me：如果这是最后一个账号被删的边缘情况，引导态要正确。
    await refresh();
  }, [refresh]);

  const onUnauthenticated = React.useCallback(() => {
    setState({ status: 'anonymous', bootstrapable: false });
  }, []);

  return { state, refresh, signIn, signOut, onUnauthenticated };
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
