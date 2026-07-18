import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  appendDiagnosticsAtom,
  clearDiagnosticsAtom,
  DEFAULT_DIAGNOSTICS_STATE,
  diagnosticsAtom,
  mapProjectionValidationErrorToDiagnostic,
  mapSpreadsheetErrorToDiagnostic,
  replaceDiagnosticsAtom,
} from '../src/diagnostics'

type AtomHasPublicWrite<Entity> = Entity extends { write: unknown } ? true : false

const DIAGNOSTICS_PUBLIC_STATE_IS_READ_ONLY: AtomHasPublicWrite<typeof diagnosticsAtom> = false

const DIAGNOSTICS_COMMANDS_ARE_WRITABLE: readonly [
  AtomHasPublicWrite<typeof appendDiagnosticsAtom>,
  AtomHasPublicWrite<typeof replaceDiagnosticsAtom>,
  AtomHasPublicWrite<typeof clearDiagnosticsAtom>,
] = [true, true, true]

describe('diagnostics core', () => {
  test('keeps public state read-only and rejects reflected writes without changing state', () => {
    const store = createStore()
    const before = store.getter(diagnosticsAtom)

    expect(DIAGNOSTICS_PUBLIC_STATE_IS_READ_ONLY).toBe(false)
    expect('write' in diagnosticsAtom).toBe(false)
    expect(() =>
      Reflect.apply(store.setter, store, [
        diagnosticsAtom,
        {
          items: [
            {
              id: 'forged',
              severity: 'error',
              source: 'backend',
              code: 'BACKEND_ERROR',
              message: 'forged state',
            },
          ],
        },
      ]),
    ).toThrow(TypeError)
    expect(store.getter(diagnosticsAtom)).toBe(before)
    expect(store.getter(diagnosticsAtom)).toEqual({ items: [] })
  })

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
    const commandAtoms = [appendDiagnosticsAtom, replaceDiagnosticsAtom, clearDiagnosticsAtom]
    const items = Array.from({ length: 25 }, (_, index) => ({
      id: `d-${index}`,
      severity: 'info' as const,
      source: 'backend' as const,
      code: 'BACKEND_ERROR' as const,
      message: `message-${index}`,
    }))

    expect(commandAtoms.map((commandAtom) => 'write' in commandAtom)).toEqual(
      DIAGNOSTICS_COMMANDS_ARE_WRITABLE,
    )
    expect(commandAtoms.map((commandAtom) => commandAtom.debugLabel)).toEqual([
      'spreadsheet.diagnostics.append',
      'spreadsheet.diagnostics.replace',
      'spreadsheet.diagnostics.clear',
    ])
    expect(commandAtoms.map((commandAtom) => store.getter(commandAtom))).toEqual([
      DEFAULT_DIAGNOSTICS_STATE,
      DEFAULT_DIAGNOSTICS_STATE,
      DEFAULT_DIAGNOSTICS_STATE,
    ])

    const appended = store.setter(appendDiagnosticsAtom, ...items)

    expect(appended.items).toHaveLength(20)
    expect(appended.items[0]).toMatchObject({ id: 'd-5' })
    expect(appended.items[19]).toMatchObject({ id: 'd-24' })
    expect(store.getter(diagnosticsAtom)).toBe(appended)

    const replaced = store.setter(replaceDiagnosticsAtom, ...items.slice(0, 3))
    expect(replaced.items).toHaveLength(3)
    expect(store.getter(diagnosticsAtom)).toBe(replaced)

    const cleared = store.setter(clearDiagnosticsAtom)
    expect(cleared).toEqual({ items: [] })
    expect(store.getter(diagnosticsAtom)).toBe(cleared)
  })
})
