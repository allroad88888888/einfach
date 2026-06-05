/**
 * Wave C / C1 — math function tests.
 *
 * Drives each `FunctionImpl` in `src/eval/functions/math.ts` directly with
 * hand-built `Value[]`. No parser, no evaluator, no atoms — these tests
 * verify the per-function contract:
 *   1. happy path (canonical inputs)
 *   2. error propagation (a positional error wins, verbatim)
 *   3. type coercion (string → number, boolean → 0/1, blank → 0)
 *   4. edge case (negative digits / negative dividend / 0^0 / sqrt(-1))
 *
 * Aggregations (SUM/AVERAGE/MIN/MAX/COUNT/COUNTA) additionally cover the
 * Excel "array ignores text, scalar coerces text" split that's easy to
 * regress when a future agent refactors the helpers.
 */

import { describe, expect, test } from '@jest/globals'

import {
  ABS,
  AVERAGE,
  CEILING,
  COUNT,
  COUNTA,
  FLOOR,
  FUNCTIONS,
  INT,
  MAX,
  MIN,
  MOD,
  POWER,
  PRODUCT,
  ROUND,
  ROUNDDOWN,
  ROUNDUP,
  SIGN,
  SQRT,
  SUM,
  SUMPRODUCT,
  TRUNC,
} from '../src/eval/functions/math'
import type { EvalContext, FunctionImpl, Value } from '../src/types'
import { BLANK } from '../src/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const STR = (s: string): Value => ({ kind: 'string', value: s })
const BOOL = (b: boolean): Value => ({ kind: 'boolean', value: b })
const ERR = (code: '#DIV/0!' | '#N/A' | '#NUM!' | '#REF!' | '#VALUE!'): Value => ({
  kind: 'error',
  code,
})
const ARR = (rows: Value[][]): Value => ({ kind: 'array', value: rows })

// Minimal context. Math functions never read `ctx` (no refs, no ranges,
// no custom-formula dispatch) so we hand them a sentinel that throws on
// any property access — guarantees zero ctx-coupling in implementations.
const ctx: EvalContext = new Proxy(
  {},
  {
    get(_, prop) {
      throw new Error(`math function unexpectedly read ctx.${String(prop)}`)
    },
  },
) as unknown as EvalContext

function call(fn: FunctionImpl, args: Value[]): Value {
  return fn(args, ctx)
}

// ---------------------------------------------------------------------------
// SUM
// ---------------------------------------------------------------------------

describe('SUM', () => {
  test('happy path: scalar numbers add', () => {
    expect(call(SUM, [NUM(1), NUM(2), NUM(3)])).toEqual(NUM(6))
  })

  test('coerces numeric strings and booleans when passed as scalar args', () => {
    expect(call(SUM, [NUM(1), STR('5'), BOOL(true)])).toEqual(NUM(7))
  })

  test('non-numeric string scalar arg surfaces #VALUE!', () => {
    expect(call(SUM, [NUM(1), STR('abc')])).toEqual(ERR('#VALUE!'))
  })

  test('ignores text / booleans / blanks INSIDE an array (Excel range rule)', () => {
    expect(
      call(SUM, [
        ARR([
          [NUM(1), STR('hello'), BOOL(true)],
          [BLANK, NUM(2), NUM(3)],
        ]),
      ]),
    ).toEqual(NUM(6))
  })

  test('error inside array propagates verbatim', () => {
    expect(call(SUM, [ARR([[NUM(1), ERR('#DIV/0!'), NUM(3)]])])).toEqual(ERR('#DIV/0!'))
  })

  test('first scalar error wins', () => {
    expect(call(SUM, [ERR('#REF!'), ERR('#NUM!'), NUM(1)])).toEqual(ERR('#REF!'))
  })

  test('blank scalar coerces to 0', () => {
    expect(call(SUM, [NUM(5), BLANK])).toEqual(NUM(5))
  })

  test('no args → 0', () => {
    expect(call(SUM, [])).toEqual(NUM(0))
  })
})

// ---------------------------------------------------------------------------
// AVERAGE
// ---------------------------------------------------------------------------

describe('AVERAGE', () => {
  test('happy path', () => {
    expect(call(AVERAGE, [NUM(2), NUM(4), NUM(6)])).toEqual(NUM(4))
  })

  test('range/array: text and blanks not counted in denominator', () => {
    expect(
      call(AVERAGE, [
        ARR([
          [NUM(2), STR('skip'), NUM(4)],
          [BLANK, NUM(6), BOOL(true)],
        ]),
      ]),
    ).toEqual(NUM(4)) // (2+4+6) / 3
  })

  test('scalar coerces string', () => {
    expect(call(AVERAGE, [NUM(10), STR('20'), STR('30')])).toEqual(NUM(20))
  })

  test('error propagates', () => {
    expect(call(AVERAGE, [NUM(1), ERR('#N/A')])).toEqual(ERR('#N/A'))
  })

  test('no numeric values → #DIV/0!', () => {
    expect(call(AVERAGE, [ARR([[STR('a'), STR('b')]])])).toEqual(ERR('#DIV/0!'))
  })

  test('no args → #DIV/0!', () => {
    expect(call(AVERAGE, [])).toEqual(ERR('#DIV/0!'))
  })
})

// ---------------------------------------------------------------------------
// COUNT
// ---------------------------------------------------------------------------

describe('COUNT', () => {
  test('counts only numbers', () => {
    expect(
      call(COUNT, [
        ARR([
          [NUM(1), STR('2'), NUM(3)],
          [BOOL(true), BLANK, NUM(4)],
        ]),
      ]),
    ).toEqual(NUM(3))
  })

  test('scalar string is NOT counted (different from SUM!)', () => {
    expect(call(COUNT, [NUM(1), STR('5'), STR('abc')])).toEqual(NUM(1))
  })

  test('scalar boolean not counted', () => {
    expect(call(COUNT, [NUM(1), BOOL(true), BOOL(false)])).toEqual(NUM(1))
  })

  test('error in scalar arg propagates', () => {
    expect(call(COUNT, [NUM(1), ERR('#REF!')])).toEqual(ERR('#REF!'))
  })

  test('error inside array propagates (does not silently count as nothing)', () => {
    expect(call(COUNT, [ARR([[NUM(1), ERR('#VALUE!')]])])).toEqual(ERR('#VALUE!'))
  })

  test('no args → 0', () => {
    expect(call(COUNT, [])).toEqual(NUM(0))
  })
})

// ---------------------------------------------------------------------------
// COUNTA
// ---------------------------------------------------------------------------

describe('COUNTA', () => {
  test('counts every non-blank including strings and booleans', () => {
    expect(
      call(COUNTA, [
        ARR([
          [NUM(1), STR('hi'), BOOL(true)],
          [BLANK, NUM(0), STR('')],
        ]),
      ]),
    ).toEqual(NUM(5)) // 1, "hi", TRUE, 0, "" — blank excluded
  })

  test('errors in arrays count as non-blank (Excel keeps the count)', () => {
    // Excel: COUNTA over a range that contains #N/A returns N/A by
    // convention? Actually no — COUNTA counts errors too. We propagate
    // only scalar errors (per Wave C contract). The test below pins
    // the in-array behavior.
    expect(
      call(COUNTA, [ARR([[NUM(1), ERR('#N/A'), NUM(3)]])]),
    ).toEqual(NUM(3))
  })

  test('scalar error propagates', () => {
    expect(call(COUNTA, [NUM(1), ERR('#REF!')])).toEqual(ERR('#REF!'))
  })

  test('all blanks → 0', () => {
    expect(call(COUNTA, [BLANK, BLANK, ARR([[BLANK, BLANK]])])).toEqual(NUM(0))
  })
})

// ---------------------------------------------------------------------------
// MIN / MAX
// ---------------------------------------------------------------------------

describe('MIN', () => {
  test('happy path', () => {
    expect(call(MIN, [NUM(3), NUM(1), NUM(2)])).toEqual(NUM(1))
  })

  test('ignores text inside array', () => {
    expect(call(MIN, [ARR([[NUM(5), STR('huge'), NUM(2)]])])).toEqual(NUM(2))
  })

  test('coerces scalar string', () => {
    expect(call(MIN, [NUM(5), STR('-3')])).toEqual(NUM(-3))
  })

  test('error propagates', () => {
    expect(call(MIN, [NUM(1), ERR('#NUM!')])).toEqual(ERR('#NUM!'))
  })

  test('no numeric values → 0 (Excel quirk)', () => {
    expect(call(MIN, [ARR([[STR('a'), STR('b')]])])).toEqual(NUM(0))
  })

  test('negative numbers handled', () => {
    expect(call(MIN, [NUM(-5), NUM(-1), NUM(-10)])).toEqual(NUM(-10))
  })
})

describe('MAX', () => {
  test('happy path', () => {
    expect(call(MAX, [NUM(3), NUM(1), NUM(2)])).toEqual(NUM(3))
  })

  test('ignores text inside array', () => {
    expect(call(MAX, [ARR([[NUM(5), STR('huge'), NUM(2)]])])).toEqual(NUM(5))
  })

  test('coerces scalar boolean', () => {
    expect(call(MAX, [NUM(-1), BOOL(true)])).toEqual(NUM(1))
  })

  test('error propagates', () => {
    expect(call(MAX, [ERR('#DIV/0!'), NUM(100)])).toEqual(ERR('#DIV/0!'))
  })

  test('no numeric values → 0 (Excel quirk)', () => {
    expect(call(MAX, [ARR([[BLANK, STR('x')]])])).toEqual(NUM(0))
  })
})

// ---------------------------------------------------------------------------
// ROUND family
// ---------------------------------------------------------------------------

describe('ROUND', () => {
  test('happy path positive digits', () => {
    expect(call(ROUND, [NUM(2.345), NUM(2)])).toEqual(NUM(2.35))
  })

  test('rounds half AWAY from zero (Excel rule, not JS rule)', () => {
    expect(call(ROUND, [NUM(2.5), NUM(0)])).toEqual(NUM(3))
    expect(call(ROUND, [NUM(-2.5), NUM(0)])).toEqual(NUM(-3))
  })

  test('negative digits round to left of decimal', () => {
    expect(call(ROUND, [NUM(1234.567), NUM(-2)])).toEqual(NUM(1200))
  })

  test('error propagates from any arg', () => {
    expect(call(ROUND, [ERR('#VALUE!'), NUM(2)])).toEqual(ERR('#VALUE!'))
    expect(call(ROUND, [NUM(1), ERR('#NUM!')])).toEqual(ERR('#NUM!'))
  })

  test('coerces string arg', () => {
    expect(call(ROUND, [STR('3.14159'), NUM(2)])).toEqual(NUM(3.14))
  })

  test('requires digits argument', () => {
    expect(call(ROUND, [NUM(2.7)])).toEqual(ERR('#VALUE!'))
    expect(call(ROUNDUP, [NUM(2.1)])).toEqual(ERR('#VALUE!'))
    expect(call(ROUNDDOWN, [NUM(2.9)])).toEqual(ERR('#VALUE!'))
  })
})

describe('ROUNDUP', () => {
  test('always away from zero', () => {
    expect(call(ROUNDUP, [NUM(2.1), NUM(0)])).toEqual(NUM(3))
    expect(call(ROUNDUP, [NUM(-2.1), NUM(0)])).toEqual(NUM(-3))
  })

  test('negative digits', () => {
    expect(call(ROUNDUP, [NUM(123), NUM(-2)])).toEqual(NUM(200))
  })

  test('error propagates', () => {
    expect(call(ROUNDUP, [ERR('#REF!'), NUM(0)])).toEqual(ERR('#REF!'))
  })

  test('coerces blank to 0', () => {
    expect(call(ROUNDUP, [NUM(2.1), BLANK])).toEqual(NUM(3))
  })
})

describe('ROUNDDOWN', () => {
  test('always toward zero (truncate)', () => {
    expect(call(ROUNDDOWN, [NUM(2.9), NUM(0)])).toEqual(NUM(2))
    expect(call(ROUNDDOWN, [NUM(-2.9), NUM(0)])).toEqual(NUM(-2))
  })

  test('positive digits', () => {
    expect(call(ROUNDDOWN, [NUM(3.14159), NUM(3)])).toEqual(NUM(3.141))
  })

  test('negative digits', () => {
    expect(call(ROUNDDOWN, [NUM(1999), NUM(-3)])).toEqual(NUM(1000))
  })

  test('error propagates', () => {
    expect(call(ROUNDDOWN, [NUM(1), ERR('#NUM!')])).toEqual(ERR('#NUM!'))
  })
})

// ---------------------------------------------------------------------------
// INT
// ---------------------------------------------------------------------------

describe('INT', () => {
  test('positive: drops fractional part', () => {
    expect(call(INT, [NUM(8.9)])).toEqual(NUM(8))
  })

  test('negative: rounds DOWN (not toward zero)', () => {
    // Excel INT(-8.9) = -9, not -8. This is the floor convention.
    expect(call(INT, [NUM(-8.9)])).toEqual(NUM(-9))
  })

  test('integer stays put', () => {
    expect(call(INT, [NUM(5)])).toEqual(NUM(5))
  })

  test('error propagates', () => {
    expect(call(INT, [ERR('#VALUE!')])).toEqual(ERR('#VALUE!'))
  })

  test('coerces string', () => {
    expect(call(INT, [STR('3.7')])).toEqual(NUM(3))
  })

  test('wrong arity → #VALUE!', () => {
    expect(call(INT, [])).toEqual(ERR('#VALUE!'))
    expect(call(INT, [NUM(1), NUM(2)])).toEqual(ERR('#VALUE!'))
  })
})

// ---------------------------------------------------------------------------
// MOD
// ---------------------------------------------------------------------------

describe('MOD', () => {
  test('happy path', () => {
    expect(call(MOD, [NUM(10), NUM(3)])).toEqual(NUM(1))
  })

  test('Excel sign convention: result follows divisor sign, not dividend', () => {
    // JS: -1 % 3 === -1. Excel: MOD(-1, 3) = 2.
    expect(call(MOD, [NUM(-1), NUM(3)])).toEqual(NUM(2))
    // JS: 1 % -3 === 1. Excel: MOD(1, -3) = -2.
    expect(call(MOD, [NUM(1), NUM(-3)])).toEqual(NUM(-2))
  })

  test('divisor zero → #DIV/0!', () => {
    expect(call(MOD, [NUM(5), NUM(0)])).toEqual(ERR('#DIV/0!'))
  })

  test('error propagates', () => {
    expect(call(MOD, [ERR('#REF!'), NUM(2)])).toEqual(ERR('#REF!'))
  })

  test('coerces string', () => {
    expect(call(MOD, [STR('10'), STR('3')])).toEqual(NUM(1))
  })

  test('wrong arity → #VALUE!', () => {
    expect(call(MOD, [NUM(1)])).toEqual(ERR('#VALUE!'))
  })
})

// ---------------------------------------------------------------------------
// ABS
// ---------------------------------------------------------------------------

describe('ABS', () => {
  test('positive stays positive', () => {
    expect(call(ABS, [NUM(5)])).toEqual(NUM(5))
  })

  test('negative becomes positive', () => {
    expect(call(ABS, [NUM(-5)])).toEqual(NUM(5))
  })

  test('zero stays zero', () => {
    expect(call(ABS, [NUM(0)])).toEqual(NUM(0))
  })

  test('coerces string', () => {
    expect(call(ABS, [STR('-3.14')])).toEqual(NUM(3.14))
  })

  test('error propagates', () => {
    expect(call(ABS, [ERR('#VALUE!')])).toEqual(ERR('#VALUE!'))
  })

  test('wrong arity → #VALUE!', () => {
    expect(call(ABS, [])).toEqual(ERR('#VALUE!'))
  })
})

// ---------------------------------------------------------------------------
// POWER
// ---------------------------------------------------------------------------

describe('POWER', () => {
  test('happy path', () => {
    expect(call(POWER, [NUM(2), NUM(10)])).toEqual(NUM(1024))
  })

  test('fractional exponent', () => {
    expect(call(POWER, [NUM(9), NUM(0.5)])).toEqual(NUM(3))
  })

  test('negative base with non-integer exponent → #NUM!', () => {
    expect(call(POWER, [NUM(-2), NUM(0.5)])).toEqual(ERR('#NUM!'))
  })

  test('0 ^ 0 → #NUM! (Excel diverges from JS Math.pow which returns 1)', () => {
    expect(call(POWER, [NUM(0), NUM(0)])).toEqual(ERR('#NUM!'))
  })

  test('0 ^ negative → #DIV/0!', () => {
    expect(call(POWER, [NUM(0), NUM(-1)])).toEqual(ERR('#DIV/0!'))
  })

  test('error propagates', () => {
    expect(call(POWER, [ERR('#REF!'), NUM(2)])).toEqual(ERR('#REF!'))
  })

  test('coerces string', () => {
    expect(call(POWER, [STR('2'), STR('3')])).toEqual(NUM(8))
  })
})

// ---------------------------------------------------------------------------
// SQRT
// ---------------------------------------------------------------------------

describe('SQRT', () => {
  test('happy path', () => {
    expect(call(SQRT, [NUM(16)])).toEqual(NUM(4))
  })

  test('zero', () => {
    expect(call(SQRT, [NUM(0)])).toEqual(NUM(0))
  })

  test('negative → #NUM!', () => {
    expect(call(SQRT, [NUM(-1)])).toEqual(ERR('#NUM!'))
  })

  test('coerces blank to 0', () => {
    expect(call(SQRT, [BLANK])).toEqual(NUM(0))
  })

  test('error propagates', () => {
    expect(call(SQRT, [ERR('#NUM!')])).toEqual(ERR('#NUM!'))
  })

  test('wrong arity → #VALUE!', () => {
    expect(call(SQRT, [NUM(1), NUM(2)])).toEqual(ERR('#VALUE!'))
  })
})

// ---------------------------------------------------------------------------
// SIGN
// ---------------------------------------------------------------------------

describe('SIGN', () => {
  test('positive → 1', () => {
    expect(call(SIGN, [NUM(42)])).toEqual(NUM(1))
  })

  test('negative → -1', () => {
    expect(call(SIGN, [NUM(-3.14)])).toEqual(NUM(-1))
  })

  test('zero → 0', () => {
    expect(call(SIGN, [NUM(0)])).toEqual(NUM(0))
  })

  test('coerces string', () => {
    expect(call(SIGN, [STR('-7')])).toEqual(NUM(-1))
  })

  test('error propagates', () => {
    expect(call(SIGN, [ERR('#DIV/0!')])).toEqual(ERR('#DIV/0!'))
  })

  test('wrong arity → #VALUE!', () => {
    expect(call(SIGN, [])).toEqual(ERR('#VALUE!'))
  })
})

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Wave F / F1 — CEILING / FLOOR / TRUNC / SUMPRODUCT / PRODUCT
// ---------------------------------------------------------------------------

describe('CEILING', () => {
  test('round up to nearest multiple of significance', () => {
    expect(call(CEILING, [NUM(2.5), NUM(1)])).toEqual(NUM(3))
    expect(call(CEILING, [NUM(2.3), NUM(0.5)])).toEqual(NUM(2.5))
    expect(call(CEILING, [NUM(7), NUM(3)])).toEqual(NUM(9))
  })

  test('default significance = 1', () => {
    expect(call(CEILING, [NUM(2.5)])).toEqual(NUM(3))
  })

  test('significance = 0 → 0 (Excel CEILING.MATH)', () => {
    expect(call(CEILING, [NUM(5), NUM(0)])).toEqual(NUM(0))
  })

  test('error propagation', () => {
    expect(call(CEILING, [ERR('#DIV/0!'), NUM(1)])).toEqual(ERR('#DIV/0!'))
  })
})

describe('FLOOR', () => {
  test('round down to nearest multiple of significance', () => {
    expect(call(FLOOR, [NUM(2.5), NUM(1)])).toEqual(NUM(2))
    expect(call(FLOOR, [NUM(2.7), NUM(0.5)])).toEqual(NUM(2.5))
    expect(call(FLOOR, [NUM(7), NUM(3)])).toEqual(NUM(6))
  })

  test('default significance = 1', () => {
    expect(call(FLOOR, [NUM(2.9)])).toEqual(NUM(2))
  })

  test('negative value floors toward negative infinity', () => {
    expect(call(FLOOR, [NUM(-2.5), NUM(1)])).toEqual(NUM(-3))
  })

  test('significance = 0 → 0', () => {
    expect(call(FLOOR, [NUM(5), NUM(0)])).toEqual(NUM(0))
  })
})

describe('TRUNC', () => {
  test('default digits=0, truncate toward zero', () => {
    expect(call(TRUNC, [NUM(3.7)])).toEqual(NUM(3))
    expect(call(TRUNC, [NUM(-3.7)])).toEqual(NUM(-3))
  })

  test('digits>0 preserves decimal places', () => {
    expect(call(TRUNC, [NUM(3.14159), NUM(2)])).toEqual(NUM(3.14))
  })

  test('digits<0 zeroes out left of decimal', () => {
    expect(call(TRUNC, [NUM(123.45), NUM(-1)])).toEqual(NUM(120))
  })

  test('error propagation', () => {
    expect(call(TRUNC, [ERR('#NUM!')])).toEqual(ERR('#NUM!'))
  })
})

describe('SUMPRODUCT', () => {
  test('element-wise product summed for equal-shape arrays', () => {
    expect(
      call(SUMPRODUCT, [
        ARR([[NUM(1), NUM(2), NUM(3)]]),
        ARR([[NUM(4), NUM(5), NUM(6)]]),
      ]),
    ).toEqual(NUM(1 * 4 + 2 * 5 + 3 * 6))
  })

  test('shape mismatch → #VALUE!', () => {
    expect(
      call(SUMPRODUCT, [ARR([[NUM(1), NUM(2)]]), ARR([[NUM(1), NUM(2), NUM(3)]])]),
    ).toEqual(ERR('#VALUE!'))
  })

  test('non-numeric inside array treated as 0 (Excel quirk)', () => {
    expect(
      call(SUMPRODUCT, [
        ARR([[NUM(1), STR('hello'), NUM(3)]]),
        ARR([[NUM(4), NUM(5), NUM(6)]]),
      ]),
    ).toEqual(NUM(1 * 4 + 0 + 3 * 6))
  })

  test('error inside array propagates', () => {
    expect(
      call(SUMPRODUCT, [
        ARR([[NUM(1), NUM(2), NUM(3)]]),
        ARR([[NUM(4), ERR('#REF!'), NUM(6)]]),
      ]),
    ).toEqual(ERR('#REF!'))
  })

  test('single-array variant returns straight sum', () => {
    expect(call(SUMPRODUCT, [ARR([[NUM(1), NUM(2), NUM(3)]])])).toEqual(NUM(6))
  })

  test('zero args → #VALUE!', () => {
    expect(call(SUMPRODUCT, [])).toEqual(ERR('#VALUE!'))
  })
})

describe('PRODUCT', () => {
  test('happy path: multiply all numeric scalar args', () => {
    expect(call(PRODUCT, [NUM(2), NUM(3), NUM(4)])).toEqual(NUM(24))
  })

  test('ignores non-numeric inside arrays', () => {
    expect(
      call(PRODUCT, [ARR([[NUM(2), STR('hi'), BOOL(true)], [BLANK, NUM(3)]])]),
    ).toEqual(NUM(6))
  })

  test('empty product → 0 (Excel quirk, not 1)', () => {
    expect(call(PRODUCT, [])).toEqual(NUM(0))
  })

  test('error propagation', () => {
    expect(call(PRODUCT, [NUM(2), ERR('#DIV/0!')])).toEqual(ERR('#DIV/0!'))
  })
})

describe('FUNCTIONS registry', () => {
  test('exposes a baseline set of math functions (extensible as new ones land)', () => {
    const keys = new Set(Object.keys(FUNCTIONS))
    // Spot-check the v1 + F1 baseline is intact. New phase-8 additions
    // expand the registry over time; this test guards against regressions
    // (removing baseline names) without rewriting on every addition.
    const baseline = [
      'ABS', 'AVERAGE', 'CEILING', 'COUNT', 'COUNTA', 'FLOOR', 'INT',
      'MAX', 'MIN', 'MOD', 'POWER', 'PRODUCT', 'ROUND', 'ROUNDDOWN',
      'ROUNDUP', 'SIGN', 'SQRT', 'SUM', 'SUMPRODUCT', 'TRUNC',
    ]
    for (const name of baseline) {
      expect(keys.has(name)).toBe(true)
    }
  })

  test('every entry satisfies FunctionImpl shape', () => {
    // Zero-arity functions (PI, RAND) intentionally reject any args
    // including a leading error — they fail the arity gate before
    // looking at args. Exclude from the propagation spot check.
    const zeroArityOnly = new Set(['PI', 'RAND'])
    for (const [name, fn] of Object.entries(FUNCTIONS)) {
      expect(typeof fn).toBe('function')
      // Spot check: every fn should accept an empty args array without
      // throwing — it may return an error Value, but never throw.
      expect(() => fn([], ctx)).not.toThrow()
      // And every fn (except zero-arity) should propagate a leading
      // scalar error.
      if (!zeroArityOnly.has(name)) {
        const result = fn([{ kind: 'error', code: '#REF!' }], ctx)
        expect(result.kind === 'error' && result.code).toBe('#REF!')
      }
      expect(name).toBe(name.toUpperCase())
    }
  })
})
