/**
 * #27 S7 proper — the two export paths where the ADAPTER produces the content
 * itself, and therefore had no way to know what the filter hid:
 *
 *   - `exportRangeTsv` / `consumeExportRangeTsvChunks` (the >10k-cell copy)
 *   - `exportRangeAsImage` (Copy as PNG)
 *
 * S7's prep slice hardened the three clipboard ENCODERS but left these two
 * open, which made a single "copy" gesture fork on SIZE after the S5 flip: a
 * rect under `CLIPBOARD_CELL_LIMIT` excluded filtered rows, anything above it
 * included them, and the user saw no error either way — just a different
 * clipboard depending on how much data they happened to select.
 *
 * Every fix below is proved DIFFERENTIALLY, never tautologically: each test
 * pair drives the UNGUARDED call first (no `hiddenRows` on the request, which
 * is exactly what the code did before this slice) and asserts the BAD result —
 * the filtered row's data actually present in the export — then re-runs the
 * guarded call and asserts it is gone. A test that only ever asserts the good
 * outcome would pass against a no-op implementation.
 *
 * Identity today: under display-compaction filtering the filter-hidden set is
 * always empty, so every `hiddenRows` argument in this file is a set that
 * production cannot yet produce. These tests describe the S5 world.
 */

import { describe, expect, jest, test } from '@jest/globals'

import { createStaticSpreadsheetBackend } from '../src-vnext/adapter/static-backend'
import {
  createWorkerWorkbookSpreadsheetBackend,
} from '../src-vnext/adapter/worker-workbook-backend'
import {
  filterTsvBandRows,
  firstVisibleRowInBand,
} from '../src-vnext/adapter/filter-hidden-rows'
import { buildRangeSvg, renderRangeAsImage } from '../src-vnext/copy-as'
import type {
  DisplayCell,
  RangeTsvExportRequest,
  SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'

// ---------------------------------------------------------------------------
// The pure band filter
// ---------------------------------------------------------------------------

describe('filterTsvBandRows', () => {
  const band = ['r0', 'r1', 'r2', 'r3'].join('\n')

  test('returns the input untouched when nothing is hidden', () => {
    const out = filterTsvBandRows(band, 0, 3, new Set())
    // Same reference, not merely an equal string — this is the mechanical
    // guarantee that today's bytes cannot drift.
    expect(out.text).toBe(band)
    expect(out.rowCount).toBe(4)
    expect(out.firstVisibleRow).toBe(0)
  })

  test('drops exactly the hidden rows and reports the first survivor', () => {
    const out = filterTsvBandRows(band, 0, 3, new Set([0, 2]))
    expect(out.text).toBe('r1\nr3')
    expect(out.rowCount).toBe(2)
    // Load-bearing: the origin marker is built from this, and it anchors
    // relative-formula shifting on paste.
    expect(out.firstVisibleRow).toBe(1)
  })

  test('offsets rows by the band start, not by the line index', () => {
    // A chunk covering rows 10..13. Hiding "row 1" must do nothing; hiding
    // row 11 must drop the SECOND line. Getting this wrong silently deletes
    // the wrong row from the user's clipboard.
    const out = filterTsvBandRows(band, 10, 13, new Set([1, 11]))
    expect(out.text).toBe('r0\nr2\nr3')
    expect(out.firstVisibleRow).toBe(10)
  })

  test('reports rowCount 0 when the whole band is hidden', () => {
    // The caller must then emit NOTHING — chunk texts are joined with '\n',
    // so emitting '' here would inject a blank line into the clipboard.
    const out = filterTsvBandRows(band, 0, 3, new Set([0, 1, 2, 3]))
    expect(out.rowCount).toBe(0)
    expect(out.firstVisibleRow).toBeNull()
  })

  test('fails OPEN when a cell value carried an embedded newline', () => {
    // The clipboard TSV format is unquoted line-per-row on both sides
    // (`serializeClipboardTsv` joins on '\n', `parseClipboardTsv` splits on
    // it), so an embedded newline already corrupts paste today. What must NOT
    // happen is this function compounding it by dropping a VISIBLE row: five
    // lines for a four-row band means the index mapping is untrustworthy, so
    // the band is left alone. Exporting a filtered row is the lesser evil.
    const ragged = ['r0', 'multi\nline', 'r2', 'r3'].join('\n')
    const out = filterTsvBandRows(ragged, 0, 3, new Set([0]))
    expect(out.text).toBe(ragged)
    expect(out.rowCount).toBe(4)
  })

  test('passes through the exhausted-session sentinel band', () => {
    // The WASM runtime signals exhaustion with `endRow = startRow - 1` and an
    // empty chunk. A zero-width band has no rows to judge.
    const out = filterTsvBandRows('', 5, 4, new Set([5]))
    expect(out.text).toBe('')
    expect(out.rowCount).toBe(0)
  })
})

describe('firstVisibleRowInBand', () => {
  test('finds the first survivor', () => {
    expect(firstVisibleRowInBand(0, 4, new Set([0, 1]))).toBe(2)
  })

  test('returns null when every row is hidden', () => {
    expect(firstVisibleRowInBand(0, 2, new Set([0, 1, 2]))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Static backend — exportRangeTsv
// ---------------------------------------------------------------------------

describe('static backend exportRangeTsv honours the filter-hidden set', () => {
  function backendWithRows() {
    return createStaticSpreadsheetBackend({
      matrix: [
        ['keep-0'],
        ['FILTERED-1'],
        ['keep-2'],
        ['FILTERED-3'],
        ['keep-4'],
      ],
    })
  }

  const range = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 0 }

  test('COUNTER-EXAMPLE: without the set, filtered rows reach the clipboard', async () => {
    const backend = backendWithRows()
    const result = await backend.exportRangeTsv!({
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
    })

    // This is the pre-slice behaviour, asserted as the defect it is: rows the
    // user filtered away are in the exported text.
    expect(result.text).toBe('keep-0\nFILTERED-1\nkeep-2\nFILTERED-3\nkeep-4')
    expect(result.text).toContain('FILTERED-1')
    expect(result.text).toContain('FILTERED-3')
  })

  test('with the set, filtered rows are gone and the origin holds', async () => {
    const backend = backendWithRows()
    const result = await backend.exportRangeTsv!({
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
      hiddenRows: [1, 3],
    })

    expect(result.text).toBe('keep-0\nkeep-2\nkeep-4')
    expect(result.text).not.toContain('FILTERED')
    // Row 0 survived, so the anchor is unmoved.
    expect(result.originAddr).toBe('A1')
    // No blank lines smuggled in where the hidden rows used to be.
    expect(result.text.split('\n')).toHaveLength(3)
  })

  test('the origin marker moves to the first EMITTED row', async () => {
    const backend = backendWithRows()
    const unguarded = await backend.exportRangeTsv!({
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
    })
    // COUNTER-EXAMPLE: the marker names row 0 even though row 0 is filtered
    // away. Paste would shift every relative reference by two rows.
    expect(unguarded.originAddr).toBe('A1')

    const guarded = await backend.exportRangeTsv!({
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
      hiddenRows: [0, 1],
    })
    expect(guarded.originAddr).toBe('A3')
    expect(guarded.text).toBe('keep-2\nFILTERED-3\nkeep-4')
  })

  test('an all-hidden range exports nothing rather than blank lines', async () => {
    const backend = backendWithRows()
    const result = await backend.exportRangeTsv!({
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
      hiddenRows: [0, 1, 2, 3, 4],
    })
    expect(result.text).toBe('')
    // Conservative fallback: nothing survived, so the anchor stays at the
    // range start. The text is empty, so it anchors nothing anyway.
    expect(result.originAddr).toBe('A1')
  })

  test('an omitted set is identical to an empty one (today s behaviour)', async () => {
    const backend = backendWithRows()
    const omitted = await backend.exportRangeTsv!({
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
    })
    const empty = await backend.exportRangeTsv!({
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
      hiddenRows: [],
    })
    expect(empty.text).toBe(omitted.text)
    expect(empty.originAddr).toBe(omitted.originAddr)
    expect(empty.estimatedBytes).toBe(omitted.estimatedBytes)
  })
})

// ---------------------------------------------------------------------------
// Image export — renderRangeAsImage
// ---------------------------------------------------------------------------

/**
 * Five single-column rows, rows 1 and 3 destined to be filtered away. Values
 * are distinctive so a blank-vs-populated `<tr>` is unambiguous in the SVG.
 */
function imageCells(): DisplayCell[] {
  return [
    { row: 0, col: 0, displayValue: 'keep-0', valueKind: 'string' },
    { row: 1, col: 0, displayValue: 'FILTERED-1', valueKind: 'string' },
    { row: 2, col: 0, displayValue: 'keep-2', valueKind: 'string' },
    { row: 3, col: 0, displayValue: 'FILTERED-3', valueKind: 'string' },
    { row: 4, col: 0, displayValue: 'keep-4', valueKind: 'string' },
  ]
}

const IMAGE_RANGE = { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 0 }
const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

describe('renderRangeAsImage honours the filter-hidden set', () => {
  test('COUNTER-EXAMPLE: without the set the PNG paints the filtered rows', () => {
    const svg = buildRangeSvg(
      { sheetId: 'sheet-1', range: IMAGE_RANGE, cells: imageCells() },
      96,
      120,
    )
    expect(svg).toContain('FILTERED-1')
    expect(svg).toContain('FILTERED-3')
  })

  test('with the set the filtered rows are not painted', () => {
    const svg = buildRangeSvg(
      {
        sheetId: 'sheet-1',
        range: IMAGE_RANGE,
        cells: imageCells(),
        hiddenRows: [1, 3],
      },
      96,
      72,
    )
    expect(svg).not.toContain('FILTERED')
    expect(svg).toContain('keep-0')
    expect(svg).toContain('keep-2')
    expect(svg).toContain('keep-4')
    // Three body rows survive, so three <tr> — not five with two blank.
    expect(svg.match(/<tr/g) ?? []).toHaveLength(3)
  })

  test('COUNTER-EXAMPLE then FIX: the canvas GEOMETRY shrinks too', async () => {
    const rasterizer = jest.fn(async (_svg: string, _w: number, _h: number) => FAKE_PNG)

    // Unguarded: 5 rows × 20px = 100px tall.
    const unguarded = await renderRangeAsImage(
      {
        sheetId: 'sheet-1',
        range: IMAGE_RANGE,
        cells: imageCells(),
        colWidthPx: 96,
        rowHeightPx: 20,
      },
      rasterizer,
    )
    expect(unguarded.height).toBe(100)

    // Guarded: only the 3 visible rows contribute → 60px.
    //
    // This is the knock-on with NO analogue in any text encoder, and the one
    // a "skip the paint" fix alone would miss: leaving the height at 100
    // while painting 3 rows yields a correct table followed by a 40px blank
    // band exactly as tall as the rows that were filtered away.
    const guarded = await renderRangeAsImage(
      {
        sheetId: 'sheet-1',
        range: IMAGE_RANGE,
        cells: imageCells(),
        colWidthPx: 96,
        rowHeightPx: 20,
        hiddenRows: [1, 3],
      },
      rasterizer,
    )
    expect(guarded.height).toBe(60)
    // Width is a column-axis quantity and must be untouched.
    expect(guarded.width).toBe(unguarded.width)

    // The SVG handed to the rasterizer agrees with the declared geometry.
    const [svg, , h] = rasterizer.mock.calls[1]!
    expect(h).toBe(60)
    expect(svg).toContain('height="60"')
    expect(svg).not.toContain('FILTERED')
  })

  test('per-row measured heights are summed over visible rows only', async () => {
    const rasterizer = jest.fn(async (_svg: string, _w: number, _h: number) => FAKE_PNG)
    // Rows 1 and 3 are the tall ones; hiding them must remove THEIR heights,
    // not a uniform default.
    const rowHeights = new Map([
      [0, 10],
      [1, 90],
      [2, 10],
      [3, 90],
      [4, 10],
    ])
    const guarded = await renderRangeAsImage(
      {
        sheetId: 'sheet-1',
        range: IMAGE_RANGE,
        cells: imageCells(),
        colWidthPx: 96,
        rowHeights,
        hiddenRows: [1, 3],
      },
      rasterizer,
    )
    expect(guarded.height).toBe(30)
  })

  test('an all-hidden range still yields a valid 1px canvas', async () => {
    const rasterizer = jest.fn(async (_svg: string, _w: number, _h: number) => FAKE_PNG)
    const result = await renderRangeAsImage(
      {
        sheetId: 'sheet-1',
        range: IMAGE_RANGE,
        cells: imageCells(),
        colWidthPx: 96,
        rowHeightPx: 20,
        hiddenRows: [0, 1, 2, 3, 4],
      },
      rasterizer,
    )
    // A zero-height canvas throws in real browsers, so the renderer's
    // `Math.max(1, ...)` floor must hold rather than emit 0.
    expect(result.height).toBe(1)
    expect(result.bytes).toBe(FAKE_PNG)
  })

  test('scale multiplies the SHRUNK height, not the raw span', async () => {
    const rasterizer = jest.fn(async (_svg: string, _w: number, _h: number) => FAKE_PNG)
    const result = await renderRangeAsImage(
      {
        sheetId: 'sheet-1',
        range: IMAGE_RANGE,
        cells: imageCells(),
        colWidthPx: 96,
        rowHeightPx: 20,
        scale: 2,
        hiddenRows: [1, 3],
      },
      rasterizer,
    )
    // 3 visible rows × 20px × scale 2 = 120, not 5 × 20 × 2 = 200.
    expect(result.height).toBe(120)
  })
})

// ---------------------------------------------------------------------------
// Worker backend — the chunked path, which is what a large copy actually takes
// ---------------------------------------------------------------------------

/**
 * Minimal client double. `consumeExportRangeTsvChunks` reproduces what the
 * real WASM runtime emits: successive row BANDS, each serialised line-per-row
 * by `sparseRangeToTSV`, with the last data chunk carrying `done: true`.
 *
 * `rowsPerChunk` is settable so a test can put the filter-hidden rows on a
 * chunk boundary and, more importantly, make one whole chunk vanish — the
 * case where a naive fix leaks a blank line into the clipboard.
 */
function createExportFakeClient(options: {
  rows: readonly string[]
  rowsPerChunk?: number
  streaming?: boolean
}) {
  const rowsPerChunk = options.rowsPerChunk ?? 2
  const streaming = options.streaming ?? true

  function bandText(startRow: number, endRow: number): string {
    const lines: string[] = []
    for (let row = startRow; row <= endRow; row += 1) lines.push(options.rows[row] ?? '')
    return lines.join('\n')
  }

  function unused(name: string): never {
    throw new Error(`${name} not used by the export fake client`)
  }

  const partial: Record<string, unknown> = {
    async initWorkbook(sheets: string[] = ['Sheet1']) {
      return sheets.map((name, idx) => ({ idx, name }))
    },
    async describeCapabilities() {
      return null
    },
    async sheetList() {
      return [{ idx: 0, name: 'Sheet1' }]
    },
    async listNonEmpty() {
      return []
    },
    // The single-shot fallback the TS runtime (and any runtime without
    // `tsvChunkExport`) takes.
    async exportRangeTsv(range: { startRow: number; endRow: number }) {
      return bandText(range.startRow, range.endRow)
    },
    onCellsDirty() {
      return () => {}
    },
    onCellsHydrated() {
      return () => {}
    },
    dispose() {},
  }

  if (streaming) {
    partial.consumeExportRangeTsvChunks = async (
      range: { startRow: number; endRow: number },
      onChunk: (c: {
        sessionId: number
        startRow: number
        endRow: number
        chunk: string
        done: boolean
      }) => void | Promise<void>,
    ) => {
      for (let start = range.startRow; start <= range.endRow; start += rowsPerChunk) {
        const end = Math.min(range.endRow, start + rowsPerChunk - 1)
        await onChunk({
          sessionId: 1,
          startRow: start,
          endRow: end,
          chunk: bandText(start, end),
          done: end >= range.endRow,
        })
      }
    }
  }

  return new Proxy(partial, {
    get(target, prop: string) {
      if (prop in target) return target[prop]
      if (prop === 'then') return undefined
      // Absent-by-design, so the adapter's `typeof … === 'function'` gate
      // correctly falls through to the single-shot branch.
      if (prop === 'consumeExportRangeTsvChunks') return undefined
      return () => unused(prop)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any
}

async function collectChunks(
  backend: SpreadsheetBackend,
  request: RangeTsvExportRequest,
) {
  const texts: string[] = []
  const result = await backend.consumeExportRangeTsvChunks!(request, (chunk) => {
    texts.push(chunk.text)
  })
  // Exactly how both hosts assemble the clipboard payload.
  return { text: texts.join('\n'), chunkCount: texts.length, originAddr: result.originAddr }
}

describe('worker backend chunked TSV export honours the filter-hidden set', () => {
  const ROWS = ['keep-0', 'FILTERED-1', 'keep-2', 'FILTERED-3', 'keep-4', 'keep-5']
  const range = { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 0 }

  function makeBackend(opts: { rowsPerChunk?: number; streaming?: boolean } = {}) {
    return createWorkerWorkbookSpreadsheetBackend({
      client: createExportFakeClient({ rows: ROWS, ...opts }),
      sheets: ['Sheet1'],
    })
  }

  test('COUNTER-EXAMPLE: without the set, filtered rows reach the clipboard', async () => {
    const backend = makeBackend()
    await backend.ready()
    const out = await collectChunks(backend, {
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
    })

    // Pre-slice behaviour asserted as the defect: the large-range copy path
    // exports rows the small-range path already excludes.
    expect(out.text).toBe('keep-0\nFILTERED-1\nkeep-2\nFILTERED-3\nkeep-4\nkeep-5')
    expect(out.text).toContain('FILTERED-1')
  })

  test('with the set, filtered rows are dropped across chunk boundaries', async () => {
    const backend = makeBackend({ rowsPerChunk: 2 })
    await backend.ready()
    // Rows 1 and 3 sit in different chunks (bands 0-1, 2-3, 4-5), so this
    // also proves the row offset is applied per band rather than per line.
    const out = await collectChunks(backend, {
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
      hiddenRows: [1, 3],
    })

    expect(out.text).toBe('keep-0\nkeep-2\nkeep-4\nkeep-5')
    expect(out.text).not.toContain('FILTERED')
    // No blank lines: 4 surviving rows means 4 lines, full stop.
    expect(out.text.split('\n')).toHaveLength(4)
  })

  test('a chunk emptied by the filter is not emitted at all', async () => {
    const backend = makeBackend({ rowsPerChunk: 2 })
    await backend.ready()
    // Bands are 0-1, 2-3, 4-5. Hiding rows 2 AND 3 empties the middle chunk
    // entirely. Emitting it as '' would put a blank line in the middle of the
    // clipboard, because the hosts join chunk texts with '\n' — this is the
    // artefact the `rowCount === 0` guard exists to prevent.
    const out = await collectChunks(backend, {
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
      hiddenRows: [2, 3],
    })

    expect(out.chunkCount).toBe(2)
    expect(out.text).toBe('keep-0\nFILTERED-1\nkeep-4\nkeep-5')
    expect(out.text).not.toContain('\n\n')
  })

  test('the origin marker names the first EMITTED row', async () => {
    const backend = makeBackend({ rowsPerChunk: 2 })
    await backend.ready()

    const unguarded = await collectChunks(backend, {
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
    })
    // COUNTER-EXAMPLE: names row 0 unconditionally.
    expect(unguarded.originAddr).toBe('A1')

    const guarded = await collectChunks(backend, {
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
      hiddenRows: [0, 1, 2],
    })
    // Row 3 is the first survivor. Leaving the marker at A1 would shift every
    // relative reference in the pasted formulas by three rows.
    expect(guarded.originAddr).toBe('A4')
    expect(guarded.text).toBe('FILTERED-3\nkeep-4\nkeep-5')
  })

  test('the single-shot fallback branch is guarded too', async () => {
    // A runtime without `tsvChunkExport` (the TS runtime, today) takes the
    // `client.exportRangeTsv` branch. It must not become the leak.
    const backend = makeBackend({ streaming: false })
    await backend.ready()

    const unguarded = await collectChunks(backend, {
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
    })
    expect(unguarded.text).toContain('FILTERED-1')

    const guarded = await collectChunks(backend, {
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
      hiddenRows: [1, 3],
    })
    expect(guarded.text).toBe('keep-0\nkeep-2\nkeep-4\nkeep-5')
  })

  test('exportRangeTsv (which delegates to the chunk path) is guarded', async () => {
    const backend = makeBackend({ rowsPerChunk: 2 })
    await backend.ready()

    const unguarded = await backend.exportRangeTsv!({
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
    })
    expect(unguarded.text).toContain('FILTERED-1')

    const guarded = await backend.exportRangeTsv!({
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
      hiddenRows: [1, 3],
    })
    expect(guarded.text).toBe('keep-0\nkeep-2\nkeep-4\nkeep-5')
    expect(guarded.originAddr).toBe('A1')
  })

  test('an omitted set leaves the chunk stream byte-for-byte unchanged', async () => {
    // The identity guarantee for TODAY: same chunk count, same texts, same
    // marker. If this ever diverges, the slice stopped being behaviour-neutral.
    const a = makeBackend({ rowsPerChunk: 2 })
    await a.ready()
    const omitted = await collectChunks(a, {
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
    })

    const b = makeBackend({ rowsPerChunk: 2 })
    await b.ready()
    const empty = await collectChunks(b, {
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
      hiddenRows: [],
    })

    expect(empty.text).toBe(omitted.text)
    expect(empty.chunkCount).toBe(omitted.chunkCount)
    expect(empty.originAddr).toBe(omitted.originAddr)
  })
})
