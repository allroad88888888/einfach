import { describe, expect, jest, test } from '@jest/globals'
import type { DisplayCell } from '@einfach/spreadsheet-ui-core'
import {
  buildRangeSvg,
  renderRangeAsImage,
} from '../src-vnext/copy-as'

/**
 * Single-pixel PNG (1x1 transparent) — placeholder bytes the fake
 * rasterizer emits. The assertions never decode it; they just confirm
 * the byte stream survives the renderer wrap.
 */
const FAKE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
])

function cells2x2(): DisplayCell[] {
  return [
    { row: 0, col: 0, displayValue: 'apple', valueKind: 'string' },
    { row: 0, col: 1, displayValue: '1', valueKind: 'number' },
    { row: 1, col: 0, displayValue: 'pear', valueKind: 'string' },
    { row: 1, col: 1, displayValue: '2', valueKind: 'number' },
  ]
}

describe('vnext copy-as image renderer (Wave 8.4 PoC)', () => {
  const range = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }

  test('buildRangeSvg wraps the html encoder output in a <foreignObject>', () => {
    const svg = buildRangeSvg(
      { sheetId: 'sheet-1', range, cells: cells2x2() },
      192,
      48,
    )
    // Outer SVG envelope with explicit pixel dimensions.
    expect(svg).toContain('<svg ')
    expect(svg).toContain('width="192"')
    expect(svg).toContain('height="48"')
    // foreignObject is what carries the HTML payload — the entire point
    // of the PoC strategy.
    expect(svg).toContain('<foreignObject')
    // The HTML encoder is the source of truth for cell paint, so its
    // output must round-trip through the SVG verbatim.
    expect(svg).toContain('<table')
    expect(svg).toContain('apple')
    expect(svg).toContain('pear')
  })

  test('renderRangeAsImage forwards bytes from the rasterizer and packs the result', async () => {
    const rasterizer = jest.fn(
      async (_svg: string, _w: number, _h: number) => FAKE_PNG,
    )
    const result = await renderRangeAsImage(
      {
        sheetId: 'sheet-x',
        range,
        cells: cells2x2(),
        scale: 1,
        colWidthPx: 100,
        rowHeightPx: 20,
      },
      rasterizer,
    )

    expect(result.kind).toBe('range-image')
    expect(result.sheetId).toBe('sheet-x')
    expect(result.mimeType).toBe('image/png')
    // 2 cols × 100px × scale 1 = 200px; 2 rows × 20px × scale 1 = 40px.
    expect(result.width).toBe(200)
    expect(result.height).toBe(40)
    expect(result.bytes).toBe(FAKE_PNG)
    expect(result.bytes.byteLength).toBeGreaterThan(0)

    // Rasterizer was handed the same SVG buildRangeSvg produces.
    expect(rasterizer).toHaveBeenCalledTimes(1)
    const [svg, w, h] = rasterizer.mock.calls[0]!
    expect(w).toBe(200)
    expect(h).toBe(40)
    expect(svg).toContain('apple')
    expect(svg).toContain('<foreignObject')
  })

  test('renderRangeAsImage honours scale on the SVG size', async () => {
    const rasterizer = jest.fn(
      async (_svg: string, _w: number, _h: number) => FAKE_PNG,
    )
    const result = await renderRangeAsImage(
      {
        sheetId: 'sheet-x',
        range,
        cells: cells2x2(),
        scale: 2,
      },
      rasterizer,
    )

    // PoC defaults: 96px col × 24px row × scale 2.
    expect(result.width).toBe(2 * 96 * 2)
    expect(result.height).toBe(2 * 24 * 2)
  })

  test('renderRangeAsImage sums per-column widths and per-row heights from the size map', async () => {
    const rasterizer = jest.fn(
      async (_svg: string, _w: number, _h: number) => FAKE_PNG,
    )
    // 2-column selection: col 0 = 50px, col 1 = 150px → 200px total.
    // 2-row selection: row 0 = 24px, row 1 = 36px → 60px total.
    const result = await renderRangeAsImage(
      {
        sheetId: 'sheet-x',
        range,
        cells: cells2x2(),
        columnWidths: new Map([
          [0, 50],
          [1, 150],
        ]),
        rowHeights: new Map([
          [0, 24],
          [1, 36],
        ]),
      },
      rasterizer,
    )

    expect(result.width).toBe(200)
    expect(result.height).toBe(60)
    // The HTML encoder gets the same map so the rendered <table> hits the
    // same dimensions as the outer SVG — checked indirectly via the SVG
    // containing a `<col style="width: 50px">` etc. (encoder behaviour
    // tested in detail elsewhere; here we only confirm the wiring).
    const svg = rasterizer.mock.calls[0]![0]
    expect(svg).toMatch(/width:\s*50px/)
    expect(svg).toMatch(/width:\s*150px/)
  })

  test('missing per-cell sizes fall back to the single-value override, then the PoC default', async () => {
    const rasterizer = jest.fn(
      async (_svg: string, _w: number, _h: number) => FAKE_PNG,
    )
    // Only col 1 has a measurement (200px); col 0 falls back to the
    // single-value override (10px). Rows have no measurements at all —
    // both fall back to the explicit `rowHeightPx` override of 12px.
    const result = await renderRangeAsImage(
      {
        sheetId: 'sheet-x',
        range,
        cells: cells2x2(),
        columnWidths: new Map([[1, 200]]),
        colWidthPx: 10,
        rowHeightPx: 12,
      },
      rasterizer,
    )
    // 10 + 200 = 210; 12 + 12 = 24.
    expect(result.width).toBe(210)
    expect(result.height).toBe(24)
  })
})
