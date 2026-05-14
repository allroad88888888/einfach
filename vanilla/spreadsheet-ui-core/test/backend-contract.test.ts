import { describe, expect, test } from '@jest/globals'
import type { SpreadsheetBackend } from '../src'
import {
  createRangeProjectionRequest,
  createVisibleProjectionRequest,
  validateProjectionResult,
} from '../src'

describe('backend contract', () => {
  test('uses visible-window and explicit range ports without exposing workbook facts', async () => {
    const backend: SpreadsheetBackend = {
      async readVisibleProjection(request) {
        return {
          kind: 'visible-window',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 'r1',
          window: request.window,
          cells: [
            {
              row: request.window.rowStart,
              col: request.window.colStart,
              displayValue: '1',
            },
          ],
        }
      },
      async readRangeProjection(request) {
        return {
          kind: 'range',
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 'r1',
          range: request.range,
          cells: [{ row: request.range.rowStart, col: request.range.colStart, displayValue: 'A' }],
        }
      },
      async setCellInput(request) {
        return {
          sheetId: request.sheetId,
          requestId: request.requestId,
          revision: 'r2',
          affectedRange: {
            rowStart: request.row,
            rowEnd: request.row,
            colStart: request.col,
            colEnd: request.col,
          },
        }
      },
    }

    const visibleRequest = createVisibleProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 7,
      window: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 2 },
    })
    const rangeRequest = createRangeProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 8,
      reason: 'selection',
      range: { rowStart: 2, rowEnd: 3, colStart: 1, colEnd: 1 },
    })

    const visibleResult = await backend.readVisibleProjection(visibleRequest)
    const rangeResult = await backend.readRangeProjection(rangeRequest)
    const mutationResult = await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      requestId: 9,
      row: 2,
      col: 1,
      input: '=A1+1',
    })

    expect(validateProjectionResult(visibleResult, { request: visibleRequest })).toEqual({
      ok: true,
      cellCount: 15,
    })
    expect(validateProjectionResult(rangeResult, { request: rangeRequest })).toEqual({
      ok: true,
      cellCount: 2,
    })
    expect(mutationResult).toMatchObject({
      sheetId: 'sheet-1',
      requestId: 9,
      revision: 'r2',
      affectedRange: { rowStart: 2, rowEnd: 2, colStart: 1, colEnd: 1 },
    })
  })
})
