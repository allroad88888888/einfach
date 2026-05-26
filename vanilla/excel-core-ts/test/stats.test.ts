/**
 * Wave C / C5 — COUNTIF / SUMIF / COUNTIFS / SUMIFS tests.
 *
 * Each function exercises the same criterion grammar:
 *   - numeric / string / boolean equality
 *   - comparison operators (`>`, `<=`, `<>`)
 *   - wildcards (`*`, `?`, `~*` escaping)
 *   - error propagation from the criterion arg
 *   - error tolerance inside the range (Excel skips error cells)
 */

import { describe, expect, test } from '@jest/globals'

import { FUNCTIONS } from '../src/eval/functions/stats'
import type { EvalContext, FunctionImpl, Value } from '../src/types'

function makeCtx(): EvalContext {
  return {
    cells: new Map(),
    currentlyEvaluating: new Set(),
    refLookup: () => ({ kind: 'blank' }),
    rangeLookup: () => [],
    crossSheetCells: () => undefined,
    callCustom: () => undefined,
    resolveName: () => undefined,
  }
}

function call(fn: FunctionImpl, args: Value[]): Value {
  return fn(args, makeCtx())
}

const num = (value: number): Value => ({ kind: 'number', value })
const str = (value: string): Value => ({ kind: 'string', value })
const bool = (value: boolean): Value => ({ kind: 'boolean', value })
const blank = (): Value => ({ kind: 'blank' })
const errVal = (code: '#REF!' | '#VALUE!' | '#DIV/0!'): Value => ({ kind: 'error', code })
const range1D = (values: Value[]): Value => ({ kind: 'array', value: [values] })
const range2D = (rows: Value[][]): Value => ({ kind: 'array', value: rows })

// ---------------------------------------------------------------------------
// COUNTIF
// ---------------------------------------------------------------------------

describe('COUNTIF', () => {
  const COUNTIF = FUNCTIONS.COUNTIF

  test('numeric equality counts exact matches', () => {
    const range = range1D([num(1), num(2), num(2), num(3), num(2)])
    expect(call(COUNTIF, [range, num(2)])).toEqual(num(3))
  })

  test('string criterion is case-insensitive', () => {
    const range = range1D([str('apple'), str('APPLE'), str('Banana'), str('cherry')])
    expect(call(COUNTIF, [range, str('apple')])).toEqual(num(2))
  })

  test('comparison criterion ">3" counts cells greater than 3', () => {
    const range = range1D([num(1), num(2), num(3), num(4), num(5)])
    expect(call(COUNTIF, [range, str('>3')])).toEqual(num(2))
  })

  test('comparison criterion "<=2" counts ≤ 2', () => {
    const range = range1D([num(1), num(2), num(3), num(4)])
    expect(call(COUNTIF, [range, str('<=2')])).toEqual(num(2))
  })

  test('"<>" with empty rest counts non-blank cells', () => {
    const range = range1D([num(1), str(''), blank(), num(2)])
    // "<>" against blank: non-blank cells. Blank cells equal "" → excluded.
    // Plain `<>` rest "" is treated as: not equal to "". Blank == "" so blank
    // is excluded; "" string is also excluded; 1 and 2 are included.
    expect(call(COUNTIF, [range, str('<>')])).toEqual(num(2))
  })

  test('wildcard `*` matches any run', () => {
    const range = range1D([str('apple'), str('apricot'), str('banana'), str('avocado')])
    expect(call(COUNTIF, [range, str('a*')])).toEqual(num(3))
  })

  test('wildcard `?` matches single character', () => {
    const range = range1D([str('cat'), str('cot'), str('cats'), str('cut')])
    expect(call(COUNTIF, [range, str('c?t')])).toEqual(num(3))
  })

  test('escaped wildcard `~*` matches literal asterisk', () => {
    const range = range1D([str('a*'), str('ab'), str('a*c'), str('*')])
    expect(call(COUNTIF, [range, str('a~*')])).toEqual(num(1)) // only the literal "a*"
  })

  test('error cells in the range are skipped (Excel-compat)', () => {
    const range = range1D([num(1), errVal('#REF!'), num(2), num(1)])
    expect(call(COUNTIF, [range, num(1)])).toEqual(num(2))
  })

  test('criterion error propagates', () => {
    const range = range1D([num(1), num(2)])
    expect(call(COUNTIF, [range, errVal('#VALUE!')])).toEqual(errVal('#VALUE!'))
  })

  test('scalar range counts 0 or 1', () => {
    expect(call(COUNTIF, [num(5), num(5)])).toEqual(num(1))
    expect(call(COUNTIF, [num(5), num(6)])).toEqual(num(0))
  })

  test('boolean criterion via "TRUE"/"FALSE" string', () => {
    const range = range1D([bool(true), bool(false), bool(true), num(1)])
    expect(call(COUNTIF, [range, str('TRUE')])).toEqual(num(2))
  })

  test('arity mismatch returns #VALUE!', () => {
    expect(call(COUNTIF, [num(1)])).toMatchObject({ kind: 'error', code: '#VALUE!' })
    expect(call(COUNTIF, [num(1), num(2), num(3)])).toMatchObject({
      kind: 'error',
      code: '#VALUE!',
    })
  })
})

// ---------------------------------------------------------------------------
// SUMIF
// ---------------------------------------------------------------------------

describe('SUMIF', () => {
  const SUMIF = FUNCTIONS.SUMIF

  test('SUMIF(range, criterion) sums cells in range matching criterion', () => {
    const range = range1D([num(1), num(2), num(3), num(2), num(1)])
    expect(call(SUMIF, [range, num(2)])).toEqual(num(4))
  })

  test('SUMIF with sum_range pairs index-by-index', () => {
    const check = range1D([str('A'), str('B'), str('A'), str('B')])
    const sum = range1D([num(10), num(20), num(30), num(40)])
    expect(call(SUMIF, [check, str('A'), sum])).toEqual(num(40))
  })

  test('SUMIF with ">5" criterion', () => {
    const range = range1D([num(1), num(6), num(7), num(2), num(10)])
    expect(call(SUMIF, [range, str('>5')])).toEqual(num(23))
  })

  test('SUMIF with wildcard on string check, numeric sum_range', () => {
    const check = range1D([str('apple'), str('apricot'), str('banana')])
    const sum = range1D([num(1), num(2), num(3)])
    expect(call(SUMIF, [check, str('a*'), sum])).toEqual(num(3))
  })

  test('SUMIF skips error cells in check range', () => {
    const check = range1D([num(1), errVal('#REF!'), num(1)])
    const sum = range1D([num(10), num(20), num(30)])
    expect(call(SUMIF, [check, num(1), sum])).toEqual(num(40))
  })

  test('SUMIF propagates errors from sum_range', () => {
    const check = range1D([num(1), num(1)])
    const sum = range1D([num(10), errVal('#DIV/0!')])
    expect(call(SUMIF, [check, num(1), sum])).toEqual(errVal('#DIV/0!'))
  })

  test('SUMIF non-numeric sum_range cells are skipped', () => {
    const check = range1D([str('a'), str('a'), str('a')])
    const sum = range1D([num(10), str('hello'), num(20)])
    expect(call(SUMIF, [check, str('a'), sum])).toEqual(num(30))
  })

  test('SUMIF criterion error propagates', () => {
    expect(call(SUMIF, [range1D([num(1)]), errVal('#REF!')])).toEqual(errVal('#REF!'))
  })

  test('SUMIF "<>" empty matches non-blank cells', () => {
    const range = range1D([num(1), blank(), num(2), blank(), num(3)])
    expect(call(SUMIF, [range, str('<>')])).toEqual(num(6))
  })

  test('SUMIF arity check', () => {
    expect(call(SUMIF, [num(1)])).toMatchObject({ kind: 'error', code: '#VALUE!' })
    expect(call(SUMIF, [num(1), num(2), num(3), num(4)])).toMatchObject({
      kind: 'error',
      code: '#VALUE!',
    })
  })
})

// ---------------------------------------------------------------------------
// COUNTIFS
// ---------------------------------------------------------------------------

describe('COUNTIFS', () => {
  const COUNTIFS = FUNCTIONS.COUNTIFS

  test('AND across two conditions', () => {
    const r1 = range1D([str('A'), str('A'), str('B'), str('A')])
    const r2 = range1D([num(1), num(2), num(1), num(2)])
    // "A" AND 2 → indices 1, 3
    expect(call(COUNTIFS, [r1, str('A'), r2, num(2)])).toEqual(num(2))
  })

  test('single condition behaves like COUNTIF', () => {
    const r1 = range1D([num(1), num(2), num(3), num(2)])
    expect(call(COUNTIFS, [r1, num(2)])).toEqual(num(2))
  })

  test('three conditions combine with AND', () => {
    const r1 = range1D([str('A'), str('A'), str('A'), str('B')])
    const r2 = range1D([num(1), num(2), num(2), num(2)])
    const r3 = range1D([str('x'), str('y'), str('y'), str('y')])
    // A & 2 & y → indices 1, 2 → count 2
    expect(call(COUNTIFS, [r1, str('A'), r2, num(2), r3, str('y')])).toEqual(num(2))
  })

  test('range shape mismatch → #VALUE!', () => {
    const r1 = range1D([num(1), num(2), num(3)])
    const r2 = range1D([num(1), num(2)])
    expect(call(COUNTIFS, [r1, num(1), r2, num(1)])).toMatchObject({
      kind: 'error',
      code: '#VALUE!',
    })
  })

  test('error cell in any range disqualifies that row', () => {
    const r1 = range1D([num(1), errVal('#REF!'), num(1)])
    const r2 = range1D([str('a'), str('a'), str('a')])
    // Row 0: 1 & a → match. Row 1: error → skip. Row 2: 1 & a → match. = 2.
    expect(call(COUNTIFS, [r1, num(1), r2, str('a')])).toEqual(num(2))
  })

  test('criterion error propagates', () => {
    const r1 = range1D([num(1), num(2)])
    const r2 = range1D([num(1), num(2)])
    expect(call(COUNTIFS, [r1, errVal('#VALUE!'), r2, num(1)])).toEqual(errVal('#VALUE!'))
  })

  test('comparison + wildcard combo', () => {
    const r1 = range1D([str('apple'), str('apricot'), str('banana'), str('blueberry')])
    const r2 = range1D([num(1), num(2), num(3), num(4)])
    // starts with "a" AND > 1 → only apricot (index 1)
    expect(call(COUNTIFS, [r1, str('a*'), r2, str('>1')])).toEqual(num(1))
  })

  test('odd args → #VALUE!', () => {
    expect(call(COUNTIFS, [range1D([num(1)]), num(1), range1D([num(1)])])).toMatchObject({
      kind: 'error',
      code: '#VALUE!',
    })
  })

  test('no args → #VALUE!', () => {
    expect(call(COUNTIFS, [])).toMatchObject({ kind: 'error', code: '#VALUE!' })
  })

  test('2-D range flattens row-major', () => {
    const r1 = range2D([
      [num(1), num(2)],
      [num(3), num(2)],
    ])
    expect(call(COUNTIFS, [r1, num(2)])).toEqual(num(2))
  })
})

// ---------------------------------------------------------------------------
// SUMIFS
// ---------------------------------------------------------------------------

describe('SUMIFS', () => {
  const SUMIFS = FUNCTIONS.SUMIFS

  test('SUMIFS sums sum_range where all conditions hold', () => {
    const sum = range1D([num(10), num(20), num(30), num(40)])
    const r1 = range1D([str('A'), str('A'), str('B'), str('A')])
    const r2 = range1D([num(1), num(2), num(1), num(2)])
    // A & 2 → indices 1, 3 → sum 20 + 40
    expect(call(SUMIFS, [sum, r1, str('A'), r2, num(2)])).toEqual(num(60))
  })

  test('SUMIFS with single condition matches SUMIF semantics', () => {
    const sum = range1D([num(10), num(20), num(30), num(40)])
    const r1 = range1D([str('A'), str('B'), str('A'), str('B')])
    expect(call(SUMIFS, [sum, r1, str('A')])).toEqual(num(40))
  })

  test('SUMIFS shape mismatch between sum_range and criteria_range → #VALUE!', () => {
    const sum = range1D([num(10), num(20)])
    const r1 = range1D([num(1), num(2), num(3)])
    expect(call(SUMIFS, [sum, r1, num(1)])).toMatchObject({ kind: 'error', code: '#VALUE!' })
  })

  test('SUMIFS skips error cells in criterion range, propagates sum_range errors', () => {
    const sum = range1D([num(10), num(20), num(30)])
    const r1 = range1D([num(1), errVal('#REF!'), num(1)])
    // Index 1 is skipped (error in r1). Index 0 and 2 sum_range are valid.
    expect(call(SUMIFS, [sum, r1, num(1)])).toEqual(num(40))
  })

  test('SUMIFS with comparison criterion', () => {
    const sum = range1D([num(100), num(200), num(300), num(400)])
    const ages = range1D([num(20), num(30), num(40), num(50)])
    // ">25" → indices 1, 2, 3 → sum 900
    expect(call(SUMIFS, [sum, ages, str('>25')])).toEqual(num(900))
  })

  test('SUMIFS with wildcard', () => {
    const sum = range1D([num(1), num(2), num(3), num(4)])
    const names = range1D([str('Alice'), str('Andrew'), str('Bob'), str('Annie')])
    expect(call(SUMIFS, [sum, names, str('A*')])).toEqual(num(7))
  })

  test('SUMIFS criterion error propagates', () => {
    const sum = range1D([num(1), num(2)])
    const r1 = range1D([num(1), num(2)])
    expect(call(SUMIFS, [sum, r1, errVal('#REF!')])).toEqual(errVal('#REF!'))
  })

  test('SUMIFS even-args layout → #VALUE!', () => {
    // SUMIFS expects sum_range + (range, criterion) pairs → odd count.
    expect(call(SUMIFS, [num(1), num(2)])).toMatchObject({ kind: 'error', code: '#VALUE!' })
  })

  test('SUMIFS two conditions narrow the sum', () => {
    const sum = range1D([num(10), num(10), num(10), num(10)])
    const r1 = range1D([str('A'), str('A'), str('B'), str('B')])
    const r2 = range1D([str('x'), str('y'), str('x'), str('y')])
    // A & x → only index 0 → sum 10
    expect(call(SUMIFS, [sum, r1, str('A'), r2, str('x')])).toEqual(num(10))
  })

  test('SUMIFS with non-numeric sum_range cells silently skipped', () => {
    const sum = range1D([num(10), str('oops'), num(30)])
    const r1 = range1D([str('a'), str('a'), str('a')])
    expect(call(SUMIFS, [sum, r1, str('a')])).toEqual(num(40))
  })
})

// ---------------------------------------------------------------------------
// matchesCriterion edge cases (probed via COUNTIF)
// ---------------------------------------------------------------------------

describe('criterion edge cases', () => {
  const COUNTIF = FUNCTIONS.COUNTIF

  test('comparison against blanks returns false (no implicit numeric coercion)', () => {
    const range = range1D([blank(), num(0), blank()])
    // ">-1" — blanks coerce to 0 numerically? Excel says blanks are *not*
    // matched by ordered comparison criteria. The 0 cell is counted.
    expect(call(COUNTIF, [range, str('>-1')])).toEqual(num(1))
  })

  test('number criterion does not match a string cell that looks numeric', () => {
    const range = range1D([num(5), str('5'), str('hello')])
    expect(call(COUNTIF, [range, num(5)])).toEqual(num(1))
  })

  test('"=5" string criterion behaves identically to bare 5', () => {
    const range = range1D([num(5), num(5), num(6)])
    expect(call(COUNTIF, [range, str('=5')])).toEqual(num(2))
  })

  test('"<>5" excludes the 5s', () => {
    const range = range1D([num(5), num(5), num(6), num(7)])
    expect(call(COUNTIF, [range, str('<>5')])).toEqual(num(2))
  })

  test('blank cell matches "" empty-string criterion', () => {
    const range = range1D([blank(), str(''), num(1)])
    // Blank == "" → both qualify, 1 does not.
    expect(call(COUNTIF, [range, str('')])).toEqual(num(2))
  })
})
