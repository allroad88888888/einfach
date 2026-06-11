# Wave 8 — PNG export design (8.4 / 8.5 slice)

## Purpose

Concrete PoC design for the PNG slice of Wave 8: "range screenshot + copy as
PNG". The umbrella wave doc (`wave-8-formula-extension-and-export.md`)
sketches a full backend port, atom contract, and DOM/canvas dual paths.
This doc narrows that to the smallest workable end-to-end shape we can land
without dragging in canvas dependencies, registering a new toolbar item, or
touching the engine.

The shipped PoC must:

1. Define an OPTIONAL `exportRangeAsImage` port on `SpreadsheetBackend`.
2. Provide a framework-agnostic `encodeSelectionAsImage` helper that turns a
   selection + backend into a `Blob | null` (null when the host port is
   missing — every Wave-8 port is optional and UI core stays inert).
3. Ship a Solid host PoC that renders the visible range via an
   `<svg>` + `<foreignObject>` data-URL → `<img>` → `<canvas>.toBlob`
   pipeline. No new npm dependencies, no canvas-dom polyfill.
4. Add the `image` variant to `lastCopyAsAtom` so Solid host can mirror a
   successful PNG write through the same diagnostics atom the text triple
   uses.

The intent is "minimum demoable", not "Excel parity". CF gradients, custom
paint, merged-cell overflow, and ligatured fonts are all explicit
non-goals for the PoC.

## Backend port shape

```ts
export interface RangeImageExportRequest extends SheetRef {
  kind: 'export-range-image'
  range: CellRange
  /** Defaults to 'png'; PoC only emits 'png'. */
  format?: 'png'
  /** Defaults to 1 (CSS px). 2 = retina. */
  scale?: number
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface RangeImageExportResult extends SheetRef {
  kind: 'range-image'
  range: CellRange
  /** Raw PNG bytes. UI core wraps in a Blob; host owns the encoder. */
  bytes: Uint8Array
  width: number
  height: number
  mimeType: 'image/png'
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

// On SpreadsheetBackend:
exportRangeAsImage?(request: RangeImageExportRequest): Promise<RangeImageExportResult>
```

Returning bytes (not a Blob) keeps the port serialisable across a worker
boundary if a future host wants to push the rendering off the main thread —
`Uint8Array` postMessages cleanly, `Blob` does not always. The PoC host
adapter happens to render on the main thread so the conversion is a
no-cost wrap.

## UI core encoder

```ts
// vanilla/spreadsheet-ui-core/src/copy-as/encodeSelectionAsImage.ts

export async function encodeSelectionAsImage(
  input: { sheetId: string; rect: CopyAsRect },
  backend: SpreadsheetBackend,
): Promise<Blob | null> {
  if (!backend.exportRangeAsImage) return null
  const range: CellRange = {
    rowStart: input.rect.startRow,
    colStart: input.rect.startCol,
    rowEnd: input.rect.endRow,
    colEnd: input.rect.endCol,
  }
  const result = await backend.exportRangeAsImage({
    kind: 'export-range-image',
    sheetId: input.sheetId,
    range,
  })
  return new Blob([result.bytes], { type: result.mimeType })
}
```

Returns `null` if the backend omits the port. Returns a `Blob` typed
`image/png` on success. No DOM access (everything runs through the
backend).

## `lastCopyAsAtom` integration

Today `CopyAsResult` is the text triple `{ html, plainText, markdown }`.
The PoC widens the atom value to a union so the same atom carries both
flavours:

```ts
export type CopyAsResult =
  | { kind?: 'text'; html: string; plainText: string; markdown: string }
  | { kind: 'image'; mimeType: 'image/png'; blob: Blob }
```

`kind` is optional on the text variant for backwards compatibility — the
existing host `store.setter(lastCopyAsAtom, encoded)` keeps working
without modification. New callers that want to mirror an image write
construct `{ kind: 'image', mimeType: 'image/png', blob }`.

Diagnostics consumers must narrow before touching `.html` / `.blob`.

## Solid host implementation (PoC strategy)

The simplest viable rendering path uses SVG `<foreignObject>` plus a
canvas:

1. Adapter receives `exportRangeAsImage({ range })`.
2. Pull the projection via the existing `readRangeProjection` so we get
   the same `DisplayCell[]` the text encoders use.
3. Reuse `encodeSelectionAsHtml` to produce a styled `<table>` for the
   selection. This already understands per-cell format (`bold`, `bgColor`,
   `align`, etc.) and merges. The HTML encoder is the single source of
   truth for "what a cell looks like in copy-as".
4. Wrap the table in an SVG document:
   ```xml
   <svg xmlns="..." width="W" height="H">
     <foreignObject width="100%" height="100%">
       <div xmlns="http://www.w3.org/1999/xhtml">{table}</div>
     </foreignObject>
   </svg>
   ```
5. Encode the SVG as a `data:` URL and load it into a hidden `Image()`.
   When `onload` fires, paint it onto an `OffscreenCanvas` (or a regular
   `<canvas>` when offscreen is unavailable) and call `toBlob('image/png')`
   to get the bytes. `Blob` → `arrayBuffer()` → `Uint8Array`.

Width and height are derived from
`(colEnd - colStart + 1) × defaultColWidth × scale` and
`(rowEnd - rowStart + 1) × defaultRowHeight × scale`. The PoC uses the
existing default width/height constants from `viewport`; per-cell size
overrides via `readViewportSizeProjection` are a Wave-8 follow-up.

### Known PoC limitations

- **Same-origin only.** `foreignObject` SVGs can taint a canvas if the
  embedded HTML loads cross-origin images; tainted canvases throw on
  `toBlob`. The PoC clips fonts to `system-ui` so we never reach into
  network territory.
- **No CF gradients.** Conditional-format gradients live in CSS the host
  doesn't have visibility into yet; the PoC reuses the static
  `SpreadsheetCellFormat` decoration only.
- **No merged-cell overflow.** `<foreignObject>` already handles
  `rowspan` / `colspan` because the HTML encoder emits real `<td>`
  attributes — so basic merges round-trip for free.
- **Resolution.** Default `scale = 1`. Hosts can bump to 2 for retina;
  the SVG path stays sharp at any scale because the HTML re-rasters in
  the canvas paint step.
- **jsdom.** The Jest environment has no real `<canvas>` paint pipeline.
  Solid-host tests mock `exportRangeAsImage` directly instead of running
  the SVG pipeline end-to-end. The pipeline is exercised in
  `solid/excel` Playwright e2e in a follow-up arc.

## Wire to `lastCopyAsAtom` (kept for follow-up)

The keyboard binding for "Copy as PNG" (e.g. `Ctrl+Shift+P`), the
`navigator.clipboard.write` + `ClipboardItem({ 'image/png': blob })` call,
and the `copyAsErrorAtom` failure tiering are deferred. They reuse the
same multi-tier write pattern `dispatchCopyAs` already implements; the
PoC stops at "encoder produces a Blob".

## Test plan

- `vanilla/spreadsheet-ui-core/test/copy-as-image.test.ts`
  - Backend without `exportRangeAsImage` → encoder returns `null`.
  - Backend with mocked `exportRangeAsImage` returning a 1×1 PNG byte
    sequence → encoder returns a `Blob` typed `image/png` whose
    `arrayBuffer` matches the input bytes.
  - `lastCopyAsAtom` accepts the `{ kind: 'image', blob }` variant.
- `solid/excel` host-level smoke test (follow-up) — assert the
  `exportRangeAsImage` PoC adapter returns a non-empty PNG byte sequence
  for a 2×2 selection. Don't pin pixel content. Skipped in CI under
  jsdom; reactivated under Playwright.

## File impact

- `vanilla/spreadsheet-ui-core/src/backend/types.ts` — add request /
  result types + optional method (~30 LOC).
- `vanilla/spreadsheet-ui-core/src/copy-as/types.ts` — widen
  `CopyAsResult` union (~10 LOC).
- `vanilla/spreadsheet-ui-core/src/copy-as/encodeSelectionAsImage.ts` —
  new (~30 LOC).
- `vanilla/spreadsheet-ui-core/src/copy-as/index.ts` — re-export (~2 LOC).
- `vanilla/spreadsheet-ui-core/test/copy-as-image.test.ts` — new
  (~80 LOC).
- `solid/excel/src-vnext/copy-as/` — new dir with PoC adapter
  (`renderRangeAsImage.ts`, ~120 LOC) — deferred to a follow-up commit
  if time permits.

Total PoC: ~150 LOC code + ~80 LOC test, plus design doc.

## What's still TODO post-PoC

1. Solid host adapter wiring on `worker-workbook-backend.ts` so the
   port is actually advertised to UI core.
2. `Ctrl+Shift+P` keyboard binding in `vanilla/spreadsheet-ui-core/src/keyboard`.
3. `navigator.clipboard.write` integration in `copy-as-dispatch.ts`
   alongside the existing text triple.
4. `MAX_EXPORT_PIXELS` cap + `'too-large'` failure variant on
   `copyAsErrorAtom`.
5. Per-cell width / height pulled from `readViewportSizeProjection`.
6. Canvas-first rendering path when a canvas grid is mounted (Wave 5).
7. Playwright e2e asserting non-empty PNG bytes for a 2×2 selection.
