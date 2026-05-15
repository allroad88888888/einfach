# protect-sheet-locked-cells

Sheet protection and locked cells feature plan for `@einfach/spreadsheet-ui-core`.

---

## Goal

Turn a sheet into protected mode where only explicitly unlocked ranges accept
edits; the UI surfaces lock state and blocks gated commands.

---

## Scope

- Toggle sheet-level protection on/off per sheet.
- Declare unlocked ranges within a protected sheet (all other cells are implicitly locked).
- Gate edit commit, paste, format, fill, and structural ops (insert/delete
  rows/columns) when the active cell or selection overlaps a locked range.
- Surface lock state in `DisplayCell` for the visible window so renderers can
  style locked cells.
- Reflect protection in `toolbarCommandAvailabilityAtom` and context-menu availability.

**Out of scope**

- Password-based protection — host adapter concern; UI core only tracks mode.
- Per-user permissions — belongs in the presence/collaboration doc.
- Client-side enforcement of password verification.
- Cross-sheet protection relationships.
- Protection of sheet structure independent of cell locking (sheet-tab rename/delete
  blocking is a sheet-tabs concern).

---

## State (UI core)

### Source atoms

**`sheetProtectionAtom`** — `atom<SheetProtectionState>`  
Holds the current sheet's protection mode and its bounded list of explicitly
unlocked ranges echoed from the backend. Reset when the active sheet changes.

```ts
sheetProtectionAtom.debugLabel = 'spreadsheet.protection.state'
```

### Derived atoms

**`isSheetProtectedAtom`** — `atom<boolean>`  
`true` when `sheetProtectionAtom.mode === 'protected'`.

```ts
isSheetProtectedAtom.debugLabel = 'spreadsheet.protection.isProtected'
```

**`activeCellLockedAtom`** — `atom<boolean>`  
`true` when the sheet is protected and the active cell does not fall inside any
unlocked range. Consumes `selectionAtom` and `sheetProtectionAtom`.

```ts
activeCellLockedAtom.debugLabel = 'spreadsheet.protection.activeCellLocked'
```

**`selectionLockedAtom`** — `atom<boolean>`  
`true` when the sheet is protected and the current selection range is not fully
covered by unlocked ranges. Used to gate paste and format commands.

```ts
selectionLockedAtom.debugLabel = 'spreadsheet.protection.selectionLocked'
```

### Command atoms

**`setSheetProtectionAtom`** — `atom(null, (get, set, req: SetSheetProtectionRequest) => void)`  
Writes the pending request; the host adapter picks it up and calls the backend,
then echoes the resulting `SheetProtectionState` back via
`applySheetProtectionAtom`.

```ts
setSheetProtectionAtom.debugLabel = 'spreadsheet.protection.setProtection'
```

**`applySheetProtectionAtom`** — `atom(null, (get, set, state: SheetProtectionState) => void)`  
Updates `sheetProtectionAtom` from a backend echo. Called after successful
`setSheetProtection` or `setRangeLock` round-trips.

```ts
applySheetProtectionAtom.debugLabel = 'spreadsheet.protection.apply'
```

### Scale bound

- `unlockedRanges` is a bounded list. Default cap: 256 unlocked ranges per
  sheet (matches practical limits in host workbook formats). UI core must not
  store per-cell lock atoms.

---

## Types

```ts
export type SheetProtectionMode = 'open' | 'protected'

export interface SheetProtectionState {
  mode: SheetProtectionMode
  unlockedRanges: CellRange[]
}

export interface SetSheetProtectionRequest extends SheetRef {
  kind: 'set-sheet-protection'
  mode: SheetProtectionMode
  requestId?: number
  revision?: ProjectionRevision
}

export interface SetRangeLockRequest extends SheetRef {
  kind: 'set-range-lock'
  range: CellRange
  locked: boolean
  requestId?: number
  revision?: ProjectionRevision
}

// Extend DisplayCell — field is omitted when the sheet is open (perf)
export interface DisplayCell {
  // ... existing fields ...
  locked?: boolean
}
```

`CellRange`, `SheetRef`, and `ProjectionRevision` are imported from existing
shared/backend types.

---

## Backend port

Two optional methods added to `SpreadsheetBackend`:

```ts
setSheetProtection?(request: SetSheetProtectionRequest): Promise<BackendMutationResult>
setRangeLock?(request: SetRangeLockRequest): Promise<BackendMutationResult>
```

Both are **optional**. When absent the UI treats protection as unavailable:
the protect/unprotect menu item is hidden, `isSheetProtectedAtom` remains
`false`.

`readVisibleProjection` extends its `DisplayCell` responses to include
`locked: true` for cells that fall outside unlocked ranges when
`mode === 'protected'`. Backends that do not compute per-cell lock state may
omit the field; the UI core derives lock state from `unlockedRanges` alone for
gating decisions, so `locked` on `DisplayCell` is for renderer hints only.

---

## Integration points

**Editing** — `commitEditAtom` checks `activeCellLockedAtom` before calling
`setCellInput`. When `true` it emits a `ProtectionDiagnostic` instead of
forwarding the mutation.

**Clipboard** — `pasteClipboardAtom` checks `selectionLockedAtom` before
calling `importCells` / `importCellChunks`. Partial-overlap paste (selection
straddles locked and unlocked cells) is rejected in full; no partial write.

**Toolbar** — `toolbarCommandAvailabilityAtom` sets `bold`, `italic`,
`textColor`, `fillColor`, `numberFormat`, and `alignment` to `false` when
`selectionLockedAtom` is `true`. Extends `ToolbarCommandAvailability` with
`protect: boolean` for the protect-sheet toggle button.

**Keyboard** — intents that produce mutations (`keyboard.commit`,
`keyboard.delete`, `keyboard.fill`, `keyboard.cut`) consult
`activeCellLockedAtom`; blocked intents are dropped silently or routed to the
diagnostics atom depending on the error UX policy (see Risks).

**Operations** — `insertRowsAtom`, `deleteRowsAtom`, `insertColumnsAtom`,
`deleteColumnsAtom` check `isSheetProtectedAtom` and are no-ops when `true`.

**Menu** — context menu exposes a "Protect sheet" toggle in the sheet-level
submenu. When `isSheetProtectedAtom` is `true` a "Lock/Unlock range" submenu
item calls `setRangeLockAtom` for the current selection. Both items are hidden
when the backend does not implement the optional ports.

---

## Risks & open questions

- **Gating performance for large pastes.** Checking whether a paste range
  overlaps any locked area requires intersecting the paste bounding box against
  each of up to 256 `unlockedRanges`. This is O(n) in range count and should
  be fast in practice; profile only if cap is relaxed beyond 1 000 ranges.

- **Partial-overlap paste.** When a paste range straddles locked and unlocked
  cells, the simplest safe policy is to reject the entire paste. An alternative
  is to clip the paste to the unlocked portion, but this silently changes the
  user's intent. Recommend full reject with a diagnostic message; revisit if
  host UX demands partial write.

- **Undo through protect/unprotect.** `setSheetProtection` is a mutation and
  should push a `HistoryEntry` (kind `'sheet.protect'`). If the user undoes past
  a protect event, the backend must restore the previous `unlockedRanges` list;
  confirm the history doc's transaction model covers structured metadata changes,
  not just cell content.

- **Error UX: silent vs diagnostic.** Blocked edits can fail silently (no
  visible change) or emit a `ProtectionDiagnostic` to the diagnostics atom.
  Silent is simpler; a diagnostic (e.g. status-bar flash) is more discoverable.
  Recommend a diagnostic with a short TTL rather than a modal, keeping it
  consistent with the existing diagnostics pattern.

- **Interaction with merged cells.** A locked range that partially overlaps a
  merged cell region produces an ambiguous lock boundary. Recommend the lock
  range check treats a merged cell as locked if its origin cell is locked,
  mirroring how selection treats merged cells as a unit.

- **`unlockedRanges` echo latency.** Between `setSheetProtection` being sent
  and `applySheetProtectionAtom` being called, the local UI core state is
  stale. Optimistic update (flip `mode` immediately, apply ranges on echo) is
  simpler than showing a spinner; document this as the expected adapter
  contract.

---

## Test surface

All tests live in `test/protection.test.ts`.

- `isSheetProtectedAtom` is `false` on init; `true` after `applySheetProtectionAtom`
  with `mode: 'protected'`.
- `activeCellLockedAtom` is `false` when mode is `'open'` regardless of
  selection.
- `activeCellLockedAtom` is `true` when protected and active cell is outside
  every `unlockedRange`.
- `activeCellLockedAtom` is `false` when protected and active cell falls inside
  an `unlockedRange`.
- `selectionLockedAtom` is `true` when the selection range partially overlaps
  locked area.
- `selectionLockedAtom` is `false` when the selection is fully within unlocked
  ranges.
- Toolbar availability flags (`bold`, `italic`, etc.) are `false` when
  `selectionLockedAtom` is `true`.
- `setSheetProtectionAtom` write does not mutate `sheetProtectionAtom` directly;
  mutation happens only via `applySheetProtectionAtom`.
- `applySheetProtectionAtom` replaces `unlockedRanges` fully (no merge).
- Switching active sheet resets `sheetProtectionAtom` to `{ mode: 'open',
  unlockedRanges: [] }`.
- Edge: empty `unlockedRanges` with `mode: 'protected'` locks every cell.
- Edge: `unlockedRanges` at cap (256) does not allocate per-cell atoms.
