# SALVAGE_FOLLOWUPS 执行计划

> 基于 `SALVAGE_FOLLOWUPS_2026-07-27.md`
> 生成日期：2026-07-28
> 总子任务：60 个
> 预计总耗时：~15 小时

---

## 一、并发拓扑

```
Wave 1（最并行，5 链齐开，32 子任务）
┌──────────────────────────────────────────────────┐
│ A 链 (7)  B 链 (5)  C 链 (5)  D 链 (11)  E 链 (4) │
│                                                  │
│ 互相零依赖，3-5 个 agent 并行消费                  │
│ 预计 1 天                                         │
└──────────────────────────────────────────────────┘
                      ↓
         汇合点: tsc -b 零错误
                 parity 全绿
                 eslint 评估报告出

Wave 2（架构师主导，串行）
┌──────────────────────────────────────────────────┐
│ F 链 (10)  ack-hardening 共享 helper 重构          │
│ F1.4~F1.9 可 6 模块部分并行                        │
│ 预计 1 天                                         │
└──────────────────────────────────────────────────┘
                      ↓

Wave 3（可并行）
┌──────────────────────────────────────────────────┐
│ G 链 (6)  fill undo 聚合                          │
│ H 链 (12) lint 旧债清理（可与 G 并行）              │
│ 预计 0.5 天                                       │
└──────────────────────────────────────────────────┘
                      ↓
              （可选）Wave 4
┌──────────────────────────────────────────────────┐
│ #9 REMOTE 公式全链路重启（7 步，3-5 天）           │
└──────────────────────────────────────────────────┘
```

---

## 二、Agent 分配（Wave 1 最大并行）

```
Agent Alpha → A 链 (static 错误字面量) + E 链 (flaky)
Agent Beta  → B 链 (WASM 别名) + C 链 (eslint 评估)
Agent Gamma → D 链 (tsc -b 零错误)
Agent Delta → D 链中剩余的并行子任务

最少 3 个 agent 可覆盖全部 Wave 1，5 个 agent 最优。
```

---

## 三、原子任务清单

---

### A 链：static 求值器裸错误字面量

**优先级**：P0 | **预计**：1.5h | **入口**：`excel/solid-excel/src-vnext/adapter/static-formula-eval.ts`

| ID | 任务 | 耗时 | 文件 | 验收 |
|---|---|---|---|---|
| A1.1 | 梳理 Rust 侧 13 个 error token 完整清单 | 10min | `excel/rust/wasm/src/lib.rs` → `error_token_to_value_error` | 输出 13 个 token 的精确字符串列表 + 正则注意点（`#N/A` 无叹号、`#NAME?` 问号结尾） |
| A1.2 | tokenizer 新增 `ErrorLiteral` token 类型 | 20min | `excel/solid-excel/src-vnext/adapter/static-formula-eval.ts` | 13 个 token 全部识别，正则单列 `#N/A` 和 `#NAME?` |
| A1.3 | parser 将 `ErrorLiteral` → 错误值 AST 节点 | 15min | 同上 | `=#REF!+1` 解析为 `BinOp(Add, Error(#REF!), Number(1))` |
| A1.4 | 求值器确认错误传播路径 | 10min | 同上 | 算术/比较中错误值短路传播（大概率不用改，只确认） |
| A1.5 | 补 static 单测 | 10min | `excel/solid-excel/test/static-formula-eval.test.ts` | `setCellInput('=#REF!+1')` → 回读 `#REF!` |
| A1.6 | parity 场景 7 双侧对齐 + 删除 FIXME | 15min | `excel/solid-excel/test/vnext-auto-fill-static-wasm-parity.test.ts` | 双侧断言 `#REF!`，无 FIXME |
| A1.7 | 回归 | 5min | — | `npx jest excel/solid-excel --runInBand` 全绿 |

---

### B 链：WASM numberFormat 别名

**优先级**：P0 | **预计**：1h | **入口**：`excel/rust/wasm/src/lib.rs`、`excel/rust/excel-core/src/format.rs`

| ID | 任务 | 耗时 | 文件 | 验收 |
|---|---|---|---|---|
| B1.1 | `#[serde(alias = "number")]` 到 decimal variant | 10min | `excel/rust/wasm/src/lib.rs` | 输出仍为 `"decimal"`，只放宽输入 |
| B1.2 | native 测试：`"number"` → 回读 decimal、格式生效 | 15min | `excel/rust/excel-core/tests/`（新增或追加） | 测试绿 |
| B1.3 | 同类扫荡：逐个检查 `SpreadsheetNumberFormat` 所有 kind | 20min | 对照 `excel/spreadsheet-ui-core/src/backend/types.ts` | `date`/`percent`/`currency`/`fraction`/`scientific`/`percentage` 等无遗漏 |
| B1.4 | WASM API 快照门禁 | 15min | — | `cd excel/rust/excel-core && cargo test --test architecture_invariants wasm_snapshot_generate -- --ignored` 绿 |
| B1.5 | Rust 回归 | 5min | — | `cargo test` 全绿 |

---

### C 链：eslint solid/* 门禁

**优先级**：P1 | **预计**：0.5h 配置 + 清理量待评估 | **入口**：`rules/.eslintrc`

| ID | 任务 | 耗时 | 文件 | 验收 |
|---|---|---|---|---|
| C1.1 | `parserOptions.project` 加 `"./solid/*/tsconfig.json"` | 10min | `rules/.eslintrc` | 配置正确 |
| C1.2 | 评估 Solid JSX overrides 需求 | 10min | 参考 `rules/.eslintrc` 中 react overrides 写法 | 确定是否需要 `no-unused-vars` 白名单等 |
| C1.3 | 只读扫描（**不 `--fix`**） | 5min | — | `npx eslint --config rules/.eslintrc --ignore-path rules/.eslintignore 'excel/solid-excel/**/*.{ts,tsx}'` 输出到文件 |
| C1.4 | 生成分类报告 | 10min | — | 总错误数 / 按规则分类 / 按文件 Top 10 / 建议策略（<50 一次清 / 50-200 分批 / >200 豁免存量） |
| C1.5a-n | 按 C1.4 报告执行清理 | 待定 | 按报告逐文件 | 每个文件清理后 lint 通过 |

---

### D 链：tsc -b 零错误

**优先级**：P1 | **预计**：2.5h

| ID | 任务 | 耗时 | 文件 | 验收 |
|---|---|---|---|---|
| D1.1 | 运行 `npx tsc -b` 收集完整错误列表 | 5min | — | 输出实际错误数量 + 文件分布（文档说 ~39 个） |
| D1.2 | viewport 测试 `it.each` 参数不兼容 | 15min | `excel/spreadsheet-ui-core/test/viewport.test.ts` | 回调签名 `(...args: (typeof TABLE)[number])` 或显式泛型 |
| D1.3 | toolbar 测试 `it.each` 参数不兼容 | 15min | `excel/spreadsheet-ui-core/test/toolbar.test.ts` | 同上 |
| D1.4 | effective-hidden 测试 `it.each` 参数不兼容 | 15min | `excel/spreadsheet-ui-core/test/effective-hidden.test.ts` | 同上 |
| D1.5 | conditional-formatting TS6133 未使用导入 | 10min | `excel/spreadsheet-ui-core/test/conditional-formatting.test.ts` | 删死代码或 `void expr` |
| D1.6 | workspace TS6133 未使用常量 | 10min | `excel/spreadsheet-ui-core/test/workspace.test.ts` | 同上 |
| D1.7 | selection TS6133 未使用常量（含 `*_IS_READ_ONLY` 块） | 10min | `excel/spreadsheet-ui-core/test/selection*.test.ts` | 逐一确认，`satisfies` 或删除 |
| D1.8 | filter-sort TS6133 未使用常量 | 10min | `excel/spreadsheet-ui-core/test/filter-sort.test.ts` | 同上 |
| D1.9 | protection.test.ts TS2559 mock 形状 | 15min | `excel/spreadsheet-ui-core/test/protection.test.ts` | mock 补端口方法 或 `Partial<Port>` + 显式断言 |
| D1.10 | worker-runtime.ts:368 参数类型对齐 | 20min | `excel/solid-excel/src-vnext/adapter/worker-runtime.ts` | `CustomFormulaCallable` 参数对齐 `AsyncCustomArg[]`；对照 `CUSTOM_FORMULAS.md` § Marshaling 确认 range 实参路径有覆盖 |
| D1.11 | 最终确认 | 5min | — | `npx tsc -b` 零错误 |

---

### E 链：react asyncWith flaky

**优先级**：P1 | **预计**：1h

| ID | 任务 | 耗时 | 文件 | 验收 |
|---|---|---|---|---|
| E1.1 | 分析根因 | 15min | `core/react/test/asyncWith.test.tsx` | 确认真实计时器位置 + 并行饥饿原因 |
| E1.2 | 改用 `jest.useFakeTimers()` + `advanceTimersByTime` | 30min | 同上 | 消灭真实计时依赖（Plan A） |
| E1.3 | Plan B（若 fake 难模拟）：`waitFor` 超时 10s + `jest.setTimeout(30000)` | 10min | 同上 | 不推荐但可用 |
| E1.4 | 验证 | 15min | — | 连续 10 次 `npx jest core/react/test/asyncWith.test.tsx --runInBand` 零失败 |

---

### F 链：ack-hardening 共享 helper 重构

**优先级**：P2 | **预计**：4h | **架构师主导** | **依赖**：Wave 1 全部绿

| ID | 任务 | 耗时 | 文件 | 验收 |
|---|---|---|---|---|
| F1.1 | 审计 8 个模块重复代码 | 20min | 全仓 grep | 精确的 `snapshotAcknowledgement` / `runBoundedOperation` / `15000` 重复位置清单 |
| F1.2 | 新建 `excel/spreadsheet-ui-core/src/internal/ack-hardening.ts` | 30min | 新建 | 不从包入口导出；`snapshotAcknowledgement` 泛型工厂 + `runBoundedOperation` + `MUTATION_TRANSPORT_TIMEOUT_MS` + ticket 基类型 + `captureInput`/`authorityWitness` 泛型工厂；保持所有错误消息逐字节不变 |
| F1.3 | 写 ack-hardening 自测 | 20min | `excel/spreadsheet-ui-core/test/ack-hardening.test.ts`（新建） | 覆盖：冻结、超时/成功、ticket 生命周期 |
| F1.4 | editing 模块迁移 | 30min | `src/editing/index.ts` | `npx jest excel/spreadsheet-ui-core/test/editing.test.ts --runInBand` 绿 |
| F1.5 | history 模块迁移 | 30min | `src/history/index.ts` | `npx jest excel/spreadsheet-ui-core/test/history.test.ts --runInBand` 绿 |
| F1.6 | filter-sort 模块迁移 | 30min | `src/filter-sort/index.ts` | `npx jest excel/spreadsheet-ui-core/test/filter-sort.test.ts --runInBand` 绿 |
| F1.7 | operations 模块迁移 | 30min | `src/operations/index.ts` | `npx jest excel/spreadsheet-ui-core/test/operations.test.ts --runInBand` 绿 |
| F1.8 | paste-special 模块迁移 | 30min | `src/paste-special/index.ts` | `npx jest excel/spreadsheet-ui-core/test/paste-special.test.ts --runInBand` 绿 |
| F1.9 | remove-duplicates 模块迁移 | 30min | `src/remove-duplicates/index.ts` | `npx jest excel/spreadsheet-ui-core/test/remove-duplicates.test.ts --runInBand` 绿 |
| F1.10 | 最终验证 | 5min | — | grep 只剩 1 处定义；`src/index.ts` 零变化；两套 Jest 全绿 |

---

### G 链：fill undo 聚合

**优先级**：P2 | **预计**：2h | **依赖**：F 链完成

| ID | 任务 | 耗时 | 文件 | 验收 |
|---|---|---|---|---|
| G1.1 | 审计兜底路径 | 15min | `excel/spreadsheet-ui-core/src/auto-fill/index.ts` | 确认 `runAutoFillAtom` 逐格写入逻辑 + `MAX_UI_FILL_FALLBACK_CELLS = 200` |
| G1.2 | 评估 `MAX_HISTORY_SIDE_PAYLOADS = 64` vs 200 | 15min | `src/history/` | 决策：行程压缩 还是 单独上限 |
| G1.3 | 实现复合 history entry | 30min | `src/history/index.ts` | N 次 `setCellInput` 逆操作聚合为单条 entry |
| G1.4 | 实现 undo 执行逻辑 | 20min | 同上 | 逆序回放；任一失败 → outcome-unknown（不半撤销） |
| G1.5 | 补测试 | 15min | `excel/solid-excel/test/vnext-fill-series.test.ts` | 兜底宿主填 5 格 → 历史 +1 → Ctrl+Z 全还原 |
| G1.6 | 回归 | 10min | — | parity + fill-series 全绿 |

---

### H 链：lint 旧债逐文件清理

**优先级**：P2 | **预计**：3h | **可与 G 链并行**

| ID | 任务 | 耗时 | 文件 | 规则 |
|---|---|---|---|---|
| H1.1 | format-painter | 15min | `test/format-painter.test.ts` | max-len |
| H1.2 | find-replace | 15min | `test/find-replace.test.ts` | max-len |
| H1.3 | conditional-formatting | 15min | `test/conditional-formatting.test.ts` | max-len + 未使用导入 |
| H1.4 | frozen-panes | 15min | `test/frozen-panes.test.ts` | max-len |
| H1.5 | menu | 15min | `test/menu.test.ts` | max-len |
| H1.6 | viewport | 15min | `test/viewport.test.ts` | max-len |
| H1.7 | toolbar | 15min | `test/toolbar.test.ts` | max-len |
| H1.8 | selection | 15min | `test/selection*.test.ts` | max-len |
| H1.9 | workspace | 15min | `test/workspace.test.ts` | max-len + 未使用常量 |
| H1.10 | protection | 15min | `test/protection.test.ts` | max-len |
| H1.11 | history.test.ts 拆分 | 20min | `test/history.test.ts` | `max-lines-per-function`：1192 行箭头函数 → 按 describe 块拆 |
| H1.12 | 回归 | 10min | — | 涉及文件 eslint 零错误 |

---

## 四、验收门禁

### Wave 1 出口

```bash
# P0
npx jest excel/solid-excel/test/vnext-auto-fill-static-wasm-parity.test.ts --runInBand  # 全绿，无 FIXME
npx jest excel/solid-excel/test/static-formula-eval.test.ts --runInBand                   # 全绿
cd excel/rust/excel-core && cargo test --test architecture_invariants                    # 全绿
cargo test                                                                          # 全绿

# P1
npx tsc -b                                                                          # 零错误
npm run eslint                                                                      # solid/* 被正常解析（先只读评估）
npx jest core/react/test/asyncWith.test.tsx --runInBand                           # 连续 10 次零失败
```

### Wave 2 出口

```bash
grep -rn 'function snapshotAcknowledgement' excel/spreadsheet-ui-core/src  # 仅 1 处
grep -rn 'runBoundedOperation' excel/spreadsheet-ui-core/src               # 仅 1 处
npx jest excel/spreadsheet-ui-core --runInBand                              # 全绿
npx jest excel/solid-excel --runInBand                                              # 全绿
npx tsc -b                                                                     # 零错误
```

### Wave 3 出口

```bash
# G 链
npx jest excel/solid-excel/test/vnext-fill-series.test.ts --runInBand               # 含 fill undo 聚合用例

# H 链
npx eslint --config rules/.eslintrc --ignore-path rules/.eslintignore \
  'excel/spreadsheet-ui-core/test/**/*.ts'                                   # 零错误（涉及文件）
```

---

## 五、风险备忘

| ID | 风险 | 级别 | 缓解 |
|---|---|---|---|
| C1.5 | eslint solid/* 存量超过 200 个 | 🟡 中 | `.eslintignore` 临时豁免 + 新文件生效 + 分期还债 |
| D1.10 | `CustomFormulaCallable` 改参数影响 worker 路径 | 🟡 中 | 改前先确认 range 实参路径有测试覆盖 |
| E1.2 | fake timers 难以模拟微任务/宏任务交错 | 🟢 低 | Plan B：放宽超时 |
| F1.4-F1.9 | 迁移中错误消息字符串变化导致测试挂 | 🟡 中 | 逐字节保持；每迁一个跑测试 |
| F1.1 | `15000` 常量散落超过 10 个文件 | 🟢 低 | 收敛为 `MUTATION_TRANSPORT_TIMEOUT_MS`，原模块 re-export 保持 API 不变 |
| G1.2 | 64 vs 200 载荷上限冲突 | 🟡 中 | 行程压缩连续区间（首选）或复合条目单独上限 |

---

## 六、禁止事项

- ❌ H1.11（history.test.ts 拆分）**不要在 F1.5 之前做**——趁 ack-hardening 迁移时顺手拆
- ❌ F 链**不许一把梭**——必须逐模块迁移、每迁一个跑测试
- ❌ A1.2/A1.3 **不要引入新的依赖或改 AST 结构**——只是加一个 token 类型
- ❌ C1.3 eslint **不要 `--fix`**——只读扫描输出报告
- ❌ Wave 1 没全绿**不要开 Wave 2**
- ❌ 公共 API（`src/index.ts`）**不能变更导出面**

---

## 七、附录：REMOTE 公式重启指引（Wave 4，可选）

若决定重启，按以下 7 步顺序执行（吸取上次半成品教训，每层接通后再做下层）：

### Step 1：端口先行
`SpreadsheetBackend` 增加可选 `registerRemoteResolver(key, fn)` / `unregisterRemoteResolver(key)`，UI core 按既有惯例在宿主缺端口时隐藏入口。

### Step 2：capability 家族
仿照 auto-fill 的 scoped witness（`worker-protocol.ts` 的 `{scope:'auto-fill'}` 模式）声明 remote 能力，fail-closed：TS worker 明确 `remote: false` + 结构化 UNSUPPORTED。

### Step 3：引擎
`sheet.rs` 的 `call_custom` 加 REMOTE 前置分支（走 async-custom memo/pending 基建）；`ValueError::Remote` 同时接进 `excel/rust/wasm` 的 error token 表**双向**（`error_token_to_value_error` 与输出方向都加 `#REMOTE!` 分支）——上次正是漏了这一层导致错误契约全部退化成 `#VALUE!`。

### Step 4：名字保留
自定义公式注册路径拒绝 `REMOTE` 名（引擎会先截胡，注册了也是死的），`engine-builtin-names.ts` 影子表同步。

### Step 5：pump
`async-custom-pump.ts` 加 `routeRemote` hook；worker 内的 postMessage 往返 router 注意**每个 runtime 实例只挂一次监听**（上次的 TS-worker 实现按 `createWorkerRuntimeTs()` 调用次数重复挂监听，跨 jsdom 测试泄漏且 callId 序列可能串线）。

### Step 6：主线程 adapter
`worker-workbook-backend.ts` 处理 `remote-call` → 查 resolver → `remote-result` 回传；无 resolver 回 `#NAME?`，reject/超时回 `#REMOTE!`。

### Step 7：验收线
engine native 测试 + worker 双 runtime 一致性测试 + 主线程 round-trip jest + Playwright e2e（真实 resolver mock 数据）。每层接通前不动下一层，禁止再出现"设计文档描述的架构与代码不一致"的状态。
