# paste-special

Owns Paste Special dialog state — the kind of paste (values / formats / etc.),
optional arithmetic operation between source and target, transpose, and
skip-blanks toggles. Backed by the optional `SpreadsheetBackend.pasteRange`
port; capability-gated by the host so the menu entry and dialog disappear
when the backend omits the port.

## State Decision Template

- Source atoms:
  - `pasteSpecialOpenAtom`: whether the dialog is visible.
  - `pasteSpecialOptionsAtom`: per-instance form state (`kind`, `op`,
    `transpose`, `skipBlanks`). Atom-backed rather than Solid signal so
    Solid 1.9.12 provider re-mounts don't drop the draft.
- Derived atoms: none in core. The host defines a derived
  `pasteSpecialSupportedAtom` reading `backend.pasteRange != null` and
  pipes it into the menu item's `isAvailable`.
- Commands:
  - `openPasteSpecialAtom`
  - `closePasteSpecialAtom`
  - `patchPasteSpecialOptionsAtom` — shallow-merge form patch.
  - `confirmPasteSpecialAtom` — closes the dialog + resets options. The
    host calls `backend.pasteRange` directly before invoking this,
    mirroring how `SpreadsheetFindReplaceDialog` handles `searchRange`.
- Scale bound: a single dialog instance; no per-cell families.
- Backend reads: optional `pasteRange(PasteRangeRequest)`. Host adapters
  may implement it by composing existing `setCellInput` / `setFormatRange`
  calls.
- Per-cell atom risk: none — the dialog edits a single options object.
- Tests: `test/paste-special.test.ts` (core), `test/vnext-paste-special.test.tsx` (host).

## Arithmetic semantics

When `op` is `'add' | 'subtract' | 'multiply' | 'divide'`, the backend
combines the source value with the existing target value per cell. The
reference implementation in `solid/excel/src-vnext/adapter/static-backend.ts`
defines the contract; worker backends are expected to match.

| source | target | op       | result                                  |
| ------ | ------ | -------- | --------------------------------------- |
| number | number | any      | `target ⊕ source`                       |
| number | text   | any      | `0 ⊕ source` (text target treated as 0) |
| number | blank  | any      | `0 ⊕ source`                            |
| text   | _any_  | any      | **skip** (target preserved verbatim)    |
| error  | _any_  | any      | **skip** (error pass-through)           |
| _any_  | error  | any      | **skip** (error pass-through)           |
| number | number | divide   | `#DIV/0!` literal when `source = 0`     |

Notes:

- "skip" means the backend leaves the existing target cell exactly as it
  was — no overwrite with the source string, no clear.
- "error" detection is a `displayValue` literal starting with `#` (e.g.
  `#DIV/0!`, `#VALUE!`, `#REF!`, `#NAME?`, `#NUM!`, `#N/A`). This is the
  same shape `valueKind: 'error'` cells project.
- `op = 'none'` (default) bypasses all of the above and writes the source
  input directly.

Host-side coverage lives in
`solid/excel/test/vnext-paste-special-arithmetic.test.ts`.
