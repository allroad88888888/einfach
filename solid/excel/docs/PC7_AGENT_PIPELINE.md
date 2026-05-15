# PC-7 多批次 Agent Pipeline 计划

本文档用于接管 `@einfach/solid-excel` vNext 后续推进。目标不是继续在旧
`solid/excel/src` 上补丁式演进，而是把在线电子表格的核心能力收敛到
`solid/excel/src-vnext`、`@einfach/spreadsheet-ui-core`、Rust/wasm workbook 这三层。

## 产品目标

- 在线电子表格，兼容百万级 cell。
- 不做多人共同在线编辑。
- 未显示、未读取、未导出、未显式依赖的公式必须延迟计算。
- UI 层只关心可视区域展现、用户交互和少量 chrome 状态，不创建全量 cell/row/column
  状态。
- Rust/wasm 层保存稀疏 workbook facts、公式依赖、格式、行列 metadata 和可流式读取的
  range 数据。

## 当前基线

- vNext UI 已经走 `@einfach/spreadsheet-ui-core` store，首屏 demo 默认进入 vNext。
- FormulaBar、SheetTabs、toolbar、context menu、clipboard、范围格式、可视窗口 grid、
  row/column resize UI metadata、worker backend demo 都已经接入。
- `@einfach/solid-excel/vnext` 子入口已经存在；root `@einfach/solid-excel` 仍保持
  legacy 默认入口。
- W1 已完成：真实 worker runtime 已迁到
  `solid/excel/src-vnext/adapter/worker-runtime.ts`，vNext worker factory 指向 vNext
  runtime；legacy `solid/excel/src/wasm-workbook-worker.ts` 只保留兼容 shim。
  `range-tsv` helper 也迁到 vNext adapter，legacy 路径保留 re-export。
- W1 顺手修复：worker workbook adapter 现在会尊重 `setFormulaDetailed` 返回的
  `{ ok:false }`，抛出带 `code/message` 的 backend error，而不是把失败公式 mutation
  当作成功。
- W3 已完成：Rust core/wasm 已有 true `move_sheet`，worker protocol/runtime 和 vNext
  adapter 已接入；vNext worker adapter 不再维护 `sheetOrderIds` 这类长期 JS display-order
  sidecar，sheet 顺序以 Rust workbook `sheetList()` 回读为准。
- W3 顺手修复：worker backend lookup 里稳定 sheet id/name 优先于 `sheet-${idx+1}` 位置别名，
  避免 reorder 后 `sheet-2` 被误解析成“第二个 sheet”。
- W4 已完成：row/column size 已进入 Rust sparse metadata，snapshot/reload 与可视 DOM
  autofit 已接入 vNext worker/backend。
- W5 已启动：Rust `bulk_load`、range dependent interval index、worker TSV chunk export
  已有主体；本轮补齐 worker sparse range snapshot chunk protocol，供大撤销、大粘贴和后续
  range 传输复用，避免一次性返回大数组。
- W2 已完成：单 sheet dependent 传播、dirty notify 契约和 TLS resolver 清算均已核实；
  vNext Worker demo 增加 `Sheet2!C5` 独立 lazy probe，打开 Sheet1 时保持 dirty，
  切到 Sheet2 后由可视读取计算并输出 console lazy 日志。

## 执行模型

每一波由“总架构师”收口，子 agent 只负责候选补丁、测试和风险报告。

- 子 agent 不直接 commit。
- 每个子 agent 必须有清晰写入边界，避免多人改同一组文件。
- 每个子 agent 的最终回复必须包含：改了哪些文件、跑了哪些测试、仍有哪些风险。
- 总架构师负责合并、补测试、跑完整验收、执行 MCP Playwright 验证、更新文档、commit。
- UI 或交互相关波次必须做 MCP Playwright 验证；只改 Rust 内核的波次也要在最终合入后跑一条
  vNext worker e2e + MCP smoke，证明真实页面仍能工作。
- 高风险 Rust/依赖图/架构判断优先交给 Claude Sonnet；边界清晰的 TS/Solid/Jest/e2e
  任务优先交给 Codex `gpt-5.3-codex-spark` 这类便宜模型。

子 agent 通用约束：

- 不允许把 per-cell、per-row、per-column atom 引入 UI。
- 不允许为了导航、hover、selection、format projection 去读取整张 sheet。
- 不允许让 public package import 触发 `import.meta.url` worker factory 副作用。
- 不允许删除 legacy 兼容路径，除非同一波已经给出迁移入口和测试。
- 不允许绕过 Rust/wasm lazy contract，在 Solid 层缓存公式最终值作为事实来源。

## 剩余波次总览

W1-W4 已完成。W5 可以继续并行开分支推进，合入顺序要由总架构师控制。
W6、W7 是 package cutover 和发布门禁。

| 波次 | 目标 | 可并行 agent | 主要写入边界 | 必须验收 |
| --- | --- | --- | --- | --- |
| W1 | 已完成：vNext worker 实现边界迁移 | Worker Runtime、Worker Tests、Public Surface Review | `solid/excel/src-vnext/adapter/*`、legacy worker shim、worker tests/e2e | vNext 不再指向 legacy worker 实现；Jest worker tests；vNext worker e2e；MCP smoke |
| W2 | 已完成：Lazy formula 正确性回归 | Rust Lazy、Wasm Contract、E2E Lazy | `rust/excel-core/*`、`rust/wasm/*`、WASM/JS tests、lazy e2e | 单 sheet dependent 传播；dirty notify 契约；TLS resolver 清零；vNext lazy probe + MCP |
| W3 | 已完成：true sheet reorder | Rust Workbook、Wasm/Worker Adapter、Cross-sheet E2E | workbook sheet order、wasm API、worker protocol、adapter、e2e | 跨 sheet 公式在 reorder 后仍正确；不再只靠 JS display-order 兜底 |
| W4 | 已完成：row/column size 持久化和 autofit | Rust Metadata、Adapter Projection、Interaction E2E | Rust sparse metadata、snapshot/reload、adapter、grid resize/autofit tests | 尺寸 metadata 稀疏持久化；autofit 只基于可视 DOM/当前窗口 |
| W5 | bulk load、range streaming、range interval index | Rust Data Plane、Wasm Streaming、Perf/E2E | bulk API、range chunks、interval index、streaming tests | 大批量导入公式不 eager compute；大 range copy/export 流式；百万级 case 不创建全量 UI 状态 |
| W6 | package cutover readiness | Package API、Legacy Compatibility、Docs/Migration | `package.json`、public barrels、compat tests、migration docs | 明确 root 是否切 vNext；legacy 有稳定入口；消费侧 import tests 通过 |
| W7 | 发布级回归门禁 | Test Sweeper、MCP Verifier、Docs Status | e2e specs、docs status、少量 test helper | 无新增 skip；console clean；核心 smoke、worker、interaction、large range、package 全通过 |

## W1：vNext worker 实现边界迁移

目标：把真实 worker runtime 移到 vNext 边界内，legacy 路径只做兼容 shim。

并行分工：

- Worker Runtime agent：负责 `src-vnext/adapter` 下 worker runtime 文件、worker factory URL、
  legacy `src/wasm-workbook-worker.ts` 兼容 shim。
- Worker Tests agent：负责 `wasm-workbook-proxy`、`vnext-adapter`、package subpath 和
  `vnext-worker-backend.spec.ts` 回归。
- Public Surface Review agent：只读 review，重点看 `import.meta.url` 是否被 public barrel
  或 root package import 带入 Jest/Node-like 环境。

验收门禁：

- `rg -n "\\.\\./\\.\\./src|\\.\\./src|from '../../src|from '../src" solid/excel/src-vnext -g '*.ts' -g '*.tsx'`
  只能剩明确记录的兼容例外；W1 完成后目标是 vNext 生产代码零 legacy import。
- `npx jest solid/excel/test/package-vnext-subpath.test.ts solid/excel/test/vnext-adapter.test.ts solid/excel/test/wasm-workbook-proxy.test.ts --runInBand`
- `npm run build -w @einfach/solid-excel`
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel -- e2e/vnext-worker-backend.spec.ts`
- MCP Playwright 打开本地 vNext worker demo，验证页面可编辑、公式链计算、console error 为 0。

## W2：Lazy formula 正确性回归（已完成）

目标：把已经发现的 lazy 真 bug 和契约缺口钉死。

并行分工：

- Rust Lazy agent：修复单 sheet `WasmSheet::set_number` 不传播本 sheet dependents 的问题；
  补 Rust unit。
- Wasm Contract agent：补 `dirty notify` 精确契约测试，覆盖“订阅公式后，多次写源同值仍发 dirty
  通知”的 lazy 行为。
- E2E Lazy agent：用 vNext worker demo 增加跨 sheet lazy 链路和可见读取触发计算的 e2e。

验收门禁：

- 单 sheet 公式 dependent 传播不再有 `.skip`。
- TLS resolver 清算达到 grep-zero，或在文档里列出唯一允许例外和迁移原因。
- Rust lazy unit、wasm tests、`vnext-worker-backend.spec.ts` 通过。
- MCP Playwright 验证 3-sheet chain：打开 Sheet1 时，只计算可见/被读取链路，console 中有可验证
  lazy read 日志。

## W3：true sheet reorder（已完成）

目标：让 Rust workbook 成为 sheet order 的事实来源，而不是长期靠 JS adapter display-order 映射兜底。

完成内容：

- `Workbook::move_sheet(from, to)` 移动 `sheets/names` 后重建 `by_name`，并从当前公式 AST
  重建 `CrossSheetDeps`，避免跨 sheet dirty fanout 继续指向旧 index。
- `WasmWorkbook::move_sheet` 暴露到 wasm，并 remap workbook subscription token 内部保存的
  `sheet_idx`，保证 move 后退订仍打到正确 sheet。
- Worker protocol/runtime 增加 `moveSheet(from, to)`；vNext worker backend 的 `reorderSheet`
  改为 RPC 到 Rust 后再 `sheetList()` 回读事实顺序。
- 删除 worker backend 的 `sheetOrderIds` 长期 sidecar；`reorderSheetMetadata` 只保留为一次性
  计算目标位置的 helper。
- `vnext-worker-backend.spec.ts` 覆盖拖拽 reorder 后 Rust `sheetList()` 顺序、Sheet1/Sheet2/Sheet3
  公式值和 console clean。

剩余风险：

- `rename_sheet` 仍未做公式文本/AST 中 sheet 名的同步改写；目前 W3 只收敛 true reorder。
- `remove_sheet` 仍沿用清空 cross-sheet deps 的防御策略；delete 后公式引用语义后续需要单独规划。

并行分工：

- Rust Workbook agent：设计并实现 true `move_sheet`。如果依赖图内部仍按 sheet index 存储，
  必须同时完成 index remap 或改为稳定 sheet id/name key。
- Wasm/Worker Adapter agent：暴露 wasm API、worker protocol message 和 vNext adapter 调用。
- Cross-sheet E2E agent：补 reorder 后跨 sheet 公式、rename 后公式、delete 后 active sheet/fallback
  的 e2e。

验收门禁：

- Rust unit 覆盖 sheet reorder 前后 cell 内容、公式依赖、dirty propagation。
- `Sheet1 -> Sheet2 -> Sheet3 -> Sheet1` 这类跨 sheet 链在 reorder 后仍能正确读取。
- vNext adapter 不再维护会和 Rust 事实冲突的长期 display-order sidecar。
- MCP Playwright 拖拽 tab 后验证公式显示值不变、console error 为 0。

## W4：row/column size 持久化和 autofit

目标：行高/列宽不再只是 JS adapter 临时 metadata，而是 Rust workbook 稀疏事实。

当前状态：

- 已完成：`Sheet` 保存 sparse `row_heights` / `col_widths` facts；row/col insert/delete
  只 shift 已存在的 sparse key，不创建全量尺寸数组。
- 已完成：`WasmWorkbook` 暴露 `snapshot_viewport_sizes`、`set_row_height`、
  `set_col_width`；persistence v1 兼容扩展可选 `sizes` 字段，空白 sheet 只保存
  显式设置过的尺寸 metadata。
- 已完成：vNext worker backend 不再维护 JS row/col size sidecar，`readViewportSizeProjection`
  读取 Rust window snapshot，resize commit 写 Rust workbook。
- 已完成：Jest 覆盖 worker protocol/runtime/backend；Playwright worker e2e 覆盖 resize
  后 persistence `sizes` 稀疏事实和可视 DOM 有界。
- 已完成：autofit 通过双击 row/column resize handle 触发。Solid UI 只测量当前可视
  DOM 的 header/cell 文本，计算出单行或单列尺寸后复用 `setRowHeight` /
  `setColumnWidth` port 持久化；不向 backend 请求整行、整列或全表扫描。
- 已完成：MCP Playwright 覆盖 resize/autofit 的视觉结果、Rust sparse facts 和
  DOM 仍只挂载可视 cell。

并行分工：

- Rust Metadata agent：实现 sparse row/column size metadata、snapshot/reload、默认值策略。
- Adapter Projection agent：更新 wasm/worker/static adapter 的 `readViewportSizeProjection`、
  `setRowHeight`、`setColumnWidth`。
- Interaction E2E agent：补 resize、切 sheet、reload、autofit 的 Playwright 覆盖。

验收门禁：

- 不允许保存全量 row/column size 数组。
- reload 后尺寸恢复；未设置尺寸的行列仍走默认值。
- autofit 只能基于当前可见窗口或明确请求的有限数据，不扫描整表。
- MCP Playwright 验证 resize 和 autofit 的视觉结果、DOM 仍只挂载可视 cell。

## W5：bulk load、range streaming、range interval index

目标：补齐百万级 cell 的数据面，不让导入、copy/export、range 依赖追踪退化为全表操作。

当前进展：

- Rust core 已有 `Sheet::bulk_load` / `Workbook::bulk_load`、lazy formula dirty cache 和
  `RangeDependentIndex` 复杂度回归测试。
- WASM/worker 已有 import session 与 TSV export session；TSV copy/export 走 row chunk
  聚合，不要求 UI core 读取整张 sheet。
- 已补 `beginSnapshotRangeSparse` / `nextSnapshotRangeSparseChunk` / `cancelSnapshot` /
  `snapshotRangeSparseChunks`：snapshot sparse range 也能按行段从 worker 流式回传，后续
  大撤销、大 paste staging 和 range-based transfer 可以复用同一模型。
- 已补 backend `importCells` port 和 vNext context-menu large paste 接线；超过小范围阈值的
  TSV paste 走 worker `beginImport/importChunk/commitImport`，不再由 UI 循环发逐 cell
  mutation RPC。

并行分工：

- Rust Data Plane agent：设计并实现 `bulk_load`/batch formula 写入入口，保证公式导入只标 dirty，
  不 eager compute。
- Wasm Streaming agent：实现 range streaming/chunk protocol，统一导出 TSV、snapshot sparse range
  和后续 large paste 的传输模型。
- Range Index agent：实现 range interval index，避免范围依赖在大表里线性扫描。
- Perf/E2E agent：补 100k 到 1m 级 synthetic case，验证 UI DOM、atom 和公式计算都保持 bounded。

验收门禁：

- 大批量公式导入没有立即计算所有公式。
- large range export/copy 走 chunk streaming，不走整块 projection。
- range dependent dirty propagation 在大 range 下有复杂度回归测试。
- MCP Playwright 验证大 range 操作后页面仍可交互、可视 cell 数稳定。

## W6：package cutover readiness

目标：把 vNext 作为可交付 package surface，同时保留明确 legacy 迁移路径。

并行分工：

- Package API agent：决定 root `@einfach/solid-excel` 是否切到 vNext；若切换，legacy 迁到
  `@einfach/solid-excel/legacy` 或兼容 namespace。
- Legacy Compatibility agent：为旧 `Table/createSheetStore/worker store` 等入口补兼容 import
  测试或迁移说明。
- Docs/Migration agent：更新 `README`、`INTERACTION_ATOM_PLAN.md`、迁移示例和风险列表。

验收门禁：

- package root、`/vnext`、legacy 入口都有 import tests。
- public barrel 不导出 demo，不导出会触发 worker URL 副作用的 factory。
- `npm run build -w @einfach/solid-excel`、package tests、核心 e2e 通过。

## W7：发布级回归门禁

目标：不再只证明单点功能能跑，而是证明 vNext 路线可以作为主路径继续迭代。

并行分工：

- Test Sweeper agent：清理现有 `.skip`，把合理 skip 改成明确 TODO issue，能打开的都打开。
- MCP Verifier agent：专门跑 MCP Playwright，记录 URL、断言、console、截图要点。
- Docs Status agent：同步 `HANDOFF`、`INTERACTION_ATOM_PLAN`、执行波次文档状态。

最终验收：

- Rust unit、wasm tests、`@einfach/spreadsheet-ui-core` tests、`@einfach/solid-excel` Jest、
  build、vNext e2e 全通过。
- MCP Playwright 至少覆盖：vNext smoke、worker backend、3-sheet lazy chain、tab reorder、
  row/column resize、large range copy/export。
- 无新增非解释性 `.skip`。
- 文档中“已完成 / 未完成 / 下一步”与代码现状一致。

## 每波交付格式

每波完成后，总架构师需要在 commit 前写下：

- 本波完成的功能。
- 子 agent 列表、模型、写入边界。
- 关键测试命令和结果。
- MCP Playwright 验证结论。
- 剩余风险和下一波入口。

提交粒度建议：每波至少一个 commit；如果一波里 Rust、adapter、e2e 三部分都很大，可以拆成
“core 实现”、“adapter 接线”、“e2e/文档”三个 commit，但不能把未通过验收的半成品合入主线。
