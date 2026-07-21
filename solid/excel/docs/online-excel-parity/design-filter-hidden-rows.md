# 设计｜筛选重做：从"显示压缩"到"隐藏行"

- **状态**：设计裁决稿（待主控派单）
- **日期**：2026-07-21
- **基线**：分支 `claude/rust-core-state-plan-Auzcj`；[CANONICAL_OWNERSHIP.md](./CANONICAL_OWNERSHIP.md) #29（筛选可见性 = UI-core 视图事实，翻转顺序第 3 步）
- **前置**：[design-engine-sort.md](./design-engine-sort.md) 已全量落地（物理排序 + `excludedRows`），本设计接手 #29 的另一半
- **范围**：把筛选从"匹配行压缩进连续 display 槽位 + `originalRow` 回映射"改为 Excel 语义的**隐藏行**（行号保留原值、跳号显示）。产品决定已拍板，本文只裁决实现形状。

---

## 0｜裁决摘要

| #   | 问题               | 裁决                                                                                                                                                                                       |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 隐藏集分几个       | **两个**：`viewportHiddenAtom`（手动隐藏，不动）+ 新增 `filterHiddenAtom`（筛选隐藏）。理由是三条硬约束而非洁癖：SUBTOTAL 两层规则、复制语义不对称、unhide 不得解筛选。Grid 取**并集**渲染 |
| 2   | 谁算筛选可见性     | **adapter 在应用筛选规则时（`setFilterSort`）一次性全列扫描**，把完整 filtered-out 源行集随 ACK 回传，UI-core 存进 `filterHiddenAtom`。**不**在投影期算——投影是有界窗口，谓词要全列        |
| 3   | 复算时机           | 快照语义，不随编辑实时重算（**与 Excel 一致**）；新增 `Data → Reapply` 命令（Excel `Ctrl+Alt+L`）作为显式重算入口                                                                          |
| 4   | 扫描上限           | 沿用既有 `MAX_FILTER_SORT_PREDICATE_CELLS = 50_000` 与 `FILTER_SORT_SOURCE_TOO_LARGE` 结构化拒绝，零新阈值                                                                                 |
| 5   | `originalRow`      | display 行 ≡ source 行恒等，**整字段删除**。W2 网关的**回映射半边全删**、**protection 门禁半边全留**；15 个依赖点逐个裁决见 §5                                                             |
| 6   | 引擎契约           | **新增独立端口 `setEvalFilterHiddenRows`**（不扩展既有 `setEvalHiddenRows` 参数）——INV-4 冻结面按 ADDITIVE 演进，手动隐藏那条已落地的链路零改动                                            |
| 7   | `fn_subtotal`      | `subtotal_hidden_for_arg` 从"`!ignore_hidden` 早退"改为**总是解析**：1-11 排除 filter 集，101-111 排除 manual ∪ filter；两 epoch 原子拆分，避免手动隐藏推送脏化 1-11 公式                  |
| 8   | 数据安全 blocker   | `remove-duplicates/algorithm.ts:186-204` 的稠密行扫描在隐藏语义下会把隐藏行判为全空重复行喂给 `removeRows` → **静默数据丢失**。加固必须**先于** adapter 翻转落地（切片序 S3 早于 S4）      |
| 9   | 顺带闭合的 parity  | filter 激活时 merge 元数据的整体抑制（`static-backend.ts:1686-1690`）可解除；`deriveFilterHiddenRows` 的有界窗口缺口消失；投影读回退为矩形范围读（性能）                                   |
| 10  | 复制 / 粘贴 / 填充 | 复制**只复制可见**（Excel 对 filter 隐藏自动生效，对手动隐藏**不**生效——见 §2）；粘贴与填充**照写隐藏行**（Excel 一致，恒等映射天然满足，零改动）                                          |

---

## 1｜背景与现状（as-is）

### 1.1 显示压缩筛选（现网）

筛选目前是**投影期显示压缩**：匹配行被搬进从 `startRow` 起的连续 display 槽位，不匹配行**没有 display 槽位**。

- 纯函数 `buildFilterSortDisplayRows`（`vanilla/spreadsheet-ui-core/src/backend/projection-helpers.ts:366-404`）产出 `displayRow → sourceRow` 稀疏数组。压缩发生在 `:399-401`：

  ```ts
  dataRows.forEach((row, index) => {
    rows[dataRowStart + index] = row
  })
  ```

  header 行 0 直通（`:387`）、summary 行（`isFilterSortSummaryRow`，`:341-347`）钉在末位、数据行 1 起压缩。行序恒为源序（排序支路已随 #24 退役，见函数头注释 `:360-365`）。

- 谓词 `rowMatchesFilterSortRules`（`:349-358`）+ `filterRuleMatchesValue`（`:91-112`）：equals / contains / range / list 四型，逐规则 AND。
- **static adapter**（`solid/excel/src-vnext/adapter/static-backend.ts`）：`buildFilterSortDisplayRows`（`:1341-1355`）取全表 `maxRow`，投影循环 `:1626-1665` 在 `filterSortActive` 分支里按 `displayRows[displayRow]` 走；`projectSourceCell`（`:1390-1425`）写 `clone.row = displayRow` 且 `clone.originalRow = sourceRow`，并把公式求值锚在 `sourceRow` 上（`:1414-1417`，注释明说 `[@Col]` 必须交到公式物理所在行）；`addFormatOnlyCells`（`:1265-1295`）同样按 `displayRows` 走并补 `originalRow`。
- **worker adapter**（`solid/excel/src-vnext/adapter/worker-workbook-backend.ts`）：`computeFilterSortDisplayRows`（`:2129-2178`）**已经是全列扫描**——`listNonEmpty` 探 sheet 行界，每个谓词列一次 `readSparseRange`，总量受 `MAX_FILTER_SORT_PREDICATE_CELLS = 50_000`（`:208`）约束，超限抛 `FILTER_SORT_SOURCE_TOO_LARGE`（`:209`），**不截断**。结果缓存在 `filterSortDisplayRowsBySheetId`（`:1277`），revision bump 时整体清（`:1359`）、按 sheet 清（`:1967`）。`setFilterSort`（`:4074-4099`）在 ACK **之前**算好排列再落缓存。
- 读投影走 `readFilteredRange`（`:2196-2290`）：display 窗口 → `MappedDisplayRow[]`（`:749`）→ 因压缩后源行散布而必须取 `[minSourceRow..maxSourceRow]` 包围盒 → 逐格 `readCells` refs → 回写时重新盖 `cell.row = displayRow; cell.originalRow = sourceRow`。overlay（validation `:752-829`、条件格式 `:876-898`、格式 `:940-953`）一律用 `cell.originalRow ?? cell.row` 解源坐标。
- **W2 统一网关**（`vanilla/spreadsheet-ui-core/src/editing/mutation-gateway.ts`）：所有内容 mutation 先经 `resolveContentMutationAtom`（`:297-361`），第 1 步 display→source 回映射（`:143-238`），第 2 步 protection 门禁（`:329-349`）。回映射靠"任一 cell 带 `originalRow`"作为激活开关（`:150`），一个连续 display 区间可能裂成多个源行 run（`:213-238`）。
- **S6 遗留缺口**：`deriveFilterHiddenRows`（`vanilla/spreadsheet-ui-core/src/filter-sort/index.ts:1358-1380`）为了给物理排序组 `excludedRows`，靠"扫投影窗口内 `originalRow` 的缺口"反推被筛掉的行。它自己的注释（`:1343-1356`）承认：只能在观察到的 `[minObserved..maxObserved]` span 内推断，**窗口外的被筛行推不出来**，是记录在案的 v1 缺口。

### 1.2 手动隐藏行（对照物 = 目标形态）

`vanilla/spreadsheet-ui-core/src/viewport/hidden.ts` 是本次要靠拢的形态，机制已完备：

- **UI-core 全量真值**：`viewportHiddenBackingAtom` 存 `rowsBySheet: Record<string, number[]>`（源行号，`sanitizeIndices` 去重升序，`:41-52`），只读投影 `viewportHiddenAtom`（`:86-89`）。文件抬头（`:21-28`）已把口径钉死：backend 的 `hideRows`/`unhideRows` 降级为 fire-and-forget 持久化镜像，`readViewportSizeProjection` 的 hidden 切片降级为**一次性 hydration 种子**，无 ACK 生命周期、无权威票据。
- **行号身份保留**：隐藏行不参与渲染，行号不重编。`SpreadsheetGrid.tsx:1355-1359` 的 `getRows()` 直接把隐藏行从窗口索引里 `filter` 掉，行头 `:3806-3823` 渲染 `{row + 1}` —— **Excel 的 1、4、7 跳号今天对手动隐藏行已经免费成立**。
- **窗口膨胀**：`viewport/window.ts:203-234` 的 `getVisibleWindowWithHidden` 按隐藏集把 `rowEnd` 往后推，保证窗口内可见行数与无隐藏时一致；`countVisibleIndices`（`:188-197`）配套。
- **结构位移**：`applyViewportHiddenStructuralShiftAtom`（`:509-542`）消费 `BackendMutationResult.structuralShift`，经 `remapIndexSetAfterStructuralShift` 让隐藏集随插入/删除行平移，删除带内的索引直接掉出。
- **undo**：`registerHistoryLocalReplayApplier(VIEWPORT_HIDDEN_REPLAY_KEY, …)`（`:556-575`）在 UI-core 内闭环，不经引擎快照。
- **推给引擎**：`solid/excel/src-vnext/provider/eval-hidden-rows-bridge.ts` 订阅 `viewportHiddenAtom`，按 sheet 序列化去重（`serializeRows`，`:40-42`），每次 fire 重读端口（`:50`，尊重异步 capability 见证），`Promise.all` 推完再 `refreshVisibleProjection`（`:76-81`）。单实例 owner 经 `WeakMap<Store, …>` 保证 Provider 重挂不会双推。

**关键对照**：手动隐藏是"UI-core 持有全量真值 + 单向推给引擎 + Grid 取集合过滤"，筛选目前是"adapter 持有排列 + 投影期压缩 + UI-core 反推"。本次就是把后者改造成前者。

### 1.3 引擎侧现状

- **存储**：`WorkbookAtomContext.eval_hidden_rows: RefCell<HashMap<usize, Rc<HashSet<u32>>>>`（`rust/excel-core/src/sheet.rs:946`），按 sheet index 键；放在 context 而非 `Sheet` 上，是因为所有 sheet 共享一个 `Store`，跨表 SUBTOTAL 必须从一个 provider 够到任意 sheet 的集合（`:933-945`）。
- **入口**：`Workbook::set_eval_hidden_rows(&mut self, sheet_index: usize, rows: &[u32])`（`rust/excel-core/src/workbook.rs:2472-2478`）。契约（`:2457-2471`）：**整集替换、幂等、空集清除、引擎不建 hidden 模型也不推断来源、越界 sheet 静默 no-op、custom-call 期间 no-op**。
- **失效**：单一 epoch 原子 `hidden_epoch` + `hidden_revision`（`sheet.rs:956-958`）；`depend_hidden`（`:1043-1046`）在探测**之前**建边（`hidden_rows_for_sheet`，`:1054-1062`），使当前无隐藏行的 101-111 公式也能在首次推送后重算；`hidden_rows_untracked`（`:1068-1070`）供 eager provider；setter（`:1077-1087`）先写侧存储再 bump epoch。
- **`fn_subtotal`**（`rust/excel-core/src/eval.rs:19932-19960`）：

  ```rust
  let (fn_norm, ignore_hidden) = if (1..=11).contains(&fn_int) {
      (fn_int as u32, false)
  } else if (101..=111).contains(&fn_int) {
      ((fn_int - 100) as u32, true)
  } else {
      return Value::Error(ValueError::InvalidValue);
  };
  ```

  `subtotal_hidden_for_arg`（`:19673-19692`）**在 `!ignore_hidden` 时早退 `None`** —— 这正是"1-11 从不看隐藏集、也从不建 epoch 边"的实现根因；解析出的 sheet index 按参数的**被引用表**取（跨表 ref 用被引表的集合）。`for_each_subtotal_value`（`:19700-19712`）按 `hidden.contains(&addr.row)` 跳过；标量/字面量参数 `addr == None`，永不过滤。`run_subtotal`（`:19722+`）9 个分支全部走这条流。

- **`AGGREGATE`**（`eval.rs:19962+`，dispatch `:9262`）：options 的 ignore-hidden 位（1/3/5/7）**解析并校验但被忽略**，硬编 `run_subtotal(…, false)`；`:20029-20035` 有在案 TODO(#32 §6.3)。
- **WASM**（`rust/wasm/src/lib.rs:2485-2489`）：

  ```rust
  #[wasm_bindgen(js_name = "setEvalHiddenRows")]
  pub fn set_eval_hidden_rows(&mut self, sheet_idx: u32, rows: Vec<u32>)
  ```

  JS 名 `setEvalHiddenRows`，入参 `number[] | Uint32Array`，返回 `void`，从不抛。

- **冻结面**：`rust/excel-core/tests/fixtures/wasm_api_signatures.txt` 第 57 行逐字记录了上面这条签名（含 `js_name` 与完整参数表）。消费者是 `rust/excel-core/tests/architecture_invariants.rs:407-440` 的 **INV-4** `wasm_public_api_signatures_unchanged`：删改是硬失败，新增失败并要求**同 commit 重生成**（生成器 `:486-504`，`cargo test --test architecture_invariants wasm_snapshot_generate -- --ignored`）。
- **贯通链**：端口 `setEvalHiddenRows?(request: SetEvalHiddenRowsRequest): Promise<void> | void`（`backend/types.ts:983`，请求型 `:655-661`）；协议 capability 键 `evalHiddenRows`（`worker-protocol.ts:380`）、client 方法（`:475`、`:815-817`）；WASM runtime dispatch（`worker-runtime.ts:1521-1541`，无 `assertSheet`，容忍越界）；TS runtime 声明 `evalHiddenRows: false`（`worker-runtime-ts.ts:126`）并 `unsupported()`（`:1509-1514`）；worker adapter `setEvalHiddenRowsThroughWorker`（`:3160-3167`）不是 mutation——无 exact ACK、无 undo、无 revision bump，靠引擎 epoch 触发的 `cellsDirty` 走常规内容变更路径；端口 getter 经 `runtimeSupports('evalHiddenRows')`（`:4156-4158`）。static 侧 `evalHiddenRowsBySheetId`（`:357`）与自有 `hiddenRowsBySheetId` 在 `evalHiddenRowsForSheet`（`:1212-1225`）取并集，注释（`:1188-1211`）明说**筛选隐藏行被刻意排除**，因为 MVP 推送源钉死在 `viewportHiddenAtom`。

---

## 2｜Excel 语义规范源（逐条确认 / 修正）

本次对齐的规范源。已核实的标 ✅，需实测的标 ⚠️ 待验证。

| 项                  | Excel 实际行为                                                                                                                         | 现网      | 本设计          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------- |
| 行号跳号            | ✅ 被筛掉的行不渲染，可见行**保留原行号**（1、4、7）。可见行号另显示为蓝色（纯视觉，本次可选）                                         | ✗         | ✓               |
| `SUBTOTAL(1-11)`    | ✅ **包含**手动隐藏行，**排除**筛选隐藏行                                                                                              | ✗         | ✓               |
| `SUBTOTAL(101-111)` | ✅ **两者都排除**                                                                                                                      | 半✓       | ✓               |
| 复制                | ✅ **不对称**：筛选区复制**自动只复制可见单元格**；手动隐藏行**照样被复制**（要跳过需 `Go To Special → Visible cells only` / `Alt+;`） | 偶然✓     | ✓（§8.2）       |
| 粘贴到筛选区        | ✅ 粘贴**连续块写入，含隐藏行**——这是 Excel 著名的数据覆盖陷阱，不是 bug                                                               | ✓         | ✓（不改）       |
| 填充 / 拖拽         | ✅ 填充柄**写入隐藏单元格**（默认行为，要跳过同样得走 Visible-cells-only）                                                             | ✓         | ✓（不改）       |
| 排序                | ✅ 可见行之间重排、隐藏行留原位                                                                                                        | ✓         | ✓（已落地）     |
| 删除行              | ⚠️ Excel 2013+ 在筛选区选中并删除行时**只删可见行**；但"选区跨隐藏行"的判定细节各版本有出入，需实测                                    | 偶然✓     | ✓（§8.3）       |
| 格式化筛选区        | ⚠️ 疑似只作用于可见单元格，需实测                                                                                                      | 偶然✓     | ⚠️ 待验证       |
| `AGGREGATE`         | ⚠️ ignore-hidden 走 `options` 位（1/3/5/7）而非 100+ 约定；"是否总是忽略筛选行"资料互相矛盾，需实测                                    | ✗         | **后续**（§11） |
| `Data → Reapply`    | ✅ 存在（`Ctrl+Alt+L`）。**推论**：Excel 的筛选结果是**快照**，编辑单元格不会即时重算可见性                                            | ✗（实时） | ✓（§4.3）       |

**"偶然✓"的含义**：现网压缩语义下这些行为是**副作用正确**——被筛行根本没有 display 槽位，所以复制/删除自然只碰到可见行。切到隐藏语义后这个免费午餐消失，必须**显式实现**，否则是回归。这是本设计最容易被漏掉的一类风险，§8 单列。

---

## 3｜裁决 1：两个隐藏集，Grid 取并集

**裁决**：`viewportHiddenAtom`（手动隐藏）**保持不动**；新增独立的 `filterHiddenAtom`（筛选隐藏）。**不合并**。

三条硬约束，任一条都足以否掉"合并成一个 Set"：

1. **SUBTOTAL 两层规则**（§2）。`SUBTOTAL(1-11)` 必须包含手动隐藏、排除筛选隐藏。合并集之后来源信息永久丢失，这条规则在架构上**无法表达**——这是本次重做的首要驱动。
2. **复制语义不对称**（§2）。筛选隐藏行复制时自动跳过，手动隐藏行照复制。同一个集合服务不了两种复制行为。
3. **生命周期与 undo 归属不同**：
   - 手动隐藏是**用户命令**，逐次进 history 走 local-replay（`hidden.ts:305-316`、`:556-575`），`unhideRowsAtom` 按选区差集清除。
   - 筛选隐藏是**规则的派生结果**，整集替换、随规则变化整体重算；它的 undo 就是筛选规则本身的 undo，**不得**产生独立的 history 条目。
   - 用户对被筛掉的行执行 `Unhide Rows`，Excel 里**不会**取消筛选。合并集会让 `unhideRowsAtom` 意外"解筛选"，且下一次投影刷新又被打回——一个不可解释的抖动。

**共性复用**（两集同构，代码可共享而状态分离）：

- 结构位移：`filterHiddenAtom` 同样消费 `structuralShift`，复用 `remapIndexSetAfterStructuralShift`。理由：插入/删除行后重扫全列代价与正确性都不如平移；且与手动隐藏行为一致。
- `sanitizeIndices` / `sameIndices` / 每 sheet `number[]` 存储形状，直接复用 `hidden.ts` 的既有私有函数（提取为共享模块，或 `filter-hidden.ts` 内复制 12 行——按 §10 切片 S3 的实现者裁量）。
- 上限：与 `MAX_FILTER_SORT_SHEETS = 256` 同级按 sheet 数有界；单 sheet 隐藏行数受 §4 的 50k 扫描上限天然界定，**不设第二个 cap**。

**Grid 渲染取并集**。改动点只有一处，且是纯加法：

```ts
// SpreadsheetGrid.tsx:1355-1359 现状
const hiddenRows = new Set(getHiddenRowsForSheet(hiddenState(), props.sheetId))
return getWindowIndexes(window.rowStart, window.rowEnd).filter((row) => !hiddenRows.has(row))
```

改为读一个 UI-core 侧的派生原子 `effectiveHiddenRowsAtom(sheetId) = manual ∪ filter`（派生，非新真值），`getHiddenRowSet()`（`:673-675`）与 `getRenderedVisibleWindow()` 喂给 `getVisibleWindowWithHidden` 的入参同源替换。**行号跳号因此零成本落地**——行头本来就渲染 `{row + 1}`（`:3806-3823`）。

同一个并集派生原子同时供给：`go-to` 的 `hiddenRows` 上下文（`go-to/index.ts:575`）、`remove-duplicates` 与 `text-to-columns` 的扫描跳过（§8.1）、复制的可见性过滤（§8.2）。**并集只在"渲染与可见性"语义下使用；凡是要区分来源的消费者（SUBTOTAL 推送、复制）必须读两个源子集。**

---

## 4｜裁决 2：谁计算筛选可见性

### 4.1 问题陈述

筛选谓词需要**全列数据**（判定第 N 行是否匹配，要读第 N 行的规则列），而投影是**有界窗口**。现网在投影期算（`buildFilterSortDisplayRows`），worker 侧靠 `computeFilterSortDisplayRows` 偷偷做了全列扫描才成立；UI-core 侧的 `deriveFilterHiddenRows` 则只能在窗口内反推，留下了 S5/S6 那个在案的 v1 缺口。

### 4.2 裁决：应用规则时一次性全列扫描，结果存进 UI-core

**adapter 在 `setFilterSort` 处理中做一次全列谓词扫描，把完整的 filtered-out 源行集随 ACK 回传；UI-core 写入 `filterHiddenAtom`。投影期不再做任何筛选计算。**

端口演进（`vanilla/spreadsheet-ui-core/src/backend/types.ts`）：

```ts
export interface SetFilterSortResult extends BackendMutationResult {
  /**
   * 0-based SOURCE rows the rules filtered out, for the WHOLE column extent —
   * not a window-bounded subset. Absent means the host cannot compute
   * visibility; UI core then keeps `filterHiddenAtom` empty (feature degrades
   * to "rules recorded, nothing hidden") rather than guessing.
   */
  hiddenRowIndices?: readonly number[]
}

setFilterSort?(request: SetFilterSortRequest): Promise<SetFilterSortResult>
```

`BackendMutationResult` 是既有 ACK 形状，`hiddenRowIndices` 为**可选加法**——旧 adapter 与 TS worker 不实现即自动降级，符合仓内"端口缺失即隐藏/降级"惯例，不需要新 capability 键。

**为什么是这里**：

1. **数据在 adapter 手上**。全列值是 backend 事实，UI-core 按分层规则不得直接读工作簿。
2. **扫描已经存在**。worker 的 `computeFilterSortDisplayRows`（`:2129-2178`）今天就在 `setFilterSort` 里做全列扫描（`:4088`），static 的 `buildFilterSortDisplayRows`（`:1341-1355`）取全表 `maxRow`。本裁决**不新增任何扫描**，只是把返回值从"display→source 排列数组"换成"隐藏源行集"——两者是同一次扫描的两种投影。
3. **频次正确**。一次规则变更扫一次，而不是每次投影读都推导。现网 worker 侧靠 `filterSortDisplayRowsBySheetId` 缓存（`:1277`）达到同样效果，本设计把这个缓存**上移成 UI-core 的真值**，缓存层随之删除。
4. **消灭有界窗口缺口**。`deriveFilterHiddenRows` 的"只能在观察 span 内推断"限制随之消失（§9.3 记为顺带闭合项）。

**成本与上限**：沿用既有 `MAX_FILTER_SORT_PREDICATE_CELLS = 50_000`（谓词列数 × 行数）与 `FILTER_SORT_SOURCE_TOO_LARGE` 结构化拒绝——**不新增阈值**，fail-closed 不截断，且"清空筛选"（无效果载荷）永不扫描，所以超限状态永远可退出（`:4070-4072` 既有裁决保留）。回传集合本身的规模上界即"隐藏行数 ≤ 扫描行数 ≤ 50k / 谓词列数"，与 `MAX_FILTER_LIST_VALUES = 10000`、named-ranges 500 等既有 cap 惯例同量级。

**被否掉的两个替代方案**：

- ❌ **继续在投影期算，然后把结果"存"进 UI-core**。投影是窗口，窗口外的隐藏行永远不进集合；滚动会让集合抖动；且违反"投影读是纯读"的既有性质。
- ❌ **UI-core 自己扫**。要么突破分层（直接读工作簿），要么发一串 `readRangeProjection` 把全列拉进主线程——比 adapter 内扫贵一个数量级，且把 50k 预算从 adapter 挪到消息通道上。

### 4.3 裁决 3：快照语义 + `Reapply`

集合在规则应用时算定，**编辑单元格不即时重算可见性**。

这不是妥协，是**与 Excel 一致**：Excel 的 `Data → Reapply`（`Ctrl+Alt+L`）存在本身就证明筛选结果是快照——把某行的值改成不再匹配，该行不会当场消失。现网压缩语义因为每次投影都重算，反而是**比 Excel 更"活"**的发散。

配套：

- 新增 UI-core 命令 `reapplyFilterAtom`：以当前 `filterSortStateAtom[sheetId]` 重发一次 `setFilterSort`，刷新 `filterHiddenAtom`。挂到 Data 菜单（`Reapply`）与 `Ctrl+Alt+L`。端口缺失时按惯例隐藏入口。
- 结构变更（插入/删除行）走 `structuralShift` 平移（§3），不触发重扫。
- 切表：`filterHiddenAtom` 按 sheet 存，切表天然隔离；`notifyActiveSheetChangedAtom`（`filter-sort/index.ts:1208`）的既有语义不变。

---

## 5｜裁决 3：`originalRow` 的去留

压缩取消后 **display 行 ≡ source 行恒等**（被隐藏的行不出现在投影里，出现的行行号即源行号）。`DisplayCell.originalRow`（`backend/types.ts:192-194`）**整字段删除**。

逐点裁决（15 个依赖文件，非测试）：

| 文件:行                                                                             | 用途                                                                                                                                                    | 裁决                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend/types.ts:192-194`                                                          | `originalRow?: number` 字段声明                                                                                                                         | **可删**（扇出原点）                                                                                                                                                                                                               |
| `backend/projection-helpers.ts:208`                                                 | `cloneCell` 携带                                                                                                                                        | **可删**                                                                                                                                                                                                                           |
| `backend/projection-helpers.ts:366-404`                                             | `buildFilterSortDisplayRows` 压缩本体                                                                                                                   | **语义改变**：返回型 `number[]`（display→source 数组）→ `Set<number>`（隐藏源行集）；`:374-379` 的 header 顺序不变式与 `:389-402` 的 summary 钉位退化为"summary 行永不隐藏"                                                        |
| `backend/projection-helpers.ts:341-358`                                             | `isFilterSortSummaryRow` / `rowMatchesFilterSortRules` 谓词                                                                                             | **需保留**（与压缩无关）                                                                                                                                                                                                           |
| `editing/mutation-gateway.ts:143-238`                                               | `getActiveRowRemapProjection` / `mapDisplayRowToSourceRow` / `mapDisplayCellToSource` 的 remap 体 / `mapDisplayRangeToSourceRanges` 全部（含 run 裂分） | **可删**                                                                                                                                                                                                                           |
| `editing/mutation-gateway.ts:325-327`                                               | `requireIdentityMapping` 门（恒不触发）                                                                                                                 | **可删**（含 `:59-60`/`:71-72` 两处接口字段与两个调用点：`text-to-columns/index.ts:1475-1479`、`paste-special/SpreadsheetPasteSpecialDialog.tsx:97-101`）                                                                          |
| `editing/mutation-gateway.ts:79/242/248`                                            | `'unmapped-row'` 原因 / 文案 / `MUTATION_UNMAPPED_ROW` 码                                                                                               | **可删**                                                                                                                                                                                                                           |
| `editing/mutation-gateway.ts:94/319-320/358`                                        | `AllowedContentMutation.remapped` 与 `ranges` 多段契约                                                                                                  | **可删**（`ranges` 退化为单段；约 20 个读结果的调用点需跟随改形）                                                                                                                                                                  |
| `editing/mutation-gateway.ts:119-136`                                               | `isValidCell` / `isValidRange` → `invalid-target`                                                                                                       | **需保留**                                                                                                                                                                                                                         |
| **`editing/mutation-gateway.ts:252-289/329-367`**                                   | **protection 门禁 + 诊断发布（`isRangeFullyUnlocked` / `locked` / `publishBlock`）**                                                                    | **必须保留**（与筛选无关，Excel 锁定单元格规则；`set-format-range` 同样受管）                                                                                                                                                      |
| `editing/README.md:21-57`                                                           | 两半机制文档                                                                                                                                            | **语义改变**（文档重写）                                                                                                                                                                                                           |
| `filter-sort/index.ts:1358-1380`                                                    | `deriveFilterHiddenRows` 窗口反推                                                                                                                       | **删除而非迁移**：改读 `filterHiddenAtom`                                                                                                                                                                                          |
| `filter-sort/index.ts:1392-1400`                                                    | `buildSortExcludedRows` 手动隐藏半边                                                                                                                    | **需保留**；筛选半边换源后两半同构，缺口闭合                                                                                                                                                                                       |
| `go-to/index.ts:821`、`go-to/types.ts:146-147`                                      | `GoToCandidateCell.originalRow` 回声（无下游读者）                                                                                                      | **可删**                                                                                                                                                                                                                           |
| `go-to/locator-engine.ts:160-185`                                                   | `scanVisibleCellsOnly` 直接吃 `hiddenRows`/`hiddenCols` 集合                                                                                            | **必须保留 —— 且是本次的样板**：注释已记录"旧的 `originalRow !== row` 启发式不可靠，本版直接用后端 hidden 状态"。筛选隐藏行须并入 `go-to/index.ts:575` 的 `hiddenRows`，否则 `Go To Special → Visible cells only` 会选中被筛掉的行 |
| `remove-duplicates/index.ts:666-690`                                                | 投影校验里的 `originalRow` 合法性与 `originalRowByVisualRow` 一致性检查                                                                                 | **可删**（`:682-685` 的坐标重复检查独立，需保留）                                                                                                                                                                                  |
| `remove-duplicates/algorithm.ts:136-168/198-202`                                    | `originalRowByRow` 映射与 `duplicateRows.push(sourceRow)`                                                                                               | **可删**（退化为 `push(row)`）                                                                                                                                                                                                     |
| **`remove-duplicates/algorithm.ts:186-204`**                                        | **稠密行扫描**                                                                                                                                          | **语义改变 —— 数据安全 blocker**，见 §8.1                                                                                                                                                                                          |
| `remove-duplicates/types.ts:85-96`、`algorithm.ts:72-77`、`README.md:83-86/163-164` | "报告的是 `originalRow` 不是视觉序号"契约文档                                                                                                           | **语义改变**（承诺变为平凡真，改写为隐藏行扫描口径）                                                                                                                                                                               |
| `text-to-columns/index.ts:777`                                                      | `cell.originalRow !== row` → 拒绝整个投影读的守卫                                                                                                       | **可删**（谓词永不触发）                                                                                                                                                                                                           |
| `text-to-columns/index.ts:784-787`                                                  | 稠密 `rowStart..rowEnd` 构行                                                                                                                            | **语义改变**（低危，见 §8.1）                                                                                                                                                                                                      |
| `static-backend.ts:1274-1291/1403-1417/1626-1669`                                   | `addFormatOnlyCells` 的 `displayRows` 分支、`projectSourceCell` 的 `displayRow`/`sourceRow` 分离与公式锚定、投影双分支                                  | **可删**（合并为既有恒等分支；公式锚定的"display 行 vs 物理行"整类 bug 随之消失）                                                                                                                                                  |
| `static-backend.ts:1686-1690`                                                       | filter 激活时整体抑制 merge 元数据                                                                                                                      | **语义改变 —— 顺带闭合 parity**，见 §9.3                                                                                                                                                                                           |
| `worker-workbook-backend.ts:749/752-829/887/948/2196-2290`                          | `MappedDisplayRow`、validation overlay 的双义 `range` 与 `mappedRows` 分支、条件格式/格式的 `?? cell.row`、`readFilteredRange` 全体                     | **可删**（`readFilteredRange` 整体塌回普通窗口读；包围盒 + 逐格 `readCells` 退回矩形范围读，性能收益）                                                                                                                             |
| `worker-workbook-backend.ts:2129-2191/4088-4093`                                    | 全列扫描与 `filterSortDisplayRowsBySheetId` 缓存                                                                                                        | **语义改变**：扫描保留，载荷改为隐藏行集；缓存层删除（真值上移 UI-core）                                                                                                                                                           |
| `grid/SpreadsheetGrid.tsx`、各 overlay、`status-bar/`                               | 零处读 `originalRow`                                                                                                                                    | **必须保留（零改动）**：Grid 已是目标形态（§1.2）；状态栏聚合（`status-bar/index.ts:189-256`）按"单元格存在性"而非行算术工作，隐藏行不产 `DisplayCell` 故自动不计入——**与 Excel 状态栏只统计可见单元格一致，免费正确**             |

**净结论**：W2 网关缩水约 60%（`:240` 以上除合法性守卫外全删，`:240` 以下全留）；`originalRow` 字段与其全部回映射机制消失；两个 adapter 的筛选投影分支整体塌回恒等路径。

---

## 6｜裁决 4：引擎契约变更（可区分来源）

### 6.1 端口形状：新增独立端口（ADDITIVE）

**裁决**：新增 `setEvalFilterHiddenRows`，**不**扩展 `setEvalHiddenRows` 的参数。

```ts
// vanilla/spreadsheet-ui-core/src/backend/types.ts
export interface SetEvalFilterHiddenRowsRequest extends SheetRef {
  kind: 'set-eval-filter-hidden-rows'
  /** 0-based FILTER-hidden row indices; whole-set replace. Empty clears. */
  rows: readonly number[]
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

setEvalFilterHiddenRows?(request: SetEvalFilterHiddenRowsRequest): Promise<void> | void
```

三选一的权衡：

| 方案                                                   | INV-4 冻结面                              | 手动隐藏链路                | 原子性                         | 裁决 |
| ------------------------------------------------------ | ----------------------------------------- | --------------------------- | ------------------------------ | ---- |
| (a) 扩参 `set_eval_hidden_rows(sheet, manual, filter)` | 签名**改写** → INV-4 硬失败，须改快照     | 全链路重测（T4/#23 回归面） | 单次 RPC，无中间态             | ❌   |
| (b) 带标签载荷（改 `rows: Vec<u32>` → `JsValue`）      | 同上，且丢掉 `Vec<u32>` 的零 serde 快路径 | 同上                        | 同上                           | ❌   |
| (c) **新增独立端口 + 新增 wasm 方法**                  | **纯新增** → 同 commit 重生成快照即可     | **零改动**                  | 两次 RPC，有瞬时中间态（见下） | ✅   |

选 (c) 的理由：INV-4 对新增有明确的"同 commit regenerate"通道，对改写是硬失败；`setEvalHiddenRows` 那条链路（bridge / 协议 / 两 runtime / 两 adapter / static 并集）是刚落地的 T4/#23 成果，**改参数等于把它整条重测**，收益为零。

**瞬时中间态的处理**：两次 RPC 之间，引擎可能以"新 manual + 旧 filter"重算一次。worker 是 FIFO 单线程，最终态必定正确，代价只是一次多余重算。且 §6.3 的双 epoch 拆分后，手动隐藏推送根本不脏化 1-11 公式，这个多余重算的面进一步收窄。bridge 侧的处理：**两路推送 `Promise.all` 后再 `refreshVisibleProjection`**（复用 `eval-hidden-rows-bridge.ts:76-81` 的既有序），保证投影读永远看到成对的最终态。

### 6.2 Rust 侧

```rust
// sheet.rs — WorkbookAtomContext（与 eval_hidden_rows 并列）
eval_filter_hidden_rows: RefCell<HashMap<usize, Rc<HashSet<u32>>>>,

// workbook.rs — 与 set_eval_hidden_rows 同构（同样的 custom-call / 越界 no-op 守卫）
pub fn set_eval_filter_hidden_rows(&mut self, sheet_index: usize, rows: &[u32])
```

provider trait（`eval.rs:974` 邻位）新增默认实现返回 `None` 的 `filter_hidden_rows(&self, sheet_index: Option<usize>) -> Option<Rc<HashSet<u32>>>`，`Sheet` 的 provider 实现照 `hidden_rows` 抄。

### 6.3 `fn_subtotal` 改动

核心是把"`!ignore_hidden` 早退"改成"总是解析，按变体选集合"：

```rust
// eval.rs:19951-19958 — 语义重命名：ignore_hidden → also_ignore_manual_hidden
let (fn_norm, also_ignore_manual) = if (1..=11).contains(&fn_int) {
    (fn_int as u32, false)      // 1-11：只排除 filter 集
} else if (101..=111).contains(&fn_int) {
    ((fn_int - 100) as u32, true) // 101-111：manual ∪ filter
} else {
    return Value::Error(ValueError::InvalidValue);
};
```

`subtotal_hidden_for_arg`（`:19673-19692`）改为返回**一对** `Option<Rc<HashSet<u32>>>`：sheet index 解析逻辑（跨表 ref 取被引表集合）原样复用，去掉 `if !ignore_hidden { return None }` 早退；`also_ignore_manual == false` 时 manual 侧返回 `None`。

`for_each_subtotal_value`（`:19700-19712`）的跳过条件从"单集合 contains"改为"任一集合 contains"：

```rust
if let Some(addr) = addr {
    if filter_hidden.map_or(false, |h| h.contains(&addr.row)) { return }
    if manual_hidden.map_or(false, |h| h.contains(&addr.row)) { return }
}
```

**不构造并集**——避免每参数一次 `HashSet` 分配，保持既有流式路径。`run_subtotal`（`:19722+`）9 个分支只需跟随签名，逻辑不动（含 7/8/10/11 那个为了复用流式跳过而内联数值收集的分支，`:19871-19874`）。

### 6.4 失效 epoch：拆成两个

现状 `hidden_epoch` 是单一原子（`sheet.rs:956-958`），1-11 因为早退**从不建边**。新语义下 1-11 也要看 filter 集，若继续共用一个 epoch，则**每次手动隐藏/取消隐藏都会脏化全工作簿所有 1-11 SUBTOTAL** —— 一个纯粹的新增重算成本。

**裁决**：拆为 `manual_hidden_epoch` 与 `filter_hidden_epoch`（各配 `revision`）。`depend_hidden` 拆成两个建边函数：

- 1-11 → 只 `depend_filter_hidden`
- 101-111 → 两个都建边

单原子的跨 sheet 过失效（`sheet.rs:947-955` 已记录，与 `tables_epoch` 同构）**保持不变**，本次不顺带优化——那是独立的性能工作项。

### 6.5 WASM / 冻结面 / 协议

| 层             | 变更                                                                                                                                                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WASM           | `rust/wasm/src/lib.rs`：新增 `#[wasm_bindgen(js_name = "setEvalFilterHiddenRows")] pub fn set_eval_filter_hidden_rows(&mut self, sheet_idx: u32, rows: Vec<u32>)`，与 `:2485-2489` 逐字同构（含 void 返回、从不抛）                                                                                                           |
| 冻结面         | `rust/excel-core/tests/fixtures/wasm_api_signatures.txt` **同 commit 重生成**（`cargo test --test architecture_invariants wasm_snapshot_generate -- --ignored`）；纯新增一行，第 57 行原条目**逐字不变**（INV-4 的删改硬失败判据因此不触发）                                                                                  |
| 协议           | `worker-protocol.ts`：capability 键 `evalFilterHiddenRows: boolean`（旧 witness 缺键按 fail-closed 读 false）；client 方法 `setEvalFilterHiddenRows(sheet, rows)`，实现照 `:815-817`。**注意**：既有 `setEvalHiddenRows` 在 client 接口上是**必需**方法，新方法按后续端口惯例声明为**可选**，让老 worker 构建仍可编译         |
| WASM runtime   | `worker-runtime.ts`：引擎侧方法签名声明为 optional（照 `:144`，兼容旧 wasm-pkg 与测试 mock），dispatch 照 `:1521-1541`（同样不 `assertSheet`，同样防御性重过滤行号）                                                                                                                                                          |
| TS runtime     | `worker-runtime-ts.ts`：`TS_WORKER_RUNTIME_CAPABILITIES.evalFilterHiddenRows: false`（照 `:126`）+ `unsupported('setEvalFilterHiddenRows …')`（照 `:1509-1514`），fail-closed，绝不伪 ACK                                                                                                                                     |
| worker adapter | `setEvalFilterHiddenRowsThroughWorker` 照 `:3160-3167`：非 mutation，无 exact ACK / 无 undo / 无自有 revision bump；端口 getter 经 `runtimeSupports('evalFilterHiddenRows')`（照 `:4156-4158`）                                                                                                                               |
| static adapter | 新增 `evalFilterHiddenRowsBySheetId: Map<string, Set<number>>` 与端口实现（照 `:4480-4487`）。`evalHiddenRowsForSheet`（`:1212-1225`）**保持只服务 manual 语义**；新增 `evalFilterHiddenRowsForSheet`，静态求值器（`static-formula-eval.ts:898` 一带）按 SUBTOTAL 变体取用。`:1188-1211` 的"筛选隐藏行被刻意排除"注释随之改写 |
| bridge         | `eval-hidden-rows-bridge.ts` 扩为双路：同一个 owner / `WeakMap<Store, …>` 单实例约束 / 每 sheet 序列化去重 ledger 各自一份，订阅从 `viewportHiddenAtom` 扩到 `[viewportHiddenAtom, filterHiddenAtom]`，两路推送 `Promise.all` 后单次 `refreshVisibleProjection`（§6.1）                                                       |

**向后兼容策略（三档降级，全部无声且不撒谎）**：

1. 端口/方法齐全（WASM worker + 新 wasm-pkg）→ 完整两层语义。
2. 有 `setEvalHiddenRows` 无 `setEvalFilterHiddenRows`（旧 wasm-pkg / 未升级 worker）→ filter 集不进引擎，SUBTOTAL 1-11 与 101-111 **退化为今天的行为**（1-11 全含、101-111 排手动）。UI 侧筛选照常隐藏行——**视图正确、公式偏保守**，不产生错误结果，只产生"没排除"。
3. 两个都无（TS worker）→ 今天的行为，与 `evalHiddenRows: false` 的既有降级形状一致。

---

## 7｜贯通层清单

| 层             | 文件                                                                             | 变更                                                                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 引擎           | `rust/excel-core/src/sheet.rs`、`workbook.rs`、`eval.rs`                         | `eval_filter_hidden_rows` 存储 + 双 epoch + `set_eval_filter_hidden_rows` + provider 方法 + `fn_subtotal` 双层规则（§6.2-6.4）                                                                                                  |
| WASM           | `rust/wasm/src/lib.rs`；`rust/excel-core/tests/fixtures/wasm_api_signatures.txt` | `setEvalFilterHiddenRows` 导出 + 快照同 commit 重生成                                                                                                                                                                           |
| 协议           | `solid/excel/src-vnext/adapter/worker-protocol.ts`                               | capability 键 + client 方法（可选）                                                                                                                                                                                             |
| runtime        | `worker-runtime.ts`、`worker-runtime-ts.ts`                                      | WASM dispatch case；TS `false` + `unsupported`                                                                                                                                                                                  |
| 端口           | `vanilla/spreadsheet-ui-core/src/backend/types.ts`                               | `SetEvalFilterHiddenRowsRequest` + 端口；`SetFilterSortResult.hiddenRowIndices`；**删** `DisplayCell.originalRow`                                                                                                               |
| UI-core 状态   | `vanilla/spreadsheet-ui-core/src/filter-sort/filter-hidden.ts`（新）             | `filterHiddenAtom`（source）、`setFilterHiddenRowsAtom` / `clearFilterHiddenRowsAtom`（command）、`applyFilterHiddenStructuralShiftAtom`（command）、`effectiveHiddenRowsForSheet`（derived helper）。README 按仓内惯例分类原子 |
| UI-core 筛选   | `vanilla/spreadsheet-ui-core/src/filter-sort/index.ts`                           | `runFilterSortMutationAtom` 消费 ACK 的 `hiddenRowIndices`；新增 `reapplyFilterAtom`；**删** `deriveFilterHiddenRows`；`buildSortExcludedRows` 改读两集                                                                         |
| UI-core 网关   | `vanilla/spreadsheet-ui-core/src/editing/mutation-gateway.ts`                    | 回映射半边全删、protection 半边全留（§5）                                                                                                                                                                                       |
| UI-core 消费者 | `go-to/`、`remove-duplicates/`、`text-to-columns/`、`clipboard/`、`operations/`  | 并集隐藏集接入；稠密扫描跳过隐藏行（§8.1）；复制只取可见（§8.2）；删除行只删可见（§8.3）                                                                                                                                        |
| 投影 helper    | `vanilla/spreadsheet-ui-core/src/backend/projection-helpers.ts`                  | `buildFilterSortDisplayRows` → `computeFilterHiddenRows(state, options, readValue): Set<number>`；`cloneCell` 去字段                                                                                                            |
| static adapter | `solid/excel/src-vnext/adapter/static-backend.ts`                                | 投影塌回恒等分支；`setFilterSort` 回传隐藏集；`evalFilterHiddenRowsBySheetId` + 端口；**解除** filter 期 merge 抑制                                                                                                             |
| worker adapter | `solid/excel/src-vnext/adapter/worker-workbook-backend.ts`                       | `readFilteredRange` 与 `MappedDisplayRow` 删除、overlay 去 `?? cell.row`；扫描载荷改隐藏集；`filterSortDisplayRowsBySheetId` 缓存删除；`setEvalFilterHiddenRowsThroughWorker`                                                   |
| bridge         | `solid/excel/src-vnext/provider/eval-hidden-rows-bridge.ts`                      | 双路推送（§6.5）                                                                                                                                                                                                                |
| Grid           | `solid/excel/src-vnext/grid/SpreadsheetGrid.tsx`                                 | `getHiddenRowSet()` / `getRows()` / `getRenderedVisibleWindow()` 改读并集派生原子（**唯一渲染改动**；行号跳号免费）                                                                                                             |
| UI 入口        | `menu-bar/SpreadsheetMenuBar.tsx`、`keyboard/`                                   | `Data → Reapply` 条目 + `Ctrl+Alt+L`；端口缺失按惯例隐藏                                                                                                                                                                        |

---

## 8｜必须显式裁决的边角（"免费午餐"消失面）

压缩语义下若干行为是**副作用正确**的。切到隐藏语义后必须显式实现，否则是回归。

### 8.1 稠密行扫描 —— 数据安全 blocker

`remove-duplicates/algorithm.ts:186-204` 在 `[firstScanRow..endRow]` 上**稠密**迭代，对 `byRow` 里没有 cell 的行产出"全空元组"。

- 压缩下安全：被筛行**根本不在** display 区间内，循环永远访问不到。
- 隐藏下**危险**：隐藏行**就在** `[startRow..endRow]` 区间内，但稀疏投影不产它的 cell → 每个隐藏行被当作全空行 → 隐藏行 2..N 被判为隐藏行 1 的**重复行**并喂给 `backend.removeRows` → **静默数据丢失**。

**裁决**：`remove-duplicates` 的扫描必须显式跳过并集隐藏行（照 `go-to/locator-engine.ts:160-185` 的 `scanVisibleCellsOnly` 样板），且**必须先于 adapter 翻转落地**：切片序 S3 早于 S5（§10）。

> **主控更正（2026-07-21，核实后写入）**：本节初稿称"今天对手动隐藏行就存在同一 bug 的弱化版"，
> **该论断不成立，已删除**。核实：手动隐藏在 `ca2d27a` 后是 UI-core 视图事实，后端投影并不知道
> 隐藏的存在，两个 adapter 都未按隐藏丢行 —— 手动隐藏行的 cell 照常进入 `byRow` 并带真实值参与
> 扫描，不会被判为全空重复行。这也与 Excel 一致（删除重复项作用于整个选区，含隐藏行）。当前唯一
> 产生全空元组的是**稀疏投影里本就不存在的空行**，而空行互为重复被删除正是 Excel 的既定行为。
>
> 因此本节描述的是**新设计引入的风险**（前提是筛选隐藏行不进投影），不是存量 bug：S3 是新设计的
> **前置约束**，不是紧急修复。顺序约束依然必须遵守，性质不同而已。
>
> 教训：设计稿里的推断性论断，实施前必须逐条回到代码验证再引用。

`text-to-columns/index.ts:784-787` 有同形状的稠密构行。危害较低（按列拆分，隐藏行写回的是空拆分结果），但同样按"跳过隐藏行"加固，一并归入 S3。

### 8.2 复制只复制可见单元格

Excel 语义（§2 已核实）：**筛选**隐藏行复制时自动跳过；**手动**隐藏行照样复制。这正是 §3 坚持两个集合的第二条硬约束的落点。

**裁决**：复制路径（`clipboard/`，及 `copy-as/`）在展开选区时，从**筛选隐藏集**（不是并集）中剔除行。手动隐藏行**照旧包含**。不匹配 Excel 的 `Go To Special → Visible cells only`（那是另一条显式路径，本次不做）。

### 8.3 删除行只删可见行

⚠️ 待验证：Excel 2013+ 在筛选区删除行时只删可见行，但"选区跨隐藏行"的判定细节各版本有出入。

**裁决（暂定）**：`operations/` 的 `removeRows` 在筛选激活时，把选区展开成"选区 ∖ 筛选隐藏集"再下发。与复制同口径（筛选集，非并集）。**S6 落地前先实测 Excel 再定稿**；若实测与暂定不符，改的是这一处的集合，不影响其余设计。

### 8.4 明确**不改**的两项

- **粘贴到筛选区**：Excel 就是连续块写入、覆盖隐藏行（§2 已核实的著名陷阱）。恒等映射天然满足，**零改动**——这是隐藏语义相对压缩语义的一个 parity **修复**（压缩语义下粘贴会跳过被筛行，与 Excel 发散）。
- **填充 / 拖拽**：同上，Excel 填充柄写入隐藏单元格。零改动。

---

## 9｜迁移影响面

### 9.1 用户可见的行为变化

1. **行号跳号**（1、4、7）——本次的产品目的。可见行号显示为蓝色是 Excel 的额外视觉线索，列为可选尾项。
2. **筛选不再实时**：改单元格值不会让行当场消失/出现，需 `Data → Reapply`（§4.3）。这是**向 Excel 收敛**，不是退步。
3. **粘贴/填充会写入被筛掉的行**（§8.4）——向 Excel 收敛，但对习惯了现网行为的用户是可感知变化，需在发布说明里点名。
4. **筛选区内的合并单元格重新可见**（§9.3）。
5. `SUBTOTAL(1-11)` 在筛选激活时结果变小（开始排除被筛行）——**这是修 bug**。

### 9.2 测试迁移清单

**总量**：受影响 **25 个测试文件 / 约 55–60 例**（ui-core 6、solid 15、e2e 4，其中 1 个已 skip）。其中 **DELETE ~28 例**（机制消失）、**MIGRATE ~15 例**（断言翻转）、**fixture-only ~10 例**。`DisplayCell.originalRow` 共出现在 **19 个测试文件**。

驱动绝大多数 DELETE 的五个符号：`unmapped-row`、`mapDisplayRangeToSourceRanges`、`requireIdentityMapping`、`buildFilterSortDisplayRows`、`buildSortExcludedRows` 的缺口反推。

**第一梯队（整块以压缩语义为主题）**：

| 文件                                                        | 用例                                                                                                                                | 动作                                                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `vanilla/spreadsheet-ui-core/test/mutation-gateway.test.ts` | `:117/134/154`（映射 / run 裂分 / 合并）、`:178-215`（`unmapped-row` 两例）、`:277-292`（`requireIdentityMapping`）、`:351/406/463` | **DELETE 7**；`:74/90` 恒等与全部 protection 例 **不受影响**                                                                     |
| `solid/excel/test/vnext-mutation-gateway.test.tsx`          | `:151/182/224/250/305`（Delete / 单格 Delete / 编辑提交 / 粘贴 / 填充的"写映射源行"）                                               | **DELETE 5**；`:202/275/352` protection 例 **仅改 fixture**                                                                      |
| `solid/excel/test/vnext-worker-filter-sort.test.tsx`        | `:270`（`originalRow===3`）、`:295`、`:327`、`:348`（排列缓存）、`:453`（`A3='Alpha'`/`A4=''`）                                     | **MIGRATE 5**；`:411`（网关写源行）**DELETE**。文件头注释 `:4-17` 逐字钉了压缩语义，需重写                                       |
| `vanilla/spreadsheet-ui-core/test/physical-sort.test.ts`    | `:258-390` 的 `runPhysicalSortAtom — filter-hidden excluded rows` 四例（并集 / 观察 span 内推断 / 无投影不推 / 跨表投影忽略）       | **DELETE 4**（缺口反推机制消失）；`:220` **MIGRATE**（排除集来源改为隐藏集）；`:393-428` 手动隐藏例与全部生命周期例 **不受影响** |

**第二梯队（健康文件内的单例）**：`filter-sort.test.ts:846-862`（2 例，DELETE）；`remove-duplicates.test.ts:377/405` 与 `:668-697` 内一个 `test.each` 分支（DELETE 3）；`text-to-columns.test.ts:951-963`（DELETE）；`go-to.test.ts:1352-1364`（DELETE）；`vnext-adapter.test.ts:1149-1222`（MIGRATE）；`audit-adapter-scaling.test.ts:419-500`（MIGRATE，注释 `:436/458/477-478` 逐字写着压缩）；`vnext-toolbar.test.tsx:517/558`（DELETE 2）、`:601`（fixture）；`vnext-grid.test.tsx:2805+`（DELETE）；`vnext-format-cells.test.tsx:715+`（DELETE 2）；`vnext-context-menu.test.tsx:838-890`（DELETE）；`vnext-paste-special.test.tsx:372-416`（DELETE）；`vnext-format-painter.test.tsx:328-383`（DELETE）；`vnext-filter-dropdown.test.tsx:595-641`（MIGRATE，改为读隐藏集）；`vnext-worker-merge-overlay.test.ts:~290-330`（MIGRATE，且随 §9.3 的 merge 解禁一并加强）。

**需要主动翻转的一条现状 pin**：`solid/excel/test/vnext-static-tables.test.ts:760+` 的 `does not treat filter-hidden rows as an evaluation truth source` —— 它钉的正是"筛选隐藏不进求值真值源"这条本设计要推翻的裁决，S5 必须显式改写而非顺手删。同理 `vnext-table-totals-static-wasm-parity.test.ts:548-608` 的 `filterHidden` parity 相位。

**e2e**：

| spec                                     | 用例                                                 | 动作                                                |
| ---------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `vnext-filter-sort-real-backend.spec.ts` | `:53-82`（`A2='cell4'`/`A3=''` 压缩断言）            | **MIGRATE**（源行 4 留在 A4）；文件头 `:12-22` 重写 |
| 同上                                     | `:84-112`（display 行编辑落源行）                    | **DELETE**（前提即压缩网关）                        |
| `toolbar-filter-sort.spec.ts`            | `:75-124`、`:126-148`（`A2='North'`/`A3='East'` 等） | **MIGRATE 2**；`:150/164/214` 排序例不受影响        |
| `vnext-sort-real-backend.spec.ts`        | `:200-250`（注释 `:207-217` 写着"中间数据行被压缩"） | **MIGRATE**                                         |
| `audit-structural.spec.ts:153-175`       | 已 `test.skip`                                       | 复活并按隐藏语义启用                                |

**必须保持全绿的对照组（约 16 文件 / 90+ 例）**：`hidden-rows-columns.test.ts`（~45 例）、`menu-hidden-context.test.ts`、`vnext-provider-eval-hidden-rows.test.ts`、`vnext-worker-subtotal-hidden-wasm.test.ts`（SUBTOTAL 109 排除 / 9 不排除）、`vnext-grid-hidden-context-menu.test.tsx`、`go-to.test.ts:1337/1489+`、`physical-sort.test.ts:393-428`、`outline.test.ts` / `history.test.ts` / `operations.test.ts` 的隐藏索引 remap，以及 e2e `vnext-hidden-rows-real-backend.spec.ts:35`（**行头跳号，字面就是本次目标语义**）、`vnext-outline-real-backend.spec.ts:44`（折叠后行头读作 `1`、`5`，**筛选行号跳号 e2e 的现成参照写法**）、`vnext-subtotal-hidden-real-backend.spec.ts:70`。

### 9.3 顺带闭合的既有缺口

| 缺口                                                                                          | 闭合方式                                                               |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `deriveFilterHiddenRows` 的有界窗口缺口（`filter-sort/index.ts:1343-1356` 在案注释）          | 隐藏集变成 UI-core 全量真值，反推机制整体删除                          |
| filter 激活时 merge 元数据被整体抑制（`static-backend.ts:1686-1690`、worker `:2280-2289`）    | 隐藏语义下 merge span 重新可表达（Excel 跨隐藏行裁剪绘制），抑制可解除 |
| `readFilteredRange` 的包围盒 + 逐格 `readCells`（`worker-…:2196-2290`）                       | 塌回矩形范围读，投影读路径变快                                         |
| `projectSourceCell` 的"公式锚 source 行 vs 单元格坐标 display 行"分裂（`static-…:1414-1417`） | 恒等后整类锚定 bug 消失                                                |
| `applyValidationOverlay` 的 `range` 双义（display 窗口 / 源包围盒，`worker-…:752-758`）       | 单义化                                                                 |
| `AGGREGATE` 的 ignore-hidden 位被忽略（`eval.rs:20029-20035` TODO #32 §6.3）                  | **不在本次范围**，但 §6.3 建立的双集合 seam 是它将来的实现基座         |

---

## 10｜分切片实施计划

每切片独立可合、门禁自含。**S1–S3 零 UI 可见变化。**

| 切片                      | 目标                                                                                                                                                                                                             | 文件边界                                                                                                                                            | 门禁                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **S1 引擎双来源**         | `eval_filter_hidden_rows` 存储 + `set_eval_filter_hidden_rows` + provider 方法 + `fn_subtotal` 双层规则 + 双 epoch 拆分（§6.2-6.4）                                                                              | 仅 `rust/excel-core/src/`（`sheet.rs`/`workbook.rs`/`eval.rs`）                                                                                     | `cargo test -p einfach-excel-core`（§11.1 Rust 矩阵）；不触 wasm/TS                                         |
| **S2 桥与协议**           | wasm 导出 + 快照重生成；协议 capability 与 client 方法；WASM runtime case；TS runtime `false` + `unsupported`                                                                                                    | `rust/wasm/src/lib.rs`；`rust/excel-core/tests/fixtures/wasm_api_signatures.txt`；`worker-protocol.ts`、`worker-runtime.ts`、`worker-runtime-ts.ts` | `npm run build:wasm`；`cargo test --test architecture_invariants`（INV-4 绿）；runtime 单测含 `UNSUPPORTED` |
| **S3 消费者加固（前置）** | **在压缩语义下就正确的防御性改动**：`remove-duplicates` / `text-to-columns` 稠密扫描跳过隐藏行（§8.1）、`go-to` 上下文接并集、并集派生 helper 落地                                                               | `vanilla/spreadsheet-ui-core/src/remove-duplicates/`、`text-to-columns/`、`go-to/`、`viewport/`                                                     | `npx jest vanilla/spreadsheet-ui-core --no-coverage`；**行为零变化**，既有断言全绿不改                      |
| **S4 UI-core 筛选隐藏集** | `filterHiddenAtom` + 命令 + 结构位移 remap + `SetFilterSortResult.hiddenRowIndices` 端口形状 + `reapplyFilterAtom` + `setEvalFilterHiddenRows` 端口；UI 未接线                                                   | `vanilla/spreadsheet-ui-core/src/filter-sort/filter-hidden.ts`（新）、`filter-sort/index.ts`、`backend/types.ts`；`filter-sort/README.md`           | `npx jest vanilla/spreadsheet-ui-core --no-coverage`；adapter 未实现新字段即降级空集，既有 e2e 不受扰       |
| **S5 adapter 原子翻转**   | **一次性切换**：两 adapter 投影塌回恒等、停发 `originalRow`、`setFilterSort` 回传隐藏集、`evalFilterHiddenRows` 端口实现、bridge 双路、Grid 取并集、解除 merge 抑制                                              | `static-backend.ts`、`worker-workbook-backend.ts`、`projection-helpers.ts`、`eval-hidden-rows-bridge.ts`、`SpreadsheetGrid.tsx`                     | `npx jest solid/excel --no-coverage` + ui-core 全绿（迁移批见 §9.2）；playwright MCP 手工 smoke（行号跳号） |
| **S6 死代码清除**         | W2 网关回映射半边、`DisplayCell.originalRow` 字段、`deriveFilterHiddenRows`、`requireIdentityMapping` 及其两调用点、`unmapped-row` 全族；`buildSortExcludedRows` 改读两集                                        | `editing/mutation-gateway.ts`、`backend/types.ts`、`filter-sort/index.ts`、`go-to/`、`remove-duplicates/`、`text-to-columns/`、`paste-special/`     | 双包 jest 全绿；`grep -r originalRow` 仅剩文档历史条目                                                      |
| **S7 可见性语义收口**     | 复制只取可见（§8.2）；删除行只删可见（§8.3，先实测 Excel）；`Data → Reapply` 入口 + `Ctrl+Alt+L`；粘贴/填充明确不改并加 pin                                                                                      | `clipboard/`、`copy-as/`、`operations/`、`menu-bar/SpreadsheetMenuBar.tsx`、`keyboard/`                                                             | 双包 jest + 定向 e2e；playwright MCP smoke（筛选→复制→粘贴→Reapply）                                        |
| **S8 文档收口**           | `filter-sort.md`（仍写着 `directives` 与"backend 拥有行序"的陈旧口径）、`editing/README.md`、`remove-duplicates/README.md`、`CANONICAL_OWNERSHIP.md` #29、`CUTOVER_INVENTORY.md`、`06-tables-data-management.md` | 纯文档                                                                                                                                              | 互链一致性人工核对                                                                                          |

**依赖顺序**：S1 → S2 → S5；S3 → S4 → S5；S5 → S6 → S7 → S8。

- S3 与 S4 可与 S1/S2 并行开工（无引擎依赖），合流点在 S5。
- **S3 必须早于 S5**：否则 adapter 翻转当天 `remove-duplicates` 就会静默删数据（§8.1）。这是本计划唯一的硬序约束。
- S5 是**原子切换**，不允许"压缩与隐藏双语义共存期"——与 CANONICAL 的翻转约束一致。
- S6 可与 S7 并行；S8 收尾。

---

## 11｜测试与验收计划

### 11.1 新增测试矩阵

**Rust（`eval.rs` / `sheet.rs`）**：

| 维度     | 用例                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 两层规则 | 1-11 × {仅 manual / 仅 filter / 两者 / 空}；101-111 同；两集重叠行不双跳；**核心 pin：`SUBTOTAL(9,…)` 排除 filter 但包含 manual** |
| 跨表     | `Sheet2!A1:A10` 参数取被引表的两个集合；`current_sheet_index` 回退路径                                                            |
| 整集替换 | 幂等重推、空集清除、越界 sheet no-op、custom-call 期间 no-op（照 `set_eval_hidden_rows` 既有矩阵抄）                              |
| epoch    | 推 manual **不**脏化 1-11 公式（双 epoch 的验收判据）；推 filter 脏化 1-11 与 101-111；首次推送前建边的公式能重算                 |
| 非行参数 | 标量/字面量参数 `addr == None` 恒不过滤                                                                                           |

**桥 / adapter**：wasm `setEvalFilterHiddenRows` 出入 + INV-4 快照绿；两 adapter `setFilterSort` 回传的 `hiddenRowIndices` **static ≡ worker** 黄金对照（含 summary 行、header 行、四种规则型、空结果、全隐藏）；50k 超限 `FILTER_SORT_SOURCE_TOO_LARGE` 且清空永远成功；TS runtime `UNSUPPORTED` + 端口 getter `undefined`；投影恒等（`cells[i].row` 恒等于源行，无 `originalRow`）。

**UI-core**：`filterHiddenAtom` 的整集替换 / 切表隔离 / 结构位移平移 / 与手动集互不干扰（`unhideRowsAtom` 不解筛选，pin §3 约束 3）；并集派生正确；`reapplyFilterAtom` 重算；`buildSortExcludedRows` 两集并；网关在无 `originalRow` 下恒等且 protection 门禁不变；`remove-duplicates` / `text-to-columns` 跳过隐藏行（§8.1 的**反例测试**：隐藏行不得被判重复）。

**e2e**：筛选后行号跳号（断言行头文本序列如 `1, 4, 7`）；筛选态下 `SUBTOTAL(9,…)` 与 `SUBTOTAL(109,…)` 结果相等且都小于全量；手动隐藏 + 筛选并存时 1-11 与 101-111 结果**不等**（两层规则的端到端佐证）；复制筛选区只得可见行；粘贴写入隐藏行（Excel parity pin）；筛选区合并单元格正常绘制；`Reapply`；TS worker demo 页 SUBTOTAL 降级不报错。

### 11.2 验收门禁

`cargo test -p einfach-excel-core` + `cargo test --test architecture_invariants`；`npm run build:wasm` 后 `npx jest vanilla/spreadsheet-ui-core --no-coverage`、`npx jest solid/excel --no-coverage`；定向 e2e spec；每个 UI 可见切片（S5、S7）后 playwright MCP 手工 smoke。

---

## 12｜Conformance notes 与未决项

**有意发散（记录在案，不阻塞）**：

1. 可见行号不染蓝（Excel 的视觉线索）——纯样式，列为可选尾项。
2. `Go To Special → Visible cells only` 作为**显式**选择路径不实现；复制的可见性过滤是隐式的（§8.2）。
3. 筛选下拉的候选值列表是否应排除本列自身规则的影响（Excel 语义），本次不动。
4. `hidden_epoch` 的跨 sheet 过失效（`sheet.rs:947-955` 在案）不顺带优化。

**未决 / 待验证**：

1. ⚠️ 删除行在筛选区的确切 Excel 行为（§8.3）——S7 落地前实测定稿。
2. ⚠️ 格式化筛选区是否只作用可见单元格（§2）——实测后决定是否进 §8。
3. ⚠️ `AGGREGATE` 的 ignore-hidden 语义与本次双集合的关系——**列为后续**，`eval.rs:20029-20035` 的 TODO(#32 §6.3) 保持，seam 已由 S1 建好。
4. `vanilla/spreadsheet-ui-core/docs/filter-sort.md` 全文是 `directives` 时代的陈旧口径（"backend 拥有行序"、`originalRow` 契约、`SortDirective` 类型），S8 整篇重写。
5. 筛选隐藏集是否需要持久化进工作簿文件格式（Excel 的 autoFilter 会存）——超出本次范围。
