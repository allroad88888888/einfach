# 设计｜引擎物理排序（`sortRange`）

- **状态**：设计裁决稿（待主控派单）
- **日期**：2026-07-19
- **基线**：分支 `claude/rust-core-state-plan-Auzcj`；[CANONICAL_OWNERSHIP.md](./CANONICAL_OWNERSHIP.md) #29（排序执行 = 引擎数据事实）
- **范围**：把"排序"从显示置换（UI/adapter 投影期置换，零写引擎）迁移为引擎物理排序（真实重排工作簿数据，Excel 语义）。筛选可见性不在本设计范围内（#29 混合归属的另一半，走翻转顺序第 3 步）。

---

## 0｜裁决摘要

| #   | 问题     | 裁决                                                                                                                                                                                                                     |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 产品语义 | 终态**所有排序入口全部物理排序**（工具栏、Data 菜单、筛选下拉），不保留显示置换排序；迁移分三相，每入口一次性原子切换，无同入口双语义                                                                                    |
| 2   | 引擎 API | 新模块 `rust/excel-core/src/sort.rs`：`sort_range(range, keys, excluded_rows)`；新比较器 `sort_cmp`（Excel 类型序：数字 < 文本 < 逻辑 < 错误 < 空，空恒最后）；稳定排序保证                                              |
| 3   | 公式语义 | **原文搬运、不平移引用**（与 pasteRange 已锁定的 verbatim 语义一致）；range 外公式引用 range 内单元格不调整（与 Excel 一致）；range 内相对引用不随动是与 Excel 的**有意发散**，记 conformance note                       |
| 4   | spill    | range 与任何 spill（anchor 或 target）相交 → 结构化拒绝 `SPILL_IN_RANGE`（对齐 Excel"不能更改数组的一部分"）                                                                                                             |
| 5   | merge    | 引擎无 merge 模型；门禁在 **adapter**（持有完整 merge registry）dispatch 前置拒绝，UI-core 预禁用只是 UX（对齐 Excel 合并区排序报错拒绝）                                                                                |
| 6   | 格式随动 | per-cell 格式随行搬运；range 格式层做"物化 + 几何切割"预处理；行高**不**随动（与 Excel 一致）                                                                                                                            |
| 7   | 排除集   | `excluded_rows` 作为请求载荷（hidden ∪ filtered-out ∪ summary 行，宿主组装），被排除行**留在原位**，其余行在"可见槽位"间稳定重排；引擎不建 hidden 模型（与 §7-1 SUBTOTAL 裁决同构；与微软文档"排序不移动隐藏行"一致）    |
| 8   | undo     | 宿主编排，走既有 `recordCellMutation` 通道：排序前 range sparse 快照 + 格式快照即完整回滚；**不需要**全表快照与 `STRUCTURAL_SNAPSHOT_MAX` 类阈值；新增源规模上限 `MAX_SORT_SOURCE_CELLS`（fail-closed 拒绝，不降级执行） |
| 9   | 端口     | `SpreadsheetBackend` 新增独立 optional 端口 `sortRange?`（**不**复用/扩展 `setFilterSort`）；TS worker 按 fail-closed 惯例声明 `sortRange: false`，真实现留作可选切片                                                    |

---

## 1｜背景与现状（as-is）

### 1.1 显示置换排序（现网）

排序目前是**投影期显示置换**，引擎数据从不移动：

- 纯函数 `buildFilterSortDisplayRows`（`vanilla/spreadsheet-ui-core/src/backend/projection-helpers.ts:401`）产出 `displayRow → sourceRow` 稀疏映射：header 行 0 直通、数据行自行 1 起、summary 行启发式钉在末位（`isFilterSortSummaryRow`）；被 filter 排除的行**压缩消失**（无 display 槽位）。
- 比较器 `compareFilterSortValues`（同文件 `:258`）：空串恒排升序末位；两侧均可解析为有限数字时数值比较；否则 `localeCompare(numeric, base)`。稳定性靠扫描序 index tie-break。
- 两个 adapter 都在投影读取时调用同一 helper：`static-backend.ts`（`buildProjectionResult`）与 `worker-workbook-backend.ts`（`computeFilterSortDisplayRows` + display-row cache，谓词扫描上限 `MAX_FILTER_SORT_PREDICATE_CELLS = 50_000`，超限结构化拒绝 `FILTER_SORT_SOURCE_TOO_LARGE`）。worker 路径只**读**引擎（`readSparseRange`），置换纯 JS。
- 指令状态：`FilterSortState.directives`（UI-core `filter-sort/` 特性），工具栏/菜单/下拉共用单 lane 状态机（`runFilterSortEntrypointAtom` / `runFilterSortMutationAtom`），transport 为 `setFilterSort` 端口。
- 回写网关（W2）：`vanilla/spreadsheet-ui-core/src/editing/mutation-gateway.ts` 的 `mapDisplayRangeToSourceRanges` / `resolveContentMutationAtom`——filter/sort 激活时所有 mutation 先做 display→originalRow 回映射。

### 1.2 引擎现状（可复用面）

`rust/excel-core` 无 sort，但物理排序需要的原语基本齐备：

- **结构编辑机器**（`sheet.rs`）：`with_structural_edit`（订阅摘除 + Store batch + topology epoch bump + 逐地址变更通知）、`relocate_cells(f)`（接受**任意地址映射**的全图重建，per-cell 格式随 f 搬运）、`drop_cells_in`、`prune_obsolete_formula_atoms`。
- **spill**：`teardown_all_spills` / `rederive_spill_anchors`（结构操作先例）；spill 正/反向索引可低成本判定 range 相交。
- **格式**：`formats: HashMap<CellAddress, CellFormat>`（per-cell）+ `range_formats: Vec<RangeFormat>`（有序层，后者胜）；`snapshot_format_range` / `restore_format_range_snapshot`（层整体替换，undo 精确）。
- **求值**：`peek_value` / `get_cell` 给出单元格求值结果；`eval.rs` 的 `SORT()` 函数用简化比较器 `compare_lookup`（数字优先、否则文本），**不满足** Excel 类型序，物理排序不复用它、也不改它。
- **快照原语（wasm 已在线）**：`snapshot_range_sparse`、`restore_sparse`（ADDITIVE）、`clear_range`、`snapshot_format_range` / `restore_format_snapshot`。
- 引擎 `undo.rs` 是死代码，按 CANONICAL 横切规则**不复活**。

### 1.3 贯通链与惯例

- worker 协议为 stringly RPC（`worker-protocol.ts` 的 `WorkerWorkbookClient` 接口 + `request<T>(cmd, payload)`）；WASM runtime（`worker-runtime.ts`）无 `describeCapabilities`（legacy 全信任），TS runtime（`worker-runtime-ts.ts`）声明 `TS_WORKER_RUNTIME_CAPABILITIES`（全 false，fail-closed，`unsupported()` 结构化拒绝）；adapter 用 `runtimeSupports(key)` 决定端口 getter 是否返回 `undefined`（UI 随之隐藏入口）。
- 宿主编排 undo（`worker-workbook-backend.ts`）：cell 域走 `recordCellMutation`（`captureUndoImage` = `snapshotRangeSparse` + `snapshotFormatRange`；回放 `clearRange` → `restoreSparse` → `restoreFormatSnapshot`，因 `restoreSparse` ADDITIVE 必须先清）；结构域走 `recordStructuralMutation`（`#REF!` 哨兵不可逆 → 全表快照 + `WORKER_STRUCTURAL_SNAPSHOT_MAX = 2000` 超限降级 not-undoable）；undo 栈 cap `WORKER_UNDO_STACK_CAP = 100`。
- pasteRange 引用语义已锁定 verbatim：`paste-range-plan.ts:15-18`、`worker-workbook-backend.ts:2558-2562`（"formulas paste VERBATIM (no ref translation…)"）。
- merge 是 adapter/backend 事实（`mergeRangesBySheetId`）+ 投影元数据（`mergedSpan`/`mergeAnchor`）+ grid overlay；Rust 引擎零 merge 感知。

---

## 2｜裁决 1：产品语义与迁移路径

### 2.1 终态：全部入口物理排序，不保留显示置换排序

**裁决**：工具栏 sort asc/desc、Data 菜单 sort-asc/sort-desc、筛选下拉内的升/降序，终态全部走引擎 `sortRange`。`FilterSortState.directives` 与显示置换排序整体退役；`buildFilterSortDisplayRows` 只保留 filter 可见性压缩（其归属随翻转第 3 步转 UI-core）。

理由：

1. CANONICAL #29 已裁"排序执行 = 引擎数据事实"，显示置换是过渡态（worker adapter 内注释自认"physical engine sort is later-phase data-fact work"）。
2. Excel 的 AutoFilter 下拉排序**本身就是物理排序**——"下拉保留显示置换"没有 Excel 依据，反而制造同表两种排序事实（引擎数据已物理排过 + UI 指令再置换一层）叠加时不可解释的合成语义。
3. 翻转约束"每模块一次性原子切换、不允许双权威共存期"同样适用：不做"缺 `sortRange` 端口就回退显示置换"的降级——端口缺失时入口按既有惯例**隐藏/禁用**（TS worker 开发后备即此形态）。

### 2.2 迁移三相（对应 §10 切片 S5/S6）

| 相  | 内容                                                         | UI 可见变化             | 既有 pin         |
| --- | ------------------------------------------------------------ | ----------------------- | ---------------- |
| P1  | 引擎 + wasm + 协议 + 端口 + static 参考实现落地，零 UI 改动  | 无                      | 全绿不动         |
| P2  | 工具栏 + Data 菜单入口翻转为 `sortRange`；同切片迁移对应 pin | 排序真实改数据、可 undo | 迁移批 1（§9.3） |
| P3  | 筛选下拉排序翻转；`directives` 退役；文档收口                | 下拉排序同上            | 迁移批 2（§9.3） |

**依赖排序**：`excluded_rows` 的 filtered-out 部分依赖翻转第 3 步（filter 可见性 UI-core canonical，未落地）。在此之前，P2 的物理排序在"当前 sheet 存在 active filter rules"时**禁用入口**（`disabledReason` 提示先清除筛选）；hidden 行集（第 2 步已落地、UI-core canonical）与 summary 行照常进排除集。P3 与翻转第 3 步会合后解除该禁用。

### 2.3 冲击面（既有 pin 盘点结论）

物理排序会翻转的断言族（详表见 §9.3）：

- "引擎数据未动"（`client.calls.setCell` 长 0）、"clear 恢复原布局"、`originalRow` 携带——`solid/excel/test/vnext-adapter.test.ts:1044-1188`、`vnext-worker-filter-sort.test.tsx:296-327`、`audit-adapter-scaling.test.ts:406-491`、e2e `vnext-filter-sort-real-backend.spec.ts:53-112`。
- "工具栏/菜单排序 = 写 `setFilterSort` 指令"——`vnext-menu-bar.test.tsx:1237/1273`、`vnext-toolbar.test.tsx:587-668`、UI-core `filter-sort.test.ts:524-563`（`dispatchSortAtom` 多键主序语义）及 `:595-1669` 入口状态机（状态机**保留**，只换 transport）。
- e2e 可见序 pin ——`toolbar-filter-sort.spec.ts:164-203`、`toolbar-number-format.spec.ts:127-144`（排序后可见序断言本身不变，新增"数据已物理移动 + undo 还原"断言）。
- 文档：`vanilla/spreadsheet-ui-core/docs/filter-sort.md:11-137`（虚拟行序契约）、`06-tables-data-management.md:47-48/74-75/505-521`、`CUTOVER_INVENTORY.md:202`。**注意**：CUTOVER #29 文案（"Worker 没有 `setFilterSort`、禁止行置换"）与树上已 FLIPPED 的测试（worker 显示置换已支持并被 pin）相互矛盾，S6 收口时一并 reconcile。

---

## 3｜裁决 2：引擎 API 形状与比较规则

### 3.1 Rust 签名（新模块 `rust/excel-core/src/sort.rs`）

```rust
pub enum SortDirection {
    Ascending,
    Descending,
}

pub struct SortKey {
    /// 绝对列号（0 基），必须落在 range 列区间内。
    pub col: u32,
    pub direction: SortDirection,
    /// 文本比较大小写敏感；Excel 默认 false。
    pub case_sensitive: bool,
}

pub struct SortRangeReport {
    /// 源行发生变化的可见槽位数；0 表示 no-op。
    pub moved_rows: u32,
    pub moved_cells: u32,
    /// 变更槽位的置换见证：(槽位行, 排序前占据该槽位的行)。
    /// 供 overlay remap / parity 断言使用；v1 消费者可忽略。
    pub row_permutation: Vec<(u32, u32)>,
}

pub enum SortRangeError {
    InvalidRange,
    EmptyKeys,
    KeyOutOfRange,
    /// range 与 spill anchor 或 spill target 相交。
    SpillIntersectsRange { anchor: CellAddress },
}

impl Sheet {
    pub fn sort_range(
        &mut self,
        range: CellRange,
        keys: &[SortKey],
        excluded_rows: &[u32],
    ) -> Result<SortRangeReport, SortRangeError> { /* … */ }
}

impl Workbook {
    pub fn sort_range(
        &mut self,
        sheet_idx: usize,
        range: CellRange,
        keys: &[SortKey],
        excluded_rows: &[u32],
    ) -> Result<SortRangeReport, SortRangeError> { /* … */ }
}
```

要点：

- **键值取求值结果**：`(row, key.col)` 处的 `Value` 经求值（公式按计算结果参与排序，等价于 Excel 按显示值排）。所有键值在**任何搬移发生前**一次性物化，避免置换中途读取。
- `excluded_rows`：range 外条目忽略、重复去重；引擎对其来源（hidden/filter/summary）零感知。
- no-op（排序后置换为恒等）：返回 `moved_rows: 0`，引擎不做任何写入。

### 3.2 值比较规则（normative，新函数 `sort_cmp`）

`sort_cmp(a: &Value, b: &Value, case_sensitive: bool) -> Ordering`，升序总序：

| 序  | 类型类                       | 类内规则                                                                                                |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | `Number`（含日期序列值）     | `f64` 数值序；NaN 类内视为相等、排数字段末（工程约定，Excel 无 NaN）                                    |
| 2   | `Text`                       | `case_sensitive=false`（默认）：Unicode simple case fold 后按 code point 序；`true`：直接 code point 序 |
| 3   | `Boolean`                    | `FALSE < TRUE`                                                                                          |
| 4   | `Error`（`Lambda` 并入此类） | **彼此相等**（稳定性保序，对齐 Excel 错误值不互比）                                                     |
| 5   | `Null`（空）                 | 彼此相等；**升序、降序都恒排最后**（对齐 Excel）                                                        |

- **降序**只反转第 1–4 类的比较结果，空仍最后（实现上比较器分两层：先空类判定，再方向施加于非空比较）。
- **多键**：`keys` 依序比较，首个非 0 即返回。
- **稳定性**：保证稳定——键全等的行保持排序前可见槽位相对序（`Vec::sort_by` 本身稳定即满足，测试显式 pin）。
- `Value::Array` 不会出现在键位（spill 相交已被拒绝，见 §5.1）。

**与现网/Excel 的两点显式发散**（记入 conformance notes，§11）：

1. **不做 locale collation**。现网 JS 显示比较器用 `localeCompare(numeric, base)`；Rust 侧引入 ICU 不成比例，且排序结果必须跨 static/worker/平台确定。裁决：normative 比较器为上表的 case-fold + code point 序，**static 参考实现必须弃用 `localeCompare` 改实现同一比较器**（`adapter/sort-order.ts` 共享模块 + 与 wasm 的 golden fixture parity 测试）。
2. Excel 的"文本型数字与数字分开排序"提示交互不做；`Number` 与 `Text` 严格按类型类分层（引擎 `Value` 类型天然如此）。

`compare_lookup`（`eval.rs` 的 `SORT()`/`SORTBY()` 函数所用简化比较器）**保持不动**——公式函数行为变更是另一个 conformance 工作项，不搭车。

---

## 4｜裁决 3：公式语义——原文搬运，不平移

**裁决：确认。** 被排序搬移的公式单元格，其 AST（hydrated）与 parked source（lazy）**原样搬运，不做任何引用平移**——即跳过结构编辑路径中的 `retarget_formula_refs` / `retarget_parked_sources` 两步。

依据与对照：

- **与仓内既有锁定语义一致**：pasteRange 已锁定 verbatim（`paste-range-plan.ts:15-18`；`worker-workbook-backend.ts:2558-2562` 写入 `srcFormula ?? srcDisplay`）。排序与 Paste Special 同属"数据搬运"，共享同一条引用哲学，用户心智模型单一。
- **Excel 实际行为**：Excel 排序移动公式时保持 R1C1 相对偏移（A1 文本随新行号改写），公式引用排序区内其他单元格时结果通常被破坏，微软文档明确建议避免；引用排序区**外**单元格的相对引用同样按偏移保持，绝对引用不变。即 Excel 也不做"语义保持"的引用修复——它保持的是**偏移**，我们保持的是**原文**，二者都会改变公式语义，Excel 的选择并不更"正确"。
- **range 外公式引用 range 内单元格**：不调整（与 Excel 一致）。物理移动值后，依赖图自然触发这些公式重算，读到落在该地址上的新内容——这正是物理排序的定义行为，无需任何额外机制。
- **range 内公式引用 range 内单元格**：verbatim 语义下引用继续指向原地址（现在住着别的数据）。与 Excel 的 R1C1 偏移保持不同，记 conformance note。

工程收益：排序路径完全不触 `shift.rs`，不产生 `#REF!` 哨兵——这是 §7 undo 可以走 range 有界快照（而非结构操作的全表快照）的**前提条件**。

后续可选项（非本设计范围）：若未来需要 Excel 兼容模式，`shift.rs` 的 `map_addrs` 按行 delta 平移即可实现，API 预留 `keys` 之外不加参数——届时以新的请求字段显式 opt-in。

---

## 5｜裁决 4：spill / merge / 格式随动

### 5.1 spill：相交即拒绝

**裁决**：`range` 与任何 spill 相交（anchor **或** target 任落其中）→ `Err(SpillIntersectsRange)`，排序不执行。对齐 Excel"不能更改数组的一部分"对排序的拒绝行为。

- 不采用"拆散重投影"：spill target 是派生 atom、无物理内容可搬；若 range 含 target 不含 anchor，排完 anchor 重新溢出到原位置，结果视觉上"没排"，语义不可解释。
- 判定用既有 spill anchor/reverse 索引，成本 O(anchors)。
- 推论：通过该门禁后 range 内外都不存在需要搬移的 spill，**不需要** `teardown_all_spills`（置换在 range 外恒等，range 外 spill 完全不受影响）。

### 5.2 merge：adapter 权威门禁，前置拒绝

**裁决**：排序区与任何 merge range 相交 → 拒绝并提示（对齐 Excel 合并区排序直接报错）。因引擎零 merge 感知（`rust/excel-core` grep 确证无 merge 模型；registry 在 adapter `mergeRangesBySheetId`），门禁分两层：

- **权威层（必经）**：adapter `sortRange` 实现内、发 RPC 前校验完整 merge registry，相交即返回结构化失败 `MERGE_IN_RANGE`（worker 与 static 同判）。
- **UX 层（尽力）**：UI-core dispatch 前用投影窗口内 `mergedSpan`/`mergeAnchor` 元数据预禁用/预提示——但投影窗口可能看不到 range 内全部 merge，故只是提前反馈，不是权威。

不采用"引擎建 merge 模型"：与 #04 adapter-overlay 转正裁决冲突。

### 5.3 格式随动：per-cell 直接搬，range 层"物化 + 切割"

Excel 语义：单元格格式随数据移动。引擎格式为两层存储，处理分开：

- **per-cell `formats`**：`relocate_cells(f)` 既有行为就是随 f 搬运——排序置换直接复用，零新机制。
- **`range_formats` 层**：**不能**把层角点喂给置换映射（角点独立置换会撕裂矩形——`relocate_cells` 对层角点应用 f 的既有代码路径对排序置换不安全）。裁决采用排序前预处理：
  1. **物化**：对 range 内每个单元格解析 `base_format_at`，非 default 者写为 per-cell 条目；
  2. **切割**：与 range 相交的每个层做几何减法，切成 ≤4 个与 range 不相交的矩形（保持 Vec 层序，后者胜语义不变）。
  3. 此后 range 内无层覆盖，"default = 无条目"恒真，per-cell 条目随置换搬运即为完整正确语义（规避"default 格子落到残留层覆盖槽位被层污染"的边角）；层角点全部在 range 外，f 恒等，`relocate_cells` 可安全复用。
- **undo 精确性**：`snapshot_format_range` 快照 range 内 per-cell 条目 + **全部**层；`restore_format_range_snapshot` 整体替换层 Vec——物化与切割都被精确回滚（§7）。
- **行高不随动**：`row_heights` 不动（Excel 行为：排序不移动行高）。区别于结构操作（insert/delete 平移行高）。
- **overlay 不随动（v1 known gap）**：批注/数据验证/条件格式按地址锚定在 adapter overlay / 外部 Service，v1 排序不搬。`SortRangeReport.row_permutation` 从第一天进 wire，为后续 overlay remap（类比 W3 `structuralShift` remap 合同的置换版）预留见证；v1 消费者忽略。Excel 会移动批注与验证，此为记录在案的 parity 缺口（§11）。

---

## 6｜裁决 5：排除集与槽位映射算法

### 6.1 载荷与组装

`excluded_rows: number[]`（source 行空间、0 基）由**宿主（UI-core dispatch）**组装，引擎只见集合不见来源：

```
excluded = hiddenRows(UI-core canonical，翻转第 2 步已落地)
         ∪ filteredOutRows(翻转第 3 步落地后可用；此前 filter 激活时入口禁用，见 §2.2)
         ∪ summaryRow(isFilterSortSummaryRow 启发式，UI-core 判定)
```

与 CANONICAL §7-1（SUBTOTAL：宿主把可见性作为求值输入喂引擎）同构：**引擎不建 hidden 模型**。W2 说明：行集合来自 UI-core canonical 源，天然 source 空间；入口目标列来自选区时列坐标不受行置换影响（display 列 ≡ source 列），无需回映射。

### 6.2 槽位映射算法（normative）

```
输入: range（normalize 后, 行区间 [r0, r1]）, keys, excluded_rows
E  = dedup(excluded_rows) ∩ [r0, r1]
V  = [r0..=r1] \ E, 升序                    // "可见槽位"序列, 长度 n
rec[i] (i = 0..n):
    - 第 V[i] 行在 range 列区间内的整行载荷: 每格 (值 | 公式原文) + per-cell 格式(物化后)
    - key 元组: keys 各列在该行的求值结果(先于任何搬移一次性物化)
perm = 稳定排序 (0..n)，比较 rec 的 key 元组（§3.2 sort_cmp，逐键、方向逐键施加）
写回: rec[perm[i]] 落到槽位 V[i]（i = 0..n）
```

性质（测试逐条 pin）：

1. **槽位集合不变**：数据只在 V 的槽位间重排；E 中行与 range 外任何单元格不读不写。
2. **E = ∅ 时**退化为整段连续重排（纯 Excel 语义）。
3. 排序不会把内容写进被排除行，也不会让被排除行的内容参与比较。
4. 空行（整行无内容）参与排序：其键为 `Null`，按"空恒最后"沉底——排序后数据紧凑、空行沉到可见槽位尾部（Excel 一致）。
5. 与现网显示置换的**语义差**：显示置换把被排除行"压缩消失"；物理排序让它们**原位保留**。迁移 e2e 时注意断言基准改变。

**Excel 对照**：微软官方文档（Sort data in a range or table）明示"按行排序时隐藏行不被移动，排序前建议取消隐藏"——本裁决与 Excel 文档行为一致；将排除集做成显式载荷（而非引擎推断）额外获得 summary 行钉位与 filter 组合的统一机制。

### 6.3 实现落点（引擎内）

`sort.rs` 编排复用结构编辑机器，差异点：

1. `with_structural_edit` 包裹（订阅摘除/一次通知/topology epoch/Store batch 复用）；
2. **跳过** spill teardown（§5.1 拒绝门禁替代）与 `retarget_*` 两步（§4 verbatim）；
3. 格式层"物化 + 切割"预处理（§5.3）先于置换；
4. 行映射 `m: old_row → new_row`（仅 moved 可见行有条目），`f(addr) = addr.col ∈ range 列区间 && addr.row ∈ m ? (m[addr.row], addr.col) : addr`，交给 `relocate_cells(f)`（任意双射，全图重建天然无碰撞）；
5. 收尾沿用 `prune_obsolete_formula_atoms` 与变更地址 facade epoch bump 尾巴。
6. 复杂度：v1 接受 `relocate_cells` 的全图重建 O(全表非空)（与 insert/delete 行同级）；range 局部重建是后续性能项，不阻塞。

---

## 7｜裁决 6：undo——宿主编排，range 有界快照即完整

**裁决**：排序 undo 走既有 **`recordCellMutation`** 通道（`kind: 'range.sort'`），**不是** `recordStructuralMutation`：

- 完整性论证：§4 verbatim 语义下排序**不产生 `#REF!` 改写**、不移动 range 外任何单元格、不动行高与层几何以外的任何 sheet 元数据 → "排序前 range sparse 快照（值 + 公式原文，`snapshotRangeSparse`）+ 格式快照（`snapshotFormatRange`，含全部层 → 物化/切割一并回滚）"即可完整还原。结构操作需要全表快照的根因（`#REF!` 哨兵不可逆）在排序路径不存在。
- 回放序沿用既有合同：`clearRange(range)` → `restoreSparse(before)` → `restoreFormatSnapshot(before)`——`restoreSparse` 是 ADDITIVE，先清是必须的（排序会改变 range 内空/非空格局，不清会残留）。
- **阈值**：不需要 `WORKER_STRUCTURAL_SNAPSHOT_MAX` 类降级阈值（快照天然被 range 非空单元格数界定）。改为**源规模上限**：`MAX_SORT_SOURCE_CELLS = 50_000`（对齐 `MAX_FILTER_SORT_PREDICATE_CELLS` 既有量级；按 range 内非空单元格计，adapter 在 dispatch 前判定），超限结构化拒绝 `SORT_SOURCE_TOO_LARGE`——**fail-closed 拒绝而非"执行但降级 not-undoable"**：排序是用户默认可逆预期的高频操作，静默丢失 undo 能力比拒绝更伤（与结构操作的降级先例场景不同）。
- no-op（`moved_rows == 0`）：ACK 成功、照常 bump revision、**不入 undo 栈**。
- undo 栈沿用 `WORKER_UNDO_STACK_CAP = 100`；UI-core history 照常经 `undoTransaction` 端口编排，`applied/notAppliedReason` 见证合同不变。static 路径对称实现（其 undo 记录机制已有 merge/格式先例）。

---

## 8｜贯通层清单

新增独立端口 `sortRange?`。**不复用 `setFilterSort`**：归属类别不同（引擎数据事实 vs UI-core 视图事实）、undo 路径不同（宿主编排快照 vs local-replay）、capability 需独立降级（TS worker 应只隐藏排序而不连坐筛选）。

| 层             | 文件                                                                                            | 变更                                                                                                                                                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 引擎           | `rust/excel-core/src/sort.rs`（新）；`lib.rs`、`sheet.rs`、`workbook.rs`                        | `sort_cmp` + 槽位算法 + `Sheet::sort_range` / `Workbook::sort_range`（§3/§6）；格式层物化/切割助手                                                                                                                                                                                                               |
| WASM           | `rust/wasm/src/lib.rs`                                                                          | `pub fn sort_range(&mut self, sheet_idx: u32, payload: JsValue) -> Result<JsValue, JsValue>`，serde JSON：入 `{ range, keys: [{ col, direction, caseSensitive }], excludedRows }`，出 `SortRangeReport`；`SortRangeError` → 结构化错误码                                                                         |
| 协议           | `solid/excel/src-vnext/adapter/worker-protocol.ts`                                              | `WorkerWorkbookClient.sortRange(sheet, payload)` + wire 类型；`WorkerRuntimeCapabilitiesWire` 增 `sortRange: boolean`（旧 witness 缺键按 fail-closed 读 false，语义自洽）                                                                                                                                        |
| WASM runtime   | `solid/excel/src-vnext/adapter/worker-runtime.ts`                                               | `case 'sortRange'` → `wb.sort_range`；引擎拒绝映射为 `rpcError('SORT_REJECTED', code)`                                                                                                                                                                                                                           |
| TS runtime     | `solid/excel/src-vnext/adapter/worker-runtime-ts.ts`                                            | `TS_WORKER_RUNTIME_CAPABILITIES.sortRange: false` + `case 'sortRange'` → `unsupported('sortRange')`。评估过同步真实现：excel-core-ts 有 cells/公式/求值可支撑，但需补"任意置换搬移 + verbatim 搬运 + no-spill 判定"，中等成本且 CANONICAL 已裁 TS 为开发后备——**裁决 v1 fail-closed false**，真实现列可选切片 S7 |
| 比较器共享     | `solid/excel/src-vnext/adapter/sort-order.ts`（新）                                             | §3.2 normative 比较器 + 槽位算法的 TS 版（static 参考实现与 parity 测试共用；禁 `localeCompare`）                                                                                                                                                                                                                |
| 端口           | `vanilla/spreadsheet-ui-core/src/backend/types.ts`                                              | `SortRangeRequest`（`SheetRef` + `kind: 'sort-range'` + `range` + `keys` + `excludedRows` + `requestId?/revision?`）、`SortRangeResult`（`movedRows` + `rowPermutation?` + 回声 id/revision）、`sortRange?(request): Promise<SortRangeResult>`                                                                   |
| static adapter | `solid/excel/src-vnext/adapter/static-backend.ts`                                               | 参考实现：merge 门禁 → 源规模门禁 → 槽位算法（键取 static 求值结果）→ undo 记录 → revision bump                                                                                                                                                                                                                  |
| worker adapter | `solid/excel/src-vnext/adapter/worker-workbook-backend.ts`                                      | `sortRangeThroughWorker`（merge 门禁 + `MAX_SORT_SOURCE_CELLS` + `recordCellMutation(kind: 'range.sort')` 包裹 RPC）；`get sortRange()` 经 `runtimeSupports('sortRange')`                                                                                                                                        |
| UI-core        | `vanilla/spreadsheet-ui-core/src/filter-sort/`                                                  | `sortRangeSupportedAtom`（capability 见证）、`runPhysicalSortAtom`（组 range=数据区 rows 1..end × used cols、keys=[激活列]、excluded 集；先清空 `directives` 再 dispatch，复用既有单 lane 票据与 entrypoint 状态机词汇 pending/local-acknowledged/refreshing/outcome-unknown）；filter-active 禁用逻辑（§2.2）   |
| UI 入口        | `SpreadsheetToolbar.tsx`、`SpreadsheetMenuBar.tsx`（P2）；`SpreadsheetFilterDropdown.tsx`（P3） | `runFilterSortEntrypointAtom` 排序分支 / `sort` intent 改派 `runPhysicalSortAtom`；capability 缺失沿用禁用/隐藏惯例                                                                                                                                                                                              |

v1 范围钉子：只做"整数据区按激活列排序"（与现网入口 UX 等价，header 行 0 由 range 起点排除）；"仅选区排序 / 表头检测 / 多键 UI"不在本设计（多键引擎 API 已支持，UI 后续）。

---

## 9｜测试与验收计划

### 9.1 新增测试矩阵

**Rust 单测（`sort.rs` + `sheet.rs` 集成）**：

| 维度   | 用例                                                                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 比较器 | 类型序全排列；空恒最后（升/降）；数字（负数/0/日期序列/NaN）；文本 case fold 默认与 `case_sensitive`；布尔；错误值互等；多键与方向逐键 |
| 稳定性 | 键全等大列表保持原可见槽位序；重复排序幂等                                                                                             |
| 排除集 | E 行原位不动、不参与比较；E=∅ 整段重排；E 覆盖全 range → no-op；range 外条目忽略                                                       |
| 公式   | verbatim：AST 与 parked source 原文搬运；range 外引用 range 内的公式经依赖图重算取新值；搬移后公式取值正确                             |
| 格式   | per-cell 随行；层相交时物化 + 切割后语义等价（range 内外对照）；快照/恢复精确回滚层几何                                                |
| 门禁   | spill anchor/target 相交拒绝；`EmptyKeys` / `KeyOutOfRange` / `InvalidRange`                                                           |
| 其他   | no-op 零写入；行高不动；range 外单元格逐格不动（含订阅通知只发给真变更地址）                                                           |

**桥/adapter**：wasm `sort_range` JSON 出入与错误码；**parity golden fixtures**（同一工作簿 + keys + excluded，static 结果 ≡ worker/WASM 结果，含比较器边角）；worker 路径 `recordCellMutation` undo/redo roundtrip（clear→restore 序）；merge 门禁与 `SORT_SOURCE_TOO_LARGE`；TS runtime `UNSUPPORTED` + 端口 getter 为 `undefined`。

**UI-core**：capability 见证与入口禁用；`runPhysicalSortAtom` 组载荷（excluded 集组装、directives 先清）；filter-active 禁用；单 lane 状态机沿用既有 14 例词汇。

**e2e**：工具栏排序 → 可见序变化 **且** 关筛选/直读引擎证实数据物理移动；undo 完整还原（值 + 格式）；含 hidden 行排序 → hidden 行原位；含 merge 排序 → 拒绝提示；TS worker demo 页排序入口隐藏。

### 9.2 验收门禁

- `cargo test -p einfach-excel-core`；`npm run build:wasm` 后 `npx jest solid/excel --no-coverage`、`npx jest vanilla/spreadsheet-ui-core --no-coverage`；e2e 定向 spec；每个 UI 可见切片后 playwright MCP 手工 smoke（既有工作惯例）。

### 9.3 既有 pin 迁移清单

| 批  | 文件:行                                                                                                                                          | 现 pin                                                                                                                                                                                 | 迁移动作                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| P2  | `solid/excel/test/vnext-toolbar.test.tsx:587-668`                                                                                                | 工具栏排序写 `setFilterSort` 指令                                                                                                                                                      | 改断言派发 `sortRange` 载荷（T14 dropdown-dismiss 回归保留）                                     |
| P2  | `solid/excel/test/vnext-menu-bar.test.tsx:1237/1273`                                                                                             | 菜单排序写指令                                                                                                                                                                         | 同上                                                                                             |
| P2  | `vanilla/spreadsheet-ui-core/test/filter-sort.test.ts:524-563`                                                                                   | `dispatchSortAtom` 多键主序                                                                                                                                                            | 指令多键语义随显示置换退役重写为物理排序载荷断言（多键 UI 未上前先 pin 单键）                    |
| P2  | `vanilla/spreadsheet-ui-core/test/filter-sort.test.ts:595-1669`                                                                                  | 入口状态机 22 例                                                                                                                                                                       | 状态机保留，transport 换 `sortRange`，逐例改桩                                                   |
| P2  | e2e `toolbar-filter-sort.spec.ts:164-203`、`toolbar-number-format.spec.ts:127-144`                                                               | 排序后可见序                                                                                                                                                                           | 可见序断言不变；追加"数据物理移动 + undo 还原"断言                                               |
| P3  | `solid/excel/test/vnext-adapter.test.ts:1044-1188`、`vnext-worker-filter-sort.test.tsx:296-327/351-385`、`audit-adapter-scaling.test.ts:406-491` | 显示置换 + `setCell` 零调用 + clear 还原                                                                                                                                               | 排序断言改物理路径；filter 压缩与 `originalRow`/W2 网关断言**保留**（filter 可见性继续显示压缩） |
| P3  | e2e `vnext-filter-sort-real-backend.spec.ts:53-112`                                                                                              | filter 压缩 + display 写 source                                                                                                                                                        | 保留（纯 filter）；若含排序步骤则改物理断言                                                      |
| P3  | 文档                                                                                                                                             | `filter-sort.md`、`06-tables-data-management.md:47-48/74-75/505-521`、`CUTOVER_INVENTORY.md:202`（含与 FLIPPED 测试的矛盾）、`README.md` #29 行、`CANONICAL_OWNERSHIP.md` #29 闭环备注 | S6 一并收口                                                                                      |

跳过项复活：`audit-structural.spec.ts:141-152`（skipped 的 "Data → Sort 重排行" e2e）在 P2 取消 skip 并按物理语义启用。

---

## 10｜分切片实施计划

每切片独立可合、门禁自含；S1–S4 零 UI 可见变化。

| 切片                      | 内容                                                                                                                                                                                | 文件边界                                                                                                                             | 门禁                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| **S1 引擎**               | `sort.rs`（`sort_cmp` + 槽位算法 + 格式层物化/切割 + `sort_range`）、`Sheet`/`Workbook` 接线                                                                                        | 仅 `rust/excel-core/src/`（`sort.rs` 新增；`lib.rs`/`sheet.rs`/`workbook.rs` 小改）                                                  | `cargo test -p einfach-excel-core`（§9.1 Rust 矩阵全绿）；不触 wasm/TS             |
| **S2 桥与协议**           | wasm `sort_range` 导出；协议 `sortRange` + capability 键；WASM runtime case；TS runtime `false` + `unsupported`                                                                     | `rust/wasm/src/lib.rs`；`adapter/worker-protocol.ts`、`worker-runtime.ts`、`worker-runtime-ts.ts`                                    | `npm run build:wasm`；runtime 单测（含 TS `UNSUPPORTED`）；不触端口/UI             |
| **S3 端口与参考实现**     | `backend/types.ts` 端口；`adapter/sort-order.ts` 共享比较器；static 实现；worker `sortRangeThroughWorker`（merge/规模门禁 + undo 记录）                                             | `vanilla/spreadsheet-ui-core/src/backend/types.ts`；`adapter/sort-order.ts`（新）、`static-backend.ts`、`worker-workbook-backend.ts` | `npx jest solid/excel --no-coverage`；parity golden fixtures + undo roundtrip 全绿 |
| **S4 UI-core 命令**       | `sortRangeSupportedAtom`、`runPhysicalSortAtom`、excluded 集组装、filter-active 禁用、directives 预清                                                                               | `vanilla/spreadsheet-ui-core/src/filter-sort/`（README 同步原子分类）                                                                | `npx jest vanilla/spreadsheet-ui-core --no-coverage`；UI 未接线、既有 e2e 不受扰   |
| **S5 入口翻转 P2**        | 工具栏 + 菜单排序改派物理排序；pin 迁移批 P2（§9.3）；复活 skipped e2e                                                                                                              | `toolbar/SpreadsheetToolbar.tsx`、`menu-bar/SpreadsheetMenuBar.tsx`；对应 test/e2e 文件                                              | 定向 e2e + 全套 jest；playwright MCP 手工 smoke（排序→undo→TS demo 入口隐藏）      |
| **S6 下拉翻转 P3 + 收口** | 筛选下拉排序改派；`directives` 退役（`FilterSortState`/`SetFilterSortRequest`/`buildFilterSortDisplayRows` 排序支路移除）；pin 迁移批 P3；文档收口（含 CUTOVER #29 矛盾 reconcile） | `filter-sort/SpreadsheetFilterDropdown.tsx`、`filter-sort/index.ts`、`projection-helpers.ts`；§9.3 P3 文档清单                       | 全套 jest + e2e；smoke；文档互链一致性人工核对                                     |
| **S7（可选）TS 真实现**   | excel-core-ts `sortRange` + capability 翻 true                                                                                                                                      | `vanilla/excel-core-ts/src/`、`worker-runtime-ts.ts`                                                                                 | 复用 S3 parity fixtures 三口径全绿                                                 |

依赖：S1→S2→S3→S4→S5→S6 串行（S1/S2 可与 S4 的纯 UI-core 部分并行开工，合流在 S3 端口形状冻结后）；S6 中"解除 filter-active 禁用"一步**另有前置**——翻转顺序第 3 步（filter 可见性 UI-core canonical）落地；若第 3 步晚于 S6，则 S6 保留禁用、留一个尾切片解除。

---

## 11｜Conformance notes 与未决项

**有意发散（记录在案，不阻塞）**：

1. range 内相对引用不随行平移（Excel 保持 R1C1 偏移）——verbatim 裁决，§4。
2. 文本比较无 locale collation（Excel 按区域设置排序）——determinism 优先，§3.2。
3. 批注 / 数据验证 / 条件格式 overlay 不随行移动（Excel 移动批注与验证）——`row_permutation` 见证已预留，overlay remap 为后续工作项，§5.3。
4. "文本型数字与数字分开/合并排序"的 Excel 提示交互不做，§3.2。

**未决 / 依赖**：

1. 翻转第 3 步（filter 可见性 UI-core canonical）的落地时点决定 filtered-out 排除集何时可用（§2.2/§10）。
2. `CUTOVER_INVENTORY.md:202` #29 旧文案与树上已 FLIPPED 的 worker 显示置换测试矛盾——S6 收口责任，先于本设计不处理。
3. `relocate_cells` 全图重建的 range 局部化（性能）——待 S1 落地后按实测决定是否立项。
4. 多键排序 UI（引擎 API 已支持 keys 数组）——独立产品切片。
