/**
 * The route editor's entire draft state: field values, validation, JSON projection,
 * dirty tracking and the save call.
 *
 * Split out of the view because the page renders the same draft in two very
 * different layouts (two columns on a wide screen, one on a phone) and in two
 * views (form and raw JSON). Keeping the writes in one hook is what stops those
 * four combinations from drifting into four sets of rules.
 *
 * Every write funnels through setDefinition so that "the operator touched this
 * form" is recorded exactly once, and so that a value equal to the schema default
 * deletes its key instead of writing it — the published diff then only mentions
 * decisions the operator actually made.
 */
import * as React from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { HostBinding } from '@/lib/api';
import { jsonByteLength, stableStringify } from '@/lib/format';
import { t } from '@/lib/messages';
import {
  BODY_REWRITE_BOOLEAN_DEFAULTS,
  BOOLEAN_DEFAULTS,
  FORM_COVERED_KEYS,
  HTTP_METHODS,
  LIMITS,
} from '@/lib/types';
import type { MatchCondition, RouteDefinition } from '@/lib/types';
import { ADVANCED_ITEMS, initialOpenFor } from './constants';
import type {
  AdvancedItem,
  BodyRewriteBooleanKey,
  BooleanKey,
  FieldErrors,
  SectionKey,
} from './constants';
import type { ConditionRow } from './editors';
import { conditionFromRow } from './editors';
import { collectErrors, reservedHeaderNames, reservedNamesIn, saveErrorMessage } from './errors';
import { toHostOptions } from './fields';
import { jsonErrorLocation } from './parts';

export interface RouteDraftInput {
  /** Prefilled data; in create mode the definition may come from "duplicate". */
  readonly initial: { id: string; definition: RouteDefinition; enabled: boolean } | null;
  /** true: the ID is editable; false: the ID is read-only. */
  readonly createMode: boolean;
  /** Called after a successful save (the caller reloads the draft and leaves). */
  readonly onSaved: (id: string) => void;
  /** Action on the success toast; undefined hides the button. */
  readonly onGoPublish?: () => void;
  /** Leave the editor without saving. */
  readonly onExit: () => void;
}

export const useRouteDraft = ({
  initial,
  createMode,
  onSaved,
  onGoPublish,
  onExit,
}: RouteDraftInput) => {
  const initialId = initial?.id ?? '';
  const initialEnabled = initial?.enabled ?? true;
  const initialDefinition = initial?.definition ?? {};

  const [id, setId] = React.useState(initialId);
  const [enabled, setEnabled] = React.useState(initialEnabled);
  const [definition, setDefinitionState] = React.useState<RouteDefinition>(initialDefinition);
  /**
   * 「用户动过这个表单没有」——任何一次写入（definition、id、enabled）都置位，
   * 且不回头。不能拿 dirty 代替：新建模式 definition 初始为空对象，打一个字再
   * 清掉就回到初始签名，dirty 变 false，错误会重新藏起来——但用户确实动过手，
   * 错误该继续见人。也不用「点了保存」当信号：保存按钮在有错时是禁用的，
   * 点击根本不会触发。
   */
  const [formTouched, setFormTouched] = React.useState(false);
  /** 所有写入走这一扇门：写 definition 的同时标记「动过」。 */
  const setDefinition: React.Dispatch<React.SetStateAction<RouteDefinition>> = (update) => {
    setFormTouched(true);
    setDefinitionState(update);
  };
  const [tab, setTab] = React.useState<'form' | 'json'>('form');
  // JSON 文本是 definition 的投影：进入 JSON 视图时按需生成，编辑时逐键解析。
  const [jsonText, setJsonText] = React.useState('');
  const [jsonError, setJsonError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  /**
   * 已绑定域名候选（issue #19）。null = 还在读。读不到的原因（未配凭据、接口
   * 失败、账号没绑定）不在这里区分 —— UI 结果一样：没候选 + 一行低调小字，
   * 原因的解释是域名页的职责。
   */
  const [hostBindings, setHostBindings] = React.useState<readonly HostBinding[] | null>(null);

  /**
   * 两组手风琴的展开集合。初始值 = 已有内容的卡自动展开；之后由用户自由收展，
   * 徽章始终报状态，收起不丢数据。
   */
  const [guardsOpen, setGuardsOpen] = React.useState<string[]>(() =>
    initialOpenFor(initialDefinition),
  );
  const [advancedOpen, setAdvancedOpen] = React.useState<string[]>(() =>
    initialOpenFor(initialDefinition).filter((item): item is AdvancedItem =>
      (ADVANCED_ITEMS as readonly string[]).includes(item),
    ),
  );

  /** jsonText 反映的是哪个版本的 definition（稳定序列化签名）。 */
  const jsonSignature = React.useRef<string | null>(null);

  const initialSignature = React.useMemo(
    () => stableStringify(initialDefinition),
    [initialDefinition],
  );
  // 键顺序不算改动，所以脏检查用稳定序列化。
  const dirty =
    stableStringify(definition) !== initialSignature ||
    id !== initialId ||
    enabled !== initialEnabled;

  /**
   * 进一次编辑页读一次：绑定可能在上次编辑之后变了；服务端有 60s 缓存兜底。
   *
   * 这个页面每次进入都是新挂载（App 用 editor 状态换掉整个内容区），所以挂载时
   * 跑一次就够 —— 从前那个 `[open]` 依赖是弹窗常驻 DOM 时代的遗留。
   */
  React.useEffect(() => {
    let cancelled = false;
    api.domains().then(
      (result) => {
        if (!cancelled) {
          setHostBindings(result.configured ? (result.hosts ?? []) : []);
        }
      },
      () => {
        if (!cancelled) {
          setHostBindings([]);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // 同一 host 可能来自多个 kind：Map 去重以第一次出现的为准，保 API 顺序。
  const hostOptions = hostBindings === null ? [] : toHostOptions(hostBindings);

  const errors = collectErrors(createMode, id, definition);
  const hasErrors = Object.keys(errors).length > 0;
  const tooBig = jsonByteLength(definition) > LIMITS.definitionBytes;
  // JSON 没修好 / 校验没过 / 超上限，三者都会被服务端或预览拒绝，先在这里拦住。
  const blocked = saving || jsonError !== null || hasErrors || tooBig;
  /**
   * 亮不亮是展示，拦不拦是规则：blocked 用全量 errors（保存必须真被拦），
   * 展示层（红框、卡徽章、页脚摘要）用 shownErrors。新建模式第一屏还没有用户
   * 输入，id/upstream 的「还没写」错误先静音——pristine 时也只可能有这两种错
   * （其余错误都需要先写内容），静音零损失。编辑模式永远全显：那里的数据是
   * 真实存在的，有问题该立刻见人。
   */
  const shownErrors: FieldErrors = createMode && !formTouched ? {} : errors;
  /**
   * 保存禁用时页脚的一句话摘要，引用第一条错误原文（错误文本自报家门）。
   * jsonError 不参与静音：在 textarea 里打坏字不走 setDefinition，但用户确实
   * 动过手——不过 JSON 页自己已经亮着带行列位置的 alert，页脚不复读；
   * 切回表单页后字段都还停在上次成功的定义上，这时页脚是唯一的解释。
   * tooBig 有自己的警示行，也不在这里重复。
   */
  const firstBlocker =
    jsonError !== null
      ? tab === 'json'
        ? null
        : t.editor.jsonInvalid
      : (Object.values(shownErrors)[0] ?? null);

  /* ---------- 写 definition 的统一出口：空值删键，不落空串与空对象。 ---------- */

  const setTopLevel = (key: string, value: unknown) =>
    setDefinition((prev) => {
      const next = { ...prev };
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });

  /** 一次写多个顶层键（undefined 删键）—— 预设按钮是唯一的调用方。 */
  const setTopLevelFields = (fields: Record<string, unknown>) =>
    setDefinition((prev) => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) {
          delete next[key];
        } else {
          next[key] = value;
        }
      }
      return next;
    });

  /** 刚被预设写过的框闪一下（index.css 的 field-flash），400ms 后复位。 */
  const [flashedKeys, setFlashedKeys] = React.useState<readonly string[]>([]);
  const flashFields = (keys: readonly string[]) => {
    setFlashedKeys(keys);
    window.setTimeout(() => setFlashedKeys([]), 400);
  };

  const setMatchKey = (key: 'host' | 'path', value: string | undefined) =>
    setDefinition((prev) => {
      const match: Record<string, unknown> = { ...prev.match };
      if (value === undefined) {
        delete match[key];
      } else {
        match[key] = value;
      }
      const next = { ...prev };
      // match 空了连壳一起删：空对象没有任何语义。
      if (Object.keys(match).length === 0) {
        delete next.match;
      } else {
        next.match = match as RouteDefinition['match'];
      }
      return next;
    });

  /**
   * 整组写回。官方 ToggleGroup 交出的是「现在按下的是哪几个」的完整数组，所以这里
   * 不再需要「谁被点了、点开还是点关」——少一层推断，就少一处能和 UI 状态不一致的
   * 地方。空数组连键一起删：`methods: []` 在 schema 眼里是「一个方法都不允许」，
   * 而用户清空复选框的意思是「不限方法」。
   */
  const setMethods = (selected: readonly string[]) =>
    setDefinition((prev) => {
      // 过一遍 HTTP_METHODS：顺序由常量表说了算，不跟着用户点击的先后漂移。
      const methods = HTTP_METHODS.filter((method) => selected.includes(method));
      const match: Record<string, unknown> = { ...prev.match };
      if (methods.length === 0) {
        delete match.methods;
      } else {
        match.methods = methods;
      }
      const next = { ...prev };
      if (Object.keys(match).length === 0) {
        delete next.match;
      } else {
        next.match = match as RouteDefinition['match'];
      }
      return next;
    });

  /**
   * 条件行写回：按行里的族重建三个数组，各自的空数组删键、match 空了连壳删。
   * host/path/methods 等其余 match 键原样保留。
   */
  const setConditionRows = (rows: readonly ConditionRow[]) =>
    setDefinition((prev) => {
      const match: Record<string, unknown> = { ...prev.match };
      const families: Record<ConditionRow['family'], MatchCondition[]> = {
        headers: [],
        query: [],
        cookies: [],
      };
      for (const row of rows) {
        families[row.family].push(conditionFromRow(row));
      }
      for (const key of ['headers', 'query', 'cookies'] as const) {
        if (families[key].length === 0) {
          delete match[key];
        } else {
          match[key] = families[key];
        }
      }
      const next = { ...prev };
      if (Object.keys(match).length === 0) {
        delete next.match;
      } else {
        next.match = match as RouteDefinition['match'];
      }
      return next;
    });

  /** 等于 schema 默认值的布尔不落键，JSON 里只保留与默认不同的决定。 */
  const setBoolean = (key: BooleanKey, checked: boolean) =>
    setDefinition((prev) => {
      const next = { ...prev };
      if (checked === BOOLEAN_DEFAULTS[key]) {
        delete next[key];
      } else {
        next[key] = checked;
      }
      return next;
    });

  /** 三段开关：开启时保留已有子键，关闭时整段删除（段的存在就是开关状态）。 */
  const setSectionOn = (section: SectionKey) =>
    setDefinition((prev) => {
      const next = { ...prev };
      if (next[section] === undefined) {
        next[section] = {};
      }
      return next;
    });
  const setSectionOff = (section: SectionKey) =>
    setDefinition((prev) => {
      const next = { ...prev };
      delete next[section];
      return next;
    });
  const setSectionKey = (section: SectionKey, key: string, value: unknown) =>
    setDefinition((prev) => {
      const current: Record<string, unknown> = {
        ...((prev[section] ?? {}) as Record<string, unknown>),
      };
      if (value === undefined) {
        delete current[key];
      } else {
        current[key] = value;
      }
      const next = { ...prev };
      next[section] = current as RouteDefinition[typeof section];
      return next;
    });

  const boolValue = (key: BooleanKey): boolean => {
    const value = definition[key];
    return typeof value === 'boolean' ? value : BOOLEAN_DEFAULTS[key];
  };

  /**
   * access.cloudflare 子段里的键。子段删空就连键一起删掉 —— `cloudflare: {}` 过不了
   * schema（audience 必填），而空段留在草稿里只会把错误推迟到发布前才被人看见。
   */
  const setAccessCloudflareKey = (key: 'team' | 'audience' | 'emails', value: unknown) =>
    setDefinition((prev) => {
      const current: Record<string, unknown> = {
        ...((prev.access?.cloudflare ?? {}) as Record<string, unknown>),
      };
      if (value === undefined) {
        delete current[key];
      } else {
        current[key] = value;
      }
      const access: Record<string, unknown> = { ...prev.access };
      if (Object.keys(current).length === 0) {
        delete access.cloudflare;
      } else {
        access.cloudflare = current;
      }
      const next = { ...prev };
      if (Object.keys(access).length === 0) {
        delete next.access;
      } else {
        next.access = access as RouteDefinition['access'];
      }
      return next;
    });

  /**
   * bodyRewrite 子段里的布尔。与 setBoolean 同样的「等于默认值不落键」语义，但
   * 不能复用它：段壳必须留下来，删到空对象就等于把整个改写关掉了。
   */
  const setBodyRewriteBoolean = (key: BodyRewriteBooleanKey, checked: boolean) =>
    setSectionKey(
      'bodyRewrite',
      key,
      checked === BODY_REWRITE_BOOLEAN_DEFAULTS[key] ? undefined : checked,
    );

  const bodyRewriteBoolValue = (key: BodyRewriteBooleanKey): boolean => {
    const value = definition.bodyRewrite?.[key];
    return typeof value === 'boolean' ? value : BODY_REWRITE_BOOLEAN_DEFAULTS[key];
  };

  /* ---------- 视图与保存 ---------- */

  const handleTabChange = (nextTab: string) => {
    if (nextTab === tab) {
      return;
    }
    if (nextTab === 'json') {
      const signature = stableStringify(definition);
      if (jsonSignature.current !== signature) {
        jsonSignature.current = signature;
        setJsonText(JSON.stringify(definition, null, 2));
        setJsonError(null);
      }
      setTab('json');
      return;
    }
    // JSON 有错也放行切回表单：表单显示的是最后一次成功解析的定义， Escape 按钮随时
    // 能把 JSON 退回那份定义 —— 锁死切换只会把人困在坏掉的 JSON 里。
    setTab('form');
  };

  const handleJsonChange = (text: string) => {
    setJsonText(text);
    const trimmed = text.trim();
    if (trimmed === '') {
      // 空文本是「还没写」：按空定义处理，报错反而把人吓退（与 defaults 卡一致）。
      setJsonError(null);
      jsonSignature.current = stableStringify({});
      setDefinition({});
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // JSON.parse 是权威判定；jsonc-parser 只用来把错误定位到行列。
      setJsonError(t.editor.jsonInvalid + ' ' + jsonErrorLocation(text));
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setJsonError(t.editor.jsonInvalid);
      return;
    }
    setJsonError(null);
    // 记下这次解析的签名：修好之后用户的排版不会被重新生成冲掉。
    jsonSignature.current = stableStringify(parsed);
    setDefinition(parsed as RouteDefinition);
  };

  /**
   * 逃生门：JSON 改坏了，退回最后一次成功解析的定义。
   * 表单视图还停在那份定义上，这里只是把 JSON 文本也对齐回来 —— 两个视图重新
   * 共享同一份数据。
   */
  const escapeJson = () => {
    setJsonText(JSON.stringify(definition, null, 2));
    jsonSignature.current = stableStringify(definition);
    setJsonError(null);
  };

  /**
   * 排版：按 2 空格重排当前文本。刻意只在能解析时动手（按钮在出错时禁用），
   * 因为格式化是排版动作 —— 它不该顺手改变定义，也不该在文档坏掉时猜意图。
   */
  const formatJson = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return;
    }
    setJsonText(JSON.stringify(parsed, null, 2));
    jsonSignature.current = stableStringify(parsed);
  };

  /** 关闭请求（×、Esc、遮罩、取消按钮）都要先过这一关。 */
  const requestClose = () => {
    if (saving) {
      return;
    }
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onExit();
  };

  const save = async () => {
    if (blocked) {
      return;
    }
    setSaving(true);
    const savedId = id;
    try {
      await api.putRoute(savedId, definition, enabled);
    } catch (error) {
      setSaving(false);
      toast.error(saveErrorMessage(error));
      return;
    }
    // 先落 saving 再回调：回调会把本组件卸载，别在卸载之后 setState。
    setSaving(false);
    // 保存只写草稿；「去发布」把下一步顺手递到手上，不接也不会丢。
    toast.success(t.editor.saved(savedId), {
      action:
        onGoPublish !== undefined ? { label: t.editor.goPublish, onClick: onGoPublish } : undefined,
    });
    onSaved(savedId);
  };

  const unknownKeys = Object.keys(definition).filter((key) => !FORM_COVERED_KEYS.includes(key));
  const reservedHeaders = reservedHeaderNames(definition);
  // 鉴权段的保留名检查：抄回头最终写进上游请求，与 requestHeaders 同一套拒绝表。
  const forwardAuthReservedRequest = reservedNamesIn(definition.forwardAuth?.copyRequestHeaders);
  const forwardAuthReservedResponse = reservedNamesIn(definition.forwardAuth?.copyResponseHeaders);

  return {
    /* 标识与开关 */
    createMode,
    initialId,
    id,
    setId,
    enabled,
    setEnabled,
    setFormTouched,
    /* 定义本体与写入口 */
    definition,
    setTopLevel,
    setTopLevelFields,
    setMatchKey,
    setMethods,
    setConditionRows,
    setBoolean,
    boolValue,
    setSectionOn,
    setSectionOff,
    setSectionKey,
    setAccessCloudflareKey,
    setBodyRewriteBoolean,
    bodyRewriteBoolValue,
    /* 预设写入后的闪烁 */
    flashedKeys,
    flashFields,
    /* 手风琴展开集合 */
    guardsOpen,
    setGuardsOpen,
    advancedOpen,
    setAdvancedOpen,
    /* 视图切换与 JSON 投影 */
    tab,
    handleTabChange,
    jsonText,
    jsonError,
    handleJsonChange,
    escapeJson,
    formatJson,
    /* 校验结果 */
    errors,
    shownErrors,
    firstBlocker,
    tooBig,
    blocked,
    /* 派生的「有问题的名字」 */
    unknownKeys,
    reservedHeaders,
    forwardAuthReservedRequest,
    forwardAuthReservedResponse,
    /* 域名候选 */
    hostBindings,
    hostOptions,
    /* 保存与离开 */
    dirty,
    saving,
    save,
    requestClose,
    confirmDiscard,
    setConfirmDiscard,
    onExit,
  };
};

/** 三个 section 与页面骨架共用的一份草稿视图。 */
export type RouteDraft = ReturnType<typeof useRouteDraft>;
