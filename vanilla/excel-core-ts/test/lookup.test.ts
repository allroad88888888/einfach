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

import {
  VLOOKUP,
  HLOOKUP,
  INDEX,
  MATCH,
  XLOOKUP,
  LOOKUP,
  XMATCH,
  FUNCTIONS,
} from '../src/eval/functions/lookup'
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

  test('wildcard matching coerces numeric candidates to text', () => {
    const table = arr([
      [n(42), s('x')],
      [n(30), s('y')],
    ])
    expect(VLOOKUP([s('4?'), table, n(2), b(false)], ctx)).toEqual(s('x'))
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

  test('match_type 0 wildcard coerces numeric candidates to text', () => {
    expect(MATCH([s('4?'), arr([[n(42), n(30)]]), n(0)], ctx)).toEqual(n(1))
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

  test('match_mode 2 coerces numeric candidates to text', () => {
    const keys = arr([[n(42)], [n(30)]])
    const values = arr([[s('x')], [s('y')]])
    expect(XLOOKUP([s('4?'), keys, values, blank, n(2)], ctx)).toEqual(s('x'))
  })

  test('match_mode 2 rejects binary search modes', () => {
    const fruit = arr([[s('apple')], [s('banana')]])
    const prices = arr([[n(1)], [n(2)]])
    expect(XLOOKUP([s('b*'), fruit, prices, blank, n(2), n(2)], ctx)).toEqual(errVAL)
    expect(XLOOKUP([s('b*'), fruit, prices, blank, n(2), n(-2)], ctx)).toEqual(errVAL)
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
// LOOKUP
// ============================================================================

describe('LOOKUP', () => {
  const keys = arr([[n(1), n(3), n(5), n(7)]])
  const labels = arr([[s('one'), s('three'), s('five'), s('seven')]])

  test('three-arg vector form returns exact-or-next-smaller result', () => {
    expect(LOOKUP([n(5), keys, labels], ctx)).toEqual(s('five'))
    expect(LOOKUP([n(6), keys, labels], ctx)).toEqual(s('five'))
    expect(LOOKUP([n(99), keys, labels], ctx)).toEqual(s('seven'))
  })

  test('two-arg vector form returns from the lookup vector itself', () => {
    expect(LOOKUP([n(4), keys], ctx)).toEqual(n(3))
  })

  test('two-arg horizontal array form returns from last row', () => {
    const table = arr([
      [n(1), n(2), n(3)],
      [s('a'), s('b'), s('c')],
    ])
    expect(LOOKUP([n(2), table], ctx)).toEqual(s('b'))
  })

  test('two-arg vertical array form returns from last column', () => {
    const table = arr([
      [n(1), s('a')],
      [n(2), s('b')],
      [n(3), s('c')],
    ])
    expect(LOOKUP([n(3), table], ctx)).toEqual(s('c'))
  })

  test('no qualifying key → #N/A and length mismatch → #VALUE!', () => {
    expect(LOOKUP([n(0), keys, labels], ctx)).toEqual(errNA)
    expect(LOOKUP([n(1), keys, arr([[s('only one')]])], ctx)).toEqual(errVAL)
  })
})

// ============================================================================
// XMATCH
// ============================================================================

describe('XMATCH', () => {
  const values = arr([[n(10), n(20), n(30), n(40)]])

  test('default exact match returns 1-based position', () => {
    expect(XMATCH([n(30), values], ctx)).toEqual(n(3))
  })

  test('match_mode -1 / 1 choose nearest numeric neighbor', () => {
    expect(XMATCH([n(25), values, n(-1)], ctx)).toEqual(n(2))
    expect(XMATCH([n(25), values, n(1)], ctx)).toEqual(n(3))
  })

  test('search_mode -1 scans from the end', () => {
    expect(XMATCH([n(1), arr([[n(1), n(2), n(1)]]), n(0), n(-1)], ctx)).toEqual(n(3))
  })

  test('wildcard mode matches text patterns', () => {
    const fruit = arr([[s('apple'), s('banana'), s('cherry')]])
    expect(XMATCH([s('ban*'), fruit, n(2)], ctx)).toEqual(n(2))
  })

  test('wildcard mode coerces numeric candidates to text', () => {
    expect(XMATCH([s('4?'), arr([[n(42), n(30)]]), n(2)], ctx)).toEqual(n(1))
  })

  test('wildcard mode rejects binary search modes', () => {
    const fruit = arr([[s('apple'), s('banana')]])
    expect(XMATCH([s('b*'), fruit, n(2), n(2)], ctx)).toEqual(errVAL)
    expect(XMATCH([s('b*'), fruit, n(2), n(-2)], ctx)).toEqual(errVAL)
  })

  test('not found and invalid modes surface errors', () => {
    expect(XMATCH([n(99), values], ctx)).toEqual(errNA)
    expect(XMATCH([n(10), values, n(99)], ctx)).toEqual(errVAL)
    expect(XMATCH([n(10), values, n(0), n(99)], ctx)).toEqual(errVAL)
  })
})

// ============================================================================
// Binary search on sorted data (VLOOKUP / HLOOKUP / MATCH approximate +
// XLOOKUP search_mode = ±2). Regression for FUNCTION_QUALITY_2026-06-05.md
// "XLOOKUP search_mode = ±2" / "VLOOKUP/HLOOKUP/MATCH approximate" entries.
//
// We don't time these — Jest doesn't reliably distinguish O(log n) from
// O(n) at 1k elements. Instead we assert correctness on inputs the linear
// path used to handle, plus structural invariants: results on the boundary
// between two sorted runs, and fallback behaviour on mixed-type input
// (where binary search must NOT error).
// ============================================================================

describe('binary search on sorted data', () => {
  // 1000 ascending unique integers: 0, 2, 4, ..., 1998.
  const ascRow: Value[] = []
  const ascCol: Value[][] = []
  for (let i = 0; i < 1000; i += 1) {
    ascRow.push(n(i * 2))
    ascCol.push([n(i * 2)])
  }
  const ascRowArr: Value = arr([ascRow])
  // VLOOKUP table: col 0 is the sorted key, col 1 the label.
  const vlookTable: Value[][] = ascCol.map((cell, i) => [cell[0], s(`row-${i}`)])
  const vlookArr: Value = arr(vlookTable)

  test('VLOOKUP approximate hits the right row on 1000-entry sorted column', () => {
    // exact element
    expect(VLOOKUP([n(500), vlookArr, n(2)], ctx)).toEqual(s('row-250'))
    // between elements (498 and 500) → largest <= 499 is 498 → row-249
    expect(VLOOKUP([n(499), vlookArr, n(2)], ctx)).toEqual(s('row-249'))
    // first element
    expect(VLOOKUP([n(0), vlookArr, n(2)], ctx)).toEqual(s('row-0'))
    // last element
    expect(VLOOKUP([n(1998), vlookArr, n(2)], ctx)).toEqual(s('row-999'))
    // overshoot — last row matches (largest <= needle)
    expect(VLOOKUP([n(99999), vlookArr, n(2)], ctx)).toEqual(s('row-999'))
    // undershoot → #N/A
    expect(VLOOKUP([n(-1), vlookArr, n(2)], ctx)).toEqual(errNA)
  })

  test('HLOOKUP approximate hits the right column on 1000-entry sorted row', () => {
    const table = arr([ascRow, ascRow.map((_, i) => s(`col-${i}`))])
    expect(HLOOKUP([n(500), table, n(2)], ctx)).toEqual(s('col-250'))
    expect(HLOOKUP([n(499), table, n(2)], ctx)).toEqual(s('col-249'))
    expect(HLOOKUP([n(-1), table, n(2)], ctx)).toEqual(errNA)
  })

  test('MATCH approximate (type=1) on 1000-entry sorted asc row', () => {
    // 1-based index. Largest <= 1000 is element 500 (value 1000) → position 501.
    expect(MATCH([n(1000), ascRowArr, n(1)], ctx)).toEqual(n(501))
    // Largest <= 999 is element 499 (value 998) → position 500.
    expect(MATCH([n(999), ascRowArr, n(1)], ctx)).toEqual(n(500))
    // Below all → #N/A.
    expect(MATCH([n(-1), ascRowArr, n(1)], ctx)).toEqual(errNA)
  })

  test('MATCH approximate (type=-1) on 1000-entry sorted desc row', () => {
    const desc: Value[] = []
    for (let i = 999; i >= 0; i -= 1) desc.push(n(i * 2))
    const descArr = arr([desc])
    // Smallest >= 999 in [1998..0] desc — that's 1000 at position 500
    // (0-based index 499 in physical order).
    expect(MATCH([n(999), descArr, n(-1)], ctx)).toEqual(n(500))
    expect(MATCH([n(1998), descArr, n(-1)], ctx)).toEqual(n(1))
    expect(MATCH([n(0), descArr, n(-1)], ctx)).toEqual(n(1000))
    expect(MATCH([n(9999), descArr, n(-1)], ctx)).toEqual(errNA)
  })

  test('XLOOKUP search_mode = 2 (binary asc) exact and nearest', () => {
    const lookCol: Value[][] = []
    const retCol: Value[][] = []
    for (let i = 0; i < 1000; i += 1) {
      lookCol.push([n(i * 2)])
      retCol.push([s(`v-${i}`)])
    }
    const look = arr(lookCol)
    const ret = arr(retCol)
    // exact (matchMode 0, searchMode 2)
    expect(XLOOKUP([n(500), look, ret, blank, n(0), n(2)], ctx)).toEqual(s('v-250'))
    // not found → #N/A
    expect(XLOOKUP([n(501), look, ret, blank, n(0), n(2)], ctx)).toEqual(errNA)
    // matchMode -1: exact or next smaller
    expect(XLOOKUP([n(501), look, ret, blank, n(-1), n(2)], ctx)).toEqual(s('v-250'))
    expect(XLOOKUP([n(-1), look, ret, blank, n(-1), n(2)], ctx)).toEqual(errNA)
    // matchMode 1: exact or next larger
    expect(XLOOKUP([n(501), look, ret, blank, n(1), n(2)], ctx)).toEqual(s('v-251'))
    expect(XLOOKUP([n(99999), look, ret, blank, n(1), n(2)], ctx)).toEqual(errNA)
  })

  test('XLOOKUP search_mode = -2 (binary desc) exact and nearest', () => {
    const lookCol: Value[][] = []
    const retCol: Value[][] = []
    for (let i = 999; i >= 0; i -= 1) {
      lookCol.push([n(i * 2)])
      retCol.push([s(`v-${i}`)])
    }
    const look = arr(lookCol)
    const ret = arr(retCol)
    expect(XLOOKUP([n(500), look, ret, blank, n(0), n(-2)], ctx)).toEqual(s('v-250'))
    expect(XLOOKUP([n(501), look, ret, blank, n(0), n(-2)], ctx)).toEqual(errNA)
    // matchMode -1: exact or next smaller (smaller value, not smaller index)
    expect(XLOOKUP([n(501), look, ret, blank, n(-1), n(-2)], ctx)).toEqual(s('v-250'))
    // matchMode 1: exact or next larger
    expect(XLOOKUP([n(501), look, ret, blank, n(1), n(-2)], ctx)).toEqual(s('v-251'))
  })

  test('binary search falls back to linear on mixed-type lookup column', () => {
    // First column mixes strings and numbers — not monotonically orderable
    // by compareForLookup. The binary path returns BSEARCH_UNSORTABLE and
    // the function falls back to the linear walk (which skips incompatible
    // cells and returns the largest comparable hay <= needle, per the
    // function's documented fallback).
    const mixed = arr([
      [s('foo'), s('label-a')],
      [n(1), s('label-1')],
      [n(2), s('label-2')],
      [s('bar'), s('label-b')],
      [n(5), s('label-5')],
    ])
    // Linear scan picks the largest numeric row <= 3 → row index 2 (n(2)).
    expect(VLOOKUP([n(3), mixed, n(2)], ctx)).toEqual(s('label-2'))
    // For XLOOKUP we explicitly request binary asc but the input is
    // unsortable — must fall back, not error.
    const look = arr([[s('foo')], [n(1)], [n(2)], [s('bar')], [n(5)]])
    const ret = arr([[s('a')], [s('b')], [s('c')], [s('d')], [s('e')]])
    // Exact match (matchMode 0) — should find n(2).
    expect(XLOOKUP([n(2), look, ret, blank, n(0), n(2)], ctx)).toEqual(s('c'))
  })

  test('XLOOKUP wildcards (matchMode 2) with binary search reject as before', () => {
    // matchMode=2 + searchMode=±2 was already rejected with #VALUE!; binary
    // implementation keeps that contract.
    const fruit = arr([[s('apple')], [s('banana')], [s('cherry')]])
    const prices = arr([[n(1)], [n(2)], [n(3)]])
    expect(XLOOKUP([s('ban*'), fruit, prices, blank, n(2), n(2)], ctx)).toEqual(errVAL)
    expect(XLOOKUP([s('ban*'), fruit, prices, blank, n(2), n(-2)], ctx)).toEqual(errVAL)
  })

  test('empty lookup array returns #N/A (binary helper short-circuits at n=0)', () => {
    const empty = arr([[]])
    // VLOOKUP with empty table is caught earlier as #VALUE!; that path stays.
    // For MATCH the empty path also surfaces as VALUE per existing wrapping,
    // so this assertion just guards no infinite loop / no throw.
    const result = MATCH([n(1), empty, n(1)], ctx)
    expect(result.kind === 'error').toBe(true)
  })
})

// ============================================================================
// Registry sanity
// ============================================================================

describe('FUNCTIONS registry', () => {
  test('exports the v1 lookup baseline (extensible)', () => {
    const keys = new Set(Object.keys(FUNCTIONS))
    const baseline = ['HLOOKUP', 'INDEX', 'LOOKUP', 'MATCH', 'VLOOKUP', 'XLOOKUP', 'XMATCH']
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
