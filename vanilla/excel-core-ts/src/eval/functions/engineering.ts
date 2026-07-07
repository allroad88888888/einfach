/**
 * Phase 8 — engineering functions: base conversions, bit ops, comparators,
 * complex numbers.
 *
 * Excel limits its base-conversion functions to 10 characters of input
 * (i.e. 40-bit precision) and uses two's-complement for negative values.
 * We mirror those limits to keep results bit-identical with Excel.
 *
 * Functions:
 *   DEC2BIN, DEC2OCT, DEC2HEX, BIN2DEC, OCT2DEC, HEX2DEC,
 *   BIN2HEX, BIN2OCT, HEX2BIN, HEX2OCT, OCT2BIN, OCT2HEX,
 *   BITAND, BITOR, BITXOR, BITLSHIFT, BITRSHIFT,
 *   DELTA, GESTEP,
 *   BESSELI, BESSELJ, BESSELK, BESSELY,
 *   ERF, ERF.PRECISE, ERFC, ERFC.PRECISE, CONVERT,
 *   COMPLEX, IMABS, IMAGINARY, IMARGUMENT, IMCONJUGATE,
 *   IMCOS, IMCOSH, IMCOT, IMCSC, IMCSCH, IMDIV, IMEXP,
 *   IMLN, IMLOG10, IMLOG2, IMPOWER, IMPRODUCT, IMREAL,
 *   IMSEC, IMSECH, IMSIN, IMSINH, IMSQRT, IMSUB, IMSUM, IMTAN
 *
 * Base conversions use the per-function signed width: BIN=10 bits,
 * OCT=30 bits, HEX=40 bits.
 */

import type { FunctionImpl, Value } from '../../types'
import { propagateError, toNumber, toString } from '../coerce'

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const ERR = (
  code: '#DIV/0!' | '#N/A' | '#NUM!' | '#VALUE!',
  message?: string,
): Value => (message ? { kind: 'error', code, message } : { kind: 'error', code })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a string in the given base. Excel allows up to 10 characters of
 * input. Values with the high bit set (e.g. "FFFFFFFFFF" hex) are
 * two's-complement negatives within the source base's signed width.
 */
function parseBaseString(
  s: string,
  base: number,
  maxChars: number,
  bitsPerDigit: number,
): number | null {
  const trimmed = s.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > maxChars) return null
  // Verify valid digits.
  const validRe = base === 2 ? /^[01]+$/
    : base === 8 ? /^[0-7]+$/
    : base === 16 ? /^[0-9A-Fa-f]+$/
    : /^[0-9]+$/
  if (!validRe.test(trimmed)) return null
  let n = 0
  for (const ch of trimmed) {
    n = n * base + parseInt(ch, base)
  }
  // Two's complement for the high-bit-set case (only relevant when maxChars
  // is the full width).
  if (trimmed.length === maxChars) {
    const bits = maxChars * bitsPerDigit
    const highBit = Math.pow(2, bits - 1)
    if (n >= highBit) {
      n -= Math.pow(2, bits)
    }
  }
  return n
}

/** Format a number in the given base, using two's complement for negatives. */
function formatBaseString(
  n: number,
  base: number,
  maxChars: number,
  bitsPerDigit: number,
): string | null {
  if (!Number.isFinite(n)) return null
  const bits = maxChars * bitsPerDigit
  const lo = -Math.pow(2, bits - 1)
  const hi = Math.pow(2, bits - 1) - 1
  let value = Math.trunc(n)
  if (value < lo || value > hi) return null
  if (value < 0) {
    value += Math.pow(2, bits)
  }
  const digits = '0123456789ABCDEF'
  if (value === 0) return '0'
  let out = ''
  while (value > 0) {
    const r = value % base
    out = digits[r] + out
    value = Math.floor(value / base)
  }
  return n < 0 ? out.padStart(maxChars, '0') : out
}

type PlacesResult =
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly error: Value }

function placesValue(arg: Value | undefined, maxChars: number): PlacesResult {
  if (arg === undefined) return { ok: true, value: undefined }
  const p = toNumber(arg)
  if (!p.ok) return { ok: false, error: p.error }
  const places = Math.trunc(p.value)
  if (places < 1 || places > maxChars) return { ok: false, error: ERR('#NUM!') }
  return { ok: true, value: places }
}

function inputBaseString(v: Value): string | Value {
  if (v.kind === 'string') return v.value
  if (v.kind === 'number') return Math.trunc(v.value).toString()
  return ERR('#VALUE!')
}

function decToXxx(
  args: ReadonlyArray<Value>,
  base: number,
  maxChars: number,
  bitsPerDigit: number,
): Value {
  const err = propagateError(args)
  if (err) return err
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  const n = Math.trunc(v.value)
  const formatted = formatBaseString(n, base, maxChars, bitsPerDigit)
  if (formatted === null) return ERR('#NUM!')
  // Optional places argument.
  if (args.length === 2) {
    const places = placesValue(args[1], maxChars)
    if (!places.ok) return places.error
    if (n < 0) {
      // Excel ignores `places` for negatives.
      return { kind: 'string', value: formatted }
    }
    if (places.value === undefined || formatted.length > places.value) return ERR('#NUM!')
    return { kind: 'string', value: formatted.padStart(places.value, '0') }
  }
  return { kind: 'string', value: formatted }
}

function xxxToDec(
  args: ReadonlyArray<Value>,
  base: number,
  maxChars: number,
  bitsPerDigit: number,
): Value {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 1) return ERR('#VALUE!')
  const s = inputBaseString(args[0])
  if (typeof s !== 'string') return s
  const parsed = parseBaseString(s, base, maxChars, bitsPerDigit)
  if (parsed === null) return ERR('#NUM!')
  return NUM(parsed)
}

function crossBase(
  args: ReadonlyArray<Value>,
  fromBase: number,
  fromBitsPerDigit: number,
  toBase: number,
  toBitsPerDigit: number,
): Value {
  const err = propagateError(args)
  if (err) return err
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
  const s = inputBaseString(args[0])
  if (typeof s !== 'string') return s
  const parsed = parseBaseString(s, fromBase, 10, fromBitsPerDigit)
  if (parsed === null) return ERR('#NUM!')
  const formatted = formatBaseString(parsed, toBase, 10, toBitsPerDigit)
  if (formatted === null) return ERR('#NUM!')
  if (args.length === 2) {
    const places = placesValue(args[1], 10)
    if (!places.ok) return places.error
    if (parsed < 0) return { kind: 'string', value: formatted }
    if (places.value === undefined || formatted.length > places.value) return ERR('#NUM!')
    return { kind: 'string', value: formatted.padStart(places.value, '0') }
  }
  return { kind: 'string', value: formatted }
}

// ---------------------------------------------------------------------------
// Base conversions
// ---------------------------------------------------------------------------

export const DEC2BIN: FunctionImpl = (args) => decToXxx(args, 2, 10, 1)
export const DEC2OCT: FunctionImpl = (args) => decToXxx(args, 8, 10, 3)
export const DEC2HEX: FunctionImpl = (args) => decToXxx(args, 16, 10, 4)

export const BIN2DEC: FunctionImpl = (args) => xxxToDec(args, 2, 10, 1)
export const OCT2DEC: FunctionImpl = (args) => xxxToDec(args, 8, 10, 3)
export const HEX2DEC: FunctionImpl = (args) => xxxToDec(args, 16, 10, 4)

export const BIN2HEX: FunctionImpl = (args) => crossBase(args, 2, 1, 16, 4)
export const BIN2OCT: FunctionImpl = (args) => crossBase(args, 2, 1, 8, 3)
export const HEX2BIN: FunctionImpl = (args) => crossBase(args, 16, 4, 2, 1)
export const HEX2OCT: FunctionImpl = (args) => crossBase(args, 16, 4, 8, 3)
export const OCT2BIN: FunctionImpl = (args) => crossBase(args, 8, 3, 2, 1)
export const OCT2HEX: FunctionImpl = (args) => crossBase(args, 8, 3, 16, 4)

// ---------------------------------------------------------------------------
// Bit operations — Excel limits to 48-bit (2^48 - 1).
// ---------------------------------------------------------------------------

const BIT_MAX = 281_474_976_710_655 // 2^48 - 1

function bitOp(args: ReadonlyArray<Value>, op: (a: number, b: number) => number): Value {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 2) return ERR('#VALUE!')
  const a = toNumber(args[0])
  if (!a.ok) return a.error
  const b = toNumber(args[1])
  if (!b.ok) return b.error
  const av = Math.trunc(a.value)
  const bv = Math.trunc(b.value)
  if (av < 0 || bv < 0 || av > BIT_MAX || bv > BIT_MAX) return ERR('#NUM!')
  // Use BigInt for 48-bit-safe ops.
  const out = Number(op(av, bv))
  return NUM(out)
}

export const BITAND: FunctionImpl = (args) => bitOp(args, (a, b) => {
  // 48-bit AND via BigInt (Number bitwise ops are 32-bit).
  return Number(BigInt(a) & BigInt(b))
})

export const BITOR: FunctionImpl = (args) => bitOp(args, (a, b) => {
  return Number(BigInt(a) | BigInt(b))
})

export const BITXOR: FunctionImpl = (args) => bitOp(args, (a, b) => {
  return Number(BigInt(a) ^ BigInt(b))
})

export const BITLSHIFT: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 2) return ERR('#VALUE!')
  const a = toNumber(args[0])
  if (!a.ok) return a.error
  const s = toNumber(args[1])
  if (!s.ok) return s.error
  const av = Math.trunc(a.value)
  const shift = Math.trunc(s.value)
  if (av < 0 || av > BIT_MAX) return ERR('#NUM!')
  if (Math.abs(shift) > 53) return ERR('#NUM!')
  const out = shift >= 0
    ? Number(BigInt(av) << BigInt(shift))
    : Number(BigInt(av) >> BigInt(-shift))
  if (out > BIT_MAX) return ERR('#NUM!')
  return NUM(out)
}

export const BITRSHIFT: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 2) return ERR('#VALUE!')
  const a = toNumber(args[0])
  if (!a.ok) return a.error
  const s = toNumber(args[1])
  if (!s.ok) return s.error
  const av = Math.trunc(a.value)
  const shift = Math.trunc(s.value)
  if (av < 0 || av > BIT_MAX) return ERR('#NUM!')
  if (Math.abs(shift) > 53) return ERR('#NUM!')
  const out = shift >= 0
    ? Number(BigInt(av) >> BigInt(shift))
    : Number(BigInt(av) << BigInt(-shift))
  if (out > BIT_MAX) return ERR('#NUM!')
  return NUM(out)
}

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

/** DELTA(a, [b=0]) — 1 if equal, 0 otherwise. */
export const DELTA: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
  const a = toNumber(args[0])
  if (!a.ok) return a.error
  let b = 0
  if (args.length === 2) {
    const r = toNumber(args[1])
    if (!r.ok) return r.error
    b = r.value
  }
  return NUM(a.value === b ? 1 : 0)
}

/** GESTEP(n, [step=0]) — 1 if n >= step, 0 otherwise. */
export const GESTEP: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
  const n = toNumber(args[0])
  if (!n.ok) return n.error
  let step = 0
  if (args.length === 2) {
    const r = toNumber(args[1])
    if (!r.ok) return r.error
    step = r.value
  }
  return NUM(n.value >= step ? 1 : 0)
}

// ---------------------------------------------------------------------------
// Bessel functions
// ---------------------------------------------------------------------------

const FRAC_PI_4 = Math.PI / 4

function evalBessel(
  args: ReadonlyArray<Value>,
  kernel: (x: number, n: number) => number | null,
): Value {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 2) return ERR('#VALUE!')
  const x = toNumber(args[0])
  if (!x.ok) return x.error
  const order = toNumber(args[1])
  if (!order.ok) return order.error
  if (!Number.isFinite(x.value) || !Number.isFinite(order.value)) return ERR('#NUM!')
  const n = Math.trunc(order.value)
  if (n < 0) return ERR('#NUM!')
  const result = kernel(x.value, n)
  if (result === null || !Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

function besselJ0(x: number): number {
  const ax = Math.abs(x)
  if (ax < 8) {
    const y = x * x
    const p = 57568490574
      + y * (-13362590354
        + y * (651619640.7
          + y * (-11214424.18 + y * (77392.33017 + y * -184.9052456))))
    const q = 57568490411
      + y * (1029532985
        + y * (9494680.718 + y * (59272.64853 + y * (267.8532712 + y))))
    return p / q
  }
  const z = 8 / ax
  const y = z * z
  const p1 = 1
    + y * (-0.1098628627e-2
      + y * (0.2734510407e-4
        + y * (-0.2073370639e-5 + y * 0.2093887211e-6)))
  const q1 = -0.1562499995e-1
    + y * (0.1430488765e-3
      + y * (-0.6911147651e-5
        + y * (0.7621095161e-6 + y * -0.934935152e-7)))
  const xx = ax - FRAC_PI_4
  return Math.sqrt(2 / (Math.PI * ax)) * (Math.cos(xx) * p1 - z * Math.sin(xx) * q1)
}

function besselJ1(x: number): number {
  const ax = Math.abs(x)
  if (ax < 8) {
    const y = x * x
    const p = x
      * (72362614232
        + y * (-7895059235
          + y * (242396853.1
            + y * (-2972611.439 + y * (15704.48260 + y * -30.16036606)))))
    const q = 144725228442
      + y * (2300535178
        + y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y))))
    return p / q
  }
  const z = 8 / ax
  const y = z * z
  const p1 = 1
    + y * (0.183105e-2
      + y * (-0.3516396496e-4
        + y * (0.2457520174e-5 + y * -0.240337019e-6)))
  const q1 = 0.04687499995
    + y * (-0.2002690873e-3
      + y * (0.8449199096e-5
        + y * (-0.88228987e-6 + y * 0.105787412e-6)))
  const xx = ax - 3 * FRAC_PI_4
  const result = Math.sqrt(2 / (Math.PI * ax)) * (Math.cos(xx) * p1 - z * Math.sin(xx) * q1)
  return x < 0 ? -result : result
}

function besselJ(x: number, n: number): number | null {
  const ax = Math.abs(x)
  if (n === 0) return besselJ0(x)
  if (n === 1) return besselJ1(x)
  if (ax === 0) return 0
  const sign = x < 0 && n % 2 !== 0 ? -1 : 1

  if (n <= ax) {
    let jm1 = besselJ0(ax)
    let j = besselJ1(ax)
    for (let k = 1; k < n; k += 1) {
      const jp1 = (2 * k / ax) * j - jm1
      jm1 = j
      j = jp1
    }
    return sign * j
  }

  const mStart = Math.max(n + Math.trunc(Math.sqrt(40 * n)), 2 * n + 8)
  let jHigher = 0
  let jHigh = 1
  let valueAtN = 0
  for (let k = mStart; k >= 1; k -= 1) {
    const jLower = (2 * k / ax) * jHigh - jHigher
    jHigher = jHigh
    jHigh = jLower
    if (k - 1 === n) valueAtN = jHigh
    if (Math.abs(jHigh) > 1e10) {
      jHigh *= 1e-10
      jHigher *= 1e-10
      valueAtN *= 1e-10
    }
  }
  if (jHigh === 0) return 0
  return sign * valueAtN * (besselJ0(ax) / jHigh)
}

function besselY0(x: number): number {
  if (x < 8) {
    const y = x * x
    const p = -2957821389
      + y * (7062834065
        + y * (-512359803.6
          + y * (10879881.29 + y * (-86327.92757 + y * 228.4622733))))
    const q = 40076544269
      + y * (745249964.8
        + y * (7189466.438 + y * (47447.26470 + y * (226.1030244 + y))))
    return p / q + 0.636619772 * besselJ0(x) * Math.log(x)
  }
  const z = 8 / x
  const y = z * z
  const p1 = 1
    + y * (-0.1098628627e-2
      + y * (0.2734510407e-4
        + y * (-0.2073370639e-5 + y * 0.2093887211e-6)))
  const q1 = -0.1562499995e-1
    + y * (0.1430488765e-3
      + y * (-0.6911147651e-5
        + y * (0.7621095161e-6 + y * -0.934935152e-7)))
  const xx = x - FRAC_PI_4
  return Math.sqrt(2 / (Math.PI * x)) * (Math.sin(xx) * p1 + z * Math.cos(xx) * q1)
}

function besselY1(x: number): number {
  if (x < 8) {
    const y = x * x
    const p = x
      * (-4.900604943e13
        + y * (1.275274390e13
          + y * (-5.153438139e11
            + y * (7.349264551e9
              + y * (-4.237922726e7 + y * 8.511937935e4)))))
    const q = 2.499580570e14
      + y * (4.244419664e12
        + y * (3.733650367e10
          + y * (2.245904002e8 + y * (1.020426050e6 + y * (3.549632885e3 + y)))))
    return p / q + 0.636619772 * (besselJ1(x) * Math.log(x) - 1 / x)
  }
  const z = 8 / x
  const y = z * z
  const p1 = 1
    + y * (0.183105e-2
      + y * (-0.3516396496e-4
        + y * (0.2457520174e-5 + y * -0.240337019e-6)))
  const q1 = 0.04687499995
    + y * (-0.2002690873e-3
      + y * (0.8449199096e-5
        + y * (-0.88228987e-6 + y * 0.105787412e-6)))
  const xx = x - 3 * FRAC_PI_4
  return Math.sqrt(2 / (Math.PI * x)) * (Math.sin(xx) * p1 + z * Math.cos(xx) * q1)
}

function besselY(x: number, n: number): number | null {
  if (x <= 0) return null
  if (n === 0) return besselY0(x)
  if (n === 1) return besselY1(x)
  let ym1 = besselY0(x)
  let y = besselY1(x)
  for (let k = 1; k < n; k += 1) {
    const yp1 = (2 * k / x) * y - ym1
    ym1 = y
    y = yp1
  }
  return y
}

function besselI0(x: number): number {
  const ax = Math.abs(x)
  if (ax < 3.75) {
    const y = Math.pow(x / 3.75, 2)
    return 1 + y
      * (3.5156229
        + y * (3.0899424
          + y * (1.2067492
            + y * (0.2659732 + y * (0.0360768 + y * 0.0045813)))))
  }
  const y = 3.75 / ax
  return (Math.exp(ax) / Math.sqrt(ax))
    * (0.39894228
      + y * (0.01328592
        + y * (0.00225319
          + y * (-0.00157565
            + y * (0.00916281
              + y * (-0.02057706
                + y * (0.02635537 + y * (-0.01647633 + y * 0.00392377))))))))
}

function besselI1(x: number): number {
  const ax = Math.abs(x)
  let result: number
  if (ax < 3.75) {
    const y = Math.pow(x / 3.75, 2)
    result = ax * (0.5
      + y * (0.87890594
        + y * (0.51498869
          + y * (0.15084934
            + y * (0.02658733 + y * (0.00301532 + y * 0.00032411))))))
  } else {
    const y = 3.75 / ax
    const p = 0.39894228
      + y * (-0.03988024
        + y * (-0.00362018
          + y * (0.00163801
            + y * (-0.01031555
              + y * (0.02282967
                + y * (-0.02895312 + y * (0.01787654 + y * -0.00420059)))))))
    result = (Math.exp(ax) / Math.sqrt(ax)) * p
  }
  return x < 0 ? -result : result
}

function besselI(x: number, n: number): number | null {
  const ax = Math.abs(x)
  if (n === 0) return besselI0(ax)
  if (n === 1) return (x < 0 ? -1 : 1) * besselI1(ax)
  if (ax === 0) return 0
  const sign = x < 0 && n % 2 !== 0 ? -1 : 1
  const mStart = Math.max(n + Math.trunc(Math.sqrt(40 * n)), 2 * n + 8)
  let iHigher = 0
  let iHigh = 1
  let valueAtN = 0
  for (let k = mStart; k >= 1; k -= 1) {
    const iLower = (2 * k / ax) * iHigh + iHigher
    iHigher = iHigh
    iHigh = iLower
    if (k - 1 === n) valueAtN = iHigh
    if (Math.abs(iHigh) > 1e10) {
      iHigh *= 1e-10
      iHigher *= 1e-10
      valueAtN *= 1e-10
    }
  }
  if (iHigh === 0) return 0
  return sign * valueAtN * (besselI0(ax) / iHigh)
}

function besselK0(x: number): number {
  if (x <= 2) {
    const y = x * x / 4
    return -(Math.log(x / 2) * besselI0(x))
      + (-0.57721566
        + y * (0.42278420
          + y * (0.23069756
            + y * (0.03488590
              + y * (0.00262698 + y * (0.00010750 + y * 0.00000740))))))
  }
  const y = 2 / x
  return (Math.exp(-x) / Math.sqrt(x))
    * (1.25331414
      + y * (-0.07832358
        + y * (0.02189568
          + y * (-0.01062446 + y * (0.00587872 + y * (-0.00251540 + y * 0.00053208))))))
}

function besselK1(x: number): number {
  if (x <= 2) {
    const y = x * x / 4
    return Math.log(x / 2) * besselI1(x)
      + (1 / x)
        * (1
          + y * (0.15443144
            + y * (-0.67278579
              + y * (-0.18156897
                + y * (-0.01919402 + y * (-0.00110404 + y * -0.00004686))))))
  }
  const y = 2 / x
  return (Math.exp(-x) / Math.sqrt(x))
    * (1.25331414
      + y * (0.23498619
        + y * (-0.03655620
          + y * (0.01504268 + y * (-0.00780353 + y * (0.00325614 + y * -0.00068245))))))
}

function besselK(x: number, n: number): number | null {
  if (x <= 0) return null
  if (n === 0) return besselK0(x)
  if (n === 1) return besselK1(x)
  let km1 = besselK0(x)
  let kValue = besselK1(x)
  for (let j = 1; j < n; j += 1) {
    const kp1 = (2 * j / x) * kValue + km1
    km1 = kValue
    kValue = kp1
  }
  return kValue
}

export const BESSELJ: FunctionImpl = (args) => evalBessel(args, besselJ)
export const BESSELY: FunctionImpl = (args) => evalBessel(args, besselY)
export const BESSELI: FunctionImpl = (args) => evalBessel(args, besselI)
export const BESSELK: FunctionImpl = (args) => evalBessel(args, besselK)

// ---------------------------------------------------------------------------
// ERF / ERFC
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cody's rational Chebyshev approximation for ERF / ERFC.
//
// Reference: W. J. Cody, "Rational Chebyshev approximations for the error
// function", Math. Comp. 23 (1969) 631-637. Coefficients reproduced from
// Cephes (S. L. Moshier) / SLATEC / Netlib `erf.f` — these are the same
// constants used by glibc's `__erf` / `__erfc`, and give full double-precision
// accuracy (~1 ULP) over the entire representable range.
//
// Split intervals:
//   |x| <  0.46875      : erf via rational(P, Q) in x^2
//   0.46875 <= |x| < 4  : erfc via rational(P1, Q1) in |x|
//   |x| >= 4            : erfc via rational(P2, Q2) in 1/x^2 with exp(-x^2)/x
//   |x| >= ~26.5        : erfc saturates to 0 (exp(-x^2) underflows)
// ---------------------------------------------------------------------------

// Coefficients for |x| < 0.46875 — erf(x) = x * R(x^2)
const ERF_P = [
  3.16112374387056560e+00,
  1.13864154151050156e+02,
  3.77485237685302021e+02,
  3.20937758913846947e+03,
  1.85777706184603153e-01,
]
const ERF_Q = [
  2.36012909523441209e+01,
  2.44024637934444173e+02,
  1.28261652607737228e+03,
  2.84423683343917062e+03,
]

// Coefficients for 0.46875 <= |x| < 4 — erfc(x) = exp(-x^2) * R(|x|)
const ERFC_P1 = [
  5.64188496988670089e-01,
  8.88314979438837594e+00,
  6.61191906371416295e+01,
  2.98635138197400131e+02,
  8.81952221241769090e+02,
  1.71204761263407058e+03,
  2.05107837782607147e+03,
  1.23033935479799725e+03,
  2.15311535474403846e-08,
]
const ERFC_Q1 = [
  1.57449261107098347e+01,
  1.17693950891312499e+02,
  5.37181101862009858e+02,
  1.62138957456669019e+03,
  3.29079923573345963e+03,
  4.36261909014324716e+03,
  3.43936767414372164e+03,
  1.23033935480374942e+03,
]

// Coefficients for |x| >= 4 — erfc(x) = exp(-x^2)/x * (1/sqrt(pi) + R(1/x^2))
const ERFC_P2 = [
  3.05326634961232344e-01,
  3.60344899949804439e-01,
  1.25781726111229246e-01,
  1.60837851487422766e-02,
  6.58749161529837803e-04,
  1.63153871373020978e-02,
]
const ERFC_Q2 = [
  2.56852019228982242e+00,
  1.87295284992346047e+00,
  5.27905102951428413e-01,
  6.05183413124413191e-02,
  2.33520497626869185e-03,
]

const ONE_OVER_SQRT_PI = 0.564189583547756286948 // 1/sqrt(pi)

function erfKernel(absX: number): number {
  // |x| < 0.46875: erf(x) = x * (P0 + P1*y + ... + P4*y^4) / (1 + Q0*y + ... + Q3*y^4)
  // where y = x^2, but we keep the conventional Cody form.
  const y = absX * absX
  let num = ERF_P[4]
  let den = 1
  for (let i = 0; i < 4; i++) {
    num = num * y + ERF_P[i]
    den = den * y + ERF_Q[i]
  }
  return absX * num / den
}

function erfcKernel1(absX: number): number {
  // 0.46875 <= |x| < 4 — note 9 P coefficients, 8 Q coefficients
  let num = ERFC_P1[8]
  let den = 1
  for (let i = 0; i < 8; i++) {
    num = num * absX + ERFC_P1[i]
    den = den * absX + ERFC_Q1[i]
  }
  const r = num / den
  return Math.exp(-absX * absX) * r
}

function erfcKernel2(absX: number): number {
  // |x| >= 4
  const y = 1 / (absX * absX)
  let num = ERFC_P2[5]
  let den = 1
  for (let i = 0; i < 5; i++) {
    num = num * y + ERFC_P2[i]
    den = den * y + ERFC_Q2[i]
  }
  const r = y * num / den
  // erfc(x) = exp(-x^2) / x * (1/sqrt(pi) - y*P/Q)
  return Math.exp(-absX * absX) / absX * (ONE_OVER_SQRT_PI - r)
}

function erfApprox(x: number): number {
  if (x === 0) return 0
  const absX = Math.abs(x)
  let result: number
  if (absX < 0.46875) {
    result = erfKernel(absX)
  } else if (absX < 4) {
    result = 1 - erfcKernel1(absX)
  } else if (absX < 26.5) {
    result = 1 - erfcKernel2(absX)
  } else {
    // erfc(x) underflows; erf(x) saturates to 1
    result = 1
  }
  return x < 0 ? -result : result
}

function erfcApprox(x: number): number {
  if (x === 0) return 1
  const absX = Math.abs(x)
  if (absX < 0.46875) {
    return x < 0 ? 1 + erfKernel(absX) : 1 - erfKernel(absX)
  }
  if (absX < 4) {
    const e = erfcKernel1(absX)
    return x < 0 ? 2 - e : e
  }
  if (absX < 26.5) {
    const e = erfcKernel2(absX)
    return x < 0 ? 2 - e : e
  }
  // For large |x|: erfc(x) → 0 (x>0) or 2 (x<0); exp underflows.
  return x < 0 ? 2 : 0
}

export const ERF: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
  const lower = toNumber(args[0])
  if (!lower.ok) return lower.error
  if (!Number.isFinite(lower.value)) return ERR('#NUM!')
  if (args.length === 1) return NUM(erfApprox(lower.value))
  const upper = toNumber(args[1])
  if (!upper.ok) return upper.error
  if (!Number.isFinite(upper.value)) return ERR('#NUM!')
  return NUM(erfApprox(upper.value) - erfApprox(lower.value))
}

export const ERF_PRECISE: FunctionImpl = ERF

export const ERFC: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 1) return ERR('#VALUE!')
  const x = toNumber(args[0])
  if (!x.ok) return x.error
  if (!Number.isFinite(x.value)) return ERR('#NUM!')
  return NUM(erfcApprox(x.value))
}

export const ERFC_PRECISE: FunctionImpl = ERFC

// ---------------------------------------------------------------------------
// CONVERT
// ---------------------------------------------------------------------------

type ConvertCategory =
  | 'length'
  | 'mass'
  | 'time'
  | 'pressure'
  | 'energy'
  | 'power'
  | 'temperature'

interface ConvertUnit {
  readonly category: ConvertCategory
  readonly factor: number
}

function convertUnitFactor(unit: string): ConvertUnit | null {
  switch (unit) {
    case 'm': return { category: 'length', factor: 1 }
    case 'km': return { category: 'length', factor: 1000 }
    case 'cm': return { category: 'length', factor: 0.01 }
    case 'mm': return { category: 'length', factor: 0.001 }
    case 'in': return { category: 'length', factor: 0.0254 }
    case 'ft': return { category: 'length', factor: 0.3048 }
    case 'yd': return { category: 'length', factor: 0.9144 }
    case 'mi': return { category: 'length', factor: 1609.344 }
    case 'Nmi':
    case 'nmi':
      return { category: 'length', factor: 1852 }

    case 'kg': return { category: 'mass', factor: 1 }
    case 'g': return { category: 'mass', factor: 0.001 }
    case 'mg': return { category: 'mass', factor: 1e-6 }
    case 'lbm': return { category: 'mass', factor: 0.45359237 }
    case 'ozm': return { category: 'mass', factor: 0.028349523125 }
    case 'ton': return { category: 'mass', factor: 907.18474 }

    case 'sec':
    case 's':
      return { category: 'time', factor: 1 }
    case 'mn':
    case 'min':
      return { category: 'time', factor: 60 }
    case 'hr': return { category: 'time', factor: 3600 }
    case 'day':
    case 'd':
      return { category: 'time', factor: 86400 }
    case 'yr': return { category: 'time', factor: 31557600 }

    case 'Pa':
    case 'p':
      return { category: 'pressure', factor: 1 }
    case 'atm':
    case 'at':
      return { category: 'pressure', factor: 101325 }
    case 'mmHg': return { category: 'pressure', factor: 133.322387415 }
    case 'psi': return { category: 'pressure', factor: 6894.757293168 }

    case 'J': return { category: 'energy', factor: 1 }
    case 'e': return { category: 'energy', factor: 1e-7 }
    case 'c':
    case 'cal':
      return { category: 'energy', factor: 4.184 }
    case 'HPh':
    case 'hh':
      return { category: 'energy', factor: 2684519.537696173 }
    case 'kWh':
      return { category: 'energy', factor: 3600000 }
    case 'Wh':
    case 'wh':
      return { category: 'energy', factor: 3600 }
    case 'flb':
      return { category: 'energy', factor: 1.3558179483314004 }
    case 'BTU':
    case 'btu':
      return { category: 'energy', factor: 1055.05585262 }
    case 'eV':
    case 'ev':
      return { category: 'energy', factor: 1.602176634e-19 }

    case 'W':
    case 'w':
      return { category: 'power', factor: 1 }
    case 'HP':
    case 'h':
      return { category: 'power', factor: 745.69987158227022 }
    case 'PS': return { category: 'power', factor: 735.49875 }

    case 'C':
    case 'cel':
      return { category: 'temperature', factor: 0 }
    case 'F':
    case 'fah':
      return { category: 'temperature', factor: 1 }
    case 'K':
    case 'kel':
      return { category: 'temperature', factor: 2 }

    default:
      return null
  }
}

function convertTemperature(value: number, fromTag: number, toTag: number): number {
  const celsius = fromTag === 0
    ? value
    : fromTag === 1
      ? (value - 32) * 5 / 9
      : value - 273.15
  return toTag === 0
    ? celsius
    : toTag === 1
      ? celsius * 9 / 5 + 32
      : celsius + 273.15
}

export const CONVERT: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 3) return ERR('#VALUE!')
  const value = toNumber(args[0])
  if (!value.ok) return value.error
  if (!Number.isFinite(value.value)) return ERR('#NUM!')
  const fromText = toString(args[1])
  if (!fromText.ok) return fromText.error
  const toText = toString(args[2])
  if (!toText.ok) return toText.error
  const fromUnit = convertUnitFactor(fromText.value)
  const toUnit = convertUnitFactor(toText.value)
  if (fromUnit === null || toUnit === null || fromUnit.category !== toUnit.category) {
    return ERR('#N/A')
  }
  const result = fromUnit.category === 'temperature'
    ? convertTemperature(value.value, fromUnit.factor, toUnit.factor)
    : value.value * fromUnit.factor / toUnit.factor
  if (!Number.isFinite(result)) return ERR('#NUM!')
  return NUM(result)
}

// ---------------------------------------------------------------------------
// Complex numbers
// ---------------------------------------------------------------------------

type ComplexSuffix = 'i' | 'j'

interface ComplexValue {
  readonly real: number
  readonly imag: number
  readonly suffix: ComplexSuffix
}

type ComplexResult =
  | { readonly ok: true; readonly value: ComplexValue }
  | { readonly ok: false; readonly error: Value }

const COMPLEX_DECIMAL_RE = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/

function parseComplexNumber(s: string): number | null {
  if (!COMPLEX_DECIMAL_RE.test(s)) return null
  return Number(s)
}

function parseComplex(text: string): ComplexResult {
  const s = text.trim()
  if (s.length === 0) return { ok: false, error: ERR('#VALUE!') }

  const last = s[s.length - 1]
  const hasSuffix = last === 'i' || last === 'j'
  const suffix: ComplexSuffix = last === 'j' ? 'j' : 'i'
  const body = hasSuffix ? s.slice(0, -1) : s

  if (!hasSuffix) {
    const real = parseComplexNumber(body)
    if (real === null) return { ok: false, error: ERR('#VALUE!') }
    return { ok: true, value: { real, imag: 0, suffix: 'i' } }
  }

  let split = -1
  for (let i = 1; i < body.length; i += 1) {
    const ch = body[i]
    if (ch !== '+' && ch !== '-') continue
    const prev = body[i - 1]
    if (prev === 'e' || prev === 'E') continue
    split = i
  }

  if (split >= 0) {
    const realStr = body.slice(0, split)
    const imagStr = body.slice(split)
    const real = parseComplexNumber(realStr)
    if (real === null) return { ok: false, error: ERR('#VALUE!') }
    const imag = imagStr === '+' || imagStr === ''
      ? 1
      : imagStr === '-'
        ? -1
        : parseComplexNumber(imagStr)
    if (imag === null) return { ok: false, error: ERR('#VALUE!') }
    return { ok: true, value: { real, imag, suffix } }
  }

  const imag = body.length === 0 || body === '+'
    ? 1
    : body === '-'
      ? -1
      : parseComplexNumber(body)
  if (imag === null) return { ok: false, error: ERR('#VALUE!') }
  return { ok: true, value: { real: 0, imag, suffix } }
}

function coerceToComplex(v: Value): ComplexResult {
  switch (v.kind) {
    case 'error':
      return { ok: false, error: v }
    case 'string':
      return parseComplex(v.value)
    case 'number':
      return { ok: true, value: { real: v.value, imag: 0, suffix: 'i' } }
    case 'boolean':
      return { ok: true, value: { real: v.value ? 1 : 0, imag: 0, suffix: 'i' } }
    case 'blank':
      return { ok: true, value: { real: 0, imag: 0, suffix: 'i' } }
    case 'array':
      return { ok: false, error: ERR('#VALUE!') }
  }
}

function explicitComplexSuffix(v: Value): ComplexSuffix | undefined {
  if (v.kind !== 'string') return undefined
  const text = v.value.trim()
  const last = text[text.length - 1]
  return last === 'i' || last === 'j' ? last : undefined
}

function resultSuffix(args: ReadonlyArray<Value>, fallback: ComplexSuffix): ComplexSuffix {
  // Excel rule: if ANY input carries a 'j' suffix, the output uses 'j'; otherwise 'i'.
  for (const arg of args) {
    if (explicitComplexSuffix(arg) === 'j') return 'j'
  }
  for (const arg of args) {
    if (explicitComplexSuffix(arg) === 'i') return 'i'
  }
  return fallback
}

function formatFiniteForComplex(n: number): string {
  const value = Object.is(n, -0) ? 0 : n
  if (value === Math.trunc(value) && Math.abs(value) < 1e16) {
    return String(Math.trunc(value))
  }
  return String(value)
}

function formatComplex(real: number, imag: number, suffix: ComplexSuffix): string {
  const r = Object.is(real, -0) ? 0 : real
  const i = Object.is(imag, -0) ? 0 : imag
  if (i === 0) return formatFiniteForComplex(r)
  if (r === 0) {
    if (i === 1) return suffix
    if (i === -1) return `-${suffix}`
    return `${formatFiniteForComplex(i)}${suffix}`
  }
  if (i > 0) {
    const imagPart = i === 1 ? '' : formatFiniteForComplex(i)
    return `${formatFiniteForComplex(r)}+${imagPart}${suffix}`
  }
  const absImag = -i
  const imagPart = absImag === 1 ? '' : formatFiniteForComplex(absImag)
  return `${formatFiniteForComplex(r)}-${imagPart}${suffix}`
}

function complexText(real: number, imag: number, suffix: ComplexSuffix): Value {
  if (!Number.isFinite(real) || !Number.isFinite(imag)) return ERR('#NUM!')
  return { kind: 'string', value: formatComplex(real, imag, suffix) }
}

function complexUnaryNumber(
  args: ReadonlyArray<Value>,
  f: (real: number, imag: number) => number,
): Value {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 1) return ERR('#VALUE!')
  const z = coerceToComplex(args[0])
  if (!z.ok) return z.error
  const out = f(z.value.real, z.value.imag)
  if (!Number.isFinite(out)) return ERR('#NUM!')
  return NUM(out)
}

function complexUnaryText(
  args: ReadonlyArray<Value>,
  f: (real: number, imag: number, suffix: ComplexSuffix) => ComplexValue,
): Value {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 1) return ERR('#VALUE!')
  const z = coerceToComplex(args[0])
  if (!z.ok) return z.error
  const out = f(z.value.real, z.value.imag, z.value.suffix)
  return complexText(out.real, out.imag, out.suffix)
}

function complexMul(a: number, b: number, c: number, d: number): [number, number] {
  return [a * c - b * d, a * d + b * c]
}

function complexDiv(a: number, b: number, c: number, d: number): [number, number] | null {
  const denom = c * c + d * d
  if (denom === 0) return null
  return [(a * c + b * d) / denom, (b * c - a * d) / denom]
}

export const COMPLEX: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length < 2 || args.length > 3) return ERR('#VALUE!')
  const real = toNumber(args[0])
  if (!real.ok) return real.error
  const imag = toNumber(args[1])
  if (!imag.ok) return imag.error
  let suffix: ComplexSuffix = 'i'
  if (args.length === 3) {
    const suffixArg = args[2]
    if (suffixArg.kind !== 'string' || (suffixArg.value !== 'i' && suffixArg.value !== 'j')) {
      return ERR('#VALUE!')
    }
    suffix = suffixArg.value
  }
  return complexText(real.value, imag.value, suffix)
}

export const IMABS: FunctionImpl = (args) =>
  complexUnaryNumber(args, (a, b) => Math.sqrt(a * a + b * b))

export const IMAGINARY: FunctionImpl = (args) => complexUnaryNumber(args, (_a, b) => b)

export const IMREAL: FunctionImpl = (args) => complexUnaryNumber(args, (a) => a)

export const IMARGUMENT: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 1) return ERR('#VALUE!')
  const z = coerceToComplex(args[0])
  if (!z.ok) return z.error
  if (z.value.real === 0 && z.value.imag === 0) return ERR('#DIV/0!')
  const out = Math.atan2(z.value.imag, z.value.real)
  if (!Number.isFinite(out)) return ERR('#NUM!')
  return NUM(out)
}

export const IMCONJUGATE: FunctionImpl = (args) =>
  complexUnaryText(args, (a, b, suffix) => ({ real: a, imag: -b, suffix }))

export const IMSUM: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length === 0) return ERR('#VALUE!')
  const first = coerceToComplex(args[0])
  if (!first.ok) return first.error
  let real = first.value.real
  let imag = first.value.imag
  const suffix = resultSuffix(args, first.value.suffix)
  for (let i = 1; i < args.length; i += 1) {
    const z = coerceToComplex(args[i])
    if (!z.ok) return z.error
    real += z.value.real
    imag += z.value.imag
  }
  return complexText(real, imag, suffix)
}

export const IMSUB: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 2) return ERR('#VALUE!')
  const a = coerceToComplex(args[0])
  if (!a.ok) return a.error
  const b = coerceToComplex(args[1])
  if (!b.ok) return b.error
  return complexText(
    a.value.real - b.value.real,
    a.value.imag - b.value.imag,
    a.value.suffix,
  )
}

export const IMPRODUCT: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length === 0) return ERR('#VALUE!')
  const first = coerceToComplex(args[0])
  if (!first.ok) return first.error
  let real = first.value.real
  let imag = first.value.imag
  const suffix = resultSuffix(args, first.value.suffix)
  for (let i = 1; i < args.length; i += 1) {
    const z = coerceToComplex(args[i])
    if (!z.ok) return z.error
    const [nextReal, nextImag] = complexMul(real, imag, z.value.real, z.value.imag)
    real = nextReal
    imag = nextImag
  }
  return complexText(real, imag, suffix)
}

export const IMDIV: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 2) return ERR('#VALUE!')
  const a = coerceToComplex(args[0])
  if (!a.ok) return a.error
  const b = coerceToComplex(args[1])
  if (!b.ok) return b.error
  const out = complexDiv(a.value.real, a.value.imag, b.value.real, b.value.imag)
  if (out === null) return ERR('#DIV/0!')
  return complexText(out[0], out[1], a.value.suffix)
}

export const IMEXP: FunctionImpl = (args) =>
  complexUnaryText(args, (a, b, suffix) => {
    const mag = Math.exp(a)
    return { real: mag * Math.cos(b), imag: mag * Math.sin(b), suffix }
  })

function complexLog(args: ReadonlyArray<Value>, denominator: number): Value {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 1) return ERR('#VALUE!')
  const z = coerceToComplex(args[0])
  if (!z.ok) return z.error
  if (z.value.real === 0 && z.value.imag === 0) return ERR('#NUM!')
  const modulus = Math.sqrt(z.value.real * z.value.real + z.value.imag * z.value.imag)
  const real = Math.log(modulus) / denominator
  const imag = Math.atan2(z.value.imag, z.value.real) / denominator
  return complexText(real, imag, z.value.suffix)
}

export const IMLN: FunctionImpl = (args) => complexLog(args, 1)
export const IMLOG10: FunctionImpl = (args) => complexLog(args, Math.log(10))
export const IMLOG2: FunctionImpl = (args) => complexLog(args, Math.log(2))

export const IMSQRT: FunctionImpl = (args) =>
  complexUnaryText(args, (a, b, suffix) => {
    const radius = Math.sqrt(a * a + b * b)
    const argHalf = Math.atan2(b, a) / 2
    const mag = Math.sqrt(radius)
    return { real: mag * Math.cos(argHalf), imag: mag * Math.sin(argHalf), suffix }
  })

export const IMPOWER: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 2) return ERR('#VALUE!')
  const z = coerceToComplex(args[0])
  if (!z.ok) return z.error
  const power = toNumber(args[1])
  if (!power.ok) return power.error
  if (z.value.real === 0 && z.value.imag === 0) {
    if (power.value === 0) return complexText(1, 0, z.value.suffix)
    if (power.value < 0) return ERR('#NUM!')
    return complexText(0, 0, z.value.suffix)
  }
  const radius = Math.sqrt(z.value.real * z.value.real + z.value.imag * z.value.imag)
  const arg = Math.atan2(z.value.imag, z.value.real)
  const mag = Math.pow(radius, power.value)
  const theta = arg * power.value
  return complexText(mag * Math.cos(theta), mag * Math.sin(theta), z.value.suffix)
}

export const IMCOS: FunctionImpl = (args) =>
  complexUnaryText(args, (a, b, suffix) => ({
    real: Math.cos(a) * Math.cosh(b),
    imag: -Math.sin(a) * Math.sinh(b),
    suffix,
  }))

export const IMCOSH: FunctionImpl = (args) =>
  complexUnaryText(args, (a, b, suffix) => ({
    real: Math.cosh(a) * Math.cos(b),
    imag: Math.sinh(a) * Math.sin(b),
    suffix,
  }))

export const IMSIN: FunctionImpl = (args) =>
  complexUnaryText(args, (a, b, suffix) => ({
    real: Math.sin(a) * Math.cosh(b),
    imag: Math.cos(a) * Math.sinh(b),
    suffix,
  }))

export const IMSINH: FunctionImpl = (args) =>
  complexUnaryText(args, (a, b, suffix) => ({
    real: Math.sinh(a) * Math.cos(b),
    imag: Math.cosh(a) * Math.sin(b),
    suffix,
  }))

export const IMTAN: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 1) return ERR('#VALUE!')
  const z = coerceToComplex(args[0])
  if (!z.ok) return z.error
  const sinReal = Math.sin(z.value.real) * Math.cosh(z.value.imag)
  const sinImag = Math.cos(z.value.real) * Math.sinh(z.value.imag)
  const cosReal = Math.cos(z.value.real) * Math.cosh(z.value.imag)
  const cosImag = -Math.sin(z.value.real) * Math.sinh(z.value.imag)
  const out = complexDiv(sinReal, sinImag, cosReal, cosImag)
  if (out === null) return ERR('#NUM!')
  return complexText(out[0], out[1], z.value.suffix)
}

export const IMSEC: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 1) return ERR('#VALUE!')
  const z = coerceToComplex(args[0])
  if (!z.ok) return z.error
  const cosReal = Math.cos(z.value.real) * Math.cosh(z.value.imag)
  const cosImag = -Math.sin(z.value.real) * Math.sinh(z.value.imag)
  const out = complexDiv(1, 0, cosReal, cosImag)
  if (out === null) return ERR('#NUM!')
  return complexText(out[0], out[1], z.value.suffix)
}

export const IMCSC: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 1) return ERR('#VALUE!')
  const z = coerceToComplex(args[0])
  if (!z.ok) return z.error
  const sinReal = Math.sin(z.value.real) * Math.cosh(z.value.imag)
  const sinImag = Math.cos(z.value.real) * Math.sinh(z.value.imag)
  const out = complexDiv(1, 0, sinReal, sinImag)
  if (out === null) return ERR('#NUM!')
  return complexText(out[0], out[1], z.value.suffix)
}

export const IMCOT: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 1) return ERR('#VALUE!')
  const z = coerceToComplex(args[0])
  if (!z.ok) return z.error
  const cosReal = Math.cos(z.value.real) * Math.cosh(z.value.imag)
  const cosImag = -Math.sin(z.value.real) * Math.sinh(z.value.imag)
  const sinReal = Math.sin(z.value.real) * Math.cosh(z.value.imag)
  const sinImag = Math.cos(z.value.real) * Math.sinh(z.value.imag)
  const out = complexDiv(cosReal, cosImag, sinReal, sinImag)
  if (out === null) return ERR('#NUM!')
  return complexText(out[0], out[1], z.value.suffix)
}

export const IMSECH: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 1) return ERR('#VALUE!')
  const z = coerceToComplex(args[0])
  if (!z.ok) return z.error
  const coshReal = Math.cosh(z.value.real) * Math.cos(z.value.imag)
  const coshImag = Math.sinh(z.value.real) * Math.sin(z.value.imag)
  const out = complexDiv(1, 0, coshReal, coshImag)
  if (out === null) return ERR('#NUM!')
  return complexText(out[0], out[1], z.value.suffix)
}

export const IMCSCH: FunctionImpl = (args) => {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 1) return ERR('#VALUE!')
  const z = coerceToComplex(args[0])
  if (!z.ok) return z.error
  const sinhReal = Math.sinh(z.value.real) * Math.cos(z.value.imag)
  const sinhImag = Math.cosh(z.value.real) * Math.sin(z.value.imag)
  const out = complexDiv(1, 0, sinhReal, sinhImag)
  if (out === null) return ERR('#NUM!')
  return complexText(out[0], out[1], z.value.suffix)
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const FUNCTIONS: Record<string, FunctionImpl> = {
  DEC2BIN,
  DEC2OCT,
  DEC2HEX,
  BIN2DEC,
  OCT2DEC,
  HEX2DEC,
  BIN2HEX,
  BIN2OCT,
  HEX2BIN,
  HEX2OCT,
  OCT2BIN,
  OCT2HEX,
  BITAND,
  BITOR,
  BITXOR,
  BITLSHIFT,
  BITRSHIFT,
  DELTA,
  GESTEP,
  BESSELI,
  BESSELJ,
  BESSELK,
  BESSELY,
  ERF,
  'ERF.PRECISE': ERF_PRECISE,
  ERFC,
  'ERFC.PRECISE': ERFC_PRECISE,
  CONVERT,
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
}
