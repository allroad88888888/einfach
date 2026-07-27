# 隐藏/筛选下沉：遗留工作计划（2026-07-28）

## 背景与口径纠正

`design-engine-hidden-rows.md` 的 E9 收敛块（2026-07-22）已确认：**E0–E8 全量
落地**（`2fd3cc5` `82f4283` `8ffd9ff` `7dc8667` 等），E9 文档收口完成，设计稿
转为「设计 + as-built 记录」。**任何仍写着「剩 E5–E9」的口径都已过期**（含
agent 记忆），以本文档为准。

现行契约要点（详见设计稿 §0）：引擎 `Sheet` 拥有手动隐藏与筛选隐藏两集合；
worker 谓词在 Rust 内求值，static 保留 TS 谓词（`filter-predicate.ts`）；
筛选 undo 走引擎快照 `snapshotFilters`/`restoreFilters`；UI-core 渲染缓存靠
`reconcileFilterHiddenFromEngine` re-hydration。

遗留的活只有下面两件 + 若干备案。

---

## 1. P1：worker 暴露 `hideRows` / `unhideRows` ACK 端口——「零推送」终局

（设计稿修正 6 点名的 adapter 活，E7 范围外欠账）

**现状证据**（as-built 修正 6、E9 收敛第 3 条）：

- worker 适配器从未把 `hideRows` / `unhideRows` 暴露进 `SpreadsheetBackend`。
  E5 只暴露了 `setFilterSort` + `readSheetHiddenState`
  （`worker-workbook-backend.ts:4077/4088`，`engineHiddenState` 门禁）；
- 手动隐藏的引擎 feed 一直是 `setEvalHiddenRows`（**整集替换**，`:4147`，
  `evalHiddenRows` 门禁），E7 把它从被删的 bridge 搬进
  `viewport/hidden.ts` `feedAndReconcileHiddenRows`（乐观写 + 无条件对账）；
- `hideRows`/`unhideRows` 在 UI-core 里只是「两者皆无时」的 fire-and-forget
  后备，worker 上不可达（static 后端有这两个端口）；
- 即：**「宿主推整集」没有消失，只是从 bridge 搬进了 atom**。设计稿 §4.2 的
  「引擎 ACK 写、零推送」终局要先补 adapter 端口才可达。

**解决方案**（自底向上，每层接通再动下一层）：

1. **wire**：`worker-protocol.ts` 增 `hide-rows` / `unhide-rows` 请求-ACK 消息，
   带 `requestId`/`revision`（照既有 mutation 惯例）。引擎方法 `hide_rows` /
   `unhide_rows` E5 已落在 `sheet.rs`（E9 收敛第 1 条），只欠 wire 暴露；
   worker-runtime 分发到 WASM，ACK 回带应用后的集合摘要供对账。
2. **adapter**：`worker-workbook-backend.ts` 暴露 `hideRows` / `unhideRows`
   端口（挂 `engineHiddenState` 同一 capability 门禁即可，不必新造）。
3. **UI-core**：`feedAndReconcileHiddenRows` 改三态——宿主有 ACK 端口 →
   增量 ACK 写；只有 `setEvalHiddenRows` → 现状整集替换（回落）；两者皆无 →
   维持现状。**无条件对账回读（`readSheetHiddenState`）保留**——它已被证明
   是兜住一切 feed 形态分歧的安全网（修正 12 副作用记录：static 上同值中性）。
4. **退休**：两后端都具 ACK 端口后，整集 feed 降为回落路径、fire-and-forget
   后备删除。WASM 的 `set_eval_hidden_rows` 端口按 INV-4 加法式包袱保留。
5. **undo 语义不动**：手动侧 local-replay + `feedAndReconcileHiddenRows`
   恢复已由修正 11 裁定为唯一恢复路径，本项不碰。

**硬规则（全部来自 as-built 踩坑）**：

- 快照/状态按 **sheet 索引**键，不是名字（修正 3）；
- 不许造第二条恢复路径（§10.2-7 双恢复警告，修正 11 的裁定理由）；
- 修正 6 的实测回归点是验收基线：隐藏行后 `G2=SUBTOTAL(109)` 必须实时变化
  （上次 bridge 误删后它停在旧值，就是这个信号暴露的）；
- 已钉数量级不许退化：乐观重绘 ~11ms、SUBTOTAL 落定 ~19ms、撤销 ~20ms。

**验收**：

1. worker + static 双后端 parity 断言 `hideRows`/`unhideRows` 端口存在且语义一致；
2. SUBTOTAL 101–111 隐藏排除实时生效（UI smoke + jest 双验）；
3. `#27` 结构位移 e2e（`vnext-filter-structural-shift-real-backend.spec.ts`）绿；
4. `grep -n 'setEvalHiddenRows' vanilla/spreadsheet-ui-core/src` 只剩回落分支；
5. 撤销/重做全绿；两套 vnext jest 套件全绿。

**工作量**：1–2 天（wire + adapter + atom 三层；引擎方法已在，无 Rust 新语义）。

## 2. P2：`filter-predicate.ts` 头部注释过期

**现状**（E9 收敛第 2 条）：E4 落地时 worker 仍用它故取中性名；E5 后 worker
谓词已进 Rust（`worker-workbook-backend.ts` 零 `buildFilterSortDisplayRows`
命中），该文件已 static-only，但头部注释仍写「E5 removes it / both adapters」。

**解决方案**：只改注释——声明「static 后端专用的第二引擎谓词；worker 谓词在
`rust/excel-core/src/filter.rs`；两者行为由 parity 套件钉住」。文件不改名
（历史提交与设计稿引用均用现名）。

**验收**：注释与现实一致。**工作量**：15 分钟，可搭任何顺风 commit。

---

## 备案（不立项）

- **`setEvalFilterHiddenRows`**：适配器已弃用，WASM 端口按 INV-4 加法式包袱
  保留。不删、不复用。
- **「一 sheet 一筛选」cap**：维持。任何与 Table（#32）挂钩的多筛选域扩展
  一律不做（既定裁定：跳过 Table）。
- **static 双 lane**：已按修正 8 退休（整集替换语义与 WASM 同构），无遗留。
