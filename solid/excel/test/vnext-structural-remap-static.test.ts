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
