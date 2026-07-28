# 2026-07-27 分支抢救遗留清单（follow-ups）

## 背景

`claude/rust-core-state-plan-Auzcj` 上曾有一批 16.6k 行的未提交改动（12aafc3 之后，
另一 AI 所写）。经全量审查后按块处置，落为 4 个 commit：

| commit | 内容 |
|---|---|
| `7849d88` | chore：`.codegraph/`、`.agent-archive/` 进 gitignore |
| `a1ede9a` | style：excel-core 纯 rustfmt 噪音（逐 token 验证零语义变化） |
| `fe88a3f` | feat：引擎持有的 auto-fill（Excel parity 语义 + static⇄WASM 金 parity 套件） |
| `066494c` | refactor：ui-core ACK 加固扫荡（4 处被翻转的既定语义已还原） |

**已整体撤回、不在树上**：REMOTE 公式全链路（半成品，主线程 resolver 缺失）、
text-to-columns 加固重构（烂尾：`ticketIsCurrent` 删了定义留了 9 处调用）。

以下是审查中确认、但**本轮未做**的事项。按优先级分组；每项给出现状证据、
解决方案、验收标准与工作量预估。

---

## P0 —— 会直接产生错误结果或掩盖回归的

### 1. static 求值器缺"裸错误字面量"语法 → `#REF!` 公式回读为 `#ERROR!`

**现状**：auto-fill 的 fillRange 把相对引用移出网格时，两个引擎都会把公式重写为
`=(#REF!+$C$1)` 这类含错误字面量的文本。WASM（Rust parser）有专门的
`#REF!` error-literal token，重新解析求值得 `#REF!`；static 的
`excel/solid-excel/src-vnext/adapter/static-formula-eval.ts` 的 tokenizer **没有**
表达式内裸错误字面量的语法规则，整条公式 tokenize 失败，单元格读成 `#ERROR!`。

**证据**：`excel/solid-excel/test/vnext-auto-fill-static-wasm-parity.test.ts` 场景 7，
文件头与用例上均有 FIXME，当前按"以 WASM 为准"分别钉住两侧现值。

**解决方案**：
1. 在 static-formula-eval 的 tokenizer 里加一类 `ErrorLiteral` token，
   识别集合与 `excel/rust/wasm/src/lib.rs::error_token_to_value_error` 的表对齐：
   `#NULL!` `#DIV/0!` `#N/A` `#REF!` `#VALUE!` `#NAME?` `#NUM!` `#CYCLE!`
   `#TYPE!` `#ARGS!` `#SPILL!` `#CALC!` `#BUSY!`（注意 `#N/A` 无叹号结尾、
   `#NAME?` 以问号结尾，正则要单列）。
2. parser 把该 token 直接产出为错误值节点；求值时按现有错误传播路径处理
   （任何算术/比较中错误值短路传播，与 Rust 侧一致）。
3. 改 parity 测试：场景 7 两侧都断言 `#REF!`，删除 FIXME。
4. 顺带补一个 static 单测：直接 `setCellInput('=#REF!+1')` 回读 `#REF!`。

**验收**：parity 套件场景 7 双侧一致且无 FIXME；`npx jest excel/solid-excel` 全绿。
**工作量**：小，约半天。tokenizer 是纯函数，无状态迁移风险。

### 2. WASM `setFormatRange` 不识别 `numberFormat.kind: "number"` 别名

**现状**：`SpreadsheetCellFormat` 文档声明 `"number"` 是 `"decimal"` 的别名，
但 `excel/rust/wasm/src/lib.rs` 的 wire 反序列化只认 `"decimal"`；传 `"number"` 时
格式被丢弃（deny_unknown_fields 之外的枚举 variant 不匹配路径）。宿主按文档
写代码会静默丢格式。

**证据**：parity 套件构建期间用纯 `setFormatRange` + 回读复现（与 auto-fill 无关，
是既有 marshaling 缺口）；parity 场景 10 特意用 `"decimal"` 绕开了它。

**解决方案**：
1. Rust 侧 wire 枚举加 serde 别名：`#[serde(alias = "number")]` 到 decimal
   variant（保持输出仍为 `"decimal"`，只放宽输入）。
2. 加 native 测试：`"number"` 输入 → 回读 kind 为 decimal、格式生效。
3. 全面对照 `SpreadsheetCellFormat` 类型文档，grep 其它声明过别名的字段
   （date/percent/currency 等）是否有同类缺口，一并补齐。
4. 记得同 commit 内跑 WASM API 快照门禁（若签名有变）：
   `cd excel/rust/excel-core && cargo test --test architecture_invariants wasm_snapshot_generate -- --ignored`

**验收**：新增 native 测试绿；`"number"` 别名端到端生效。
**工作量**：小，1-2 小时。

---

## P1 —— 质量门禁的洞，越拖越贵

### 3. `rules/.eslintrc` 漏配 `solid/*`，整个 excel/solid-excel 从未被行级 lint

**现状**：`parserOptions.project` 列表缺 `./solid/*/tsconfig.json`，导致所有
`excel/solid-excel/**` 文件在 `npm run eslint` 与定向 `npx eslint --config rules/.eslintrc`
下**解析直接失败**（在完全未改动的 `excel/solid-excel/src-vnext/public.ts` 上可复现），
任何行级规则（含 max-len）从未对该目录生效。这是 HEAD 就存在的门禁盲区。

**解决方案**：
1. `rules/.eslintrc` 的 `parserOptions.project` 增加 `./solid/*/tsconfig.json`。
2. 先做**只读**定向扫描评估规模（切勿直接跑 `npm run eslint`——它是全仓 `--fix`，
   会顺手改动 apps/ 等并行工作区）：
   `npx eslint --config rules/.eslintrc --ignore-path rules/.eslintignore 'excel/solid-excel/**/*.{ts,tsx}'`
3. 视错误规模决定：一次性机械清理 commit，或在 `rules/.eslintignore` 里临时
   豁免存量文件、只对新文件生效，再分批还债。
4. Solid JSX 可能需要 overrides（如 `no-unused-vars` 对 JSX 组件引用的误报），
   参考 react 目录现有 overrides 的写法。

**验收**：`public.ts` 等 solid 文件能被正常解析并出具规则结论；
`npm run eslint` 全仓可跑通。
**工作量**：配置改动 10 分钟；存量清理规模未知（先扫描再定，预留半天到一天）。

### 4. 测试空间 tsc 全绿化（HEAD 旧债 38 处 + 1 处 src 旧债）

**现状**：`npx tsc -b` 在**本次未碰过**的测试文件里有约 38 个错误
（format-painter、find-replace、conditional-formatting、frozen-panes、menu、
viewport、toolbar、selection、workspace、protection、effective-hidden 等），
Jest 因 SWC 剥类型而看不到。另有 1 处 src 旧债：
`excel/solid-excel/src-vnext/adapter/worker-runtime.ts:368` 的
`CustomFormulaCallable` vs `AsyncCustomCallable` 参数类型不匹配
（已验证 HEAD 同样报错，非本次引入）。

**错误模式与对应解法**：
- `it.each(readonly tuple)` 回调参数不兼容（viewport/toolbar/effective-hidden）：
  表数据 `as const` 后回调签名写成 `(...args: (typeof TABLE)[number])` 或给
  `it.each` 显式泛型参数；机械替换。
- TS6133 未使用导入/常量（conditional-formatting、workspace、selection、
  filter-sort 的 `*_IS_READ_ONLY` 常量块等）：确认真死代码后删除；若是
  "只为类型断言存在"的常量，改用 `void expr` 或 `satisfies`。
- protection.test.ts TS2559 mock 形状与 `SheetProtectionPersistencePort`
  无交集：mock 补上端口方法或改成 `Partial<Port>` + 显式断言。
- worker-runtime.ts:368：把 `CustomFormulaCallable` 的参数类型对齐
  `AsyncCustomArg[]`（后者含二维数组 range 实参——对照
  `excel/rust/excel-core/src/CUSTOM_FORMULAS.md` § Marshaling），或让 pump 的
  `lookup` 泛化。改前先确认 range 实参路径有测试覆盖。

**验收**：`npx tsc -b` 全仓零错误，并考虑把它加进 pre-commit（见第 8 条备注）。
**工作量**：半天到一天，几乎全是机械改动。

### 5. react `asyncWith.test.tsx` 在全量跑时 flaky

**现状**：`npm test`（全量、带覆盖率、并行 worker）下偶发失败；单独跑 5/5 稳绿。
典型的真实计时器 + 并行负载饥饿问题（用例内有 1.5-2s 的真实等待）。
这是 pre-commit 门禁的一部分，flaky 会随机挡住所有人的提交。

**解决方案**（按优先序）：
1. 改用 `jest.useFakeTimers()` + `advanceTimersByTime` 重写等待逻辑，
   消灭真实计时依赖（根治）。
2. 若组件行为依赖真实微任务/宏任务交错难以 fake：把 `waitFor` 超时从默认
   1s 提到 10s，并给该套件 `jest.setTimeout(30_000)`（缓解）。
3. 不建议 `jest.retryTimes`——只是把 flaky 藏起来。

**验收**：连续 10 次 `npm test` 全量运行该套件零失败。
**工作量**：小，2-3 小时（fake timers 重写含验证）。

---

## P2 —— 结构性还债与产品补齐

### 6. ack-hardening 模板抽共享 helper（8 个模块重复）

**现状**：`066494c` 落地后，`snapshotAcknowledgement` 在 8 个模块各有一份、
`runBoundedOperation` 3 份、`15_000` 超时常量散在 10 个文件、
`capture*Input`/ticket/authority-witness 脚手架逐模块复制。约占该 commit
一半行数。是审查确认的最大结构性债务；每新增一个 mutation 模块就会再抄一遍。

**解决方案**：
1. 新建 `excel/spreadsheet-ui-core/src/internal/ack-hardening.ts`
   （**不**从包入口导出——内部模块，避免变成公共 API）：
   - `snapshotAcknowledgement(ack, spec)`：按字段规格提取+冻结 ACK 快照；
   - `runBoundedOperation(run, timeoutMs, timeoutError)`：统一超时竞速；
   - `FILTER_SORT_DEFAULT_TIMEOUT_MS` 等常量收敛为一个
     `MUTATION_TRANSPORT_TIMEOUT_MS = 15_000`（各模块 re-export 保持现有
     导出名不破坏公共 API）；
   - ticket 基类型 + `captureInput`/`authorityWitness` 泛型工厂。
2. **逐模块迁移，每迁一个跑一遍该模块测试**（editing → history → filter-sort →
   operations → paste-special → remove-duplicates），不要一把梭。
3. 注意：多个测试钉住了错误消息字符串与 debugLabel，迁移时保持字符串逐字节
   不变，或在同一 commit 内同步更新对应断言。
4. text-to-columns 当时被整体撤回，如日后重做加固，直接基于共享 helper 写，
   不要再复刻旧模板（旧版失败原因见背景节）。

**验收**：`grep -rn 'function snapshotAcknowledgement' excel/spreadsheet-ui-core/src`
只剩 1 处定义；两套 Jest 全绿；公共 API 导出面（`src/index.ts`）零变化。
**工作量**：1-2 天。风险中等（大面积机械迁移），务必分模块提交。

### 7. 无 `fillRange`/`importCells` 端口宿主的逐格填充 undo（Excel 是单步）

**现状**：`runAutoFillAtom` 的兜底路径（宿主只实现了必选的 `setCellInput`）
逐格写入并逐格压历史，一次填充最多产生 `MAX_UI_FILL_FALLBACK_CELLS = 200`
条 undo 记录；Excel 语义是一次填充 = 一步撤销。HEAD 时代的 grid 内联代码
同样如此（非本次回归），但现在该行为被固化进了 ui-core。真实后端
（worker/static）都走批量端口，不受影响——所以是低优先级。

**解决方案**：
1. 在 history 增加一种复合条目（或复用 `cells.import` 条目形状）：兜底路径
   把 N 次 `setCellInput` 的逆操作聚合进单条 entry 的 side payload
   （现有 `MAX_HISTORY_SIDE_PAYLOADS = 64` 上限需评估：200 格 > 64，
   要么提高该路径的载荷编码密度——按行程压缩连续区间——要么给复合条目
   单独的上限声明，遵守"有界缓存必须声明上限"的约定）。
2. undo 执行时逆序回放逆操作；任何一格失败 → 整条 entry 走既有
   outcome-unknown 路径（不能半撤销）。
3. `vnext-fill-series` 加用例：兜底宿主填 5 格 → 历史长度 +1 → 一次 Ctrl+Z
   全部还原。

**验收**：兜底路径单条历史；真实后端路径行为不变（parity 套件回归绿）。
**工作量**：一天。先做第 6 条再做这条会省力（复用共享 helper）。

### 8. ui-core 触碰文件里的 lint/type 存量旧债（101 个 lint 问题）

**现状**：本次只清了 diff 涉及行上的 70 个；同批文件的未触碰行上还有
41 个 max-len + `no-use-before-define`(7) + `no-unused-vars`(19) +
`max-lines-per-function`(11，如 history.test.ts 单箭头函数 1192 行) +
`consistent-type-imports`(2)。均为 HEAD 旧债。

**解决方案**：与第 4 条合并成一个"测试空间卫生"commit 处理即可；
`max-lines-per-function` 的 1192 行测试体建议趁第 6 条迁移时顺手按
describe 块拆分，不单独立项。完成后评估把
`npx tsc -b` 加入 pre-commit（当前 hook 是 `npm run build && npm test`；
注意 memory 里的坑：build 失败会清空包产物）。

---

## 备案（不立项，仅记录）

- **static 求值器不支持跨表引用**（`Sheet!A1`）：`static-formula-eval.ts` 头部
  已声明"worker backend covers those"，是演示后端的既定边界。若日后要补，
  跨表环检测在 Rust 侧已有 `closes_workbook_cycle` 可对照。不建议在演示
  求值器上加戏。
- **`escapeAutoFillOpaqueRevisionWitness`**：曾评为过度工程，但有测试钉住
  lone-surrogate 全域性（任意宿主 `ProjectionRevision` 字符串可安全嵌入），
  且已收窄到 auto-fill 专用推进路径。保留；除非重构 revision 语义否则不动。
- **`DisplayCell.format` 投影冗长度差异**（WASM 全展开 vs static 稀疏）：
  两者描述同一有效格式；parity 套件用 `normalizeFormat` 归一后比较。
  若未来做格式序列化对外导出，再统一。

---

## 附：REMOTE 公式重启指引（已撤回，路线图仍在 wave-8 § 8.1）

本轮撤回的实现是半成品：worker 往主线程 post `remote-call`，但主线程监听、
resolver 注册端口、capability 声明全部缺失，任何 `=REMOTE(...)` 只会挂在
`#BUSY!` 直到超时。若重启，按以下顺序做（吸取本次教训，每层做完接通再做下一层）：

1. **端口先行**：`SpreadsheetBackend` 增加可选 `registerRemoteResolver(key, fn)` /
   `unregisterRemoteResolver(key)`，UI core 按既有惯例在宿主缺端口时隐藏入口。
2. **capability 家族**：仿照 auto-fill 的 scoped witness（`worker-protocol.ts`
   的 `{scope:'auto-fill'}` 模式）声明 remote 能力，fail-closed：TS worker
   明确 `remote: false` + 结构化 UNSUPPORTED。
3. **引擎**：`sheet.rs` 的 `call_custom` 加 REMOTE 前置分支（走 async-custom
   memo/pending 基建，本次撤回的那 8 行方向是对的）；`ValueError::Remote` 同时
   要接进 `excel/rust/wasm` 的 error token 表**双向**（`error_token_to_value_error`
   与输出方向都加 `#REMOTE!` 分支）——上次正是漏了这一层导致错误契约全部
   退化成 `#VALUE!`。
4. **名字保留**：自定义公式注册路径拒绝 `REMOTE` 名（引擎会先截胡，注册了
   也是死的），`engine-builtin-names.ts` 影子表同步。
5. **pump**：`async-custom-pump.ts` 加 `routeRemote` hook；worker 内的
   postMessage 往返 router 注意**每个 runtime 实例只挂一次监听**（上次的
   TS-worker 实现按 createWorkerRuntimeTs() 调用次数重复挂监听，跨 jsdom
   测试泄漏且 callId 序列可能串线）。
6. **主线程 adapter**：`worker-workbook-backend.ts` 处理 `remote-call` →
   查 resolver → `remote-result` 回传；无 resolver 回 `#NAME?`，reject/超时回
   `#REMOTE!`。
7. **验收线**：engine native 测试 + worker 双 runtime 一致性测试 + 主线程
   round-trip jest + Playwright e2e（真实 resolver mock 数据）。每层接通前
   不动下一层，禁止再出现"设计文档描述的架构与代码不一致"的状态。
