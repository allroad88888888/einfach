# 在线电子表格剩余执行波次规划

> 日期：2026-05-13
>
> 当前角色：总架构师。
>
> 产品目标：在线电子表格；不做多人协同；支持百万级 cell；公式只在视口读取、
> 显式读取、导出或订阅路径计算。空 cell 不物化，前端不复制核心状态。

## 当前 HEAD 事实

以最近提交 `157c9b5 perf(solid-excel): stream million demo seed chunks` 为准，
项目已经不是旧 `PHASE5_PARALLEL.md` 里的起点状态。

已落地的主能力：

- Rust `excel-core` 已经是 lazy formula 主线：公式保存 AST/依赖/cache，`set_formula`
  不 eager compute。
- `WorkbookEvalProvider` 已承担跨 sheet lazy eval；旧 TLS resolver 只剩历史文档噪音。
- workbook 级跨 sheet point/range dirty graph、range dependency index、sparse value index、
  bounded cross-sheet range parser 已落地。
- `WasmWorkbook` 已有 canonical workbook mutator、`bulk_import_cells`、
  `list_non_empty_cells`、`snapshot_sparse`、`read_sparse_range`、`clear_range`、
  debug formula eval/cache 探针。
- `solid/excel` 已有 worker-owned workbook RPC、request id、统一 ok/error envelope、
  begin/importChunk/commit/cancel import session、sparse snapshot、range clear。
- `DemoMillion` 已走 worker-backed workbook + 2D virtualized table；seed 生成已经按 chunk
  flush，不再在主线程一次性构造完整 seed 数组。
- 大 selection copy / large clear 已有主线程保护：超阈值时拒绝或走 backend range command，
  不再盲目展开百万地址。

仍未达到产品目标的地方：

- worker adapter 的 `set_formula` 仍在 `ISheet` 同步接口下返回 optimistic `true`；
  worker 失败只能事后 hydrate，不能成为用户命令的权威结果。
- 大 range clear 已 range-native，但 undo 语义是清空 undo/redo 栈；还没有后端 sparse
  range snapshot + restore/coarse transaction。
- format/copy/export 仍主要是小范围主线程路径；大范围是拒绝，不是产品化 streaming。
- worker import session 仍把 chunk 累积在 worker 内存，commit 时一次性进 Rust；
  还不是严格 bounded streaming/backpressure 模型。
- `formulaCacheState` 在 worker workbook store 仍返回 `'unknown'`，诊断能力没有接到
  产品 path。
- 稀疏持久化、导出、自动保存尚未形成 v1 合同。
- 测试覆盖已经很多，但 E2E 文档计数滞后；MCP Playwright/Chrome DevTools 还没有成为
  每波固定验收记录。

## 总体判断

还剩 **5 波实现 + 1 个发布门禁波**。

前 5 波都可以多 agent 并行推进，但每波必须先冻结接口、分清文件所有权，最后由总架构师
集成验收。子 agent 的“已完成”只表示候选补丁完成，不表示可合入主线。

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

## 波次 1：权威 worker 命令合同

### 目标

把 worker-backed workbook store 从“乐观投影”推进到“用户命令有权威结果”。

必须解决：

- `set_formula` 不能继续同步返回永久 `true`。
- parse fail、same-sheet cycle、cross-sheet cycle、invalid sheet 必须能回到 UI/store 命令层。
- worker hydration 不能用旧响应覆盖新 mutation。
- `formulaCacheState` 要能在 worker store 读到真实 worker/Rust 状态，至少用于 debug/demo/e2e。

### 并行角色

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| A1 Worker 协议 | Claude Sonnet | `solid/excel/src/wasm-workbook-proxy.ts`, `solid/excel/src/wasm-workbook-worker.ts` | 收紧 ok/error/code 语义；补 mutation version/seq 风险点 |
| A2 Store 合同 | Codex Spark | `solid/excel/src/wasm-workbook-store.ts`, 必要时 `solid/excel/src/types.ts` | 设计 fallible mutation 接口；保留兼容层但不让产品 path 误判成功 |
| A3 测试 | Codex Spark | `solid/excel/test/*`, `solid/excel/e2e/worker-workbook.spec.ts` | 先写非法公式/循环/乱序 hydrate 红测，再配合实现转绿 |
| A4 文档 | Codex Spark | `rust/docs/HANDOFF.md`, `solid/excel/docs/E2E_TEST_PLAN.md` | 同步 worker authority 当前状态 |

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

- 如果 `ISheet` 同步接口无法表达 fallible async mutation，不继续硬塞；新增 async command
  facade 或 product-only workbook command 层。
- 如果 rollback 会导致可见 cell 闪烁或旧 hydrate 覆盖新 mutation，先设计 version/seq。

## 波次 2：Range-native undo / format / copy / export

### 目标

把“大矩形操作”从“拒绝或不可 undo”推进到“后端稀疏/范围命令可产品化”。

必须解决：

- 大 range clear 需要可预测 undo 语义：后端 sparse range snapshot + restore，或明确的
  coarse transaction。
- format selection 需要 backend range metadata 或 chunked backend command；不能为了格式化
  百万格在主线程构造地址。
- copy/export 要走 worker streaming/chunked read；小范围仍可用现有 clipboard path。
- undo snapshot 来源必须是 Rust/worker sparse iterator，不是主线程 projection cache。

### 并行角色

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| B1 Rust/WASM snapshot | Claude Sonnet | `rust/excel-core/src/workbook.rs`, `rust/wasm/src/lib.rs` | 补 range no-eval sparse snapshot、restore sparse、必要的 range format API |
| B2 Worker protocol | Codex Spark | `solid/excel/src/wasm-workbook-proxy.ts`, `solid/excel/src/wasm-workbook-worker.ts` | 暴露 snapshotRangeSparse/restoreSparse/exportRange chunks |
| B3 SheetStore range UX | Codex Spark | `solid/excel/src/sheet-store.ts`, `solid/excel/src/Table.tsx` | 接入大 range undo/format/copy/export；维持小范围路径 |
| B4 E2E/Perf | Codex Spark | `solid/excel/e2e/range-ops.spec.ts`, `solid/excel/e2e/million-demo.spec.ts` | 钉住不展开百万地址、不清空旧 undo 栈、导出只读可控范围 |

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
- snapshotRange 读取公式结果导致 eval counter 增长。

## 波次 3：真正 bounded 的导入与稀疏持久化 v1

### 目标

把“worker chunk API”推进到“内存有上界、可取消、可持久化、保持 lazy”的产品导入/保存链路。

必须解决：

- worker import session 不能无限累积所有 chunk。
- CSV/JSON 解析和 backpressure 策略要明确。
- commit 必须走 Rust `Workbook::bulk_load`；导入公式后 `debug_formula_eval_count == 0`。
- sparse persistence v1 保存 sheet name、dimension、primitive、formula、format；不保存 dense grid。
- cancel 后 workbook 不可见任何 session 内容。

### 并行角色

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| C1 Import runtime | Claude Sonnet | `solid/excel/src/wasm-workbook-worker.ts`, `rust/wasm/src/lib.rs` | bounded session、chunk flush、cancel/commit 错误语义 |
| C2 Persistence schema | Codex Spark | `rust/wasm/src/lib.rs`, 新增 docs/test fixture | sparse persistence v1 schema + round-trip |
| C3 Demo/import UI | Codex Spark | `solid/excel/src/demos/DemoMillion.tsx`, 可能新增 import helper | 大导入进度、取消、issue 展示入口 |
| C4 Tests | Codex Spark | `solid/excel/test/wasm-workbook-worker.test.ts`, `solid/excel/e2e/worker-workbook.spec.ts` | 100k import lazy、cancel、issues、round-trip |

### 验收门禁

```sh
cd rust/excel-core && cargo test --lib bulk_load
cd rust/excel-core && cargo test --test cross_sheet
cd rust/wasm && cargo test
cd rust/wasm && cargo build
cd /Volumes/work/self/einfach && npx jest solid/excel/test/wasm-workbook-worker.test.ts
cd solid/excel && npx playwright test e2e/worker-workbook.spec.ts e2e/million-demo.spec.ts
```

MCP 验收：

- 在浏览器触发大导入或模拟导入；
- 验证进度、取消、issue 统计；
- 导入后不读公式时 eval counter 保持 0。

### 停止条件

- 100k/1M import 期间主线程冻结。
- commit 前 session 内容已经对 workbook 可见。
- persistence round-trip 预热公式 cache。

## 波次 4：性能、观测和 MCP 门禁产品化

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

## 波次 5：产品硬化与 Excel 兼容缺口

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
cd /Volumes/work/self/einfach && npm run build -w @einfach/solid-excel
cd /Volumes/work/self/einfach && npx jest
cd solid/excel && npm run build:wasm && npx playwright test
```

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

下一步先执行 **波次 1：权威 worker 命令合同**。

原因：

- 它是后续 range undo、导入错误、持久化恢复、UI 回滚的共同前置。
- 当前代码已有 worker RPC skeleton，修合同的收益最大、冲突面可控。
- 如果不先解决 `set_formula` optimistic true，后续所有产品命令都会继续绕过真实错误语义。

