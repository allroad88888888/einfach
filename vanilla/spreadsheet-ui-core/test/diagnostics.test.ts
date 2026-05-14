import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  appendDiagnosticsAtom,
  clearDiagnosticsAtom,
  diagnosticsAtom,
  mapProjectionValidationErrorToDiagnostic,
  mapSpreadsheetErrorToDiagnostic,
  replaceDiagnosticsAtom,
} from '../src/diagnostics'

describe('diagnostics core', () => {
  test('maps backend and projection errors to displayable diagnostics', () => {
    expect(
      mapSpreadsheetErrorToDiagnostic(
        {
          code: 'INVALID_FORMULA',
          message: 'Formula parse failed.',
        },
        {
          sheetId: 'sheet-1',
          cell: { row: 2, col: 3 },
        },
      ),
    ).toEqual({
      id: 'formula-bar:INVALID_FORMULA::',
      severity: 'error',
      source: 'formula-bar',
      code: 'INVALID_FORMULA',
      message: 'Formula parse failed.',
      sheetId: 'sheet-1',
      cell: { row: 2, col: 3 },
      range: undefined,
      requestId: undefined,
      revision: undefined,
    })

    expect(
      mapProjectionValidationErrorToDiagnostic({
        code: 'RANGE_TOO_LARGE',
        message: 'Projection requests must remain bounded.',
        range: { rowStart: 0, rowEnd: 100, colStart: 0, colEnd: 100 },
        cellCount: 10_201,
        maxCells: 100,
      }),
    ).toMatchObject({
      severity: 'warning',
      source: 'projection',
      code: 'RANGE_TOO_LARGE',
      range: { rowStart: 0, rowEnd: 100, colStart: 0, colEnd: 100 },
    })
  })

  test('keeps the diagnostics list bounded', () => {
    const store = createStore()
    const items = Array.from({ length: 25 }, (_, index) => ({
      id: `d-${index}`,
      severity: 'info' as const,
      source: 'backend' as const,
      code: 'BACKEND_ERROR' as const,
      message: `message-${index}`,
    }))

    const appended = store.setter(appendDiagnosticsAtom, ...items)

    expect(appended.items).toHaveLength(20)
    expect(appended.items[0]).toMatchObject({ id: 'd-5' })
    expect(appended.items[19]).toMatchObject({ id: 'd-24' })

    const replaced = store.setter(replaceDiagnosticsAtom, ...items.slice(0, 3))
    expect(replaced.items).toHaveLength(3)

    const cleared = store.setter(clearDiagnosticsAtom)
    expect(cleared).toEqual({ items: [] })
    expect(store.getter(diagnosticsAtom)).toEqual({ items: [] })
  })
})
