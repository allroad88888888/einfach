/**
 * Phase 8 — math function additions tests.
 *
 * Covers: trig (SIN/COS/TAN + inverses + hyperbolic + reciprocal), angle
 * conversion (RADIANS/DEGREES), exponential/log (EXP/LN/LOG/LOG10),
 * constants (PI), random (RAND/RANDBETWEEN — soft-check),
 * rounding (MROUND/QUOTIENT/EVEN/ODD), combinatorics (FACT/COMBIN/
 * PERMUT/FACTDOUBLE), divisibility (GCD/LCM), misc (COUNTBLANK/SUMSQ/
 * SQRTPI).
 *
 * Each function gets ≥3 cases: happy path + error/edge case + type
 * coercion. Where math identities pin the result (e.g. SIN(0)=0), we use
 * exact comparisons; for irrational results we use `toBeCloseTo`.
 */

import { describe, expect, test } from '@jest/globals'

import {
  ACOS,
  ACOSH,
  ACOT,
  ACOTH,
  ACSC,
  AGGREGATE,
  ASIN,
  ASINH,
  ASEC,
  ATAN,
  ATAN2,
  ATANH,
  BASE,
  CEILING_MATH,
  CEILING_PRECISE,
  COMBIN,
  COMBINA,
  COS,
  COSH,
  COT,
  COUNTBLANK,
  COTH,
  CSCH,
  CSC,
  DEGREES,
  EVEN,
  EXP,
  FACT,
  FACTDOUBLE,
  FLOOR_MATH,
  FLOOR_PRECISE,
  FUNCTIONS,
  GCD,
  ISO_CEILING,
  LCM,
  LN,
  LOG,
  LOG10,
  DECIMAL,
  MDETERM,
  MINVERSE,
  MMULT,
  MROUND,
  MULTINOMIAL,
  MUNIT,
  ODD,
  PERMUTATIONA,
  PERMUT,
  PI,
  QUOTIENT,
  RADIANS,
  RAND,
  RANDBETWEEN,
  SEC,
  SECH,
  SERIESSUM,
  SIN,
  SINH,
  SQRTPI,
  SUBTOTAL,
  SUMSQ,
  SUMX2MY2,
  SUMX2PY2,
  SUMXMY2,
  TAN,
  TANH,
} from '../src/eval/functions/math'
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
      throw new Error(`phase8 math unexpectedly read ctx.${String(prop)}`)
    },
  },
) as unknown as EvalContext

const call = (fn: FunctionImpl, args: Value[]): Value => fn(args, ctx)

function asNumber(v: Value): number {
  if (v.kind !== 'number') throw new Error(`expected number, got ${JSON.stringify(v)}`)
  return v.value
}

// ---------------------------------------------------------------------------
// Trig
// ---------------------------------------------------------------------------

describe('SIN', () => {
  test('SIN(0) = 0', () => expect(asNumber(call(SIN, [NUM(0)]))).toBeCloseTo(0, 10))
  test('SIN(PI/2) ≈ 1', () => expect(asNumber(call(SIN, [NUM(Math.PI / 2)]))).toBeCloseTo(1, 10))
  test('non-numeric arg → #VALUE!', () => expect(call(SIN, [STR('foo')])).toEqual(ERR('#VALUE!')))
})

describe('COS', () => {
  test('COS(0) = 1', () => expect(asNumber(call(COS, [NUM(0)]))).toBeCloseTo(1, 10))
  test('COS(PI) ≈ -1', () => expect(asNumber(call(COS, [NUM(Math.PI)]))).toBeCloseTo(-1, 10))
  test('error propagates', () => expect(call(COS, [ERR('#N/A')])).toEqual(ERR('#N/A')))
})

describe('TAN', () => {
  test('TAN(0) = 0', () => expect(asNumber(call(TAN, [NUM(0)]))).toBeCloseTo(0, 10))
  test('boolean coerces (TAN(false)=0)', () =>
    expect(asNumber(call(TAN, [BOOL(false)]))).toBeCloseTo(0, 10))
  test('wrong arity → #VALUE!', () => expect(call(TAN, [NUM(1), NUM(2)])).toEqual(ERR('#VALUE!')))
})

describe('ASIN / ACOS', () => {
  test('ASIN(1) = PI/2', () => expect(asNumber(call(ASIN, [NUM(1)]))).toBeCloseTo(Math.PI / 2, 10))
  test('ASIN(2) → #NUM! (out of domain)', () =>
    expect(call(ASIN, [NUM(2)])).toEqual(ERR('#NUM!')))
  test('ACOS(0) = PI/2', () => expect(asNumber(call(ACOS, [NUM(0)]))).toBeCloseTo(Math.PI / 2, 10))
})

describe('ATAN / ATAN2', () => {
  test('ATAN(1) = PI/4', () => expect(asNumber(call(ATAN, [NUM(1)]))).toBeCloseTo(Math.PI / 4, 10))
  test('ATAN2(1, 1) = PI/4 (note: Excel arg order is (x, y))', () =>
    expect(asNumber(call(ATAN2, [NUM(1), NUM(1)]))).toBeCloseTo(Math.PI / 4, 10))
  // Excel returns #DIV/0! when both args are zero (atan2 is undefined at origin).
  // See Microsoft Office docs for ATAN2.
  test('ATAN2(0, 0) → #DIV/0!', () =>
    expect(call(ATAN2, [NUM(0), NUM(0)])).toEqual(ERR('#DIV/0!')))
})

describe('SINH / COSH / TANH', () => {
  test('SINH(0) = 0', () => expect(asNumber(call(SINH, [NUM(0)]))).toBeCloseTo(0, 10))
  test('COSH(0) = 1', () => expect(asNumber(call(COSH, [NUM(0)]))).toBeCloseTo(1, 10))
  test('TANH(0) = 0', () => expect(asNumber(call(TANH, [NUM(0)]))).toBeCloseTo(0, 10))
})

describe('ASINH / ACOSH / ATANH', () => {
  test('ASINH(0) = 0', () => expect(asNumber(call(ASINH, [NUM(0)]))).toBeCloseTo(0, 10))
  test('ACOSH(0) → #NUM! (must be >= 1)', () => expect(call(ACOSH, [NUM(0)])).toEqual(ERR('#NUM!')))
  test('ATANH(1) → #NUM! (must be in (-1, 1))', () =>
    expect(call(ATANH, [NUM(1)])).toEqual(ERR('#NUM!')))
})

describe('CSC / SEC / COT', () => {
  test('CSC(PI/2) = 1', () => expect(asNumber(call(CSC, [NUM(Math.PI / 2)]))).toBeCloseTo(1, 10))
  test('SEC(0) = 1', () => expect(asNumber(call(SEC, [NUM(0)]))).toBeCloseTo(1, 10))
  test('COT(0) → #NUM!', () => expect(call(COT, [NUM(0)])).toEqual(ERR('#NUM!')))
})

describe('CSCH / SECH / COTH', () => {
  test('CSCH(1) = 1/sinh(1)', () =>
    expect(asNumber(call(CSCH, [NUM(1)]))).toBeCloseTo(1 / Math.sinh(1), 10))
  test('SECH(0) = 1', () => expect(asNumber(call(SECH, [NUM(0)]))).toBeCloseTo(1, 10))
  test('COTH(1) = 1/tanh(1)', () =>
    expect(asNumber(call(COTH, [NUM(1)]))).toBeCloseTo(1 / Math.tanh(1), 10))
  test('CSCH(0) and COTH(0) → #DIV/0!', () => {
    expect(call(CSCH, [NUM(0)])).toEqual(ERR('#DIV/0!'))
    expect(call(COTH, [NUM(0)])).toEqual(ERR('#DIV/0!'))
  })
})

describe('ACSC / ASEC / ACOT / ACOTH', () => {
  test('ACSC(2) = PI/6', () =>
    expect(asNumber(call(ACSC, [NUM(2)]))).toBeCloseTo(Math.PI / 6, 10))
  test('ASEC(2) = PI/3', () =>
    expect(asNumber(call(ASEC, [NUM(2)]))).toBeCloseTo(Math.PI / 3, 10))
  test('ACOT uses Excel branch in (0, PI)', () => {
    expect(asNumber(call(ACOT, [NUM(0)]))).toBeCloseTo(Math.PI / 2, 10)
    expect(asNumber(call(ACOT, [NUM(-1)]))).toBeCloseTo((3 * Math.PI) / 4, 10)
  })
  test('ACOTH(2) = 0.5 * LN(3)', () =>
    expect(asNumber(call(ACOTH, [NUM(2)]))).toBeCloseTo(0.5 * Math.log(3), 10))
  test('reciprocal inverse trig domains surface Excel errors', () => {
    expect(call(ACSC, [NUM(0)])).toEqual(ERR('#DIV/0!'))
    expect(call(ASEC, [NUM(0.5)])).toEqual(ERR('#NUM!'))
    expect(call(ACOTH, [NUM(1)])).toEqual(ERR('#NUM!'))
  })
})

// ---------------------------------------------------------------------------
// Angle conversion
// ---------------------------------------------------------------------------

describe('RADIANS', () => {
  test('RADIANS(180) ≈ PI', () =>
    expect(asNumber(call(RADIANS, [NUM(180)]))).toBeCloseTo(Math.PI, 10))
  test('RADIANS(0) = 0', () => expect(asNumber(call(RADIANS, [NUM(0)]))).toBe(0))
  test('non-numeric → #VALUE!', () => expect(call(RADIANS, [STR('hi')])).toEqual(ERR('#VALUE!')))
})

describe('DEGREES', () => {
  test('DEGREES(PI) ≈ 180', () =>
    expect(asNumber(call(DEGREES, [NUM(Math.PI)]))).toBeCloseTo(180, 10))
  test('DEGREES(0) = 0', () => expect(asNumber(call(DEGREES, [NUM(0)]))).toBe(0))
  test('error propagates', () => expect(call(DEGREES, [ERR('#REF!')])).toEqual(ERR('#REF!')))
})

// ---------------------------------------------------------------------------
// Exp / Log
// ---------------------------------------------------------------------------

describe('EXP / LN', () => {
  test('EXP(0) = 1', () => expect(asNumber(call(EXP, [NUM(0)]))).toBeCloseTo(1, 10))
  test('LN(1) = 0', () => expect(asNumber(call(LN, [NUM(1)]))).toBeCloseTo(0, 10))
  test('LN(0) → #NUM!', () => expect(call(LN, [NUM(0)])).toEqual(ERR('#NUM!')))
})

describe('LOG / LOG10', () => {
  test('LOG(100) = 2 (default base 10)', () =>
    expect(asNumber(call(LOG, [NUM(100)]))).toBeCloseTo(2, 10))
  test('LOG(8, 2) = 3', () => expect(asNumber(call(LOG, [NUM(8), NUM(2)]))).toBeCloseTo(3, 10))
  test('LOG10(1000) = 3', () => expect(asNumber(call(LOG10, [NUM(1000)]))).toBeCloseTo(3, 10))
  test('LOG(x, 1) → #NUM! (base 1 undefined)', () =>
    expect(call(LOG, [NUM(10), NUM(1)])).toEqual(ERR('#NUM!')))
})

// ---------------------------------------------------------------------------
// Constants & random
// ---------------------------------------------------------------------------

describe('PI', () => {
  test('PI() ≈ 3.14159265', () => expect(asNumber(call(PI, []))).toBeCloseTo(Math.PI, 10))
  test('PI(1) → #VALUE! (zero arity)', () => expect(call(PI, [NUM(1)])).toEqual(ERR('#VALUE!')))
  test('returns the math constant exactly', () => expect(asNumber(call(PI, []))).toBe(Math.PI))
})

describe('RAND', () => {
  test('RAND() returns a number in [0, 1)', () => {
    const v = asNumber(call(RAND, []))
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThan(1)
  })
  test('RAND(1) → #VALUE! (zero arity)', () =>
    expect(call(RAND, [NUM(1)])).toEqual(ERR('#VALUE!')))
  test('two calls produce numbers (cannot assert distinctness deterministically)', () => {
    expect(call(RAND, []).kind).toBe('number')
  })
})

describe('RANDBETWEEN', () => {
  test('returns integer in [low, high]', () => {
    const v = asNumber(call(RANDBETWEEN, [NUM(1), NUM(5)]))
    expect(Number.isInteger(v)).toBe(true)
    expect(v).toBeGreaterThanOrEqual(1)
    expect(v).toBeLessThanOrEqual(5)
  })
  test('low > high → #NUM!', () => expect(call(RANDBETWEEN, [NUM(5), NUM(1)])).toEqual(ERR('#NUM!')))
  test('wrong arity → #VALUE!', () =>
    expect(call(RANDBETWEEN, [NUM(1)])).toEqual(ERR('#VALUE!')))
})

// ---------------------------------------------------------------------------
// MROUND / QUOTIENT / EVEN / ODD
// ---------------------------------------------------------------------------

describe('MROUND', () => {
  test('MROUND(10, 3) = 9 (nearest multiple of 3)', () =>
    expect(call(MROUND, [NUM(10), NUM(3)])).toEqual(NUM(9)))
  test('MROUND(-10, -3) = -9', () => expect(call(MROUND, [NUM(-10), NUM(-3)])).toEqual(NUM(-9)))
  test('opposite signs → #NUM!', () =>
    expect(call(MROUND, [NUM(10), NUM(-3)])).toEqual(ERR('#NUM!')))
  test('zero multiple → 0', () => expect(call(MROUND, [NUM(10), NUM(0)])).toEqual(NUM(0)))
})

describe('CEILING.MATH / FLOOR.MATH', () => {
  test('positive values round with custom significance', () => {
    expect(call(CEILING_MATH, [NUM(10.5), NUM(2)])).toEqual(NUM(12))
    expect(call(FLOOR_MATH, [NUM(10.5), NUM(2)])).toEqual(NUM(10))
  })
  test('negative default mode rounds toward +inf / -inf', () => {
    expect(call(CEILING_MATH, [NUM(-2.5)])).toEqual(NUM(-2))
    expect(call(FLOOR_MATH, [NUM(-2.5)])).toEqual(NUM(-3))
  })
  test('negative nonzero mode reverses direction', () => {
    expect(call(CEILING_MATH, [NUM(-2.5), NUM(1), NUM(1)])).toEqual(NUM(-3))
    expect(call(FLOOR_MATH, [NUM(-2.5), NUM(1), NUM(1)])).toEqual(NUM(-2))
  })
  test('zero significance returns 0', () => {
    expect(call(CEILING_MATH, [NUM(10.5), NUM(0)])).toEqual(NUM(0))
    expect(call(FLOOR_MATH, [NUM(10.5), NUM(0)])).toEqual(NUM(0))
  })
})

describe('CEILING.PRECISE / FLOOR.PRECISE / ISO.CEILING', () => {
  test('precise variants ignore sign of significance', () => {
    expect(call(CEILING_PRECISE, [NUM(10.5), NUM(-2)])).toEqual(NUM(12))
    expect(call(FLOOR_PRECISE, [NUM(10.5), NUM(-2)])).toEqual(NUM(10))
  })
  test('precise variants keep fixed rounding direction for negatives', () => {
    expect(call(CEILING_PRECISE, [NUM(-2.5)])).toEqual(NUM(-2))
    expect(call(FLOOR_PRECISE, [NUM(-2.5)])).toEqual(NUM(-3))
  })
  test('ISO.CEILING aliases CEILING.PRECISE behavior', () => {
    expect(call(ISO_CEILING, [NUM(4.3), NUM(2)])).toEqual(NUM(6))
    expect(call(ISO_CEILING, [NUM(-4.3), NUM(1)])).toEqual(NUM(-4))
  })
  test('dotted names are registered for evaluator dispatch', () => {
    expect(FUNCTIONS['CEILING.MATH']).toBe(CEILING_MATH)
    expect(FUNCTIONS['FLOOR.MATH']).toBe(FLOOR_MATH)
    expect(FUNCTIONS['CEILING.PRECISE']).toBe(CEILING_PRECISE)
    expect(FUNCTIONS['FLOOR.PRECISE']).toBe(FLOOR_PRECISE)
    expect(FUNCTIONS['ISO.CEILING']).toBe(ISO_CEILING)
  })
})

describe('QUOTIENT', () => {
  test('QUOTIENT(7, 2) = 3', () => expect(call(QUOTIENT, [NUM(7), NUM(2)])).toEqual(NUM(3)))
  test('QUOTIENT(-7, 2) = -3 (truncate toward zero)', () =>
    expect(call(QUOTIENT, [NUM(-7), NUM(2)])).toEqual(NUM(-3)))
  test('divide by zero → #DIV/0!', () =>
    expect(call(QUOTIENT, [NUM(7), NUM(0)])).toEqual(ERR('#DIV/0!')))
})

describe('EVEN', () => {
  test('EVEN(3) = 4', () => expect(call(EVEN, [NUM(3)])).toEqual(NUM(4)))
  test('EVEN(-3) = -4', () => expect(call(EVEN, [NUM(-3)])).toEqual(NUM(-4)))
  test('EVEN(2.1) = 4', () => expect(call(EVEN, [NUM(2.1)])).toEqual(NUM(4)))
})

describe('ODD', () => {
  test('ODD(2) = 3', () => expect(call(ODD, [NUM(2)])).toEqual(NUM(3)))
  test('ODD(-2) = -3', () => expect(call(ODD, [NUM(-2)])).toEqual(NUM(-3)))
  test('ODD(1.5) = 3', () => expect(call(ODD, [NUM(1.5)])).toEqual(NUM(3)))
})

// ---------------------------------------------------------------------------
// Combinatorics
// ---------------------------------------------------------------------------

describe('FACT', () => {
  test('FACT(5) = 120', () => expect(call(FACT, [NUM(5)])).toEqual(NUM(120)))
  test('FACT(0) = 1', () => expect(call(FACT, [NUM(0)])).toEqual(NUM(1)))
  test('FACT(-1) → #NUM!', () => expect(call(FACT, [NUM(-1)])).toEqual(ERR('#NUM!')))
  test('FACT(200) → #NUM! (overflow)', () => expect(call(FACT, [NUM(200)])).toEqual(ERR('#NUM!')))
})

describe('FACTDOUBLE', () => {
  test('FACTDOUBLE(7) = 105 (7*5*3*1)', () =>
    expect(call(FACTDOUBLE, [NUM(7)])).toEqual(NUM(105)))
  test('FACTDOUBLE(8) = 384 (8*6*4*2)', () =>
    expect(call(FACTDOUBLE, [NUM(8)])).toEqual(NUM(384)))
  test('FACTDOUBLE(-2) → #NUM!', () => expect(call(FACTDOUBLE, [NUM(-2)])).toEqual(ERR('#NUM!')))
})

describe('COMBIN', () => {
  test('COMBIN(5, 2) = 10', () => expect(call(COMBIN, [NUM(5), NUM(2)])).toEqual(NUM(10)))
  test('COMBIN(10, 0) = 1', () => expect(call(COMBIN, [NUM(10), NUM(0)])).toEqual(NUM(1)))
  test('COMBIN(3, 5) → #NUM! (k > n)', () =>
    expect(call(COMBIN, [NUM(3), NUM(5)])).toEqual(ERR('#NUM!')))
})

describe('PERMUT', () => {
  test('PERMUT(5, 2) = 20', () => expect(call(PERMUT, [NUM(5), NUM(2)])).toEqual(NUM(20)))
  test('PERMUT(5, 0) = 1', () => expect(call(PERMUT, [NUM(5), NUM(0)])).toEqual(NUM(1)))
  test('PERMUT(-1, 2) → #NUM!', () =>
    expect(call(PERMUT, [NUM(-1), NUM(2)])).toEqual(ERR('#NUM!')))
})

describe('COMBINA / PERMUTATIONA / MULTINOMIAL', () => {
  test('COMBINA(4, 3) = 20', () => expect(call(COMBINA, [NUM(4), NUM(3)])).toEqual(NUM(20)))
  test('COMBINA(0, 0) = 1', () => expect(call(COMBINA, [NUM(0), NUM(0)])).toEqual(NUM(1)))
  test('PERMUTATIONA(3, 2) = 9', () =>
    expect(call(PERMUTATIONA, [NUM(3), NUM(2)])).toEqual(NUM(9)))
  test('PERMUTATIONA(0, 0) = 1', () =>
    expect(call(PERMUTATIONA, [NUM(0), NUM(0)])).toEqual(NUM(1)))
  test('MULTINOMIAL(2, 3, 4) = 1260', () =>
    expect(call(MULTINOMIAL, [NUM(2), NUM(3), NUM(4)])).toEqual(NUM(1260)))
  test('negative inputs → #NUM!', () => {
    expect(call(COMBINA, [NUM(-1), NUM(2)])).toEqual(ERR('#NUM!'))
    expect(call(PERMUTATIONA, [NUM(3), NUM(-1)])).toEqual(ERR('#NUM!'))
    expect(call(MULTINOMIAL, [NUM(1), NUM(-1)])).toEqual(ERR('#NUM!'))
  })
})

describe('BASE / DECIMAL', () => {
  test('BASE converts integers with padding', () => {
    expect(call(BASE, [NUM(255), NUM(16)])).toEqual(STR('FF'))
    expect(call(BASE, [NUM(5), NUM(2), NUM(8)])).toEqual(STR('00000101'))
  })
  test('DECIMAL parses base text', () => {
    expect(call(DECIMAL, [STR('FF'), NUM(16)])).toEqual(NUM(255))
    expect(call(DECIMAL, [STR('101'), NUM(2)])).toEqual(NUM(5))
  })
  test('invalid radix or digit → #NUM!', () => {
    expect(call(BASE, [NUM(10), NUM(1)])).toEqual(ERR('#NUM!'))
    expect(call(DECIMAL, [STR('2'), NUM(2)])).toEqual(ERR('#NUM!'))
  })
})

describe('SUMX2MY2 / SUMX2PY2 / SUMXMY2', () => {
  const xs = ARR([[NUM(1), NUM(2), NUM(3)]])
  const ys = ARR([[NUM(4), NUM(5), NUM(6)]])

  test('sums pairwise formulas over same-shape arrays', () => {
    expect(call(SUMX2MY2, [xs, ys])).toEqual(NUM(-63))
    expect(call(SUMX2PY2, [xs, ys])).toEqual(NUM(91))
    expect(call(SUMXMY2, [xs, ys])).toEqual(NUM(27))
  })

  test('shape mismatch → #VALUE!', () => {
    expect(call(SUMX2MY2, [xs, ARR([[NUM(1)], [NUM(2)]])])).toEqual(ERR('#VALUE!'))
  })

  test('non-numeric pairs are skipped when either side is non-numeric', () => {
    expect(call(SUMX2PY2, [ARR([[NUM(1), STR('x')]]), ARR([[NUM(2), NUM(3)]])])).toEqual(NUM(5))
  })
})

describe('MUNIT / MMULT / MDETERM / MINVERSE', () => {
  test('MUNIT returns an identity matrix', () => {
    expect(call(MUNIT, [NUM(3)])).toEqual(
      ARR([[NUM(1), NUM(0), NUM(0)], [NUM(0), NUM(1), NUM(0)], [NUM(0), NUM(0), NUM(1)]]),
    )
  })

  test('MMULT multiplies matrices', () => {
    expect(
      call(MMULT, [
        ARR([[NUM(1), NUM(2)], [NUM(3), NUM(4)]]),
        ARR([[NUM(5), NUM(6)], [NUM(7), NUM(8)]]),
      ]),
    ).toEqual(ARR([[NUM(19), NUM(22)], [NUM(43), NUM(50)]]))
  })

  test('MDETERM computes determinant', () => {
    expect(call(MDETERM, [ARR([[NUM(1), NUM(2)], [NUM(3), NUM(4)]])])).toEqual(NUM(-2))
  })

  test('MINVERSE inverts a 2x2 matrix', () => {
    const result = call(MINVERSE, [ARR([[NUM(4), NUM(7)], [NUM(2), NUM(6)]])])
    expect(result.kind).toBe('array')
    if (result.kind !== 'array') return
    expect(result.value[0][0]).toEqual(NUM(0.6000000000000001))
    expect(result.value[0][1]).toEqual(NUM(-0.7000000000000001))
    expect(result.value[1][0]).toEqual(NUM(-0.2))
    expect(result.value[1][1]).toEqual(NUM(0.4))
  })

  test('invalid matrix dimensions surface errors', () => {
    expect(call(MMULT, [ARR([[NUM(1), NUM(2)]]), ARR([[NUM(1), NUM(2)]])])).toEqual(
      ERR('#VALUE!'),
    )
    expect(call(MDETERM, [ARR([[NUM(1), NUM(2)]])])).toEqual(ERR('#VALUE!'))
    expect(call(MINVERSE, [ARR([[NUM(1), NUM(2)], [NUM(2), NUM(4)]])])).toEqual(ERR('#NUM!'))
  })
})

describe('GCD', () => {
  test('GCD(12, 18) = 6', () => expect(call(GCD, [NUM(12), NUM(18)])).toEqual(NUM(6)))
  test('GCD(15, 25, 5) = 5', () =>
    expect(call(GCD, [NUM(15), NUM(25), NUM(5)])).toEqual(NUM(5)))
  test('GCD(0, 5) = 5', () => expect(call(GCD, [NUM(0), NUM(5)])).toEqual(NUM(5)))
  test('negative inputs return #NUM!', () =>
    expect(call(GCD, [NUM(-2), NUM(4)])).toEqual(ERR('#NUM!')))
})

describe('LCM', () => {
  test('LCM(4, 6) = 12', () => expect(call(LCM, [NUM(4), NUM(6)])).toEqual(NUM(12)))
  test('LCM(3, 5, 7) = 105', () =>
    expect(call(LCM, [NUM(3), NUM(5), NUM(7)])).toEqual(NUM(105)))
  test('LCM(0, 5) = 0', () => expect(call(LCM, [NUM(0), NUM(5)])).toEqual(NUM(0)))
  test('negative inputs return #NUM!', () =>
    expect(call(LCM, [NUM(-2), NUM(4)])).toEqual(ERR('#NUM!')))
})

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

describe('COUNTBLANK', () => {
  test('counts blank cells in array', () =>
    expect(call(COUNTBLANK, [ARR([[NUM(1), BLANK, STR('hi')], [BLANK, NUM(2), BLANK]])])).toEqual(
      NUM(3),
    ))
  test('empty-string counts as blank too', () =>
    expect(call(COUNTBLANK, [ARR([[STR(''), STR('x')]])])).toEqual(NUM(1)))
  test('scalar blank → 1', () => expect(call(COUNTBLANK, [BLANK])).toEqual(NUM(1)))
})

describe('SUMSQ', () => {
  test('SUMSQ(3, 4) = 25 (9+16)', () => expect(call(SUMSQ, [NUM(3), NUM(4)])).toEqual(NUM(25)))
  test('SUMSQ over array', () =>
    expect(call(SUMSQ, [ARR([[NUM(1), NUM(2)], [NUM(2), NUM(0)]])])).toEqual(NUM(9)))
  test('error propagates', () =>
    expect(call(SUMSQ, [NUM(1), ERR('#N/A')])).toEqual(ERR('#N/A')))
})

describe('SERIESSUM', () => {
  test('computes coefficient series', () => {
    expect(call(SERIESSUM, [NUM(2), NUM(1), NUM(1), ARR([[NUM(1), NUM(2), NUM(3)]])])).toEqual(
      NUM(34),
    )
  })

  test('coerces coefficient cells', () => {
    expect(call(SERIESSUM, [NUM(3), NUM(0), NUM(1), ARR([[NUM(1), BLANK, STR('2')]])])).toEqual(
      NUM(19),
    )
  })

  test('coefficient errors propagate', () => {
    expect(call(SERIESSUM, [NUM(2), NUM(1), NUM(1), ARR([[ERR('#N/A')]])])).toEqual(
      ERR('#N/A'),
    )
  })
})

describe('SUBTOTAL / AGGREGATE', () => {
  const values = ARR([[NUM(1), NUM(2), NUM(3)], [STR('x'), BLANK, NUM(4)]])

  test('SUBTOTAL supports common aggregation codes', () => {
    expect(call(SUBTOTAL, [NUM(9), values])).toEqual(NUM(10))
    expect(call(SUBTOTAL, [NUM(1), values])).toEqual(NUM(2.5))
    expect(call(SUBTOTAL, [NUM(2), values])).toEqual(NUM(4))
    expect(call(SUBTOTAL, [NUM(3), values])).toEqual(NUM(5))
    expect(call(SUBTOTAL, [NUM(104), values])).toEqual(NUM(4))
  })

  test('SUBTOTAL propagates errors for numeric aggregations', () => {
    expect(call(SUBTOTAL, [NUM(9), ARR([[NUM(1), ERR('#REF!')]])])).toEqual(ERR('#REF!'))
  })

  test('AGGREGATE supports ignore-error option and ranking functions', () => {
    expect(call(AGGREGATE, [NUM(9), NUM(6), ARR([[NUM(1), ERR('#REF!'), NUM(4)]])])).toEqual(
      NUM(5),
    )
    expect(call(AGGREGATE, [NUM(9), NUM(2), ARR([[NUM(1), ERR('#REF!'), NUM(4)]])])).toEqual(
      NUM(5),
    )
    expect(call(AGGREGATE, [NUM(9), NUM(4), ARR([[NUM(1), ERR('#REF!'), NUM(4)]])])).toEqual(
      ERR('#REF!'),
    )
    expect(call(AGGREGATE, [NUM(14), NUM(0), values, NUM(2)])).toEqual(NUM(3))
    expect(call(AGGREGATE, [NUM(15), NUM(0), values, NUM(2)])).toEqual(NUM(2))
  })

  test('AGGREGATE supports percentile/quartile families', () => {
    const row = ARR([[NUM(1), NUM(2), NUM(3), NUM(4)]])
    expect(call(AGGREGATE, [NUM(16), NUM(0), row, NUM(0.5)])).toEqual(NUM(2.5))
    expect(call(AGGREGATE, [NUM(17), NUM(0), row, NUM(2)])).toEqual(NUM(2.5))
  })

  test('invalid codes return #VALUE!', () => {
    expect(call(SUBTOTAL, [NUM(12), values])).toEqual(ERR('#VALUE!'))
    expect(call(AGGREGATE, [NUM(20), NUM(0), values])).toEqual(ERR('#VALUE!'))
  })
})

describe('SQRTPI', () => {
  test('SQRTPI(1) = sqrt(PI)', () =>
    expect(asNumber(call(SQRTPI, [NUM(1)]))).toBeCloseTo(Math.sqrt(Math.PI), 10))
  test('SQRTPI(0) = 0', () => expect(asNumber(call(SQRTPI, [NUM(0)]))).toBe(0))
  test('SQRTPI(-1) → #NUM!', () => expect(call(SQRTPI, [NUM(-1)])).toEqual(ERR('#NUM!')))
})
