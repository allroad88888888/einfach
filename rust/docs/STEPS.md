# 增量实现步骤

每步原则：最小功能 + 单测验证 + 不偏离主流程

---

## Phase 1: Core Engine ✅

- [x] Step 1: AtomId + Value 类型
- [x] Step 2: Store + 原始 atom 读写
- [x] Step 3: 派生 atom + 依赖追踪
- [x] Step 4: 变更传播（拓扑排序）
- [x] Step 5: 订阅通知
- [x] Step 6: 环检测 + 动态依赖

**状态：30 tests passing (einfach-core)**

---

## Phase 2: Core 补充功能 ✅

- [x] Step 7: Value 扩展 — Boolean + Null + Error 类型
- [x] Step 8: 批量更新 — batch(fn) 多次 set 合并一次传播
- [x] Step 9: 写 atom — create_writable(read_fn, write_fn)

**状态：49 tests passing (einfach-core)**

---

## Phase 3: Excel Core ✅

- [x] Step 10: CellAddress 解析 — "A1" → (row=0, col=0)
- [x] Step 11: Sheet 基础 — set_cell / get_cell
- [x] Step 12: 公式解析器 — "=A1+B1" → AST（递归下降解析器）
- [x] Step 13: 公式求值 + Sheet 集成 — AST → 派生 atom → 自动传播
- [x] Step 14: 范围支持 — "A1:B3" → 多单元格引用
- [x] Step 15: 内置函数 — SUM, AVERAGE, COUNT, IF, MIN, MAX

**状态：66 tests passing (einfach-excel-core)**

---

## Phase 4: WASM 绑定 ✅

- [x] Step 16: wasm-bindgen 基础绑定（cdylib + rlib）
- [x] Step 17: JS 可调用的 Sheet API（WasmSheet: set_number/text/formula, get_display/number/type, subscribe, batch_set_numbers）

**状态：10 tests passing (einfach-wasm), cargo build --target wasm32 通过**

---

## Phase 5: SolidJS 视图

- [ ] Step 18: 表格组件骨架
- [ ] Step 19: 单元格编辑 + 公式输入
- [ ] Step 20: 虚拟滚动（大表格性能）
