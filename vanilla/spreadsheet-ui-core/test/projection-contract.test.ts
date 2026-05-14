import { describe, expect, test } from '@jest/globals'
import {
  createRangeProjectionRequest,
  createVisibleProjectionRequest,
  getProjectionWindowKey,
  isProjectionResultForRequest,
  validateProjectionRequest,
  validateProjectionResult,
} from '../src'

describe('projection contract', () => {
  test('creates bounded visible-window requests without keeping caller range references', () => {
    const window = { rowStart: 10, rowEnd: 14, colStart: 2, colEnd: 5 }
    const request = createVisibleProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 3,
      window,
      reason: 'viewport',
      revision: 'rev-a',
    })

    window.rowStart = 99

    expect(request).toEqual({
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 3,
      reason: 'viewport',
      revision: 'rev-a',
      window: { rowStart: 10, rowEnd: 14, colStart: 2, colEnd: 5 },
    })
    expect(validateProjectionRequest(request)).toEqual({ ok: true, cellCount: 20 })
  })

  test('creates explicit range requests for user commands, not workbook snapshots', () => {
    const request = createRangeProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 4,
      reason: 'clipboard',
      range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 1 },
    })

    expect(request.kind).toBe('range')
    expect(validateProjectionRequest(request)).toEqual({ ok: true, cellCount: 6 })
    expect(getProjectionWindowKey(request.sheetId, request.range)).toBe('sheet-1:0:2:0:1')
  })

  test('rejects empty, invalid, or unbounded projection requests before backend reads', () => {
    expect(
      validateProjectionRequest(
        createVisibleProjectionRequest({
          sheetId: 'sheet-1',
          requestId: 1,
          window: { rowStart: 0, rowEnd: -1, colStart: 0, colEnd: -1 },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'EMPTY_RANGE' } })

    expect(
      validateProjectionRequest(
        createVisibleProjectionRequest({
          sheetId: 'sheet-1',
          requestId: 1,
          window: { rowStart: -1, rowEnd: 3, colStart: 0, colEnd: 2 },
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_RANGE' } })

    expect(
      validateProjectionRequest(
        createRangeProjectionRequest({
          sheetId: 'sheet-1',
          requestId: 1,
          reason: 'toolbar',
          range: { rowStart: 0, rowEnd: 999, colStart: 0, colEnd: 999 },
        }),
        { maxCells: 50_000 },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'RANGE_TOO_LARGE', cellCount: 1_000_000, maxCells: 50_000 },
    })
  })

  test('rejects stale results and cells outside the requested window', () => {
    const request = createVisibleProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 5,
      window: { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 2 },
    })
    const matchingResult = {
      kind: 'visible-window' as const,
      sheetId: 'sheet-1',
      requestId: 5,
      window: { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 2 },
      cells: [{ row: 1, col: 2, displayValue: 'ok' }],
    }
    const staleResult = {
      ...matchingResult,
      requestId: 4,
    }
    const leakingResult = {
      ...matchingResult,
      cells: [{ row: 10, col: 2, displayValue: 'outside' }],
    }

    expect(isProjectionResultForRequest(request, matchingResult)).toBe(true)
    expect(validateProjectionResult(matchingResult, { request })).toEqual({
      ok: true,
      cellCount: 30,
    })
    expect(validateProjectionResult(staleResult, { request })).toMatchObject({
      ok: false,
      error: { code: 'STALE_RESULT' },
    })
    expect(validateProjectionResult(leakingResult, { request })).toMatchObject({
      ok: false,
      error: { code: 'CELL_OUT_OF_RANGE' },
    })
  })

  test('rejects dense or duplicated results larger than the requested range', () => {
    const request = createVisibleProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 6,
      window: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })

    expect(
      validateProjectionResult(
        {
          kind: 'visible-window',
          sheetId: 'sheet-1',
          requestId: 6,
          window: request.window,
          cells: [
            { row: 0, col: 0, displayValue: 'A' },
            { row: 0, col: 0, displayValue: 'A again' },
          ],
        },
        { request },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'RESULT_TOO_LARGE', cellCount: 2, maxCells: 1 },
    })
  })
})
