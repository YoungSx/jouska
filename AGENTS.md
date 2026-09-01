# AGENTS.md

## UI 控件原则（硬约束）

界面控件一律用 shadcn/ui 官方 Base UI 版原样件（`components/ui/` 下的组件，Base UI + cva）。

- 产品层只通过 variant 与 `className` 组合来适配，不改 `components/ui/` 原样件。
- 如无必要禁止手搓 UI 控件：官方库已覆盖的交互控件（菜单、弹窗、标签页、表格、开关等）不得用裸 `div`/`button` + 手写 state 重新实现。
- 需要新形态时先找官方原样件里最近的组件，用组合达成；组合不到再回到 DESIGN.md 立档讨论。

## 开发

- 前端在 `workers/admin-panel/web`：`npm run dev` / `build` / `typecheck` / `test`。
- 界面文案集中在 `web/src/lib/messages.ts`，组件不写裸字符串。
- 设计规范见 `DESIGN.md`，产品背景见 `PRODUCT.md`。
