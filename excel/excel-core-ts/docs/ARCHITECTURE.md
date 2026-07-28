# Architecture — Excel Core (TS)

> Companion doc to [PLAN.md](./PLAN.md). This file is the design rationale and dataflow reference.

## 1. Layer cake

```
┌──────────────────────────────────────────────────────────────┐
│ vnext UI (excel/solid-excel/src-vnext/)                            │
│  - Grid, toolbar, dialogs                                    │
│  - Atoms scoped to UI session                                │
└─────────────────┬────────────────────────────────────────────┘
                  │ SpreadsheetBackend port (unchanged)
                  ▼
┌──────────────────────────────────────────────────────────────┐
│ Worker (excel/solid-excel/src-vnext/adapter/worker-runtime.ts)     │
│  - postMessage → request decoder                             │
│  - Calls into @einfach/excel-core                            │
└─────────────────┬────────────────────────────────────────────┘
                  │ in-process function calls
                  ▼
┌──────────────────────────────────────────────────────────────┐
│ @einfach/excel-core (this package)                           │
│                                                              │
│  workbook.ts  ─→  sheets: Map<id, sheetAtom>                 │
│                   names:  Map<name, NamedRange>              │
│                                                              │
│  sheet.ts ─────── sheetAtom: atom<Map<CellKey, Cell>>        │
│                                                              │
│  formula derives: atom(get => evaluate(get(sheetAtom), ...)) │
│                                                              │
│  evaluator: parser/ → ast → eval/functions/                  │
└─────────────────┬────────────────────────────────────────────┘
                  │ store getter/setter/sub
                  ▼
┌──────────────────────────────────────────────────────────────┐
│ @einfach/core (core/core)                                 │
│  - createStore, atom, sub                                    │
│  - WeakMap-based dep tracking + lazy invalidation            │
└──────────────────────────────────────────────────────────────┘
```

Key property: **`@einfach/excel-core` does not import `solid-js`, the DOM, or anything UI-specific**. Same discipline as `excel/spreadsheet-ui-core`. It depends only on `@einfach/core`.

## 2. Data model

### 2.1 CellKey

```ts
export type CellKey = string  // "<row>:<col>"  — int row, int col, 0-indexed
export const keyFor = (row: number, col: number): CellKey => `${row}:${col}`
```

Same convention `static-backend.ts` already uses. Internal-only — public APIs use `{ row, col }` or A1 strings.

### 2.2 Cell

```ts
type Value =
  | { kind: 'blank' }
  | { kind: 'number';  value: number }
  | { kind: 'string';  value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'error';   code: ErrorCode; message?: string }
  | { kind: 'array';   value: Value[][] }   // spill anchor

interface Cell {
  formula?: string         // raw text, e.g. "=A1+B2"
  ast?: Expr               // parsed once on setCell, then cached
  value: Value             // last computed value (filled in by evaluator)
  format?: CellFormat      // bg, fg, font, number format, ...
}
```

A cell with `formula === undefined` is a literal. A cell with `formula` has its `value` overwritten by every evaluator run. Format is orthogonal — not affected by recompute.

### 2.3 sheetAtom

```ts
type SheetState = ReadonlyMap<CellKey, Cell>

export const sheetAtom: WritableAtom<SheetState, [SheetMutation], void>
```

The atom is **the entire sheet's cell map**. Writes go through a setter that takes a structured mutation (`SetCell`, `ClearCell`, `BulkApply`, etc.), applies it immutably, and produces a new `Map` reference. `core/core`'s `Object.is` cache check then invalidates every formula derive in one stroke.

Why immutable? `dep-equality` in `core/core` is reference equality. If we mutated the existing Map, derives wouldn't see a change. The new-Map allocation is cheap (~50 ns/op even for 10k-cell sheets).

### 2.4 Formula derives

```ts
// Per-cell derive, lazily created on first read or sub
const formulaCellAtom = (sheet: WorkbookSheet, key: CellKey) =>
  atom((get) => {
    const cells = get(sheet.sheetAtom)
    const cell = cells.get(key)
    if (!cell) return BLANK
    if (cell.ast === undefined) return cell.value  // literal
    return evaluate(cell.ast, makeContext(get, sheet, key))
  })
```

`makeContext` builds an `EvalContext` that the evaluator uses for `refLookup`, `volatileNow`, `customFormulaCall`, etc. — all derived from the captured `get` so deps register naturally.

Atom is cached by `(sheet, key)` so subsequent `sub` calls hit the same instance.

## 3. Mutation flow

```
UI dispatches setCell command
     │
     ▼
SpreadsheetBackend.setCellInput({ sheetId, row, col, input })
     │  (via postMessage to worker)
     ▼
worker-runtime.ts decodes request
     │
     ▼
workbook.setCell(sheetId, key, input)
     │  - parse input → Cell { formula?, value?, ast? }
     │  - immutably update Map<CellKey, Cell>
     │  - store.setter(sheet.sheetAtom, newMap)
     ▼
core/core: marks every back-dep of sheetAtom dirty
     │
     ▼
flushPending walks pending — only currently-subscribed derives recompute
     │
     ▼
Subscribers (worker projection responder) read the visible window
     │
     ▼
postMessage back to UI: VisibleProjectionResult
```

**No explicit recalc loop in the core.** core/core's `flushPending` does the work. Mutation = single setter call. Evaluation = whatever happens when subscribers read.

## 4. Evaluation flow

For a single formula like `=IF(A1>0, A1*B1, "n/a")`:

```
evaluate(ast, ctx)
   ├─ ast.kind === 'call', name === 'IF'
   ├─ args = ast.args
   ├─ predicate = evaluate(args[0], ctx)
   │     ├─ ast.kind === 'binop', op === '>'
   │     ├─ left  = evaluate(ref('A1'), ctx)
   │     │     └─ ctx.refLookup('A1')
   │     │            └─ cells.get(keyFor(0, 0))?.value  ◄ from sheetAtom
   │     ├─ right = literal 0
   │     └─ coerce + compare
   ├─ if predicate truthy → evaluate(args[1])
   │     └─ A1 * B1 (two more refLookups)
   └─ else → evaluate(args[2])  // literal string
```

Every `ctx.refLookup` hits `cells.get`, which is **the same Map** referenced once at the start of `evaluate` via `get(sheetAtom)`. One dep registered (`sheetAtom`), arbitrarily many refs resolved.

This is the key insight from §4.1 of PLAN.md realized in code: **broad dep, fine-grained lookup**. No range-dep index, no per-cell atom — but full granularity inside the evaluator.

## 5. Cycle detection

```ts
const currentlyEvaluating = new Set<CellKey>()

function refLookup(refKey: CellKey, ctx: EvalContext): Value {
  if (currentlyEvaluating.has(refKey)) {
    return { kind: 'error', code: '#CIRCULAR!' }
  }
  const cell = ctx.cells.get(refKey)
  if (!cell?.ast) return cell?.value ?? BLANK
  currentlyEvaluating.add(refKey)
  try {
    return evaluate(cell.ast, ctx)
  } finally {
    currentlyEvaluating.delete(refKey)
  }
}
```

The set is scoped to a **single top-level `evaluate()` call chain**, not global. Recursive `refLookup` within the same evaluation share the set; once the chain unwinds, the set is empty. Concurrent evaluations from different `get` paths get fresh sets — core/core serializes derive execution so concurrency isn't a worry.

## 6. Spill arrays

Anchor cell:

```ts
{
  formula: '=SEQUENCE(3,2)',
  ast: ...,
  value: { kind: 'array', value: [[1,2],[3,4],[5,6]] }
}
```

Renderer logic in the grid:

```ts
function projectionCellAt(row, col) {
  const cell = cells.get(keyFor(row, col))
  if (cell) return cell                              // explicit cell
  // walk left/up looking for a spill anchor
  for (const [aRow, aCol] of anchorCandidates(row, col)) {
    const a = cells.get(keyFor(aRow, aCol))
    if (a?.value.kind === 'array') {
      const r = row - aRow, c = col - aCol
      if (r < a.value.value.length && c < a.value.value[0].length) {
        return { value: scalar(a.value.value[r][c]), formula: undefined }
      }
    }
  }
  return BLANK_CELL
}
```

No "spill target atoms." The grid renders the spilled region by **looking up** at projection-build time. Dep flow stays clean: subscribers depend on `sheetAtom`, anchor cell holds the array, grid composes the visible projection at read time.

Cost: a spill target cell does a few `cells.get` calls to find its anchor. Bounded by max-spill-distance; in practice, anchors are nearby. Acceptable.

## 7. Volatile / F9

```ts
export function recalc(workbook: Workbook): void {
  for (const sheet of workbook.sheets.values()) {
    store.setter(sheet.sheetAtom, new Map(store.getter(sheet.sheetAtom)))
  }
}
```

That's it. `new Map(existing)` clones the cell map → fresh reference → every derive marked dirty → next read picks up fresh `NOW()`, `RAND()`, etc.

Hooked to Ctrl-F9 in the UI, or to a timer for "live clock" cells (rare).

## 8. Cross-sheet references

`Sheet2!A1` parsing yields an AST node `{ kind: 'crossRef', sheetName: 'Sheet2', ref: 'A1' }`. Evaluator resolves:

```ts
function crossRefLookup(node, ctx) {
  const sheet = ctx.workbook.sheets.get(ctx.workbook.sheetIdByName(node.sheetName))
  if (!sheet) return { kind: 'error', code: '#REF!' }
  const cells = ctx.get(sheet.sheetAtom)   // ◄ extra dep on the other sheet's atom
  return cells.get(keyFor(...resolveRef(node.ref)))?.value ?? BLANK
}
```

This registers a dep on the **other sheet's atom** — core/core handles cross-atom propagation natively. When Sheet2 changes, formulas on Sheet1 referencing Sheet2 invalidate. No special cross-sheet bookkeeping.

3D refs (`Sheet1:Sheet3!A1`) — phase 5+. Same mechanism, just iterating multiple sheet atoms.

## 9. Named ranges + LAMBDA

Named ranges resolve to a workbook-level lookup before evaluation:

```ts
// workbook.names: Map<string, { kind: 'range', sheetId, ref } | { kind: 'lambda', params, body }>
function resolveName(name, ctx) {
  const entry = ctx.workbook.names.get(name)
  if (!entry) return { kind: 'error', code: '#NAME?' }
  if (entry.kind === 'range') return rangeLookup(entry, ctx)
  // LAMBDA case: lazy, instantiate body with bound args at call site
  return { kind: 'lambda', value: entry }
}
```

`workbook.names` is itself an atom; mutations to named ranges trigger broad invalidation of formulas referencing them. Same model as sheetAtom.

LAMBDA bodies parse once when defined and cache their AST; calls evaluate the body with `paramName → argValue` substitution in the eval context.

## 10. Custom formulas

Host registers via the existing UI atom (`registerCustomFormulaAtom` in `spreadsheet-ui-core`). The worker side maintains a registry:

```ts
type CustomFormula = (args: Value[]) => Value | Promise<Value>
const registry = new Map<string, CustomFormula>()
```

Dispatch happens after built-in lookup misses:

```ts
function dispatchCall(name, args, ctx) {
  const builtin = builtins.get(name.toUpperCase())
  if (builtin) return builtin(args, ctx)
  const custom = registry.get(name.toUpperCase())
  if (custom) return wrapCustomResult(custom(args.map(unwrap)))
  return { kind: 'error', code: '#NAME?' }
}
```

Async custom formulas (returning a Promise) integrate via `core/core`'s built-in promise support — the derive returns a `StatesWithPromise<Value>` and subscribers see the placeholder, then the resolved value.

No re-entrancy guard needed (cycle detection in §5 already covers calling-back-into-yourself). No source-string `new Function` evaluation — host passes real closures.

## 11. Performance levers

If Phase 4 profiling shows TS is too slow:

1. **AST caching** (in §2.2 — already planned). Parser runs once per formula edit, not per evaluation.
2. **Function-table dispatch** via plain `Map.get`, not `switch` (JIT inlines monomorphic Map.get; large `switch` is megamorphic).
3. **Number-only hot path** in arithmetic: if both operands are `kind === 'number'`, skip coerce.
4. **Range pre-materialization**: for `SUM(A1:A1000)`, do a single sheetAtom read and pull a flat array, not 1000 individual lookups.
5. **Worker SAB transfer** for projection results — only if postMessage becomes the bottleneck (unlikely at 200-cell windows).

None of these are v1. Profile first.

## 12. What stays in `excel/spreadsheet-ui-core`

Unchanged. The UI core defines the **backend port shape**, host APIs (custom formulas, find/replace, etc.), and UI atoms. It has zero opinion on whether the worker is rust or ts.

This is the contract that keeps the port boring: no UI change.

## 13. What stays in `excel/solid-excel/src-vnext/adapter/`

Unchanged in shape, swap in implementation:

- `worker-factory.ts` — picks which worker bundle to spawn (today: wasm bundle; after Phase 4: ts bundle behind flag; after Phase 10: ts bundle only).
- `worker-runtime.ts` — decodes postMessage requests, calls into the worker-side core, encodes responses.
- `worker-workbook-backend.ts` — UI-facing port; sends requests over postMessage.

The new core slots in where `Workbook` (wasm-bound) is constructed today.
