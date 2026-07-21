import { describe, expect, it } from '@jest/globals'
import { createRangeProjectionRequest, type DisplayCell } from '@einfach/spreadsheet-ui-core'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter'

// Pins the static-backend structural remap of merge ranges and freeze
// panes across insertRows / deleteRows / insertColumns / deleteColumns,
// and the structuralShift descriptor on the mutation results.
//
// Merge semantics (Excel): insert before a merge shifts it whole,
// insert strictly inside extends it; delete before shifts it back,
// partial overlap shrinks it, full coverage removes it, and a merge
// that shrinks to a single cell stops being a merge.
//
// Freeze semantics: freeze counts describe the frozen leading band
// [0, rows) / [0, cols). Inserting strictly above/left of the freeze
// line grows the band by count; deleting shrinks it by the overlap
// with the band; operations at or past the freeze line are no-ops.

const SHEET = 'sheet-1'

function seededBackend() {
  return createStaticSpreadsheetBackend({
    revision: 1,
    matrix: [
      ['A1', 'B1', 'C1', 'D1'],
      ['A2', 'B2', 'C2', 'D2'],
      ['A3', 'B3', 'C3', 'D3'],
      ['A4', 'B4', 'C4', 'D4'],
      ['A5', 'B5', 'C5', 'D5'],
      ['A6', 'B6', 'C6', 'D6'],
    ],
  })
}

async function readCells(
  backend: ReturnType<typeof seededBackend>,
  range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
): Promise<DisplayCell[]> {
  const result = await backend.readRangeProjection(
    createRangeProjectionRequest({ sheetId: SHEET, requestId: 99, reason: 'test', range }),
  )
  return result.cells
}

function mergeCells(cells: DisplayCell[]) {
  return cells
    .filter((cell) => cell.mergedSpan || cell.mergeAnchor)
    .map(({ row, col, mergedSpan, mergeAnchor }) => ({ row, col, mergedSpan, mergeAnchor }))
    .sort((a, b) => (a.row === b.row ? a.col - b.col : a.row - b.row))
}

async function readFreeze(backend: ReturnType<typeof seededBackend>) {
  const result = await backend.readFreezeConfig?.({ kind: 'read-freeze-config', sheetId: SHEET })
  return result?.freeze
}

describe('static backend structural merge remap', () => {
  it('insertRows above a merge shifts it whole and reports structuralShift', async () => {
    const backend = seededBackend()
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
    })

    const mutation = await backend.insertRows?.({
      kind: 'insert-rows',
      sheetId: SHEET,
      requestId: 7,
      rowIndex: 0,
      count: 2,
    })

    expect(mutation).toMatchObject({
      sheetId: SHEET,
      requestId: 7,
      structuralShift: { axis: 'row', kind: 'insert', index: 0, count: 2 },
    })

    const cells = await readCells(backend, { rowStart: 0, rowEnd: 7, colStart: 0, colEnd: 3 })
    expect(mergeCells(cells)).toEqual([
      { row: 3, col: 1, mergedSpan: { rows: 2, cols: 2 }, mergeAnchor: undefined },
      { row: 3, col: 2, mergedSpan: undefined, mergeAnchor: { row: 3, col: 1 } },
      { row: 4, col: 1, mergedSpan: undefined, mergeAnchor: { row: 3, col: 1 } },
      { row: 4, col: 2, mergedSpan: undefined, mergeAnchor: { row: 3, col: 1 } },
    ])
  })

  it('insertRows strictly inside a merge extends it', async () => {
    const backend = seededBackend()
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 2, colStart: 1, colEnd: 1 },
    })

    await backend.insertRows?.({ kind: 'insert-rows', sheetId: SHEET, rowIndex: 1, count: 1 })

    const cells = await readCells(backend, { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 2 })
    const anchor = cells.find((cell) => cell.row === 0 && cell.col === 1)
    expect(anchor?.mergedSpan).toEqual({ rows: 4, cols: 1 })
    expect(
      cells
        .filter((cell) => cell.mergeAnchor)
        .map((cell) => [cell.row, cell.col]),
    ).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ])
  })

  it('deleteRows overlapping a merge shrinks it and reports structuralShift', async () => {
    const backend = seededBackend()
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 3, colStart: 1, colEnd: 2 },
    })

    const mutation = await backend.deleteRows?.({
      kind: 'delete-rows',
      sheetId: SHEET,
      requestId: 8,
      rowIndex: 2,
      count: 1,
    })

    expect(mutation).toMatchObject({
      structuralShift: { axis: 'row', kind: 'delete', index: 2, count: 1 },
    })

    const cells = await readCells(backend, { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 3 })
    const anchor = cells.find((cell) => cell.row === 1 && cell.col === 1)
    expect(anchor?.mergedSpan).toEqual({ rows: 2, cols: 2 })
  })

  it('deleteRows covering a merge removes it entirely', async () => {
    const backend = seededBackend()
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
    })

    await backend.deleteRows?.({ kind: 'delete-rows', sheetId: SHEET, rowIndex: 1, count: 2 })

    const cells = await readCells(backend, { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 3 })
    expect(mergeCells(cells)).toEqual([])
  })

  it('a merge collapsing to a single cell stops being a merge', async () => {
    const backend = seededBackend()
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 1 },
    })

    await backend.deleteRows?.({ kind: 'delete-rows', sheetId: SHEET, rowIndex: 2, count: 1 })

    const cells = await readCells(backend, { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 3 })
    expect(mergeCells(cells)).toEqual([])
  })

  it('insertColumns and deleteColumns remap merges on the column axis', async () => {
    const backend = seededBackend()
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
    })

    const insert = await backend.insertColumns?.({
      kind: 'insert-columns',
      sheetId: SHEET,
      requestId: 9,
      colIndex: 0,
      count: 1,
    })
    expect(insert).toMatchObject({
      structuralShift: { axis: 'column', kind: 'insert', index: 0, count: 1 },
    })

    let cells = await readCells(backend, { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 })
    let anchor = cells.find((cell) => cell.mergedSpan)
    expect(anchor && [anchor.row, anchor.col]).toEqual([1, 2])
    expect(anchor?.mergedSpan).toEqual({ rows: 2, cols: 2 })

    const remove = await backend.deleteColumns?.({
      kind: 'delete-columns',
      sheetId: SHEET,
      requestId: 10,
      colIndex: 3,
      count: 1,
    })
    expect(remove).toMatchObject({
      structuralShift: { axis: 'column', kind: 'delete', index: 3, count: 1 },
    })

    cells = await readCells(backend, { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 4 })
    anchor = cells.find((cell) => cell.mergedSpan)
    expect(anchor && [anchor.row, anchor.col]).toEqual([1, 2])
    expect(anchor?.mergedSpan).toEqual({ rows: 2, cols: 1 })
  })

  it('merges entirely before the operation index stay put', async () => {
    const backend = seededBackend()
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })

    await backend.insertRows?.({ kind: 'insert-rows', sheetId: SHEET, rowIndex: 4, count: 2 })
    await backend.deleteRows?.({ kind: 'delete-rows', sheetId: SHEET, rowIndex: 3, count: 2 })

    const cells = await readCells(backend, { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 2 })
    const anchor = cells.find((cell) => cell.row === 0 && cell.col === 0)
    expect(anchor?.mergedSpan).toEqual({ rows: 2, cols: 2 })
  })

  it('undoTransaction restores pre-shift merge coordinates', async () => {
    const backend = seededBackend()
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
    })

    await backend.insertRows?.({ kind: 'insert-rows', sheetId: SHEET, rowIndex: 0, count: 2 })
    await backend.undoTransaction?.({ kind: 'undo-transaction', transactionId: 't-1' })

    const cells = await readCells(backend, { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 3 })
    const anchor = cells.find((cell) => cell.mergedSpan)
    expect(anchor && [anchor.row, anchor.col]).toEqual([1, 1])
    expect(anchor?.mergedSpan).toEqual({ rows: 2, cols: 2 })
  })
})

describe('static backend structural freeze remap', () => {
  async function freezeBackend(rows: number, cols: number) {
    const backend = seededBackend()
    await backend.setFreezeConfig?.({
      kind: 'set-freeze-config',
      sheetId: SHEET,
      freeze: { rows, cols },
    })
    return backend
  }

  it('insertRows above the freeze line grows the frozen row band', async () => {
    const backend = await freezeBackend(3, 2)
    await backend.insertRows?.({ kind: 'insert-rows', sheetId: SHEET, rowIndex: 1, count: 2 })
    expect(await readFreeze(backend)).toEqual({ rows: 5, cols: 2 })
  })

  it('insertRows at or below the freeze line leaves the band untouched', async () => {
    const backend = await freezeBackend(3, 2)
    await backend.insertRows?.({ kind: 'insert-rows', sheetId: SHEET, rowIndex: 3, count: 4 })
    expect(await readFreeze(backend)).toEqual({ rows: 3, cols: 2 })
  })

  it('deleteRows inside the frozen band shrinks it by the full count', async () => {
    const backend = await freezeBackend(3, 2)
    await backend.deleteRows?.({ kind: 'delete-rows', sheetId: SHEET, rowIndex: 1, count: 2 })
    expect(await readFreeze(backend)).toEqual({ rows: 1, cols: 2 })
  })

  it('deleteRows crossing the freeze line shrinks the band only by the overlap', async () => {
    const backend = await freezeBackend(3, 2)
    await backend.deleteRows?.({ kind: 'delete-rows', sheetId: SHEET, rowIndex: 2, count: 5 })
    expect(await readFreeze(backend)).toEqual({ rows: 2, cols: 2 })
  })

  it('deleteRows below the freeze line leaves the band untouched', async () => {
    const backend = await freezeBackend(3, 2)
    await backend.deleteRows?.({ kind: 'delete-rows', sheetId: SHEET, rowIndex: 3, count: 2 })
    expect(await readFreeze(backend)).toEqual({ rows: 3, cols: 2 })
  })

  it('insertColumns and deleteColumns remap the frozen column band', async () => {
    const backend = await freezeBackend(1, 2)
    await backend.insertColumns?.({ kind: 'insert-columns', sheetId: SHEET, colIndex: 0, count: 1 })
    expect(await readFreeze(backend)).toEqual({ rows: 1, cols: 3 })

    await backend.deleteColumns?.({ kind: 'delete-columns', sheetId: SHEET, colIndex: 0, count: 5 })
    expect(await readFreeze(backend)).toEqual({ rows: 1, cols: 0 })
  })

  it('a zero freeze never changes across structural operations', async () => {
    const backend = seededBackend()
    await backend.insertRows?.({ kind: 'insert-rows', sheetId: SHEET, rowIndex: 0, count: 3 })
    await backend.deleteColumns?.({ kind: 'delete-columns', sheetId: SHEET, colIndex: 0, count: 1 })
    expect(await readFreeze(backend)).toEqual({ rows: 0, cols: 0 })
  })
})

// removeRowsExact / legacy removeRows share applyStaticRowsRemoval: every
// descending single-row band must apply the same delete-shift semantics
// to merges and freeze panes as the W3 deleteRows path above.
describe('static backend removeRowsExact structural remap', () => {
  function mergeAnchors(cells: DisplayCell[]) {
    return cells
      .filter((cell) => cell.mergedSpan)
      .map(({ row, col, mergedSpan }) => ({ row, col, mergedSpan }))
      .sort((a, b) => (a.row === b.row ? a.col - b.col : a.row - b.row))
  }

  async function currentRevision(backend: ReturnType<typeof seededBackend>) {
    return (await backend.listSheets!()).revision as number
  }

  // Bands for rows [2, 3, 5]: contiguous (2, count 2) and (5, count 1).
  async function seedMergesAndFreeze(backend: ReturnType<typeof seededBackend>) {
    // M1 rows 0..1 — entirely above both bands, must stay put.
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
    // M2 rows 2..3 — fully covered by band (2,2), must be removed.
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 2, rowEnd: 3, colStart: 0, colEnd: 1 },
    })
    // M3 rows 1..4 — overlaps band (2,2), must shrink to rows 1..2.
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 4, colStart: 2, colEnd: 3 },
    })
    // M4 rows 4..5 — loses row 5 to band (5,1), then shifts up to row 2.
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 4, rowEnd: 5, colStart: 0, colEnd: 1 },
    })
    await backend.setFreezeConfig?.({
      kind: 'set-freeze-config',
      sheetId: SHEET,
      freeze: { rows: 5, cols: 2 },
    })
  }

  async function removeMultiBand(backend: ReturnType<typeof seededBackend>) {
    return backend.removeRowsExact({
      kind: 'remove-rows',
      requestId: 41,
      sheetId: SHEET,
      targetRange: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 3 },
      rows: [2, 3, 5],
      revision: await currentRevision(backend),
    })
  }

  it('multi-band exact removal remaps merges per band and keeps the exact ACK shape', async () => {
    const backend = seededBackend()
    await seedMergesAndFreeze(backend)
    const revision = await currentRevision(backend)

    const result = await removeMultiBand(backend)
    expect(result).toEqual({
      requestId: 41,
      sheetId: SHEET,
      targetRange: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 3 },
      removedRowIndices: [2, 3, 5],
      removedRows: 3,
      affectedRange: { startRow: 2, endRow: 5, startCol: 0, endCol: 3 },
      revision: revision + 1,
    })

    const cells = await readCells(backend, { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 3 })
    expect(mergeAnchors(cells)).toEqual([
      { row: 0, col: 0, mergedSpan: { rows: 2, cols: 2 } },
      { row: 1, col: 2, mergedSpan: { rows: 2, cols: 2 } },
      { row: 2, col: 0, mergedSpan: { rows: 1, cols: 2 } },
    ])
  })

  it('multi-band exact removal shrinks the freeze band only by the in-band overlap', async () => {
    const backend = seededBackend()
    await seedMergesAndFreeze(backend)
    await removeMultiBand(backend)
    // Band (5,1) sits outside the frozen [0..4] band; band (2,2) is inside.
    expect(await readFreeze(backend)).toEqual({ rows: 3, cols: 2 })
  })

  it('undoTransaction restores pre-removal merge and freeze facts via the fullSheet capture', async () => {
    const backend = seededBackend()
    await seedMergesAndFreeze(backend)
    await removeMultiBand(backend)
    await backend.undoTransaction?.({ kind: 'undo-transaction', transactionId: 't-remove' })

    const cells = await readCells(backend, { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 3 })
    expect(mergeAnchors(cells)).toEqual([
      { row: 0, col: 0, mergedSpan: { rows: 2, cols: 2 } },
      { row: 1, col: 2, mergedSpan: { rows: 4, cols: 2 } },
      { row: 2, col: 0, mergedSpan: { rows: 2, cols: 2 } },
      { row: 4, col: 0, mergedSpan: { rows: 2, cols: 2 } },
    ])
    expect(await readFreeze(backend)).toEqual({ rows: 5, cols: 2 })
  })

  it('legacy removeRows shares the merge/freeze remap for unordered multi-band input', async () => {
    const backend = seededBackend()
    await backend.mergeRange?.({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 4, colStart: 0, colEnd: 1 },
    })
    await backend.setFreezeConfig?.({
      kind: 'set-freeze-config',
      sheetId: SHEET,
      freeze: { rows: 5, cols: 0 },
    })

    const result = await backend.removeRows?.({
      kind: 'remove-rows',
      sheetId: SHEET,
      rows: [5, 3, 2],
    })
    expect(result).toMatchObject({ sheetId: SHEET, removedRows: 3 })

    const cells = await readCells(backend, { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 3 })
    expect(mergeAnchors(cells)).toEqual([{ row: 1, col: 0, mergedSpan: { rows: 2, cols: 2 } }])
    expect(await readFreeze(backend)).toEqual({ rows: 3, cols: 0 })
  })
})

// ---------------------------------------------------------------------------
// #27 S5a — the FILTER-hidden snapshot is displaced by the same shift.
//
// Since the S5 flip this backend keeps `filterHiddenRowsBySheetId` as a
// SNAPSHOT: it withholds those rows from every projection AND feeds them to
// its evaluator as the SUBTOTAL filter lane. Nothing recomputes it per
// revision any more, so a row insert/delete has to remap it — the twin of the
// `hiddenRowsBySheetId` remap two lines up in `insertRows` / `deleteRows`.
//
// Differential, not tautological: the pre-insert numbers are pinned first, and
// they are exactly what an unshifted snapshot keeps answering afterwards.
// ---------------------------------------------------------------------------

describe('static backend structural remap of the FILTER-hidden snapshot (S5a)', () => {
  async function filterBackend() {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: [{ id: SHEET, name: 'Sheet1' }],
      // A1 'Val', A2:A5 = 10/20/30/40.
      matrix: [['Val'], [10], [20], [30], [40]],
    })
    // Three probes on the header row. Formulas have to arrive through
    // setCellInput — a seed matrix stores display values verbatim.
    // Whole-column ranges on purpose: this backend does not rewrite formula
    // references across a structural shift, so a bounded A2:A5 would move
    // relative to the data and muddy the differential this test is making.
    const probeInputs = ['=SUBTOTAL(9,A1:A10)', '=SUBTOTAL(109,A1:A10)', '=SUM(A1:A10)']
    for (let offset = 0; offset < probeInputs.length; offset += 1) {
      await backend.setCellInput({
        kind: 'set-cell-input',
        sheetId: SHEET,
        row: 0,
        col: 2 + offset,
        input: probeInputs[offset]!,
        requestId: 900 + offset,
      })
    }
    return backend
  }

  async function probes(
    backend: Awaited<ReturnType<typeof filterBackend>>,
    probeRow: number,
  ): Promise<{ s9: string; s109: string; sum: string }> {
    const cells = await readCells(backend, {
      rowStart: probeRow,
      rowEnd: probeRow,
      colStart: 2,
      colEnd: 4,
    })
    const at = (col: number) =>
      cells.find((cell) => cell.row === probeRow && cell.col === col)?.displayValue ?? ''
    return { s9: at(2), s109: at(3), sum: at(4) }
  }

  async function columnA(backend: Awaited<ReturnType<typeof filterBackend>>, rowEnd: number) {
    const cells = await readCells(backend, { rowStart: 0, rowEnd, colStart: 0, colEnd: 0 })
    return cells
      .filter((cell) => cell.col === 0)
      .sort((left, right) => left.row - right.row)
      .map((cell) => [cell.row, cell.displayValue] as const)
  }

  it('an insert above an active filter moves the snapshot, the projection and SUBTOTAL', async () => {
    const backend = await filterBackend()
    // Manually hide source row 2 (the 20) and filter the 10 away, as in the
    // reported repro. The two lanes must stay independently addressable.
    await backend.hideRows?.({ kind: 'hide-rows', sheetId: SHEET, rowIndices: [2] })
    const ack = await backend.setFilterSort?.({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [{ kind: 'range', colIndex: 0, min: 20 }],
      requestId: 1,
    })
    expect(ack?.hiddenRowIndices).toEqual([1])

    expect(await probes(backend, 0)).toEqual({ s9: '90', s109: '70', sum: '100' })
    expect(await columnA(backend, 4)).toEqual([
      [0, 'Val'],
      [2, '20'],
      [3, '30'],
      [4, '40'],
    ])

    await backend.insertRows?.({ kind: 'insert-rows', sheetId: SHEET, rowIndex: 0, count: 1 })

    // Header at its new row 1, the filtered-out 10 still withheld. An
    // unshifted snapshot swallows row 1 and paints the 10 at row 2.
    expect(await columnA(backend, 5)).toEqual([
      [1, 'Val'],
      [3, '20'],
      [4, '30'],
      [5, '40'],
    ])
    // 90 / 70 are unreachable from a snapshot still holding index 1: that one
    // points at the (non-numeric) header after the shift, so it excludes
    // nothing and the two SUBTOTAL bands answer 100 / 80 instead.
    expect(await probes(backend, 1)).toEqual({ s9: '90', s109: '70', sum: '100' })
  })

  it('a delete band consuming filter-hidden rows drops them and shifts the rest', async () => {
    const backend = await filterBackend()
    await backend.setFilterSort?.({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [{ kind: 'range', colIndex: 0, min: 30 }],
      requestId: 1,
    })
    // Rows 1 (10) and 2 (20) are filter-hidden.
    expect(await columnA(backend, 4)).toEqual([
      [0, 'Val'],
      [3, '30'],
      [4, '40'],
    ])

    // Delete rows 1..2 — the whole filter-hidden band. It must LEAVE the set,
    // not slide onto the rows that took its place.
    await backend.deleteRows?.({ kind: 'delete-rows', sheetId: SHEET, rowIndex: 1, count: 2 })
    expect(await columnA(backend, 2)).toEqual([
      [0, 'Val'],
      [1, '30'],
      [2, '40'],
    ])
    expect(await probes(backend, 0)).toEqual({ s9: '70', s109: '70', sum: '70' })
  })

  it('undo restores the pre-shift snapshot', async () => {
    const backend = await filterBackend()
    await backend.setFilterSort?.({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [{ kind: 'range', colIndex: 0, min: 20 }],
      requestId: 1,
    })
    await backend.insertRows?.({ kind: 'insert-rows', sheetId: SHEET, rowIndex: 0, count: 1 })
    expect(await columnA(backend, 5)).toEqual([
      [1, 'Val'],
      [3, '20'],
      [4, '30'],
      [5, '40'],
    ])

    const undone = await backend.undoTransaction?.({
      kind: 'undo-transaction',
      transactionId: 'static-s5a-undo',
      requestId: 2,
    })
    expect(undone?.applied).not.toBe(false)
    expect(await columnA(backend, 4)).toEqual([
      [0, 'Val'],
      [2, '20'],
      [3, '30'],
      [4, '40'],
    ])
  })

  it('a COLUMN insert leaves the row snapshot alone', async () => {
    const backend = await filterBackend()
    await backend.setFilterSort?.({
      kind: 'set-filter-sort',
      sheetId: SHEET,
      rules: [{ kind: 'range', colIndex: 0, min: 20 }],
      requestId: 1,
    })
    await backend.insertColumns?.({ kind: 'insert-columns', sheetId: SHEET, colIndex: 0, count: 1 })
    // Everything moved one column right; the withheld ROW is unchanged.
    const cells = await readCells(backend, { rowStart: 0, rowEnd: 4, colStart: 1, colEnd: 1 })
    expect(
      cells
        .filter((cell) => cell.col === 1)
        .sort((left, right) => left.row - right.row)
        .map((cell) => [cell.row, cell.displayValue] as const),
    ).toEqual([
      [0, 'Val'],
      [2, '20'],
      [3, '30'],
      [4, '40'],
    ])
  })
})
