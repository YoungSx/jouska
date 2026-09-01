/**
 * 草稿状态：路由表、defaults、以及"草稿与线上差在哪"。
 *
 * 这是闸门轨道的支点。面板的核心概念是「保存不等于上线」，所以任何一次写操作之
 * 后都必须重新问一次 `/api/preview` —— 它同时回答草稿能不能发布、线上是哪个
 * revision、以及草稿是否已经和线上不一致（服务端用文档指纹比对，见
 * src/fingerprint.ts）。
 *
 * 为什么不在前端自己算脏值：前端算出来的"改了 3 项"只是本次会话内的计数，刷新
 * 一下就归零，而且同事在另一个标签页里发布过之后它就是错的。指纹比对是可证明
 * 的，代价是每次写操作多一个 GET。
 */
import * as React from 'react';
import { api, type PreviewResult, type RouteEntry } from '@/lib/api';
import { errorCode } from './use-session';

export type PublishGate =
  /** 还在问服务端。 */
  | { readonly kind: 'loading' }
  /** 草稿是空的，还没开始 —— 引导，不报错。 */
  | { readonly kind: 'empty'; readonly live: number | null }
  /** 编译或校验不过，列出问题。 */
  | { readonly kind: 'blocked'; readonly preview: PreviewResult; readonly live: number | null }
  /** 可以发布，且草稿与线上不同。 */
  | { readonly kind: 'dirty'; readonly preview: PreviewResult; readonly live: number | null }
  /** 草稿与线上一致，没有待发布的东西。 */
  | { readonly kind: 'clean'; readonly preview: PreviewResult; readonly live: number }
  | { readonly kind: 'error'; readonly code: string };

export interface Draft {
  readonly routes: readonly RouteEntry[];
  readonly defaults: Record<string, unknown> | null;
  readonly gate: PublishGate;
  readonly loading: boolean;
  /** 重新拉全部草稿状态。写操作成功后调用。 */
  readonly reload: () => Promise<void>;
  /** 只重算闸门，不重拉路由表 —— 用在预览页的「重新检查」上。 */
  readonly recheck: () => Promise<void>;
}

const gateFrom = (preview: PreviewResult): PublishGate => {
  const live = preview.live?.revision ?? null;
  if (preview.empty === true) {
    return { kind: 'empty', live };
  }
  if (!preview.ok) {
    return { kind: 'blocked', preview, live };
  }
  // dirty 由服务端判定（指纹比对）。老版本服务端不返回这个字段，此时按"脏"处理：
  // 少一次"其实不用发布"的提示，好过让人以为已经上线了。
  if (preview.dirty === false && live !== null) {
    return { kind: 'clean', preview, live };
  }
  return { kind: 'dirty', preview, live };
};

export const useDraft = (enabled: boolean, onUnauthenticated: () => void): Draft => {
  const [routes, setRoutes] = React.useState<readonly RouteEntry[]>([]);
  const [defaults, setDefaults] = React.useState<Record<string, unknown> | null>(null);
  const [gate, setGate] = React.useState<PublishGate>({ kind: 'loading' });
  const [loading, setLoading] = React.useState(true);

  const recheck = React.useCallback(async () => {
    try {
      setGate(gateFrom(await api.preview()));
    } catch (error) {
      const code = errorCode(error);
      if (code === 'unauthenticated') {
        onUnauthenticated();
        return;
      }
      setGate({ kind: 'error', code });
    }
  }, [onUnauthenticated]);

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      // 三个请求互不依赖，并发发出；allSettled 让其中一个失败不至于把另外两个
      // 已经拿到的数据一起丢掉。
      const [routesResult, defaultsResult, previewResult] = await Promise.allSettled([
        api.listRoutes(),
        api.getDefaults(),
        api.preview(),
      ]);

      const rejected = [routesResult, defaultsResult, previewResult].find(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      if (rejected !== undefined && errorCode(rejected.reason) === 'unauthenticated') {
        onUnauthenticated();
        return;
      }

      if (routesResult.status === 'fulfilled') {
        setRoutes(routesResult.value);
      }
      if (defaultsResult.status === 'fulfilled') {
        setDefaults(defaultsResult.value);
      }
      if (previewResult.status === 'fulfilled') {
        setGate(gateFrom(previewResult.value));
      } else {
        setGate({ kind: 'error', code: errorCode(previewResult.reason) });
      }
    } finally {
      setLoading(false);
    }
  }, [onUnauthenticated]);

  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    void reload();
  }, [enabled, reload]);

  return { routes, defaults, gate, loading, reload, recheck };
};
