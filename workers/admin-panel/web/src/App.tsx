import * as React from 'react';
import { ChevronDownIcon, LogOutIcon, MenuIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { BuildTagFooter } from '@/components/build-tag';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PublishBar } from '@/components/publish-bar';
import { PublishDialog } from '@/components/publish-dialog';
import { DiscardDialog } from '@/components/discard-dialog';
import { ViewErrorBoundary } from '@/components/error-boundary';
import { ThemeToggle } from '@/components/theme-toggle';
import { AuthView } from '@/views/auth-view';
import { AuditView } from '@/views/audit-view';
import { DomainsView } from '@/views/domains-view';
import { HistoryView } from '@/views/history-view';
import { McpTokensView } from '@/views/mcp-tokens-view';
import { PreviewView } from '@/views/preview-view';
import { RouteEditorPage } from '@/views/route-editor';
import { RoutesView } from '@/views/routes-view';
import { UsersView } from '@/views/users-view';
import { useDraft } from '@/hooks/use-draft';
import { errorCode, useSession } from '@/hooks/use-session';
import { api, type RouteEntry, type User } from '@/lib/api';
import { isUsableDefinition } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/messages';
import type { RouteDefinition } from '@/lib/types';

/**
 * 应用外壳：会话、导航、闸门轨道的接线处。
 *
 * 这个文件不做业务判断 —— 它只把 useSession（谁在用）、useDraft（草稿与线上差多
 * 少）和各个视图缝在一起。发布栏常驻底部，意味着无论操作者此刻在哪一页，「线上
 * 正在服务哪一版」这个问题始终有答案。
 */

type View = 'routes' | 'domains' | 'preview' | 'audit' | 'users' | 'history' | 'mcp-tokens';

interface NavItem {
  readonly id: View;
  readonly label: string;
  readonly planned?: boolean;
  /** admin 专属页：viewer 的导航里整个不出现，而不是点进去吃 403。 */
  readonly adminOnly?: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: 'routes', label: t.nav.routes },
  { id: 'domains', label: t.nav.domains },
  { id: 'preview', label: t.nav.preview },
  { id: 'audit', label: t.nav.audit },
  { id: 'history', label: t.nav.history },
  { id: 'users', label: t.nav.users, adminOnly: true },
  { id: 'mcp-tokens', label: t.nav.mcp, adminOnly: true },
];

const App = () => {
  const session = useSession();
  const [view, setView] = React.useState<View>('routes');

  /* 顶栏导航在窄屏下可横滚；「滚到头了没有」只驱动右缘淡出的显示，不参与渲染分支。 */
  const navRef = React.useRef<HTMLElement | null>(null);
  const syncNavTail = React.useCallback(() => {
    navRef.current?.classList.toggle(
      'scroll-tail',
      navRef.current.scrollWidth - navRef.current.scrollLeft - navRef.current.clientWidth > 1,
    );
  }, []);
  /* 视口宽度变化（旋转、分屏）会改变是否溢出；Web 字体（Geist、CJK 徽标字）
     晚于首帧加载也会改变文字宽度——fonts.ready 后补测一次，淡出才不陈旧。 */
  React.useEffect(() => {
    syncNavTail();
    window.addEventListener('resize', syncNavTail);
    document.fonts.ready.then(syncNavTail).catch(() => undefined);
    return () => window.removeEventListener('resize', syncNavTail);
  }, [syncNavTail]);

  const draft = useDraft(session.state.status === 'authed', session.onUnauthenticated);
  const isAdmin = session.state.status === 'authed' && session.state.user.role === 'admin';

  /* ---------- 弹窗状态：发布、删除确认。编辑器不在其中——它是一个页面。 ---------- */
  const [editor, setEditor] = React.useState<{
    initial: { id: string; definition: RouteDefinition; enabled: boolean };
    createMode: boolean;
  } | null>(null);
  /**
   * 编辑器是页面而不是弹窗，所以没有 open 状态：`editor !== null` 就是「正在编辑」。
   *
   * 焦点得自己还回去 —— 从前是 Dialog 免费做的。进编辑器时记下当时聚焦的那个元素
   * （通常是某一行的编辑按钮），回列表时把焦点放回去，键盘用户不会掉到页首。
   */
  const editorReturnFocus = React.useRef<HTMLElement | null>(null);
  const [publishOpen, setPublishOpen] = React.useState(false);
  const [discardOpen, setDiscardOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<RouteEntry | null>(null);

  const reloadQuietly = React.useCallback(() => {
    void draft.reload();
  }, [draft.reload]);

  /* ---------- 编辑器入口。 ---------- */

  /** 复制件需要一个不与现有路由冲突的 ID —— 服务端会拒绝重复 ID，别把错留给它。 */
  const suggestCopyId = (base: string): string => {
    const taken = new Set(draft.routes.map((route) => route.id));
    if (!taken.has(`${base}-copy`)) {
      return `${base}-copy`;
    }
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-copy-${String(n)}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
  };

  const suggestNewId = (): string => {
    const taken = new Set(draft.routes.map((route) => route.id));
    for (let n = 1; ; n += 1) {
      const candidate = `route-${String(n)}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
  };

  const openEditor = (
    initial: { id: string; definition: RouteDefinition; enabled: boolean },
    createMode: boolean,
  ) => {
    // 记下从哪儿进来的，退出时把焦点还回去。
    editorReturnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditor({ initial, createMode });
  };

  /** 退出编辑页：清状态并把焦点还给当初那个按钮（它可能已经不在，所以是可选调用）。 */
  const closeEditor = () => {
    setEditor(null);
    const target = editorReturnFocus.current;
    editorReturnFocus.current = null;
    // 等列表重新挂上再还焦点，否则聚焦的是一个正在被卸载的节点。
    window.setTimeout(() => target?.focus(), 0);
  };

  const onCreate = () => {
    openEditor({ id: suggestNewId(), definition: {}, enabled: true }, true);
  };

  const onEdit = (route: RouteEntry) => {
    // 不可用的定义不进编辑器 —— routes-view 已经把入口禁掉，这里再挡一层。
    if (!isUsableDefinition(route.definition)) {
      return;
    }
    openEditor({ id: route.id, definition: route.definition, enabled: route.enabled }, false);
  };

  const onDuplicate = (route: RouteEntry) => {
    if (!isUsableDefinition(route.definition)) {
      return;
    }
    // 深拷贝：编辑器里改动不能回流到原路由的定义。
    const definition = JSON.parse(JSON.stringify(route.definition)) as RouteDefinition;
    openEditor({ id: suggestCopyId(route.id), definition, enabled: route.enabled }, true);
  };

  /* ---------- 路由写操作。 ---------- */

  /** 401 之外的写失败进 toast —— 会话失效则整页回到登录。 */
  const handleWriteError = (error: unknown, fallback: (message: string) => string) => {
    if (errorCode(error) === 'unauthenticated') {
      session.onUnauthenticated();
      return;
    }
    toast.error(fallback(error instanceof Error ? error.message : t.common.unknownError));
  };

  const onDelete = async () => {
    const target = deleteTarget;
    if (target === null) {
      return;
    }
    setDeleteTarget(null);
    try {
      await api.deleteRoute(target.id);
      toast.success(t.routes.deleted(target.id));
      reloadQuietly();
    } catch (error) {
      handleWriteError(error, t.routes.actionFailed);
    }
  };

  const onMove = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draft.routes.length) {
      return;
    }
    const ids = draft.routes.map((route) => route.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    try {
      await api.reorderRoutes(ids);
      toast.success(t.routes.reordered);
      reloadQuietly();
    } catch (error) {
      handleWriteError(error, t.routes.actionFailed);
    }
  };

  const onSaveDefaults = async (defaults: Record<string, unknown>) => {
    try {
      await api.putDefaults(defaults);
      toast.success(t.defaults.saved);
      reloadQuietly();
    } catch (error) {
      handleWriteError(error, t.routes.actionFailed);
      // 抛回去让 DefaultsCard 的保存按钮停下来 —— 静默失败会让人以为存上了。
      throw error;
    }
  };

  /* ---------- 预览页拿到的门。 ---------- */

  const previewForPage = (() => {
    switch (draft.gate.kind) {
      case 'empty':
        // 门已经知道草稿是空的；把这份事实交给预览页的空态分支。
        return { ok: true, empty: true as const };
      case 'blocked':
      case 'dirty':
      case 'clean':
        return draft.gate.preview;
      default:
        return null;
    }
  })();

  /** 每条路由命中的危险字段路径，行内就地标出。 */
  const dangersByRoute: Record<string, readonly string[]> = (() => {
    const gate = draft.gate;
    if (gate.kind !== 'dirty' && gate.kind !== 'blocked' && gate.kind !== 'clean') {
      return {};
    }
    const paths: Record<string, readonly string[]> = {};
    for (const [routeId, risks] of Object.entries(gate.preview.dangers ?? {})) {
      paths[routeId] = risks.map((risk) => risk.path);
    }
    return paths;
  })();

  /* ---------- 会话的三种非登录态。 ---------- */

  if (session.state.status === 'loading') {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10" aria-busy>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  if (session.state.status === 'offline') {
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        <Card>
          <CardHeader>
            <CardTitle>{t.common.networkError}</CardTitle>
            <CardDescription>{t.app.title}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => void session.refresh()}>
              <RefreshCwIcon />
              {t.common.retry}
            </Button>
          </CardContent>
        </Card>
        {/* 连服务端都答不上话，剩下的唯一一串是浏览器里这份 JS 自己的。 */}
        <BuildTagFooter />
      </div>
    );
  }

  if (session.state.status === 'anonymous') {
    return (
      <>
        <AuthView
          me={{
            user: null,
            ...(session.state.accessEmail === undefined
              ? {}
              : { accessEmail: session.state.accessEmail }),
            ...(session.state.identityNotConfigured === true
              ? { identityNotConfigured: true }
              : {}),
            ...(session.state.build === undefined ? {} : { build: session.state.build }),
          }}
          loading={false}
        />
        <Toaster position="top-center" richColors />
      </>
    );
  }

  const user: User = session.state.user;

  return (
    <div className="flex min-h-dvh flex-col">
      {/* 键盘可达性是硬要求（PRODUCT.md）：先给读屏与键盘用户一条直达内容的路。 */}
      <a
        href="#main"
        className="bg-primary text-primary-foreground sr-only z-50 rounded-md px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t.nav.skipToContent}
      </a>

      {/*
        编辑期间窄屏让位：手机上编辑页接管整屏（那正是从前全高 sheet 想要的效果，
        只是它当时得靠一堆弹窗补丁才拿到）。高度写成 h-（不是 py-），因为
        --panel-header-height 是这根栏和编辑页动作栏之间的契约。
      */}
      <header
        className={cn(
          'bg-background/95 sticky top-0 z-30 border-b backdrop-blur',
          editor !== null && 'max-sm:hidden',
        )}
      >
        <div className="mx-auto flex h-(--panel-header-height) max-w-6xl items-center gap-2.5 px-4 sm:gap-4">
          <div className="shrink-0">
            <div className="text-sm leading-tight font-semibold tracking-tight">{t.app.name}</div>
            <div className="text-muted-foreground text-xs leading-tight">{t.app.subtitle}</div>
          </div>

          {/* 桌面：导航全部平铺（Tabs）。窄屏：收进一个官方 DropdownMenu，当前页打勾。
              两条路指向同一份 NAV_ITEMS 与同一个 view 状态，不会漂移成两套导航。 */}
          <nav
            ref={navRef}
            onScroll={syncNavTail}
            className="nav-scroll hidden min-w-0 flex-1 sm:block"
            aria-label={t.app.title}
          >
            <Tabs value={view} onValueChange={(value) => setView(value as View)}>
              <TabsList>
                {NAV_ITEMS.filter((item) => item.adminOnly !== true || isAdmin).map((item) => (
                  /*
                    编辑期间导航停用而不是消失（DESIGN.md：disabled 留在原位配 title
                    说明原因）。换页会卸载编辑页，未保存的改动就没了 —— 与其在这里
                    再造一套跨组件的脏态确认，不如把这条路先关上，并说清怎么开。
                  */
                  <TabsTrigger
                    key={item.id}
                    value={item.id}
                    disabled={editor !== null}
                    title={editor !== null ? t.nav.blockedByEditor : undefined}
                  >
                    {item.label}
                    {item.planned === true && (
                      <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[10px]">
                        {t.planned.badge}
                      </Badge>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </nav>
          <nav className="min-w-0 flex-1 sm:hidden" aria-label={t.app.title}>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="sm" aria-label={t.nav.menu}>
                    <MenuIcon />
                    {NAV_ITEMS.find((item) => item.id === view)?.label ?? ''}
                  </Button>
                }
              />
              <DropdownMenuContent align="start" className="min-w-44">
                {NAV_ITEMS.map((item) => (
                  <DropdownMenuCheckboxItem
                    key={item.id}
                    checked={item.id === view}
                    disabled={editor !== null}
                    onCheckedChange={() => setView(item.id)}
                    // Base UI 对 CheckboxItem 的默认是点了留在菜单里（多选语义）；
                    // 导航是单选，点了就得走。
                    closeOnClick
                    className="py-3"
                  >
                    {item.label}
                    {item.planned === true && (
                      <Badge variant="secondary" className="ml-1.5 px-1.5 py-0 text-[10px]">
                        {t.planned.badge}
                      </Badge>
                    )}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </nav>

          <div className="flex shrink-0 items-center gap-1.5">
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="sm" aria-label={t.account.menu}>
                    <span className="max-w-16 truncate font-mono text-xs sm:max-w-32">
                      {user.subject}
                    </span>
                    <Badge variant={isAdmin ? 'default' : 'secondary'}>
                      {isAdmin ? t.account.admin : t.account.viewer}
                    </Badge>
                    {/* 名字 + 角色单独看不出这是个菜单。给一个会翻转的雪佛龙，
                        「能点开」和「已经点开」都不用猜。 */}
                    <ChevronDownIcon className="text-muted-foreground transition-transform group-aria-expanded/button:rotate-180" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-44">
                {/* DropdownMenuGroup 不是装饰：Base UI 的 GroupLabel 会把自己的 id 注册
                    进父 Group 的 aria-labelledby，脱离 Group 就直接抛异常，而渲染期抛出
                    的异常会卸载整棵 React 树 —— 症状是点一下用户名，整个面板变黑屏。
                    这里的分组也确实成立：下面两项操作的对象就是标签里这个账号。 */}
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="font-mono text-xs">
                    {user.subject}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => {
                      setView('routes');
                      void session.signOut();
                    }}
                  >
                    <LogOutIcon />
                    {t.account.logout}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-8">
        {/* 视图级兜底。头部与发布栏留在 boundary 外面，所以「这一页崩了」不会
            连带退出登录一起消失。key 换了就重建 boundary —— 它不会自己复位，
            缺了 key 就会一直停在错误卡片上。 */}
        {editor !== null ? (
          /*
            编辑器占掉整个内容区，而不是盖在它上面。这样底部那根真发布栏留在原位：
            上面那道闸是「这一条路由 → 草稿」，下面那道是「整份草稿 → 生产」，
            两道门同时看得见，「保存≠上线」不再需要靠一句话来解释。
          */
          <ViewErrorBoundary key="route-editor">
            <RouteEditorPage
              initial={editor.initial}
              createMode={editor.createMode}
              onSaved={() => {
                closeEditor();
                reloadQuietly();
              }}
              // 保存成功的 toast 带一扇「去发布」的门：草稿写完的下一步就是发布。
              onGoPublish={() => {
                reloadQuietly();
                setPublishOpen(true);
              }}
              onExit={closeEditor}
            />
          </ViewErrorBoundary>
        ) : (
          <ViewErrorBoundary key={view}>
            {view === 'routes' && (
              <RoutesView
                routes={draft.routes}
                defaults={draft.defaults}
                loading={draft.loading}
                isAdmin={isAdmin}
                dangersByRoute={dangersByRoute}
                onCreate={onCreate}
                onEdit={onEdit}
                onDuplicate={onDuplicate}
                onDelete={setDeleteTarget}
                onMove={(index, direction) => void onMove(index, direction)}
                onSaveDefaults={onSaveDefaults}
              />
            )}
            {view === 'domains' && <DomainsView />}
            {view === 'preview' && (
              <PreviewView
                preview={previewForPage}
                liveRevision={draft.gate.kind === 'clean' ? draft.gate.live : null}
                loading={draft.loading}
                isAdmin={isAdmin}
                onRefresh={() => void draft.recheck()}
                onPublish={() => setPublishOpen(true)}
                onGoRoutes={() => setView('routes')}
              />
            )}
            {view === 'audit' && <AuditView />}
            {view === 'history' && (
              <HistoryView isAdmin={isAdmin} onConfigChanged={reloadQuietly} />
            )}
            {view === 'users' && (
              <UsersView
                selfSubject={user.subject}
                onSelfRoleChanged={() => void session.refresh()}
              />
            )}
            {view === 'mcp-tokens' && (
              <McpTokensView onUnauthenticated={session.onUnauthenticated} />
            )}
          </ViewErrorBoundary>
        )}
      </main>

      {/* 闸门轨道：无论在哪一页，草稿与线上的差异都摆在这里。 */}
      <PublishBar
        className={editor !== null ? 'max-sm:hidden' : undefined}
        gate={draft.gate}
        canPublish={isAdmin}
        publishing={false}
        onPublish={() => setPublishOpen(true)}
        onReview={() => setView('preview')}
        onDiscard={() => setDiscardOpen(true)}
      />

      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        preview={draft.gate.kind === 'dirty' ? draft.gate.preview : null}
        onPublished={() => {
          setPublishOpen(false);
          reloadQuietly();
        }}
      />

      {/* 弹窗要显示的 liveRevision：按钮只在 dirty/blocked 且 live 非空时出现，
          所以这里必然拿得到；null 只是类型上的余量。 */}
      <DiscardDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        liveRevision={
          (draft.gate.kind === 'clean'
            ? draft.gate.live
            : draft.gate.kind === 'dirty' || draft.gate.kind === 'blocked'
              ? draft.gate.live
              : null) ?? 0
        }
        onDiscarded={() => {
          setDiscardOpen(false);
          reloadQuietly();
        }}
      />

      <DeleteRouteDialog
        target={deleteTarget}
        onDismiss={() => setDeleteTarget(null)}
        onConfirm={() => void onDelete()}
      />

      <Toaster position="top-center" richColors />
    </div>
  );
};

/** 删除路由的确认弹窗。删除是写操作，必须问过一次；理由写在正文里而不是标题上。 */
const DeleteRouteDialog = ({
  target,
  onDismiss,
  onConfirm,
}: {
  target: RouteEntry | null;
  onDismiss: () => void;
  onConfirm: () => void;
}) => (
  <Dialog open={target !== null} onOpenChange={(open: boolean) => open || onDismiss()}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{target === null ? '' : t.routes.deleteTitle(target.id)}</DialogTitle>
        <DialogDescription>{t.routes.deleteBody}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onDismiss}>
          {t.common.cancel}
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          <Trash2Icon />
          {t.routes.deleteConfirm}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export default App;
