# 核心主流程

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
  → 有 write_fn？→ 委托给 write_fn → 内部再调 set
  → 写入 values
  → batch_depth > 0？→ 记录到 pending_dirty，延迟传播
  → collect_affected(id)    # BFS 收集所有下游派生 atom
  → topological_sort()      # 拓扑排序保证依赖先算
  → 逐个 recompute()        # 重算派生值 + 更新依赖图（支持动态依赖）
  → notify(changed)         # 只通知实际变化的 atom 的订阅者
```

### Value 类型
```
Number(f64)     — 数字（位级相等，NaN == NaN）
Text(String)    — 文本
Boolean(bool)   — 布尔
Null            — 空值
Error(ValueError) — 错误（DivisionByZero, InvalidRef, InvalidValue, InvalidName, CyclicRef）
```

## 2. Excel Core ✅

```
Sheet.new()
  → set_cell("A1", Value)               # 写入值（清除已有公式）
  → set_formula("A1", "=B1+C1")         # 解析公式 → 创建派生 atom
  → get_cell("A1") → Value              # 读值（公式返回计算结果）
  → batch_set([("A1", v1), ...])         # 批量写
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

## 3. WASM 桥接 ✅

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
  sheet.subscribe("B1", fn) → (注册回调，待接通)
```

## 4. SolidJS 视图 ✅

```
<Table store rows cols />
  → 列头 A-Z + 行号 1-N
  → <Cell addr store />
    → 显示模式：<span class="cell-display">
    → 编辑模式：<input class="cell-input">（双击进入）
    → Enter 提交 / Escape 取消 / Blur 提交
    → setCellInput() 自动识别公式/数字/文本

createSheetStore(ISheet)
  → SolidJS signal 包装
  → setNumber / setText / setFormula / setCellInput
  → getCell() → { display, type, isError }

createJSSheet()
  → 纯 JS 实现 ISheet 接口（开发用，不依赖 WASM）
```
