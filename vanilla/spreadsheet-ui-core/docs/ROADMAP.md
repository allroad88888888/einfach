# ROADMAP

This index sequences the 20 missing-feature planning docs in `docs/` into four
implementation waves. Each wave is sized so its integration points land
together and the cross-doc "out of scope" notes resolve in order.

Charts, images, and floating objects are explicitly excluded from this set and
have no docs.

## Cross-cutting conventions

All 20 docs assume the same UI core invariants. They are listed here once so
each doc can stay focused on its own decisions.

- **Optional backend ports** — every `SpreadsheetBackend` method added by these
  features is optional. UI core hides the surface (toolbar items, menu entries,
  keyboard intents) when the host adapter omits the port.
- **State Decision Template** — every new module declares Source / Derived /
  Command atoms, scale bound, and per-cell/per-row atom risk. Atom
  `debugLabel` follows the `spreadsheet.<feature>.<name>` namespace.
- **`DisplayCell` additions** — many features extend `DisplayCell` with
  optional fields populated by the visible-window projection: `mergedSpan`,
  `mergeAnchor`, `validation`, `conditionalFormat`, `noteIndicator`,
  `commentThreadId`, `locked`, `originalRow`. The cell stays a value type; no
  atom families.
- **Bounded caches** — every cache of backend state declares an explicit cap
  (history 100, named-range list 500, presence cursors 32, find matches 500,
  unlocked ranges 256). Eviction policy is documented per feature.
- **Revision and cancellation** — new requests follow the existing optional
  `requestId` / `revision` / `cancelToken` shape.

## Wave 1 — Foundation completion

Half-built declarations plus the lowest-cost foundations. These mostly do not
touch the backend port surface. Land first so later waves build on a complete
substrate.

| Doc | Why first |
|---|---|
| [error-codes](./error-codes.md) | Many other docs assume a richer `SpreadsheetError`. Landing the taxonomy first prevents a second migration pass. |
| [history](./history.md) | Every other wave produces mutations; once history is in, those mutations route through one undo stack. |
| [clear-cells-endpoint](./clear-cells-endpoint.md) | `ClearCellsIntent` is already declared in keyboard but unconsumed. Closes a half-built API with one field on `ClearRangeRequest`. |
| [formula-reference-mode](./formula-reference-mode.md) | `KeyboardMode = 'formula-reference'` is already in the type. Unblocks formula-rule UX in data-validation and conditional-formatting. |
| [multi-range-selection](./multi-range-selection.md) | Widens `SelectionState` with no new backend port. Doing this early avoids touching every selection consumer twice. |

**Exit criteria.** `package-boundary.test.ts` stays green, no `DisplayCell`
shape changes yet, undo dispatches a transaction id that workspace revision
honors.

## Wave 2 — Workbook fact surfaces

Features whose canonical state lives in the backend and echoes through the
visible-window projection. They share visible-window math, so doing them in
one wave avoids revisiting it four times.

| Doc | Echo channel |
|---|---|
| [merge-cells](./merge-cells.md) | `DisplayCell.mergedSpan` / `mergeAnchor` |
| [frozen-panes](./frozen-panes.md) | New `viewportFreezeAtom`; four-quadrant projection requests |
| [hidden-rows-columns](./hidden-rows-columns.md) | `ViewportSizeProjectionResult.hiddenRowIndices` / `hiddenColIndices` |
| [named-ranges](./named-ranges.md) | Bounded cache atom; `shiftFormulaRefs` gains a name-token guard |

**Exit criteria.** `getVisibleWindow` derivation handles freeze quadrants and
hidden indices. Selection and keyboard navigation read merge metadata
transiently.

## Wave 3 — Cell-level semantics

Features that layer onto `DisplayCell` or gate the editing session. Each one
is independent; do them in any order within the wave.

| Doc | Surface |
|---|---|
| [cell-format-expansion](./cell-format-expansion.md) | Extends `SpreadsheetCellFormat`; toolbar dropdowns only |
| [auto-fill-series](./auto-fill-series.md) | Pointer fill-handle session + optional `fillSeries` port |
| [data-validation](./data-validation.md) | `DisplayCell.validation`; editor commit gate |
| [conditional-formatting](./conditional-formatting.md) | `DisplayCell.conditionalFormat` overlay |
| [rich-types-text-links](./rich-types-text-links.md) | `DisplayCell.displayValue` widens to a discriminated union |
| [comments-notes](./comments-notes.md) | `DisplayCell.noteIndicator` / `commentThreadId` |

**Exit criteria.** `DisplayCell` shape frozen; no further optional fields
planned.

## Wave 4 — Discoverability and sharing

Feature shell. Depends on the earlier waves but rarely on each other.

| Doc | Notes |
|---|---|
| [find-replace](./find-replace.md) | Needs error-codes for regex / timeout signals |
| [filter-sort](./filter-sort.md) | Touches hidden-rows-columns indirectly; landing after Wave 2 keeps visible-window logic stable |
| [protect-sheet-locked-cells](./protect-sheet-locked-cells.md) | Gates commands; reuses data-validation diagnostic patterns |
| [print-page-area](./print-page-area.md) | Mostly self-contained |
| [collab-presence](./collab-presence.md) | Depends on workspace revision metadata and history transaction ids |

## Luckysheet 1:1 push — Waves 5-8

Target reference: Luckysheet (https://github.com/dream-num/Luckysheet). Closes
the remaining gap between Wave 1-4 coverage (~56% of Luckysheet features) and
true 1:1 parity. Charts / images / floating objects / xlsx file I/O /
PivotTable stay excluded per project scope.

| Wave | Doc | Theme |
|---|---|---|
| 5 | [wave-5-shell-and-canvas-overlay](./wave-5-shell-and-canvas-overlay.md) | Top menubar (Luckysheet style, not Excel ribbon) + Name Box + Status Bar aggregates + Format Painter + canvas overlay for selection/decorations (DOM stays for cell text) |
| 6 | [wave-6-cell-format-complete](./wave-6-cell-format-complete.md) | Format Cells 5-tab dialog + text rotation / overflow / wrap + complete Number Format (12 categories + custom strings) |
| 7 | [wave-7-data-ops-and-navigation](./wave-7-data-ops-and-navigation.md) | Text to Columns + Remove Duplicates + Paste Special + Go To (Ctrl+G) + complete Data Validation + Copy as HTML/Markdown (7.4, pulled from Wave 8) |
| 8 | [wave-8-formula-extension-and-export](./wave-8-formula-extension-and-export.md) | Remote formulas + custom formulas (**shipped 2026-07-14, sync + async — see doc § 8.2 status note; as-built diverges from the original pending-reactor spec**) + array/matrix enhancements + range screenshot + copy as PNG (HTML/MD shipped early in Wave 7.4) |

**Cross-cutting decisions** (locked before implementation):

- Number Format parser lives in the projection / JS reference layer; the Rust
  engine continues to store raw values and is not aware of display format.
- Diagonal cell borders deferred to a later wave; `SpreadsheetBorders` keeps
  its 4-side shape for Wave 6.
- `removeDuplicates` equality uses the displayed value (Excel default), not
  raw cell input.
- Custom formula execution runs in the trusted host context, no sandbox
  (matches Luckysheet). A sandboxed variant can be added later if needed.
- Canvas overlay = the host renderer referenced by Wave 3 conditional
  formatting for the `@einfach/solid-excel` host. Other hosts may render
  differently.
- jsdom tests for canvas overlay use a mockable 2D context abstraction, not
  the `canvas` npm package.
- **Wave 7.4 — Copy as HTML / Markdown** (in progress). Framework-agnostic
  encoders live in `src/copy-as/` (`encodeSelectionAsHtml`,
  `encodeSelectionAsMarkdown`, `encodeSelectionAsPlainText`,
  `encodeSelectionForClipboard`) plus a `lastCopyAsAtom` source atom. Solid
  host binds Ctrl+Shift+C → `navigator.clipboard.write` of an `ItemList`
  with `text/html`, `text/markdown`, and `text/plain` flavours, falling
  back to `writeText` of the TSV when `ClipboardItem` is rejected. The PNG
  flavour stays in Wave 8 (depends on `exportRangeAsImage`).

## Dependency map

```
error-codes ──┬──> data-validation
              ├──> find-replace
              └──> diagnostics (existing)

history ──────┬──> every mutation feature (clear-cells, fill-series,
              │   format, validation, conditional-format, ...)
              └──> collab-presence (attribution)

formula-reference-mode ──┬──> data-validation (formula rules)
                         └──> conditional-formatting (formula rules)

merge-cells ──┬──> multi-range-selection (selection within a merge)
              ├──> auto-fill-series (fill across a merge)
              ├──> conditional-formatting (rule eval on anchor)
              └──> clipboard (existing — TSV expansion)

hidden-rows-columns <──> frozen-panes (combined visibility math)
hidden-rows-columns <──> filter-sort (parallel hiding mechanisms)

named-ranges ──> clipboard (shiftFormulaRefs name-token guard)
```

## Index

| Doc | Wave | Lines | One-line |
|---|---|---:|---|
| [auto-fill-series](./auto-fill-series.md) | 3 | 188 | Series detection (numbers/dates/weekdays) on the fill handle |
| [cell-format-expansion](./cell-format-expansion.md) | 3 | 232 | Borders, underline, strikethrough, wrap, indent |
| [clear-cells-endpoint](./clear-cells-endpoint.md) | 1 | 141 | Del / Ctrl+Del semantics; `ClearRangeRequest.target` field |
| [collab-presence](./collab-presence.md) | 4 | 251 | Remote cursors plus edit attribution; no socket in UI core |
| [comments-notes](./comments-notes.md) | 3 | 203 | Notes (plain) plus comment threads; F2 / Shift+F2 |
| [conditional-formatting](./conditional-formatting.md) | 3 | 346 | Rule-driven per-cell format overlay |
| [data-validation](./data-validation.md) | 3 | 175 | List / range / regex / formula rules; commit gate |
| [error-codes](./error-codes.md) | 1 | 197 | Open-string codes; severity + source; legacy auto-grade |
| [filter-sort](./filter-sort.md) | 4 | 209 | Column filters plus multi-key sort; virtual row indices |
| [find-replace](./find-replace.md) | 4 | 324 | Paged search plus batch replace; 500-coord cap in UI |
| [formula-reference-mode](./formula-reference-mode.md) | 1 | 270 | Caret-driven cell picking into a formula draft |
| [frozen-panes](./frozen-panes.md) | 2 | 290 | Per-sheet freeze; four-quadrant visible window |
| [hidden-rows-columns](./hidden-rows-columns.md) | 2 | 218 | Sparse index sets echoed via projection |
| [history](./history.md) | 1 | 289 | Backend-owned undo; transaction id; stack cap 100 |
| [merge-cells](./merge-cells.md) | 2 | 235 | Backend registry; projection echoes span / anchor |
| [multi-range-selection](./multi-range-selection.md) | 1 | 212 | `regions[]` plus `primaryIndex`; primary-only paste |
| [named-ranges](./named-ranges.md) | 2 | 214 | Bounded cache; formula tokenizer guard for name tokens |
| [print-page-area](./print-page-area.md) | 4 | 196 | Print area, manual breaks, scale; host renders |
| [protect-sheet-locked-cells](./protect-sheet-locked-cells.md) | 4 | 249 | `unlockedRanges` cap 256; partial-overlap rejected |
| [rich-types-text-links](./rich-types-text-links.md) | 3 | 213 | `DisplayCell.displayValue` discriminated union |

## What this index is not

- Not a delivery schedule. Wave order is dependency-shaped, not calendar-shaped.
- Not a contract. Every doc still owns its own decisions; the roadmap only
  sequences them.
- Not exhaustive. Charts, images, and floating objects are out of scope and
  have no docs in this set.
