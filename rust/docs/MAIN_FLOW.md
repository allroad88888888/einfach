# 核心主流程

## Atom 状态引擎（已完成）

```
Store.new()
  → create_atom(Value) → AtomId          # 原始 atom
  → create_derived(read_fn) → AtomId     # 派生 atom
  → get(AtomId) → Value                  # 读值
  → set(AtomId, Value)                   # 写值 → 传播 → 通知
  → sub(AtomId, listener) → SubId        # 订阅
  → unsub(SubId)                         # 取消订阅
```

### 变更传播链路
```
set(id, value)
  → 值相同？跳过
  → 写入 values
  → collect_affected(id)    # BFS 收集所有下游
  → topological_sort()      # 拓扑排序保证依赖先算
  → 逐个 recompute()        # 重算派生值 + 更新依赖图
  → notify(changed)         # 只通知实际变化的 atom
```

## Excel Core 层（待实现）

```
Sheet.new()
  → set_cell(addr, Value)               # 写入单元格值
  → set_formula(addr, formula_str)       # 写入公式（解析+创建派生atom）
  → get_cell(addr) → Value              # 读取单元格值
  → 修改单元格 → 公式自动重算 → 订阅者收到通知
```

### Excel 公式链路
```
用户输入 "=A1+B1"
  → parse_formula("=A1+B1")             # 解析为 AST
  → 提取依赖: [A1, B1]
  → create_derived(|get| get(A1) + get(B1))
  → 值缓存到 Sheet
  → A1 变化 → 公式 atom 自动重算 → 视图更新
```

## WASM 桥接层（待实现）

```
JS 侧:
  const sheet = new WasmSheet()
  sheet.set_cell("A1", 42)
  sheet.set_formula("B1", "=A1*2")
  sheet.get_cell("B1")  // → 84
  sheet.subscribe("B1", callback)
```

## 视图层（待实现）

```
SolidJS:
  <Table sheet={sheet} rows={100} cols={26} />
    → <Cell addr="A1" />  // 单个单元格组件
    → 编辑 → sheet.set_cell() → WASM → 自动传播 → 视图更新
```
