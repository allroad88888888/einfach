/**
 * Regression tests for stats numerical-accuracy fixes
 * (FUNCTION_QUALITY_2026-06-05.md):
 *   1. BETA.INV — Newton-Raphson with bisection fallback (shallow CDF)
 *   2. GAMMA.INV — Newton-Raphson with bisection fallback
 *   3. NORM.INV / LOGNORM.INV / T.INV / F.INV — closed-form / Newton routing
 *   4. STDEV / VAR family — Welford's single-pass algorithm (cancellation)
 *
 * These cases were not exercised at this precision by the existing tests.
 */
import { describe, expect, test } from '@jest/globals'

import { FUNCTIONS } from '../src/eval/functions/stats'
import type { EvalContext, FunctionImpl, Value } from '../src/types'

const NUM = (n: number): Value => ({ kind: 'number', value: n })

const ctx: EvalContext = new Proxy(
  {},
  {
    get(_, prop) {
      throw new Error(`stats accuracy test unexpectedly read ctx.${String(prop)}`)
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

describe('Issue 1 — BETA.INV Newton-Raphson refinement', () => {
  test('round-trips BETA.DIST through BETA.INV at high precision (a=2, b=5)', () => {
    // Pick an x; compute its CDF, then invert. Tight tolerance forces precision
    // beyond what 100-iter bisection over [0,1] (~7e-31 wide but cdf-shallow) can
    // reach in one round trip — Newton refines to ~1e-12 cheaply.
    const x = 0.2387
    const p = asNumber(
      call('BETA.DIST', [NUM(x), NUM(2), NUM(5), { kind: 'boolean', value: true }]),
    )
    const back = asNumber(call('BETA.INV', [NUM(p), NUM(2), NUM(5)]))
    expect(back).toBeCloseTo(x, 12)
  })

  test('high-shape parameters round-trip cleanly', () => {
    // Shallow CDF region — bisection accuracy is limited by float density there.
    // Newton-Raphson converges to machine precision quickly.
    const x = 0.6
    const p = asNumber(
      call('BETA.DIST', [NUM(x), NUM(50), NUM(30), { kind: 'boolean', value: true }]),
    )
    const back = asNumber(call('BETA.INV', [NUM(p), NUM(50), NUM(30)]))
    expect(back).toBeCloseTo(x, 10)
  })

  test('symmetric BETA.INV(p=0.5, a=b) returns 0.5 to high precision', () => {
    const back = asNumber(call('BETA.INV', [NUM(0.5), NUM(3), NUM(3)]))
    expect(back).toBeCloseTo(0.5, 12)
  })

  test('BETAINV alias remains accurate after Newton swap', () => {
    expect(asNumber(call('BETAINV', [NUM(0.5), NUM(1), NUM(1), NUM(2), NUM(4)]))).toBeCloseTo(3, 12)
  })
})

describe('Issue 2 — GAMMA.INV Newton-Raphson refinement', () => {
  test('round-trips GAMMA.DIST through GAMMA.INV to ~10 decimals', () => {
    // Bisection via inversePositiveCdf converged here to ~6 decimals (existing
    // test asserts 6); Newton seeded at the mean drives it ~10 decimals.
    const x = 5
    const p = asNumber(
      call('GAMMA.DIST', [NUM(x), NUM(3), NUM(2), { kind: 'boolean', value: true }]),
    )
    const back = asNumber(call('GAMMA.INV', [NUM(p), NUM(3), NUM(2)]))
    expect(back).toBeCloseTo(x, 10)
  })

  test('large mean — Newton converges past the geometric-doubling bound', () => {
    const x = 1000
    const p = asNumber(
      call('GAMMA.DIST', [NUM(x), NUM(20), NUM(50), { kind: 'boolean', value: true }]),
    )
    const back = asNumber(call('GAMMA.INV', [NUM(p), NUM(20), NUM(50)]))
    expect(back).toBeCloseTo(x, 6)
  })

  test('p = 0 → 0 (boundary preserved by Newton path)', () => {
    expect(asNumber(call('GAMMA.INV', [NUM(0), NUM(2), NUM(3)]))).toBe(0)
  })
})

describe('Issue 3 — T.INV closed-form for df=1, NORM/LOGNORM.INV Acklam routing', () => {
  test('T.INV(p, df=1) matches Cauchy closed form tan(π·(p-0.5))', () => {
    // Newton on df=1 is fragile — fat tails make the PDF tiny far from origin.
    // Closed form is exact (modulo trig).
    const p = 0.97
    const t = asNumber(call('T.INV', [NUM(p), NUM(1)]))
    expect(t).toBeCloseTo(Math.tan(Math.PI * (p - 0.5)), 12)
  })

  test('T.INV(p, df=1) handles extreme tails without divergence', () => {
    const p = 0.999
    const t = asNumber(call('T.INV', [NUM(p), NUM(1)]))
    expect(t).toBeCloseTo(Math.tan(Math.PI * (p - 0.5)), 8)
  })

  test('T.INV(p, df=10) round-trips through T.DIST to high precision', () => {
    // Newton seeded by the standard-normal inverse converges quickly.
    const x = 1.812
    const p = asNumber(
      call('T.DIST', [NUM(x), NUM(10), { kind: 'boolean', value: true }]),
    )
    const back = asNumber(call('T.INV', [NUM(p), NUM(10)]))
    expect(back).toBeCloseTo(x, 10)
  })

  test('T.INV at large df approaches the standard-normal quantile', () => {
    // As df → ∞ the Student-t collapses onto N(0,1). Loose tolerance because
    // even df=1e6 still has a small (~10⁻⁷) discrepancy from the normal.
    const p = 0.975
    const t = asNumber(call('T.INV', [NUM(p), NUM(1e6)]))
    expect(t).toBeCloseTo(1.959963984540054, 5)
  })

  test('NORM.INV directly inverts NORM.DIST via Acklam (4 decimals over the whole tail)', () => {
    for (const p of [0.001, 0.05, 0.5, 0.95, 0.999]) {
      const z = asNumber(call('NORM.INV', [NUM(p), NUM(0), NUM(1)]))
      const back = asNumber(
        call('NORM.DIST', [NUM(z), NUM(0), NUM(1), { kind: 'boolean', value: true }]),
      )
      expect(back).toBeCloseTo(p, 10)
    }
  })

  test('LOGNORM.INV at typical inputs round-trips', () => {
    const p = 0.7
    const x = asNumber(call('LOGNORM.INV', [NUM(p), NUM(1), NUM(0.5)]))
    const back = asNumber(
      call('LOGNORM.DIST', [NUM(x), NUM(1), NUM(0.5), { kind: 'boolean', value: true }]),
    )
    expect(back).toBeCloseTo(p, 10)
  })

  test('F.INV Wilson-Hilferty seeding converges to high precision', () => {
    const x = 2.5
    const p = asNumber(
      call('F.DIST', [NUM(x), NUM(5), NUM(10), { kind: 'boolean', value: true }]),
    )
    const back = asNumber(call('F.INV', [NUM(p), NUM(5), NUM(10)]))
    expect(back).toBeCloseTo(x, 10)
  })

  test('F.INV.RT round-trips with the upper-tail probability', () => {
    const x = 2.5
    const tail = asNumber(call('F.DIST.RT', [NUM(x), NUM(5), NUM(10)]))
    const back = asNumber(call('F.INV.RT', [NUM(tail), NUM(5), NUM(10)]))
    expect(back).toBeCloseTo(x, 10)
  })
})

describe('Issue 4 — Welford STDEV / VAR cancellation resistance', () => {
  // Two-pass mean + sum-of-squares suffers catastrophic cancellation when
  // x_i = mean ± tiny_delta with |mean| ≫ delta. Welford's algorithm avoids it.
  // Note: input precision itself is bounded by float64 — eps(1e6) ≈ 1.16e-10,
  // so we choose delta ≫ eps(huge) to leave Welford's win measurable.
  const huge = 1e6
  const delta = 1e-3
  const huge1 = [huge, huge + delta, huge + 2 * delta, huge + 3 * delta]
  // Exact sample variance of {0, δ, 2δ, 3δ} is 5δ²/3.
  const exactSampleVar = (5 * delta * delta) / 3
  const exactSampleStdev = Math.sqrt(exactSampleVar)
  const exactPopVar = (5 * delta * delta) / 4
  const exactPopStdev = Math.sqrt(exactPopVar)

  test('STDEV survives huge-mean / tiny-spread input', () => {
    const v = asNumber(call('STDEV', huge1.map(NUM)))
    expect(v).toBeCloseTo(exactSampleStdev, 8)
  })

  test('VAR survives huge-mean / tiny-spread input', () => {
    const v = asNumber(call('VAR', huge1.map(NUM)))
    expect(v).toBeCloseTo(exactSampleVar, 12)
  })

  test('STDEVP survives huge-mean / tiny-spread input', () => {
    const v = asNumber(call('STDEVP', huge1.map(NUM)))
    expect(v).toBeCloseTo(exactPopStdev, 8)
  })

  test('VARP survives huge-mean / tiny-spread input', () => {
    const v = asNumber(call('VARP', huge1.map(NUM)))
    expect(v).toBeCloseTo(exactPopVar, 12)
  })

  test('STDEV.S / VAR.S aliases produce the same Welford result', () => {
    const sampleS = asNumber(call('STDEV.S', huge1.map(NUM)))
    const varS = asNumber(call('VAR.S', huge1.map(NUM)))
    expect(sampleS).toBeCloseTo(exactSampleStdev, 8)
    expect(varS).toBeCloseTo(exactSampleVar, 12)
  })

  test('STDEV.P / VAR.P aliases produce the same Welford result', () => {
    const stdevP = asNumber(call('STDEV.P', huge1.map(NUM)))
    const varP = asNumber(call('VAR.P', huge1.map(NUM)))
    expect(stdevP).toBeCloseTo(exactPopStdev, 8)
    expect(varP).toBeCloseTo(exactPopVar, 12)
  })

  test('STDEVA / VARA — single-pass also robust through varianceA path', () => {
    const stdev = asNumber(call('STDEVA', huge1.map(NUM)))
    const variance = asNumber(call('VARA', huge1.map(NUM)))
    expect(stdev).toBeCloseTo(exactSampleStdev, 8)
    expect(variance).toBeCloseTo(exactSampleVar, 12)
  })

  test('STDEVPA / VARPA — single-pass also robust', () => {
    const stdev = asNumber(call('STDEVPA', huge1.map(NUM)))
    const variance = asNumber(call('VARPA', huge1.map(NUM)))
    expect(stdev).toBeCloseTo(exactPopStdev, 8)
    expect(variance).toBeCloseTo(exactPopVar, 12)
  })

  test('STDEV preserves textbook accuracy on plain inputs', () => {
    // Sanity — the canonical example should still match its known value.
    const r = asNumber(call('STDEV', [NUM(2), NUM(4), NUM(4), NUM(4), NUM(5), NUM(5), NUM(7), NUM(9)]))
    expect(r).toBeCloseTo(2.138089935299395, 12)
  })
})
