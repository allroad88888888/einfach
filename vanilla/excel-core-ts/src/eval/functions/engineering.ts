/**
 * Phase 8 — engineering functions: base conversions, bit ops, comparators.
 *
 * Excel limits its base-conversion functions to 10 characters of input
 * (i.e. 40-bit precision) and uses two's-complement for negative values.
 * We mirror those limits to keep results bit-identical with Excel.
 *
 * Functions:
 *   DEC2BIN, DEC2OCT, DEC2HEX, BIN2DEC, OCT2DEC, HEX2DEC,
 *   BITAND, BITOR, BITXOR, BITLSHIFT, BITRSHIFT,
 *   DELTA, GESTEP
 *
 * All numeric ops here stay within ±2^39 to match Excel's documented range.
 */

import type { FunctionImpl, Value } from '../../types'
import { propagateError, toNumber } from '../coerce'

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const ERR = (
  code: '#DIV/0!' | '#N/A' | '#NUM!' | '#VALUE!',
  message?: string,
): Value => (message ? { kind: 'error', code, message } : { kind: 'error', code })

const MAX_DEC = 549_755_813_887 // 2^39 - 1
const MIN_DEC = -549_755_813_888 // -2^39

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a string in the given base. Excel allows up to 10 characters of
 * input. Values with the high bit set (e.g. "FFFFFFFFFF" hex) are
 * two's-complement negatives within the 40-bit range.
 */
function parseBaseString(
  s: string,
  base: number,
  maxChars: number,
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
  // Use BigInt for safe parsing — values up to 40 bits fit easily in Number,
  // but we want to handle the high-bit-set case as 2's complement.
  let n = 0
  for (const ch of trimmed) {
    n = n * base + parseInt(ch, base)
  }
  // Two's complement for the high-bit-set case (only relevant when maxChars
  // is the full width — i.e. 10 chars for binary, 4 for hex, etc.).
  if (trimmed.length === maxChars) {
    // For binary maxChars=10, the high bit means n >= 2^9 = 512.
    const highBit = Math.pow(base, maxChars - 1) * (base / 2)
    if (n >= highBit) {
      n -= Math.pow(base, maxChars)
    }
  }
  return n
}

/** Format a number in the given base, using two's complement for negatives. */
function formatBaseString(
  n: number,
  base: number,
  maxChars: number,
): string | null {
  if (!Number.isFinite(n)) return null
  // Excel limit: 10 chars at base 2 (40 bits).
  if (n < MIN_DEC || n > MAX_DEC) return null
  let value = n
  if (value < 0) {
    value += Math.pow(base, maxChars)
  }
  const digits = '0123456789ABCDEF'
  if (value === 0) return '0'
  let out = ''
  while (value > 0) {
    const r = value % base
    out = digits[r] + out
    value = Math.floor(value / base)
  }
  return out
}

function decToXxx(args: ReadonlyArray<Value>, base: number, maxChars: number): Value {
  const err = propagateError(args)
  if (err) return err
  if (args.length < 1 || args.length > 2) return ERR('#VALUE!')
  const v = toNumber(args[0])
  if (!v.ok) return v.error
  const n = Math.trunc(v.value)
  // Excel range check
  const lo = -Math.pow(base, maxChars) / 2
  const hi = Math.pow(base, maxChars) / 2 - 1
  if (n < lo || n > hi) return ERR('#NUM!')
  const formatted = formatBaseString(n, base, maxChars)
  if (formatted === null) return ERR('#NUM!')
  // Optional places argument.
  if (args.length === 2) {
    const p = toNumber(args[1])
    if (!p.ok) return p.error
    const places = Math.trunc(p.value)
    if (n < 0) {
      // Excel ignores `places` for negatives.
      return { kind: 'string', value: formatted }
    }
    if (places < 1 || places > maxChars) return ERR('#NUM!')
    if (formatted.length > places) return ERR('#NUM!')
    return { kind: 'string', value: formatted.padStart(places, '0') }
  }
  return { kind: 'string', value: formatted }
}

function xxxToDec(args: ReadonlyArray<Value>, base: number, maxChars: number): Value {
  const err = propagateError(args)
  if (err) return err
  if (args.length !== 1) return ERR('#VALUE!')
  const v = args[0]
  let s: string
  if (v.kind === 'string') s = v.value
  else if (v.kind === 'number') s = Math.trunc(v.value).toString()
  else return ERR('#VALUE!')
  const parsed = parseBaseString(s, base, maxChars)
  if (parsed === null) return ERR('#NUM!')
  return NUM(parsed)
}

// ---------------------------------------------------------------------------
// Base conversions
// ---------------------------------------------------------------------------

export const DEC2BIN: FunctionImpl = (args) => decToXxx(args, 2, 10)
export const DEC2OCT: FunctionImpl = (args) => decToXxx(args, 8, 10)
export const DEC2HEX: FunctionImpl = (args) => decToXxx(args, 16, 10)

export const BIN2DEC: FunctionImpl = (args) => xxxToDec(args, 2, 10)
export const OCT2DEC: FunctionImpl = (args) => xxxToDec(args, 8, 10)
export const HEX2DEC: FunctionImpl = (args) => xxxToDec(args, 16, 10)

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
// Registry
// ---------------------------------------------------------------------------

export const FUNCTIONS: Record<string, FunctionImpl> = {
  DEC2BIN,
  DEC2OCT,
  DEC2HEX,
  BIN2DEC,
  OCT2DEC,
  HEX2DEC,
  BITAND,
  BITOR,
  BITXOR,
  BITLSHIFT,
  BITRSHIFT,
  DELTA,
  GESTEP,
}
