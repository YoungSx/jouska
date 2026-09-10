import * as React from 'react';
import { ChevronRightIcon, CopyIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { t } from '@/lib/messages';
import { cn } from '@/lib/utils';

/**
 * 只读 JSON 树。替代「一坨 `JSON.stringify` 塞进 `<pre>`」的摆法：同一个文档，
 * 折叠起来是结构（顶层有哪些键、各几项），展开才是内容，复制按钮兜住「要的就是
 * 全文」的那一步 —— 反代热路径逐字符核对仍然有原文可抄。
 *
 * 配色只有灰阶（DESIGN.md 禁第二个色相）：键浅值深 —— 扫结构看浅的键，读内容
 * 看深的值，数字与布尔靠透明度与斜体再退一层。所有颜色绑回 CSS 变量，明暗主题
 * 自动成立。
 */

/** 展开状态的 key：把 path 数组序列化成串。对象键可以含任意字符，拼接会撞车。 */
type Path = readonly (string | number)[];

const pathKey = (path: Path): string => JSON.stringify(path);

const isBranch = (value: unknown): value is Record<string, unknown> | unknown[] =>
  typeof value === 'object' && value !== null;

const branchCount = (value: Record<string, unknown> | unknown[]): number =>
  Array.isArray(value) ? value.length : Object.keys(value).length;

/** 防御上限：正常配置文档到不了 50 层，到得了的也读不动。 */
const MAX_WALK_DEPTH = 50;

/** 深度 ≤ defaultDepth 的分支路径，作为初始展开集。 */
const collectPaths = (value: unknown, predicate: (depth: number) => boolean): Path[] => {
  const found: Path[] = [];
  const walk = (node: unknown, path: Path, depth: number): void => {
    if (!isBranch(node) || depth > MAX_WALK_DEPTH) return;
    if (predicate(depth)) found.push(path);
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, [...path, index], depth + 1));
    } else {
      for (const [key, child] of Object.entries(node)) {
        walk(child, [...path, key], depth + 1);
      }
    }
  };
  walk(value, [], 0);
  return found;
};

const hasDeepBranch = (value: unknown): boolean =>
  collectPaths(value, (depth) => depth >= 2).length > 0;

/** 标量着色：字符串最深是内容主体；数字/布尔/空退半层；标点全靠 muted。 */
const Scalar = ({ value }: { readonly value: unknown }) => {
  if (typeof value === 'string') {
    return <span className="text-foreground">{JSON.stringify(value)}</span>;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="text-foreground/70 tabular-nums">{String(value)}</span>;
  }
  if (value === null) {
    return <span className="text-foreground/70 italic">null</span>;
  }
  // API 返回的东西不会走到这；出现就按原样字符串摆出来，别静默吞。
  return <span className="text-foreground">{String(value)}</span>;
};

const Punct = ({ children }: { readonly children: string }) => (
  <span className="text-muted-foreground">{children}</span>
);

const JsonLabel = ({ name }: { readonly name: string | number }) => (
  <>
    <span className="text-muted-foreground">
      {typeof name === 'string' ? JSON.stringify(name) : name}
    </span>
    <Punct>: </Punct>
  </>
);

interface JsonNodeProps {
  readonly name: string | number | null;
  readonly value: unknown;
  readonly path: Path;
  readonly depth: number;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (path: Path) => void;
}

const JsonNode = ({ name, value, path, depth, expanded, onToggle }: JsonNodeProps) => {
  if (!isBranch(value)) {
    return (
      <div className="rounded px-1 py-px break-words whitespace-pre-wrap">
        {name !== null && <JsonLabel name={name} />}
        <Scalar value={value} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const count = branchCount(value);
  const open = expanded.has(pathKey(path));
  const empty = count === 0;

  return (
    <div>
      {/* 空容器没有内容可翻，不装成可折叠的；有内容的整行都是开关，点哪都行。 */}
      {empty ? (
        <div className="rounded px-1 py-px">
          {name !== null && <JsonLabel name={name} />}
          <Punct>{isArray ? '[]' : '{}'}</Punct>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onToggle(path)}
          aria-expanded={open}
          className="flex w-full items-baseline rounded px-1 py-px text-left hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronRightIcon
            className={cn(
              'text-muted-foreground size-3.5 shrink-0 self-center transition-transform',
              open && 'rotate-90',
            )}
          />
          {name !== null && <JsonLabel name={name} />}
          <Punct>{isArray ? '[' : '{'}</Punct>
          {!open && (
            <>
              <span className="text-muted-foreground px-1 text-xs">
                … {isArray ? t.json.items(count) : t.json.keys(count)}
              </span>
              <Punct>{isArray ? ']' : '}'}</Punct>
            </>
          )}
        </button>
      )}
      {/* guide line 标层级归属：收起哪一层，线就在哪一层内侧。 */}
      {open && !empty && (
        <div className="ml-1.5 border-l border-border/60 pl-4">
          {isArray
            ? (value as unknown[]).map((child, index) => (
                <JsonNode
                  key={index}
                  name={index}
                  value={child}
                  path={[...path, index]}
                  depth={depth + 1}
                  expanded={expanded}
                  onToggle={onToggle}
                />
              ))
            : Object.entries(value).map(([key, child]) => (
                <JsonNode
                  key={key}
                  name={key}
                  value={child}
                  path={[...path, key]}
                  depth={depth + 1}
                  expanded={expanded}
                  onToggle={onToggle}
                />
              ))}
        </div>
      )}
    </div>
  );
};

interface JsonViewerProps {
  readonly value: unknown;
  /** 外层容器（限高、滚动、圆角边框）由调用方决定。 */
  readonly className?: string;
}

/**
 * 树的展开状态全在根上（`Set<pathKey>`），节点是无状态递归 —— 否则「全部展开/
 * 收起」要把状态广播到每个节点，或者节点各养一份状态然后互相打架。
 */
export const JsonViewer = ({ value, className }: JsonViewerProps) => {
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set(collectPaths(value, (depth) => depth <= 1).map(pathKey)),
  );

  const toggle = React.useCallback((path: Path) => {
    const key = pathKey(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
      toast.success(t.common.copied);
    } catch {
      toast.error(t.common.copyFailed);
    }
  };

  // 纯粹的根标量（API 不会给，但组件不该因此摆烂）不配工具栏。
  if (!isBranch(value)) {
    return (
      <div className={cn('rounded-md bg-muted p-3 font-mono text-xs', className)}>
        <Scalar value={value} />
      </div>
    );
  }

  // ⚡ Bolt Performance Optimization:
  // Memoizing these computations prevents O(N) traversal of the JSON tree
  // on every render (e.g. when toggling expansion states).
  const { count, deep, allKeys } = React.useMemo(() => {
    return {
      count: branchCount(value),
      deep: hasDeepBranch(value),
      allKeys: new Set(collectPaths(value, () => true).map(pathKey)),
    };
  }, [value]);

  return (
    <div className={cn('rounded-md border bg-muted/50', className)}>
      <div className="flex items-center gap-2 border-b px-2.5 py-1.5">
        <Badge variant="secondary" className="font-mono text-xs font-normal">
          {t.json.entries(count)}
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          {deep && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setExpanded(allKeys)}
              className="h-6 px-1.5 text-xs text-muted-foreground"
            >
              {t.json.expandAll}
            </Button>
          )}
          {deep && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setExpanded(new Set([pathKey([])]))}
              className="h-6 px-1.5 text-xs text-muted-foreground"
            >
              {t.json.collapseAll}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void copy()}
            aria-label={t.common.copy}
          >
            <CopyIcon />
          </Button>
        </div>
      </div>
      <div className="max-h-96 overflow-auto p-2.5 font-mono text-xs leading-5">
        <JsonNode
          name={null}
          value={value}
          path={[]}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
        />
      </div>
    </div>
  );
};
