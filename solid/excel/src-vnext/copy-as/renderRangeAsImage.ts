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
  /**
   * Optional per-column widths in CSS px. Typically derived from
   * `readViewportSizeProjection`. Indexed by absolute column number (the
   * same coordinate space as `range.colStart` / `range.colEnd`). Missing
   * columns fall back to `colWidthPx` (or the PoC default).
   */
  columnWidths?: ReadonlyMap<number, number>
  /**
   * Optional per-row heights in CSS px. Same indexing semantics as
   * `columnWidths` — keyed by absolute row number.
   */
  rowHeights?: ReadonlyMap<number, number>
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
 * Compute the per-column widths the SVG geometry will use. Returns a
 * map keyed by absolute column index inside `[colStart, colEnd]`. Order
 * of preference per column:
 *   1. `columnWidths.get(col)` if the host supplied a measurement
 *      (typically from `readViewportSizeProjection`).
 *   2. `colWidthPx` (a single override, e.g. the projection's median).
 *   3. `DEFAULT_COL_WIDTH_PX` (the PoC bake-in).
 *
 * The shared "resolve" pass keeps the geometry sum and the
 * `encodeSelectionAsHtml({columnWidths})` argument in lockstep — the SVG
 * `width=` attribute and the inner `<col>` widths describe the same
 * layout, otherwise `<foreignObject>` would clip or pillarbox.
 */
function resolveColumnWidths(input: RenderRangeAsImageInput): Map<number, number> {
  const fallback = input.colWidthPx ?? DEFAULT_COL_WIDTH_PX
  const out = new Map<number, number>()
  for (let col = input.range.colStart; col <= input.range.colEnd; col += 1) {
    const measured = input.columnWidths?.get(col)
    out.set(col, Math.max(1, measured ?? fallback))
  }
  return out
}

function resolveRowHeights(input: RenderRangeAsImageInput): Map<number, number> {
  const fallback = input.rowHeightPx ?? DEFAULT_ROW_HEIGHT_PX
  const out = new Map<number, number>()
  for (let row = input.range.rowStart; row <= input.range.rowEnd; row += 1) {
    const measured = input.rowHeights?.get(row)
    out.set(row, Math.max(1, measured ?? fallback))
  }
  return out
}

function sumMap(values: Iterable<number>): number {
  let sum = 0
  for (const v of values) sum += v
  return sum
}

/**
 * Build the SVG document the rasteriser consumes. Wrapping the HTML
 * table in `<foreignObject>` is what lets us reuse `encodeSelectionAsHtml`
 * verbatim — the renderer paints the same markup as `text/html`
 * clipboard already produces, so the PNG output stays consistent with
 * the HTML preview.
 *
 * Per-cell sizes (when supplied via `columnWidths` / `rowHeights`) flow
 * through the HTML encoder's `<colgroup>` and row `height` attributes,
 * so each `<td>` ends up at the same dimensions the live grid would
 * render. The fallback path (no size map) is the PoC default grid of
 * uniform 96×24 cells.
 */
export function buildRangeSvg(input: RenderRangeAsImageInput, width: number, height: number): string {
  const colWidths = resolveColumnWidths(input)
  const rowHeights = resolveRowHeights(input)
  const tableHtml = encodeSelectionAsHtml({
    cells: input.cells,
    rect: {
      startRow: input.range.rowStart,
      startCol: input.range.colStart,
      endRow: input.range.rowEnd,
      endCol: input.range.colEnd,
    },
    columnWidths: colWidths,
    rowHeights: rowHeights,
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
 *
 * Geometry: total width = sum of resolved column widths × scale, total
 * height = sum of resolved row heights × scale. Per-cell measurements
 * from `columnWidths` / `rowHeights` override the single-value PoC
 * `colWidthPx` / `rowHeightPx` knobs; both fall back to the baked
 * 96×24 defaults when the host supplies nothing.
 *
 * TODO(canvas): when Wave 5 lands a real `<canvas>` overlay grid, this
 * function should detect the mounted canvas and paint via
 * `canvas.getContext('2d').drawImage(...)` instead of the SVG path. See
 * `vanilla/spreadsheet-ui-core/docs/wave-8-png-export-design.md`
 * §"What's still TODO post-PoC" item 6. Today no canvas grid exists on
 * the Wave 5 demo (it's an SVG overlay), so the SVG path is the only
 * path.
 */
export async function renderRangeAsImage(
  input: RenderRangeAsImageInput,
  rasterizer: typeof rasterizeSvgToPng = rasterizeSvgToPng,
): Promise<RangeImageExportResult> {
  const scale = input.scale ?? 1
  const colWidths = resolveColumnWidths(input)
  const rowHeights = resolveRowHeights(input)
  const width = Math.max(1, sumMap(colWidths.values()) * scale)
  const height = Math.max(1, sumMap(rowHeights.values()) * scale)

  let bytes: Uint8Array
  try {
    const svg = buildRangeSvg(input, width, height)
    bytes = await rasterizer(svg, width, height)
  } catch (svgErr) {
    // SVG-with-foreignObject can fail to decode in headless Chromium
    // (`InvalidStateError: The source image could not be decoded`) and
    // similar quirks on stripped-down user agents. Fall back to the
    // canvas-direct path which paints cells with Canvas 2D primitives
    // and never goes through createImageBitmap on an SVG blob.
    try {
      bytes = await paintCellsToCanvasPng(input, colWidths, rowHeights, width, height)
    } catch {
      throw svgErr
    }
  }

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

/**
 * Canvas-direct paint path — used as a fallback when SVG/foreignObject
 * rasterisation fails (headless Chromium, stripped user agents) and as
 * the first-choice paint when a Wave 5 canvas overlay is mounted.
 *
 * Draws each cell as a white rectangle with a grey border + the cell's
 * displayValue text at default font. Per-cell sizes come from the same
 * `columnWidths` / `rowHeights` resolved by the SVG path so the geometry
 * stays in lockstep.
 *
 * The encoding does not attempt to reproduce font weight, alignment, or
 * cell formatting — that's deferred to a future iteration once the SVG
 * path renders reliably in test environments. The canvas fallback's
 * purpose is to keep the dispatch pipeline observable in headless
 * Playwright runs.
 */
async function paintCellsToCanvasPng(
  input: RenderRangeAsImageInput,
  colWidths: Map<number, number>,
  rowHeights: Map<number, number>,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const g = globalThis as unknown as {
    OffscreenCanvas?: typeof OffscreenCanvas
  }
  let getCtx: () => CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  let toBytes: () => Promise<Uint8Array>
  if (typeof g.OffscreenCanvas !== 'undefined') {
    const canvas = new g.OffscreenCanvas(width, height)
    getCtx = () => canvas.getContext('2d')
    toBytes = async () => {
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      return new Uint8Array(await blob.arrayBuffer())
    }
  } else if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    getCtx = () => canvas.getContext('2d')
    toBytes = async () => {
      const blob: Blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
          'image/png',
        )
      })
      return new Uint8Array(await blob.arrayBuffer())
    }
  } else {
    throw new Error('paintCellsToCanvasPng: no canvas surface available')
  }

  const ctx = getCtx()
  if (!ctx) throw new Error('paintCellsToCanvasPng: failed to get 2D context')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = '#d0d0d0'
  ctx.lineWidth = 1
  ctx.font = '12px system-ui, sans-serif'
  ctx.fillStyle = '#000000'
  ctx.textBaseline = 'middle'

  const lookup = new Map<string, string>()
  for (const c of input.cells) {
    lookup.set(`${c.row}:${c.col}`, c.displayValue ?? '')
  }

  let y = 0
  for (let row = input.range.rowStart; row <= input.range.rowEnd; row += 1) {
    const rh = rowHeights.get(row) ?? 24
    let x = 0
    for (let col = input.range.colStart; col <= input.range.colEnd; col += 1) {
      const cw = colWidths.get(col) ?? 96
      ctx.strokeRect(x + 0.5, y + 0.5, cw, rh)
      const text = lookup.get(`${row}:${col}`) ?? ''
      if (text.length > 0) {
        ctx.fillStyle = '#000000'
        ctx.fillText(text, x + 4, y + rh / 2, Math.max(1, cw - 8))
      }
      x += cw
    }
    y += rh
  }

  return toBytes()
}
