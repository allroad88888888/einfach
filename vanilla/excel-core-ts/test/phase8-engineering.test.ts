/**
 * Phase 8 — engineering function tests.
 *
 * Base conversions (DEC2BIN/OCT/HEX, BIN/OCT/HEX2DEC), bit ops
 * (BITAND/OR/XOR/LSHIFT/RSHIFT), comparators (DELTA, GESTEP), complex
 * functions (COMPLEX, IM*).
 */

import { describe, expect, test } from '@jest/globals'

import {
  BIN2HEX,
  BIN2OCT,
  BIN2DEC,
  BESSELI,
  BESSELJ,
  BESSELK,
  BESSELY,
  BITAND,
  BITLSHIFT,
  BITOR,
  BITRSHIFT,
  BITXOR,
  COMPLEX,
  CONVERT,
  DEC2BIN,
  DEC2HEX,
  DEC2OCT,
  DELTA,
  ERF,
  ERF_PRECISE,
  ERFC,
  ERFC_PRECISE,
  FUNCTIONS,
  GESTEP,
  HEX2BIN,
  HEX2DEC,
  HEX2OCT,
  IMABS,
  IMAGINARY,
  IMARGUMENT,
  IMCONJUGATE,
  IMCOS,
  IMCOSH,
  IMCOT,
  IMCSC,
  IMCSCH,
  IMDIV,
  IMEXP,
  IMLN,
  IMLOG10,
  IMLOG2,
  IMPOWER,
  IMPRODUCT,
  IMREAL,
  IMSEC,
  IMSECH,
  IMSIN,
  IMSINH,
  IMSQRT,
  IMSUB,
  IMSUM,
  IMTAN,
  OCT2BIN,
  OCT2DEC,
  OCT2HEX,
} from '../src/eval/functions/engineering'
import type { EvalContext, FunctionImpl, Value } from '../src/types'

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const STR = (s: string): Value => ({ kind: 'string', value: s })
const ERR = (code: '#DIV/0!' | '#N/A' | '#NUM!' | '#VALUE!'): Value => ({
  kind: 'error',
  code,
})

const ctx: EvalContext = new Proxy(
  {},
  {
    get(_, prop) {
      throw new Error(`phase8 eng unexpectedly read ctx.${String(prop)}`)
    },
  },
) as unknown as EvalContext

const call = (fn: FunctionImpl, args: Value[]): Value => fn(args, ctx)

function numberValue(value: Value): number {
  if (value.kind !== 'number') throw new Error(`expected number, got ${JSON.stringify(value)}`)
  return value.value
}

function stringValue(value: Value): string {
  if (value.kind !== 'string') throw new Error(`expected string, got ${JSON.stringify(value)}`)
  return value.value
}

function expectNumberClose(value: Value, expected: number, precision = 12): void {
  expect(numberValue(value)).toBeCloseTo(expected, precision)
}

function expectComplexClose(
  value: Value,
  expectedReal: number,
  expectedImag: number,
  precision = 12,
): void {
  const text = stringValue(value)
  expectNumberClose(call(IMREAL, [STR(text)]), expectedReal, precision)
  expectNumberClose(call(IMAGINARY, [STR(text)]), expectedImag, precision)
}

describe('DEC2BIN', () => {
  test('5 → "101"', () => expect(call(DEC2BIN, [NUM(5)])).toEqual(STR('101')))
  test('0 → "0"', () => expect(call(DEC2BIN, [NUM(0)])).toEqual(STR('0')))
  test('with places: 5, 8 → "00000101"', () =>
    expect(call(DEC2BIN, [NUM(5), NUM(8)])).toEqual(STR('00000101')))
  test('out of range → #NUM!', () =>
    expect(call(DEC2BIN, [NUM(10000)])).toEqual(ERR('#NUM!')))
})

describe('DEC2HEX', () => {
  test('255 → "FF"', () => expect(call(DEC2HEX, [NUM(255)])).toEqual(STR('FF')))
  test('with places: 255, 4 → "00FF"', () =>
    expect(call(DEC2HEX, [NUM(255), NUM(4)])).toEqual(STR('00FF')))
  test('non-numeric → #VALUE!', () =>
    expect(call(DEC2HEX, [STR('abc')])).toEqual(ERR('#VALUE!')))
})

describe('DEC2OCT', () => {
  test('8 → "10"', () => expect(call(DEC2OCT, [NUM(8)])).toEqual(STR('10')))
  test('63 → "77"', () => expect(call(DEC2OCT, [NUM(63)])).toEqual(STR('77')))
  test('negative round-trip', () => {
    // -1 in 10-digit octal w/ 2s complement
    const r = call(DEC2OCT, [NUM(-1)])
    expect(r.kind).toBe('string')
  })
})

describe('BIN2DEC / OCT2DEC / HEX2DEC', () => {
  test('BIN2DEC("101") = 5', () => expect(call(BIN2DEC, [STR('101')])).toEqual(NUM(5)))
  test('OCT2DEC("77") = 63', () => expect(call(OCT2DEC, [STR('77')])).toEqual(NUM(63)))
  test('HEX2DEC("FF") = 255', () => expect(call(HEX2DEC, [STR('FF')])).toEqual(NUM(255)))
  test('invalid digits → #NUM!', () => expect(call(BIN2DEC, [STR('123')])).toEqual(ERR('#NUM!')))
})

describe('BIN2HEX / BIN2OCT', () => {
  test('BIN2HEX("1111") = "F"', () => expect(call(BIN2HEX, [STR('1111')])).toEqual(STR('F')))
  test('BIN2HEX negative two-complement keeps 10 hex digits', () =>
    expect(call(BIN2HEX, [STR('1111111111')])).toEqual(STR('FFFFFFFFFF')))
  test('BIN2HEX pads positive values with places', () =>
    expect(call(BIN2HEX, [STR('1010'), NUM(4)])).toEqual(STR('000A')))
  test('BIN2HEX places too small → #NUM!', () =>
    expect(call(BIN2HEX, [STR('11111'), NUM(1)])).toEqual(ERR('#NUM!')))
  test('BIN2HEX invalid binary input → #NUM!', () =>
    expect(call(BIN2HEX, [STR('2')])).toEqual(ERR('#NUM!')))

  test('BIN2OCT("1010") = "12"', () => expect(call(BIN2OCT, [STR('1010')])).toEqual(STR('12')))
  test('BIN2OCT negative two-complement keeps 10 octal digits', () =>
    expect(call(BIN2OCT, [STR('1111111111')])).toEqual(STR('7777777777')))
  test('BIN2OCT pads positive values with places', () =>
    expect(call(BIN2OCT, [STR('1010'), NUM(4)])).toEqual(STR('0012')))
})

describe('HEX2BIN / HEX2OCT', () => {
  test('HEX2BIN("A") = "1010"', () => expect(call(HEX2BIN, [STR('A')])).toEqual(STR('1010')))
  test('HEX2BIN negative two-complement keeps 10 binary digits', () =>
    expect(call(HEX2BIN, [STR('FFFFFFFFFF')])).toEqual(STR('1111111111')))
  test('HEX2BIN target overflow → #NUM!', () =>
    expect(call(HEX2BIN, [STR('FFF')])).toEqual(ERR('#NUM!')))
  test('HEX2BIN pads positive values with places', () =>
    expect(call(HEX2BIN, [STR('A'), NUM(6)])).toEqual(STR('001010')))
  test('HEX2BIN invalid hex input → #NUM!', () =>
    expect(call(HEX2BIN, [STR('G')])).toEqual(ERR('#NUM!')))

  test('HEX2OCT("F") = "17"', () => expect(call(HEX2OCT, [STR('F')])).toEqual(STR('17')))
  test('HEX2OCT negative two-complement keeps 10 octal digits', () =>
    expect(call(HEX2OCT, [STR('FFFFFFFFFF')])).toEqual(STR('7777777777')))
  test('HEX2OCT pads positive values with places', () =>
    expect(call(HEX2OCT, [STR('F'), NUM(4)])).toEqual(STR('0017')))
})

describe('OCT2BIN / OCT2HEX', () => {
  test('OCT2BIN("12") = "1010"', () => expect(call(OCT2BIN, [STR('12')])).toEqual(STR('1010')))
  test('OCT2BIN negative two-complement keeps 10 binary digits', () =>
    expect(call(OCT2BIN, [STR('7777777777')])).toEqual(STR('1111111111')))
  test('OCT2BIN target overflow → #NUM!', () =>
    expect(call(OCT2BIN, [STR('1000')])).toEqual(ERR('#NUM!')))

  test('OCT2HEX("17") = "F"', () => expect(call(OCT2HEX, [STR('17')])).toEqual(STR('F')))
  test('OCT2HEX negative two-complement keeps 10 hex digits', () =>
    expect(call(OCT2HEX, [STR('7777777777')])).toEqual(STR('FFFFFFFFFF')))
  test('OCT2HEX pads positive values with places', () =>
    expect(call(OCT2HEX, [STR('17'), NUM(4)])).toEqual(STR('000F')))
})

describe('BITAND / BITOR / BITXOR', () => {
  test('BITAND(5, 3) = 1', () => expect(call(BITAND, [NUM(5), NUM(3)])).toEqual(NUM(1)))
  test('BITOR(5, 3) = 7', () => expect(call(BITOR, [NUM(5), NUM(3)])).toEqual(NUM(7)))
  test('BITXOR(5, 3) = 6', () => expect(call(BITXOR, [NUM(5), NUM(3)])).toEqual(NUM(6)))
  test('negative → #NUM!', () => expect(call(BITAND, [NUM(-1), NUM(0)])).toEqual(ERR('#NUM!')))
})

describe('BITLSHIFT / BITRSHIFT', () => {
  test('BITLSHIFT(1, 4) = 16', () => expect(call(BITLSHIFT, [NUM(1), NUM(4)])).toEqual(NUM(16)))
  test('BITRSHIFT(16, 2) = 4', () => expect(call(BITRSHIFT, [NUM(16), NUM(2)])).toEqual(NUM(4)))
  test('BITLSHIFT shift > 53 → #NUM!', () =>
    expect(call(BITLSHIFT, [NUM(1), NUM(60)])).toEqual(ERR('#NUM!')))
})

describe('DELTA', () => {
  test('equal → 1', () => expect(call(DELTA, [NUM(5), NUM(5)])).toEqual(NUM(1)))
  test('not equal → 0', () => expect(call(DELTA, [NUM(5), NUM(3)])).toEqual(NUM(0)))
  test('single arg uses 0 default: DELTA(0) = 1', () => expect(call(DELTA, [NUM(0)])).toEqual(NUM(1)))
})

describe('GESTEP', () => {
  test('n >= step → 1', () => expect(call(GESTEP, [NUM(5), NUM(3)])).toEqual(NUM(1)))
  test('n < step → 0', () => expect(call(GESTEP, [NUM(2), NUM(3)])).toEqual(NUM(0)))
  test('single arg uses 0 default: GESTEP(5) = 1', () =>
    expect(call(GESTEP, [NUM(5)])).toEqual(NUM(1)))
})

describe('BESSELJ / BESSELY / BESSELI / BESSELK', () => {
  test('BESSELJ covers zero, low order, recurrence, and truncated order', () => {
    expectNumberClose(call(BESSELJ, [NUM(0), NUM(0)]), 1, 5)
    expectNumberClose(call(BESSELJ, [NUM(0), NUM(5)]), 0, 5)
    expectNumberClose(call(BESSELJ, [NUM(1), NUM(0)]), 0.7651976866, 5)
    expectNumberClose(call(BESSELJ, [NUM(1), NUM(1.9)]), 0.4400505857, 5)
    expectNumberClose(call(BESSELJ, [NUM(2), NUM(5)]), 0.0070396298635, 4)
  })

  test('BESSELY rejects non-positive x and evaluates common orders', () => {
    expect(call(BESSELY, [NUM(0), NUM(0)])).toEqual(ERR('#NUM!'))
    expect(call(BESSELY, [NUM(-1), NUM(0)])).toEqual(ERR('#NUM!'))
    expectNumberClose(call(BESSELY, [NUM(1), NUM(0)]), 0.0882569642, 4)
    expectNumberClose(call(BESSELY, [NUM(1), NUM(1)]), -0.7812128213, 4)
    expectNumberClose(call(BESSELY, [NUM(1), NUM(2)]), -1.6506826, 3)
  })

  test('BESSELI covers modified first kind and negative-order errors', () => {
    expectNumberClose(call(BESSELI, [NUM(0), NUM(0)]), 1, 5)
    expectNumberClose(call(BESSELI, [NUM(0), NUM(4)]), 0, 5)
    expectNumberClose(call(BESSELI, [NUM(1), NUM(0)]), 1.2660658, 5)
    expectNumberClose(call(BESSELI, [NUM(1), NUM(1)]), 0.5651591, 5)
    expectNumberClose(call(BESSELI, [NUM(2), NUM(3)]), 0.2127836, 4)
    expect(call(BESSELI, [NUM(1), NUM(-1)])).toEqual(ERR('#NUM!'))
  })

  test('BESSELK rejects non-positive x and evaluates common orders', () => {
    expect(call(BESSELK, [NUM(0), NUM(0)])).toEqual(ERR('#NUM!'))
    expectNumberClose(call(BESSELK, [NUM(1), NUM(0)]), 0.42102443, 4)
    expectNumberClose(call(BESSELK, [NUM(1), NUM(1)]), 0.60190723, 4)
    expectNumberClose(call(BESSELK, [NUM(1), NUM(2)]), 1.6248389, 3)
  })

  test('argument count and non-finite errors use #VALUE! / #NUM!', () => {
    expect(call(BESSELJ, [])).toEqual(ERR('#VALUE!'))
    expect(call(BESSELJ, [NUM(1)])).toEqual(ERR('#VALUE!'))
    expect(call(BESSELJ, [NUM(1), NUM(0), NUM(2)])).toEqual(ERR('#VALUE!'))
    expect(call(BESSELJ, [NUM(Number.POSITIVE_INFINITY), NUM(0)])).toEqual(ERR('#NUM!'))
  })
})

describe('ERF / ERFC', () => {
  test('ERF evaluates one-arg and two-arg forms', () => {
    expect(call(ERF, [NUM(0)])).toEqual(NUM(0))
    expectNumberClose(call(ERF, [NUM(1)]), 0.8427007929, 6)
    expectNumberClose(call(ERF, [NUM(1), NUM(2)]), 0.9953222650 - 0.8427007929, 5)
  })

  test('ERFC and precise aliases mirror ERF/ERFC behavior', () => {
    expectNumberClose(call(ERFC, [NUM(1)]), 1 - 0.8427007929, 6)
    expect(call(ERF_PRECISE, [NUM(0.5)])).toEqual(call(ERF, [NUM(0.5)]))
    expect(call(ERFC_PRECISE, [NUM(2)])).toEqual(call(ERFC, [NUM(2)]))
  })

  test('argument count and non-finite errors', () => {
    expect(call(ERF, [])).toEqual(ERR('#VALUE!'))
    expect(call(ERFC, [])).toEqual(ERR('#VALUE!'))
    expect(call(ERFC, [NUM(1), NUM(2)])).toEqual(ERR('#VALUE!'))
    expect(call(ERF, [NUM(Number.NaN)])).toEqual(ERR('#NUM!'))
  })

  // High-precision regression — Cody's rational Chebyshev kernel should match
  // reference values (Wolfram / glibc __erf) to within ~1 ULP across the
  // sub-1 and small-x ranges where the previous A&S 7.1.26 fit only gave 1.5e-7.
  test('ERF matches IEEE 754 double-precision reference values', () => {
    expectNumberClose(call(ERF, [NUM(0.1)]), 0.1124629160182849, 15)
    expectNumberClose(call(ERF, [NUM(0.5)]), 0.5204998778130465, 15)
    expectNumberClose(call(ERF, [NUM(1)]), 0.8427007929497149, 15)
    expectNumberClose(call(ERF, [NUM(1.5)]), 0.9661051464753108, 15)
    expectNumberClose(call(ERF, [NUM(2)]), 0.9953222650189527, 15)
    expectNumberClose(call(ERF, [NUM(3)]), 0.9999779095030014, 15)
    // erf(5) ≠ 1 in IEEE 754 double — the erfc tail of ~1.54e-12 is still
    // representable. erf(10) saturates fully because exp(-100) underflows.
    expectNumberClose(call(ERF, [NUM(5)]), 0.9999999999984625, 15)
    expect(numberValue(call(ERF, [NUM(10)]))).toBe(1)
    expect(numberValue(call(ERF, [NUM(-10)]))).toBe(-1)
  })

  test('ERFC matches IEEE 754 double-precision reference values', () => {
    expectNumberClose(call(ERFC, [NUM(0.1)]), 0.8875370839817151, 15)
    expectNumberClose(call(ERFC, [NUM(0.5)]), 0.4795001221869535, 15)
    expectNumberClose(call(ERFC, [NUM(1)]), 0.1572992070502851, 15)
    expectNumberClose(call(ERFC, [NUM(2)]), 0.004677734981047266, 17)
    expectNumberClose(call(ERFC, [NUM(3)]), 2.2090496998585441e-5, 19)
    // Large argument: previous polynomial fit returned ~0; Cody's kernel
    // still produces the right exp(-x^2)/x*sqrt(pi) tail.
    expectNumberClose(call(ERFC, [NUM(5)]), 1.5374597944280351e-12, 25)
  })

  test('ERF.PRECISE matches ERF for the same reference points', () => {
    for (const x of [0.1, 0.5, 1, 1.5, 2, 3, -0.5, -2]) {
      expect(call(ERF_PRECISE, [NUM(x)])).toEqual(call(ERF, [NUM(x)]))
    }
  })

  test('ERF is exactly antisymmetric around zero', () => {
    for (const x of [0.1, 0.25, 0.5, 0.8, 1, 2, 3]) {
      const pos = numberValue(call(ERF, [NUM(x)]))
      const neg = numberValue(call(ERF, [NUM(-x)]))
      expect(neg).toBe(-pos)
    }
  })
})

describe('CONVERT', () => {
  test('converts Rust-supported length, mass, and time units', () => {
    expectNumberClose(call(CONVERT, [NUM(1), STR('yd'), STR('m')]), 0.9144, 9)
    expectNumberClose(call(CONVERT, [NUM(100), STR('cm'), STR('m')]), 1, 9)
    expectNumberClose(call(CONVERT, [NUM(1), STR('mi'), STR('m')]), 1609.344, 6)
    expectNumberClose(call(CONVERT, [NUM(1), STR('kg'), STR('lbm')]), 2.20462262185, 6)
    expectNumberClose(call(CONVERT, [NUM(60), STR('sec'), STR('mn')]), 1, 9)
  })

  test('converts pressure, energy, power, and temperature units', () => {
    expectNumberClose(call(CONVERT, [NUM(1), STR('atm'), STR('Pa')]), 101325, 3)
    expectNumberClose(call(CONVERT, [NUM(1), STR('at'), STR('p')]), 101325, 3)
    expectNumberClose(call(CONVERT, [NUM(1), STR('psi'), STR('Pa')]), 6894.757293168, 3)
    expectNumberClose(call(CONVERT, [NUM(1), STR('e'), STR('J')]), 1e-7, 12)
    expectNumberClose(call(CONVERT, [NUM(1), STR('c'), STR('J')]), 4.184, 9)
    expectNumberClose(call(CONVERT, [NUM(1), STR('cal'), STR('J')]), 4.184, 9)
    expectNumberClose(call(CONVERT, [NUM(1), STR('flb'), STR('J')]), 1.3558179483314004, 9)
    expectNumberClose(call(CONVERT, [NUM(1), STR('Wh'), STR('J')]), 3600, 9)
    expectNumberClose(call(CONVERT, [NUM(1), STR('wh'), STR('J')]), 3600, 9)
    expectNumberClose(call(CONVERT, [NUM(1), STR('HPh'), STR('J')]), 2684519.537696173, 3)
    expectNumberClose(call(CONVERT, [NUM(1), STR('hh'), STR('J')]), 2684519.537696173, 3)
    expectNumberClose(call(CONVERT, [NUM(1), STR('kWh'), STR('J')]), 3600000, 3)
    expectNumberClose(call(CONVERT, [NUM(1), STR('HP'), STR('W')]), 745.69987158227022, 3)
    expectNumberClose(call(CONVERT, [NUM(212), STR('F'), STR('C')]), 100, 9)
    expectNumberClose(call(CONVERT, [NUM(0), STR('C'), STR('K')]), 273.15, 9)
  })

  test('rejects unknown or incompatible units and wrong arg counts', () => {
    expect(call(CONVERT, [NUM(1), STR('kg'), STR('sec')])).toEqual(ERR('#N/A'))
    expect(call(CONVERT, [NUM(1), STR('frobnicate'), STR('m')])).toEqual(ERR('#N/A'))
    expect(call(CONVERT, [NUM(1), STR('m')])).toEqual(ERR('#VALUE!'))
    expect(call(CONVERT, [NUM(1), STR('m'), STR('cm'), NUM(1)])).toEqual(ERR('#VALUE!'))
  })
})

describe('COMPLEX', () => {
  test('formats common, pure-real, and pure-imaginary values', () => {
    expect(call(COMPLEX, [NUM(3), NUM(4)])).toEqual(STR('3+4i'))
    expect(call(COMPLEX, [NUM(3), NUM(4), STR('j')])).toEqual(STR('3+4j'))
    expect(call(COMPLEX, [NUM(3), NUM(0)])).toEqual(STR('3'))
    expect(call(COMPLEX, [NUM(0), NUM(1)])).toEqual(STR('i'))
    expect(call(COMPLEX, [NUM(0), NUM(-1)])).toEqual(STR('-i'))
  })

  test('invalid suffix → #VALUE!', () =>
    expect(call(COMPLEX, [NUM(3), NUM(4), STR('k')])).toEqual(ERR('#VALUE!')))
})

describe('IM accessors', () => {
  test('reads common, pure-real, pure-imaginary, and j-suffix values', () => {
    expect(call(IMABS, [STR('3+4i')])).toEqual(NUM(5))
    expect(call(IMREAL, [STR('5')])).toEqual(NUM(5))
    expect(call(IMAGINARY, [STR('-i')])).toEqual(NUM(-1))
    expect(call(IMREAL, [STR('5-2j')])).toEqual(NUM(5))
    expect(call(IMAGINARY, [STR('5-2j')])).toEqual(NUM(-2))
  })

  test('argument handles quadrant and origin', () => {
    expectNumberClose(call(IMARGUMENT, [STR('1+i')]), Math.PI / 4)
    expect(call(IMARGUMENT, [STR('0')])).toEqual(ERR('#DIV/0!'))
  })

  test('invalid complex text → #VALUE!', () =>
    expect(call(IMABS, [STR('abc')])).toEqual(ERR('#VALUE!')))
})

describe('IM arithmetic', () => {
  test('conjugate, sum, subtraction, product, and division', () => {
    expect(call(IMCONJUGATE, [STR('3+4i')])).toEqual(STR('3-4i'))
    expect(call(IMCONJUGATE, [STR('5-2j')])).toEqual(STR('5+2j'))
    expect(call(IMSUM, [STR('3+4j'), STR('1+2i')])).toEqual(STR('4+6j'))
    expect(call(IMSUM, [NUM(4), STR('1+2j')])).toEqual(STR('5+2j'))
    expect(call(IMSUB, [STR('3+4i'), STR('1+2i')])).toEqual(STR('2+2i'))
    expect(call(IMPRODUCT, [STR('2+3i'), STR('4+5i')])).toEqual(STR('-7+22i'))
    expect(call(IMPRODUCT, [NUM(2), STR('1+2j')])).toEqual(STR('2+4j'))
    expect(call(IMDIV, [STR('4+2i'), STR('1+i')])).toEqual(STR('3-i'))
  })

  test('division by zero → #DIV/0!', () =>
    expect(call(IMDIV, [STR('3+4i'), STR('0')])).toEqual(ERR('#DIV/0!')))

  test('IMSUM/IMPRODUCT suffix: any j wins regardless of arg position', () => {
    // 'j' on a later arg still flips output suffix to 'j' (Excel rule)
    expect(call(IMSUM, [STR('3+4i'), STR('5+6j')])).toEqual(STR('8+10j'))
    // all-'i' inputs stay 'i'
    expect(call(IMSUM, [STR('3+4i'), STR('5+6i')])).toEqual(STR('8+10i'))
    // IMPRODUCT: 'j' on first, 'i' on second → 'j'
    // (1+2j)(3+4i) → 3+4i+6j+8ij = treating both suffixes as same √-1 → 3+4j+6j-8 = -5+10j
    expect(call(IMPRODUCT, [STR('1+2j'), STR('3+4i')])).toEqual(STR('-5+10j'))
    // all-'i' inputs stay 'i'
    expect(call(IMPRODUCT, [STR('1+2i'), STR('3+4i')])).toEqual(STR('-5+10i'))
  })
})

describe('IM exp, logs, sqrt, and power', () => {
  test('evaluates common complex and real-axis values', () => {
    expectComplexClose(call(IMEXP, [STR('1+2i')]), -1.1312043837568135, 2.4717266720048188)
    expectComplexClose(call(IMLN, [STR('1+2i')]), 0.8047189562170503, 1.1071487177940904)
    expectComplexClose(call(IMLOG10, [STR('100')]), 2, 0)
    expectComplexClose(call(IMLOG2, [STR('8')]), 3, 0)
    expectComplexClose(call(IMSQRT, [STR('-1')]), 0, 1)
    expectComplexClose(call(IMSQRT, [STR('-1+0j')]), 0, 1)
    expectComplexClose(call(IMPOWER, [STR('1+i'), NUM(2)]), 0, 2)
  })

  test('zero domains follow Excel-compatible errors', () => {
    expect(call(IMLN, [STR('0')])).toEqual(ERR('#NUM!'))
    expect(call(IMPOWER, [STR('0'), NUM(0)])).toEqual(STR('1'))
    expect(call(IMPOWER, [STR('0'), NUM(-1)])).toEqual(ERR('#NUM!'))
  })
})

describe('IM trigonometric and hyperbolic functions', () => {
  test('evaluates common a+bi values', () => {
    expectComplexClose(call(IMCOS, [STR('1+2i')]), 2.0327230070196656, -3.0518977991518)
    expectComplexClose(call(IMSIN, [STR('1+2i')]), 3.165778513216168, 1.9596010414216063)
    expectComplexClose(call(IMCOSH, [STR('1+2i')]), -0.64214812471552, 1.0686074213827783)
    expectComplexClose(call(IMSINH, [STR('1+2i')]), -0.4890562590412937, 1.4031192506220405)
    expectComplexClose(call(IMTAN, [STR('1+2i')]), 0.0338128260798966, 1.0147936161466335)
    expectComplexClose(call(IMSEC, [STR('1+2i')]), 0.15117629826557724, 0.2269736753937216)
    expectComplexClose(call(IMCSC, [STR('1+2i')]), 0.22837506559968654, -0.1413630216124078)
    expectComplexClose(call(IMCOT, [STR('1+2i')]), 0.0327977555337525, -0.9843292264581908)
    expectComplexClose(call(IMSECH, [STR('1+2i')]), -0.41314934426694, -0.6875274386554789)
    expectComplexClose(call(IMCSCH, [STR('1+2i')]), -0.22150093085050945, -0.6354937992539)
  })

  test('real-axis identities and singularities', () => {
    expect(call(IMCOS, [STR('0')])).toEqual(STR('1'))
    expect(call(IMSIN, [STR('0')])).toEqual(STR('0'))
    expect(call(IMCOSH, [STR('0')])).toEqual(STR('1'))
    expect(call(IMSINH, [STR('0')])).toEqual(STR('0'))
    expect(call(IMTAN, [STR('0')])).toEqual(STR('0'))
    expect(call(IMSEC, [STR('0')])).toEqual(STR('1'))
    expect(call(IMSECH, [STR('0')])).toEqual(STR('1'))
    expect(call(IMCOT, [STR('0')])).toEqual(ERR('#NUM!'))
    expect(call(IMCSC, [STR('0')])).toEqual(ERR('#NUM!'))
    expect(call(IMCSCH, [STR('0')])).toEqual(ERR('#NUM!'))
  })
})

describe('engineering FUNCTIONS registry', () => {
  const registered = {
    BESSELI,
    BESSELJ,
    BESSELK,
    BESSELY,
    CONVERT,
    ERF,
    'ERF.PRECISE': ERF_PRECISE,
    ERFC,
    'ERFC.PRECISE': ERFC_PRECISE,
    COMPLEX,
    IMABS,
    IMAGINARY,
    IMARGUMENT,
    IMCONJUGATE,
    IMCOS,
    IMCOSH,
    IMCOT,
    IMCSC,
    IMCSCH,
    IMDIV,
    IMEXP,
    IMLN,
    IMLOG10,
    IMLOG2,
    IMPOWER,
    IMPRODUCT,
    IMREAL,
    IMSEC,
    IMSECH,
    IMSIN,
    IMSINH,
    IMSQRT,
    IMSUB,
    IMSUM,
    IMTAN,
  } as const

  for (const [name, fn] of Object.entries(registered)) {
    test(`${name} is registered`, () => {
      expect(FUNCTIONS[name]).toBe(fn)
    })
  }
})
