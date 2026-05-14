# 在线电子表格剩余执行波次规划

> 日期：2026-05-14
>
> 当前角色：总架构师。
>
> 产品目标：在线电子表格；不做多人协同；支持百万级 cell；公式只在视口读取、
> 显式读取、导出或订阅路径计算。空 cell 不物化，前端不复制核心状态。

## 当前 HEAD 事实

以最近提交 `0cf1ef3 feat(solid-excel): harden virtualized UX gates` 为准；
文件导入/backpressure UI、Wave 6 产品硬化、Wave 6.5 虚拟化 UX 门禁均已完成本地与
MCP 验收，当前工作树进入发布门禁波。
项目已经越过旧 `PHASE5_PARALLEL.md` 和早期 north-star 计划里的起点状态。

本轮状态更新：

- Wave 3 已提交到 `6462024`（bounded import + sparse persistence v1）。
- Wave 4 已提交到 `f456dd7`（debug counters + observability e2e + MCP 记录）。
- Wave 5 已提交到 `4337eb7`：正式文件导入 / backpressure UI。
- Wave 6 已提交到 `352df78`：worker-backed MultiSheet、FormulaBar diagnostics、
  `TEXT/TODAY/NOW` 浏览器门禁。
- Wave 6.5 已提交到 `0cf1ef3`：1M toolbar range-native format、键盘跨虚拟视口、
  range 内右键 Clear 与 MCP 记录。
- Push / CI 仍禁止，直到用户放开并完成总体上层门禁。

已落地的主能力：

- Rust `excel-core` 已经是 lazy formula 主线：公式保存 AST/依赖/cache，`set_formula`
  不 eager compute。
- `WorkbookEvalProvider` 已承担跨 sheet lazy eval；旧 TLS resolver 只剩历史文档噪音。
- workbook 级跨 sheet point/range dirty graph、range dependency index、sparse value index、
  bounded cross-sheet range parser 已落地。
- `WasmWorkbook` 已有 canonical workbook mutator、`bulk_import_cells`、
  `list_non_empty_cells`、`snapshot_sparse`、`snapshot_range_sparse`、
  `restore_sparse`、`read_sparse_range`、`clear_range`、`set_format_range`、
  debug formula eval/cache 探针。
- `solid/excel` 已有 worker-owned workbook RPC、request id、统一 ok/error envelope、
  begin/importChunk/commit/cancel import session、sparse snapshot、range clear、range format。
- `DemoMillion` 已走 worker-backed workbook + 2D virtualized table；seed 生成已经按 chunk
  flush，不再在主线程一次性构造完整 seed 数组。
- 大 selection clear / copy / format 已有 range-native 或 backend-assisted 路径：
  large clear 通过 sparse snapshot/restore 支持可 undo；copy 优先走 worker chunked TSV
  export session；format 走 `set_format_range` + format snapshot/restore undo，不再盲目
  展开百万地址。
- worker-backed store 的产品写公式路径已有 `setFormulaAsync`，可以把 worker/Rust 的
  parse/cycle 结果回传到 store；同步 `set_formula` 兼容接口仍是 optimistic `true`。
- worker-backed `formulaCacheState` 已能异步从 worker 探测真实 cache 状态；首次读取前可
  返回 `unknown`，随后更新。
- `DemoMillion` 已接入 `FormatToolbar`；大选区点击真实 Bold 按钮走 range-native
  `set_format_range`，不展开 `selectionAddrs`。
- `Table` 右键命中当前 range 时保留选区；context menu 的 Clear/Cut/Copy 可继续作用于
  已有 range。

仍未达到产品目标的地方：

- 同步 `ISheet.set_formula` 仍然只能返回 optimistic `true`，但产品公式提交路径已经收敛到
  `setFormulaAsync` / `setFormulaDetailedAsync`；FormulaBar 不再把同步兼容层当权威结果。
- 浏览器剪贴板写入仍需要最终字符串；当前已把 worker 侧 range export 改成按行块读取和
  postMessage，后续文件导出/持久化可复用 chunk 合同继续做真正 sink streaming。
- worker import session 已按 chunk 写入 worker 内 staging workbook，并补上 bounded memory
  合同、稳定错误码和 cancel/commit 测试。
- 稀疏持久化 v1 合同已经形成：sheet meta + sparse cells + format metadata，不保存 dense grid
  或公式结果。自动保存仍未做。
- 测试覆盖已经很多，E2E 文档计数已经在发布门禁中校准为 23 spec / 162 active Playwright
  tests / 0 skip。
  MCP Playwright 验证记录已经进入 Wave 4/5/6/6.5 文档，后续每波继续固定记录。

## 总体判断

还剩 **1 个发布门禁波**。产品化实现波已完成到 Wave 6.5。

原“波次 1 权威 worker 命令合同”已经完成大半：worker workbook RPC、async formula、
formula cache probe 都在主线。现在的波次 1 改为“权威命令收口 + 文档同步”，不再重复做
已经落地的 worker skeleton。

后续波次都可以多 agent 并行推进，但每波必须先冻结接口、分清文件所有权，最后由总架构师
集成验收。子 agent 的“已完成”只表示候选补丁完成，不表示可合入主线。

## 本轮 agent 调度记录

本轮必须显式记录外部/内部 agent，而不是只在口头说“多 agent”：

- Claude Sonnet 已用外部 CLI 只读审查：
  `claude -p --model sonnet --permission-mode plan --max-budget-usd 1 ...`。
  结论：旧计划里“只有行虚拟化、range dep 未修、copy/format 仍全量展开”等判断已过期；
  真实剩余风险集中在 range format undo、copy/export streaming、import/persistence 和
  MCP 门禁产品化。
- Codex Spark 已尝试外部 CLI：
  `codex exec -m gpt-5.3-codex-spark -C /Volumes/work/self/einfach --sandbox read-only ...`。
  结果：当前账号触发使用限额，提示 `try again at 4:42 PM`。后续同一波如果 Spark 不可用，
  必须记录失败并降级到便宜模型。
- 已降级执行 `codex exec -m gpt-5.4-mini ...` 做只读审查；内部子 agent 也使用
  `gpt-5.4-mini` 复核当前 P0/P1 和下一波拆分。
- Wave 2 copy/export streaming 使用内部 `gpt-5.3-codex-spark` 子 agent 执行
  worker/proxy 协议候选补丁；Claude Sonnet 同步做只读架构审查。总架构师在主线集成
  SheetStore、worker store、E2E 和文档，并以本地测试/MCP 为最终验收。
- 总架构师仍是唯一集成和验收角色。Claude/Sonnet、Codex Spark、便宜 Codex 子 agent 的
  输出只能作为候选实现或审查意见，不能替代最终验收。

## 总控规则

### 状态边界

- Rust/WASM workbook 是产品数据、公式 cache、依赖图、稀疏快照、导入结果的唯一事实源。
- Solid 只保存 UI 交互状态和可见投影 cache；不能保存公式结果、依赖图、全量数据副本。
- atom/核心状态必须按需创建。读取、订阅或引用空 cell 不能创建 primitive atom。
- 公式导入、`set_formula`、bulk import 不得触发公式求值；只有 read/export/visible/subscribed
  路径允许计算。

### 子 agent 工作方式

- 每个子 agent 必须有明确角色、文件所有权、不要触碰的文件、测试命令和停止条件。
- 可以使用：
  - `claude -p --model sonnet`：复杂架构复核、Rust/worker 高风险实现、代码审查。
  - `codex exec -m gpt-5.3-codex-spark` 或 Codex worker 子 agent：边界清晰的实现、红测、
    文档同步、局部修复。
- 子 agent 必须在最终报告里写清：
  - 改了哪些文件；
  - 跑了哪些测试；
  - 哪些测试没跑以及原因；
  - 是否触发停止条件；
  - 是否有遗留风险。
- 子 agent 不允许 `git push`、不允许改 `.github/workflows/*`、不允许 `git commit --amend`。
- 任何 UI 或 browser 行为相关波次，必须有 Playwright CLI + MCP Playwright 或 Chrome
  DevTools MCP 验证记录。MCP 不可用时，要记录失败原因，并用 CLI Playwright 兜底，但不能
  静默跳过。

### 总架构师验收

每波最终以总架构师验收为准：

- review 子 agent diff；
- 解决跨 agent 冲突；
- 跑该波 blocking gate；
- 用 MCP 验证关键浏览器行为；
- 更新本计划的状态或新增 handoff；
- 只在用户要求时 commit / push。

## 波次 1：权威 worker 命令收口

状态：已完成。`setFormulaAsync` 已作为 worker-backed 产品公式提交路径使用；worker-backed
粘贴公式也改走 async 公式命令，不再依赖同步 `set_formula` 的 optimistic `true`。proxy /
worker / store 测试已钉住 parse fail、cycle、invalid sheet、失败回滚、undo 批次一致性。

### 目标

把已落地的 worker-backed workbook store 从“主要路径可权威”收口到“产品入口不再误用同步
乐观接口”。

必须解决：

- UI 和 store 的写公式入口必须优先使用 `setFormulaAsync` 或 async command facade。
- 同步 `ISheet.set_formula` 必须明确是 legacy compatibility，不能被文档或产品路径当作权威成功。
- parse fail、same-sheet cycle、cross-sheet cycle、invalid sheet 必须有测试证明能回到 UI/store 命令层。
- worker hydration 不能用旧响应覆盖新 mutation；现有 version guard 要补足回归测试和文档说明。
- `formulaCacheState` 的 async probe 状态要写入 E2E 文档，避免后续 agent 继续把它当“永远 unknown”。

### 并行角色

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| A1 Worker 协议复核 | Claude Sonnet | `solid/excel/src/wasm-workbook-proxy.ts`, `solid/excel/src/wasm-workbook-worker.ts` | 只读/小补丁：确认 ok/error/code、request version、hydrate 乱序没有漏测 |
| A2 Store 合同收口 | Codex Spark | `solid/excel/src/wasm-workbook-store.ts`, 必要时 `solid/excel/src/types.ts` | 清点仍调用同步 `set_formula` 的产品入口；能改则改到 async command facade |
| A3 测试 | Codex Spark | `solid/excel/test/*`, `solid/excel/e2e/worker-workbook.spec.ts` | 钉非法公式、循环、乱序 hydrate、cache probe 的回归测试 |
| A4 文档 | Codex Spark 或便宜 Codex | `rust/docs/HANDOFF.md`, `solid/excel/docs/E2E_TEST_PLAN.md`, 本文档 | 同步 worker authority 当前状态和 agent 调度记录 |

### 验收门禁

```sh
cd /Volumes/work/self/einfach && npx jest solid/excel/test/wasm-workbook-proxy.test.ts
cd /Volumes/work/self/einfach && npx jest solid/excel/test/worker-workbook-store.test.ts
cd /Volumes/work/self/einfach && npm run build -w @einfach/solid-excel
cd solid/excel && npx playwright test e2e/worker-workbook.spec.ts e2e/workbook-chain.spec.ts
```

MCP 验收：

- 打开 worker-backed demo；
- 手动输入非法公式和循环公式；
- 验证 UI 不把失败命令永久显示为成功；
- console 无未处理错误。

### 停止条件

- 如果 `ISheet` 同步接口无法表达 fallible async mutation，不继续硬塞；使用 async command
  facade 或 product-only workbook command 层，并把同步接口标注为兼容层。
- 如果 rollback 会导致可见 cell 闪烁或旧 hydrate 覆盖新 mutation，先设计 version/seq。

## 波次 2：Range-native undo / format / copy / export

状态：实现完成，等待本轮最终提交。large range format 已接入 format metadata
snapshot/restore：Rust core 只快照 range-format layers 和 range 内显式 per-cell
formats，不展开空 cell；WASM/worker/SheetStore 已接入 undo/redo。copy/export 已从
一次性 worker TSV 字符串推进到 worker export session + row chunks，SheetStore 大范围复制
优先走 `export_range_tsv_chunks`，legacy `export_range_tsv` 保留为兼容回退。

本轮验收记录：

- Codex Spark 子 agent：实现 worker/proxy chunked TSV export 协议候选补丁，并自跑 proxy /
  worker Jest。
- Claude Sonnet：只读审查，指出非事务快照语义、session 泄漏、chunk 拼接边界和 MCP 测试点。
- 总架构师集成：补 `ISheet.export_range_tsv_chunks`、worker workbook store、SheetStore 优先
  chunked copy、1M/worker E2E 和文档。
- MCP Playwright：在 `http://localhost:5174/?debug=1` 打开 1M Cells，验证 121×121 大选择
  `copySelectionTextAsync()` 调用 `export_range_tsv_chunks(0,0,120,120)`，未调用 legacy
  `export_range_tsv` / `selectionAddrs` / `copySelection`，console 只有 favicon 404。

### 目标

把“大矩形操作”从“多数已经 range-native”推进到“undo、streaming、持久化合同可产品化”。

必须解决：

- 大 range clear 的 backend sparse snapshot/restore 路径已经存在；本波补文档、MCP 验收和
  fallback 降级说明。
- format selection 已走 backend range metadata；本波补 format-range snapshot/restore 或明确
  transaction，使 large format 可 undo，不能继续清空 undo 栈。
- copy/export 已走 backend TSV export；本波把一次性整段字符串收口为 worker chunked read。
- undo snapshot 来源必须是 Rust/worker sparse iterator，不是主线程 projection cache。

### 并行角色

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| B1 Rust/WASM range format undo | Claude Sonnet | `rust/excel-core/src/sheet.rs`, `rust/wasm/src/lib.rs` | 设计 range format layer snapshot/restore 或 compaction transaction，不触发公式 eval |
| B2 Worker streaming export | Codex Spark | `solid/excel/src/wasm-workbook-proxy.ts`, `solid/excel/src/wasm-workbook-worker.ts` | 从 `exportRangeTsv` 一次性字符串推进到 chunked export |
| B3 SheetStore range UX | Codex Spark | `solid/excel/src/sheet-store.ts`, `solid/excel/src/Table.tsx` | large format undo、copy/export streaming 接入；维持小范围路径 |
| B4 E2E/Perf | Codex Spark | `solid/excel/e2e/range-ops.spec.ts`, `solid/excel/e2e/million-demo.spec.ts` | 钉住不展开百万地址、不清空旧 undo 栈、导出按 chunk 读 |

### 验收门禁

```sh
cd rust/excel-core && cargo test --lib
cd rust/wasm && cargo build
cd /Volumes/work/self/einfach && npx jest solid/excel/test/sheet-store.test.ts
cd /Volumes/work/self/einfach && npx jest solid/excel/test/worker-workbook-store.test.ts
cd solid/excel && npx playwright test e2e/range-ops.spec.ts e2e/million-demo.spec.ts
```

MCP 验收：

- 在 1M demo 选择大矩形执行 clear / undo / copy/export；
- 验证 DOM cell 数、订阅数和 console；
- 验证大 range 操作不会造成浏览器长时间无响应。

### 停止条件

- 大 range 操作需要主线程生成 O(range cell count) 地址字符串。
- undo 需要从 `raw.non_empty_addrs()` 或 projection cache 取事实源。
- snapshotRange 或 format undo 读取公式结果导致 eval counter 增长。
- chunked export 会在 worker 内一次性 snapshot 整个范围，而不是按当前 row chunk 读取。

## 波次 3：真正 bounded 的导入与稀疏持久化 v1

状态：已提交（`6462024`），执行计划和验收记录已落地到
`rust/docs/WAVE3_IMPORT_PERSISTENCE_PLAN.md`。本波按多 agent pipeline 执行：
Codex Spark 负责 worker/proxy persistence 与 E2E，Claude Sonnet 负责只读风险审查，总架构师
负责 Rust 原子性修正、WASM 重新生成、本地测试与 MCP Playwright 最终验收。

### 目标

把“worker chunk API”推进到“内存有上界、可取消、可持久化、保持 lazy”的产品导入/保存链路。

必须解决：

- worker import session 不能无限累积所有 chunk：已用 chunk/normalized/final-touch/issues 上界收口。
- CSV/JSON 解析和 backpressure 策略要明确：本波不做正式文件 parser/UI，先固定 worker 合同和错误码。
- commit 必须走 Rust `Workbook::bulk_load`；导入公式后 `debug_formula_eval_count == 0`：已由
  worker e2e 和 MCP 验证。
- sparse persistence v1 保存 sheet name、dimension、primitive、formula、format；不保存 dense grid：
  已由 Rust/WASM API、worker/proxy API 和 e2e 验证。
- cancel 后 workbook 不可见任何 session 内容：已由 MCP 和 worker/import 测试验证。

### 并行角色

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| C1 Import runtime | Codex Spark + 总架构师 | `solid/excel/src/wasm-workbook-worker.ts`, tests | bounded session、错误码、cancel/commit 语义 |
| C2 Persistence schema | Codex Spark + 总架构师 | `rust/wasm/src/lib.rs`, `wasm-workbook-proxy/worker` | sparse persistence v1 schema + worker API + round-trip |
| C3 Demo/import UI | 后续 | `solid/excel/src/demos/DemoMillion.tsx` | 正式文件导入进度 UI 延后，不阻塞本波 API 合同 |
| C4 Tests/MCP | Codex Spark + 总架构师 | `solid/excel/test/*`, `solid/excel/e2e/worker-workbook.spec.ts` | lazy import、cancel、limit、persistence round-trip、MCP |

### 验收门禁

```sh
cd rust/excel-core && cargo test --lib bulk_load
cd rust/excel-core && cargo test --test cross_sheet
cd rust/wasm && cargo test
cd rust/wasm && cargo build
cd /Volumes/work/self/einfach && npx jest solid/excel/test/wasm-workbook-worker.test.ts
cd solid/excel && npx playwright test e2e/worker-workbook.spec.ts e2e/million-demo.spec.ts
```

本轮实际已跑：

```sh
cd rust/wasm && cargo test --quiet                           # 21 passed
cd /Volumes/work/self/einfach && npx tsc -p solid/excel/tsconfig.json --noEmit
cd /Volumes/work/self/einfach && npx jest solid/excel/test/wasm-workbook-proxy.test.ts solid/excel/test/wasm-workbook-worker.test.ts solid/excel/test/worker-workbook-store.test.ts --runInBand  # 50 passed
cd /Volumes/work/self/einfach && npm run build:wasm -w @einfach/solid-excel
cd /Volumes/work/self/einfach && npm run build -w @einfach/solid-excel
cd solid/excel && npm run e2e -- e2e/worker-workbook.spec.ts --grep "persistence|import"  # 9 passed
```

MCP 验收：

- 在浏览器触发大导入或模拟导入；
- 验证进度、取消、issue 统计；
- 导入后不读公式时 eval counter 保持 0。

本轮 MCP Playwright 已在 `http://localhost:5174/?debug=1` 验证：

- cancel import 后主 workbook 不可见 session 内容；
- 10001 cell chunk 返回 `IMPORT_CHUNK_TOO_LARGE`，并且 session 可 cancel；
- persistence snapshot/restore 不预热公式，读公式前 eval count 为 0，读后得到 `42` 且 eval
  count 变为 1；
- 当前导航后的 console warning/error 为 0。

### 停止条件

- 100k/1M import 期间主线程冻结。
- commit 前 session 内容已经对 workbook 可见。
- persistence round-trip 预热公式 cache。

## 波次 4：性能、观测和 MCP 门禁产品化

状态：**已完成并提交**，提交 `f456dd7 feat(solid-excel): add observability gates`。本波输出：

- Rust/WASM 与 worker/proxy debug counters 已接入；
- 新增 `observability.spec.ts`，覆盖 1M DOM viewport bound 与 worker lazy eval counters；
- MCP 可复现门禁记录已补充到 Wave 4 文档；
- E2E 计数已与真实 `playwright test --list` 对齐：21 spec / 150 tests / 0 skip。

### 目标

把“能跑”变成“可证明没有退化”。

必须解决：

- 统一 debug counters：import stats、formula eval hit/miss、dirty formula count、
  live subscription count、viewport hydration count、worker queue/import memory estimate。
- Playwright + MCP/Chrome DevTools 有固定验证脚本和记录。
- E2E 文档计数和当前真实 spec/test 数同步。
- intentional skip 只有明确原因和 owner，不能新增无解释 skip。

### 并行角色

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| D1 Rust counters | Codex Spark | `rust/excel-core/src/*`, `rust/wasm/src/lib.rs` | 补 counters 暴露和 unit tests |
| D2 Browser perf | Claude Sonnet | `solid/excel/e2e/*`, MCP 验收脚本/说明 | viewport DOM 数、long task、heap、subscription bound |
| D3 Docs gate | Codex Spark | `solid/excel/docs/E2E_TEST_PLAN.md`, `rust/docs/HANDOFF.md` | 更新真实状态、测试矩阵、MCP 流程 |
| D4 Review guard | Codex Spark | 测试文件 | no-only/no-new-skip、console error guard、lazy eval counter tests |

### 验收门禁

```sh
cd rust/excel-core && cargo test --lib
cd rust/excel-core && cargo test --test scale
cd rust/wasm && wasm-pack test --headless --chrome .
cd /Volumes/work/self/einfach && npx jest
cd solid/excel && npm run build:wasm && npx playwright test e2e/million-demo.spec.ts e2e/virtualize.spec.ts e2e/worker-workbook.spec.ts
```

MCP 验收：

- 必须用 MCP 打开本地 dev server；
- 采集 console、DOM cell 数、滚动后 subscription count、关键操作响应；
- 记录 MCP 工具不可用时的错误和 CLI Playwright 兜底结果。

### 停止条件

- 性能测试需要改业务代码才能通过，但没有明确产品原因。
- 指标只做截图观察，没有可重复的脚本或断言。

## 波次 5：文件导入与 Backpressure UI

状态：**已实现并完成本地/MCP 验收**。计划与记录：
`rust/docs/WAVE5_FILE_IMPORT_BACKPRESSURE_PLAN.md`。

### 目标

把已有 worker import session 从 API 合同推进到用户可操作的文件导入链路：

- CSV/TSV 通过 `File.stream()` 增量读取，禁止 `file.text()` 一次性读全量。
- parser/helper 负责 begin/importChunk/commit/cancel 和 backpressure。
- UI 展示进度、统计、错误和取消按钮，但不复制 workbook 数据。
- 导入公式后未读取前 eval counter 保持 0。
- MCP 验证导入、取消、session count、console 和 lazy eval。

### 并行角色

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| E1 流式 parser/helper | Codex Spark | `solid/excel/src/file-import.ts`, `solid/excel/test/file-import.test.ts` | stream parser、chunk flush、abort/cancel、progress 测试 |
| E2 导入 UI | 总架构师 + Codex Spark | `DemoMillion.tsx`, `styles.css`, i18n | 1M worker demo 文件导入控件、进度、取消、统计 |
| E3 E2E/MCP | Codex Spark | `solid/excel/e2e/file-import.spec.ts` | 导入/取消/lazy eval/console 验收 |
| E4 架构复核/文档 | Claude Sonnet + 总架构师 | docs | backpressure/lazy/state 边界复核 |

### 验收门禁

```sh
cd /Volumes/work/self/einfach && npx tsc -p solid/excel/tsconfig.json --noEmit
cd /Volumes/work/self/einfach && npx jest solid/excel/test/file-import.test.ts solid/excel/test/wasm-workbook-proxy.test.ts solid/excel/test/wasm-workbook-worker.test.ts --runInBand
cd /Volumes/work/self/einfach && npm run build -w @einfach/solid-excel
cd /Volumes/work/self/einfach/solid/excel && npm run e2e -- e2e/file-import.spec.ts e2e/observability.spec.ts
```

MCP 验收：

- 打开 `http://localhost:5174/?debug=1`；
- 在 1M worker demo 导入一个包含公式的 CSV/TSV；
- 读公式前 eval count 不增长，读公式后才增长；
- 取消导入后 `debugCounters().importSessionCount = 0`；
- console warning/error 为 0。

### 停止条件

- 实现需要一次性读取整个文件或一次性构造全量 cell 数组。
- UI 为展示结果读取全表。
- cancel 后 import session 泄漏。

### 执行记录

- `file-import.ts` helper 已实现 `File.stream()` + `TextDecoder` 增量解析，支持 CSV/TSV、
  quoted field、abort/cancel、progress 与 worker ack backpressure。
- 1M demo 已接入文件导入 UI、取消、统计和 `?debug=1` worker debug client。
- 可见投影刷新只针对当前订阅窗口，不读取全表。
- E2E 新增 `file-import.spec.ts` 3 条：CSV、TSV、取消后 session 归零。
- `solid/excel/docs/E2E_TEST_PLAN.md` 当前已同步为 23 spec / 162 active Playwright tests /
  0 skip。
- MCP Playwright 返回：`A1=21`、`B1=mcp-label`、`A120` 读前 dirty / 读后 clean、
  eval delta 1、取消后 `importSessionCount=0`、console warning/error 0。

## 波次 6：产品硬化与 Excel 兼容缺口

状态：MultiSheet worker product path、公式诊断、`TEXT/TODAY/NOW` 浏览器门禁均已落地；
虚拟列下 keyboard/accessibility/context-menu/toolbar 的完整发布级扫尾仍留给下一产品化小波或
发布门禁波。

### 目标

把核心 spreadsheet 体验从 demo-grade 补到 MVP product-grade。

本波只做不牵涉协同的能力：

- 公式错误和 parser diagnostics 可用于 UI 展示。
- `TEXT()`、`TODAY()`、`NOW()` 的浏览器/时区行为补齐测试。
- 多 sheet 增删改、active sheet、订阅 cache、跨 sheet 引用在 worker product path 下稳定。
- keyboard/accessibility、context menu、format toolbar 在虚拟列和大表下稳定。
- 文档明确哪些 Excel 函数/导入导出能力属于 MVP 后续，不在本轮强塞。

### 并行角色

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| E1 Formula diagnostics | Claude Sonnet | `rust/excel-core/src/eval.rs`, parser 相关文件, `rust/wasm/src/lib.rs` | 错误码/错误消息/diagnostics 合同 |
| E2 Multi-sheet product path | Codex Spark | `solid/excel/src/wasm-workbook-store.ts`, sheet tabs 相关文件 | worker store 表级增删改和缓存一致性 |
| E3 UX/a11y | Codex Spark | `solid/excel/src/Table.tsx`, `ContextMenu.tsx`, `FormatToolbar.tsx` | 虚拟列下键盘/菜单/工具条稳定 |
| E4 Tests/docs | Codex Spark | e2e/docs | 代表性用户流和兼容矩阵 |

### 验收门禁

```sh
cd rust/excel-core && cargo test --lib
cd rust/wasm && cargo test
cd /Volumes/work/self/einfach && npm run build -w @einfach/solid-excel
cd /Volumes/work/self/einfach && npx jest
cd solid/excel && npx playwright test
```

MCP 验收：

- 多 sheet 新增/重命名/删除/切换；
- 跨 sheet 公式链；
- 错误公式展示；
- 大表下键盘导航、格式工具条、context menu。

### 停止条件

- 为了兼容函数语义破坏 lazy/read-on-demand 合同。
- UI 需要在前端复制 workbook 核心状态。

## 发布门禁波：总验收与交付

详细命令和 blocker 定义见 `rust/docs/RELEASE_GATE_PLAN.md`。

### 目标

确认主线达到“百万 cell、lazy formula、无协同”的 MVP 交付标准。

### 必跑门禁

```sh
cd rust/excel-core && cargo test --lib
cd rust/excel-core && cargo test --test scale
cd rust/excel-core && cargo test --test cross_sheet
cd rust/excel-core && cargo bench --no-run
cd rust/wasm && cargo test
cd rust/wasm && cargo build
cd rust/wasm && wasm-pack test --headless --chrome .
cd /Volumes/work/self/einfach && npx tsc -p solid/excel/tsconfig.json --noEmit
cd /Volumes/work/self/einfach && npm run build -w @einfach/solid-excel
cd /Volumes/work/self/einfach && npx jest
cd solid/excel && npm run build:wasm && npx playwright test
```

注意：当前 repo 没有统一 root Cargo workspace gate；完整 release gate 应优先按
`rust/docs/RELEASE_GATE_PLAN.md` 里的 `--manifest-path` 命令执行。`excel-core` clippy 有历史
baseline，当前作为 advisory，不阻断发布判断。

### 最终验收清单

- 1M coordinate workbook 不 dense 分配。
- 空 cell read/subscribe/reference 不创建 primitive atom。
- 导入 100k+ 公式后 eval counter 仍为 0。
- 只读取 viewport/export 的公式会计算；未读公式保持 dirty/uncomputed。
- 跨 sheet 链 dirty propagation 正确，读取前不 eager compute。
- 大 range clear/format/copy/export 不在主线程展开百万地址。
- 大导入可取消，失败有 issue，commit 前不可见。
- undo 对小操作完整，对大操作有明确 transaction/snapshot 策略。
- worker 是 authoritative product path；主线程 cache 只是投影。
- Playwright CLI 绿；MCP 验证有记录。
- 文档状态与真实测试/功能一致。

## 推荐下一步

当前波次：**发布门禁波：总验收与交付准备**。

原因：

- large range format undo、copy/export streaming、bounded import、sparse persistence v1、
  file import/backpressure UI 都已完成本轮实现和验证。
- Wave 4 已经把规模行为做成可查询 counters 和 e2e/MCP 门禁。
- Wave 5 已经把正式文件流导入/backpressure UI 接到 1M worker demo，并通过 e2e/MCP 验收。
- 错误诊断、多 sheet worker product path、虚拟列下键盘/context menu/toolbar 稳定性已经
  完成；剩余主要缺口转向最终发布门禁、文档一致性和是否允许 CI/PR 的决策。
