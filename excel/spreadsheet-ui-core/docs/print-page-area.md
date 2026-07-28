# print-page-area

## Goal

Define print area, page breaks, scaling, and header/footer metadata so a host
adapter can render print output or generate PDF. UI core owns the configuration
and exposes it as bounded atoms per sheet. The host adapter is responsible for
all layout, pagination, and rendering execution; it reads config via the backend
port and produces paginated output outside the UI layer.

## Scope

Configuration owned by UI core:

- Print area: optional cell range bounding what gets printed on a sheet
- Manual page break positions: explicit row and column break indices
- Scale-to-fit: percentage or pages-wide/tall target
- Paper orientation: portrait or landscape
- Header/footer text fields: left/center/right bands for both header and footer

**Out of scope:**

- Actual PDF or print rendering (host adapter responsibility)
- Repeat-rows/repeat-columns on each page (defer; overlaps frozen-panes design)
- Print quality DPI, paper size selection, margin config (future)
- Auto page break computation in UI core (backend may return these; UI core does
  not compute them)

## State (UI core)

One bounded config record per sheet stored in a single map atom:

```ts
// src/print/atoms.ts
import { atom } from '@einfach/core'
import type { PrintConfig } from './types'

export const printConfigStateAtom = atom<Record<string, PrintConfig>>({})
printConfigStateAtom.debugLabel = 'spreadsheet.print.config'

export const printPreviewOpenAtom = atom(false)
printPreviewOpenAtom.debugLabel = 'spreadsheet.print.previewOpen'

export const printPageSetupOpenAtom = atom(false)
printPageSetupOpenAtom.debugLabel = 'spreadsheet.print.pageSetupOpen'
```

`printConfigStateAtom` is keyed by `sheetId`. Writing a config for a sheet
replaces the full record for that sheet; the atom is never unbounded because
sheet count is bounded.

`printPreviewOpenAtom` drives a preview overlay in the viewport layer.
`printPageSetupOpenAtom` drives the Page Setup dialog in the toolbar layer.

## Types

```ts
// src/print/types.ts
import type { CellRange } from '../shared'

export type PrintOrientation = 'portrait' | 'landscape'

export type PrintScale =
  | { kind: 'percent'; value: number }       // e.g. 75 means 75 %
  | { kind: 'fit'; wide: number; tall: number } // fit to N pages wide × M tall

export interface ManualPageBreak {
  axis: 'row' | 'column'
  index: number
}

export interface HeaderFooterBand {
  left?: string
  center?: string
  right?: string
}

export interface HeaderFooterFields {
  header?: HeaderFooterBand
  footer?: HeaderFooterBand
}

export interface PrintConfig {
  printArea?: CellRange           // undefined = full used range
  manualPageBreaks: ManualPageBreak[]
  scale: PrintScale
  orientation: PrintOrientation
  headerFooter?: HeaderFooterFields
}
```

All fields use plain serialisable values so configs round-trip through JSON
without loss.

## Backend port

Two optional methods added to `SpreadsheetBackend`:

```ts
readPrintConfig?(request: ReadPrintConfigRequest): Promise<ReadPrintConfigResult>
setPrintConfig?(request: SetPrintConfigRequest): Promise<BackendMutationResult>
```

Request/result shapes:

```ts
import type { SheetRef } from '../shared'
import type { PrintConfig, ManualPageBreak } from '../print/types'

export interface ReadPrintConfigRequest extends SheetRef {
  kind: 'read-print-config'
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface ReadPrintConfigResult extends SheetRef {
  kind: 'read-print-config'
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
  config: PrintConfig
  autoPageBreaks?: ManualPageBreak[] // computed by backend; advisory only
}

export interface SetPrintConfigRequest extends SheetRef {
  kind: 'set-print-config'
  config: PrintConfig
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}
```

Both methods are optional. Backends that do not support print config omit them;
UI core degrades gracefully (config lives in atoms only, no persistence).
`autoPageBreaks` from `readPrintConfig` is advisory: UI core may surface it in
the preview overlay but does not store it in `printConfigStateAtom`.

## Integration points

**Viewport** — preview overlay reads `printPreviewOpenAtom` and the active
sheet's `PrintConfig` to draw page break guidelines. Overlays are not in normal
cell flow; they are rendered as absolute positioned guides above the grid canvas.
Auto page breaks returned from the backend are surfaced here only when preview is
open.

**Toolbar** — Page Setup button toggles `printPageSetupOpenAtom`; print preview
button toggles `printPreviewOpenAtom`. The dialog reads and writes the active
sheet's entry in `printConfigStateAtom`.

**Operations** — `insertRows` / `deleteRows` / `insertColumns` / `deleteColumns`
must shift `ManualPageBreak` indices in `printConfigStateAtom` to keep breaks
aligned with user-visible positions after structural edits.

**Workspace** — workspace revision metadata should include a print config
revision so the host adapter knows when to re-paginate. Hosts compare this
revision before recomputing layout for PDF export.

**Clipboard / fill-handle** — no interaction; print config is not affected by
cell-level operations.

## Risks & open questions

- **Paginate cost on large sheets** — computing auto page breaks requires
  iterating row heights across the full sheet; backends should do this lazily and
  return only when the preview is open, not on every revision tick.
- **Frozen panes and repeat headers** — the deferred repeat-rows feature
  overlaps directly with frozen pane config; shipping print area without repeat
  rows may produce confusing previews on sheets with frozen top rows.
- **Hidden rows in print range** — if the print area contains hidden rows the
  host must decide whether to skip them or include blank pages; the config has no
  flag for this yet.
- **Multi-range print selection** — `printArea` is a single `CellRange`; users
  cannot yet specify disjoint print areas. This is common in Excel and may need a
  `printArea: CellRange[]` upgrade.
- **Header/footer format tokens** — Excel supports `&P` (page number), `&D`
  (date), `&F` (filename) tokens in header/footer strings. The current
  `HeaderFooterBand` stores raw strings; token expansion is deferred to the host.
- **Scale precision** — `fit` scale depends on paper size and margins that UI
  core does not own; mismatches between host paper config and UI scale target may
  produce unexpected page counts in preview vs. actual output.

## Test surface

`test/print-page-area.test.ts`

Cover:

- Initial `printConfigStateAtom` is empty; writing a config for a sheet stores
  it under that sheet id and does not affect other sheets
- `insertRows` below a manual row page break shifts break index up by count
- `deleteRows` above a manual row page break shifts break index down; breaks
  inside deleted range are removed
- Same shift logic for column page breaks on `insertColumns` / `deleteColumns`
- `printPreviewOpenAtom` and `printPageSetupOpenAtom` toggle independently
- `PrintScale` `percent` and `fit` variants both serialise round-trip through
  JSON cleanly
- `printArea` undefined degrades gracefully (no crash in atoms or port helpers)
