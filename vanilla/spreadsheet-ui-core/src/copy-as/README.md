# copy-as

Pure encoders that serialise a `DisplayCell[]` projection of the active
selection into the three clipboard flavours the host writes on
`Ctrl+Shift+C`:

- `text/html` — a `<table>` with inline styles derived from each cell's
  `SpreadsheetCellFormat`.
- `text/plain` — Excel-compatible TSV (tab between columns, `\n` between
  rows; inner newlines and tabs collapsed to spaces).
- `text/markdown` — a GitHub Flavoured Markdown table.

The encoders are pure data transforms. They never touch the DOM, never
issue backend requests, and never read other atoms — the host hands them a
`CopyAsInput` snapshot built from the current projection and they hand back
strings.

## State Decision Template

- Source atoms: private Core backing atoms hold the latest successful result
  and user-visible status.
- Derived atoms: `lastCopyAsAtom` and `copyAsErrorAtom` are read-only public
  projections consumed by tests, diagnostics, and status surfaces.
- Commands: hosts publish successful payloads through
  `publishCopyAsResultAtom` and report or clear status through
  `reportCopyAsStatusAtom`. A total failure updates only status and preserves
  the previous successful result.
- Scale bound: one latest-result snapshot plus one small status value; no
  per-cell or per-range families. The result is replaced on each success.
- Backend reads: none. Copy-as consumes the `DisplayCell[]` the host has
  already projected for the rectangle (typically via
  `readRangeProjection` with `reason: 'clipboard'`).
- Per-cell atom risk: none — the snapshot is a single object.
- Tests: `test/copy-as.test.ts`.

## Public encoder API

```ts
export function encodeSelectionAsHtml(input: CopyAsInput): string
export function encodeSelectionAsMarkdown(input: CopyAsInput): string
export function encodeSelectionAsPlainText(input: CopyAsInput): string
export function encodeSelectionForClipboard(input: CopyAsInput): CopyAsResult
```

`CopyAsInput.cells` is sparse — only occupied cells from the projection.
The encoders iterate `rect`, not `cells`, so empty cells in the rectangle
render as empty `<td>` / blank GFM cell / empty plain-text column.

## HTML encoder semantics

- Root element: `<table style="border-collapse: collapse; border: 1px solid #ccc">`.
- One `<tr>` per row in `rect`; one `<td>` per column. Empty cells emit a
  `<td></td>` with the per-cell border + padding style but no content.
- Cell text is HTML-escaped (`&`, `<`, `>`, `"`, `'`); embedded line breaks
  become `<br>` after escaping.
- Per-cell style is derived from `DisplayCell.format`:

  | source field      | css                                       |
  | ----------------- | ----------------------------------------- |
  | `bold`            | `font-weight: bold`                       |
  | `italic`          | `font-style: italic`                      |
  | `underline`       | `text-decoration: underline`              |
  | `strikethrough`   | `text-decoration: line-through`           |
  | `underline` + `strikethrough` | `text-decoration: underline line-through` |
  | `align`           | `text-align: left/right/center/justify`   |
  | `verticalAlign`   | `vertical-align: top/middle/bottom`       |
  | `bgColor`         | `background-color`                        |
  | `fgColor`         | `color`                                   |
  | `fontFamily`      | `font-family`                             |
  | `fontSize` (pt)   | `font-size: Npt`                          |

  Alignment values without a clean CSS equivalent (`'fill'`,
  `'distributed'`) are dropped silently.

- Merge handling: when a `DisplayCell` carries `mergedSpan: { rows, cols }`
  with either dimension > 1, the encoder emits `rowspan="rows"` /
  `colspan="cols"` on the anchor `<td>` and **omits** the cells covered by
  the span entirely from the markup. Single-row / single-col degenerate
  spans (1×1) emit neither attribute.
- Optional `columnWidths` / `rowHeights` produce a `<colgroup>` with
  `<col style="width: Npx">` and `<tr style="height: Npx">` respectively;
  hosts that don't supply these maps get a layout-neutral table.

## Markdown encoder semantics

- First row of `rect` is the header row.
- Columns separated by ` | `, rows separated by `\n`.
- Separator after the header is a single ` --- ` per column.
- Cell text escaping: backslash doubled, `|` escaped as `\|`, newlines
  replaced with `<br>` (GFM table cells are single-line).
- Formatting: `**bold**` and `*italic*` wrap the cell text **after**
  escaping. Underline, strikethrough, colors, fonts, and number-format
  metadata are dropped silently — GFM tables can't express them.
- Empty cells emit a literal empty column (no `**` wrap, no whitespace
  surprises).

### Known limitation: merge cells in Markdown

GFM tables cannot express row/colspan. The merge anchor carries the
content; the covered cells render blank. Hosts that need lossless merge
round-trip should rely on the HTML flavour instead.

Detection uses both `DisplayCell.mergedSpan` (set on anchors) and
`DisplayCell.mergeAnchor` (set on covered cells, pointing back to the
anchor). The four anchor / covered × in-rect / out-of-rect combinations
behave as follows:

| anchor in rect | covered in rect | behaviour                            |
| -------------- | --------------- | ------------------------------------ |
| yes            | yes             | anchor writes content; covered blank |
| yes            | no              | anchor writes content (covered N/A)  |
| no             | yes             | covered renders blank (no leakage)   |
| no             | no              | merge ignored                        |

The "anchor outside the rect, covered cells inside" case used to leak the
covered cells' projection-side placeholder values into the table; the
encoder now blanks them so the selection rectangle is the only thing the
clipboard ever sees.

### Known limitation: clipped merges in HTML

When the selection rectangle only partially overlaps a merge, the HTML
encoder clips the emitted `rowspan` / `colspan` to the intersection so
the table can never reference cells outside the selection. When the true
anchor falls *outside* the rect, a synthetic anchor is placed at the
top-left of the intersection and rendered blank (no content is leaked
from outside the selection). The format on a synthetic anchor is also
omitted — only the true anchor carries style.

## Plain text (Excel-compatible TSV)

- `\t` between columns, `\n` between rows.
- Inner `\n` and `\t` in cell text are replaced with a single space —
  this mirrors what Excel does when it writes a multi-line cell to
  `text/plain`.
- No formatting; covered cells of a merge emit empty columns (the anchor
  emits its content once on its column index).

## Atom contract

```ts
export const lastCopyAsAtom: Atom<CopyAsResult | null>
export const copyAsErrorAtom: Atom<CopyAsError | null>
export const publishCopyAsResultAtom: WritableAtom<null, [CopyAsResult], void>
export const reportCopyAsStatusAtom: WritableAtom<null, [CopyAsError | null], void>
// debugLabel = 'spreadsheet.copyAs.last'
```

Core owns both private backing atoms. Hosts can only write through typed
commands; public consumers receive read-only projections. PNG publishes its
snapshot before attempting the system clipboard. Any later clipboard failure
reports degraded status without clearing that snapshot.

```mermaid
flowchart LR
  H[Host result or clipboard outcome] --> C{Core typed command}
  C -->|publishCopyAsResultAtom| R[private result backing]
  C -->|reportCopyAsStatusAtom| E[private status backing]
  R --> RP[readonly lastCopyAsAtom]
  E --> EP[readonly copyAsErrorAtom]
  F[Total failure] --> E
  F -. preserves previous result .-> R
```
