import { describe, expect, test } from '@jest/globals'

import { BUILTIN_FUNCTIONS, evaluate, getBuiltinFunction, parseFormula } from '../src'
import { FUNCTIONS } from '../src/eval/functions/database'
import type { ErrorCode, EvalContext, FunctionImpl, Value } from '../src/types'

const NUM = (value: number): Value => ({ kind: 'number', value })
const STR = (value: string): Value => ({ kind: 'string', value })
const ERR = (code: ErrorCode): Value => ({ kind: 'error', code })
const ARR = (rows: Value[][]): Value => ({ kind: 'array', value: rows })
const BLANK: Value = { kind: 'blank' }

const DATABASE_ROWS: Value[][] = [
  [STR('Name'), STR('Age'), STR('Dept'), STR('Salary')],
  [STR('Alice'), NUM(30), STR('Eng'), NUM(80000)],
  [STR('Bob'), NUM(25), STR('Sales'), NUM(60000)],
  [STR('Carol'), NUM(35), STR('Eng'), NUM(95000)],
  [STR('Dave'), NUM(28), STR('Sales'), NUM(70000)],
]

const CRITERIA_ENG_AGE_ROWS: Value[][] = [
  [STR('Dept'), STR('Age')],
  [STR('Eng'), STR('>28')],
]

const CRITERIA_MARKETING_ROWS: Value[][] = [
  [STR('Dept'), STR('Age')],
  [STR('Marketing'), BLANK],
]

const DATABASE = ARR(DATABASE_ROWS)
const CRITERIA_ENG_AGE = ARR(CRITERIA_ENG_AGE_ROWS)
const CRITERIA_MARKETING = ARR(CRITERIA_MARKETING_ROWS)

const DATABASE_NAMES = [
  'DSUM',
  'DCOUNT',
  'DCOUNTA',
  'DMAX',
  'DMIN',
  'DPRODUCT',
  'DAVERAGE',
  'DGET',
  'DSTDEV',
  'DSTDEVP',
  'DVAR',
  'DVARP',
] as const

type DatabaseFunctionName = (typeof DATABASE_NAMES)[number]

const ctx: EvalContext = new Proxy(
  {},
  {
    get(_, prop) {
      throw new Error(`database functions unexpectedly read ctx.${String(prop)}`)
    },
  },
) as unknown as EvalContext

function get(name: DatabaseFunctionName): FunctionImpl {
  const fn = FUNCTIONS[name]
  if (!fn) throw new Error(`No database function registered for ${name}`)
  return fn
}

function call(name: DatabaseFunctionName, args: Value[]): Value {
  return get(name)(args, ctx)
}

function asNumber(value: Value): number {
  if (value.kind !== 'number') throw new Error(`expected number, got ${JSON.stringify(value)}`)
  return value.value
}

function makeEvalCtx(): EvalContext {
  return {
    cells: new Map(),
    currentlyEvaluating: new Set(),
    refLookup: () => BLANK,
    rangeLookup: (start, end) => {
      const key = `${start}:${end}`
      if (key === 'A1:D5') return DATABASE_ROWS
      if (key === 'F1:G2') return CRITERIA_ENG_AGE_ROWS
      return [[BLANK]]
    },
    crossSheetCells: () => undefined,
    callCustom: () => undefined,
    resolveName: () => undefined,
  }
}

describe('database function registry', () => {
  test('merges all D-functions into the built-in registry', () => {
    for (const name of DATABASE_NAMES) {
      expect(BUILTIN_FUNCTIONS.has(name)).toBe(true)
      expect(getBuiltinFunction(name.toLowerCase())).toBe(get(name))
    }
  })

  test('evaluator dispatches pre-evaluated range arrays to DSUM', () => {
    const result = evaluate(parseFormula('=DSUM(A1:D5,"Salary",F1:G2)'), makeEvalCtx())
    expect(result).toEqual(NUM(175000))
  })
})

describe('database field and criteria semantics', () => {
  test('resolves field by case-insensitive header name and 1-based column index', () => {
    expect(call('DSUM', [DATABASE, STR('salary'), CRITERIA_ENG_AGE])).toEqual(NUM(175000))
    expect(call('DSUM', [DATABASE, NUM(4), CRITERIA_ENG_AGE])).toEqual(NUM(175000))
  })

  test('ANDs criteria cells in one row', () => {
    expect(call('DSUM', [DATABASE, STR('Salary'), CRITERIA_ENG_AGE])).toEqual(NUM(175000))
  })

  test('ORs multiple criteria rows', () => {
    const criteria = ARR([
      [STR('Dept'), STR('Age')],
      [STR('Eng'), STR('>28')],
      [STR('Sales'), STR('>26')],
    ])
    expect(call('DSUM', [DATABASE, STR('Salary'), criteria])).toEqual(NUM(245000))
  })

  test('supports comparison operators with repeated criteria headers', () => {
    const criteria = ARR([
      [STR('Age'), STR('Age')],
      [STR('>=28'), STR('<35')],
    ])
    expect(call('DCOUNT', [DATABASE, STR('Age'), criteria])).toEqual(NUM(2))
  })

  test('bare text criteria matches prefix while explicit equals stays exact', () => {
    const prefix = ARR([[STR('Name')], [STR('Al')]])
    const exact = ARR([[STR('Name')], [STR('=Al')]])
    expect(call('DCOUNTA', [DATABASE, STR('Name'), prefix])).toEqual(NUM(1))
    expect(call('DCOUNTA', [DATABASE, STR('Name'), exact])).toEqual(NUM(0))
  })

  test('empty result returns zero for zero-default aggregates and #DIV/0! for averages', () => {
    expect(call('DSUM', [DATABASE, STR('Salary'), CRITERIA_MARKETING])).toEqual(NUM(0))
    expect(call('DCOUNT', [DATABASE, STR('Salary'), CRITERIA_MARKETING])).toEqual(NUM(0))
    expect(call('DCOUNTA', [DATABASE, STR('Name'), CRITERIA_MARKETING])).toEqual(NUM(0))
    expect(call('DAVERAGE', [DATABASE, STR('Salary'), CRITERIA_MARKETING])).toEqual(
      ERR('#DIV/0!'),
    )
  })
})

describe('database aggregate functions', () => {
  test('numeric and count aggregates match Rust parity fixture', () => {
    expect(call('DCOUNT', [DATABASE, STR('Salary'), CRITERIA_ENG_AGE])).toEqual(NUM(2))
    expect(call('DCOUNT', [DATABASE, STR('Name'), CRITERIA_ENG_AGE])).toEqual(NUM(0))
    expect(call('DCOUNTA', [DATABASE, STR('Name'), CRITERIA_ENG_AGE])).toEqual(NUM(2))
    expect(call('DMAX', [DATABASE, STR('Salary'), CRITERIA_ENG_AGE])).toEqual(NUM(95000))
    expect(call('DMIN', [DATABASE, STR('Salary'), CRITERIA_ENG_AGE])).toEqual(NUM(80000))
    expect(call('DPRODUCT', [DATABASE, STR('Salary'), CRITERIA_ENG_AGE])).toEqual(
      NUM(7600000000),
    )
    expect(call('DAVERAGE', [DATABASE, STR('Salary'), CRITERIA_ENG_AGE])).toEqual(NUM(87500))
  })

  test('variance and standard-deviation functions match sample and population rules', () => {
    expect(asNumber(call('DSTDEV', [DATABASE, STR('Salary'), CRITERIA_ENG_AGE]))).toBeCloseTo(
      Math.sqrt(112500000),
      8,
    )
    expect(call('DSTDEVP', [DATABASE, STR('Salary'), CRITERIA_ENG_AGE])).toEqual(NUM(7500))
    expect(call('DVAR', [DATABASE, STR('Salary'), CRITERIA_ENG_AGE])).toEqual(NUM(112500000))
    expect(call('DVARP', [DATABASE, STR('Salary'), CRITERIA_ENG_AGE])).toEqual(NUM(56250000))
  })
})

describe('DGET', () => {
  test('returns the unique matched field value', () => {
    const criteria = ARR([
      [STR('Dept'), STR('Age')],
      [STR('Sales'), STR('>26')],
    ])
    expect(call('DGET', [DATABASE, STR('Salary'), criteria])).toEqual(NUM(70000))
  })

  test('returns #NUM! for multiple matches and #VALUE! for no matches', () => {
    expect(call('DGET', [DATABASE, STR('Salary'), CRITERIA_ENG_AGE])).toEqual(ERR('#NUM!'))
    expect(call('DGET', [DATABASE, STR('Salary'), CRITERIA_MARKETING])).toEqual(ERR('#VALUE!'))
  })
})

describe('database error propagation', () => {
  test('propagates errors from criteria cells', () => {
    const criteria = ARR([[STR('Dept')], [ERR('#REF!')]])
    expect(call('DSUM', [DATABASE, STR('Salary'), criteria])).toEqual(ERR('#REF!'))
  })

  test('propagates errors from database cells', () => {
    const database = ARR([
      [STR('Name'), STR('Age'), STR('Dept'), STR('Salary')],
      [STR('Alice'), NUM(30), STR('Eng'), ERR('#DIV/0!')],
      [STR('Bob'), NUM(25), STR('Sales'), NUM(60000)],
    ])
    expect(call('DAVERAGE', [database, STR('Salary'), CRITERIA_ENG_AGE])).toEqual(
      ERR('#DIV/0!'),
    )
  })
})
