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
- worker 已有 `beginImport / importChunk / commitImport / cancelImport`。
- worker import session 现在保存 staging workbook、累计 stats、normalization issues、`finalTouches`。
- `snapshot_sparse / restore_sparse` 已可 round-trip primitive/formula，但没有 sheet meta/dimension/
  format 的 v1 persistence envelope。
- format metadata 已有 `snapshot_format_range / restore_format_snapshot`，可作为 persistence format
  载体的候选来源。

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
  formats?: Array<{
    sheet: number
    snapshot: FormatRangeSnapshot
  }>
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
| C1 Import Runtime | Claude Sonnet 或 Codex Spark | `solid/excel/src/wasm-workbook-worker.ts`, `solid/excel/src/wasm-workbook-proxy.ts`, 对应 worker/proxy tests | 加 import chunk/session 上界、错误码、测试 cancel/limit/commit lazy |
| C2 Persistence Schema | Codex Spark | `rust/wasm/src/lib.rs`, `solid/excel/src/wasm-workbook-proxy.ts`, `solid/excel/src/wasm-workbook-worker.ts`, 新 docs/test fixture | 设计/实现 persistence v1 save/load API，round-trip sheet names + sparse cells，不预热公式 |
| C3 Store/Demo 接线 | Codex Spark 或便宜 Codex | `solid/excel/src/wasm-workbook-store.ts`, `solid/excel/src/demos/DemoMillion.tsx` | 暴露 save/load/import stats 调试入口；不做正式 UI |
| C4 Tests/MCP | Codex Spark 或便宜 Codex | `solid/excel/test/*`, `solid/excel/e2e/worker-workbook.spec.ts`, `solid/excel/e2e/million-demo.spec.ts` | 100k lazy import、cancel、limit、persistence round-trip、MCP Playwright 验收 |

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
cd /Volumes/work/self/einfach && npx tsc -p solid/excel/tsconfig.json --noEmit
cd /Volumes/work/self/einfach && npx jest solid/excel/test/wasm-workbook-proxy.test.ts
cd /Volumes/work/self/einfach && npx jest solid/excel/test/wasm-workbook-worker.test.ts
cd /Volumes/work/self/einfach && npx jest solid/excel/test/worker-workbook-store.test.ts
cd /Volumes/work/self/einfach && npm run build -w @einfach/solid-excel
cd /Volumes/work/self/einfach/solid/excel && npx playwright test e2e/worker-workbook.spec.ts e2e/million-demo.spec.ts
```

MCP Playwright 验收：

- 浏览器中创建 worker workbook，导入含公式的大 chunk，commit 前后 eval counter 仍为 0。
- cancel 后读取主 workbook 看不到 session 内容。
- save persistence → 新 workbook load → 读公式前 cache dirty，读后结果正确。
- console 无未处理错误；favicon 404 可忽略。

## 停止条件

- 为了 persistence 或 import，在主线程展开 dense grid 或读取公式 display。
- persistence 保存公式计算结果而不是 formula source。
- import limit 超限后 session 继续保留不可预测的部分状态。
- 为了实现“无限导入”引入未经验证的浏览器存储依赖。
