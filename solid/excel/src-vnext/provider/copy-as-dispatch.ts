import type { Store } from '@einfach/core'
import {
  copyAsErrorAtom,
  encodeSelectionAsImage,
  encodeSelectionAsPlainText,
  encodeSelectionForClipboard,
  publishCopyAsResultAtom,
  reportCopyAsStatusAtom,
  selectionSnapshotAtom,
  type CellRange,
  type CopyAsError,
  type CopyAsResult,
  type CopyAsTextResult,
  type EncodeSelectionAsImageResult,
  type RangeImageExportRequest,
  type RangeImageExportResult,
  type SpreadsheetBackend,
  type ViewportColumnWidth,
  type ViewportRowHeight,
} from '@einfach/spreadsheet-ui-core'

import { advanceSpreadsheetProjectionRequestIdAtom } from './atoms'
import { renderRangeAsImage } from '../copy-as/renderRangeAsImage'

/**
 * Maximum selection size (rows × cols) the multi-MIME copy-as path will
 * encode. Beyond this, we'd allocate huge HTML/Markdown strings and block
 * the main thread (e.g. column-A select = 1M rows). Matches Go To Special's
 * cap convention (`GO_TO_SCAN_MAX_CELLS = 100_000`).
 *
 * When exceeded, the dispatch falls back to writing a *clipped* TSV
 * (first `MAX_COPY_AS_CELLS` cells) via `navigator.clipboard.writeText` —
 * the keystroke still produces a usable plain-text result but skips the
 * expensive HTML/Markdown encoders.
 */
export const MAX_COPY_AS_CELLS = 100_000

export { copyAsErrorAtom }
export type { CopyAsError }

/**
 * Test-only mirror of `lastCopyAsAtom` written to `window.__einfach_lastCopyAs__`
 * for e2e visibility. Gated behind a runtime flag so the production bundle
 * never leaks an internal hook onto the global object.
 *
 * Detection (any positive match enables the mirror):
 *   - `process.env.NODE_ENV === 'test'`            (Jest unit tests)
 *   - `(globalThis as any).__EINFACH_E2E__ === true` (Playwright sets this
 *     before any page script runs via `context.addInitScript`)
 *
 * Note: we intentionally avoid `import.meta.env` here — Jest's SWC config
 * doesn't transform it, and bundlers (Vite, Rollup) can do their own
 * dead-code elimination via the `__EINFACH_E2E__` global when needed.
 */
function isE2EMirrorEnabled(): boolean {
  try {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') return true
  } catch {
    // process is undefined in browser bundles — that's fine, fall through.
  }
  const g = globalThis as { __EINFACH_E2E__?: boolean }
  return g.__EINFACH_E2E__ === true
}

function setE2EMirror(result: CopyAsResult | null): void {
  if (!isE2EMirrorEnabled()) return
  if (typeof window === 'undefined') return
  const w = window as unknown as { __einfach_lastCopyAs__?: CopyAsResult | null }
  w.__einfach_lastCopyAs__ = result
}

/**
 * Clip the rect to at most `MAX_COPY_AS_CELLS` cells, keeping the top-left
 * anchor (row 0/col 0 of the rect) and the leftmost columns. We prefer
 * a full-width prefix (whole rows of the original selection) so the
 * resulting TSV stays grid-shaped.
 */
function clipRectToCap(range: CellRange): CellRange {
  const rows = range.rowEnd - range.rowStart + 1
  const cols = range.colEnd - range.colStart + 1
  if (rows * cols <= MAX_COPY_AS_CELLS) return range
  // Keep full width if a single row fits; otherwise clip rows.
  if (cols >= MAX_COPY_AS_CELLS) {
    return {
      ...range,
      rowEnd: range.rowStart,
      colEnd: range.colStart + MAX_COPY_AS_CELLS - 1,
    }
  }
  const maxRows = Math.max(1, Math.floor(MAX_COPY_AS_CELLS / cols))
  return {
    ...range,
    rowEnd: range.rowStart + maxRows - 1,
  }
}

/**
 * Multi-tier clipboard write. Some browsers reject non-standard MIME types
 * (notably `text/markdown` in older Chrome / jsdom) and bin the whole
 * ClipboardItem when any one entry is unrecognised. Strategy:
 *
 *   tier 1 — `new ClipboardItem({html, plain, markdown})`
 *   tier 2 — `new ClipboardItem({html, plain})` (drop markdown)
 *   tier 3 — `navigator.clipboard.writeText(plain)`
 *
 * Returns the tier that ultimately succeeded, or `null` if all three failed.
 */
async function multiTierWrite(
  encoded: CopyAsTextResult,
): Promise<'rich-triple' | 'rich-no-markdown' | 'plain-text' | null> {
  const g = globalThis as { ClipboardItem?: typeof ClipboardItem }
  const hasClipboardItem = typeof g.ClipboardItem !== 'undefined'
  const hasClipboardWrite =
    typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.write)
  const hasWriteText =
    typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.writeText)

  // Tier 1: html + plain + markdown.
  if (hasClipboardItem && hasClipboardWrite) {
    try {
      const item = new g.ClipboardItem!({
        'text/html': new Blob([encoded.html], { type: 'text/html' }),
        'text/plain': new Blob([encoded.plainText], { type: 'text/plain' }),
        'text/markdown': new Blob([encoded.markdown], { type: 'text/markdown' }),
      })
      await navigator.clipboard.write([item])
      return 'rich-triple'
    } catch {
      // Fall through to tier 2.
    }

    // Tier 2: html + plain only (drop markdown — most common rejection cause).
    try {
      const item = new g.ClipboardItem!({
        'text/html': new Blob([encoded.html], { type: 'text/html' }),
        'text/plain': new Blob([encoded.plainText], { type: 'text/plain' }),
      })
      await navigator.clipboard.write([item])
      return 'rich-no-markdown'
    } catch {
      // Fall through to tier 3.
    }
  }

  // Tier 3: plain text only.
  if (hasWriteText) {
    try {
      await navigator.clipboard.writeText(encoded.plainText)
      return 'plain-text'
    } catch {
      return null
    }
  }
  return null
}

/**
 * Shared "Copy as HTML / Markdown / plain text" dispatch.
 *
 * Used by both the grid (Ctrl+Shift+C) and the menu bar (Edit > Copy as)
 * so the two entry points share a single implementation. Reads the
 * selection's projection cells via the backend port, runs the framework
 * agnostic encoders, then writes the triple to the system clipboard.
 *
 * Multi-tier fallback chain (see `multiTierWrite`):
 *   1. `ClipboardItem` with html + plain + markdown
 *   2. `ClipboardItem` with html + plain (drops markdown)
 *   3. `navigator.clipboard.writeText(plainText)`
 *
 * `lastCopyAsAtom` is only set on a successful write — on total failure it
 * stays at its previous value so callers can distinguish "never copied"
 * from "wrote stale value". Failure mode surfaces via `copyAsErrorAtom`.
 *
 * Large selections (rows × cols > `MAX_COPY_AS_CELLS`) skip the HTML/MD
 * encoders entirely and write a clipped TSV via `writeText` — selecting
 * a whole column shouldn't hang the tab.
 */
export async function dispatchCopyAs(
  store: Store,
  backend: SpreadsheetBackend,
  options: { sheetId?: string; range?: CellRange } = {},
): Promise<void> {
  const snap = store.getter(selectionSnapshotAtom)
  const sheetId = options.sheetId ?? snap.selection.sheetId ?? ''
  if (!sheetId) {
    return
  }
  const range = options.range ?? snap.range

  const rows = range.rowEnd - range.rowStart + 1
  const cols = range.colEnd - range.colStart + 1
  const totalCells = rows * cols

  // --- Oversized selection path: clip + plain-text only. ---
  if (totalCells > MAX_COPY_AS_CELLS) {
    const clipped = clipRectToCap(range)
    const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
    if (requestId === null) {
      store.setter(reportCopyAsStatusAtom, { kind: 'failed' })
      return
    }
    const result = await backend.readRangeProjection({
      kind: 'range',
      sheetId,
      requestId,
      reason: 'clipboard',
      range: clipped,
    })
    const plain = encodeSelectionAsPlainText({
      cells: result.cells,
      rect: {
        startRow: clipped.rowStart,
        startCol: clipped.colStart,
        endRow: clipped.rowEnd,
        endCol: clipped.colEnd,
      },
    })
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(plain)
        store.setter(reportCopyAsStatusAtom, {
          kind: 'too-large',
          cells: totalCells,
          limit: MAX_COPY_AS_CELLS,
        })
      } else {
        store.setter(reportCopyAsStatusAtom, { kind: 'failed' })
      }
    } catch {
      store.setter(reportCopyAsStatusAtom, { kind: 'failed' })
    }
    // Intentionally leave `lastCopyAsAtom` untouched — we never produced
    // the html/markdown flavours, and overwriting it with a partial result
    // would mislead diagnostics that assume the snapshot is the full
    // (html, plain, markdown) triple.
    return
  }

  // --- Normal path: encode all three flavours, multi-tier write. ---
  const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
  if (requestId === null) {
    store.setter(reportCopyAsStatusAtom, { kind: 'failed' })
    return
  }
  const result = await backend.readRangeProjection({
    kind: 'range',
    sheetId,
    requestId,
    reason: 'clipboard',
    range,
  })

  const encoded = encodeSelectionForClipboard({
    cells: result.cells,
    rect: {
      startRow: range.rowStart,
      startCol: range.colStart,
      endRow: range.rowEnd,
      endCol: range.colEnd,
    },
  })

  const tier = await multiTierWrite(encoded)

  if (tier === null) {
    // Both paths failed — leave `lastCopyAsAtom` unchanged so consumers
    // can distinguish "never copied" from "wrote stale value".
    store.setter(reportCopyAsStatusAtom, { kind: 'failed' })
    return
  }

  // Success at some tier. Persist the encoded triple + clear errors.
  store.setter(publishCopyAsResultAtom, encoded)
  setE2EMirror(encoded)
  if (tier === 'rich-triple') {
    store.setter(reportCopyAsStatusAtom, null)
  } else {
    // Tier 2 or 3 — partial success. Surface as a non-fatal status.
    store.setter(reportCopyAsStatusAtom, { kind: 'fallback-plain-only' })
  }
}

// ---------------------------------------------------------------------------
// Copy as PNG (Wave 8.4 / 8.5)
// ---------------------------------------------------------------------------

/**
 * Build per-index size maps from a `ViewportSizeProjectionResult`. The
 * SVG renderer reads these to compute exact per-column / per-row pixel
 * dimensions; the encoder's pre-flight cap reads the median as a single
 * representative scalar.
 *
 * Returned shape:
 *   - `columnWidths` / `rowHeights`: full per-index maps, ready to hand
 *     to `renderRangeAsImage({columnWidths, rowHeights})`.
 *   - `medianColWidthPx` / `medianRowHeightPx`: median over non-zero
 *     values — used by `encodeSelectionAsImage`'s `estimatedColWidthPx`
 *     / `estimatedRowHeightPx` (the cap is a single-number gate).
 */
function projectViewportSizes(
  rows: ReadonlyArray<ViewportRowHeight>,
  cols: ReadonlyArray<ViewportColumnWidth>,
): {
  columnWidths: Map<number, number>
  rowHeights: Map<number, number>
  medianColWidthPx?: number
  medianRowHeightPx?: number
} {
  function median(values: number[]): number | undefined {
    if (values.length === 0) return undefined
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }
  const columnWidths = new Map<number, number>()
  for (const c of cols) {
    if (c.widthPx > 0) columnWidths.set(c.colIndex, c.widthPx)
  }
  const rowHeights = new Map<number, number>()
  for (const r of rows) {
    if (r.heightPx > 0) rowHeights.set(r.rowIndex, r.heightPx)
  }
  return {
    columnWidths,
    rowHeights,
    medianColWidthPx: median(cols.map((c) => c.widthPx).filter((n) => n > 0)),
    medianRowHeightPx: median(rows.map((r) => r.heightPx).filter((n) => n > 0)),
  }
}

/**
 * Wrap a backend that lacks `exportRangeAsImage` with a host-side renderer
 * that reads the projection via `readRangeProjection` and rasterises via
 * the SVG `<foreignObject>` pipeline in `renderRangeAsImage`. Returns the
 * original backend unchanged if it already advertises the port (the worker
 * adapter still has the option to render in-worker via the JS-side, even
 * if the WASM workbook doesn't expose a native renderer).
 *
 * Per-cell sizes flow through via the optional
 * `readViewportSizeProjection` port — if the host implements it we pick
 * the representative size to feed the SVG geometry; otherwise the
 * renderer falls back to its baked-in PoC defaults.
 */
function withHostImageRenderer(backend: SpreadsheetBackend): SpreadsheetBackend {
  if (backend.exportRangeAsImage) return backend
  return {
    ...backend,
    async exportRangeAsImage(
      request: RangeImageExportRequest,
    ): Promise<RangeImageExportResult> {
      const projection = await backend.readRangeProjection({
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId ?? 0,
        revision: request.revision,
        reason: 'clipboard',
        range: request.range,
      })
      let columnWidths: ReadonlyMap<number, number> | undefined
      let rowHeights: ReadonlyMap<number, number> | undefined
      let colWidthPx: number | undefined
      let rowHeightPx: number | undefined
      if (backend.readViewportSizeProjection) {
        try {
          const size = await backend.readViewportSizeProjection({
            kind: 'viewport-size',
            sheetId: request.sheetId,
            window: request.range,
            requestId: request.requestId,
            revision: request.revision,
          })
          const pick = projectViewportSizes(size.rowHeights, size.colWidths)
          columnWidths = pick.columnWidths
          rowHeights = pick.rowHeights
          colWidthPx = pick.medianColWidthPx
          rowHeightPx = pick.medianRowHeightPx
        } catch {
          // Sizing is decoration — a viewport-size failure must not poison
          // the PNG render. Fall back to PoC defaults.
        }
      }
      return renderRangeAsImage({
        sheetId: request.sheetId,
        range: request.range,
        cells: projection.cells,
        scale: request.scale,
        columnWidths,
        rowHeights,
        colWidthPx,
        rowHeightPx,
      })
    },
  }
}

/**
 * Multi-tier clipboard write for an image Blob. Mirrors
 * `multiTierWrite` for the text triple: try the rich-MIME path first,
 * fall back to a degraded mode if the browser rejects.
 *
 *   tier 1 — `navigator.clipboard.write([new ClipboardItem({'image/png': blob})])`
 *   tier 2 — `lastCopyAsAtom` snapshot only (no system clipboard write)
 *
 * Tier 2 is intentionally a "soft success" — Playwright headless without
 * `clipboard-write` permission, jsdom, and Firefox builds that haven't
 * exposed `ClipboardItem` for images all land here. The host UI still
 * has a Blob to surface (e.g. a "Download PNG" affordance) so the user
 * isn't left holding nothing.
 */
async function writeImageToClipboard(blob: Blob): Promise<'system-clipboard' | 'atom-only' | null> {
  const g = globalThis as { ClipboardItem?: typeof ClipboardItem }
  const hasClipboardItem = typeof g.ClipboardItem !== 'undefined'
  const hasClipboardWrite =
    typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.write)
  if (hasClipboardItem && hasClipboardWrite) {
    try {
      const item = new g.ClipboardItem!({ 'image/png': blob })
      await navigator.clipboard.write([item])
      return 'system-clipboard'
    } catch {
      // Fall through — we'll still mirror to the atom so the host can
      // surface a "saved snapshot" indicator.
    }
  }
  return 'atom-only'
}

/**
 * Shared "Copy as PNG" dispatch — the image-flavour twin of
 * `dispatchCopyAs`. Called from the Ctrl+Shift+P keyboard binding and
 * (eventually) the menubar "Edit → Copy as image" entry.
 *
 * Flow:
 *   1. Resolve the selection rectangle.
 *   2. If the backend lacks `exportRangeAsImage`, install a host-side
 *      renderer wrapper (`withHostImageRenderer`). The wrapper reads the
 *      projection and rasterises via the SVG → canvas pipeline.
 *   3. Call `encodeSelectionAsImage`. Surfaces failure variants
 *      (`no-backend` / `too-large` / `empty-bytes`) on `copyAsErrorAtom`.
 *   4. On success, attempt `navigator.clipboard.write([ClipboardItem])`.
 *      Fall back to setting only `lastCopyAsAtom` if the system
 *      clipboard rejects (Playwright headless, Firefox, etc.).
 *
 * The Blob is mirrored into `lastCopyAsAtom` whenever encoding succeeded,
 * even if the system clipboard write fell through — diagnostics consumers
 * can narrow on `kind: 'image'` to find the snapshot.
 */
export async function dispatchCopyAsImage(
  store: Store,
  backend: SpreadsheetBackend,
  options: { sheetId?: string; range?: CellRange } = {},
): Promise<void> {
  const snap = store.getter(selectionSnapshotAtom)
  const sheetId = options.sheetId ?? snap.selection.sheetId ?? ''
  if (!sheetId) return
  const range = options.range ?? snap.range

  // Install the host-side renderer if the backend doesn't ship one. The
  // wrapper is per-call so we don't mutate the long-lived backend
  // instance held by the provider.
  const renderingBackend = withHostImageRenderer(backend)

  // Pre-flight: read per-cell sizes so the cap estimate uses the actual
  // rendered geometry rather than the encoder's baked defaults. The
  // wrapper inside `withHostImageRenderer` reads them again for the SVG
  // dimensions — duplicated calls are intentional so the cap stays a
  // pure UI-core concern (no state shared with the renderer).
  let estimatedColWidthPx: number | undefined
  let estimatedRowHeightPx: number | undefined
  if (backend.readViewportSizeProjection) {
    try {
      const size = await backend.readViewportSizeProjection({
        kind: 'viewport-size',
        sheetId,
        window: range,
      })
      const pick = projectViewportSizes(size.rowHeights, size.colWidths)
      estimatedColWidthPx = pick.medianColWidthPx
      estimatedRowHeightPx = pick.medianRowHeightPx
    } catch {
      // Pre-flight sizing failure is non-fatal — fall through to defaults.
    }
  }

  let encoded: EncodeSelectionAsImageResult
  try {
    encoded = await encodeSelectionAsImage(
      {
        sheetId,
        rect: {
          startRow: range.rowStart,
          startCol: range.colStart,
          endRow: range.rowEnd,
          endCol: range.colEnd,
        },
        estimatedColWidthPx,
        estimatedRowHeightPx,
      },
      renderingBackend,
    )
  } catch {
    store.setter(reportCopyAsStatusAtom, { kind: 'image-failed' })
    return
  }

  if (!encoded.ok) {
    switch (encoded.reason) {
      case 'no-backend':
        store.setter(reportCopyAsStatusAtom, { kind: 'image-no-backend' })
        return
      case 'too-large':
        store.setter(reportCopyAsStatusAtom, {
          kind: 'image-too-large',
          estimatedPixels: encoded.estimatedPixels ?? 0,
          limit: encoded.limit ?? 0,
        })
        return
      case 'empty-bytes':
        store.setter(reportCopyAsStatusAtom, { kind: 'image-failed' })
        return
    }
  }

  // Snapshot the blob into `lastCopyAsAtom` BEFORE attempting the
  // clipboard write. This way a Playwright headless run (no clipboard
  // permission) still produces a verifiable mirror — the e2e spec asserts
  // the atom mirror, not `navigator.clipboard.read()`, when the system
  // clipboard is unavailable.
  const snapshot: CopyAsResult = { kind: 'image', mimeType: 'image/png', blob: encoded.blob }
  store.setter(publishCopyAsResultAtom, snapshot)
  setE2EMirror(snapshot)

  const tier = await writeImageToClipboard(encoded.blob)
  if (tier === 'system-clipboard') {
    store.setter(reportCopyAsStatusAtom, null)
  } else {
    // atom-only — still a soft success, surfaced as the same
    // "fallback-plain-only" status the text triple uses for tier-2 / tier-3
    // landings. The host shows "saved snapshot — clipboard not available".
    store.setter(reportCopyAsStatusAtom, { kind: 'fallback-plain-only' })
  }
}
