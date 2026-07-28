# 设计｜筛选重做：从"显示压缩"到"隐藏行"

- **状态**：**已全量落地（S1–S8，2026-07-21）**。本文自此为**历史设计记录**，不是现行契约。
- **日期**：2026-07-21（设计）／2026-07-21（S8 收口）
- **基线**：分支 `claude/rust-core-state-plan-Auzcj`；[CANONICAL_OWNERSHIP.md](./CANONICAL_OWNERSHIP.md) #29（筛选可见性 = UI-core 视图事实，翻转顺序第 3 步）
- **前置**：[design-engine-sort.md](./design-engine-sort.md) 已全量落地（物理排序 + `excludedRows`），本设计接手 #29 的另一半
- **范围**：把筛选从"匹配行压缩进连续 display 槽位 + `originalRow` 回映射"改为 Excel 语义的**隐藏行**（行号保留原值、跳号显示）。产品决定已拍板，本文只裁决实现形状。

> ## ⚠️ 读本文前必读（S8 收口，2026-07-21）
>
> **本文是设计稿，不是现状文档，且已被证明有多处与代码不符。**
> 找现行契约请读 **`excel/spreadsheet-ui-core/docs/filter-sort.md`**（面向使用者的完整口径）
> 与各模块 README（`viewport/` 两个集合、`filter-sort/`、`editing/`、`copy-as/`、
> `operations/`、`remove-duplicates/`）。凡本文与代码冲突处，**一律以代码为准**。

---

## 0.0｜落地状态与勘误索引（S8 收口）

### 切片落地状态

| 切片 | 提交 | 状态 | 备注 |
| ---- | ---- | ---- | ---- |
| S1+S2 引擎双隐藏集 + 桥与协议 | `79d7efb` | ✅ 已落地 | 该提交只动 `rust/`；协议与两个 runtime 的 TS 那半边实际随 S4 落地（见 §10 "S4 重定义"） |
| S3 稠密扫描前置加固 | `7c13fd4` | ✅ 已落地 | 顺带把筛选集提前建在 `viewport/effective-hidden.ts`（**不是** §7 规划的路径，见勘误 E1） |
| S4 adapter 算集合并推给引擎 | `0ac8166` | ✅ 已落地 | 唯一有真实行为变化的前置切片：SUBTOTAL 两档开始排除被筛行 |
| S5 adapter 原子翻转 | `d123275` | ✅ 已落地 | bridge 双路**有意不做**（见勘误 E6） |
| S5a 结构位移重映射 | `1a7fae3` | ✅ 已落地 | §10 从未把它派进任何切片（见勘误 E7） |
| S6 死代码清除 | `50a14e1` | ✅ 已落地 | 顺带改了 `SpreadsheetGrid.tsx` 与 `SpreadsheetContextMenu.tsx`（见勘误 E2） |
| S7 可见性语义收口 | `5dc7783`（前置）+ `0f9a150`（正式）+ `S9`（Reapply 补齐） | ✅ 已落地 | 复制/删除/导出随 `0f9a150`；`Data → Reapply` 入口（原子 + 菜单 + `Ctrl+Alt+L`）随 S9 补齐，见勘误 E8 |
| S8 文档收口 | `5a08eca` | ✅ 已落地 | `filter-sort.md` 整篇重写；CANONICAL §7-1 勘误；CUTOVER 记账；06 分册订正 |
| S9 `Data → Reapply` 补齐 | 本次 | ✅ 已落地 | 闭合勘误 E8 —— #27 唯一的**能力缺失**（其余七处都是文档与代码不符）。原子 + 菜单 + 键位 + i18n + 双包单测 + e2e |

**门禁（S8 复跑，2026-07-21）**：ui-core **63 suites / 1583 tests PASS**、
solid **97 suites / 1455 tests PASS**（1 suite / 6 tests skipped）。与 S6 提交信息记录的
基线逐字一致。两次运行在含无关 Table 在途改动的工作树上取得。

### 勘误索引 —— 七个切片各挡下一处，加 S8 新查出一处

设计稿的这些错处散落在长文各处（有的在"主控裁定"块、有的在"落地记录"块）。
**此处是唯一的入口清单**；每条给出所在节与一句话结论。

| #      | 所在节 | 提出者 | 设计稿写的 | 代码实际 |
| ------ | ------ | ------ | ---------- | -------- |
| **E1** | §7 表 "UI-core 状态" 行；§3 末段；§9.2 末尾"另：§7 的文件规划已被 S3 超越" | S3 / S4 实施者 | 新建 `filter-sort/filter-hidden.ts`，原子名 `filterHiddenAtom` / `effectiveHiddenRowsAtom` | **文件与原子名全部作废**。实际落在 `excel/spreadsheet-ui-core/src/viewport/effective-hidden.ts`，原子实名 `viewportFilterHiddenAtom` / `effectiveHiddenAtom`（另有 `setViewportFilterHiddenRowsAtom` / `clearViewportFilterHiddenRowsAtom` / `applyViewportFilterHiddenStructuralShiftAtom` / `VIEWPORT_FILTER_HIDDEN_REPLAY_KEY`）。按 §7 找文件会扑空 |
| **E2** | §5 逐点裁决表**末行**；§7 表 "Grid" 行 | S6 实施者 | `SpreadsheetGrid.tsx`"零处读 `originalRow`，必须保留（零改动）"；Grid 的唯一改动是改读并集 | 对**字段**成立、对**机制**不成立。S6 另删了两处死分支：Grid 填充柄的 per-cell 回退（读 `remapped`）、`SpreadsheetContextMenu.tsx` 为粘贴重建的 `displayToSourceRowMap`（同一常假条件）。**逐文件表遗漏了这两处**——判"零改动"的依据是搜字段，而机制在一跳之外 |
| **E3** | §8.1 首个引用块 | S3 实施者 | "今天对手动隐藏行就存在同一 bug 的弱化版" | **不成立，已删除**。手动隐藏行的 cell 照常带真实值进 `byRow`，不会被判为全空重复行。§8.1 描述的是**新设计引入的风险**，不是存量 bug —— S3 是前置约束，不是紧急修复 |
| **E4** | §8.1 主控裁定二；连带 §3 末段 | S3 实施者 | `remove-duplicates` / `text-to-columns` 跳过**并集**隐藏行；二者列为并集消费者 | **改为只跳过筛选子集**。跳过手动隐藏行会主动制造与 Excel 的分歧，且与 S3"行为零变化"的验收硬约束直接冲突（用户今天手动隐藏任一行，去重结果就会立刻改变）。并集的真实消费者只剩 `go-to` 与 Grid 渲染 |
| **E5** | §7 表 "UI-core 筛选" 行 vs §10 S6 行；§9.2 主控裁定三 修正 2 | S4 实施者 | `buildSortExcludedRows` 换源归 S4（§7）／归 S6（§10）—— 设计稿**自相矛盾** | **定档 S5**。S4 完全不写 `viewportFilterHiddenAtom`（作用域止于 adapter，集合算完直接推给引擎）；换源必须与"原子真正被填值"同切片，否则它读一个恒空集合、排序排除行静默失效 |
| **E6** | §6.5 表 "bridge" 行；§10 S5 行 | S5 实施者 | `eval-hidden-rows-bridge.ts` 扩为双路推送 | **有意不做，两处作废**。S4 已把筛选集的推送放在两个 adapter 的 `setFilterSort` 内部（ACK **之前** await）；bridge 再加一路会产生**第二个写者**，且比 adapter 内推送晚一拍。真要迁到 bridge，须先加 `SpreadsheetBackend.setEvalFilterHiddenRows` 端口并**同时**撤掉两个 adapter 的内部推送 |
| **E7** | §3 "共性复用" 首条；§10 切片表 | S5 / S5a 实施者 | 筛选集复用 `remapIndexSetAfterStructuralShift` 随结构位移平移 | §3 要求了，但 **§10 没把它派进任何切片**，S5 派单也不含它 → S5 落地即成实测回归（筛选激活时插入行 → 陈旧索引**指向另一行真实数据**，表头被吞、被筛掉的值重现）。S5a 补齐，落点**三层**（UI-core / 两个 adapter 的本地快照 / 引擎副本），缺任一层复现都不算修好 |
| **E8 (S8 查出 → S9 已闭合)** | §4.3；§7 表 "UI 入口" 行；§10 S7 行；§9.1-2 | S8 实施者提出 / S9 实施者闭合 | 新增 `reapplyFilterAtom` + Data 菜单 `Reapply` + `Ctrl+Alt+L`，作为快照语义的显式重算入口；"端口缺失时按惯例**隐藏**入口" | **S8 时三者均未实现，S9 已补齐**，但形状有两处与设计稿不同：①**不隐藏，改禁用** —— Reapply 的常态不可用原因是"当前无激活筛选"，一个随筛选出现/消失的菜单项比灰掉更像 bug；可用性全部由纯派生的 `reapplyFilterDisabledReasonAtom` 承担，与紧邻的 `data.filter` 一致。②**只重做筛选，不重做排序** —— Excel 的 Reapply 确实涵盖排序（已查证），但 #24 之后排序不再是视图状态，`FilterSortState` 只有 `rules`，没有可重放的排序规格；重跑物理排序会变成一次数据变更。落点：`filter-sort/index.ts`（`reapplyFilterAtom` / `reapplyFilterDisabledReasonAtom`）、`menu-bar/index.ts`（`data.reapply`）、`keyboard/`（`filterSort.reapply`）、`SpreadsheetMenuBar.tsx` + `SpreadsheetGrid.tsx` 宿主接线、en/zh i18n |

> **另有两项计数/强度问题，不算"与代码不符"但同样必须找得到**：
>
> - **§9.2 主控裁定三的白名单自相矛盾**（该块内已标为"第 5 处不符"）：修正 1 的表格把
>   `buildSortExcludedRows` 那 6 例单列一行，修正 2 随后定档归 S5，但"S5 当天的白名单"
>   只枚举了修正 1 的另一行。照字面执行会误报回归。**判据应为两者之并**。
> - **§8.3 的证据强度**：删除行"只删可见行"的结论出处是 **MS Q&A 志愿版主 / MVP 与
>   Contextures**，**不是微软规范文档**；官方 [Copy visible cells only](https://support.microsoft.com/en-us/office/copy-visible-cells-only-6e3a1f01-2884-4332-b262-8b814412847e)
>   那句 "Excel copies hidden **or filtered** cells" 与我们采信的一侧**直接矛盾**。
>   三条明确未证实项见 §8.3：①无微软规范文档正面写过删除行行为；②"Excel 2013+"版本
>   限定词是原稿臆造已删；③"选区完全落在隐藏行内"无任何来源，实现取保守默认
>   （可见集为空 ⇒ 零下发），**这是未证实的默认选择，不是已验证行为**。
>
> **S8 未发现第九处不符；S9 亦未发现。** S9 实施者按派单逐条回代码核实了 §4.3 / §7 "UI 入口" 行 /
> §10 S7 行的每个名字，没有找到 E1–E8 之外的新不符项。E8 由"未实现"改判为"已实现，形状有两处
> 有意偏离"，偏离本身记在 E8 行内 —— 那是实现裁决，不是设计稿写错。逐条回代码核实过的名字见
> 本节 E1–E8 与 `excel/spreadsheet-ui-core/docs/filter-sort.md`。

### S8 另行订正的两处叙述（非新增不符，是措辞已过期）

- **`buildFilterSortDisplayRows` 名字与注释已名不副实**（`backend/projection-helpers.ts`）。
  §7 规划它改名为 `computeFilterHiddenRows(...): Set<number>`；**实际未改名、未改返回型**——
  它仍返回 display→source 排列数组，只是那个排列**不再用于投影**，唯一消费者是
  `filterHiddenRowsFromDisplayRows(displayRows, rowCount)`（`adapter/filter-hidden-rows.ts`），
  把它折成隐藏行集。行为正确，命名误导。S8 只订正了它的文档注释（原文说"投影在此把被筛行压缩掉"，
  而投影早已不压缩），**未改名**——改名会动两个 adapter 的调用点，超出纯文档切片边界。
- **`@types/` 下仍有 `originalRow`**：那是**过期的构建产物**（`.d.ts`），不是源码。
  S6 的 `grep -r originalRow` 判据针对 `src/` 与 `test/`，两处均零命中。

---

## 0｜裁决摘要

| #   | 问题               | 裁决                                                                                                                                                                                       |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 隐藏集分几个       | **两个**：`viewportHiddenAtom`（手动隐藏，不动）+ 新增 `filterHiddenAtom`（筛选隐藏）。理由是三条硬约束而非洁癖：SUBTOTAL 两层规则、复制语义不对称、unhide 不得解筛选。Grid 取**并集**渲染 |
| 2   | 谁算筛选可见性     | **adapter 在应用筛选规则时（`setFilterSort`）一次性全列扫描**，把完整 filtered-out 源行集随 ACK 回传，UI-core 存进 `filterHiddenAtom`。**不**在投影期算——投影是有界窗口，谓词要全列        |
| 3   | 复算时机           | 快照语义，不随编辑实时重算（**与 Excel 一致**）；新增 `Data → Reapply` 命令（Excel `Ctrl+Alt+L`）作为显式重算入口。**已落地（S9）**，两处形状偏离见勘误 E8                               |
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

- 纯函数 `buildFilterSortDisplayRows`（`excel/spreadsheet-ui-core/src/backend/projection-helpers.ts:366-404`）产出 `displayRow → sourceRow` 稀疏数组。压缩发生在 `:399-401`：

  ```ts
  dataRows.forEach((row, index) => {
    rows[dataRowStart + index] = row
  })
  ```

  header 行 0 直通（`:387`）、summary 行（`isFilterSortSummaryRow`，`:341-347`）钉在末位、数据行 1 起压缩。行序恒为源序（排序支路已随 #24 退役，见函数头注释 `:360-365`）。

- 谓词 `rowMatchesFilterSortRules`（`:349-358`）+ `filterRuleMatchesValue`（`:91-112`）：equals / contains / range / list 四型，逐规则 AND。
- **static adapter**（`excel/solid-excel/src-vnext/adapter/static-backend.ts`）：`buildFilterSortDisplayRows`（`:1341-1355`）取全表 `maxRow`，投影循环 `:1626-1665` 在 `filterSortActive` 分支里按 `displayRows[displayRow]` 走；`projectSourceCell`（`:1390-1425`）写 `clone.row = displayRow` 且 `clone.originalRow = sourceRow`，并把公式求值锚在 `sourceRow` 上（`:1414-1417`，注释明说 `[@Col]` 必须交到公式物理所在行）；`addFormatOnlyCells`（`:1265-1295`）同样按 `displayRows` 走并补 `originalRow`。
- **worker adapter**（`excel/solid-excel/src-vnext/adapter/worker-workbook-backend.ts`）：`computeFilterSortDisplayRows`（`:2129-2178`）**已经是全列扫描**——`listNonEmpty` 探 sheet 行界，每个谓词列一次 `readSparseRange`，总量受 `MAX_FILTER_SORT_PREDICATE_CELLS = 50_000`（`:208`）约束，超限抛 `FILTER_SORT_SOURCE_TOO_LARGE`（`:209`），**不截断**。结果缓存在 `filterSortDisplayRowsBySheetId`（`:1277`），revision bump 时整体清（`:1359`）、按 sheet 清（`:1967`）。`setFilterSort`（`:4074-4099`）在 ACK **之前**算好排列再落缓存。
- 读投影走 `readFilteredRange`（`:2196-2290`）：display 窗口 → `MappedDisplayRow[]`（`:749`）→ 因压缩后源行散布而必须取 `[minSourceRow..maxSourceRow]` 包围盒 → 逐格 `readCells` refs → 回写时重新盖 `cell.row = displayRow; cell.originalRow = sourceRow`。overlay（validation `:752-829`、条件格式 `:876-898`、格式 `:940-953`）一律用 `cell.originalRow ?? cell.row` 解源坐标。
- **W2 统一网关**（`excel/spreadsheet-ui-core/src/editing/mutation-gateway.ts`）：所有内容 mutation 先经 `resolveContentMutationAtom`（`:297-361`），第 1 步 display→source 回映射（`:143-238`），第 2 步 protection 门禁（`:329-349`）。回映射靠"任一 cell 带 `originalRow`"作为激活开关（`:150`），一个连续 display 区间可能裂成多个源行 run（`:213-238`）。
- **S6 遗留缺口**：`deriveFilterHiddenRows`（`excel/spreadsheet-ui-core/src/filter-sort/index.ts:1358-1380`）为了给物理排序组 `excludedRows`，靠"扫投影窗口内 `originalRow` 的缺口"反推被筛掉的行。它自己的注释（`:1343-1356`）承认：只能在观察到的 `[minObserved..maxObserved]` span 内推断，**窗口外的被筛行推不出来**，是记录在案的 v1 缺口。

### 1.2 手动隐藏行（对照物 = 目标形态）

`excel/spreadsheet-ui-core/src/viewport/hidden.ts` 是本次要靠拢的形态，机制已完备：

- **UI-core 全量真值**：`viewportHiddenBackingAtom` 存 `rowsBySheet: Record<string, number[]>`（源行号，`sanitizeIndices` 去重升序，`:41-52`），只读投影 `viewportHiddenAtom`（`:86-89`）。文件抬头（`:21-28`）已把口径钉死：backend 的 `hideRows`/`unhideRows` 降级为 fire-and-forget 持久化镜像，`readViewportSizeProjection` 的 hidden 切片降级为**一次性 hydration 种子**，无 ACK 生命周期、无权威票据。
- **行号身份保留**：隐藏行不参与渲染，行号不重编。`SpreadsheetGrid.tsx:1355-1359` 的 `getRows()` 直接把隐藏行从窗口索引里 `filter` 掉，行头 `:3806-3823` 渲染 `{row + 1}` —— **Excel 的 1、4、7 跳号今天对手动隐藏行已经免费成立**。
- **窗口膨胀**：`viewport/window.ts:203-234` 的 `getVisibleWindowWithHidden` 按隐藏集把 `rowEnd` 往后推，保证窗口内可见行数与无隐藏时一致；`countVisibleIndices`（`:188-197`）配套。
- **结构位移**：`applyViewportHiddenStructuralShiftAtom`（`:509-542`）消费 `BackendMutationResult.structuralShift`，经 `remapIndexSetAfterStructuralShift` 让隐藏集随插入/删除行平移，删除带内的索引直接掉出。
- **undo**：`registerHistoryLocalReplayApplier(VIEWPORT_HIDDEN_REPLAY_KEY, …)`（`:556-575`）在 UI-core 内闭环，不经引擎快照。
- **推给引擎**：`excel/solid-excel/src-vnext/provider/eval-hidden-rows-bridge.ts` 订阅 `viewportHiddenAtom`，按 sheet 序列化去重（`serializeRows`，`:40-42`），每次 fire 重读端口（`:50`，尊重异步 capability 见证），`Promise.all` 推完再 `refreshVisibleProjection`（`:76-81`）。单实例 owner 经 `WeakMap<Store, …>` 保证 Provider 重挂不会双推。

**关键对照**：手动隐藏是"UI-core 持有全量真值 + 单向推给引擎 + Grid 取集合过滤"，筛选目前是"adapter 持有排列 + 投影期压缩 + UI-core 反推"。本次就是把后者改造成前者。

### 1.3 引擎侧现状

- **存储**：`WorkbookAtomContext.eval_hidden_rows: RefCell<HashMap<usize, Rc<HashSet<u32>>>>`（`excel/rust/excel-core/src/sheet.rs:946`），按 sheet index 键；放在 context 而非 `Sheet` 上，是因为所有 sheet 共享一个 `Store`，跨表 SUBTOTAL 必须从一个 provider 够到任意 sheet 的集合（`:933-945`）。
- **入口**：`Workbook::set_eval_hidden_rows(&mut self, sheet_index: usize, rows: &[u32])`（`excel/rust/excel-core/src/workbook.rs:2472-2478`）。契约（`:2457-2471`）：**整集替换、幂等、空集清除、引擎不建 hidden 模型也不推断来源、越界 sheet 静默 no-op、custom-call 期间 no-op**。
- **失效**：单一 epoch 原子 `hidden_epoch` + `hidden_revision`（`sheet.rs:956-958`）；`depend_hidden`（`:1043-1046`）在探测**之前**建边（`hidden_rows_for_sheet`，`:1054-1062`），使当前无隐藏行的 101-111 公式也能在首次推送后重算；`hidden_rows_untracked`（`:1068-1070`）供 eager provider；setter（`:1077-1087`）先写侧存储再 bump epoch。
- **`fn_subtotal`**（`excel/rust/excel-core/src/eval.rs:19932-19960`）：

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
- **WASM**（`excel/rust/wasm/src/lib.rs:2485-2489`）：

  ```rust
  #[wasm_bindgen(js_name = "setEvalHiddenRows")]
  pub fn set_eval_hidden_rows(&mut self, sheet_idx: u32, rows: Vec<u32>)
  ```

  JS 名 `setEvalHiddenRows`，入参 `number[] | Uint32Array`，返回 `void`，从不抛。

- **冻结面**：`excel/rust/excel-core/tests/fixtures/wasm_api_signatures.txt` 第 57 行逐字记录了上面这条签名（含 `js_name` 与完整参数表）。消费者是 `excel/rust/excel-core/tests/architecture_invariants.rs:407-440` 的 **INV-4** `wasm_public_api_signatures_unchanged`：删改是硬失败，新增失败并要求**同 commit 重生成**（生成器 `:486-504`，`cargo test --test architecture_invariants wasm_snapshot_generate -- --ignored`）。
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
| 删除行              | ✅ 筛选激活时选中并删除跨隐藏行的行区间**只删可见行**，被筛行存活；手动隐藏行**照样被删**（§8.3 已查证，出处见该节）                    | 偶然✓     | ✓（§8.3）       |
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
  **归属：S5a（补记，2026-07-21）。** §10 的切片表从未把这条派进任何切片，S5 落地后成为实测回归
  （筛选激活时插入行 → 陈旧索引指向表头行，表头被吞、被筛掉的值重现）。S5a 补齐，落点三层：
  1. **UI-core**：`viewport/effective-hidden.ts` 的 `applyViewportFilterHiddenStructuralShiftAtom`
     （**仅 row 轴**——筛选集是行集合，列位移对它恒为 no-op；手动集持双轴故需分支），
     在 `operations/index.ts` 与 `remove-duplicates/index.ts` 两个既有
     `applyViewportHiddenStructuralShiftAtom` 调用点旁并列，并各自补一条
     `VIEWPORT_FILTER_HIDDEN_REPLAY_KEY` 的 `localSidePayloads`（删除带内的成员没有逆运算，
     undo 只能重放录下的快照——与手动集同一理由）。
  2. **两个 adapter 的本地快照**：`static-backend.ts` 的 `filterHiddenRowsBySheetId`
     （insertRows / deleteRows / removeRowsExact 三处，并入 `captureFullSheet`
     / `restoreFullSheet` 以支持 undo）、`worker-workbook-backend.ts` 的同名 Map
     （`shiftFilterHiddenOverlay`，并按 `mergeOverlay` 的样板在结构记录里挂
     `filterHiddenOverlay` 前后像）。**这一层不是可选的**：投影主动扣掉筛选隐藏行，
     只修 UI-core 会让表头行"可见但空白"。
  3. **引擎副本**：worker 侧在位移后重推 `setEvalFilterHiddenRows`（static 侧的
     `filterHiddenRowsForSheet` 本身就是求值输入，随 Map 自动跟随），否则
     `SUBTOTAL(1-11)` / `(101-111)` 会按错位的集合聚合。

  > **顺带勘误 S5 落地记录第 2 条**：那里写"筛选激活期间插入或删除行会让隐藏集**错位一行**"，
  > 低估了严重性——错位的索引会**指向另一行真实数据**（表头或相邻数据行），是"藏错行 + 露出被筛行"，
  > 不是渲染偏移。同时那条只点了 `viewport/effective-hidden.ts` 与两个调用点，
  > 附带一句"两个 adapter 的本地快照同样要跟随"；按代码核实，adapter 与引擎两层的工作量
  > 大于 UI-core 层，且缺任一层复现都不算修好。
  >
  > **两处不可达路径（核实所得，非遗漏）**：`remove-duplicates` 与右键 `row.delete` 都
  > 按 §8.1/§8.3 跳过筛选隐藏行，所以在这两条路径上**筛选隐藏行永远不会落在删除带内**——
  > "被删的行本身在集合里"这个场景只能从 `runStructureOperationAtom` 直接驱动，
  > 单测在那里覆盖，e2e 不必（也无法）复现。
- `sanitizeIndices` / `sameIndices` / 每 sheet `number[]` 存储形状，直接复用 `hidden.ts` 的既有私有函数（提取为共享模块，或 `filter-hidden.ts` 内复制 12 行——按 §10 切片 S3 的实现者裁量）。
- 上限：与 `MAX_FILTER_SORT_SHEETS = 256` 同级按 sheet 数有界；单 sheet 隐藏行数受 §4 的 50k 扫描上限天然界定，**不设第二个 cap**。

**Grid 渲染取并集**。改动点只有一处，且是纯加法：

```ts
// SpreadsheetGrid.tsx:1355-1359 现状
const hiddenRows = new Set(getHiddenRowsForSheet(hiddenState(), props.sheetId))
return getWindowIndexes(window.rowStart, window.rowEnd).filter((row) => !hiddenRows.has(row))
```

改为读一个 UI-core 侧的派生原子 `effectiveHiddenRowsAtom(sheetId) = manual ∪ filter`（派生，非新真值），`getHiddenRowSet()`（`:673-675`）与 `getRenderedVisibleWindow()` 喂给 `getVisibleWindowWithHidden` 的入参同源替换。**行号跳号因此零成本落地**——行头本来就渲染 `{row + 1}`（`:3806-3823`）。

并集派生原子供给 `go-to` 的 `hiddenRows` 上下文（`go-to/index.ts:575`）。**并集只在"渲染与导航可见性"语义下使用；凡是要动数据的消费者必须读源子集** —— `remove-duplicates` / `text-to-columns` 的扫描跳过（§8.1）、复制的可见性过滤（§8.2）、SUBTOTAL 推送都只读**筛选**子集。（初稿把前两者列为并集消费者，2026-07-21 已按 §8.1 主控裁定二更正。）

---

## 4｜裁决 2：谁计算筛选可见性

### 4.1 问题陈述

筛选谓词需要**全列数据**（判定第 N 行是否匹配，要读第 N 行的规则列），而投影是**有界窗口**。现网在投影期算（`buildFilterSortDisplayRows`），worker 侧靠 `computeFilterSortDisplayRows` 偷偷做了全列扫描才成立；UI-core 侧的 `deriveFilterHiddenRows` 则只能在窗口内反推，留下了 S5/S6 那个在案的 v1 缺口。

### 4.2 裁决：应用规则时一次性全列扫描，结果存进 UI-core

**adapter 在 `setFilterSort` 处理中做一次全列谓词扫描，把完整的 filtered-out 源行集随 ACK 回传；UI-core 写入 `filterHiddenAtom`。投影期不再做任何筛选计算。**

端口演进（`excel/spreadsheet-ui-core/src/backend/types.ts`）：

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

- UI-core 命令 `reapplyFilterAtom`：以当前 `filterSortStateAtom[sheetId]` 的**已提交规则**重发一次
  `setFilterSort`，把 ACK 经**同一个** `setViewportFilterHiddenRowsAtom` 落回筛选集。挂到 Data 菜单
  （`data.reapply`）与 `Ctrl+Alt+L`。**已落地（S9）**，两处形状偏离设计稿，见 §0.0 勘误 E8：
  端口缺失时**禁用而非隐藏**；**只重做筛选，不重做排序**。
  - **真值来源复用 adapter 的整列扫描，不在 UI-core 另起一条。** UI-core 自算会是**第二个谓词求值器**
    （Apply 与 Reapply 可能对同一规则给出不同答案）、会是**窗口有界**的（即 §4.2 已否掉、S5 已删掉的
    `deriveFilterHiddenRows` 缺口重现）、且落在宿主的 `MAX_FILTER_SORT_PREDICATE_CELLS` 失败关闭预算之外。
    这与 CANONICAL_OWNERSHIP #29 不冲突：归属讲的是**谁持有**这条视图事实，不是谁计算它 ——
    `viewportFilterHiddenAtom` 仍是唯一真值且只在匹配 ACK 上被写，宿主是执行器，与 TSV / 图片导出端口同形。
  - **不进 undo 栈。** 应用筛选本身不产生 history 条目，Reapply 若产生就会是一条没有对应物的撤销步。
    微软文档对 Excel 的 Reapply 与 undo 的关系**两侧都未表态**（2026-07-21 核实：官方
    "Reapply a filter and sort, or clear a filter" 页全文不提 undo），所以这是**与 Apply 保持一致的未证实默认**，
    不是已验证的 Excel 对齐。
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
| `grid/SpreadsheetGrid.tsx`、各 overlay、`status-bar/`                               | 零处读 `originalRow`                                                                                                                                    | ~~**必须保留（零改动）**~~ **⚠️ 见 §0.0 勘误 E2**：对**字段**成立、对**机制**不成立——Grid 填充柄与 `SpreadsheetContextMenu.tsx` 的粘贴路径都读一跳之外的 `remapped`，S6 一并删除。状态栏那半句仍正确：聚合（`status-bar/index.ts:189-256`）按"单元格存在性"而非行算术工作，隐藏行不产 `DisplayCell` 故自动不计入——**与 Excel 状态栏只统计可见单元格一致，免费正确** |

**净结论**：W2 网关缩水约 60%（`:240` 以上除合法性守卫外全删，`:240` 以下全留）；`originalRow` 字段与其全部回映射机制消失；两个 adapter 的筛选投影分支整体塌回恒等路径。

---

## 6｜裁决 4：引擎契约变更（可区分来源）

### 6.1 端口形状：新增独立端口（ADDITIVE）

**裁决**：新增 `setEvalFilterHiddenRows`，**不**扩展 `setEvalHiddenRows` 的参数。

```ts
// excel/spreadsheet-ui-core/src/backend/types.ts
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
| WASM           | `excel/rust/wasm/src/lib.rs`：新增 `#[wasm_bindgen(js_name = "setEvalFilterHiddenRows")] pub fn set_eval_filter_hidden_rows(&mut self, sheet_idx: u32, rows: Vec<u32>)`，与 `:2485-2489` 逐字同构（含 void 返回、从不抛）                                                                                                           |
| 冻结面         | `excel/rust/excel-core/tests/fixtures/wasm_api_signatures.txt` **同 commit 重生成**（`cargo test --test architecture_invariants wasm_snapshot_generate -- --ignored`）；纯新增一行，第 57 行原条目**逐字不变**（INV-4 的删改硬失败判据因此不触发）                                                                                  |
| 协议           | `worker-protocol.ts`：capability 键 `evalFilterHiddenRows: boolean`（旧 witness 缺键按 fail-closed 读 false）；client 方法 `setEvalFilterHiddenRows(sheet, rows)`，实现照 `:815-817`。**注意**：既有 `setEvalHiddenRows` 在 client 接口上是**必需**方法，新方法按后续端口惯例声明为**可选**，让老 worker 构建仍可编译         |
| WASM runtime   | `worker-runtime.ts`：引擎侧方法签名声明为 optional（照 `:144`，兼容旧 wasm-pkg 与测试 mock），dispatch 照 `:1521-1541`（同样不 `assertSheet`，同样防御性重过滤行号）。**S4 修正**：dispatch **不能**用 `assertMethod`（照抄 `:1538` 会抛 `WASM_METHOD_UNAVAILABLE`，把"旧 wasm-pkg"变成"筛选整个失败"），改为方法缺失时显式回 `UNSUPPORTED`——这才是让下面第 2 档降级"无声"的机制 |
| TS runtime     | `worker-runtime-ts.ts`：`TS_WORKER_RUNTIME_CAPABILITIES.evalFilterHiddenRows: false`（照 `:126`）+ `unsupported('setEvalFilterHiddenRows …')`（照 `:1509-1514`），fail-closed，绝不伪 ACK                                                                                                                                     |
| worker adapter | 非 mutation，无 exact ACK / 无 undo / 无自有 revision bump。**S4 实测修正**：本设计原写"新增 `SpreadsheetBackend` 端口 + `runtimeSupports` getter"（照 `setEvalHiddenRows` 的形状），但 S4 的推送源是 adapter 自己的 `setFilterSort`，**不是 UI-core**——UI-core 侧真值（`viewportFilterHiddenAtom`）要等 S5 才接线。因此 S4 落地的是 adapter 内部的 `pushEvalFilterHiddenRows(sheet, rows)`，在 ACK **之前** await；对外端口留给 S5 按需要再加（`backend/types.ts` 零改动） |
| static adapter | 新增 `filterHiddenRowsBySheetId: Map<string, Set<number>>`，**在 `setFilterSort` 里自算**（它自己就持有全部单元格值，没有"宿主推送"这条腿，所以没有 union 逻辑）。`evalHiddenRowsForSheet`（`:1212-1225`）**保持只服务 manual 语义**；新增 `filterHiddenRowsForSheet`，静态求值器 `applySubtotal` 增加第二个入参 `filterHiddenRows`，**两个 band 都排除它**、只有 101-111 额外排除 manual。`:1188-1211` 的"筛选隐藏行被刻意排除"注释随之改写 |
| bridge         | `eval-hidden-rows-bridge.ts` 扩为双路：同一个 owner / `WeakMap<Store, …>` 单实例约束 / 每 sheet 序列化去重 ledger 各自一份，订阅从 `viewportHiddenAtom` 扩到 `[viewportHiddenAtom, filterHiddenAtom]`，两路推送 `Promise.all` 后单次 `refreshVisibleProjection`（§6.1）                                                       |

**向后兼容策略（三档降级，全部无声且不撒谎）**：

1. 端口/方法齐全（WASM worker + 新 wasm-pkg）→ 完整两层语义。
2. 有 `setEvalHiddenRows` 无 `setEvalFilterHiddenRows`（旧 wasm-pkg / 未升级 worker）→ filter 集不进引擎，SUBTOTAL 1-11 与 101-111 **退化为今天的行为**（1-11 全含、101-111 排手动）。UI 侧筛选照常隐藏行——**视图正确、公式偏保守**，不产生错误结果，只产生"没排除"。
3. 两个都无（TS worker）→ 今天的行为，与 `evalHiddenRows: false` 的既有降级形状一致。

---

## 7｜贯通层清单

| 层             | 文件                                                                             | 变更                                                                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 引擎           | `excel/rust/excel-core/src/sheet.rs`、`workbook.rs`、`eval.rs`                         | `eval_filter_hidden_rows` 存储 + 双 epoch + `set_eval_filter_hidden_rows` + provider 方法 + `fn_subtotal` 双层规则（§6.2-6.4）                                                                                                  |
| WASM           | `excel/rust/wasm/src/lib.rs`；`excel/rust/excel-core/tests/fixtures/wasm_api_signatures.txt` | `setEvalFilterHiddenRows` 导出 + 快照同 commit 重生成                                                                                                                                                                           |
| 协议           | `excel/solid-excel/src-vnext/adapter/worker-protocol.ts`                               | capability 键 + client 方法（可选）                                                                                                                                                                                             |
| runtime        | `worker-runtime.ts`、`worker-runtime-ts.ts`                                      | WASM dispatch case；TS `false` + `unsupported`                                                                                                                                                                                  |
| 端口           | `excel/spreadsheet-ui-core/src/backend/types.ts`                               | `SetEvalFilterHiddenRowsRequest` + 端口；`SetFilterSortResult.hiddenRowIndices`；**删** `DisplayCell.originalRow`                                                                                                               |
| UI-core 状态   | ~~`excel/spreadsheet-ui-core/src/filter-sort/filter-hidden.ts`（新）~~ **⚠️ 作废，见 §0.0 勘误 E1**。实际：`excel/spreadsheet-ui-core/src/viewport/effective-hidden.ts` | ~~`filterHiddenAtom` / `setFilterHiddenRowsAtom` / `clearFilterHiddenRowsAtom` / `applyFilterHiddenStructuralShiftAtom` / `effectiveHiddenRowsForSheet`~~ **本行原子名全部作废**。实名：`viewportFilterHiddenAtom`（derived 只读投影，私有 backing `spreadsheet.viewport.filterHiddenBacking`）、`setViewportFilterHiddenRowsAtom` / `clearViewportFilterHiddenRowsAtom` / `applyViewportFilterHiddenStructuralShiftAtom`（command）、`effectiveHiddenAtom`（并集 derived）、`getFilterHiddenRowsForSheet` / `unionHiddenRowsForSheet`（helper）、`VIEWPORT_FILTER_HIDDEN_REPLAY_KEY`。分类见 `viewport/README.md` |
| UI-core 筛选   | `excel/spreadsheet-ui-core/src/filter-sort/index.ts`                           | `runFilterSortMutationAtom` 消费 ACK 的 `hiddenRowIndices`；新增 `reapplyFilterAtom` + `reapplyFilterDisabledReasonAtom`（S9）；**删** `deriveFilterHiddenRows`；`buildSortExcludedRows` 改读两集                              |
| UI-core 网关   | `excel/spreadsheet-ui-core/src/editing/mutation-gateway.ts`                    | 回映射半边全删、protection 半边全留（§5）                                                                                                                                                                                       |
| UI-core 消费者 | `go-to/`、`remove-duplicates/`、`text-to-columns/`、`clipboard/`、`operations/`  | `go-to` 接**并集**；稠密扫描跳过**筛选**隐藏行（§8.1 裁定二）；复制只取可见（§8.2）；删除行只删可见（§8.3）                                                                                                                     |
| 投影 helper    | `excel/spreadsheet-ui-core/src/backend/projection-helpers.ts`                  | `buildFilterSortDisplayRows` → `computeFilterHiddenRows(state, options, readValue): Set<number>`；`cloneCell` 去字段                                                                                                            |
| static adapter | `excel/solid-excel/src-vnext/adapter/static-backend.ts`                                | 投影塌回恒等分支；`setFilterSort` 回传隐藏集；`evalFilterHiddenRowsBySheetId` + 端口；**解除** filter 期 merge 抑制                                                                                                             |
| worker adapter | `excel/solid-excel/src-vnext/adapter/worker-workbook-backend.ts`                       | `readFilteredRange` 与 `MappedDisplayRow` 删除、overlay 去 `?? cell.row`；扫描载荷改隐藏集；`filterSortDisplayRowsBySheetId` 缓存删除；`setEvalFilterHiddenRowsThroughWorker`                                                   |
| bridge         | `excel/solid-excel/src-vnext/provider/eval-hidden-rows-bridge.ts`                      | 双路推送（§6.5）                                                                                                                                                                                                                |
| Grid           | `excel/solid-excel/src-vnext/grid/SpreadsheetGrid.tsx`                                 | `getHiddenRowSet()` / `getRows()` / `getRenderedVisibleWindow()` 改读并集派生原子（**唯一渲染改动**；行号跳号免费）                                                                                                             |
| UI 入口        | `menu-bar/index.ts`、`keyboard/`、`SpreadsheetMenuBar.tsx`、`SpreadsheetGrid.tsx` | `Data → Reapply`（`data.reapply` + dispatch `reapply-filter`）+ `Ctrl+Alt+L`（intent `filterSort.reapply`）。**已落地（S9）**；~~端口缺失按惯例隐藏~~ → **改为禁用**，见 §0.0 勘误 E8                                          |

---

## 8｜必须显式裁决的边角（"免费午餐"消失面）

压缩语义下若干行为是**副作用正确**的。切到隐藏语义后必须显式实现，否则是回归。

### 8.1 稠密行扫描 —— 数据安全 blocker

`remove-duplicates/algorithm.ts:186-204` 在 `[firstScanRow..endRow]` 上**稠密**迭代，对 `byRow` 里没有 cell 的行产出"全空元组"。

- 压缩下安全：被筛行**根本不在** display 区间内，循环永远访问不到。
- 隐藏下**危险**：隐藏行**就在** `[startRow..endRow]` 区间内，但稀疏投影不产它的 cell → 每个隐藏行被当作全空行 → 隐藏行 2..N 被判为隐藏行 1 的**重复行**并喂给 `backend.removeRows` → **静默数据丢失**。

**裁决**（2026-07-21 修订，见下方两条更正）：`remove-duplicates` 的扫描必须显式跳过**筛选隐藏行（不是并集）**，且**必须先于 adapter 翻转落地**：切片序 S3 早于 S5（§10）。

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

> **主控裁定二（2026-07-21，S3 实施者提出，核实后采纳）**：本节初稿要求"跳过**并集**隐藏行"，
> **该口径已改为"只跳过筛选隐藏行"**。三条理由，任一独立成立：
>
> 1. **Excel 语义**：删除重复项作用于整个选区，**包含手动隐藏行**。跳过手动隐藏行会主动制造与
>    Excel 的分歧 —— 而本轮改造的目的正是消除分歧。
> 2. **危害面的准确定义**：真正的风险不是"行被隐藏了"，而是"行落在 `[startRow..endRow]` 内却
>    贡献不出任何 cell（没进投影）"。S5 之后只有**筛选**隐藏行具备这个性质；手动隐藏行的 cell
>    照常带真实值进 `byRow`（见上条更正）。对手动隐藏行设防既无必要，也防不到点上。
> 3. **与 S3 自身的硬约束冲突**：S3 的验收条件是**行为零变化**（§10）。若接并集，用户今天只要
>    手动隐藏任意一行，删除重复项的结果就会立刻改变 —— 并集读法在 S3 的约束下**根本不可实现**。
>
> 连带修正：§3 末段把 `remove-duplicates` / `text-to-columns` 列为"并集消费者"同样是错的，
> 二者读**筛选子集**；并集的真实消费者只剩 `go-to`（渲染与可见性导航语义）。这与 §8.2 复制侧
> 已经选筛选子集的裁决自洽 —— 凡是**要动数据**的消费者都读筛选子集，只有**导航/渲染**读并集。
>
> 记账：此裁定由 S3 实施者在动工前提出并拒绝按初稿实现，属于我在任务书中明确要求的行为
> （"若确实冲突，在报告里提出并给建议，不要擅自选一个实现了事"）。

`text-to-columns/index.ts:784-787` 有同形状的稠密构行。危害较低（按列拆分，隐藏行写回的是空拆分结果），但同样按"跳过**筛选**隐藏行"加固（同上裁定），一并归入 S3。

### 8.2 复制只复制可见单元格

Excel 语义（§2 已核实）：**筛选**隐藏行复制时自动跳过；**手动**隐藏行照样复制。这正是 §3 坚持两个集合的第二条硬约束的落点。

**裁决**：复制路径（`clipboard/`，及 `copy-as/`）在展开选区时，从**筛选隐藏集**（不是并集）中剔除行。手动隐藏行**照旧包含**。不匹配 Excel 的 `Go To Special → Visible cells only`（那是另一条显式路径，本次不做）。

> **落地记录（S7 实施者，2026-07-21，与 §8.3 同一提交前置落地）**：`CopyAsInput.hiddenRows` 落在三个编码器（plain / markdown / html）上，宿主 `copy-as-dispatch.ts` 与 `SpreadsheetContextMenu.tsx` 的 `resultToClipboardText` 从 `viewportFilterHiddenAtom` 取值喂进去。今天恒等（筛选集恒空）。三处非平凡的连带语义已实现并 pin 了测试：
>
> - markdown 表头取 rect 内**首个可见行**，不是 `rect.startRow`；全隐藏 rect 编码为 `''`。
> - html `rowspan` 按交集内**可见行数**重新裁剪、锚点下移到首个可见行；整片隐藏的 merge 整体丢弃。不做这一步会产出 `rowspan` 大于实际 `<tr>` 数的坏表格。
> - TSV origin marker 取**首个实际输出行**，因为它是粘贴时相对引用平移的锚。
>
> ~~**仍未覆盖（记入 S7 正式切片）**：`backend.exportRangeTsv` / `consumeExportRangeTsvChunks` 大区间分块复制路径与 `backend.exportRangeAsImage` 图片导出路径都由 adapter 自行产出内容，端口上没有隐藏集入参，S5 之后会把被筛行一并导出。二者需扩端口，不属于本次前置加固范围。~~ **已闭合，见下。**

> **落地记录（S7 正式切片实施者，2026-07-21）**：上述缺口已闭合，今天仍是恒等。
>
> **形态裁决：隐藏集作为端口入参，由 UI-core 下发。** `RangeTsvExportRequest.hiddenRows` 与 `RangeImageExportRequest.hiddenRows` 新增为可选入参（ADDITIVE，省略 = 今天的行为）。依据是 CANONICAL_OWNERSHIP §2：**filter 可见性是 UI-core 视图事实，UI-core 是唯一权威，backend 端口降级为可选钩子**。端口是执行者，不是权威。
>
> 放弃的两个方案及其错处：
>
> - **adapter 自己读 `setFilterSort` 快照**（改动最小）。这会让 adapter 成为第二个权威。S4 落地记录已写明该快照与实时投影可以不一致（"编辑一个单元格可以让行在视图里移动而聚合不动"），于是小区间复制读实时 atom、大区间复制读陈旧快照 —— 把"按大小分叉"换成"按新鲜度分叉"，没有消除分叉。且自定义 backend 若从不调 `setFilterSort` 就完全无从得知。
> - **UI-core 先把选区拆成可见 run、逐 run 调端口**。TSV 上会把一次导出变成 O(run 数) 次 RPC（重度筛选的 10 万行区间可达数千次），且 `originAddr` 与分块边界要由调用方重新缝合；图片上**根本不成立** —— UI-core 无 DOM，无法把 N 张 PNG 拼成一张。
> - **把隐藏集推进 worker/WASM**（S4 对 SUBTOTAL 就是这么做的）。这里不行：SUBTOTAL 是公式语义（数据事实），导出内容成形是视图关注点。推进引擎还会引入 capability 门控与 wasm-pkg 版本偏斜 —— 旧 wasm-pkg 会静默地把 bug 放回来。现方案在**主线程 adapter 边界**过滤，隐藏集从不跨 `postMessage`，因此 WASM runtime、TS runtime（`tsvChunkExport: false` 走单发回退）、static 三条路一致生效，无门控、无版本风险。
>
> **TSV 实现**：共享纯函数 `filterTsvBandRows`（`adapter/filter-hidden-rows.ts`，与 S4 同一模块）按行带丢弃已序列化文本的行。可行性依据：`sparseRangeToTSV` 对行带恒产出"一行一 row、`\n` 连接"，且本仓 clipboard TSV 合同**两侧都不带引号**（`serializeClipboardTsv` join `\n` / `parseClipboardTsv` split `\n`），所以按行号过滤与格式本身同精度。单点插桩在 `worker-workbook-backend.consumeExportRangeTsvChunks`，同时覆盖流式、单发回退、以及委派过来的 `exportRangeTsv` 三条出口。
>
> 三个连带语义，与 §8.2 前置切片同构：
>
> - **origin marker 取首个实际输出行**（两个 adapter 均已改），否则粘贴时相对引用整体偏移。
> - **被过滤空的 chunk 整块不下发**：宿主用 `'\n'` 拼接 chunk，发一个 `''` 会在剪贴板中间插入空行。
> - **失败开放的形状守卫**：行数与行带不符（单元格值内含裸换行）时整带原样放行 —— 误删一个**可见**行是数据损坏，多导一个被筛行只是已知的次要缺陷。
>
> **图片导出路径查证结论：同构问题存在，且多出一条文本编码器没有的**。三处都必须改，缺一处都留可见瑕疵：
>
> 1. SVG 路径 —— `encodeSelectionAsHtml` 自 S7 起已支持 `hiddenRows`（含 `rowspan` 重裁），但图片路径从未把集合传进去，于是每个被筛行产出一个空 `<tr>`。
> 2. canvas 回退路径 `paintCellsToCanvasPng` —— S7 从未触及的**另一个画笔**，每个被筛行画出一条空的带边框行带。
> 3. **几何**（文本编码器无此物）：画布高度是行高之和，只修 1、2 会得到"表格正确 + 底部一条与被筛行等高的空白带"。`resolveRowHeights` 现只遍历可见行。
>
> 另外 `encodeSelectionAsImage` 的 `too-large` 预检也只计可见行，否则重度筛选的选区会因它根本不会渲染的尺寸被拒。
>
> **顺带闭合的第四个洞（S7 前置记录未提及）**：`SpreadsheetGrid.tsx` 的 `copySelectionToClipboard` —— 即 **Ctrl+C / Ctrl+X 本身** —— 两个分支都没被 S7 接线（S7 改的是右键菜单与 `copy-as/`）。只补大区间分支会把"按大小分叉"**反转**而非消除，因此小区间分支（含其 origin marker）在本切片一并加固。

### 8.3 删除行只删可见行

**裁决（2026-07-21 查证后定稿，暂定裁决维持不变）**：删除行在筛选激活时，把选区展开成"选区 ∖ **筛选**隐藏集"，按**降序**切成若干连续 run 逐个下发。手动隐藏行**照删**（与复制同口径：筛选集，非并集）。

> **查证结论（S7 实施者，2026-07-21）**：暂定裁决与可查到的最佳证据**一致**，因此照做。但证据强度必须如实记录 —— 详见下表。
>
> | 结论                                       | 出处                                                                                                                                                                                                                                                                 | 强度                                                      |
> | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
> | 筛选激活时删除行**只删可见行**，被筛行存活 | MS Q&A 志愿版主 Vijay A. Verma（[answers/4942719](https://learn.microsoft.com/en-us/answers/questions/4942719/delete-rows-after-filtering)）："You can delete only visible rows not otherwise"；Ashish Mathur（[answers/4840720](https://learn.microsoft.com/en-us/answers/questions/4840720/delete-filtered-rows)）："only the visible cells will get deleted/copied" | 中高（版主 / MVP，非规范文档）                            |
> | 手动隐藏 ≠ 筛选隐藏，手动隐藏行会被一起写/删 | MS Q&A Andreas Killer（[answers/4987876](https://learn.microsoft.com/en-us/answers/questions/4987876/filter-vs-hidden-how-excel-2016-treats-invisible-c)）给出可复现实验；[wmfexcel 对照表](https://wmfexcel.com/2015/06/13/hidden-rows-vs-filtered-rows/)                | 中高（但实验测的是单元格级操作，结构性删除行未见严格实验） |
> | 复制筛选区**只复制可见**（§8.2 依据）      | [Contextures / Debra Dalgleish](https://www.contextures.com/excelcopypastefilteredlist.html) 明确区分 "can COPY from visible rows only" 与 "CANNOT PASTE into visible rows only"；Andreas Killer 同上                                                                     | 高                                                        |
>
> **三条必须诚实标注的缺口**：
>
> 1. **没有任何微软规范文档正面写过删除行的这个行为**。更糟的是，官方 [Copy visible cells only](https://support.microsoft.com/en-us/office/copy-visible-cells-only-6e3a1f01-2884-4332-b262-8b814412847e) 里那句 "By default, Excel copies hidden **or filtered** cells in addition to visible cells" 与上表第三行**直接矛盾**，且不区分 hidden 与 filtered —— 这句话很可能就是全网"删除前必须 Go To Special"那套 cargo cult 的源头。我们采信版主 / Contextures 一侧。
> 2. **"Excel 2013+"这个版本限定词是原稿臆造的，已从 §2 表格删除**。查不到任何可信来源支持存在版本差异；唯一提出该说法的是 AI 生成的内容农场。反向证据：2010 年代的论坛帖已在描述现行行为。
> 3. **"选区完全落在隐藏行内"这个边角没有任何来源**（§12 原文点名要查的正是它）。行头点不中零高度的隐藏行，但名称框可以选出这种区间。本实现取**保守默认**：可见集为空 ⇒ **不下发任何删除**（`'no-visible-rows'`），绝不回退到原始区间。**这是未证实的默认选择，不是已验证行为。**
>
> 另记两条相邻事实：Excel 在筛选区对某些结构性操作会直接报错 "Can't move cells in a filtered range or table"；粘贴与复制**不对称**（粘贴照写隐藏行），后者与 §8.4 已有裁决一致。

**实现形状**（`operations/`，随 §8.2 一同前置落地）：

- 纯规划函数 `planFilterVisibleRowDeletions({ rowIndex, count, filterHiddenRows })` → `RowDeletionRun[]`，**降序**、run 最大化、空结果表示"零下发"。降序是硬约束：先删高位 run，低位 run 的索引才不需要重映射。
- 命令 `runFilterVisibleRowDeleteAtom` 读 `viewportFilterHiddenAtom`（筛选子集），逐 run 走既有 `runStructureOperationAtom`，首个非 `completed` 即中止并把该 run 的结局透出。每个 run 各自一条 history 条目，undo 逐条回退。
- 今天恒等：压缩语义下被筛行没有 display 槽位，筛选集恒空 ⇒ 规划结果恒为原区间单 run ⇒ 与改造前逐字节相同。宿主唯一的 `row.delete` 派发点是行头右键（`count: 1`），菜单栏没有删除行入口。

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
5. `SUBTOTAL(1-11)` 在筛选激活时结果变小（开始排除被筛行）——**这是修 bug**。**已随 S4 落地**，早于其余 4 条（它们仍等 S5）。同时 `(101-111)` 也开始排除被筛行——原先它只排除手动隐藏。

### 9.2 测试迁移清单

**总量**：受影响 **25 个测试文件 / 约 55–60 例**（ui-core 6、solid 15、e2e 4，其中 1 个已 skip）。其中 **DELETE ~28 例**（机制消失）、**MIGRATE ~15 例**（断言翻转）、**fixture-only ~10 例**。`DisplayCell.originalRow` 共出现在 **19 个测试文件**。

驱动绝大多数 DELETE 的五个符号：`unmapped-row`、`mapDisplayRangeToSourceRanges`、`requireIdentityMapping`、`buildFilterSortDisplayRows`、`buildSortExcludedRows` 的缺口反推。

> ## ⚠️ 主控裁定三（2026-07-21，独立审计后写入）—— 本节以下内容按此块修正
>
> 一次独立只读审计逐条回源核实了本节每一个条目，并全仓扫描查漏。**本节最大的问题不是漏项，是切片归属错配**，下列修正**优先于**本节原文。
>
> ### 修正 1（最重要）：S5 的红只有约 16 例，不是本节的全部
>
> §10 的 S5 门禁写"迁移批见 §9.2"，暗示本节整张表都是 S5 翻转当天的红 —— **错**。本节列出的绝大多数测试**不经过任何真实 adapter**，而是手工构造带 `originalRow` 的 `DisplayCell` 数组直接喂 UI-core。S5 只改 adapter 与 Grid，`originalRow` 字段与网关回映射要到 **S6** 才删，所以这些测试**S5 当天全绿，S6 当天才集体变红**。
>
> | 切片 | 预期红 | 性质 |
> | ---- | ------ | ---- |
> | **S5（adapter 翻转）** | **约 16 例 / 8 文件** | 走真实 adapter 或真实浏览器的 |
> | **S6（删字段+删网关）** | **约 43 例 / 14 文件** | 全部手工 fixture 类 |
> | S4 或 S5（见修正 2） | 6 例 | `buildSortExcludedRows` 换源 |
>
> **S5 当天的 16 例白名单**（唯一允许变红的）：`vnext-worker-filter-sort.test.tsx` 的 `:270/295/327/348/411/453`（6）、`vnext-adapter.test.ts:1149`、`audit-adapter-scaling.test.ts:419`、`vnext-worker-merge-overlay.test.ts:290`、~~`vnext-static-tables.test.ts:760`~~、~~`vnext-table-totals-static-wasm-parity.test.ts`（`:593-605` + `:781-783`）~~、e2e `vnext-filter-sort-real-backend.spec.ts:53`/`:84`（2）、e2e `toolbar-filter-sort.spec.ts:75`/`:126`（2）、e2e `vnext-sort-real-backend.spec.ts:200`。
>
> > **S4 实施后修订**：划掉的两项**已在 S4 迁移完毕**（求值真值源在 S4 就翻了，见 §10 "S4 重定义"），S5 当天它们应当**保持绿**。白名单因此是 **14 例**。若这两个文件在 S5 当天变红，那是 S5 的真回归，不是预期迁移。
>
> **判据：S5 当天任何不在这份白名单里的红都是真回归。** 特别地——手工 fixture 那 43 例若在 S5 当天变红，说明 S5 越界动了网关或字段，违反 §10 切片边界；只种手动隐藏的 Grid 测试（`vnext-grid.test.tsx:676`/`:721`）变红 = 并集派生写错。
>
> 执行姿势：S5 动工前先跑全量存基线，翻转后比对失败清单与白名单，**差集非空即停**。
>
> > **S5 实施后回填（2026-07-21）—— 白名单本身有一处自相矛盾，这是设计稿被查出的第 5 处不符。**
> >
> > **本裁定块的 "14 例白名单" 与它自己的修正 2 不自洽。** 修正 1 的表格把
> > `buildSortExcludedRows` 换源的 6 例单列为一行（"S4 或 S5"），修正 2 随后**定档归 S5**，
> > 但"S5 当天的白名单"那句话只枚举了修正 1 的另外那一行。照字面执行的实施者会看到白名单外的红，
> > 按"差集非空即停"停工并误报回归。**判据应为：白名单 = 修正 1 的 14 例 ∪ 修正 2 的 6 例。**
> >
> > **实测结果（翻转后全量）**：
> >
> > | 来源 | 预期 | 实际变红 | 说明 |
> > | ---- | ---- | -------- | ---- |
> > | 修正 1 白名单（jest） | 9 | **8** | `vnext-worker-filter-sort.test.tsx:327` 未红 —— 见下 |
> > | 修正 1 白名单（e2e） | 5 | **5** | 全中 |
> > | 修正 2 关联集 | 6 | **4** | `physical-sort.test.ts` 的 `:220`/`:259`/`:290` + `vnext-filter-dropdown.test.tsx:595` |
> > | **白名单外** | 0 | **0** | 差集为空，无真回归 |
> >
> > 两条过度预测（均为设计稿失准，非实现问题）：
> >
> > - **修正 5 对 `:327` 的判断方向反了**。它说"仅 `:345` 一行 `originalRow === undefined` 会死"——
> >   那一行断言的是**未激活筛选时不带** `originalRow`，翻转后恒等映射让它更真，只会更绿。该例全程绿。
> > - 修正 2 的 6 例里，`physical-sort.test.ts:322`/`:345` 断言的是 `excludedRows === []`，
> >   换源后依然是 `[]`（前者无隐藏集、后者跨表），所以不红。它们被**改写**（换掉已消失的机制描述）
> >   而非被迫迁移。
> >
> > 反向信号两项均如预期：手工 fixture 那 43 例**全程绿**（ui-core 63 suites / 1567 → 1567，
> > solid 未动网关与字段）；`vnext-grid.test.tsx:676`/`:721` 只种手动隐藏的两例**全程绿**，
> > 并集派生正确。
>
> ### 修正 2：`buildSortExcludedRows` 换源的归属
>
> §7 把它放进 S4 的文件边界，§10 的 S6 行又列了同一项 —— 设计稿自相矛盾。**裁决：它必须与"`viewportFilterHiddenAtom` 真正被填入真实值"落在同一切片**，否则它读一个恒空集合、排序排除行静默失效，那是真回归而非迁移。由 S4 实施者回报事实后定档。
>
> > **已定档（S4 实施者回报，2026-07-21）：归 S5。** 核实结论：S4 **完全不写** `viewportFilterHiddenAtom` —— 它的作用域止于 `excel/solid-excel/src-vnext/adapter/`，集合算完直接推给引擎（worker 走 `setEvalFilterHiddenRows`，static 存进自己的求值输入），**没有任何一条路径回到 UI-core**。回传需要 `SetFilterSortResult.hiddenRowIndices`（在 `excel/spreadsheet-ui-core/src/backend/types.ts`）加上 `filter-sort/index.ts` 的消费逻辑，两者都在 S4 范围外。
> > 全仓复核：`setViewportFilterHiddenRowsAtom` 的写者**只有测试**（`effective-hidden.test.ts` / `go-to.test.ts` / `remove-duplicates.test.ts` / `text-to-columns.test.ts`），生产代码零写者。因此 `buildSortExcludedRows` 换源与那 6 例测试**一律归 S5**，S4 未动 `filter-sort/index.ts`。
>
> 关联 6 例：`physical-sort.test.ts` 的 `:259/290/322/345/373` + `vnext-filter-dropdown.test.tsx:595`。其中 **`physical-sort.test.ts:259` 必须 MIGRATE 不是 DELETE** —— 它断言的并集语义（`excludedRows === [3,5]`）正是要保留的行为，只是改种 `viewportFilterHiddenAtom`；删掉会丢失唯一一条"两集并入 `excludedRows`"的覆盖。`:373` 是无关的 dropdown 路径例，勿按行区间误伤。
>
> ### 修正 3：本节两处事实错误（已有反证）
>
> - **"`mutation-gateway.test.ts` 全部 protection 例不受影响" —— 不成立。** `:230`、`:313`、`:371` 三例都吃 `filteredCells()` 并按**源行 5/3** 解锁与断言；恒等后 display 行 1 → 源行 1（未解锁），结果从 allowed 翻成 blocked。**MIGRATE ×3**（门禁本身保留，fixture 与期望值必须改）。
> - **"DELETE 7" —— 数错了。** 列出的即 9 例（3+2+1+3），加漏项实为 13。漏的是配对的 `:295-311`（`requireIdentityMapping passes through untouched targets`，字段删除后编译不过，DELETE）。
>
> ### 修正 4：§4.3 快照语义的测试影响面缺失
>
> 本节只按"压缩语义"筛测试，漏了"筛选不再实时"这条**独立的**行为变更。至少 `vnext-worker-filter-sort.test.tsx:364-380` 断言的是"编辑单元格后重扫、新行自动进入视图"，它因 §4.3 而非 §5 变红 —— 所以 `:348` 标 MIGRATE 不够，其**后半是 DELETE**。
>
> ### 修正 5：行号与判断的逐条订正
>
> - `remove-duplicates.test.ts` 实为 `:378`/`:406`（各差 1）；`text-to-columns.test.ts` 实为 `:953-964`，且**漏 `:702` fixture**；`go-to.test.ts` test 实在 `:1357`；`audit-adapter-scaling.test.ts` 注释实在 `:437-438`/`:471-476`。
> - `physical-sort.test.ts:258-390` 区间内实含 **5** 个 test 不是 4。
> - `vnext-worker-filter-sort.test.tsx:327` 标 MIGRATE 偏重，实为 **assertion-only**（仅 `:345` 一行 `originalRow === undefined` 会死）；`:411` 建议改 **MIGRATE 不是 DELETE**（"筛选态下编辑写到正确引擎地址"是独立于映射机制的有价值端到端钉）。
> - `vnext-table-totals-static-wasm-parity.test.ts` 区间不全：真正要翻的断言在 **`:781-783`**（`SUBTOTAL(9,…)` 与 `(109,…)` 同为 400），那是 §9.1-5 "1-11 在筛选下变小"的**唯一断言站点**。
> - 漏项（S6 编译期）：`vnext-adapter.test.ts:1082`/`:1113` 两处 `originalRow).toBeUndefined()`。
>
> ### 修正 6：`audit-structural.spec.ts:153` 不该挂在 S5 门禁上
>
> 本设计把它列为"复活并按隐藏语义启用"，但其 `:154-157` 的 skip 理由是"Wave5 移除 menubar 后没有筛选触发器"，**与语义无关**；且现有断言在两种语义下都成立。复活需先在 demo 接一个 header 漏斗图标 —— 独立工作项，从 S5 门禁移除。
>
> ### 修正 7：e2e 迁移的一条硬事实
>
> 隐藏行是**卸载**不是渲空（证据：`vnext-hidden-rows-real-backend.spec.ts:58` 的 `toHaveCount(0)`）。所以 e2e 里所有 `toHaveText('')` 断言会以"定位到 0 个元素"失败而非值不对，迁移时必须改成 `toHaveCount(0)`。
>
> ### 修正 8：覆盖缺口（不是 S5 的红，是 S5 的盲区，须补）
>
> - **static 侧 filter×merge 全仓无任何测试**，§9.3 的解禁将无声发生（worker 侧只有 `vnext-worker-merge-overlay.test.ts:290`）。S5 必须补一例。
> - `vnext-adapter.test.ts:1117` 的 static 筛选例因 North 恰在源行 1 = display 行 1 而两语义同结果，属**侥幸绿**。static 投影恒等化几乎没有单测保护，须补一个源行错位用例。
>
> ### 另：§7 的文件规划已被 S3 超越
>
> §7 写的 `filter-sort/filter-hidden.ts` + `filterHiddenAtom` **不存在**。实际落于 `viewport/effective-hidden.ts`，原子名 `viewportFilterHiddenAtom` / `effectiveHiddenAtom`（§3 末段的 `effectiveHiddenRowsAtom` 亦是旧名）。按 §7 找文件会扑空 —— 以代码为准。

**第一梯队（整块以压缩语义为主题）**：

| 文件                                                        | 用例                                                                                                                                | 动作                                                                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `excel/spreadsheet-ui-core/test/mutation-gateway.test.ts` | `:117/134/154`（映射 / run 裂分 / 合并）、`:178-215`（`unmapped-row` 两例）、`:277-292`（`requireIdentityMapping`）、`:351/406/463` | **DELETE 7**；`:74/90` 恒等与全部 protection 例 **不受影响**                                                                     |
| `excel/solid-excel/test/vnext-mutation-gateway.test.tsx`          | `:151/182/224/250/305`（Delete / 单格 Delete / 编辑提交 / 粘贴 / 填充的"写映射源行"）                                               | **DELETE 5**；`:202/275/352` protection 例 **仅改 fixture**                                                                      |
| `excel/solid-excel/test/vnext-worker-filter-sort.test.tsx`        | `:270`（`originalRow===3`）、`:295`、`:327`、`:348`（排列缓存）、`:453`（`A3='Alpha'`/`A4=''`）                                     | **MIGRATE 5**；`:411`（网关写源行）**DELETE**。文件头注释 `:4-17` 逐字钉了压缩语义，需重写                                       |
| `excel/spreadsheet-ui-core/test/physical-sort.test.ts`    | `:258-390` 的 `runPhysicalSortAtom — filter-hidden excluded rows` 四例（并集 / 观察 span 内推断 / 无投影不推 / 跨表投影忽略）       | **DELETE 4**（缺口反推机制消失）；`:220` **MIGRATE**（排除集来源改为隐藏集）；`:393-428` 手动隐藏例与全部生命周期例 **不受影响** |

**第二梯队（健康文件内的单例）**：`filter-sort.test.ts:846-862`（2 例，DELETE）；`remove-duplicates.test.ts:377/405` 与 `:668-697` 内一个 `test.each` 分支（DELETE 3）；`text-to-columns.test.ts:951-963`（DELETE）；`go-to.test.ts:1352-1364`（DELETE）；`vnext-adapter.test.ts:1149-1222`（MIGRATE）；`audit-adapter-scaling.test.ts:419-500`（MIGRATE，注释 `:436/458/477-478` 逐字写着压缩）；`vnext-toolbar.test.tsx:517/558`（DELETE 2）、`:601`（fixture）；`vnext-grid.test.tsx:2805+`（DELETE）；`vnext-format-cells.test.tsx:715+`（DELETE 2）；`vnext-context-menu.test.tsx:838-890`（DELETE）；`vnext-paste-special.test.tsx:372-416`（DELETE）；`vnext-format-painter.test.tsx:328-383`（DELETE）；`vnext-filter-dropdown.test.tsx:595-641`（MIGRATE，改为读隐藏集）；`vnext-worker-merge-overlay.test.ts:~290-330`（MIGRATE，且随 §9.3 的 merge 解禁一并加强）。

**需要主动翻转的一条现状 pin**：`excel/solid-excel/test/vnext-static-tables.test.ts:760+` 的 `does not treat filter-hidden rows as an evaluation truth source` —— 它钉的正是"筛选隐藏不进求值真值源"这条本设计要推翻的裁决，必须显式改写而非顺手删。同理 `vnext-table-totals-static-wasm-parity.test.ts:548-608` 的 `filterHidden` parity 相位。

> **已在 S4 完成**（原计划归 S5，因为求值真值源在 S4 就翻了）：前者改写为
> `excludes filter-hidden rows from BOTH SUBTOTAL bands`（并新增一例两层规则），后者的
> `filterHidden` 相位由 `400/400` 改为 `120/120`，并新增 `filterPlusManualHidden` 相位
> （9 = 120、109 = 0）——那是两层规则的端到端佐证，且由 static⇄WASM 逐步 diff 保证两个引擎
> 逐字一致。**这个 parity 脚本是本切片最强的验证手段**：它证明新写的 TS 求值器分支与 Rust 引擎
> 在整个隐藏矩阵上完全同答。

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
| **手动隐藏行在筛选后错位到另一行**（主控 smoke 2026-07-21 实测发现，详见下方）                | 恒等映射后 display 序 ≡ 源序，两个坐标系不可能再分叉，**结构性消失**  |

> #### 实测发现的缺陷：手动隐藏行会因筛选而"跳到"另一行
>
> **发现方式**：S4 落地后的手工 UI smoke（vNext Worker 真实 WASM 后端）。**没有任何单测或 e2e 覆盖到它** —— 这是手工 smoke 相对自动化测试的增量价值的一个实例。
>
> **确定性复现步骤**（从空白 Sheet1 起）：
>
> 1. `E1='Val'`、`E2..E5 = 10/20/30/40`；`G1==SUBTOTAL(9,E2:E5)`、`H1==SUBTOTAL(109,E2:E5)`、`I1==SUM(E2:E5)` → 三者均 100。
> 2. 行头右键**源行 3**（值 20）→ 隐藏行。此时**完全正确**：行号 1,2,4,5（跳号），可见 10/30/40，`G1=100`（1-11 含手动隐藏）、`H1=80`（101-111 排除）、`I1=100`。
> 3. 选 `E1:E5` → 筛选 → 取消勾选值 `10` → 确定。
>
> **观察到**：可见值变为 **20 和 40**。手动隐藏的那行（20）**重新出现**，而从未被隐藏过的行（30）**消失了**。同时 `G1=90`、`H1=70`。
>
> **诊断**（现象 + 代码双向确认）：`G1=90=20+30+40`（只排筛选行）与 `H1=70=30+40`（排筛选行 + 源行 3）说明**引擎始终认定手动隐藏 = 源行 3，是对的**；错的是视图。更进一步，`H1=70` 与屏幕上可见值之和（20+40=60）**自相矛盾** —— 一个号称"只统计可见行"的函数给出了屏幕上不存在的数。
>
> **根因**：手动隐藏集存的是**一个不带坐标系标签的裸行号**（`menu/index.ts:431` 的 `createSelectedAxisIndices(selectionStart, selectionEnd)` 取自选区坐标）。记录当刻无筛选，display 序 == 源序 == 3，**两侧一致**；筛选压缩后，同一个 `3` 在 Grid 眼里是 display 行 3（= 源行 4），在引擎眼里仍是源行 3。**不是写入时就分叉，而是同一个数字在两个坐标系里的含义事后被压缩悄悄改写了**，且没有任何一侧知情。
>
> **为什么 S5 结构性地消灭它**：恒等映射后 display 序 ≡ 源序**恒成立**，裸行号不再有二义性。这不是"修一个 bug"，而是让这类 bug 无法被表达 —— 与 §5 删除 `originalRow` 的动机同源。
>
> **S5 验收条件（必须新增）**：上述三步复现必须得到"可见值 = 30 和 40（20 因手动隐藏缺席、10 因筛选缺席），行号 1、4、5 跳号，`G1=90`、`H1=70`、`I1=100`"，且 `H1` 必须等于屏幕可见值之和。建议同时补一条 e2e 钉死"手动隐藏行不因筛选变更而改变所指"。
>
> > **已落地（S5 实施者，2026-07-21）**：两条都补了，验收数字逐字命中。
> >
> > - `vnext-worker-filter-subtotal-wasm.test.ts` 新增
> >   `a manual hide keeps pointing at the same row when a filter is applied`：真 Rust 引擎 + 真
> >   `worker-runtime.ts`，按 §9.3 三步逐字复现（E 列 10/20/30/40，手动隐藏源行 2，筛选 `>=20`）。
> >   断言 `G1=90`、`H1=70`、`I1=100`，投影里源行 1 缺席、幸存行仍在 `row 3`/`row 4`（值 30、40），
> >   并把"自相矛盾"本身写成恒等式断言：`SUBTOTAL(109) === 屏幕可见值之和 === 70`。
> >   **差分性**：压缩语义下同一断言会读到 20 和 40（display 行 1、3）、可见和 60 ≠ 70，必红。
> > - e2e `vnext-filter-sort-real-backend.spec.ts` 新增
> >   `a manually hidden row does not change what it refers to when a filter changes`：
> >   行头右键隐藏源行 2 → 加筛选 → 清筛选，钉死手动隐藏行全程不动、且**清筛选不解手动隐藏**
> >   （§3 约束 3 的端到端佐证）。wasm / ts 两个 project 均绿。

---

## 10｜分切片实施计划

每切片独立可合、门禁自含。**S1–S3 零 UI 可见变化。**

| 切片                      | 目标                                                                                                                                                                                                             | 文件边界                                                                                                                                            | 门禁                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **S1 引擎双来源**         | `eval_filter_hidden_rows` 存储 + `set_eval_filter_hidden_rows` + provider 方法 + `fn_subtotal` 双层规则 + 双 epoch 拆分（§6.2-6.4）                                                                              | 仅 `excel/rust/excel-core/src/`（`sheet.rs`/`workbook.rs`/`eval.rs`）                                                                                     | `cargo test -p einfach-excel-core`（§11.1 Rust 矩阵）；不触 wasm/TS                                         |
| **S2 桥与协议**           | wasm 导出 + 快照重生成；协议 capability 与 client 方法；WASM runtime case；TS runtime `false` + `unsupported`                                                                                                    | `excel/rust/wasm/src/lib.rs`；`excel/rust/excel-core/tests/fixtures/wasm_api_signatures.txt`；`worker-protocol.ts`、`worker-runtime.ts`、`worker-runtime-ts.ts` | `npm run build:wasm`；`cargo test --test architecture_invariants`（INV-4 绿）；runtime 单测含 `UNSUPPORTED` |
| **S3 消费者加固（前置）** | **在压缩语义下就正确的防御性改动**：`remove-duplicates` / `text-to-columns` 稠密扫描跳过隐藏行（§8.1）、`go-to` 上下文接并集、并集派生 helper 落地                                                               | `excel/spreadsheet-ui-core/src/remove-duplicates/`、`text-to-columns/`、`go-to/`、`viewport/`                                                     | `npx jest excel/spreadsheet-ui-core --no-coverage`；**行为零变化**，既有断言全绿不改                      |
| **S4 adapter 算集合并推给引擎**（已落地，见下方"S4 重定义"） | 协议 capability `evalFilterHiddenRows` + client 可选方法；WASM runtime dispatch（缺方法回 `UNSUPPORTED`）；TS runtime `false` + `unsupported`；两个 adapter 在 `setFilterSort` 里由**同一次谓词扫描**取补集得筛选隐藏行集，worker 推 `setEvalFilterHiddenRows`、static 存进自己的求值输入。**投影压缩不动**（那是 S5） | `excel/solid-excel/src-vnext/adapter/filter-hidden-rows.ts`（新）、`worker-workbook-backend.ts`、`static-backend.ts`、`static-formula-eval.ts`、`worker-protocol.ts`、`worker-runtime.ts`、`worker-runtime-ts.ts` | `npx jest excel/solid-excel --no-coverage`；`npm run build:wasm`；定向 e2e。**注意：这是唯一一个有真实行为变化的前置切片** |
| **S5 adapter 原子翻转**（已落地，见下方"S5 落地记录"） | **一次性切换**：两 adapter 投影塌回恒等、停发 `originalRow`、`setFilterSort` 回传隐藏集（`SetFilterSortResult.hiddenRowIndices`）、UI-core 写入 `viewportFilterHiddenAtom`、`buildSortExcludedRows` 改读两集、Grid 取并集、解除 merge 抑制。~~bridge 双路~~（不做，理由见落地记录）                                              | `static-backend.ts`、`worker-workbook-backend.ts`、`projection-helpers.ts`、`eval-hidden-rows-bridge.ts`、`SpreadsheetGrid.tsx`                     | `npx jest excel/solid-excel --no-coverage` + ui-core：**只允许 §9.2 主控裁定三的 16 例白名单变红，差集非空即停**（§9.2 原表约 43 例属 S6，S5 当天必须全绿）；playwright MCP 手工 smoke（行号跳号） |
| **S6 死代码清除**（已落地 `50a14e1`） | W2 网关回映射半边、`DisplayCell.originalRow` 字段、~~`deriveFilterHiddenRows`~~（**S5 就删了，见勘误 E5**）、~~`buildSortExcludedRows` 改读两集~~（**同属 S5**）、`requireIdentityMapping` 及其两调用点、`unmapped-row` 全族、`AllowedContentMutation.remapped`。**实际另含**：`SpreadsheetGrid.tsx` 填充柄与 `SpreadsheetContextMenu.tsx` 粘贴路径的两处死分支（读 `remapped`，逐文件表遗漏，见勘误 E2）。**有意不做**：把 `ranges` 塌成单段（§5 派了、§10 没派；改 7 个读点零行为收益） | `editing/mutation-gateway.ts`、`backend/types.ts`、`filter-sort/index.ts`、`go-to/`、`remove-duplicates/`、`text-to-columns/`、`paste-special/`、`grid/`、`context-menu/`     | 双包 jest 全绿（ui-core 63/1583、solid 97/1455+6 skipped）；`grep -r originalRow` 在 `src/` 与 `test/` 零命中（`@types/` 下的过期构建产物不计）                                                      |
| **S7 可见性语义收口**（已落地）     | ~~复制只取可见（§8.2）；删除行只删可见（§8.3，先实测 Excel）~~ **已作为前置加固提前落地**（恒等，S5 后生效；§8.3 查证已定稿）。`exportRangeTsv` 分块复制与 `exportRangeAsImage` 两条 adapter 自产内容路径的端口扩参、粘贴/填充明确不改并加 pin，随 `0f9a150`。**`Data → Reapply` 入口 + `Ctrl+Alt+L` 随 S9 补齐**（勘误 E8）                                                                                      | `clipboard/`、`copy-as/`、`operations/`、`menu-bar/`、`keyboard/`、`SpreadsheetMenuBar.tsx`、`SpreadsheetGrid.tsx`                                                             | 双包 jest + 定向 e2e；playwright MCP smoke（筛选→复制→粘贴→Reapply）                                        |
| **S8 文档收口**（已落地）  | `docs/filter-sort.md` **整篇重写**；`filter-sort/README.md`（`buildSortExcludedRows` 的"从投影反推"口径已换源）、`viewport/README.md`（去掉"S3 恒空集、S4 填值"的过期段）、`operations/README.md`（去掉"今天恒等"）、`editing/README.md`（补写"粘贴/填充照写被筛行"的 Excel parity 叙述）、`remove-duplicates/README.md`（补前置约束理由与结构位移）；`CANONICAL_OWNERSHIP.md` #29 行 + §4-4 + §6 判据 + **§7-1"手动/filter 同一集合"勘误**；`CUTOVER_INVENTORY.md` 记账行 + 段落；`06-tables-data-management.md` §3.1-6/7 与 §11 的过期机制描述；**本文 §0.0 勘误索引** | 纯文档（唯一例外：`backend/projection-helpers.ts` 上 `buildFilterSortDisplayRows` 的一段过期**注释**——原文称投影在此压缩被筛行，与 #27 后的代码直接矛盾） | 互链一致性人工核对；每个 API 名 / 路径 / 原子名回代码核实                                                    |

**依赖顺序**：S1 → S2 → S4 → S5；S3 → S5；S5 → S6 → S7 → S8。

- **S3 必须早于 S5**：否则 adapter 翻转当天 `remove-duplicates` 就会静默删数据（§8.1）。这是本计划唯一的硬序约束。
- S5 是**原子切换**，不允许"压缩与隐藏双语义共存期"——与 CANONICAL 的翻转约束一致。
- S6 可与 S7 并行；S8 收尾。

> **S5 落地记录（2026-07-21，实施后写回）**：原子翻转已落地，门禁数字见下。两点必须记账的偏离：
>
> 1. **`eval-hidden-rows-bridge.ts` 的"双路"没有做，是有意的。** §6.5 与 S5 派单都要求 bridge 扩为
>    双路推送，但 S4 已经把筛选集的推送放在**两个 adapter 的 `setFilterSort` 内部**（worker 走
>    `setEvalFilterHiddenRows` 并在 ACK **之前** await，static 直接存进自己的求值输入）。此时给
>    bridge 再加一条筛选路会产生**第二个写者**：同一事实推两遍，且 bridge 是在 ACK **之后**才由
>    原子变更触发，比 adapter 内推送晚一拍，投影刷新的时序保证反而变弱。核实过没有覆盖缺口——
>    `viewportFilterHiddenAtom` 的唯一生产写者就是 `setFilterSort` 的 ACK，筛选不进 history
>    （§3 约束 3，无独立 undo 条目），切表按 sheet 隔离且引擎侧集合按 sheet index 常驻，
>    **不存在"原子变了但没走 setFilterSort"的路径**。因此 §6.5 的 bridge 行与 §10 的 S5 行
>    在此项上作废，以代码为准；真要迁到 bridge，须先加 `SpreadsheetBackend.setEvalFilterHiddenRows`
>    端口并**同时**撤掉两个 adapter 的内部推送，那是独立工作项。
> 2. **筛选隐藏集不随 `structuralShift` 平移（已知缺口，未做）。** §3 要求筛选集复用
>    `remapIndexSetAfterStructuralShift`，但 §10 没把它派进任何切片，S5 派单的 6 项也不含它。
>    翻转前投影每次 revision bump 重算，插入/删除行会自我纠正；翻转后集合是快照（§4.3），
>    于是**筛选激活期间插入或删除行会让隐藏集错位一行**。这是本切片引入的真实缺口，
>    不是既有问题，建议在 S6/S7 补：`viewport/effective-hidden.ts` 加
>    `applyViewportFilterHiddenStructuralShiftAtom`，在 `operations/index.ts:989` 与
>    `remove-duplicates/index.ts:1254` 两个既有 `applyViewportHiddenStructuralShiftAtom`
>    调用点旁并列一行即可，两个 adapter 的本地快照同样要跟随。
>
> 另记一条实现事实（设计稿只在 §5 的状态栏行与 §8.1 的危害描述里隐含说明，没有正面写）：
> **两个 adapter 的投影都主动"扣掉"筛选隐藏行，不产它们的 cell**（含 format-only 空白格）。
> 手动隐藏行则照常进投影（后端不知道它存在）。这个不对称是刻意的，也是 S3 那道加固所设防的
> 前提、以及"状态栏聚合免费只统计可见格"这条结论成立的机制。

> **S4 重定义（2026-07-21，主控派单，实施后写回）**：初稿的 S4 是"UI-core 筛选隐藏集"
> （`filterHiddenAtom` + `SetFilterSortResult.hiddenRowIndices` + `reapplyFilterAtom`）。
> 实际派下来并已落地的 S4 是**另一件事**：adapter 侧算出集合、直接推给引擎。两点记账：
>
> 1. **UI-core 的那半边已经不在 S4 了**。S3（`7c13fd4`）落地时把筛选集提前建在了
>    `excel/spreadsheet-ui-core/src/viewport/effective-hidden.ts` 里，原子实名
>    `viewportFilterHiddenAtom` / `effectiveHiddenAtom`（**不是** §7 写的
>    `filter-sort/filter-hidden.ts` / `filterHiddenAtom` / `effectiveHiddenRowsAtom`，
>    §3 与 §7 的这几个名字全部作废，以代码为准）。该原子目前**只有测试写入**，生产侧无写者，
>    接线（ACK 回传 → 写原子 → `buildSortExcludedRows` 换源 → `reapplyFilterAtom`）整体归 **S5**。
>    **`buildSortExcludedRows` 换源必须与"原子真正被填值"同切片**，否则它会读一个恒空集合、
>    排序排除行静默失效；§7 把它列进 S4、§10 又列进 S6，两处都不对。
> 2. **§10 原 S2 的 TS 那半边也没在 S2 落地**。`79d7efb`（标 S1+S2）只动了 `rust/`，
>    协议 capability、两个 runtime 的 dispatch 是随 S4 一起落的。
>
> **S4 是唯一一个有真实用户可见行为变化的前置切片**（S1–S3 都是零变化）：落地当天筛选激活时
> `SUBTOTAL(1-11)` 与 `(101-111)` 开始排除被筛掉的行，即 §9.1 第 5 条的 bug 修复提前到此。
>
> **已知的过渡期不一致（S4 独有，S5 关闭）**：引擎侧的筛选集是**快照**（`setFilterSort` 时算一次），
> 而投影压缩此刻仍然是**实时**的（每次 revision bump 后重算）。所以在筛选激活期间编辑单元格值，
> 可能出现"某行已经从视图里消失/出现，但 SUBTOTAL 还按旧集合算"。这不是新增发散：Excel 本身就是
> 快照语义（§4.3），S5 让投影也变成快照后两边自动对齐。过渡期内 SUBTOTAL 偏保守，不产生错误数字。

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

`cargo test -p einfach-excel-core` + `cargo test --test architecture_invariants`；`npm run build:wasm` 后 `npx jest excel/spreadsheet-ui-core --no-coverage`、`npx jest excel/solid-excel --no-coverage`；定向 e2e spec；每个 UI 可见切片（S5、S7）后 playwright MCP 手工 smoke。

---

## 12｜Conformance notes 与未决项

**有意发散（记录在案，不阻塞）**：

1. 可见行号不染蓝（Excel 的视觉线索）——纯样式，列为可选尾项。
2. `Go To Special → Visible cells only` 作为**显式**选择路径不实现；复制的可见性过滤是隐式的（§8.2）。
3. 筛选下拉的候选值列表是否应排除本列自身规则的影响（Excel 语义），本次不动。
4. `hidden_epoch` 的跨 sheet 过失效（`sheet.rs:947-955` 在案）不顺带优化。

**未决 / 待验证**：

1. ~~⚠️ 删除行在筛选区的确切 Excel 行为（§8.3）~~ —— **2026-07-21 已查证定稿**，暂定裁决维持，出处与三条证据缺口见 §8.3。残留未证实项仅剩"选区完全落在隐藏行内"，已按保守默认（零下发）实现并明确标注。
2. ⚠️ 格式化筛选区是否只作用可见单元格（§2）——实测后决定是否进 §8。
3. ⚠️ `AGGREGATE` 的 ignore-hidden 语义与本次双集合的关系——**列为后续**，`eval.rs:20029-20035` 的 TODO(#32 §6.3) 保持，seam 已由 S1 建好。
4. ~~`excel/spreadsheet-ui-core/docs/filter-sort.md` 全文是 `directives` 时代的陈旧口径（"backend 拥有行序"、`originalRow` 契约、`SortDirective` 类型），S8 整篇重写。~~ **已完成（S8，2026-07-21）**：该文现为筛选的**现行契约规范源**，本设计稿降级为历史记录。
5. 筛选隐藏集是否需要持久化进工作簿文件格式（Excel 的 autoFilter 会存）——超出本次范围。
6. ~~**⚠️ `Data → Reapply` 入口未落地（S8 查出，勘误 E8）。**~~ **已闭合（S9，2026-07-21）**：
   `reapplyFilterAtom` + `reapplyFilterDisabledReasonAtom` + `data.reapply` 菜单项 + `Ctrl+Alt+L`
   四个部件全部落地，两处有意偏离设计稿（禁用而非隐藏；只重做筛选不重做排序），理由记在勘误 E8 与 §4.3。
   **仍未证实**：Reapply 是否应进 undo 栈 —— 微软文档两侧都不表态，现取"与 Apply 一致 = 不进栈"作为
   **未证实的默认选择**，不是已验证行为。
7. **E2 暴露的方法论问题**：逐文件影响面表用"搜字段名"判定改动面，会漏掉**一跳之外**读派生量的
   消费者（本次是 `remapped`）。将来做同类删除时，判据应是"从字段出发做一次可达性分析"，
   而不是 `grep` 字段名。
