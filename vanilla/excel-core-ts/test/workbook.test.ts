/**
 * Wave B/B2 workbook + sheet tests.
 *
 * Exercises the reactive layer end-to-end:
 *  - `setCell` + `formulaCellAtom` round-trip via vanilla/core's `sub`.
 *  - the "one sheetAtom dep per formula derive" invariant — proven by
 *    instrumenting the dep registration (counting how many times the
 *    derive's `getter` is invoked).
 *  - mutation flow: a downstream formula recomputes when an upstream
 *    cell mutates.
 *  - `recalc()` bumps the atom even when nothing structurally changed.
 *  - format updates are orthogonal to value/formula.
 *  - cycle detection at the workbook level (top-level derive seeds the
 *    `currentlyEvaluating` set).
 *
 * Where the real parser is needed, we use it (B1 has landed). Where we
 * want to bypass it (test isolation), we inject a mock via `parser`.
 */

import { describe, expect, test } from '@jest/globals'

import { createWorkbook } from '../src/workbook'
import { keyFor } from '../src/sheet'
import type { Expr, Value } from '../src/types'
import { BLANK } from '../src/types'

describe('createWorkbook — sheet handles + cell mutation', () => {
  test('builds one WorkbookSheet per seed; sheet() + sheetByName() resolve', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 's2', name: 'Sheet2' },
    ])
    expect(wb.sheets).toHaveLength(2)
    expect(wb.sheet('s1')?.name).toBe('Sheet1')
    expect(wb.sheet('s2')?.name).toBe('Sheet2')
    expect(wb.sheetByName('Sheet2')?.id).toBe('s2')
    expect(wb.sheet('ghost')).toBeUndefined()
  })

  test('setCell on a literal number → sheetAtom holds a Map with that cell', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '42')
    const cells = wb.store.getter(wb.sheet('s1')!.sheetAtom)
    const cell = cells.get(keyFor(0, 0))
    expect(cell?.value).toEqual({ kind: 'number', value: 42 })
    expect(cell?.input).toBe('42')
    expect(cell?.ast).toBeUndefined()
  })

  test('setCell on TRUE / FALSE literal yields boolean Values', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, 'TRUE')
    wb.setCell('s1', 0, 1, 'false')
    const cells = wb.store.getter(wb.sheet('s1')!.sheetAtom)
    expect(cells.get('0:0')?.value).toEqual({ kind: 'boolean', value: true })
    expect(cells.get('0:1')?.value).toEqual({ kind: 'boolean', value: false })
  })

  test('clearCell with target=value drops the cell when there is no format', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '10')
    wb.clearCell('s1', 0, 0, 'value')
    const cells = wb.store.getter(wb.sheet('s1')!.sheetAtom)
    expect(cells.has('0:0')).toBe(false)
  })

  test('bulkApply writes many cells under one atom transition', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    let updates = 0
    // revisionAtom is the per-sheet change signal (KEY_GRANULAR_INVALIDATION):
    // the sheet's Map identity is stable storage, bumped once per mutation batch.
    const unsubscribe = wb.store.sub(wb.sheet('s1')!.revisionAtom, () => {
      updates += 1
    })
    wb.bulkApply('s1', [
      { row: 0, col: 0, input: '1' },
      { row: 0, col: 1, input: '2' },
      { row: 1, col: 0, input: '3' },
    ])
    unsubscribe()
    expect(updates).toBe(1)
    const cells = wb.store.getter(wb.sheet('s1')!.sheetAtom)
    expect(cells.get('0:0')?.value).toEqual({ kind: 'number', value: 1 })
    expect(cells.get('0:1')?.value).toEqual({ kind: 'number', value: 2 })
    expect(cells.get('1:0')?.value).toEqual({ kind: 'number', value: 3 })
  })

  describe('clearRange — sparse bulk clear (audit D-1/C-4)', () => {
    test('walks existing cells only; huge rect clears just the intersection', () => {
      const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
      wb.bulkApply('s1', [
        { row: 0, col: 0, input: '1' },
        { row: 5, col: 0, input: '2' },
        { row: 0, col: 3, input: 'keep' },
      ])
      // Full-column rect (Excel max rows) — only the two col-0 cells exist.
      const cleared = wb.clearRange('s1', {
        rowStart: 0,
        rowEnd: 1_048_575,
        colStart: 0,
        colEnd: 0,
      })
      expect(cleared).toBe(2)
      const cells = wb.store.getter(wb.sheet('s1')!.sheetAtom)
      expect(cells.has('0:0')).toBe(false)
      expect(cells.has('5:0')).toBe(false)
      expect(cells.get('0:3')?.value).toEqual({ kind: 'string', value: 'keep' })
    })

    test('one revision bump for the whole batch; empty intersection bumps nothing', () => {
      const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
      wb.bulkApply('s1', [
        { row: 0, col: 0, input: '1' },
        { row: 1, col: 0, input: '2' },
      ])
      let updates = 0
      const unsubscribe = wb.store.sub(wb.sheet('s1')!.revisionAtom, () => {
        updates += 1
      })
      expect(wb.clearRange('s1', { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 })).toBe(2)
      expect(updates).toBe(1)
      // Nothing left in the rect — a second clear touches no cells and
      // must not signal (clearing blanks is a value no-op).
      expect(wb.clearRange('s1', { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 })).toBe(0)
      expect(updates).toBe(1)
      unsubscribe()
    })

    test("target='value' keeps format; 'all' drops cell; deps re-derive", () => {
      const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
      const sheet = wb.sheet('s1')!
      wb.setCell('s1', 0, 0, '10')
      wb.setFormat('s1', { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }, { bold: true })
      wb.setCell('s1', 1, 0, '=A1+1')
      const dependent = sheet.formulaCellAtom(keyFor(1, 0))
      expect(wb.store.getter(dependent)).toEqual({ kind: 'number', value: 11 })

      // 'value' clear: format survives, value blanks, dependent sees blank.
      expect(
        wb.clearRange('s1', { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }, 'value'),
      ).toBe(1)
      const cells = wb.store.getter(sheet.sheetAtom)
      expect(cells.get('0:0')?.format).toEqual({ bold: true })
      expect(cells.get('0:0')?.value).toEqual({ kind: 'blank' })
      expect(wb.store.getter(dependent)).toEqual({ kind: 'number', value: 1 })

      // 'all' clear over both rows: formula cell torn down (dep edges +
      // derive evicted via the shared postWrite path), entries removed.
      expect(
        wb.clearRange('s1', { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 }, 'all'),
      ).toBe(2)
      expect(cells.has('0:0')).toBe(false)
      expect(cells.has('1:0')).toBe(false)
      expect(wb.store.getter(dependent)).toEqual(BLANK)
    })

    test("target='format' drops formats only, never dirties formulas", () => {
      const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
      const sheet = wb.sheet('s1')!
      wb.setCell('s1', 0, 0, '5')
      wb.setFormat('s1', { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }, { bold: true })
      wb.setCell('s1', 1, 0, '=A1*2')
      wb.store.getter(sheet.formulaCellAtom(keyFor(1, 0)))
      const evalsBefore = wb.debugFormulaEvalCount(0)

      expect(
        wb.clearRange('s1', { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 }, 'format'),
      ).toBe(2)
      const cells = wb.store.getter(sheet.sheetAtom)
      expect(cells.get('0:0')?.format).toBeUndefined()
      expect(cells.get('0:0')?.value).toEqual({ kind: 'number', value: 5 })
      // Same AST object + valueChanged:false → no re-derive happened.
      expect(wb.debugFormulaEvalCount(0)).toBe(evalsBefore)
      expect(wb.store.getter(sheet.formulaCellAtom(keyFor(1, 0)))).toEqual({
        kind: 'number',
        value: 10,
      })
    })
  })

  test('setFormat applies a format patch to every cell in the range', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '10')
    wb.setFormat(
      's1',
      { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      { bgColor: '#fff', bold: true },
    )
    const cells = wb.store.getter(wb.sheet('s1')!.sheetAtom)
    expect(cells.get('0:0')?.format).toEqual({ bgColor: '#fff', bold: true })
    // Cells inside the range that didn't exist before are stamped with a
    // blank value + the format.
    expect(cells.get('1:1')?.format).toEqual({ bgColor: '#fff', bold: true })
    expect(cells.get('1:1')?.value).toEqual({ kind: 'blank' })
  })
})

describe('formulaCellAtom — derive + vanilla/core sub', () => {
  test('=1+2*3 → 7 via formula atom (parser-driven)', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '=1+2*3')
    const formulaAtom = wb.sheet('s1')!.formulaCellAtom('0:0')
    const value = wb.store.getter(formulaAtom)
    expect(value).toEqual({ kind: 'number', value: 7 })
  })

  test('=A1+B1 with A1=10, B1=20 → 30; mutation invalidates the derive', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '10') // A1
    wb.setCell('s1', 0, 1, '20') // B1
    wb.setCell('s1', 1, 0, '=A1+B1') // A2
    const formulaAtom = wb.sheet('s1')!.formulaCellAtom('1:0')

    const seen: Value[] = []
    const unsubscribe = wb.store.sub(formulaAtom, () => {
      seen.push(wb.store.getter(formulaAtom))
    })
    // Initial value latched at sub time.
    expect(wb.store.getter(formulaAtom)).toEqual({ kind: 'number', value: 30 })

    // Mutate A1 — derive should fire.
    wb.setCell('s1', 0, 0, '15')
    expect(wb.store.getter(formulaAtom)).toEqual({ kind: 'number', value: 35 })

    unsubscribe()
    // At least one publish happened from the A1 mutation.
    expect(seen.length).toBeGreaterThanOrEqual(1)
  })

  test('=A1*B1 with A1=#REF! short-circuits to #REF!', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '#REF!') // A1 — literal error
    wb.setCell('s1', 0, 1, '20')
    wb.setCell('s1', 1, 0, '=A1*B1')
    const result = wb.store.getter(wb.sheet('s1')!.formulaCellAtom('1:0'))
    expect(result).toEqual({ kind: 'error', code: '#REF!' })
  })

  test('cycle: A1=B1+1, B1=A1+1 → #CIRCULAR!', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '=B1+1')
    wb.setCell('s1', 0, 1, '=A1+1')
    const a1 = wb.store.getter(wb.sheet('s1')!.formulaCellAtom('0:0'))
    expect(a1).toEqual({ kind: 'error', code: '#CIRCULAR!' })
  })

  test('formulaCellAtom is cached per key — identity stable across calls', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '=1+1')
    const a = wb.sheet('s1')!.formulaCellAtom('0:0')
    const b = wb.sheet('s1')!.formulaCellAtom('0:0')
    expect(a).toBe(b)
  })

  test('formulaCellAtom for an empty cell returns BLANK', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    expect(wb.store.getter(wb.sheet('s1')!.formulaCellAtom('5:5'))).toEqual(BLANK)
  })

  test('array formula returns #SPILL! when the spill target is occupied', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 1, 'blocker')
    wb.setCell('s1', 0, 0, '=SEQUENCE(2,2)')

    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(0, 0)))).toMatchObject({
      kind: 'error',
      code: '#SPILL!',
    })
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(0, 1)))).toEqual({
      kind: 'string',
      value: 'blocker',
    })
  })

  test('array formula returns #SPILL! when the spill extent exceeds sheet bounds', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 1_048_575, 0, '=SEQUENCE(2,1)')

    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(1_048_575, 0)))).toMatchObject({
      kind: 'error',
      code: '#SPILL!',
    })
  })

  test('writing into a cached spill range revalidates the anchor as #SPILL!', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    const anchor = sheet.formulaCellAtom(keyFor(0, 0))
    wb.setCell('s1', 0, 0, '=SEQUENCE(2,2)')

    expect(wb.store.getter(anchor)).toMatchObject({ kind: 'array' })

    wb.setCell('s1', 0, 1, 'blocker')

    expect(wb.store.getter(anchor)).toMatchObject({
      kind: 'error',
      code: '#SPILL!',
    })

    wb.clearCell('s1', 0, 1, 'all')

    expect(wb.store.getter(anchor)).toEqual({
      kind: 'array',
      value: [
        [
          { kind: 'number', value: 1 },
          { kind: 'number', value: 2 },
        ],
        [
          { kind: 'number', value: 3 },
          { kind: 'number', value: 4 },
        ],
      ],
    })
  })
})

describe('recalc — F9 re-derives every cached formula', () => {
  test('recalc keeps the sheet Map identity stable but forces fresh evaluation', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '10')
    wb.setCell('s1', 0, 1, '=A1*2')
    const sheet = wb.sheet('s1')!
    const formulaAtom = sheet.formulaCellAtom('0:1')

    expect(wb.store.getter(formulaAtom)).toEqual({ kind: 'number', value: 20 })
    const evalsBefore = sheet._debug.evalCount()

    // Storage-primary (KEY_GRANULAR_INVALIDATION): the sheet's Map
    // identity is stable for the sheet's lifetime — recalc invalidates
    // by bumping every cached formula's epoch atom, not by cloning.
    const prevMap = wb.store.getter(sheet.sheetAtom)
    wb.recalc()
    const nextMap = wb.store.getter(sheet.sheetAtom)
    expect(nextMap).toBe(prevMap) // stable identity — storage, not signal
    // The cached derive really re-ran (fresh evaluation for volatiles).
    expect(sheet._debug.evalCount()).toBe(evalsBefore + 1)
    expect(wb.store.getter(formulaAtom)).toEqual({ kind: 'number', value: 20 })
  })

  test('recalc bumps each sheet revisionAtom (the F9 change signal)', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '10')
    let fires = 0
    const unsubscribe = wb.store.sub(wb.sheet('s1')!.revisionAtom, () => {
      fires += 1
    })
    wb.recalc()
    unsubscribe()
    expect(fires).toBe(1)
  })
})

describe('key-granular invalidation — only true dependents re-derive', () => {
  test('mutating a sibling formula does not re-derive a non-dependent formula', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '5')
    wb.setCell('s1', 0, 1, '=A1+1')
    wb.setCell('s1', 0, 2, '=A1+2')

    expect(wb.store.getter(sheet.formulaCellAtom('0:1'))).toEqual({
      kind: 'number',
      value: 6,
    })
    expect(wb.store.getter(sheet.formulaCellAtom('0:2'))).toEqual({
      kind: 'number',
      value: 7,
    })
    const evalsBefore = sheet._debug.evalCount()

    // Rewrite B1. C1 depends only on A1 — with the per-formula epoch
    // deps + workbook DepGraph (audit C-2 fix) the write re-derives B1
    // (its own cell changed) and NOTHING else.
    wb.setCell('s1', 0, 1, '=A1+99')
    expect(sheet._debug.evalCount()).toBe(evalsBefore + 1)
    expect(wb.store.getter(sheet.formulaCellAtom('0:2'))).toEqual({
      kind: 'number',
      value: 7,
    })

    // Mutating the shared dep A1 re-derives BOTH dependents, eagerly.
    wb.setCell('s1', 0, 0, '6')
    expect(sheet._debug.evalCount()).toBe(evalsBefore + 3)
    expect(wb.store.getter(sheet.formulaCellAtom('0:1'))).toEqual({
      kind: 'number',
      value: 105,
    })
    expect(wb.store.getter(sheet.formulaCellAtom('0:2'))).toEqual({
      kind: 'number',
      value: 8,
    })
  })
})

describe('parser injection — tests can bypass B1', () => {
  test('createWorkbook(.., { parser }) routes formula input through the injected parser', () => {
    const calls: string[] = []
    const injected = (input: string): Expr => {
      calls.push(input)
      // Always return a literal number AST so we can assert it was used.
      return { kind: 'number', value: 999 }
    }
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }], { parser: injected })
    wb.setCell('s1', 0, 0, '=THIS_DOES_NOT_MATTER')
    expect(calls).toEqual(['=THIS_DOES_NOT_MATTER'])
    expect(
      wb.store.getter(wb.sheet('s1')!.formulaCellAtom('0:0')),
    ).toEqual({ kind: 'number', value: 999 })
  })
})

describe('cross-sheet refs — workbook resolver wires through to evaluator', () => {
  test('=Sheet2!A1 reads from another sheet; mutation propagates', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 's2', name: 'Sheet2' },
    ])
    wb.setCell('s2', 0, 0, '100') // Sheet2!A1
    wb.setCell('s1', 0, 0, '=Sheet2!A1')
    const formulaAtom = wb.sheet('s1')!.formulaCellAtom('0:0')
    expect(wb.store.getter(formulaAtom)).toEqual({ kind: 'number', value: 100 })

    // Mutate Sheet2!A1 — Sheet1 formula must observe the change.
    wb.setCell('s2', 0, 0, '250')
    expect(wb.store.getter(formulaAtom)).toEqual({ kind: 'number', value: 250 })
  })

  test('=GhostSheet!A1 → #REF!', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '=GhostSheet!A1')
    expect(
      wb.store.getter(wb.sheet('s1')!.formulaCellAtom('0:0')),
    ).toEqual({ kind: 'error', code: '#REF!' })
  })
})

describe('custom formulas — registered host callbacks', () => {
  test('registerCustomFormula makes MYFN dispatchable in formulas', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.registerCustomFormula('MYDOUBLE', (args) => {
      const a = args[0]
      if (a?.kind === 'number') return { kind: 'number', value: a.value * 2 }
      return { kind: 'error', code: '#VALUE!' }
    })
    wb.setCell('s1', 0, 0, '=MYDOUBLE(21)')
    expect(
      wb.store.getter(wb.sheet('s1')!.formulaCellAtom('0:0')),
    ).toEqual({ kind: 'number', value: 42 })
  })

  test('unknown function falls through to #NAME?', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '=GHOSTFN()')
    const result = wb.store.getter(wb.sheet('s1')!.formulaCellAtom('0:0'))
    expect(result.kind).toBe('error')
    expect((result as { code: string }).code).toBe('#NAME?')
  })

  test('registering and unregistering a custom formula invalidates cached formulas', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '=MYDOUBLE(21)')
    const formulaAtom = wb.sheet('s1')!.formulaCellAtom('0:0')
    expect(wb.store.getter(formulaAtom)).toMatchObject({ kind: 'error', code: '#NAME?' })

    wb.registerCustomFormula('MYDOUBLE', (args) => {
      const a = args[0]
      return a?.kind === 'number'
        ? { kind: 'number', value: a.value * 2 }
        : { kind: 'error', code: '#VALUE!' }
    })
    expect(wb.store.getter(formulaAtom)).toEqual({ kind: 'number', value: 42 })

    expect(wb.unregisterCustomFormula('MYDOUBLE')).toBe(true)
    expect(wb.store.getter(formulaAtom)).toMatchObject({ kind: 'error', code: '#NAME?' })
  })
})

describe('defineName — workbook defined names', () => {
  test('a value binding resolves through NameExpr', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('PI', { kind: 'value', value: { kind: 'number', value: 3.14 } })
    wb.setCell('s1', 0, 0, '=PI*2')
    expect(
      wb.store.getter(wb.sheet('s1')!.formulaCellAtom('0:0')),
    ).toEqual({ kind: 'number', value: 6.28 })
  })

  test('defining and undefining a name invalidates cached formulas', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '=PI*2')
    const formulaAtom = wb.sheet('s1')!.formulaCellAtom('0:0')
    expect(wb.store.getter(formulaAtom)).toMatchObject({ kind: 'error', code: '#NAME?' })

    wb.defineName('PI', { kind: 'value', value: { kind: 'number', value: 3.14 } })
    expect(wb.store.getter(formulaAtom)).toEqual({ kind: 'number', value: 6.28 })

    expect(wb.undefineName('PI')).toBe(true)
    expect(wb.store.getter(formulaAtom)).toMatchObject({ kind: 'error', code: '#NAME?' })
  })

  test('a cross-sheet range binding resolves values and reference metadata', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 'data', name: 'Data' },
    ])
    wb.setCell('data', 0, 0, '1')
    wb.setCell('data', 1, 0, '2')
    wb.setCell('data', 2, 0, '=A2+1')
    wb.defineName('DATA_COL', {
      kind: 'range',
      sheetName: 'Data',
      start: 'A1',
      end: 'A3',
    })
    wb.setCell('s1', 0, 0, '=SUM(DATA_COL)')
    wb.setCell('s1', 1, 0, '=ROWS(DATA_COL)')
    wb.setCell('s1', 2, 0, '=CELL("address",DATA_COL)')
    wb.setCell('s1', 3, 0, '=FORMULATEXT(INDEX(DATA_COL,3,1))')

    expect(wb.store.getter(wb.sheet('s1')!.formulaCellAtom('0:0'))).toEqual({
      kind: 'number',
      value: 6,
    })
    expect(wb.store.getter(wb.sheet('s1')!.formulaCellAtom('1:0'))).toEqual({
      kind: 'number',
      value: 3,
    })
    expect(wb.store.getter(wb.sheet('s1')!.formulaCellAtom('2:0'))).toEqual({
      kind: 'string',
      value: 'Data!$A$1',
    })
    expect(wb.store.getter(wb.sheet('s1')!.formulaCellAtom('3:0'))).toEqual({
      kind: 'string',
      value: '=A2+1',
    })

    wb.setCell('data', 1, 0, '20')
    expect(wb.store.getter(wb.sheet('s1')!.formulaCellAtom('0:0'))).toEqual({
      kind: 'number',
      value: 42,
    })
  })
})

describe('createWorkbook — withBatch deferral', () => {
  test('collapses N name registrations into ONE downstream recalc', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    // Seed at least one prior write so the atom has a value to observe.
    wb.setCell('s1', 0, 0, '1')

    let fires = 0
    const unsubscribe = wb.store.sub(sheet.revisionAtom, () => {
      fires += 1
    })

    wb.withBatch(() => {
      wb.defineName('FOO1', { kind: 'value', value: { kind: 'number', value: 1 } })
      wb.defineName('FOO2', { kind: 'value', value: { kind: 'number', value: 2 } })
      wb.defineName('FOO3', { kind: 'value', value: { kind: 'number', value: 3 } })
      wb.defineName('FOO4', { kind: 'value', value: { kind: 'number', value: 4 } })
      wb.defineName('FOO5', { kind: 'value', value: { kind: 'number', value: 5 } })
    })

    unsubscribe()
    // Five defines normally trigger five recalcs (one per sheet × 5
    // = 5 sub fires here). With batching, the outermost exit fires
    // exactly one recalc → one sub fire.
    expect(fires).toBe(1)
  })

  test('nested withBatch only recalcs once on outermost exit', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '1')

    let fires = 0
    const unsubscribe = wb.store.sub(sheet.revisionAtom, () => {
      fires += 1
    })

    wb.withBatch(() => {
      wb.defineName('OUTER', { kind: 'value', value: { kind: 'number', value: 1 } })
      wb.withBatch(() => {
        wb.defineName('INNER', { kind: 'value', value: { kind: 'number', value: 2 } })
      })
      // Inner exit must NOT have fired — only outer does.
      expect(fires).toBe(0)
    })

    unsubscribe()
    expect(fires).toBe(1)
  })

  test('throw inside withBatch propagates and suppresses pending recalc', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '1')

    let fires = 0
    const unsubscribe = wb.store.sub(sheet.revisionAtom, () => {
      fires += 1
    })

    expect(() => {
      wb.withBatch(() => {
        wb.defineName('ABORT', { kind: 'value', value: { kind: 'number', value: 99 } })
        throw new Error('test-abort')
      })
    }).toThrow('test-abort')

    unsubscribe()
    expect(fires).toBe(0)

    // After abort, batch state must be fully unwound — a subsequent
    // direct (non-batched) defineName must still fire its immediate
    // recalc through the normal path.
    let postFires = 0
    const unsubscribe2 = wb.store.sub(sheet.revisionAtom, () => {
      postFires += 1
    })
    wb.defineName('AFTER', { kind: 'value', value: { kind: 'number', value: 7 } })
    unsubscribe2()
    expect(postFires).toBe(1)
  })

  test('no-batch path: direct defineName still triggers immediate recalc', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '1')

    let fires = 0
    const unsubscribe = wb.store.sub(sheet.revisionAtom, () => {
      fires += 1
    })

    wb.defineName('DIRECT', { kind: 'value', value: { kind: 'number', value: 1 } })
    wb.defineName('DIRECT2', { kind: 'value', value: { kind: 'number', value: 2 } })

    unsubscribe()
    // Two direct calls outside any batch → two recalcs → two sub fires.
    expect(fires).toBe(2)
  })

  test('withBatch returns fn result', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const result = wb.withBatch(() => {
      wb.defineName('X', { kind: 'value', value: { kind: 'number', value: 1 } })
      return 'returned-value'
    })
    expect(result).toBe('returned-value')
  })

  // --- audit C-5: throw rolls back batch-participating registries ---

  test('throw rolls back defineName: registry and cached derive stay consistent', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '=MYNAME')
    const a = sheet.formulaCellAtom(keyFor(0, 0))
    expect(wb.store.getter(a)).toEqual({ kind: 'error', code: '#NAME?' })

    expect(() =>
      wb.withBatch(() => {
        wb.defineName('MYNAME', { kind: 'value', value: { kind: 'number', value: 99 } })
        throw new Error('host abort')
      }),
    ).toThrow('host abort')

    // The abort is real: MYNAME is gone from the registry, so the
    // derive stays #NAME? — and an unrelated write must NOT flip it to
    // 99 (the pre-fix C-5 symptom: registry/cache disagreement healed
    // only by accidental invalidation).
    expect(wb.store.getter(a)).toEqual({ kind: 'error', code: '#NAME?' })
    wb.setCell('s1', 9, 9, '1')
    expect(wb.store.getter(a)).toEqual({ kind: 'error', code: '#NAME?' })
  })

  test('throw rolls back undefineName: pre-batch name survives the abort', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.defineName('KEEP', { kind: 'value', value: { kind: 'number', value: 7 } })
    wb.setCell('s1', 0, 0, '=KEEP')
    const a = sheet.formulaCellAtom(keyFor(0, 0))
    expect(wb.store.getter(a)).toEqual({ kind: 'number', value: 7 })

    expect(() =>
      wb.withBatch(() => {
        wb.undefineName('KEEP')
        throw new Error('host abort')
      }),
    ).toThrow('host abort')

    // Rollback restored the deleted entry; later mutations keep serving 7.
    wb.setCell('s1', 9, 9, '1')
    expect(wb.store.getter(a)).toEqual({ kind: 'number', value: 7 })
  })

  test('throw rolls back registerCustomFormula', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '=MYFN(1)')
    const a = sheet.formulaCellAtom(keyFor(0, 0))
    expect(wb.store.getter(a)).toMatchObject({ kind: 'error', code: '#NAME?' })

    expect(() =>
      wb.withBatch(() => {
        wb.registerCustomFormula('MYFN', () => ({ kind: 'number', value: 42 }))
        throw new Error('host abort')
      }),
    ).toThrow('host abort')

    // Callback rolled back: still #NAME?, even after an unrelated write.
    wb.setCell('s1', 9, 9, '1')
    expect(wb.store.getter(a)).toMatchObject({ kind: 'error', code: '#NAME?' })
  })

  test('throw rolls back setLocale', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    expect(wb.getLocale()).toBe('en-US')

    expect(() =>
      wb.withBatch(() => {
        wb.setLocale('de-DE')
        expect(wb.getLocale()).toBe('de-DE') // live inside the batch
        throw new Error('host abort')
      }),
    ).toThrow('host abort')

    expect(wb.getLocale()).toBe('en-US')
  })

  // eslint-disable-next-line max-len
  test('nested batch: inner throw propagating through the outer frame aborts the whole batch', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '=OUTERN')
    wb.setCell('s1', 0, 1, '=INNERN')
    const aOuter = sheet.formulaCellAtom(keyFor(0, 0))
    const aInner = sheet.formulaCellAtom(keyFor(0, 1))

    let fires = 0
    const unsubscribe = wb.store.sub(sheet.revisionAtom, () => {
      fires += 1
    })

    expect(() =>
      wb.withBatch(() => {
        wb.defineName('OUTERN', { kind: 'value', value: { kind: 'number', value: 1 } })
        wb.withBatch(() => {
          wb.defineName('INNERN', { kind: 'value', value: { kind: 'number', value: 2 } })
          throw new Error('inner abort')
        })
      }),
    ).toThrow('inner abort')

    unsubscribe()
    expect(fires).toBe(0)

    // BOTH defines rolled back — the snapshot is taken at outermost
    // entry, so the outer frame's mutation aborts along with the inner.
    wb.setCell('s1', 9, 9, '1')
    expect(wb.store.getter(aOuter)).toEqual({ kind: 'error', code: '#NAME?' })
    expect(wb.store.getter(aInner)).toEqual({ kind: 'error', code: '#NAME?' })
  })

  test('success path unchanged: batch mutations persist and resolve after exit', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '=GOODN')
    wb.setCell('s1', 0, 1, '=GOODFN(2)')
    const aName = sheet.formulaCellAtom(keyFor(0, 0))
    const aFn = sheet.formulaCellAtom(keyFor(0, 1))

    wb.withBatch(() => {
      wb.defineName('GOODN', { kind: 'value', value: { kind: 'number', value: 5 } })
      wb.registerCustomFormula('GOODFN', (args) => {
        const n = args[0]?.kind === 'number' ? args[0].value : 0
        return { kind: 'number', value: n * 10 }
      })
      wb.setLocale('fr-FR')
    })

    expect(wb.store.getter(aName)).toEqual({ kind: 'number', value: 5 })
    expect(wb.store.getter(aFn)).toEqual({ kind: 'number', value: 20 })
    expect(wb.getLocale()).toBe('fr-FR')
  })

  test('rollback restores a throwing batch to a clean slate for subsequent batches', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '=RETRYN')
    const a = sheet.formulaCellAtom(keyFor(0, 0))

    expect(() =>
      wb.withBatch(() => {
        wb.defineName('RETRYN', { kind: 'value', value: { kind: 'number', value: 1 } })
        throw new Error('first try fails')
      }),
    ).toThrow('first try fails')

    // A later SUCCESSFUL batch works normally — no stale snapshot leaks.
    wb.withBatch(() => {
      wb.defineName('RETRYN', { kind: 'value', value: { kind: 'number', value: 2 } })
    })
    expect(wb.store.getter(a)).toEqual({ kind: 'number', value: 2 })
  })
})

describe('wave 8.2 — async custom formulas (engine-level)', () => {
  const num = (value: number): { kind: 'number'; value: number } => ({ kind: 'number', value })
  const neverCalled = (): never => {
    throw new Error('async custom formula fn must not be invoked by the engine')
  }

  function makeAsyncWb() {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.registerCustomFormula('SLOW', neverCalled, { isAsync: true })
    const read = (key: string) => wb.store.getter(wb.sheet('s1')!.formulaCellAtom(key))
    return { wb, read }
  }

  test('pending cell and its dependent show #BUSY!; settle re-derives both', () => {
    const { wb, read } = makeAsyncWb()
    wb.setCell('s1', 0, 0, '=SLOW(1)')
    wb.setCell('s1', 1, 0, '=A1+1')
    expect(read('0:0')).toMatchObject({ kind: 'error', code: '#BUSY!' })
    expect(read('1:0')).toMatchObject({ kind: 'error', code: '#BUSY!' })

    const calls = wb.drainPendingAsyncCustomCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('SLOW')
    expect(calls[0].args).toEqual([num(1)])

    const outcome = wb.resolveAsyncCustomCall(calls[0].callId, num(10))
    expect(outcome.resolved).toBe(true)
    expect(outcome.touched).toEqual([{ sheetId: 's1', key: '0:0' }])
    expect(read('0:0')).toEqual(num(10))
    expect(read('1:0')).toEqual(num(11))
    // Memoized: nothing re-enqueues on re-read.
    expect(wb.drainPendingAsyncCustomCalls()).toEqual([])
  })

  test('same (name, args) across cells dedupes to one pending call, settle updates all', () => {
    const { wb, read } = makeAsyncWb()
    wb.setCell('s1', 0, 0, '=SLOW(2)')
    wb.setCell('s1', 0, 1, '=SLOW(2)')
    expect(read('0:0')).toMatchObject({ code: '#BUSY!' })
    expect(read('0:1')).toMatchObject({ code: '#BUSY!' })

    const calls = wb.drainPendingAsyncCustomCalls()
    expect(calls).toHaveLength(1)
    expect(wb.resolveAsyncCustomCall(calls[0].callId, num(5)).resolved).toBe(true)
    expect(read('0:0')).toEqual(num(5))
    expect(read('0:1')).toEqual(num(5))
  })

  test('registry change strands the in-flight settle and re-arms on re-read', () => {
    const { wb, read } = makeAsyncWb()
    wb.setCell('s1', 0, 0, '=SLOW(3)')
    expect(read('0:0')).toMatchObject({ code: '#BUSY!' })
    const stale = wb.drainPendingAsyncCustomCalls()
    expect(stale).toHaveLength(1)

    // Any registry change invalidates the memo wholesale.
    wb.registerCustomFormula('OTHER', () => num(0))

    expect(wb.resolveAsyncCustomCall(stale[0].callId, num(99)).resolved).toBe(false)
    expect(read('0:0')).toMatchObject({ code: '#BUSY!' })

    const fresh = wb.drainPendingAsyncCustomCalls()
    expect(fresh).toHaveLength(1)
    expect(fresh[0].callId).not.toBe(stale[0].callId)
    expect(wb.resolveAsyncCustomCall(fresh[0].callId, num(6)).resolved).toBe(true)
    expect(read('0:0')).toEqual(num(6))
  })

  test('error args short-circuit without enqueueing', () => {
    const { wb, read } = makeAsyncWb()
    wb.setCell('s1', 0, 0, '=SLOW(1/0)')
    expect(read('0:0')).toMatchObject({ kind: 'error', code: '#DIV/0!' })
    expect(wb.drainPendingAsyncCustomCalls()).toEqual([])
  })

  test('unregistering the async name surfaces #NAME? and drops the stale settle', () => {
    const { wb, read } = makeAsyncWb()
    wb.setCell('s1', 0, 0, '=SLOW(4)')
    expect(read('0:0')).toMatchObject({ code: '#BUSY!' })
    const calls = wb.drainPendingAsyncCustomCalls()

    expect(wb.unregisterCustomFormula('SLOW')).toBe(true)
    expect(read('0:0')).toMatchObject({ kind: 'error', code: '#NAME?' })
    expect(wb.resolveAsyncCustomCall(calls[0].callId, num(1)).resolved).toBe(false)
  })

  test('withBatch rollback invalidates the async memo like a registry change', () => {
    const { wb, read } = makeAsyncWb()
    wb.setCell('s1', 0, 0, '=SLOW(7)')
    expect(read('0:0')).toMatchObject({ code: '#BUSY!' })
    const calls = wb.drainPendingAsyncCustomCalls()

    expect(() =>
      wb.withBatch(() => {
        wb.registerCustomFormula('DOOMED', () => num(0))
        throw new Error('abort')
      }),
    ).toThrow('abort')

    expect(wb.resolveAsyncCustomCall(calls[0].callId, num(1)).resolved).toBe(false)
  })
})
