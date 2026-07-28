/**
 * Phase 8 — stats function additions tests.
 *
 * Covers MEDIAN, MODE, STDEV(P), VAR(P), LARGE, SMALL, PERCENTILE,
 * QUARTILE, RANK, AVERAGEIF(S), MAXIFS, MINIFS, CORREL, SLOPE,
 * INTERCEPT, AVERAGEA. Function impls are not exported from stats.ts —
 * we go through the registry barrel.
 */

import { describe, expect, test } from '@jest/globals'

import { FUNCTIONS } from '../src/eval/functions/stats'
import type { EvalContext, FunctionImpl, Value } from '../src/types'

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const STR = (s: string): Value => ({ kind: 'string', value: s })
const BLANK: Value = { kind: 'blank' }
const ERR = (code: '#DIV/0!' | '#N/A' | '#NUM!' | '#VALUE!'): Value => ({
  kind: 'error',
  code,
})
const ARR = (rows: Value[][]): Value => ({ kind: 'array', value: rows })

const ctx: EvalContext = new Proxy(
  {},
  {
    get(_, prop) {
      throw new Error(`phase8 stats unexpectedly read ctx.${String(prop)}`)
    },
  },
) as unknown as EvalContext

const get = (name: string): FunctionImpl => {
  const f = FUNCTIONS[name]
  if (!f) throw new Error(`No function ${name} in registry`)
  return f
}
const call = (name: string, args: Value[]): Value => get(name)(args, ctx)

const asNumber = (v: Value): number => {
  if (v.kind !== 'number') throw new Error(`expected number, got ${JSON.stringify(v)}`)
  return v.value
}

describe('MEDIAN', () => {
  test('odd count: middle value', () =>
    expect(call('MEDIAN', [NUM(1), NUM(3), NUM(5)])).toEqual(NUM(3)))
  test('even count: average of two middle', () =>
    expect(call('MEDIAN', [NUM(1), NUM(2), NUM(3), NUM(4)])).toEqual(NUM(2.5)))
  test('empty → #NUM!', () => expect(call('MEDIAN', [])).toEqual(ERR('#NUM!')))
})

describe('MODE', () => {
  test('returns most frequent', () =>
    expect(call('MODE', [NUM(1), NUM(2), NUM(2), NUM(3)])).toEqual(NUM(2)))
  test('all unique → #N/A', () =>
    expect(call('MODE', [NUM(1), NUM(2), NUM(3)])).toEqual(ERR('#N/A')))
  test('single value → #N/A', () => expect(call('MODE', [NUM(5)])).toEqual(ERR('#N/A')))
})

describe('STDEV (sample)', () => {
  test('STDEV([2,4,4,4,5,5,7,9]) ≈ 2.138', () => {
    const r = asNumber(call('STDEV', [NUM(2), NUM(4), NUM(4), NUM(4), NUM(5), NUM(5), NUM(7), NUM(9)]))
    expect(r).toBeCloseTo(2.138, 3)
  })
  test('single value → #DIV/0!', () => expect(call('STDEV', [NUM(5)])).toEqual(ERR('#DIV/0!')))
  test('error propagates', () =>
    expect(call('STDEV', [NUM(1), ERR('#N/A')])).toEqual(ERR('#N/A')))
})

describe('STDEVP (population)', () => {
  test('STDEVP([2,4,4,4,5,5,7,9]) = 2', () => {
    const r = asNumber(
      call('STDEVP', [NUM(2), NUM(4), NUM(4), NUM(4), NUM(5), NUM(5), NUM(7), NUM(9)]),
    )
    expect(r).toBeCloseTo(2, 6)
  })
  test('empty → #DIV/0!', () => expect(call('STDEVP', [])).toEqual(ERR('#DIV/0!')))
  test('single value → 0', () => expect(asNumber(call('STDEVP', [NUM(5)]))).toBeCloseTo(0, 6))
})

describe('VAR / VARP', () => {
  test('VAR sample variance', () => {
    const r = asNumber(call('VAR', [NUM(1), NUM(2), NUM(3), NUM(4), NUM(5)]))
    expect(r).toBeCloseTo(2.5, 6)
  })
  test('VARP population variance', () => {
    const r = asNumber(call('VARP', [NUM(1), NUM(2), NUM(3), NUM(4), NUM(5)]))
    expect(r).toBeCloseTo(2, 6)
  })
  test('VAR single → #DIV/0!', () => expect(call('VAR', [NUM(5)])).toEqual(ERR('#DIV/0!')))
})

describe('LARGE / SMALL', () => {
  test('LARGE: 2nd largest', () =>
    expect(call('LARGE', [ARR([[NUM(3), NUM(1), NUM(5), NUM(4)]]), NUM(2)])).toEqual(NUM(4)))
  test('SMALL: 1st smallest', () =>
    expect(call('SMALL', [ARR([[NUM(3), NUM(1), NUM(5), NUM(4)]]), NUM(1)])).toEqual(NUM(1)))
  test('LARGE k > length → #NUM!', () =>
    expect(call('LARGE', [ARR([[NUM(1), NUM(2)]]), NUM(5)])).toEqual(ERR('#NUM!')))
})

describe('PERCENTILE', () => {
  test('PERCENTILE 0.5 = median', () =>
    expect(asNumber(call('PERCENTILE', [ARR([[NUM(1), NUM(2), NUM(3), NUM(4), NUM(5)]]), NUM(0.5)]))).toBeCloseTo(
      3,
      6,
    ))
  test('PERCENTILE 0 = min', () =>
    expect(call('PERCENTILE', [ARR([[NUM(1), NUM(2), NUM(3)]]), NUM(0)])).toEqual(NUM(1)))
  test('PERCENTILE 1 = max', () =>
    expect(call('PERCENTILE', [ARR([[NUM(1), NUM(2), NUM(3)]]), NUM(1)])).toEqual(NUM(3)))
  test('out of range → #NUM!', () =>
    expect(call('PERCENTILE', [ARR([[NUM(1), NUM(2)]]), NUM(2)])).toEqual(ERR('#NUM!')))
})

describe('QUARTILE', () => {
  test('Q2 = median', () =>
    expect(asNumber(call('QUARTILE', [ARR([[NUM(1), NUM(2), NUM(3), NUM(4), NUM(5)]]), NUM(2)]))).toBeCloseTo(
      3,
      6,
    ))
  test('Q0 = min', () =>
    expect(call('QUARTILE', [ARR([[NUM(1), NUM(2), NUM(3)]]), NUM(0)])).toEqual(NUM(1)))
  test('Q5 → #NUM!', () =>
    expect(call('QUARTILE', [ARR([[NUM(1)]]), NUM(5)])).toEqual(ERR('#NUM!')))
})

describe('RANK', () => {
  test('descending default', () =>
    expect(call('RANK', [NUM(5), ARR([[NUM(3), NUM(5), NUM(7), NUM(1)]])])).toEqual(NUM(2)))
  test('ascending order', () =>
    expect(call('RANK', [NUM(5), ARR([[NUM(3), NUM(5), NUM(7), NUM(1)]]), NUM(1)])).toEqual(
      NUM(3),
    ))
  test('value not in list → #N/A', () =>
    expect(call('RANK', [NUM(99), ARR([[NUM(1), NUM(2)]])])).toEqual(ERR('#N/A')))
})

describe('AVERAGEIF', () => {
  test('count + sum matching', () =>
    expect(
      call('AVERAGEIF', [ARR([[NUM(1), NUM(2), NUM(3), NUM(4)]]), STR('>2')]),
    ).toEqual(NUM(3.5)))
  test('with separate avgRange', () =>
    expect(
      call('AVERAGEIF', [
        ARR([[NUM(1), NUM(2), NUM(3)]]),
        STR('>1'),
        ARR([[NUM(10), NUM(20), NUM(30)]]),
      ]),
    ).toEqual(NUM(25)))
  test('criteria range errors propagate', () =>
    expect(call('AVERAGEIF', [ARR([[ERR('#VALUE!')]]), STR('x'), ARR([[NUM(10)]])])).toEqual(
      ERR('#VALUE!'),
    ))
  test('averageRange must match criteria range shape', () =>
    expect(
      call('AVERAGEIF', [ARR([[STR('x'), STR('x')]]), STR('x'), ARR([[NUM(10)]])]),
    ).toEqual(ERR('#VALUE!')))
  test('no matches → #DIV/0!', () =>
    expect(call('AVERAGEIF', [ARR([[NUM(1)]]), STR('>5')])).toEqual(ERR('#DIV/0!')))
})

describe('AVERAGEIFS', () => {
  test('multi-criteria AND', () =>
    expect(
      call('AVERAGEIFS', [
        ARR([[NUM(10), NUM(20), NUM(30), NUM(40)]]), // avg range
        ARR([[NUM(1), NUM(2), NUM(3), NUM(4)]]), // range1
        STR('>=2'),
        ARR([[NUM(1), NUM(2), NUM(3), NUM(4)]]), // range2
        STR('<=3'),
      ]),
    ).toEqual(NUM(25)))
  test('no matches → #DIV/0!', () =>
    expect(
      call('AVERAGEIFS', [ARR([[NUM(10), NUM(20)]]), ARR([[NUM(1), NUM(2)]]), STR('>9')]),
    ).toEqual(ERR('#DIV/0!')))
  test('mismatched shapes → #VALUE!', () =>
    expect(
      call('AVERAGEIFS', [ARR([[NUM(10), NUM(20)]]), ARR([[NUM(1)]]), STR('>0')]),
    ).toEqual(ERR('#VALUE!')))
  test('same flat length but different shape → #VALUE!', () =>
    expect(
      call('AVERAGEIFS', [ARR([[NUM(10)], [NUM(20)]]), ARR([[NUM(1), NUM(2)]]), STR('>0')]),
    ).toEqual(ERR('#VALUE!')))
  test('criteria range errors propagate', () =>
    expect(
      call('AVERAGEIFS', [ARR([[NUM(10)]]), ARR([[ERR('#VALUE!')]]), STR('x')]),
    ).toEqual(ERR('#VALUE!')))
})

describe('MAXIFS / MINIFS', () => {
  test('MAXIFS picks largest passing criterion', () =>
    expect(
      call('MAXIFS', [
        ARR([[NUM(10), NUM(20), NUM(30)]]),
        ARR([[NUM(1), NUM(2), NUM(3)]]),
        STR('<3'),
      ]),
    ).toEqual(NUM(20)))
  test('MINIFS picks smallest passing criterion', () =>
    expect(
      call('MINIFS', [
        ARR([[NUM(10), NUM(20), NUM(30)]]),
        ARR([[NUM(1), NUM(2), NUM(3)]]),
        STR('>=2'),
      ]),
    ).toEqual(NUM(20)))
  test('MAXIFS no matches → 0', () =>
    expect(
      call('MAXIFS', [ARR([[NUM(1), NUM(2)]]), ARR([[NUM(5), NUM(6)]]), STR('>99')]),
    ).toEqual(NUM(0)))
  test('MAXIFS / MINIFS reject shape transposes', () => {
    const args = [ARR([[NUM(10)], [NUM(20)]]), ARR([[NUM(1), NUM(2)]]), STR('>0')]
    expect(call('MAXIFS', args)).toEqual(ERR('#VALUE!'))
    expect(call('MINIFS', args)).toEqual(ERR('#VALUE!'))
  })
  test('MAXIFS / MINIFS propagate criteria range errors', () => {
    const args = [ARR([[NUM(10)]]), ARR([[ERR('#VALUE!')]]), STR('x')]
    expect(call('MAXIFS', args)).toEqual(ERR('#VALUE!'))
    expect(call('MINIFS', args)).toEqual(ERR('#VALUE!'))
  })
})

describe('CORREL', () => {
  test('perfect positive correlation', () =>
    expect(
      asNumber(
        call('CORREL', [ARR([[NUM(1), NUM(2), NUM(3)]]), ARR([[NUM(2), NUM(4), NUM(6)]])]),
      ),
    ).toBeCloseTo(1, 6))
  test('perfect negative correlation', () =>
    expect(
      asNumber(
        call('CORREL', [ARR([[NUM(1), NUM(2), NUM(3)]]), ARR([[NUM(6), NUM(4), NUM(2)]])]),
      ),
    ).toBeCloseTo(-1, 6))
  test('mismatched lengths → #N/A', () =>
    expect(call('CORREL', [ARR([[NUM(1), NUM(2)]]), ARR([[NUM(1)]])])).toEqual(ERR('#N/A')))
  test('filters non-numeric values pairwise', () =>
    expect(
      asNumber(
        call('CORREL', [
          ARR([[NUM(1), STR('skip'), NUM(3)]]),
          ARR([[NUM(10), NUM(999), NUM(30)]]),
        ]),
      ),
    ).toBeCloseTo(1, 6))
})

describe('SLOPE / INTERCEPT', () => {
  test('SLOPE for y = 2x + 1', () =>
    expect(
      asNumber(call('SLOPE', [ARR([[NUM(3), NUM(5), NUM(7)]]), ARR([[NUM(1), NUM(2), NUM(3)]])])),
    ).toBeCloseTo(2, 6))
  test('INTERCEPT for y = 2x + 1', () =>
    expect(
      asNumber(
        call('INTERCEPT', [ARR([[NUM(3), NUM(5), NUM(7)]]), ARR([[NUM(1), NUM(2), NUM(3)]])]),
      ),
    ).toBeCloseTo(1, 6))
  test('SLOPE on constant x → #DIV/0!', () =>
    expect(call('SLOPE', [ARR([[NUM(1), NUM(2)]]), ARR([[NUM(5), NUM(5)]])])).toEqual(
      ERR('#DIV/0!'),
    ))
  test('filters non-numeric known_y / known_x pairs together', () => {
    const ys = ARR([[NUM(3), STR('skip'), NUM(7)]])
    const xs = ARR([[NUM(1), NUM(2), NUM(3)]])
    expect(asNumber(call('SLOPE', [ys, xs]))).toBeCloseTo(2, 6)
    expect(asNumber(call('INTERCEPT', [ys, xs]))).toBeCloseTo(1, 6)
  })
})

describe('COVARIANCE', () => {
  test('filters non-numeric values pairwise', () => {
    const a = ARR([[NUM(1), STR('skip'), NUM(3)]])
    const b = ARR([[NUM(10), NUM(999), NUM(30)]])
    expect(asNumber(call('COVARIANCE.P', [a, b]))).toBeCloseTo(10, 6)
    expect(asNumber(call('COVARIANCE.S', [a, b]))).toBeCloseTo(20, 6)
  })
})

describe('AVERAGEA', () => {
  test('text counts as 0', () =>
    expect(call('AVERAGEA', [ARR([[NUM(10), STR('hi')]])])).toEqual(NUM(5)))
  test('booleans count', () =>
    expect(asNumber(call('AVERAGEA', [ARR([[NUM(1), { kind: 'boolean', value: true }]])]))).toBe(1))
  test('empty → #DIV/0!', () => expect(call('AVERAGEA', [])).toEqual(ERR('#DIV/0!')))
  test('blank skipped', () => expect(call('AVERAGEA', [NUM(10), BLANK])).toEqual(NUM(10)))
})
