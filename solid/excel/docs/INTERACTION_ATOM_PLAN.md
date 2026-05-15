# Spreadsheet UI Core + Solid Excel 重做规划

> 日期：2026-05-14
>
> 目标：保留 `@einfach/solid-excel` 包名，但重做内部 UI 架构；先新建一个
> framework-agnostic spreadsheet UI core 包，核心状态使用 `@einfach/core` 的 JS
> atom/store；Rust/WASM/worker 继续作为工作簿事实源。
>
> 说明：本文暂放在 `solid/excel/docs/`，因为新包尚未创建。PC-1 创建
> `vanilla/spreadsheet-ui-core/` 后，应把核心架构文档迁到新包 `README.md` 或 `docs/`。

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

因此这里调整方向：`@einfach/solid-excel` 保留包名，但内部实现重做。旧实现冻结为
legacy/reference，只作为已有 demo、worker/Rust 适配来源和 E2E 对照场。新的交互核心单独
成包，新的 Solid UI 基于这个 core 重新实现，避免 UI、worker 适配、demo、历史兼容逻辑混在
一起。

## 总体策略

不是推倒整个项目，而是分层重做：

```text
Rust/WASM/worker
  保留：workbook facts、formula、lazy eval、range ops、import/export backend。

@einfach/spreadsheet-ui-core
  新建：framework-agnostic UI core，只管 viewport / projection / interaction / command。

@einfach/solid-excel
  保留包名，重做实现：新的 Solid UI 只做绑定、组件、adapter、demo 和 e2e。

legacy solid-excel UI
  冻结：作为参考和回归对照，不继续扩核心架构。
```

最终对外仍然交付 `@einfach/solid-excel`，只是内部从 legacy 实现切到 vNext 实现。

## 架构决定

新建 `@einfach/spreadsheet-ui-core`，建议落在：

```text
vanilla/spreadsheet-ui-core/
```

它是 framework-agnostic UI core。它不是 workbook core，也不是 sheet data model；它只管两类
事情：

- 当前可视区域需要怎么展示。
- 用户当前正在怎么交互。

包内目录按功能拆分，职责包含 viewport window、visible projection contract 与 interaction
overlay：

```text
vanilla/spreadsheet-ui-core/
  package.json
  tsconfig.json
  README.md
  src/
    index.ts
    createSpreadsheetUi.ts
    backend/          # workbook 数据读取/写入 port，不绑定 worker/Rust 实现
    workspace/
    viewport/
    projection/
    selection/
    keyboard/
    editing/
    formula-bar/
    pointer/
    menu/
    toolbar/
    clipboard/
    sheet-tabs/
    operations/
    diagnostics/
    shared/
  test/
```

核心规则：

- UI core 使用 `@einfach/core` 的 `atom`、`createStore`。
- UI core 不依赖 Solid、React、DOM、worker、wasm-bindgen、CSS 或 Playwright。
- Solid 组件后续通过 `@einfach/solid-excel` 的 vNext adapter 读取 core atom；组件不再直接
  保存产品交互状态。
- `@einfach/solid-excel` 保留包名并重做实现，但不在包内新增第二套核心状态模型。
- 每个 workbook/view 创建独立 UI store，禁止使用全局 default store 承载产品会话状态。
- Rust/WASM/worker 仍是 workbook facts 的唯一事实源：cell value、formula、dependency graph、
  formula cache、format metadata、sparse snapshot、import session 都不进入 JS atom。
- UI atom 只保存“可见什么”和“用户正在怎么操作”：viewport window、selection、edit mode、
  formula draft、menu、keyboard mode、viewport focus、fill handle、row/col resize 等。

## 包边界

### 新包：`@einfach/spreadsheet-ui-core`

负责：

- viewport window 计算。
- visible projection 请求合同。
- selection、keyboard、editing、formula bar、menu、toolbar、clipboard、sheet tabs 等交互状态。
- command model：把 UI intent 转换成 backend port 调用。
- framework-agnostic 单测。

禁止：

- 直接 import `solid-js` / `@einfach/solid`。
- 直接 import worker proxy、WASM glue 或 Rust generated package。
- 直接读写 DOM。
- 保存 workbook facts、formula cache、dependency graph、sparse snapshot。
- 为 cell/row/col 建无界 atom。

### `@einfach/solid-excel`

保留包名，拆成两个阶段：

1. **legacy 阶段**：旧实现保留，冻结架构，只做必要 bug fix。
2. **vNext 阶段**：基于 `@einfach/spreadsheet-ui-core` 重做 Solid UI，验证通过后切换入口。

legacy 短期角色：

- 保留现有 demo、Playwright e2e、MCP 验证入口。
- 保留 worker/Rust 适配代码，作为新 core backend port 的候选实现来源。
- 保留现有 UI，作为回归对照和迁移参考。

vNext 目标结构建议：

```text
solid/excel/src-vnext/
  index.tsx
  provider/         # Solid Provider / hooks，连接 @einfach/spreadsheet-ui-core
  adapter/          # worker/Rust backend port 实现
  grid/             # viewport grid、headers、cells、overlays
  formula-bar/
  toolbar/
  sheet-tabs/
  context-menu/
  status-bar/
  demos/
  test-utils/
```

不再做：

- 不在 `solid/excel/src` 里继续扩张新的核心交互状态架构。
- 不把 `sheet-store.ts`、`Table.tsx` 继续改成“第二个 core”。
- 不把 formula cache、workbook facts、visible projection 长期副本塞进 Solid 状态。

最终切换：

- `src-vnext` 的 API、demo、e2e 达到 legacy parity 后，把 package 入口切到 vNext。
- legacy 目录保留一段时间作为对照，再按独立清理任务删除。
- 不新建 `@einfach/solid-spreadsheet`，除非未来需要另一个完全不同的产品线。

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

1. 宿主适配层把 DOM scroll / resize 的测量结果传入 viewport metrics。
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

## 在线 Excel 功能拆分

文档只冻结功能边界和文件夹结构，不在规划阶段拍死 atom 名称或数量。每个功能子 agent 在自己
负责的文件夹内设计 atom，并提交一份状态决策说明；总架构师验收是否符合 lazy、百万 cell 和
Einfach 状态唯一来源约束。

### 文件夹结构

第一版按在线 Excel 的功能拆到新包 `vanilla/spreadsheet-ui-core/src/` 下：

```text
vanilla/spreadsheet-ui-core/src/
  workspace/        # 当前工作区、active sheet UI 视角、view lifecycle
  viewport/         # scroll/resize -> visible window，row/col 尺寸投影
  projection/       # visible window 的展示快照、worker/Rust request 合同
  selection/        # active cell、range、row/col/all selection、name box anchor
  keyboard/         # navigation/edit/range extend/reference-picking 模式与快捷键
  editing/          # cell editor、commit/cancel、draft 来源
  formula-bar/      # formula bar draft、focus、diagnostics、引用拾取接线
  pointer/          # drag select、fill handle、row/col resize、autoscroll
  menu/             # cell/header/context menu、target、highlight
  toolbar/          # ribbon/toolbar UI、dropdown、format command availability
  clipboard/        # copy/cut/paste UI 状态，worker chunked export/import 接线
  sheet-tabs/       # tab context menu、rename/delete UI flow
  operations/       # import/export/save/load 进度、取消、错误提示
  diagnostics/      # command error、toast/status、debug panel UI
  shared/           # 共享类型、坐标/range helper、跨模块 command bus
  backend/          # framework-agnostic workbook backend port
  createSpreadsheetUi.ts
  index.ts
```

每个功能文件夹建议保持相同骨架，但子 agent 可以按复杂度裁剪：

```text
feature-name/
  README.md         # 功能边界 + atom 决策记录
  types.ts          # 纯类型
  atoms.ts          # source/derived atom 定义
  commands.ts       # command functions 或 writable command atom
  selectors.ts      # 派生读取；不保存第二份状态
  index.ts          # 只导出公共 API
```

### 功能域边界

| 功能域 | 文件夹 | UI core 保存 | worker/Rust 或命令负责 | 不允许保存 |
|---|---|---|---|---|
| 工作区 | `workspace/` | 当前 UI 工作区、active sheet UI 视角、view lifecycle | workbook facts、sheet 增删改名 | 全量 sheet data |
| Viewport | `viewport/` | scroll、viewport size、overscan、row/col 尺寸投影 | 持久化 row/col metadata | 全量尺寸数组、每行/列 atom |
| 展示投影 | `projection/` | 当前 visible window 的展示快照与请求状态 | display value、format、formula lazy read | offscreen cell cache、sheet snapshot |
| 选择导航 | `selection/` | active cell、anchor/focus、range/header selection | range command、scrollToCell | 展开 range 地址 |
| 键盘模式 | `keyboard/` | navigation/edit/extend/reference-picking 模式 | 具体命令分发 | cell data、formula result |
| Cell 编辑 | `editing/` | editing addr、draft、commit/cancel UI 状态 | set value/formula async command | value/formula/result facts |
| FormulaBar | `formula-bar/` | bar focus、draft、diagnostic、引用拾取 UI | parser/cycle/lazy eval | formula cache |
| 指针交互 | `pointer/` | drag/fill/resize 进行中状态 | fill/range/resize commit command | 被拖拽区域 cell 状态 |
| 菜单 | `menu/` | menu open、target、position、highlight | clear/copy/insert/delete command | 菜单命令结果数据 |
| Toolbar | `toolbar/` | dropdown、picker、按钮可用性 UI | format/range format command | 单元格格式 facts |
| Clipboard | `clipboard/` | copy/cut/paste UI 状态、错误 | browser clipboard、worker chunked export/import | 大范围 TSV 中间数据 |
| Sheet tabs | `sheet-tabs/` | tab menu、rename/delete flow | workbook mutation | sheet 内容、依赖图 |
| Operations | `operations/` | import/export/save/load progress、cancel/error | worker sessions、file sink | staging workbook、snapshot 副本 |
| Diagnostics | `diagnostics/` | toast/status/debug panel UI | worker/Rust error code 和 counters | 错误 cell 全量索引 |
| Backend Port | `backend/` | 不保存状态，只定义端口和 request/response 类型 | solid-excel worker/Rust adapter 实现端口 | 直接绑定 worker/WASM |

### Atom 决策交给子 Agent

每个子 agent 在实现某个功能文件夹时，必须在该文件夹 `README.md` 里写清：

- 这个功能需要哪些 source atom。
- 哪些状态是 derived atom，为什么不直接存第二份。
- 哪些行为是 command，不作为长期状态保存。
- atom 的数量和命名。
- 每个 atom 的规模上界：跟 workbook、visible window、selection，还是用户操作会话绑定。
- 是否会触发 Rust/worker 读取；如果会，是否只限 visible window 或显式用户命令。
- 为什么不会创建 per-cell/per-row/per-col atom。
- 相关单测和 Playwright/MCP 验证点。

总架构师验收时看的是边界，不是预设数量：

- atom 数量越少越好，但不能为了少而把不相关功能塞进一个难以维护的大 atom。
- 能 derived 的不做 source。
- 能 command 表达的，不做长期状态。
- 能由 worker/Rust 作为事实源的，不进 UI atom。
- 动态 atom 必须 bounded cache，并证明上限跟 visible window 绑定。

## 分阶段执行

新包和 `@einfach/solid-excel` vNext 按 PC-0 到 PC-7 推进：PC-0 是规划冻结，PC-1 到
PC-5 做 framework-agnostic core，PC-6 平行重做 Solid UI，PC-7 切换包入口与收口。
每波都要先有单元测试，再迁 UI；涉及浏览器行为的波次必须跑
Playwright CLI，并补 MCP Playwright 验证记录。

| 波次 | 目标 | 可并行角色 | 交付物 |
|---|---|---|---|
| PC-0 | 固定新包合同 | 架构 / 测试 / 审查 | 本文档、新包边界、legacy 冻结 + vNext 重做规则 |
| PC-1 | 新包骨架 | Package / Feature folders / Test harness | `vanilla/spreadsheet-ui-core`、功能文件夹、README 决策模板 |
| PC-2 | Viewport + Projection | Viewport / Backend port / Tests | visible window、projection request、backend port 单测 |
| PC-3 | Selection + Keyboard | Selection / Keyboard / Adapter | framework-agnostic selection/keyboard command，不接 UI 或只接 demo flag |
| PC-4 | Editing + FormulaBar | Editing / FormulaBar / Diagnostics | draft/commit/cancel/diagnostic 状态与 backend command 合同 |
| PC-5 | Menu + Toolbar + Clipboard + Tabs | UI Commands / Range ops | menu/toolbar/clipboard/sheet-tab command core |
| PC-6 | Solid Excel vNext | Solid UI / Backend adapter / Demos | `solid/excel/src-vnext` 平行实现，旧 UI 不动 |
| PC-7 | 切入口与收口 | Package entry / E2E / MCP | `@einfach/solid-excel` 入口切到 vNext，legacy 冻结或删除计划 |

### 当前执行记录

2026-05-14 第一批已落地到 `vanilla/spreadsheet-ui-core`：

- PC-1：包骨架、功能文件夹、package/root config、Jest 映射和包边界测试。
- PC-2：viewport math、visible/range projection contract、backend port contract。
- PC-3：selection core、keyboard intent core。
- PC-4：editing core、formula-bar core、diagnostics core。
- PC-5：pointer、menu、toolbar、clipboard、sheet-tabs、operations intent core。
- PC-6 第一段：`solid/excel/src-vnext` 已接入 Provider、静态 backend adapter、可视窗口
  Grid、vNext demo tab 和 smoke e2e；legacy `solid/excel/src` 未被迁移或删除。
- PC-6 第二段：vNext demo 已挂上 FormulaBar 和 SheetTabs；Grid 已支持行/列头选择、
  Shift range、键盘移动、Delete 清 active cell，并订阅 projection snapshot 以响应跨组件刷新。
- PC-6 第三段：vNext demo 已挂上 Toolbar 和 ContextMenu；Grid 右键写入 core menu
  atom；keyboard core 支持 Ctrl/Cmd+Arrow、Ctrl/Cmd+Home、Ctrl/Cmd+End 的 bounds
  跳转，不扫描数据区也不触发公式求值。
- PC-6 第四段：vNext demo 已挂上 StatusBar；ContextMenu 的 `cell.clear` 已从单纯
  intent 变成 backend mutation，并刷新当前可视 projection。StatusBar 只读 core/projection
  atom，展示 active cell、selection、projection status、visible cell count、loaded value count
  和最近 toolbar/menu command。
- PC-6 第五段：vNext 新增 worker workbook backend adapter 和 `vNext Worker` demo。vNext UI
  仍只依赖 `SpreadsheetBackend` port；真实 Rust worker 通过 adapter 提供
  `readSparseRange` 可视投影和 `setCell` / `setFormulaDetailed` / `clearCell` mutation。
- PC-6 第六段：backend port 增加可选 `clearRange`，static/worker adapter 已实现；
  vNext Grid 修正 Shift-click 选区保持，右键选区内 cell 会打开 range target menu，
  ContextMenu Delete 可通过 backend range clear 清空整个选区。
- PC-6 第七段：backend port 增加可选 row/column insert/delete；static adapter 保持
  sparse shift，不创建 per-row/per-col atom；workbook worker proxy/RPC 已接 Rust
  `insert_row` / `delete_row` / `insert_col` / `delete_col`；vNext ContextMenu 的行头/列头
  Insert/Delete 已执行真实 backend mutation 并刷新当前可视 projection。
- PC-6 第八段：backend port 增加可选 `setFormatRange`，`DisplayCell` projection
  携带有界 `format` metadata；static/worker adapter 都在读取当前可视/range projection
  时才合并格式，不把整张 sheet 或大选区物化成 cell atom；vNext Toolbar 的 Bold/Italic/
  Fill/Text/Number format 已执行真实 backend range-format mutation 并刷新当前可视 projection，
  vNext Grid 按 projection format 渲染基础样式。
- PC-6 第九段：vNext ContextMenu 的 Copy/Cut/Paste 已从 intent 接到真实 executor。
  Copy/Cut 使用 bounded `readRangeProjection` 生成 TSV-with-origin 写系统剪贴板，Cut
  再走 backend `clearRange` / 单格 clear；Paste 读取系统剪贴板 TSV 后按目标左上角
  写入 `setCellInput` 并刷新当前可视 projection。无 streaming port 的大范围 clipboard
  先用 10k cell 阈值拦住，避免前端物化百万格。
- PC-6 第十段：vNext SheetTabs 的 add/rename/delete 已接入 backend workbook metadata
  mutation。`@einfach/spreadsheet-ui-core` 新增 sheet list snapshot atom 和 sheet metadata
  backend port；Solid 组件只展示当前 sheet metadata snapshot，真实列表来自 static/worker
  backend 的 `listSheets` / `addSheet` / `renameSheet` / `deleteSheet`。Sheet tab 仍只创建
  tab 级 atom 状态，不创建整张 sheet 或 cell atom。
- PC-6 第十一段：vNext Grid 已接 row/column resize 第一版。`@einfach/spreadsheet-ui-core`
  新增按 sheet 分片的稀疏 `viewportSizeOverridesAtom`，只保存用户显式调整过的可视层
  row height / column width override；Solid Grid 通过 pointer resize intent 写入该 atom，
  渲染时按当前 visible window 读取尺寸。该状态不写入 Rust cell facts，不创建全量 row/col
  atom 或数组，也不触发公式求值。
- PC-6 第十二段：vNext Grid 已接 `Alt+PageUp/PageDown` 横向翻屏。Keyboard core
  继续只保存 compact intent，不读取 backend；adapter 把当前 visible column count 作为
  `pageColDelta` 传入，core 用它移动 active cell 或扩展 selection。该行为只更新 selection
  atom，不创建 offscreen cell，不触发 projection 扩大或公式求值。
- PC-6 第十三段：vNext Grid 已接 `Ctrl/Meta+PageUp/PageDown` 切换相邻 sheet。Keyboard
  core 只发 `sheet.activate-adjacent` compact intent，不保存或读取 sheet list；Grid adapter
  用 `sheetTabsSheetsAtom` 的有界 sheet metadata 和 workspace active sheet 计算目标 sheet，
  再写 `setWorkspaceActiveSheetAtom`。该行为只切换 tab/workspace 状态，不读取整张 sheet、
  不创建 cell atom，也不触发公式求值。
- PC-6 第十四段：vNext Grid 已接 fill handle 第一版。Pointer core 只保存 source/preview
  range、focus 和 direction，并提供 preview/write-range/source-coordinate helper；backend
  port 增加可选 `fillRange` compact range command。Solid Grid 只在 active visible cell
  渲染一个 fill handle，拖拽时提交 source/target range；static backend 已实现复制，缺少
  `fillRange` 的 backend 只允许小上限可视 fallback。该链路不创建 per-cell atom，不读取整张
  sheet，也不触发公式求值。
- PC-6 第十五段：vNext Grid 已接数据感知 `Ctrl/Meta+Arrow` 第一版。Backend port
  增加可选 `resolveDataEdge`，请求只包含 active cell、方向和 sheet bounds，结果只返回
  一个目标坐标；static backend 在 sparse cell facts 上计算连续数据边界，不走
  `readRangeProjection` 或整行/整列 projection。Grid adapter 仅在 backend 支持该 port
  时拦截 Ctrl/Meta+Arrow 并更新 selection；不支持的 backend 继续走原 sheet-boundary
  fallback。该行为不创建 per-cell atom，也不读取整张 sheet。
- PC-6 第十六段：worker/Rust workbook backend adapter 已接 `resolveDataEdge`。Worker
  adapter 使用 `snapshotRangeSparse` 读取目标行或列的非空 cell facts，公式 cell 作为
  已占用事实参与边界判断，但不读取 display value、不调用 `readSparseRange`、不调用
  `snapshotFormatRange`，因此不会为了导航触发公式求值或格式投影物化。vNext Worker
  demo 已覆盖 `Ctrl+ArrowRight` 的真实 Rust worker 路径。
- PC-6 第十七段：vNext SheetTabs 已接拖拽重排第一版。`@einfach/spreadsheet-ui-core`
  增加 sheet metadata reorder helper 和可选 backend `reorderSheet` port；Solid UI
  用独立 drag handle 触发 `sheet-tab.reorder.*` intent，不占用 tab click / double-click /
  context-menu。static backend 持久化 metadata 顺序；worker/Rust adapter 在 JS adapter
  层维护 sheet id 到 Rust idx 的显示顺序映射，底层 Rust workbook 暂不执行 `move_sheet`，
  避免在 cross-sheet 依赖图按 index 存储的现状下误改内容归属。该链路只移动 sheet
  metadata，不读取或物化任何 cell。
- PC-6 第十八段：vNext Grid 已接 row/column size backend metadata 第一版。
  `@einfach/spreadsheet-ui-core` 增加 `readViewportSizeProjection`、`setRowHeight`、
  `setColumnWidth` 可选 backend port；请求按当前 visible window 返回 sparse row height /
  column width facts，resize commit 只写单行或单列 metadata。Solid Grid 仍用
  `viewportSizeOverridesAtom` 做可视渲染桥接，mount 时从 backend hydrate 当前窗口尺寸；
  static backend 按 `sheetId` 持久化 size metadata，worker adapter 在 JS adapter 层维护 size
  metadata，底层 Rust workbook 暂未持久化 row/col size。该链路不读取 cell projection、
  不创建 row/col atom，也不维护全量尺寸数组。
- PC-6 第十九段：vNext ContextMenu 已接大范围 TSV streaming clipboard export。
  `@einfach/spreadsheet-ui-core` 增加可选 backend `exportRangeTsv` port；小范围 copy/cut
  继续走 bounded `readRangeProjection`，超过 10k cell 的 range copy/cut 优先走
  backend TSV export，返回 TSV body 和 origin metadata，Solid 侧只补 clipboard marker，
  不再读取 range projection。static backend 用 sparse state 生成 TSV；worker/Rust adapter
  优先走 `exportRangeTsvChunks`，再 fallback `exportRangeTsv`，不会调用
  `readSparseRange`、`snapshotRangeSparse` 或 `snapshotFormatRange`。vNext smoke demo
  逻辑边界提高到 200x100，e2e 用 `Ctrl+Shift+End` 选 2 万格并验证仍只挂载 30 个可视
  cell。
- PC-7 准备第一段：vNext paste 公式引用偏移逻辑已从 legacy `solid/excel/src`
  下沉到 `@einfach/spreadsheet-ui-core` 的 clipboard core。`SpreadsheetContextMenu`
  不再 import legacy `formula-shift`；该纯函数仍只处理 clipboard paste 的字符串转换，
  不读取 backend、不创建 cell atom、不触发公式求值。vNext 剩余 legacy import 主要是
  worker/Rust adapter 与 worker demo 需要使用现有 WASM worker proxy/types。
- PC-7 准备第二段：`@einfach/solid-excel` legacy package entry 已显式暴露
  `vNext` namespace，消费者可以从 root entry 读取 vNext provider/grid/chrome/backend
  adapter；但 `main` 仍保持 legacy `./src/index.tsx`，不做 breaking cutover。vNext public
  surface 单独收敛到 `solid/excel/src-vnext/public.ts`，不导出 demo，避免 package entry
  import 时把 `VNextWorkerDemo` 的 worker factory / `import.meta.url` 副作用带进 Jest 或
  Node-like 消费环境。demo 入口继续由 `src-vnext/index.tsx` 内部导出给现有 App 使用。
- PC-7 准备第三段：demo App 首屏默认切到 `vNext`，让本地打开页面时直接进入新
  UI core 路径；legacy demos 仍保留在同一导航里作为对照和旧能力回归。i18n e2e
  明确点击 `Blank` 后再验证 legacy demo 文案，避免继续把首页默认 demo 和翻译测试耦合。
- PC-7 准备第四段：`@einfach/solid-excel` package exports 增加正式
  `@einfach/solid-excel/vnext` 子入口，指向 `src-vnext/public.ts`；root `.` 仍指向
  legacy `src/index.tsx`，所以这一步只增加迁移入口，不把默认 import 切到 vNext。vNext
  子入口只暴露 provider/grid/chrome/backend adapter 等库级 surface，不导出 demo。
- PC-7 准备第五段：`VNextWorkerDemo` 不再直接 import legacy
  `wasm-workbook-worker-factory` 或 `wasm-workbook-proxy` type；demo 改用 vNext adapter
  下的本地 worker factory 和 adapter option 类型推导。真实 Rust worker 文件仍暂时复用
  legacy `src/wasm-workbook-worker.ts`，因为 worker/RPC 迁移需要单独拆大任务。
- PC-7 准备第六段：worker workbook proxy/protocol 已从 legacy
  `solid/excel/src/wasm-workbook-proxy.ts` 迁到 vNext adapter 的
  `solid/excel/src-vnext/adapter/worker-protocol.ts`。legacy 文件现在只 re-export
  vNext protocol，保留旧 import 路径兼容；`worker-workbook-backend` 也不再 import
  legacy `src/types` 或 `src/wasm-workbook-proxy`。含 `import.meta.url` 的 worker factory
  暂不从 public barrel 导出，避免 Node/Jest import `@einfach/solid-excel/vnext` 时解析
  worker URL 副作用。真实 worker 实现仍在 legacy `src/wasm-workbook-worker.ts`，下一步
  可单独迁 RPC worker 文件边界。
- PC-7 准备第七段：真实 worker runtime 已迁到
  `solid/excel/src-vnext/adapter/worker-runtime.ts`，vNext worker factory 改为指向
  `./worker-runtime.ts`；legacy `solid/excel/src/wasm-workbook-worker.ts` 只做兼容 shim，
  显式调用 `installWorkerRuntime()`，避免 build 时被 tree-shake 成空 worker chunk。
  `range-tsv` helper 同步迁到 vNext adapter，legacy `src/range-tsv.ts` 保留 re-export。
  `@einfach/solid-excel/vnext` 仍不导出 worker factory，package import 不会触发
  `import.meta.url` 副作用。顺手修复 worker workbook adapter 忽略
  `setFormulaDetailed` 的 `{ ok:false }` 的问题：失败公式现在会抛出带 `code/message`
  的 backend error，而不是返回成功 mutation。
- PC-7 准备第八段：W2 lazy formula 回归门禁已收口。单 sheet WasmSheet
  transitive chain 增加 Rust wasm unit，`formulas-wasm.spec.ts` 保持 active 覆盖
  `F8 -> G8 -> H8 -> I8` 传播；dirty notify 精确契约已有
  `formula_subscriber_dirty_notified_for_same_source_value_writes` 和
  `dirty_notify_no_eager_compute`。legacy TLS resolver 关键符号在 `excel-core` /
  `wasm` 生产与测试路径 grep 为 0。vNext Worker demo 新增 `Sheet2!C5` 独立
  lazy probe：打开 Sheet1 时 `Sheet2!C5` 仍为 dirty，切到 Sheet2 后可视读取计算为
  `105` 并输出 `[vnext-worker-lazy-demo] computed Sheet2!C5 before=dirty after=clean ...`。

PC-6 第一段验收记录：

- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest solid/excel/test/vnext-adapter.test.ts solid/excel/test/vnext-provider.test.tsx solid/excel/test/vnext-grid.test.tsx --runInBand`
- `npx jest vanilla/spreadsheet-ui-core/test --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts`
- MCP Playwright：打开 `http://localhost:5174/`，验证 vNext grid 只渲染 30 个可视
  cell、`J20` offscreen 未挂载、`B1` click active、`A1` 双击编辑提交、console error 为 0。

PC-6 第二段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest solid/excel/test/vnext-adapter.test.ts solid/excel/test/vnext-provider.test.tsx solid/excel/test/vnext-grid.test.tsx solid/excel/test/vnext-formula-bar.test.tsx solid/excel/test/vnext-sheet-tabs.test.tsx --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts`
- MCP Playwright：验证 30 个可视 cell、`J20` offscreen 未挂载、FormulaBar 从 `Alpha`
  提交到 `A1`、`Shift+ArrowDown` 扩展到 `B2`、行头选择、`Sheet2` tab active、
  console error 为 0。

PC-6 第三段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest vanilla/spreadsheet-ui-core/test --runInBand`
- `npx jest solid/excel/test/vnext-adapter.test.ts solid/excel/test/vnext-provider.test.tsx solid/excel/test/vnext-grid.test.tsx solid/excel/test/vnext-formula-bar.test.tsx solid/excel/test/vnext-sheet-tabs.test.tsx solid/excel/test/vnext-toolbar.test.tsx solid/excel/test/vnext-context-menu.test.tsx --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts`
- MCP Playwright：验证 30 个可视 cell、`J20` offscreen 未挂载、`Ctrl+ArrowRight`
  让 active address 到 `J2` 但 `J2` 不挂载、Toolbar Bold enabled、右键 `A1`
  打开 cell context menu、Delete 后 menu 隐藏、console error 为 0。

PC-6 第四段验收记录：

- `npx jest solid/excel/test/vnext-status-bar.test.tsx solid/excel/test/vnext-context-menu.test.tsx --runInBand`
- `npx jest solid/excel/test/vnext-*.test* --runInBand`
- `npx jest vanilla/spreadsheet-ui-core/test --runInBand`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npm run build -w @einfach/spreadsheet-ui-core`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts`
- MCP Playwright：打开 `http://127.0.0.1:5173/`，验证 30 个可视 cell、`J20`
  offscreen 未挂载、状态栏显示 `A1` / `Ready` / `30 cells` / `30 loaded`；
  点击 `B2` 后 `Ctrl+ArrowRight` 让公式栏和状态栏都到 `J2` 且 `J2` 未挂载；
  右键 `A1` 执行 Delete 后 menu 隐藏、`A1` 为空、loaded count 变为 `29 loaded`、
  console error 为 0。

PC-6 第五段验收记录：

- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest solid/excel/test/vnext-adapter.test.ts solid/excel/test/i18n.test.ts --runInBand`
- `npx jest solid/excel/test/vnext-*.test* --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- MCP Playwright：打开 `http://127.0.0.1:5173/` 的 `vNext Worker` demo，验证
  `Sheet1!C2=13`、`Sheet1!B4=10`、30 个可视 cell、`J20` offscreen 未挂载；
  将 `Sheet1!B4` 改成 `20` 后，`Sheet1!C2=23`、切到 `Sheet2` 后 `C2=22`、
  切到 `Sheet3` 后 `C2=21`，console error 为 0。

PC-6 第六段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest solid/excel/test/vnext-adapter.test.ts solid/excel/test/vnext-context-menu.test.tsx solid/excel/test/vnext-grid.test.tsx --runInBand`
- `npx jest vanilla/spreadsheet-ui-core/test --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- MCP Playwright：打开 `http://127.0.0.1:5173/` 的 `vNext` demo，验证
  Shift-click 选中 `A1:C2` 后状态栏显示 `A1:C2`，右键 `B2` 打开 `range`
  target menu；执行 Delete 后 `A1/B1/C1/A2/B2/C2` 清空，`D1` 保持 `Delta`，
  loaded count 变为 `24 loaded`，console error 为 0。

PC-6 第七段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest solid/excel/test/vnext-adapter.test.ts solid/excel/test/vnext-context-menu.test.tsx solid/excel/test/wasm-workbook-proxy.test.ts solid/excel/test/wasm-workbook-worker.test.ts solid/excel/test/worker-workbook-store.test.ts --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- MCP Playwright：打开 `http://127.0.0.1:5173/` 的 `vNext` demo，验证右键第 2
  行执行 Insert row 后第 2 行为空、第 3 行变为 `North`；右键 B 列执行 Delete column
  后 `B1` 从 `Beta` 变为 `Gamma`；console error 为 0。

PC-6 第八段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest solid/excel/test/vnext-adapter.test.ts solid/excel/test/vnext-grid.test.tsx solid/excel/test/vnext-toolbar.test.tsx --runInBand`
- `npx jest solid/excel/test/vnext-*.test* --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- `npm run build`
- `npm test`
- MCP Playwright：打开 `http://127.0.0.1:5173/` 的 `vNext` demo，点击 Toolbar
  Bold 后验证 `A1` computed `fontWeight=700`、当前仍只渲染 30 个可视 cell、`J20`
  offscreen 未挂载、projection 状态为 `Ready`、console error 为 0。

PC-6 第九段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest vanilla/spreadsheet-ui-core/test/clipboard.test.ts solid/excel/test/vnext-context-menu.test.tsx --runInBand`
- `npx jest solid/excel/test/vnext-context-menu.test.tsx solid/excel/test/vnext-grid.test.tsx vanilla/spreadsheet-ui-core/test/clipboard.test.ts --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- MCP Playwright：打开 `http://127.0.0.1:5173/` 的 `vNext` demo，授予
  clipboard read/write 权限；右键 `A1` Copy，再右键 `B3` Paste，验证 `B3=Alpha`、
  当前仍只渲染 30 个可视 cell、`J20` offscreen 未挂载、projection 状态为 `Ready`、
  console error 为 0。

PC-6 第十段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest vanilla/spreadsheet-ui-core/test/sheet-tabs.test.ts solid/excel/test/vnext-adapter.test.ts solid/excel/test/vnext-sheet-tabs.test.tsx --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- `npm run build`
- `npm test`
- MCP Playwright：打开 `http://localhost:5174/` 的 `vNext` demo，点击 `+` 新增
  `Sheet4`，双击改名为 `Report`，右键 `Report` 执行 Delete 并确认；验证
  `Report` 消失、active tab 回到 `Sheet3`、当前仍只渲染 30 个可视 cell、`J20`
  offscreen 未挂载、状态栏显示 `30 cells`、console error 为 0。

PC-6 第十一段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest vanilla/spreadsheet-ui-core/test/viewport.test.ts solid/excel/test/vnext-grid.test.tsx --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- MCP Playwright：打开 `http://localhost:5174/` 的 `vNext` demo，验证 B 列从
  `96px` resize 到 `128px`、第 2 行 resize 到 `36px`、`B2` cell 同步为
  `128x36`，当前仍只渲染 30 个可视 cell、`J20` offscreen 未挂载、console error 为 0。

PC-6 第十二段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest vanilla/spreadsheet-ui-core/test/keyboard.test.ts solid/excel/test/vnext-grid.test.tsx --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- MCP Playwright：打开 `http://localhost:5174/` 的 `vNext` demo，验证 `B2`
  按 `Alt+PageDown` 后 active/formula address 到 `G2`，`Alt+PageUp` 回到 `B2`；
  `G2` 和 `J20` 均 offscreen 未挂载，当前仍只渲染 30 个可视 cell、console error 为 0。

PC-6 第十三段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest vanilla/spreadsheet-ui-core/test/keyboard.test.ts vanilla/spreadsheet-ui-core/test/sheet-tabs.test.ts solid/excel/test/vnext-grid.test.tsx --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- MCP Playwright：打开 `http://localhost:5174/` 的 `vNext` demo，验证 grid
  中按 `Ctrl+PageDown` 从 `Sheet1` 切到 `Sheet2` 再切到 `Sheet3`，按
  `Ctrl+PageUp` 回到 `Sheet2`；当前仍只渲染 30 个可视 cell、`J20` offscreen
  未挂载、console error 为 0。

PC-6 第十四段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest vanilla/spreadsheet-ui-core/test/pointer.test.ts solid/excel/test/vnext-adapter.test.ts solid/excel/test/vnext-grid.test.tsx --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- `git diff --check`
- `npm run build`
- `npm test`
- MCP Playwright：打开 `http://localhost:5174/` 的 `vNext` demo，点击 `A1`
  后拖拽 `fill-handle-A1` 到 `A3`；验证 `A2/A3=Alpha`、当前仍只渲染 30
  个可视 cell、`J20` offscreen 未挂载、projection 为 `Ready`、console error 为 0。

PC-6 第十五段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest solid/excel/test/vnext-adapter.test.ts solid/excel/test/vnext-grid.test.tsx --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- `git diff --check`
- `npm run build`
- `npm test`
- MCP Playwright：打开 `http://localhost:5174/` 的 `vNext` demo，点击 `B2`
  后按 `Ctrl+ArrowRight`；验证 active/formula address 到 `E2`、`E2` active、
  当前仍只渲染 30 个可视 cell、`J20` offscreen 未挂载、projection 为 `Ready`、
  console error 为 0。

PC-6 第十六段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest solid/excel/test/vnext-adapter.test.ts --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- `git diff --check`
- `npm run build`
- `npm test`
- MCP Playwright：打开 `http://localhost:5174/` 的 `vNext Worker` demo，点击
  `A4` 后按 `Ctrl+ArrowRight`；验证 active/formula address 到 `C4`、`C4=source`
  且 active、当前仍只渲染 30 个可视 cell、`J20` offscreen 未挂载、projection 为
  `Ready`、console error 为 0。

PC-6 第十七段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest vanilla/spreadsheet-ui-core/test/sheet-tabs.test.ts solid/excel/test/vnext-sheet-tabs.test.tsx solid/excel/test/vnext-adapter.test.ts --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- `git diff --check`
- `npm run build`
- `npm test`
- MCP Playwright：打开 `http://localhost:5174/`，分别验证 `vNext` 和 `vNext Worker`
  demo 中拖拽 `Sheet3` 到 `Sheet1` 前；两条路径 tab 顺序均为
  `Sheet3 / Sheet1 / Sheet2`，active 仍为 `Sheet1`，当前仍只渲染 30 个可视 cell、
  `J20` offscreen 未挂载、projection 为 `Ready`、console error 为 0。

PC-6 第十八段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest vanilla/spreadsheet-ui-core/test/backend-contract.test.ts solid/excel/test/vnext-adapter.test.ts solid/excel/test/vnext-grid.test.tsx --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- `git diff --check`
- `npm run build`
- `npm test`
- MCP Playwright：打开 `http://localhost:5174/`，分别验证 `vNext` 和 `vNext Worker`
  demo 中拖拽 B 列和第 2 行；两条路径 B 列 / `B2` 宽度均为 `128px`、第 2 行 /
  `B2` 高度均为 `36px`，当前仍只渲染 30 个可视 cell、`J20` offscreen 未挂载、
  projection 为 `Ready`、console error 为 0。

PC-6 第十九段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest vanilla/spreadsheet-ui-core/test/backend-contract.test.ts solid/excel/test/vnext-adapter.test.ts solid/excel/test/vnext-context-menu.test.tsx --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/vnext-worker-backend.spec.ts`
- `git diff --check`
- `npm run build`
- `npm test`
- MCP Playwright：打开 `http://localhost:5174/` 的 `vNext` demo，mock clipboard
  后点击 `A1` 并派发 `Ctrl+Shift+End`，验证 selection 为 `A1:CV200`；右键
  `A1` 执行 Copy 后，clipboard 以 `# einfach-clipboard-origin: A1` 开头、
  共 201 行，当前仍只渲染 30 个可视 cell、`J20` offscreen 未挂载、projection 为
  `Ready`、console error 为 0。

PC-7 准备第一段验收记录：

- `npm run build -w @einfach/spreadsheet-ui-core`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npx jest vanilla/spreadsheet-ui-core/test/clipboard.test.ts solid/excel/test/vnext-context-menu.test.tsx --runInBand`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts`
- `git diff --check`
- `npm run build`
- `npm test`
- MCP Playwright：打开 `http://localhost:5174/` 的 `vNext` demo，mock clipboard
  后重复 `A1` 到 `A1:CV200` 的大范围 Copy；验证 clipboard marker 存在、共 201 行、
  当前仍只渲染 30 个可视 cell、`J20` offscreen 未挂载、projection 为 `Ready`、
  console error 为 0。

PC-7 准备第二段验收记录：

- `npx jest solid/excel/test/package-entry.test.ts solid/excel/test/vnext-provider.test.tsx --runInBand`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts`
- `git diff --check`
- MCP Playwright：打开 `http://127.0.0.1:5174/`，点击 `vNext` demo；验证
  table body 仍只挂载 30 个可视 cell、页面没有 `J20`、状态栏显示 `Ready` /
  `30 cells` / `30 loaded`、console error 为 0。

PC-7 准备第三段验收记录：

- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts e2e/i18n.spec.ts`
- `git diff --check`
- MCP Playwright：打开 `http://127.0.0.1:5174/` 首页，不点击 demo tab；验证 active tab
  为 `vNext`、`vnext-grid` 已挂载、table body 仍只有 30 个可视 cell、`J20` 未挂载、
  状态栏包含 `Ready` / `30 cells` / `30 loaded`、console error 为 0。

PC-7 准备第四段验收记录：

- `npx jest solid/excel/test/package-vnext-subpath.test.ts solid/excel/test/package-entry.test.ts --runInBand`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-smoke.spec.ts`
- `git diff --check`
- MCP Playwright：打开 `http://127.0.0.1:5174/` 首页；验证 active tab 为
  `vNext`、`vnext-grid` 已挂载、table body 仍只有 30 个可视 cell、`J20` 未挂载、
  状态栏包含 `Ready` / `30 cells` / `30 loaded`、console error 为 0。

PC-7 准备第五段验收记录：

- `rg -n "\\.\\./\\.\\./src|\\.\\./src|from '../../src|from '../src" solid/excel/src-vnext -g '*.ts' -g '*.tsx'`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-worker-backend.spec.ts`
- `git diff --check`
- MCP Playwright：打开 `http://127.0.0.1:5174/`，切到 `vNext Worker`；验证
  worker grid 已挂载、table body 仍只有 30 个可视 cell、`Sheet1!C2=13`、
  `Sheet1!B4=10`、`J20` 未挂载、状态为 `Ready` / `30 cells`、console error 为 0。

PC-7 准备第六段验收记录：

- `rg -n "\\.\\./\\.\\./src|\\.\\./src|from '../../src|from '../src" solid/excel/src-vnext -g '*.ts' -g '*.tsx'`
- `npx jest solid/excel/test/package-vnext-subpath.test.ts solid/excel/test/vnext-adapter.test.ts solid/excel/test/wasm-workbook-proxy.test.ts --runInBand`
- `npx jest solid/excel/test/wasm-workbook-worker.test.ts solid/excel/test/worker-workbook-store.test.ts --runInBand`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-worker-backend.spec.ts`
- `git diff --check`
- MCP Playwright：打开 `http://127.0.0.1:5174/`，切到 `vNext Worker`；验证
  worker grid 已挂载、table body 仍只有 30 个可视 cell、`Sheet1!C2=13`、
  `Sheet1!B4=10`、`J20` 未挂载、状态为 `Ready` / `30 cells`、console error 为 0。

PC-7 准备第七段验收记录：

- `rg -n "\\.\\./\\.\\./src|\\.\\./src|from '../../src|from '../src" solid/excel/src-vnext -g '*.ts' -g '*.tsx'`
- `npx jest solid/excel/test/package-vnext-subpath.test.ts solid/excel/test/vnext-adapter.test.ts solid/excel/test/wasm-workbook-proxy.test.ts solid/excel/test/wasm-workbook-worker.test.ts solid/excel/test/worker-workbook-store.test.ts --runInBand`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-worker-backend.spec.ts`
- `git diff --check`
- MCP Playwright：打开 `http://127.0.0.1:5174/`，切到 `vNext Worker`；验证
  worker grid 已挂载、可视 cell 数为 30、`Sheet1!C2=13`、`Sheet1!B4=10`、
  `J20` 未挂载、状态为 `Ready` / `30 cells` / `7 loaded`、console error/warning 为 0。

PC-7 准备第八段验收记录：

- `cargo test --manifest-path rust/excel-core/Cargo.toml`
- `cargo test --manifest-path rust/wasm/Cargo.toml`
- `wasm-pack test --headless --chrome rust/wasm`
- `npx tsc -p solid/excel/tsconfig.json --noEmit --pretty false`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/formulas-wasm.spec.ts`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-worker-backend.spec.ts`
- `rg -n "with_cross_resolver|CrossSheetResolver|mem::transmute|CROSS_RESOLVER|CURRENT_SHEET|CROSS_SHEET_VISITED" rust/excel-core/src rust/wasm/src rust/excel-core/tests rust/wasm/tests`
- `rg -n "test\\.skip|describe\\.skip|it\\.skip|test\\.only|describe\\.only|it\\.only" solid/excel/e2e solid/excel/test`
- `git diff --check`
- MCP Playwright：打开 `http://127.0.0.1:5174/?debug=1`，切到 `vNext Worker`；
  验证 Sheet1 首屏 30 个可视 cell、`Sheet2!C5` debug cache state 为 `dirty`、
  切到 Sheet2 后 `C5=105` 且 cache state 为 `clean`，console 输出
  `[vnext-worker-lazy-demo] computed Sheet2!C5 before=dirty after=clean ...`，
  console error/warning 为 0。

仍未完成：

- vNext 已有 static backend 和真实 worker/Rust workbook backend adapter；但 default
  public entry 还未切到 vNext。当前 root entry 只新增 `vNext` namespace 作为兼容迁移入口；
  `package.json` 已增加 `./vnext` 子入口，但 root `main` / export `.` 仍保持 legacy，
  避免断掉 legacy `Table` / `createSheetStore` / worker store 等现有导出。sheet
  add/rename/delete 已接入 vNext backend port；
  sheet reorder 已接 vNext metadata backend port 和 worker adapter 显示顺序映射；
  Rust core/wasm 仍未实现真正的 `move_sheet`。
- vNext chrome UI 已有 status bar；ContextMenu 的 `cell.clear` 已接单 cell 和 range
  mutation，row/column insert/delete 已接真实 backend mutation；Toolbar 已接真实
  range format mutation；ContextMenu Copy/Cut/Paste 已接真实 clipboard executor，
  大范围 copy/cut 已接 backend TSV streaming export。
- FormulaBar 已接可视 cell mutation；SheetTabs 已接真实 workbook sheet add/rename/delete
  和 metadata reorder mutation；Rust-level sheet order mutation 仍待单独设计。
- 数据区域感知的 Ctrl+Arrow 已有 optional backend port，static backend 和 worker/Rust
  backend adapter 均已接入；后续可继续补更完整的 Excel 空白/非空边界细节测试。
- Excel 级交互仍缺：row/col resize 已接 vNext backend metadata port，但 Rust
  persistence / reload 后保留 / auto-fit 等完整 Excel 行为仍未实现。
- PC-7 已进入 package surface 准备；`@einfach/solid-excel` default public entry 还没有切到
  vNext。
- PC-7 后续多批次 agent 执行计划已单独落到
  `solid/excel/docs/PC7_AGENT_PIPELINE.md`。W1-W2 已完成；接下来按该文档的 W3-W7 波次推进，
  每波由总架构师收口并要求测试 + MCP Playwright 验证。

## 并行 Agent 计划

总架构师负责接口冻结、集成和最终验收。子 agent 只能提交候选补丁。
PC-7 后续执行以 `solid/excel/docs/PC7_AGENT_PIPELINE.md` 为准；本节保留为
`spreadsheet-ui-core` 和 vNext 初始拆包阶段的历史分工记录。

### PC-1 新包骨架

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| A1 Package Skeleton | Codex Spark | `vanilla/spreadsheet-ui-core/package.json`, `tsconfig.json`, `src/index.ts` | 新建 workspace package，只依赖 `@einfach/core` |
| A2 Feature Folders | Codex Spark | `vanilla/spreadsheet-ui-core/src/*/README.md`, `shared/*` | 建功能文件夹、公共类型边界、atom 决策模板 |
| A3 Backend Port | Claude Sonnet | `vanilla/spreadsheet-ui-core/src/backend/*` | 定义 visible read、mutation、range command 的端口类型 |
| A4 Tests | Codex Mini | `vanilla/spreadsheet-ui-core/test/*` | 新包测试 harness、folder contract、visible window 单测 |

验收：

```sh
npx tsc -p vanilla/spreadsheet-ui-core/tsconfig.json --noEmit
npx jest vanilla/spreadsheet-ui-core/test
npm run build -w @einfach/spreadsheet-ui-core
```

### PC-2 Viewport + Projection

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| B1 Viewport Math | Codex Spark | `viewport/*` | 固定 row/col size、overscan、scroll -> visible window |
| B2 Projection Contract | Claude Sonnet | `projection/*`, `backend/*` | 定义 display projection request/response、version、cancellation |
| B3 Tests | Codex Spark | `test/viewport*.test.ts`, `test/projection*.test.ts` | O(1) visible window、bounded projection request 单测 |

验收：

```sh
npx tsc -p vanilla/spreadsheet-ui-core/tsconfig.json --noEmit
npx jest vanilla/spreadsheet-ui-core/test/viewport*.test.ts vanilla/spreadsheet-ui-core/test/projection*.test.ts
```

### PC-3 Selection + Keyboard

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| C1 Selection Core | Claude Sonnet | `selection/*` | active cell、range、row/col/all selection、normalized range |
| C2 Keyboard Core | Codex Spark | `keyboard/*` | Arrow/Shift/Ctrl/Home/End/Page command，不依赖 DOM |
| C3 Tests | Codex Spark | `test/selection*.test.ts`, `test/keyboard*.test.ts` | selection 不展开大 range、keyboard command 合同 |

特别约束：

- selection 只能保存边界和模式，不能生成 range 内地址列表。
- keyboard command 可以请求 scrollToCell，但不能直接访问 DOM。

### PC-4 Editing + FormulaBar

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| D1 Editing Core | Claude Sonnet | `editing/*` | typing/F2/double click/commit/cancel 状态归一 |
| D2 FormulaBar Core | Codex Spark | `formula-bar/*` | draft/focus/diagnostic/reference-picking 合同 |
| D3 Tests | Codex Spark | `test/editing*.test.ts`, `test/formula-bar*.test.ts` | Enter/Tab/Esc/F2、非法公式、cycle diagnostic contract |

特别约束：

- FormulaBar draft 同步不能因为 selection 改变而读取公式结果。
- commit 只能通过 backend port 的 async formula/value command 表达。

### PC-5 Menu / Toolbar / Clipboard / Tabs

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| E1 Menu Core | Codex Spark | `menu/*` | menu target、highlight、range-preserving context command |
| E2 Toolbar Core | Claude Sonnet | `toolbar/*` | command availability、format command，不复制格式 facts |
| E3 Clipboard Core | Codex Spark | `clipboard/*` | copy/cut/paste UI 状态、chunked backend contract |
| E4 Sheet Tabs Core | Codex Spark | `sheet-tabs/*` | tab menu、rename/delete flow，不保存 sheet facts |

### PC-6 Solid Excel vNext 重做

这一波才开始动 `@einfach/solid-excel` UI。目标不是在旧 `Table.tsx` / `sheet-store.ts`
上继续修补，而是在 `solid/excel/src-vnext/` 平行实现新的 Solid UI。它面向用户感知，必须用
MCP 验证。

文件所有权：

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| F1 Solid Provider | Codex Spark | `solid/excel/src-vnext/provider/*` | 连接 `@einfach/spreadsheet-ui-core` store 和 `@einfach/solid` |
| F2 Backend Adapter | Claude Sonnet | `solid/excel/src-vnext/adapter/*` | 把现有 worker/Rust store 适配到 core backend port |
| F3 Grid UI | Codex Spark | `solid/excel/src-vnext/grid/*` | 可视窗口 grid、headers、cells、overlay，不保存 workbook facts |
| F4 Chrome UI | Codex Spark | `src-vnext/formula-bar/*`, `toolbar/*`, `sheet-tabs/*`, `context-menu/*` | FormulaBar、toolbar、tabs、context menu 的新 UI |
| F5 Demo/E2E | Codex Spark | `solid/excel/src-vnext/demos/*`, `solid/excel/e2e/*` | vNext demo flag、Playwright 和 MCP 验证 |

目标：

- 保留 `@einfach/solid-excel` 包名。
- 旧 `solid/excel/src` 先不删，作为 legacy/reference。
- 新实现放在 `solid/excel/src-vnext`，通过 demo flag 或独立 route 验证。
- vNext 组件只做 Solid binding 和展示，不重新发明核心状态。
- row header / col header 点击选择整行整列。
- Shift + 点击扩展 range。
- Ctrl + Arrow 跳转到区域边界。
- Home / End / PageUp / PageDown 行为对齐表格常识。
- fill handle 第一版：小范围拖拽复制或序列填充，大范围必须走 range command。
- row/col resize 第一版：只保存 UI 交互尺寸，不写入 cell facts。

验收：

```sh
npx tsc -p vanilla/spreadsheet-ui-core/tsconfig.json --noEmit
npm run build -w @einfach/spreadsheet-ui-core
npx tsc -p solid/excel/tsconfig.json --noEmit
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel
```

MCP：

- 1M demo：键盘、range extend、row/col header、fill handle。
- MultiSheet demo：跨 sheet 后 selection/edit/menu 状态不串。
- FormulaBar：非法公式和 cycle 显示诊断后可恢复。
- console 无 warning/error。

### PC-7 切入口与收口

当 vNext 达到 legacy 关键功能 parity 后，才切 `@einfach/solid-excel` 的 public entry。

切换规则：

- `package.json` 的入口仍是 `@einfach/solid-excel`。
- 默认 demo / export 指向 vNext。
- legacy 保留在内部路径或独立 demo route，直到一轮全量回归后删除。
- 不允许在入口切换时重写 Rust/WASM/worker 核心。

### 最终收口 Gate

收口 gate：

```sh
npx tsc -p vanilla/spreadsheet-ui-core/tsconfig.json --noEmit
npm run build -w @einfach/spreadsheet-ui-core
npx jest vanilla/spreadsheet-ui-core/test
npx tsc -p solid/excel/tsconfig.json --noEmit
npm run build -w @einfach/solid-excel
NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel
npm test
```

`@einfach/solid-excel` 的 `createSignal` grep 不要求绝对为 0，但必须有白名单：

- DOM ref / measurement / animation frame。
- i18n locale 这类独立基础设施如果暂不迁移，要单独记录。
- demo-only import progress 如果影响产品导入流程，后续也应迁 atom。

## 停止条件

遇到以下情况必须暂停并重规划：

- 任何实现试图为百万 cell 创建 per-cell atom。
- 子 agent 新增 atom 却没有在对应功能 `README.md` 记录 source/derived/command 决策。
- `@einfach/spreadsheet-ui-core` 直接依赖 Solid、React、DOM、worker、WASM glue 或 Playwright。
- 新的核心交互逻辑继续堆进 `@einfach/solid-excel` legacy 目录，而不是进入新 core 或 vNext adapter。
- vNext 组件绕过 `@einfach/spreadsheet-ui-core`，直接用 Solid signal 承载产品交互状态。
- selection 或 toolbar 派生需要展开大 range 地址列表。
- viewport/projection 实现会累积 offscreen window 数据，或保留完整 sheet snapshot。
- 行高/列宽实现需要创建全量 row/col atom 或全量尺寸数组。
- UI 状态迁移导致公式在 selection 移动时被 eager eval。
- UI store 保存了 worker snapshot、formula cache 或 dependency graph。
- vNext adapter 为了方便绕开 `@einfach/core`，重新引入框架本地产品状态。
- MCP 无法验证交互变更，但代码已经改了浏览器行为。

## 完成定义

整体完成时，需要同时满足：

- 产品交互状态只由 JS atom/store 承载。
- UI core 只关心 visible window、bounded visible projection 和 interaction overlay。
- 每个功能文件夹都有状态决策记录，atom 由子 agent 在功能边界内设计并接受总架构师验收。
- Rust/WASM/worker 继续是 workbook facts 的唯一事实源。
- `@einfach/spreadsheet-ui-core` 不依赖 Solid、React、DOM、worker、WASM glue、CSS、Playwright。
- `@einfach/solid-excel` 保留包名，public entry 切到基于新 core 的 vNext 实现。
- legacy `solid-excel` 只作为参考/回归对照，不再承载核心架构。
- selection/edit/menu/formula bar/toolbar/sheet tabs 有可独立运行的 atom 单测。
- viewport window 有独立单测，证明可见行列范围由 scroll/size 推导，不创建 per-cell 状态。
- 1M demo 中 selection、keyboard、右键、大 range toolbar 操作不物化百万地址。
- 公式 lazy 约束不回退：导入、设置公式、selection 移动不触发 eager compute。
- Playwright 全量通过，MCP 记录关键交互和 console 结果。
