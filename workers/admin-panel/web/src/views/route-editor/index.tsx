/**
 * The route editor, as a page.
 *
 * It used to be a dialog. Thirty-odd fields never fit: on a phone the centred card
 * left 153px of form, and on a desktop the 672px column wasted two thirds of the
 * screen. More importantly a dialog covers the publish bar — so the editor had to
 * carry its own "this is a draft" strip, restating in words what the layout could
 * have shown. As a page it does show it: the editor's own actions sit at the top
 * (this one route → the draft) and the real publish bar stays at the bottom (the
 * whole draft → production). Two gates, two ends of the screen.
 *
 * Losing the dialog means picking up four things Base UI used to hand over for
 * free: Escape, focus placement, focus return and leave interception. They are all
 * wired here rather than in the draft hook, because they belong to "this is a page"
 * rather than to "this is a route".
 */
import * as React from 'react';
import { ChevronLeftIcon, SaveIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { t } from '@/lib/messages';
import { LIMITS } from '@/lib/types';
import type { RouteDefinition } from '@/lib/types';
import { ErrorIndex } from './error-index';
import { SectionAdvanced } from './section-advanced';
import { SectionDestination } from './section-destination';
import { SectionGuards } from './section-guards';
import { SectionIdentity } from './section-identity';
import { SectionJson } from './section-json';
import { useRouteDraft } from './use-route-draft';

export interface RouteEditorPageProps {
  /** Prefilled data; in create mode the definition may come from "duplicate". */
  readonly initial: { id: string; definition: RouteDefinition; enabled: boolean } | null;
  /** true: the ID is editable; false: the ID is read-only. */
  readonly createMode: boolean;
  /** Called after a successful save. */
  readonly onSaved: (id: string) => void;
  /** Action on the success toast; undefined hides the button. */
  readonly onGoPublish?: () => void;
  /** Leave the editor and go back to the route list. */
  readonly onExit: () => void;
}

export const RouteEditorPage = ({
  initial,
  createMode,
  onSaved,
  onGoPublish,
  onExit,
}: RouteEditorPageProps) => {
  /** 我们自己在收自己压的那条 history entry —— 别把它当成用户按了返回键。 */
  const leavingRef = React.useRef(false);
  const headingRef = React.useRef<HTMLHeadingElement>(null);

  const leave = React.useCallback(() => {
    leavingRef.current = true;
    // 收掉进入时压的 entry：历史里不留一条指向已经关掉的编辑器的记录。
    window.history.back();
    onExit();
  }, [onExit]);

  const draft = useRouteDraft({ initial, createMode, onSaved, onGoPublish, onExit: leave });

  /**
   * 窗口级监听要读最新的状态，但它只该绑一次（pushState 有副作用，effect 重跑会
   * 再压一条 entry）。所以状态走 ref，监听器的依赖表保持空。
   */
  const liveRef = React.useRef({
    dirty: draft.dirty,
    confirmDiscard: draft.confirmDiscard,
    requestClose: draft.requestClose,
    save: draft.save,
  });
  liveRef.current = {
    dirty: draft.dirty,
    confirmDiscard: draft.confirmDiscard,
    requestClose: draft.requestClose,
    save: draft.save,
  };

  /** 焦点落位：读屏念出「正在编辑哪条路由」，而且不会误改任何字段。 */
  React.useEffect(() => {
    headingRef.current?.focus();
  }, []);

  /**
   * 浏览器返回键。这是整页形态最容易踩空的一格：不接的话返回键会把人从整个面板里
   * 弹出去，而他以为只是退出编辑器。做法是进来压一条 entry，返回时按「取消」处理；
   * 草稿脏着就把 entry 补回去再问一次，答应放弃才真的走。
   */
  React.useEffect(() => {
    window.history.pushState({ jouskaRouteEditor: true }, '');
    const onPopState = () => {
      if (leavingRef.current) {
        return;
      }
      if (!liveRef.current.dirty) {
        onExit();
        return;
      }
      window.history.pushState({ jouskaRouteEditor: true }, '');
      draft.setConfirmDiscard(true);
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只绑一次：pushState 有副作用，状态走 liveRef。
  }, []);

  /**
   * Esc 与 ⌘/Ctrl+S。Dialog 从前免费提供 Esc；页面得自己接，而且要让开两种情况：
   * 弃改确认框开着时它自己处理 Esc，浮层（下拉、Popover）已经处理过的按键带着
   * defaultPrevented 过来。
   */
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || liveRef.current.confirmDiscard) {
        return;
      }
      if (event.key === 'Escape') {
        liveRef.current.requestClose();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        // 浏览器的「保存网页」在这个界面上没有任何用处，拦下来换成保存草稿。
        event.preventDefault();
        void liveRef.current.save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/*
        动作栏：作用对象是「这一条路由」。它 sticky 在 App 顶栏正下方 —— 高度取
        --panel-header-height，两处引用同一个变量，顶栏改高时不会露出一条缝。
        窄屏顶栏让位（编辑页接管整屏），所以那一档贴 top-0。
      */}
      <div className="bg-background/95 sticky top-0 z-20 -mx-4 flex flex-col gap-1 border-b px-4 py-2 backdrop-blur sm:top-(--panel-header-height)">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => draft.requestClose()}>
            <ChevronLeftIcon />
            {t.editor.backToRoutes}
          </Button>
          {/* 页面标题即路由标识：新建时说「新建」，编辑时就是那串 ID（等宽，要核对）。 */}
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="truncate font-mono text-sm font-medium outline-none"
          >
            {createMode ? t.editor.createTitle : draft.initialId}
          </h1>
          <Badge variant="secondary" title={t.editor.draftBannerHint}>
            {t.editor.draftBanner}
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            <ErrorIndex draft={draft} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => draft.requestClose()}
              disabled={draft.saving}
            >
              {t.editor.cancel}
            </Button>
            <Button
              size="sm"
              onClick={() => void draft.save()}
              disabled={draft.blocked}
              title={t.editor.saveShortcut}
            >
              {draft.saving ? <Spinner /> : <SaveIcon />}
              {draft.saving ? t.editor.saving : t.editor.save}
            </Button>
          </div>
        </div>
        {/* 窄屏没有发布栏（让位给编辑页），这一行是「保存≠上线」唯一的说明处。 */}
        <p className="text-muted-foreground text-xs sm:hidden">{t.editor.draftBannerHint}</p>
      </div>

      {/*
        两条拦住保存却没法「跳过去修」的问题：超上限是整份定义的体积，JSON 坏了是
        另一个视图的事。它们不进错误索引（那份清单每条都要能跳到一个字段），改成
        常驻的 Alert —— 官方件，语义就是「这里有话要说」。
      */}
      {draft.tooBig && (
        <Alert variant="destructive">
          <AlertDescription>{t.editor.tooBig(LIMITS.definitionBytes / 1024)}</AlertDescription>
        </Alert>
      )}
      {draft.jsonError !== null && draft.tab === 'form' && (
        <Alert variant="destructive">
          <AlertDescription>{t.editor.saveBlocked(t.editor.jsonInvalid)}</AlertDescription>
        </Alert>
      )}

      {/* 标识在 tabs 外：ID 与启用开关都不属于 definition，写 JSON 时也得能改。 */}
      <SectionIdentity draft={draft} />

      <Tabs value={draft.tab} onValueChange={draft.handleTabChange}>
        <TabsList>
          <TabsTrigger value="form">{t.editor.tabForm}</TabsTrigger>
          <TabsTrigger value="json">{t.editor.tabJson}</TabsTrigger>
        </TabsList>

        <TabsContent value="form">
          {/*
            双列分区，不是把字段蛇形铺开：左列每一样都是「不填上不了线」，右列每一样
            都可以留空 —— 右列一栏「未设置」本身就是「你已经安全了」这句话的形态。
            lg（64rem）才分栏：条件行一行五个控件，列宽不足 480px 就挤爆。
            items-start 让两列各自按内容高度收，不被更长的那列拉齐。
          */}
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-6">
              <SectionDestination draft={draft} />
            </div>
            <div className="flex min-w-0 flex-col gap-6">
              <SectionGuards draft={draft} />
              <SectionAdvanced draft={draft} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="json">
          <SectionJson draft={draft} />
        </TabsContent>
      </Tabs>

      {/*
        弃改确认用 AlertDialog 而不是 Dialog：它的语义就是「这一步要人明确答一句」
        —— 点外面不关、Esc 由它自己接、Cancel 与 Action 是成对的官方子件。
        从前这里是 Dialog 里套 Dialog，那是为了借外层弹窗的 Esc 派发顺序；页面化之后
        那个理由消失了，套娃也就没必要了。
      */}
      <AlertDialog
        open={draft.confirmDiscard}
        onOpenChange={(next: boolean) => {
          if (!next) {
            draft.setConfirmDiscard(false);
          }
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t.editor.discardTitle}</AlertDialogTitle>
            <AlertDialogDescription>{t.editor.discardBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => draft.setConfirmDiscard(false)}>
              {t.editor.discardCancel}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                draft.setConfirmDiscard(false);
                draft.onExit();
              }}
            >
              {t.editor.discardConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
