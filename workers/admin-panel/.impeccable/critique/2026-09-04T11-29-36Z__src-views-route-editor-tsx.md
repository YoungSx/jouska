---
target: 审计路由编辑模块 src/views/route-editor.tsx
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 1
timestamp: 2026-09-04T11-29-36Z
slug: src-views-route-editor-tsx
---
# 路由编辑器复审 · 双代理综合报告

**Method: dual-agent (A: aafede2caa74f18f8 · B: critique-B)**
**Target:** `workers/admin-panel/web/src/views/route-editor.tsx`（Operate 模式）

A = 无锚定设计审查（playwright 截图桌面+移动，未读旧 critique）；B = 反模式检测器（CLI 三文件 + 浏览器注入）。

## 上一轮修复验收
- P0 无分层 → 治好（四层 IA + 手风琴，A 独立确认结构特异性强）
- P1 JSON 出错锁死 → 治好（escapeJson + 脏态确认被评为产品级错误恢复）
- P3 保存后无去向 → 治好（「去发布」toast 被评为最诚实的峰值）
- P1 术语 / P2 专家效率 → 延后（用户批准）

## Nielsen 十条（27/40）
1. 状态可见性 3 — 保存灰着原因藏在收起卡
2. 系统与现实匹配 3 — 两处文案对行为撒谎
3. 用户控制与自由 4 — Esc 确认 + escapeJson，满分
4. 一致性与标准 3 — needsFix 徽章只接线 2 处
5. 错误预防 2 — 未触碰字段提前判红
6. 识别而非回忆 2 — 帮助是整段话
7. 灵活与效率 3 — 「改个 path」无最短路径
8. 美学与极简 3 — 默认 true 开关排成墙
9. 诊断与修复错误 1 — 最弱项
10. 帮助与文档 3 — 段落式 help 是税

## 双代理对齐
- 互证：A 的 P0（收起卡错误不可见）× B 的 nested-cards ×11（AccordionItem 卡片嵌在 DialogContent 内，机制为真）——B 找到的嵌套卡正是 A 实测里藏错误的抽屉。
- B cramped-padding flush ×5：AccordionTrigger 只有 py-3 无水平 padding，映射 DESIGN.md 触摸命中区「只补高度不补宽度」的既有决策，非缺陷，polish 轮可看。
- B 误报剔除 4 类：line-length（CJK 误算）、flat-type-hierarchy（16px 封顶是设计规矩）、gradient-text（检测器自扫描）、layout-transition（sonner 供应商 CSS）。CLI 三文件全零发现。

## 优先问题
### P0 · 数值越界错误不可见却阻塞保存
错误来自全字段 NUMERIC_BOUNDS 检查，needsFix 徽章只接线 forwardAuth 保留头与 headers 保留头两处；其余卡片越界错误收起后不可见（A DIAG2 实测 + B 嵌套卡证据互证）。修复方向：collectErrors 带字段→卡片归属，收起卡有错亮红徽章；保存禁用旁给第一条错误摘要。可与延后的 needsFix 全量接线合并一轮做。
### P1 · 两处文案对行为撒谎
jsonInvalid 说「先修好才能切回表单」实际 handleTabChange 放行；jsonEscape 叫「回到表单」实际只回滚 JSON 文本。修复方向：改文案或改行为二选一。
### P3 · 新建模式第一屏提前判红
upstream 必填错误在用户未触碰时已红。修复方向：延迟到 touched 或首次保存尝试。
### P3 · 手风琴展开后层级塌平
高级区 4 个默认 true 开关、守卫族 5 卡并列无分层锚点。修复方向：卡头加「已启用/默认」状态字（文字，维持灰阶纪律）。

## 做得好的
1. 「保存到草稿」+ 草稿条：把「保存≠上线」刻进每次动作的视线。
2. escapeJson + 脏态确认：产品级错误恢复。
3. 危险区域色相纪律：红色只意味着「按下去会改变生产流量」。

## Persona 红牌
- Alex（专家）：JSON 快通道好，但 P0 逼他翻 console debug 界面。
- Jordan（新手）：段落 help、7 复选框全空语义不清、收起卡错误不可见。
- Riley（压力）：需要全局错误索引「哪里红点哪里」；豁免项是 44px 命中区、focus-visible、Esc 确认。

## 挑衅性提问
1. 灰色按钮是「系统不同意」还是「系统没准备好」？灰阶换掉色相语言后，禁用原因只能由文案承担。
2. 8 张折叠卡是渐进披露，还是把负荷推迟到「全展开确认保存」的瞬间？
3. 如果 JSON tab 才是专家的真身，表单 tab 为谁存在？
