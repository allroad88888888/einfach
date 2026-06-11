/**
 * Wave 8.4 — Solid-host PoC for `exportRangeAsImage`. Renders a
 * `DisplayCell[]` projection to PNG bytes using an
 * `<svg><foreignObject>` data URL → `<img>` → `<canvas>.toBlob`
 * pipeline. No new npm dependencies and no canvas polyfill.
 *
 * Caller responsibility: invoke `readRangeProjection` first to populate
 * `cells`, then hand both the cells and the range to
 * `renderRangeAsImage`. The intent is for a future
 * `worker-workbook-backend` adapter implementation to call this from
 * inside its `exportRangeAsImage` method — the helper stays decoupled
 * so it can also be reused by a static demo backend or an e2e harness.
 *
 * PoC limitations are documented in
 * `vanilla/spreadsheet-ui-core/docs/wave-8-png-export-design.md`. The
 * short version: no canvas-first path, no per-cell width/height, no
 * conditional formatting paint, defaults to `scale = 1`.
 */

import {
  encodeSelectionAsHtml,
  type CellRange,
  type DisplayCell,
  type RangeImageExportResult,
  type SheetRef,
} from '@einfach/spreadsheet-ui-core'

/** PoC defaults — kept small so a 2×2 demo fits in one screen pixel grid. */
const DEFAULT_COL_WIDTH_PX = 96
const DEFAULT_ROW_HEIGHT_PX = 24

export interface RenderRangeAsImageInput extends SheetRef {
  range: CellRange
  cells: ReadonlyArray<DisplayCell>
  /** Defaults to `1`. */
  scale?: number
  /** Override the PoC default column width (`96px`). */
  colWidthPx?: number
  /** Override the PoC default row height (`24px`). */
  rowHeightPx?: number
}

/**
 * Convert the SVG string to PNG bytes via the browser's image decoder +
 * canvas pipeline. Hoisted so a unit test can substitute a fake
 * implementation when running under jsdom.
 *
 * Throws when `OffscreenCanvas` and `HTMLCanvasElement` are both
 * unavailable (server-side rendering, no-DOM workers) — in those
 * environments the caller should fall back to a deferred backend
 * implementation that runs in a real browser context.
 */
export async function rasterizeSvgToPng(
  svg: string,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

  // Path 1 — OffscreenCanvas + createImageBitmap (preferred on workers /
  // modern browsers; no DOM elements created).
  const g = globalThis as {
    OffscreenCanvas?: typeof OffscreenCanvas
    createImageBitmap?: typeof createImageBitmap
    Image?: typeof Image
  }
  if (typeof g.OffscreenCanvas !== 'undefined' && typeof g.createImageBitmap !== 'undefined') {
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const bitmap = await g.createImageBitmap(blob)
    try {
      const canvas = new g.OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('OffscreenCanvas: failed to get 2D context')
      ctx.drawImage(bitmap, 0, 0, width, height)
      const out = await canvas.convertToBlob({ type: 'image/png' })
      const buf = await out.arrayBuffer()
      return new Uint8Array(buf)
    } finally {
      bitmap.close?.()
    }
  }

  // Path 2 — `<img>` + `<canvas>` (DOM-bound; what html2canvas-style
  // libraries do internally).
  if (typeof document !== 'undefined' && typeof g.Image !== 'undefined') {
    const img = new g.Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Failed to load SVG into <img>'))
      img.src = dataUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('<canvas>: failed to get 2D context')
    ctx.drawImage(img, 0, 0, width, height)
    const blob: Blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png')
    })
    const buf = await blob.arrayBuffer()
    return new Uint8Array(buf)
  }

  throw new Error('rasterizeSvgToPng: no OffscreenCanvas and no DOM canvas available')
}

/**
 * Build the SVG document the rasteriser consumes. Wrapping the HTML
 * table in `<foreignObject>` is what lets us reuse `encodeSelectionAsHtml`
 * verbatim — the renderer paints the same markup as `text/html`
 * clipboard already produces, so the PNG output stays consistent with
 * the HTML preview.
 */
export function buildRangeSvg(input: RenderRangeAsImageInput, width: number, height: number): string {
  const tableHtml = encodeSelectionAsHtml({
    cells: input.cells,
    rect: {
      startRow: input.range.rowStart,
      startCol: input.range.colStart,
      endRow: input.range.rowEnd,
      endCol: input.range.colEnd,
    },
  })

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `  <foreignObject width="100%" height="100%">`,
    `    <div xmlns="http://www.w3.org/1999/xhtml" style="font: 12px system-ui, sans-serif; color: #000; background: #fff;">`,
    tableHtml,
    `    </div>`,
    `  </foreignObject>`,
    `</svg>`,
  ].join('\n')
}

/**
 * Convert a range projection to a `RangeImageExportResult`. Wraps both
 * `buildRangeSvg` and `rasterizeSvgToPng`; the two halves are exported
 * separately so a follow-up canvas-first path can swap the raster step
 * without re-implementing the layout logic.
 *
 * `rasterizer` is injectable for tests — under jsdom we hand it a fake
 * that emits a fixed PNG byte sequence so we can assert the result
 * shape without booting a real canvas.
 */
export async function renderRangeAsImage(
  input: RenderRangeAsImageInput,
  rasterizer: typeof rasterizeSvgToPng = rasterizeSvgToPng,
): Promise<RangeImageExportResult> {
  const scale = input.scale ?? 1
  const colWidth = input.colWidthPx ?? DEFAULT_COL_WIDTH_PX
  const rowHeight = input.rowHeightPx ?? DEFAULT_ROW_HEIGHT_PX
  const cols = input.range.colEnd - input.range.colStart + 1
  const rows = input.range.rowEnd - input.range.rowStart + 1
  const width = Math.max(1, cols * colWidth * scale)
  const height = Math.max(1, rows * rowHeight * scale)

  const svg = buildRangeSvg(input, width, height)
  const bytes = await rasterizer(svg, width, height)

  return {
    kind: 'range-image',
    sheetId: input.sheetId,
    range: input.range,
    bytes,
    width,
    height,
    mimeType: 'image/png',
  }
}
