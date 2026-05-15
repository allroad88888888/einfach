# Cell Format Expansion

Borders, underline, strikethrough, text wrap, indent.

## Goal

Extend `SpreadsheetCellFormat` with per-side border specs, underline,
strikethrough, text wrap, and indent level so the toolbar and keyboard layer
can write these attributes through the existing `setFormatRange` backend port.
No new backend methods are required.

## Scope

- **Borders**: per-side (top, right, bottom, left) with style, color, and
  weight. Diagonal borders are out of scope.
- **Underline**: single underline toggle (`boolean`).
- **Strikethrough**: toggle (`boolean`).
- **Text wrap**: toggle (`boolean`); interaction with row autofit is noted under
  Risks.
- **Indent**: non-negative integer (level count, not pixels).

### Out of scope

- Merge cells (sibling doc)
- Conditional formatting (sibling doc)
- Rich text runs / mixed inline formatting (sibling doc)
- Themes and named style presets

## State (UI core)

Border picker is a new toolbar surface requiring one addition to
`ToolbarDropdownKind`:

```ts
// toolbar/types.ts
export type ToolbarDropdownKind = 'alignment' | 'number-format' | 'border'
```

`ToolbarSurfaceId` inherits the addition automatically via union. No new atoms
are needed — `toolbarUiStateAtom` (kind `'dropdown'`, id `'border'`) covers the
open/closed lifecycle through the existing `openToolbarDropdownAtom` write path.

New `ToolbarFormatCommandKind` values for the dispatch surface:

```ts
| 'underline'
| 'strikethrough'
| 'wrap'
| 'indent-increase'
| 'indent-decrease'
| 'border'
```

`getToolbarCommandAvailability` gains matching boolean fields
(`underline`, `strikethrough`, `wrap`, `indent`, `border`), all gated on the
same `canStyleSelection` predicate used by `bold`/`italic`.

`debugLabel` rule: no new atoms are introduced; the existing atom labels
`spreadsheet.toolbar.ui` and `spreadsheet.toolbar.intent` cover these paths.

## Types

### New supporting types

```ts
export type SpreadsheetBorderStyle =
  | 'none'
  | 'thin'
  | 'medium'
  | 'thick'
  | 'dashed'
  | 'dotted'
  | 'double'

export interface SpreadsheetBorderSpec {
  style: SpreadsheetBorderStyle
  color?: string   // CSS hex or rgba; omit = theme default
  weight?: number  // logical weight hint; renderers may ignore when style implies weight
}

export interface SpreadsheetBorderSide {
  top?: SpreadsheetBorderSpec
  right?: SpreadsheetBorderSpec
  bottom?: SpreadsheetBorderSpec
  left?: SpreadsheetBorderSpec
}
```

### Updated `SpreadsheetCellFormat`

```ts
export interface SpreadsheetCellFormat {
  // existing
  numberFormat?: SpreadsheetNumberFormat
  bold?: boolean
  italic?: boolean
  align?: SpreadsheetAlignment
  fontSize?: number
  fgColor?: string
  bgColor?: string
  // new
  underline?: boolean
  strikethrough?: boolean
  wrap?: boolean
  indent?: number               // >= 0; 0 = no indent
  borders?: SpreadsheetBorderSide
}
```

All new fields are optional. The partial-update semantics in the next section
describe how `undefined` vs `null` is interpreted.

## Backend port

`setFormatRange` already accepts `SpreadsheetCellFormat | null` in
`SetFormatRangeRequest`. No new port methods are needed.

**Partial-update semantics** (to be adopted by all host adapters):

| Field value   | Meaning                                              |
|---------------|------------------------------------------------------|
| `undefined`   | Omitted — leave whatever the backend currently has   |
| `null`         | Not valid at the field level (only at request level) |
| explicit value | Override — backend must write this value             |

`format: null` at the request level means clear all formatting (existing
behaviour). Individual fields use `undefined`-as-omit because
`SpreadsheetCellFormat` already follows that pattern for `bold`, `italic`, etc.
This must be documented in the `backend/README.md` or a separate
partial-format doc so all adapter authors apply it consistently.

`borders` follows the same omit semantics per side: sending
`{ borders: { bottom: { style: 'thin' } } }` touches only the bottom border
and leaves top/right/left unchanged.

## Integration points

### Toolbar

- Add `'border'` to `ToolbarDropdownKind` (opens border picker panel).
- Extend `ToolbarFormatCommandKind` with `'underline'`, `'strikethrough'`,
  `'wrap'`, `'indent-increase'`, `'indent-decrease'`, `'border'`.
- Extend `ToolbarCommandAvailability` with matching boolean fields.
- `isToolbarFormatCommandAvailable` switch gains cases for each new command.
- Border picker emits a `toolbar.format.command` intent with
  `command: 'border'` and `value` encoding the side+style (e.g.
  `'bottom:thin:#000000'` — exact serialization is a renderer concern; the
  core just passes the string through).

### Projection (`DisplayCell.format`)

`DisplayCell.format` already carries `SpreadsheetCellFormat`. The expanded
fields are automatically available to renderers via the projection result with
no changes to `readVisibleProjection` or `readRangeProjection` signatures.

### Keyboard

Standard shortcuts dispatched through `dispatchToolbarFormatCommandAtom` (or a
keyboard-layer equivalent):

| Key        | Command         |
|------------|-----------------|
| `Ctrl+U`   | `underline`     |
| `Ctrl+5`   | `strikethrough` |

Indent increase/decrease can be bound to toolbar buttons or context-menu items;
no keyboard shortcut is standardised here (defer to the keyboard doc).

### Clipboard

Format round-trip on copy/paste is **not a goal for this work item**. The
clipboard doc (sibling) defines whether format metadata travels with TSV export.
For now, `importCells` and `importCellChunks` carry only cell inputs; format
paste is a separate feature flag that the clipboard sibling doc should address.

## Risks & open questions

- **Adjacent-cell border conflict**: when two cells each specify a shared edge
  (e.g. cell A's right border and cell B's left border differ), renderers must
  define a resolution rule (last-write wins, or priority by weight/style).
  This must be decided per adapter; the UI core ships no merge logic.

- **Indent unit**: indent is specified as a non-negative integer level, not
  pixels. Renderers translate level to pixels (e.g. 8 px per level). If a
  backend stores pixel offsets, the adapter is responsible for rounding to the
  nearest level on read, or the type should widen to `number` (fractional).
  Decide before first adapter implementation.

- **Wrap + row autofit interaction**: enabling `wrap: true` on a cell implies
  the row height must grow to show all content. Autofit (sibling: viewport size
  doc) currently measures the current visible DOM. Wrap state must be
  communicated to the autofit path, or a separate "wrap-triggered refit"
  command must be introduced.

- **`style: 'none'` vs omitting borders**: `SpreadsheetBorderSpec` with
  `style: 'none'` is an explicit "erase this side" signal, distinct from
  omitting the key (leave it). Adapters must honour this distinction; the
  partial-update semantics table above makes it explicit, but adapters need
  guard tests.

- **Underline and strikethrough rendering**: these are CSS text-decoration
  properties in DOM renderers, but canvas renderers must draw them manually.
  The type carries the boolean; per-renderer implementation is out of scope
  here.

- **`weight` field on `SpreadsheetBorderSpec`**: thin/medium/thick styles
  already imply a weight. The optional `weight` field is a hint only; renderers
  that rely on `style` alone should ignore it. Consider dropping `weight` to
  keep the type minimal.

## Test surface

File: `test/cell-format-expansion.test.ts`

Scope:

- **Type tests**: verify that the extended `SpreadsheetCellFormat` is
  assignable with all new optional fields present and absent.
- **`SpreadsheetBorderSide` partial assignment**: confirm that omitting sides
  compiles and that `style: 'none'` is a valid explicit erase.
- **Toolbar dispatch**: given a store with the existing toolbar atoms, confirm
  that `dispatchToolbarFormatCommandAtom` with `command: 'underline'`
  produces a `ToolbarFormatCommandIntent` with the correct shape, and that
  unavailable states (editing mode active) suppress the intent.
- **Dropdown kind guard**: confirm `isToolbarDropdownKind('border')` returns
  `true` after the type is added.
- **Availability flags**: `getToolbarCommandAvailability` returns `true` for
  `underline`, `strikethrough`, `wrap`, `indent`, `border` when
  `selectionKind === 'cell'` and `editingMode !== 'drafting'`.

No backend adapter tests here — those live in `test/backend*.test.ts` and are
owned by the host adapter implementations.
