# REMOTE 公式重启计划（2026-07-28）

## 背景：上轮为什么撤回

2026-07-27 salvage 审查中整体撤回的 REMOTE 实现是半成品：worker 往主线程
post `remote-call`，但**主线程监听、resolver 注册端口、capability 声明全部
缺失**，任何 `=REMOTE(...)` 只会挂在 `#BUSY!` 直到超时。另有两处结构性错误：

1. **错误契约退化**：`ValueError::Remote` 没接进 wire 的 error token 表
   **出向**，所有 REMOTE 错误退化成 `#VALUE!`；
2. **重复挂监听**：TS worker 的 postMessage router 按 `createWorkerRuntimeTs()`
   调用次数重复挂监听，跨 jsdom 测试泄漏且 callId 可能串线。

路线图位置：wave-8 §8.1。本文档吸取教训的总纲只有一条：**每层做完接通、
测试落地后才动下一层；任何时刻文档描述的架构必须与树上代码一致。**

依赖基建（全部已在，均经本轮核实）：async-custom memo/pending 基建
（`sheet.rs` `call_custom`，`rust/excel-core/src/CUSTOM_FORMULAS.md` § Async）、
共享 pump（`solid/excel/src-vnext/adapter/async-custom-pump.ts`，双 worker
runtime 共用）、scoped capability witness 模式（`worker-protocol.ts:572`
`{scope:'auto-fill'}`）、可选端口惯例（`backend/types.ts:1210`
`registerCustomFormula?` / `:1215` `unregisterCustomFormula?`）。

---

## 分层步骤（禁止跳层）

### L1 端口先行

`SpreadsheetBackend`（`vanilla/spreadsheet-ui-core/src/backend/types.ts`）增
可选端口，形状仿 `registerCustomFormula?`：

```ts
registerRemoteResolver?(key: string, resolver: RemoteResolver): Promise<void>
unregisterRemoteResolver?(key: string): Promise<void>
```

UI core 按既有惯例：宿主缺端口 → 相关入口全部隐藏，不感知「未实现」与
「不存在」的区别。

**验收**：类型编译；`package-boundary` 测试绿（不引 DOM/worker/WASM）。

### L2 capability 家族（fail-closed）

仿 `{scope:'auto-fill'}` witness 造 `{scope:'remote'}`：

- WASM worker runtime 声明 `remote: true`（在 L3 引擎分支落地**之后**才许翻真）；
- TS worker runtime 明确 `remote: false` + 结构化 UNSUPPORTED 应答——
  **不是缺省缺失，是显式否认**（fail-closed）。

**验收**：worker 双 runtime 一致性测试断言 capability 面；TS runtime 收到
remote 调用返回结构化 UNSUPPORTED 而非挂起。

### L3 引擎 + 错误契约（上轮翻车层，双向都要）

1. `sheet.rs` `call_custom`（`:1690` 求值路径 / `:2342` 转发路径）加 REMOTE
   前置分支：命中 `REMOTE` 名 → 走 async-custom 的 memo/pending 基建（上轮
   撤回的那 8 行方向正确，照做）。挂起中单元格 `#BUSY!`，与 async 自定义
   公式同语义。
2. `ValueError::Remote` 新变体，**四处同 commit 落齐**：
   - 入向：`rust/wasm/src/lib.rs:2607` `error_token_to_value_error` 加
     `"#REMOTE!" => Some(ValueError::Remote)`；
   - 出向：`rust/excel-core/src/format.rs` 的 ValueError→显示 token 映射加
     `#REMOTE!` 分支（**上轮正是漏了这一侧导致全部退化 `#VALUE!`**；
     eval.rs 若有第二处映射一并查，`grep -rn 'DIV/0' rust/excel-core/src`）；
   - 公式字面量：`rust/excel-core/src/formula.rs:858` 错误字面量表加
     `("#REMOTE!", ValueError::Remote)`；
   - **static 侧对齐义务**（A 链新立的契约）：
     `solid/excel/src-vnext/adapter/static-formula-eval.ts` 的
     `ERROR_LITERAL_RE` 同步加 `REMOTE!`，
     `static-formula-eval-error-literals.test.ts` 的 13-token 表扩成 14。
3. round-trip 测试扩展：`rust/wasm/src/lib.rs:6280`
   `wasm_calc_error_token_round_trips` 加 `#REMOTE!`。

**验收**：engine native 测试绿；round-trip 绿；若 WASM 签名有变跑快照门禁
`cd rust/excel-core && cargo test --test architecture_invariants
wasm_snapshot_generate -- --ignored`。

### L4 名字保留

- 自定义公式注册路径拒绝 `REMOTE` 名（引擎前置分支会截胡，注册了也是死的，
  必须在注册时报错而非静默）；
- `vanilla/spreadsheet-ui-core/src/custom-formulas/engine-builtin-names.ts`
  影子表加 `REMOTE`；README 的 built-in shadow list 说明同步。

**验收**：注册 `REMOTE` 得到结构化拒绝的测试。

### L5 pump 路由（上轮泄漏层）

- `async-custom-pump.ts` 加 `routeRemote` hook：REMOTE pending 分流到宿主
  round-trip，其余 async 自定义公式路径零变化；
- worker 内 postMessage router 硬规则：**每个 runtime 实例只挂一次监听**，
  卸载对称；callId per-instance 单调递增。为上轮的重复挂监听写一个专门回归
  测试（重复 `createWorkerRuntime*()` → 监听器计数不增长、callId 不串线）。

**验收**：pump 单测（routeRemote 分流 + 既有 async 行为不回归）；重复实例化
回归测试绿；跨 jsdom 套件无泄漏告警。

### L6 主线程 adapter

`worker-workbook-backend.ts`：处理 `remote-call` → 查 resolver 注册表 →
`remote-result` 回传。错误映射三分：

| 场景 | 单元格 |
|---|---|
| 无 resolver 注册该 key | `#NAME?` |
| resolver reject / 超时 | `#REMOTE!` |
| 挂起中 | `#BUSY!` |

**验收**：主线程 round-trip jest（注册 → 求值 → 拿值；注销 → `#NAME?`；
reject → `#REMOTE!`）。

### L7 验收线（全链路）

engine native 测试 + worker 双 runtime 一致性测试 + 主线程 round-trip jest +
Playwright e2e（真实 resolver mock 数据：`=REMOTE("key", A1)` 从 `#BUSY!`
落到值；断网/注销场景落到对应错误 token）。

---

## 约束

- 每层一个自含 commit（带该层测试），层间不许有「文档说了代码没有」的窗口；
- 本分支并回主线前不开工（W4 排期，见 `SALVAGE_PLAN_REVISIONS.md` §八）；
- 工作量预估 3–5 天全链路;
- memoization 语义沿用 async-custom（per (name, args) 直到 registry 变更），
  REMOTE 不另造缓存层。

## 上轮三坑速查（写给执行 agent）

| 坑 | 症状 | 本计划的防线 |
|---|---|---|
| 主线程侧整层缺失 | 一切 `=REMOTE` 挂 `#BUSY!` 到超时 | 分层令：L6 未接通前 capability 不许翻真 |
| 错误 token 只接入向 | 错误契约全退化 `#VALUE!` | L3 四处同 commit + round-trip 测试 |
| runtime 每实例化重复挂监听 | jsdom 泄漏、callId 串线 | L5 专门回归测试 |
