# Wave 4：性能、观测和 MCP 门禁产品化

> 日期：2026-05-13
>
> 角色：总架构师。
>
> 前置状态：Wave 1 worker 命令收口、Wave 2 range-native undo/format/copy/export、
> Wave 3 bounded import + sparse persistence v1 均已提交。

## 目标

把当前“功能能跑”推进到“规模行为可重复证明”：

- 统一 debug / observability 合同，能证明公式未读不计算、订阅数量不随滚动历史增长、worker
  import/export session 不泄漏。
- E2E 文档的 spec/test/skip 数与真实仓库一致。
- Playwright CLI + MCP Playwright 成为每波固定验收记录，而不是口头说明。
- 所有新增测试必须继续保护核心状态边界：Rust/WASM workbook 是事实源；Solid 只保存 UI 投影；
  空 cell 和未读公式不物化、不求值。

非目标：

- 不改 `.github/workflows/*`。
- 不做多人协作。
- 不做正式文件导入 UI / IndexedDB 自动保存。
- 不为通过 perf 测试而重写业务路径；先加可观测指标和稳定断言。

## 当前事实

- Rust `Sheet` 已有一批 debug counters：
  - `debug_formula_eval_count`
  - `debug_formula_count`
  - `debug_live_subscription_count`
  - cache state / imported formula counters 等。
- `WasmSheet` 已暴露 single-sheet counters；`WasmWorkbook` 已暴露
  `debug_formula_cache_state` / `debug_formula_eval_count`。
- `solid/excel` 已有 viewport subscription 测试：
  - `virtualize.spec.ts`
  - `million-demo.spec.ts`
  - `observe-cell.test.ts`
- Wave 3 已用 MCP Playwright 验证 import cancel、import limit、persistence lazy restore。
- `solid/excel/docs/E2E_TEST_PLAN.md` 已是 2026-05-13，但数值已变为 21 spec / 150 tests；
  已按本次统计更新并同步 0 skip。Wave 2/3 新增覆盖（chunked export、
  bounded import、persistence lazy restore）已纳入 E2E 文档。

## 架构决策

### D1：先补“可查询指标”，再补“阈值断言”

性能门禁不能只靠截图和人工观察。Wave 4 的每个浏览器性能断言都应有可重复查询入口：

- DOM cell 数：直接从 DOM query 统计。
- worker lazy eval：通过 `debugFormulaEvalCount` / cache state。
- live subscription：优先用已有 `activeSubscriptionCount()`；worker workbook 如无入口，则新增
  worker debug command。
- worker session：import/export session 必须有可查询 count 或由状态机错误断言证明已释放。

### D2：MCP 记录写进文档

每次 MCP 验收要记录：

- URL。
- 执行脚本/动作摘要。
- 核心返回值。
- console 结果。
- 与 CLI Playwright 的对应关系。

### D3：不把观测指标变成产品状态

debug counters 是只读探针，不进入 Solid 产品状态，不缓存公式结果，不要求前端维护核心事实源。

## 并行角色

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| D1 Rust/WASM counters | `gpt-5.3-codex-spark` | `rust/excel-core/src/*`, `rust/wasm/src/lib.rs`, Rust tests | 补 workbook live subscription / formula count / session-relevant counters 的最小 WASM 暴露，保持 lazy |
| D2 Browser perf/MCP | Claude Sonnet（只读审查）+ 总架构师 | `solid/excel/e2e/*`, MCP 记录 | 设计可重复 MCP 脚本：DOM 数、eval count、subscription bound、console |
| D3 Docs gate | `gpt-5.3-codex-spark` 或便宜 Codex | `solid/excel/docs/E2E_TEST_PLAN.md`, `rust/docs/HANDOFF.md`, 本计划 | 重新统计 spec/test/skip，更新真实状态和 MCP 流程 |
| D4 Test guard | `gpt-5.3-codex-spark` | `solid/excel/e2e/*`, `solid/excel/test/*` | no-new-skip/no-only 扫描，补缺少的稳定 e2e 或 Jest 断言 |

## 文件冲突矩阵

| | D1 | D2 | D3 | D4 |
|---|---|---|---|---|
| D1 | - | D2 只读 D1 输出 | D3 只记录 | D4 只消费 counters |
| D2 | 只读 | - | 共享 MCP 记录，最终由总架构师合并 | D4 可复用脚本 |
| D3 | 只读代码 | 文档可能冲突，D3 先提交 doc 统计 | - | D4 若改文档需排队 |
| D4 | 消费 counters | 消费 MCP 设计 | 可能同改 E2E 计划，D3 先行 | - |

## 验收门禁

```sh
cd /Volumes/work/self/einfach && rg --line-number "test\\.only|describe\\.only|it\\.only|test\\.skip|describe\\.skip|it\\.skip" solid/excel/e2e solid/excel/test
cd /Volumes/work/self/einfach && npx tsc -p solid/excel/tsconfig.json --noEmit
cd /Volumes/work/self/einfach && npx jest solid/excel/test/wasm-workbook-worker.test.ts solid/excel/test/worker-workbook-store.test.ts solid/excel/test/observe-cell.test.ts --runInBand
cd /Volumes/work/self/einfach/rust/wasm && cargo test --quiet
cd /Volumes/work/self/einfach && npm run build:wasm -w @einfach/solid-excel
cd /Volumes/work/self/einfach && npm run build -w @einfach/solid-excel
cd /Volumes/work/self/einfach/solid/excel && npm run e2e -- e2e/million-demo.spec.ts e2e/virtualize.spec.ts e2e/worker-workbook.spec.ts
```

MCP Playwright 验收：

- 打开 `http://localhost:5174/?debug=1`。
- 统计 1M demo 初始 DOM cell 数，滚动后再次统计，断言仍是 viewport 级别。
- 调 worker workbook import/persistence/lazy eval 探针，断言未读公式 eval count 为 0。
- 执行一次大 range copy/export 或已有 helper，确认走 chunked worker path。
- 查询当前导航后的 console warning/error 为 0。

## 执行记录

### D1 Rust/WASM counters

- `WasmWorkbook` 新增只读观测入口：
  - `debug_formula_eval_count_total()`
  - `debug_formula_count()`
  - `debug_live_subscription_count()`
  - `debug_sheet_live_subscription_count(sheet_idx)`
  - `debug_sheet_formula_count(sheet_idx)`
- worker/proxy 新增 `debugCounters()` 聚合 RPC，返回：
  - workbook/sheet 公式数、eval count；
  - Rust live subscription count；
  - worker subscription/import/export session count；
  - cross-sheet dependent count。
- 这些指标均为只读，不扫描 dense grid，不读取公式 display，不触发公式求值。

### D3 Docs Gate

- `cd solid/excel && npx playwright test --list`：
  - 21 spec files；
  - 150 active tests；
  - 0 active skip/only。
- skip/only 扫描只命中 `regression.spec.ts` 的历史注释文本，无真实 `.skip/.only`。

### D4 Observability E2E

- 新增 `solid/excel/e2e/observability.spec.ts`：
  - 1M demo 初始与滚动后 DOM cell 数保持 viewport 级别；
  - worker workbook import 后未读公式前 eval count 为 0；
  - `debugCounters()` 读前 `formulaEvalCountTotal` 为 0，读公式后增长。
- `cd solid/excel && npm run e2e -- e2e/observability.spec.ts`：
  - 2 passed。

### MCP Playwright 验收

- URL：`http://localhost:5174/?debug=1`
- 1M demo：
  - `backend = "worker-workbook"`
  - 初始 DOM cell count：693
  - 横向/纵向滚动后 DOM cell count：693
  - `activeSubscriptionCount()`：693 → 693，delta = 0
- worker workbook lazy probe：
  - import 后 `debugCounters().formulaCount = 2`
  - 读公式前 `formulaEvalCountTotal = 0`
  - `debugFormulaCacheState(0, "A2") = "dirty"`
  - 读 `A2` 后 display = `11`
  - 读后 `formulaEvalCountTotal = 1`
- 当前导航后的 console warning/error：0。

## 停止条件

- 指标需要主线程扫描百万地址才能得到。
- 为了观测把公式结果或 sparse cells 复制进 Solid 状态。
- 新增 skip / only / flaky wait，却没有 owner 和明确修复计划。
- MCP 不可用但没有记录失败原因和 CLI Playwright 兜底。

## 本波输出

- Wave 4 代码/测试/文档提交至少 1 个。
- `solid/excel/docs/E2E_TEST_PLAN.md` 的计数与真实 `playwright test --list` 一致。
- `rust/docs/HANDOFF.md` 和 `ONLINE_SPREADSHEET_EXECUTION_WAVES.md` 更新到 Wave 4 当前状态。
- 最终汇报必须列出：
  - 参与的 Claude/Spark/Codex 子角色；
  - 本地命令验证；
  - MCP Playwright 验证；
  - 尚未做的产品功能项。
