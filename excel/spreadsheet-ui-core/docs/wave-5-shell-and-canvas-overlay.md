# Wave 5 — Visual shell + Canvas overlay

Planning doc for the shell-and-overlay wave of `@einfach/spreadsheet-ui-core`
and `@einfach/solid-excel`'s `src-vnext/` integration.

---

## Purpose

Waves 1–4 closed the data-shape and command surfaces. The grid still
renders entirely through `<td>` nodes (see
`excel/solid-excel/src-vnext/grid/SpreadsheetGrid.tsx`); the chrome is a flat
toolbar plus a single-line status bar; and there is no top-level entry
point matching Luckysheet's File / Edit / Insert / Format / Data / View /
Help discoverability. Wave 5 lands the visual shell (menu bar, name box,
enriched status bar, format painter) and introduces a `<canvas>` overlay so
selection decorations, fill handles, marching ants, and conditional-format
overlays render at frame rate independent of the DOM grid. The wave is
intentionally hybrid: cell text and the editing input stay in DOM so
accessibility, copy-from-cell, and the existing Solid `<For>` over `<td>`
rendering keep working. The canvas owns *decorations only*; a full canvas
migration of cell text is explicitly deferred.

---

## Sub-feature inventory

| Sub | Feature | Surface | New atoms |
|---|---|---|---:|
| 5.1 | Top menu bar (Luckysheet-style) | Above toolbar | 3 public projections |
| 5.2 | Name box | Left of formula bar | 2 source + 1 derived |
| 5.3 | Status bar enhanced | Below grid | 4 |
| 5.4 | Format painter | Toolbar button + cursor mode | 2 |
| 5.5 | Canvas overlay | Inside grid container | 0 new (subscribes only) |

All five ship together. None changes the `DisplayCell` shape or any backend
port — this wave is host-side and atom-only.

---

## 5.1 Top menu bar

### Atoms

New module: `src/menu-bar/`, distinct from `src/menu/` which owns the cell
context menu (see `excel/spreadsheet-ui-core/src/menu/types.ts`).

- `topMenuOpenAtom` — read-only `Atom<TopMenuOpenState>`. The state is
  `{ kind: 'idle' }` or `{ kind: 'open'; menu: TopMenuId }`.
- `topMenuHighlightAtom` — read-only `Atom<string | null>`. It is currently
  always `null`; directional item highlighting has not been implemented.
- `helpOverlayAtom` — read-only `Atom<'closed' | 'shortcuts' | 'about'>`.

```ts
export type TopMenuId =
  | 'file' | 'edit' | 'insert' | 'format' | 'data' | 'view' | 'help'
```

Module-private backing atoms own those values. `openTopMenuAtom`,
`closeTopMenuAtom`, `openHelpOverlayAtom`, and `closeHelpOverlayAtom` are the
public write boundary. The first two also clear the private highlight state.

The static `MENU_BAR_ITEMS` registry in `src/menu-bar/index.ts` declares each
category's labels, dispatch descriptor, availability mode, and optional
capability key. The Solid host maps those descriptors to existing command
atoms; placeholder and capability-gated entries remain explicit in the
registry.

Item map:

- **File** — New / Open (placeholder) / Save (placeholder) / Print Preview
  / Close
- **Edit** — Undo / Redo / Cut / Copy / Copy As / Paste / Paste Special /
  Find / Replace / Go To / Delete cells / Select All
- **Insert** — Insert rows / cols (context-menu commands) / Insert sheet /
  Hyperlink (placeholder) / Comment / Name Manager
- **Format** — Format Cells (Wave 6 placeholder) / Cell color / Text color
  / Bold / Italic / Underline / Conditional Formatting / Data Validation /
  Hide row / Hide col / Freeze panes
- **Data** — Sort / Filter / Text to Columns and Remove Duplicates
  (capability-gated) / Data Validation
- **View** — Zoom / Show formula bar / Show gridlines / Show headings /
  Freeze panes / Full screen
- **Help** — About / Keyboard shortcuts

### Backend port additions

None. All targets resolve through existing atoms.

### UI components

- `excel/solid-excel/src-vnext/menu-bar/SpreadsheetMenuBar.tsx`
- Mounted by the vNext worker demos above `SpreadsheetToolbar`.

### Interaction states

`idle` → `open(menu)`. Clicking another category or hovering it while a menu
is open switches directly to `open(other menu)`. `Esc`, an outside click, or
dispatching an enabled item returns to `idle`. There is no `dispatching`
state, and arrow-key item navigation is not implemented. Help overlays follow
their own `closed` / `shortcuts` / `about` state flow.

### Test plan

`test/menu-bar.test.ts`:

- Public menu and Help state atoms are compile-time and runtime read-only.
- Command atoms retain their write signatures and current readable values.
- Open / switch / close and Help overlay transitions remain store-isolated.
- A source scan keeps backing atoms private and forbids direct public-state
  writes. Host registry routing and disabled entries remain covered by the
  Solid `vnext-menu-bar` regression suite.

### Risks

- **Item drift.** Later waves add commands; `MENU_BAR_ITEMS` must stay in
  sync. Mitigated by the registry-test assertion.
- Two "Data Validation" entries (Format and Data menus) both route to
  `openValidationRuleEditorAtom`; intentional, matches Luckysheet.

---

## 5.2 Name Box

### Atoms

New module: `src/name-box/`.

- `nameBoxInputAtom` — `atom<string>`. Draft text being typed.
- `nameBoxModeAtom` — `atom<'idle' | 'typing' | 'committing'>`.
- `nameBoxDisplayAtom` — derived. Reads `selectionSnapshotAtom` and
  `nameRegistryCacheAtom` (already exists, see
  `src/named-ranges/index.ts`); returns either the matching name or an A1
  address string.
- `commitNameBoxAtom` — command. Parses the input as:
  1. cell address (`B10`) → `selectCellAtom`,
  2. A1 range (`B2:D5`) → `setSelectionAtom`,
  3. existing name → `selectCellAtom` on the name's anchor,
  4. new identifier → `openNameManagerAtom` with the typed name and
     current selection pre-filled.

All atoms use the `spreadsheet.nameBox.*` debugLabel namespace.

### Backend port additions

None. New-name creation routes through the existing name-manager flow
(Wave 2) which already owns the `setNamedRanges` port.

### UI components

- `excel/solid-excel/src-vnext/name-box/SpreadsheetNameBox.tsx`, mounted in
  the formula-bar row, left of
  `excel/solid-excel/src-vnext/formula-bar/SpreadsheetFormulaBar.tsx`. The
  existing `formula-bar-addr` span inside that file is replaced.

### Interaction states

- `idle` — read-only display reflects `nameBoxDisplayAtom`.
- `typing` — input focused; `nameBoxInputAtom` tracks value.
- `committing` — `Enter` or blur runs `commitNameBoxAtom`. On parse
  failure, input is reset to display and mode returns to `idle`. `Esc`
  reverts.

### Test plan

`test/name-box.test.ts`:

- Display returns A1 for a single cell; returns the name when selection
  exactly matches a registered range.
- `commitNameBoxAtom('B10')` dispatches `selectCellAtom`;
  `commitNameBoxAtom('B2:D5')` dispatches `setSelectionAtom`.
- `commitNameBoxAtom('MyRange')` resolves via `nameRegistryCacheAtom`.
- `commitNameBoxAtom('NewName')` (no match, valid identifier) opens the
  name manager via `openNameManagerAtom`.
- Invalid input reverts state.

### Risks

- A1 vs R1C1 ambiguity. Wave 5 is A1 only; R1C1 deferred.
- Locale-dependent name validity reuses the existing Wave 2 validator.

---

## 5.3 Status Bar enhanced

### Atoms

New module: `src/status-bar/`. The host bar at
`excel/solid-excel/src-vnext/status-bar/SpreadsheetStatusBar.tsx` currently
hard-codes its fields; we move host-agnostic state into core.

- `selectionAggregatesAtom` — derived
  `atom<SelectionAggregates>`. Reads `visibleWindowAtom` and the active
  selection range to compute
  `{ sum, average, count, numericCount, min, max, truncated }`. Selections
  exceeding the visible window set `truncated: true`.
- `statusBarAggregateConfigAtom` — `atom<readonly AggregateKey[]>`.
  Which aggregates show; click toggles. Persistence is host-side.
- `zoomLevelAtom` — `atom<number>` snapping to
  `[0.5, 0.75, 1, 1.25, 1.5, 2]`.
- `viewModeAtom` — `atom<'normal' | 'page-break-preview' | 'page-layout'>`.
  Wired now; rendering of non-normal modes deferred.
- `inputModeAtom` — derived `atom<'ready' | 'edit' | 'enter' | 'point'>`
  from `editingSessionAtom`, `formulaBarStateAtom`, and the
  formula-reference module.

debugLabels under `spreadsheet.statusBar.*`, `spreadsheet.zoom.*`,
`spreadsheet.viewMode`, `spreadsheet.inputMode`.

### Backend port additions

None. Aggregates compute from already-projected cells.

### UI components

- `excel/solid-excel/src-vnext/status-bar/SpreadsheetStatusBar.tsx` (modified)
- `excel/solid-excel/src-vnext/status-bar/AggregatePicker.tsx` (new)
- `excel/solid-excel/src-vnext/status-bar/ZoomSlider.tsx` (new)

### Interaction states

- Aggregate labels: click toggles inclusion in
  `statusBarAggregateConfigAtom`; right-click opens the picker for all
  keys.
- Zoom slider: drag updates `zoomLevelAtom`; the grid scales via row /
  column-size multipliers on `viewportMetricsAtom` with no projection
  re-request. Pinch-to-zoom on trackpad (`wheel + ctrlKey`) is optional.
- Mode badges read `inputModeAtom`.

### Test plan

`test/status-bar-aggregates.test.ts`:

- Sum / average / count over a 3-cell numeric range matches expected math.
- `numericCount` excludes strings.
- Out-of-visible-window selection returns `truncated: true`.
- `statusBarAggregateConfigAtom` toggle leaves other keys untouched.
- `zoomLevelAtom` snaps to the nearest discrete level on out-of-range
  writes.
- `inputModeAtom` returns `edit` when `editingSessionAtom.status` is
  `'drafting'`, `point` when formula-reference mode is active.

### Risks

- Aggregate cost on huge selections. The visible-window bound is the
  safeguard; `truncated` must surface in the UI.
- `zoomLevelAtom` interaction with `viewportSizeOverridesAtom` (manual
  resizes). Wave 5 picks: user overrides are 100%-baseline, zoom
  multiplies on top. Revisit if drift becomes noticeable.

---

## 5.4 Format Painter

### Atoms

New module: `src/format-painter/`.

- `formatPainterStateAtom` — `atom<'idle' | 'armed' | 'sticky'>`.
- `formatPainterClipboardAtom` — `atom<CapturedFormat | null>`.

```ts
export interface CapturedFormat {
  format: SpreadsheetCellFormat
  conditionalFormat?: DisplayCell['conditionalFormat']
  validation?: DisplayCell['validation']
}
```

Commands:

- `armFormatPainterAtom('armed' | 'sticky')` — captures the active cell's
  format / conditionalFormat / validation into
  `formatPainterClipboardAtom`.
- `applyFormatPainterAtom(target)` — dispatches the equivalent of
  `dispatchToolbarFormatCommandAtom` for each captured field. In `'armed'`
  mode transitions back to `'idle'`; in `'sticky'` stays.
- `cancelFormatPainterAtom` — resets to `'idle'`, clears clipboard. Fired
  on `Esc`.

### Backend port additions

None. Apply re-uses the existing format command pipeline.

### UI components

- `excel/solid-excel/src-vnext/toolbar/SpreadsheetToolbar.tsx` adds a
  `format-painter` command to `toolbarCommands`, with `onDoubleClick`
  entering sticky mode.
- `excel/solid-excel/src-vnext/grid/SpreadsheetGrid.tsx` reads
  `formatPainterStateAtom` to switch the CSS cursor on the grid surface.

### Interaction states

`idle` → `armed` (single click; cursor becomes paintbrush; next cell click
applies and returns to `idle`) → `sticky` (double-click button; applies on
every click until `Esc`).

### Test plan

`test/format-painter.test.ts`:

- `armFormatPainterAtom('armed')` captures `SpreadsheetCellFormat`.
- `applyFormatPainterAtom(target)` dispatches and clears state in
  `'armed'`.
- In `'sticky'` mode two consecutive applies both succeed.
- `cancelFormatPainterAtom` resets cleanly.
- Captured payload includes conditional format and validation.

### Risks

- Scope: format painter copies *format only*, not values or formulas.
  Document explicitly so the Edit / Paste Special placeholder is not
  conflated.
- Capturing conditional format and validation depends on Wave 3
  `DisplayCell` extensions, which are already done.

---

## 5.5 Canvas overlay

### Architecture

A single `<canvas data-testid="grid-overlay-canvas">` is absolutely
positioned over the grid scroll container with
`inset: 0; pointer-events: none`. Clicks pass through to the DOM cells
underneath; the canvas never owns hit testing, focus, or cell text.

An `OverlayRenderer` class at
`excel/solid-excel/src-vnext/grid/overlay/OverlayRenderer.ts` is constructed
once per grid mount, holds the 2D context, and exposes:

```ts
class OverlayRenderer {
  attach(canvas: HTMLCanvasElement, store: SpreadsheetUiStore): void
  detach(): void
  markDirty(reason: OverlayDirtyReason): void
}
```

A Solid wrapper `SpreadsheetGridOverlay.tsx` mounts the canvas, creates
the renderer, subscribes (via `useSpreadsheetUiStore().sub`) to a small
set of decoration atoms, and forwards `markDirty` on every change.

### What draws on canvas (decorations layer)

- Primary selection rectangle and active-cell border (Excel-style 2px
  accent green) — `selectionRangeAtom` + `activeCellAtom`.
- Secondary selection rectangles for multi-range — `selectionRegionsAtom`.
- Fill handle at the primary region's bottom-right — `selectionRangeAtom`.
- Fill-drag preview during a pointer fill session — `pointerSessionAtom`
  plus existing helpers `getFillHandleSourceCoord` and
  `getFillHandleWriteRange`.
- Merge-cell outer borders — `DisplayCell.mergedSpan` on the anchor.
- Conditional-format overlays (data-bar backgrounds, color-scale gradients
  drawn under the DOM cell text) — `DisplayCell.conditionalFormat`.
- Marching-ants for cut / copy clipboard source — `clipboardStateAtom`.
- Frozen pane divider lines — `viewportFreezeAtom` non-zero.
- Paste drop indicator.

### What stays DOM

- Cell text and rich-value runs (`<td>` children).
- Editing input overlay positioned over the active cell.
- Row-number column and column-letter row.
- ARIA mirror layer; the canvas is `aria-hidden`.
- Context menu, dialogs, dropdowns.

### Atom dependencies (read-only)

The renderer subscribes to (and re-draws only on changes to):

- `selectionRangeAtom`, `selectionRegionsAtom`, `activeCellAtom`
- `pointerSessionAtom`
- `clipboardStateAtom`
- `viewportMetricsAtom`, `viewportFreezeAtom`, `viewportHiddenAtom`
- `spreadsheetProjectionSnapshotAtom` (host atom in
  `excel/solid-excel/src-vnext/provider/atoms.ts`, for `conditionalFormat` /
  `mergedSpan` data)
- `zoomLevelAtom`

The overlay never reads cell text or formulas, never subscribes to
`formulaBarDraftAtom`, and never touches per-cell atom families.

### Render loop strategy (rAF + dirty flag)

A single boolean `dirty` is set by any subscribed atom's listener. When
`dirty = true`, exactly one `requestAnimationFrame` is scheduled; its
callback reads atom snapshots via `store.getter`, clears the canvas, draws
all layers in fixed order, then resets `dirty`. The renderer never re-draws
synchronously inside an atom listener. Marching ants runs a separate
sub-loop only while `clipboardStateAtom.kind === 'copy' | 'cut'`, advancing
the dash offset every ~120 ms; it stops on `clearClipboardAtom`.

### DPR / retina handling

Canvas backing-store is `cssWidth * devicePixelRatio` by
`cssHeight * devicePixelRatio`. After resize,
`ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` resets to CSS pixels. Resize is
triggered by `ResizeObserver` on the scroll container *and* by
`zoomLevelAtom` changes.

### Hit testing (clicks pass through)

`pointer-events: none` always. All pointer events land on the underlying
`<td>` nodes where existing handlers (`startPointerAtom` etc.) already
process them — no canvas-side hit test. The fill-handle hot-zone is the
one exception: a transparent `<div>` overlay at the handle coordinate
carries `pointer-events: auto`.

### Test plan

New file: `excel/solid-excel/test/vnext-grid-overlay.test.tsx`.

- Single-cell selection: assert `canvas.toDataURL()` hash against baseline.
- Multi-range: two regions in `selectionRegionsAtom`; sample pixel colors
  at known centroids and assert each rectangle drew.
- Active-cell border color matches the documented accent.
- Toggling `clipboardStateAtom` to `copy` schedules marching ants; stub
  `requestAnimationFrame` and assert frame count over a fake time window.
- DPR=2: backing-store width is twice the CSS width.
- `pointer-events: none`: dispatch a click at the canvas bounds and assert
  the underlying `<td>` listener fired.
- Regression guard: changing `formulaBarDraftAtom` must NOT mark dirty.

### Risks (text AA, ARIA, copy-from-canvas)

- **Text antialiasing.** Sidestepped by keeping text in DOM. Future
  canvas-text waves will need cross-browser metric reconciliation.
- **ARIA.** The canvas is invisible to screen readers; this is fine
  because nothing semantic lives on it. Selection announcements go
  through the DOM mirror.
- **Copy from canvas.** Cell text stays in DOM so native text-select
  still works.

### Out of scope for this wave

Cell text on canvas; headers on canvas; WebGL / WebGPU.

---

## File impact estimate

- **New files ~14.** Core: `src/menu-bar/{index,types,items,README}`,
  `src/name-box/{index,types}`, `src/status-bar/{index,types}`,
  `src/format-painter/{index,types}`. Host: `src-vnext/menu-bar/*`,
  `src-vnext/name-box/SpreadsheetNameBox.tsx`,
  `src-vnext/grid/overlay/{OverlayRenderer.ts, SpreadsheetGridOverlay.tsx}`.
- **Modified files ~5.** `SpreadsheetGrid.tsx` (mount overlay, format-painter
  cursor); `SpreadsheetStatusBar.tsx` (aggregates, zoom, view mode, input
  mode); `SpreadsheetToolbar.tsx` (painter button);
  `SpreadsheetFormulaBar.tsx` (mount name box, drop inline
  `formula-bar-addr`); `excel/spreadsheet-ui-core/src/index.ts`
  (re-exports).
- **New atoms ~12** across four core modules.

---

## Test impact

- New: `test/menu-bar.test.ts`, `test/name-box.test.ts`,
  `test/status-bar-aggregates.test.ts`, `test/format-painter.test.ts`,
  `excel/solid-excel/test/vnext-grid-overlay.test.tsx`.
- The existing `vnext-status-bar.test.tsx` hard-codes the current six
  `<span>` items; it needs updating when aggregates land.
- Grid tests stay valid: canvas is `pointer-events: none`, so all
  existing pointer-down assertions still resolve to `<td>`.
- Canvas snapshot tests need a real canvas implementation under jsdom —
  add `canvas` (npm) to the test runtime, or write the renderer behind a
  mockable context interface and use coord-based pixel sampling.

---

## Risks and unknowns

- **jsdom + canvas.** jsdom's `<canvas>` is a stub by default.
  `canvas.toDataURL()` snapshot tests require the `canvas` npm package or
  an abstraction layer the tests can mock. Decision pending.
- **Zoom vs manual sizes.** `zoomLevelAtom` multiplies on top of
  `viewportSizeOverridesAtom`; this can drift visually if the user mixes
  zoom and manual resizes. Revisit after Wave 5 user testing.
- **Menu-bar drift.** `MENU_BAR_ITEMS` is the single source of truth but
  imports atoms owned by other waves. Adding new items is a cross-wave
  coordination cost; mitigated by a lint-style test asserting every
  target resolves.

---

## Out of scope (defer to later waves)

- Full canvas migration of cell text.
- Backstage (Excel File backstage). Wave 5 uses a flat menubar like
  Luckysheet.
- Ribbon (Excel-style multi-tab ribbon).
- R1C1 address mode in the name box.
- Pinch-to-zoom is bonus; the discrete slider is mandatory.

---

## State Decision Template

- Public read-only projections: `topMenuOpenAtom`, `topMenuHighlightAtom`,
  `helpOverlayAtom`.
- Source atoms: `nameBoxInputAtom`, `nameBoxModeAtom`,
  `statusBarAggregateConfigAtom`, `zoomLevelAtom`, `viewModeAtom`,
  `formatPainterStateAtom`, `formatPainterClipboardAtom`.
- Derived atoms: `nameBoxDisplayAtom`, `selectionAggregatesAtom`,
  `inputModeAtom`.
- Commands: `openTopMenuAtom`, `closeTopMenuAtom`, `openHelpOverlayAtom`,
  `closeHelpOverlayAtom`, `commitNameBoxAtom`, `armFormatPainterAtom`,
  `applyFormatPainterAtom`, `cancelFormatPainterAtom`.
- Scale bound: aggregates capped by the visible window; no per-cell atoms.
- Backend reads: none added in this wave.
- Per-cell / per-row / per-col atom risk: none.
- Tests: see Test impact.
