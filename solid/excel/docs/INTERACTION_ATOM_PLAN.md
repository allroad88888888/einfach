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

前端新增一个框架无关的 UI core。它不是 workbook core，也不是 sheet data model；它只管两类
事情：

- 当前可视区域需要怎么展示。
- 用户当前正在怎么交互。

目录仍命名为 `interaction/`，但职责包含 viewport window 与 interaction overlay：

```text
solid/excel/src/interaction/
  atoms.ts              # primitive / derived / writable atoms
  viewport.ts           # scroll/size -> visible row/col window
  projection.ts         # bounded visible projection contract
  commands.ts           # selection/edit/menu/keyboard/viewport command
  types.ts              # 交互状态类型
  createInteraction.ts  # createStore() + 初始状态 + bridge API
  solid.tsx             # Solid 绑定层，只做 hooks/provider 桥接
```

核心规则：

- UI core 使用 `@einfach/core` 的 `atom`、`createStore`。
- Solid 组件通过 `@einfach/solid` 或很薄的本地 bridge 读取 atom；组件不再直接保存产品交互状态。
- `@einfach/solid-excel` 需要声明 workspace 依赖：`@einfach/core` 与 `@einfach/solid`。
- 每个 workbook/view 创建独立 UI store，禁止使用全局 default store 承载产品会话状态。
- Rust/WASM/worker 仍是 workbook facts 的唯一事实源：cell value、formula、dependency graph、
  formula cache、format metadata、sparse snapshot、import session 都不进入 JS atom。
- UI atom 只保存“可见什么”和“用户正在怎么操作”：viewport window、selection、edit mode、
  formula draft、menu、keyboard mode、viewport focus、fill handle、row/col resize 等。

## 可视窗口模型

这是跟传统前端表格最大的区别：前端渲染出来的永远只有可视区域，加少量 overscan。百万 cell
不是百万个 DOM，也不是百万个 atom。

UI core 只维护一个 viewport window：

- `scrollTop` / `scrollLeft`。
- viewport 宽高。
- row / col 尺寸模型。
- overscan 策略。
- derived `visibleWindow`：`rowStart`、`rowEnd`、`colStart`、`colEnd`。

数据流固定为：

1. DOM scroll / resize 更新 viewport metrics。
2. `visibleWindow` 由 viewport metrics 和尺寸模型推导出来。
3. UI 用 `sheetId + visibleWindow` 向 worker/Rust 请求当前窗口的 display projection。
4. Rust 只在读取这块窗口时计算需要展示的 cell；未读取的公式仍保持 lazy。
5. UI 渲染 visible cells、headers、selection overlay、active cell、editor、handles。
6. 窗口滑走后，旧窗口 projection 可以被替换或丢弃，不积累成整张表 cache。

尺寸模型也不能变成百万状态：

- 固定行高/列宽时，用 O(1) 数学从 scroll offset 算 row/col。
- 后续支持行高/列宽调整时，只保存 sparse override 或区间结构。
- 正在拖拽 resize 的预览属于 interaction state；真正持久化的 row/col size metadata 属于
  workbook facts，仍由 worker/Rust 或明确的 workbook metadata 层负责。

visible projection 是有界展示数据，不是核心事实源：

- 可以保存当前窗口的 display values / formats / errors / loading 状态。
- 必须按 window/version 替换，或最多保留很小的最近窗口缓存。
- 不能为窗口内每个 cell 创建独立 atom；一个 projection atom 或小量分块 atom 即可。
- 不能保存完整 sheet、完整 sparse snapshot、公式 cache 或依赖图。

## 状态边界

必须进 JS atom 的状态：

- 当前 sheet 交互上下文：`activeSheetId` / `activeSheetName` 的 UI 视角。
- viewport metrics：scroll offset、viewport size、overscan。
- visible window：当前需要展示的行列范围。
- visible projection 状态：当前窗口的数据请求状态和有界展示快照。
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
- 整张 sheet 的 dense matrix。
- 全量行/列尺寸数组。
- 公式依赖图或 dirty graph。
- worker sparse snapshot 的完整副本。
- 大范围 clipboard/export 的完整中间数据。

原则：UI 状态可以“指向”一个 range，也可以保存当前 visible window 的展示快照，但不能物化整张
sheet 或把 offscreen cell 变成长期状态。

## Lazy Formula 约束

selection 移动、右键、sheet tab 切换、toolbar 状态刷新不能触发公式求值。允许触发求值的路径仍然只有：

- 可见 cell 渲染读取 display value。
- 用户明确读取某个 cell。
- 导出、复制、保存需要读取结果。
- 订阅路径需要响应真实数据变化。

公式栏同步 draft 时，优先读取公式源码或用户输入源，不为了显示 draft 去读 formula result。
如果后续做公式引用拾取，也只能写 interaction atom 中的 reference-picking 状态，不能预热整片区域。

## 在线 Excel 功能域拆分

按在线 Excel 的功能拆域后，大部分能力是“命令 + 派生展示”，不是新状态。第一版 UI core
只保留 21 个核心 atom：14 个 writable/source atom，7 个 derived atom。

| 功能域 | 需要保存的 UI 状态 | 后端 / 命令负责 | 不建 atom 的内容 |
|---|---|---|---|
| Sheet 工作区 | 当前 UI 激活的 sheet、视图版本 | workbook store 切 sheet、增删改名 | 全量 sheet 列表 facts、sheet data |
| Viewport 渲染 | scroll、viewport size、overscan、visible projection | worker/Rust 按 window 取 display projection | offscreen cell、整张表 projection |
| 行列尺寸 | 默认尺寸、sparse override 的 UI 投影、resize 预览 | 持久化尺寸 metadata、结构操作 | 每行/每列一个 atom、全量尺寸数组 |
| 选择与导航 | anchor、focus、mode、active cell | 键盘命令、scrollToCell、range command | 展开 range 内所有地址 |
| Cell 编辑 | 当前编辑地址、draft、commit/cancel 状态 | set value/formula async command | cell value/formula/result 本体 |
| FormulaBar | focus、draft、diagnostic、引用拾取状态 | 公式解析、cycle 检查、lazy eval | 公式结果 cache |
| 公式引用拾取 | keyboard/reference-picking mode、临时引用 range | commit 时写公式文本 | 预读引用区域结果 |
| 右键菜单 | menu open/target/highlight | clear/copy/cut/insert/delete command | 菜单项结果、range 数据 |
| Toolbar / Ribbon | 打开的 dropdown、color picker、按钮可用性 | apply format/range format command | 单元格格式 facts |
| Clipboard | copy/cut/paste UI 状态、最近命令状态 | worker chunked export/import、浏览器 clipboard | 大范围 TSV 完整中间数据 |
| Fill handle / drag | drag 起点、当前点、预览 range | 小范围填充或 range command | 被填充区域每个 cell 状态 |
| Row/Col 结构 | header selection、resize/insert/delete 交互态 | worker/Rust row/col insert/delete | dense row/col model |
| Sheet tabs | tab menu、rename/delete 流程 UI | workbook store facts mutation | sheet 内容与依赖图 |
| Import/Export/Save | 进度、错误、取消中状态 | worker import session、snapshot、file sink | 导入 staging workbook、持久化 snapshot 副本 |
| Diagnostics / Status | 命令错误、加载状态、轻量 toast | 真实错误码来自 worker/Rust | 错误 cell 的全量索引 |

## 核心 Atom 清单

### Writable / Source Atom：14 个

这些 atom 是唯一需要直接写入的 UI source state。它们都是 workbook/view 级别，不按 cell、
row、col 动态创建。

| # | Atom | 负责内容 | 典型写入来源 |
|---|---|---|---|
| 1 | `activeSheetUiAtom` | 当前 UI 激活 sheet id/name、sheet view version | sheet tab click、workbook init |
| 2 | `viewportMetricsAtom` | scrollTop、scrollLeft、viewportW/H、overscan | scroll、resize、keyboard scroll |
| 3 | `dimensionProjectionAtom` | 默认 row/col size、visible/sparse size override | metadata load、resize preview/commit |
| 4 | `visibleProjectionAtom` | 当前 window 的 display cells、formats、errors、loading/version | worker visible read resolve |
| 5 | `selectionAtom` | anchor、focus、mode(cell/row/col/all)、lastIntent | click、keyboard、name box |
| 6 | `editSessionAtom` | editing addr、draft、source、dirty、commit policy | typing、F2、double click、FormulaBar |
| 7 | `formulaBarAtom` | focused、draft、diagnostic、lastValidatedInput | FormulaBar input、diagnostic response |
| 8 | `keyboardModeAtom` | navigation/editing/extending/reference-picking | keydown、edit begin/cancel |
| 9 | `pointerInteractionAtom` | drag-select、fill-handle、resize-row/col、autoscroll | pointer down/move/up |
| 10 | `contextMenuAtom` | open/closed、target kind/range、position、highlight | right click、keyboard menu |
| 11 | `toolbarUiAtom` | open dropdown、color picker、pending toolbar command | toolbar click、format picker |
| 12 | `sheetTabUiAtom` | tab context menu、rename/delete UI flow | tab right click、prompt/confirm |
| 13 | `clipboardUiAtom` | cut/copy source marker、paste mode、last clipboard error | copy/cut/paste command |
| 14 | `asyncOperationUiAtom` | import/export/save/load progress、cancel/error/toast | worker operation events |

### Derived Atom：7 个

这些 atom 只从 source atom 推导，不单独保存第二份状态。

| # | Atom | 派生自 | 用途 |
|---|---|---|---|
| 15 | `visibleWindowAtom` | `viewportMetricsAtom` + `dimensionProjectionAtom` | 得到 rowStart/rowEnd/colStart/colEnd |
| 16 | `visibleRequestAtom` | `activeSheetUiAtom` + `visibleWindowAtom` + projection version | 生成 worker/Rust display projection 请求 key |
| 17 | `selectionRectAtom` | `selectionAtom` | 标准化 selection rectangle，不展开地址 |
| 18 | `activeCellAddrAtom` | `selectionAtom` + `activeSheetUiAtom` | FormulaBar、name box、active cell overlay |
| 19 | `gridOverlayAtom` | visible window + selection/edit/pointer/menu | active cell、selection、fill、resize、editor 的 overlay |
| 20 | `formulaInputViewAtom` | formulaBar + editSession + activeCell | 决定 FormulaBar 展示 draft/source/diagnostic |
| 21 | `commandAvailabilityAtom` | selection/edit/menu/operation/projection | toolbar/menu/shortcut 是否可用 |

### 不计入 Atom 的东西

命令不是 atom。第一版命令以 function 或 writable command atom 封装写入，但不增加长期状态：

- `scrollToCell`
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
- `copySelection`
- `pasteAtSelection`
- `applyFormatToSelection`
- `beginFillHandle`
- `beginResizeRowCol`
- `startImport`
- `cancelImport`

visible projection 如果后续需要优化重渲染，可以拆成 bounded window shard atom，但必须满足：

- shard 数量跟 visible window 或 overscan 上限绑定，不能跟 sheet 总 cell 数绑定。
- shard cache 必须有很小的 max size，例如最近 4 到 8 个 window。
- shard atom 只保存展示快照，不能保存公式 cache、依赖图或 sparse workbook snapshot。

## 分阶段执行

交互 atom 化按 IA-0 到 IA-6 推进：IA-0 是规划冻结，IA-1 到 IA-6 是实现与收口。
每波都要先有单元测试，再迁 UI；涉及浏览器行为的波次必须跑 Playwright CLI，并补 MCP
Playwright 验证记录。

| 波次 | 目标 | 可并行角色 | 交付物 |
|---|---|---|---|
| IA-0 | 固定合同与依赖 | 架构 / 测试 / 审查 | 本文档、状态白名单、`@einfach/core`/`@einfach/solid` 依赖计划 |
| IA-1 | 建 UI core | Viewport / Atom core / Solid bridge | `interaction/*`、21 个 atom 清单、visible window 单测、无 UI 行为变化 |
| IA-2 | selection + keyboard 迁移 | Selection / Keyboard / E2E | `sheet-store` selection 改由 UI core 驱动，键盘导航合同测试 |
| IA-3 | edit + formula bar 迁移 | Edit / FormulaBar / Diagnostics | F2、Enter、Tab、Esc、formula diagnostics 状态归一 |
| IA-4 | menu + sheet tabs + toolbar 迁移 | ContextMenu / SheetTabs / Toolbar | 右键菜单、tab 菜单、toolbar 可用状态统一进 atom |
| IA-5 | Excel 交互补齐 | UX / E2E / MCP | row/col 选择、fill handle、resize、range extend、MCP 记录 |
| IA-6 | 收口与门禁 | Review / Perf / Docs | grep gate、全量 e2e、MCP gate、文档同步 |

## 并行 Agent 计划

总架构师负责接口冻结、集成和最终验收。子 agent 只能提交候选补丁。

### IA-1 建 UI core

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| A1 Viewport Core | Codex Spark | `solid/excel/src/interaction/viewport.ts`, `types.ts` | scroll/size/overscan 推导 visible window，不碰 UI |
| A2 Atom Core | Codex Spark | `solid/excel/src/interaction/*` | 定义 atoms、commands、createInteractionStore |
| A3 Solid Bridge | Codex Spark | `solid/excel/src/interaction/solid.tsx`, `solid/excel/package.json` | 接入 `@einfach/solid` bridge，不迁业务组件 |
| A4 Tests | Claude Sonnet 或 Codex Mini | `solid/excel/test/interaction*.test.ts` | 纯 store 单测：21 个核心 atom、visible window、selection/edit/menu/derived 状态 |

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
- 新增第 22 个核心 atom，但无法说明为什么不能放进已有 source atom 或 derived atom。
- selection 或 toolbar 派生需要展开大 range 地址列表。
- viewport/projection 实现会累积 offscreen window 数据，或保留完整 sheet snapshot。
- 行高/列宽实现需要创建全量 row/col atom 或全量尺寸数组。
- UI 状态迁移导致公式在 selection 移动时被 eager eval。
- UI store 保存了 worker snapshot、formula cache 或 dependency graph。
- Solid bridge 为了方便绕开 `@einfach/core`，重新引入框架本地产品状态。
- MCP 无法验证交互变更，但代码已经改了浏览器行为。

## 完成定义

交互 atom 化完成时，需要同时满足：

- 产品交互状态只由 JS atom/store 承载。
- UI core 只关心 visible window、bounded visible projection 和 interaction overlay。
- 第一版核心 atom 数量保持 21 个：14 个 writable/source + 7 个 derived。
- Rust/WASM/worker 继续是 workbook facts 的唯一事实源。
- selection/edit/menu/formula bar/toolbar/sheet tabs 有可独立运行的 atom 单测。
- viewport window 有独立单测，证明可见行列范围由 scroll/size 推导，不创建 per-cell 状态。
- 1M demo 中 selection、keyboard、右键、大 range toolbar 操作不物化百万地址。
- 公式 lazy 约束不回退：导入、设置公式、selection 移动不触发 eager compute。
- Playwright 全量通过，MCP 记录关键交互和 console 结果。
