# Wave 5：文件导入与 Backpressure UI

> 日期：2026-05-13
>
> 角色：总架构师。
>
> 前置状态：Wave 1 worker 命令收口、Wave 2 range-native 操作、Wave 3 bounded
> import + sparse persistence v1、Wave 4 observability gates 均已提交。

## 目标

把已有 worker import session 从“API 可用”推进到“用户可以导入本地文件，并且导入过程可观测、
可取消、有 backpressure”。

本波只做单机在线表格能力，不做协同，不做服务端上传。

必须解决：

- CSV/TSV 文件按流读取，不能 `file.text()` 一次性把大文件读进主线程。
- 解析出的 cell 分批进入 `WorkerWorkbookClient.importChunk()`，每个 chunk 必须等待 worker
  ack 后再继续推进，形成明确 backpressure。
- 用户可取消导入；取消后必须调用 `cancelImport()`，不能让 staging session 泄漏。
- 成功导入后调用 `commitImport()`；导入公式后未读取前 eval counter 保持 0。
- UI 只展示进度/状态/统计，不复制 workbook 数据，不保存公式结果。

非目标：

- 不做 `.xlsx` 二进制解析。
- 不做 IndexedDB 自动保存。
- 不做多人协同。
- 不改 `.github/workflows/*`。
- 不追求完整 Excel CSV 方言；v1 只承诺普通 CSV/TSV、引号转义、CRLF/LF。多行 quoted cell
  如果要支持，必须先补 parser 测试。

## 架构决策

### E1：文件解析在主线程分片执行，事实写入仍在 worker

浏览器 `File.stream()` 已能避免一次性读入文件。本波用 `ReadableStreamDefaultReader`
和 `TextDecoder` 增量解码，按行解析，再按 `ImportCellWire[]` chunk 推给 worker。

这里不新增专用 import worker，原因：

- 当前 Rust/WASM workbook 已在 worker 内；解析只是轻量文本分片。
- 每个 chunk 都 await worker ack，天然限制 parser 前进速度。
- 如果 MCP 或 E2E 证明主线程仍明显卡顿，再进入下一波拆独立 parser worker。

### E2：Backpressure 合同放在 helper，而不是 UI 组件

新增 helper 负责：

- begin/importChunk/commit/cancel 生命周期；
- chunk flush；
- abort signal；
- progress callback；
- `await` worker ack 后再继续读流。

UI 只消费 helper 的进度状态。这样后续可以复用到菜单、拖拽、命令面板，而不是把导入协议写死在
`DemoMillion`。

### E3：导入后可见投影要刷新，但不能 eager read 全表

导入 commit 后只刷新当前可见订阅窗口。不能为了展示“导入完成”读取全部导入 cell。

## 并行角色

| 角色 | 推荐执行者 | 文件所有权 | 任务 |
|---|---|---|---|
| E1 流式 parser/helper | Codex Spark | `solid/excel/src/file-import.ts`, `solid/excel/test/file-import.test.ts` | 实现 CSV/TSV stream parser、chunk flush、abort/cancel、progress 单元测试 |
| E2 导入 UI | 总架构师 + Codex Spark | `solid/excel/src/demos/DemoMillion.tsx`, `styles.css`, i18n | 在 1M worker demo 增加文件导入控件、进度、取消、统计，不复制 workbook 数据 |
| E3 E2E/MCP | Codex Spark | `solid/excel/e2e/file-import.spec.ts`, `helpers.ts` | 通过小文件验证导入、公式 lazy、取消、console；MCP 脚本记录真实返回值 |
| E4 架构复核/文档 | Claude Sonnet + 总架构师 | 本文档、`HANDOFF.md`, `ONLINE_SPREADSHEET_EXECUTION_WAVES.md` | 复核 backpressure 是否真的存在，记录验证命令和遗留风险 |

## 文件冲突矩阵

| | E1 | E2 | E3 | E4 |
|---|---|---|---|---|
| E1 | - | E2 只调用公开 helper | E3 消费 helper/UI | E4 只记录 |
| E2 | 不改 helper 内部 | - | 共享 selector，E2 先定 test id | E4 只记录 |
| E3 | 只读 helper | 只读 UI selector | - | E4 只记录 |
| E4 | 只读代码 | 只读代码 | 只读测试 | - |

## 验收门禁

```sh
cd /Volumes/work/self/einfach && npx tsc -p solid/excel/tsconfig.json --noEmit
cd /Volumes/work/self/einfach && npx jest solid/excel/test/file-import.test.ts solid/excel/test/wasm-workbook-proxy.test.ts solid/excel/test/wasm-workbook-worker.test.ts --runInBand
cd /Volumes/work/self/einfach && npm run build -w @einfach/solid-excel
cd /Volumes/work/self/einfach/solid/excel && npm run e2e -- e2e/file-import.spec.ts e2e/observability.spec.ts
```

MCP Playwright 验收：

- 打开 `http://localhost:5174/?debug=1`。
- 进入 1M worker demo。
- 导入一个包含值和公式的 CSV/TSV 文件。
- 读公式前 `debugCounters().formulaEvalCountTotal` 不增长；读可见公式后才增长。
- 取消一次导入，确认 `debugCounters().importSessionCount = 0`。
- console warning/error 为 0。

## 停止条件

- 实现需要 `file.text()` 或一次性构造全量 `ImportCellWire[]`。
- UI 为了展示导入结果读取全表或复制 workbook 数据。
- cancel 后 worker `importSessionCount` 不归零。
- 导入公式时 eval counter 增长。
- E2E 只能靠固定 sleep，无法用可查询状态断言完成。

## 计划输出

- `file-import.ts` helper + 单元测试。
- 1M demo 文件导入 UI。
- Playwright e2e + MCP 验收记录。
- 文档状态更新并提交。
