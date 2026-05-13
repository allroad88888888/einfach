# 在线电子表格规模化计划

> 日期：2026-05-13
>
> 产品目标：做一个在线电子表格；不做多人协同编辑；支持百万级 cell
> 工作簿；未被读取、导出或视口订阅到的公式不计算。

## 总目标

系统要像电子表格一样工作，但默认保持稀疏：

- 工作簿可以暴露 1,000,000+ cell 的坐标空间，但不能分配一个
  1,000,000 元素的密集网格。
- 空 cell 没有持久状态成本。只有用户写入值、写入公式、设置格式、
  订阅视口或导入内容时，cell 才能被物化。
- 公式导入阶段只保存 AST 和依赖元数据。公式结果只在可见/订阅 cell、
  导出路径或显式重算读取它时计算。
- 前端视口是订阅边界。滚动应该移动订阅窗口，而不是累计历史订阅。
- Rust/WASM 是工作簿引擎的唯一事实源。Solid 只负责 UI 投影和交互状态，
  不能复制公式缓存、依赖图或产品数据。
- 大导入和重公式计算在产品化前必须走 worker-backed sheet/workbook，
  避免阻塞主线程。

## 当前状态

以 `a082c27 feat(solid-excel): range-native large format` 为当前实现基线。

已经完成：

- 公式不再是 eager core derived atom。`Sheet::set_formula` 在 Sheet 层保存
  `FormulaRecord` 和 `FormulaCache`，公式结果通过 `get_cell` 按需计算。
- `EvalProvider`、`SheetEvalProvider`、`WorkbookEvalProvider` 已落地。
  跨 sheet 读取不再依赖旧 TLS resolver。
- `bulk_load`、worker import session、chunked demo seed、CSV 导入路径已存在；导入公式
  可以保持 cache dirty/uncomputed。
- Range 求值和 sparse value index 已落地。大 range 遍历不会为了空 cell 创建 atom，小 range
  读取不再扫描整张 sheet 的非空集合。
- Range 依赖不会再被 sparse eval 收窄丢失；`range_dependents` 已有 bucket / wide-range
  fallback，`SUM(A1:A100000)` 这类公式能在空 cell 后写入时 dirty。
- Workbook-level `CrossSheetDeps` 已落地，跨 sheet point/range dirty propagation、lazy
  recursion、cycle check 已进入 Rust/WASM/browser 覆盖。
- `DemoMillion` 已走 worker-backed workbook + 二维虚拟化；viewport 未测量时也使用有界初始窗口。
- Cell 订阅已经改成 `observeCell(addr)` retain/release；虚拟滚动卸载 Cell 时会释放订阅。
  Worker proxy/store 有显式 `dispose()`。
- 大 selection clear / copy / format 已有 range-native 或 backend-assisted 路径：
  large clear 可用 sparse snapshot/restore 做 undo；copy 可走 backend TSV export；
  format 可走 `set_format_range`，不再展开百万地址。
- worker-backed store 已有 `setFormulaAsync` 权威公式提交路径和 `formulaCacheState`
  async probe；同步 `set_formula` 仍保留为 legacy compatibility。

仍不足以支撑产品目标：

- 大 range format 没有 format-range snapshot/restore 合同。当前能 range-native 应用格式，
  但会清空 undo/redo 栈，不能回滚。
- copy/export 现在避免了主线程地址展开，但仍一次性生成整段 TSV 字符串；需要
  streaming/chunked export 和 backpressure。
- worker import 已按 chunk 进入 worker 内 staging workbook，但 bounded memory、cancel/commit
  可观测指标、持久化 v1 和 save/load 合同还没产品化。
- 同步 `ISheet.set_formula` 仍然 optimistic `true`。产品入口必须继续收敛到 async command；
  文档和测试要避免后续 agent 误用同步兼容层。
- Solid 的 in-process workbook adapter / demo adapter 仍有 coarse notify 路径。产品大表路径
  应使用 worker-backed workbook；in-process path 只可作为 demo/test 或需要另补精确订阅。
- 稀疏持久化、自动保存、导入导出格式合同尚未形成 v1。
- E2E 文档和 handoff 有状态滞后。后续必须让 `ONLINE_SPREADSHEET_EXECUTION_WAVES.md`
  成为真实执行状态源，避免 agent 继续执行已完成 gap。
- CI 还不是完整规模化门禁：JS build/Jest 和 Playwright 已有，但 Rust unit/clippy、
  wasm browser test、百万 lazy correctness、MCP 验证记录需要变成 blocking 或明确的
  release gate。

## 架构目标

### 1. 稀疏引擎

Rust `excel-core` 拥有工作簿状态：

- Primitive cell atom：只为已写入的 primitive cell 创建。
- Formula record：保存 AST、公式文本、cache state、依赖。
- Format 和 conditional rule：用稀疏 metadata map，不做密集 cell 对象。
- Dependency graph：以 address / range / sheet reference 表达，不以 AtomId 表达。
- Undo/import snapshot：只记录非空地址。

硬规则：读取、订阅或引用空 cell 都不能创建 primitive atom。

### 2. Lazy 公式模型

公式生命周期：

1. Parse 公式并保存 AST。
2. 注册依赖元数据。
3. 标记 cache dirty/uncomputed。
4. 导入或 `set_formula` 时不计算。
5. 只有 read path 需要值时才计算。
6. 上游写入前，clean cache 可复用。

公式 subscriber 契约保持 dirty-notify，而不是 value-change notify。否则为了判断是否
通知就必须先计算公式，会直接破坏 lazy 收益。

### 3. 视口是运行边界

Solid 只渲染和订阅可见 cell 加 overscan：

- 行列二维虚拟化。
- viewport size 未知时也不能全量渲染。
- `observeCell` 必须 ref-count。
- 滚动历史不能让订阅数累积增长。
- FormulaBar 和 selection 最多观察一个或少量 cell，不能观察整块 range。
- Copy/export 可以显式读取 range，但这是用户命令，不是被动视口工作。

### 4. Worker 优先

产品路径应该默认使用 worker-backed sheet/workbook：

- 主线程保留 optimistic cache 和 UI state。
- Worker 拥有 WASM sheet/workbook 和公式计算。
- 导入 parsing/loading 要可分块、可取消。
- Subscribe/unsubscribe、dirty push、initial hydration 都保持 address-based。
- 会失败的 mutation，例如 `set_formula`，需要权威 reply，不能永久乐观 true。
- Range/list/snapshot 查询需要 worker RPC；主线程 cache 不能作为 undo/import 的事实源。
- Worker 生命周期必须显式且有测试。

### 5. Blocking 质量门禁

百万 cell / lazy 契约的正确性门禁必须 blocking：

- Rust `core`、`excel-core`、WASM-facing 行为的 unit test。
- Rust crate 运行 `cargo clippy -- -D warnings`。
- `wasm-pack test --headless --chrome rust/wasm` 覆盖浏览器 callback 和 lazy workbook。
- Solid 的 Jest 和 TypeScript 检查。
- Playwright e2e 覆盖 spreadsheet workflow 和 viewport/lazy 集成。
- 规模敏感路径的 benchmark smoke。完整 criterion 报告可以 advisory，但 100k/1M
  正确性不能 advisory。

## 执行阶段

阶段状态修订：

- Phase 1～4 的核心能力已经在当前 HEAD 落地：lazy core、range dep/index、workbook dirty graph、
  2D viewport、worker-backed 1M demo 都不是后续待办。
- Phase 5 已部分落地：worker workbook RPC、chunk import staging、large clear undo、large copy
  export、large format range-native 都在主线。剩余重点是 format undo、streaming export、
  bounded import/persistence、权威命令收口。
- Phase 6 仍是产品硬化和发布门禁阶段。

### Phase 0：统一状态和门禁

目标：继续实现前先消除状态歧义。

交付：

- 更新 ROADMAP / ISSUES / LAZY，使当前 HEAD 有唯一状态表。
- 同步 E2E 文档中的 spec/test 数量和 workflow 状态。树里已经存在的内容，文档不能继续写
  “13 specs / 98 tests” 或 “没有 workflow”。
- `MAIN_FLOW` 这类描述旧 eager `set_formula -> create_derived` 路径的文档，要标记为历史文档
  或改成当前架构。
- 在 CI 文档里加入规模门禁：Rust unit、wasm test、Jest、e2e、TypeScript、grep gate、
  benchmark smoke。
- `.skip` / `.only` 保持 0。

验收：

- `rg "7B|7C|TLS|bulk_load|range streaming"` 不再命中过期“未做”描述，除非明确标注为历史记录。
- `NO_PROXY=localhost,127.0.0.1 npm run e2e -w @einfach/solid-excel` 绿。
- Rust unit/clippy/wasm browser test 在 CI 中有门禁位置；耗时 bench 可以先 staged/advisory。

### Phase 1：核心规模化契约

目标：让引擎契约足够支撑百万 cell。

交付：

- 将依赖追踪拆成显式 `cells`、`ranges`、`sheet_cells`、`sheet_ranges`。
  动态 eval 可以收窄分支依赖，但不能把 range 依赖收缩成 sparse 读取时访问到的已物化 cell。
- 补完整 debug counters：formula eval miss/hit、dirty count、imported formula count、
  range dependency count、live subscription count。
- 增加 Rust native tests：
  - 100k formula import 后 formula eval 为 0。
  - 读取 100 个 viewport formula 只计算可达公式。
  - 读取/订阅/引用空 cell 不创建 atom。
  - `SUM(A1:A100000)` 在 `A50000` 为空时读一次；之后写 `A50000`，公式必须 dirty，
    下一次读必须包含新值。
  - formula dirty notify 不触发 eager compute。
  - 写 Null 在安全时释放 primitive atom。
- 增加 100k formula import 和 1M-coordinate sparse sheet 的 benchmark smoke。

验收：

- 导入公式后 `formula_eval_count == 0`。
- 空 viewport subscription 不增长 primitive atom 数。
- Cached formula read 是 O(visible/reachable)，不是 O(sheet size)。

### Phase 2：Range 依赖索引

目标：大量 range 公式存在时，dirty lookup 仍然可扩展。

交付：

- 用 interval index 替换 range dependency 展开：
  - row range：按 row bucket 挂 col interval；
  - column range：按 col bucket 挂 row interval；
  - rectangle range：按较短维度索引；
  - whole row/column 使用特殊 bucket。
- 增加 sparse value index，使小 range 读取不扫描整张 sheet 的非空 cell。
- Parser 支持整列/整行语法，例如 `A:A`。
- 增加 100k range formula 的 dirty lookup benchmark。

验收：

- 100k registered range formula 下，单 cell 写入不会线性扫描全部 range formula。
- 1M 非空 cell 的 sheet 中读取小 range，不扫描整张 sheet。
- `SUM(A1:A1048576)` 和 `SUM(A:A)` 不物化空 cell。

### Phase 3：Workbook-wide 依赖图

目标：跨 sheet 公式成为一等 dirty graph，而不只是 read path 能力。

交付：

- Workbook-level reverse dependency index，覆盖 sheet-cell 和 sheet-range reference。
- 从写入源向跨 sheet 下游公式传播 dirty。
- Cross-sheet cycle detection 和 runtime cycle fallback 使用同一图模型。
- Worker/WASM API 暴露 workbook bulk load 和 subscribe path。

验收：

- 写 Sheet3 会 dirty Sheet2 公式和 Sheet1 公式，但在读取前不计算。
- Cross-sheet chain e2e 能证明 cache 在 visible sheet 读取前保持 dirty。
- Cross-sheet cycle 返回 `#CYCLE!`，不栈溢出。

### Phase 4：前端百万 cell 视口

目标：UI 成本随 viewport size 增长，而不是随 sheet size 增长。

交付：

- 二维虚拟化：行和列都虚拟化。
- Large-grid 模式移除 “measurement 前全量渲染” fallback。viewport 未测量时先渲染有界初始窗口。
- 稳定的 cell measurement 和 scroll anchoring。
- 可见 cell 订阅窗口受 `activeSubscriptionCount` 约束。
- Worker-backed large-grid demo，至少 1M addressable cells。
- FormulaBar、selection、copy/paste、formatting、context menu 在虚拟列下仍可用。

验收：

- DOM cell 数稳定在 viewport rows * viewport cols + overscan 附近。
- 滚动几千行/列后，live subscription count 不随历史增长。
- 导入和公式重算期间，主线程仍能响应输入和滚动。
- `10000 x 100` 和 `1000 x 1000` 两种形状都通过 viewport 测试；前者测深滚动，
  后者测宽表布局。

### Phase 5：导入、持久化、Undo 边界

目标：大数据进出系统时仍不破坏 lazy。

交付：

- Chunked CSV/JSON import 进入 worker-backed `bulk_load`。
- 可选 sparse workbook persistence 格式：primitive、formula、format、sheet name、dimension。
- 大导入和结构编辑的 undo/redo 策略：
  - 小编辑 snapshot values；
  - 大导入变成 coarse transaction；
  - 过密结构编辑可以有明确产品限制。
- Range-native UI operations：
  - clear/delete selected range 不构造所有地址字符串；
  - format selected range 使用 sparse/range metadata 或 chunked backend command；
  - copy/export 走 streaming；
  - undo snapshot 来自 backend sparse iterator，不来自 dense JS arrays。

验收：

- 100k 行 CSV import 不冻结 UI。
- 导入公式后 formula cache 保持 dirty，直到 viewport/export 读取。
- 大导入 undo 有可预测内存上界。
- 清空/格式化百万 cell 矩形，不在主线程分配百万个 JS 地址字符串。

### Phase 6：产品硬化

目标：从 demo-grade spreadsheet 走向 product-grade spreadsheet。

交付：

- Rust unit/clippy、wasm-pack browser tests、Jest/TypeScript、Playwright e2e 全部变成
  blocking CI。
- Formula error model 和 parser diagnostics 能支撑 UI 展示。
- 补齐当前 deferred 的 Excel 兼容函数语义。
- 虚拟化 grid 的 accessibility 和 keyboard 覆盖。
- Native、WASM、worker、browser e2e 的性能 dashboard。

验收：

- ISSUES 中没有已知 correctness-critical gap。
- 规模门禁在 CI 或明确的 pre-release job 中运行。
- Browser e2e 覆盖代表性用户流程，而不是每个内部方法。

## Agent 分工

按所有权拆 agent，不按模糊的“前端/后端”拆。

### Agent A：Core Lazy Engine

负责：

- `rust/excel-core/src/sheet.rs`
- `rust/excel-core/src/eval.rs`
- `rust/excel-core/src/workbook.rs`
- `rust/excel-core/benches/sheet_bench.rs`

主要任务：

- debug counters；
- 修 range dependency shape；
- range dependency interval index；
- workbook-wide reverse dependency graph；
- sparse import/recalc tests。

不要碰：

- Solid UI 组件，除非是 WASM API 集成必需。

### Agent B：WASM 和 Worker Runtime

负责：

- `rust/wasm/src/lib.rs`
- `rust/wasm/tests/web.rs`
- `solid/excel/src/wasm-sheet-proxy.ts`
- `solid/excel/src/wasm-sheet-worker.ts`

主要任务：

- workbook worker API；
- bulk load commands；
- async/chunked import；
- fallible operation 的权威 request/reply protocol；
- worker-owned non-empty/range snapshot APIs；
- subscribe/dirty push protocol；
- worker lifecycle tests。

不要碰：

- grid layout 或视觉行为，除非是集成点。

### Agent C：Viewport 和 UI Interaction

负责：

- `solid/excel/src/Table.tsx`
- `solid/excel/src/Cell.tsx`
- `solid/excel/src/FormulaBar.tsx`
- `solid/excel/src/sheet-store.ts`
- 相关 e2e specs。

主要任务：

- column virtualization；
- measurement 前的有界初始渲染；
- bounded subscription window；
- range-native selection command plumbing；
- virtualization 下的 selection/copy/format 行为；
- large-grid demo。

不要碰：

- Rust 公式语义。

### Agent D：测试和 Benchmark Gatekeeper

负责：

- `rust/excel-core/tests`
- `rust/wasm/tests`
- `solid/excel/e2e`
- benchmark docs 和 CI scripts。

主要任务：

- scale acceptance tests；
- benchmark smoke jobs；
- Rust、wasm、Jest、TypeScript、Playwright 的 blocking CI；
- Playwright helper cleanup；
- no-skip/no-only grep gates。

不要碰：

- 生产行为，除非是最小 debug/test probe。

### Agent E：Docs 和 Product Contract

负责：

- `rust/docs/ROADMAP.md`
- `rust/docs/ISSUES.md`
- `rust/docs/LAZY_FORMULA_EVAL.md`
- `solid/excel/docs/E2E_TEST_PLAN.md`
- 本文档。

主要任务：

- 保持状态当前；
- 明确标记历史说明；
- 同步 E2E spec/test 数量和 workflow 状态；
- 把工程门禁翻译成产品验收标准。

不要碰：

- 实现文件。

## 建议并行批次

当前不再按旧 Batch 1～3 执行；那些内容大多已经进入主线。后续按下面 4 波推进，
细节以 `rust/docs/ONLINE_SPREADSHEET_EXECUTION_WAVES.md` 为准。

Wave 1：权威 worker 命令收口 + 文档同步。

- Claude Sonnet：复核 worker protocol、request/version、hydrate 乱序风险。
- Codex Spark：清点产品入口是否仍误用同步 `set_formula`，能改则迁到 async command。
- Codex Spark 或便宜 Codex：补非法公式/循环/乱序 hydrate/cache probe 测试。
- Docs agent：同步 HANDOFF、E2E 文档和本计划。

Wave 2：range-native undo / streaming export。

- Claude Sonnet：设计 range format layer snapshot/restore 或 transaction。
- Codex Spark：worker chunked export protocol。
- Codex Spark：SheetStore large format undo、copy/export streaming 接线。
- E2E agent：MCP + Playwright 验证 1M demo 不展开百万地址、不清空 undo 栈。

Wave 3：bounded import + sparse persistence v1。

- Claude Sonnet：worker import bounded memory、backpressure、cancel/commit 语义。
- Codex Spark：sparse persistence schema 和 Rust/WASM round-trip。
- Codex Spark：Demo/import UI 的进度、取消、issue 展示。
- Test agent：100k import lazy、cancel、round-trip。

Wave 4：性能、观测和 MCP 门禁产品化。

- Codex Spark：debug counters 和 unit tests。
- Claude Sonnet：browser perf/MCP 验收脚本。
- Docs/Test agent：E2E 计数、no-only/no-new-skip、console guard、lazy eval counter gates。

发布门禁波：

- 总架构师串行跑 Rust/WASM/Jest/build/Playwright/MCP，确认百万 cell、lazy formula、
  no-collaboration MVP 交付清单。

## 非目标

- 不做协同编辑、CRDT、presence、conflict resolution、shared cursor protocol。
- 不为完整坐标空间做 dense in-memory grid。
- 不在导入阶段计算公式来预热 cache。
- 不在前端复制公式 cache。

## 停止条件

如果出现以下任一情况，应暂停并重新设计：

- viewport read/subscription 为 viewport 外空 cell 创建 atom。
- 导入公式在任何 read 之前增加 formula eval counter。
- 滚动导致 subscription count 随历史增长。
- 单 cell 写入 dirty 成本与工作簿全部公式数量成正比。
- worker import/recalc 阻塞主线程输入或滚动。
