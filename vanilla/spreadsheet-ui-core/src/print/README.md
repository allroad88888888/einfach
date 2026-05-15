# print

Owns print configuration state per sheet: print area, manual page breaks, scale, orientation, header/footer.

## State Decision Template

- Source atoms:
  - `printConfigStateAtom`: map of sheetId → PrintConfig; bounded by sheet count.
  - `printPreviewOpenAtom`: boolean for preview overlay visibility.
  - `pageSetupDialogOpenAtom`: boolean for Page Setup dialog visibility.
- Derived atoms: none.
- Commands:
  - `setPrintConfigAtom` — merge config for a sheet.
  - `clearPrintConfigAtom` — remove config for a sheet.
  - `togglePrintPreviewAtom` — flip preview open state.
  - `togglePageSetupDialogAtom` — flip page setup dialog state.
- Scale bound: one record per sheet; sheet count is bounded.
- Backend reads: `readPrintConfig` / `setPrintConfig` (optional; UI core degrades gracefully).
- Per-cell/per-row/per-col atom risk: none; config is per-sheet.
- Pure helpers: `shiftManualPageBreaks` for row/col structural edits.
- Tests: `test/print-page-area.test.ts`.
