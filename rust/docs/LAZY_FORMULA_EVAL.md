# Lazy Formula Eval 规划

> 目标：公式结果必须按需计算。导入、批量写入、订阅空白 viewport 都不能把整张表提前算热或提前创建 atom。
>
> 当前状态：Step 1/2 主体已落地。`Sheet::set_formula` 不再调用
> `Store::create_derived`，公式记录为 Sheet 层 `FormulaRecord`；
> `Workbook::get_cell` 走 `WorkbookEvalProvider` 递归读取跨 sheet 公式。
> 仍未完成：BulkLoader、range dependency interval index、workbook-wide
> 跨 sheet 订阅/反向依赖图、primitive atom GC。TLS resolver 仅保留为旧
> `eval_expr(get, cell_map)` 兼容入口。

## 背景

旧实现里 `Sheet::set_formula` 会立即调用 `Store::create_derived`。`create_derived` 在创建时立刻 `recompute`，所以大批量导入公式会同步计算全部公式结果。

这在小表可接受，但会限制后续几个方向：

- CSV / JSON / xlsx 导入大量公式时，导入阶段被公式计算拖慢。
- 虚拟滚动只显示 viewport，但不可见公式仍被提前计算。
- 未设置的引用 cell 现在靠 `ensure_refs` 创建 atom，公式一多会把大量空 cell 也物化。
- Range 公式如 `SUM(A1:A100000)` 会展开大量地址，后续 `SUM(A:A)` 这类整列引用会更差。
- Workbook 跨 sheet eval 需要在读取公式时带 workbook 上下文，当前 eager derived 很难拿到正确 resolver。

旧实现曾有临时 bridge：`Workbook::get_cell` 在 resolver scope 内 silent 重算目标
sheet 上含 `SheetRef` 的公式。这条路径已被 `WorkbookEvalProvider` 替换；
Workbook 读取时递归求值并 bypass formula cache，链式跨 sheet 读取能看到 live 值。

## 设计原则

1. **空白 cell 零分配**
   读取、订阅、公式引用空白 cell 都不能创建 primitive atom。只有用户写入、显式 cell atom API、或后续确实需要持久状态时才创建。

2. **公式保存 AST，不立即计算**
   `set_formula` 只解析、记录公式、建立依赖索引、标 dirty；不执行 `eval_expr`。

3. **公式依赖用地址 / range 表达，不用 AtomId 表达**
   AtomId 只能表示已经物化的 primitive cell。公式必须能依赖尚不存在的 `B1`，否则 `=A1+B1` 第一次读到 `B1 = Null` 后，后续写入 `B1` 无法让公式变 dirty。

4. **读取触发计算**
   `get_cell("B1")`、订阅回调后的 UI read、导出、显式 recalc 才计算公式。不可见且无人读取的公式保持 dirty/uncomputed。

5. **订阅语义是地址变化，不是 AtomId 变化**
   UI 订阅的是 `B1` 显示值。内部 primitive/formula/cache 如何切换都不能泄漏到 API。

6. **range 依赖不能靠创建 N 个空 atom 解决**
   第一阶段可以用 compact range 依赖线性扫描；后续必须上 range index，整列/整行引用不能展开成全部 cell atom。

## 非目标

- 不在第一步重写 `einfach_core::Store` 的通用 derived 语义。
- 不要求立刻做到 Excel 全量重算引擎。
- 不要求第一步优化 `SUM(A:A)` 到 O(changed cells)，但必须不创建整列空 atom。
- 不用 Solid/React 本地状态承载公式缓存或依赖图。
- 跨 sheet 环检测、primitive atom GC 不在本规划范围（见末尾"已知遗留"）。

## 关键决策（动手前已敲定）

以下 4 条是 review 阶段先纠结清楚的契约/形态决定，写在 step 之前避免 step 期间反复改方向。

### D1. formula 订阅语义改为"dirty 即通知"，不再保证"值真变才触发"

- **primitive cell 订阅**：保持精确值变化语义，跟现在一致。
- **formula cell 订阅**：dirty 即触发，可能是空触发（值实际未变）。

理由：lazy 的核心收益是"上游变化不立即重算"。若要保持值精确比对，就得在通知前先算公式 —— 直接把 lazy 收益吃光。

破坏性后果：依赖"subscriber fire 次数 == 值变化次数"的代码会观察到 fire 次数偏多。需在 Step 2 切换时：

- 显式更新 `Sheet::subscribe_cell` doc string 说明两种契约
- Solid `sheet-store.ts` 的 per-cell tick signal 已经吃 dirty 通知，OK；但 Step 2 验收必须跑一遍现有 demo 确认无可见回归
- 加测试钉住新契约：`subscribe(B1)` + `B1 = =A1*2`，向 A1 写同值 N 次，subscriber fire == N（dirty 触发），不是 == 0

### D2. dirty 传播 = 写时 BFS（而非读时级联检测）

写入 `set_cell(A1)` 时：

1. 收集 `cell_dependents[A1]` 直接下游公式集合
2. BFS 通过 `cell_dependents[fid_of_each]` 把所有传递下游也标 dirty
3. 一次性收集所有需要 notify 的 subscriber 地址，去重后通知

理由：读时级联检测要求每次 `eval_formula` 都重核所有依赖的 cache 时间戳，跟"读路径轻量"目标矛盾。写时 BFS 是 O(transitive dependents)，对正常表格规模可接受；BFS 一次性收集 notify 列表也能去重。

### D3. set_formula 同步契约：只覆盖 parse + 静态环

`set_formula(addr, text) -> bool` 返回值含义：

- `false` 当且仅当：parse 失败 / 静态依赖图发现环 / 跨 sheet ref 指向不存在的 sheet
- `true` 其它情况（包括"读取后会得到 #DIV/0!"、"#VALUE!" 等运行时错误）

UI 不能基于返回值假设"true 就一定能算出值"。运行时错误只能通过 `get_cell` 看到。

### D4. EvalContext 归属：Sheet 默认实现 + Workbook 注入实现

#### Borrow 形状（review 阶段必须先敲死）

`SheetEvalCtx { sheet: &'a Sheet }` 的最初草稿和 lazy 缓存写回有借用冲突 ——
`eval_formula(fid)` 需要在 cache miss 时把 `Computing` 写进 record、求值、再写
回 `Clean(value)`，但 ctx 只持 `&Sheet` 没法 mutate。换 `&mut Sheet` 又破坏
递归（同一公式 graph 上 A→B 时 A 的 borrow 还活着 B 拿不到 mut 借）。

正解：**lazy cache 用 per-record 内部可变性**，ctx 始终持 `&Sheet`。

```rust
pub struct FormulaRecord {
    addr: CellAddress,
    text: String,
    expr: Rc<Expr>,
    deps: RefCell<FormulaDeps>,         // 动态依赖在 eval 时回写
    cache: RefCell<FormulaCache>,        // 状态机本身就是写不下的
}

// Sheet 持有的 map 的 value 不需要 Wrap RefCell；逐 record 已经是
// RefCell 了。整体并发模型仍然是单线程 + 内部可变性。
formulas: HashMap<FormulaId, Rc<FormulaRecord>>,
```

为什么 Rc 包外层而不是用 `&FormulaRecord` 直接借出：递归 eval 时需要把当前
record 的引用沿 EvalContext 传下去。如果是 `&FormulaRecord`，那它的生命周
期绑在 sheet 的某一帧借用上，递归时 Rust borrow checker 会把整个 `&Sheet`
锁住，递归再借就拒。`Rc<FormulaRecord>` 把生命周期和 sheet 解耦，`borrow_mut`
仅锁单条 record，A→B 互不阻塞。

#### Trait 形状

```rust
pub trait EvalContext {
    /// 读单 cell。&self —— 无副作用，cache 命中也走这里。
    fn cell(&self, addr: CellAddress) -> Value;

    /// 读跨 sheet cell。SheetEvalCtx 默认返回 #REF!；
    /// WorkbookEvalCtx 委托给目标 sheet。
    fn sheet_cell(&self, sheet: &str, addr: CellAddress) -> Value;

    /// 流式遍历 range，f 被调用 (addr, value)。"流式" = 不创建 cell atom，
    /// 不要求 O(1) 内存。statefull 函数（MEDIAN/VLOOKUP）在闭包里自己
    /// 攒 Vec<Value>。
    fn for_each_range_cell(&self, range: CellRange, f: &mut dyn FnMut(CellAddress, Value));
}
```

`&self` 不是 `&mut self`：cache 写入通过 record 内的 `RefCell` 完成，trait
本身不必 mut。这让 ctx 可以被多次嵌套（递归 eval）而不需要拆 mut 借。

#### 两种实现

```rust
// 单 sheet 默认 ctx
pub struct SheetEvalCtx<'a> {
    pub sheet: &'a Sheet,
    /// 记录正在求值的 fid，eval 时 push，完成 pop。
    /// Computing 状态要立即可见（防递归环爆栈），所以单独维护。
    pub computing: RefCell<Vec<FormulaId>>,
}

impl<'a> EvalContext for SheetEvalCtx<'a> {
    fn cell(&self, addr: CellAddress) -> Value {
        // 1. 找 primitive
        if let Some(id) = self.sheet.primitive_atom(addr) {
            return self.sheet.store_get(id);
        }
        // 2. 找 formula
        if let Some(fid) = self.sheet.formula_at(addr) {
            return eval_formula(self.sheet, fid, self);
        }
        // 3. 空 cell — 把这个地址塞进当前正在求值 record 的 deps
        self.record_dep(addr);
        Value::Null
    }
    fn sheet_cell(&self, _sheet: &str, _addr: CellAddress) -> Value {
        Value::Error(ValueError::InvalidRef) // 单 sheet 没跨 sheet 概念
    }
    // ...
}

// Workbook 注入 ctx
pub struct WorkbookEvalCtx<'a> {
    pub wb: &'a Workbook,
    pub current: SheetIndex,
    pub computing: RefCell<Vec<(SheetIndex, FormulaId)>>,
}
```

`eval_formula(sheet: &Sheet, fid, ctx: &dyn EvalContext)` 是 free function
（不挂 Sheet 上）：因为 ctx 可能跨 sheet 切换 current，挂 Sheet 上反而绕。

#### 跨 sheet 求值流转

`WorkbookEvalCtx::cell(A1)` → 当前 sheet 的 cell。
`WorkbookEvalCtx::sheet_cell("Other", A1)` →
1. 解析 "Other" → SheetIndex
2. 拿 `&Workbook.sheets[idx]`（不可变借出 OK，因为整个 ctx 是 `&Workbook`）
3. 在该 sheet 的 formula record 上做 `eval_formula(other_sheet, fid, self)` —
   **复用同一个 ctx**，computing stack 共享，跨 sheet 环检测自然兜底
4. 求值过程中再遇到 `sheet_cell` → 递归

当前落地版已经让 Workbook 读路径脱离 TLS resolver。`with_cross_resolver`
和 TLS 仍保留给旧 `eval_expr(get, cell_map)` 兼容入口，后续可独立删除。

#### 为什么不用 `&mut self`

替代方案：trait 用 `&mut self`，ctx 内部直接持 `&mut Sheet`。但：

1. 递归 eval 同一 sheet 上 A→B 时，A 的 `&mut Sheet` 借用还在栈上，B 拿不到第二份 `&mut`。
2. cache hit 路径（最常见）也被迫拿 `&mut`，给后续多线程读放弃了语义自由度。
3. 跨 sheet 时 `WorkbookEvalCtx` 持 `&mut Workbook`，整个 wb 被锁，连读其他 sheet 都得排队。

`&self` + per-record `RefCell` 是这个场景的标准写法（参考 `salsa` / `serde`
的 deserializer pattern）。借用粒度从"整 sheet"降到"单 record"，递归 / 跨
sheet / 并发读都自然展开。

## 目标架构

公式从“core derived atom”迁移为 `Sheet` 层的 lazy formula node。primitive cell 仍然用 core atom 存值；公式结果由 `Sheet` 维护 AST、依赖、dirty/cache，并通过地址级订阅通知 UI。

```rust
struct FormulaId(u64);

enum CellSlot {
    Primitive(AtomId),
    Formula(FormulaId),
}

struct FormulaRecord {
    addr: CellAddress,
    text: String,
    expr: Rc<Expr>,
    /// 动态依赖在每次 eval 完成时被替换。RefCell 让 EvalContext 在
    /// `&self` 路径上完成回写（见 D4 borrow 设计）。
    deps: RefCell<FormulaDeps>,
    /// 状态机本身就是写不下的；RefCell 让 cache hit 路径走 borrow,
    /// miss 路径走 borrow_mut，且粒度仅锁单条 record（不锁整 sheet）。
    cache: RefCell<FormulaCache>,
}

struct FormulaDeps {
    cells: HashSet<CellAddress>,
    ranges: Vec<CellRange>,
    sheet_cells: Vec<(String, CellAddress)>,
    sheet_ranges: Vec<(String, CellRange)>,
}

enum FormulaCache {
    Uncomputed,
    Dirty,
    Computing,
    Clean(Value),
}
```

`Sheet` 需要维护：

```rust
slots: HashMap<CellAddress, CellSlot>,
primitive_cells: HashMap<CellAddress, AtomId>,
/// 用 Rc 包装，让 EvalContext 跨递归借出单 record 时不锁整个 map
/// （见 D4 "为什么 Rc 包外层"）。
formulas: HashMap<FormulaId, Rc<FormulaRecord>>,
formula_by_addr: HashMap<CellAddress, FormulaId>,
cell_dependents: HashMap<CellAddress, HashSet<FormulaId>>,
range_dependents: RangeDependencyIndex,
cell_subscriptions: HashMap<CellAddress, AddressSubscriptionBucket>,
```

旧 `formula_cells: HashMap<CellAddress, AtomId>` 形态必须被替换。当前落地实现
保留了 `formula_cells` 名称，但 value 已变成 `Rc<FormulaRecord>`；公式结果不再
必须有 `AtomId`。

## EvalContext 重构

trait 形状、归属、为什么 `&self`、为什么 `Rc<FormulaRecord>` —— 详见 D4。
本节只列求值时的具体行为：

- `Expr::CellRef(A1)` → `ctx.cell(A1)`。
- `Expr::Range(A1:B3)` 不预先创建 atom；按函数需要走 `for_each_range_cell` 流式拿值。
- `ctx.cell` 遇到 formula cell → 递归 `eval_formula(target_sheet, fid, ctx)`，cache 命中（`Clean(value)`）直接返。
- `ctx.cell` 遇到不存在的 cell → 返回 `Value::Null`，同时通过 ctx 内部的"current formula stack"找到当前求值 record，把该地址记进它的动态依赖集合（写 record 的 `RefCell<FormulaDeps>`）。
- 动态依赖函数（例如 `IF`）只记录实际执行分支读取到的依赖；eval 完成后用收集到的依赖替换 reverse index 中该 formula 的旧条目。

**Streaming 的边界**（需在文档里说清楚以免误解）：

- `for_each_range_cell` 的"streaming"指**不创建 cell atom**，不指"O(1) 内存"。
- `SUM/COUNT/AVERAGE/MIN/MAX` 是真 streaming，O(1) 累加状态。
- `MEDIAN/MODE/STDEV/VAR/LARGE/SMALL/VLOOKUP/HLOOKUP/INDEX/MATCH` 仍需临时 `Vec<Value>` 或 2D `Vec<Vec<Value>>`，但这只是 N 个 Value 的栈临时数据，不会污染 store。
- 整列引用 `SUM(A:A)` 在 range index 升级前先按 sparse range 处理（只遍历真实存在的 cell）。

**TLS resolver 的清算**：✅ 已完成。`with_cross_resolver` 函数族、
`CROSS_RESOLVER` / `CURRENT_SHEET` / `CROSS_SHEET_VISITED` 三个
thread_local、`CrossSheetResolver` trait、`unsafe { mem::transmute }`
全部从 `excel-core` 删除。grep `with_cross_resolver` / `thread_local!`
/ `mem::transmute` 在 `rust/excel-core/src/` 现在 0 命中。跨 sheet 通道
唯一路径是 `WorkbookEvalProvider`；legacy `eval_expr` 调 `AtomEvalProvider`
处理 single-sheet，`sheet_cell` 直接返 `#REF!`（没有 workbook 上下文也
无意义）。`Sheet`/`Workbook` 测试覆盖未减少。

## 写入与 dirty 传播

### `set_cell(addr, value)`

1. 如果 `addr` 原来是公式，删除 formula record 并从 reverse dependency index 摘除该 fid。
2. 仅对被写入地址物化 primitive atom。
3. 写入 primitive atom（按现有"值真变才触发"语义触发 primitive subscriber）。
4. **写时 BFS 标 dirty**（决策 D2）：
   - 起点：`cell_dependents[addr]` ∪ `range_dependents.lookup(addr)`
   - BFS 通过 `cell_dependents[fid]` 把所有传递下游也加进 dirty 集合
   - 单次写入收集去重，不会重复处理同一 fid
5. 一次性收集 dirty 集合中所有 formula 地址的订阅者（去重），通知它们。
6. 不计算任何公式。

### `set_formula(addr, text)`

1. parse 为 AST。失败 → 写 `#VALUE!`，返回 `false`（决策 D3）。
2. 静态收集直接依赖（cells、ranges、sheet refs）。
3. **静态环检测**：BFS 检查直接依赖里是否有路径回到 `addr`。命中 → 写 `#CYCLE!`，返回 `false`（决策 D3）。
4. 跨 sheet ref 指向不存在的 sheet → 写 `#REF!`，返回 `false`（决策 D3）。
5. 从 reverse index 摘除 `addr` 旧依赖（如有），写入新依赖。
6. 写入 `FormulaRecord { cache: Uncomputed }`。
7. 通过 D2 的 BFS 把所有下游公式标 dirty + 通知。
8. 通知 `addr` 自身的订阅者。
9. 不调用 `eval_expr`，不创建引用到的空 cell atom，返回 `true`。

返回 `true` 不代表"读取一定能得到值" —— 运行时错误（`#DIV/0!` / `#VALUE!` / 动态环 / 跨 sheet 跑空）只能通过 `get_cell` 看到。

### `get_cell(addr)`

1. 空地址返回 `Null`。
2. primitive cell 返回 atom value。
3. formula cell 调 `eval_formula(self, fid, &SheetEvalCtx::new(self))`。

### `eval_formula(sheet: &Sheet, fid: FormulaId, ctx: &dyn EvalContext) -> Value`

free function，不挂 `Sheet` impl 上 —— 跨 sheet 求值时 ctx 的 current 会切换，挂 Sheet 反而绕。

1. 拿 `Rc<FormulaRecord>` —— 拿出来后 sheet 借用就可以释放，递归求值时不会锁住整 map。
2. `record.cache.borrow()` 看状态：
   - `Clean(value)` → 返回，零开销
   - `Computing` → 返 `#CYCLE!`，并把所有还在 ctx.computing 栈上的 record 缓存写为 `Clean(#CYCLE!)`，避免下次再陷入
   - `Dirty` / `Uncomputed` → drop 借用，进入下面流程
3. `record.cache.borrow_mut()` 写 `Computing` → 立即 drop borrow（避免和 ctx 内部递归借冲突）
4. ctx.computing.borrow_mut().push((sheet_idx, fid)) → 立即 drop
5. ctx 求值 record.expr，过程中：
   - cell ref 命中 formula → 递归 eval_formula（用同一 ctx，computing stack 共享）
   - cell ref 命中空 cell → ctx 拿到 ctx.computing 栈顶找到 self，写进 self.deps（`record.deps.borrow_mut()`）
6. 求值完成 → `record.cache.borrow_mut() = Clean(value)`，pop computing stack
7. 用收集到的动态依赖替换 sheet 的 `cell_dependents` / `range_dependents` 中本 fid 的旧条目（动态依赖 ⊆ 静态依赖的子集，必须替换不能合并 —— 否则旧分支的 cell 写入仍会假触发）

**注意**：D1 之下 dirty 通知已在 `set_cell` / `set_formula` 阶段完成。`eval_formula` 不再触发任何 subscriber —— 它只算值，不通知。Subscriber 收到的是"上游可能变"的 dirty 信号，UI 拿到信号后调 `get_cell` 才走到这一步。

## Range 依赖索引

### 第一阶段：简单 compact index

先保留 `Vec<(CellRange, FormulaId)>`：

```rust
struct RangeDependencyIndex {
    ranges: Vec<(CellRange, FormulaId)>,
}
```

写入某个 cell 时扫描 ranges，命中则标 formula dirty。这个阶段复杂度是 O(range formula count)，但不创建空 atom，足够支撑过渡。

### 第二阶段：行列 interval index

当 benchmark 显示 range 扫描成为瓶颈，再升级：

- 行 range：`row -> interval tree of cols`
- 列 range：`col -> interval tree of rows`
- 矩形 range：按较短维度挂索引
- 整列引用：特殊 bucket，不展开到所有行

门禁：10 万个 range formula 时，单 cell 写入的 range dirty 查找不能线性扫全表。

## 与订阅的关系

地址级订阅继续保留，但契约按地址类型分裂（决策 D1）：

| 地址类型 | 触发语义 | 实现 |
|---|---|---|
| primitive cell | 值真变才触发（与现有一致） | Store subscription on primitive atom，fanout 走当前 `AddressListenerFanout` |
| formula cell | dirty 即触发，可能空触发 | Sheet 在 `set_cell` / `set_formula` 的 BFS 步骤里直接 `dispatch_listeners(bucket.listeners)` |

primitive 写入流程：

1. primitive atom `set` → 已有 fanout 按值变化触发 primitive subscriber
2. 同步 BFS 标 dirty 收集下游 formula 集合
3. 对集合中每个 formula 地址 `dispatch_listeners`（dirty 通知，无视值是否变）
4. UI 收到通知后调 `get_cell` → 这时才走 `eval_formula` 算值

合并 dispatch：步骤 1 和 3 可能命中同一地址（primitive cell 自己被订阅 + 是 formula 依赖），需要在 BFS 收集时去重，确保单地址单次触发。

**契约破坏点**：现在的代码 + 我刚收紧的精确次数测试假设 "subscriber fire 次数 == 值变化次数"。Lazy 之后对 formula subscriber 该假设破裂。**升级前必须**：

1. `Sheet::subscribe_cell` doc string 标注两种语义
2. 现有 sheet.rs 测试中针对 formula 的精确次数断言需要重写（标注"primitive 路径精确值，formula 路径 dirty 通知"）
3. 跑一遍 `solid/excel` demo 的 5 个页面 + DemoFormulas，确认无可见回归（Solid per-cell tick signal 已经按 dirty 通知设计，但要实测）

## 与 undo / redo / import 的关系

Undo/redo snapshot 需要存：

- primitive value
- formula text
- formula cache 不入 snapshot

导入流程使用 RAII 风格 bulk API（仿照 core 的 `BatchGuard`，避免 begin/end 漏配对）：

```rust
pub fn bulk_load<R>(&mut self, f: impl FnOnce(&mut BulkLoader<'_>) -> R) -> R;

pub struct BulkLoader<'a> { sheet: &'a mut Sheet }

impl BulkLoader<'_> {
    pub fn set_cell(&mut self, addr: &str, value: Value);
    pub fn set_formula(&mut self, addr: &str, text: &str) -> bool;
}
```

bulk load 期间：

- 只写 primitive atom / formula record / 静态依赖索引
- 不做 D2 的 BFS 标 dirty
- 不逐条通知任何 subscriber

退出 `bulk_load` 时（Drop / 显式 flush）：

- 把整个 bulk 期间的所有写入合并成一组 dirty 集合
- 对当前已有订阅的地址做一次 BFS 标 dirty 并通知
- 对完全没有订阅的地址直接跳过通知（lazy 的极致：没人看就一直不算）

## 实施步骤

### Step 0：性能与状态计数门禁

新增 debug/test-only 计数 / 探针 API（feature `debug-counters` gated，release 编译丢弃）：

- `Sheet::debug_primitive_atom_count()` —— 当前 store 中 primitive atom 数
- `Sheet::debug_formula_count()` —— FormulaRecord 总数
- `Sheet::debug_formula_eval_count()` —— 累计 eval_formula 调用次数（含 cache hit / miss 区分）
- `Sheet::debug_dirty_formula_count()` —— 当前 cache 状态为 Dirty 的 formula 数
- `Sheet::debug_dependents_count(addr)` —— 直接依赖 `addr` 的 formula 数（cell + range 都算）
- `Sheet::debug_cache_state(fid)` —— 返回当前 cache 状态枚举（Uncomputed / Dirty / Computing / Clean）

新增 benchmark / repro 测试：

- 导入 100000 个公式不读取，`formula_eval_count == 0`
- 读取 100 个 viewport formula，`formula_eval_count == 100`
- 公式引用空白 cell 后，primitive atom count 不增加
- 后续写入这个空白 cell → 依赖公式 cache 状态从 `Clean` / `Uncomputed` 变 `Dirty`

### Step 1：抽出 EvalProvider + Workbook provider（✅ 完成）

把求值入口拆成两层：保留旧 `eval_expr(expr, get, cell_map)` 兼容 API，
新增 `eval_expr_with_provider(expr, provider: &dyn EvalProvider)`：

- ✅ `EvalProvider` trait 落地，求值器按地址读取 cell，不要求每个引用都有 `AtomId`
- ✅ `Sheet` 默认 `SheetEvalProvider` + `WorkbookEvalProvider` 两实现
- ✅ `Workbook::get_cell` 走 provider 链递归，已替代旧 resolver scope + silent derived recompute bridge
- ✅ `eval.rs::with_cross_resolver` / `CrossSheetResolver` trait / 3 个 thread_local / `unsafe mem::transmute` 全部从 excel-core 删除
- ✅ legacy `AtomEvalProvider::sheet_cell` 简化为永返 `#REF!`（无 workbook 上下文也无意义）

验收：

- ✅ 现有公式测试全过（包括跨 sheet 8 条 cycle / 4 条 workbook lazy / 3-sheet chain demo）
- ✅ Workbook 读路径不再触发 core derived recompute
- ✅ grep `with_cross_resolver` / `CrossSheetResolver` / `thread_local!` / `mem::transmute` / `CROSS_RESOLVER` / `CURRENT_SHEET` / `CROSS_SHEET_VISITED` 在 `rust/excel-core/src/` 均 0 命中

### Step 2：lazy formula 主体（主体已完成，无 feature flag）

合并原 Step 2 + Step 3 —— 引入 FormulaRecord 单独上线意义不大（依赖收集只能用假数据测）；当前实现未加 feature flag，直接替换旧 derived formula 路径。

新增结构：

- 已完成：`FormulaRecord`, `FormulaCache`, `cell_dependents`
- 未完成：`range_dependents` interval index、`BulkLoader` RAII、完整 eval/debug 计数

行为变化：

- `set_formula` 不再 `create_derived`，只写 record + 更新 reverse index
- `set_cell` 通过 D2 BFS 标 dirty + 通知（不计算）
- `get_cell` 遇 formula 走 `eval_formula` 走 lazy cache
- formula subscriber 收到 dirty 通知（D1 契约切换）
- `Store::propagate_force` 不再被 sheet 调用（保留 API 但 sheet 路径全部不走）

验收：

- 100000 set_formula 后 `debug_formula_eval_count == 0`
- 读取 100 个 viewport formula 后 `debug_formula_eval_count == 100`
- 公式链 `=A1+1`/`=B1+1`/`=C1+1` 读取尾端时只算尾端 + 路径上未缓存的环节
- 静态环 / 自引用 / 互引用 → `set_formula` 返回 false + cell = `#CYCLE!`，不栈溢出
- `IF(A1>0, B1, C1)` 动态依赖切换：A1 从正变负后写 B1 不再触发本公式 dirty
- 跑一遍 Solid demo 5 页 + DemoFormulas，无可见回归

### Step 3：bulk import API ✅

`bulk_load(|loader| { ... })` 上线，CSV/JSON/xlsx 导入接入。

#### 落地 API 形态（RAII，非 begin/end）

最终选了 RAII 闭包，原始草稿讨论过 `begin_bulk` / `end_bulk` 但被否：begin/end
要求 caller 配对，错过 end 就把 sheet 永远卡在 quiesced 状态。RAII 闭包让
borrow checker 替我们守门 —— `BulkLoader` 不暴露出 `bulk_load` 闭包外，flush
保证执行。

```rust
impl Sheet {
    pub fn bulk_load<R>(&mut self, f: impl FnOnce(&mut BulkLoader<'_>) -> R) -> R;
}

pub struct BulkLoader<'a> {
    sheet: &'a mut Sheet,
    touched: HashSet<CellAddress>,
}

impl BulkLoader<'_> {
    pub fn set_cell(&mut self, addr: &str, value: Value);
    pub fn set_formula(&mut self, addr: &str, text: &str) -> bool;
    // flush() 私有，由 bulk_load 在闭包返回后自动调
}
```

#### 行为契约

bulk 期间：
- `set_cell` / `set_formula` 把地址记进 `touched`，写入 primitive atom / formula
  record / 静态依赖索引
- 不做 D2 的 BFS 标 dirty，不通知任何订阅者
- 写入前 `detach_address_sub(addr)`，让底层 `store.set` 不通过 fanout 同步触发；
  flush 时再 `attach_address_sub` 重连
- `set_formula` 仍跑 same-sheet 静态环检测 (B.2 `would_create_cycle`) —— 增量
  cycle protection 不值得为 perf 放掉，且代价仅 O(新公式依赖闭包)
- 解析失败 / 静态环命中：cell 写 `#VALUE!` / `#CYCLE!`，返回 `false`，**不通知**

flush 时：
- BFS 通过 `cell_dependents` 从每个 `touched` 出发，收集传递下游公式集合 `dirty`
- 对 `dirty` 中每个 formula record 把 `cache` 置 `Dirty`
- 重连每个 `touched` 地址的 fanout
- 对 `touched ∪ dirty` 中**当前有订阅**的地址 `notify_address_subscribers`，
  每地址恰好一次；无订阅的地址直接跳过（lazy 极致：没人看就一直不算）

#### 复杂度

flush 的 BFS：O(T + D)，T = `touched.len()`，D = 从 touched 出发可达的下游
公式闭包大小。通知去重 O(1) per address via HashSet。空集快速路径不分配。

#### CSV 导入接入

`csv.rs::import_csv` 已迁移到 `sheet.bulk_load(|loader| ...)`；每个字段调
`loader.set_cell` / `loader.set_formula`，不再走每 cell notify path。

#### 验收

- ✅ `bulk_load_set_formula_zero_eval_count`：100 公式 bulk 后 `debug_recompute_count` delta 为 0
- ✅ `bulk_load_notifies_subscribers_once`：5 个订阅地址各触发恰好 1 次
- ✅ `bulk_load_skips_eval_until_first_read`：bulk 后 `debug_formula_cache_state("B1") == "dirty"`，首次 `get_cell` 后变 `clean`
- ✅ `bulk_load_cycle_check_still_runs`：bulk 内 set_formula 命中环返回 false，读取返回 `#CYCLE!` 不栈溢出
- ✅ `bulk_load_unsubscribed_addresses_not_notified`：写无订阅地址不触发 recompute / notify

#### 已知遗留 / 后续路线

- 10 万公式 import 的 wall-clock benchmark 还没在仓库里钉死（criterion harness 是 TODO 2.5）
- bulk_load 同地址多次写入会被多次记入 touched，但 HashSet dedup 后只算一次 notify
  source。如果 bulk 期间通过 set_cell→set_formula→set_cell 反复切 cell 类型，
  fanout detach/attach 会跑多次 —— 实际影响只是常数倍，没有正确性问题

### Step 4：range streaming 改造

把现有 `collect_range_values` 的 `Vec<Value>` 收集改成 ctx-driven：

- `SUM/COUNT/AVERAGE/MIN/MAX/COUNTIF/SUMIF` 走 `for_each_range_cell` 的真 streaming（O(1) 累加状态）
- `VLOOKUP/HLOOKUP/INDEX/MATCH/MEDIAN/MODE/STDEV/VAR/LARGE/SMALL` 仍允许临时 Vec（算法本身要求），但**不能创建 cell atom**
- 整列引用 `SUM(A:A)` 在 ctx 内按 sparse 实际存在的 cell 遍历，不展开

### Step 5：range dependency index 升级

range formula 数量起来后再做：

- 行 range：`row -> interval tree of cols`
- 列 range：`col -> interval tree of rows`
- 矩形 range：按较短维度挂索引
- 整列引用：特殊 bucket，不展开到所有行

门禁：10 万 range formula 时单 cell 写入的 range dirty 查找不能线性扫全表。

### Step 6：feature flag 拆除 + 旧路径删除

- 删除旧 `formula_cells: HashMap<CellAddress, AtomId>` 形态；当前 `formula_cells`
  已是 `HashMap<CellAddress, Rc<FormulaRecord>>`
- 删除 sheet 公式路径上的 `Store::create_derived` 调用（已完成）
- 删除 sheet 公式路径上的 `Store::propagate_force` 调用（已完成）
- 删除 `with_remap` 的 formula→primitive 分支（不再有 derived atom 需要 swap）

验收：sheet 公式路径 grep 不再出现 `Store::create_derived` / `Store::propagate_force`；
`formula_cells` 名称仍可存在，但 value 不能再是 `AtomId`。

## 测试清单

### 正确性

- `=A1+B1` 首次读取时 B1 不存在，返回 A1；后续写 B1，公式 dirty，读取后更新。
- `=IF(A1>0,B1,C1)` 只追踪实际分支；A1 改变后依赖分支切换，旧分支写入不再影响公式。
- `=SUM(A1:A10)` 对空范围返回正确值，且不创建 10 个 atom。
- `=A1` 公式未读取前 A1 多次变化，首次读取拿到最新值。
- 自引用、互引用、间接环 → `set_formula` 返回 false + cell = `#CYCLE!`，不栈溢出。
- parse 失败 / 静态环 / 跨 sheet ref 找不到 sheet → `set_formula` 返回 false（D3 契约）。
- 运行时错误（`#DIV/0!`、`#VALUE!`、动态环）→ `set_formula` 返回 true，`get_cell` 看到错误（D3 契约）。

### 订阅契约（D1）

- **primitive subscriber**：`subscribe(A1)` + 写 A1 同值 N 次，fire 次数 == 0。
- **formula subscriber dirty 语义**：`subscribe(B1)` + `B1 = =A1*2`，向 A1 写**同值** N 次，fire 次数 == N（dirty 通知，不是值变化通知）。
- **去重**：`subscribe(B1)` + `B1 = =A1*2`，单次 `set_cell(A1, ...)` 只让 B1 fire 一次，不因 BFS 经过多条路径重复触发。
- **fire 后 lazy**：subscriber callback 内不调 `get_cell` → `debug_formula_eval_count` 不变。
- **unsubscribe** 后 dirty notify 不再触发。

### 性能

- 100000 formula import：eval count 为 0。
- 100000 formula import 后读取 100 个：eval count 在 [100, 依赖链总长] 区间，不接近全表。
- 100000 空白 cell viewport subscribe：primitive atom count 为 0。
- `SUM(A1:A100000)` 首次读取不创建空 cell atom（实际遍历 sparse）。
- 单 cell 写入只 dirty 相关公式（用 `debug_dirty_formula_count` 在写前后对比），不全表 dirty。
- bulk_load 导入 10 万公式：eval 时间占 < 5%（profile 验证）。

### WASM / UI

- `WasmSheet.subscribe("B1", cb)` 后，A1 变化只让 B1 dirty，callback 触发后 JS 读取 B1 才计算。
- viewport 外公式不因 viewport 内写入而计算，除非它是被订阅公式的依赖。
- unsubscribe 后 dirty notify 不再触发。
- Solid demo 5 页 + DemoFormulas 实际跑一遍，formula bar、公式编辑、键盘 undo/redo 全部无可见回归（Step 2 验收硬门禁）。

## 风险与决策点

### Dirty 通知是否保持"值真的变才通知"

→ 已敲定见 D1：primitive 保持精确，formula 改 dirty 通知。

### 动态依赖是否第一阶段支持

必须支持。`IF` 只用静态 deps 会造成过多 dirty；性能不可接受。EvalContext 在求值时收集实际 deps，cache 更新时替换 reverse index 对应条目（不能 union，必须替换，否则旧分支变化仍会假触发）。

### 是否把 lazy 下沉到 core Store

暂不下沉。Excel 需要依赖不存在的 cell、range、cross-sheet，这些是 Sheet/Workbook 领域概念。先在 `excel-core` 做 lazy formula graph；如果未来 core 层也需要 lazy derived，再抽象通用能力。

## 已知遗留（不在本规划范围）

以下问题与 lazy formula 相关但**不解决**，单独 issue 跟踪：

- **跨 sheet 环检测**：当前 `would_create_cycle` 只看本 sheet `formula_exprs`，跨 sheet 环（Sheet1!A1 = Sheet2!A1+1，Sheet2!A1 = Sheet1!A1+1）漏检。Workbook 层面环检测需要 workbook-wide 反向依赖图，不属于 lazy 范围 —— 但 lazy 主体上线时运行时 `Computing` 状态会兜底（不会栈溢出），可见错误是 `#CYCLE!`，可接受。
- **primitive atom GC**：`set_cell(addr, Value::Null)` 不释放 primitive atom，长期运行会缓慢增长。lazy 不解决这个，但在 Step 6 删旧路径时可顺便加 `clear_cell` 真正释放。

## 里程碑门禁

完成本规划后，以下结论必须成立（每条配对应的测试或 grep）：

| 门禁 | 验证方式 |
|---|---|
| 导入公式不计算公式 | `debug_formula_eval_count == 0` after bulk import |
| 读取空 cell 不创建 atom | `debug_primitive_atom_count` 不变 before/after `get_cell` on empty |
| 公式引用空 cell 不创建 atom | `set_formula("=Z99")` 后 Z99 对应 atom count == 0 |
| 订阅空 cell 不创建 atom | `subscribe_cell("Z99")` 后 atom count == 0（已实现） |
| 公式依赖空 cell 后写入能 dirty | 写 Z99 后 `debug_cache_state(fid) == Dirty` |
| range 依赖不通过展开空 atom | `set_formula("=SUM(A1:A100000)")` 后 atom count 不增加 |
| viewport 是计算边界 | 只读 viewport 后 `debug_formula_eval_count == viewport size` |
| Workbook 读路径不走 TLS resolver | ✅ `Workbook::get_cell` 用 `WorkbookEvalProvider` |
| Legacy TLS resolver 已删除 | ✅ grep `with_cross_resolver` / `thread_local!` / `mem::transmute` / `CrossSheetResolver` / `CROSS_RESOLVER` / `CURRENT_SHEET` / `CROSS_SHEET_VISITED` 在 `rust/excel-core/src/` 均 0 命中 |
| 旧 derived 路径已删除 | sheet 公式路径不调用 `Store::create_derived` / `Store::propagate_force`；`formula_cells` value 不是 `AtomId` |
| EvalContext 用 `&self`，cache 用 `RefCell` per-record | grep `&mut dyn EvalContext` / `EvalContext for .*&mut` 在 excel-core == 0 |
| FormulaRecord 用 Rc 包装 | type alias 形如 `Rc<FormulaRecord>` 在 sheet 内可见 |
