# Phase 2 — Parallel Execution Plan

> Date: 2026-05-12
>
> Companion to `ONLINE_SPREADSHEET_PLAN.md` § Phase 2. Phase 1 closed the
> P0 correctness gap (range deps survive sparse-eval narrowing) and
> introduced the typed `range_dependents` index. Phase 2 makes the same
> contract scale to 100k range formulas + 1M-cell sparse sheets without
> per-write linear scans.

## What Phase 1 Left

Phase 1 stored `range_dependents` as `HashMap<CellRange, HashSet<CellAddress>>`
and the dirty-write helper `Sheet::dependents_of(addr)` does a linear
`range_dependents.iter().filter(|r| r.contains(addr))` scan
(sheet.rs:1485 region). For today's demo this is fine; for 100k range
formulas it's a per-write O(N) scan.

Phase 1 also kept the primitive cell storage as `cells: HashMap<CellAddress, AtomId>`.
The sparse iter `Sheet::for_each_range_cell` walks the full `cells` map
and filters by range — O(non_empty_count), not O(cells_in_range). At
1M non-empty cells reading a 50×27 viewport, that's ~1M iterations per
range read.

Parser-wise, `Expr::Range { start, end }` always has both corners
bound. `=SUM(A:A)` / `=SUM(1:1)` whole-column / whole-row syntax
doesn't parse, which forces users into the verbose
`=SUM(A1:A1048576)`.

## Tracks

| Track | Owner | Scope | Effort | Parallelism |
|---|---|---|---|---|
| **E** | Interval index for range deps | `sheet.rs` `range_dependents` storage + `dependents_of`. Replace HashMap with a row-bucketed + col-bucketed pair, plus whole-row / whole-col special buckets when Track G lands `Unbounded` corners. Lookup must be O(matches), not O(range_count). | 3–4 d | sequential — owns the structural change |
| **F** | Sparse value index | `sheet.rs` `cells` storage + `for_each_range_cell`. Replace `HashMap<CellAddress, AtomId>` with a row-indexed structure (`BTreeMap<u32, BTreeMap<u32, AtomId>>` or equivalent) so range reads visit only the rows the range overlaps. | 2–3 d | parallel with E (different `Sheet` regions) |
| **G** | Whole-row / whole-col parser | `formula.rs` parser, `Expr::Range` enum (corner becomes `RangeCorner::Cell(CellAddress) | RangeCorner::WholeRow(u32) | RangeCorner::WholeCol(u32)`), and propagation through `collect_range_refs`, `eval_expr`, `for_each_range_cell`, `shift::map_addrs`. | 2–3 d | **after** E and F land — touches both their data shapes |
| **H** | Bench + scale tests | `benches/scale_bench.rs` extension (100k range formula dirty lookup) + `tests/scale.rs` additions for the new Phase 2 acceptance properties. | 1 d | parallel with E and F |

## File Conflict Matrix

|  | E | F | G | H |
|---|---|---|---|---|
| **E** | — | sheet.rs different regions; conflict only if methods reorder | depends on E's index shape | no |
| **F** | (above) | — | depends on F's iter shape | no |
| **G** | — | — | — | no |
| **H** | sheet.rs is read-only for H | — | — | — |

Most likely real conflict: E and F both edit `Sheet::new()` (struct
init) and `Sheet::set_cell` / `clear_cell` (mutation paths). Mitigation:
each track makes its struct field addition a single self-contained
commit landing first; method edits ride on top.

## Sequencing

```
Day 0:  E starts ─┐
        F starts ─┤  three parallel
        H starts ─┘
Day 1:  H merges (bench + scale-test scaffolding)
Day 2:  E merges (interval index, dependents_of O(matches))
Day 3:  F merges (sparse value index, for_each_range_cell O(range))
Day 4:  G starts (parser + Expr enum change rippling through both)
Day 5:  G merges
```

## Track E — Interval Index for `range_dependents`

**Problem**: `dependents_of(addr)` currently scans every registered
range to find ones that contain `addr`. With 100k range formulas, a
single cell write costs 100k `CellRange::contains` calls before any
dirty propagation work begins.

**Target**: lookup that's O(matches), not O(N). For an addr (r, c), the
ranges containing it are exactly those where
`start.row ≤ r ≤ end.row` AND `start.col ≤ c ≤ end.col`.

**Suggested first cut** (Agent E's choice — start simple):

- Two interval-index halves: `row_index: HashMap<u32, Vec<CellRange>>`
  keyed by *every row the range covers*, and similarly for columns. To
  find ranges containing (r, c), intersect `row_index[r]` with
  `col_index[c]`.
- For row buckets sized in the thousands this is cheap. For ranges
  spanning a million rows it's NOT cheap to register, so add a
  size-cutoff fallback: ranges larger than `WIDE_RANGE_BUCKET_THRESHOLD`
  (e.g. 4096 rows or cols) go into a separate `wide_ranges: Vec<CellRange>`
  that always gets linearly scanned. 100k narrow ranges are then fast;
  the small number of "whole sheet" ranges get the old behavior.
- Once Track G lands `Unbounded` corners, route those into the
  `wide_ranges` (or a new whole-col / whole-row bucket) — they never go
  in the row/col indexes.

**Acceptance**:

- New unit test: 100k registered single-cell-width ranges; one cell
  write hits only ranges containing that cell (bench measures this).
- `Sheet::debug_range_dep_count()` API stays unchanged — only the
  storage swaps.
- Existing 6 scale tests + the Phase 1 unit tests stay green.

**DO NOT touch**: `cells` storage (Track F), `Expr::Range` enum (Track G),
benches (Track H), wasm bindings, frontend.

## Track F — Sparse Value Index

**Problem**: `for_each_range_cell(range, f)` iterates `cells` (and
`formula_cells`) and filters by `range.contains(addr)`. Read cost is
O(total non-empty cells), not O(cells in range).

**Target**: O(cells_in_range) reads.

**Suggested first cut**:

- Replace `cells: HashMap<CellAddress, AtomId>` with
  `cells_by_row: BTreeMap<u32, BTreeMap<u32, AtomId>>`. Outer key is
  row, inner key is column.
- `for_each_range_cell(range, f)` iterates `cells_by_row.range(min_row..=max_row)`,
  then per row iterates `inner.range(min_col..=max_col)`. Both halves
  are O(visited cells + log).
- Keep `formula_cells` mirroring the same shape so range reads of
  formulas (e.g. SUM over a range that includes formula cells) stay
  O(matches).
- All existing public methods (`set_cell`, `get_cell`, etc.) keep the
  same signatures; only internal storage shape changes.

**Acceptance**:

- New scale test: 1M-coord sheet with 10k scattered non-empty cells;
  reading a 50×27 viewport visits ≤ 50 rows × 27 cols, not 10k.
- Existing 198 lib tests + 6 scale tests + 4 review_repro all stay
  green.
- Benchmark `sparse_1m_grid_read_window` (already in scale_bench.rs)
  should noticeably speed up on this commit.

**DO NOT touch**: `range_dependents` (Track E), `Expr::Range` enum
(Track G), benches outside scaffolding adjustments.

## Track G — Whole-Row / Whole-Col Parser

**Problem**: users have to write `SUM(A1:A1048576)` for "all of column A".
Excel/Sheets accept `SUM(A:A)` and `SUM(1:1)`.

**Target**: `A:A`, `A:C` (cols A through C), `1:1`, `1:3` (rows 1
through 3) all parse and evaluate.

**Suggested shape**:

- `Expr::Range` becomes `Expr::Range { start: RangeCorner, end: RangeCorner }`
  where `RangeCorner` is one of `Cell(CellAddress)`, `WholeRow(u32)`,
  `WholeCol(u32)`. Existing call sites that pattern-match `Range { start, end }`
  expecting `CellAddress` need to be adjusted (likely a small number —
  use grep to enumerate).
- Parser: accept `<letters>:<letters>` and `<digits>:<digits>` at the
  same precedence as `<addr>:<addr>`.
- `collect_range_refs` emits the canonical CellRange for the corners.
  For unbounded ranges, store a dedicated `WholeCol(col)` /
  `WholeRow(row)` flag in the range tracker and skip them from the
  row/col bucket indexes (Track E feeds them into `wide_ranges`).
- `for_each_range_cell` clamps unbounded corners to the actual sheet
  extents derived from `cells_by_row` (Track F).
- `shift::map_addrs` shifts the bounded corner of half-unbounded
  ranges; whole-col / whole-row ranges are invariant under row/col
  insert/delete.

**Acceptance**:

- Parser test: `parse_formula("=SUM(A:A)")` returns the right `Expr`.
- Eval test: `=SUM(A:A)` with A1..A10 set sums all 10.
- Lazy test: `=SUM(A:A)` does NOT materialize empty cell atoms in
  the 1M-row coordinate space.

## Track H — Bench + Scale Tests

**New bench** in `benches/scale_bench.rs`:

- `bench_dirty_lookup_100k_ranges` — set up 100k narrow ranges (e.g.
  `=SUM(A{r}:A{r}+5)` for r in 1..100k, each only 6 rows tall),
  perform a single `set_cell` on an address that hits, say, 3 of
  those ranges. The timed section is the `set_cell` call. Without
  Track E, this is O(100k) per write; with Track E, it's O(3 + log).

**New scale tests** in `tests/scale.rs`:

- `single_write_with_100k_range_formulas_is_bounded` — same setup as
  the bench but assert that `set_cell` completes in under, say, 50ms
  on a baseline test machine. Tight enough to catch a regression but
  loose enough to survive normal CI noise.
- `range_read_1m_sparse_visits_only_range` — reuses the sparse 1M
  setup; uses a probe (new debug counter or existing
  `debug_primitive_atom_count` diff) to assert the read didn't visit
  cells outside the range.

**Acceptance**: bench compiles via `cargo bench --no-run`; tests pass
once Tracks E + F land.

## Phase 2 Acceptance Roll-Up

- 100k range formulas + 1 cell write: bounded by matches, not by N
  (Track E + Track H bench).
- 1M non-empty cells + small range read: O(range cells) visited
  (Track F + Track H test).
- `=SUM(A:A)` parses and evaluates lazily (Track G).
- Phase 1 acceptance (all 6 scale tests) still green.
- No `cargo clippy --lib` regressions vs the Phase 1 baseline (the
  pre-existing 6 errors in `shift.rs` / `eval.rs` / `format.rs` /
  `formula.rs` / `sheet.rs` doc-list are out of scope here too).

## Stop Conditions

- Track E's row+col index makes registration slow enough to dominate
  the bench. If so, fall back to keeping a coarse spatial hash (e.g.
  64×64 cell tiles) and stop trying to enumerate every covered
  row/col.
- Track F's BTreeMap-of-BTreeMap memory overhead exceeds the
  HashMap version by >2× at 1M sparse cells. If so, pivot to a flat
  `BTreeMap<(u32, u32), AtomId>` keyed by `(row, col)`; range scans
  still work, just with one BTreeMap layer instead of two.
- Track G's enum change causes >50 call-site rewrites. If so, defer
  Track G to a Phase 2.5 and ship E + F + H first.

## Non-Goals for Phase 2

- Cross-sheet dirty propagation — that's Phase 3.
- UI work (column virtualization, 1M demo) — Phase 4.
- Worker authoritative RPCs — Phase 5 prep.
- ICU / regional number formatting, accessibility — Phase 6.
