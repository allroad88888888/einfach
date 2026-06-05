import { describe, expect, test } from '@jest/globals'

import { FUNCTIONS } from '../src/eval/functions/stats'
import type { EvalContext, FunctionImpl, Value } from '../src/types'

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const STR = (s: string): Value => ({ kind: 'string', value: s })
const BOOL = (b: boolean): Value => ({ kind: 'boolean', value: b })
const BLANK: Value = { kind: 'blank' }
const ERR = (code: '#DIV/0!' | '#N/A' | '#NUM!' | '#VALUE!'): Value => ({
  kind: 'error',
  code,
})
const ARR = (values: number[]): Value => ({
  kind: 'array',
  value: [values.map((value) => NUM(value))],
})
const ARR2 = (rows: number[][]): Value => ({
  kind: 'array',
  value: rows.map((row) => row.map((value) => NUM(value))),
})
const VALARR = (values: Value[]): Value => ({ kind: 'array', value: [values] })

const ctx: EvalContext = new Proxy(
  {},
  {
    get(_, prop) {
      throw new Error(`stats disjoint test unexpectedly read ctx.${String(prop)}`)
    },
  },
) as unknown as EvalContext

const get = (name: string): FunctionImpl => {
  const fn = FUNCTIONS[name]
  if (!fn) throw new Error(`missing function ${name}`)
  return fn
}

const call = (name: string, args: Value[]): Value => get(name)(args, ctx)

const asNumber = (value: Value): number => {
  if (value.kind !== 'number') throw new Error(`expected number, got ${JSON.stringify(value)}`)
  return value.value
}

const asArray = (value: Value): Value[][] => {
  if (value.kind !== 'array') throw new Error(`expected array, got ${JSON.stringify(value)}`)
  return value.value
}

const expectClose = (name: string, args: Value[], expected: number): void => {
  expect(asNumber(call(name, args))).toBeCloseTo(expected, 10)
}

describe('stats disjoint function fill-out', () => {
  test('registry exposes the selected modern names and aliases', () => {
    const names = [
      'STDEV.S',
      'STDEV.P',
      'VAR.S',
      'VAR.P',
      'COVAR',
      'COVAR.P',
      'COVAR.S',
      'COVARIANCE.P',
      'COVARIANCE.S',
      'PEARSON',
      'RANK.EQ',
      'RANK.AVG',
      'PERCENTILE.INC',
      'QUARTILE.INC',
      'MODE.SNGL',
      'AVEDEV',
      'DEVSQ',
      'MAXA',
      'MINA',
      'STDEVA',
      'STDEVPA',
      'VARA',
      'VARPA',
      'STANDARDIZE',
      'GEOMEAN',
      'HARMEAN',
      'TRIMMEAN',
      'FISHER',
      'FISHERINV',
      'RSQ',
      'SKEW',
      'SKEW.P',
      'KURT',
      'FORECAST',
      'FORECAST.LINEAR',
      'PERCENTRANK',
      'PERCENTRANK.INC',
      'PERCENTRANK.EXC',
      'PROB',
      'NORM.DIST',
      'NORM.S.DIST',
      'NORM.INV',
      'NORM.S.INV',
      'NORMDIST',
      'NORMSDIST',
      'NORMINV',
      'NORMSINV',
      'LOGNORM.DIST',
      'LOGNORM.INV',
      'LOGNORMDIST',
      'LOGINV',
      'EXPON.DIST',
      'EXPONDIST',
      'POISSON.DIST',
      'POISSON',
      'WEIBULL.DIST',
      'WEIBULL',
      'PHI',
      'GAUSS',
      'Z.TEST',
      'ZTEST',
      'CONFIDENCE.NORM',
      'CONFIDENCE',
      'CONFIDENCE.T',
      'PERCENTILE.EXC',
      'QUARTILE.EXC',
      'RANKEQ',
      'RANKAVG',
      'MODE.MULT',
      'FREQUENCY',
      'GAMMA',
      'GAMMA.DIST',
      'GAMMA.INV',
      'GAMMADIST',
      'GAMMAINV',
      'GAMMALN',
      'GAMMALN.PRECISE',
      'BETA.DIST',
      'BETA.INV',
      'BETADIST',
      'BETAINV',
      'BINOM.DIST',
      'BINOM.DIST.RANGE',
      'BINOM.INV',
      'BINOMDIST',
      'CRITBINOM',
      'CHIDIST',
      'CHIINV',
      'CHISQ.DIST',
      'CHISQ.DIST.RT',
      'CHISQ.INV',
      'CHISQ.INV.RT',
      'CHISQ.TEST',
      'CHITEST',
      'F.DIST',
      'F.DIST.RT',
      'F.INV',
      'F.INV.RT',
      'F.TEST',
      'FDIST',
      'FINV',
      'FTEST',
      'HYPGEOM.DIST',
      'HYPGEOMDIST',
      'NEGBINOM.DIST',
      'NEGBINOMDIST',
      'T.DIST',
      'T.DIST.2T',
      'T.DIST.RT',
      'T.INV',
      'T.INV.2T',
      'T.TEST',
      'TDIST',
      'TINV',
      'TTEST',
      'STEYX',
      'TREND',
      'GROWTH',
      'LINEST',
      'LOGEST',
    ]
    expect(names.filter((name) => !FUNCTIONS[name])).toEqual([])
  })

  test('STDEV.S and STDEV.P reuse sample and population helpers', () => {
    const data = [NUM(2), NUM(4), NUM(4), NUM(4), NUM(5), NUM(5), NUM(7), NUM(9)]
    expectClose('STDEV.S', data, Math.sqrt(32 / 7))
    expectClose('STDEV.P', data, 2)
  })

  test('VAR.S and VAR.P reuse sample and population helpers', () => {
    const data = [NUM(1), NUM(2), NUM(3), NUM(4), NUM(5)]
    expectClose('VAR.S', data, 2.5)
    expectClose('VAR.P', data, 2)
  })

  test('PERCENTILE.INC, QUARTILE.INC, and MODE.SNGL mirror existing helpers', () => {
    expectClose('PERCENTILE.INC', [ARR([1, 2, 3, 4, 5]), NUM(0.25)], 2)
    expectClose('QUARTILE.INC', [ARR([1, 2, 3, 4, 5]), NUM(3)], 4)
    expect(call('MODE.SNGL', [ARR([1, 2, 2, 3, 3, 3])])).toEqual(NUM(3))
  })

  test('PEARSON mirrors CORREL', () => {
    expectClose('PEARSON', [ARR([1, 2, 3]), ARR([2, 4, 6])], 1)
    expectClose('PEARSON', [ARR([1, 2, 3]), ARR([6, 4, 2])], -1)
  })

  test('RANK.EQ returns competition rank and RANK.AVG averages ties', () => {
    const ref = ARR([10, 20, 20, 30])
    expect(call('RANK.EQ', [NUM(20), ref])).toEqual(NUM(2))
    expect(call('RANK.AVG', [NUM(20), ref])).toEqual(NUM(2.5))
    expect(call('RANK.AVG', [NUM(30), ref, NUM(1)])).toEqual(NUM(4))
  })

  test('COVAR, COVAR.P, and COVARIANCE.P return population covariance', () => {
    const args = [ARR([1, 2, 3, 4]), ARR([2, 4, 6, 8])]
    expectClose('COVAR', args, 2.5)
    expectClose('COVAR.P', args, 2.5)
    expectClose('COVARIANCE.P', args, 2.5)
  })

  test('COVAR.S and COVARIANCE.S return sample covariance', () => {
    const args = [ARR([1, 2, 3, 4]), ARR([2, 4, 6, 8])]
    expectClose('COVAR.S', args, 10 / 3)
    expectClose('COVARIANCE.S', args, 10 / 3)
  })

  test('covariance aliases validate arity, length, and sample size', () => {
    expect(call('COVARIANCE.P', [ARR([1]), ARR([1, 2])])).toEqual(ERR('#N/A'))
    expect(call('COVARIANCE.P', [])).toEqual(ERR('#VALUE!'))
    expect(call('COVARIANCE.S', [ARR([1]), ARR([2])])).toEqual(ERR('#DIV/0!'))
  })

  test('AVEDEV and DEVSQ compute deviations and use range numeric-only semantics', () => {
    expectClose('AVEDEV', [ARR([1, 2, 3, 6, 8])], 2.4)
    expectClose('DEVSQ', [ARR([1, 2, 3, 4, 5])], 10)
    expectClose('AVEDEV', [VALARR([NUM(1), STR('ignored'), BOOL(true), BLANK, NUM(3)])], 1)
    expect(call('AVEDEV', [VALARR([ERR('#VALUE!')])])).toEqual(ERR('#VALUE!'))
  })

  test('MAXA, MINA, and A-variance functions include text and booleans but skip blanks', () => {
    const mixed = VALARR([NUM(1), BOOL(false), NUM(3), STR('text'), BLANK])
    expect(call('MAXA', [NUM(-1), BOOL(false), BOOL(true)])).toEqual(NUM(1))
    expect(call('MINA', [NUM(5), STR('hello'), NUM(10)])).toEqual(NUM(0))
    expect(call('MAXA', [BLANK])).toEqual(NUM(0))
    expectClose('VARA', [mixed], 2)
    expectClose('VARPA', [mixed], 1.5)
    expectClose('STDEVA', [mixed], Math.sqrt(2))
    expectClose('STDEVPA', [mixed], Math.sqrt(1.5))
  })

  test('STANDARDIZE, GEOMEAN, HARMEAN, and TRIMMEAN cover numeric and boundary cases', () => {
    expectClose('STANDARDIZE', [NUM(7), NUM(5), NUM(2)], 1)
    expect(call('STANDARDIZE', [NUM(1), NUM(0), NUM(0)])).toEqual(ERR('#NUM!'))
    expectClose('GEOMEAN', [VALARR([NUM(2), STR('ignored'), BLANK, NUM(8)])], 4)
    expect(call('GEOMEAN', [ARR([1, 0, 2])])).toEqual(ERR('#NUM!'))
    expectClose('HARMEAN', [ARR([1, 2, 4])], 3 / 1.75)
    expect(call('HARMEAN', [ARR([1, -1, 2])])).toEqual(ERR('#NUM!'))
    expectClose('TRIMMEAN', [ARR([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), NUM(0.2)], 5.5)
    expect(call('TRIMMEAN', [ARR([1, 2, 3]), NUM(1)])).toEqual(ERR('#NUM!'))
  })

  test('FISHER and FISHERINV handle transforms and invalid domains', () => {
    expectClose('FISHER', [NUM(0.75)], 0.5 * Math.log(7))
    expectClose('FISHERINV', [call('FISHER', [NUM(0.5)])], 0.5)
    expect(call('FISHER', [NUM(1)])).toEqual(ERR('#NUM!'))
    expect(call('FISHER', [ERR('#VALUE!')])).toEqual(ERR('#VALUE!'))
  })

  test('RSQ and FORECAST use paired numeric points and expose FORECAST.LINEAR alias', () => {
    const xs = ARR([1, 2, 3, 4, 5])
    const ys = ARR([2, 4, 6, 8, 10])
    expectClose('RSQ', [ys, xs], 1)
    expectClose('FORECAST', [NUM(10), ys, xs], 20)
    expectClose('FORECAST.LINEAR', [NUM(10), ys, xs], 20)
    expectClose(
      'FORECAST',
      [NUM(4), VALARR([NUM(2), NUM(4), STR('skip'), NUM(8)]), ARR([1, 2, 3, 4])],
      8,
    )
    expect(call('RSQ', [ARR([1, 2]), ARR([1])])).toEqual(ERR('#N/A'))
    expect(call('FORECAST', [NUM(1), ARR([1, 2]), ARR([5, 5])])).toEqual(ERR('#DIV/0!'))
  })

  test('SKEW, SKEW.P, and KURT compute moments and reject insufficient or constant data', () => {
    expectClose('SKEW', [ARR([1, 2, 3, 4, 5])], 0)
    expect(asNumber(call('SKEW.P', [ARR([1, 1, 1, 2, 10])]))).toBeGreaterThan(0.5)
    expectClose('KURT', [ARR([1, 2, 3, 4, 5])], -1.2)
    expect(call('SKEW', [ARR([1, 2])])).toEqual(ERR('#NUM!'))
    expect(call('KURT', [ARR([1, 1, 1, 1])])).toEqual(ERR('#DIV/0!'))
  })

  test('PERCENTRANK variants interpolate, truncate by significance, and validate bounds', () => {
    const values = ARR([10, 20, 30, 40])
    expectClose('PERCENTRANK', [values, NUM(25)], 0.5)
    expectClose('PERCENTRANK.INC', [values, NUM(40)], 1)
    expectClose('PERCENTRANK.EXC', [values, NUM(20)], 0.4)
    expectClose('PERCENTRANK.INC', [values, NUM(22), NUM(2)], 0.4)
    expect(call('PERCENTRANK.INC', [values, NUM(5)])).toEqual(ERR('#N/A'))
    expect(call('PERCENTRANK.EXC', [values, NUM(20), NUM(0)])).toEqual(ERR('#NUM!'))
  })

  test('PROB sums probabilities over inclusive bounds and validates probability ranges', () => {
    const xs = ARR([0, 1, 2, 3])
    const ps = ARR([0.1, 0.2, 0.3, 0.4])
    expectClose('PROB', [xs, ps, NUM(1), NUM(2)], 0.5)
    expectClose('PROB', [xs, ps, NUM(2)], 0.3)
    expectClose('PROB', [xs, ps, NUM(3), NUM(1)], 0.9)
    expect(call('PROB', [xs, ARR([0.1, 0.2]), NUM(1)])).toEqual(ERR('#N/A'))
    expect(call('PROB', [xs, ARR([0.1, 0.2, 0.3, 0.3]), NUM(1)])).toEqual(ERR('#NUM!'))
    expect(call('PROB', [xs, ARR([0.1, 0, 0.5, 0.4]), NUM(1)])).toEqual(ERR('#NUM!'))
  })

  test('normal distribution functions and legacy aliases cover CDF, PDF, and inverse', () => {
    expectClose('NORM.DIST', [NUM(0), NUM(0), NUM(1), BOOL(false)], 0.3989422804014327)
    expectClose('NORM.S.DIST', [NUM(1), BOOL(true)], 0.8413447460685429)
    expectClose('NORM.INV', [NUM(0.975), NUM(5), NUM(2)], 8.919927969080108)
    expectClose('NORM.S.INV', [NUM(0.975)], 1.959963984540054)
    expectClose('NORMDIST', [NUM(5), NUM(5), NUM(2), BOOL(true)], 0.5)
    expectClose('NORMSDIST', [NUM(0)], 0.5)
    expectClose('NORMINV', [NUM(0.5), NUM(5), NUM(2)], 5)
    expectClose('NORMSINV', [NUM(0.5)], 0)
    expect(call('NORM.DIST', [NUM(0), NUM(0), NUM(0), BOOL(true)])).toEqual(ERR('#NUM!'))
    expect(call('NORM.S.INV', [NUM(1)])).toEqual(ERR('#NUM!'))
  })

  test('lognormal distribution functions and aliases round-trip through the normal inverse', () => {
    expectClose('LOGNORM.DIST', [NUM(Math.E), NUM(1), NUM(0.5), BOOL(true)], 0.5)
    expectClose('LOGNORM.DIST', [NUM(1), NUM(0), NUM(1), BOOL(false)], 0.3989422804014327)
    const p = call('LOGNORM.DIST', [NUM(3), NUM(1), NUM(0.5), BOOL(true)])
    expect(asNumber(call('LOGNORM.INV', [p, NUM(1), NUM(0.5)]))).toBeCloseTo(3, 8)
    expect(asNumber(call('LOGINV', [p, NUM(1), NUM(0.5)]))).toBeCloseTo(3, 8)
    expectClose('LOGNORMDIST', [NUM(Math.E), NUM(1), NUM(0.5)], 0.5)
    expect(call('LOGNORM.DIST', [NUM(0), NUM(0), NUM(1), BOOL(true)])).toEqual(ERR('#NUM!'))
    expect(call('LOGNORM.INV', [NUM(0), NUM(0), NUM(1)])).toEqual(ERR('#NUM!'))
  })

  test('exponential, Poisson, and Weibull distributions expose modern names and aliases', () => {
    expectClose('EXPON.DIST', [NUM(0), NUM(2), BOOL(false)], 2)
    expectClose('EXPONDIST', [NUM(1), NUM(1), BOOL(true)], 0.6321205588285577)
    expectClose('POISSON.DIST', [NUM(0), NUM(2), BOOL(false)], 0.1353352832366127)
    expectClose('POISSON.DIST', [NUM(1.5), NUM(2), BOOL(false)], 0.2706705664732254)
    expectClose('POISSON', [NUM(10), NUM(2), BOOL(true)], 0.9999916917756315)
    expectClose('WEIBULL.DIST', [NUM(2), NUM(3), NUM(2), BOOL(true)], 0.6321205588285577)
    expectClose('WEIBULL', [NUM(2), NUM(3), NUM(2), BOOL(true)], 0.6321205588285577)
    expect(call('EXPON.DIST', [NUM(1), NUM(0), BOOL(true)])).toEqual(ERR('#NUM!'))
    expect(call('WEIBULL.DIST', [NUM(1), NUM(0), NUM(1), BOOL(true)])).toEqual(ERR('#NUM!'))
  })

  test('PHI, GAUSS, Z.TEST, and confidence functions cover tests and intervals', () => {
    expectClose('PHI', [NUM(0)], 0.3989422804014327)
    expectClose('PHI', [NUM(1)], asNumber(call('PHI', [NUM(-1)])))
    expectClose('GAUSS', [NUM(0)], 0)
    expectClose('GAUSS', [NUM(1)], 0.3413447460685429)
    expectClose('Z.TEST', [ARR([3, 6, 7, 8, 6]), NUM(6)], 0.5)
    expectClose('ZTEST', [ARR([3, 6, 7, 8, 6]), NUM(5), NUM(2)], 0.13177623864148635)
    expectClose('CONFIDENCE.NORM', [NUM(0.05), NUM(2.5), NUM(50)], 0.6929519121748391)
    expectClose('CONFIDENCE', [NUM(0.05), NUM(2.5), NUM(50)], 0.6929519121748391)
    expect(asNumber(call('CONFIDENCE.T', [NUM(0.05), NUM(1), NUM(10)]))).toBeCloseTo(
      0.7153569059706626,
      10,
    )
    expect(call('Z.TEST', [ARR([1]), NUM(1)])).toEqual(ERR('#DIV/0!'))
    expect(call('Z.TEST', [ARR([3, 6, 7, 8, 6]), NUM(5), NUM(0)])).toEqual(ERR('#DIV/0!'))
    expect(call('CONFIDENCE.NORM', [NUM(0), NUM(1), NUM(10)])).toEqual(ERR('#NUM!'))
    expect(call('CONFIDENCE.T', [NUM(0.05), NUM(1), NUM(1)])).toEqual(ERR('#NUM!'))
  })

  test('exclusive percentiles, quartiles, rank aliases, MODE.MULT, and FREQUENCY', () => {
    const values = ARR([2, 4, 6, 8, 10])
    expectClose('PERCENTILE.EXC', [values, NUM(0.25)], 3)
    expectClose('PERCENTILE.EXC', [values, NUM(0.5)], 6)
    expectClose('QUARTILE.EXC', [values, NUM(1)], 3)
    expectClose('QUARTILE.EXC', [values, NUM(3)], 9)
    expect(call('PERCENTILE.EXC', [values, NUM(0.1)])).toEqual(ERR('#NUM!'))
    expect(call('QUARTILE.EXC', [values, NUM(4)])).toEqual(ERR('#NUM!'))

    expect(call('RANKEQ', [NUM(6), values])).toEqual(NUM(3))
    expect(call('RANKAVG', [NUM(10), ARR([10, 10, 5])])).toEqual(NUM(1.5))
    expect(asArray(call('MODE.MULT', [ARR([1, 2, 2, 3, 3, 4])]))).toEqual([
      [NUM(2)],
      [NUM(3)],
    ])
    expect(asArray(call('FREQUENCY', [ARR([1, 2, 3, 4, 5]), ARR([2, 4])]))).toEqual([
      [NUM(2)],
      [NUM(2)],
      [NUM(1)],
    ])
  })

  test('gamma and beta functions cover aliases, scaling, inverses, and invalid domains', () => {
    expectClose('GAMMA', [NUM(5)], 24)
    expectClose('GAMMA', [NUM(0.5)], Math.sqrt(Math.PI))
    expectClose('GAMMALN', [NUM(5)], Math.log(24))
    expectClose('GAMMALN.PRECISE', [NUM(5)], Math.log(24))
    expect(call('GAMMA', [NUM(0)])).toEqual(ERR('#NUM!'))
    expect(call('GAMMALN', [NUM(-1)])).toEqual(ERR('#NUM!'))

    expectClose('BETA.DIST', [NUM(0.25), NUM(1), NUM(1), BOOL(true)], 0.25)
    expectClose('BETA.DIST', [NUM(0.5), NUM(1), NUM(1), BOOL(false)], 1)
    expectClose('BETADIST', [NUM(3), NUM(1), NUM(1), NUM(2), NUM(4)], 0.5)
    expectClose('BETA.INV', [NUM(0.3), NUM(1), NUM(1)], 0.3)
    expectClose('BETAINV', [NUM(0.5), NUM(1), NUM(1), NUM(2), NUM(4)], 3)
    expect(call('BETA.DIST', [NUM(2), NUM(1), NUM(1), BOOL(true), NUM(0), NUM(1)])).toEqual(
      ERR('#NUM!'),
    )

    expectClose('GAMMA.DIST', [NUM(1), NUM(1), NUM(1), BOOL(true)], 0.6321205588285577)
    expectClose('GAMMADIST', [NUM(1), NUM(1), NUM(1), BOOL(true)], 0.6321205588285577)
    const p = call('GAMMA.DIST', [NUM(2), NUM(3), NUM(2), BOOL(true)])
    expect(asNumber(call('GAMMA.INV', [p, NUM(3), NUM(2)]))).toBeCloseTo(2, 6)
    expect(asNumber(call('GAMMAINV', [p, NUM(3), NUM(2)]))).toBeCloseTo(2, 6)
    expect(call('GAMMA.DIST', [NUM(1), NUM(0), NUM(1), BOOL(true)])).toEqual(ERR('#NUM!'))
  })

  test('binomial, hypergeometric, and negative-binomial functions cover aliases', () => {
    expectClose('BINOM.DIST', [NUM(2), NUM(10), NUM(0.5), BOOL(false)], 45 / 1024)
    expectClose('BINOMDIST', [NUM(10), NUM(10), NUM(0.5), BOOL(true)], 1)
    expectClose('BINOM.DIST.RANGE', [NUM(10), NUM(0.5), NUM(2)], 45 / 1024)
    expectClose('BINOM.DIST.RANGE', [NUM(10), NUM(0.3), NUM(0), NUM(10)], 1)
    expectClose('BINOM.INV', [NUM(10), NUM(0.5), NUM(0.5)], 5)
    expectClose('CRITBINOM', [NUM(10), NUM(0.5), NUM(0.999)], 9)
    expect(call('BINOM.DIST', [NUM(1.5), NUM(10), NUM(0.5), BOOL(false)])).toEqual(
      ERR('#NUM!'),
    )
    expect(call('BINOM.DIST.RANGE', [NUM(10), NUM(0.5), NUM(5), NUM(3)])).toEqual(
      ERR('#NUM!'),
    )

    expectClose('HYPGEOM.DIST', [NUM(2), NUM(5), NUM(6), NUM(20), BOOL(false)], (15 * 364) / 15504)
    expectClose('HYPGEOMDIST', [NUM(2), NUM(5), NUM(6), NUM(20)], (15 * 364) / 15504)
    expect(call('HYPGEOM.DIST', [NUM(2), NUM(5), NUM(25), NUM(20), BOOL(false)])).toEqual(
      ERR('#NUM!'),
    )
    expectClose('NEGBINOM.DIST', [NUM(0), NUM(1), NUM(0.5), BOOL(false)], 0.5)
    expectClose('NEGBINOMDIST', [NUM(0), NUM(1), NUM(0.5)], 0.5)
    expect(call('NEGBINOMDIST', [NUM(0), NUM(1), NUM(0)])).toEqual(ERR('#NUM!'))
  })

  test('chi-square, F, and T distributions expose modern and legacy forms', () => {
    const chiP = call('CHISQ.DIST', [NUM(3), NUM(5), BOOL(true)])
    expect(asNumber(chiP) + asNumber(call('CHISQ.DIST.RT', [NUM(3), NUM(5)]))).toBeCloseTo(1, 10)
    expect(asNumber(call('CHISQ.INV', [chiP, NUM(5)]))).toBeCloseTo(3, 6)
    expectClose('CHIDIST', [NUM(3), NUM(5)], asNumber(call('CHISQ.DIST.RT', [NUM(3), NUM(5)])))
    expectClose('CHIINV', [NUM(1), NUM(5)], 0)
    expect(call('CHISQ.INV', [NUM(0.5), NUM(0)])).toEqual(ERR('#NUM!'))

    const fLeft = call('F.DIST', [NUM(2), NUM(5), NUM(10), BOOL(true)])
    const fRight = call('F.DIST.RT', [NUM(2), NUM(5), NUM(10)])
    expect(asNumber(fLeft) + asNumber(fRight)).toBeCloseTo(1, 10)
    expect(asNumber(call('F.INV', [fLeft, NUM(5), NUM(10)]))).toBeCloseTo(2, 6)
    expect(asNumber(call('F.INV.RT', [fRight, NUM(5), NUM(10)]))).toBeCloseTo(2, 6)
    expectClose('FDIST', [NUM(2), NUM(5), NUM(10)], asNumber(fRight))
    expectClose('FINV', [NUM(0.5), NUM(5), NUM(10)], asNumber(call('F.INV.RT', [NUM(0.5), NUM(5), NUM(10)])))
    expect(call('F.DIST', [NUM(-1), NUM(5), NUM(10), BOOL(true)])).toEqual(ERR('#NUM!'))

    expectClose('T.DIST', [NUM(0), NUM(10), BOOL(true)], 0.5)
    expectClose('T.DIST', [NUM(0), NUM(10), BOOL(false)], 0.389108383966031)
    expectClose('T.DIST.RT', [NUM(0), NUM(10)], 0.5)
    expectClose('T.DIST.2T', [NUM(0), NUM(10)], 1)
    expectClose('T.INV', [NUM(0.5), NUM(10)], 0)
    expectClose('T.INV.2T', [NUM(1), NUM(10)], 0)
    expectClose('TDIST', [NUM(0), NUM(10), NUM(2)], 1)
    expectClose('TINV', [NUM(1), NUM(10)], 0)
    expect(call('TDIST', [NUM(-1), NUM(10), NUM(1)])).toEqual(ERR('#NUM!'))
  })

  test('CHISQ.TEST, F.TEST, and T.TEST produce p-values and legacy aliases', () => {
    const actual = ARR([10, 20, 30, 40])
    const expected = ARR([15, 15, 35, 35])
    const chi2 = 50 / 15 + 50 / 35
    expectClose('CHISQ.TEST', [actual, expected], asNumber(call('CHISQ.DIST.RT', [NUM(chi2), NUM(3)])))
    expectClose('CHITEST', [actual, expected], asNumber(call('CHISQ.TEST', [actual, expected])))
    expect(call('CHISQ.TEST', [ARR([1, 2]), ARR([1, 2, 3])])).toEqual(ERR('#N/A'))

    const xs = ARR([1, 2, 3, 4, 5])
    const ys = ARR([10, 20, 30, 40, 50])
    expect(asNumber(call('F.TEST', [xs, ys]))).toBeGreaterThan(0)
    expectClose('FTEST', [xs, ys], asNumber(call('F.TEST', [xs, ys])))
    expect(call('F.TEST', [ARR([5, 5]), ARR([1, 2])])).toEqual(ERR('#DIV/0!'))

    const p = call('T.TEST', [ARR([1, 2, 3, 4]), ARR([1, 2, 4, 8]), NUM(2), NUM(3)])
    expect(asNumber(p)).toBeGreaterThan(0)
    expect(asNumber(p)).toBeLessThanOrEqual(1)
    expectClose('TTEST', [ARR([1, 2, 3, 4]), ARR([1, 2, 4, 8]), NUM(2), NUM(3)], asNumber(p))
    expect(call('T.TEST', [ARR([1, 2]), ARR([1, 2]), NUM(3), NUM(1)])).toEqual(ERR('#NUM!'))
  })

  test('STEYX, LINEST, LOGEST, TREND, and GROWTH return regression arrays', () => {
    const xs = ARR2([[1], [2], [3], [4], [5]])
    const ys = ARR2([[2], [4], [6], [8], [10]])
    expectClose('STEYX', [ys, xs], 0)

    const linest = asArray(call('LINEST', [ys, xs]))
    expect(linest).toHaveLength(1)
    expect(asNumber(linest[0][0])).toBeCloseTo(2, 10)
    expect(asNumber(linest[0][1])).toBeCloseTo(0, 10)
    const linestStats = asArray(call('LINEST', [ys, xs, BOOL(true), BOOL(true)]))
    expect(linestStats).toHaveLength(5)
    expect(linestStats[0]).toHaveLength(2)

    const trend = asArray(call('TREND', [ys, xs, ARR2([[6], [7]])]))
    expect(trend).toEqual([[NUM(12)], [NUM(14)]])

    const growthYs = ARR2([[2], [4], [8], [16]])
    const growthXs = ARR2([[1], [2], [3], [4]])
    const logest = asArray(call('LOGEST', [growthYs, growthXs]))
    expect(asNumber(logest[0][0])).toBeCloseTo(2, 10)
    expect(asNumber(logest[0][1])).toBeCloseTo(1, 10)
    const growth = asArray(call('GROWTH', [growthYs, growthXs, ARR2([[5]])]))
    expect(asNumber(growth[0][0])).toBeCloseTo(32, 8)
    expect(call('GROWTH', [ARR2([[0], [1]]), ARR2([[1], [2]])])).toEqual(ERR('#NUM!'))
  })
})
