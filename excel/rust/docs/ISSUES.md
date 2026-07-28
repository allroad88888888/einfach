# Review Issues

> Review on branch `claude/rust-core-state-plan-Auzcj` against `main`.
> 严重度：**必修** = 正确性 / 安全 / 数据丢失风险；**中** = 路线图后期会撞墙；**轻** = 风格 / 可维护性。

---

## 状态总览（截至本分支 HEAD）

✅ = 已修；⚠️ = 部分修 / 后端齐全 / UI 待接；□ = 未修。

### A. Rust core
| ID | 状态 | 修复点 |
|---|---|---|
| A.1 | ✅ | 1A step 1 (2b49660) |
| A.2 | ✅ | 1A step 2 (59992b6) — Rc<RefCell<HashMap>> 替换 unsafe |
| A.3 | ✅ | E 段 (db6d039) — NaN 兜底 |
| A.4 | ✅ | 1A step 3 (c19133e) — destroy_atom |
| A.5 | ✅ | 1A step 1 — SETTING thread_local |
| A.6 | ✅ | 1A step 1 — BatchGuard RAII |
| A.7 | ✅ | E 段 (db6d039) — VecDeque FIFO |
| A.8 | ✅ | 7A (f929dca) — sub_index 反查 |
| A.9 | □ | 自循环测试 hacky，未改 |
| A.10 | □ | store.rs 1100+ 行单文件，未拆 |
| A.11 | ✅ | 1A step 1 — RecomputeGuard RAII |

### B. Excel core
| ID | 状态 | 修复点 |
|---|---|---|
| B.1 | ✅ | 1A step 4 (438d17c) — Rc<RefCell<HashMap>> + propagate_force |
| B.2 | ✅ | 1A step 4 — would_create_cycle 静态环检测 |
| B.3 | ✅ | 1A step 1 — set_formula 返回 bool / 写 #VALUE! |
| B.4 | ✅ | 1A step 6 (19dffd6) — destroy 旧 derived |
| B.5 | □ | SUM/COUNT/AVERAGE 字面量 vs cell 引用区分，未做 |
| B.6 | ⚠️ | E 段 — MIN 改返 #VALUE!；MAX 仍返 0 |
| B.7 | □ | AVERAGE 错误码（acceptable）|
| B.8 | ✅ | E 段 — thunk 删除 |
| B.9 | □ | parse error 信息丢失；ParseError struct 未实现 |
| B.10 | □ | AST 缓存 / 常量折叠（性能优化）|
| B.11 | ✅ | Range 孤立返回 #VALUE!（跟 Excel 一致）|
| B.12 | ✅ | 1A step 5 (9380b27) — batch_set 清公式 |

### C. WASM 桥接
| ID | 状态 | 修复点 |
|---|---|---|
| C.1 | ✅ | 1A step 8 (f66ef57) — JsCallbackListener |
| C.2 | ✅ | 1A step 8 — store propagate 自动通知 |
| C.3 | ⚠️ | 1A step 8 — 同步 fire；JS 用 queueMicrotask 防重入（文档化）|
| C.4 | ✅ | 1A step 8 — token 化 unsubscribe |
| C.5 | □ | get 都是 &mut self；peek_value 已加但 wasm 层未拆 |
| C.6 | ✅ | C.1+C.2 间接修 — 走 store 自然检查值变化 |
| C.7 | □ | batch_set 只支持 number；text/formula 版本未做 |
| C.8 | □ | wasm-bindgen-test 未集成 |
| C.9 | □ | value_to_display 阈值，未改 |
| C.10 | ✅ | 1A step 1 — console_error_panic_hook |
| C.11 | ✅ | 1A step 7 (44e03be) — CellListener trait + Sheet::subscribe_cell |

### D. Solid Excel
| ID | 状态 | 修复点 |
|---|---|---|
| D.1 | ⚠️ | createJSSheet 仍跟 Rust 不等价；wasm 加载（A.7）才能彻底解决，playwright 实测仍 #ERROR! |
| D.2 | □ | createJSSheet 用 Function() — 短期保留 |
| D.3 | ✅ | 1A step 10 (e1fbe0d) — 精准订阅取代 refreshAll |
| D.4 | ✅ | 1A step 10 — signal 不再存 cell 数据副本 |
| D.5 | ⚠️ | dispose() 已加，组件 unmount 自动调没接 |
| D.6 | ⚠️ | raw @deprecated；保留兼容旧测试 |
| D.7 | □ | setTimeout focus，未改 |
| D.8 | □ | cellValue() 重复调用，未 createMemo |
| D.9 | □ | 同 D.8 |
| D.10 | □ | demo 函数体长串初始化 |
| D.11 | ✅ | 1A step 9+10 (92956f0+e1fbe0d) — get_formula 全链路 |
| D.12 | ✅ | B.1 收尾 (421606b) — tsconfig 治理后 pragma 删除 |

### E. ROADMAP / 工程
| ID | 状态 | 备注 |
|---|---|---|
| E.1 | ✅ | def07a9 — review 落地路线图前置依赖 |
| E.2 | ✅ | def07a9 — 一/七期已拆 1A/1B/7A/7B/7C |
| E.3 | ✅ | def07a9 — 测试 / 错误模型 / API 稳定性都加进 ROADMAP |
| E.4 | ✅ | 1A step 7 — CellListener trait 兼容 worker adapter |
| E.5 | ✅ | 路线图六期前置加了 C.1+C.2+D.3 |
| E.6 | ✅ | 路线图按期独立可发布的细化已落 |

### 新增（review 之外完成的功能）
- ✅ 跨 sheet 引用 parser (`Name!A1`) — c4057ce
- ✅ Workbook 跨 sheet eval (`WorkbookEvalProvider` + lazy read-time recursion；跨 sheet 订阅仍 deferred) — 99f8528 + lazy formula follow-up
- ✅ TODAY / NOW (chrono wasmbind) — f92f142
- ✅ 条件格式后端 (ConditionalRule + apply_rules) — ce973f2
- ✅ undo / redo + clipboard copy/paste TS API — 2267c54
- ✅ Ctrl+Z/Y/Delete 全局键绑 — 7297173
- ✅ FormulaBar 接到 Table — 8de2375
- ✅ approximate-match VLOOKUP/HLOOKUP + TRUE/FALSE — 729d8f3
- ✅ 行列 insert/delete TS 透传 — ae745c5

### 仍 deferred（需工具链 / 浏览器环境）
- A.7 vite + wasm-pack 加载真 wasm
- A.5 多 sheet UI（WasmWorkbook + WorkbookStore + tab UI）
- A.6 行列右键菜单（后端齐全）
- A.8 格式化 / 条件格式 UI
- B.3 wasm-bindgen-test, B.4 playwright e2e CI, B.5 criterion benchmark
- D.1/D.2 7B 虚拟滚动 + 7C Web Worker
- C.1 follow-up — legacy TLS resolver 清理；workbook-wide 跨 sheet 订阅 / 反向依赖图

---

## A. Rust core (`excel/rust/core`)

### A.1（必修）`recompute` 环检测 panic 信息错误
- **位置**：`excel/rust/core/src/store.rs:122-125`
- **问题**：panic 里两个 `{:?}` 都填了 `dep_id`，第二个应是当前 `id`（外层正在 compute 的 atom），现在调试找不到环的另一边。
- **改法**：第二个改成 `id`。

### A.2（必修）`recompute` 用 raw pointer 绕过借用检查
- **位置**：`excel/rust/core/src/store.rs:112-140`
- **现状**：`let values = &self.values as *const HashMap<...>;` 在 `read_fn` 内 `unsafe { (*values).get(...) }`。
- **风险**：当前安全（read_fn 期间不写 values），但一旦后续引入懒求值 / 嵌套 recompute / `set` 内触发 `recompute` 路径，立刻 UB。
- **改法**：用 `RefCell<HashMap>` 包 `values`；或在 recompute 入口 `mem::take` 出 values、读完再放回。

### A.3（必修）`Value::Number` 的 NaN 等值用 `to_bits()`
- **位置**：`excel/rust/core/src/atom.rs:83`
- **问题**：`a.to_bits() == b.to_bits()` 让 NaN==NaN 工作，但两个不同 bit 的 NaN（quiet vs signaling，不同 payload）会被判不等。Excel 公式 `0/0`、`LOG(-1)` 等可能产生不同 NaN，下游派生会"看似没变却重算 + 通知"。
- **改法**：在 `PartialEq::eq` 里加 `if a.is_nan() && b.is_nan() { return true; }` 兜底，或用 `f64::total_cmp` + 注释说明。

### A.4（必修，已提到 1A）没有 atom 销毁 API → 长期内存只增不减
- **位置**：`excel/rust/core/src/store.rs:21-37`
- **问题**：`values` / `read_fns` / `dependencies` / `back_deps` / `subscriptions` 全是 `HashMap<AtomId, …>`，atom 创建后永不释放。TS 版靠 `WeakMap` + atom 引用 GC 自动回收。
- **影响**：
  - Excel demo 当前 200 个固定 cell 没问题
  - ROADMAP **第四期**（插入 / 删除行列）开始动态创建丢弃 atom
  - **第七期**（虚拟滚动 + 万级单元格）必崩
- **改法**：进第四期前必须落地 `pub fn destroy_atom(&mut self, id: AtomId)`，清掉所有 4 张表里指向该 id 的条目。

### A.5（中）`set` 没有写循环检测
- **位置**：`excel/rust/core/src/store.rs:179-219`
- **问题**：`recompute` 用 `COMPUTING` thread_local 检测读循环；但两个 `writable` 互相 set 对方 → 死循环 / 栈溢出，无保护。
- **影响**：第三期 undo/redo、第六期条件格式如果引入复杂 writable 是定时炸弹。
- **改法**：加一个 `SETTING` thread_local 跟 `COMPUTING` 平行；递归 set 检测到已在集合内时 panic 或返回 `Error(CyclicRef)`。

### A.11（中）`recompute` 在 `read_fn` panic 时 `COMPUTING` / `TRACKING` 不清理
- **位置**：`excel/rust/core/src/store.rs:105-148`
- **现状**：第 106 行 `COMPUTING.insert(id)`，第 115 行 `TRACKING = Some(...)`；read_fn 在第 142 行调用，正常返回后第 145 行 `COMPUTING.remove(id)` 第 148 行 `TRACKING.take()`
- **问题**：read_fn panic 时跳过 145/148 → thread_local 残留 → 后续任何 atom 重算都误报循环
- **影响**：测试隔离失败、用户公式 panic（B.3 / 类型 panic）后整个 store 不可用
- **改法**：用 RAII guard，drop 时统一清理（跟 A.6 同类问题一起处理）

### A.6（中）`batch` 在 `f` panic 时 `batch_depth` 不归零
- **位置**：`excel/rust/core/src/store.rs:223-232`
- **问题**：`self.batch_depth += 1; f(self); self.batch_depth -= 1;` 中间 `f` panic 会让 depth 永远 +1，后续所有 `set` 走 pending 路径不再传播。
- **改法**：用 RAII guard（`struct BatchGuard<'a>` impl Drop 自减）替代手写计数。

### A.7（轻）拓扑排序用 `Vec::pop()` LIFO
- **位置**：`excel/rust/core/src/store.rs:334`
- **现状**：拓扑序正确，但订阅者通知顺序非稳定。
- **第七期"精准更新"** 公布订阅顺序契约时需明确说明，或换 `VecDeque::pop_front()` 给 FIFO。

### A.8（轻）`unsub` O(atoms × subs)
- **位置**：`excel/rust/core/src/store.rs:281-283`
- **问题**：每次 unsub 遍历所有 atom 的订阅列表。
- **影响**：万级单元格时 unsub 成为热点。
- **改法**：维护 `sub_id → atom_id` 反查表。

### A.9（轻）自循环测试 hacky
- **位置**：`excel/rust/core/src/store.rs:677-680`
- **问题**：靠 `AtomId(placeholder.0 + 1)` 假设下一个 id，依赖 `alloc_id` 实现细节。
- **改法**：换"两个互引派生"的等价测试，或者只测 `pub` API 能触发的路径（无法构造单 atom 自引时跳过）。

### A.10（轻）`store.rs` 960 行单文件
- **改法**：拆 `store/{mod,propagation,subscription,cycle}.rs`。不影响功能。

### 与 TS core 行为差异（备忘，非 issue）

| 维度 | TS | Rust |
|---|---|---|
| 求值策略 | lazy（read 时检测依赖变化重算） | eager（set 时 propagate 全部下游） |
| 异步 atom | continuable promise | ❌ 无 |
| sub 时机 | sub 时立即触发一次 readAtom 拉值 | sub 不重算 |
| atom GC | WeakMap 自动 | ❌ 无 → A.4 |

> **路线**：用户答复"平行存在，能替代最好但不强求"。所以行为对等性只在用户场景需要时再补；当前 demo 不需要异步 atom，可暂缓。

---

## B. Rust excel-core (`excel/rust/excel-core`)

### B.1（必修，已验证）`set_formula` 的 `cell_map` 是快照 — 后建公式的 cell 不会传播到先建的引用方
- **位置**：`excel/rust/excel-core/src/sheet.rs:65-89`
- **现象**：`set_formula` 时把当前 `self.cells` 拷贝成 `cell_map: HashMap<CellAddress, AtomId>`，固化进 derived 闭包
- **问题**：当前快照对每个 cell 检查"是否已有 formula → 用 formula atom"，但**之后**给某个被引用的 cell 新 set_formula，闭包仍持有旧快照（指向 primitive atom），新 derived 不被任何人订阅传播
- **验证**：临时测试已跑通失败：
  ```rust
  sheet.set_formula("D1", "=E1");      // E1 此时是 primitive Null
  sheet.set_formula("E1", "=A1*2");    // E1 现在是 derived = 20
  sheet.get_cell("D1");                // 期望 20，实际 Null
  ```
- **改法**：cell_map 不能是快照，必须是动态查询。两个方案：
  1. 让 `cell_map` 改成 `Rc<RefCell<HashMap<...>>>`，在 sheet 改 formula_cells 时同步刷新该共享表
  2. derived 闭包不持 cell_map，而是持有一个 `Rc<dyn Fn(CellAddress) -> AtomId>` 反查闭包，每次 eval 时去 sheet 查实时映射
- **影响**：路线图第二期（公式栏）后用户开始改公式时立即出现，必须先修

### B.2（必修，描述已修正）公式自引用 / 互引用**绕过**环检测，**不 panic 也无 #CYCLE!**
- **位置**：`excel/rust/excel-core/src/sheet.rs:58-89`
- **实际行为（已用测试验证 `tests/review_repro.rs`）**：
  - `set_formula("A1", "=A1+1")` → A1 = `Number(1.0)`（读到 primitive 的 Null=0 + 1）
  - `set_formula("A1", "=B1+1"); set_formula("B1", "=A1+1")` → A1=1, B1=2（互不指向 derived）
- **机理**：`cell_map` 在 derived 注册前就快照（sheet.rs:65），自身 cell 还没进 `formula_cells`，所以快照里 A1 永远指向 primitive，`COMPUTING` 检测看不到环
- **影响**：用户写循环公式得到的不是 `#CYCLE!` 而是看似合理的随机数字。**比 panic 还危险**（静默错）
- **改法**：set_formula 入口在 parse 后做静态环检测（基于 AST 遍历 + 已存在的 formula_cells 拓扑），形成环就写 `Value::Error(ValueError::CyclicRef)` 不创建 derived。或者 cell_map 改成动态查询（B.1 的解法）顺带让运行时 `COMPUTING` 能看到环

### B.3（必修）`set_formula` 公式解析失败时 panic
- **位置**：`excel/rust/excel-core/src/sheet.rs:60`
  ```rust
  let expr = parse_formula(formula_str).expect("invalid formula");
  ```
- **问题**：用户在 UI 输入 `=foo bar` 这种垃圾，parse_formula 返回 None → panic → WASM 进程挂掉
- **改法**：返回 `Result<(), FormulaError>`，或失败时把该 cell 设为 `Value::Error(InvalidValue)` 但保留旧 atom

### B.4（必修，已提到 1A）旧 derived atom 永不释放 → 编辑公式越多越慢
- **位置**：`excel/rust/excel-core/src/sheet.rs:88` `self.formula_cells.insert(addr, derived_id);`
- **问题**：重新 set_formula 同一个 cell，旧 derived 在 store 里依然存在（依赖关系也还在）。用户在 UI 编辑公式 100 次 → 100 个废弃 derived 全部留在 store，每次源 cell 改动都会重算所有这些幽灵 derived
- **当前状态**：lazy formula 主体落地后，公式不再是 core derived atom；`formula_cells` 保存的是 `Rc<FormulaRecord>`，替换公式会释放旧 record 并重建地址级依赖。
- **依赖**：A.4（atom GC 缺失）。**ROADMAP 1A 已选择实现 `destroy_atom`**（不选 replace_read_fn），1A step 3 完成 A.4 后 step 6 在 set_formula 调用 `destroy_atom(old_id)`
- **原本可选方案（已弃）**：复用旧 derived id 替换 read_fn — 工作量小但 A.4 仍欠债，否决

### B.5（中）`SUM` / `COUNT` / `AVERAGE` 对 Boolean / Text / Null 的处理跟 Excel 不一致
- **位置**：`excel/rust/excel-core/src/eval.rs:141-190`
- **现状**：
  - `SUM(TRUE)` 返回 1（Excel 对 cell 引用的 boolean 应该忽略，对字面量 boolean 才转 1）
  - `SUM("abc")` 静默忽略（Excel: 字面量 text 应该 #VALUE!，cell 引用 text 才忽略）
- **影响**：跟 Excel 互通时结果不一致，但当前 demo 没人会注意
- **改法**：分清"字面量"和"cell 引用"两条路径，路径分别处理。或者在 ROADMAP 第二期补函数时一起重构

### B.6（中）`MIN` / `MAX` 空集返回 `Number(0)`，应为 `#NUM!`
- **位置**：`excel/rust/excel-core/src/eval.rs:225, 241`
- **改法**：`min.map_or(Value::Error(ValueError::InvalidValue), Value::Number)` （ValueError 里没有 InvalidNum，可加）

### B.7（中）`AVERAGE` 空集错误码用了 `DivisionByZero`，可接受但不精准
- **位置**：`eval.rs:174`
- Excel 表现的确是 `#DIV/0!`，所以**实际 OK**，记录便于将来比对

### B.8（轻）`eval_expr` 闭包多包了一层 thunk
- **位置**：`excel/rust/excel-core/src/sheet.rs:82-84`
  ```rust
  let derived_id = self.store.create_derived(move |get| {
      eval_expr(&expr_clone, &|id| get(id), &cell_map_clone)
  });
  ```
- 内层 `&|id| get(id)` 跟 `get` 类型一致，可直接传 `get`。每次 recompute 创建一个临时闭包，轻微浪费
- **当前状态**：旧 `create_derived` 公式路径已删除；`Sheet` 公式求值改走 `eval_expr_with_provider`，此项实际不再适用。

### B.9（轻）`parse_formula` 错误时返回 `None` 信息丢失
- **位置**：`excel/rust/excel-core/src/formula.rs:42-53`
- **问题**：用户输错只知道"失败"，不知道哪一处。语法错误位置 / 期望符号 / 实际看到什么都丢
- **改法**：返回 `Result<Expr, ParseError { pos, expected, got }>`，配合 ROADMAP 第一期的"公式栏"才能给出有意义的错误提示

### B.10（轻）AST 没缓存 / 没常量折叠
- AST 已随 `FormulaRecord` / `formula_exprs` 保存，不再每次重新 parse；常量折叠仍未做。
- ROADMAP 第七期"性能"目标，目前规模不需要

### B.11（轻）`Range` 出现在非函数参数位置直接 `InvalidValue`
- **位置**：`excel/rust/excel-core/src/eval.rs:46-51`
- 当前对 `=A1:B3` 这种孤立 Range 返回 `#VALUE!`，**符合 Excel** ✅

### B.12（必修，已用测试验证）`batch_set` 不清 `formula_cells` → 批量覆盖公式格读到旧公式结果
- **位置**：`excel/rust/excel-core/src/sheet.rs:138-155`
- **对比**：`set_cell` 第 51 行 `self.formula_cells.remove(&addr)`；`batch_set` 直接走 ensure_cell + store.set，**没清 formula_cells**
- **结果**：`batch_set("B1", 99)` 之后 `get_cell("B1")` 还是返回旧公式结果（已用测试 `batch_set_should_clear_formula` 验证）
- **影响放大**：`excel/rust/wasm/src/lib.rs:75` 的 `batch_set_numbers` 直接暴露这个 bug 给 JS。前端任何"批量数据导入"操作覆盖到公式格都失败
- **改法**：`batch_set` 内每个 update 也走 `formula_cells.remove(&addr)`，或者复用 `set_cell` 路径在 batch 里执行
- **当前状态**：已修。`batch_set` 覆盖公式格会移除 lazy formula record 并重建依赖索引。

### 路线图与现实的 gap

ROADMAP 第二期（比较运算 / 文本函数 / 条件聚合）依赖 parser 重构：
- `<`, `>`, `<=`, `>=`, `=`, `<>` 在加减法之下加一个优先级层
- `&` 在加减法同一层（左结合）
- `^` 在乘除上面
- 字符串字面量已经支持 `"..."` ✅

`eval` 层硬编码 `match name` 替换为 `HashMap<&str, fn(...) -> Value>` 注册表是合理重构方向（路线图也提了），但要小心闭包捕获的生命周期。

---

## C. WASM 桥接 (`excel/rust/wasm`)

### C.1（必修）`subscribe` 完全没接通 — `fire_listeners` 是空函数
- **位置**：`excel/rust/wasm/src/lib.rs:84-96`
  ```rust
  pub fn subscribe(&mut self, addr: &str, callback: js_sys::Function) {
      self.listeners.entry(addr.to_string()).or_default().push(callback);
  }
  fn fire_listeners(&self, _addr: &str) {
      // Note: In a full implementation, we'd wire this to the atom store's
      // subscription system. For now, listeners are fired manually after set calls.
      // The atom store handles propagation internally.
  }
  ```
- **现状**：listener 收下了从来不调用。注释承认是占位
- **影响**：Solid Excel demo 因此走 `createJSSheet` 而不能用 WASM
- **路线图标注**：第一期"WASM 订阅接通"，但没提 fire_listeners 是空函数这件事
- **解决方案**：subscribe 入口拿到 `sheet.cell_atom(addr)` 得到 AtomId，把 callback 注册到 `store.sub(atom_id, ...)`。让 store 的 propagate_and_notify 自动触发。但这需要先解决 C.3

### C.2（必修）`set_number` 触发 listener 但**不传播到下游公式 cell 的 listener**
- **位置**：`excel/rust/wasm/src/lib.rs:27-42`
- **现状**：`set_number(addr)` → `fire_listeners(addr)`，只触发该 addr 的 listener
- **问题**：B1 = `=A1*2`，订阅了 B1 的 callback。`set_number("A1", ...)` 时只 fire A1 的 listener，B1 的 callback 完全不收通知
- **理由是 store 内部已经把 B1 derived 重算并 propagate 了 — 但 wasm 的 listeners 表跟 store 的 subscriptions 表是两个独立结构，没桥接
- **跟 C.1 一起解**：把 listeners 从 wasm 层挪到 store 层

### C.3（必修）`WasmSheet` 是 `&mut self`，listener 内回调进 set 会借用冲突 panic
- **位置**：整个 WasmSheet impl
- **问题**：`set_number(&mut self, ...)` 期间触发 listener；listener 是 JS 函数，可能 `wasmSheet.set_number(...)` 反向调用 → 同一时刻两个 `&mut self` → wasm-bindgen 抛 panic
- **解决方案**：内部用 `Rc<RefCell<Sheet>>`，对外保持 `&mut self`。但 RefCell 在重入时也会 panic（borrow_mut 嵌套），需要：
  - 用一个 pending 队列：listener 内的 set 不立即执行，加到队列，当前 set 完后 flush
  - 或者 listener 通过 `queueMicrotask` 异步执行（JS 层处理）

### C.4（必修）没有 `unsubscribe`
- **位置**：`excel/rust/wasm/src/lib.rs:85-90`
- 加进去就拿不出来，JS 组件卸载无法清理。listener 持有的闭包引用会泄漏（包括捕获的 DOM/Solid signal）
- **改法**：subscribe 返回一个 token id，加配套 `unsubscribe(token)`

### C.5（中）`get_display` / `get_number` / `is_error` 都是 `&mut self`
- **位置**：`excel/rust/wasm/src/lib.rs:45-72`
- **原因**：`sheet.get_cell` 内部走 `readable_atom` 调 `ensure_cell` 可能创建 atom，所以是 `&mut self`
- **影响**：wasm-bindgen 默认禁止两个并发 `&mut` 调用，前端读多个 cell 时会序列化
- **改法**：`get_cell` 拆成 `peek_cell(&self)`（不 ensure，未存在的 cell 返回 Null）和当前的 ensure 版本

### C.6（中）`fire_listeners` 即使值没变也会 fire（如果接通的话）
- **位置**：`excel/rust/wasm/src/lib.rs:27-42`
- **现状**：`set_number` 无条件调 `fire_listeners(addr)`
- **store 内部已经做了"值未变跳过 notify"**，但 wasm 层的 listeners 不走 store，永远触发
- **跟 C.1/C.2 一起解决**：listeners 桥接到 store 后这个问题自动消失

### C.7（中）`batch_set_numbers` 只支持 number，不支持 text / formula
- **位置**：`excel/rust/wasm/src/lib.rs:75-82`
- **改法**：用 `JsValue` 数组接受任意类型，或者拆三个 batch_set_text / batch_set_formula

### C.8（中）没有 wasm32 集成测试
- **现状**：`cargo test` 跑的都是原生 target，wasm-bindgen 行为没验证
- **改法**：用 `wasm-bindgen-test` 在 headless 浏览器里跑端到端
- **次序**：C.1/C.2/C.3 都修完之后再加，否则测试会因为这些 bug 全失败

### C.9（轻）`value_to_display` 整数判定阈值随意
- **位置**：`excel/rust/wasm/src/lib.rs:101-107`
- `n == n.floor() && n.abs() < 1e15`：1e15 可精确表示为 f64 整数，阈值偏低
- 不重要

### C.11（必修，已提到 1A）`Sheet.store` 是 crate-private，subscribe API 需分层避免 7C 重设计
- **位置**：`excel/rust/excel-core/src/sheet.rs:12` `pub(crate) store: Store`，wasm 层只能用 Sheet 的公开方法
- **后果**：直接动手做 1A 会卡在"在 wasm 层访问不到 store"。临时改成 `pub store: Store` 又破坏封装
- **追加问题（来自二轮 review）**：1A 如果直接让 `Store::sub` 接收 `js_sys::Function`，7C（Web Worker）下 callback 不能跨线程，需要重新设计接口。**在 1A 就要定分层**：

```rust
// einfach-core 不依赖 wasm-bindgen
pub trait CellListener: 'static { fn on_change(&self); }
impl Store {
    pub fn sub(&mut self, id: AtomId, l: Box<dyn CellListener>) -> SubscriptionId;
}
// einfach-excel-core
pub struct CellSubscription { sub_id: SubscriptionId, atom_id: AtomId }
impl Sheet {
    pub fn subscribe_cell(&mut self, addr: &str, l: Box<dyn CellListener>) -> CellSubscription;
    pub fn unsubscribe_cell(&mut self, sub: CellSubscription);
}
// einfach-wasm 主线程 adapter
struct JsCallbackListener(js_sys::Function);
impl CellListener for JsCallbackListener { fn on_change(&self) { let _ = self.0.call0(...); } }
// 7C 加 worker adapter（不在 1A 实现，但 trait 要兼容）
struct PostMessageListener { /* worker_port + addr */ }
```

`subscribe_cell` 返回 token 包含 SubId + AtomId，因为 cell 可能被换 derived（B.4 修后），unsubscribe 时需要知道当前订阅指向哪个 atom。

### C.10（轻）没有 panic catch
- Rust panic 在 wasm 里默认是 trap，整个 wasm 实例不可用
- 应在 lib 入口加 `console_error_panic_hook::set_once()`，让 panic 输出到 console 便于调试
- ROADMAP 第一期开始大量加功能时会遇到

---

## D. Solid Excel (`excel/solid-excel`)

### D.1（必修，影响首屏）"可切换后端"目标 vs 实际：JS 后端跟 Rust 行为不等价 — **首屏 demo 已显示错误结果**
- **位置**：`excel/solid-excel/src/js-sheet.ts:25-65`，入口 `excel/solid-excel/src/App.tsx:26` 默认 tab 是 `formulas`
- **现状**：`createJSSheet().evalFormula` 只硬编码识别 `^SUM\(([A-Z]+\d+):([A-Z]+\d+)\)$` 范围形式，其他用 `Function(\`"use strict"; return (${evaluated})\`)()`
- **能力差距**（JS 后端缺，Rust 后端有）：
  - 不支持 `IF` / `AVERAGE` / `COUNT` / `MIN` / `MAX`（不在 SUM 范围正则里 → 落到 Function eval → 函数名当成自由变量 → 报错）
  - 不支持 `SUM(A1, B1, C1)` 列表形式（只支持 `SUM(A1:B3)` 范围）
  - 不支持字符串字面量、嵌套函数、Boolean/Null 强转
- **首屏即坏**：`DemoFormulas.tsx:48` 起的 `=SUM(A8,A9,A10,A11,A12)` / `=AVERAGE(...)` / `=COUNT(...)` / `=MIN(...)` / `=MAX(...)` / `=IF(...)` 在 createJSSheet 上**全部 #ERROR! 或 #VALUE!**
- **改法**（按推荐顺序）：
  1. **用 dev 模式编 wasm**：vite 直接加载 wasm，不需要 JS 后端（推荐）
  2. **若仍要 JS 后端**：把 formula.rs / eval.rs 翻译成 TS 共享在 `vanilla/excel-core` 之类的包，Rust 和 TS 共用语义
- **临时建议**：在 demo 加 console.assert / 显式断言，至少让"用错后端"被测出来

### D.2（必修）`createJSSheet.evalFormula` 用 `Function(...)` 动态执行
- **位置**：`excel/solid-excel/src/js-sheet.ts:54`
  ```ts
  const result = Function(`"use strict"; return (${evaluated})`)()
  ```
- **当前安全的原因**：`evaluated` 是先把 cell ref 替换成数字（`getNumeric` 返回 number），看起来只剩数字 + 运算符
- **风险**：
  - 如果 `getNumeric` 返回 `NaN`，最终被 `String(NaN)` → `"NaN"` 注入到表达式（OK，NaN 是合法 JS 标识符）
  - 一旦扩展支持文本字面量或更多函数，注入风险变真
- **改法**：弃用 `Function`，写真正的 parser/eval（D.1 同条解决方案下）

### D.3（必修）`refresh()` = `refreshAll()`，每次写都全表重读
- **位置**：`excel/solid-excel/src/sheet-store.ts:28-39`
- **现状**：set_* 后遍历所有已创建的 signal 全部重读 → 触发对应 component re-render
- **影响**：当前 demo 200 cell 没事；ROADMAP 第七期"万级单元格"必崩
- **根因**：ISheet 接口没有"哪些 cell 变了"的信息（`subscribe` 接通后才有）
- **次序**：依赖 C.1+C.2 接通 store subscribe；那之后改成 `subscribe` 注册到具体 cell，callback 内 `setSignal(...)` 单点更新

### D.4（中）每个 cell 在 sheet-store 里维护一份 SolidJS signal — 数据副本
- **位置**：`excel/solid-excel/src/sheet-store.ts:9-17`
- **冲突点**：技能 `einfach-atom-patterns` 第 130-134 行验收清单"派生值用 derived atom，而不是额外存一份"
- **现状解释**：因为 Rust atom 没暴露给 Solid（C 段问题），sheet-store 不得不复制
- **改法**：subscribe 接通后，让 SolidJS signal 退化成"通知机制"，display/type/isError 每次从 sheet 实时读，不在 signal 里存值

### D.5（中）`signals` Map 永不清理
- **位置**：`excel/solid-excel/src/sheet-store.ts:9`
- **影响**：长生命周期 + 滚动浏览大量 cell 时单调增长
- **改法**：用 LRU 限制大小；或者组件卸载时主动 remove

### D.6（中）`store.raw` 暴露内部 ISheet 引用
- **位置**：`excel/solid-excel/src/sheet-store.ts:83`
- **风险**：用户绕过 store 直接 `raw.set_number(...)` 不会触发 refresh，signal 跟 sheet 状态分裂
- **改法**：删除 `raw` 字段；如有诊断需求改成 `__unsafe_raw`

### D.7（中）没有暴露 batch
- **位置**：`excel/solid-excel/src/sheet-store.ts`
- **现状**：N 次连续 set 触发 N 次 refreshAll
- **改法**：加 `batch(fn)` 包一层 sheet.batch + 单次 refresh

### D.8（轻）Cell focus 用 `setTimeout(() => el.focus(), 0)`
- **位置**：`excel/solid-excel/src/Cell.tsx:52`
- **改法**：用 SolidJS 的 `onMount` 或 `requestAnimationFrame`

### D.9（轻）`Cell` 内多次调用 `cellValue()` 触发多次 `getCell`
- **位置**：`excel/solid-excel/src/Cell.tsx:13, 39, 44`
- **改法**：`const value = createMemo(() => props.store.getCell(props.addr))`

### D.12（轻，已用 pragma 临时绕过）`excel/solid-excel` 的 src .tsx 缺 `@jsxImportSource solid-js` pragma → `npm run build` 卡 tsc
- **位置**：`excel/solid-excel/src/*.tsx` + `excel/solid-excel/src/demos/*.tsx`（10 个文件）
- **根因**：根 `tsconfig.json` 用 `"jsx": "react-jsx"`，且没把 `excel/solid-excel/tsconfig.json` 加到 `references`。`excel/solid-excel/test/*.tsx` 通过 import 把 src 的 .tsx 拉进根 tsconfig 编译范围 → 用 React JSX 类型检查 SolidJS 代码 → 报错
- **临时修法（已实施）**：每个 src .tsx 顶部加 `/** @jsxImportSource solid-js */` pragma（跟 test 文件一致）
- **正式修法（建议放 1A step 10 vite + wasm 一起做）**：
  1. `excel/solid-excel/tsconfig.json` 改成 extends `tsconfig.base.json` 风格（参考 `core/solid/tsconfig.json`），加 `composite: true`
  2. 根 `tsconfig.json` `references` 加 `./solid/excel/tsconfig.json`
  3. 之后新 .tsx 文件不需要 pragma
- **影响**：当前 `pre-commit` hook 跑 `npm run build`，不修整个仓库无法 commit

### D.11（必修）双击编辑公式格会丢公式 — `ISheet` 没 `get_formula`
- **位置**：`excel/solid-excel/src/Cell.tsx:16` `setEditValue(cellValue().display)` + `Cell.tsx:21` `setCellInput(editValue())`
- **现象**：B1 = `=A1*2`，display 是计算结果 `"20"`。用户双击 B1 进入编辑，input 里显示 `"20"`，回车提交 → `setCellInput("20")` → `set_number(20)` → 公式被静态值替换
- **根因**：`excel/solid-excel/src/types.ts:2` 的 `ISheet` 接口没有 `get_formula(addr)` 方法；`excel/rust/wasm/src/lib.rs` 也没暴露
- **影响**：用户**不可能**在公式栏（路线图 1B 关键功能）之外编辑公式，每次双击都把公式吃掉。1B 功能本身依赖这个接口
- **改法**：
  1. `Sheet` 加 `pub fn get_formula(&self, addr: &str) -> Option<String>`（在 `formula_cells` 命中时返回原始公式字符串 → 需要 `set_formula` 时同时存 `addr → String` 表）
  2. `WasmSheet` 透传 `get_formula`
  3. `ISheet` 加 `get_formula(addr): string | null`
  4. `Cell.tsx` 编辑时优先用 `get_formula(addr) ?? cellValue().display`

### D.10（轻）demo 组件函数体直接执行长串初始化
- **位置**：`excel/solid-excel/src/demos/DemoFormulas.tsx:11-83`
- **现状**：tab 切换 demo 组件 unmount/remount，state 丢失重建。OK for demo，但说明数据生命周期管理还很粗

### 跟 `einfach-state-only` 技能的关系

技能允许"框架绑定层内部为了桥接订阅机制可以使用框架原语"（state-only 第 33-34 行）。所以 sheet-store 用 `createSignal` 作为 SolidJS 反应桥**不违反技能**。但 D.4 说的"每个 cell 一份 signal 数据副本"超出了"桥接"的范围，是状态复制 — **轻度违反** `einfach-atom-patterns` 的"派生值用 derived atom 而不是额外存一份"。

ROADMAP 第一期目标"WASM 订阅接通"完成后这个矛盾自动消失，因为 signal 退化为通知触发器，不再存值。

---

## E. ROADMAP 路线本身

### E.1（必修）路线图没把 review 出来的 bug 当成各期前置条件
路线图按"功能增量"组织，但忽略了存量 bug 对每期的阻塞关系。建议在每期"需求"前加"前置修复"小节：

| 期次 | 必须先修的 issue |
|---|---|
| 一期（公式栏 + 键盘 + WASM 订阅） | **B.1**（cell_map 快照 — 用户改公式立即出问题）、**B.3**（parse 失败 panic）、**C.1+C.2+C.3+C.4**（subscribe 接通 + 传播 + 重入 + unsubscribe）、**A.1**（panic 信息 bug）、**A.5**（set 循环检测）|
| 二期（比较运算 + 函数库） | **A.2**（unsafe raw pointer，加新求值路径前必须修）、**B.4**（公式重新设置时的旧 derived 残留 — 用户大量改函数时显形）|
| 三期（复制粘贴 + 撤销重做） | **A.5**（writable 循环检测，undo 操作可能形成循环）、**B.4**（撤销操作要恢复旧 derived，但旧的没释放过会引用错乱）|
| 四期（行列操作 + 多 Sheet） | **A.4**（atom GC，删除行 / 删除 sheet 时大量 atom 必须释放）、**B.1**（行插入会改 cell map，cell_map 快照彻底崩）|
| 五期 | 无新增前置 |
| 六期（格式化 + 条件格式） | **C.1+C.2**（条件格式需精准订阅）、**D.3**（如果第一期没改完，条件格式必崩）|
| 七期（性能 + Web Worker） | **A.4**（万级单元格无 GC 必崩）、**A.7+A.8**（订阅顺序 + unsub 性能）、**E.4**（thread_local 跟 worker 模型）|

### E.2（中）各期粒度不均，被低估的期复杂度

| 期次 | 路线图标 | 实际评估 | 原因 |
|---|---|---|---|
| 一期 | 低 | **高** | "WASM 订阅接通"展开是 C.1+C.2+C.3+C.4 四件互相绞缠的事，外加 A.1+A.5+B.1+B.3 修复 |
| 二期 | 中 | **高** | 5 大类函数 × N 个函数 + parser 加 3 个优先级层 + eval 重构成函数注册表 |
| 七期 | 高 | **极高** | 性能 + 虚拟滚动 + Web Worker + 内存优化 + benchmark 四件独立大事 |
| 三/五/六期 | 中 | **中** | 估得相对准 |
| 四期 | 高 | **高** | 估得对。但 A.4 没列前置 |

**建议**：一期拆成 1A（订阅接通 + bug 修）和 1B（公式栏 + 键盘）；七期拆成 7A（atom GC + 内存）、7B（虚拟滚动）、7C（Web Worker）

### E.3（中）路线图缺失项

1. **错误处理统一模型**：parse error、cycle、set 失败、wasm panic 各自处理路径不同，应有统一文档
2. **测试策略**：当前 `cargo test` 在原生 target 跑，wasm32 没集成测试，Solid 没 e2e。每期完成的"验证"标准应明确包含 wasm-bindgen-test 和 e2e 何时启用
3. **API 稳定性 / 版本策略**：`WasmSheet` 公开方法签名、`ISheet` 接口都没 versioning。一发布到 npm，二期重构函数注册表是否破 API？
4. **TS 类型生成 vs 手写 ISheet**：当前 `excel/solid-excel/src/types.ts` 手写 `ISheet`。WASM 编出来后 wasm-bindgen 自动生成 `.d.ts`，需要决定是否抛弃手写、改用生成的类型，还是把 `ISheet` 当成稳定契约

### E.4（中）第七期 Web Worker 跟当前架构的耦合点没说清
- `excel/rust/core/src/store.rs:40-44` 用 `thread_local!` 存 TRACKING / COMPUTING
- 单 worker 内每个 store 是 thread_local，**OK**
- 但路线图"把 WASM Sheet 放到 Worker"需要明确：
  - Sheet 完全在 worker 内，主线程不持 store
  - 主线程通过 postMessage 发命令 → worker 解码 → 调 sheet API
  - 这意味着 sub callback 不能直接是 JS 函数（跨 worker 不能传函数引用），需要发"通知消息"回主线程
- 这跟 C.1-C.4 的当前 subscribe 设计**完全不一样**——是不同的模型，不是简单"挪到 worker"
- **建议**：在第一期就决定 sub callback 的设计是"跨 worker 友好"还是"本 worker"。如果两种都要，接口应分两套

### E.5（中）第六期"条件格式"前置缺失
- 路线图描述："格式不参与 atom 依赖图（纯 UI 层）"
- 但条件格式"基于值高亮"需要订阅 cell 变化
- 当前 D.3 是全表 refresh，条件格式跑在视图层就是 O(N×rules) 每次写
- **建议**：第六期前置依赖 D.3 + C.1+C.2 必须修完

### E.6（轻）"每期结束都能独立发布使用"在前期是空话
- 一期完成时，C.1+C.2+C.3+C.4 还没全做的版本不可发布（subscribe 不通用户体验都谈不上）
- 第二期"覆盖 80% 日常 Excel"前用户根本没什么公式可写
- **建议**：把"独立可发布"标准定细。例如一期完成的发布形态是"WASM 跑通 + 键盘流畅 + 公式栏只读显示" — 写公式的能力可能放二期初

---

## 总结

### 工作排序建议

1. **修 6 个最致命的**（按依赖顺序）：A.1 → A.5 → A.2 → A.4 → B.1 → B.3
2. **C 段一锅烩**（subscribe 接通的 4 件事一起做）：C.1+C.2+C.3+C.4
3. **JS 后端定方向**：是改成"加载 wasm"还是"TS 重写求值器"，决定 D.1 怎么办
4. **路线图重写**：把上面的前置依赖加进 ROADMAP.md，把一期拆成 1A/1B，七期拆成 7A/7B/7C

### Review 总分

| 段 | 必修数 | 中等数 | 轻微数 |
|---|---|---|---|
| A. Rust core | **4** | 3 | 4 |
| B. Excel core | 5 | 3 | 4 |
| C. WASM 桥接 | 5 | 4 | 2 |
| D. Solid Excel | 4 | 4 | 3 |
| E. ROADMAP | 1 | 4 | 1 |
| **合计** | **19** | **18** | **14** |

> 二轮 review 新增：A.11（recompute panic 不清 thread_local）、B.12（batch_set 不清公式）、C.11（Sheet.store 私有 + subscribe 分层）、D.11（双击编辑公式格丢公式）。修正：B.2（自引用是绕过环检测，不是 panic）。
> 三轮 review：A.4 升级为必修并提到 1A、B.4 提到 1A、C.11 加 trait 分层模型对齐 7C。新增 ROADMAP 全期通用门禁基线 + 状态归属架构约束 + 各期专有自动化门禁。

测试都能过、demo 能跑，是因为：
- 测试覆盖的是"先 ensure 再用"的简单序列，B.1 这种顺序敏感的场景没测
- WASM subscribe 没接通，所以 C 段 4 个相关 bug 在 demo 里无影响（因为 demo 走 createJSSheet）
- A.2（unsafe）当前路径正确所以没翻车

整体方向对，**当前是一个好的 PoC** —— 但要进一期实质开发前，必修项必须先解决。
