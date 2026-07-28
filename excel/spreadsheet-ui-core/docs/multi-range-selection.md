# Multi-Range (Disjoint) Selection

## Goal

Ctrl/Cmd-click and Ctrl-drag add disjoint regions to the selection. Each
gesture appends a new `SelectionRegion` without replacing existing ones.
The user can accumulate mixed cell, range, row, and column regions across
a single sheet. One region is always **primary** and owns the active cell.

## Scope

Supported region kinds: `cell`, `range`, `row`, `column` (same variants
that `SelectionState` already models). Mixed kinds in one multi-region
selection are valid (e.g. two ranges plus a row).

**Out of scope**

- Non-rectangular regions (L-shapes, arbitrary polygons)
- Cross-sheet disjoint selections
- Programmatic union/difference of overlapping regions at the state level

## State (UI core)

`selectionAtom` currently stores a single `SelectionState`. Extend it to
a wrapper that carries an ordered list of regions plus a `primaryIndex`.

```ts
// new source atom — replaces bare selectionAtom value type
export interface MultiRangeSelectionState {
  regions: readonly SelectionState[] // at least one element always
  primaryIndex: number           // index into regions[]
}
```

The existing `selectionAtom` keeps its name and `debugLabel`
`'spreadsheet.selection.state'` but its value type widens. A backwards-
compat accessor returns `regions[primaryIndex]` as a plain `SelectionState`
for all derived atoms (`activeCellAtom`, `selectionRangeAtom`,
`selectionSnapshotAtom`) so consumers that only read the primary region
need no changes.

Optional auxiliary atom for debugging:

```ts
export const selectionRegionsAtom = atom(
  (get) => snapshotRegions(get(selectionAtom).regions),
)
selectionRegionsAtom.debugLabel = 'spreadsheet.selection.regions'
```

Single-region path remains the default and common path. When `regions`
has one entry the internal representation is identical to today's state
(primary region at index 0).

## Types

```ts
// excel/spreadsheet-ui-core/src/selection/types.ts additions

export type SelectionRegion =
  | CellSelection
  | RangeSelection
  | RowSelection
  | ColumnSelection

// Updated top-level state
export interface MultiRangeSelectionState {
  regions: readonly SelectionState[]
  primaryIndex: number
}

// SelectionState stays as the union (unchanged) — used for individual regions
// MultiRangeSelectionState is the new atom value

export interface AddSelectionRegionInput {
  region: SelectionRegion
  makePrimary?: boolean   // default true — new region becomes primary
}

export interface ClearSelectionRegionsInput {
  keepPrimary?: boolean   // when true, collapses to the primary region only
}

export interface ExtendPrimaryRegionInput {
  focus: CellCoord
}
```

`AllSelection` is excluded from `SelectionRegion`, so callers cannot append
`all` as one disjoint region. Internally `MultiRangeSelectionState.regions`
uses `SelectionState` to allow Ctrl/Cmd+A to replace the whole multi-region
state with a single `all` region.

## Backend Port

No new backend ports. All projection and range commands continue to address
the **primary** region only (`regions[primaryIndex]`). Multi-region
operations (clear contents, format, fill color) are handled at the adapter
level by iterating `regions` and issuing one command per region. This keeps
the backend port surface unchanged and avoids baking iteration policy into
the UI core atoms.

Convention: adapters that implement multi-region ops must guard on
`regions.length > 1` before iterating, so single-region fast-paths stay
cheap.

## Integration Points

### Keyboard

- Arrow keys and Tab move the active cell within the **primary** region
  (`regions[primaryIndex]`). Other regions are not affected.
- Shift+Arrow extends the primary region's `focus` (same as today for a
  single selection).
- Escape with `regions.length > 1`: collapse to primary region only
  (`selection.clearNonPrimary` intent, backed by `clearSelectionRegionsAtom`
  with `keepPrimary: true`). Escape with a single region: existing behaviour
  (cancel edit or deselect).
- Ctrl/Cmd+A: replace all regions with a single `all` region.

`dispatchKeyboardInputAtom` reads the primary region for movement logic and
the region count for Escape collapse. The keyboard intent union includes
`selection.clearNonPrimary` so adapters can prevent default consistently.

### Pointer

- Plain click → replace all regions with a single cell region (existing
  `selectCellAtom` behaviour).
- Shift+click → extend the primary region's focus (existing `extend` flag).
- Ctrl/Cmd+click → dispatch `addSelectionRegionAtom` with the clicked cell
  as a new region; set it as primary.
- Ctrl/Cmd+drag → start a drag-selection session; on pointer-up append the
  dragged range via `addSelectionRegionAtom`.
- Pointer drag-selection start/commit carries `append?: boolean`, so host
  adapters can keep modifier-key policy in the UI while preserving a precise
  core pointer contract.

### Clipboard

Copy from a multi-region selection produces stacked TSV blocks, one block
per region in `regions` order, separated by a blank row. Example for two
non-adjacent ranges A1:B2 and D5:E6:

```
A1\tB1
A2\tB2
          ← blank separator row
D5\tE5
D6\tE6
```

Notes:
- Block order follows `regions` array order (append order, not spatial order).
- When row counts differ across blocks, each block is self-contained; the
  receiver interprets them independently.
- `ClipboardPayloadDescriptor.source` points to the primary region's range
  for paste-target resolution. Multi-source metadata is a future extension.
- Cut from multi-range: clears all regions, same iteration convention as
  format ops.

### Toolbar

Format commands (bold, fill color, number format, etc.) iterate all regions.
The toolbar reads `selectionAtom.regions` and passes each region's range to
the relevant backend command. Toolbar state (e.g. "is bold active?") derives
from the **primary** region only to avoid expensive multi-range union queries.

### Formula Bar

The formula bar displays the address of the **primary** region
(`regions[primaryIndex]`). The address input and cell-edit interactions apply
to the primary region only. Multi-range address display (e.g. `A1,D5`) is a
future enhancement.

## Risks & Open Questions

- **Overlap dedup semantics** — two regions that fully overlap are stored as
  separate entries; no automatic dedup or merge is performed. Should visual
  rendering highlight the overlap once or twice? Decision needed before
  implementing the renderer highlight path.
- **Copy when row counts differ** — stacked TSV blocks with unequal heights
  may confuse receivers that expect a rectangular payload. Consider padding
  shorter blocks with empty cells to the max row count, or document the
  no-pad contract explicitly.
- **Paste-to-multi shape mismatch** — pasting into a multi-region target
  where region shapes don't match the source block count is undefined.
  Initial policy: paste always targets the primary region only; multi-target
  paste is out of scope.
- **Accessibility** — screen readers announce selection changes via live
  regions. Multi-range accumulation needs a clear announcement strategy
  (e.g. "3 regions selected") to avoid chatty updates on every Ctrl+click.
- **Performance with many regions** — `regions` is iterated on every format
  command and every clipboard copy. Cap at a practical limit (e.g. 256
  regions) and surface a UI warning when the cap is reached.
- **`AllSelection` interaction** — if the user Ctrl+clicks after Ctrl+A the
  current plan replaces all regions; confirm this is the desired UX or
  whether `all` + extra regions should be a valid state.

## Test Surface

`test/selection-multi-range.test.ts`

Planned cases:

- `addSelectionRegion` appends a region and sets `primaryIndex`
- `addSelectionRegion` with `makePrimary: false` does not shift `primaryIndex`
- Arrow navigation moves active cell within primary, leaves other regions
  unchanged
- Escape with multiple regions collapses to primary only
- Escape with single region falls through to existing handler
- `clearSelectionRegions` with `keepPrimary: true` retains primary region
- `clearSelectionRegions` without flag resets to `DEFAULT_SELECTION_STATE`
- Backwards-compat: `activeCellAtom`, `selectionRangeAtom`, and
  `selectionSnapshotAtom` all return primary-region values when multiple
  regions exist
- Single-region path produces identical output to the current implementation
- Ctrl+A replaces all regions with a single `all` region
