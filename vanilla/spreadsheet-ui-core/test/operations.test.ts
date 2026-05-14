import { describe, expect, test } from '@jest/globals'
import {
  createAddSheetOperation,
  createDeleteColumnsOperation,
  createDeleteSheetOperation,
  createInsertColumnsOperation,
  createInsertRowsOperation,
  createRenameSheetOperation,
  createReorderSheetOperation,
  createSetCellOperation,
  getOperationCellRange,
  isSheetMutationOperation,
} from '../src/operations'

describe('operations core', () => {
  test('creates normalized intents for the common spreadsheet mutations', () => {
    expect(
      createSetCellOperation({
        sheetId: 'sheet-1',
        row: 3,
        col: 4,
        input: '=A1+1',
      }),
    ).toEqual({
      kind: 'cell.set-input',
      sheetId: 'sheet-1',
      row: 3,
      col: 4,
      input: '=A1+1',
      source: undefined,
      requestId: undefined,
      revision: undefined,
    })

    expect(
      createInsertRowsOperation({
        sheetId: 'sheet-1',
        rowIndex: 2,
        count: 3,
      }),
    ).toMatchObject({
      kind: 'row.insert',
      sheetId: 'sheet-1',
      rowIndex: 2,
      count: 3,
    })

    expect(
      createDeleteColumnsOperation({
        sheetId: 'sheet-1',
        colIndex: 1,
        count: 2,
      }),
    ).toMatchObject({
      kind: 'column.delete',
      sheetId: 'sheet-1',
      colIndex: 1,
      count: 2,
    })

    expect(
      createRenameSheetOperation({
        sheetId: 'sheet-1',
        sheetName: '  Summary  ',
      }),
    ).toEqual({
      kind: 'sheet.rename',
      sheetId: 'sheet-1',
      sheetName: 'Summary',
      source: undefined,
      requestId: undefined,
      revision: undefined,
    })
  })

  test('guards invalid counts and missing reorder placement hints', () => {
    expect(() =>
      createSetCellOperation({
        sheetId: 'sheet-1',
        row: 1.5,
        col: 4,
        input: 'x',
      }),
    ).toThrow(RangeError)

    expect(() =>
      createInsertRowsOperation({
        sheetId: 'sheet-1',
        rowIndex: 0,
        count: 0,
      }),
    ).toThrow(RangeError)

    expect(() =>
      createDeleteColumnsOperation({
        sheetId: 'sheet-1',
        colIndex: -1,
        count: 1,
      }),
    ).toThrow(RangeError)

    expect(() =>
      createAddSheetOperation({
        sheetName: '   ',
      }),
    ).toThrow(RangeError)

    expect(() =>
      createReorderSheetOperation({
        sheetId: 'sheet-1',
      }),
    ).toThrow(RangeError)

    expect(
      isSheetMutationOperation(
        createDeleteSheetOperation({
          sheetId: 'sheet-1',
        }),
      ),
    ).toBe(true)

    expect(
      getOperationCellRange(
        createInsertColumnsOperation({
          sheetId: 'sheet-1',
          colIndex: 4,
          count: 2,
        }),
      ),
    ).toBeNull()
  })
})
