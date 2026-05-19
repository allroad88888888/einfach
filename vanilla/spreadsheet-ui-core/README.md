# @einfach/spreadsheet-ui-core

Framework-agnostic spreadsheet UI core for the Einfach vnext stack. The package owns viewport math, visible-window projection contracts, selection, editing, keyboard, menus, toolbar, clipboard, sheet tabs, and 20 feature modules — backed entirely by `@einfach/core` atoms. It does not depend on Solid, React, the DOM, workers, or WASM; host adapters bring those.

## Feature waves

The 20 feature specs in `docs/` are sequenced into four implementation waves by `docs/ROADMAP.md`. Each doc declares its source / derived / command atoms and any optional backend port it adds.

### Wave 1 — Foundation completion

| Doc | Surface |
|---|---|
| [error-codes](./docs/error-codes.md) | Open-string error taxonomy + severity + source |
| [history](./docs/history.md) | Backend-owned undo stack with transaction ids (cap 100) |
| [clear-cells-endpoint](./docs/clear-cells-endpoint.md) | Del / Ctrl+Del semantics; `ClearRangeRequest.target` |
| [formula-reference-mode](./docs/formula-reference-mode.md) | Caret-driven cell picking into a formula draft |
| [multi-range-selection](./docs/multi-range-selection.md) | `regions[]` plus `primaryIndex`; primary-only paste |

### Wave 2 — Workbook fact surfaces

| Doc | Echo channel |
|---|---|
| [merge-cells](./docs/merge-cells.md) | `DisplayCell.mergedSpan` / `mergeAnchor` |
| [frozen-panes](./docs/frozen-panes.md) | `viewportFreezeAtom`; four-quadrant projection |
| [hidden-rows-columns](./docs/hidden-rows-columns.md) | `ViewportSizeProjectionResult.hiddenRowIndices` / `hiddenColIndices` |
| [named-ranges](./docs/named-ranges.md) | Bounded cache; tokenizer guard for name tokens |

### Wave 3 — Cell-level semantics

| Doc | Surface |
|---|---|
| [cell-format-expansion](./docs/cell-format-expansion.md) | Borders, underline, strikethrough, wrap, indent |
| [auto-fill-series](./docs/auto-fill-series.md) | Series detection on the fill handle |
| [data-validation](./docs/data-validation.md) | List / range / regex / formula rules; commit gate |
| [conditional-formatting](./docs/conditional-formatting.md) | Rule-driven per-cell format overlay |
| [rich-types-text-links](./docs/rich-types-text-links.md) | `DisplayCell.displayValue` discriminated union |
| [comments-notes](./docs/comments-notes.md) | Notes plus comment threads; F2 / Shift+F2 |

### Wave 4 — Discoverability and sharing

| Doc | Surface |
|---|---|
| [find-replace](./docs/find-replace.md) | Paged search plus batch replace; 500-coord cap |
| [filter-sort](./docs/filter-sort.md) | Column filters plus multi-key sort; virtual row indices |
| [protect-sheet-locked-cells](./docs/protect-sheet-locked-cells.md) | `unlockedRanges` cap 256; partial-overlap rejected |
| [print-page-area](./docs/print-page-area.md) | Print area, manual breaks, scale; host renders |
| [collab-presence](./docs/collab-presence.md) | Remote cursors plus edit attribution |

Charts, images, and floating objects are explicitly out of scope.

## Top-level src modules

| Folder | Owns |
|---|---|
| `src/backend/` | `SpreadsheetBackend` port, projection request/result types, mutation requests |
| `src/projection/` | Visible-window and range projection state |
| `src/viewport/` | Scroll metrics, visible window derivation, freeze quadrants, scroll-to-cell |
| `src/selection/` | Multi-range selection state and selection commands |
| `src/keyboard/` | Normalized keyboard intents and dispatcher |
| `src/pointer/` | Drag-selection, fill-handle, append-mode |
| `src/editing/` | Cell editor draft, focus, commit / cancel, diagnostics |
| `src/formula-bar/` | Formula bar draft + formula-reference picking |
| `src/formula-reference/` | Inline reference picking into a draft |
| `src/menu/`, `src/toolbar/` | Compact menu / toolbar command intents |
| `src/clipboard/` | TSV-shaped paste / copy intents (no clipboard API) |
| `src/sheet-tabs/` | Tab list, active sheet, reorder intents |
| `src/operations/` | Bulk insert / delete row / column intents |
| `src/workspace/` | Session revision metadata |
| `src/diagnostics/` | Bounded UI diagnostics buffer |
| `src/history/` | Transaction ids and undo / redo intents |
| `src/named-ranges/` | Bounded named-range cache and formula token guard |
| `src/find-replace/` | Search query, cursor, paged matches |
| `src/filter-sort/` | Filter and sort intent state |
| `src/conditional-formatting/` | Rule registry and projection overlay |
| `src/data-validation/` | Rule registry and commit-gate diagnostics |
| `src/comments/` | Note and comment-thread intents |
| `src/auto-fill/` | Fill-handle session and series intents |
| `src/rich-types/` | `DisplayCellRichValue` union and helpers |
| `src/presence/` | Remote cursor cache (cap 32) and subscribe intent |
| `src/print/` | Print config draft and preview state |
| `src/protection/` | Sheet protection and unlocked-range cache |
| `src/shared/` | Cross-feature primitives (`CellCoord`, `CellRange`, `SheetRef`, `SpreadsheetError`) |
| `src/createSpreadsheetUi.ts` | Wires a backend and store together |

Each feature folder documents its source / derived / command atoms in its own `README.md`.

## Backend port

`src/backend/types.ts` exports `SpreadsheetBackend`. Three methods are required (`readVisibleProjection`, `readRangeProjection`, `setCellInput`); 45+ feature methods are optional. UI core hides the surface (toolbar items, menu entries, keyboard intents) when the host adapter omits the port. See the root `CLAUDE.md` for the optional-method pattern and reference adapters in `solid/excel/src-vnext/adapter/`.

## Atom conventions

- `debugLabel = 'spreadsheet.<feature>.<name>'` on every atom (e.g. `spreadsheet.findReplace.cursor`).
- No per-cell, per-row, or per-column atom families. Large-table data flows through the visible-window projection or a bounded cache; caps are documented per feature.
- Mutation requests carry optional `requestId` / `revision` / `cancelToken` so workers can drop stale work.

## Testing

Roughly 700 atom-level unit tests live in `test/`. Each test creates a fresh store via `createStore()` and isolates atom interactions.

```bash
# Whole package
npx jest vanilla/spreadsheet-ui-core --no-coverage

# Single feature
npx jest vanilla/spreadsheet-ui-core/test/<feature>.test.ts --runInBand

# Type + boundary gate
npx tsc -p vanilla/spreadsheet-ui-core/tsconfig.json --noEmit --pretty false
npx jest vanilla/spreadsheet-ui-core/test/package-boundary.test.ts --runInBand
```

`package-boundary.test.ts` keeps imports of Solid, React, DOM runtime APIs, worker glue, and WASM glue out of the package root. Treat it as the canary for new transitive dependencies.

## Collaboration

Concurrent feature work is tracked in `docs/AGENT_COLLABORATION.md`. Update the in-flight kanban before touching a feature's file boundary; do not roll back another agent's dirty file mid-flight.
