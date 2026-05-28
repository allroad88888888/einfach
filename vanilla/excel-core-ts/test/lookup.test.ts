/**
 * Wave C / C3 — lookup function tests.
 *
 * Each function has 6+ fixtures spanning the documented modes:
 *  - exact / approximate / wildcard / not-found / error-propagation / edge case
 *
 * Tests drive the function impls directly with hand-built `Value[]` args —
 * no parser, no AST, no atoms. That keeps the suite focused on the function
 * semantics themselves; integration with the evaluator goes through the
 * dispatcher tests in Wave B/B2's evaluate.test.ts (and will be tightened
 * when the function registry merges in src/eval/functions/index.ts).
 */

import { describe, expect, test } from '@jest/globals'

import { VLOOKUP, HLOOKUP, INDEX, MATCH, XLOOKUP, FUNCTIONS } from '../src/eval/functions/lookup'
import type { EvalContext, Value } from '../src/types'

// Minimal ctx — lookup functions don't consult any of these but the impls
// take the ctx slot for FunctionImpl conformance.
const ctx: EvalContext = {
  cells: new Map(),
  currentlyEvaluating: new Set(),
  refLookup: () => ({ kind: 'blank' }),
  rangeLookup: () => [[{ kind: 'blank' }]],
  crossSheetCells: () => undefined,
  callCustom: () => undefined,
  resolveName: () => undefined,
}

// Helpers to build values tersely.
const n = (v: number): Value => ({ kind: 'number', value: v })
const s = (v: string): Value => ({ kind: 'string', value: v })
const b = (v: boolean): Value => ({ kind: 'boolean', value: v })
const blank: Value = { kind: 'blank' }
const arr = (rows: Value[][]): Value => ({ kind: 'array', value: rows })
const errNA: Value = { kind: 'error', code: '#N/A' }
const errVAL: Value = { kind: 'error', code: '#VALUE!' }
const errREF: Value = { kind: 'error', code: '#REF!' }
const errDIV: Value = { kind: 'error', code: '#DIV/0!' }

// ============================================================================
// VLOOKUP
// ============================================================================

describe('VLOOKUP', () => {
  const employees = arr([
    [n(101), s('Alice'), n(50000)],
    [n(102), s('Bob'), n(60000)],
    [n(103), s('Charlie'), n(70000)],
    [n(104), s('Diana'), n(80000)],
  ])

  test('exact match: lookup by id returns the correct column', () => {
    expect(VLOOKUP([n(102), employees, n(2), b(false)], ctx)).toEqual(s('Bob'))
  })

  test('exact match: returns #N/A when needle is missing', () => {
    expect(VLOOKUP([n(999), employees, n(2), b(false)], ctx)).toEqual(errNA)
  })

  test('approximate match (default range_lookup=TRUE): largest <= needle', () => {
    // Tax bracket table
    const table = arr([
      [n(0), s('0%')],
      [n(10000), s('10%')],
      [n(40000), s('20%')],
      [n(100000), s('30%')],
    ])
    expect(VLOOKUP([n(35000), table, n(2)], ctx)).toEqual(s('10%'))
    expect(VLOOKUP([n(50000), table, n(2)], ctx)).toEqual(s('20%'))
    expect(VLOOKUP([n(150000), table, n(2)], ctx)).toEqual(s('30%'))
  })

  test('approximate match: needle below the first value → #N/A', () => {
    const table = arr([
      [n(10), s('A')],
      [n(20), s('B')],
    ])
    expect(VLOOKUP([n(5), table, n(2)], ctx)).toEqual(errNA)
  })

  test('wildcard matching (only when range_lookup=FALSE)', () => {
    // Build a name-keyed table so the wildcards have something to match.
    const byName = arr([
      [s('Alice'), n(50000)],
      [s('Bob'), n(60000)],
      [s('Charlie'), n(70000)],
    ])
    expect(VLOOKUP([s('Al*'), byName, n(2), b(false)], ctx)).toEqual(n(50000))
    expect(VLOOKUP([s('?ob'), byName, n(2), b(false)], ctx)).toEqual(n(60000))
    expect(VLOOKUP([s('Ch?rl*'), byName, n(2), b(false)], ctx)).toEqual(n(70000))
  })

  test('case-insensitive exact matching', () => {
    const byName = arr([
      [s('Alice'), n(50000)],
      [s('Bob'), n(60000)],
    ])
    expect(VLOOKUP([s('alice'), byName, n(2), b(false)], ctx)).toEqual(n(50000))
    expect(VLOOKUP([s('BOB'), byName, n(2), b(false)], ctx)).toEqual(n(60000))
  })

  test('error propagation: any arg with #DIV/0! short-circuits', () => {
    expect(VLOOKUP([errDIV, employees, n(2), b(false)], ctx)).toEqual(errDIV)
    expect(VLOOKUP([n(101), errDIV, n(2)], ctx)).toEqual(errDIV)
  })

  test('col_index < 1 → #VALUE!', () => {
    expect(VLOOKUP([n(101), employees, n(0), b(false)], ctx)).toEqual(errVAL)
    expect(VLOOKUP([n(101), employees, n(-1), b(false)], ctx)).toEqual(errVAL)
  })

  test('col_index > width → #REF!', () => {
    expect(VLOOKUP([n(101), employees, n(99), b(false)], ctx)).toEqual(errREF)
  })

  test('wrong arity → #VALUE!', () => {
    expect(VLOOKUP([n(101), employees], ctx)).toEqual(errVAL)
    expect(VLOOKUP([n(101), employees, n(1), b(false), n(99)], ctx)).toEqual(errVAL)
  })

  test('escaped wildcards (~* matches literal *)', () => {
    const table = arr([
      [s('star*ship'), n(1)],
      [s('plain'), n(2)],
    ])
    expect(VLOOKUP([s('star~*ship'), table, n(2), b(false)], ctx)).toEqual(n(1))
    expect(VLOOKUP([s('star*'), table, n(2), b(false)], ctx)).toEqual(n(1)) // wildcard match
  })
})

// ============================================================================
// HLOOKUP
// ============================================================================

describe('HLOOKUP', () => {
  // Quarterly figures by department: dept name in row 0, then 4 rows of $.
  const quarters = arr([
    [s('Sales'), s('Marketing'), s('Eng')],
    [n(100), n(200), n(300)],
    [n(110), n(210), n(310)],
    [n(120), n(220), n(320)],
  ])

  test('exact match: lookup row pulls value from later row', () => {
    expect(HLOOKUP([s('Marketing'), quarters, n(2), b(false)], ctx)).toEqual(n(200))
    expect(HLOOKUP([s('Eng'), quarters, n(4), b(false)], ctx)).toEqual(n(320))
  })

  test('approximate match on numeric first row (largest <= needle)', () => {
    const table = arr([
      [n(0), n(10), n(20), n(50)],
      [s('Low'), s('Med'), s('High'), s('VHigh')],
    ])
    expect(HLOOKUP([n(15), table, n(2)], ctx)).toEqual(s('Med'))
    expect(HLOOKUP([n(60), table, n(2)], ctx)).toEqual(s('VHigh'))
  })

  test('approximate: below first value → #N/A', () => {
    const table = arr([
      [n(10), n(20)],
      [s('A'), s('B')],
    ])
    expect(HLOOKUP([n(5), table, n(2)], ctx)).toEqual(errNA)
  })

  test('wildcard matching with range_lookup=FALSE', () => {
    expect(HLOOKUP([s('Eng*'), quarters, n(2), b(false)], ctx)).toEqual(n(300))
    expect(HLOOKUP([s('Mark?ting'), quarters, n(3), b(false)], ctx)).toEqual(n(210))
  })

  test('not found exact → #N/A', () => {
    expect(HLOOKUP([s('HR'), quarters, n(2), b(false)], ctx)).toEqual(errNA)
  })

  test('error propagation', () => {
    expect(HLOOKUP([errDIV, quarters, n(2), b(false)], ctx)).toEqual(errDIV)
  })

  test('row_index < 1 → #VALUE!', () => {
    expect(HLOOKUP([s('Sales'), quarters, n(0), b(false)], ctx)).toEqual(errVAL)
  })

  test('row_index > height → #REF!', () => {
    expect(HLOOKUP([s('Sales'), quarters, n(99), b(false)], ctx)).toEqual(errREF)
  })
})

// ============================================================================
// INDEX
// ============================================================================

describe('INDEX', () => {
  const matrix = arr([
    [n(1), n(2), n(3)],
    [n(4), n(5), n(6)],
    [n(7), n(8), n(9)],
  ])

  test('2-D index: row + col returns the cell', () => {
    expect(INDEX([matrix, n(2), n(3)], ctx)).toEqual(n(6))
    expect(INDEX([matrix, n(1), n(1)], ctx)).toEqual(n(1))
    expect(INDEX([matrix, n(3), n(2)], ctx)).toEqual(n(8))
  })

  test('row_num = 0 returns whole column', () => {
    expect(INDEX([matrix, n(0), n(2)], ctx)).toEqual(arr([[n(2)], [n(5)], [n(8)]]))
  })

  test('col_num = 0 returns whole row', () => {
    expect(INDEX([matrix, n(2), n(0)], ctx)).toEqual(arr([[n(4), n(5), n(6)]]))
  })

  test('row_num = 0 AND col_num = 0 returns whole array', () => {
    expect(INDEX([matrix, n(0), n(0)], ctx)).toEqual(matrix)
  })

  test('1-D row array: single arg indexes within the row', () => {
    const row = arr([[n(10), n(20), n(30), n(40)]])
    expect(INDEX([row, n(2)], ctx)).toEqual(n(20))
    expect(INDEX([row, n(4)], ctx)).toEqual(n(40))
  })

  test('1-D column array: single arg indexes within the column', () => {
    const col = arr([[n(10)], [n(20)], [n(30)], [n(40)]])
    expect(INDEX([col, n(3)], ctx)).toEqual(n(30))
  })

  test('out of bounds → #REF!', () => {
    expect(INDEX([matrix, n(5), n(1)], ctx)).toEqual(errREF)
    expect(INDEX([matrix, n(1), n(5)], ctx)).toEqual(errREF)
  })

  test('error propagation', () => {
    expect(INDEX([errDIV, n(1), n(1)], ctx)).toEqual(errDIV)
    expect(INDEX([matrix, errDIV, n(1)], ctx)).toEqual(errDIV)
  })

  test('scalar wrapped to single-cell — indexing returns scalar back', () => {
    expect(INDEX([n(42), n(1), n(1)], ctx)).toEqual(n(42))
    expect(INDEX([n(42), n(1)], ctx)).toEqual(n(42))
  })

  test('negative indices → #VALUE!', () => {
    expect(INDEX([matrix, n(-1), n(1)], ctx)).toEqual(errVAL)
  })
})

// ============================================================================
// MATCH
// ============================================================================

describe('MATCH', () => {
  const numericAsc = arr([[n(1), n(2), n(4), n(8), n(16), n(32)]])
  const numericDesc = arr([[n(32), n(16), n(8), n(4), n(2), n(1)]])
  const strings = arr([[s('apple'), s('banana'), s('cherry'), s('date')]])

  test('match_type 0 (exact): returns 1-based index', () => {
    expect(MATCH([n(8), numericAsc, n(0)], ctx)).toEqual(n(4))
    expect(MATCH([s('cherry'), strings, n(0)], ctx)).toEqual(n(3))
  })

  test('match_type 0: wildcards on string needle', () => {
    expect(MATCH([s('ban*'), strings, n(0)], ctx)).toEqual(n(2))
    expect(MATCH([s('?herry'), strings, n(0)], ctx)).toEqual(n(3))
  })

  test('match_type 1 (default, asc): largest <= needle', () => {
    expect(MATCH([n(7), numericAsc, n(1)], ctx)).toEqual(n(3)) // 4 is largest <= 7
    expect(MATCH([n(8), numericAsc, n(1)], ctx)).toEqual(n(4)) // exact
    expect(MATCH([n(100), numericAsc, n(1)], ctx)).toEqual(n(6)) // last element
  })

  test('match_type 1: default when match_type omitted', () => {
    expect(MATCH([n(7), numericAsc], ctx)).toEqual(n(3))
  })

  test('match_type 1: below first value → #N/A', () => {
    expect(MATCH([n(0), numericAsc, n(1)], ctx)).toEqual(errNA)
  })

  test('match_type -1 (desc): smallest >= needle', () => {
    expect(MATCH([n(7), numericDesc, n(-1)], ctx)).toEqual(n(3)) // 8 is smallest >= 7
    expect(MATCH([n(16), numericDesc, n(-1)], ctx)).toEqual(n(2)) // exact
  })

  test('match_type -1: above first value → #N/A', () => {
    expect(MATCH([n(100), numericDesc, n(-1)], ctx)).toEqual(errNA)
  })

  test('not found exact → #N/A', () => {
    expect(MATCH([n(7), numericAsc, n(0)], ctx)).toEqual(errNA)
    expect(MATCH([s('mango'), strings, n(0)], ctx)).toEqual(errNA)
  })

  test('error propagation', () => {
    expect(MATCH([errDIV, numericAsc, n(0)], ctx)).toEqual(errDIV)
  })

  test('invalid match_type → #VALUE!', () => {
    expect(MATCH([n(1), numericAsc, n(99)], ctx)).toEqual(errVAL)
  })

  test('case-insensitive string match', () => {
    expect(MATCH([s('APPLE'), strings, n(0)], ctx)).toEqual(n(1))
    expect(MATCH([s('Date'), strings, n(0)], ctx)).toEqual(n(4))
  })
})

// ============================================================================
// XLOOKUP
// ============================================================================

describe('XLOOKUP', () => {
  const ids = arr([[n(101)], [n(102)], [n(103)], [n(104)], [n(105)]])
  const names = arr([[s('Alice')], [s('Bob')], [s('Charlie')], [s('Diana')], [s('Eve')]])

  test('exact match (default match_mode=0)', () => {
    expect(XLOOKUP([n(103), ids, names], ctx)).toEqual(s('Charlie'))
    expect(XLOOKUP([n(101), ids, names], ctx)).toEqual(s('Alice'))
    expect(XLOOKUP([n(105), ids, names], ctx)).toEqual(s('Eve'))
  })

  test('exact match not found returns #N/A by default', () => {
    expect(XLOOKUP([n(999), ids, names], ctx)).toEqual(errNA)
  })

  test('exact match not found uses if_not_found when supplied', () => {
    expect(XLOOKUP([n(999), ids, names, s('NOT FOUND')], ctx)).toEqual(s('NOT FOUND'))
    expect(XLOOKUP([n(999), ids, names, n(0)], ctx)).toEqual(n(0))
  })

  test('match_mode -1: exact or next smaller', () => {
    // ids: 101..105. needle 103.5 → next smaller is 103 → Charlie
    expect(XLOOKUP([n(103.5), ids, names, blank, n(-1)], ctx)).toEqual(s('Charlie'))
    expect(XLOOKUP([n(100), ids, names, blank, n(-1)], ctx)).toEqual(errNA) // nothing smaller
  })

  test('match_mode 1: exact or next larger', () => {
    expect(XLOOKUP([n(103.5), ids, names, blank, n(1)], ctx)).toEqual(s('Diana'))
    expect(XLOOKUP([n(106), ids, names, blank, n(1)], ctx)).toEqual(errNA)
  })

  test('match_mode 2: wildcard matching', () => {
    const fruit = arr([[s('apple')], [s('banana')], [s('cherry')]])
    const prices = arr([[n(1)], [n(2)], [n(3)]])
    expect(XLOOKUP([s('ban*'), fruit, prices, blank, n(2)], ctx)).toEqual(n(2))
    expect(XLOOKUP([s('?herry'), fruit, prices, blank, n(2)], ctx)).toEqual(n(3))
  })

  test('search_mode -1: last-to-first scan', () => {
    // Duplicate values — last-to-first should pick the later index.
    const lookups = arr([[n(1)], [n(2)], [n(1)], [n(3)]])
    const labels = arr([[s('first')], [s('second')], [s('third')], [s('fourth')]])
    expect(XLOOKUP([n(1), lookups, labels, blank, n(0), n(-1)], ctx)).toEqual(s('third'))
    expect(XLOOKUP([n(1), lookups, labels, blank, n(0), n(1)], ctx)).toEqual(s('first'))
  })

  test('mismatched array lengths → #VALUE!', () => {
    const short = arr([[n(1)], [n(2)]])
    expect(XLOOKUP([n(1), ids, short], ctx)).toEqual(errVAL)
  })

  test('error propagation', () => {
    expect(XLOOKUP([errDIV, ids, names], ctx)).toEqual(errDIV)
    // if_not_found slot does NOT propagate (host may pass a sentinel)
    expect(XLOOKUP([n(999), ids, names, errDIV], ctx)).toEqual(errDIV) // but this becomes the return when not found
  })

  test('case-insensitive exact', () => {
    const fruit = arr([[s('Apple')], [s('Banana')]])
    const prices = arr([[n(1)], [n(2)]])
    expect(XLOOKUP([s('APPLE'), fruit, prices], ctx)).toEqual(n(1))
    expect(XLOOKUP([s('banana'), fruit, prices], ctx)).toEqual(n(2))
  })

  test('horizontal lookup_array (1xN)', () => {
    const rowIds = arr([[n(101), n(102), n(103)]])
    const rowNames = arr([[s('Alice'), s('Bob'), s('Charlie')]])
    expect(XLOOKUP([n(102), rowIds, rowNames], ctx)).toEqual(s('Bob'))
  })

  test('multi-column return → returns matching row as 1xN array', () => {
    const keys = arr([[s('Alice')], [s('Bob')], [s('Charlie')]])
    const records = arr([
      [s('Alice'), n(30), s('Eng')],
      [s('Bob'), n(40), s('Sales')],
      [s('Charlie'), n(50), s('HR')],
    ])
    const result = XLOOKUP([s('Bob'), keys, records], ctx)
    expect(result).toEqual(arr([[s('Bob'), n(40), s('Sales')]]))
  })

  test('invalid match_mode → #VALUE!', () => {
    expect(XLOOKUP([n(101), ids, names, blank, n(99)], ctx)).toEqual(errVAL)
  })

  test('invalid search_mode → #VALUE!', () => {
    expect(XLOOKUP([n(101), ids, names, blank, n(0), n(99)], ctx)).toEqual(errVAL)
  })
})

// ============================================================================
// Registry sanity
// ============================================================================

describe('FUNCTIONS registry', () => {
  test('exports the v1 lookup baseline (extensible)', () => {
    const keys = new Set(Object.keys(FUNCTIONS))
    const baseline = ['HLOOKUP', 'INDEX', 'MATCH', 'VLOOKUP', 'XLOOKUP']
    for (const name of baseline) {
      expect(keys.has(name)).toBe(true)
    }
  })

  test('each entry is callable', () => {
    for (const name of Object.keys(FUNCTIONS)) {
      const fn = FUNCTIONS[name]
      expect(typeof fn).toBe('function')
    }
  })
})
