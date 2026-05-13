# Phase 5 — Worker 权威 Workbook + 分块导入并行计划

> 日期：2026-05-12
>
> Companion to `ONLINE_SPREADSHEET_PLAN.md` § Phase 5。产品目标不变：
> 在线电子表格；不做多人协同；支持百万级 cell；公式只在 read/export/visible/
> subscribed 路径计算。

## 上一阶段留下的问题

Phase 1–4A 已经把 Rust core 的稀疏/lazy 主线补齐到可继续产品化：

- `Sheet::set_formula` 不再 eager compute，公式结果走 `get_cell` 按需计算。
- `Sheet::bulk_load` 和 `Workbook::bulk_load` 已有 RAII bulk 能力，flush 时做一次
  dirty fanout 和 subscriber 去重。
- `Workbook` 已有 cross-sheet point/range reverse deps、cycle detection、
  lazy cross-sheet eval。
- `Table.tsx` 已经有 native 2D virtualization，`1M Cells` demo 有 e2e 覆盖。
- `Sheet2!A1:A100` 这类 bounded cross-sheet range parser 已在 Phase 4A 收尾。

但产品路径还不是“worker 权威 workbook”：

- `solid/excel/src/wasm-sheet-worker.ts` 仍只持有一个 `WasmSheet`，不是
  `WasmWorkbook`。
- `solid/excel/src/wasm-sheet-proxy.ts` 仍是 fire-and-forget 协议；`set_formula`
  永远乐观返回 `true`，失败/环检测无法权威回传。
- worker proxy 的 `non_empty_addrs()` 来自主线程 cache，只能看到已经读/写/订阅过的
  地址，不能作为 undo/import/persistence 的事实源。
- `WasmWorkbook` 同时暴露旧 mutator 和 canonical mutator。旧的
  `set_number/set_text/set_boolean/set_error/clear_cell` 仍可能绕过
  `Workbook::set_cell/clear_cell`，从而漏掉 cross-sheet dirty fanout。
- 大导入还没有 WASM/worker 友好的 API；不能把 Rust RAII closure 直接暴露给 JS
  当成 Phase 5 的主设计。
- `sheet-store.ts` 的 range delete/copy/undo 仍会构造地址数组并逐格读写，对百万矩形
  不成立。
- `workbook-store.ts` / `wasm-workbook-store.ts` 仍有 demo 级 coarse `notifyAll` 和
  Solid `createSignal` 产品状态；后续新增状态必须收敛到 Einfach atom/store 或明确
  标注为 DOM/lifecycle bridge。

## 架构决策

本阶段采用：

**Worker 持有 `WasmWorkbook` + request/reply RPC + typed chunk import session。**

不采用：

- 直接把 `WorkbookLoader<'_>` / Rust closure 作为 wasm-bindgen JS loader handle 暴露。
- 继续扩展单 sheet `createWorkerSheet` 作为产品主路径。
- 让主线程 cache 成为 undo、non-empty、persistence、formula cache 的事实源。

理由：

- `Workbook::bulk_load` 的 RAII 形状在 Rust 内部是正确的：borrow checker 保证 flush。
  但把 loader handle 暴露到 JS 会引入 `&mut self` borrow、callback 重入、cancel/error
  语义和 lifetime 设计问题，Phase 5 不该把风险放在这里。
- Worker message boundary 天然适合 `begin/chunk/commit/cancel`。JS/worker 只传 typed
  data，Rust commit 时仍能进入现有 `Workbook::bulk_load`，保留 lazy 和 fanout 去重。
- 公式/跨 sheet/undo/persistence 的事实源必须是 worker 内的 Rust workbook；主线程只保留
  visible projection cache 和 UI 交互状态。
- 会失败的操作必须权威 reply。`set_formula`、rename、remove sheet、import chunk parse
  错误、cycle 都不能永久乐观成功。

`codex exec` 已对这个 fork 做只读复核，结论与三个子 agent 一致：先做 worker-owned
`WasmWorkbook` 和 request/reply，再做 typed chunk import；不要先暴露 Rust closure。

## 目标状态

Phase 5 完成后，产品主链路应该满足：

- worker owns `WasmWorkbook`，所有写入只走 workbook-aware canonical API。
- main thread 只保存可见 cell 的投影 cache；cache miss 通过 RPC hydrate。
- RPC 有 `id`，mutations 返回 authoritative `ok/result/error`。
- subscribe/dirty push 不需要为了判断是否通知而提前计算公式；可见/订阅 cell 需要 display
  时再通过 hydration/read path 计算。
- `listNonEmpty/snapshotSparse/exportRange` 来自 worker/Rust。
- 100k CSV/JSON typed import 分块进入 worker，不阻塞主线程滚动/输入。
- import 后公式 cache 保持 dirty；只有 viewport/export/read 才触发 eval counter。
- 大 import/大 range operation 不在主线程构造百万个地址字符串。

## Tracks

| Track | Owner | Scope | Effort | Parallelism |
|---|---|---|---|---|
| **A** | Worker Workbook RPC | `rust/wasm/src/lib.rs`, new `solid/excel/src/wasm-workbook-worker.ts`, new `solid/excel/src/wasm-workbook-proxy.ts`, protocol types | 2–3 d | 先行，其他 Track 依赖它的协议 |
| **B** | Typed Import / Sparse Snapshot | `rust/wasm/src/lib.rs`, `rust/excel-core/src/csv.rs`, worker import commands, optional persistence JSON | 2–3 d | 依赖 A 的 request/reply，可与 C 读代码并行 |
| **C** | Frontend State / Range-Native UI | `solid/excel/src/sheet-store.ts`, `Table.tsx`, workbook demos, worker workbook store | 3–4 d | A 的最小 client 出来后开始 |
| **D** | E2E / Bench / Docs Gatekeeper | `solid/excel/e2e`, `solid/excel/test`, `rust/excel-core/tests`, docs | 2–3 d | 全程并行；先写 red tests，最后解除/更新 |

## 文件冲突矩阵

|  | A | B | C | D |
|---|---|---|---|---|
| **A** | — | 都会 touch `rust/wasm/src/lib.rs`，A 先定 protocol/canonical API，B 追加 import methods | C 只消费 A 新 client，不改 A worker internals | D 可先写 fake-worker tests，最终按 A 协议调整 |
| **B** | 依赖 A reply/error envelope | — | C 只接 store command，不碰 import parser/session internals | D owns import e2e/native tests，B owns implementation |
| **C** | 依赖 A client shape | 依赖 B import command | — | 可能共同 touch e2e helper；D 先写 helper，C 只消费 |
| **D** | 不改 protocol 源文件，除非测试 type 需要 | 不改 import implementation | 不改 product component logic | — |

集成顺序：A protocol skeleton → D red tests → A minimal workbook worker → B import/snapshot →
C store/range UI → D final gate cleanup。

## Sequencing

### Day 0 — Plan 和协议冻结

1. 提交本计划文档。
2. 让 A/D 先行：A 负责协议和最小 worker workbook，D 负责 fake-worker/Jest/e2e red tests。
3. B/C 同步只读确认 import/store 接入点，避免先动同一批文件。

### Day 1 — Worker Workbook 最小闭环

1. 新增 workbook worker/proxy，不删除现有 `createWorkerSheet` demo path。
2. worker 初始化 `WasmWorkbook`，支持 sheet list、read cells、set cell、set formula、
   subscribe/unsubscribe。
3. 所有 mutating RPC 返回 authoritative reply。
4. `set_formula` parse fail / same-sheet cycle / cross-sheet cycle 都能回传失败。

### Day 2 — Import 和 Snapshot

1. 加 typed import session：`beginImport` → `importChunk` → `commitImport` /
   `cancelImport`。
2. WASM commit 使用 Rust `Workbook::bulk_load`，不要暴露 `WorkbookLoader` 到 JS。
3. 加 `listNonEmpty` / `snapshotSparse` / `readRange`，undo/persistence 不再读主线程 cache。

### Day 3+ — Frontend 产品路径

1. 新建 worker-backed workbook store，逐步替代 demo-grade coarse `notifyAll` path。
2. 大 range clear/delete/format/copy/export 改走 range command 或 worker streaming。
3. 新增/迁移状态时遵守 Einfach state-only：产品状态进 atom/store；Solid signal 仅保留
   DOM measurement、component-local draft、lifecycle bridge。

### Final — Gate 和 Handoff

1. 跑 Rust targeted tests、WASM build、Jest、Solid build、Playwright targeted e2e。
2. 更新 `HANDOFF.md`，记录 Phase 5 完成/未完成项。
3. 不 push，不改 `.github/workflows/*`。

## Track A — Worker Workbook RPC

### 目标

把产品主 worker 从 `WasmSheet` 升级为 `WasmWorkbook`，并提供可扩展 RPC。

### 建议协议

```ts
type RpcRequest =
  | { id: number; cmd: 'initWorkbook'; sheets?: string[] }
  | { id: number; cmd: 'sheetList' }
  | { id: number; cmd: 'addSheet'; name: string }
  | { id: number; cmd: 'renameSheet'; sheet: number; name: string }
  | { id: number; cmd: 'removeSheet'; sheet: number }
  | { id: number; cmd: 'setCell'; sheet: number; addr: string; value: CellWire }
  | { id: number; cmd: 'setFormula'; sheet: number; addr: string; formula: string }
  | { id: number; cmd: 'clearCell'; sheet: number; addr: string }
  | { id: number; cmd: 'readCells'; cells: CellRefWire[] }
  | { id: number; cmd: 'subscribeCells'; subId: number; cells: CellRefWire[] }
  | { id: number; cmd: 'unsubscribeCells'; subId: number }
  | { id: number; cmd: 'debugCounters' }

type RpcResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }

type RpcEvent =
  | { event: 'cellsDirty'; cells: CellRefWire[] }
  | { event: 'cellsHydrated'; cells: CellSnapshotWire[] }
```

### 实现要求

- worker 只能调用 workbook-aware canonical API：
  - `set_cell_number`
  - `set_cell_text`
  - `set_cell_boolean`
  - `clearCellAt`
  - `setFormulaAt`
- 同步修正或废弃 `WasmWorkbook` 旧 mutator，避免未来误用
  `sheet_mut(...).set_cell(...)`。
- `setFormula` RPC 必须返回真实 bool 或 error envelope，不能乐观 true。
- `readCells` 是 hydration/read path；读取公式会计算，这是 visible/read 合同允许的。
- dirty event 不应为了判断是否通知而调用 display read。
- 保留现有 `createWorkerSheet` 作为兼容 demo/test path，但新产品 demo 走 workbook worker。

### 验收

```sh
cd rust/wasm && cargo build
cd solid/excel && npm run build
cd /Volumes/work/self/einfach && npx jest solid/excel/test/wasm-workbook-proxy.test.ts
cd solid/excel && npx playwright test e2e/worker-workbook.spec.ts
```

### Stop Conditions

- 如果 `WasmWorkbook` 订阅仍只能通过 JS callback 直接持有 closure，且无法可靠映射到
  worker `postMessage` event，暂停并先改成 worker 内部 listener adapter。
- 如果保持 `ISheet` 同步接口会迫使 worker reply 被忽略，新增 async workbook client，
  不要继续扩大 optimistic sync facade。

## Track B — Typed Import / Sparse Snapshot

### 目标

大导入和持久化边界必须走 worker/Rust sparse path，不走前端逐格循环。

### 建议 API

```ts
type ImportRequest =
  | { id: number; cmd: 'beginImport'; session: number; sheet: number; origin: CoordWire; empty: 'skip' | 'clear' }
  | { id: number; cmd: 'importChunk'; session: number; seq: number; cells: ImportCellWire[] }
  | { id: number; cmd: 'commitImport'; session: number }
  | { id: number; cmd: 'cancelImport'; session: number }

type ImportCellWire =
  | { row: number; col: number; kind: 'number'; value: number }
  | { row: number; col: number; kind: 'text'; value: string }
  | { row: number; col: number; kind: 'boolean'; value: boolean }
  | { row: number; col: number; kind: 'error'; value: string }
  | { row: number; col: number; kind: 'formula'; value: string }
  | { row: number; col: number; kind: 'null' }
```

### 实现要求

- CSV/JSON parsing 在 worker 内分块，主线程只发文件/文本来源和进度显示。
- Rust commit 时进入 `Workbook::bulk_load`，批量公式只注册 AST/deps，不计算 display。
- import stats 返回 accepted、formulas、parseErrors、cycleErrors、cleared、durationMs。
- `WorkbookLoader` 对同一 bulk 内新引入的跨 sheet formula cycle 仍有已知限制；
  commit 端必须补最终校验/回退策略，或把该限制明确暴露成 import error。
- 明确定义 CSV empty field 合同：
  - 默认 `empty: 'skip'`，保持当前 `import_csv` 行为；
  - `empty: 'clear'` 作为显式清空模式，另写测试。
- `listNonEmpty` / `snapshotSparse` 由 worker/Rust 返回，覆盖未被主线程读过的 cell。
- 可选 persistence v1 只保存 sparse workbook：sheet name、dimension、primitive、formula、
  format；不做 dense grid，不做协同日志。

### 验收

```sh
cd rust/excel-core && cargo test --lib bulk_load
cd rust/excel-core && cargo test --lib csv
cd rust/excel-core && cargo test --test cross_sheet
cd rust/wasm && cargo build
cd solid/excel && npx playwright test e2e/import-worker.spec.ts
```

### Stop Conditions

- 如果 100k import 需要在 main thread 构造 100k+ cell display snapshot，暂停。
- 如果 import commit 后 `debug_formula_eval_count` 增长，暂停。
- 如果 cancel 之后已有 chunk 对 workbook 可见，暂停。
- 如果同一 import session 内新公式互相形成 cross-sheet cycle 却能静默提交为正常公式，
  暂停并先补 commit-final validation。

## Track C — Frontend State / Range-Native UI

### 目标

让 UI 只做投影和交互，不持有产品事实源；大 range 操作不展开百万地址。

### 实现要求

- 新增 worker-backed workbook store，优先用于 product/demo path。
- 新增产品状态时使用 Einfach atom/store；允许 Solid signal 的范围：
  - DOM measurement：scrollTop、scrollLeft、viewport size；
  - component-local edit draft；
  - lifecycle bridge / cleanup handle。
- `selection`、active sheet、workbook metadata 后续迁移到 Einfach state；本阶段至少不再新增
  Solid signal 承载产品事实。
- `SheetStore` 保持 UI facade：observe visible cells、提交 user command、消费 worker event。
- import/large range undo 不复用当前逐格 snapshot；改用 worker sparse snapshot 或 coarse
  transaction。
- 大矩形 clear/delete/format/copy/export：
  - clear/delete/format 发 range command；
  - copy/export 走 worker streaming 或 chunked read；
  - 小 range 可以保留现有路径，但要有阈值和测试。
- 收紧 `raw` 暴露：产品路径不能绕过 worker/Rust 和 undo；测试 hook 单独命名。

### 验收

```sh
cd /Volumes/work/self/einfach && npx jest solid/excel/test/sheet-store.test.ts
cd /Volumes/work/self/einfach && npx jest solid/excel/test/workbook-store.test.ts
cd solid/excel && npx playwright test e2e/range-ops.spec.ts e2e/million-demo.spec.ts
cd solid/excel && npx playwright test e2e/workbook-chain.spec.ts
```

### Stop Conditions

- 如果 range clear/delete 仍必须先生成全部地址字符串，暂停并补后端 range API。
- 如果 undo 需要读取 proxy cache 的 `non_empty_addrs()`，暂停。
- 如果 worker reply 失败后 UI 无法回滚 optimistic cache，暂停并收窄 optimistic 范围。

## Track D — E2E / Bench / Docs Gatekeeper

### 目标

把已有功能和 Phase 5 新能力钉成测试合同。

### 当前测试基线

本地现状有 19 个 Playwright spec 文件；`million-demo.spec.ts` 的历史 focus-pin
skip 已改成 native 2D 虚拟化下的 selection scroll-into-view 断言。不要新增无
解释 skip；如果确实需要跳过，必须写 owner、原因和恢复条件。

### 新增测试清单

- worker workbook authority：
  - `setFormula` parse fail / cycle 返回失败；
  - worker 不再永久 optimistic true；
  - 写 `Sheet3` 源 cell 后，`Sheet1` cross-sheet dependent 可被 dirty/hydrate。
- lazy non-read：
  - import 公式后 eval counter 为 0；
  - staying on Sheet1 时 Sheet2 offscreen formula 不计算；
  - 切到 Sheet2 或 export/read 时才计算。
- import：
  - begin/chunk/commit 顺序；
  - cancel 后无可见写入；
  - chunk parse errors 回传行列；
  - 100k CSV/JSON import 不阻塞 UI；
  - import 是一个 undo entry。
- sparse snapshot：
  - 未被主线程读过的非空 cell 也出现在 worker snapshot；
  - persistence round-trip 不预热 formula cache。
- range-native：
  - 百万矩形 clear/format 不在主线程生成百万地址；
  - viewport 内订阅收到正确 dirty/hydrate；
  - subscription count 不随滚动历史增长。

### 验收命令

```sh
cd rust/excel-core && cargo test --lib
cd rust/excel-core && cargo test --test cross_sheet
cd rust/excel-core && cargo bench --no-run
cd rust/wasm && cargo build
cd /Volumes/work/self/einfach && npm run build -w @einfach/solid-excel
cd /Volumes/work/self/einfach && npx jest
cd solid/excel && npx playwright test e2e/worker.spec.ts e2e/workbook-chain.spec.ts e2e/million-demo.spec.ts
```

不要改 `.github/workflows/*`。CI blocking 化留到用户明确放开 CI 规则后再做。

## 多 Agent Pipeline

### Pipeline 1 — Protocol Freeze

- Agent A：写 protocol types、worker workbook skeleton、fake worker tests。
- Agent D：写 red tests，特别是 `setFormula` 权威失败和 worker-owned non-empty。
- 主线集成：只合协议和 red tests，不做 import。

### Pipeline 2 — Runtime Authority

- Agent A：worker owns `WasmWorkbook`，RPC request/reply，canonical mutator。
- Agent C：最小 worker-backed workbook store，只消费 A 的 client。
- Agent D：跑 worker/workbook targeted e2e。

### Pipeline 3 — Import/Snapshot

- Agent B：typed import session、`listNonEmpty`、`snapshotSparse`。
- Agent D：import cancel/commit/lazy eval tests。
- Agent C：import UI command 只接进度和结果，不做逐格前端写入。

### Pipeline 4 — Range-Native Productization

- Agent C：clear/delete/format/copy/export 的 range command plumbing。
- Agent B：必要的 backend range/snapshot API。
- Agent D：million/range e2e 和 perf smoke。

## 非目标

- 不做多人协同、CRDT、presence、shared cursor。
- 不做 dense workbook persistence。
- 不做完整 xlsx import/export。
- 不把所有 Solid signal 一次性重写；只要求新增产品状态不继续扩大 Solid-local state。
- 不改 `.github/workflows/*`。
- 不 push。
- 不 amend。
- 不修 pre-existing clippy baseline，除非 Phase 5 改动直接引入新的 clippy 问题。

## 全局停止条件

出现以下任一情况，暂停并重新规划：

- worker/product path 仍绕过 `Workbook::set_cell/set_formula/clear_cell`。
- 导入或 `set_formula` 在没有 read/export/visible/subscribed 的情况下触发公式 eval。
- main thread cache 被用于 authoritative undo/import/persistence。
- 大 range 操作在主线程分配与 cell 数量同阶的地址字符串。
- 100k import 期间 UI 滚动/输入明显卡死。
- request/reply 乱序导致旧 hydration 覆盖新 mutation 且没有 version/seq 保护。
