import * as React from 'react';
import { toast } from 'sonner';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/lib/messages';

/**
 * 本页这份 JS 的构建身份。`__BUILD_ID__` 由构建工具在打包时替换成字符串字面量；
 * 没走到那条构建路径（比如测试环境的 jsdom）时标识符不存在，typeof 守卫兜成
 * 'dev' —— 和服务端没注入时的诚实值同款，而不是编一个版本出来。
 */
export const pageBuildId = (): string => (typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev');

/**
 * 页脚那行构建标识。不解释如何进门，只回答被挡住的人唯一问得出口的诊断问题：
 * 拦我的是哪个构建。
 *
 * 原则是「标在拒绝你的那一方身上」：拒绝请求的是服务端 Worker，不是浏览器里这份
 * JS，所以服务端报了构建时以它为准；本页与服务端出自同一条 `git describe`，两串
 * 不一致本身就是信号 —— 浏览器在跑缓存的旧页面。不平等才值得并排，一致时一个裸串
 * 更安静。服务端缺席（连不上、页面崩了）时只剩本页一串，前缀「本页」说清它的来源。
 *
 * 样式刻意只是页脚一行小字：不做横幅、不进卡片正文 —— 它是诊断信息，不是告警。
 */
export const BuildTag = ({
  serverBuild,
}: {
  /** 服务端报的构建。undefined = 服务端没答话（offline、页面崩溃、旧版部署）。 */
  readonly serverBuild?: string;
}) => {
  const [copied, setCopied] = React.useState(false);
  // 「已复制」是个瞬时确认不是新状态：两秒后回到版本串，否则这行字永远停在路上。
  React.useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const page = pageBuildId();
  // 空串按缺席处理：服务端不会把版本号存成空，出现空串只能是字段被手写坏了。
  const server = typeof serverBuild === 'string' && serverBuild !== '' ? serverBuild : undefined;
  const mismatched = server !== undefined && server !== page;

  const label = mismatched
    ? `${t.buildTag.serverPrefix} ${server} ${t.buildTag.separator} ${t.buildTag.pagePrefix} ${page}`
    : server !== undefined
      ? server
      : `${t.buildTag.pagePrefix} ${page}`;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(label);
      setCopied(true);
      toast.success(t.common.copied);
    } catch {
      toast.error(t.common.copyFailed);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={t.buildTag.hint}
            className="cursor-default font-mono text-xs text-muted-foreground underline-offset-2 outline-none hover:underline focus-visible:underline"
          >
            {copied ? t.common.copied : label}
          </button>
        }
      />
      <TooltipContent>{t.buildTag.hint}</TooltipContent>
    </Tooltip>
  );
};

/** BuildTag 外面统一的间距与居中，四处挂载点长得一样才不像补丁。 */
export const BuildTagFooter = (props: { readonly serverBuild?: string }) => (
  <div className="flex justify-center pt-4">
    <BuildTag {...props} />
  </div>
);
