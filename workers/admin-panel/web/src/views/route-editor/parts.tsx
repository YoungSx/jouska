/**
 * Small presentational pieces shared by every section of the route editor:
 * inline hints, danger notes, term tooltips and the accordion card head.
 *
 * None of these owns state. They exist so a field's copy, its terminology
 * tooltip and its danger surface look identical wherever the field lives.
 */
import * as React from 'react';
import { InfoIcon, TriangleAlertIcon } from 'lucide-react';
import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { AccordionTrigger } from '@/components/ui/accordion';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { FieldLabel } from '@/components/ui/field';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/lib/messages';
import { DANGER_REASONS, DANGEROUS_PATHS } from '@/lib/types';

/**
 * help 文案里的反引号片段排成等宽字：操作者要逐字符抄写的就是这些片段（`/*`、
 * `*.example.com`），普通正文把它们淹没会直接造成写错。
 */
export const Hint = ({ text }: { readonly text: string }) => (
  <>
    {text.split('`').map((part, index) =>
      index % 2 === 1 ? (
        <code key={index} className="text-foreground bg-muted rounded px-1 font-mono text-xs">
          {part}
        </code>
      ) : (
        <React.Fragment key={index}>{part}</React.Fragment>
      ),
    )}
  </>
);

/**
 * 危险字段的就地警示。只对 types.ts 登记过的路径渲染 —— 路径拼错时不显示，
 * 比显示一句错误文案更早暴露「新增了危险字段但没登记」。
 */
export const DangerNote = ({ path }: { readonly path: string }) => {
  if (!DANGEROUS_PATHS.has(path)) {
    return null;
  }
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertDescription>{DANGER_REASONS[path]}</AlertDescription>
    </Alert>
  );
};

/**
 * 打开正文改写之后立刻要看见的两件事：代价，与覆盖不到的地方。
 *
 * 不是 DangerNote —— 它不需要发布时确认，配置本身也没有危险。但也不能只当一行小
 * 字：改写会静默剥掉上游的验证器和 CSP，而「开了就全都留在代理上」是不成立的，两
 * 件事都得在按下开关的那一刻摊开，而不是等页面出问题再回来查。
 */
export const RewriteNote = () => (
  <Alert>
    <InfoIcon />
    <AlertDescription className="flex flex-col gap-1">
      <span>
        <Hint text={t.fields.bodyRewrite.cost} />
      </span>
      <span>
        <Hint text={t.fields.bodyRewrite.scope} />
      </span>
    </AlertDescription>
  </Alert>
);

/** 表单未覆盖字段的值预览：只求认得出是什么，不求完整。 */
export const previewValue = (value: unknown): string => {
  const raw = JSON.stringify(value) ?? 'undefined';
  return raw.length > 120 ? `${raw.slice(0, 119)}…` : raw;
};

export const hasText = (value: string | undefined | null): boolean =>
  value !== undefined && value !== null && value !== '';

/**
 * JSON 错误定位：权威判定是 JSON.parse，这里只用 jsonc-parser 的容错扫描把
 * 第一个错定位到行列（1 起始）。两者的判定口径不同 —— jsonc 容忍注释与尾逗号
 * —— 所以它的解析结果一个字都不能用，只取 offset。
 */
export const jsonErrorLocation = (text: string): string => {
  const errors: ParseError[] = [];
  parseJsonc(text, errors);
  const first = errors[0];
  if (first === undefined) {
    return '';
  }
  const beforeError = text.slice(0, first.offset);
  const line = (beforeError.match(/\n/g)?.length ?? 0) + 1;
  const column = first.offset - (beforeError.lastIndexOf('\n') + 1) + 1;
  return `${printParseErrorCode(first.error)}（${t.editor.jsonErrorAt(line, column)}）`;
};

/**
 * 字段标签旁的术语提示：label 保留原词（host、CIDR、AUD tag），解释进 tooltip。
 * 悬停/聚焦都触发 —— 触屏之外的两条路径都得能打开它。
 */
export const TermTip = ({ text }: { readonly text: string }) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <button
          type="button"
          aria-label={text}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-2 inline-flex cursor-pointer items-center outline-none"
        >
          <InfoIcon aria-hidden className="size-3.5" />
        </button>
      }
    />
    <TooltipContent className="max-w-64">{text}</TooltipContent>
  </Tooltip>
);

/** 标签 + 可选术语提示的共用排版。 */
export const PropertyLabel = ({
  htmlFor,
  label,
  tip,
}: {
  readonly htmlFor?: string;
  readonly label: string;
  readonly tip?: string;
}) => (
  <span className="inline-flex items-center gap-1.5">
    <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
    {tip !== undefined && <TermTip text={tip} />}
  </span>
);

/**
 * 手风琴卡头：卡名 + 这一组配没配过的状态徽章。状态是小白的地图——不用展开
 * 五张卡也能知道这条路由挡了谁；needsFix（有错误要修）盖过一切。守卫卡
 * （kind="guard"）配置过读「已启用」——守卫生效就是这条意思；高级卡配置过读
 * 「已设置」——那不是开关，是自定义值。没配一律读「默认」。
 */
export const SectionCardTrigger = ({
  label,
  set,
  needsFix = false,
  kind,
}: {
  readonly label: string;
  readonly set: boolean;
  readonly needsFix?: boolean;
  readonly kind?: 'guard';
}) => (
  <AccordionTrigger>
    <span>{label}</span>
    {needsFix ? (
      <Badge variant="destructive">{t.fields.sections.sectionNeedsFix}</Badge>
    ) : set ? (
      <Badge variant="secondary">
        {kind === 'guard' ? t.fields.sections.sectionEnabled : t.fields.sections.sectionSet}
      </Badge>
    ) : (
      <Badge variant="ghost" className="text-muted-foreground">
        {t.fields.sections.sectionEmpty}
      </Badge>
    )}
  </AccordionTrigger>
);

/* ---------- 单字段控件 ---------- */
