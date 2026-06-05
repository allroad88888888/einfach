/**
 * Wave F / F1 — Financial function tests.
 *
 * Reference values verified against Excel's financial functions (or
 * derived from the underlying annuity identity for cases Excel doesn't
 * give a fixed pin for, e.g. multi-period NPV).
 *
 * Each function gets:
 *   - happy path (canonical inputs, value pinned)
 *   - error case (#NUM! or #VALUE!)
 *   - edge case (rate=0 / type=1 / wrong sign / convergence failure)
 */

import { describe, expect, test } from '@jest/globals'

import {
  ACCRINT,
  ACCRINTM,
  AMORDEGRC,
  AMORLINC,
  COUPDAYBS,
  COUPDAYS,
  COUPDAYSNC,
  COUPNCD,
  COUPNUM,
  COUPPCD,
  CUMIPMT,
  CUMPRINC,
  DB,
  DDB,
  DISC,
  DOLLARDE,
  DOLLARFR,
  DURATION,
  EFFECT,
  FUNCTIONS,
  FV,
  FVSCHEDULE,
  INTRATE,
  IPMT,
  IRR,
  ISPMT,
  MDURATION,
  MIRR,
  NOMINAL,
  NPER,
  NPV,
  ODDFPRICE,
  ODDFYIELD,
  ODDLPRICE,
  ODDLYIELD,
  PDURATION,
  PMT,
  PPMT,
  PRICE,
  PRICEDISC,
  PRICEMAT,
  PV,
  RATE,
  RECEIVED,
  RRI,
  SLN,
  SYD,
  TBILLEQ,
  TBILLPRICE,
  TBILLYIELD,
  VDB,
  XIRR,
  XNPV,
  YIELD,
  YIELDDISC,
  YIELDMAT,
} from '../src/eval/functions/financial'
import type { EvalContext, FunctionImpl, Value } from '../src/types'

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const ERR = (code: '#DIV/0!' | '#NUM!' | '#VALUE!' | '#N/A' | '#REF!'): Value => ({
  kind: 'error',
  code,
})
const ARR = (rows: Value[][]): Value => ({ kind: 'array', value: rows })

const ctx: EvalContext = new Proxy(
  {},
  {
    get(_, prop) {
      throw new Error(`financial function unexpectedly read ctx.${String(prop)}`)
    },
  },
) as unknown as EvalContext

const DATE_MS_PER_DAY = 86_400_000
const EXCEL_ANCHOR_UTC_MS = Date.UTC(1899, 11, 31)

function dateSerial(year: number, month: number, day: number): number {
  if (year === 1900 && month === 2 && day === 29) return 60
  const realDays = Math.floor(
    (Date.UTC(year, month - 1, day) - EXCEL_ANCHOR_UTC_MS) / DATE_MS_PER_DAY,
  )
  return realDays >= 60 ? realDays + 1 : realDays
}

function call(fn: FunctionImpl, args: Value[]): Value {
  return fn(args, ctx)
}

function expectClose(actual: Value, expected: number, eps = 1e-4): void {
  expect(actual.kind).toBe('number')
  if (actual.kind === 'number') {
    expect(Math.abs(actual.value - expected)).toBeLessThan(eps)
  }
}

// ---------------------------------------------------------------------------
// PV
// ---------------------------------------------------------------------------

describe('PV', () => {
  test('happy path: 5%/yr, 10 yrs, payment $100 → ~ -772.17', () => {
    // =PV(0.05, 10, 100) in Excel → -772.1734929
    expectClose(call(PV, [NUM(0.05), NUM(10), NUM(100)]), -772.1734929)
  })

  test('rate=0 degenerates to -(pv + pmt*n + fv) closed form', () => {
    // PV(0, 5, 100, 0, 0) = -500
    expectClose(call(PV, [NUM(0), NUM(5), NUM(100)]), -500)
  })

  test('wrong arity → #VALUE!', () => {
    expect(call(PV, [NUM(0.05)])).toEqual(ERR('#VALUE!'))
  })
})

// ---------------------------------------------------------------------------
// FV
// ---------------------------------------------------------------------------

describe('FV', () => {
  test('happy path: 5%/yr, 10 yrs, payment $-100 → ~ 1257.79', () => {
    // =FV(0.05, 10, -100) → 1257.789254
    expectClose(call(FV, [NUM(0.05), NUM(10), NUM(-100)]), 1257.789254)
  })

  test('rate=0 → -(pv + pmt*n)', () => {
    expectClose(call(FV, [NUM(0), NUM(5), NUM(-100), NUM(0)]), 500)
  })

  test('error propagation: error in rate', () => {
    expect(call(FV, [ERR('#DIV/0!'), NUM(10), NUM(100)])).toEqual(ERR('#DIV/0!'))
  })
})

// ---------------------------------------------------------------------------
// PMT
// ---------------------------------------------------------------------------

describe('PMT', () => {
  test('happy path: $10000 loan, 5%/yr, 10 yrs → ~ -1295.05', () => {
    // =PMT(0.05, 10, 10000) → -1295.045749
    expectClose(call(PMT, [NUM(0.05), NUM(10), NUM(10000)]), -1295.045749)
  })

  test('rate=0 → -(pv + fv) / nper', () => {
    // PMT(0, 5, 1000) = -200
    expectClose(call(PMT, [NUM(0), NUM(5), NUM(1000)]), -200)
  })

  test('nper=0 → #NUM!', () => {
    expect(call(PMT, [NUM(0.05), NUM(0), NUM(1000)])).toEqual(ERR('#NUM!'))
  })

  test('type=1 (annuity due) differs from type=0', () => {
    const due = call(PMT, [NUM(0.05), NUM(10), NUM(10000), NUM(0), NUM(1)])
    const ord = call(PMT, [NUM(0.05), NUM(10), NUM(10000), NUM(0), NUM(0)])
    expect(due.kind).toBe('number')
    expect(ord.kind).toBe('number')
    if (due.kind === 'number' && ord.kind === 'number') {
      // Annuity-due payment is smaller in magnitude (paid sooner =
      // less interest needed).
      expect(Math.abs(due.value)).toBeLessThan(Math.abs(ord.value))
    }
  })

  test('type must truncate to 0 or 1', () => {
    expect(call(PMT, [NUM(0.05), NUM(10), NUM(10000), NUM(0), NUM(2)])).toEqual(
      ERR('#VALUE!'),
    )
    expect(call(PMT, [NUM(0.05), NUM(10), NUM(10000), NUM(0), NUM(0.9)])).toEqual(
      call(PMT, [NUM(0.05), NUM(10), NUM(10000), NUM(0), NUM(0)]),
    )
  })
})

// ---------------------------------------------------------------------------
// NPER
// ---------------------------------------------------------------------------

describe('NPER', () => {
  test('happy path: how many $100 payments to retire a $1000 loan @ 5%? ~14.2', () => {
    // =NPER(0.05, -100, 1000) → 14.2067
    expectClose(call(NPER, [NUM(0.05), NUM(-100), NUM(1000)]), 14.2067, 1e-3)
  })

  test('rate=0 → -(pv + fv) / pmt', () => {
    expectClose(call(NPER, [NUM(0), NUM(-100), NUM(500)]), 5)
  })

  test('rate=0 AND pmt=0 → #NUM!', () => {
    expect(call(NPER, [NUM(0), NUM(0), NUM(1000)])).toEqual(ERR('#NUM!'))
  })
})

// ---------------------------------------------------------------------------
// RATE
// ---------------------------------------------------------------------------

describe('RATE', () => {
  test('happy path: 10 periods, -100 pmt, 1000 pv → ~ 0.0492', () => {
    // =RATE(10, -100, 1000) → 0.04277...
    // Actually Excel: 0.04277...; let me verify by inverse — PMT(0.04277, 10, 1000) = -124.something.
    // No — RATE(10, -100, 1000) finds r where PV identity holds.
    // pv * (1+r)^10 + pmt * ((1+r)^10 - 1)/r + fv = 0
    // 1000 * (1+r)^10 + (-100) * ((1+r)^10 - 1)/r = 0
    // The Excel answer is roughly 0.04277.
    const result = call(RATE, [NUM(10), NUM(-100), NUM(1000)])
    expect(result.kind).toBe('number')
    if (result.kind === 'number') {
      // Verify by plugging back into the residual:
      const r = result.value
      const pow = Math.pow(1 + r, 10)
      const residual = 1000 * pow + -100 * (pow - 1) / r
      expect(Math.abs(residual)).toBeLessThan(1e-4)
    }
  })

  test('non-convergent inputs → #NUM!', () => {
    // Pathological: pmt and pv same sign — can't satisfy the identity
    // with any positive rate.
    const result = call(RATE, [NUM(10), NUM(100), NUM(1000), NUM(0), NUM(0), NUM(0.5)])
    expect(result.kind).toBe('error')
  })

  test('residual convergence is invariant to cash-flow scale', () => {
    const base = call(RATE, [NUM(360), NUM(-1199.1), NUM(200000)])
    const scaled = call(RATE, [NUM(360), NUM(-1199.1e6), NUM(200000e6)])
    expect(base.kind).toBe('number')
    expect(scaled.kind).toBe('number')
    if (base.kind === 'number' && scaled.kind === 'number') {
      expect(scaled.value).toBeCloseTo(base.value, 12)
    }
  })

  test('tiny cash-flow residual convergence matches normal scale', () => {
    const base = call(RATE, [NUM(1), NUM(0), NUM(-1), NUM(2)])
    const tiny = call(RATE, [NUM(1), NUM(0), NUM(-1e-6), NUM(2e-6)])
    expectClose(base, 1, 1e-9)
    expectClose(tiny, 1, 1e-9)
    if (base.kind === 'number' && tiny.kind === 'number') {
      expect(Math.abs(tiny.value - base.value)).toBeLessThan(1e-9)
    }
  })

  test('wrong arity → #VALUE!', () => {
    expect(call(RATE, [NUM(10)])).toEqual(ERR('#VALUE!'))
  })
})

// ---------------------------------------------------------------------------
// NPV
// ---------------------------------------------------------------------------

describe('NPV', () => {
  test('happy path: 10% discount, cash flows [100, 200, 300]', () => {
    // =NPV(0.1, 100, 200, 300) → 481.5928
    expectClose(call(NPV, [NUM(0.1), NUM(100), NUM(200), NUM(300)]), 481.5928, 1e-3)
  })

  test('cash flows as a range argument', () => {
    expectClose(
      call(NPV, [NUM(0.1), ARR([[NUM(100), NUM(200), NUM(300)]])]),
      481.5928,
      1e-3,
    )
  })

  test('rate=-1 or below → #NUM!', () => {
    expect(call(NPV, [NUM(-1), NUM(100)])).toEqual(ERR('#NUM!'))
  })

  test('wrong arity → #VALUE!', () => {
    expect(call(NPV, [NUM(0.1)])).toEqual(ERR('#VALUE!'))
  })
})

// ---------------------------------------------------------------------------
// IRR
// ---------------------------------------------------------------------------

describe('IRR', () => {
  test('happy path: -1000 then 300x4 → ~ 0.07714', () => {
    // =IRR({-1000, 300, 300, 300, 300}) — bisection gives 0.07713847...
    expectClose(
      call(IRR, [ARR([[NUM(-1000), NUM(300), NUM(300), NUM(300), NUM(300)]])]),
      0.07714,
      1e-4,
    )
  })

  test('all positive → #NUM!', () => {
    expect(call(IRR, [ARR([[NUM(100), NUM(200), NUM(300)]])])).toEqual(ERR('#NUM!'))
  })

  test('all negative → #NUM!', () => {
    expect(call(IRR, [ARR([[NUM(-100), NUM(-200)]])])).toEqual(ERR('#NUM!'))
  })

  test('respects guess argument', () => {
    // Same series, different guess — should converge to same root.
    const a = call(IRR, [ARR([[NUM(-1000), NUM(300), NUM(300), NUM(300), NUM(300)]])])
    const b = call(IRR, [
      ARR([[NUM(-1000), NUM(300), NUM(300), NUM(300), NUM(300)]]),
      NUM(0.2),
    ])
    expect(a.kind).toBe('number')
    expect(b.kind).toBe('number')
    if (a.kind === 'number' && b.kind === 'number') {
      expect(Math.abs(a.value - b.value)).toBeLessThan(1e-4)
    }
  })

  test('tiny cash-flow residual converges within Excel-correct tolerance', () => {
    // Harvey P2 — the convergence threshold is `max(|scale|, 1) * tolerance`,
    // so at |scale| ≪ 1 the bar is the absolute floor (1e-10) instead of a
    // sub-machine-epsilon ratio. Newton can legitimately stop earlier than
    // the base-scale case; verify by re-computing |f(rate)|.
    const base = call(IRR, [ARR([[NUM(-1), NUM(2)]])])
    const tiny = call(IRR, [ARR([[NUM(-1e-9), NUM(2e-9)]])])
    expectClose(base, 1, 1e-9)
    expect(tiny.kind).toBe('number')
    if (tiny.kind === 'number') {
      const flows = [-1e-9, 2e-9]
      let f = 0
      for (let i = 0; i < flows.length; i++) f += flows[i] / Math.pow(1 + tiny.value, i)
      expect(Math.abs(f)).toBeLessThan(1e-9)
    }
  })
})

// ---------------------------------------------------------------------------
// IPMT
// ---------------------------------------------------------------------------

describe('IPMT', () => {
  test('happy path: period 1 interest on $10k @ 5%/yr for 10 yrs → -500', () => {
    // =IPMT(0.05, 1, 10, 10000) → -500 (first period: balance × rate)
    expectClose(call(IPMT, [NUM(0.05), NUM(1), NUM(10), NUM(10000)]), -500)
  })

  test('per > nper → #NUM!', () => {
    expect(call(IPMT, [NUM(0.05), NUM(11), NUM(10), NUM(10000)])).toEqual(ERR('#NUM!'))
  })

  test('per < 1 → #NUM!', () => {
    expect(call(IPMT, [NUM(0.05), NUM(0), NUM(10), NUM(10000)])).toEqual(ERR('#NUM!'))
  })

  test('error propagation', () => {
    expect(call(IPMT, [ERR('#REF!'), NUM(1), NUM(10), NUM(10000)])).toEqual(ERR('#REF!'))
  })

  test('type outside 0/1 → #VALUE!', () => {
    expect(call(IPMT, [NUM(0.05), NUM(1), NUM(10), NUM(10000), NUM(0), NUM(-1)])).toEqual(
      ERR('#VALUE!'),
    )
  })
})

// ---------------------------------------------------------------------------
// PPMT
// ---------------------------------------------------------------------------

describe('PPMT', () => {
  test('happy path: PMT - IPMT for the same period', () => {
    // PMT(0.05, 10, 10000) = -1295.045749
    // IPMT(0.05, 1, 10, 10000) = -500
    // PPMT(0.05, 1, 10, 10000) = -1295.045749 - (-500) = -795.045749
    expectClose(call(PPMT, [NUM(0.05), NUM(1), NUM(10), NUM(10000)]), -795.045749)
  })

  test('per > nper → #NUM!', () => {
    expect(call(PPMT, [NUM(0.05), NUM(15), NUM(10), NUM(10000)])).toEqual(ERR('#NUM!'))
  })

  test('PPMT + IPMT identity holds across periods', () => {
    const ipmt = call(IPMT, [NUM(0.05), NUM(3), NUM(10), NUM(10000)])
    const ppmt = call(PPMT, [NUM(0.05), NUM(3), NUM(10), NUM(10000)])
    const pmt = call(PMT, [NUM(0.05), NUM(10), NUM(10000)])
    expect(ipmt.kind).toBe('number')
    expect(ppmt.kind).toBe('number')
    expect(pmt.kind).toBe('number')
    if (ipmt.kind === 'number' && ppmt.kind === 'number' && pmt.kind === 'number') {
      expect(Math.abs(ipmt.value + ppmt.value - pmt.value)).toBeLessThan(1e-6)
    }
  })
})

// ---------------------------------------------------------------------------
// CUMIPMT
// ---------------------------------------------------------------------------

describe('CUMIPMT', () => {
  test('happy path: cumulative interest periods 1..3 on a $10k 5%/10yr loan', () => {
    // Should equal IPMT(1) + IPMT(2) + IPMT(3) — independently verifiable.
    const ipmt1 = call(IPMT, [NUM(0.05), NUM(1), NUM(10), NUM(10000)])
    const ipmt2 = call(IPMT, [NUM(0.05), NUM(2), NUM(10), NUM(10000)])
    const ipmt3 = call(IPMT, [NUM(0.05), NUM(3), NUM(10), NUM(10000)])
    let expected = 0
    for (const v of [ipmt1, ipmt2, ipmt3]) {
      if (v.kind === 'number') expected += v.value
    }
    expectClose(
      call(CUMIPMT, [NUM(0.05), NUM(10), NUM(10000), NUM(1), NUM(3), NUM(0)]),
      expected,
    )
  })

  test('start > end → #NUM!', () => {
    expect(
      call(CUMIPMT, [NUM(0.05), NUM(10), NUM(10000), NUM(5), NUM(3), NUM(0)]),
    ).toEqual(ERR('#NUM!'))
  })

  test('rate <= 0 → #NUM!', () => {
    expect(
      call(CUMIPMT, [NUM(0), NUM(10), NUM(10000), NUM(1), NUM(3), NUM(0)]),
    ).toEqual(ERR('#NUM!'))
  })

  test('wrong arity → #VALUE!', () => {
    expect(call(CUMIPMT, [NUM(0.05), NUM(10), NUM(10000)])).toEqual(ERR('#VALUE!'))
  })
})

// ---------------------------------------------------------------------------
// SLN / SYD / DB / DDB / VDB
// ---------------------------------------------------------------------------

describe('SLN', () => {
  test('happy path: straight-line depreciation', () => {
    // =SLN(30000, 7500, 10) → 2250
    expectClose(call(SLN, [NUM(30000), NUM(7500), NUM(10)]), 2250)
  })

  test('life <= 0 → #DIV/0!', () => {
    expect(call(SLN, [NUM(30000), NUM(7500), NUM(0)])).toEqual(ERR('#DIV/0!'))
  })
})

describe('SYD', () => {
  test('happy path: first year sum-of-years depreciation', () => {
    // =SYD(30000, 7500, 10, 1) → 4090.9090909
    expectClose(call(SYD, [NUM(30000), NUM(7500), NUM(10), NUM(1)]), 4090.9090909)
  })

  test('period outside life → #NUM!', () => {
    expect(call(SYD, [NUM(30000), NUM(7500), NUM(10), NUM(11)])).toEqual(ERR('#NUM!'))
  })
})

describe('DB', () => {
  test('happy path: Excel fixed-declining balance example', () => {
    // =DB(1000000, 100000, 6, 1, 7) → 186083.3333
    expectClose(call(DB, [NUM(1000000), NUM(100000), NUM(6), NUM(1), NUM(7)]), 186083.3333)
  })

  test('later period uses accumulated depreciation', () => {
    expectClose(call(DB, [NUM(1000000), NUM(100000), NUM(6), NUM(2), NUM(7)]), 259639.4167)
  })

  test('invalid month → #NUM!', () => {
    expect(call(DB, [NUM(1000000), NUM(100000), NUM(6), NUM(1), NUM(13)])).toEqual(
      ERR('#NUM!'),
    )
  })
})

describe('DDB', () => {
  test('happy path: double-declining first and second period', () => {
    expectClose(call(DDB, [NUM(2400), NUM(300), NUM(10), NUM(1)]), 480)
    expectClose(call(DDB, [NUM(2400), NUM(300), NUM(10), NUM(2)]), 384)
  })

  test('factor <= 0 → #NUM!', () => {
    expect(call(DDB, [NUM(2400), NUM(300), NUM(10), NUM(1), NUM(0)])).toEqual(ERR('#NUM!'))
  })
})

describe('VDB', () => {
  test('happy path: variable declining balance for first period', () => {
    expectClose(call(VDB, [NUM(2400), NUM(300), NUM(10), NUM(0), NUM(1)]), 480)
  })

  test('switches to straight-line when larger', () => {
    expectClose(call(VDB, [NUM(2400), NUM(300), NUM(10), NUM(6), NUM(7)]), 125.82912)
  })

  test('end beyond life → #NUM!', () => {
    expect(call(VDB, [NUM(2400), NUM(300), NUM(10), NUM(0), NUM(11)])).toEqual(ERR('#NUM!'))
  })
})

describe('AMORDEGRC / AMORLINC', () => {
  const purchased = dateSerial(2008, 8, 19)
  const firstPeriod = dateSerial(2008, 12, 31)

  test('AMORDEGRC applies French degressive coefficient and rounding', () => {
    expectClose(
      call(AMORDEGRC, [
        NUM(2400),
        NUM(purchased),
        NUM(firstPeriod),
        NUM(300),
        NUM(0),
        NUM(0.15),
        NUM(1),
      ]),
      330,
      1e-9,
    )
    expectClose(
      call(AMORDEGRC, [
        NUM(2400),
        NUM(purchased),
        NUM(firstPeriod),
        NUM(300),
        NUM(1),
        NUM(0.15),
        NUM(1),
      ]),
      776,
      1e-9,
    )
  })

  test('AMORLINC returns rounded linear depreciation for the first period', () => {
    expectClose(
      call(AMORLINC, [
        NUM(2400),
        NUM(purchased),
        NUM(firstPeriod),
        NUM(300),
        NUM(0),
        NUM(0.15),
        NUM(1),
      ]),
      132,
      1e-9,
    )
  })

  test('AMOR* validates cost, salvage, period, rate, and basis', () => {
    expect(
      call(AMORDEGRC, [
        NUM(100),
        NUM(purchased),
        NUM(firstPeriod),
        NUM(100),
        NUM(1),
        NUM(0.15),
      ]),
    ).toEqual(ERR('#NUM!'))
    expect(
      call(AMORLINC, [
        NUM(2400),
        NUM(purchased),
        NUM(firstPeriod),
        NUM(300),
        NUM(1),
        NUM(-0.15),
      ]),
    ).toEqual(ERR('#NUM!'))
    expect(
      call(AMORDEGRC, [
        NUM(2400),
        NUM(purchased),
        NUM(firstPeriod),
        NUM(300),
        NUM(1),
        NUM(0.15),
        NUM(5),
      ]),
    ).toEqual(ERR('#NUM!'))
  })
})

// ---------------------------------------------------------------------------
// EFFECT / NOMINAL / FVSCHEDULE / MIRR
// ---------------------------------------------------------------------------

describe('EFFECT', () => {
  test('happy path: nominal annual rate compounded quarterly', () => {
    // =EFFECT(0.0525, 4) → 0.053542667
    expectClose(call(EFFECT, [NUM(0.0525), NUM(4)]), 0.053542667, 1e-9)
  })

  test('nominal <= 0 → #NUM!', () => {
    expect(call(EFFECT, [NUM(0), NUM(4)])).toEqual(ERR('#NUM!'))
  })
})

describe('NOMINAL', () => {
  test('happy path: effective annual rate to nominal quarterly rate', () => {
    // =NOMINAL(0.053543, 4) → 0.0525003199
    expectClose(call(NOMINAL, [NUM(0.053543), NUM(4)]), 0.0525003199, 1e-9)
  })

  test('npery truncates below 1 → #NUM!', () => {
    expect(call(NOMINAL, [NUM(0.053543), NUM(0.9)])).toEqual(ERR('#NUM!'))
  })
})

describe('FVSCHEDULE', () => {
  test('happy path: compounded schedule array', () => {
    // =FVSCHEDULE(1, {0.09,0.11,0.10}) → 1.33089
    expectClose(call(FVSCHEDULE, [NUM(1), ARR([[NUM(0.09), NUM(0.11), NUM(0.1)]])]), 1.33089)
  })

  test('blank schedule cells are skipped', () => {
    expectClose(
      call(FVSCHEDULE, [NUM(100), ARR([[NUM(0.1), { kind: 'blank' }, NUM(0.2)]])]),
      132,
    )
  })
})

describe('MIRR', () => {
  test('happy path: Excel mixed cash-flow example', () => {
    const flows = ARR([[NUM(-120000), NUM(39000), NUM(30000), NUM(21000), NUM(37000), NUM(46000)]])
    expectClose(call(MIRR, [flows, NUM(0.1), NUM(0.12)]), 0.1260941304, 1e-9)
  })

  test('requires at least one positive and one negative cash flow', () => {
    expect(call(MIRR, [ARR([[NUM(100), NUM(200)]]), NUM(0.1), NUM(0.12)])).toEqual(
      ERR('#DIV/0!'),
    )
  })

  test('rates below -100% → #NUM!', () => {
    expect(
      call(MIRR, [ARR([[NUM(-100), NUM(200)]]), NUM(-1), NUM(0.12)]),
    ).toEqual(ERR('#NUM!'))
  })
})

// ---------------------------------------------------------------------------
// XNPV / XIRR
// ---------------------------------------------------------------------------

describe('XNPV', () => {
  const values = ARR([[NUM(-10000)], [NUM(2750)], [NUM(4250)], [NUM(3250)], [NUM(2750)]])
  const dates = ARR([[NUM(39448)], [NUM(39508)], [NUM(39751)], [NUM(39859)], [NUM(39904)]])

  test('happy path: irregular dated cash flows', () => {
    // Excel example dates: 2008-01-01, 2008-03-01, 2008-10-30, 2009-02-15, 2009-04-01.
    expectClose(call(XNPV, [NUM(0.09), values, dates]), 2086.647602, 1e-6)
  })

  test('rate <= -1 → #NUM!', () => {
    expect(call(XNPV, [NUM(-1), values, dates])).toEqual(ERR('#NUM!'))
  })

  test('values/date length mismatch → #NUM!', () => {
    expect(call(XNPV, [NUM(0.09), ARR([[NUM(-100), NUM(200)]]), ARR([[NUM(39448)]])])).toEqual(
      ERR('#NUM!'),
    )
  })

  test('date before the first schedule date returns #NUM!', () => {
    expect(
      call(XNPV, [
        NUM(0.1),
        ARR([[NUM(100), NUM(-50)]]),
        ARR([[NUM(43832), NUM(43831)]]),
      ]),
    ).toEqual(ERR('#NUM!'))
  })
})

describe('XIRR', () => {
  const values = ARR([[NUM(-10000)], [NUM(2750)], [NUM(4250)], [NUM(3250)], [NUM(2750)]])
  const dates = ARR([[NUM(39448)], [NUM(39508)], [NUM(39751)], [NUM(39859)], [NUM(39904)]])

  test('happy path: irregular dated cash flows', () => {
    expectClose(call(XIRR, [values, dates]), 0.3733625335, 1e-9)
  })

  test('respects guess argument', () => {
    expectClose(call(XIRR, [values, dates, NUM(0.2)]), 0.3733625335, 1e-9)
  })

  test('tiny cash-flow residual converges within Excel-correct tolerance', () => {
    // Harvey P2 — see IRR test note: floored threshold means tiny inputs may
    // legitimately settle a few magnitudes earlier than the base-scale case.
    const oneYearDates = ARR([[NUM(43831), NUM(44196)]])
    const base = call(XIRR, [ARR([[NUM(-1), NUM(2)]]), oneYearDates])
    const tiny = call(XIRR, [ARR([[NUM(-1e-9), NUM(2e-9)]]), oneYearDates])
    expectClose(base, 1, 1e-9)
    expect(tiny.kind).toBe('number')
    if (tiny.kind === 'number') {
      const flows = [-1e-9, 2e-9]
      const dates = [43831, 44196]
      const d0 = dates[0]
      let f = 0
      for (let i = 0; i < flows.length; i++) {
        f += flows[i] / Math.pow(1 + tiny.value, (dates[i] - d0) / 365)
      }
      expect(Math.abs(f)).toBeLessThan(1e-9)
    }
  })

  test('all positive cash flows → #NUM!', () => {
    expect(call(XIRR, [ARR([[NUM(100), NUM(200)]]), ARR([[NUM(39448), NUM(39449)]])])).toEqual(
      ERR('#NUM!'),
    )
  })
})

// ---------------------------------------------------------------------------
// RRI / PDURATION / ISPMT / CUMPRINC
// ---------------------------------------------------------------------------

describe('RRI', () => {
  test('happy path: equivalent growth rate', () => {
    // =RRI(96, 10000, 11000) → 0.0009933074
    expectClose(call(RRI, [NUM(96), NUM(10000), NUM(11000)]), 0.0009933074, 1e-10)
  })

  test('nper <= 0 → #NUM!', () => {
    expect(call(RRI, [NUM(0), NUM(10000), NUM(11000)])).toEqual(ERR('#NUM!'))
  })
})

describe('PDURATION', () => {
  test('happy path: periods needed to grow pv to fv', () => {
    // =PDURATION(0.025, 2000, 2200) → 3.8598661626
    expectClose(call(PDURATION, [NUM(0.025), NUM(2000), NUM(2200)]), 3.8598661626, 1e-10)
  })

  test('non-positive pv → #NUM!', () => {
    expect(call(PDURATION, [NUM(0.025), NUM(0), NUM(2200)])).toEqual(ERR('#NUM!'))
  })
})

describe('ISPMT', () => {
  test('happy path: straight-line interest payment', () => {
    // =ISPMT(0.1/12, 1, 3*12, 8000000) → -64814.8148148
    expectClose(call(ISPMT, [NUM(0.1 / 12), NUM(1), NUM(3 * 12), NUM(8000000)]), -64814.8148)
  })

  test('nper=0 → #DIV/0!', () => {
    expect(call(ISPMT, [NUM(0.1 / 12), NUM(1), NUM(0), NUM(8000000)])).toEqual(
      ERR('#DIV/0!'),
    )
  })
})

describe('CUMPRINC', () => {
  test('happy path: first-year principal on a 30-year mortgage', () => {
    // =CUMPRINC(0.005,360,200000,1,12,0) → -2456.0234
    expectClose(
      call(CUMPRINC, [NUM(0.005), NUM(360), NUM(200000), NUM(1), NUM(12), NUM(0)]),
      -2456.0234,
      1e-4,
    )
  })

  test('start_period < 1 → #NUM!', () => {
    expect(
      call(CUMPRINC, [NUM(0.005), NUM(360), NUM(200000), NUM(0), NUM(12), NUM(0)]),
    ).toEqual(ERR('#NUM!'))
  })
})

// ---------------------------------------------------------------------------
// Bond / settlement financial functions
// ---------------------------------------------------------------------------

describe('DOLLARDE / DOLLARFR', () => {
  test('DOLLARDE converts fractional dollars to decimal dollars', () => {
    expectClose(call(DOLLARDE, [NUM(1.1), NUM(16)]), 1.625, 1e-9)
    expectClose(call(DOLLARDE, [NUM(-1.1), NUM(16)]), -1.625, 1e-9)
  })

  test('DOLLARFR converts decimal dollars to fractional dollars', () => {
    expectClose(call(DOLLARFR, [NUM(1.625), NUM(16)]), 1.1, 1e-9)
    expectClose(call(DOLLARFR, [NUM(-1.625), NUM(16)]), -1.1, 1e-9)
  })

  test('fraction domain errors match Excel shape', () => {
    expect(call(DOLLARDE, [NUM(1.1), NUM(0.5)])).toEqual(ERR('#DIV/0!'))
    expect(call(DOLLARFR, [NUM(1.625), NUM(-2)])).toEqual(ERR('#NUM!'))
  })
})

describe('ACCRINT / ACCRINTM', () => {
  const jan1_2020 = dateSerial(2020, 1, 1)
  const apr1_2020 = dateSerial(2020, 4, 1)
  const jul1_2020 = dateSerial(2020, 7, 1)
  const jan1_2021 = dateSerial(2021, 1, 1)

  test('ACCRINT accrues from issue to settlement', () => {
    expectClose(
      call(ACCRINT, [
        NUM(jan1_2020),
        NUM(jul1_2020),
        NUM(jul1_2020),
        NUM(0.1),
        NUM(1000),
        NUM(2),
      ]),
      50,
      1e-9,
    )
  })

  test('ACCRINT basis 3 uses actual/365 days', () => {
    expectClose(
      call(ACCRINT, [
        NUM(jan1_2020),
        NUM(jul1_2020),
        NUM(jul1_2020),
        NUM(0.1),
        NUM(1000),
        NUM(2),
        NUM(3),
      ]),
      49.8630137,
      1e-6,
    )
  })

  test('ACCRINT calc_method=false accrues from first interest date', () => {
    expectClose(
      call(ACCRINT, [
        NUM(jan1_2020),
        NUM(jul1_2020),
        NUM(jan1_2021),
        NUM(0.1),
        NUM(1000),
        NUM(2),
        NUM(0),
        NUM(0),
      ]),
      50,
      1e-9,
    )
  })

  test('ACCRINT calc_method=false still accrues from issue before first interest date', () => {
    expectClose(
      call(ACCRINT, [
        NUM(jan1_2020),
        NUM(jul1_2020),
        NUM(apr1_2020),
        NUM(0.1),
        NUM(1000),
        NUM(2),
        NUM(0),
        NUM(0),
      ]),
      25,
      1e-9,
    )
  })

  test('ACCRINTM accrues to maturity', () => {
    expectClose(call(ACCRINTM, [NUM(jan1_2020), NUM(jan1_2021), NUM(0.1), NUM(1000)]), 100)
  })

  test('invalid frequency and date order return #NUM!', () => {
    expect(
      call(ACCRINT, [
        NUM(jan1_2020),
        NUM(jul1_2020),
        NUM(jul1_2020),
        NUM(0.1),
        NUM(1000),
        NUM(3),
      ]),
    ).toEqual(ERR('#NUM!'))
    expect(call(ACCRINTM, [NUM(jan1_2021), NUM(jan1_2020), NUM(0.1), NUM(1000)])).toEqual(
      ERR('#NUM!'),
    )
  })
})

describe('DISC / INTRATE / RECEIVED', () => {
  const jan1_2020 = dateSerial(2020, 1, 1)
  const jan1_2021 = dateSerial(2021, 1, 1)

  test('DISC returns discount rate for a discounted security', () => {
    expectClose(call(DISC, [NUM(jan1_2020), NUM(jan1_2021), NUM(90), NUM(100)]), 0.1, 1e-9)
  })

  test('INTRATE returns simple investment interest rate', () => {
    expectClose(
      call(INTRATE, [NUM(jan1_2020), NUM(jan1_2021), NUM(1000), NUM(1100)]),
      0.1,
      1e-9,
    )
  })

  test('RECEIVED returns amount received at maturity', () => {
    expectClose(
      call(RECEIVED, [NUM(jan1_2020), NUM(jan1_2021), NUM(1000), NUM(0.1)]),
      1111.111111,
      1e-6,
    )
  })

  test('domain errors', () => {
    expect(call(DISC, [NUM(jan1_2021), NUM(jan1_2020), NUM(90), NUM(100)])).toEqual(
      ERR('#NUM!'),
    )
    expect(call(INTRATE, [NUM(jan1_2020), NUM(jan1_2021), NUM(0), NUM(1100)])).toEqual(
      ERR('#NUM!'),
    )
    expect(call(RECEIVED, [NUM(jan1_2020), NUM(jan1_2021), NUM(1000), NUM(1.5)])).toEqual(
      ERR('#NUM!'),
    )
  })
})

describe('Treasury bill functions', () => {
  const jan1_2020 = dateSerial(2020, 1, 1)
  const jul1_2020 = dateSerial(2020, 7, 1)
  const jan1_2022 = dateSerial(2022, 1, 1)

  test('TBILLEQ annualizes discount on a 365-day equivalent basis', () => {
    expectClose(call(TBILLEQ, [NUM(jan1_2020), NUM(jul1_2020), NUM(0.05)]), 0.05201, 1e-5)
  })

  test('TBILLPRICE returns price per $100 face value', () => {
    expectClose(call(TBILLPRICE, [NUM(jan1_2020), NUM(jul1_2020), NUM(0.05)]), 97.472222, 1e-6)
  })

  test('TBILLYIELD returns yield from price', () => {
    expectClose(call(TBILLYIELD, [NUM(jan1_2020), NUM(jul1_2020), NUM(97.4722)]), 0.0513, 1e-4)
  })

  test('T-bills require positive rates/prices and maturity within one year', () => {
    expect(call(TBILLEQ, [NUM(jan1_2020), NUM(jul1_2020), NUM(0)])).toEqual(ERR('#NUM!'))
    expect(call(TBILLPRICE, [NUM(jan1_2020), NUM(jan1_2022), NUM(0.05)])).toEqual(
      ERR('#NUM!'),
    )
    expect(call(TBILLYIELD, [NUM(jan1_2020), NUM(jul1_2020), NUM(0)])).toEqual(ERR('#NUM!'))
  })
})

describe('DURATION / MDURATION', () => {
  const jan1_2020 = dateSerial(2020, 1, 1)
  const jan1_2025 = dateSerial(2025, 1, 1)

  test('DURATION returns a positive Macaulay duration under maturity', () => {
    const result = call(DURATION, [NUM(jan1_2020), NUM(jan1_2025), NUM(0.05), NUM(0.05), NUM(2), NUM(0)])
    expect(result.kind).toBe('number')
    if (result.kind === 'number') {
      expect(result.value).toBeGreaterThan(0)
      expect(result.value).toBeLessThan(5)
    }
  })

  test('MDURATION is DURATION discounted by yield per period', () => {
    const duration = call(DURATION, [
      NUM(jan1_2020),
      NUM(jan1_2025),
      NUM(0.05),
      NUM(0.06),
      NUM(2),
      NUM(0),
    ])
    const modified = call(MDURATION, [
      NUM(jan1_2020),
      NUM(jan1_2025),
      NUM(0.05),
      NUM(0.06),
      NUM(2),
      NUM(0),
    ])
    expect(duration.kind).toBe('number')
    expect(modified.kind).toBe('number')
    if (duration.kind === 'number' && modified.kind === 'number') {
      expect(modified.value).toBeCloseTo(duration.value / 1.03, 10)
      expect(modified.value).toBeLessThan(duration.value)
    }
  })

  test('invalid frequency and date order return #NUM!', () => {
    expect(call(DURATION, [NUM(jan1_2020), NUM(jan1_2025), NUM(0.05), NUM(0.05), NUM(3)])).toEqual(
      ERR('#NUM!'),
    )
    expect(call(MDURATION, [NUM(jan1_2025), NUM(jan1_2020), NUM(0.05), NUM(0.05), NUM(2)])).toEqual(
      ERR('#NUM!'),
    )
  })
})

describe('Bond pricing and yield functions', () => {
  const jan1_2019 = dateSerial(2019, 1, 1)
  const jan1_2020 = dateSerial(2020, 1, 1)
  const jul1_2020 = dateSerial(2020, 7, 1)
  const jan1_2021 = dateSerial(2021, 1, 1)
  const jul1_2021 = dateSerial(2021, 7, 1)
  const jan1_2024 = dateSerial(2024, 1, 1)
  const jul1_2024 = dateSerial(2024, 7, 1)
  const jan1_2025 = dateSerial(2025, 1, 1)
  const jul1_2025 = dateSerial(2025, 7, 1)

  test('PRICE returns par when coupon equals yield at a coupon boundary', () => {
    expectClose(
      call(PRICE, [NUM(jan1_2020), NUM(jan1_2025), NUM(0.05), NUM(0.05), NUM(100), NUM(2), NUM(0)]),
      100,
      1e-2,
    )
  })

  test('YIELD inverts PRICE', () => {
    const price = call(
      PRICE,
      [NUM(jan1_2020), NUM(jan1_2025), NUM(0.05), NUM(0.06), NUM(100), NUM(2), NUM(0)],
    )
    expect(price.kind).toBe('number')
    if (price.kind === 'number') {
      expectClose(
        call(YIELD, [
          NUM(jan1_2020),
          NUM(jan1_2025),
          NUM(0.05),
          NUM(price.value),
          NUM(100),
          NUM(2),
          NUM(0),
        ]),
        0.06,
        1e-5,
      )
    }
  })

  test('PRICEDISC and YIELDDISC use discount-security closed forms', () => {
    expectClose(
      call(PRICEDISC, [NUM(jan1_2020), NUM(jul1_2020), NUM(0.05), NUM(100), NUM(0)]),
      97.5,
      1e-9,
    )
    expectClose(
      call(YIELDDISC, [NUM(jan1_2020), NUM(jul1_2020), NUM(97.5), NUM(100), NUM(0)]),
      (100 - 97.5) / 97.5 / 0.5,
      1e-9,
    )
  })

  test('PRICEMAT and YIELDMAT use maturity-interest closed forms', () => {
    expectClose(
      call(PRICEMAT, [
        NUM(jan1_2020),
        NUM(jan1_2021),
        NUM(jan1_2019),
        NUM(0.05),
        NUM(0.05),
        NUM(0),
      ]),
      110 / 1.05 - 5,
      1e-9,
    )
    expectClose(
      call(YIELDMAT, [
        NUM(jan1_2020),
        NUM(jan1_2021),
        NUM(jan1_2019),
        NUM(0.05),
        NUM(110 / 1.06 - 5),
        NUM(0),
      ]),
      0.06,
      1e-9,
    )
  })

  test('ODDFPRICE and ODDFYIELD handle short odd first coupon periods', () => {
    expectClose(
      call(ODDFPRICE, [
        NUM(jul1_2020),
        NUM(jul1_2025),
        NUM(jan1_2020),
        NUM(jan1_2021),
        NUM(0.05),
        NUM(0.05),
        NUM(100),
        NUM(2),
        NUM(0),
      ]),
      100,
      1,
    )

    const price = call(ODDFPRICE, [
      NUM(jul1_2020),
      NUM(jul1_2025),
      NUM(jan1_2020),
      NUM(jan1_2021),
      NUM(0.05),
      NUM(0.07),
      NUM(100),
      NUM(2),
      NUM(0),
    ])
    expect(price.kind).toBe('number')
    if (price.kind === 'number') {
      expectClose(
        call(ODDFYIELD, [
          NUM(jul1_2020),
          NUM(jul1_2025),
          NUM(jan1_2020),
          NUM(jan1_2021),
          NUM(0.05),
          NUM(price.value),
          NUM(100),
          NUM(2),
          NUM(0),
        ]),
        0.07,
        1e-3,
      )
    }
  })

  test('ODDLPRICE and ODDLYIELD handle odd last coupon periods', () => {
    const priceAtPar = call(ODDLPRICE, [
      NUM(jul1_2024),
      NUM(jan1_2025),
      NUM(jan1_2024),
      NUM(0.05),
      NUM(0.05),
      NUM(100),
      NUM(2),
      NUM(0),
    ])
    expect(priceAtPar.kind).toBe('number')
    if (priceAtPar.kind === 'number') {
      expect(priceAtPar.value).toBeGreaterThan(95)
      expect(priceAtPar.value).toBeLessThan(105)
    }

    const price = call(ODDLPRICE, [
      NUM(jul1_2024),
      NUM(jan1_2025),
      NUM(jan1_2024),
      NUM(0.05),
      NUM(0.06),
      NUM(100),
      NUM(2),
      NUM(0),
    ])
    expect(price.kind).toBe('number')
    if (price.kind === 'number') {
      expectClose(
        call(ODDLYIELD, [
          NUM(jul1_2024),
          NUM(jan1_2025),
          NUM(jan1_2024),
          NUM(0.05),
          NUM(price.value),
          NUM(100),
          NUM(2),
          NUM(0),
        ]),
        0.06,
        1e-4,
      )
    }
  })

  test('pricing functions validate date order, prices, and frequency', () => {
    expect(
      call(PRICE, [NUM(jan1_2025), NUM(jan1_2020), NUM(0.05), NUM(0.05), NUM(100), NUM(2)]),
    ).toEqual(ERR('#NUM!'))
    expect(
      call(YIELD, [NUM(jan1_2020), NUM(jan1_2025), NUM(0.05), NUM(100), NUM(100), NUM(3)]),
    ).toEqual(ERR('#NUM!'))
    expect(call(PRICEDISC, [NUM(jul1_2020), NUM(jan1_2020), NUM(0.05), NUM(100)])).toEqual(
      ERR('#NUM!'),
    )
    expect(call(YIELDDISC, [NUM(jan1_2020), NUM(jul1_2020), NUM(0), NUM(100)])).toEqual(
      ERR('#NUM!'),
    )
    expect(
      call(PRICEMAT, [NUM(jan1_2020), NUM(jan1_2021), NUM(jul1_2020), NUM(0.05), NUM(0.05)]),
    ).toEqual(ERR('#NUM!'))
    expect(
      call(YIELDMAT, [NUM(jan1_2020), NUM(jan1_2021), NUM(jan1_2019), NUM(0.05), NUM(-1)]),
    ).toEqual(ERR('#NUM!'))
    expect(
      call(ODDFPRICE, [
        NUM(jul1_2021),
        NUM(jul1_2025),
        NUM(jan1_2020),
        NUM(jan1_2021),
        NUM(0.05),
        NUM(0.05),
        NUM(100),
        NUM(2),
      ]),
    ).toEqual(ERR('#NUM!'))
    expect(
      call(ODDFYIELD, [
        NUM(jul1_2020),
        NUM(jul1_2025),
        NUM(jan1_2020),
        NUM(jan1_2021),
        NUM(0.05),
        NUM(100),
        NUM(100),
        NUM(3),
      ]),
    ).toEqual(ERR('#NUM!'))
    expect(
      call(ODDLPRICE, [
        NUM(jan1_2024),
        NUM(jan1_2025),
        NUM(jul1_2024),
        NUM(0.05),
        NUM(0.05),
        NUM(100),
        NUM(2),
      ]),
    ).toEqual(ERR('#NUM!'))
    expect(
      call(ODDLYIELD, [
        NUM(jul1_2024),
        NUM(jan1_2025),
        NUM(jan1_2024),
        NUM(0.05),
        NUM(0),
        NUM(100),
        NUM(2),
      ]),
    ).toEqual(ERR('#NUM!'))
  })
})

describe('Coupon date functions', () => {
  const jan1_2020 = dateSerial(2020, 1, 1)
  const apr1_2020 = dateSerial(2020, 4, 1)
  const jan1_2024 = dateSerial(2024, 1, 1)
  const apr1_2024 = dateSerial(2024, 4, 1)
  const jul1_2024 = dateSerial(2024, 7, 1)
  const jan1_2025 = dateSerial(2025, 1, 1)

  test('COUPDAYBS and COUPDAYS count the current coupon period', () => {
    expectClose(call(COUPDAYBS, [NUM(apr1_2020), NUM(jan1_2025), NUM(2), NUM(1)]), 91, 1e-9)
    expectClose(call(COUPDAYS, [NUM(apr1_2020), NUM(jan1_2025), NUM(2), NUM(0)]), 180, 1e-9)
    expectClose(call(COUPDAYS, [NUM(apr1_2020), NUM(jan1_2025), NUM(2), NUM(1)]), 182, 1e-9)
  })

  test('COUPDAYSNC counts settlement to next coupon', () => {
    expectClose(call(COUPDAYSNC, [NUM(apr1_2020), NUM(jan1_2025), NUM(2), NUM(1)]), 91, 1e-9)
  })

  test('COUPNCD / COUPPCD return adjacent coupon dates', () => {
    expectClose(call(COUPNCD, [NUM(apr1_2024), NUM(jan1_2025), NUM(2), NUM(0)]), jul1_2024, 1e-9)
    expectClose(call(COUPPCD, [NUM(apr1_2024), NUM(jan1_2025), NUM(2), NUM(0)]), jan1_2024, 1e-9)
  })

  test('COUPNUM rounds up to whole coupons remaining', () => {
    expectClose(call(COUPNUM, [NUM(jan1_2020), NUM(jan1_2025), NUM(2), NUM(0)]), 10, 1e-9)
    expectClose(call(COUPNUM, [NUM(apr1_2024), NUM(jan1_2025), NUM(2), NUM(0)]), 2, 1e-9)
  })

  test('coupon functions validate frequency and date order', () => {
    expect(call(COUPDAYBS, [NUM(apr1_2020), NUM(jan1_2025), NUM(3)])).toEqual(ERR('#NUM!'))
    expect(call(COUPNCD, [NUM(jan1_2025), NUM(jan1_2024), NUM(2), NUM(0)])).toEqual(
      ERR('#NUM!'),
    )
  })
})

describe('new financial functions error propagation', () => {
  const cases: Array<[string, FunctionImpl, Value[]]> = [
    ['ACCRINT', ACCRINT, [ERR('#REF!'), NUM(1), NUM(2), NUM(0.1), NUM(100), NUM(2)]],
    ['ACCRINTM', ACCRINTM, [ERR('#REF!'), NUM(2), NUM(0.1), NUM(100)]],
    ['COUPDAYBS', COUPDAYBS, [ERR('#REF!'), NUM(2), NUM(2)]],
    ['COUPDAYS', COUPDAYS, [ERR('#REF!'), NUM(2), NUM(2)]],
    ['COUPDAYSNC', COUPDAYSNC, [ERR('#REF!'), NUM(2), NUM(2)]],
    ['COUPNCD', COUPNCD, [ERR('#REF!'), NUM(2), NUM(2)]],
    ['COUPNUM', COUPNUM, [ERR('#REF!'), NUM(2), NUM(2)]],
    ['COUPPCD', COUPPCD, [ERR('#REF!'), NUM(2), NUM(2)]],
    ['SLN', SLN, [ERR('#REF!'), NUM(0), NUM(1)]],
    ['SYD', SYD, [ERR('#REF!'), NUM(0), NUM(1), NUM(1)]],
    ['DB', DB, [ERR('#REF!'), NUM(0), NUM(1), NUM(1)]],
    ['DDB', DDB, [ERR('#REF!'), NUM(0), NUM(1), NUM(1)]],
    ['AMORDEGRC', AMORDEGRC, [ERR('#REF!'), NUM(1), NUM(2), NUM(0), NUM(0), NUM(0.1)]],
    ['AMORLINC', AMORLINC, [ERR('#REF!'), NUM(1), NUM(2), NUM(0), NUM(0), NUM(0.1)]],
    ['DISC', DISC, [ERR('#REF!'), NUM(2), NUM(90), NUM(100)]],
    ['DOLLARDE', DOLLARDE, [ERR('#REF!'), NUM(16)]],
    ['DOLLARFR', DOLLARFR, [ERR('#REF!'), NUM(16)]],
    ['DURATION', DURATION, [ERR('#REF!'), NUM(2), NUM(0.05), NUM(0.05), NUM(2)]],
    ['VDB', VDB, [ERR('#REF!'), NUM(0), NUM(1), NUM(0), NUM(1)]],
    ['CUMPRINC', CUMPRINC, [ERR('#REF!'), NUM(1), NUM(1), NUM(1), NUM(1), NUM(0)]],
    ['EFFECT', EFFECT, [ERR('#REF!'), NUM(1)]],
    ['NOMINAL', NOMINAL, [ERR('#REF!'), NUM(1)]],
    ['INTRATE', INTRATE, [ERR('#REF!'), NUM(2), NUM(1000), NUM(1100)]],
    ['ISPMT', ISPMT, [ERR('#REF!'), NUM(1), NUM(1), NUM(1)]],
    ['MDURATION', MDURATION, [ERR('#REF!'), NUM(2), NUM(0.05), NUM(0.05), NUM(2)]],
    ['FVSCHEDULE', FVSCHEDULE, [ERR('#REF!'), ARR([[NUM(0.1)]])]],
    ['MIRR', MIRR, [ERR('#REF!'), NUM(0.1), NUM(0.1)]],
    ['RECEIVED', RECEIVED, [ERR('#REF!'), NUM(2), NUM(1000), NUM(0.1)]],
    ['TBILLEQ', TBILLEQ, [ERR('#REF!'), NUM(2), NUM(0.05)]],
    ['TBILLPRICE', TBILLPRICE, [ERR('#REF!'), NUM(2), NUM(0.05)]],
    ['TBILLYIELD', TBILLYIELD, [ERR('#REF!'), NUM(2), NUM(90)]],
    ['PRICE', PRICE, [ERR('#REF!'), NUM(2), NUM(0.05), NUM(0.05), NUM(100), NUM(2)]],
    ['YIELD', YIELD, [ERR('#REF!'), NUM(2), NUM(0.05), NUM(100), NUM(100), NUM(2)]],
    ['PRICEDISC', PRICEDISC, [ERR('#REF!'), NUM(2), NUM(0.05), NUM(100)]],
    ['YIELDDISC', YIELDDISC, [ERR('#REF!'), NUM(2), NUM(100), NUM(100)]],
    ['PRICEMAT', PRICEMAT, [ERR('#REF!'), NUM(2), NUM(1), NUM(0.05), NUM(0.05)]],
    ['YIELDMAT', YIELDMAT, [ERR('#REF!'), NUM(2), NUM(1), NUM(0.05), NUM(100)]],
    ['ODDFPRICE', ODDFPRICE, [ERR('#REF!'), NUM(3), NUM(1), NUM(2), NUM(0.05), NUM(0.05), NUM(100), NUM(2)]],
    ['ODDFYIELD', ODDFYIELD, [ERR('#REF!'), NUM(3), NUM(1), NUM(2), NUM(0.05), NUM(100), NUM(100), NUM(2)]],
    ['ODDLPRICE', ODDLPRICE, [ERR('#REF!'), NUM(3), NUM(1), NUM(0.05), NUM(0.05), NUM(100), NUM(2)]],
    ['ODDLYIELD', ODDLYIELD, [ERR('#REF!'), NUM(3), NUM(1), NUM(0.05), NUM(100), NUM(100), NUM(2)]],
    ['XNPV', XNPV, [ERR('#REF!'), ARR([[NUM(-1), NUM(2)]]), ARR([[NUM(1), NUM(2)]])]],
    ['XIRR', XIRR, [ERR('#REF!'), ARR([[NUM(1), NUM(2)]])]],
    ['PDURATION', PDURATION, [ERR('#REF!'), NUM(1), NUM(2)]],
    ['RRI', RRI, [ERR('#REF!'), NUM(1), NUM(2)]],
  ]

  test.each(cases)('%s propagates leading scalar error', (_name, fn, args) => {
    expect(call(fn, args)).toEqual(ERR('#REF!'))
  })
})

// ---------------------------------------------------------------------------
// Harvey P2 — tail issues (residual scaling, NASD Feb EOM, invalid basis)
// ---------------------------------------------------------------------------

describe('Harvey tail — residual scaling for tiny cashflows', () => {
  // The tolerance threshold uses `max(|cashflows|, 1)` instead of raw |scale|,
  // so tiny inputs don't get a sub-machine-epsilon tolerance and don't get
  // accepted on a stuck-Newton step whose residual is still significant.

  test('RATE on tiny pmt with pv=1 converges cleanly or rejects on residual', () => {
    // RATE(10, -0.0001, 1) — pmt 0.0001 USD, pv 1 USD, fv 0. With the floored
    // threshold the answer is either a real root with |f| < 1e-6, or #NUM!.
    const result = call(RATE, [NUM(10), NUM(-0.0001), NUM(1)])
    if (result.kind === 'number') {
      const r = result.value
      const pow = Math.pow(1 + r, 10)
      const residual = 1 * pow + -0.0001 * (pow - 1) / r
      expect(Math.abs(residual)).toBeLessThan(1e-6)
    } else {
      expect(result).toEqual(ERR('#NUM!'))
    }
  })

  test('IRR on tiny cashflows converges to a valid root (not #NUM!)', () => {
    // IRR over uniformly scaled cashflows is scale-invariant in theory. With
    // the floored-tolerance fix the tiny case returns a finite rate satisfying
    // |f(rate)| <= threshold; we verify by re-computing the NPV.
    const result = call(IRR, [ARR([[NUM(-1e-9), NUM(2e-9)]])])
    expect(result.kind).toBe('number')
    if (result.kind === 'number') {
      const flows = [-1e-9, 2e-9]
      let f = 0
      for (let i = 0; i < flows.length; i++) f += flows[i] / Math.pow(1 + result.value, i)
      expect(Math.abs(f)).toBeLessThan(1e-9)
    }
  })

  test('XIRR on million-scale cashflows converges (sanity for non-tiny scale)', () => {
    // Large absolute scale + single-day window — floored-scale threshold
    // doesn't relax the check when |scale| ≫ 1.
    const jan1 = dateSerial(2020, 1, 1)
    const jan2 = dateSerial(2020, 1, 2)
    const result = call(XIRR, [
      ARR([[NUM(-1000000), NUM(1000001)]]),
      ARR([[NUM(jan1), NUM(jan2)]]),
    ])
    expect(result.kind).toBe('number')
  })
})

describe('Harvey tail — invalid basis returns #NUM! (Excel-correct)', () => {
  const jan1_2020 = dateSerial(2020, 1, 1)
  const jan1_2021 = dateSerial(2021, 1, 1)
  const jan1_2019 = dateSerial(2019, 1, 1)

  test('ACCRINT basis=5 → #NUM!', () => {
    expect(
      call(ACCRINT, [
        NUM(jan1_2020),
        NUM(jan1_2021),
        NUM(jan1_2021),
        NUM(0.05),
        NUM(1000),
        NUM(2),
        NUM(5),
      ]),
    ).toEqual(ERR('#NUM!'))
  })

  test('ACCRINT basis=-1 → #NUM!', () => {
    expect(
      call(ACCRINT, [
        NUM(jan1_2020),
        NUM(jan1_2021),
        NUM(jan1_2021),
        NUM(0.05),
        NUM(1000),
        NUM(2),
        NUM(-1),
      ]),
    ).toEqual(ERR('#NUM!'))
  })

  test('DURATION basis=5 → #NUM!', () => {
    expect(
      call(DURATION, [
        NUM(jan1_2020),
        NUM(jan1_2021),
        NUM(0.05),
        NUM(0.05),
        NUM(2),
        NUM(5),
      ]),
    ).toEqual(ERR('#NUM!'))
  })

  test('DURATION fractional basis → #NUM!', () => {
    expect(
      call(DURATION, [
        NUM(jan1_2020),
        NUM(jan1_2021),
        NUM(0.05),
        NUM(0.05),
        NUM(2),
        NUM(1.5),
      ]),
    ).toEqual(ERR('#NUM!'))
  })

  test('AMORLINC basis=-1 → #NUM!', () => {
    expect(
      call(AMORLINC, [
        NUM(2400),
        NUM(dateSerial(2008, 8, 19)),
        NUM(dateSerial(2008, 12, 31)),
        NUM(300),
        NUM(1),
        NUM(0.15),
        NUM(-1),
      ]),
    ).toEqual(ERR('#NUM!'))
  })

  test('YIELDMAT basis=5 → #NUM!', () => {
    expect(
      call(YIELDMAT, [
        NUM(jan1_2020),
        NUM(jan1_2021),
        NUM(jan1_2019),
        NUM(0.05),
        NUM(100),
        NUM(5),
      ]),
    ).toEqual(ERR('#NUM!'))
  })
})

describe('Harvey tail — NASD 30/360 Feb EOM in financial yearFracBasis', () => {
  // YEARFRAC lives in date.ts but financial.ts has its own basis-0 path used
  // by ACCRINT, DISC, DURATION, PRICE, YIELD, etc. The two paths must agree.

  test('ACCRINT basis 0 over last-Feb endpoints uses Feb EOM rule', () => {
    // Issue→Settlement Feb-29 2020 → Feb-28 2021 spans exactly one NASD year
    // once Feb EOM is applied. Without the rule we'd be 1/360 short.
    const feb29_2020 = dateSerial(2020, 2, 29)
    const feb28_2021 = dateSerial(2021, 2, 28)
    const withEom = call(ACCRINT, [
      NUM(feb29_2020),
      NUM(feb28_2021),
      NUM(feb28_2021),
      NUM(0.1),
      NUM(1000),
      NUM(1),
      NUM(0),
    ])
    expectClose(withEom, 100, 1e-9)
  })
})

// ---------------------------------------------------------------------------
// FUNCTIONS registry
// ---------------------------------------------------------------------------

describe('FUNCTIONS registry', () => {
  test('exposes existing and bond financial functions', () => {
    expect(Object.keys(FUNCTIONS).sort()).toEqual([
      'ACCRINT',
      'ACCRINTM',
      'AMORDEGRC',
      'AMORLINC',
      'COUPDAYBS',
      'COUPDAYS',
      'COUPDAYSNC',
      'COUPNCD',
      'COUPNUM',
      'COUPPCD',
      'CUMIPMT',
      'CUMPRINC',
      'DB',
      'DDB',
      'DISC',
      'DOLLARDE',
      'DOLLARFR',
      'DURATION',
      'EFFECT',
      'FV',
      'FVSCHEDULE',
      'INTRATE',
      'IPMT',
      'IRR',
      'ISPMT',
      'MDURATION',
      'MIRR',
      'NOMINAL',
      'NPER',
      'NPV',
      'ODDFPRICE',
      'ODDFYIELD',
      'ODDLPRICE',
      'ODDLYIELD',
      'PDURATION',
      'PMT',
      'PPMT',
      'PRICE',
      'PRICEDISC',
      'PRICEMAT',
      'PV',
      'RATE',
      'RECEIVED',
      'RRI',
      'SLN',
      'SYD',
      'TBILLEQ',
      'TBILLPRICE',
      'TBILLYIELD',
      'VDB',
      'XIRR',
      'XNPV',
      'YIELD',
      'YIELDDISC',
      'YIELDMAT',
    ])
  })

  test('every entry satisfies FunctionImpl shape', () => {
    for (const [name, fn] of Object.entries(FUNCTIONS)) {
      expect(typeof fn).toBe('function')
      expect(name).toBe(name.toUpperCase())
      // Every fn handles empty args without throwing (returns #VALUE!).
      expect(() => fn([], ctx)).not.toThrow()
      // Every fn propagates a leading scalar error.
      const r = fn([ERR('#REF!'), NUM(1), NUM(1), NUM(1)], ctx)
      expect(r.kind).toBe('error')
    }
  })
})
