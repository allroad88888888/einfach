# 增量实现步骤

每步原则：最小功能 + 单测验证 + 不偏离主流程

> **review 已完成**：见 [ISSUES.md](./ISSUES.md)。所有标 ✅ 的步骤都有已知问题，详见对应 issue 编号。

---

## Phase 1: Core Engine ✅

- [x] Step 1: AtomId + Value 类型
- [x] Step 2: Store + 原始 atom 读写
- [x] Step 3: 派生 atom + 依赖追踪
- [x] Step 4: 变更传播（拓扑排序）
- [x] Step 5: 订阅通知
- [x] Step 6: 环检测 + 动态依赖

**状态：30 tests passing (einfach-core)**
**已知问题**：A.1（panic 信息）、A.2（unsafe raw pointer）、A.5（无写循环检测）、A.7（拓扑 LIFO）、A.9（自循环测试 hacky）

---

## Phase 2: Core 补充功能 ✅

- [x] Step 7: Value 扩展 — Boolean + Null + Error 类型
- [x] Step 8: 批量更新 — batch(fn) 多次 set 合并一次传播
- [x] Step 9: 写 atom — create_writable(read_fn, write_fn)

**状态：49 tests passing (einfach-core)**
**已知问题**：A.3（NaN 位级比较）、A.4（无 atom GC）、A.6（batch panic 时 depth 不归零）、A.8（unsub O(N×M)）、A.10（store.rs 单文件 960 行）、A.11（recompute panic 时 thread_local 不清理）

---

## Phase 3: Excel Core ✅

- [x] Step 10: CellAddress 解析 — "A1" → (row=0, col=0)
- [x] Step 11: Sheet 基础 — set_cell / get_cell
- [x] Step 12: 公式解析器 — "=A1+B1" → AST（递归下降解析器）
- [x] Step 13: 公式求值 + Sheet 集成 — AST → 派生 atom → 自动传播
- [x] Step 14: 范围支持 — "A1:B3" → 多单元格引用
- [x] Step 15: 内置函数 — SUM, AVERAGE, COUNT, IF, MIN, MAX

**状态：66 tests passing (einfach-excel-core) + 5 review_repro 测试（4 ignore + 1 文档化 buggy 行为）**
**已知问题**：B.1（cell_map 快照，已验证 bug）、B.2（自引用绕过环检测，已验证）、B.3（parse 失败 panic）、B.4（旧 derived 不释放）、B.5/B.6（SUM/MIN/MAX 跟 Excel 不一致）、B.8（thunk 多包一层）、B.9（parse error 信息丢失）、B.12（batch_set 不清公式，已验证 bug）

---

## Phase 4: WASM 绑定 ✅

- [x] Step 16: wasm-bindgen 基础绑定（cdylib + rlib）
- [x] Step 17: JS 可调用的 Sheet API（WasmSheet: set_number/text/formula, get_display/number/type, subscribe, batch_set_numbers）

**状态：10 tests passing (einfach-wasm), cargo build --target wasm32 通过**
**已知问题**：C.1（subscribe 是空函数）、C.2（不传播下游）、C.3（重入借用 panic）、C.4（无 unsubscribe）、C.5（get 都是 &mut self）、C.7（batch_set 只支持 number）、C.8（无 wasm32 集成测试）、C.10（无 panic hook）、C.11（Sheet.store 私有，1A 须先暴露 subscribe_cell API）

---

## Phase 5: SolidJS 视图 ✅

- [x] Step 18: Table 组件（列头A-J, 行号1-20, 固定grid）
- [x] Step 19: Cell 组件（双击编辑, 回车确认, ESC取消, 公式/数字/文字自动识别）
- [x] Step 20: 虚拟滚动（延后，MVP 不需要）

**组件：** Table, Cell, createSheetStore, createJSSheet (纯JS后端), ISheet 接口
**构建：** Vite + vite-plugin-solid, 产物 14.6 KB gzip 5.9 KB
**已知问题**：D.1（JS 后端跟 Rust 不等价，**默认 demo 首屏即坏**）、D.2（Function() 注入风险）、D.3（refresh 全表重读）、D.4（cell 数据副本在 signal）、D.5（signal map 不清理）、D.6（raw 暴露内部）、D.7（无 batch）、D.8（focus setTimeout）、D.9（cellValue 重复调用）、D.11（双击编辑公式格丢公式 / ISheet 缺 get_formula）
