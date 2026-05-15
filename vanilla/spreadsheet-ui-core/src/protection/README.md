# protection

Sheet protection and locked-cell state for the spreadsheet UI core.

## State Decision Template

- Source atoms:
  - `sheetProtectionAtom`: map of sheetId → `SheetProtectionState` (mode + bounded unlocked ranges).
- Derived atoms:
  - `activeCellLockedAtom`: true when the active cell is locked in a protected sheet.
  - `selectionLockedAtom`: 'open' | 'locked' | 'partial' for the current selection range.
- Commands:
  - `setSheetProtectionAtom`: store protection state per sheet; truncates `unlockedRanges` at MAX_UNLOCKED_RANGES.
  - `clearSheetProtectionAtom`: remove protection entry for a sheet.
- Scale bound: `unlockedRanges` capped at 256 per sheet; no per-cell atoms.
- Backend reads: host adapter echoes protection state via `setSheetProtectionAtom`.
- Per-cell/per-row/per-col atom risk: do not store per-cell lock atoms.
- Tests: `test/protection.test.ts`.
