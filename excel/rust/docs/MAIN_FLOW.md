# 核心主流程

> 已知缺陷标 ⚠️，详见 [ISSUES.md](./ISSUES.md)

## 全链路数据流

```
用户操作 → SolidJS Cell → SheetStore → WASM → Rust Sheet
  → parse_formula → eval_expr → Store.set → 拓扑传播 → recompute
  → notify → WASM callback → SheetStore signal → SolidJS re-render
```

## 1. Atom 状态引擎 ✅

```
Store.new()
  → create_atom(Value) → AtomId          # 原始 atom
  → create_derived(read_fn) → AtomId     # 派生 atom（只读）
  → create_writable(read_fn, write_fn)   # 派生 atom（可写）
  → get(AtomId) → Value                  # 读值
  → set(AtomId, Value)                   # 写值 → 传播 → 通知
  → batch(fn)                            # 批量写，合并一次传播
  → sub(AtomId, listener) → SubId        # 订阅
  → unsub(SubId)                         # 取消订阅
```

### 变更传播链路
```
set(id, value)
  → 值相同？跳过
  → 有 write_fn？→ 委托给 write_fn → 内部再调 set  ⚠️ A.5 没写循环检测
  → 写入 values
  → batch_depth > 0？→ 记录到 pending_dirty，延迟传播  ⚠️ A.6 batch panic 时 depth 不归零
  → collect_affected(id)    # BFS 收集所有下游派生 atom
  → topological_sort()      # 拓扑排序保证依赖先算  ⚠️ A.7 LIFO 顺序非稳定
  → 逐个 recompute()        # 重算派生值 + 更新依赖图（支持动态依赖）
                             ⚠️ A.2 unsafe raw pointer
                             ⚠️ A.11 read_fn panic 时 COMPUTING/TRACKING 不清理
  → notify(changed)         # 只通知实际变化的 atom 的订阅者
```

⚠️ **没有 atom 销毁 API**（A.4），创建后永不释放。第四期 / 第七期前置必修。

### Value 类型
```
Number(f64)     — 数字（位级相等，NaN == NaN）
Text(String)    — 文本
Boolean(bool)   — 布尔
Null            — 空值
Error(ValueError) — 错误（DivisionByZero, InvalidRef, InvalidValue, InvalidName, CyclicRef）
```

## 2. Excel Core ⚠️

```
Sheet.new()
  → set_cell("A1", Value)               # 写入值（清除已有公式）
  → set_formula("A1", "=B1+C1")         # 解析公式 → 创建派生 atom
                                         ⚠️ B.1 cell_map 是快照（已验证 bug）
                                         ⚠️ B.2 自/互引用绕过 #CYCLE! 得到随机数（已验证）
                                         ⚠️ B.3 parse 失败 panic 整个 wasm
                                         ⚠️ B.4 重新设公式时旧 derived 不释放
                                         ⚠️ D.11 没有 get_formula，UI 双击编辑会丢公式
  → get_cell("A1") → Value              # 读值（公式返回计算结果）
  → batch_set([("A1", v1), ...])         ⚠️ B.12 不清 formula_cells（已验证 bug）
  → cell_atom("A1") → AtomId            # 获取底层 atom（供订阅用）
```

### 公式解析（递归下降）
```
"=A1+B1*2"
  → Parser → Expr::BinOp(Add, CellRef(A1), BinOp(Mul, CellRef(B1), Number(2)))

支持：+ - * / 负号 括号 函数调用 范围(A1:B3) 字符串"" 嵌套函数
优先级：() > 负号 > * / > + -
```

### 公式求值
```
eval_expr(ast, getter, cell_map)
  → CellRef → getter(atom_id)
  → BinOp → 递归求值两侧 → 算术运算（除零→#DIV/0!）
  → FuncCall → 展开范围参数 → 调用内置函数
  → 类型强制：Null→0, Boolean(true)→1

内置函数：SUM, AVERAGE, COUNT, IF, MIN, MAX
```

## 3. WASM 桥接 ⚠️ 部分接通

```
JS:
  const sheet = new WasmSheet()
  sheet.set_number("A1", 42)
  sheet.set_text("A1", "hello")
  sheet.set_formula("B1", "=A1*2")
  sheet.get_display("B1")   → "84"
  sheet.get_number("B1")    → 84.0
  sheet.get_type("B1")      → "number"
  sheet.is_error("C1")      → false
  sheet.subscribe("B1", fn) ⚠️ C.1 fire_listeners 是空函数，callback 永不触发
                            ⚠️ C.2 即使接通也只 fire 该 addr，不传播下游公式
                            ⚠️ C.3 listener 内回调 set 会借用冲突 panic
                            ⚠️ C.4 没有 unsubscribe API
                            ⚠️ C.11 Sheet.store 私有，1A 必须先暴露 subscribe_cell
```

## 4. SolidJS 视图 ⚠️

```
<Table store rows cols />
  → 列头 A-Z + 行号 1-N
  → <Cell addr store />
    → 显示模式：<span class="cell-display">
    → 编辑模式：<input class="cell-input">（双击进入）
                              ⚠️ D.11 编辑用 display 值，公式格双击会吞公式
    → Enter 提交 / Escape 取消 / Blur 提交
    → setCellInput() 自动识别公式/数字/文本

createSheetStore(ISheet)
  → SolidJS signal 包装  ⚠️ D.4 每个 cell 一份 signal 复制了 cell 数据
  → setNumber / setText / setFormula / setCellInput
                          ⚠️ D.3 每次 set 都 refreshAll，O(N) 每次写
  → getCell() → { display, type, isError }

createJSSheet()
  → 纯 JS 实现 ISheet 接口（开发用，不依赖 WASM）
                          ⚠️ D.1 跟 Rust 行为不等价，**默认 demo 首屏即坏**
                                  IF/AVERAGE/COUNT/MIN/MAX/SUM 列表形式都不工作
                          ⚠️ D.2 用 Function() 动态执行，扩展后有注入风险
```

---

## 状态归属约束（架构约束，跨期持续生效）

每种状态归属一个明确层，避免后期"selection 该放哪"这种来回讨论。1B 之后任何状态新增都要对照下表确认归属。

| 状态类型 | 归属层 | 理由 | 示例 |
|---|---|---|---|
| **Cell 值（含公式结果）** | Rust `Sheet` / `Store` | 是核心业务状态，需要持久化、撤销重做、跨 worker 同步 | A1=10, B1 公式结果 |
| **公式原文** | Rust `Sheet`（formula_text 表） | 编辑公式 / 公式栏 / 撤销重做都需要原文 | "=A1*2" |
| **撤销重做栈** | Rust `Sheet`（三期加） | 撤销操作要影响所有 cell；跨 worker 时需要在 sheet 这一层 | UndoStack |
| **多 sheet 工作簿** | Rust `Workbook`（四期加） | 跨 sheet 引用需要在 Rust 层解析 | Workbook { sheets: Vec<Sheet> } |
| **格式信息** | Rust `Sheet`（六期加） | 持久化、复制粘贴携带格式都需要 | CellFormat |
| **selection（选区）** | Rust `Sheet`（三期加） | 复制粘贴 / Shift+方向键扩展选区 / 跨组件读取 → 是业务状态 | SelectionRange |
| **当前选中 cell（active cell）** | Rust `Sheet`（三期之前可临时放 SolidJS） | 公式栏需要、键盘导航需要 → 业务状态 | activeCell: CellAddress |
| **公式栏输入中的临时值** | SolidJS signal（1B） | 未提交前是 UI 中间态，提交才进 Rust | formulaBarDraft: string |
| **编辑模式的 input 值** | SolidJS signal（已是） | 同上，未提交前 UI 中间态 | editValue |
| **编辑模式开关** | SolidJS signal（已是） | 纯 UI 状态 | editing: boolean |
| **hover / focus / 高亮动画** | SolidJS signal | 纯渲染状态，不影响业务 | hoveredCell |
| **DOM ref / 测量值** | SolidJS ref | 不是状态 | inputRef |

### 推论

- **三期之前** activeCell / selection 可以临时放 SolidJS signal（因为 1B 还没复制粘贴，不需要跨组件协调），三期开始进 Rust
- **公式栏的 onChange 不立即写 sheet**，回车 / blur 才提交 → 中间态在 SolidJS
- **复制粘贴的剪贴板内容**：进 Rust（属于跨操作的业务状态）
- **撤销重做不能依赖 SolidJS reactivity** → 必须有 sheet API（即便 1B 之前 selection 在 Solid，三期前要把它迁回 Rust）

### 跟 `einfach-state-only` 技能的对应

技能允许"框架绑定层内部为了桥接订阅机制可以使用框架原语"，但**不允许把业务状态放在 SolidJS signal 里**。上表的 SolidJS 一栏全部是"纯 UI 中间态 / 桥接 / 反应式触发"，不是业务状态，**符合技能约束**。
