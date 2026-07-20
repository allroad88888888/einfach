/**
 * Static backend physical `sortRange` port (design-engine-sort #19). Covers the
 * reference engine's physical reorder, the structured reject gates that mirror
 * the worker adapter, format-follows-row semantics, and undo/redo. Cross-engine
 * order parity is pinned separately in `vnext-sort-static-wasm-parity.test.ts`.
 */

import { describe, expect, test } from '@jest/globals'

import {
  createStaticSpreadsheetBackend,
  type StaticSpreadsheetBackend,
} from '../src-vnext/adapter/static-backend'
import type { CellRange, DisplayCell, SortRangeKey } from '@einfach/spreadsheet-ui-core'

const SHEET = 'sheet-1'

async function readCol(
  backend: StaticSpreadsheetBackend,
  col: number,
  rowEnd: number,
): Promise<string[]> {
  const result = await backend.readVisibleProjection({
    kind: 'visible-window',
    sheetId: SHEET,
    window: { rowStart: 0, rowEnd, colStart: 0, colEnd: col },
    requestId: 1,
  })
  const byRow = new Map<number, string>()
  for (const cell of result.cells) {
    if (cell.col === col) byRow.set(cell.row, cell.displayValue)
  }
  return Array.from({ length: rowEnd + 1 }, (_, i) => byRow.get(i) ?? '')
}

async function readFormat(
  backend: StaticSpreadsheetBackend,
  row: number,
  col: number,
): Promise<DisplayCell['format']> {
  const result = await backend.readVisibleProjection({
    kind: 'visible-window',
    sheetId: SHEET,
    window: { rowStart: 0, rowEnd: row + 1, colStart: 0, colEnd: col },
    requestId: 2,
  })
  return result.cells.find((cell) => cell.row === row && cell.col === col)?.format
}

function numbers(col: number, values: number[]): DisplayCell[] {
  return values.map((value, row) => ({
    row,
    col,
    displayValue: String(value),
    valueKind: 'number' as const,
    numericValue: value,
  }))
}

async function sort(
  backend: StaticSpreadsheetBackend,
  range: CellRange,
  keys: SortRangeKey[],
  excludedRows?: number[],
) {
  return backend.sortRange!({ kind: 'sort-range', sheetId: SHEET, range, keys, excludedRows })
}

describe('static sortRange — physical reorder', () => {
  test('ascending sort physically moves rows and bumps the revision', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: ['Sheet1'],
      cells: [
        ...numbers(0, [3, 1, 2]),
        { row: 0, col: 1, displayValue: 'three', valueKind: 'string' },
        { row: 1, col: 1, displayValue: 'one', valueKind: 'string' },
        { row: 2, col: 1, displayValue: 'two', valueKind: 'string' },
      ],
    })
    const before = (await backend.listSheets!()).revision

    const result = await sort(backend, { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 }, [
      { col: 0, direction: 'asc' },
    ])
    expect(result.applied).toBe(true)
    if (result.applied) {
      expect(result.movedRows).toBe(3)
      expect(result.movedCells).toBe(6)
      expect(result.rowPermutation).toEqual([
        [0, 1],
        [1, 2],
        [2, 0],
      ])
      expect(result.revision).not.toBe(before)
    }
    expect(await readCol(backend, 0, 2)).toEqual(['1', '2', '3'])
    // The adjacent column rode along with the sorted rows.
    expect(await readCol(backend, 1, 2)).toEqual(['one', 'two', 'three'])
  })

  test('already-sorted data is a no-op: applied, movedRows 0, no revision bump', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: ['Sheet1'],
      cells: numbers(0, [1, 2, 3]),
    })
    const before = (await backend.listSheets!()).revision
    const result = await sort(backend, { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 }, [
      { col: 0, direction: 'asc' },
    ])
    expect(result.applied).toBe(true)
    if (result.applied) {
      expect(result.movedRows).toBe(0)
      expect(result.rowPermutation).toEqual([])
      expect(result.revision).toBe(before)
    }
    expect(await readCol(backend, 0, 2)).toEqual(['1', '2', '3'])
  })

  test('excluded rows stay in place and never participate in comparison', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: ['Sheet1'],
      cells: [
        { row: 0, col: 0, displayValue: '4', valueKind: 'number', numericValue: 4 },
        { row: 1, col: 0, displayValue: 'PINNED', valueKind: 'string' },
        { row: 2, col: 0, displayValue: '2', valueKind: 'number', numericValue: 2 },
        { row: 3, col: 0, displayValue: '1', valueKind: 'number', numericValue: 1 },
      ],
    })
    await sort(backend, { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 }, [{ col: 0 }], [1])
    // Visible slots 0,2,3 with keys 4,2,1 → 1,2,4; row 1 keeps 'PINNED'.
    expect(await readCol(backend, 0, 3)).toEqual(['1', 'PINNED', '2', '4'])
  })
})

describe('static sortRange — structured reject gates', () => {
  const backendFor = () =>
    createStaticSpreadsheetBackend({ sheets: ['Sheet1'], cells: numbers(0, [2, 1]) })

  test('empty keys reject with empty-keys and move nothing', async () => {
    const backend = backendFor()
    const result = await sort(backend, { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 }, [])
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.code).toBe('empty-keys')
    expect(await readCol(backend, 0, 1)).toEqual(['2', '1'])
  })

  test('a key column outside the range rejects with key-out-of-range', async () => {
    const backend = backendFor()
    const result = await sort(backend, { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 }, [
      { col: 5 },
    ])
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.code).toBe('key-out-of-range')
  })

  test('an over-cap range rejects with source-too-large before any work', async () => {
    const backend = backendFor()
    const result = await sort(
      backend,
      { rowStart: 0, rowEnd: 60_000, colStart: 0, colEnd: 0 },
      [{ col: 0 }],
    )
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.code).toBe('source-too-large')
  })

  test('a malformed range rejects with invalid-payload', async () => {
    const backend = backendFor()
    const result = await backend.sortRange!({
      kind: 'sort-range',
      sheetId: SHEET,
      keys: [{ col: 0 }],
    } as never)
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.code).toBe('invalid-payload')
  })

  test('a sort intersecting a merged range rejects with merge-in-range', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: ['Sheet1'],
      cells: numbers(0, [3, 1, 2]),
    })
    await backend.mergeRange!({
      kind: 'merge-range',
      sheetId: SHEET,
      range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })
    const result = await sort(backend, { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 }, [
      { col: 0 },
    ])
    expect(result.applied).toBe(false)
    if (!result.applied) expect(result.code).toBe('merge-in-range')
    // The rejected gate left the data untouched.
    expect(await readCol(backend, 0, 2)).toEqual(['3', '1', '2'])
  })
})

describe('static sortRange — formats and undo', () => {
  test('per-cell format follows its row', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: ['Sheet1'],
      cells: [
        { row: 0, col: 0, displayValue: '2', valueKind: 'number', numericValue: 2, format: { bold: true } },
        { row: 1, col: 0, displayValue: '1', valueKind: 'number', numericValue: 1 },
      ],
    })
    await sort(backend, { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 }, [{ col: 0, direction: 'asc' }])
    expect(await readCol(backend, 0, 1)).toEqual(['1', '2'])
    // The bold value (2) moved to row 1; row 0 is no longer bold.
    expect((await readFormat(backend, 1, 0))?.bold).toBe(true)
    expect((await readFormat(backend, 0, 0))?.bold).toBeUndefined()
  })

  test('a range-format layer is materialized + cut; new occupants are not polluted', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: ['Sheet1'],
      cells: numbers(0, [3, 1, 2]),
    })
    // Layer covers ONLY row 1 (the key-1 row that moves to slot 0).
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: SHEET,
      range: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      format: { bgColor: '#ff0000' },
    })
    await sort(backend, { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 }, [{ col: 0, direction: 'asc' }])
    expect(await readCol(backend, 0, 2)).toEqual(['1', '2', '3'])
    // Row 1's red followed its content to slot 0.
    expect((await readFormat(backend, 0, 0))?.bgColor).toBe('#ff0000')
    // The default rows that landed where the layer used to be are NOT red.
    expect((await readFormat(backend, 1, 0))?.bgColor).toBeUndefined()
    expect((await readFormat(backend, 2, 0))?.bgColor).toBeUndefined()
  })

  test('undo restores the pre-sort order; redo re-applies the sort', async () => {
    const backend = createStaticSpreadsheetBackend({
      sheets: ['Sheet1'],
      cells: numbers(0, [2, 1, 3]),
    })
    await sort(backend, { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 }, [{ col: 0, direction: 'asc' }])
    expect(await readCol(backend, 0, 2)).toEqual(['1', '2', '3'])

    await backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 't-sort' })
    expect(await readCol(backend, 0, 2)).toEqual(['2', '1', '3'])

    await backend.redoTransaction!({ kind: 'redo-transaction', transactionId: 't-sort' })
    expect(await readCol(backend, 0, 2)).toEqual(['1', '2', '3'])
  })
})
