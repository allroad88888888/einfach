import { describe, expect, test } from '@jest/globals'
import {
  cloneCell,
  createRangeProjectionRequest,
  createVisibleProjectionRequest,
  getProjectionWindowKey,
  isProjectionResultForRequest,
  projectionRevisionsCorrelate,
  validateProjectionRequest,
  validateProjectionResult,
} from '../src'

describe('projection contract', () => {
  test('cloneCell preserves the canonical numeric projection fact', () => {
    const clone = cloneCell({
      row: 1,
      col: 2,
      displayValue: '1,234.50',
      valueKind: 'number',
      numericValue: 1_234.5,
    })

    expect(clone).toEqual({
      row: 1,
      col: 2,
      displayValue: '1,234.50',
      valueKind: 'number',
      numericValue: 1_234.5,
    })
  })

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

  test('accepts only non-zero safe request ids', () => {
    const request = createRangeProjectionRequest({
      sheetId: 'sheet-1',
      requestId: -1,
      reason: 'test',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
    })

    expect(validateProjectionRequest(request)).toEqual({ ok: true, cellCount: 1 })
    expect(validateProjectionRequest({ ...request, requestId: 0 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST_ID' },
    })
    expect(
      validateProjectionRequest({ ...request, requestId: Number.MAX_SAFE_INTEGER + 1 }),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST_ID' },
    })
  })

  test('lets an omitted request revision accept the result version', () => {
    expect(projectionRevisionsCorrelate(undefined, 'rev-current')).toBe(true)
  })

  test('requires an explicitly requested revision to match exactly', () => {
    expect(projectionRevisionsCorrelate('rev-a', 'rev-a')).toBe(true)
    expect(projectionRevisionsCorrelate('rev-a', 'rev-b')).toBe(false)
    expect(projectionRevisionsCorrelate('rev-a', undefined)).toBe(false)
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
      revision: 'rev-current',
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

  test('correlates explicit revisions together with request id and target', () => {
    const request = createRangeProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 8,
      reason: 'test',
      revision: 'rev-a',
      range: { rowStart: 2, rowEnd: 3, colStart: 4, colEnd: 5 },
    })
    const matchingResult = {
      kind: 'range' as const,
      sheetId: 'sheet-1',
      requestId: 8,
      revision: 'rev-a',
      range: { rowStart: 2, rowEnd: 3, colStart: 4, colEnd: 5 },
      cells: [],
    }

    expect(isProjectionResultForRequest(request, matchingResult)).toBe(true)
    expect(isProjectionResultForRequest(request, { ...matchingResult, revision: 'rev-b' })).toBe(
      false,
    )
    expect(
      validateProjectionResult({ ...matchingResult, revision: 'rev-b' }, { request }),
    ).toMatchObject({
      ok: false,
      error: { code: 'STALE_RESULT' },
    })
    expect(isProjectionResultForRequest(request, { ...matchingResult, requestId: 9 })).toBe(false)
    expect(
      isProjectionResultForRequest(request, {
        ...matchingResult,
        range: { ...matchingResult.range, colEnd: 6 },
      }),
    ).toBe(false)
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
