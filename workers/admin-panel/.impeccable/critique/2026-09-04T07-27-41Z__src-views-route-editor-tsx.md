---
target: 审计路由编辑模块 src/views/route-editor.tsx
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
timestamp: 2026-09-04T07-27-41Z
slug: src-views-route-editor-tsx
---
# 路由编辑面板 UX 审查（route-editor.tsx）

Method: dual-agent (A: critique-A · B: critique-B)。目标：workers/admin-panel/web/src/views/route-editor.tsx（2271 行）。模式：Operate。

## Design Health Score：28/40（Good 带下缘）

| # | 启发式 | 分 | 关键问题 |
|---|--------|----|----------|
| 1 | 系统状态可见 | 3 | 保存按钮四态禁用、预设 flash 400ms，但无「已改动」指示器，只有关闭时被拦问 |
| 2 | 贴近真实世界 | 2 | 术语三重门槛：裸英文标签、手写 ISO 国家码、hint 放 openssl 终端命令 |
| 3 | 用户控制与自由 | 3 | 「放弃改动」确认 + 默认值不落键好；JSON 出错即锁死，无逃生门 |
| 4 | 一致性与标准 | 4 | 双视图共享草稿、mono 纪律、危险态统一——最干净的一项 |
| 5 | 错误预防 | 4 | 本地校验 + 18 项保留头拒绝表 + 回声指纹，最强维度 |
| 6 | 识别优于回忆 | 3 | host 下拉拉真实绑定；7 区块无目录，「还有哪些没看」靠回忆 |
| 7 | 灵活与效率 | 2 | 无 Ctrl+S、无字段跳转、JSON 无格式化；唯一加速器是 timing 预设 |
| 8 | 极简与美学 | 2 | 视觉语言到位，但 30+ 控件无权重差 |
| 9 | 错误恢复 | 3 | collectErrors 具体；JSON 错误无行号；服务端 Issue.message 中英混排风险（未实证，存疑） |
| 10 | 帮助与文档 | 2 | hint 全被动；B 实测 Hint 等宽代码对比度 4.3:1 不达标 |

## Design Specificity 判词

性格真实但只活在 hint 层（timing 预设文案、/* 前缀陷阱警告、X-Internal 不是访问控制——只有 jouska 说得出）；骨架层是 schema 字段顺序的直译（7 FieldSet 按 15 顶层字段排列，不是按「是什么/去哪里/谁能来」翻译）。最错失的机会：闸门心智模型（草稿→发布）在编辑器里退化成一句按钮文案，未做成结构事实。Alex 不读 hint，一旦不读，面板与任意反代表单无法区分。

确定性扫描：detect.mjs 对该文件 clean（0 发现）。浏览器注入（headless harness，vite+playwright 直挂弹窗）得 13 条，全落在运行时样式与文案，与 CLI 互补不矛盾。low-contrast ×10 全在 Hint 组件 bg-muted 等宽片段（token 层问题）；line-length ×1 在 matchConditions.help；flat-type/nested-cards/layout-transition 三条判为误报（token 阶梯 / Dialog+Alert 非嵌套 / 报在 body 节点）。

## 认知负荷

8 项清单：2.5–3 项失败/部分失败 → 中等偏高。超标决策点：HTTP 方法 7 复选框；条件行 5 控件/行；guards 区 6+ 决策点一屏；cors 展开 6 控件；access 展开 ~6 控件；timing 区 9 项；全展开 30+ 控件无复杂度档位。

## 情绪旅程

高峰：timing 预设 + flash。低谷：JSON 出错双锁之门（修不好也退不出）。新建路由开场冷（空表单 + route-1）。保存结尾干净但断链：toast「已存入草稿」后无发布引导。DangerNote 是高压时刻的真安抚。

## 做得好的

1. timing 预设 + field-flash：领域知识压成两个按钮，两端通吃。
2. DangerNote 体系：有值/缺失/表单未覆盖键三形态齐全，`cors.origins (absent)` 反向形态见功力。
3. 等于默认值不落键：工程决策直接产生设计收益——发布 diff 只说真话。

## 优先问题

- **P0 信息架构无分层**：7 区块无条件纵向堆叠，30+ 控件。Fix：基础（标识/匹配/上游）/高级两层，已有键的区块自动展开；「段存在即开关」形态上移到顶层。命令：/impeccable distill + /impeccable shape
- **P1 术语与输入格式不翻译**：终端命令、ISO 国家码、CIDR 三堵墙。Fix：国家码可搜索多选；CIDR 用 ipaddr.js 就地校验；access.keys 一键生成并哈希，终端命令降级为折叠高级项。命令：/impeccable onboard + /impeccable clarify
- **P1 guards 决策点超标**：四种心智模型一屏并列。Fix：「谁能来」单选概念（任何人/IP 白名单/特定国家/交给后端），选中才展开。命令：/impeccable distill
- **P1 JSON 出错锁死视图**：无行号、无逃生门。Fix：错误带行号与片段；提供「放弃 JSON 改动回表单」逃生门（JSON 是投影，表单原稿未被破坏）。命令：/impeccable clarify + /impeccable harden
- **P2 专家效率缺席**：无 Ctrl+S/格式化/锚点目录，与「全程不开终端」承诺冲突。Fix：Ctrl+S 绑保存、JSON 格式化按钮、区块目录。命令：/impeccable bolder + /impeccable shape
- **P3 保存后无发布引导**：toast 后断链。Fix：保存成功提供「去发布」动作。命令：/impeccable onboard

## Persona 红旗

- Alex：无 Ctrl+S；改 retries 滚 7 区块；无格式化。对高手的全部尊重由两个预设按钮承担。
- Jordan：空表单开场无任务映射；guards 一屏 6 决策点；「留空是安全的」从未显式传达；access.keys 终端命令执行后不知道粘哪段；保存后以为改完了，线上没变。
- Riley：未知键保留与危险子路径覆盖是好面；超长值仅 64KB 一刀切；空 JSON 保存能走到服务端才被拦。

## 次要观察

- Hint 等宽片段对比度 4.3:1（10 处）——token 层一次修好，hint 是小白的生命线。
- 条件行 present/absent 拆两下拉项是「把领域折进 UI」的好例子，值得推广。
- HTTP 方法 7 复选框 vs schema 任意 token：表单无「其他」输人口，单向门。
- disabled 输入 aria-disabled + placeholder 双语成立；上下移动而非拖拽、删除确认理由放正文——小正确决定。

## 挑衅性问题

1. 把 7 区块砍成 3（是什么/去哪里/谁能来），有用户投诉吗？——检验 IA 在服务任务还是 schema 直译。
2. 小白第一次做对是被教会了，还是恰好不需要高级字段？——目前是后者，面板没有「教」的动作。
3. 最高频任务（改一个数字）无快捷路径，最危险任务有整套 DangerNote——设计重量压在罕见而致命的一侧。
