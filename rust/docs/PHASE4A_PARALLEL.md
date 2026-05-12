# Phase 4A — 跨 Sheet Range Parser 收尾计划

> 日期：2026-05-12
>
> Companion to `ONLINE_SPREADSHEET_PLAN.md` 和 `HANDOFF.md` 的 Option A。
> Phase 1–4 已完成百万 cell 主线的核心、索引、workbook dirty graph、
> 2D viewport。Phase 4A 只关闭一个 Phase 3 遗留小尾巴：解析
> `Sheet2!A1:A100` 这类跨 sheet range，使已 wiring 的
> `CrossSheetRef::Range` 真正可达，并解除 `cross_sheet_range_dirty` 的
> ignore。

## 上一阶段留下的问题

`rust/excel-core/src/workbook.rs` 已经有 `CrossSheetRef::Range`、每 source
sheet 一个 `RangeDependentIndex`、dirty fanout、cycle BFS 分支；测试
`rust/excel-core/tests/cross_sheet.rs::cross_sheet_range_dirty` 也已经写好。

缺口只在 parser：当前 `formula.rs` 能解析：

- `Sheet2!A1`：跨 sheet 单 cell；
- `A1:A100`：本 sheet bounded range；
- `A:A` / `1:1`：本 sheet whole-col / whole-row；

但不能解析：

- `Sheet2!A1:A100`
- `Sheet2!A:A`
- `Sheet2!1:1`

因此 Phase 3 的 cross-sheet range graph 虽然已接线，却没有 AST 节点入口。

## 架构决策

保持现有 workbook / lazy eval 架构，只新增最小 AST variant。跨 sheet range
用已经存在的 `Expr::SheetRef { sheet, addr }` 和
`Expr::Range { start, end, unbounded }` 组合无法表达，因此本阶段采用：

```rust
Expr::SheetRange {
    sheet: String,
    start: CellAddress,
    end: CellAddress,
    unbounded: RangeBounds,
}
```

选择 `SheetRange` variant 的原因：

- 不破坏现有 `SheetRef` 单 cell 语义。
- `collect_cross_sheet_refs` 可以直接映射到 `CrossSheetRef::Range`。
- `eval_expr_with_provider` 可以用 `provider.for_each_sheet_range_cell`
  之类的后续扩展；本阶段只需让函数参数中的 `SUM(Sheet2!A1:A100)` 能
  走已存在 workbook provider range 路径。如果现有 provider 已有等价入口，
  优先复用，不做大重构。

实现时先让 `Sheet2!A1:A100` 通过；whole-col / whole-row 的跨 sheet 形式留到
后续阶段，避免在当前 patch 中扩大 parser grammar 和 unbounded range 风险。

## Tracks

| Track | Owner | Scope | Effort | Parallelism |
|---|---|---|---|---|
| **A** | Parser AST | `rust/excel-core/src/formula.rs` | 0.5–1 d | 可先行 |
| **B** | Workbook integration | `rust/excel-core/src/workbook.rs`, `rust/excel-core/src/eval.rs` | 0.5–1 d | 依赖 A 的 AST 形状 |
| **C** | Tests / un-ignore | `rust/excel-core/tests/cross_sheet.rs`, formula parser tests | 0.5 d | 可先写 red tests，最终等 A/B |

## 文件冲突矩阵

|  | A | B | C |
|---|---|---|---|
| **A** | — | AST enum 会影响 B，先合 A | 无直接冲突 |
| **B** | 依赖 A 的 AST variant | — | 可能都 touch `cross_sheet.rs`，C 最后合 |
| **C** | 无 | 测试跟随 B 的行为 | — |

主线集成顺序：A → B → C。

## Track A — Parser AST

### 目标

`parse_formula` 能解析 bounded cross-sheet range：

```rust
=SUM(Sheet2!A1:A100)
```

可选追加：

```rust
=SUM(Sheet2!A:A)
=SUM(Sheet2!1:1)
```

### 要求

- 保持 `Sheet2!A1` 原行为不变。
- 不支持带空格/引号的 sheet name，本阶段不扩展 Excel sheet-name grammar。
- 不引入 eager eval。
- Parser test 要覆盖：
  - single cell：`=Sheet2!A1`
  - bounded range：`=SUM(Sheet2!A1:A100)`
  - invalid range：`=SUM(Sheet2!A1:)` 返回 None

### Stop Conditions

- 如果新增 `SheetRange` 会迫使大量 eval 函数签名重写，停下并改成
  “在 `FuncCall` args 中把 `Sheet2!A1:A100` lowering 成内部 helper 节点”。

## Track B — Workbook Integration

### 目标

AST 的 cross-sheet range 能进入现有 workbook graph：

- `collect_cross_sheet_refs` 产生 `CrossSheetRef::Range`。
- `WorkbookEvalProvider` 能对 `SUM(Sheet2!A1:A100)` 提供值。
- `cross_sheet_cycle` 的 range arm 继续工作。

### 要求

- 不改 direct `Sheet::set_cell` 的语义。跨 sheet dirty 仍只通过
  `Workbook::set_cell` / `Workbook::set_formula`。
- 不改 CI workflow。
- 不做 worker bulk API，这是 Phase 5。

### 验收

```sh
cd rust/excel-core && cargo test --test cross_sheet cross_sheet_range_dirty -- --exact
cd rust/excel-core && cargo test --lib workbook
```

## Track C — Tests / Un-ignore

### 目标

解除 `cross_sheet_range_dirty` 的 ignore，并补 parser 单测。

### 要求

- 删除 `#[ignore = "..."]`。
- 更新 `cross_sheet.rs` 顶部注释，移除“parser 不支持”的 deferred 描述。
- 如果 whole-col / whole-row cross-sheet range 本阶段也支持，补对应测试；
  否则明确留到 Phase 5/6，不要扩大当前 patch。

### 验收

```sh
cd rust/excel-core && cargo test --test cross_sheet
cd rust/excel-core && cargo test --lib formula
cd rust/excel-core && cargo bench --no-run
```

## Pipeline

1. 主线提交本计划文档。
2. Agent A/B/C 并行读代码，A 先出 parser patch，B 审 workbook surfaces，C 准备测试改动。
3. 主线按 A → B → C 集成。
4. 跑 targeted tests。
5. 如果 targeted green，再跑 handoff 推荐的 Rust gate：
   - `cargo test --lib`
   - `cargo test --test cross_sheet`
   - `cargo bench --no-run`

## 非目标

- 不改 `.github/workflows/*`。
- 不 push。
- 不 amend。
- 不做 Phase 5 worker authoritative RPC。
- 不做 sheet name quoting grammar。
- 不清理 pre-existing clippy baseline。
