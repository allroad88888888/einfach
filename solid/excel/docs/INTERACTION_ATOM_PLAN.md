# Solid Excel 交互 Atom 化规划

> 日期：2026-05-14
>
> 目标：在线电子表格交互体验向 Excel 对齐；交互层核心状态使用
> `@einfach/core` 的 JS atom/store；Rust/WASM/worker 继续作为工作簿事实源。

## 背景

当前主线已经完成百万 cell、worker-backed workbook、跨 sheet lazy formula、range-native
大范围操作、导入 backpressure、Playwright + MCP 发布门禁。下一段重点从“能承载大表”
转到“交互体验像表格产品”。

现状里仍有一批产品交互状态散在 Solid `createSignal` 中：

- `solid/excel/src/sheet-store.ts`：selection、anchor、订阅 tick。
- `solid/excel/src/Table.tsx`：滚动视口、右键菜单。
- `solid/excel/src/FormulaBar.tsx`：draft、focused、formulaError。
- `solid/excel/src/ContextMenu.tsx`：highlight、菜单位置。
- `solid/excel/src/SheetTabs.tsx`：sheet tab context menu。

这能跑，但不利于继续做 Excel 级交互：键盘模式、编辑模式、公式栏、右键菜单、sheet tab
命令会互相影响；如果继续分散在组件 signal 里，测试和状态回放会越来越难。

## 架构决定

交互层新增一个框架无关的 interaction core：

```text
solid/excel/src/interaction/
  atoms.ts              # primitive / derived / writable atoms
  commands.ts           # selection/edit/menu/keyboard command
  types.ts              # 交互状态类型
  createInteraction.ts  # createStore() + 初始状态 + bridge API
  solid.tsx             # Solid 绑定层，只做 hooks/provider 桥接
```

核心规则：

- interaction core 使用 `@einfach/core` 的 `atom`、`createStore`。
- Solid 组件通过 `@einfach/solid` 或很薄的本地 bridge 读取 atom；组件不再直接保存产品交互状态。
- `@einfach/solid-excel` 需要声明 workspace 依赖：`@einfach/core` 与 `@einfach/solid`。
- 每个 workbook/view 创建独立 interaction store，禁止使用全局 default store 承载产品会话状态。
- Rust/WASM/worker 仍是 workbook facts 的唯一事实源：cell value、formula、dependency graph、
  formula cache、format metadata、sparse snapshot、import session 都不进入 JS atom。
- interaction atom 只保存“用户正在怎么操作”：selection、edit mode、formula draft、menu、
  keyboard mode、viewport focus、fill handle、row/col resize 等。

## 状态边界

必须进 JS atom 的状态：

- 当前 sheet 交互上下文：`activeSheetId` / `activeSheetName` 的 UI 视角。
- selection：anchor、focus、normalized range、选择模式（cell / row / col / all）。
- keyboard mode：navigation、range extend、edit、formula reference picking。
- edit state：正在编辑的地址、输入来源、draft、commit/cancel 意图。
- formula bar state：focused、draft、diagnostics、是否接管 cell editor。
- context menu state：菜单类型、目标地址/行/列/range、highlight。
- sheet tab UI state：tab 菜单、rename/delete 流程中的交互状态。
- fill handle / drag select / row-col resize 的进行中状态。
- toolbar command state：当前命令是否可用、最近一次用户命令，不复制后端格式事实。

可以继续留在 Solid 本地原语的状态：

- DOM ref。
- ResizeObserver 的一次性尺寸读数。
- requestAnimationFrame id、pointer capture 临时变量。
- 只影响布局测量、不影响用户流程或业务命令的瞬时值。

禁止进入 JS atom 的状态：

- 每个 cell 的 value/formula/result/cache。
- 每行/每列/每个空 cell 的 atom。
- 公式依赖图或 dirty graph。
- worker sparse snapshot 的完整副本。
- 大范围 clipboard/export 的完整中间数据。

原则：交互状态可以“指向”一个 range，但不能物化这个 range 的所有地址。

## Lazy Formula 约束

selection 移动、右键、sheet tab 切换、toolbar 状态刷新不能触发公式求值。允许触发求值的路径仍然只有：

- 可见 cell 渲染读取 display value。
- 用户明确读取某个 cell。
- 导出、复制、保存需要读取结果。
- 订阅路径需要响应真实数据变化。

公式栏同步 draft 时，优先读取公式源码或用户输入源，不为了显示 draft 去读 formula result。
如果后续做公式引用拾取，也只能写 interaction atom 中的 reference-picking 状态，不能预热整片区域。

## Atom 模型草案

第一版只建全局交互 atom，不做 per-cell atom：

- `activeSheetAtom`：当前交互 sheet id/name。
- `selectionAtom`：anchor/focus/mode。
- `selectionRectAtom`：derived，标准化后的矩形，不展开地址列表。
- `activeCellAddrAtom`：derived，当前 focus 地址。
- `editSessionAtom`：编辑地址、draft、source、dirty、commit policy。
- `formulaBarAtom`：focused、draft、diagnostic、lastValidatedInput。
- `keyboardModeAtom`：navigation/editing/extending/fill/reference-picking。
- `contextMenuAtom`：closed 或打开状态、坐标、target kind、target range。
- `dragStateAtom`：drag-select、fill-handle、resize-row、resize-col。
- `commandAvailabilityAtom`：derived，基于 selection/edit/menu 推导 UI 按钮可用性。

命令通过 writable atom 或 command function 统一写入：

- `selectCell`
- `selectRange`
- `extendSelection`
- `moveSelectionByKeyboard`
- `beginEdit`
- `updateEditDraft`
- `commitEdit`
- `cancelEdit`
- `openContextMenu`
- `closeContextMenu`
- `beginFillHandle`
- `beginResizeRowCol`

命令层可以调用现有 `SheetStore` / worker command，但不保存后端数据副本。

## 分阶段执行

交互 atom 化按 IA-0 到 IA-6 推进：IA-0 是规划冻结，IA-1 到 IA-6 是实现与收口。
每波都要先有单元测试，再迁 UI；涉及浏览器行为的波次必须跑 Playwright CLI，并补 MCP
Playwright 验证记录。

| 波次 | 目标 | 可并行角色 | 交付物 |
|---|---|---|---|
| IA-0 | 固定合同与依赖 | 架构 / 测试 / 审查 | 本文档、状态白名单、`@einfach/core`/`@einfach/solid` 依赖计划 |
| IA-1 | 建 interaction core | Atom core / Solid bridge | `interaction/*`、纯 JS atom 单测、无 UI 行为变化 |
| IA-2 | selection + keyboard 迁移 | Selection / Keyboard / E2E | `sheet-store` selection 改由 interaction core 驱动，键盘导航合同测试 |
| IA-3 | edit + formula bar 迁移 | Edit / FormulaBar / Diagnostics | F2、Enter、Tab、Esc、formula diagnostics 状态归一 |
| IA-4 | menu + sheet tabs + toolbar 迁移 | ContextMenu / SheetTabs / Toolbar | 右键菜单、tab 菜单、toolbar 可用状态统一进 atom |
| IA-5 | Excel 交互补齐 | UX / E2E / MCP | row/col 选择、fill handle、resize、range extend、MCP 记录 |
| IA-6 | 收口与门禁 | Review / Perf / Docs | grep gate、全量 e2e、MCP gate、文档同步 |

## 并行 Agent 计划

总架构师负责接口冻结、集成和最终验收。子 agent 只能提交候选补丁。

### IA-1 建 core

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| A1 Atom Core | Codex Spark | `solid/excel/src/interaction/*` | 定义 atoms、commands、createInteractionStore |
| A2 Solid Bridge | Codex Spark | `solid/excel/src/interaction/solid.tsx`, `solid/excel/package.json` | 接入 `@einfach/solid` bridge，不迁业务组件 |
| A3 Tests | Claude Sonnet 或 Codex Mini | `solid/excel/test/interaction*.test.ts` | 纯 store 单测：selection/edit/menu/derived 状态 |

验收：

```sh
npx tsc -p solid/excel/tsconfig.json --noEmit
npx jest solid/excel/test/interaction-core.test.ts
npm run build -w @einfach/solid-excel
```

### IA-2 Selection + Keyboard

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| B1 Selection Adapter | Claude Sonnet | `solid/excel/src/sheet-store.ts`, `solid/excel/src/Table.tsx` | selection/anchor 改接 interaction store |
| B2 Keyboard | Codex Spark | `solid/excel/src/Table.tsx`, keyboard helpers | Arrow/Shift/Ctrl/Home/End/Page 键行为统一命令层 |
| B3 E2E | Codex Spark | `solid/excel/e2e/million-demo.spec.ts`, `selection-clipboard.spec.ts` | 键盘跨虚拟视口、range extend、selection 不物化 |

验收：

```sh
npx jest solid/excel/test/interaction-core.test.ts
npx tsc -p solid/excel/tsconfig.json --noEmit
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/million-demo.spec.ts e2e/selection-clipboard.spec.ts
```

MCP：

- 打开 1M demo。
- 键盘移动到视口外再回来。
- 验证 selection 正确、DOM cell 数量有界、console 无 warning/error。

### IA-3 Edit + FormulaBar

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| C1 Edit Session | Claude Sonnet | `solid/excel/src/Cell.tsx`, `interaction/*` | typing/F2/double click/commit/cancel 状态归一 |
| C2 FormulaBar | Codex Spark | `solid/excel/src/FormulaBar.tsx` | draft/focus/diagnostic 迁到 atom |
| C3 Tests | Codex Spark | `formula-bar.spec.ts`, interaction tests | Enter/Tab/Esc/F2、非法公式、cycle diagnostic |

特别约束：

- FormulaBar draft 同步不能因为 selection 改变而读取公式结果。
- commit 仍走 worker-backed async formula command，不能回退到 optimistic sync `set_formula`。

### IA-4 Menu / SheetTabs / Toolbar

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| D1 Menu | Codex Spark | `ContextMenu.tsx`, `Table.tsx`, `interaction/*` | 菜单打开目标、highlight、关闭状态迁 atom |
| D2 SheetTabs | Codex Spark | `SheetTabs.tsx`, workbook store bridge | tab menu/rename/delete 流程迁 atom |
| D3 Toolbar | Claude Sonnet | `FormatToolbar.tsx`, command availability | toolbar command state 只派生，不复制格式事实 |

验收重点：

- 右键命中已选 range 时不折叠选区。
- 大 range Clear/Copy/Format 继续走 range-native worker 路径。
- tab rename/delete 不污染 workbook facts。

### IA-5 Excel 交互补齐

本波面向用户感知，必须用 MCP 验证。

目标：

- row header / col header 点击选择整行整列。
- Shift + 点击扩展 range。
- Ctrl + Arrow 跳转到区域边界。
- Home / End / PageUp / PageDown 行为对齐表格常识。
- fill handle 第一版：小范围拖拽复制或序列填充，大范围必须走 range command。
- row/col resize 第一版：只保存 UI 交互尺寸，不写入 cell facts。

验收：

```sh
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel
```

MCP：

- 1M demo：键盘、range extend、row/col header、fill handle。
- MultiSheet demo：跨 sheet 后 selection/edit/menu 状态不串。
- FormulaBar：非法公式和 cycle 显示诊断后可恢复。
- console 无 warning/error。

### IA-6 收口

收口 gate：

```sh
rg -n "createSignal|from 'solid-js/store'|from \"solid-js/store\"" solid/excel/src
npx tsc -p solid/excel/tsconfig.json --noEmit
npm run build -w @einfach/solid-excel
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel
npm test
```

`createSignal` grep 不要求绝对为 0，但必须有白名单：

- DOM ref / measurement / animation frame。
- i18n locale 这类独立基础设施如果暂不迁移，要单独记录。
- demo-only import progress 如果影响产品导入流程，后续也应迁 atom。

## 停止条件

遇到以下情况必须暂停并重规划：

- 任何实现试图为百万 cell 创建 per-cell atom。
- selection 或 toolbar 派生需要展开大 range 地址列表。
- UI 状态迁移导致公式在 selection 移动时被 eager eval。
- interaction store 保存了 worker snapshot、formula cache 或 dependency graph。
- Solid bridge 为了方便绕开 `@einfach/core`，重新引入框架本地产品状态。
- MCP 无法验证交互变更，但代码已经改了浏览器行为。

## 完成定义

交互 atom 化完成时，需要同时满足：

- 产品交互状态只由 JS atom/store 承载。
- Rust/WASM/worker 继续是 workbook facts 的唯一事实源。
- selection/edit/menu/formula bar/toolbar/sheet tabs 有可独立运行的 atom 单测。
- 1M demo 中 selection、keyboard、右键、大 range toolbar 操作不物化百万地址。
- 公式 lazy 约束不回退：导入、设置公式、selection 移动不触发 eager compute。
- Playwright 全量通过，MCP 记录关键交互和 console 结果。
