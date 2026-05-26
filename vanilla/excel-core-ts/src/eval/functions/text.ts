/**
 * Wave C / C4 — Text functions.
 *
 * Functions: CONCATENATE, CONCAT, LEFT, RIGHT, MID, LEN, LOWER, UPPER, TRIM,
 *            TEXT, VALUE
 *
 * Discipline:
 *  - Pure: do not mutate `args`, `ctx`, or any captured state.
 *  - Total: every input returns a `Value`. Never throws.
 *  - Error short-circuit via `propagateError` (Excel "first-error-wins").
 *
 * Unicode discipline (LEFT/RIGHT/MID/LEN):
 *  - `String.prototype.length` counts UTF-16 *code units*, which mangles
 *    code-point counts for non-BMP characters (emoji, supplementary planes
 *    where each glyph = 2 code units = 1 codepoint).
 *  - Excel itself counts UTF-16 code units historically — but einfach-ts
 *    elects user-correct semantics: split via `Array.from(text)` so emoji
 *    count as 1 character. Tests pin this behavior.
 */

import { propagateError, toNumber, toString as valueToString } from '../coerce'
import type { FunctionImpl, Value } from '../../types'

// =============================================================================
// Helpers
// =============================================================================

const ERR_VALUE: Value = { kind: 'error', code: '#VALUE!' }

/** Convenience: build an error Value with code + optional message. */
function errValue(code: '#VALUE!' | '#NAME?' | '#NUM!' | '#N/A', message?: string): Value {
  return message ? { kind: 'error', code, message } : { kind: 'error', code }
}

/**
 * Code-point split (Unicode-safe). For LEFT/RIGHT/MID/LEN the contract is
 * "1 user-visible character" — not "1 UTF-16 code unit". `Array.from`
 * iterates by code points (because `String.prototype[Symbol.iterator]`
 * yields code points), so a 4-byte emoji counts as 1.
 *
 * NB: this is not full Unicode grapheme-cluster segmentation — a flag emoji
 * (regional-indicator pair) still counts as 2. Grapheme clusters would need
 * `Intl.Segmenter`, which we defer until a real complaint shows up.
 */
function codepoints(s: string): string[] {
  return Array.from(s)
}

/**
 * Coerce a Value to a string for text-function input. Booleans become
 * "TRUE"/"FALSE", numbers stringify, blank → "". Errors propagate.
 *
 * This is `coerce.toString` reused — kept as a helper here to make the
 * call sites self-documenting (the text-fn input contract is exactly
 * the same as `valueToString`).
 */
function coerceText(v: Value): { ok: true; value: string } | { ok: false; error: Value } {
  const r = valueToString(v)
  if (r.ok) return { ok: true, value: r.value }
  return { ok: false, error: r.error }
}

/**
 * Flatten array `Value` recursively into a stream of scalar `Value`s. Used
 * by CONCAT (which, unlike CONCATENATE, takes array args and joins their
 * elements in row-major order).
 */
function* flattenForConcat(v: Value): Generator<Value> {
  if (v.kind === 'array') {
    for (const row of v.value) {
      for (const cell of row) {
        yield* flattenForConcat(cell)
      }
    }
    return
  }
  yield v
}

// =============================================================================
// CONCATENATE / CONCAT
// =============================================================================

/**
 * CONCATENATE(text1, text2, ...) — concatenate string representations of
 * every arg in order. At least one argument required. Errors propagate
 * (first error wins). Arrays are coerced top-left scalar (Excel behavior
 * for the *legacy* function).
 */
const CONCATENATE: FunctionImpl = (args) => {
  if (args.length === 0) return errValue('#VALUE!', 'CONCATENATE requires at least one argument')
  const err = propagateError(args)
  if (err) return err
  let out = ''
  for (const a of args) {
    const r = coerceText(a)
    if (!r.ok) return r.error
    out += r.value
  }
  return { kind: 'string', value: out }
}

/**
 * CONCAT(text1, text2, ...) — like CONCATENATE but **flattens arrays**.
 * `CONCAT(A1:A3)` glues the three cells in row-major order. Post-2019
 * Excel addition.
 */
const CONCAT: FunctionImpl = (args) => {
  if (args.length === 0) return errValue('#VALUE!', 'CONCAT requires at least one argument')
  const err = propagateError(args)
  if (err) return err
  let out = ''
  for (const a of args) {
    for (const scalar of flattenForConcat(a)) {
      if (scalar.kind === 'error') return scalar
      const r = coerceText(scalar)
      if (!r.ok) return r.error
      out += r.value
    }
  }
  return { kind: 'string', value: out }
}

// =============================================================================
// LEFT / RIGHT / MID
// =============================================================================

/**
 * LEFT(text, [num_chars=1]) — first N code points. `num_chars > length`
 * yields the whole string. `num_chars < 0` → `#VALUE!`. Fractional
 * num_chars is truncated toward zero (Excel semantics).
 */
const LEFT: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2)
    return errValue('#VALUE!', 'LEFT takes 1 or 2 arguments')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  let n = 1
  if (args.length === 2) {
    const nr = toNumber(args[1])
    if (!nr.ok) return nr.error
    n = Math.trunc(nr.value)
    if (n < 0) return ERR_VALUE
  }
  const chars = codepoints(ts.value)
  return { kind: 'string', value: chars.slice(0, n).join('') }
}

/**
 * RIGHT(text, [num_chars=1]) — last N code points. Same edge rules as LEFT.
 */
const RIGHT: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2)
    return errValue('#VALUE!', 'RIGHT takes 1 or 2 arguments')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  let n = 1
  if (args.length === 2) {
    const nr = toNumber(args[1])
    if (!nr.ok) return nr.error
    n = Math.trunc(nr.value)
    if (n < 0) return ERR_VALUE
  }
  const chars = codepoints(ts.value)
  if (n === 0) return { kind: 'string', value: '' }
  return { kind: 'string', value: chars.slice(chars.length - n).join('') }
}

/**
 * MID(text, start, num_chars) — substring with 1-based `start`.
 *  - `start < 1`                  → `#VALUE!`
 *  - `num_chars < 0`              → `#VALUE!`
 *  - `start > length`             → "" (empty string, not error — Excel)
 *  - `start + num_chars > length` → truncated to end
 */
const MID: FunctionImpl = (args) => {
  if (args.length !== 3) return errValue('#VALUE!', 'MID takes exactly 3 arguments')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  const sr = toNumber(args[1])
  if (!sr.ok) return sr.error
  const nr = toNumber(args[2])
  if (!nr.ok) return nr.error
  const start = Math.trunc(sr.value)
  const num = Math.trunc(nr.value)
  if (start < 1) return ERR_VALUE
  if (num < 0) return ERR_VALUE
  const chars = codepoints(ts.value)
  if (start > chars.length) return { kind: 'string', value: '' }
  // Convert 1-based start to 0-based slice index.
  return { kind: 'string', value: chars.slice(start - 1, start - 1 + num).join('') }
}

// =============================================================================
// LEN / LOWER / UPPER / TRIM
// =============================================================================

/**
 * LEN(text) — code-point count. See module header for the
 * `Array.from(text).length` vs `text.length` choice.
 */
const LEN: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'LEN takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  return { kind: 'number', value: codepoints(ts.value).length }
}

/** LOWER(text) — locale-independent lowercasing. */
const LOWER: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'LOWER takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  return { kind: 'string', value: ts.value.toLowerCase() }
}

/** UPPER(text) — locale-independent uppercasing. */
const UPPER: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'UPPER takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  return { kind: 'string', value: ts.value.toUpperCase() }
}

/**
 * TRIM(text) — Excel's TRIM, NOT JS `.trim()`:
 *  1. Strip leading whitespace.
 *  2. Strip trailing whitespace.
 *  3. Collapse interior runs of whitespace to a single space.
 *
 * Excel specifically trims ASCII spaces (U+0020) — non-breaking space
 * (U+00A0) is *not* trimmed by classic Excel TRIM. We mirror that strict
 * behavior: only ASCII whitespace gets normalized.
 */
const TRIM: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'TRIM takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  // Match runs of one-or-more ASCII spaces; trim leading/trailing, collapse interior.
  // /\s+/g would also strip non-breaking spaces — we restrict to ASCII whitespace
  // explicitly to mirror Excel.
  const collapsed = ts.value.replace(/[ \t\n\r\f\v]+/g, ' ').replace(/^ +| +$/g, '')
  return { kind: 'string', value: collapsed }
}

// =============================================================================
// TEXT
// =============================================================================

/**
 * Supported format codes (v1 scope, per C4 task):
 *   "0"         integer with no thousands separator
 *   "0.00"      fixed 2 decimals
 *   "#,##0"     integer with thousands separator
 *   "#,##0.00"  thousands + 2 decimals
 *   "0%"        integer percent (multiplies by 100, appends %)
 *   "0.00%"     2-decimal percent
 *   "$#,##0.00" USD currency
 *
 * Out of scope (returns raw String(n) with no formatting — TODO):
 *   - Negative suffix `"#,##0;(#,##0)"` — semicolon-separated sections.
 *   - Date/time format codes (`"yyyy-mm-dd"`, etc.) — Wave C/C5 owns dates.
 *   - Arbitrary `#`/`0` patterns beyond the canonical seven above.
 *   - Scientific (`0.00E+00`) / fraction (`# ?/?`) formats.
 */
function formatTextNumber(n: number, format: string): string {
  // Strip negative-section if present (out of scope per task brief).
  // TODO(C4): support `"#,##0;(#,##0)"` negative suffix.
  const positiveOnly = format.includes(';') ? format.split(';')[0] : format

  switch (positiveOnly) {
    case '0':
      return Math.round(n).toString()
    case '0.00':
      return n.toFixed(2)
    case '#,##0':
      return formatThousands(Math.round(n), 0)
    case '#,##0.00':
      return formatThousands(n, 2)
    case '0%':
      return `${Math.round(n * 100)}%`
    case '0.00%':
      return `${(n * 100).toFixed(2)}%`
    case '$#,##0.00':
      return `$${formatThousands(n, 2)}`
    default:
      // TODO(C4): broader format-string parser (date codes, repeated #,
      // mixed text segments, escapes). For now, fall back to a raw repr
      // so callers see *something* useful instead of an error.
      return String(n)
  }
}

/** Format a number with thousands separators and a fixed decimal count. */
function formatThousands(n: number, decimals: number): string {
  const negative = n < 0
  const abs = Math.abs(n)
  // Round to the requested number of decimals first so we don't carry
  // float noise into the integer portion.
  const rounded = decimals > 0
    ? abs.toFixed(decimals)
    : Math.round(abs).toString()
  const [intPart, decPart] = rounded.split('.')
  // Insert commas every 3 digits from the right.
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = decPart !== undefined ? `${withCommas}.${decPart}` : withCommas
  return negative ? `-${body}` : body
}

/**
 * TEXT(value, format_code) — format a number per Excel format string.
 * Non-numeric `value` stringifies as-is (passthrough) — matches Excel's
 * behavior of "if it's already text, format codes are ignored".
 */
const TEXT: FunctionImpl = (args) => {
  if (args.length !== 2) return errValue('#VALUE!', 'TEXT takes exactly 2 arguments')
  const err = propagateError(args)
  if (err) return err
  const fmtR = coerceText(args[1])
  if (!fmtR.ok) return fmtR.error
  const fmt = fmtR.value
  const v = args[0]
  // If it's already text, return it as-is — Excel's documented "TEXT
  // returns the value unchanged when it's already text" rule.
  if (v.kind === 'string') return v
  if (v.kind === 'blank') return { kind: 'string', value: '' }
  if (v.kind === 'boolean') return { kind: 'string', value: v.value ? 'TRUE' : 'FALSE' }
  // For arrays, format the top-left scalar (Wave E will broadcast).
  if (v.kind === 'array') {
    const row = v.value[0]
    if (!row || row.length === 0) return ERR_VALUE
    const inner = row[0]
    if (inner.kind === 'error') return inner
    if (inner.kind === 'string') return inner
    if (inner.kind === 'blank') return { kind: 'string', value: '' }
    if (inner.kind === 'boolean') return { kind: 'string', value: inner.value ? 'TRUE' : 'FALSE' }
    if (inner.kind === 'number') return { kind: 'string', value: formatTextNumber(inner.value, fmt) }
    return ERR_VALUE
  }
  if (v.kind !== 'number') return ERR_VALUE
  return { kind: 'string', value: formatTextNumber(v.value, fmt) }
}

// =============================================================================
// VALUE
// =============================================================================

/**
 * VALUE(text) — parse a string as a number.
 *
 * Excel accepts:
 *   - Leading currency `$`            ("$1,234.5" → 1234.5)
 *   - Thousands separator `,`         ("1,234"    → 1234)
 *   - Trailing percent `%`            ("50%"      → 0.5)
 *   - Leading sign `+` / `-`          ("-1,000"   → -1000)
 *   - Surrounding whitespace          (" 42 "     → 42)
 *
 * Anything that doesn't fit the (sign? currency? digits[.digits]? percent?)
 * shape → `#VALUE!`. Booleans coerce (TRUE → 1, FALSE → 0). Numbers pass
 * through.
 */
const VALUE: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'VALUE takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const v = args[0]
  switch (v.kind) {
    case 'number':
      return v
    case 'boolean':
      return { kind: 'number', value: v.value ? 1 : 0 }
    case 'blank':
      return { kind: 'number', value: 0 }
    case 'array': {
      const row = v.value[0]
      if (!row || row.length === 0) return ERR_VALUE
      // Top-left scalar — same logic, inline to avoid bogus ctx.
      const inner = row[0]
      if (inner.kind === 'string') return parseValueString(inner.value)
      if (inner.kind === 'number') return inner
      if (inner.kind === 'boolean') return { kind: 'number', value: inner.value ? 1 : 0 }
      if (inner.kind === 'blank') return { kind: 'number', value: 0 }
      if (inner.kind === 'error') return inner
      return ERR_VALUE
    }
    case 'error':
      return v
    case 'string':
      return parseValueString(v.value)
  }
}

/**
 * Parse the string-half of VALUE. Returns a Value (number or error).
 * Extracted so the array-fallback branch can reuse it without faking a
 * FunctionImpl call signature.
 */
function parseValueString(raw: string): Value {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ERR_VALUE
  // Allow leading `$`, strip thousands `,`, allow trailing `%`.
  let s = trimmed
  // Pull off leading sign for later re-application.
  let sign = 1
  if (s.startsWith('-')) {
    sign = -1
    s = s.slice(1).trimStart()
  } else if (s.startsWith('+')) {
    s = s.slice(1).trimStart()
  }
  if (s.startsWith('$')) s = s.slice(1).trimStart()
  // Trailing percent.
  let percent = false
  if (s.endsWith('%')) {
    percent = true
    s = s.slice(0, -1).trimEnd()
  }
  // Strip thousands separators only if they fit the comma-every-3
  // pattern. Excel is strict: "1,2,3" is not a number. We do a light
  // sanity check before removing them.
  if (s.includes(',')) {
    // Reject leading, trailing, or adjacent-to-decimal-point commas.
    if (/(^,|,,|,\.|,$)/.test(s)) return ERR_VALUE
    s = s.replace(/,/g, '')
  }
  // Now `s` should be a JS-parseable number.
  if (s.length === 0) return ERR_VALUE
  const n = Number(s)
  if (!Number.isFinite(n)) return ERR_VALUE
  const final = sign * (percent ? n / 100 : n)
  return { kind: 'number', value: final }
}

// =============================================================================
// Registry
// =============================================================================

/**
 * Wave C contract: each function file exports a `FUNCTIONS` record. The
 * evaluator's central index merges these into one dispatch Map.
 *
 * Names are uppercased — case-insensitive matching is the dispatcher's job,
 * but we keep them upper here to make the source readable as a manifest.
 */
export const FUNCTIONS: Record<string, FunctionImpl> = {
  CONCATENATE,
  CONCAT,
  LEFT,
  RIGHT,
  MID,
  LEN,
  LOWER,
  UPPER,
  TRIM,
  TEXT,
  VALUE,
}
