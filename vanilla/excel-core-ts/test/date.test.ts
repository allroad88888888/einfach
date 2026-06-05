/**
 * Wave C / C5 — date function tests.
 *
 * Pinned serials are verified against Excel for compatibility. The
 * 1900 leap-year bug is explicitly covered: DATE(1900, 2, 29) returns
 * serial 60 and serials >= 61 align with the post-phantom calendar.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'

import { FUNCTIONS } from '../src/eval/functions/date'
import type { EvalContext, FunctionImpl, Value } from '../src/types'

// A minimal stub context — date functions don't consult any field.
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
const err = (code: '#NUM!' | '#VALUE!' | '#REF!'): Value => ({ kind: 'error', code })

// ---------------------------------------------------------------------------
// DATE
// ---------------------------------------------------------------------------

describe('DATE', () => {
  const DATE = FUNCTIONS.DATE

  test('DATE(2024, 1, 1) === 45292 (Excel canonical)', () => {
    expect(call(DATE, [num(2024), num(1), num(1)])).toEqual(num(45292))
  })

  test('DATE(1900, 1, 1) === 1', () => {
    expect(call(DATE, [num(1900), num(1), num(1)])).toEqual(num(1))
  })

  test('DATE(1900, 2, 28) === 59 and DATE(1900, 3, 1) === 61', () => {
    expect(call(DATE, [num(1900), num(2), num(28)])).toEqual(num(59))
    expect(call(DATE, [num(1900), num(3), num(1)])).toEqual(num(61))
  })

  test('DATE(1900, 2, 29) === 60 (Excel 1900 leap-bug)', () => {
    expect(call(DATE, [num(1900), num(2), num(29)])).toEqual(num(60))
  })

  test('month overflow rolls forward — DATE(2024, 14, 1) === 2025-02-01 serial', () => {
    const got = call(DATE, [num(2024), num(14), num(1)]) as Value & { kind: 'number' }
    // 2025-02-01: Days from 1899-12-31 = ... use DATE(2025, 2, 1) as the
    // reference to anchor the assertion without re-deriving the math.
    const ref = call(DATE, [num(2025), num(2), num(1)])
    expect(got).toEqual(ref)
  })

  test('day overflow rolls forward — DATE(2024, 1, 32) === 2024-02-01', () => {
    expect(call(DATE, [num(2024), num(1), num(32)])).toEqual(call(DATE, [num(2024), num(2), num(1)]))
  })

  test('years 0..1899 add 1900 and negative years return #NUM!', () => {
    expect(call(DATE, [num(99), num(1), num(1)])).toEqual(
      call(DATE, [num(1999), num(1), num(1)]),
    )
    expect(call(DATE, [num(0), num(1), num(1)])).toEqual(num(1))
    expect(call(DATE, [num(-1), num(1), num(1)])).toEqual(err('#NUM!'))
  })

  test('arity mismatch returns #VALUE!', () => {
    expect(call(DATE, [num(2024), num(1)])).toMatchObject({ kind: 'error', code: '#VALUE!' })
    expect(call(DATE, [])).toMatchObject({ kind: 'error', code: '#VALUE!' })
  })

  test('error in any arg propagates', () => {
    expect(call(DATE, [err('#REF!'), num(1), num(1)])).toEqual(err('#REF!'))
    expect(call(DATE, [num(2024), err('#VALUE!'), num(1)])).toEqual(err('#VALUE!'))
  })

  test('coerces string args via toNumber', () => {
    expect(call(DATE, [str('2024'), str('1'), str('1')])).toEqual(num(45292))
  })

  test('truncates fractional args', () => {
    expect(call(DATE, [num(2024.7), num(1.3), num(1.9)])).toEqual(num(45292))
  })
})

// ---------------------------------------------------------------------------
// YEAR / MONTH / DAY
// ---------------------------------------------------------------------------

describe('YEAR / MONTH / DAY', () => {
  const { YEAR, MONTH, DAY } = FUNCTIONS

  test('YEAR/MONTH/DAY of serial 45292 → 2024 / 1 / 1', () => {
    expect(call(YEAR, [num(45292)])).toEqual(num(2024))
    expect(call(MONTH, [num(45292)])).toEqual(num(1))
    expect(call(DAY, [num(45292)])).toEqual(num(1))
  })

  test('YEAR/MONTH/DAY of serial 1 → 1900 / 1 / 1', () => {
    expect(call(YEAR, [num(1)])).toEqual(num(1900))
    expect(call(MONTH, [num(1)])).toEqual(num(1))
    expect(call(DAY, [num(1)])).toEqual(num(1))
  })

  test('serial 60 reports as 1900-02-29 (Excel phantom)', () => {
    expect(call(YEAR, [num(60)])).toEqual(num(1900))
    expect(call(MONTH, [num(60)])).toEqual(num(2))
    expect(call(DAY, [num(60)])).toEqual(num(29))
  })

  test('serial 61 reports as 1900-03-01', () => {
    expect(call(YEAR, [num(61)])).toEqual(num(1900))
    expect(call(MONTH, [num(61)])).toEqual(num(3))
    expect(call(DAY, [num(61)])).toEqual(num(1))
  })

  test('end-of-year boundary: serial 45657 → 2024-12-31', () => {
    // DATE(2024, 12, 31) should give 45657
    const dec31 = call(FUNCTIONS.DATE, [num(2024), num(12), num(31)]) as Value & { kind: 'number' }
    expect(dec31.value).toBe(45657)
    expect(call(YEAR, [num(45657)])).toEqual(num(2024))
    expect(call(MONTH, [num(45657)])).toEqual(num(12))
    expect(call(DAY, [num(45657)])).toEqual(num(31))
  })

  test('negative serial → #NUM!', () => {
    expect(call(YEAR, [num(-1)])).toEqual(err('#NUM!'))
    expect(call(MONTH, [num(-1)])).toEqual(err('#NUM!'))
    expect(call(DAY, [num(-1)])).toEqual(err('#NUM!'))
  })

  test('error arg propagates', () => {
    expect(call(YEAR, [err('#REF!')])).toEqual(err('#REF!'))
  })

  test('truncates fractional serial', () => {
    expect(call(YEAR, [num(45292.7)])).toEqual(num(2024))
    expect(call(MONTH, [num(45292.7)])).toEqual(num(1))
    expect(call(DAY, [num(45292.7)])).toEqual(num(1))
  })

  test('arity != 1 returns #VALUE!', () => {
    expect(call(YEAR, [])).toMatchObject({ kind: 'error', code: '#VALUE!' })
    expect(call(MONTH, [num(1), num(2)])).toMatchObject({ kind: 'error', code: '#VALUE!' })
  })

  test('boolean coerced via toNumber', () => {
    // TRUE → 1 → 1900-01-01
    expect(call(YEAR, [bool(true)])).toEqual(num(1900))
  })
})

// ---------------------------------------------------------------------------
// WEEKDAY
// ---------------------------------------------------------------------------

describe('WEEKDAY', () => {
  const WEEKDAY = FUNCTIONS.WEEKDAY

  test('WEEKDAY(1) === 1 (1900-01-01 Sun in Excel-compat)', () => {
    expect(call(WEEKDAY, [num(1)])).toEqual(num(1))
  })

  test('WEEKDAY(7) === 7 (Sat)', () => {
    expect(call(WEEKDAY, [num(7)])).toEqual(num(7))
  })

  test('WEEKDAY(45292) === 2 (Mon — 2024-01-01)', () => {
    // 2024-01-01 was actually a Monday.
    expect(call(WEEKDAY, [num(45292)])).toEqual(num(2))
  })

  test('WEEKDAY with return_type=2 maps Mon→1', () => {
    // 2024-01-01 is Monday → 1
    expect(call(WEEKDAY, [num(45292), num(2)])).toEqual(num(1))
  })

  test('WEEKDAY with return_type=3 maps Mon→0', () => {
    expect(call(WEEKDAY, [num(45292), num(3)])).toEqual(num(0))
  })

  test('WEEKDAY(7, 2) === 6 (Sat in Mon=1 scheme)', () => {
    // Saturday in return_type=2: Mon=1..Sun=7 → Sat=6
    expect(call(WEEKDAY, [num(7), num(2)])).toEqual(num(6))
  })

  test('invalid return_type → #NUM!', () => {
    expect(call(WEEKDAY, [num(1), num(0)])).toMatchObject({ kind: 'error', code: '#NUM!' })
    expect(call(WEEKDAY, [num(1), num(99)])).toMatchObject({ kind: 'error', code: '#NUM!' })
    expect(call(WEEKDAY, [num(1), num(10)])).toMatchObject({ kind: 'error', code: '#NUM!' })
    expect(call(WEEKDAY, [num(1), num(18)])).toMatchObject({ kind: 'error', code: '#NUM!' })
  })

  // 2024-01-01 = Monday, serial 45292. Walk through types 11..17 — each
  // type N anchors weekday (N-11) as "1" (Mon=0..Sun=6).
  test('WEEKDAY return_type 11 (Mon=1..Sun=7) — alias of 2', () => {
    expect(call(WEEKDAY, [num(45292), num(11)])).toEqual(num(1)) // Mon → 1
    expect(call(WEEKDAY, [num(45292 + 6), num(11)])).toEqual(num(7)) // Sun → 7
  })

  test('WEEKDAY return_type 12 (Tue=1..Mon=7)', () => {
    expect(call(WEEKDAY, [num(45292), num(12)])).toEqual(num(7)) // Mon → 7
    expect(call(WEEKDAY, [num(45292 + 1), num(12)])).toEqual(num(1)) // Tue → 1
  })

  test('WEEKDAY return_type 13 (Wed=1..Tue=7)', () => {
    expect(call(WEEKDAY, [num(45292), num(13)])).toEqual(num(6)) // Mon → 6
    expect(call(WEEKDAY, [num(45292 + 2), num(13)])).toEqual(num(1)) // Wed → 1
  })

  test('WEEKDAY return_type 14 (Thu=1..Wed=7)', () => {
    expect(call(WEEKDAY, [num(45292 + 3), num(14)])).toEqual(num(1)) // Thu → 1
    expect(call(WEEKDAY, [num(45292), num(14)])).toEqual(num(5)) // Mon → 5
  })

  test('WEEKDAY return_type 15 (Fri=1..Thu=7)', () => {
    expect(call(WEEKDAY, [num(45292 + 4), num(15)])).toEqual(num(1)) // Fri → 1
    expect(call(WEEKDAY, [num(45292), num(15)])).toEqual(num(4)) // Mon → 4
  })

  test('WEEKDAY return_type 16 (Sat=1..Fri=7)', () => {
    expect(call(WEEKDAY, [num(45292 + 5), num(16)])).toEqual(num(1)) // Sat → 1
    expect(call(WEEKDAY, [num(45292), num(16)])).toEqual(num(3)) // Mon → 3
  })

  test('WEEKDAY return_type 17 (Sun=1..Sat=7) — alias of 1', () => {
    expect(call(WEEKDAY, [num(45292 + 6), num(17)])).toEqual(num(1)) // Sun → 1
    expect(call(WEEKDAY, [num(45292), num(17)])).toEqual(num(2)) // Mon → 2
  })

  test('error arg propagates', () => {
    expect(call(WEEKDAY, [err('#REF!')])).toEqual(err('#REF!'))
  })

  test('arity 0 or 3+ → #VALUE!', () => {
    expect(call(WEEKDAY, [])).toMatchObject({ kind: 'error', code: '#VALUE!' })
    expect(call(WEEKDAY, [num(1), num(1), num(1)])).toMatchObject({
      kind: 'error',
      code: '#VALUE!',
    })
  })
})

// ---------------------------------------------------------------------------
// TODAY / NOW — non-deterministic, use fake timers
// ---------------------------------------------------------------------------

describe('TODAY', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  test('TODAY() returns serial for the current UTC date (no time)', () => {
    // Pin to 2024-01-01 12:34:56 UTC. Serial of the date == 45292.
    jest.setSystemTime(new Date(Date.UTC(2024, 0, 1, 12, 34, 56)))
    expect(call(FUNCTIONS.TODAY, [])).toEqual(num(45292))
  })

  test('TODAY() truncates time-of-day to midnight UTC', () => {
    jest.setSystemTime(new Date(Date.UTC(2024, 0, 1, 23, 59, 59)))
    expect(call(FUNCTIONS.TODAY, [])).toEqual(num(45292))
  })

  test('TODAY() shifts on the next UTC day', () => {
    jest.setSystemTime(new Date(Date.UTC(2024, 0, 2, 0, 0, 1)))
    expect(call(FUNCTIONS.TODAY, [])).toEqual(num(45293))
  })

  test('TODAY() with args → #VALUE!', () => {
    expect(call(FUNCTIONS.TODAY, [num(1)])).toMatchObject({ kind: 'error', code: '#VALUE!' })
  })
})

describe('NOW', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  test('NOW() returns serial + 0.5 at noon UTC', () => {
    jest.setSystemTime(new Date(Date.UTC(2024, 0, 1, 12, 0, 0)))
    const out = call(FUNCTIONS.NOW, []) as Value & { kind: 'number' }
    expect(out.kind).toBe('number')
    expect(out.value).toBeCloseTo(45292.5, 10)
  })

  test('NOW() at midnight UTC equals TODAY()', () => {
    jest.setSystemTime(new Date(Date.UTC(2024, 0, 1, 0, 0, 0)))
    expect(call(FUNCTIONS.NOW, [])).toEqual(num(45292))
  })

  test('NOW() fractional component is in [0, 1)', () => {
    jest.setSystemTime(new Date(Date.UTC(2024, 0, 1, 18, 0, 0)))
    const out = call(FUNCTIONS.NOW, []) as Value & { kind: 'number' }
    const whole = Math.floor(out.value)
    const frac = out.value - whole
    expect(whole).toBe(45292)
    expect(frac).toBeGreaterThanOrEqual(0)
    expect(frac).toBeLessThan(1)
    expect(frac).toBeCloseTo(0.75, 10)
  })

  test('NOW() with args → #VALUE!', () => {
    expect(call(FUNCTIONS.NOW, [num(1)])).toMatchObject({ kind: 'error', code: '#VALUE!' })
  })
})

// ---------------------------------------------------------------------------
// Round-trip — DATE / YEAR / MONTH / DAY consistency
// ---------------------------------------------------------------------------

describe('DATE ↔ YEAR/MONTH/DAY round-trip', () => {
  const { DATE, YEAR, MONTH, DAY } = FUNCTIONS

  const samples: Array<[number, number, number]> = [
    [1900, 1, 1],
    [1900, 3, 1],
    [1999, 12, 31],
    [2000, 1, 1],
    [2000, 2, 29], // real leap year
    [2024, 6, 15],
    [2100, 3, 1], // 2100 is NOT a leap year
  ]

  test.each(samples)('round-trip DATE(%i, %i, %i)', (y, m, d) => {
    const serial = call(DATE, [num(y), num(m), num(d)]) as Value & { kind: 'number' }
    expect(serial.kind).toBe('number')
    expect(call(YEAR, [serial])).toEqual(num(y))
    expect(call(MONTH, [serial])).toEqual(num(m))
    expect(call(DAY, [serial])).toEqual(num(d))
  })

  test('blank arg coerces to 0 — DATE(1900, 1, 0) returns serial 0 → #NUM!?', () => {
    // DATE(1900, 1, 0) means "the day before 1900-01-01" which is
    // 1899-12-31 in JS — serial 0 in our anchor (>= 0 is fine).
    const v = call(DATE, [num(1900), num(1), blank()]) as Value & { kind: 'number' }
    expect(v.kind).toBe('number')
    expect(v.value).toBe(0)
  })
})
