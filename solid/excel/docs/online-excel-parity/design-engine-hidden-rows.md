# 设计｜隐藏行下沉：从"宿主推送求值输入"到"引擎拥有状态"

- **状态**：**E0–E8 已全量落地（2026-07-22），E9 文档收口完成。** 本文既是裁决记录、
  也是 as-built 收口 —— 见 §0 的"E9 收敛"块。找现行契约请读
  `vanilla/spreadsheet-ui-core/docs/filter-sort.md`（引擎拥有筛选、谓词在 Rust 求值）
  与 `CANONICAL_OWNERSHIP.md` #03 / #29（已翻为引擎 canonical）。
- **日期**：2026-07-21
- **基线**：分支 `claude/rust-core-state-plan-Auzcj`，`a3325e7`
- **前置**：[design-filter-hidden-rows.md](./design-filter-hidden-rows.md)（#27，已全量落地）；
  [design-engine-sort.md](./design-engine-sort.md)（#29 排序物理化，已落地）
- **范围**：把**隐藏行集合 + 筛选规则 + 筛选谓词求值**从宿主（UI-core / adapter）
  下沉到 `rust/excel-core`。**隐藏列不动**（§8）。

---

## 0｜裁决摘要

> ### E9 收敛（2026-07-22）：全切片已落地，本文转为设计 + as-built 记录
>
> **E0–E8 已全部落地并合入**（提交 `2fd3cc5` `82f4283` `8ffd9ff` `7dc8667`
> `931612b` `7b51e07` `f75488f` `064ef93` `9d7e18d` `e1a52bd`）。下方修正 1–12 是各切片
> 实施者核实写入的偏离；本块把它们收敛成一致的最终态，§10.1 切片表与 §4.2 / §6.3 / §7.1
> 正文均已标注 as-built。读现行契约优先看 `vanilla/spreadsheet-ui-core/docs/filter-sort.md`
> 与 `CANONICAL_OWNERSHIP.md` #03 / #29（本次已翻为引擎 canonical）。
>
> **落地形状与设计稿的实质差异（修正 1–12 收敛结论，均已回代码核实）：**
>
> 1. **引擎确实拿到全部拥有态**（Rust，§1–§3 / §5.2 / §6.2 照做）：
>    `Sheet.hidden_rows`、`SheetAutoFilter`（规则 + 派生隐藏集）、
>    `apply/reapply/clear_filter`、`hide/unhide_rows`、`snapshot/restore_hidden`、
>    `republish_hidden`（含分集合幂等去重）；`WorkbookAtomContext` 两张表降级为只读镜像
>    （`sheet.rs` `eval_hidden_rows` / `eval_filter_hidden_rows`）。persistence v1 新增
>    `hidden` / `filters` 字段（`rust/wasm/src/lib.rs`），闭合 xlsx parity 缺口。
> 2. **谓词落点是"每个引擎一份"**（§5.2 采纳）：worker 经引擎 `applyFilter` 在 Rust 内
>    求值（E5 删掉适配器扫描，`worker-workbook-backend.ts` 零 `buildFilterSortDisplayRows`
>    命中）；static 是第二引擎，保留 TS 谓词 —— **实名 `filter-predicate.ts`，非设计稿
>    计划的 `static-filter-predicate.ts`**（E4 落地时 worker 仍用它，故中性命名；E5 后
>    已 static-only，文件未改名，其头部注释"E5 removes it / both adapters"已过期）。
>    UI-core 谓词零知识（`grep filterRuleMatchesValue vanilla/spreadsheet-ui-core/src` 零命中）。
> 3. **手动隐藏的引擎 feed 是 `setEvalHiddenRows`（整集替换），不是 `hideRows` 端口**
>    （修正 6）：worker 适配器从未把 `hideRows` / `unhideRows` 暴露到 `SpreadsheetBackend`；
>    feed 从被删的 `eval-hidden-rows-bridge.ts` 搬进原子的乐观 + 对账路径
>    （`viewport/hidden.ts` `feedAndReconcileHiddenRows`），`readSheetHiddenState` 做无条件
>    对账回读，`hideRows` / `unhideRows` 仅作"两者皆无时"的 fire-and-forget 后备。
>    §4.2 假设的"经 `hideRows` 端口 ACK 写"前提**不成立**。乐观写 + 无条件对账（§4.3）已落地，
>    实测 worker 往返：乐观重绘 ~11ms、SUBTOTAL 落定 ~19ms、撤销 ~20ms。
> 4. **筛选 undo 走引擎快照 `snapshotFilters` / `restoreFilters`**（E8，修正 11），
>    取代 §6.2 泛指的 `restore_hidden`；`setEvalFilterHiddenRows` 现被适配器**弃用**
>    （WASM 端口仍在，INV-4 加法式包袱）。
> 5. **UI-core 渲染缓存需一条新 re-hydration**（修正 9）：引擎快照恢复不了
>    `viewportFilterHiddenAtom`，故 provider 撤销/重做后从 `readSheetHiddenState.filterRows`
>    回读写回（`provider/history-dispatch.ts` `reconcileFilterHiddenFromEngine`）。
>    §6.3"筛选侧引擎快照覆盖 = 可全删"不完整。
> 6. **筛选侧前向结构位移保留、只删 local-replay 恢复路径**（修正 10）：
>    `applyViewportFilterHiddenStructuralShiftAtom`（乐观同 tick 投影）保留；
>    `VIEWPORT_FILTER_HIDDEN_REPLAY_KEY` 及其 applier、两处 side payload 已删。
> 7. **手动侧 adapter 不动**（修正 11）：E7 后手动 local-replay applier 经
>    `feedAndReconcileHiddenRows` 已把引擎恢复对了，再加 `snapshot_hidden` 会双恢复
>    （§10.2-7 警告），故 E8 不给手动事务加 `snapshot_hidden`。§6.2 / 切片表 E8 行的
>    "手动侧记 snapshot_hidden" **不采纳**；手动侧仍保留 local-replay。
> 8. **static 补了 `readSheetHiddenState`**（修正 12，设计假设两后端都有、static 原本没有），
>    读自 `hiddenRowsBySheetId` / `filterHiddenRowsBySheetId` / `filterSortBySheetId`，
>    re-hydration 才能在 static 上工作。static 双 lane 并集按修正 8 退休。
> 9. **`filter-hidden-rows.ts` 未整文件删除**：§7.1 DELETE 清单列它全删，实际它**保留** ——
>    仍持 `filterHiddenRowsFromDisplayRows`（static 折排列→隐藏集，`static-backend.ts`）与
>    `filterTsvBandRows`（两后端 TSV 导出）。§7.1 为设计期估算，实际删除集以各切片提交为准。
> 10. **E0 / E1 前置已完成**（修正 2）：`2fd3cc5` / `82f4283`（D1 重键 + 位移）、
>     `8ffd9ff`（outline 解耦）。
>
> **修正间无冲突**：修正 7（E7 把筛选侧 local-replay 删除推迟到 E8）与修正 9–11
> （E8 删 local-replay + 新增 re-hydration + 保前向位移 + 手动侧不动）是同一决定的先后两半，
> 已一致收敛，不是矛盾。
>
> ---

> ### as-built 修正（2026-07-21，E2 实施后核实写入）—— **E3 动工前必读**
>
> **修正 1（§2.1 的头两条理由已失效）**：§2.1 把"结构位移免费跟随""sheet 生命周期免费跟随"列为 `Sheet` 拥有态的好处。**这两条在 E2 动工前就已成立** —— `2fd3cc5` 已给 index-keyed 镜像补了 sheet 增删移重键，`82f4283` 已给它补了行号随结构位移平移。放置位置仍然正确，但**理由应改为第 3、4 条**：persistence-v1 本来就遍历 sheets（新字段无需自建 keying），且该集合与 `row_heights` 是同一**种**事实（稀疏、行索引、per-sheet 尺寸元数据）。
>
> **修正 2（§9.1-D1 已过期）**：D1 被描述为"真实缺陷，现网存在……建议独立修复"，**已由 `2fd3cc5` 修复**。切片表 **E0 状态 = 已完成**；E1（outline 解耦）亦已完成（`8ffd9ff`）。
>
> **修正 3（§6.2 未指定快照键 —— E3 最容易抄错的一条）**：`snapshot_hidden` / `restore_hidden` 按 **sheet 索引**键，**不是按名字**。不要照抄 Table 的名字锚定：Table 之所以按名字，是因为注册表是 **workbook 级命名空间**、必须扛过 `moveSheet`；而隐藏行是 **per-`Sheet` 元数据**，随 `moveSheet` 自动跟走，且本仓其余每一个 per-sheet 持久化载荷（formats、sizes）都已是索引键。E3 的筛选状态同理。
>
> **修正 4（§3 措辞易误读）**：§3 的"分别判断两个集合"读起来像是 E2 会 republish 两侧。**E2 只 republish 手动侧**；筛选存储与 `filter_hidden_epoch` 在 E3 之前原样未动。
>
> **修正 5（§4.3 乐观写）**：见 §4.3 内的主控裁定块 —— 乐观写 + 无条件对账已定为**默认**而非备选。

> ### as-built 修正（2026-07-22，E7 实施后核实写入）—— **E8 动工前必读**
>
> **修正 6（§4.2 的核心前提过期 —— 引擎的手动集合 feed 端口）**：§4.2 / §7.1 / §10.1-E7 假设**手动隐藏经 `hideRows` / `unhideRows` 端口下沉引擎**，E7 把 UI-core 从"本地写"翻成"经这两个端口 ACK 写"。**核实所得：worker adapter 从未暴露 `hideRows` / `unhideRows` 端口。** E5 只暴露了 `setFilterSort` + `readSheetHiddenState`（`worker-workbook-backend.ts:4077/4088`，均 `engineHiddenState` 门禁），手动集合的引擎 feed **一直是 `setEvalHiddenRows`（整集替换，`:4147`，`evalHiddenRows` 门禁）**，由被删的 `eval-hidden-rows-bridge` 驱动。静态后端虽有 `hideRows` 端口，但也暴露 `setEvalHiddenRows`。**后果**：删 bridge 后若照 §4.2 只调 `hideRows`，worker 的引擎永不收到手动隐藏 → SUBTOTAL 101-111 不排除（UI smoke 实测：隐藏后 G2=SUBTOTAL(109) 停在 100 不变 80）。**E7 的实际形状**：手动 feed 走 `setEvalHiddenRows`（整集，两后端都支持），从 bridge 搬进 atom 的乐观+对账路径（`viewport/hidden.ts` `feedAndReconcileHiddenRows`）；`readSheetHiddenState` 做无条件对账；`hideRows`/`unhideRows` 降级为"仅有它们时"的 fire-and-forget 镜像后备。**"宿主推"没有消失，因为 adapter 没建 §4.2 假设的端口**；要真正做到"引擎 ACK 写、零推送"必须先给 worker 暴露 `hideRows`/`unhideRows` 端口（adapter 活，E7 范围外）。
>
> **修正 7（§10.1-E7 的筛选侧删除与 §10.2-7 冲突）**：E7 行要求"筛选侧 local-replay + 结构位移全删"。**核实所得：这与 §10.2-7（E8 晚于 E7）及 #27 回归 e2e 硬冲突。** `vnext-filter-structural-shift-real-backend.spec.ts:164-170` 断言撤销结构操作时**靠 local-replay 记录像恢复筛选缓存**；`undoTransaction`（`HistoryTransactionResult`）不回传隐藏态，所以引擎事务撤销不会重建 UI-core 筛选缓存；引擎快照撤销是 E8。**E7 若删掉筛选侧 local-replay，撤销即无法恢复筛选缓存，#27 e2e 变红。** 故 E7 **保留**筛选侧结构位移 + local-replay（引擎自平移与 UI-core 乐观平移同语义、同结果），把它们的删除**推迟到 E8（undo 改道引擎快照同切片）**。切片表应把"筛选侧 local-replay 删除"从 E7 移到 E8。
>
> **修正 8（§5.1/§7.1 static 双 lane 的退休方式）**：E6 报告说 static 的 `evalHiddenRowsForSheet` 双 lane（`hiddenRowsBySheetId` ∪ `evalHiddenRowsBySheetId`）"随 bridge 在 E7 退休"。**实际退休方式**：把 `setEvalHiddenRows` 改成整集替换 `hiddenRowsBySheetId`（与 WASM 引擎 `set_eval_hidden_rows` 写唯一 `Sheet::hidden_rows` 同构），删掉独立的 `evalHiddenRowsBySheetId` 与并集。**端口本身保留**（与 WASM 的 INV-4 永久包袱对齐；parity 断言 `port.setEvalHiddenRows==true`）。唯一退休的是那个 static-only、与 WASM 分歧的"并集"语义 —— 连带删掉 `vnext-static-tables` 里断言该并集的一条用例。

> ### as-built 修正（2026-07-22，E8 实施后核实写入）
>
> **修正 9（§6.3 "引擎快照覆盖"不完整 —— UI-core 渲染缓存需要一条新的 re-hydration 路径）**：§6.3 说筛选侧 local-replay "可全删，引擎快照覆盖"。**核实所得：引擎快照（`restoreFilters`）只恢复 _引擎_ 拥有态与 adapter 的 withholding 镜像，恢复不了 UI-core 的渲染缓存 `viewportFilterHiddenAtom`。** 该缓存是 Grid 画哪几行的真值来源（`SpreadsheetGrid.tsx:688/771/1193` 经 `effectiveHiddenAtom` 读它），删掉 local-replay 后无人恢复它 → 撤销后画错行、#27 变红。**E8 的实际形状**：删掉筛选侧 local-replay 后，**新增**一条 re-hydration —— 撤销/重做结束时 provider 从引擎回读 `readSheetHiddenState.filterRows` 写回该缓存（`provider/history-dispatch.ts` `reconcileFilterHiddenFromEngine`，接进 `dispatchUndo`/`dispatchRedo`/`retryHistoryRefresh` 的 refresh）。与 local-replay 的记录像逐字相同（两者都源自同一引擎快照的 before/after）。
>
> **修正 10（§6.3 "结构位移全删"会引入重绘闪烁 —— 前向位移保留）**：修正 7 与 §7.1 要求筛选侧 local-replay **与结构位移**一并删。**核实所得：删前向位移（`applyViewportFilterHiddenStructuralShiftAtom`）会让插入行后、异步 re-hydration 回来前有一帧筛选缓存陈旧（画错行）。** 手动侧同样保留其前向位移（乐观、同 tick），二者对称。**E8 只删 local-replay（撤销恢复），保留前向位移**（乐观、同 tick 的渲染投影，非 local-replay）。切片表 E8 行的"结构位移全删"应改为"只删 local-replay 恢复路径，前向位移保留"。
>
> **修正 11（手动侧 §6.2 的 `snapshot_hidden` 在 E7 后已冗余 —— E8 不动手动侧 adapter）**：§6.2 与切片表 E8 行要求"宿主事务日志改记 `snapshot_hidden`（手动隐藏侧）"。**核实所得：E7 后手动侧撤销已经把引擎恢复对了** —— 手动 local-replay applier（保留）经 `feedAndReconcileHiddenRows` 用 `setEvalHiddenRows`（整集）把恢复后的手动集重新喂进引擎并对账，删除吞掉成员的无逆情况也由记录像的 before 覆盖。**再加 `snapshot_hidden`/`restore_hidden` 到手动事务会形成对同一引擎集合的第二条恢复路径（§10.2-7 警告的双恢复）**，故 E8 **不动手动侧 adapter**。手动侧仅需 §6.3 已裁定的"local-replay 不删"。**筛选侧则相反下沉**：改用 `snapshotFilters`/`restoreFilters`（替换 E7 的 `filterHiddenOverlay` adapter-memory 前后像 + `setEvalFilterHiddenRows` 回推），因为筛选缓存是纯投影、无自己的写路径。
>
> **修正 12（static 缺 `readSheetHiddenState` —— E8 补上）**：§4.2 假设 `readSheetHiddenState` 两后端都有。**核实所得：static 从未实现它**（只有 worker 实现，`engineHiddenState` 门禁）。E8 的筛选缓存 re-hydration 依赖它，故给 static 补了一个（读自 `hiddenRowsBySheetId` / `filterHiddenRowsBySheetId` / `filterSortBySheetId`）；static 引擎态本就由 `restoreFullSheet`（含 `filterHiddenRows`）在事务里恢复，无需改。**副作用**：static 现在也有 `readSheetHiddenState`，手动侧 `feedAndReconcileHiddenRows` 在 static 上也会走对账回读（此前 static 只走乐观写）；结果值不变（对账回读同值），行为中性。

| #   | 问题                | 裁决                                                                                                                 |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | 状态挂哪            | **`Sheet` 拥有**（紧邻 `row_heights`），`WorkbookAtomContext` 的两张 index-keyed 表降级为**引擎内部只读镜像**，由一个私有 `republish_hidden` 单点同步。筛选规则与其派生集合合成一个 `Sheet.filter: Option<SheetAutoFilter>` |
| 2   | 谓词求值时机        | **命令式 `&mut self` 入口，绝不建成派生原子。** 只有 `apply_filter` / `reapply_filter` / `clear_filter` 会重算；写单元格永不重算。这既是 Excel 快照语义，也是**避免真实依赖环**的唯一形状（§2.2） |
| 3   | 双 epoch            | **零改动。** 双 epoch 与 `subtotal_hidden_for_arg` 的选择性 hook 调用整体位于归属缝之下。唯一新增义务：**幂等去重必须从 bridge 搬进 Rust**，否则每次结构操作弄脏全簿 SUBTOTAL（§3） |
| 4   | UI-core 读取路径    | 两个 atom **保留形状、更换写者**：从"UI-core 命令写"改为"backend ACK 写"。新增整表读 `readSheetHiddenState`（**不是** window-bounded 的 `readViewportSizeProjection`）。**零逐帧 RPC**。代价是手动隐藏从同步变异步 —— 这是本设计最大的产品风险（§4） |
| 5   | static 后端         | **保留 TS 谓词，但重新定性**：static 是第二个引擎，不是 UI-core 的一部分。谓词从 `spreadsheet-ui-core/src/backend/` 迁到 `src-vnext/adapter/`，由黄金对照钉死（照抄 `vnext-sort-static-wasm-parity.test.ts`）。**UI-core 从此零谓词知识** |
| 6   | undo / 持久化       | 改走引擎快照：新增 `snapshot_hidden` / `restore_hidden`（照抄 `snapshot_tables` / `restore_tables`）+ persistence v1 新增两个字段。**删掉筛选侧 local-replay；手动侧不能删**（大纲折叠占用同一 applier，§6.3） |
| 7   | 净增减              | **诚实结论：不净减代码。** TS 净减 ≈ 800 行，Rust + wire 净增 ≈ 800-1000 行，总量大致持平。真正的收益是**同一事实的副本数 5 → 1**，以及两类实锤缺陷（E7 三层平移、sheet 重排不重键）的根除。若主控的判据严格是"净减行数"，本方案不达标 —— 见 §7 的取舍表 |
| 8   | 隐藏列              | **不动。** 引擎全仓零建模（核实见 §8）；`SUBTOTAL` 只按 `addr.row` 过滤。判据的反面例证。**但会产生一个必须处理的后果**：`viewportHiddenAtom` 将行/列两轴归属不同，必须拆原子 |

---

## 1｜翻转论证：前提为何过期

### 1.1 被翻转的那句话

`CANONICAL_OWNERSHIP.md:9` 是 2026-07-19 "混合翻转 C-modified" 裁决的第一条依据：

> **视口事实从未真实活在 backend。** hidden 行列、freeze、filter 可见性、protection 在纸面上是
> backend canonical，实际只活在 `static-backend` 的内存态；两个引擎（`rust/excel-core`、
> `vanilla/excel-core-ts`）和 worker RPC 从未建模它们；**引擎没有任何公式读取 hidden
> （SUBTOTAL 101-111 被折算为 1-11）**。

据此 `CANONICAL_OWNERSHIP.md:39`（#03）把"隐藏/取消隐藏"判为 UI-core 视图事实，
`:65`（#29）把"筛选可见性"同判。**当日这个判断是正确的**：加粗那句在当时逐字为真。

### 1.2 前提在 #27 与 #32 之间死掉了

三处代码把它推翻了，全部已落地：

1. **引擎有了两个隐藏集，且是真实求值输入。**
   `rust/excel-core/src/sheet.rs:947` `eval_hidden_rows`、`:954` `eval_filter_hidden_rows`。
2. **`SUBTOTAL` 真的读它们，且两档规则不同。**
   `rust/excel-core/src/eval.rs:19694-19699` 定义 `SubtotalHiddenPolicy`
   （`IncludeAll` / `ExcludeFilter` / `ExcludeFilterAndManual`）；
   `:19737-19762` 的 `subtotal_hidden_for_arg` **选择性**调用两个 provider hook；
   `:19765-19786` 的 `for_each_subtotal_value` 按 `hidden.contains(addr.row)` 跳行。
   1-11 只读 filter 集、101-111 两个都读 —— `:19733-19735` 的注释把这条钉死。
3. **求值结果因此可观测地不同。** `filter-sort.md`（docs）"User-visible behaviour changes"
   第 5 条：`SUBTOTAL(1-11)` 在筛选激活时会变小。这不是渲染差异，是**数字变了**。

`CANONICAL_OWNERSHIP.md:129` 的 §7-1 勘误已经承认了一半 —— 它订正了"手动/filter 同一集合"
这句，改成两个集合两个端口两个 epoch。**但它没有回头动 §2 的分类表和 #03 / #29 两行。**
勘误停在了"实现形状"，没有走到"归属结论"。本设计做的就是那一步。

### 1.3 判据：影响计算的状态归引擎

用户的判据把这件事说得比"canonical 归属四分类"更清楚：

> **影响计算的状态归引擎，不影响计算的归视图。**

按此重判 `CANONICAL_OWNERSHIP.md:21` 那一行的五项：

| 事实         | 影响计算？                                   | 归属      |
| ------------ | -------------------------------------------- | --------- |
| freeze       | 否                                           | UI-core   |
| 行高列宽     | 否（as-built 已修正为引擎，理由是既有实现，不是判据） | 引擎（不动） |
| **隐藏行**   | **是** —— `SUBTOTAL` 两档（eval.rs:19694+）  | **引擎**  |
| **筛选可见性** | **是** —— 同上，且 1-11 只读它               | **引擎**  |
| 隐藏列       | **否** —— 引擎零建模，`SUBTOTAL` 只过滤 `addr.row`（eval.rs:19779） | UI-core（不动） |
| protection   | 否                                           | UI-core   |

隐藏列这一行是**判据的负对照**：同一个原子里的两条轴，因为一条影响计算一条不影响，
归属分开。这不是折中，是判据本身在起作用。

### 1.4 这不是反复横跳

写给后来者的一句话总结：

> 2026-07-19 判 UI-core，理由是"引擎不读 hidden"。#27（2026-07-21）让引擎真的读了。
> 判据没变，前提变了，所以结论跟着变。**本次翻转推翻的是一个已经过期的事实陈述，
> 不是一个当时错误的决策。**

如果哪天 `SUBTOTAL` 的两档规则被删掉、`AGGREGATE` 的 ignore-hidden 位也确定不做，
那么按同一判据，隐藏行应该翻回 UI-core。判据是稳定的，归属是判据的函数。

---

## 2｜Q1 / Q2：状态挂哪、谓词何时算

### 2.1 状态挂哪 —— `Sheet` 拥有，context 降级为镜像

**现状（已核实）**：唯一的存储是 `WorkbookAtomContext` 上两张
`RefCell<HashMap<usize, Rc<HashSet<u32>>>>`（`sheet.rs:947` / `:954`），**按 sheet 索引键**。
`sheet.rs:942-946` 给出了放在 context 而非 `Sheet` 的理由：所有 sheet 共享一个 `Store`，
跨表 SUBTOTAL 必须从一个 provider 够到任意 sheet 的集合。

**核实所得的缺陷（新发现，见 §9-D1）**：`Workbook::remove_sheet`（`workbook.rs:1754-1778`）
与 `move_sheet`（`:1081-1099`）**都不重键这两张表**。`workbook.rs` 全文只在 `:2474` / `:2497`
两处提到 `eval_hidden_rows`，即两个 setter 本身。Table 注册表没有这个问题，因为它按
**表名**键、内部存 `sheet_name`，`remove_sheet` 用 `self.tables.retain(|_, t| t.sheet_name != name)`
（`:1770`）维护。索引键的隐藏集没有对应机制。

**裁决**：

```
Sheet {
    row_heights: BTreeMap<u32, u32>,          // 既有，sheet.rs:657
    col_widths:  BTreeMap<u32, u32>,          // 既有，sheet.rs:659
    hidden_rows: BTreeSet<u32>,               // 新增：手动隐藏
    filter:      Option<SheetAutoFilter>,     // 新增：规则 + 派生隐藏集
}

struct SheetAutoFilter {
    range:  Option<CellRange>,   // Excel 的 autoFilter ref；None = 全表
    rules:  Vec<ColumnFilterRule>,
    hidden: BTreeSet<u32>,       // 派生，只由 apply/reapply 写
}
```

四条理由，每条对应一个既有事实：

1. **结构位移免费跟随。** `Sheet::insert_row` / `delete_row` 已是 sheet 方法，
   `Workbook::insert_rows`（`workbook.rs:2525`）经
   `apply_structural_shift_with_table_follow`（`:2556`）委派给它，
   而 wasm 的 `insert_row`（`rust/wasm/src/lib.rs:2550-2551`）**已经**路由到
   `self.workbook.insert_rows`（T6 已落地，`workbook.rs:2519-2522` 的
   "wasm 仍直调 Sheet" 注释已过期，见 §9-D2）。隐藏集与 `row_heights` 同处一层，
   位移逻辑写一次。**这一条直接消灭 #27 勘误 E7 的三层平移**
   （`design-filter-hidden-rows.md:51`：UI-core / 两个 adapter 快照 / 引擎副本，"缺任一层复现都不算修好"）。
2. **sheet 生命周期免费跟随。** `move_sheet` 整体搬 `Sheet`，`remove_sheet` 整体 drop，
   D1 那个缺陷结构上不可表达。
3. **持久化免费跟随。** persistence v1 的 sheet 元数据已按 sheet 组织
   （`rust/wasm/src/lib.rs:1130` `sheets: Vec<WorkbookPersistenceSheetMetaJSON>`）。
4. **与既有维度状态同构。** 行高列宽已经是 `Sheet` 的 `BTreeMap`，隐藏行是同类事实。

**context 那两张表保留，但改成引擎内部镜像。** 它们的存在理由（跨表 SUBTOTAL 的
formula-inner 路径够不到 `&Workbook`）没有消失，`depend_manual_hidden` /
`depend_filter_hidden`（`sheet.rs:1064-1076`）与 `hidden_rows_for_sheet` /
`filter_hidden_rows_for_sheet`（`:1083-1105`）整条读路径逐字不变。
变的只有**写者**：从 `Workbook::set_eval_hidden_rows`（宿主端口）改为一个私有

```rust
fn republish_hidden(&mut self, sheet_index: usize)   // 单 sheet
fn republish_hidden_all(&mut self)                   // 拓扑变化后
```

调用点是有限且可枚举的：hide/unhide、apply/reapply/clear filter、结构位移、
`sync_atom_topology`（`workbook.rs:685-696`，`add_sheet` / `remove_sheet` / `move_sheet`
三处都调它）、`restore_hidden`、persistence restore。

> **诚实标注**：这在 Rust 内保留了**两份**副本。它比现状（UI-core atom / static Map /
> worker Map / 引擎手动集 / 引擎筛选集 = 5 份，跨 3 个包与一次 postMessage）好，
> 但不是"一份"。把 context 教会直接持有 `Sheet` 的集合、或按稳定 sheet id 而非索引键，
> 是更干净的形状，**但我没有核实是否存在稳定 sheet id** —— 列为待验证项 §9-V1。

**规则存哪、照不照 Table 样板**：**只照它的 snapshot/restore 一半，不照它的注册表一半。**
Table 是工作簿级具名实体，所以有 `HashMap<name, Table>` + cap 256 + 命名互斥
（`workbook.rs:170/239-271`）。筛选是 per-sheet 匿名单例，没有名字、没有互斥、
cap 天然是 1。硬套注册表只会带来不需要的键空间。
要照抄的是 `snapshot_tables`（`:2170`）/ `restore_tables`（`:2212`）那对
REPLACE 语义原语，它的文档（`:239-258`）把宿主 undo 用法写得很直白：
"A host undo transaction records `snapshot_tables()` as the before-image,
applies the mutation, and calls `restore_tables(before)` to undo."

**待裁决**：Excel 里每个 Table 有自己的筛选，sheet 的 AutoFilter 是另一个。
#32 已经有 Table 注册表了，所以"一个 sheet 一个筛选"这个 cap 是否够，
取决于是否要做 Table 级筛选。列为 §9-V2。

### 2.2 谓词何时算 —— 命令式，绝不建成派生原子

这是本设计**最容易做错**的一处，必须写死。

引擎有一个通用的 atom `Store`，spill 派生原子（`sheet.rs` § Spill）与 Table epoch
（`:1043-1057`）都在用它。把"筛选隐藏集"建模成"谓词列的派生原子"在技术上完全可行，
**而这正是陷阱**。三条否决理由，严重度递减：

1. **它会制造一个真实的依赖环。** `SUBTOTAL` 读筛选集（`eval.rs:19756`）；
   派生的筛选集会读谓词列的单元格；谓词列里放一个 `SUBTOTAL` 就闭环了。
   现状靠一个明确的手法躲开：扫描时喂**上一轮**的筛选集 ——
   `static-backend.ts:4890-4894` 的注释逐字写着
   "Deliberately the PREVIOUS filter set, exactly like the worker … which keeps
   the derivation non-circular on both hosts"。**派生原子没有这个躲法**，
   Store 会把它认成真环。
2. **它会让筛选变成实时的**，而 Excel 不是。`filter-sort.md`（docs）
   "Snapshot semantics" 一节把这条钉死："The pre-#27 implementation recomputed the
   permutation on every revision bump, which made our filter *more live than Excel's*
   — a divergence, not a feature."
3. **成本**：每次单元格写入触发一次全列扫描。

**裁决**：三个 `&mut self` 命令，与其它 mutator 同构（都带
`is_inside_custom_call()` 再入守卫，样板见 `workbook.rs:2475` / `:2561`）：

```rust
pub fn apply_filter(&mut self, sheet_index: usize, rules: &[ColumnFilterRule]) -> FilterApplyReport
pub fn reapply_filter(&mut self, sheet_index: usize) -> FilterApplyReport
pub fn clear_filter(&mut self, sheet_index: usize) -> FilterApplyReport
```

- **只有这三个入口重算。** 写单元格、结构操作、格式变更一律不重算 —— 结构操作只
  **平移**已有集合（与 #27 的 `remapIndexSetAfterStructuralShift` 同语义）。
  这就是快照语义，而且是"结构上不可能实时"，不是"约定不实时"。
- **"重算由谁触发"** = 宿主，且只有宿主。`Data → Reapply`（`Ctrl+Alt+L`）
  从"UI-core 重发 `setFilterSort`"变成"UI-core 调 `reapply_filter` 端口"。
  `reapplyFilterAtom` / `reapplyFilterDisabledReasonAtom`
  （`filter-sort/index.ts:1208-1219`）的门禁逻辑与菜单接线**零改动**，只换派发目标。
- **扫描必须走非追踪读。** 用 `hidden_rows_untracked`（`sheet.rs:1111`）那一类
  eager 路径，**不能**注册 epoch 边 —— 一旦注册，apply 本身就把筛选接进了反应图，
  从后门把实时性带回来。`apply_filter` 拿 `&mut self` 而 eager provider 要 `&self`，
  所以实现上必须"先算进局部变量、再提交"。列为实现约束，也列为 §9-V3
  （我没有核实 `WorkbookEvalProvider` 在整列驱动下的表现）。
- **预算下沉。** `MAX_FILTER_SORT_PREDICATE_CELLS = 50_000` 目前在 worker adapter
  （常量 `worker-workbook-backend.ts:211`，`:2225` 抛 `FILTER_SORT_SOURCE_TOO_LARGE`）。
  宿主扫描消失后这个闸门也就没了，必须搬进 Rust，按结构化拒绝返回 ——
  即 `Ok` 臂里返回 `{ ok: false, code, message }`，与 `sortRange` 的既有约定一致
  （`rust/wasm/src/lib.rs:1158-1167` 逐字描述了这个 convention）。
- **`isFilterSortSummaryRow` 必须一起搬。** `projection-helpers.ts:340-346`：
  第 0 列 trim + lowercase 后等于 `total` / `summary` 且 `row > 1` 的行，
  被钉在末位恒可见（`:396-398`、`:407`）。这是一条**产品启发式**，不是筛选语义，
  Rust 侧必须逐字复刻否则汇总行会被筛掉。**列为最容易漏的一条。**

---

## 3｜Q3：epoch 与失效

**结论：双 epoch 优化零改动地保留，因为它整体位于归属缝之下。**

已核实的机制：

- 两个独立 epoch 原子 + revision：`sheet.rs:964-965`（manual）、`:972-973`（filter）。
  `:966-971` 的注释给出了拆开的理由：两档 SUBTOTAL 都读 filter 集，
  共用一个 epoch 会让每次手动 hide/unhide 弄脏全簿的 1-11。
- 选择性 hook 调用是拆分生效的关键：`eval.rs:19730-19736` 明说
  "The provider hooks are called SELECTIVELY, because calling one is what
  registers its invalidation epoch edge"，实现在 `:19754-19761`。
- `SubtotalHiddenSets`（`eval.rs:19707-19723`）刻意**不建并集**，两个 `Option<Rc<..>>`
  各自哈希探测。

下沉只改写者，不改这条链上任何一环。

**但下沉引入一个新的失效义务，必须显式实现：幂等去重。**

现状：`WorkbookAtomContext::set_eval_hidden_rows`（`sheet.rs:1129-1139`）
**无条件** bump epoch，没有等值检查。去重发生在宿主 ——
`eval-hidden-rows-bridge.ts:60-64` 用 `lastPushed` ledger 比对序列化字符串，
相等就 `continue`。worker adapter 的筛选侧则明确选了不去重
（`worker-workbook-backend.ts:2169-2172` 的注释：
"Unconditional whole-set replace rather than a diff against a local ledger"，
理由是 apply 是用户节奏的动作）。

删掉 bridge 之后，去重责任无人承担，而新的写者 `republish_hidden` 会被
**结构位移**调用 —— 那是热路径。插入一行会让两个集合各自平移一次，
即使集合为空也 bump 两个 epoch，弄脏全簿每一个 SUBTOTAL。

**裁决**：`republish_hidden` 内做等值检查，只在集合真的变了时 bump，
且**分别**判断两个集合（手动没变就别碰 manual epoch）。
这 12 行 Rust 是 bridge 那 120 行删除的必要对价，别忘了写。
门禁：一个"空集合 sheet 上插入行，两个 epoch 的 revision 都不变"的 Rust 单测。

---

## 4｜Q4：谁还需要知道，读取路径

### 4.1 消费者清单（已核实，逐条 grep）

**并集 `effectiveHiddenAtom`** —— 生产代码只有 3 处：

| 位置                                 | 用途                                    |
| ------------------------------------ | --------------------------------------- |
| `go-to/index.ts:564`                 | `Go To Special → Visible cells only`    |
| `SpreadsheetGrid.tsx:688`            | 渲染行窗口过滤                          |
| `SpreadsheetGrid.tsx:771`            | 喂 `getVisibleWindowWithHidden` 窗口膨胀 |

**筛选子集 `viewportFilterHiddenAtom`** —— 生产代码 12 处：
`copy-as/visible-rows.ts:15`、`copy-as/types.ts:36`、
`copy-as/encodeSelectionAsImage.ts:72`、`operations/index.ts:983/1034/1271`、
`remove-duplicates/index.ts:419/1247/1285`、`text-to-columns/index.ts:1200`、
`filter-sort/index.ts:1642`（`buildSortExcludedRows`）、
`provider/copy-as-dispatch.ts:196/515`、`SpreadsheetContextMenu.tsx:352`、
`SpreadsheetGrid.tsx:1193/2387`、`renderRangeAsImage.ts:57`。

判据（`CANONICAL_OWNERSHIP.md:123`）不变：**动数据的读子集，渲染与导航读并集。**

### 4.2 裁决：保形状、换写者、加一个整表读

> **as-built（见 §0 收敛块修正 3）**：手动隐藏的引擎 feed 落在 `setEvalHiddenRows`（整集替换），
> **不是**本节假设的 `hideRows` / `unhideRows` 端口 —— worker 适配器从未把它们暴露到
> `SpreadsheetBackend`。feed 从被删的 bridge 搬进原子的乐观写 + 无条件对账路径
> （`viewport/hidden.ts` `feedAndReconcileHiddenRows`，对账回读 `readSheetHiddenState`）。

**两个 atom 的形状与 API 一个字不改**，12 + 3 个消费者零改动迁移。
变的是写者：从 UI-core 命令（`hidden.ts:336-349` 的 `hideRowsAtom` / `unhideRowsAtom`、
`effective-hidden.ts:75-95` 的 `setViewportFilterHiddenRowsAtom`）
改为**只在 backend ACK 上写**。

这正是 #27 已经为筛选侧建好的形状：`FilterSortMutationResult.hiddenRowIndices`
（`filter-sort/types.ts:43-58`）随 ACK 回传整集，UI-core 逐字存入。
本设计把它推广到手动侧：`hideRows` / `unhideRows`
（端口 `backend/types.ts:1031-1032`，请求型 `:652-663`）的
`BackendMutationResult` 同样回传该 sheet 的**完整** post-mutation 集合。

**新增一个整表读，不复用 `readViewportSizeProjection`。**
`ViewportSizeProjectionResult` 已经带 `hiddenRowIndices` / `hiddenColIndices`
（`backend/types.ts:648-649`），static 也填了（`static-backend.ts:1816-1831`），
但它有两个致命属性：

1. **window-bounded**（`:626` `window: CellRange`）。窗口膨胀
   （`SpreadsheetGrid.tsx:771` → `getVisibleWindowWithHidden`）需要知道窗口**之外**
   的隐藏行才能正确外推，用窗口内的答案去决定窗口有多大是循环的。
2. **worker adapter 根本没填。** `worker-workbook-backend.ts:2148-2168` 的
   `readViewportSizeProjection` 返回体里没有 `hiddenRowIndices` / `hiddenColIndices`
   两个键 —— 引擎没有隐藏模型，它无从填起。

所以新增：

```ts
readSheetHiddenState?(request: SheetRef): Promise<{
  manualRows: readonly number[]
  manualCols: readonly number[]     // 仍由 UI-core 拥有，见 §8；此处只做 hydration
  filterRows: readonly number[]
  filterRules: readonly ColumnFilterRule[]
}>
```

调用时机：sheet 激活一次、ACK 缺失回传时兜底一次、workbook restore 后一次。
**不逐帧、不逐滚动、不逐 revision。**

### 4.3 会不会每帧 RPC —— 不会，但有另一个代价

不会：atom 仍是渲染期真值来源，只是不再是 canonical 真值来源。
Grid 的 `store.sub(viewportFilterHiddenAtom, bumpRender)`
（`SpreadsheetGrid.tsx:1193`）逐字保留。

**真正的代价：手动隐藏从同步变异步。**

今天 `hideRowsAtom`（`hidden.ts:336`）是纯本地写，同一 tick 内 Grid 就重渲染；
backend 的 `hideRows` 端口只是 fire-and-forget 持久化镜像
（`hidden.ts:214-221`，`.catch()` 吞掉，`:23-28` 的文件抬头把这条口径钉死）。
下沉后，隐藏一行要 postMessage 往返。

> ## 主控裁定（2026-07-21）：乐观写 + 无条件对账，定为**默认**而非备选
>
> 初版计划是"先接受异步，实测延迟可感知再考虑乐观写"。**该裁决已推翻**，理由是我把乐观写的成本估高了：
>
> **它不新增状态。** `viewportHiddenAtom` 在本设计里本来就保留为 UI-core 缓存（§4.2"保形状、换写者"，副本数 5→2 里的 2 就是缓存 + 引擎）。乐观写没有第三份拷贝，只改变**既有缓存的更新时机**。
>
> **它不新增错误分支。** 照既有先例 `worker-workbook-backend.ts:3816` 的 `optimisticSheets`（乐观 + 重读对账）形状：急写缓存 → ACK 回来时**无条件**用权威值覆盖。引擎若不同意，ACK 自然纠正，走的是与非乐观**完全相同**的写入路径，只是前面多一次急写。**不需要回滚分支** —— 而罕见的回滚分支正是最容易藏 bug 的地方（几乎不执行、几乎测不到）。
>
> **先前反对它的理由不成立。** 原话是"重新引入临时双权威"。但 #27 smoke 实测出的那个真缺陷（`design-filter-hidden-rows.md` §9.3：视图与引擎对哪一行被隐藏各执一词）是**永久且静默**的分歧；乐观窗口是**有界且有意**的分歧。二者不是同一类风险，先前把它们混为一谈了。
>
> ### 让有界窗口保持有界的两条硬纪律（E7 验收条件）
>
> 1. **对账必须无条件** —— 总是用 ACK 的权威值覆盖缓存。一旦允许"值相同就跳过写入"，有界窗口就可能退化成永久分歧，即退化回 §9.3 那个缺陷的形状。
> 2. **用既有的 `requestId` / `revision` 丢弃过期 ACK** —— 否则连续快速隐藏两次，乱序 ACK 会让视图闪回。该机制已存在（`CLAUDE.md` 的 mutation 请求约定）。
>
> ### 适用范围
>
> 手动隐藏行、以及**大纲折叠**（折叠即写隐藏集，下沉后同样跨 worker；折叠一次可能隐藏几十行，延迟表现未必与隐藏单行相同）。E7 仍需**实测并报出两者的往返延迟**——不是用来决定要不要做乐观写（已定为做），而是用来验证乐观写之后**用户感知确实是即时的**。

**这是本设计最大的产品风险，且它落在一个高频交互上。**（筛选 apply 本来就是异步的，
所以只有手动隐藏这一半受影响。）三条出路：

| 出路                     | 代价                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| A. 接受异步              | 隐藏行有可感知延迟。行数越多、worker 越忙越明显                      |
| B. 乐观本地写 + ACK 对账 | 重新引入第二个写者 —— 正是本设计要消灭的东西，只是这次带回滚          |
| C. 手动侧不下沉          | 但 101-111 读手动集，判据说它该归引擎；且 static 的两条 lane（§7）留着 |

**倾向 B，但不强推。** 理由：`FilterSortEntrypointStatus` 已经有
`'local-acknowledged'` 这一档（`filter-sort/types.ts:76`），说明"本地先认、
ACK 再确认"在本仓已是既有词汇；B 是**一个写者带回滚**，不是两个权威。
但我**没有核实**是否有现成的乐观写 + 回滚样板可抄，列为 §9-V4。
这一条应当由主控拍板，不该由实施者在切片里临时决定。

---

## 5｜Q5：static 后端怎么办

### 5.1 现状（已核实）

任务书给的"谓词有两处 TS 实现、static 另走一条"**不成立**，实际是：

- **全仓只有一个 TS 谓词**：`filterRuleMatchesValue`
  （`projection-helpers.ts:91-112`，四型 `equals` / `contains` / `range` / `list`）
  + 两个辅助 `normalizeFilterText` / `numericValue`（`:82-89`）
  + 逐规则 AND 的 `rowMatchesFilterSortRules`（`:348-358`）
  + 排列构造 `buildFilterSortDisplayRows`（`:373-410`）。
- `filter-sort/index.ts:1177` 只是在**注释里提到** `filterRuleMatchesValue`，
  说的是"被否决的另一种 Reapply 实现"，那里没有第二份实现。
- **static 不另走一条**，它 `import { buildFilterSortDisplayRows as buildFilterSortDisplayRowsShared }`
  （`static-backend.ts:130`），本地包装（`:1433-1447`）只负责喂
  `readFilterSortValue`（`:1411-1423`）这个取值器。worker 同样调共享函数
  （`worker-workbook-backend.ts:2249-2256`）。
- 两条路真正的分歧在**取值器**：worker 读 `snapshot.display`，来自 Rust
  `value_to_display`（`rust/wasm/src/lib.rs:3578`）；static 读
  `formatEvalResult(evaluateFormula(...)).display`（`static-backend.ts:1421-1422`），
  TS 求值器。**谓词一份，被比较的字符串两份。**

这个订正对本设计是**好消息**：worker 路径的谓词输入本来就是 Rust 算的显示串，
所以把谓词搬进 Rust 不会改变 worker 路径上任何一个匹配结果。

### 5.2 裁决：static 是第二个引擎，不是 UI-core 的一部分

三个选项：

- **(a) static 在 TS 里重实现同语义** —— 这不是新增第二个求值器，因为 static
  本来就有自己的求值器；但如果把它写成"UI-core 的谓词"，就复活了
  `filter-sort/index.ts:1179-1181` 明确否决的"两个求值器可能对同一规则同一数据给出
  不同答案，且分歧是静默的、随规则形状变的"。
- **(b) fail-closed 声明不支持** —— static 是 Wave5 静态 demo 宿主，刚拿到 Table 支持
  （`a3325e7`）。砍掉筛选是真实产品倒退。
- **(c) 保留谓词，但重新定性。** ✅

**采 (c)**：承认一个从来没被写下来的事实 —— **static-backend 本身就是第二个引擎**
（它有自己的 `evaluateFormula`）。"引擎是唯一真相"这句话的正确读法是
**每个引擎一份谓词**，不是全局一份。落地动作：

1. 谓词从 `vanilla/spreadsheet-ui-core/src/backend/projection-helpers.ts`
   **迁出**到 `solid/excel/src-vnext/adapter/`（比如 `static-filter-predicate.ts`）。
   位置本身是语义：留在 ui-core 里它看起来像 canonical，搬到 adapter 里它是
   static 引擎的内部实现。**UI-core 从此对谓词零知识**，只保留
   `ColumnFilterRule` 这个**线型**（`filter-sort/types.ts:12-16`）。
2. `ColumnFilterRule` 成为跨语言线型：TS 侧不变，Rust 侧新增等价 enum + serde。
3. **黄金对照钉死两者。** 照抄 `solid/excel/test/vnext-sort-static-wasm-parity.test.ts`
   （242 行，抬头逐字写明方法：同一数据集喂 WASM worker 与 static，比对读回的标记列，
   "locks the shared comparator to the normative Rust `sort_cmp` … and rules out any
   locale-collation drift"）。筛选版的语料必须覆盖：
   - 四型规则各自 + 组合（AND）
   - `caseSensitive` 有/无（`equals` / `contains` 两型带此位）
   - `range` 遇非数值（`numericValue` 返回 `null` → `false`，`projection-helpers.ts:103-104`）
   - `list` 的**精确串比对**（`:110` `rule.values.includes(value)` —— 不做大小写归一，
     与 `equals` **不一致**，这是既有语义，Rust 必须照抄这个不一致）
   - 空串 / 错误值 / 布尔 / 公式格
   - 汇总行钉位（`isFilterSortSummaryRow`）
   - `MAX_FILTER_LIST_VALUES = 10000` 截断（`filter-sort/index.ts:54`、`:198`）

> **注意 `list` 与 `equals` 的大小写不一致是既有真实行为**（`:96-97` vs `:110`），
> 不是笔误也不要顺手"修"。Rust 逐字复刻，任何"顺带修正"都会变成一次静默行为变更。

---

## 6｜Q6：undo 与持久化

### 6.1 现状（已核实）

- **筛选侧不产生自己的 history 条目**（`CANONICAL_OWNERSHIP.md:96`：
  "筛选隐藏集不产生自己的 history 条目 —— 它是规则的派生结果，它的 undo 就是筛选规则本身的 undo"）。
  唯一用到 local-replay 的地方是结构操作的快照式 side payload
  （`effective-hidden.ts:107` `VIEWPORT_FILTER_HIDDEN_REPLAY_KEY`、
  `:174-188` applier、调用点 `operations/index.ts:983/1034/1271`、
  `remove-duplicates/index.ts:1247/1285`）。
- **手动侧逐次进 history**：`hidden.ts:311` `applyKey: VIEWPORT_HIDDEN_REPLAY_KEY`、
  `:556-575` applier。
- **隐藏状态完全不进引擎快照。** `WorkbookPersistenceV1JSON`
  （`rust/wasm/src/lib.rs:1128-1146`）只有 `version` / `sheets` / `cells` /
  `formats` / `sizes` / `tables`。存盘丢隐藏与筛选 —— 任务书这条**已核实为真**。

### 6.2 裁决：改走引擎快照，新增两个原语

照抄 Table 那对：

```rust
pub fn snapshot_hidden(&self) -> HiddenStateSnapshot     // 对标 workbook.rs:2170
pub fn restore_hidden(&mut self, snapshot) -> Result<u32, ..>  // 对标 :2212
```

REPLACE 语义、越界 sheet 静默丢弃、形状非法整体拒绝且不改工作簿
（`workbook.rs:2181` 说明 `restore_tables` 就是 mirror 了
`restore_persistence_v1` 的 reject-without-mutating 行为）。
宿主事务日志在既有 before-image 旁多记一份，与 `snapshot_tables` 同一位置。

persistence v1 加两个字段，**逐字照抄 `tables` 字段的加法**
（`rust/wasm/src/lib.rs:1136-1145` 的注释把双向后向兼容的理由写全了：
`#[serde(default, skip_serializing_if = "Vec::is_empty")]` 让旧 payload 恢复为
"无 Table"、让无 Table 的工作簿序列化字节不变）：

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
hidden: Vec<SheetHiddenStateJSON>,
#[serde(default, skip_serializing_if = "Vec::is_empty")]
filters: Vec<SheetAutoFilterJSON>,
```

`WorkbookPersistenceRestoreStatsJSON`（`:1148-1156`）加对应计数键，加法式。
**这条顺带闭合任务书点名的 parity 缺口**：真实 xlsx 保存隐藏行与 autoFilter 状态。

### 6.3 能删多少 local-replay —— 筛选侧全删，手动侧**不能删**

> **as-built（见 §0 收敛块修正 5–7）**：筛选侧删 local-replay 的**同时**新增一条 provider
> re-hydration —— 引擎快照（`restoreFilters`）恢复不了 UI-core 渲染缓存
> `viewportFilterHiddenAtom`，故撤销/重做后从 `readSheetHiddenState.filterRows` 回读写回
> （`provider/history-dispatch.ts` `reconcileFilterHiddenFromEngine`）。筛选侧**前向结构位移
> 保留**（`applyViewportFilterHiddenStructuralShiftAtom`，乐观同 tick 投影，删它会闪帧）；只删
> local-replay 恢复路径。手动侧 adapter **不加 `snapshot_hidden`**（会与 E7 保留的 local-replay
> 形成双恢复），故 E8 不动手动侧。

- **筛选侧**：`VIEWPORT_FILTER_HIDDEN_REPLAY_KEY` + applier
  （`effective-hidden.ts:107` / `:174-188`）+ 两个调用点的 `localSidePayloads`
  可全删，引擎快照覆盖。
- **手动侧不能删。** 已核实：`vanilla/spreadsheet-ui-core/src/outline/index.ts:13-14`
  import 了 `VIEWPORT_HIDDEN_REPLAY_KEY` 与 `viewportHiddenAtom`，
  `:216` 读隐藏态，`:272-278` 与 `:643-648` 两处通过
  `getHistoryLocalReplayApplier(VIEWPORT_HIDDEN_REPLAY_KEY)` **复用手动隐藏的 applier**
  实现大纲折叠 undo；`outline/README.md:40` 确认了这个复用。
  **删掉 applier 会静默破坏大纲折叠的撤销**，而大纲（#07）是 UI-core 视图事实、
  按判据不下沉。

**硬序约束（见 §7 切片 E5）**：手动侧 local-replay 的拆除必须**先**给 outline
一个自己的 applier key，否则 E5 落地即回归，且回归表现是"折叠后 Ctrl+Z 无反应"，
在筛选/隐藏的测试面上**照不出来**。这是本设计里最容易被漏掉的一条耦合。

---

## 7｜Q7：能删掉什么，以及净增减的诚实核算

### 7.1 DELETE 清单（带行号区间，供实施者核对）

| 文件                                                       | 区间                        | 内容                                                        | 约行数 |
| ---------------------------------------------------------- | --------------------------- | ----------------------------------------------------------- | -----: |
| `solid/excel/src-vnext/provider/eval-hidden-rows-bridge.ts` | 全文                        | 手动隐藏推送桥（含 `WeakMap` 单实例 owner、`lastPushed` ledger） |    120 |
| `vanilla/…/src/viewport/effective-hidden.ts`               | 31-203                      | 筛选集 backing atom、整集替换命令、结构位移、replay applier |    173 |
| `vanilla/…/src/backend/projection-helpers.ts`              | 82-112, 336-410             | 谓词 + 汇总行启发式 + 排列构造（**迁出**到 adapter，非净删） |    106 |
| `solid/excel/src-vnext/adapter/filter-hidden-rows.ts`      | 1-56                        | `filterHiddenRowsFromDisplayRows`（排列→隐藏集折叠）        |     56 |
| `solid/excel/src-vnext/adapter/worker-workbook-backend.ts` | 2192-2198, 2209-2262        | `filterSortPredicateColumns` + `computeFilterSortDisplayRows`（含 50k 预算） |     71 |
|                                                            | 2264-2310                   | `pushEvalFilterHiddenRows` + 降级 latch                     |     47 |
|                                                            | 2048-2068                   | `shiftFilterHiddenOverlay`                                  |     21 |
|                                                            | 1584-1617, 1926-1934, 1990-1998, 2024, 2356-2360, 2654, 2806, 2825 | `filterHiddenRowsBySheetId` 全部读写 + undo overlay 前后像 |  约 60 |
|                                                            | 4140-4180                   | `setFilterSort` 主体（降为一次 RPC 转发）                   |     41 |
| `solid/excel/src-vnext/adapter/static-backend.ts`          | 1276-1320                   | `filterHiddenRowsForSheet` + `shiftFilterHiddenRows`        |     45 |
|                                                            | 1411-1447                   | `readFilterSortValue` + 包装（**迁**，不删）                |     37 |
|                                                            | 4878-4917                   | `setFilterSort` 主体                                        |     40 |
|                                                            | 1238-1274                   | `evalHiddenRowsForSheet` **两条 lane 取并集** —— 宿主推送 lane 消失后整段消失 |     37 |
| `vanilla/…/src/viewport/hidden.ts`                          | 189-221, 285-316, 509-575（部分） | backing 写、backend 镜像 fire-and-forget、结构位移、replay（手动侧下沉时） |  约 150 |

**合计可删/可迁 TS ≈ 1000 行**，其中真正净删（非迁移）≈ **850 行**。

> **as-built（见 §0 收敛块修正 9）**：本表为设计期估算，实际删除集与之有出入。最显著的一处：
> `filter-hidden-rows.ts` **未整文件删除** —— 保留 `filterHiddenRowsFromDisplayRows`
> （static 折排列→隐藏集）与 `filterTsvBandRows`（两后端 TSV 导出）。谓词模块实名
> `filter-predicate.ts`（非 `static-filter-predicate.ts`，未改名）。以各切片提交为准。

顺带消失的**机制**（比行数更重要）：

- **#27 勘误 E7 的三层平移**（`design-filter-hidden-rows.md:51`）塌成一层。
  E7 的原话是"落点三层，缺任一层复现都不算修好"——三层里有两层在本设计中不复存在。
- **#27 勘误 E6 的"第二个写者"张力**（`:50`）消失：不再有 bridge 与 adapter
  争夺同一事实的写权。
- **static 的双 lane 并集**（`static-backend.ts:1264-1273`：自有 `hiddenRowsBySheetId`
  与宿主推送 `evalHiddenRowsBySheetId` 取并）消失。
- **§2.1-D1 的 sheet 重排不重键缺陷**结构上不可表达。

### 7.2 ADD 清单（估算）

| 侧      | 内容                                                                 | 约行数 |
| ------- | -------------------------------------------------------------------- | -----: |
| Rust    | `ColumnFilterRule` enum + serde 线型                                 |     80 |
| Rust    | 谓词求值（四型 + AND + 汇总行钉位 + 显示串取值）                     |    120 |
| Rust    | `SheetAutoFilter` 存储 + `apply/reapply/clear_filter` + 50k 预算拒绝 |    140 |
| Rust    | `Sheet.hidden_rows` + `hide/unhide/list` + `republish_hidden`（含幂等去重） |    120 |
| Rust    | 结构位移跟随 + sheet 生命周期跟随                                    |     60 |
| Rust    | `snapshot_hidden` / `restore_hidden`                                 |     90 |
| Rust    | persistence v1 两字段 + stats                                        |     60 |
| wasm    | 绑定（apply/reapply/clear/hide/unhide/list/snapshot/restore）        |    150 |
| TS      | 协议线型 + capability 键 + 两个 runtime dispatch                     |    140 |
| TS      | adapter 转发 + UI-core cache 写者改造 + `readSheetHiddenState`       |    130 |
| **合计** |                                                                     | **≈1090** |

（不含 Rust 单测与黄金对照语料，那部分是净增且应当净增。）

### 7.3 诚实结论

**本设计不净减代码。** TS 净减约 850 行，Rust + wire 净增约 1090 行，
总量大致持平甚至略增。任务书说"如果不能净减代码，说明方案错了 —— 请如实指出"，
所以这里如实指出，并给出取舍表让主控拍板：

| 判据                    | 结果                                                       |
| ----------------------- | ---------------------------------------------------------- |
| 总行数                  | ❌ 持平/略增                                               |
| TS 行数                 | ✅ −850                                                    |
| 同一事实的副本数        | ✅ **5 → 2**（UI-core cache + 引擎；引擎内部 Sheet↔context 各一份是实现细节，同 crate 同提交） |
| 跨 postMessage 的权威数 | ✅ **2 → 1**                                               |
| 已知缺陷根除            | ✅ E7 三层平移、D1 sheet 重排不重键、static 双 lane        |
| parity 缺口闭合         | ✅ 隐藏 + autoFilter 进持久化（xlsx 语义）                 |
| 新增风险                | ❌ 手动隐藏同步→异步（§4.3）；跨语言谓词漂移（靠黄金对照兜） |

**我的判断**：如果主控的判据严格是"净减行数"，本方案**不达标**，应当停在
"只下沉隐藏集合、不下沉谓词"的较小范围 —— 但那个版本同样不净减（它删掉 bridge
与三层平移，却仍要付 Rust 状态所有权 + 持久化 + 快照原语的代价），
**所以'净减行数'这个判据在本题上选不出任何方案**。
如果判据是"消灭跨进程双权威与两类实锤缺陷、并闭合持久化 parity"，本方案达标。
建议主控把判据改成后者再决定是否开工。

---

## 8｜Q8：隐藏列 —— 确认不动

**核实**：`rust/excel-core/src/` 与 `rust/wasm/src/` 全仓对 "hidden" 的命中，
逐条看过，**全部**是 `eval_hidden_rows` / `eval_filter_hidden_rows` /
`manual_hidden_epoch` / `filter_hidden_epoch` / `hidden_rows_*` 这一族行集合
（`sheet.rs:933-1156`、`eval.rs:959-990` 与 `:19682-19812`、
`wasm/lib.rs:2488` 与 `:2502`）。**没有任何列形状的隐藏建模**，
`for_each_subtotal_value` 只按 `addr.row` 过滤（`eval.rs:19779`）。

与 Excel 一致：`SUBTOTAL` / `AGGREGATE` 的 ignore-hidden 概念只针对行。
按判据"不影响计算的归视图"，隐藏列留在
`viewportHiddenAtom.colsBySheet`，`effective-hidden.ts:246` 那句
`colsBySheet: manual.colsBySheet` 原样直通。

**但有一个必须处理的后果。** 下沉之后 `viewportHiddenAtom` 会**行列两轴归属不同**：
行是引擎状态的缓存、列是 UI-core canonical。同一个原子里两套所有权规则，
必然有人读错。

**裁决**：拆原子。

```
viewportHiddenColsAtom   // UI-core canonical，含 hideColumns/unhideColumns/结构位移/local-replay
sheetHiddenRowsAtom      // 引擎状态投影，只在 ACK 上写
```

保留一个 `viewportHiddenAtom` 兼容派生（合成旧形状）供未迁移的消费者过渡，
但新代码不得写它。**这条不做，隐藏列就会在某次重构里被顺手推给引擎**，
而引擎没有地方放它。

---

## 9｜发现的缺陷、待验证项、与任务书的出入

### 9.1 新发现的现状缺陷

**D1｜`remove_sheet` / `move_sheet` 不重键隐藏集（真实缺陷，现网存在）**
`WorkbookAtomContext.eval_hidden_rows` / `eval_filter_hidden_rows` 按 **sheet 索引**键
（`sheet.rs:947` / `:954`）。`Workbook::remove_sheet`（`workbook.rs:1754-1778`）与
`move_sheet`（`:1081-1099`）都不重键 —— `workbook.rs` 全文只有 `:2474` / `:2497`
两处触及这两张表，即 setter 自身。Table 注册表按名维护（`:1770`），隐藏集没有对应逻辑。
**后果**：删除 sheet 0 之后，原 sheet 1 的隐藏集仍挂在键 1，而它现在是索引 0，
该 sheet 的 SUBTOTAL 会用错集合，直到宿主的下一次推送把它冲掉。
**当前可达性**：bridge 订阅 `viewportHiddenAtom`（`eval-hidden-rows-bridge.ts:98`），
sheet 删除本身不改该原子，所以**不会**自动重推 —— 窗口不是一瞬，是直到下一次
hide/unhide 或 filter apply。**建议独立修复，不要等本设计**（`sync_atom_topology`
`workbook.rs:685-696` 是现成的挂点，三处 sheet 生命周期操作都调它）。

**D2｜`workbook.rs:2519-2522` 的注释已过期**
原文："The wasm binding still calls `Sheet::insert_row` directly today; rewiring it to
route through these wrappers is T6 (§10) — deliberately NOT done here"。
**T6 已经落地**：`rust/wasm/src/lib.rs:2550-2551` 的 `WasmWorkbook::insert_row`
调的是 `self.workbook.insert_rows(...)`，`:2554` / `:2559` / `:2563` 同理。
（`:1523-1527` 那组 `self.sheet.insert_row` 属于另一个 `WasmSheet` 单表包装，不是同一条路。）
这对本设计是**有利**事实 —— 结构位移已经统一走 Workbook，不需要额外重接线。

**D3｜`buildFilterSortDisplayRows` 的命名误导，#27 已记在案但未改**
`design-filter-hidden-rows.md:73-78` 的 S8 订正说明它"仍返回 display→source 排列数组，
只是那个排列不再用于投影"。本设计**顺带解决**：整个函数被 Rust 谓词取代，
static 侧迁走后可以顺手改成 `computeFilterHiddenRows(...): Set<number>`。

### 9.2 对任务书"已核实事实"的订正

| 任务书原文                                                     | 核实结果                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 筛选谓词只有 4 种（`filter-sort/types.ts:12-16`）              | ✅ **成立**，逐字核对                                                                             |
| 谓词今天有**两处** TS 实现，static 后端**另走一条**            | ❌ **不成立。** 全仓只有**一处**谓词（`projection-helpers.ts:91-112`）；`filter-sort/index.ts:1177` 只是注释提及；static 与 worker **都** import 同一个共享 `buildFilterSortDisplayRows`（`static-backend.ts:130`、`worker-workbook-backend.ts:89/2249`）。真正分歧在**取值器**（Rust `value_to_display` vs TS `formatEvalResult`），不在谓词。详见 §5.1 |
| 引擎已有 `insert_rows` / `delete_rows` / `insert_columns`      | ✅ **成立**（`workbook.rs:2525/2533/2541`，另有 `delete_columns`:2549）。**补充**：wasm 已路由过来（D2），任务书说"隐藏集搬进去后位移由引擎自理"因此成立 |
| 样板 `snapshot_tables`/`restore_tables` + 进 persistence v1    | ✅ **成立**（`workbook.rs:2170/2212`；`wasm/lib.rs:1144-1145` 的 `tables` 字段）                   |
| 引擎当前不建模隐藏，只有两个求值输入端口                        | ✅ **成立**（`workbook.rs:2474/2497`）                                                             |
| 引擎没有任何隐藏列入口，`hidden_col` 全仓零命中                 | ✅ **成立**（§8）                                                                                  |
| 隐藏状态不进引擎快照/持久化                                     | ✅ **成立**（`wasm/lib.rs:1128-1146` envelope 逐字核对）                                           |

### 9.3 待验证项（**写成待验证，不是结论**）

- **V1**｜是否存在稳定的 sheet id（非索引）可供 context 键用。未核实。
  若有，§2.1 的"两份副本"可以进一步收成一份。
- **V2**｜Excel 里 Table 各有自己的筛选，sheet 的 AutoFilter 是另一个。
  #32 已有 Table 注册表，"一个 sheet 一个 filter" 的 cap 是否够用未裁决。
- **V3**｜`WorkbookEvalProvider` 的 eager 路径在整列（最坏 50k 格）驱动下的行为
  与性能未测；`apply_filter` 需 `&mut self` 而 provider 要 `&self`，
  "先算局部再提交"的可行性未验证。
- **V4**｜本仓是否已有"乐观本地写 + ACK 回滚"的样板可抄（§4.3 出路 B）。
  仅从 `FilterSortEntrypointStatus` 有 `'local-acknowledged'` 一档
  （`filter-sort/types.ts:76`）**推断**存在，未读实现。
- **V5**｜`AGGREGATE` 的 ignore-hidden 位（1/3/5/7）现被解析但忽略
  （`eval.rs:19687-19689` 的 `IncludeAll` 说明 + 在案 TODO）。
  下沉后它是否应当一并实现、以及 Excel 的真实语义（"是否总是忽略筛选行"资料互相矛盾，
  见 `design-filter-hidden-rows.md:186`），均未裁决。**本设计不含它。**
- **V6**｜INV-4（`architecture_invariants.rs:407-441`）对**删除**签名是硬失败。
  本设计**不删** `setEvalHiddenRows` / `setEvalFilterHiddenRows`
  （`wasm_api_signatures.txt:57-58`），而是把它们改成写 `Sheet` 拥有态的入口。
  **但 INV-4 的提取器（`:445-490`）连参数与 `js_name` 一起指纹化**，
  所以哪怕只改参数也会硬失败。**改签名 = 删签名**，必须保持逐字不变。
  两个端口因此成为**永久的加法式历史包袱**（引擎不再需要它们，但不能删）。
  是否值得为此单开一次"批准的破坏性 INV-4 重生成"，未裁决。

---

## 10｜切片计划

### 10.1 切片表

**状态（2026-07-22）：E0–E9 全部已落地。** 下表为设计期定义的范围/门禁；E7 / E8 的 as-built
偏离（手动 feed 走 `setEvalHiddenRows` 而非 `hideRows` 端口、筛选侧 local-replay 删除移至 E8
并新增 provider re-hydration、筛选侧前向位移保留、手动侧不加 `snapshot_hidden`）见 §0 收敛块修正 3–9。

| 片      | 范围                                                                                                            | 文件边界                                                                                     | 验收门禁                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **E0**  | **前置修复 D1**：`sync_atom_topology` 挂 `republish`，让隐藏集随 sheet 增删移重键                                | `rust/excel-core/src/workbook.rs` 单文件                                                     | 新增 Rust 单测：sheet 0 删除后 sheet 1 的 101-111 仍读自己的集合。**零 TS 改动、零 wasm 签名变化**             |
| **E1**  | **outline 解耦**：给大纲折叠自己的 replay key，停止复用 `VIEWPORT_HIDDEN_REPLAY_KEY`                            | `vanilla/…/src/outline/index.ts` + `README.md`                                               | `npx jest vanilla/spreadsheet-ui-core --no-coverage` 全绿；折叠 undo 单测显式断言用的是新 key                  |
| **E2**  | **Rust 拥有隐藏行（手动侧）**：`Sheet.hidden_rows` + hide/unhide/list + 结构跟随 + `republish_hidden`（含幂等去重）+ `snapshot_hidden`/`restore_hidden` + persistence 字段。`set_eval_hidden_rows` 保签名，改为写拥有态 | `rust/excel-core/src/{sheet,workbook}.rs`、`rust/wasm/src/lib.rs`、`wasm_api_signatures.txt` | `cargo test -p einfach-excel-core -p einfach-wasm`；INV-4 同提交重生成且 diff 只见新增；**空集合 sheet 插入行两个 epoch 均不 bump** 的单测 |
| **E3**  | **Rust 拥有筛选**：`ColumnFilterRule` + 谓词 + 汇总行钉位 + `SheetAutoFilter` + apply/reapply/clear + 50k 结构化拒绝 + 持久化 | 同 E2 文件集                                                                                 | Rust 单测覆盖 §5.2 语料全表（**含 `list`/`equals` 大小写不一致**）；`apply_filter` 不注册任何 epoch 边的断言   |
| **E4**  | **谓词迁出 UI-core**：`projection-helpers.ts` 的谓词族搬到 `src-vnext/adapter/static-filter-predicate.ts`，static 独用 | `vanilla/…/src/backend/projection-helpers.ts`、`solid/excel/src-vnext/adapter/`              | 两包单测全绿；`grep -r filterRuleMatchesValue vanilla/spreadsheet-ui-core/src` **零命中**                       |
| **E5**  | **协议与 adapter 转发**：新增 capability 键 + 两 runtime dispatch + `readSheetHiddenState` 端口；worker adapter 的 `computeFilterSortDisplayRows` / `pushEvalFilterHiddenRows` / `filterHiddenRowsBySheetId` 三层全删 | `worker-protocol.ts`、`worker-runtime.ts`、`worker-runtime-ts.ts`、`worker-workbook-backend.ts` | `npx jest solid/excel --no-coverage`；TS runtime 显式 `false` 且入口隐藏（fail-closed，不得假 ACK）             |
| **E6**  | **static 转发**：static 的 `setFilterSort` 改用 E4 的谓词模块 + 自有隐藏集合；`evalHiddenRowsForSheet` 双 lane 拆掉 | `static-backend.ts` 单文件                                                                   | **新增 `vnext-filter-static-wasm-parity.test.ts`**（照抄 `vnext-sort-static-wasm-parity.test.ts` 的形状）全绿 |
| **E7**  | **UI-core 原子翻转**：两 atom 换写者；`viewportHiddenAtom` 拆行/列两个原子；筛选侧 local-replay + 结构位移全删；bridge 删除 | `viewport/{hidden,effective-hidden}.ts`、`operations/`、`remove-duplicates/`、`provider/eval-hidden-rows-bridge.ts` | 两包单测；15 个消费者（§4.1）逐个确认读的是哪个集合；**e2e 必跑**：筛选激活时插入行不吞表头（E7 回归语料） |
| **E8**  | **undo 改道**：宿主事务日志改记 `snapshot_hidden` before-image                                                  | `worker-workbook-backend.ts`、`static-backend.ts`、`history` 调用点                          | Ctrl+Z 往返 e2e：手动隐藏、筛选、结构操作三类各一条                                                            |
| **E9**  | **文档收口**：`CANONICAL_OWNERSHIP.md` §2 表 + #03/#29 两行 + §7-1 勘误；`filter-sort.md` 改写；本文标"已落地"   | 纯文档                                                                                       | 无代码门禁；但必须给出 §1.4 那段"为何不是横跳"的论证                                                           |

### 10.2 硬序约束（违反会出什么事）

1. **E1 必须早于 E7。** outline 折叠复用手动隐藏的 replay applier
   （`outline/index.ts:272-278` / `:643-648`）。E7 拆 applier 时若 outline 还挂着，
   回归表现是"折叠后 Ctrl+Z 无反应"—— **这在隐藏与筛选的整个测试面上照不出来**，
   要等 outline 的 e2e 才暴露，而 outline 的持久化钩子本来就是 TODO
   （`CANONICAL_OWNERSHIP.md:43`），关注度低。这是本计划里最容易吃亏的一条。
2. **E0 必须早于 E2。** D1 是现网缺陷；先在旧形状下修好并留下单测，E2 的重构才有
   回归网可依。反过来做，D1 会被"重构顺带修了"的叙事吞掉，无人知道它曾经存在。
3. **E2 必须早于 E3。** 筛选的派生集合与手动集合共用 `republish_hidden` 与幂等去重；
   先建筛选会让去重逻辑写两遍，且第二遍大概率与第一遍不一致。
4. **E4 必须早于 E6，且晚于 E3。** 早于 E6：static 要 import 迁移后的模块。
   晚于 E3：Rust 谓词先落地，E4 的迁移才有"对照物"可比 —— 否则 E4 只是搬文件，
   没有任何东西能证明搬完还等价。
5. **E5 与 E6 必须早于 E7。** E7 删掉 UI-core 的写者。若此时两个 adapter 还没有
   在 ACK 上回传完整集合，UI-core 的 atom 会**恒为空**，隐藏与筛选整体静默失效。
   这与 #27 勘误 E5（`design-filter-hidden-rows.md:49`）是同一类错误：
   "换源必须与原子真正被填值同切片，否则它读一个恒空集合"。**同一个坑不要踩第二次。**
6. **E6 的黄金对照必须与 E6 同提交。** 不是"后补测试"。static 与 Rust 的谓词分歧
   是静默的、随规则形状变的（`filter-sort/index.ts:1179-1181`），
   没有对照就没有任何东西能发现它。
7. **E8 不得早于 E7。** undo 改道前 UI-core 还持有 local-replay；两条 undo 路径
   同时在线会产生双重恢复（一次 local-replay + 一次引擎快照），表现为
   "撤销一次退两步"。

### 10.3 每片的"不做"边界

- **E2/E3 不动 `set_eval_hidden_rows` / `set_eval_filter_hidden_rows` 的签名**（§9.3-V6）。
- **E5 不做 TS worker 的能力补齐**：按 `CANONICAL_OWNERSHIP.md:28` 的口径，
  TS worker 是 fail-closed 开发后备，声明 `false` 并隐藏入口即可，**禁止假 ACK**。
- **E7 不改 15 个消费者的读取方向**（并集 vs 子集），只换真值来源。
  方向的判据在 `CANONICAL_OWNERSHIP.md:123`，本设计不重新裁决。
- **全程不碰 `AGGREGATE`**（§9.3-V5）。
- **全程不碰隐藏列的语义**，只在 E7 拆原子（§8）。

---

## 11｜预期失败面

### 11.1 DELETE（测试随被测机制一起消失）

| 测试                                                            | 原因                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| `vanilla/…/test/effective-hidden.test.ts` 的筛选集写入/整集替换/结构位移用例 | `setViewportFilterHiddenRowsAtom` 等命令不再存在          |
| `solid/excel/test/vnext-structural-remap-static.test.ts` 的 filter-hidden 部分 | adapter 本地快照与其平移一起消失                          |
| worker/static 各自的 `setFilterSort` 内部扫描用例               | 扫描搬进 Rust                                            |

### 11.2 MIGRATE（断言对象换层，用例保留）

| 测试                                                             | 迁到                                             |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| `test/filter-sort.test.ts`（规则、dropdown 生命周期、capability 降级、ACK 匹配） | 保留；ACK 匹配改断言新端口                        |
| `test/reapply-filter.test.ts`                                    | 保留；派发目标改 `reapply_filter`                 |
| `solid/excel/test/vnext-worker-filter-subtotal-wasm.test.ts`     | **最重要的保留项**：两档 SUBTOTAL 的真实 Rust 验证，本设计不得让它变弱 |
| `test/remove-duplicates.test.ts` / `text-to-columns.test.ts` 的 hidden 用例 | 保留；`hiddenRows` 来源改引擎投影                 |
| `test/physical-sort.test.ts` 的 `buildSortExcludedRows` 并集用例  | 保留                                             |
| `test/copy-as*.test.ts` / `operations.test.ts` 的可见性用例       | 保留（导出端口按 `filter-sort.md` 明说不走引擎推送，本设计不改这条） |
| `test/mutation-gateway.test.ts`                                  | 应当**零改动** —— 若它红了，说明动到了不该动的东西 |
| `vnext-filter-hidden-rows.test.ts` / `vnext-filter-hidden-export.test.ts` | 保留                                             |
| e2e `vnext-filter-*-real-backend.spec.ts` 三支                    | **全部保留且必须绿** —— 它们是产品行为的唯一守卫  |

### 11.3 NEW（必须新增，否则切片不算完）

- Rust：谓词四型 + 组合 + 边界语料；`apply_filter` 零 epoch 边断言；
  空集合插入行不 bump epoch；sheet 删除后集合归属正确（E0）。
- `solid/excel/test/vnext-filter-static-wasm-parity.test.ts`（E6，同提交）。
- undo 往返三类（E8）。
- outline 折叠 undo 用新 key（E1）。

### 11.4 会红但属预期的既有断言

- `wasm_api_signatures.txt` 会因新增导出而失败一次，**必须同提交重生成**
  （`architecture_invariants.rs:492-504`，`cargo test --test architecture_invariants
  wasm_snapshot_generate -- --ignored`）。
- 任何断言 `readViewportSizeProjection` 返回 `hiddenRowIndices` 的 static 用例
  （`static-backend.ts:1816-1831`）会在 E7 拆原子后需要重新裁决语义。

---

## 12｜风险与未决项

### 12.1 三条主要风险，按严重度

1. **手动隐藏从同步变异步（§4.3）。** 落在高频交互上，用户可感知。
   出路 A/B/C 三选一必须由主控拍板，不能留给实施者。
   **这是我认为最可能让本设计被否决的一条。**
2. **跨语言谓词漂移。** static 的 TS 求值器与 Rust 引擎对同一格给出的显示串
   本来就可能不同（`formatEvalResult` vs `value_to_display`）；
   谓词一致不代表结果一致。黄金对照能发现它，但**发现之后怎么办没有裁决** ——
   是改 static 去追 Rust，还是承认 static 是"近似 demo 后端"。
   建议 E6 之前先跑一次探索性对照，把分歧规模摸清楚再定切片验收线。
3. **outline 的静默耦合（§6.3 / 硬序 1）。** 已识别，且**已排查完毕**：
   `getHistoryLocalReplayApplier` 的全仓调用点只有 4 处 ——
   `outline/index.ts:272` 与 `:643`（外部消费者，就是这一处耦合）、
   `history/index.ts:378` 与 `:577`（history 模块自用）。
   **没有第二处间接复用**，所以 E1 的解耦范围是封闭的。
   风险降级为"实施时必须记得做"，而不是"可能还有未知耦合"。

### 12.2 未决项（需主控裁决，不由实施者决定）

| #   | 事项                                    | 参见       |
| --- | --------------------------------------- | ---------- |
| U1  | 手动隐藏异步化的出路 A/B/C              | §4.3       |
| U2  | 判据是"净减行数"还是"消灭双权威"        | §7.3       |
| U3  | static 谓词漂移的处置口径               | §12.1-2    |
| U4  | Table 级筛选是否在范围内                | §9.3-V2    |
| U5  | 两个 `setEval*HiddenRows` 端口的永久保留 vs 一次批准的 INV-4 破坏性重生成 | §9.3-V6 |
| U6  | `AGGREGATE` ignore-hidden 是否顺带做    | §9.3-V5    |

### 12.3 给实施者的一句话

本文所有"现状"论断都带 `文件:行号`，且都是我亲自读过的那一段。
**推断项已在文中显式标注（"推断"/"未核实"/"待验证"）。**
凡与代码冲突处，**以代码为准，并把冲突记回本文的勘误索引** ——
上一轮八处不符各挡下一个实施者，这一轮的目标是零处。
如果你查出第一处，请像 #27 那样把它写进一张表，而不是私下绕过。
