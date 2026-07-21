# operations

Owns framework-agnostic spreadsheet operation intents.

## State Decision Template

- Source atoms: none in the first wave.
- Derived atoms: none.
- Commands: pure intent factories for cell input, row/column insert/delete, and sheet add/delete/rename/reorder.
- Scale bound: one operation intent at a time; large data movement remains backend/session-owned.
- Backend reads: none directly. Host adapters translate intents to worker/Rust commands.
- Per-cell/per-row/per-col atom risk: none; intents store coordinates/range hints, not expanded cells.
- Tests: `test/operations.test.ts`.

## Deleting rows over a filtered region (§8.3)

Excel deletes only the **visible** rows of a selection that spans a filtered
region — filtered-out rows inside the span survive. Manually hidden rows do
not get that protection: they are deleted along with everything else. Same
asymmetry as copy (see `copy-as/README.md`), and the reason the design keeps
two hidden-row sets rather than one.

```ts
export function planFilterVisibleRowDeletions(
  input: PlanFilterVisibleRowDeletionsInput,
): readonly RowDeletionRun[]

export const runFilterVisibleRowDeleteAtom: WritableAtom<
  null,
  [RunFilterVisibleRowDeleteInput],
  Promise<FilterVisibleRowDeleteOutcome>
>
```

`planFilterVisibleRowDeletions` splits a contiguous `[rowIndex, count]`
selection into the spans that actually remove data:

1. Runs come back **descending**. Deleting the highest run first leaves every
   lower run's index valid, so the caller never remaps indices between
   backend calls. Ascending would corrupt every run after the first.
2. Runs are maximal — adjacent visible rows never split, so the caller issues
   the fewest transactions possible.
3. An empty result means **launch zero transport**: either the span was
   malformed, or every row in it was filter-hidden. Never fall back to the
   raw span; that is the data-loss case this guard exists to prevent.

`runFilterVisibleRowDeleteAtom` is the command wrapper. It reads
`viewportFilterHiddenAtom` (the filter subset — *not* `effectiveHiddenAtom`),
plans the runs, and dispatches one `runStructureOperationAtom` per run,
stopping at the first that does not complete. Each run is its own history
entry, so undo unwinds them one at a time exactly as N separate deletes
would. An all-hidden selection returns `'no-visible-rows'` having called
nothing.

With no filter active the planner returns the input span verbatim and the
command issues exactly one operation — identical to calling
`runStructureOperationAtom` with `createDeleteRowsOperation` directly, which
is what every caller did before this existed. Under today's display
compaction a filtered-out row has no display slot, so the filter set is
always empty and this is an identity; the guard starts doing work only after
the S5 adapter flip. See
`solid/excel/docs/online-excel-parity/design-filter-hidden-rows.md` §8.3.
