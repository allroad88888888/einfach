# Wave 3：bounded import + sparse persistence v1

> 日期：2026-05-13
>
> 角色：总架构师。
>
> 前置状态：Wave 1 worker 命令收口、Wave 2 range-native undo/format/copy/export 已提交。

## 目标

把当前“可用的 worker import session + sparse snapshot”推进到产品化的数据进入/保存链路：

- import session 内存有明确上界，超限时返回可观测错误，不让 worker 无限吃内存。
- import chunk 继续写入 worker 内 staging workbook；commit 只把最终 touched cells 写入主 workbook。
- 导入公式不触发求值，commit 后 `debug_formula_eval_count(sheet) == 0`。
- sparse persistence v1 保存 workbook 的稀疏事实源：sheet name、dimension、primitive、formula、
  format metadata。不保存 dense grid，不保存公式计算结果。
- cancel 后主 workbook 不可见 session 内容。

非目标：

- 不做多人协作。
- 不做 `.github/workflows/*`。
- 不引入 IndexedDB/localStorage 自动保存 UI；本波只做 schema/API/test。
- 不要求 CSV parser 完整产品化；CSV/文件导入 UI 留到后续。

## 当前事实

- `WasmWorkbook.bulk_import_cells` 已存在，Rust 侧 bulk-load 公式不求值。
- worker 已有 `beginImport / importChunk / commitImport / cancelImport`，并已补上 chunk/session
  上界：chunk cells、normalized cells、final touches、issues。
- worker import session 保存 staging workbook、累计 stats、normalization issues、`finalTouches`；
  超限 chunk 不会部分写入 staging session。
- `snapshot_sparse / restore_sparse` 已可 round-trip primitive/formula；本波新增 persistence v1
  envelope，包含 sheet meta、sparse cells 和 format metadata。
- format metadata 使用每 sheet 的 `snapshot_format_range(full sheet)` 输出，不展开 dense grid。

## 架构决策

### D1：import session 上界先做“合同 + 防爆”，不重写成磁盘流

本仓库当前运行在浏览器 worker，没有稳定的临时文件/流式持久化 sink。真正无限导入必须等后续
文件流与 backpressure UI。Wave 3 先做产品可接受的硬上界：

- 每个 session 限制 accepted cells、issues 数、final touches 数。
- 每个 `importChunk` 限制 chunk 长度。
- 超限返回结构化错误码，例如 `IMPORT_CHUNK_TOO_LARGE`、`IMPORT_SESSION_LIMIT_EXCEEDED`。
- cancel / resetWorkbook 必须释放 session。

### D2：persistence v1 是 sparse envelope，不是 dense workbook

建议 schema：

```ts
type WorkbookPersistenceV1 = {
  version: 1
  sheets: Array<{
    idx: number
    name: string
    rowCount?: number
    colCount?: number
  }>
  cells: SparseCellWire[]
  formats?: FormatRangeSnapshot[] // 每个 snapshot 自带 sheet 字段
}
```

`cells` 必须使用 formula source，不读 formula display。`formats` 优先用 format snapshot；如 Rust
format API 暂时无法表达全 sheet metadata，先记录能力缺口并只保存 cells + sheet meta。

### D3：worker 是事实源，Solid 只拿 envelope

保存/加载 API 放在 worker/proxy/workbook store 层。UI store 不扫描 cell、不复制全量状态、不从
projection cache 组装 persistence。

## 并行角色

| 角色 | 推荐模型 | 文件所有权 | 任务 |
|---|---|---|---|
| C1 Import Runtime | Claude Sonnet 或 Codex Spark | `excel/solid-excel/src/wasm-workbook-worker.ts`, `excel/solid-excel/src/wasm-workbook-proxy.ts`, 对应 worker/proxy tests | 加 import chunk/session 上界、错误码、测试 cancel/limit/commit lazy |
| C2 Persistence Schema | Codex Spark | `excel/rust/wasm/src/lib.rs`, `excel/solid-excel/src/wasm-workbook-proxy.ts`, `excel/solid-excel/src/wasm-workbook-worker.ts`, 新 docs/test fixture | 设计/实现 persistence v1 save/load API，round-trip sheet names + sparse cells，不预热公式 |
| C3 Store/Demo 接线 | Codex Spark 或便宜 Codex | `excel/solid-excel/src/wasm-workbook-store.ts`, `excel/solid-excel/src/demos/DemoMillion.tsx` | 暴露 save/load/import stats 调试入口；不做正式 UI |
| C4 Tests/MCP | Codex Spark 或便宜 Codex | `excel/solid-excel/test/*`, `excel/solid-excel/e2e/worker-workbook.spec.ts`, `excel/solid-excel/e2e/million-demo.spec.ts` | 100k lazy import、cancel、limit、persistence round-trip、MCP Playwright 验收 |

## 文件冲突矩阵

| | C1 | C2 | C3 | C4 |
|---|---|---|---|---|
| C1 | - | `proxy/worker` 可能冲突，C2 先冻结类型 | C3 只消费 API | C4 只测 |
| C2 | `proxy/worker` 可能冲突 | - | C3 只消费 API | C4 只测 |
| C3 | 只消费 API | 只消费 API | - | E2E helper 可能冲突 |
| C4 | 只测 | 只测 | E2E helper 可能冲突 | - |

总架构师合并顺序：C1 → C2 → C3 → C4，若 C1/C2 同改 worker/proxy，由总架构师手工整合类型。

## 验收门禁

```sh
cd /Volumes/work/self/einfach && npx tsc -p excel/solid-excel/tsconfig.json --noEmit
cd /Volumes/work/self/einfach && npx jest excel/solid-excel/test/wasm-workbook-proxy.test.ts
cd /Volumes/work/self/einfach && npx jest excel/solid-excel/test/wasm-workbook-worker.test.ts
cd /Volumes/work/self/einfach && npx jest excel/solid-excel/test/worker-workbook-store.test.ts
cd /Volumes/work/self/einfach && npm run build -w @einfach/solid-excel
cd /Volumes/work/self/einfach/solid/excel && npx playwright test e2e/worker-workbook.spec.ts e2e/million-demo.spec.ts
```

MCP Playwright 验收：

- 浏览器中创建 worker workbook，导入含公式的大 chunk，commit 前后 eval counter 仍为 0。
- cancel 后读取主 workbook 看不到 session 内容。
- save persistence → 新 workbook load → 读公式前 cache dirty，读后结果正确。
- console 无未处理错误；favicon 404 可忽略。

## 测试执行记录 / 建议

> 这部分是 C4 的落地清单，目标是把 Wave 3 验收拆成可执行的 e2e/MCP 步骤。当前阶段优先补规划，不要求一次性补齐所有 API。

### 验收矩阵

| 验收点 | 当前覆盖 | 建议测试形态 | 通过标准 |
|---|---|---|---|
| large import commit 前后 eval count 0 | `worker-workbook.spec.ts` 里已有“commits chunked import without hydrating formulas before read”与 round-trip 类似断言 | 继续沿用浏览器 e2e，单独固化为 Wave 3 用例；必要时在 debug 入口读 `debugFormulaEvalCount` | commit 前 `0`，commit 后 `0`，直到显式读公式才可变为 `1` |
| cancel 后主 workbook 不可见 session 内容 | 现有 import 场景已经验证 cancel 读不到 `B2`，但只覆盖单点 | e2e 中在 cancel 后读取多个地址，并验证 `listNonEmpty` / snapshot 不包含 session 写入 | cancel 返回成功；主 workbook 相关地址保持空；session 内容不可见 |
| persistence round-trip 后公式 cache dirty，读取后结果正确 | 当前有 sparse snapshot round-trip，不是 persistence envelope | 等 C2 提供 save/load API 后，做“save envelope -> new workbook load -> inspect cache -> read formula -> re-inspect” | load 后 cache dirty；读前 eval count 0；读后 display 正确，cache clean |
| import limit 超限错误码和 session 可取消 | 现有测试未覆盖 limit | 用 MCP/Playwright 触发超大 chunk / 累积超限，断言结构化错误码和 session 可 cancel | 返回明确错误码；session 仍可 cancel；cancel 后不会再写入主 workbook |

### 建议的 e2e/MCP 步骤

1. 在 `worker-workbook.spec.ts` 里保留一个 Wave 3 import 场景：先 `beginImport`，分块写入含公式数据，`commitImport` 前后都检查 `debugFormulaEvalCount(0) === 0`，再做一次显式 `readCells` 证明求值只发生在读取点。
2. 在同一 worker workbook 生命周期里，`beginImport` -> `importChunk` -> `cancelImport`，随后检查主 workbook 的 `readCells`、`listNonEmpty`，以及必要时 `snapshotSparse`，确认 session 写入没有外泄。
3. 在 persistence API 到位后，新增一条 round-trip 验收：`snapshot/save` 后重建 workbook，`load/restore` 后先查 `debugFormulaCacheState` 为 dirty，再读公式并校验结果。
4. 针对 limit，优先验证“错误码 + 可取消”而不是错误文案；文案可变，错误码和取消后可恢复状态才是合同。

### 现有测试的复用建议

- `excel/solid-excel/e2e/worker-workbook.spec.ts`：优先扩展这里的 import helpers，不要把 Wave 3 验收拆到新的低层 helper 里。
- `excel/solid-excel/test/wasm-workbook-worker.test.ts`：适合补 worker 级别的 contract 断言，尤其是 `beginImport / importChunk / commitImport / cancelImport` 的状态机和错误码。
- `excel/solid-excel/e2e/million-demo.spec.ts`：只保留 demo 级 smoke，不建议在这里承载 Wave 3 persistence 断言，避免把一套合同绑到 demo UI 上。

### 当前缺口

- persistence envelope 的 worker/proxy API 已稳定为 `snapshotPersistenceV1()` /
  `restorePersistenceV1(snapshot)`；cells 使用 `SparseCellWire[]`，不是 display/formula-result
  形态。
- import limit 的公开错误码已钉住：`IMPORT_CHUNK_TOO_LARGE`、
  `IMPORT_SESSION_LIMIT_EXCEEDED`、`IMPORT_ISSUES_LIMIT_EXCEEDED`。
- Wave 3 的关键合同已由 Rust unit、worker/proxy/store Jest、worker e2e 和 MCP Playwright
  覆盖。

## 停止条件

- 为了 persistence 或 import，在主线程展开 dense grid 或读取公式 display。
- persistence 保存公式计算结果而不是 formula source。
- import limit 超限后 session 继续保留不可预测的部分状态。
- 为了实现“无限导入”引入未经验证的浏览器存储依赖。

## Rust 侧执行记录（C2）

- 已在 `excel/rust/wasm/src/lib.rs` 新增持久化 v1 核心 API：
  - `snapshot_persistence_v1() -> Result<JsValue, JsValue>`
  - `restore_persistence_v1(value: JsValue) -> Result<JsValue, JsValue>`
- v1 envelope 使用 `version/sheets/cells/formats`（`formats` 为每 sheet 的 `snapshot_format_range` 结果）。
- `sheet` 元信息增加 `idx/name/rowCount?/colCount?`；
  `rowCount/colCount` 仅基于稀疏非空单元格边界推断，不代表 dense 维度。
- `cells` 保持 `formula` 的 source 字符串（`=...`）快照；无公式 display 读取。
- `restore_persistence_v1` 重建 workbook（清空到默认一张 Sheet 后按 snapshot 顺序重建），并按顺序回放 `cells` 与 `formats`。
- 格式能力边界：当前只保留 `snapshot_format_range` 可见范围内的元数据；当前 API 入口不能表达“纯空白区域上的完整单元格格式快照”，因此 dense grid 仍不保留，格式能力以 range-format 语义为主。
- 已补充 Rust 测试覆盖：
  - v1 schema round-trip、默认 `Sheet1` 恢复、版本校验、坏 format payload 原子性、restore
    清理订阅 token。当前 `cd excel/rust/wasm && cargo test --quiet` 为 21 passed。

## Worker / Proxy 执行记录（C1 + C3）

- `excel/solid-excel/src/wasm-workbook-worker.ts`：
  - 新增 import 上界常量和测试注入钩子。
  - `importChunk` 在 normalize / `bulk_import_cells` 前检查 chunk/session/issue/final-touch 上界。
  - 新增 `snapshotPersistenceV1` / `restorePersistenceV1` worker command；restore 成功后清理
    worker subscription tokens、import sessions、export sessions。
- `excel/solid-excel/src/wasm-workbook-proxy.ts`：
  - 新增 `WorkbookPersistenceSnapshotWire` / `WorkbookPersistenceRestoreStatsWire`。
  - `WorkerWorkbookClient` 正式暴露 `snapshotPersistenceV1()` 和 `restorePersistenceV1(snapshot)`。
  - persistence cells 使用 `SparseCellWire[]`，明确保存 formula source，不保存 display/result。
- `excel/solid-excel/test/*`：
  - proxy tests 覆盖 RPC 形状和 WASM API 缺失错误码。
  - worker tests 覆盖 import limits、restore 清理订阅/import/export session、persistence route。
  - store fake client 同步了 persistence v1 合同，避免接口变成可选软合同。

## E2E / MCP 验收记录

- Playwright CLI：
  - `cd excel/solid-excel && npm run e2e -- e2e/worker-workbook.spec.ts --grep "persistence|import"`
  - 结果：9 passed。
- MCP Playwright：
  - 打开 `http://localhost:5174/?debug=1`。
  - 浏览器内创建 worker workbook，验证：
    - cancel import 后 `E5` 仍为空。
    - 10001 cell chunk 返回 `IMPORT_CHUNK_TOO_LARGE`，session 可 cancel。
    - import 公式后 snapshot 前后 `debugFormulaEvalCount(0) === 0`，cache `dirty`。
    - persistence v1 snapshot cells 为 `kind/value` sparse facts，formula 保存
      `=Sheet2!A1+1` source。
    - restore 后读公式前 eval count 仍为 0，读 `A1` 得到 `42`，之后 cache `clean`、eval count
      变为 1。
  - 当前导航后的 console warning/error 为 0；历史 HMR/connection refused 记录来自 dev server
    重启前，已用非 `all` 查询排除。

## 已知后续项

- 这波只做 bounded session 和 sparse persistence API；真正文件流 CSV parser、backpressure UI、
  IndexedDB/localStorage 自动保存仍留到后续。
- `excel/solid-excel/wasm-pkg/` 被 `.gitignore` 忽略；本地浏览器/e2e 需要在 Rust 改动后运行
  `npm run build:wasm -w @einfach/solid-excel` 重新生成。
