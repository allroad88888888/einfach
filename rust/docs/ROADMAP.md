# Einfach Excel — 迭代路线图

> 原则：每期交付可用的增量，先跑通再完善，每期结束都是一个能用的版本

> **代码 review 已完成**：见 [ISSUES.md](./ISSUES.md)。每期"前置修复"小节列出阻塞该期的 issue。
> **状态归属架构约束**：见 [MAIN_FLOW.md 末尾](./MAIN_FLOW.md)。任何新状态必须对照该表确认归属层。

## 全期通用门禁基线

每期完成都必须满足以下最低线，**红线项不过不得进入下一期**：

| 类别 | 工具 | 红线（每期都必须过） |
|---|---|---|
| Rust unit | `cargo test --workspace` | 全过；新增功能必须有对应单测；不得引入新的 `#[ignore]` |
| WASM 集成 | `wasm-pack test --headless --chrome` | 1A 之后启用；每期新增的 WASM API 必须有 wasm-bindgen-test |
| Solid component | `jest` + `@solidjs/testing-library` | 全过；每个组件改动 / 新组件有对应 component test |
| Solid e2e | `playwright` | 1A 之后启用；每期新增用户交互必须有 e2e；e2e 用真实 WASM 后端，不用 mock |
| Lint / 类型 | `cargo clippy -- -D warnings` + `tsc --noEmit` + `npm run eslint` | 0 warning，0 error |
| 内存基线 | 自定义 harness（1A 加） | destroy/create 1 万 atom 循环后内存稳定（无单调增长） |

每期"自动化门禁"小节列出**该期专有的额外门禁**（性能指标、特定功能 e2e 等）。



---

## 当前状态（截至本分支 HEAD）

> 1A → 6 + 7A 已完成。7B / 7C 留给后续工具链工作。
> Rust 测试：core 61 + excel-core 120 + 4 review_repro + wasm 10 = **195 通过**。
> JS 测试：jest 53 套件 / 317 通过。

**已完成（后端）**

- ✅ Atom 引擎：destroy_atom (A.4)、O(1) unsub (A.8)、写循环检测 (A.5)、recompute/batch RAII (A.6+A.11)、unsafe raw pointer 替换 (A.2)、CellListener trait 分层 (C.11)
- ✅ Excel 公式：四则 + `^` + `&` + 比较运算 + 字符串字面量
- ✅ 函数库（28 个）
  - 算术：SUM, AVERAGE, COUNT, MIN, MAX
  - 逻辑：IF, AND, OR, NOT
  - 数学：ABS, ROUND, CEILING, FLOOR, SQRT, POWER, MOD
  - 文本：CONCATENATE, LEN, LEFT, RIGHT, MID, UPPER, LOWER, TRIM
  - 条件：COUNTIF, SUMIF
  - 查找：VLOOKUP, HLOOKUP, INDEX, MATCH
  - 统计：MEDIAN, MODE, STDEV, VAR, LARGE, SMALL
  - 日期：DATE, YEAR, MONTH, DAY（TODAY/NOW 留给 chrono）
- ✅ Sheet API：set/get cell + formula + batch + subscribe/unsubscribe + 行列插入删除（含 ref 自动调整 + #REF!）
- ✅ Workbook：多 sheet 容器（跨 sheet 引用 parser deferred）
- ✅ Undo / Range / 公式偏移：UndoStack, Edit, CellSnapshot, CellRange, shift_refs, render_formula
- ✅ 格式化：CellFormat（数字 / 百分比 / 货币 / 千分位）— 条件格式 deferred
- ✅ CSV 导入导出（RFC 4180 引号转义）
- ✅ WASM 桥接：subscribe / unsubscribe / get_formula 全接通

**已完成（UI）**
- ✅ TS 侧 ISheet 完整接口 + sheet-store 精准订阅（D.3+D.4）
- ✅ Cell 双击编辑保留公式（D.11）
- ✅ FormulaBar 组件、selection 模型、Cell 高亮、Table 方向键 / Tab 导航

**Deferred — 工具链 / UI e2e 密集**
- Solid demo 实际加载 wasm-pack 产物（需 vite-plugin-wasm + wasm-pack）
- 跨 sheet 引用 parser（`=Sheet1!A1`）
- 复制粘贴 / 撤销重做 / 多 sheet 切换的 UI 接线（后端 API 都齐了）
- 条件格式 rule engine
- 7B 虚拟滚动 + fps benchmark
- 7C Web Worker + 跨线程 subscribe 适配器
- wasm-bindgen-test + playwright e2e
- TODAY / NOW（chrono crate）

> 所有 ISSUES.md 列出的"必修"项已全部解决；review_repro 4 个 ignore 测试已全部去 ignore 通过。

---

## 第一期 1A：订阅接通 + 关键 bug 修复（基础设施期）

**目标：** 把 v0.1 那些已知缺陷修干净，让后续功能开发有可靠底座；让 Solid demo 真正跑在 Rust/WASM 路径上，避免后续功能在 JS mock 上验证

### 决策（要在 1A 开工前定）

**D1：atom 生命周期管理选哪种？**（影响 B.4、A.4、第二期、第四期、第七期）
- 选项 A：实现 `Store::destroy_atom(id)`，4 张表全部清理 — 干净但工作量大
- 选项 B：实现 `Store::replace_read_fn(id, new_fn)`，set_formula 同 cell 复用 derived id 替换 read_fn — 工作量小但只解决 B.4，A.4 依然欠债
- **建议**：选 A。第四期（行列删除）、第七期（万级数据）必然需要，早做晚做都要做。1A 现在做能让二期 / 三期 / 四期都不卡

**D2：subscribe 分层模型**（决定 1A 接口形态、避免 7C 重设计）
- core 层（`Store`）只发"变更事件"，不耦合 callback 形态
- 适配层分两种：
  - main-thread adapter：把事件转成 `js_sys::Function` 调用（1A 实现）
  - worker adapter：把事件序列化成 `postMessage`（7C 实现，1A 留接口）
- 具体接口：
  ```rust
  // core 层 — 不依赖 wasm-bindgen
  pub trait CellListener: 'static { fn on_change(&self); }
  impl Store {
      pub fn sub(&mut self, id: AtomId, l: Box<dyn CellListener>) -> SubId;
  }
  // wasm 层 main-thread adapter
  struct JsCallbackListener(js_sys::Function);
  impl CellListener for JsCallbackListener { fn on_change(&self) { self.0.call0(...); } }
  // worker adapter（7C 加，先留 trait）
  struct PostMessageListener { worker_port: ..., addr: String }
  ```
- **核心要求**：core 不能直接拿 `js_sys::Function`，必须经 trait

**D3：Solid demo 是否在 1A 切到 WASM？**
- **建议必做**。当前 demo 走 createJSSheet 等于功能验证绕过 Rust 真实路径，1A 接通 subscribe 后必须立即切换，否则后续功能验证全是假的
- 切换不删 createJSSheet —— 改成只在测试替身里用（component test mock）

### 步骤顺序（不能颠倒）

1. **修 panic 路径**（不修后面所有改动都不安全）
   - **A.1**：`recompute` panic 信息打错变量
   - **A.6**：`batch` 用 RAII guard，panic 时归零
   - **A.11**：`recompute` 用 RAII guard 清理 `COMPUTING` / `TRACKING`
   - **A.5**：`set` 加循环检测（SETTING thread_local）
   - **B.3**：`parse_formula` 失败返回 `Result`，不 panic
   - **C.10**：lib 入口加 `console_error_panic_hook`

2. **修 unsafe / 借用问题**
   - **A.2**：用 `RefCell<HashMap>` 或 `mem::take` 替代 raw pointer

3. **实现 atom GC（A.4）— D1 选项 A**
   - `Store::destroy_atom(id: AtomId)`：清 `values` / `read_fns` / `write_fns` / `dependencies` / `back_deps` / `subscriptions` 5 张表
   - `Store::has_atom(id) -> bool`：让上层判断 id 是否还活着
   - 单测：destroy 后 get/set/sub 都 panic；destroy 后内存稳定（创建-销毁循环 1 万次）

4. **修 cell_map 快照（B.1 + B.2 一起解）+ 公式静态环检测**
   - cell_map 改成动态查询（`Rc<RefCell<HashMap>>` 或反查闭包）
   - set_formula 入口在 parse 后做静态环检测；运行时 `COMPUTING` 也能识别
   - 用 `tests/review_repro.rs` 现有 4 个 ignore 测试做基线

5. **修 batch_set 不清公式（B.12）**
   - `batch_set` 内每个 update 也走 `formula_cells.remove`，旧 derived 调 `destroy_atom`

6. **修 B.4：set_formula 同 cell 释放旧 derived**（依赖 step 3 的 destroy_atom）
   - `Sheet::set_formula` 入口若 `formula_cells.contains_key(addr)` 则先 `destroy_atom(old_id)`

7. **定义 subscribe 分层 API（C.11 + D2）**
   ```rust
   // einfach-core
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
   ```

8. **接通 wasm subscribe（C.1 + C.2 + C.3 + C.4）**
   - 实现 main-thread adapter：`struct JsCallbackListener(js_sys::Function)`
   - `WasmSheet.subscribe(addr, fn)` 包成 `JsCallbackListener` 调 `sheet.subscribe_cell`
   - 返回 token id（u32），加 `WasmSheet.unsubscribe(token)`
   - 重入保护：`WasmSheet` 内部用 `Rc<RefCell<Sheet>>`，listener 调 set 时走 pending 队列

9. **加 `get_formula` API（D.11 前置）**
   - `Sheet::set_formula` 同时存 `addr → 原始字符串`
   - `Sheet::get_formula(addr) -> Option<String>`，`WasmSheet` 透传，`ISheet` 加方法

10. **Solid demo 切到 WASM 后端（D3）**
    - 配置 vite 加载 `*.wasm`（用 `vite-plugin-wasm` + `vite-plugin-top-level-await`）
    - 写 `createWasmSheet()` 工厂，App.tsx 改成 `createSheetStore(await createWasmSheet())`
    - createJSSheet 不删，挪到 `solid/excel/test/mocks/` 当测试替身
    - sheet-store 改用 step 8 的 subscribe 精准更新，去掉 refreshAll（解 D.3）

### 自动化门禁（必须全过才进 1B）

| 类别 | 工具 | 范围 | 阻塞 |
|---|---|---|---|
| Rust unit | `cargo test` | 所有 crate；`tests/review_repro.rs` 4 个 ignore 全过 | ✅ |
| WASM 集成 | `wasm-pack test --headless --chrome` | subscribe/unsubscribe/重入/get_formula 端到端 | ✅ |
| Solid component | `jest` + `@solidjs/testing-library` | Cell / Table / sheet-store，**用 createJSSheet mock** | ✅ |
| Solid e2e | `playwright` | 默认 demo 跑 WASM 后端，所有公式正确（不再首屏即坏） | ✅ |
| 内存基线 | 自定义 harness | 创建-销毁 1 万 atom 循环后内存稳定 | ✅ |

### 验证
- `tests/review_repro.rs` 4 个 ignore 测试去掉 ignore 全部通过
- 端到端：JS 注册 callback 到 D1（依赖 A1*2），改 A1 时 callback 真的被调用且只被调用一次
- 在 listener 里调 set_number 不 panic（重入安全），后续传播照常
- unsubscribe 后 callback 不再触发
- 没有任何已知 panic 路径会让 wasm 实例挂掉
- `Sheet.store` 保持 `pub(crate)`，wasm 层只通过 `subscribe_cell` 访问
- 默认 demo 在 vite dev / build 模式下都跑 WASM；createJSSheet 仅用于测试 mock
- 创建-销毁 1 万 atom 循环后内存稳定（A.4 验证）

---

## 第一期 1B：键盘交互 + 公式栏（让它"像"Excel）

**目标：** 用户能用键盘流畅操作，看到公式内容

### 前置修复
- 1A 必须全部完成
- **D.11**（已在 1A 暴露 `get_formula`）— 公式栏 / 双击编辑都需要原始公式
- **D.1**：决定后端方向。两条路二选一：
  1. vite 直接加载 wasm（推荐，废弃 createJSSheet）
  2. 把 formula.rs / eval.rs 翻译成 TS 让 createJSSheet 跟 Rust 等价

### 需求

1. **单元格选中**
   - 点击选中，蓝色边框高亮
   - 维护一个 `selectedCell` signal

2. **键盘导航**
   - 方向键移动选中
   - Tab → 右移，Shift+Tab → 左移
   - Enter → 下移（提交编辑后）
   - 直接打字 → 进入编辑模式（覆盖原值）
   - F2 → 进入编辑模式（保留原值）

3. **公式栏**
   - 表格上方显示当前选中单元格的地址 + 内容
   - 公式单元格显示公式文本（=A1+B1），而非计算结果
   - 可在公式栏里编辑，回车提交

4. **去掉 `refreshAll()` 轮询**
   - sheet-store 改用精准订阅（依赖 1A 的 C.1+C.2）
   - signal 退化为通知触发器，不再存 cell 数据副本（解 D.4）

### 思路
- 新增 `Selection` 组件管理选中态
- Table 监听全局键盘事件，分发到 Cell
- 新增 `FormulaBar` 组件
- Sheet 层新增 `get_formula(addr)` 返回原始公式字符串

### 自动化门禁（额外）

| 测试 | 工具 | 内容 |
|---|---|---|
| 公式栏端到端 | playwright | 选 B1 → 公式栏显示 `=A1*2` → 改成 `=A1*3` 提交 → B1 重算 → 切回原 cell 公式仍为 `=A1*3` |
| 双击编辑公式格不丢公式 | playwright | 双击 B1 → input 显示 `=A1*2`（不是 `20`） → 回车不修改 → B1 仍是公式 |
| 键盘导航 | playwright | Tab / Shift+Tab / 方向键 / Enter / F2 / 直接打字六个动作 |
| 精准重渲染（机器可验证） | playwright + 全局 render counter | 改 A1 时 B1（依赖）renders +1，C1（无关）renders +0；不靠人工看 console |

### 验证
- 方向键能移动高亮
- 打字直接进入编辑
- 公式栏显示 `=A1+B1`，结果格显示 `30`
- 双击公式格 input 显示原公式而不是结果
- 改一个源 cell，只有受影响的下游 cell 重渲染（**用 render counter 验证，不靠人眼**）

---

## 第二期：比较运算 + 常用函数（让它"能用"）

**目标：** 覆盖 80% 日常 Excel 公式场景

### 前置修复
- ~~**B.4**~~（已在 1A 修）
- **B.5**：SUM/COUNT/AVERAGE 对 Boolean/Text/Null 的处理跟 Excel 对齐（字面量 vs cell 引用区分）
- **B.6**：MIN/MAX 空集返回 Error 而非 0
- **B.9**：parse error 返回结构化 `ParseError { pos, expected, got }` 给公式栏显示

### 需求

1. **比较运算符**
   - `<`, `>`, `<=`, `>=`, `=`, `<>`
   - 返回 Boolean (TRUE/FALSE)

2. **逻辑函数**
   - `AND(cond1, cond2, ...)`
   - `OR(cond1, cond2, ...)`
   - `NOT(cond)`

3. **数学函数**
   - `ABS`, `ROUND`, `CEILING`, `FLOOR`
   - `SQRT`, `POWER` / `^` 运算符
   - `MOD`

4. **文本函数**
   - `CONCATENATE(a, b, ...)` / `&` 运算符
   - `LEN`, `LEFT`, `RIGHT`, `MID`
   - `UPPER`, `LOWER`, `TRIM`
   - `TEXT`（数字格式化）

5. **条件聚合**
   - `COUNTIF(range, criteria)`
   - `SUMIF(range, criteria, sum_range)`

### 思路
- formula.rs：Parser 增加比较运算符优先级层（低于加减）、`^` 和 `&`
- eval.rs：新增函数注册表，用 HashMap<&str, fn> 替代硬编码 match
- 每个函数单独一个测试

### 自动化门禁（额外）

| 测试 | 工具 | 内容 |
|---|---|---|
| 每个新函数一个 unit | cargo test | AND/OR/NOT/ABS/.../COUNTIF/SUMIF 各自至少一个 happy path + 一个错误传播测试 |
| Parser 优先级 | cargo test | 比较运算符 vs 加减、`^` vs `*`、`&` 在加减层 |
| 公式栏交互 e2e | playwright | 输入 `=IF(A1>10,"big","small")` 提交 → 修改 A1 → 显示翻转 |

### 验证
- `=IF(A1>10, "大", "小")` 能工作
- `=CONCATENATE(A1, " ", B1)` 拼接文本
- `=SUMIF(A1:A10, ">5")` 条件求和

---

## 第三期：复制粘贴 + 撤销重做（让它"好用"）

**目标：** 基础编辑操作完整

### 前置修复
- **A.5**（已在 1A 修）— writable 循环检测，undo 操作可能形成循环
- **B.4**（已在 1A 修）— 撤销操作恢复旧 derived 时不能引用错乱

### 需求

1. **范围选择**
   - Shift+点击 选择范围
   - Shift+方向键 扩展选区
   - 选区蓝色半透明背景

2. **复制粘贴**
   - Ctrl+C 复制选区
   - Ctrl+V 粘贴（公式相对引用自动偏移）
   - Ctrl+X 剪切
   - 从外部粘贴 TSV 文本（Excel/Google Sheets 互通）

3. **撤销重做**
   - Ctrl+Z 撤销
   - Ctrl+Y / Ctrl+Shift+Z 重做
   - 每次 set_cell / set_formula 记录一个操作到 undo 栈

4. **Delete 键清空单元格**

### 思路
- 新增 `SelectionRange { start, end }` 类型
- 新增 `UndoStack` — 记录 `(addr, old_value, new_value)` 序列
- 粘贴时解析 `\t` 和 `\n` 分割的文本
- 公式偏移：A1 复制到 B2 → 公式里的引用偏移 (col+1, row+1)

### 自动化门禁（额外）

| 测试 | 工具 | 内容 |
|---|---|---|
| selection / undo 状态归属 | code review | selection / activeCell / undoStack 必须迁回 Rust（架构约束） |
| 复制粘贴 e2e | playwright | 单 cell / 范围 / 公式偏移 / 跨外部应用粘贴（TSV） |
| 撤销重做 e2e | playwright | 连续 5 次操作 → undo 5 次回到初始 → redo 5 次回到末态 |
| 撤销保留焦点 | playwright | undo 后 activeCell 回到操作前位置 |

### 验证
- 选中 A1:B3 → Ctrl+C → 选中 D1 → Ctrl+V → 内容正确复制
- 公式 `=A1` 从 B1 复制到 B2 → 变成 `=A2`
- 撤销 3 次，重做 2 次，值正确

---

## 第四期：行列操作 + 多 Sheet（让它"完整"）

**目标：** 支持表格结构编辑和多工作表

### 前置修复
- **A.4**（已在 1A 修）— `Store::destroy_atom` 已实现
- **B.1**（已在 1A 修）— 行插入会改 cell 地址，cell_map 必须是动态查询
- 新增 `Sheet::delete_row` / `Sheet::delete_col` 时遍历公式 AST 调整或失效引用

### 需求

1. **插入/删除行列**
   - 右键菜单 → 插入行/列、删除行/列
   - 插入后公式引用自动调整（A5 变 A6）
   - 删除后引用指向已删除的 → 变 #REF!

2. **行列拖拽调整宽高**

3. **冻结首行/首列**
   - 表头固定不随滚动

4. **多 Sheet**
   - 底部 Tab 栏切换 Sheet
   - 新增/删除/重命名 Sheet
   - 跨 Sheet 引用：`=Sheet2!A1`

5. **右键上下文菜单**
   - 插入/删除行列
   - 复制/粘贴
   - 清空内容

### 思路
- Sheet 结构改为稀疏存储（HashMap 而非密集数组）
- 行列操作需要 `shift_references()` 遍历所有公式 AST 调整引用
- 多 Sheet 用 `Workbook { sheets: Vec<Sheet> }` 管理
- 公式解析器支持 `Sheet1!A1` 语法

### 自动化门禁（额外）

| 测试 | 工具 | 内容 |
|---|---|---|
| atom GC | cargo test | 删除整列 N cell 后 atom 数减少 N；连续插入删除 1000 次内存稳定 |
| 公式 ref 调整 | cargo test | A5 处插入行 → 引用 A5 的公式 AST 变 A6；删除被引用行 → 公式变 #REF! |
| 跨 sheet e2e | playwright | Sheet2 新建 → Sheet1 写 `=Sheet2!A1` → Sheet2 改值 → Sheet1 自动更新 |

### 验证
- 在 A5 前插入一行 → 原来引用 A5 的公式变成引用 A6
- 切换到 Sheet2，输入数据，Sheet1 公式 `=Sheet2!A1` 能取到值

---

## 第五期：查找函数 + 数据处理（让它"专业"）

**目标：** 支持复杂数据分析场景

### 需求

1. **查找函数**
   - `VLOOKUP(lookup_value, table_range, col_index, [exact_match])`
   - `HLOOKUP`
   - `INDEX(range, row, col)`
   - `MATCH(value, range, [type])`

2. **更多聚合**
   - `MEDIAN`, `MODE`
   - `STDEV`, `VAR`
   - `LARGE(range, k)`, `SMALL(range, k)`

3. **日期函数**
   - Value 新增 Date 类型（内部存为天数）
   - `TODAY()`, `NOW()`
   - `DATE(year, month, day)`
   - `YEAR`, `MONTH`, `DAY`
   - `DATEDIF`

4. **排序和筛选**
   - 列头点击排序（升序/降序）
   - 自动筛选下拉

### 思路
- VLOOKUP 实现：遍历 range 第一列找匹配，返回对应列
- Date 类型内部用 i64 天数偏移（epoch = 1900-01-01，兼容 Excel）
- 排序/筛选是视图层逻辑，不修改底层数据，只改变渲染顺序

### 自动化门禁（额外）

| 测试 | 工具 | 内容 |
|---|---|---|
| VLOOKUP / HLOOKUP / INDEX / MATCH | cargo test | 各自精确匹配、近似匹配、未找到 |
| 日期 | cargo test | DATE(2026,1,1) → 内部天数；YEAR/MONTH/DAY 反解；DATEDIF 跨月跨年 |
| 排序筛选 e2e | playwright | 列头点击切升降；筛选选项交互 |

### 验证
- VLOOKUP 查价格表
- 按日期排序一列数据

---

## 第六期：格式化 + 导入导出（让它"实用"）

**目标：** 数据能进能出，显示美观

### 前置修复
- **C.1+C.2**（已在 1A 修）— 条件格式必须基于精准订阅，否则 O(N×rules) 每次写
- **D.3**（已在 1B 修）— 全表 refresh 路径必须先去掉

### 需求

1. **单元格格式**
   - 数字格式：小数位数、千分位、百分比、货币
   - 文本格式：加粗、斜体、字体大小、颜色
   - 对齐：左/中/右、上/中/下
   - 背景色
   - 边框样式

2. **条件格式**
   - 基于值高亮（>100 红色，<0 绿色）
   - 数据条
   - 色阶

3. **导入导出**
   - CSV 导入/导出
   - JSON 导入/导出（含公式）
   - 剪贴板互通（与 Excel/Google Sheets）

4. **自动保存**
   - localStorage 持久化
   - 定时自动保存

### 思路
- 格式信息独立存储：`CellFormat { font, align, bg_color, number_format, ... }`
- 格式不参与 atom 依赖图（纯 UI 层）
- CSV 解析：按行按逗号分割，处理引号转义
- 条件格式：每次 cell 值变化后在视图层评估规则

### 自动化门禁（额外）

| 测试 | 工具 | 内容 |
|---|---|---|
| CSV roundtrip | cargo test | 写入 → 导出 → 重新导入 → 内容一致（含引号转义） |
| 剪贴板 e2e | playwright | 与 Excel/Sheets 互通：复制本应用 → 粘贴到外部、外部复制 → 粘贴进来 |
| 条件格式精准订阅 | playwright + render counter | 改一个 cell 只触发该 cell 的规则评估，不触发整表 |

### 验证
- 数字显示 ¥1,234.56
- 负数显示红色
- 导出 CSV → 用 Excel 打开正常

---

## 第七期 7A：内存与大数据（让它"装得下"）

**目标：** 万级单元格不爆内存

### 前置修复
- **A.4**（已在 1A 修）— `destroy_atom` 已实现

### 需求

1. **稀疏存储**：空单元格不占内存
2. **字符串驻留**：相同文本共享内存
3. **A.7**：拓扑排序顺序明确文档；如需稳定通知顺序换 `VecDeque::pop_front()`
4. **A.8**：unsub 加 `sub_id → atom_id` 反查表，从 O(atoms × subs) 降到 O(1)

### 自动化门禁（额外）

| 测试 | 工具 | 红线 |
|---|---|---|
| 内存基线（强化版） | criterion + 自定义 harness | 1 万 cell 全部写入后 wasm linear memory < 10MB；创建-销毁循环 1000 次内存增长 < 1MB |
| unsub 性能 | criterion | 1 万订阅下单次 unsub < 1ms |
| 拓扑稳定性 | cargo test | 同一组依赖图，多次跑订阅通知顺序稳定（VecDeque FIFO 验证） |

### 验证
- 1 万 cell 全部写入后内存占用 < 10MB
- 创建-销毁 1 万 atom 循环 100 次后内存稳定（无泄漏）

---

## 第七期 7B：虚拟滚动（让它"看得快"）

**目标：** 100×100 表格滚动 60fps

### 前置修复
- 7A 完成

### 需求
- 只渲染可视区域的单元格
- 滚动时动态加载/卸载行
- D.5：sheet-store 的 signal map 用 LRU，跟着虚拟滚动卸载

### 思路
- 维护 `visibleRange { startRow, endRow }`，只渲染该范围
- Cell 进出视口时 subscribe / unsubscribe 对应 atom（依赖 1A 的 C.4）

### 自动化门禁（额外）

| 测试 | 工具 | 红线 |
|---|---|---|
| 滚动 fps | playwright + chrome devtools protocol Performance.metrics | 100×100 滚动持续 5 秒，平均 fps ≥ 58，p95 frame time ≤ 20ms |
| 滚动内存稳定 | playwright + Memory.prototype.totalJSHeapSize | 1000 次滚动后 heap 增长 < 5MB |
| Cell 进出视口订阅清理 | playwright + render counter | 滚出视口的 cell 在 atom store 里 sub 数减少 |

### 验证
- 100×100 表格滚动 60fps
- 滚动 1000 次后内存稳定

---

## 第七期 7C：Web Worker + 异步计算（让它"算得快"）

**目标**：大范围 SUM 不阻塞 UI

### 前置修复
- **E.4**：明确 Sheet 完全在 worker 内，主线程通过 postMessage 发命令
- C.1-C.4 的 subscribe 模型可能需要重新设计为"跨 worker 友好"（callback 不能跨 worker，需要消息通知）

### 需求

1. **WASM 在 Web Worker 中运行**
2. **脏标记 + 增量计算**：只重算实际受影响的 atom
3. **Rust 侧用 `FxHashMap` 替代 `HashMap` 提升哈希性能**
4. **基准测试**：
   - 10000 单元格写入性能
   - 100 个公式链传播性能
   - SUM(A1:A10000) 计算性能

### 自动化门禁（额外）

| 测试 | 工具 | 红线 |
|---|---|---|
| Worker 集成 | playwright + 自定义 harness | sheet 在 worker 跑，主线程通过 postMessage 完成 set/get/sub |
| 计算性能 | criterion + benchmark e2e | 1 万 cell 公式链，单次 set 触发的传播 < 50ms（end-to-end，含 postMessage）|
| 主线程不阻塞 | playwright | 大范围 SUM 时主线程持续渲染（fps 不掉至 50 以下） |

### 验证
- 10000 单元格全部填公式，修改一个源值 <50ms 完成传播
- 大范围 SUM 不阻塞主线程渲染（fps 不掉）

---

## 各期优先级总结

| 期 | 主题 | 核心价值 | 预估复杂度 |
|----|------|---------|-----------|
| 1A | 订阅接通 + bug 修复 | 基础设施 | 高 |
| 1B | 键盘交互 + 公式栏 | 基本可操作 | 中 |
| 二 | 比较运算 + 常用函数 | 公式能力 | 高 |
| 三 | 复制粘贴 + 撤销重做 | 编辑体验 | 中 |
| 四 | 行列操作 + 多 Sheet | 结构编辑 | 高 |
| 五 | 查找函数 + 数据处理 | 分析能力 | 中 |
| 六 | 格式化 + 导入导出 | 数据流通 | 中 |
| 7A | 内存与大数据 | 规模化（容量） | 中 |
| 7B | 虚拟滚动 | 规模化（渲染） | 中 |
| 7C | Web Worker | 规模化（计算） | 高 |

> 复杂度评估已根据 ISSUES.md E.2 修正。原一期、二期、七期被低估。

每期结束都能独立发布使用，不依赖后续期。**1A 例外** —— 1A 是纯基础设施期，发布形态是"WASM 跑通 + 核心 bug 修干净"，没有新用户功能。
