# Wave 6 — Cell format complete

Format Cells 5-tab dialog, text rotation / overflow / wrap rendering, and a
complete number-format pipeline for `@einfach/spreadsheet-ui-core` and the Solid
adapter.

## Purpose

Wave 3 (`cell-format-expansion`) widened `SpreadsheetCellFormat` with borders,
underline, strikethrough, wrap and indent. Wave 6 closes the rest of the
Luckysheet / Excel "Format Cells" surface:

- A single 5-tab modal that exposes every format attribute (Number, Alignment,
  Font, Border, Fill) in one place.
- Rendering wiring for text rotation, overflow into adjacent cells, wrap +
  row-height autofit, shrink-to-fit and distributed alignment.
- A complete number-format pipeline with the 12 standard categories, custom
  format strings, locale resolution and negative-display variants.

After Wave 6 no Excel formatting attribute should be unreachable from the UI
core or unable to round-trip through `setFormatRange`.

## Sub-feature inventory

| Sub-feature | New atoms | Type changes | Backend port changes |
|---|---|---|---|
| 6.1 Format Cells dialog | `formatCellsEditorAtom`, `openFormatCellsEditorAtom`, `closeFormatCellsEditorAtom`, `saveFormatCellsEditorAtom` | none beyond 6.2 / 6.3 below | none — reuses `setFormatRange` |
| 6.2 Text rotation / overflow / wrap | none (overflow projection only) | `SpreadsheetCellFormat.rotation`, `verticalAlign`, `overflow`, `shrinkToFit`; `SpreadsheetAlignment` widens | none |
| 6.3 Complete number format | none | `SpreadsheetNumberFormat` widens to 12 categories + `custom`; `SpreadsheetNumberFormatNegative`; `locale` hint | `setFormatRange` payload only |

The dialog never adds a backend method. It uses only `setFormatRange` (already
present) plus the visible-window projection. When the host omits
`setFormatRange` the menu entry that opens the dialog is hidden, matching
every other Wave 1–5 feature.

## 6.1 Format Cells dialog

Modal lives at
`excel/solid-excel/src-vnext/format-cells/SpreadsheetFormatCellsDialog.tsx`. It is
the only surface for editing rotation, vertical alignment, font family,
custom number-format strings, diagonal borders and pattern / gradient fills.
The toolbar keeps its quick-action buttons (bold, italic, fill-color palette)
and falls through to this dialog for the long tail.

### Tab 1: Number

Categories (matching Luckysheet / Excel ordering):

| Category | Default format string | Extra inputs |
|---|---|---|
| General | `General` | none |
| Number | `0.00` | decimals counter, thousands checkbox, negative variant |
| Currency | `"$"#,##0.00` | currency symbol picker, decimals, negative variant |
| Accounting | `_("$"* #,##0.00_)` | currency symbol, decimals |
| Date | `yyyy-mm-dd` | locale-aware preset list + custom string |
| Time | `hh:mm:ss` | 12 / 24 hour, fractional seconds toggle |
| Percentage | `0.00%` | decimals counter |
| Fraction | `# ?/?` | denominator size (one digit / two digits / fixed) |
| Scientific | `0.00E+00` | decimals counter |
| Text | `@` | none |
| Special | locale-bound (zip, phone) | preset list |
| Custom | user string | raw input + recent-format list |

Each category renders a live preview using a sample value taken from the
active cell. Edits flow into `draft.numberFormat` on `formatCellsEditorAtom`.
Switching categories does not discard draft for other tabs.

### Tab 2: Alignment

- Horizontal: `Left`, `Center`, `Right`, `Fill`, `Justify`, `Distributed`,
  `General` (default). Widens `SpreadsheetAlignment` (see 6.2).
- Vertical: `Top`, `Center`, `Bottom`, `Justify`, `Distributed`.
- Text rotation: integer slider from -90 to +90, plus a "vertical text"
  toggle that serializes as `rotation: 'vertical'`.
- Wrap text checkbox.
- Shrink to fit checkbox (mutually exclusive with wrap).
- Indent counter (>= 0).
- Text direction: `context`, `ltr`, `rtl`.

### Tab 3: Font

- Font family dropdown (host supplies the list via `formatCellsFontsAtom`,
  populated by the Solid adapter — UI core ships only the read-side atom).
- Size in points.
- Style: `bold`, `italic`, `underline` (single / double / accounting), and
  `strikethrough`.
- Foreground color picker.
- `superscript` / `subscript` toggle (mutually exclusive).

The single / double underline distinction lives only in the dialog draft; the
public type retains `underline?: boolean` plus a new `underlineStyle?: 'single'
| 'double' | 'accounting'` flag.

### Tab 4: Border

- Preset row: `None`, `Outline`, `Inside`, `Outline+Inside`.
- Per-side toggle buttons: top, bottom, left, right, diagonal-up,
  diagonal-down. Diagonals add two keys (`diagUp`, `diagDown`) to
  `SpreadsheetBorders` and are the only addition to that type in this wave.
- Style picker (reuses `SpreadsheetBorderStyle` from Wave 3).
- Color picker.
- Preview area renders the live border configuration on a sample cell.

### Tab 5: Fill

- Solid color picker (writes `bgColor`).
- Pattern picker: `solid`, `lined`, `dotted`, `crosshatch`. Pattern detail
  lives on a new `SpreadsheetCellFormat.fillPattern` field (optional, omit =
  solid).
- Gradient: simple two-stop linear with start color, end color and angle
  (`0`, `45`, `90`, `180`). Stored as `fillGradient?: { from, to, angle }`.

The dialog explicitly does not expose textures, images or theme-derived fills
in this wave.

### Atoms required

All four atoms live in a new module `src/format-cells/`:

- `formatCellsEditorAtom` — `atom<FormatCellsEditorState>` (source). Status,
  target range, draft (`SpreadsheetCellFormat`), active tab, dirty flag.
  `debugLabel = 'spreadsheet.formatCells.editor'`.
- `openFormatCellsEditorAtom` — command. Takes `{ range, initialFormat,
  initialTab? }`. Seeds `draft` with a clone of `initialFormat` (so cancel
  reverts trivially).
- `closeFormatCellsEditorAtom` — command. Discards `draft`, sets
  `status: 'closed'`. Used by Cancel and Escape.
- `saveFormatCellsEditorAtom` — async command. Reads `draft` and `target`,
  calls `backend.setFormatRange`, then closes on success. On rejection emits a
  diagnostic and keeps the dialog open with the draft intact.

Recommend keeping tab id as a field on `formatCellsEditorAtom` (one source
atom per modal, mirroring `validationRuleEditor` and
`conditionalFormatEditor`). Draft state must live in store atoms, not Solid
`createSignal`: the Solid Provider may remount between dialog open and submit
and would otherwise lose the user's work.

### Backend port additions

None. `setFormatRange?(request: SetFormatRangeRequest): Promise<BackendMutationResult>`
already accepts a full `SpreadsheetCellFormat | null`. The semantics declared
in `cell-format-expansion.md` apply unchanged: `undefined` field = leave alone,
explicit value = override, `format: null` = clear all.

The dialog sends a *full* draft (merged with the original format on open), not
a sparse diff, so backends that interpret `undefined` as "leave alone" and
backends that interpret it as "clear" behave the same. Adapters that want diff
semantics compute the diff themselves.

### Test plan

File: `test/format-cells-editor.test.ts`.

- `openFormatCellsEditorAtom` seeds `draft` with a deep clone of
  `initialFormat` (mutating the draft must not mutate the seed).
- `closeFormatCellsEditorAtom` resets status to `'closed'` and clears draft.
- `saveFormatCellsEditorAtom` is a no-op when `backend.setFormatRange` is
  absent and emits a diagnostic.
- `saveFormatCellsEditorAtom` calls `setFormatRange` with the merged draft
  and closes on success.
- Switching tabs preserves per-tab draft fields (set bold on Font tab,
  switch to Border, switch back, bold remains true).
- Cancel does not call `setFormatRange`.

### Risks

- **Surface explosion.** Five tabs is a lot of UI for one modal. Draft shape
  must stay a single `SpreadsheetCellFormat` plus tab id, not a per-tab
  object, to avoid combinatorial state.
- **Toolbar / dialog divergence.** Dialog save must not bypass the toolbar's
  `dispatchToolbarFormatCommandAtom` availability gates (locked cells,
  protected sheets). Route save through the same gate.
- **Font list source.** UI core cannot enumerate fonts; adapter supplies
  them. Default to empty; dialog degrades gracefully when none supplied.

## 6.2 Text rotation / overflow / wrap

### Atoms required

None new on the UI core side. All five attributes live on
`SpreadsheetCellFormat`:

| Field | Type | Default |
|---|---|---|
| `rotation` | `number \| 'vertical'` | `0` |
| `verticalAlign` | `'top' \| 'center' \| 'bottom' \| 'justify' \| 'distributed'` | `'bottom'` |
| `overflow` | `'clip' \| 'ellipsis' \| 'overflow'` | `'overflow'` for text, `'clip'` for numbers |
| `shrinkToFit` | `boolean` | `false` |
| `align` (widened) | `... \| 'fill' \| 'justify' \| 'distributed'` | unchanged |

`SpreadsheetAlignment` widens from `'default' | 'left' | 'center' | 'right'`
to include `'fill'`, `'justify'`, `'distributed'`. The package-boundary test
must accept the wider union.

### Rendering changes

The UI core ships only the attributes. The Solid adapter at
`excel/solid-excel/src-vnext/grid/` is responsible for:

- `transform: rotate(${rotation}deg)` on the inner span;
  `rotation: 'vertical'` renders as `writing-mode: vertical-rl`.
- `overflow: 'ellipsis'` → `text-overflow: ellipsis; overflow: hidden`.
- `overflow: 'overflow'` (Excel default for left-aligned text) paints into
  the adjacent cell rect only when the right neighbour is blank; the
  renderer reads `DisplayCell.valueKind` on neighbours from the existing
  visible-window projection.
- `shrinkToFit` measures the rendered text and reduces font-size.
- `wrap: true` plus row autofit recomputes row height via the Wave 2
  `viewportSize` projection request.
- `'distributed'` uses `text-align: justify; text-align-last: justify`.

If Wave 5 (canvas overlay) ships first, the canvas renderer implements
rotation via `ctx.translate / ctx.rotate` and overflow via a clip region.

### Test plan

File: `test/cell-format-rotation.test.ts`.

- Type test: `SpreadsheetCellFormat` accepts all five new fields, each
  individually and combined.
- Type test: `align: 'fill' | 'justify' | 'distributed'` compiles.
- Round-trip test: `setFormatRange` with `{ rotation: 45 }` is forwarded
  verbatim to the backend; subsequent visible-window projection echoes
  `rotation: 45` back through `DisplayCell.format`.
- Wrap + shrink-to-fit are mutually exclusive at the type level — confirmed
  with a runtime guard in `saveFormatCellsEditorAtom` that prefers `wrap`
  if both are set (or rejects — decide before first adapter ships).

### Risks

- **Row-height autofit on wrap.** Wrap requires measuring text after layout.
  The UI core signals intent; the Solid adapter wires the measurement back
  into the row-height atom via the existing autofit pipeline.
- **Frozen panes interaction.** `overflow: 'overflow'` cannot cross the
  freeze boundary; the renderer clips per quadrant.
- **Rotation + merge anchor.** Rotation on a merged cell rotates only the
  anchor's text; renderer reads `DisplayCell.mergeAnchor` first.
- **Vertical text vs rotation 90.** `'vertical'` is character stacking;
  `rotation: 90` is a rotated baseline. They are different — keep both.

## 6.3 Complete number format

### Categories table

```ts
export type SpreadsheetNumberFormat =
  | { kind: 'general' }
  | { kind: 'number'; digits?: number; thousands?: boolean; negative?: SpreadsheetNumberFormatNegative }
  | { kind: 'currency'; symbol?: string; digits?: number; negative?: SpreadsheetNumberFormatNegative }
  | { kind: 'accounting'; symbol?: string; digits?: number }
  | { kind: 'date'; pattern?: string }
  | { kind: 'time'; pattern?: string }
  | { kind: 'percent'; digits?: number; negative?: SpreadsheetNumberFormatNegative }
  | { kind: 'fraction'; denominator?: 'one-digit' | 'two-digit' | 'three-digit' | number }
  | { kind: 'scientific'; digits?: number }
  | { kind: 'text' }
  | { kind: 'special'; preset: string; locale?: string }
  | { kind: 'custom'; pattern: string }

export type SpreadsheetNumberFormatNegative =
  | 'minus'
  | 'red'
  | 'parens'
  | 'red-parens'
```

The existing variants (`general`, `decimal`, `percent`, `currency`, `date`)
remain readable. The `decimal` kind renames to `number` — adapters must accept
the alias for one wave before it is removed.

### Custom format string syntax

The `custom` variant carries an Excel-compatible format string. Supported tokens
(minimum viable set; widening is a follow-up):

- `0` — required digit (pad with zero).
- `#` — optional digit.
- `?` — optional digit (pad with space, for fraction alignment).
- `.` — decimal separator.
- `,` — thousands separator (locale-resolved at render).
- `;` — section delimiter. Up to four sections: positive, negative, zero,
  text.
- `[Red]`, `[Blue]`, `[Green]`, `[Black]`, `[White]`, `[Cyan]`, `[Magenta]`,
  `[Yellow]` — color tags.
- `[>0]`, `[<0]`, `[=0]`, `[>=...]` — condition tags on a section.
- `"literal"` — literal text.
- `\<char>` — escaped literal.

Unsupported in this wave: `*`, `_` (currency padding for the Accounting
preset is hardcoded — not parsed from custom strings), locale tags
(`[$-409]`), `@` repetition, fractional seconds modifier on time. Document
these as known gaps.

### Locale handling

The format string is locale-agnostic. Rendering resolves `,` and `.` against a
locale supplied per workbook on the backend. A new optional field on
`SpreadsheetCellFormat`:

```ts
export interface SpreadsheetCellFormat {
  // ...existing
  locale?: string  // BCP-47 tag; omit = workbook default
}
```

The UI core does not run the formatter — the backend produces
`DisplayCell.displayValue` already formatted, and the dialog preview is
computed by the adapter via a host-supplied formatter callback registered
through a new optional context method (TBD; see Risks).

### Engine touch-points

The Rust engine (if Wave 5 wired it in) already owns number formatting because
`displayValue` is computed by the engine, not the UI. The engine must:

- Parse the format string (Excel-compatible).
- Apply the negative variant and color tag to the rendered string and a
  separate color hint sent on `DisplayCell.format.fgColor` (or a dedicated
  `displayColor` field — decide before adapter implementation).
- Resolve locale separators.

The UI core ships only the type. If the engine is the JS reference
implementation, it must handle the custom parser; if the engine is Rust, the
parser lives in Rust and the JS reference must mirror it.

### Test plan

File: `test/cell-format-number.test.ts`.

- Type test: every new `SpreadsheetNumberFormat` variant is assignable.
- Alias test: passing `{ kind: 'decimal' }` through `setFormatRange` is
  accepted by the type guard (with a deprecation note).
- Negative-variant test: setting `negative: 'red-parens'` survives round-trip.
- Custom-pattern test: setting `{ kind: 'custom', pattern: '#,##0.00;[Red]
  (#,##0.00);"-"' }` round-trips through the projection.

The actual *evaluation* of custom patterns is tested in the engine, not in
the UI core.

### Risks

- **Custom format parser is non-trivial.** A faithful Excel parser is several
  hundred lines. Document the supported subset; unsupported tokens pass
  through with a diagnostic.
- **Preview without an engine.** Per-keystroke preview requires running the
  formatter at draft time. Recommend a host callback registered on the Solid
  Provider; UI core declares the contract only.
- **Locale propagation.** Add a `workbookLocaleAtom` (source, populated by
  the host adapter) if one is not yet modelled.
- **Color tag vs `fgColor`.** Define precedence between `[Red]` section tag
  and explicit `fgColor`. Recommend tag wins (matches Excel).

## File impact estimate

- `src/format-cells/` — new module (`index.ts`, `types.ts`, `README.md`),
  ~150 lines.
- `src/backend/types.ts` — widen `SpreadsheetCellFormat`,
  `SpreadsheetNumberFormat`, `SpreadsheetAlignment`, `SpreadsheetBorders`.
- `src/index.ts` — re-export new module.
- 3 new core test files; `test/package-boundary.test.ts` updated.
- `excel/solid-excel/src-vnext/format-cells/SpreadsheetFormatCellsDialog.tsx` —
  new. `excel/solid-excel/src-vnext/grid/` — rotation / overflow / wrap.
  `excel/solid-excel/src-vnext/toolbar/SpreadsheetToolbar.tsx` — "More formats"
  entry.

## Test impact

- 3 new core test files (editor, rotation, number).
- Package boundary test updated.
- Adapter Playwright e2e: open the dialog from the toolbar, edit each tab,
  save, confirm projection echo.

No existing test should break: the type changes are additive (existing fields
remain optional, existing variants remain assignable except for the `decimal`
→ `number` rename, which is aliased for one wave).

## Risks and unknowns

- **Engine ownership of the custom parser.** If the Rust engine plan is the
  ground truth, this wave depends on it adding a Luckysheet / Excel-compatible
  formatter. Block the dialog ship on that decision.
- **Preview latency.** A backend round-trip per keystroke is too slow.
  Require either a JS formatter in the adapter or a synchronous
  `formatNumber(value, pattern, locale)` helper from the engine via context.
- **`underline` widening.** Going from `boolean` to a union is a breaking
  shape change. Add a separate `underlineStyle?:` field instead.
- **Toolbar / dialog duplication.** Keep both — toolbar is the fast path,
  dialog is the long tail.
- **Gradient fill on canvas vs DOM.** Two-stop only, so the serialised
  payload stays bounded for both renderers.

## Out of scope

- Theme-derived fills, textures, image fills.
- Icon sets in conditional formatting (separate doc).
- Rich-text per-run formatting inside one cell (covered by
  `rich-types-text-links.md`).
- Format painter / format brush UX (separate keyboard / pointer surface).
- Live preview of the format painter — independent feature.
- Importing Excel format strings from XLSX files (host adapter concern).
- Charts, conditional-format data bars and color scales (Wave 3 sibling
  docs already own these).
