---
target: 前端发布历史 diff 功能
total_score: 15
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
timestamp: 2026-09-05T12-06-17Z
slug: workers-admin-panel-web-src-views-history-view-tsx
---
Method: dual-agent（A 设计评审 · B 检测器 + 浏览器取证，两个隔离子代理并行；A 先完成，检测结果后进综合）

评审对象：jouska 管理面板「发布历史 + 版本对比（diff）」
主文件：`web/src/views/history-view.tsx`、`web/src/components/revision-diff.tsx`、`web/src/components/rollback-dialog.tsx`（服务端判定在 `src/diff.ts`）
Mode: **Operate**（操作者要完成任务：看懂两版之间改了什么、必要时退回去）

## Design Health Score

| # | 启发式 | 分 | 关键问题 |
|---|---|---|---|
| 1 | 系统状态可见 | 1 | 点满两版后视口零变化：diff 标题在折线下 51px（6 条 revision）／6.8 屏之外（50 条），页面不滚、不播报 |
| 2 | 贴近真实世界 | 2 | 「原值／新值」是相对词，而哪一侧是原值由点击顺序决定；标题用双向 `↔` |
| 3 | 用户控制与自由 | 2 | 选错一张不能只换那一张；Esc 全页无作用；同一对 diff 失败后**无法重试**（effect 依赖 `[from,to]` 不变） |
| 4 | 一致性与标准 | 2 | 回滚弹窗与发布弹窗同源（优秀）；但同页三套报错语法、三套「你不能做」答法，且与 `audit-view` 的四处成例都不一样 |
| 5 | 防错 | 1 | 方向可静默反转的 diff = 决策错误生成器；键盘按回滚会**静默执行另一个动作** |
| 6 | 识别优于回忆 | 1 | 读懂一行要同时记 7–8 件事，其中 3 件不在屏幕上 |
| 7 | 灵活与高效 | 1 | 零快捷键、无「与线上比」、无复制、无分页；50 条时主路径含 6.8 屏手动滚动 |
| 8 | 美观与极简 | 2 | 视觉权重反了：`新增` 是全系统最重的 primary 实底，`删除` 只有 10% 淡染；时间轴竖线 10% 白且被 `gap-3` 切断 |
| 9 | 帮助识别／诊断／恢复 | 1 | 「有一侧没有快照」不说哪一侧（服务端 `detail` 里说了，客户端扔了）；无重试；未知码裸奔 |
| 10 | 帮助与文档 | 2 | 文案好的地方非常好，但 diff 内零解释；唯一那句解释挂在 `pointer-events:none` 的禁用按钮 `title` 上，鼠标永远碰不到 |
| **合计** | | **15/40** | **Poor —— 主体验需要大修** |

十条全部适用（Operate 面板），未使用 n/a。

分数低不是因为装饰层差，恰恰相反：**四个最重的缺陷全在主任务路径上**，而样式纪律是干净的。

## Design Specificity 判定

**列表是长出来的，diff 卡是搬过来的。**

时间轴那一侧带着 jouska 的性格，而且是别的产品抄不走的那种：`live` 圆点换主色、`回滚自 #43` 把 rollback 出处写在卡上、`无快照` + 断档说明行承认记录的边界。这三样只在「一次发布 = 一次 KV 写 + 一份快照 + 一条审计」这个具体机制下才有意义。

diff 卡则是任何 config 后台都能原样搬走的形态，判据不是「像 git diff」，而是**它对 jouska 的领域一无所知**：

- 面板自己有 `src/danger.ts`（12+ 条危险字段带 level）和 `lib/types.ts` 的 `DANGER_REASONS`（每条配一句中文后果）。`routes.<id>.access.keys` 就在里面，配着「粘错了真 key 的主人从此被挡在门外」。发布弹窗遇到它会铺 `danger-surface` 并要求亲手勾一次；diff 里它是第 8 行灰字，和 `timeoutMs: 30000 → 10000` 一模一样。同一个字段、同一个产品、两种立场。
- `移序 第 5 位 → 第 1 位` 拿的是 badge 里最轻的 `outline`，还被排到最后 —— 而「顺序即优先级、首个匹配胜出」是 `shadow.ts` 存在的全部理由。
- 路由 id 从不解析成 host/path，虽然 `matchSummary()` 就在旁边、路由页天天在用。

现成材料没用上的地方：服务端 `diffRoutes` 本来就是按 `id` 归并的，前端把这个结构拍平成按动词分组；`src/api/revisions.ts` 的注释写着 diff 端点方向自由是 "exactly what the rollback dialog needs" —— 门留了，回滚弹窗没走。

**确定性扫描（Assessment B）**

CLI `detect.mjs --json` 扫这三个文件：**0 条发现，退出码 0**。这个「干净」是被反证过的，不是扫描器没开火：`--no-config --no-design-system` 绕过立档豁免仍是 0；同一扫描器扫整个 `web/src` 出 4 条 `design-system-font-size`（`App.tsx` 的 10px、`ui/button.tsx` 与 `ui/toggle.tsx` 的 0.8rem）；人造探针文件命中 4 条、退出码 2。

浏览器内注入检测器：8 组发现，逐条判定后**真实归属这个功能的是 0 条**：

| 规则 | 数量 | 判定 |
|---|---|---|
| `nested-cards` | 7 | **误报，机制可证**：`isCardLikeDOM` 的 `hasBorder` 靠正则 `/\bborder\b/` 匹配类名，命中的是 `CardHeader` 里的 variant 选择器 `[.border-b]:pb-…`，不是画出来的边框。历史页没有一处真的把 Card 套进 Card |
| `flat-type-hierarchy` | 1 | **误报，DESIGN.md 明文立档**：「封顶 16px、层级靠字重与灰度」「无大标题规则」。扫描器要的 ≥1.25 级差与这条规则直接冲突，规则赢 |
| `layout-transition` | 1 | 真实但不归这三个文件：`transition-all` 来自官方 registry 基座件（button/badge/toggle/tabs/accordion/switch） |
| `text-overflow` | 1 | 真实但不归历史页：顶栏账号名 `max-w-16 truncate` |
| `text-occlusion` | 7 | 覆盖层自检伪影（被遮的是覆盖层自己的标签） |

**结论值得单独说一句：检测器全绿，而这一屏最重的四个问题一个都不在它的射程内。** 键盘路径、结果送达、diff 方向、危险语义 —— 没有一条是能用正则扫出来的。

**覆盖层**：注入成功（`detect.js` 加载、DOM 出现 15 个 `.impeccable-*` 元素、`window.impeccableDetect` 就位），但它跑在无头浏览器里且已关闭 —— **没有留给你看的常驻覆盖层**，上表就是它报的全部内容。为 critique 起的 vite（:5301）与 live-server（:8400）都已停，`pgrep` 自查无残留，仓库 `git status` 干净。

## Overall Impression

**账本记得很老实，读账的那一半没做完。**

时间轴这一半是这个仓库里质量最高的东西之一：它承认自己不知道的事（无快照、断档、路由数未知），而且分三种说法分别解释，没有拿一个 `—` 糊过去。回滚弹窗更是把「回滚就是一次发布」这个后端事实落成了前端形态，一个字都没重新发明。

diff 这一半停在了「把服务端给的字段摆出来」。它正确、诚实、密度也合适 —— 但真正在做 diff 的是人不是工具：你得自己记住哪一版是原值，自己知道 `allowPrivateUpstream` 是危险方向，自己把散在 6 行里的 `api-gw` 拼回一条路由，自己滚 6.8 屏去找结果。

**最大的一个机会**：这一屏真正的主角是 diff，不是列表。把它翻过来 —— 进页面就默认对比「正在服务的那一版」与它前一版，diff 在首屏，列表退成换参照物的选择器 —— 凌晨三点值班的人零点击就拿到答案，「任选两版」变成高级路径。现在是 6500px 的列表当主角。

## What's Working

1. **三种「记录不完整」各说各的话。** 无快照说「早于历史功能，只留下审计记录 —— 能看，不能对比或回滚」；断档说「改动已上线、面板记录没写成，历史无法补记」；路由数未知就说未知。同类产品的做法是藏起来或给个假按钮。这里选了只说实话，而且没把三件事混成一句。
2. **回滚复用发布的两段式闸门。** 骨架、`confirming && confirmed` 的合取、`danger-surface` 底色、在途锁关闭全部同源，结尾 toast 还补一句「线上约 3 分钟内全面生效」。操作者在两处看到同一张脸，不需要学第二套规则 —— 峰终定律靠这个救回来了。
3. **卡上那行说明的选材是对的。** `12 条路由 · 把 api-gw 的上游切到新集群…（事故 INC-2291 的临时缓解）` —— 规模 + 意图放同一行，正是事后追查要的两样东西。（呈现有问题，见 P2，但选的东西对。）

## Priority Issues

### [P0] 结果渲染在视口之外，而且没有任何东西把人送过去
**实测**：6 条 revision 时 diff 标题 `top=1001px`，视口 950px，点击前后 `scrollY` 全程 **0**，`scroll-behavior: auto`，无 `scrollIntoView`；文档从 1064px 直接翻倍到 2036px，**跳版发生在屏外**。50 条 revision（正好是快照滚动保留上限，所以成熟部署永久处在这个状态）时标题在 **6497px = 6.8 屏之下**；390 宽下 **8505px = 10.1 屏之下**。点满两版后视口里唯一的变化是那张卡多一枚 `已选 #46` badge、外加「对比」按钮的文字消失了。
**为什么要紧**：主任务的完成信号不可见。失败态同样在折线之下 51px —— 用户点完第二张卡，连「对比不了」都看不到。加载态是一行 spinner，到达态是 956px 内容，DESIGN.md「加载完不跳版」在这一屏被以最大幅度违反。
**修法**（按代价升序）：(a) diff 卡移到列表**之前**，选中两版后插在头卡下方 —— 一处 JSX 换位，顺带解决「看完差异要回头找卡」；(b) 保留位置但选满两版时 `scrollIntoView({block:'start'})` **并**给 diff 卡加 `aria-live="polite"`，让键盘与读屏也收到通知；(c) diff 卡 sticky 在顶栏之下，复用路由编辑器动作栏的 `--panel-header-height` 语法。首选 (a)+(b)。
**建议命令**：`/impeccable layout`

### [P0] 「回滚」按钮键盘按不动，而且静默变成了另一个动作
**实测两处取证**：聚焦 #45 的「回滚」→ 按 Enter → **弹窗不开**，改成这张卡被选进对比（`aria-pressed=true`）；按空格 → 又取消选中；鼠标点同一个按钮 → 弹窗「回滚到 revision 45」正常打开。事件取证：`capture@card key=Enter target=BUTTON defaultPrevented=false` → `bubble@window … defaultPrevented=true`。
**根因**：`history-view.tsx:97-102` 的 `onKeyDown` 挂在 `Card` 上，内层原生 `<button>` 的 keydown 冒泡上来被它接住，`preventDefault()` 掐掉了浏览器给按钮合成 click 的默认动作，然后 `onToggleSelect()` 照跑。`onClick` 那侧有 `stopPropagation()`，keydown 这侧没有。
**为什么要紧**：PRODUCT.md 把键盘可达写成硬要求，这是选 Base UI 的直接理由。破坏性动作对纯键盘用户**完全不可达**（WCAG 2.1.1），而且不是报错而是**做了别的事** —— 最坏的一类失败。「对比」按钮之所以看着正常，纯属卡片处理器恰好干了同一件事，是巧合不是设计。
**修法**：卡片不该同时是按钮。把选择改成 CardHeader 里一个真正的 `Checkbox`（或一个显式 toggle 按钮），`Card` 退回普通容器 —— 一并修掉下面那条可访问名问题。若要保留整卡可点，最小修补是两个内层按钮加 `onKeyDown={(e) => e.stopPropagation()}`，并把卡片 handler 改成只在 `event.target === event.currentTarget` 时响应。
**建议命令**：`/impeccable harden`

### [P1] diff 的方向由点击顺序决定，屏幕上无从恢复
**实测**：先点 #47（顶部、live、就是它坏的）再点 #46 → 标题 `对比 #47 ↔ #46`，`from=47`。于是「原值」= 较**新**那一版，「新值」= 较旧那一版。**自上而下点 —— 唯一自然的动作 —— 得到的 diff 语义是反的**，而 `↔` 是双向箭头，主动否认存在方向。
**更隐蔽两处**：① `toggleSelect` 里取消第一个会把第二个提到 `a` 槽，方向静默翻转；② 挤出规则实测是 `[47,46]` → 点 #45 得 `[47,45]` → 点 #44 得 `[47,44]`，**第一次选的被钉死、第二槽轮换**，而代码注释写的是「挤掉最早的那个」—— 与行为相反。两张选中卡视觉完全相同，没有任何东西区分「锚」与「轮换槽」。
**为什么要紧**：事故排查里一个反向的 diff 不是不便，是错误决策生成器 —— 会把「已经修好」读成「刚被改坏」。
**修法**：方向钉死成时间序（`from = min(revision)`），标签从相对词换成绝对指称（`#46 的值` / `#47 的值`），标题 `#46 → #47`；两张选中卡加 `A（原）`/`B（新）` 标记让挤出规则可见。要保留「任选两版」也至少把 `↔` 换成 `→`。
**建议命令**：`/impeccable clarify`

### [P1] 产品自己的危险词汇在 diff 里缺席
`access.keys`、`allowPrivateUpstream`、`upstreamHeaders`、`requestHeaders.set`… 全在 `src/danger.ts` 与 `lib/types.ts` 的 `DANGER_REASONS` 里带着 level 和中文后果。在 diff 里它们与 `timeoutMs` 同权重、同灰度、无 level、无 reason、无跳转。DESIGN.md「危险有底色规则」原文要求同一语义在不同页面同底色，并点名了预览页与发布弹窗 —— diff 是第三处，没跟上。`revision-diff.tsx` 甚至没 import `DANGER_REASONS`，而隔壁 `rollback-dialog.tsx` import 了。
**修法**：`DiffEntry.path` 去掉 `routes.<id>.` 前缀后与 `DANGER_REASONS` 做后缀匹配，命中的行铺 `danger-surface` + 附那句中文 reason；更干净是服务端在 `DiffEntry` 上带 `risk?: FieldRisk`（判定仍只有 `dangerFlags` 一份，前端仍只渲染）。顺手把危险条数提到标题：`对比 #46 → #47 · 13 项差异，其中 2 项危险`。
**建议命令**：`/impeccable colorize`

### [P1] 卡片 `role="button"` 的可访问名是整张卡，且包住了两个按钮；diff 到达无播报
**实测**：#47 卡的可访问名 **118 字**（选中后 122 字），字面是 `#47正在服务4分钟前 · 2026/09/05 … · ops@example.com对比回滚12 条路由 · 把 api-gw 的上游切到新集群…` —— `ops@example.com对比回滚12 条路由` 连成一串念出来。ARIA 规定 `role="button"` 的后代是 presentational，遵守这条的 AT 会把两个内层按钮整个抹掉；Tab 序实测是「卡 → 卡内两按钮 → 下一张卡」，每条 revision 吃 2–3 个 Tab 位。
**附带三条**：① 选中后「对比」按钮 `textContent=""`、无 `aria-label`、无 `title`，**可访问名为空**（WCAG 4.1.2），宽度从 66px 掉到 36px；② 全页 live region 只有发布栏那一个，diff 开始加载／到达／失败**全程静默**，`diffCardAttrs` 实测为空；③ 全页只有两个 heading，都是 diff 内部的 `<h4>`（`路由`、`表级默认值`），没有 h1/h2/h3，「发布历史」是 `card-title` div —— 按标题导航会走进两个孤立的 h4。
**修法**：结构同上（Checkbox）。不动结构的话至少给卡片显式 `aria-label`、把选中态按钮标签换成「取消对比」而不是空串（`history-view.test.tsx` 里那个 `/对比|取消/` 正则说明这本来就是原意，现在的测试是靠空名字才通过的）、diff 卡加 `aria-live="polite"`、页面标题升成真 heading。
**建议命令**：`/impeccable audit`

### [P2] 值不可核对，长值不可展开
`MAX_VALUE_CHARS = 120` 之后只留一个裸省略号，被截断的恰好是哈希和 body rewrite 规则 —— 「必须逐字符核对」的那两类值。`messages.ts` 里备好的 `t.history.diff.truncated`（「（过长已截断）」）**从未被引用**，同为死键的还有 `diff.failed`、`diff.valueLabel`。窄屏 `break-all` 把 64 位哈希在任意位置断行（`break-all` 是继承属性，传进了没写它的内层 `code`），而 DESIGN.md 的规则是「窄屏不断行 —— 等宽值换行会读错」，处方 `-mx-4 overflow-x-auto px-4` 在 `audit-view` 实现了、这里没有。两行几乎相同的 JSON 之间**没有任何值内高亮**。（好消息：B 实测窄屏横向溢出为 **0**，`document.scrollingElement.scrollWidth === clientWidth === 390` —— 这是折行换来的，不是布局崩了。）
**修法**：值区改横滚不换行；超限值折叠成 `<details>` 或给「看全文」按钮；`title` 挂全文；两侧做 token 级差异标记（哪怕只标出第一处分歧）。截断提示用已经写好的那句话。
**建议命令**：`/impeccable harden`

### [P2] 三套报错语法、同一对 diff 无法重试、未知码裸奔
列表失败 = `<Alert>` 无 `variant` + 一个空的 `<AlertDescription />` + 无重试；diff 失败 = 裸红字 + 无重试；回滚失败 = toast。对照 `audit-view` 是 `Alert variant="destructive"` + 重试按钮。更实际的一条：diff effect 依赖 `[from, to]`，**同一对失败后不会再发请求**，唯一的出路是取消选择再重选。未知错误码直出机器码（实测屏幕上唯一的红字就是 `internal_error` / `not_a_known_code`），而服务端 409 里那句 `detail`（`revision 46 has no snapshot — it predates the history feature or was pruned`，明确说了哪一侧、为什么）被客户端整个丢掉，界面只说「有一侧」。
**修法**：三处收敛到 `audit-view` 的成例（destructive Alert + 重试）；重试改成显式按钮而不是靠 effect 依赖；未知码套 `t.history.diff.failed`；读 `ApiError.body.detail` 把「哪一侧」说出来。
**建议命令**：`/impeccable clarify`

## Persona Red Flags

**Alex（急躁老手，要 60 秒内拿到答案）**
- 全页零快捷键，而同一个 app 的 `route-editor/index.tsx` 已经立了 Cmd/Ctrl+S 的先例。最常见的意图「对比最上面两版」没有一键路径。
- **Esc 什么都不做**：整页只有一个 keydown handler，只认 Enter/空格。清除选择要么滚 6500px 去点 ghost 的「清除对比」，要么把两张卡再点一遍。
- 无批量、无范围对比、无「live vs #N」、无复制；值被截断，框选复制拿到的是 `…`。
- 50 张卡里哪两张被选中了？选中卡的「对比」按钮变成 36px 图标 —— 在一列 66px 按钮里靠宽度差认，还得滚回去看。

**Sam（键盘 + 屏幕阅读器）**
- **回滚不可达**（上面的 P0，实测）。
- 卡片 118 字可访问名，内含两个按钮的标签；选中态按钮可访问名为空。
- 全页无 live region 覆盖 diff；加载骨架既无 `aria-hidden` 也无外层 `aria-busy`（`audit-view` 的骨架容器有 `aria-hidden`），三个脉动空 div 进了阅读顺序。
- `<ol>` 里塞了 GapRow 这个纯文字 `<li>` —— 列表项数在撒谎（7 项 = 6 卡 + 1 说明行）。
- `#40`（无快照）卡 `tabindex=null`、`aria-pressed=null`，却仍带 `role="button"`：一个不可聚焦、按不动、却被念成按钮的元素。
- **viewer 的「回滚」被整个移除且不给理由。** DESIGN.md「disabled 可见规则」原文点名了观察者场景，发布栏遵守了（disabled + `title`）。同一屏对「你不能做这件事」给了三种互相矛盾的答法：live → disabled+title；无快照 → 移除+散文；viewer → 移除+沉默。
- 好消息：焦点环实测**可见**（卡片吃全局 `:focus-visible`，`solid 2px` offset 2px），`matches(':focus-visible')` 为 true。

**Riley（边界测试者）**
- **50 条**：列表 6308px、文档 6580px（桌面）／9544px（390），1200 个 DOM 节点，无分页、无虚拟滚动、无总数、无「还有更早的」、无日期吸顶。
- **超长内容**：50 字符的 actor 已经把元信息行推到 1440px 右缘、在 390px 折成三行（时间戳被断在两行）。服务端允许 500 字符 note，`RevisionCard` 没有任何 `line-clamp` —— 一条 revision 能比视口还高。
- **非 ASCII**：`MAX_VALUE_CHARS` 数的是 UTF-16 code unit，CJK 值与 ASCII 哈希拿一样的预算；`slice(0,120)` 可以把非 BMP 字符切在代理对中间。
- **刷新中途**：`load()` 没有 cancelled 守卫（diff 那个 effect 有），连点两次「刷新」由慢的那个响应胜出。
- **两版都无快照**：UI 走不到（无快照卡没有「对比」按钮），所以 `snapshot_unavailable` 只在列表加载后快照被 prune 的窗口里可达 —— 而那时它拒绝说是哪一侧。
- **禁用的「回滚」**：`pointer-events:none` 使真实命中区 1×1，粗指针下伪元素也一起被废，`title="线上正在服务的就是这一版的内容，不用回。"` **鼠标永远碰不到** —— 「为什么这一版不能回滚」唯一的解释是不可达的。

**凌晨三点值班中的运维（项目特有 persona）**
他只有两个问题：上一次改了什么、能不能立刻退回去。
- 问题一应该零点击，实际两次点击 + 6500px 滚动 —— 而答案所需的两份快照就在进页面时最上面两张卡上。
- 他拿到的 diff 可能是反的，屏幕上没有任何元素能让他发现。
- 能结束这次事故的那一行（`allowPrivateUpstream: false → true`、`access.keys` 多了一条）是 `text-muted-foreground text-xs`，与超时改动同款。`DANGER_REASONS` 里为 `access.keys` 写的那句话正是为这一刻写的。
- 问题二：读完 diff，两个被对比版本的「回滚」按钮在 6500px 之上，diff 卡只给了「清除对比」。
- 他最终到达的回滚弹窗只讲机制（不是倒带、草稿会重置），一句不讲内容 —— 你即将把线上换成什么。给的是「闸门设计得好」的安心，不是「我知道我在做什么」的安心。
- 时间戳：绝对时间非等宽、非 `tabular-nums`，前面还挂着变宽的相对时间（`4分钟前`/`昨天`/`上周`），整列确切时间参差不齐 —— 「这一版几点上的线」是逐卡阅读，不是一眼。

## Minor Observations

- **两处死类**：选中态的 `border-primary` 与 hover 态的 `hover:border-ring` 都不画东西 —— `Card` 只有 `ring-1`、没有任何 border 宽度工具类，而 Tailwind preflight 是 `border: 0 solid`。后果是**整卡可点却没有任何 hover 反馈**（只有 `cursor-pointer`），选中态实际只靠 `ring-2 ring-primary/30`。
- `#47` 的 CardTitle 与 diff 卡标题都是 `font-mono text-base`（16px），而 DESIGN.md 的 mono 档位是 12px。
- 分组标题用了 `uppercase tracking-wide` —— `uppercase` 对 CJK 是空操作，这套排版是给拉丁文写的。
- 时间轴轨道 `bg-border w-px grow` 是 10% 白，且每段只活在自己的 `li` 里、被 `ol` 的 `gap-3` 切断 —— 实际是一条虚线近似，读得出来的只有 live 圆点的 `ring-4`。删掉竖线大概没人会发现。
- `/api/revisions` 返回 `liveRevision`，`api.listRevisions` 把它丢了 —— 「live 不在可见列表里」时时间轴没有「你在这」的锚，也没有兜底句子。
- diff 卡底部那个 `<Separator />` 是 flex column 的最后一个孩子，在最后一行下面画一条线，分隔的是内容与卡片 padding。分隔符要分隔两样东西，这里只有一样。
- 无快照卡渲染了一个空 `<CardAction>`，无害，但 CardHeader 白白切成两列。
- 回滚在途的按钮文案复用 `t.publishBar.publishing`（「发布中…」）—— 语义正确（回滚就是一次发布），但没读过产品文档的人会以为按错了。
- 「两版内容完全一致」在这个产品里其实很常见（回滚天生制造内容相同的一对，`#46` 就是「回滚自 #43」），文案把它当成了巧合，没解释成因。
- **对比度**：默认 dark 主题全部通过（`原值/新值` 6.94、`#47` 标题 17.18、`已选 #47` 14.5、无快照说明行 6.94）。light 主题下两条低于 4.5:1 —— diff 的 `删除` badge **3.97**、`#47` 禁用「回滚」**3.71**（禁用件受 WCAG 1.4.3 豁免，但它与上面那条摸不到的 `title` 叠在一起，等于既看不清也摸不到）。`原值/新值` 在 light 下是 4.74，只比门槛高 0.24。
- `version` 因 `isDefaultsPath` 只特判 `defaults`，被归进「路由」组 —— version 不是路由。

## Questions to Consider

1. **如果方向根本不该由点击顺序决定，`from`/`to` 为什么是用户可控的？** 时间轴天生有序，「原值」永远该是较早那一版。钉死方向的代价只是失掉「反着比」这个没人要过的能力 —— 而服务端那句 "direction is free" 本来是为回滚弹窗写的，回滚弹窗根本没用它。
2. **这一屏真正的主角是 diff 还是列表？** 什么理由让 6500px 的列表当主角、让结果排在它后面？
3. **危险词汇一次 path 后缀匹配就能用上，不做的理由是什么？** 如果理由是「diff 只渲染服务端给的东西、不做第二套判定」—— 那服务端为什么不在 `DiffEntry` 上带一个 `risk` 字段？这个理由现在挡住的不是重复实现，是信息传递。
4. **「整张卡可点」换来更大的命中区，代价是嵌套控件、118 字可访问名、键盘回滚失效。** 换成 CardHeader 里一个真 Checkbox，失去的只是「点空白处也能选」。这个便利值这些代价吗？
5. **被截断的哈希，操作者到底该去哪里核对？** 答「去审计页看原文」，diff 就是索引不是终点，界面该照索引重排；答「就在这里核对」，它就需要值内高亮、可展开、可复制。现在两头都不是 —— 选哪一条决定这个组件接下来还要不要长别的东西。
