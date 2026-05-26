/**
 * Wave C merge sanity — verifies the 6 category files compose into a
 * single registry without name collisions and that the v1 target of
 * ~40 functions (PLAN.md §6.1) is met.
 *
 * Also exercises the full evaluator→dispatch→function pipeline end to
 * end with a couple of formulas spanning multiple Wave C tracks, so any
 * future contract drift between B2 evaluator and Wave C function
 * shapes is caught here rather than in Wave D worker integration.
 */
import { describe, expect, test } from '@jest/globals'

import {
  BLANK,
  BUILTIN_FUNCTIONS,
  createWorkbook,
  evaluate,
  getBuiltinFunction,
  listBuiltinNames,
  parseFormula,
  type EvalContext,
  type Value,
} from '../src'

describe('@einfach/excel-core-ts — Wave C registry merge', () => {
  test('exposes a non-empty frozen registry', () => {
    expect(BUILTIN_FUNCTIONS.size).toBeGreaterThanOrEqual(40)
    expect(Object.isFrozen(BUILTIN_FUNCTIONS)).toBe(true)
  })

  test('contains the v1 target functions from PLAN.md §6.1', () => {
    const targets = [
      // Math
      'SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'MIN', 'MAX',
      'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'INT', 'MOD', 'ABS',
      'POWER', 'SQRT', 'SIGN',
      // Logical
      'IF', 'IFERROR', 'IFNA', 'AND', 'OR', 'NOT', 'IFS', 'SWITCH',
      'TRUE', 'FALSE',
      // Lookup
      'VLOOKUP', 'HLOOKUP', 'INDEX', 'MATCH', 'XLOOKUP',
      // Text
      'CONCATENATE', 'CONCAT', 'LEFT', 'RIGHT', 'MID', 'LEN',
      'LOWER', 'UPPER', 'TRIM', 'TEXT', 'VALUE',
      // Date
      'TODAY', 'NOW', 'DATE', 'YEAR', 'MONTH', 'DAY', 'WEEKDAY',
      // Stats
      'COUNTIF', 'SUMIF', 'COUNTIFS', 'SUMIFS',
    ] as const
    const missing = targets.filter((name) => !BUILTIN_FUNCTIONS.has(name))
    expect(missing).toEqual([])
  })

  test('getBuiltinFunction is case-insensitive', () => {
    expect(getBuiltinFunction('sum')).toBe(getBuiltinFunction('SUM'))
    expect(getBuiltinFunction('Sum')).toBeDefined()
    expect(getBuiltinFunction('not-a-function')).toBeUndefined()
  })

  test('listBuiltinNames returns sorted unique uppercase names', () => {
    const names = listBuiltinNames()
    const expectedSorted = [...names].sort()
    expect(names).toEqual(expectedSorted)
    const set = new Set(names)
    expect(set.size).toBe(names.length)
    for (const name of names) {
      expect(name).toBe(name.toUpperCase())
    }
  })
})

describe('@einfach/excel-core-ts — evaluator dispatches Wave C registry', () => {
  function makeCtx(): EvalContext {
    return {
      cells: new Map(),
      refLookup: () => BLANK,
      rangeLookup: () => [[BLANK]],
      crossSheetCells: () => undefined,
      callCustom: () => undefined,
      currentlyEvaluating: new Set(),
      resolveName: () => undefined,
    }
  }

  test('=SUM(1, 2, 3) → 6', () => {
    const ast = parseFormula('=SUM(1, 2, 3)')
    const result = evaluate(ast, makeCtx())
    expect(result).toEqual<Value>({ kind: 'number', value: 6 })
  })

  test('=IF(TRUE, "yes", "no") → "yes"', () => {
    const ast = parseFormula('=IF(TRUE, "yes", "no")')
    const result = evaluate(ast, makeCtx())
    expect(result).toEqual<Value>({ kind: 'string', value: 'yes' })
  })

  test('=UPPER(LEFT("hello", 3)) → "HEL"', () => {
    const ast = parseFormula('=UPPER(LEFT("hello", 3))')
    const result = evaluate(ast, makeCtx())
    expect(result).toEqual<Value>({ kind: 'string', value: 'HEL' })
  })

  test('=DATE(2024, 1, 1) → 45292 (Excel pin)', () => {
    const ast = parseFormula('=DATE(2024, 1, 1)')
    const result = evaluate(ast, makeCtx())
    expect(result).toEqual<Value>({ kind: 'number', value: 45292 })
  })

  test('unknown function name surfaces as #NAME?', () => {
    const ast = parseFormula('=NOT_A_FUNCTION(1, 2)')
    const result = evaluate(ast, makeCtx())
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.code).toBe('#NAME?')
    }
  })

  test('built-in shadowed: custom registry returning a value is still bypassed', () => {
    const ctx: EvalContext = {
      ...makeCtx(),
      callCustom: () => ({ kind: 'string', value: 'CUSTOM_WINS' }),
    }
    const ast = parseFormula('=SUM(1, 2)')
    const result = evaluate(ast, ctx)
    // Built-in SUM wins over the custom registry — registry only consulted
    // when name isn't a built-in.
    expect(result).toEqual<Value>({ kind: 'number', value: 3 })
  })
})

describe('@einfach/excel-core-ts — workbook + evaluator + registry integration', () => {
  test('formulaCellAtom round-trips a function call through sheetAtom', () => {
    const workbook = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    workbook.setCell('s1', 0, 0, '10')
    workbook.setCell('s1', 1, 0, '20')
    workbook.setCell('s1', 2, 0, '30')
    workbook.setCell('s1', 3, 0, '=SUM(A1:A3)')

    const sheet = workbook.sheet('s1')!
    const atom = sheet.formulaCellAtom('3:0')
    const result = workbook.store.getter(atom)
    expect(result).toEqual<Value>({ kind: 'number', value: 60 })
  })

  test('mutation invalidates downstream function-call formula', () => {
    const workbook = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    workbook.setCell('s1', 0, 0, '5')
    workbook.setCell('s1', 1, 0, '=POWER(A1, 2)')
    const atom = workbook.sheet('s1')!.formulaCellAtom('1:0')
    expect(workbook.store.getter(atom)).toEqual<Value>({ kind: 'number', value: 25 })

    workbook.setCell('s1', 0, 0, '10')
    expect(workbook.store.getter(atom)).toEqual<Value>({ kind: 'number', value: 100 })
  })
})
