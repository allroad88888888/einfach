# Structural Undo

How `insertRow` / `deleteRow` / `insertCol` / `deleteCol` are made undoable in
`sheet-store.ts`. Companion to `core/core/src/utils/createHistory.ts`,
which is the same idea applied at the atom layer.

## Background

`sheet-store.ts` already maintains an `undoStack` / `redoStack` for cell-value
edits. Each entry records `before` and `after` snapshots of the cells the edit
touched, so undo / redo just replay those snapshots:

```ts
type UndoEntry = { before: CellSnapshot[]; after: CellSnapshot[] }
```

Structural edits used to be deliberately excluded — the original concern was
"naive snapshot of every cell in the affected band is O(N), explodes on big
sheets". The note at `sheet-store.ts:341` flagged this as a TODO.

The relationship to `createUndoRedo` is just *shape, not code*: same idea of a
linear history with cursor, batched edits via `beginEdit` / `endEdit` (≈
`mergeState`), pop-to-undo / push-back-to-redo. We don't reuse the einfach atom
machinery because cells are addressed in a `HashMap<CellAddress, AtomId>` rather
than each cell being an `Atom`, and `createUndoRedo`'s `watchAtom` would require
one subscription per touched address.

## Approach: non-empty snapshot, with op-inverse fallback

Snapshot just the *non-empty* cells inside the affected band, both before and
after the edit. Most real sheets are sparse — even a 10k×100 sheet usually has
only a few hundred non-empty cells in any given band. Replay walks that small
list inside a `bulk_load` so the per-cell subscriber storm collapses to one
flush.

There's still a degenerate case (band of 100k+ populated cells). For that we
keep a threshold: when the band's non-empty count crosses the limit, we drop
the snapshot and store the op + parameters, undo as the inverse op. Inverse
loses any formulas that referenced rows / cols that got destroyed by a delete,
but at that point a perfect undo isn't tractable without copying the entire
sheet, so we accept the degradation and surface it via a console warning.

### UndoEntry shape

```ts
type UndoEntry =
  | { kind: 'cells'; before: CellSnapshot[]; after: CellSnapshot[] }
  | {
      kind: 'structural'
      op: 'insertRow' | 'deleteRow' | 'insertCol' | 'deleteCol'
      at: number
      count: number
      // null when fallback path was used.
      snapshot: { before: CellSnapshot[]; after: CellSnapshot[] } | null
    }
```

### Restore order

For `insertRow(at, count)` undo:
1. `deleteRow(at, count)` (reverses the structural shift).
2. If snapshot exists, `bulk_load` → restore each `before` cell. This is mostly
   a no-op for inserts (insert doesn't lose data) but is needed to recover any
   primitive value that got re-pinned through dependency rewriting.

For `deleteRow(at, count)` undo:
1. `insertRow(at, count)` (creates the empty band back).
2. `bulk_load` → restore each `before` cell (this is where the deleted content
   actually comes back, including formulas that referenced rows in the
   deleted band).

Redo is the symmetric replay using `after`.

### Coalescing with value edits

Structural entries don't merge with cell `beginEdit/endEdit` batches — they
get their own stack frame even if called inside a begin/end pair. Mixing the
two in one entry would force restore to interleave "set this cell" with
"shift the grid", which is fragile. Calling `insertRow` while a value-edit
batch is open will flush the value batch first, then push the structural
entry.

## Required API additions

### Rust (`excel/rust/excel-core/src/sheet.rs`)

```rust
/// Iterate every (addr, value) pair that has either a primitive value or a
/// formula. Skips empty addresses. Used by structural-undo to capture only
/// the cells that actually need restoring.
pub fn for_each_non_empty(&self, f: &mut dyn FnMut(CellAddress));

/// Convenience: collect into a Vec<String> of addresses (e.g. "A1").
pub fn non_empty_addrs(&self) -> Vec<String>;
```

These walk `self.cells` + `self.formula_cells`, dedup the keys (a cell can
have both during the brief Computing window — pick the formula version).

### wasm (`excel/rust/wasm/src/lib.rs`)

```rust
#[wasm_bindgen]
pub fn non_empty_addrs(&self) -> Array; // Array<string>
```

### TS (`excel/solid-excel/src/types.ts`)

```ts
interface ISheet {
  // ... existing methods ...
  non_empty_addrs?(): string[]
}
```

`js-sheet.ts` mock implements it by iterating its own `cells` map. WASM
backend forwards to the wasm binding.

## Threshold

`SNAPSHOT_MAX = 2000` non-empty cells across the *whole sheet* (not just the
band — cheap upper bound). Above that, we store the entry with `snapshot:
null` and undo runs the inverse op only. The constant can be tuned once we
have real benchmarks.

## Test coverage

Jest unit:
- `insertRow` → `undo` → grid identical, formula refs identical
- `deleteRow` containing a formula → `undo` → formula text restored, value
  re-evaluates to the same result
- `deleteCol` containing a primitive value → `undo` → value back, fanout
  notify count matches a single push
- Threshold path: load 3000 cells, `deleteRow`, `undo`, assert
  `console.warn` was emitted and grid is *approximately* restored (op-inverse
  semantics — empty band reappears but original cells in that band are gone).

E2E (`range-ops.spec.ts`):
- Right click row 3 → Delete row → Ctrl+Z → row 3 cells visible again with
  original content. (Requires the right-click menu agent's work to land
  first.)
