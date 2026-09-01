---
name: jouska 管理面板
description: 反向代理配置平面 —— 一道必须亲手推开的发布闸
colors:
  background: 'oklch(0.145 0 0)'
  foreground: 'oklch(0.985 0 0)'
  card: 'oklch(0.205 0 0)'
  card-foreground: 'oklch(0.985 0 0)'
  popover: 'oklch(0.205 0 0)'
  popover-foreground: 'oklch(0.985 0 0)'
  primary: 'oklch(0.922 0 0)'
  primary-foreground: 'oklch(0.205 0 0)'
  secondary: 'oklch(0.269 0 0)'
  secondary-foreground: 'oklch(0.985 0 0)'
  muted: 'oklch(0.269 0 0)'
  muted-foreground: 'oklch(0.708 0 0)'
  accent: 'oklch(0.269 0 0)'
  accent-foreground: 'oklch(0.985 0 0)'
  destructive: 'oklch(0.704 0.191 22.216)'
  border: 'oklch(1 0 0 / 10%)'
  input: 'oklch(1 0 0 / 15%)'
  ring: 'oklch(0.556 0 0)'
typography:
  body:
    fontFamily: "'Geist Variable', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"
    fontSize: '0.875rem'
    fontWeight: 400
    lineHeight: '1.25rem'
  annotation:
    fontFamily: "'Geist Variable', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"
    fontSize: '0.75rem'
    fontWeight: 400
    lineHeight: '1rem'
  title:
    fontFamily: "'Geist Variable', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"
    fontSize: '1rem'
    fontWeight: 500
    lineHeight: '1.375rem'
  mono:
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'Noto Sans Mono CJK SC', monospace"
    fontSize: '0.75rem'
rounded:
  sm: '6px'
  md: '8px'
  lg: '10px'
  xl: '14px'
  4xl: '26px'
spacing:
  2xs: '2px'
  xs: '4px'
  sm: '6px'
  md: '8px'
  lg: '12px'
  xl: '16px'
  2xl: '24px'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.primary-foreground}'
    typography: '0.875rem / 500'
    rounded: '{rounded.lg}'
    padding: '0 10px'
    height: '32px'
  button-primary-hover:
    backgroundColor: 'oklch(0.922 0 0 / 80%)'
  button-outline:
    backgroundColor: '{colors.background}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.lg}'
    padding: '0 10px'
    height: '32px'
  button-destructive:
    backgroundColor: 'oklch(0.704 0.191 22.216 / 20%)'
    textColor: '{colors.destructive}'
    rounded: '{rounded.lg}'
    padding: '0 10px'
    height: '32px'
  button-ghost:
    textColor: '{colors.foreground}'
    rounded: '{rounded.lg}'
  badge-secondary:
    backgroundColor: '{colors.secondary}'
    textColor: '{colors.secondary-foreground}'
    typography: '0.75rem / 500'
    rounded: '{rounded.4xl}'
    padding: '2px 8px'
    height: '20px'
  badge-destructive:
    backgroundColor: 'oklch(0.704 0.191 22.216 / 20%)'
    textColor: '{colors.destructive}'
    typography: '0.75rem / 500'
    rounded: '{rounded.4xl}'
    padding: '2px 8px'
    height: '20px'
  card:
    backgroundColor: '{colors.card}'
    textColor: '{colors.card-foreground}'
    rounded: '{rounded.xl}'
  danger-surface:
    backgroundColor: 'oklch(0.704 0.191 22.216 / 8%)'
    textColor: '{colors.foreground}'
    rounded: '{rounded.lg}'
    padding: '12px'
---

# Design System: jouska 管理面板

## Overview

**Creative North Star: "闸门"（The Gate）**

这个界面不是通用管理后台，它只讲一件事：草稿与生产之间隔着一道必须亲手推开的闸。视觉系统全部服务于这句话——常驻底部的发布栏是唯一的主角，其他一切都是它的注脚；危险不禁止、只让手指变重，所以整个系统里唯一的彩色是 destructive，它出现的地方都是「按下去会改变生产流量」的地方，从不装饰。

底座是 shadcn/ui 官方 Base UI 版 nova preset（neutral 中性 oklch token、自托管 Geist 变量字体、Lucide 图标），nova token 一律不改——跟得上上游升级比拿到偏好的色号重要（`src/index.css` 明文声明）。产品只补 preset 没覆盖的两类东西：浏览器自身表面（selection、滚动条、focus）与产品特有语义（等宽数字、危险底色、闸门动画）。深色优先（`html.dark` 出厂即深色），浅色完整对称。

**Key Characteristics:**

- 全中性灰阶 + 唯一色相 destructive；primary 不是品牌色而是明度反转的强调
- 无阴影系统，深度靠边框、tonal 分层与 backdrop-blur
- 类型档位封顶 text-base（16px），层级靠字重与灰度不靠字号
- 标识符、host、路径、JSON 一律等宽；表格数字一律 tabular-nums
- 常驻顶栏与常驻发布栏夹住内容，sticky + 半透明 + backdrop-blur
- 键盘可达是硬要求：焦点环永远可见，disabled 控件留在原地并说明原因

## Colors

整盘是 zero-chroma 灰阶（oklch C=0），唯一的彩色是 destructive 的红。前matter 记的是深色（默认主题）值；浅色主题是同一批 token 的对称翻转，权威定义在 `workers/admin-panel/web/src/index.css` 的 `:root` 块，两套都必须从那里的变量取，不得另立色号。

### Primary

- **反转强调（primary，深色 oklch(0.922 0 0) / 浅色 oklch(0.205 0 0)）**: 不是品牌色，是「最重的那个动作」。主按钮（发布、新建路由）、选中态 Badge、skip-link。它的重量来自明度反转与稀缺，不来自色相。

### Secondary

- 无。项目没有第二强调色；需要区分层级时用 secondary/muted 的灰阶（如「待开发」Badge、「停用」Badge、观察者角色 Badge）。

### Neutral

- **画布（background，深色 oklch(0.145 0 0)）**: 页面底色与 sticky 栏的半透明底（`bg-background/95` + backdrop-blur）。
- **面板（card，深色 oklch(0.205 0 0)）**: 所有 Card、弹窗浮层。比画布亮一档，这是本系统唯一常规的深度来源。
- **次级表面（secondary / accent / muted，深色均为 oklch(0.269 0 0)）**: hover 底、JSON 预览底（`bg-muted`）、次级 Badge。
- **次级文字（muted-foreground，深色 oklch(0.708 0 0)）**: 说明、hint、时间戳、表头外的辅助信息。annotation 级文字默认用它。
- **描边（border，深色 oklch(1 0 0 / 10%)；input oklch(1 0 0 / 15%)）**: 分隔线、输入框、danger 块、卡片 ring 的基色（Card 用 `ring-1 ring-foreground/10`）。
- **焦点（ring，深色 oklch(0.556 0 0)）**: 所有 focus-visible 环的颜色，全局 `outline: 2px solid var(--ring)` + 组件内 `ring-3 ring-ring/50`。

### Tertiary

- **危险红（destructive，深色 oklch(0.704 0.191 22.216) / 浅色 oklch(0.577 0.245 27.325)）**: 全系统唯一彩色。只用于语义：校验失败的 Alert、危险开关的 Badge 与文字、破坏性按钮/菜单项、发布栏 blocked 状态的图标。从不装饰。

### Named Rules

**唯一色相规则。** 全系统只允许 destructive 一个 chroma > 0 的 token。要强调就用明度反转（primary）或灰阶深浅，不引入第二个色相。品牌、成功、信息都用图标（Lucide）+ 灰阶表达，不上绿色/蓝色。

**危险有底色规则。** 「需要亲手确认」的区域用 `danger-surface`（destructive 8% 底 + 30% 描边）标出，而不是只靠文字。发布预览页的危险卡片与发布弹窗里的危险清单必须同底色——两处说的是同一件事，操作者要能把它们对上。

**disabled 可见规则。** 观察者看得见发布按钮但按不动，并且知道为什么：disabled 控件不隐藏、不消失，用原生 disabled 样式（opacity-50）加 `title` 说明原因。

## Typography

**Display/Body Font:** Geist Variable（`@fontsource-variable/geist` 自托管），汉字回退栈显式列出：`-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif`——Geist 不含汉字，不写回退则字重观感随系统漂移。
**Mono Font:** 系统等宽栈 `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'Noto Sans Mono CJK SC', monospace`。刻意不再拉一个字体文件：这些是数据不是排版表现。
**图标字体:** 无。图标全部是 Lucide 的内联 SVG。

**Character:** 工具型界面的字体系统——没有 display 字号，层级全部由 12px/14px/16px 三档加字重与灰度完成。标题即正文加粗。

### Hierarchy

- **Title**（500, 16px / text-base, 1.375rem）：CardTitle 与页面级标题，是本系统的最大字号。
- **Body**（400, 14px / text-sm, 1.25rem）：默认正文、按钮文字、表单标签、CardDescription。中文界面语。
- **Annotation**（400, 12px / text-xs, 1rem）：hint、说明、时间戳、表头、表格数据、`<code>` 里的标识符。辅助信息配 muted-foreground。
- **Micro**（500, 10px / text-[10px]）：仅「待开发」Badge 这一处嵌入组件内的小标注；不作为通用档位。
- **Mono**（12px，等宽）：路由 ID、match/host/path/upstream、JSON 文档、审计对象、账号名。凡是需要逐字符核对的东西。
- **品牌字标**（600, 14px, tracking-tight）：顶栏左上的小写 `jouska`，下方跟一行 12px muted-foreground 副题「反向代理配置」。没有 logo 图形。

### Named Rules

**等宽是数据规则。** 一个字符串只要会被操作者逐字符核对（ID、host、路径、上游、JSON、时间戳旁的确切值），就用 `font-mono`（12px）；说给人看的话用 sans。两者不混排在一个值里。

**数字对齐规则。** 表格里的时间戳、计数、毫秒、revision 一律 `tabular-nums`（`table, .tabular` 全局生效）——比例数字会让竖列对不齐。

**无大标题规则。** 不要给这个界面引入 20px+ 的标题字号。层级靠字重（400/500/600）与灰度（foreground / muted-foreground）完成，封顶 16px。

## Layout

单列纵向流，`flex min-h-dvh flex-col` 夹住内容：

- **容器**：`max-w-6xl`（72rem）居中，水平内边距统一 `px-4`（16px）。登录页收窄到 `max-w-sm`（24rem）居中。
- **顶栏**：sticky top-0，`bg-background/95` + `backdrop-blur` + 底边框，z-30。品牌（左）+ 导航（中，见「响应式」）+ 主题切换与账号菜单（右）。高度由 `py-2.5` 决定，内容单行。
- **发布栏**：sticky bottom-0，同样的半透明 + blur + 顶边框，z-20。左：状态图标 + 状态句 + （非 clean 时）线上 revision Badge；下挂一行 12px muted-foreground 细节。右：查看按钮（ghost sm）+ 发布按钮（sm）。sticky 而非 fixed——fixed 会盖住最后一行，而这个面板的最后一行常常正是刚改的那条路由。
- **主体**：`pt-6 pb-8`（24px / 32px），页面内区块之间 `gap-6`（24px），Card 内元素 `gap-2`/`gap-1.5`（8px / 6px）。
- **表格**：容器内横滚（`-mx-4 overflow-x-auto px-4 sm:mx-0`），窄屏不断行——这些值要逐字符核对，换行会读错。列宽用固定 `w-*` 约束序号、状态、时间、操作列。
- **密度**：紧凑。空隙档位实测分布：gap-2（8px）最常用，其次 gap-1.5（6px）、gap-4（16px）；危险块、JSON 块内 `p-3`（12px）。
- **响应式**：`sm:` 断点之上发布栏与顶栏转单行，之下转两行（图标+文案 / 按钮）。导航分两路：`sm:` 及以上平铺 Tabs 横滚（`nav-scroll` 右缘淡出提示还有未入屏项，滚到头即收）；窄屏收进一个官方 DropdownMenu——触发钮显示菜单图标与当前页名，菜单项是 CheckboxItem，当前页打勾（390px 视口下六个导航项挤进一条横滚缝，「现在在哪」不可见，故折叠）。两路指向同一份导航数据与同一个状态，不会漂移成两套导航。

## Elevation & Depth

本系统不用 box-shadow。深度由四个手段表达，按优先级：

1. **tonal 分层**：card 比 background 亮一档（oklch 0.205 vs 0.145），浮层（popover、下拉、toast）与 card 同色但由边界界定。
2. **边界**：Card 用 `ring-1 ring-foreground/10`（1px 细环），区块与输入框用 `border-border`。
3. **半透明 + blur**：两根 sticky 栏用 `bg-background/95` + `backdrop-blur`，让滚过的内容在栏后隐约可见——这是「盖在上面的东西」的信号，不是装饰。
4. **z 序**：顶栏 30、发布栏 20、skip-link 50。除此之外没有悬浮层级。

### Shadow Vocabulary

- 无。若未来确需阴影（如拖拽浮层），必须先回到这里补一条记录，不得就地引入。

### Named Rules

**无边影规则。** 静止与交互态都不用 box-shadow。层次感来自灰阶差与 1px 边界；模糊只用于 sticky 栏的 backdrop-blur。

**焦点环规则。** 焦点必须一眼可见：组件内 `focus-visible:ring-3 ring-ring/50`，原生元素由全局 `:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px }` 兜底。任何新控件不得移除焦点环。

## Shapes

圆角以 `--radius: 0.625rem`（10px）为基，nova 按倍数派生整条刻度（×0.6 至 ×2.6）。实际用到的四档：

- **10px（rounded-lg）**：按钮、输入框、danger 块、Alert、下拉菜单、大部分内嵌块。这是控件的默认圆角。
- **14px（rounded-xl）**：Card 与 Dialog。容器比控件圆一档，形成内外两层。
- **8px（rounded-md）/ 6px（rounded-sm）**：卡片内再嵌一层的块（JSON `<pre>`、`<details>` 折叠块），内层比外层收敛。
- **26px（rounded-4xl，胶囊）**：仅 Badge。小胶囊形是状态标签的专属剪影，其他元素不得使用。
- 小尺寸按钮（sm/xs）用 `rounded-[min(var(--radius-md),12px)]` 收敛，避免矮控件显得过圆。

边框语言：1px 实线，统一 `border-border`；Card 用 ring 代替 border 以便 overflow 裁切。分隔用 `Separator` 或 border-t/b。没有斜切、没有异形。

## Components

组件底座是 `components/ui/` 下的官方 nova 原样件（Base UI + cva），不改；产品层只通过 variant 与 `className` 组合。以下记录实际用到的形态。

### Buttons

- **Shape:** rounded-lg（10px），`inline-flex` 单行，图标+文字间距 gap-1.5，`transition-all`，active 下沉 1px（`translate-y-px`）。
- **Primary（default）:** `bg-primary text-primary-foreground`，hover 变 `primary/80`。用于发布、新建路由、确认弹窗的主动作。尺寸 sm（h-7, 0.8rem 字号）为主，发布/新建用 sm。
- **Outline:** `border-border bg-background`，hover `bg-muted`。取消、刷新、重试等次级动作。弹窗页脚的取消键固定是它。
- **Destructive:** 刻意是淡染不是实底——`bg-destructive/10 text-destructive`（深色 /20），hover 加深到 /20（深色 /30）。用于删除路由确认。危险不尖叫，只变重。
- **Ghost:** 透明底，hover `bg-muted`。行内图标按钮（行菜单 icon-sm、主题切换 icon-sm）、发布栏的「查看发布内容」。
- **Focus:** `focus-visible:ring-3 ring-ring/50`；aria-invalid 时描边与环转 destructive。
- **Disabled:** `opacity-50 pointer-events-none`，且保留在原位配 `title` 说明。

### Badges

- 20px 高、胶囊形（rounded-4xl）、12px medium 字号、内嵌 12px 图标。
- **default:** primary 实底——启用状态、管理员角色。
- **secondary:** 灰底——停用状态、观察者角色、「待开发」标注。
- **destructive:** destructive 10% 淡染 + destructive 文字——数据损坏、路由行内危险开关计数（配 TriangleAlertIcon 与 tooltip 说明）。
- **outline:** 带边框透明底——发布栏里的「线上 revision N」。

### Cards / Containers

- **Corner Style:** rounded-xl（14px）。
- **Background:** card 色，`ring-1 ring-foreground/10`，overflow-hidden。
- **Internal Padding:** `--card-spacing: 16px`（sm 变体 12px）；CardTitle 与 CardDescription 同栅格，CardAction 靠右（放刷新/主按钮）。
- **Shadow Strategy:** 无阴影，见 Elevation。
- **卡内嵌块:** danger 块、`<details>`、`<pre>` 都是 rounded-md/lg + border，内边距 12px。

### Inputs / Fields

- 由 `Field` / `FieldLabel` / `FieldDescription` 组织：label 14px、description 12px muted-foreground，垂直 `gap-4` 分组。
- Input/Textarea/Select：`border-input` + rounded-lg，深色下 `bg-input/30` 系底色（nova 原样）；focus 转环。
- **Error:** JSON 校验失败用 12px 文案就地说明（「JSON 格式不对」），组件不上 destructive 描边，除非 aria-invalid 生效。
- 字符数上限就地提示（如发布备注 500 字），由 `maxLength` 硬约束。

### Navigation

- 顶栏 TabsList 承载路由/域名/发布/审计/用户/历史，顺序即优先级。选中态由 nova Tabs 提供（accent 底）。
- 未实现功能的导航项照样可达，挂 10px「待开发」secondary Badge，落地页是一张说明卡而不是假表单——空壳按钮比没有按钮更让人以为坏了。
- 窄屏收进官方 DropdownMenu：ghost 触发钮（菜单图标 + 当前页名）拉 CheckboxItem 菜单，当前页打勾；菜单项加高触控目标（`py-3`）。`sm:` 及以上回到平铺 Tabs + `nav-scroll` 右缘淡出（mask-image 渐隐，不遮点击；JS 置位 `scroll-tail`，滚到头即收）。
- 账号：ghost 按钮（等宽账号名 + 角色 Badge）拉下拉菜单，菜单含等宽账号名与 destructive 退出项。
- skip-link：`sr-only`，focus 时固定于左上角的 primary 实底块。

### Signature Component: 发布栏（PublishBar）

常驻底部的 sticky 栏，是这个面板的论点本身。五态（loading / clean / empty / blocked / dirty[含 never-published 分支]），每态一个 Lucide 图标（CircleDashed / CircleCheck / CircleAlert）+ 一句 headline（14px medium）+ 一行 12px 细节；dirty/blocked 附 ghost「查看」按钮与发布按钮。图标颜色随 tone：bad → destructive，pending → foreground，neutral → muted-foreground。闸门翻转时图标重放 200ms 的 `gate-land` 落位动画（key 重挂驱动，静止零成本）——这是全系统唯一的自定义动效。整栏 `role="status" aria-live="polite"`。措辞集中在 `messages.ts`，四态词是操作者判断能否下班的依据，绝不编造服务端没给的改动计数。

### Signature Component: 危险确认弹窗（PublishDialog）

两段式：第一段永远不带 confirm；服务端回 409 才在弹窗内就地展开危险清单（danger-surface 底）并要求亲手勾一次 Switch。在途时锁关闭、按钮内换成 Spinner。删除等破坏性确认弹窗同一骨架：`sm:max-w-md`、DialogFooter 里 outline 取消 + destructive/primary 确认，理由写在正文里而不是标题上。

### 反馈

- Toast：sonner，top-center，主题跟随应用主题，底/字/边全部绑回 popover/border token，radius 绑 `--radius`。成功/失败/会话过期/网络错误都走它；写操作失败必须可见，静默失败会让人以为存上了。
- Skeleton：形状对齐真实内容（几行、多高），加载完不跳版，`aria-hidden` + 外层 `aria-busy`。
- Empty：Empty 组件 + EmptyMedia 图标 + 标题 + 引导句 + （可选）行动按钮。空是「还没开始」，不是「配置有错」。

## Do's and Don'ts

### Do:

- **Do** 从 `src/index.css` 的 CSS 变量取每一个颜色（`bg-background`、`text-muted-foreground`、`text-destructive`…），深浅两主题自动成立；不写死色号。
- **Do** 保持 nova token 零改动。产品需要新语义时在 index.css 追加 `@utility`/`@theme`，像 `danger-surface`、`gate-icon` 一样带注释说明为什么。
- **Do** 用 `danger-surface` 标出一切「按下会改变生产流量」的区域，并让同一语义在不同页面同底色。
- **Do** 新增控件保持键盘可达：可 Tab、焦点环可见、弹窗有焦点陷阱与 Esc 关闭（Base UI 默认提供，别绕开）。
- **Do** 把所有界面文案写进 `src/lib/messages.ts`，语气说清后果不吓人；空态是「还没开始」。
- **Do** 状态变化用 toast 或发布栏告知；加载用形状对齐的 Skeleton。

### Don't:

- **Don't** 引入第二个色相或品牌色。primary、secondary、accent 都是灰阶；绿色/蓝色成功/信息指示在这里没有位置。
- **Don't** 用装饰性红色。destructive 只出现在「会改变生产行为」的语义处；危险按钮用淡染（`bg-destructive/10`），不用实底大色块。
- **Don't** 使用 box-shadow 表达层级；也不要给 Badge 以外的元素用胶囊圆角。
- **Don't** 引入 20px 以上的标题字号，或替代 Geist 的第二套字体。
- **Don't** 隐藏或移除 disabled 控件——留在原位配 `title` 说明原因。
- **Don't** 用拖拽实现路由排序（上下移按钮天然键盘可达）；不要让表格在窄屏折行——等宽值换行会读错。

### Not canonized

`--sidebar-*` 与 `--chart-1..5` token 族随 preset 进了 index.css 但无任何组件使用（含深色 `--sidebar-primary` 的蓝色值，是全文件唯一非中性非 destructive 的彩色）。它们是这个 build 携带的未用件，不是系统规则；新界面不得开始引用它们，除非先在 Colors 章节立档。
