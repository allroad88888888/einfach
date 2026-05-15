# Rich Cell Types, Rich Text Runs, and Hyperlinks

## Goal

Extend `DisplayCell` beyond plain string display. Today `displayValue: string`
covers every cell kind. This plan adds three explicit value shapes: **hyperlinks**
(url + label), **inline rich-text runs** (per-run bold / italic / color within
one cell), and **richer value-kind metadata** (currency, date, link) that hosts
can surface without changing the scalar. The editor draft and clipboard must
round-trip these shapes so a host can read back exactly what the user entered or
pasted.

## Scope

**In scope**

- `DisplayCellValue` discriminated union replacing bare `string` in `DisplayCell`
- `Hyperlink { url, label }` value shape
- `RichTextRun { text, format }` and `RichText { runs }` value shape
- Extended `valueKind`: adds `'currency' | 'date' | 'link'` variants
- Editor draft widens to `string | DisplayCellValue`
- `setCellRichValue` backend port for explicit rich edits
- TSV clipboard degradation rule (rich → plain text)
- Test surface in `test/rich-types.test.ts`

**Out of scope**

- Images, charts, sparklines, file attachments
- Host rendering of runs (font, colour, RTL) — host concern
- HTML clipboard variant preserving run fidelity
- Run-level undo / redo within the editor session
- Merged-cell interaction with rich values

## State (UI core)

No new atoms are introduced. Existing atoms widen their payload type.

- `editingSessionStateAtom.draft` changes from `string` to
  `string | DisplayCellValue`. A plain string draft covers formula and plain-text
  entry as before. A structured draft is set when the host opens a rich cell for
  editing or when the formula-bar emits a rich commit.
- The atom `debugLabel` values are unchanged (`'editing.session'`, etc.).
- `clipboardIntentAtom` carries a `cells` array; each cell's `input` field
  stays `string` for TSV round-trips. Rich value metadata is not stored in the
  clipboard atom — it flows through the backend port directly.
- No per-cell, per-run, or per-hyperlink atoms. All rich data is value-in-atom,
  not atom-per-run.

## Types

```ts
// vanilla/spreadsheet-ui-core/src/backend/types.ts additions

export interface RichTextFormat {
  bold?: boolean
  italic?: boolean
  color?: string      // CSS hex or named color
  fontSize?: number
}

export interface RichTextRun {
  text: string
  format?: RichTextFormat
}

export interface RichText {
  kind: 'rich-text'
  runs: RichTextRun[]
}

export interface Hyperlink {
  kind: 'link'
  url: string
  label?: string      // display label; falls back to url if absent
}

export type DisplayCellValue =
  | string
  | number
  | boolean
  | RichText
  | Hyperlink
  | { kind: 'error'; message: string }

// Updated DisplayCell — displayValue widens
export interface DisplayCell {
  row: number
  col: number
  displayValue: DisplayCellValue   // was: string
  valueKind?:
    | 'blank' | 'number' | 'string' | 'boolean' | 'error'
    | 'currency' | 'date' | 'link' | 'rich-text'
  formula?: string
  error?: SpreadsheetError
  formatKey?: string
  format?: SpreadsheetCellFormat
}
```

```ts
// vanilla/spreadsheet-ui-core/src/editing/types.ts — widened draft

import type { DisplayCellValue } from '../backend/types'

export interface EditingSessionState {
  status: EditingSessionStatus
  source: EditingSourceCell | null
  draft: string | DisplayCellValue   // was: string
  diagnostic: SpreadsheetError | null
}

export interface EditingDraftInput {
  draft: string | DisplayCellValue   // was: string
  source?: EditingInputSource
}

export interface EditingCommitInput {
  input: string | DisplayCellValue   // was: string
  move?: EditingCommitMove
  source?: EditingInputSource
}

export interface EditingCommitIntent {
  type: 'editing.commit'
  sheetId: string
  cell: CellCoord
  source: EditingInputSource
  input: string | DisplayCellValue   // was: string
  move: EditingCommitMove
}
```

```ts
// New backend port request

export interface SetCellRichValueRequest extends SheetRef {
  kind: 'set-cell-rich-value'
  row: number
  col: number
  value: DisplayCellValue
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

// SpreadsheetBackend addition (optional)
// setCellRichValue?(request: SetCellRichValueRequest): Promise<BackendMutationResult>
```

## Backend Port

`setCellInput` accepts a plain `string` and is unchanged for formula and
plain-text entry. A sibling **`setCellRichValue`** carries a structured
`DisplayCellValue`. Hosts that do not support rich values may omit it — the UI
core falls back to `setCellInput` with a text serialisation of the value (url
for hyperlinks, concatenated run text for rich-text).

The recommendation is **`setCellRichValue` as an optional sibling**, not a
parser-hint field on `setCellInput`, because:

- Keeps the existing string path zero-cost for plain editing
- Lets a host opt in to rich storage without changing its TSV parser
- The UI core can safely test for the method's presence before dispatch

No changes to `importCells` or `ImportCellInput` — bulk paste continues to use
plain-string inputs with TSV semantics.

## Integration Points

| Surface | Change |
|---------|--------|
| **Editing** | Draft atom widens; host editor receives `DisplayCellValue` when opening a rich cell and commits same type back |
| **Formula-bar** | Reads `draft`; when draft is `RichText` or `Hyperlink` renders a structured preview instead of raw string |
| **Clipboard** | TSV export: `displayValue` degrades — `RichText` → concatenated run text, `Hyperlink` → label or url. No HTML clipboard variant in this wave |
| **Projection** | `readVisibleProjection` / `readRangeProjection` return `DisplayCell[]`; hosts fill `displayValue` with the appropriate union member |
| **Toolbar** | Run-level formatting (bold a single run) requires caret position within the draft — partial scope. Cell-level bold via `setFormatRange` is unchanged |

## Risks & Open Questions

- **Breaking change in `displayValue`** — all host code that reads
  `displayValue` as a `string` will need a narrowing guard. A compatibility
  helper `displayValueText(v: DisplayCellValue): string` should ship alongside.
- **Host rendering complexity** — the UI core does not render; hosts that only
  handle `string` today must add a branch or cast. Document the fallback
  contract clearly.
- **Formula-bar vs in-cell run editing parity** — editing runs in the formula-bar
  and editing them inline have different caret models. Deferring in-cell run
  editing to a later wave is the safer path.
- **Hyperlink click target** — who handles navigation? The UI core emits an
  intent; the host decides whether to open a new tab, follow an app route, or
  prompt. The intent type is not yet defined.
- **Copy-as-text fallback semantics** — when a user copies a hyperlink, is the
  TSV text the label, the url, or `=HYPERLINK("url","label")`? Decision needed
  before clipboard integration lands.
- **`valueKind` vs `DisplayCellValue.kind` redundancy** — two sources of truth
  for the cell type. Consider whether `valueKind` can be derived from the union
  discriminant, or whether it serves a separate display-hint purpose.

## Test Surface

`test/rich-types.test.ts`

- Construct `DisplayCell` with each `DisplayCellValue` variant; assert type
  narrowing compiles and the `displayValueText` helper returns the right string.
- Round-trip a `Hyperlink` through an editing commit intent and back out of a
  projection result; confirm url and label survive.
- Round-trip a `RichText` with two runs (one bold, one plain) through the same
  path.
- TSV degradation: assert that a `RichText` cell exports the concatenated run
  text with no markup.
- Backend fallback: when `setCellRichValue` is absent on the adapter, the
  command falls back to `setCellInput` with the text serialisation.
- Extended `valueKind` values (`'currency'`, `'date'`, `'link'`, `'rich-text'`)
  are accepted without TypeScript error.
