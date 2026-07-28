# rich-types

Discriminated union for structured cell values surfaced alongside the existing plain-string display path.

## State Decision Template

- Source atoms: none. Rich value data is plain data attached to `DisplayCell`; no per-cell or per-run atoms.
- Derived atoms: none.
- Commands: none. The backend port `setCellRichValue` is an optional method on `SpreadsheetBackend`.
- Scale bound: one optional field per cell in projection results.
- Backend reads: `richValue` field in `DisplayCell` returned by `readVisibleProjection` / `readRangeProjection`.
- Per-cell atom risk: avoided — rich data travels as value-in-projection, not atom-per-cell.
- Tests: `test/rich-types.test.ts`.

## Additive design decision

`DisplayCell.displayValue: string` is unchanged. `richValue?: DisplayCellRichValue` is a sibling optional field.

Renderers that understand rich values prefer `richValue` when present and fall back to `displayValue` for plain rendering. This keeps the existing string path zero-cost for hosts that do not need rich values, and avoids a breaking change to any code that reads `displayValue` as a `string`.

The editor draft type (`EditingSessionState.draft`) stays `string`; rich editing goes through the separate `setCellRichValue` backend port.
