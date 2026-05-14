import { describe, expect, it } from '@jest/globals'
import {
  createRangeProjectionRequest,
  createVisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import {
  createStaticSpreadsheetBackend,
  matrixToDisplayCells,
  matrixToVisibleProjectionResult,
  sparseCellsToDisplayCells,
  sparseCellsToRangeProjectionResult,
} from '../src-vnext/adapter'

describe('vnext adapter', () => {
  it('converts matrix seeds into bounded visible-window results', () => {
    const request = createVisibleProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 1,
      revision: 7,
      window: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
    })

    const result = matrixToVisibleProjectionResult(
      [
        ['A1', 'B1'],
        ['A2', 'B2'],
        ['A3', 'B3'],
      ],
      request,
      7,
    )

    expect(result).toEqual({
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 1,
      revision: 7,
      window: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      cells: [
        { row: 0, col: 0, displayValue: 'A1', valueKind: 'string' },
        { row: 0, col: 1, displayValue: 'B1', valueKind: 'string' },
        { row: 1, col: 0, displayValue: 'A2', valueKind: 'string' },
        { row: 1, col: 1, displayValue: 'B2', valueKind: 'string' },
      ],
    })
  })

  it('converts sparse cells into bounded range results', () => {
    const request = createRangeProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 2,
      revision: 8,
      reason: 'selection',
      range: { rowStart: 1, rowEnd: 2, colStart: 0, colEnd: 1 },
    })

    const result = sparseCellsToRangeProjectionResult(
      [
        { row: 0, col: 0, displayValue: 'outside-top' },
        { row: 1, col: 0, displayValue: 'in-range-a' },
        { row: 2, col: 1, displayValue: 'in-range-b' },
        { row: 3, col: 1, displayValue: 'outside-bottom' },
      ],
      request,
      8,
    )

    expect(result.cells).toEqual([
      { row: 1, col: 0, displayValue: 'in-range-a' },
      { row: 2, col: 1, displayValue: 'in-range-b' },
    ])
    expect(result.range).toEqual(request.range)
    expect(result.requestId).toBe(2)
    expect(result.revision).toBe(8)
  })

  it('keeps setCellInput isolated to the target cell and bumps revision', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 3,
      matrix: [
        ['A1', 'B1'],
        ['A2', 'B2'],
      ],
    })

    const mutation = await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      requestId: 9,
      revision: 3,
      row: 0,
      col: 1,
      input: 'B1-updated',
    })

    expect(mutation).toEqual({
      sheetId: 'sheet-1',
      requestId: 9,
      revision: 3,
      affectedRange: {
        rowStart: 0,
        rowEnd: 0,
        colStart: 1,
        colEnd: 1,
      },
    })

    const result = await backend.readRangeProjection(
      createRangeProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 10,
        range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
        reason: 'test',
      }),
    )

    expect(result.revision).toBe(4)
    expect(result.cells).toEqual([
      { row: 0, col: 0, displayValue: 'A1', valueKind: 'string' },
      { row: 0, col: 1, displayValue: 'B1-updated', valueKind: 'string' },
      { row: 1, col: 0, displayValue: 'A2', valueKind: 'string' },
      { row: 1, col: 1, displayValue: 'B2', valueKind: 'string' },
    ])
  })

  it('supports sparse seed helpers directly', () => {
    const cells = sparseCellsToDisplayCells([
      { row: 2, col: 2, displayValue: 'C3' },
      { row: 0, col: 1, displayValue: 'B1' },
    ])

    expect(cells).toEqual([
      { row: 0, col: 1, displayValue: 'B1' },
      { row: 2, col: 2, displayValue: 'C3' },
    ])

    expect(
      matrixToDisplayCells([
        [true, 0],
        [null, 'x'],
      ]),
    ).toEqual([
      { row: 0, col: 0, displayValue: 'TRUE', valueKind: 'boolean' },
      { row: 0, col: 1, displayValue: '0', valueKind: 'number' },
      { row: 1, col: 1, displayValue: 'x', valueKind: 'string' },
    ])
  })

  it('keeps requestId and revision aligned on visible reads', async () => {
    const backend = createStaticSpreadsheetBackend([
      ['A1', 'B1'],
      ['A2', 'B2'],
    ])

    const request = createVisibleProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 42,
      revision: 11,
      window: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })

    const result = await backend.readVisibleProjection(request)

    expect(result).toMatchObject({
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 42,
      revision: 11,
    })
    expect(result.cells).toEqual([{ row: 0, col: 0, displayValue: 'A1', valueKind: 'string' }])
  })
})
