/**
 * Phase 8 — info / logical / lookup function additions tests.
 */

import { describe, expect, test } from '@jest/globals'

import { FUNCTIONS as INFO_FUNCTIONS } from '../src/eval/functions/info'
import { FUNCTIONS as LOGICAL_FUNCTIONS } from '../src/eval/functions/logical'
import { FUNCTIONS as LOOKUP_FUNCTIONS } from '../src/eval/functions/lookup'
import type { EvalContext, FunctionImpl, Value } from '../src/types'

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const STR = (s: string): Value => ({ kind: 'string', value: s })
const BOOL = (b: boolean): Value => ({ kind: 'boolean', value: b })
const BLANK: Value = { kind: 'blank' }
const ERR = (code: '#DIV/0!' | '#N/A' | '#NUM!' | '#VALUE!' | '#REF!'): Value => ({
  kind: 'error',
  code,
})
const ARR = (rows: Value[][]): Value => ({ kind: 'array', value: rows })

const ctx: EvalContext = new Proxy(
  {},
  {
    get(_, prop) {
      throw new Error(`phase8 ilL unexpectedly read ctx.${String(prop)}`)
    },
  },
) as unknown as EvalContext

function from(map: Record<string, FunctionImpl>, name: string): FunctionImpl {
  const f = map[name]
  if (!f) throw new Error(`No function ${name}`)
  return f
}

const info = (name: string, args: Value[]): Value => from(INFO_FUNCTIONS, name)(args, ctx)
const logical = (name: string, args: Value[]): Value => from(LOGICAL_FUNCTIONS, name)(args, ctx)
const lookup = (name: string, args: Value[]): Value => from(LOOKUP_FUNCTIONS, name)(args, ctx)

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

describe('ISNONTEXT', () => {
  test('non-text inputs → TRUE', () => {
    expect(info('ISNONTEXT', [NUM(5)])).toEqual(BOOL(true))
    expect(info('ISNONTEXT', [BLANK])).toEqual(BOOL(true))
  })
  test('strings → FALSE', () => expect(info('ISNONTEXT', [STR('hi')])).toEqual(BOOL(false)))
  test('errors → TRUE (errors aren\'t text)', () =>
    expect(info('ISNONTEXT', [ERR('#N/A')])).toEqual(BOOL(true)))
})

describe('ISEVEN / ISODD', () => {
  test('ISEVEN(2) = TRUE', () => expect(info('ISEVEN', [NUM(2)])).toEqual(BOOL(true)))
  test('ISEVEN(3) = FALSE', () => expect(info('ISEVEN', [NUM(3)])).toEqual(BOOL(false)))
  test('ISODD(3) = TRUE', () => expect(info('ISODD', [NUM(3)])).toEqual(BOOL(true)))
  test('ISEVEN of error propagates', () =>
    expect(info('ISEVEN', [ERR('#N/A')])).toEqual(ERR('#N/A')))
  test('ISEVEN of string → #VALUE!', () =>
    expect(info('ISEVEN', [STR('foo')])).toEqual(ERR('#VALUE!')))
})

describe('N', () => {
  test('N(5) = 5', () => expect(info('N', [NUM(5)])).toEqual(NUM(5)))
  test('N(TRUE) = 1', () => expect(info('N', [BOOL(true)])).toEqual(NUM(1)))
  test('N(blank) = 0', () => expect(info('N', [BLANK])).toEqual(NUM(0)))
  test('N(text) = 0', () => expect(info('N', [STR('hi')])).toEqual(NUM(0)))
  test('N(error) propagates', () => expect(info('N', [ERR('#N/A')])).toEqual(ERR('#N/A')))
})

describe('NA', () => {
  test('NA() = #N/A', () => expect(info('NA', [])).toEqual(ERR('#N/A')))
  test('NA(1) → #VALUE!', () => expect(info('NA', [NUM(1)])).toEqual(ERR('#VALUE!')))
})

describe('ISFORMULA / ISREF', () => {
  // These are pre-resolved by the dispatcher so they can't see formula
  // metadata — they return FALSE for any input.
  test('ISFORMULA always FALSE', () => expect(info('ISFORMULA', [NUM(5)])).toEqual(BOOL(false)))
  test('ISREF always FALSE', () => expect(info('ISREF', [NUM(5)])).toEqual(BOOL(false)))
  test('wrong arity → #VALUE!', () =>
    expect(info('ISFORMULA', [NUM(1), NUM(2)])).toEqual(ERR('#VALUE!')))
})

describe('INFO / ERROR.TYPE', () => {
  test('INFO returns stable runtime metadata', () => {
    expect(info('INFO', [STR('recalc')])).toEqual(STR('Automatic'))
    expect(info('INFO', [STR('numfile')])).toEqual(NUM(1))
    expect(info('INFO', [STR('release')])).toEqual(STR('einfach-ts'))
    const system = info('INFO', [STR('system')])
    expect(system.kind).toBe('string')
    if (system.kind === 'string') expect(['mac', 'pc', 'other']).toContain(system.value)
  })

  test('INFO propagates errors and rejects unknown keys', () => {
    expect(info('INFO', [ERR('#N/A')])).toEqual(ERR('#N/A'))
    expect(info('INFO', [STR('unknown')])).toEqual(ERR('#VALUE!'))
  })

  test('ERROR.TYPE maps error codes', () => {
    expect(info('ERROR.TYPE', [ERR('#N/A')])).toEqual(NUM(7))
    expect(info('ERROR.TYPE', [ERR('#REF!')])).toEqual(NUM(4))
    expect(info('ERROR.TYPE', [ERR('#VALUE!')])).toEqual(NUM(3))
  })

  test('ERROR.TYPE rejects non-errors', () => {
    expect(info('ERROR.TYPE', [NUM(5)])).toEqual(ERR('#VALUE!'))
  })
})

// ---------------------------------------------------------------------------
// Logical
// ---------------------------------------------------------------------------

describe('XOR', () => {
  test('odd count of TRUEs → TRUE', () =>
    expect(logical('XOR', [BOOL(true), BOOL(false), BOOL(true), BOOL(true)])).toEqual(BOOL(true)))
  test('even count of TRUEs → FALSE', () =>
    expect(logical('XOR', [BOOL(true), BOOL(false), BOOL(true)])).toEqual(BOOL(false)))
  test('XOR on array', () =>
    expect(logical('XOR', [ARR([[BOOL(true), BOOL(true), BOOL(true)]])])).toEqual(BOOL(true)))
  test('no args → #VALUE!', () => expect(logical('XOR', [])).toEqual(ERR('#VALUE!')))
})

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

describe('CHOOSE', () => {
  test('picks 2nd value', () =>
    expect(lookup('CHOOSE', [NUM(2), STR('a'), STR('b'), STR('c')])).toEqual(STR('b')))
  test('out of range → #VALUE!', () =>
    expect(lookup('CHOOSE', [NUM(5), STR('a'), STR('b')])).toEqual(ERR('#VALUE!')))
  test('index 1 → first', () =>
    expect(lookup('CHOOSE', [NUM(1), STR('a'), STR('b')])).toEqual(STR('a')))
})

describe('ROWS / COLUMNS', () => {
  test('ROWS on 3x2 array = 3', () =>
    expect(lookup('ROWS', [ARR([[NUM(1), NUM(2)], [NUM(3), NUM(4)], [NUM(5), NUM(6)]])])).toEqual(
      NUM(3),
    ))
  test('COLUMNS on 3x2 array = 2', () =>
    expect(
      lookup('COLUMNS', [ARR([[NUM(1), NUM(2)], [NUM(3), NUM(4)], [NUM(5), NUM(6)]])]),
    ).toEqual(NUM(2)))
  test('ROWS on scalar = 1', () => expect(lookup('ROWS', [NUM(5)])).toEqual(NUM(1)))
})

describe('ROW / COLUMN', () => {
  test('ROW() with no args = 1 (no ref info at this layer)', () =>
    expect(lookup('ROW', [])).toEqual(NUM(1)))
  test('COLUMN() with no args = 1', () => expect(lookup('COLUMN', [])).toEqual(NUM(1)))
  test('ROW on array returns column array 1..N', () => {
    const result = lookup('ROW', [ARR([[NUM(1)], [NUM(2)], [NUM(3)]])])
    expect(result.kind).toBe('array')
  })
})

describe('ADDRESS', () => {
  test('default A1 absolute', () =>
    expect(lookup('ADDRESS', [NUM(1), NUM(1)])).toEqual(STR('$A$1')))
  test('with sheet name', () =>
    expect(lookup('ADDRESS', [NUM(2), NUM(3), NUM(1), BOOL(true), STR('Sheet1')])).toEqual(
      STR('Sheet1!$C$2'),
    ))
  test('relative (abs=4)', () =>
    expect(lookup('ADDRESS', [NUM(1), NUM(1), NUM(4)])).toEqual(STR('A1')))
  test('column letter beyond Z', () =>
    expect(lookup('ADDRESS', [NUM(1), NUM(27)])).toEqual(STR('$AA$1')))
})
