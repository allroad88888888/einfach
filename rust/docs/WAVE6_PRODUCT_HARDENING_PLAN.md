# Wave 6 产品硬化执行计划

> 日期：2026-05-14
>
> 角色：总架构师负责集成与验收；子 agent 只产出候选补丁或审查意见。
>
> 产品目标：在线电子表格；不做多人协同；支持百万级 cell；未被视口、显式读取、
> 导出或订阅命中的公式保持 lazy，不在导入或写入时计算。

## 当前真实状态

Wave 6 + Wave 6.5 已提交到
`0cf1ef3 feat(solid-excel): harden virtualized UX gates`。本文件现在作为执行记录和
发布门禁输入，不再是待执行计划。

已落地：

- `MultiSheet` 已切到 worker-backed workbook；`SheetTabs` 支持 sync/async workbook
  结构操作。
- worker-backed store 已暴露并测试 `addSheet` / `renameSheet` / `removeSheet` /
  `indexOf`。
- FormulaBar 已产品化展示 worker/Rust 返回的 `INVALID_FORMULA` / `FORMULA_CYCLE`
  简洁诊断，并在成功提交或切换 selection 后清理。
- `TEXT()` / `TODAY()` / `NOW()` 已有真实 WASM browser gate。
- `DemoMillion` 已是 worker-backed workbook + 2D virtualized table，并接入
  `FormatToolbar`。
- 虚拟化 UX 门禁已覆盖：1M 大选区真实 Bold 走 range-native `set_format_range`、键盘跨
  视口 selection 不丢、右键命中当前 range 时 Clear 不折叠选区。
- 本波每个 UI 行为变更都有 Playwright CLI + MCP Playwright 验收记录。

## Wave 6 目标（已完成）

1. 把 `MultiSheet` demo 切到 worker-backed workbook，跨 sheet formula 在产品 UI 路径可用。
2. 让 `SheetTabs` 支持 async workbook 结构操作，同时保持 JS mock 兼容。
3. 给 worker-backed 多 sheet UI 加 e2e：tab 切换、add/rename/delete、跨 sheet 公式读取前
   不 eager、读取后正确显示。
4. 给公式诊断、日期/文本函数、虚拟列交互补发布级测试计划；能在本波低风险落地的先落地。
5. 每次 UI 行为变更都必须有 Playwright CLI + MCP Playwright/Chrome 验证记录。

## 非目标

- 不改 `.github/workflows/*`。
- 不做多人协同。
- 不把 Solid 变成 workbook 数据事实源。
- 不做 dense grid、全量 cell atom 或前端公式 cache 副本。
- 不在 Wave 6 强行做完整 Excel 兼容矩阵，只补当前已有函数和产品入口的可靠性门禁。

## 并行轨道

| 轨道 | 推荐执行者 | 文件所有权 | 目标 |
|---|---|---|---|
| W6-A Worker 多 sheet store | Codex Spark / worker 子 agent | `solid/excel/src/wasm-workbook-store.ts`, `solid/excel/test/worker-workbook-store.test.ts` | 暴露 async `addSheet` / `renameSheet` / `removeSheet` / `indexOf`；结构变更后重建 sheet adapter/store，避免删除 sheet 后索引漂移 |
| W6-B SheetTabs + MultiSheet 产品路径 | Codex Spark / worker 子 agent | `solid/excel/src/SheetTabs.tsx`, `solid/excel/src/demos/MultiSheet.tsx`, i18n 必要文案 | `SheetTabs` 支持 sync/async workbook；`MultiSheet` 改为 worker-backed seed，移除“cross-sheet unsupported”旧文案 |
| W6-C E2E + MCP 用例 | Codex Spark / worker 子 agent | `solid/excel/e2e/multisheet-ui.spec.ts` 或新增 worker spec, `solid/excel/e2e/helpers.ts` 必要小改 | 钉 worker-backed multi-sheet：seed、tab、add/rename/delete、cross-sheet formula 和 lazy cache probe |
| W6-D 公式诊断与函数门禁规划 | Claude Sonnet / 只读审查优先 | `rust/docs/*`, `solid/excel/docs/E2E_TEST_PLAN.md` | 列出公式错误 UI、`TEXT/TODAY/NOW` 浏览器测试、虚拟列交互测试的下一批落点 |

## 文件冲突矩阵

| 文件 | W6-A | W6-B | W6-C | W6-D |
|---|---|---|---|---|
| `wasm-workbook-store.ts` | 主写 | 不碰 | 不碰 | 只读 |
| `worker-workbook-store.test.ts` | 主写 | 不碰 | 可只读 | 只读 |
| `SheetTabs.tsx` | 不碰 | 主写 | 只读 | 只读 |
| `MultiSheet.tsx` | 不碰 | 主写 | 只读 | 只读 |
| e2e spec | 不碰 | 不碰 | 主写 | 只读 |
| docs | 不碰 | 不碰 | 记录结果 | 主写/总架构师集成 |

如果 W6-B 需要 `wasm-workbook-store.ts` 类型变更，必须先等 W6-A 合入或改为只读建议。

## 设计约束

### Worker store 结构操作

- `addSheet` / `renameSheet` / `removeSheet` 以 worker RPC 为权威。
- `removeSheet` 后 sheet idx 会移动；主线程 store/adapters 必须根据 `sheetList()` 重建，不能
  继续复用旧 idx 对应的 adapter。
- 重建时必须 dispose 旧 `SheetStore`，释放 worker subscriptions，不能留下历史 tab 的
  live subscriptions。
- 结构操作只影响 sheet metadata 和可见投影，不复制 workbook 数据。
- 默认 sheet name 仍遵循 `Sheet{N}` 且避免重名。

### SheetTabs 合同

- 支持同步 JS workbook 和异步 worker workbook 两种返回：
  `number | Promise<number>`、`boolean | Promise<boolean>`。
- 失败时仍用当前 prompt/confirm/alert 语义，不引入复杂弹窗。
- 点击 `+` 后必须等 async add 结果，再切 active sheet。
- rename/delete 后 tab list 来源仍是 workbook metadata，不在组件内维护副本。

### MultiSheet seed

- 使用 `createWorkerWorkbookStore({ workerFactory, sheets, afterInit })`。
- seed 通过 worker import session 写入，不在 UI 初始化后逐 cell 同步写。
- seed 公式不应在导入时计算；只有可见 cell hydration 或显式读取时计算。
- Sheet1 必须展示一个跨 sheet 公式结果，例如 `=Expenses!B5`。
- 至少保留三个 sheet：`Sheet1`、`Expenses`、`Notes`。

## 验收门禁

本波代码合入前至少运行：

```sh
cd /Volumes/work/self/einfach && npx tsc -p solid/excel/tsconfig.json --noEmit
cd /Volumes/work/self/einfach && npx jest solid/excel/test/worker-workbook-store.test.ts solid/excel/test/wasm-workbook-proxy.test.ts solid/excel/test/wasm-workbook-worker.test.ts --runInBand
cd /Volumes/work/self/einfach && npm run build -w @einfach/solid-excel
cd /Volumes/work/self/einfach/solid/excel && npm run e2e -- e2e/multisheet-ui.spec.ts e2e/workbook-chain.spec.ts
```

MCP 验收必须记录：

- 打开 `http://localhost:<port>/?debug=1`。
- 进入 `Multi-Sheet`。
- 验证三张 seed sheet 可见。
- 验证 Sheet1 上跨 sheet formula 显示最终结果。
- 新增、重命名、删除 sheet 后，tab UI 和 active sheet 正确。
- 通过 debug 客户端或页面行为确认 unobserved formula 不在打开 Sheet1 时被提前计算。
- console error/warning 为 0 或只有明确 allowlist 项。

## 停止条件

- 如果 worker `removeSheet` 的 Rust/WASM 语义不是 idx-shift，而是稳定 id，先停下来修正文档和
  adapter 设计。
- 如果 `SheetTabs` 为了 async 结构操作需要引入组件内 workbook 状态副本，停止；应回到
  workbook store 暴露 reactive metadata。
- 如果 MultiSheet seed 导致导入时 formula eval 增长，停止；需要查 worker import 或 visible
  hydration 是否提前读取。
- 如果 MCP Playwright 不可用，必须记录具体失败原因，并用 CLI Playwright 临时兜底；不能静默
  认为通过。

## 预期提交拆分

1. `docs(rust): plan Wave 6 product hardening`
2. `feat(solid-excel): worker-backed multisheet workbook`
3. `test(solid-excel): cover worker multisheet product path`
4. 如公式诊断也落地，单独提交：`feat(solid-excel): surface formula diagnostics`

## 本轮执行记录

- W6-A：`WasmWorkbookStore` 暴露 worker-backed `addSheet` / `renameSheet` /
  `removeSheet` / `indexOf`。结构操作以 worker RPC + `sheetList()` 回读为权威；
  remove 后重建 `SheetStore`/adapter 并释放旧订阅；最后一张 sheet 在 store 层拒删。
- W6-B：`SheetTabs` 支持 sync/async workbook 结构操作；`MultiSheet` 切到
  `createWorkerWorkbookStore` + worker import session seed；Sheet1!B5 显示
  `=Expenses!B5` 的结果。
- W6-C：`multisheet-ui.spec.ts` 扩到 10 条，覆盖 worker-backed seed、add/rename/delete、
  跨 sheet formula 结果，以及 `Expenses!C5 = Notes!B1+1` 的 lazy debug probe。
- 集成修复：结构操作重建 store 后，`MultiSheet` table key 改为 active sheet + sheet
  metadata 指纹，避免 active idx 不变时继续挂旧的 disposed store。
- MCP Playwright：`http://localhost:5174/?debug=1` 验证 backend 为 `worker-workbook`；
  Sheet1!B5=11700；打开 Sheet1 时 `Expenses!C5` 为 dirty，切到 Expenses 后显示 41 且
  cache clean；新增 Sheet4、Notes 重命名为 Renamed、删除 Renamed 均通过；console
  warning/error 为 0。
- W6-D 后半段：公式提交增加 detailed result 合同，worker-backed FormulaBar 展示
  `INVALID_FORMULA` / `FORMULA_CYCLE` 的简洁诊断，成功提交或切换 selection 后清理。
- W6-D 函数门禁：Rust core 补 MVP `TEXT()`（`0.00`、`000` 等零格式），新增浏览器
  `formula-functions.spec.ts` 覆盖 `TEXT()`、`TODAY()`、`NOW()` 的真实 WASM UI 路径。
- 集成修复：FormulaBar 只在 active addr 变化时清理诊断，避免 worker hydration 回来后把同一
  cell 的错误提示立即抹掉；`DemoFormulas` debug cleanup 挪回组件 owner，MCP console
  warning/error 为 0。
- MCP Playwright：手工在 `Multi-Sheet` 输入 `=garbage((` 得到 `INVALID_FORMULA` /
  `Invalid formula`，输入 `=I18+1` 得到 `FORMULA_CYCLE` / `Formula cycle`；合法 `=1`
  清理诊断；`Formulas` 中 `TEXT(1234.5,"0.00")=1234.50`，`TODAY()` / `NOW()` 显示本地日
  serial；console warning/error 为 0。
- Wave 6.5 虚拟化 UX 追补：
  - `DemoMillion` 的 1M worker-backed table 接入 `FormatToolbar`，真实 UI 上可以直接触发
    大选区格式化。
  - `Table` 右键 cell 时，如果命中当前 `selectionRange` 内部则保留 range；只有点到 range
    外才折叠到单 cell。这样 Cut/Copy/Clear 继续作用在已有大选区上。
  - `context-menu.spec.ts` 增至 5 条：覆盖 `A1:B2` range 内右键 `B1` 后执行 Clear，
    四个 cell 都被清空。
  - `million-demo.spec.ts` 增至 10 条：大选区通过真实 Bold 按钮走 range-native
    `set_format_range(0,0,999,999,{bold:true})`，并禁止 `selectionAddrs` / 单 cell
    `set_format` 被调用；键盘从 `A1` 移动到虚拟视口外的 `S29` 后，目标 cell 可见且仍
    selected，DOM cell 数保持 `<1500`。
  - 本地门禁：`npx tsc -p solid/excel/tsconfig.json --noEmit`、`npm run build -w
    @einfach/solid-excel`、`NO_PROXY=localhost,127.0.0.1 npm --prefix solid/excel run e2e --
    e2e/context-menu.spec.ts`（5/5）、`NO_PROXY=localhost,127.0.0.1 npm --prefix solid/excel
    run e2e -- e2e/million-demo.spec.ts`（10/10）均通过。
  - MCP Playwright：`http://localhost:5174/?debug=1` 验证 1M toolbar 可见；点击真实
    Bold 按钮后记录到唯一 `set_format_range` 调用；键盘事件移动到 `S29` 后
    `cell-selected`、DOM cell 数 735；Blank 页 range 内右键 Clear 后 `A1/B1/A2/B2`
    显示为空；console warning/error 为 0。
