/**
 * Wave C / C5 — criteria-driven aggregation functions.
 *
 * COUNTIF, SUMIF, COUNTIFS, SUMIFS — the four "if" aggregators that share
 * the same criterion grammar:
 *
 *   - bare number   `5`         → equality (numeric)
 *   - bare string   `"abc"`     → case-insensitive equality, may include
 *                                 wildcards `*` (any run) / `?` (one char)
 *   - comparison    `">5"`, `"<=3"`, `"<>x"` — operator prefix strips off,
 *                                 the remainder is the comparand. `=` and
 *                                 `<>` may compare against strings.
 *   - cell reference is resolved to a Value before reaching us; we treat
 *     it as bare-number / bare-string by `kind`.
 *
 * The criterion-grammar parser is local to this file by mandate (no
 * cross-import from `lookup.ts`). It is small enough to inline.
 */

import type { EvalContext, FunctionImpl, Value } from '../../types'
import { toBoolean, toNumber } from '../coerce'

// ---------------------------------------------------------------------------
// Criterion parsing
// ---------------------------------------------------------------------------

type Comparator = '=' | '<>' | '<' | '<=' | '>' | '>='

interface ParsedCriterion {
  readonly op: Comparator
  /** Comparand as a Value — number / string / boolean / blank. */
  readonly target: Value
  /** Set when the criterion is a string whose body contains `*` or `?`. */
  readonly wildcard: boolean
}

/** Split a string criterion into (comparator, rest). Defaults to `=`. */
function parseStringCriterion(raw: string): { op: Comparator; rest: string } {
  // Order matters — check the two-char operators first.
  if (raw.startsWith('<=')) return { op: '<=', rest: raw.slice(2) }
  if (raw.startsWith('>=')) return { op: '>=', rest: raw.slice(2) }
  if (raw.startsWith('<>')) return { op: '<>', rest: raw.slice(2) }
  if (raw.startsWith('<')) return { op: '<', rest: raw.slice(1) }
  if (raw.startsWith('>')) return { op: '>', rest: raw.slice(1) }
  if (raw.startsWith('=')) return { op: '=', rest: raw.slice(1) }
  return { op: '=', rest: raw }
}

function parseNumericString(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Convert a Value-shaped criterion into the parsed form. Numeric / boolean
 * / blank criteria become `op:'='` against the original Value. String
 * criteria run through the comparator prefix check; the remainder is
 * coerced to number when possible so `">5"` compares numerically.
 */
function parseCriterion(criterion: Value): ParsedCriterion | { error: Value } {
  if (criterion.kind === 'error') return { error: criterion }

  if (criterion.kind !== 'string') {
    // Non-string criterion (number, boolean, blank, array) — direct equality
    // against the underlying scalar. Arrays collapse to top-left.
    let target: Value = criterion
    if (criterion.kind === 'array') {
      const row = criterion.value[0]
      target = row && row.length ? row[0] : { kind: 'blank' }
    }
    return { op: '=', target, wildcard: false }
  }

  const { op, rest } = parseStringCriterion(criterion.value)
  // Attempt numeric coercion on the rest. If it parses cleanly, compare
  // numerically; otherwise keep as string.
  const trimmed = rest.trim()
  if (trimmed.length > 0) {
    const n = parseNumericString(trimmed)
    if (n !== undefined) {
      return { op, target: { kind: 'number', value: n }, wildcard: false }
    }
    // "TRUE" / "FALSE" → boolean comparand.
    const u = trimmed.toUpperCase()
    if (u === 'TRUE') return { op, target: { kind: 'boolean', value: true }, wildcard: false }
    if (u === 'FALSE') return { op, target: { kind: 'boolean', value: false }, wildcard: false }
  }
  // Fall through to string comparison.
  const wildcard = /[*?]/.test(rest)
  return { op, target: { kind: 'string', value: rest }, wildcard }
}

// ---------------------------------------------------------------------------
// Wildcard matching (local copy — by mandate, do not cross-import Wave C3)
// ---------------------------------------------------------------------------

/**
 * Excel wildcard match:
 *   `*` → any run of characters (including empty)
 *   `?` → exactly one character
 *   `~*` / `~?` / `~~` → literal `*` / `?` / `~`
 *
 * Case-insensitive — Excel string comparison is.
 */
function wildcardMatch(text: string, pattern: string): boolean {
  // Translate to a RegExp. Build the source piece-by-piece so escaping is
  // unambiguous.
  let src = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '~' && i + 1 < pattern.length) {
      const next = pattern[i + 1]
      if (next === '*' || next === '?' || next === '~') {
        src += escapeRegex(next)
        i++
        continue
      }
      src += escapeRegex(ch)
      continue
    }
    if (ch === '*') {
      src += '.*'
    } else if (ch === '?') {
      src += '.'
    } else {
      src += escapeRegex(ch)
    }
  }
  src += '$'
  return new RegExp(src, 'i').test(text)
}

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Single-value match against a parsed criterion
// ---------------------------------------------------------------------------

/**
 * Test whether `value` satisfies `parsed`. Excel rules:
 *
 *  - Blank cells match `=""`, do **not** match other numeric/string criteria.
 *  - Type mismatches under `=` / `<>` are false / true respectively (a
 *    number cell never equals a string criterion).
 *  - Comparison operators (`<`, `<=`, `>`, `>=`) only work between
 *    numerically-coercible values; otherwise no match.
 *  - String equality is case-insensitive (Excel-compat).
 */
function matchesCriterion(value: Value, parsed: ParsedCriterion): boolean {
  const { op, target, wildcard } = parsed

  // Wildcards only apply with = / <>, only when target is a string.
  if (wildcard && target.kind === 'string' && (op === '=' || op === '<>')) {
    if (value.kind !== 'string') {
      // Wildcard never matches a non-string cell with `=`; the negation of
      // "no match" is "true" under `<>`.
      return op === '<>'
    }
    const hit = wildcardMatch(value.value, target.value)
    return op === '=' ? hit : !hit
  }

  if (op === '=' || op === '<>') {
    const eq = scalarEquals(value, target)
    return op === '=' ? eq : !eq
  }

  // Ordered comparison — numeric only.
  const vNum = numericComparable(value)
  const tNum = numericComparable(target)
  if (vNum === undefined || tNum === undefined) return false
  switch (op) {
    case '<':
      return vNum < tNum
    case '<=':
      return vNum <= tNum
    case '>':
      return vNum > tNum
    case '>=':
      return vNum >= tNum
  }
}

export function makeCriterionMatcher(
  criterion: Value,
):
  | {
      readonly ok: true
      readonly matches: (value: Value) => boolean
      readonly matchesBlank: boolean
    }
  | {
      readonly ok: false
      readonly error: Value
    } {
  const parsed = parseCriterion(criterion)
  if ('error' in parsed) return { ok: false, error: parsed.error }
  return {
    ok: true,
    matches: (value) => value.kind !== 'error' && matchesCriterion(value, parsed),
    matchesBlank: matchesCriterion({ kind: 'blank' }, parsed),
  }
}

/** Coerce to a number for ordered comparison; return undefined if no clean coercion. */
function numericComparable(v: Value): number | undefined {
  if (v.kind === 'number') return v.value
  if (v.kind === 'boolean') return v.value ? 1 : 0
  if (v.kind === 'string') return parseNumericString(v.value)
  // Blanks / arrays / errors are not ordered against numbers in Excel's
  // criteria semantics.
  return undefined
}

/**
 * Scalar equality used by `=` / `<>`. Numeric criteria coerce numeric
 * strings from cells, matching Excel/Rust COUNTIF-family behavior.
 */
function scalarEquals(a: Value, b: Value): boolean {
  if (a.kind === 'error' || b.kind === 'error') return false
  if (a.kind === 'blank' && b.kind === 'blank') return true
  if (a.kind === 'blank' && b.kind === 'string' && b.value === '') return true
  if (b.kind === 'blank' && a.kind === 'string' && a.value === '') return true
  if (a.kind === 'blank' || b.kind === 'blank') return false
  if (a.kind === 'number' && b.kind === 'string') return parseNumericString(b.value) === a.value
  if (a.kind === 'string' && b.kind === 'number') return parseNumericString(a.value) === b.value
  if (a.kind !== b.kind) return false
  if (a.kind === 'number' && b.kind === 'number') return a.value === b.value
  if (a.kind === 'boolean' && b.kind === 'boolean') return a.value === b.value
  if (a.kind === 'string' && b.kind === 'string') {
    return a.value.toLowerCase() === b.value.toLowerCase()
  }
  return false
}

// ---------------------------------------------------------------------------
// Range materialization
// ---------------------------------------------------------------------------

/**
 * Convert a range-or-scalar argument into a flat `Value[]` (row-major). A
 * scalar argument is treated as a single-element range — matches Excel.
 */
function flatten(v: Value): Value[] {
  if (v.kind === 'array') {
    const out: Value[] = []
    for (const row of v.value) for (const cell of row) out.push(cell)
    return out
  }
  return [v]
}

interface ValueShape {
  readonly rows: number
  readonly cols: number
}

function valueShape(v: Value): ValueShape {
  if (v.kind !== 'array') return { rows: 1, cols: 1 }
  return { rows: v.value.length, cols: v.value[0]?.length ?? 0 }
}

function sameValueShape(a: Value, b: Value): boolean {
  const left = valueShape(a)
  const right = valueShape(b)
  return left.rows === right.rows && left.cols === right.cols
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

const COUNTIF: FunctionImpl = (args, _ctx) => {
  if (args.length !== 2) {
    return { kind: 'error', code: '#VALUE!', message: 'COUNTIF() requires 2 arguments' }
  }
  const [range, criterion] = args
  // Criterion errors propagate; range errors do **not** — Excel skips error
  // cells inside a range and counts the rest. We replicate that.
  const parsed = parseCriterion(criterion)
  if ('error' in parsed) return parsed.error

  const cells = flatten(range)
  let count = 0
  for (const cell of cells) {
    if (cell.kind === 'error') continue
    if (matchesCriterion(cell, parsed)) count++
  }
  return { kind: 'number', value: count }
}

const SUMIF: FunctionImpl = (args, _ctx) => {
  if (args.length < 2 || args.length > 3) {
    return { kind: 'error', code: '#VALUE!', message: 'SUMIF() takes 2 or 3 arguments' }
  }
  const [range, criterion, sumRange] = args
  const parsed = parseCriterion(criterion)
  if ('error' in parsed) return parsed.error

  const checkCells = flatten(range)
  const sumCells = sumRange ? flatten(sumRange) : checkCells

  // Excel: if sum_range is shorter, it's *extended* to match range. We
  // implement the simpler conservative rule — same length, otherwise we
  // pair index-by-index and stop at min(len). Matches WPS / LibreOffice
  // behavior for unequal arrays; Excel will silently truncate too.
  const n = Math.min(checkCells.length, sumCells.length)
  let total = 0
  for (let i = 0; i < n; i++) {
    const probe = checkCells[i]
    if (probe.kind === 'error') continue
    if (!matchesCriterion(probe, parsed)) continue
    const target = sumCells[i]
    if (target.kind === 'error') return target // propagate sum-side errors
    const num = toNumber(target)
    // Non-numeric sum-targets are silently ignored (Excel-compat); a string
    // that *looks* numeric does coerce, blanks coerce to 0.
    if (num.ok) total += num.value
  }
  return { kind: 'number', value: total }
}

const COUNTIFS: FunctionImpl = (args, _ctx) => {
  if (args.length < 2 || args.length % 2 !== 0) {
    return { kind: 'error', code: '#VALUE!', message: 'COUNTIFS() requires range/criterion pairs' }
  }
  const pairs = collectPairs(args)
  if ('error' in pairs) return pairs.error
  if (pairs.flats.length === 0) return { kind: 'number', value: 0 }

  const len = pairs.flats[0].length
  const baseShape = pairs.shapes[0]
  for (const shape of pairs.shapes) {
    if (shape.rows !== baseShape.rows || shape.cols !== baseShape.cols) {
      return { kind: 'error', code: '#VALUE!', message: 'COUNTIFS ranges must share shape' }
    }
  }

  let count = 0
  outer: for (let i = 0; i < len; i++) {
    for (let j = 0; j < pairs.flats.length; j++) {
      const cell = pairs.flats[j][i]
      if (cell.kind === 'error') return cell
      if (!matchesCriterion(cell, pairs.parsed[j])) continue outer
    }
    count++
  }
  return { kind: 'number', value: count }
}

const SUMIFS: FunctionImpl = (args, _ctx) => {
  // SUMIFS(sum_range, range1, crit1, range2, crit2, ...)
  if (args.length < 3 || args.length % 2 === 0) {
    return { kind: 'error', code: '#VALUE!', message: 'SUMIFS() requires sum_range + range/criterion pairs' }
  }
  const sumCells = flatten(args[0])
  const pairs = collectPairs(args.slice(1))
  if ('error' in pairs) return pairs.error
  if (pairs.flats.length === 0) {
    return { kind: 'error', code: '#VALUE!', message: 'SUMIFS() requires at least one criterion' }
  }

  const len = sumCells.length
  const sumShape = valueShape(args[0])
  for (const shape of pairs.shapes) {
    if (shape.rows !== sumShape.rows || shape.cols !== sumShape.cols) {
      return { kind: 'error', code: '#VALUE!', message: 'SUMIFS ranges must share shape' }
    }
  }

  let total = 0
  outer: for (let i = 0; i < len; i++) {
    for (let j = 0; j < pairs.flats.length; j++) {
      const cell = pairs.flats[j][i]
      if (cell.kind === 'error') return cell
      if (!matchesCriterion(cell, pairs.parsed[j])) continue outer
    }
    const target = sumCells[i]
    if (target.kind === 'error') return target
    const num = toNumber(target)
    if (num.ok) total += num.value
  }
  return { kind: 'number', value: total }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectPairs(
  args: Value[],
): { flats: Value[][]; parsed: ParsedCriterion[]; shapes: ValueShape[] } | { error: Value } {
  const flats: Value[][] = []
  const parsed: ParsedCriterion[] = []
  const shapes: ValueShape[] = []
  for (let i = 0; i < args.length; i += 2) {
    const rangeArg = args[i]
    const critArg = args[i + 1]
    const p = parseCriterion(critArg)
    if ('error' in p) return { error: p.error }
    flats.push(flatten(rangeArg))
    parsed.push(p)
    shapes.push(valueShape(rangeArg))
  }
  return { flats, parsed, shapes }
}

// ---------------------------------------------------------------------------
// Phase 8 additions — descriptive stats
// ---------------------------------------------------------------------------

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const ERR_VAL = (
  code: '#DIV/0!' | '#N/A' | '#NUM!' | '#VALUE!',
  message?: string,
): Value => (message ? { kind: 'error', code, message } : { kind: 'error', code })

type NumberArg = { ok: true; value: number } | { ok: false; err: Value }
type BooleanArg = { ok: true; value: boolean } | { ok: false; err: Value }

function numberArg(value: Value): NumberArg {
  const n = toNumber(value)
  if (!n.ok) return { ok: false, err: n.error }
  if (!Number.isFinite(n.value)) return { ok: false, err: ERR_VAL('#NUM!') }
  return { ok: true, value: n.value }
}

function booleanArg(value: Value): BooleanArg {
  const b = toBoolean(value)
  if (!b.ok) return { ok: false, err: b.error }
  return { ok: true, value: b.value }
}

/**
 * Walk every numeric value in args (Excel range-arg semantics: arrays
 * ignore non-numeric; scalars coerce). Returns numbers as a flat array,
 * or the first error encountered.
 */
function collectNumbers(args: ReadonlyArray<Value>): { ok: true; values: number[] } | { ok: false; err: Value } {
  const out: number[] = []
  for (const arg of args) {
    if (arg.kind === 'error') return { ok: false, err: arg }
    if (arg.kind === 'array') {
      for (const row of arg.value) {
        for (const cell of row) {
          if (cell.kind === 'error') return { ok: false, err: cell }
          if (cell.kind === 'number') out.push(cell.value)
          // string / boolean / blank inside array → skipped
        }
      }
      continue
    }
    const n = toNumber(arg)
    if (!n.ok) return { ok: false, err: n.error }
    out.push(n.value)
  }
  return { ok: true, values: out }
}

function collectNumbersA(
  args: ReadonlyArray<Value>,
): { ok: true; values: number[] } | { ok: false; err: Value } {
  const out: number[] = []
  const push = (value: Value): Value | undefined => {
    if (value.kind === 'error') return value
    if (value.kind === 'number') out.push(value.value)
    else if (value.kind === 'boolean') out.push(value.value ? 1 : 0)
    else if (value.kind === 'string') out.push(0)
    else if (value.kind === 'array') {
      for (const row of value.value) {
        for (const cell of row) {
          const err = push(cell)
          if (err) return err
        }
      }
    }
    return undefined
  }
  for (const arg of args) {
    const err = push(arg)
    if (err) return { ok: false, err }
  }
  return { ok: true, values: out }
}

interface NumberPair {
  readonly x: number
  readonly y: number
}

function collectNumberPairs(
  a: Value,
  b: Value,
): { ok: true; pairs: NumberPair[] } | { ok: false; err: Value } {
  if (a.kind === 'error') return { ok: false, err: a }
  if (b.kind === 'error') return { ok: false, err: b }
  const left = flatten(a)
  const right = flatten(b)
  if (left.length !== right.length) return { ok: false, err: ERR_VAL('#N/A') }

  const pairs: NumberPair[] = []
  for (let i = 0; i < left.length; i++) {
    const x = left[i]
    const y = right[i]
    if (x.kind === 'error') return { ok: false, err: x }
    if (y.kind === 'error') return { ok: false, err: y }
    if (x.kind === 'number' && y.kind === 'number') pairs.push({ x: x.value, y: y.value })
  }
  return { ok: true, pairs }
}

function meanOf(values: ReadonlyArray<number>): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sumSquaredDeviations(values: ReadonlyArray<number>, mean: number): number {
  return values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0)
}

function finiteNumber(value: number): Value {
  return Number.isFinite(value) ? NUM(value) : ERR_VAL('#NUM!')
}

/** MEDIAN — middle value or mean of two middle values. */
const MEDIAN: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  const nums = r.values.slice().sort((a, b) => a - b)
  if (nums.length === 0) return ERR_VAL('#NUM!')
  const mid = Math.floor(nums.length / 2)
  if (nums.length % 2 === 1) return NUM(nums[mid])
  return NUM((nums[mid - 1] + nums[mid]) / 2)
}

/** MODE.SNGL — first most-frequent number, or #N/A if all unique. */
const MODE: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  if (r.values.length < 2) return ERR_VAL('#N/A')
  const counts = new Map<number, number>()
  // Preserve insertion order so ties resolve to first-seen.
  for (const n of r.values) counts.set(n, (counts.get(n) ?? 0) + 1)
  let best: number | undefined
  let bestCount = 0
  for (const [n, c] of counts) {
    if (c > bestCount) {
      bestCount = c
      best = n
    }
  }
  if (best === undefined || bestCount < 2) return ERR_VAL('#N/A')
  return NUM(best)
}

/** MODE.MULT — column array of every value tied for the highest frequency. */
const MODE_MULT: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  if (r.values.length < 2) return ERR_VAL('#N/A')
  const counts = new Map<number, number>()
  for (const n of r.values) counts.set(n, (counts.get(n) ?? 0) + 1)
  const maxCount = Math.max(...counts.values())
  if (maxCount < 2) return ERR_VAL('#N/A')
  const seen = new Set<number>()
  const rows: Value[][] = []
  for (const n of r.values) {
    if (counts.get(n) === maxCount && !seen.has(n)) {
      seen.add(n)
      rows.push([NUM(n)])
    }
  }
  return { kind: 'array', value: rows }
}

/** STDEV — sample standard deviation (Bessel correction n-1). */
const STDEV: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  if (r.values.length < 2) return ERR_VAL('#DIV/0!')
  const mean = r.values.reduce((s, n) => s + n, 0) / r.values.length
  const sumSq = r.values.reduce((s, n) => s + (n - mean) * (n - mean), 0)
  return NUM(Math.sqrt(sumSq / (r.values.length - 1)))
}

/** STDEVP — population standard deviation (divide by n). */
const STDEVP: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  if (r.values.length === 0) return ERR_VAL('#DIV/0!')
  const mean = r.values.reduce((s, n) => s + n, 0) / r.values.length
  const sumSq = r.values.reduce((s, n) => s + (n - mean) * (n - mean), 0)
  return NUM(Math.sqrt(sumSq / r.values.length))
}

/** VAR — sample variance. */
const VAR: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  if (r.values.length < 2) return ERR_VAL('#DIV/0!')
  const mean = r.values.reduce((s, n) => s + n, 0) / r.values.length
  const sumSq = r.values.reduce((s, n) => s + (n - mean) * (n - mean), 0)
  return NUM(sumSq / (r.values.length - 1))
}

/** VARP — population variance. */
const VARP: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  if (r.values.length === 0) return ERR_VAL('#DIV/0!')
  const mean = r.values.reduce((s, n) => s + n, 0) / r.values.length
  const sumSq = r.values.reduce((s, n) => s + (n - mean) * (n - mean), 0)
  return NUM(sumSq / r.values.length)
}

/** LARGE(array, k) — k-th largest. */
const LARGE: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const kArg = args[1]
  if (kArg.kind === 'error') return kArg
  const r = collectNumbers([args[0]])
  if (!r.ok) return r.err
  const kc = toNumber(kArg)
  if (!kc.ok) return kc.error
  const k = Math.trunc(kc.value)
  if (k < 1 || k > r.values.length) return ERR_VAL('#NUM!')
  const sorted = r.values.slice().sort((a, b) => b - a)
  return NUM(sorted[k - 1])
}

/** SMALL(array, k) — k-th smallest. */
const SMALL: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const kArg = args[1]
  if (kArg.kind === 'error') return kArg
  const r = collectNumbers([args[0]])
  if (!r.ok) return r.err
  const kc = toNumber(kArg)
  if (!kc.ok) return kc.error
  const k = Math.trunc(kc.value)
  if (k < 1 || k > r.values.length) return ERR_VAL('#NUM!')
  const sorted = r.values.slice().sort((a, b) => a - b)
  return NUM(sorted[k - 1])
}

/**
 * PERCENTILE.INC (a.k.a. PERCENTILE) — linear interpolation, k in [0,1].
 * The "INC" variant includes the endpoints; this is the function Excel
 * exposes under the bare name `PERCENTILE`.
 */
const PERCENTILE: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  if (args[1].kind === 'error') return args[1]
  const r = collectNumbers([args[0]])
  if (!r.ok) return r.err
  if (r.values.length === 0) return ERR_VAL('#NUM!')
  const kc = toNumber(args[1])
  if (!kc.ok) return kc.error
  const k = kc.value
  if (k < 0 || k > 1) return ERR_VAL('#NUM!')
  const sorted = r.values.slice().sort((a, b) => a - b)
  const pos = k * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return NUM(sorted[lo])
  return NUM(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo))
}

/** PERCENTILE.EXC(array, k) — exclusive interpolation, k strictly in (0, 1). */
const PERCENTILE_EXC: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  if (args[1].kind === 'error') return args[1]
  const r = collectNumbers([args[0]])
  if (!r.ok) return r.err
  if (r.values.length === 0) return ERR_VAL('#NUM!')
  const kc = toNumber(args[1])
  if (!kc.ok) return kc.error
  const k = kc.value
  if (k <= 0 || k >= 1) return ERR_VAL('#NUM!')
  const sorted = r.values.slice().sort((a, b) => a - b)
  const pos = k * (sorted.length + 1)
  if (pos < 1 || pos > sorted.length) return ERR_VAL('#NUM!')
  const zeroBased = pos - 1
  const lo = Math.floor(zeroBased)
  const hi = Math.ceil(zeroBased)
  if (lo === hi) return NUM(sorted[lo])
  return NUM(sorted[lo] + (sorted[hi] - sorted[lo]) * (zeroBased - lo))
}

/** QUARTILE(array, quart) — quart in 0..4, maps to k = quart/4. */
const QUARTILE: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  if (args[1].kind === 'error') return args[1]
  const qc = toNumber(args[1])
  if (!qc.ok) return qc.error
  const q = Math.trunc(qc.value)
  if (q < 0 || q > 4) return ERR_VAL('#NUM!')
  return PERCENTILE([args[0], { kind: 'number', value: q / 4 }], _ctxStub)
}

/** QUARTILE.EXC(array, quart) — quart in 1..3, maps to PERCENTILE.EXC. */
const QUARTILE_EXC: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  if (args[1].kind === 'error') return args[1]
  const qc = toNumber(args[1])
  if (!qc.ok) return qc.error
  const q = Math.trunc(qc.value)
  if (q !== qc.value || q < 1 || q > 3) return ERR_VAL('#NUM!')
  return PERCENTILE_EXC([args[0], { kind: 'number', value: q / 4 }], _ctxStub)
}

// Stats functions don't consult ctx, but FunctionImpl requires it.
// Build a sentinel that throws so any accidental access surfaces clearly.
const _ctxStub = new Proxy({}, {
  get(_, prop) {
    throw new Error(`stats fn unexpectedly read ctx.${String(prop)}`)
  },
}) as unknown as EvalContext

/** RANK(value, ref, [order=0]) — order=0 descending (default), 1 ascending. */
const RANK: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3) return ERR_VAL('#VALUE!')
  if (args[0].kind === 'error') return args[0]
  const vc = toNumber(args[0])
  if (!vc.ok) return vc.error
  const r = collectNumbers([args[1]])
  if (!r.ok) return r.err
  let descending = true
  if (args.length === 3) {
    if (args[2].kind === 'error') return args[2]
    const oc = toNumber(args[2])
    if (!oc.ok) return oc.error
    descending = oc.value === 0
  }
  const arr = r.values
  if (!arr.includes(vc.value)) return ERR_VAL('#N/A')
  // Standard competition ranking: 1-based.
  let rank = 1
  for (const n of arr) {
    if (descending ? n > vc.value : n < vc.value) rank++
  }
  return NUM(rank)
}

/** RANK.AVG(value, ref, [order=0]) — tied ranks average their occupied positions. */
const RANK_AVG: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3) return ERR_VAL('#VALUE!')
  if (args[0].kind === 'error') return args[0]
  const vc = toNumber(args[0])
  if (!vc.ok) return vc.error
  const r = collectNumbers([args[1]])
  if (!r.ok) return r.err
  let descending = true
  if (args.length === 3) {
    if (args[2].kind === 'error') return args[2]
    const oc = toNumber(args[2])
    if (!oc.ok) return oc.error
    descending = oc.value === 0
  }
  const arr = r.values
  if (!arr.includes(vc.value)) return ERR_VAL('#N/A')
  let better = 0
  let equal = 0
  for (const n of arr) {
    if (n === vc.value) {
      equal++
    } else if (descending ? n > vc.value : n < vc.value) {
      better++
    }
  }
  return NUM(better + (equal + 1) / 2)
}

/** AVERAGEIF(range, criterion, [averageRange]) */
const AVERAGEIF: FunctionImpl = (args, _ctx) => {
  if (args.length < 2 || args.length > 3) return ERR_VAL('#VALUE!')
  const [range, criterion, avgRange] = args
  const parsed = parseCriterion(criterion)
  if ('error' in parsed) return parsed.error
  if (avgRange && !sameValueShape(range, avgRange)) return ERR_VAL('#VALUE!')
  const checkCells = flatten(range)
  const sumCells = avgRange ? flatten(avgRange) : checkCells
  let total = 0
  let count = 0
  for (let i = 0; i < checkCells.length; i++) {
    const probe = checkCells[i]
    if (probe.kind === 'error') return probe
    if (!matchesCriterion(probe, parsed)) continue
    const target = sumCells[i]
    if (target.kind === 'error') return target
    const num = toNumber(target)
    if (num.ok) {
      total += num.value
      count++
    }
  }
  if (count === 0) return ERR_VAL('#DIV/0!')
  return NUM(total / count)
}

/** AVERAGEIFS(averageRange, range1, crit1, ...) */
const AVERAGEIFS: FunctionImpl = (args, _ctx) => {
  if (args.length < 3 || args.length % 2 === 0) return ERR_VAL('#VALUE!')
  const sumCells = flatten(args[0])
  const pairs = collectPairs(args.slice(1))
  if ('error' in pairs) return pairs.error
  const len = sumCells.length
  const sumShape = valueShape(args[0])
  for (const shape of pairs.shapes) {
    if (shape.rows !== sumShape.rows || shape.cols !== sumShape.cols) return ERR_VAL('#VALUE!')
  }
  let total = 0
  let count = 0
  outer: for (let i = 0; i < len; i++) {
    for (let j = 0; j < pairs.flats.length; j++) {
      const cell = pairs.flats[j][i]
      if (cell.kind === 'error') return cell
      if (!matchesCriterion(cell, pairs.parsed[j])) continue outer
    }
    const target = sumCells[i]
    if (target.kind === 'error') return target
    const num = toNumber(target)
    if (num.ok) {
      total += num.value
      count++
    }
  }
  if (count === 0) return ERR_VAL('#DIV/0!')
  return NUM(total / count)
}

/** MAXIFS(maxRange, range1, crit1, ...) — modern Excel function. */
const MAXIFS: FunctionImpl = (args, _ctx) => {
  if (args.length < 3 || args.length % 2 === 0) return ERR_VAL('#VALUE!')
  const targetCells = flatten(args[0])
  const pairs = collectPairs(args.slice(1))
  if ('error' in pairs) return pairs.error
  const len = targetCells.length
  const targetShape = valueShape(args[0])
  for (const shape of pairs.shapes) {
    if (shape.rows !== targetShape.rows || shape.cols !== targetShape.cols) return ERR_VAL('#VALUE!')
  }
  let best = Number.NEGATIVE_INFINITY
  let seen = false
  outer: for (let i = 0; i < len; i++) {
    for (let j = 0; j < pairs.flats.length; j++) {
      const cell = pairs.flats[j][i]
      if (cell.kind === 'error') return cell
      if (!matchesCriterion(cell, pairs.parsed[j])) continue outer
    }
    const target = targetCells[i]
    if (target.kind === 'error') return target
    if (target.kind === 'number') {
      if (target.value > best) best = target.value
      seen = true
    }
  }
  return NUM(seen ? best : 0)
}

/** MINIFS(minRange, range1, crit1, ...) */
const MINIFS: FunctionImpl = (args, _ctx) => {
  if (args.length < 3 || args.length % 2 === 0) return ERR_VAL('#VALUE!')
  const targetCells = flatten(args[0])
  const pairs = collectPairs(args.slice(1))
  if ('error' in pairs) return pairs.error
  const len = targetCells.length
  const targetShape = valueShape(args[0])
  for (const shape of pairs.shapes) {
    if (shape.rows !== targetShape.rows || shape.cols !== targetShape.cols) return ERR_VAL('#VALUE!')
  }
  let best = Number.POSITIVE_INFINITY
  let seen = false
  outer: for (let i = 0; i < len; i++) {
    for (let j = 0; j < pairs.flats.length; j++) {
      const cell = pairs.flats[j][i]
      if (cell.kind === 'error') return cell
      if (!matchesCriterion(cell, pairs.parsed[j])) continue outer
    }
    const target = targetCells[i]
    if (target.kind === 'error') return target
    if (target.kind === 'number') {
      if (target.value < best) best = target.value
      seen = true
    }
  }
  return NUM(seen ? best : 0)
}

/** Correlation coefficient: Pearson r between two equal-length arrays. */
const CORREL: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const collected = collectNumberPairs(args[0], args[1])
  if (!collected.ok) return collected.err
  const pairs = collected.pairs
  if (pairs.length === 0) return ERR_VAL('#DIV/0!')
  const n = pairs.length
  const meanA = pairs.reduce((s, p) => s + p.x, 0) / n
  const meanB = pairs.reduce((s, p) => s + p.y, 0) / n
  let cov = 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    const da = pairs[i].x - meanA
    const db = pairs[i].y - meanB
    cov += da * db
    sa += da * da
    sb += db * db
  }
  if (sa === 0 || sb === 0) return ERR_VAL('#DIV/0!')
  return NUM(cov / Math.sqrt(sa * sb))
}

function covariance(args: Value[], sample: boolean): Value {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const collected = collectNumberPairs(args[0], args[1])
  if (!collected.ok) return collected.err
  const pairs = collected.pairs
  const n = pairs.length
  if (n === 0 || (sample && n < 2)) return ERR_VAL('#DIV/0!')
  const meanA = pairs.reduce((s, p) => s + p.x, 0) / n
  const meanB = pairs.reduce((s, p) => s + p.y, 0) / n
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += (pairs[i].x - meanA) * (pairs[i].y - meanB)
  }
  return NUM(sum / (sample ? n - 1 : n))
}

/** COVARIANCE.P / COVAR — population covariance. */
const COVARIANCE_P: FunctionImpl = (args) => covariance(args, false)

/** COVARIANCE.S — sample covariance. */
const COVARIANCE_S: FunctionImpl = (args) => covariance(args, true)

/** SLOPE(known_ys, known_xs) — linear regression slope. */
const SLOPE: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const collected = collectNumberPairs(args[1], args[0])
  if (!collected.ok) return collected.err
  const pairs = collected.pairs
  const n = pairs.length
  if (n < 2) return ERR_VAL('#DIV/0!')
  const meanX = pairs.reduce((s, p) => s + p.x, 0) / n
  const meanY = pairs.reduce((s, p) => s + p.y, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = pairs[i].x - meanX
    num += dx * (pairs[i].y - meanY)
    den += dx * dx
  }
  if (den === 0) return ERR_VAL('#DIV/0!')
  return NUM(num / den)
}

/** INTERCEPT(known_ys, known_xs) — y-intercept of linear regression. */
const INTERCEPT: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const collected = collectNumberPairs(args[1], args[0])
  if (!collected.ok) return collected.err
  const pairs = collected.pairs
  const n = pairs.length
  if (n < 2) return ERR_VAL('#DIV/0!')
  const meanX = pairs.reduce((s, p) => s + p.x, 0) / n
  const meanY = pairs.reduce((s, p) => s + p.y, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = pairs[i].x - meanX
    num += dx * (pairs[i].y - meanY)
    den += dx * dx
  }
  if (den === 0) return ERR_VAL('#DIV/0!')
  const slope = num / den
  return NUM(meanY - slope * meanX)
}

/** AVERAGEA — like AVERAGE but text counts as 0, booleans count as 0/1. */
const AVERAGEA: FunctionImpl = (args) => {
  if (args.length === 0) return ERR_VAL('#DIV/0!')
  let total = 0
  let count = 0
  for (const arg of args) {
    if (arg.kind === 'error') return arg
    if (arg.kind === 'array') {
      for (const row of arg.value) {
        for (const cell of row) {
          if (cell.kind === 'error') return cell
          if (cell.kind === 'blank') continue
          if (cell.kind === 'number') {
            total += cell.value
            count++
          } else if (cell.kind === 'boolean') {
            total += cell.value ? 1 : 0
            count++
          } else if (cell.kind === 'string') {
            // text counts as 0 in AVERAGEA
            count++
          }
        }
      }
    } else if (arg.kind === 'blank') {
      // skip
    } else if (arg.kind === 'number') {
      total += arg.value
      count++
    } else if (arg.kind === 'boolean') {
      total += arg.value ? 1 : 0
      count++
    } else if (arg.kind === 'string') {
      // scalar string: must be numeric in AVERAGEA; else #VALUE!
      const n = toNumber(arg)
      if (!n.ok) return n.error
      total += n.value
      count++
    }
  }
  if (count === 0) return ERR_VAL('#DIV/0!')
  return NUM(total / count)
}

/** AVEDEV — average absolute deviation from the mean. */
const AVEDEV: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  if (r.values.length === 0) return ERR_VAL('#DIV/0!')
  const mean = meanOf(r.values)
  return finiteNumber(r.values.reduce((sum, value) => sum + Math.abs(value - mean), 0) / r.values.length)
}

/** DEVSQ — sum of squared deviations from the mean. */
const DEVSQ: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  if (r.values.length === 0) return NUM(0)
  return finiteNumber(sumSquaredDeviations(r.values, meanOf(r.values)))
}

/** MAXA / MINA — text and FALSE count as 0, TRUE counts as 1, blanks skip. */
const MAXA: FunctionImpl = (args) => {
  const r = collectNumbersA(args)
  if (!r.ok) return r.err
  if (r.values.length === 0) return NUM(0)
  return finiteNumber(r.values.reduce((best, value) => Math.max(best, value), Number.NEGATIVE_INFINITY))
}

const MINA: FunctionImpl = (args) => {
  const r = collectNumbersA(args)
  if (!r.ok) return r.err
  if (r.values.length === 0) return NUM(0)
  return finiteNumber(r.values.reduce((best, value) => Math.min(best, value), Number.POSITIVE_INFINITY))
}

function varianceA(args: ReadonlyArray<Value>, sample: boolean, sqrt: boolean): Value {
  const r = collectNumbersA(args)
  if (!r.ok) return r.err
  const n = r.values.length
  if ((sample && n < 2) || (!sample && n < 1)) return ERR_VAL('#DIV/0!')
  const variance = sumSquaredDeviations(r.values, meanOf(r.values)) / (sample ? n - 1 : n)
  return finiteNumber(sqrt ? Math.sqrt(variance) : variance)
}

const STDEVA: FunctionImpl = (args) => varianceA(args, true, true)
const STDEVPA: FunctionImpl = (args) => varianceA(args, false, true)
const VARA: FunctionImpl = (args) => varianceA(args, true, false)
const VARPA: FunctionImpl = (args) => varianceA(args, false, false)

/** STANDARDIZE(x, mean, standard_dev). */
const STANDARDIZE: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const x = toNumber(args[0])
  if (!x.ok) return x.error
  const mean = toNumber(args[1])
  if (!mean.ok) return mean.error
  const standardDev = toNumber(args[2])
  if (!standardDev.ok) return standardDev.error
  if (standardDev.value <= 0) return ERR_VAL('#NUM!')
  return finiteNumber((x.value - mean.value) / standardDev.value)
}

/** GEOMEAN — geometric mean of strictly-positive inputs. */
const GEOMEAN: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  if (r.values.length === 0) return ERR_VAL('#NUM!')
  let logSum = 0
  for (const value of r.values) {
    if (value <= 0) return ERR_VAL('#NUM!')
    logSum += Math.log(value)
  }
  return finiteNumber(Math.exp(logSum / r.values.length))
}

/** HARMEAN — harmonic mean of strictly-positive inputs. */
const HARMEAN: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  if (r.values.length === 0) return ERR_VAL('#NUM!')
  let invSum = 0
  for (const value of r.values) {
    if (value <= 0) return ERR_VAL('#NUM!')
    invSum += 1 / value
  }
  return finiteNumber(r.values.length / invSum)
}

/** TRIMMEAN(array, percent) — trim equally from both tails before averaging. */
const TRIMMEAN: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const percent = toNumber(args[1])
  if (!percent.ok) return percent.error
  if (percent.value < 0 || percent.value >= 1) return ERR_VAL('#NUM!')
  const r = collectNumbers([args[0]])
  if (!r.ok) return r.err
  const n = r.values.length
  if (n === 0) return ERR_VAL('#DIV/0!')
  const trimEach = Math.floor(Math.floor(n * percent.value) / 2)
  if (trimEach * 2 >= n) return ERR_VAL('#NUM!')
  const sorted = r.values.slice().sort((a, b) => a - b)
  const kept = sorted.slice(trimEach, n - trimEach)
  return finiteNumber(meanOf(kept))
}

const FISHER: FunctionImpl = (args) => {
  if (args.length !== 1) return ERR_VAL('#VALUE!')
  const x = toNumber(args[0])
  if (!x.ok) return x.error
  if (x.value <= -1 || x.value >= 1) return ERR_VAL('#NUM!')
  return finiteNumber(0.5 * Math.log((1 + x.value) / (1 - x.value)))
}

const FISHERINV: FunctionImpl = (args) => {
  if (args.length !== 1) return ERR_VAL('#VALUE!')
  const y = toNumber(args[0])
  if (!y.ok) return y.error
  return finiteNumber(Math.tanh(y.value))
}

function regressionSums(pairs: ReadonlyArray<NumberPair>): {
  readonly sxx: number
  readonly sxy: number
  readonly syy: number
  readonly meanX: number
  readonly meanY: number
} {
  const meanX = pairs.reduce((sum, pair) => sum + pair.x, 0) / pairs.length
  const meanY = pairs.reduce((sum, pair) => sum + pair.y, 0) / pairs.length
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const pair of pairs) {
    const dx = pair.x - meanX
    const dy = pair.y - meanY
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  return { sxx, sxy, syy, meanX, meanY }
}

/** RSQ(known_ys, known_xs) — square of Pearson correlation. */
const RSQ: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const pairs = collectNumberPairs(args[1], args[0])
  if (!pairs.ok) return pairs.err
  if (pairs.pairs.length < 2) return ERR_VAL('#DIV/0!')
  const { sxx, sxy, syy } = regressionSums(pairs.pairs)
  if (sxx === 0 || syy === 0) return ERR_VAL('#DIV/0!')
  return finiteNumber((sxy * sxy) / (sxx * syy))
}

/** SKEW — sample skewness. */
const SKEW: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  const n = r.values.length
  if (n < 3) return ERR_VAL('#NUM!')
  const mean = meanOf(r.values)
  const variance = sumSquaredDeviations(r.values, mean) / (n - 1)
  const standardDev = Math.sqrt(variance)
  if (standardDev === 0) return ERR_VAL('#DIV/0!')
  const sumCubed = r.values.reduce((sum, value) => sum + ((value - mean) / standardDev) ** 3, 0)
  return finiteNumber((n / ((n - 1) * (n - 2))) * sumCubed)
}

/** SKEW.P — population skewness. */
const SKEW_P: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  const n = r.values.length
  if (n < 3) return ERR_VAL('#NUM!')
  const mean = meanOf(r.values)
  const variance = sumSquaredDeviations(r.values, mean) / n
  const standardDev = Math.sqrt(variance)
  if (standardDev === 0) return ERR_VAL('#DIV/0!')
  const thirdMoment = r.values.reduce((sum, value) => sum + (value - mean) ** 3, 0) / n
  return finiteNumber(thirdMoment / standardDev ** 3)
}

/** KURT — sample excess kurtosis. */
const KURT: FunctionImpl = (args) => {
  const r = collectNumbers(args)
  if (!r.ok) return r.err
  const n = r.values.length
  if (n < 4) return ERR_VAL('#NUM!')
  const mean = meanOf(r.values)
  const variance = sumSquaredDeviations(r.values, mean) / (n - 1)
  const standardDev = Math.sqrt(variance)
  if (standardDev === 0) return ERR_VAL('#DIV/0!')
  const sumFourth = r.values.reduce((sum, value) => sum + ((value - mean) / standardDev) ** 4, 0)
  const excess =
    (n * (n + 1) * sumFourth) / ((n - 1) * (n - 2) * (n - 3)) -
    (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3))
  return finiteNumber(excess)
}

/** FORECAST / FORECAST.LINEAR — simple linear-regression prediction. */
const FORECAST: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const xAt = toNumber(args[0])
  if (!xAt.ok) return xAt.error
  const pairs = collectNumberPairs(args[2], args[1])
  if (!pairs.ok) return pairs.err
  if (pairs.pairs.length < 2) return ERR_VAL('#DIV/0!')
  const { sxx, sxy, meanX, meanY } = regressionSums(pairs.pairs)
  if (sxx === 0) return ERR_VAL('#DIV/0!')
  return finiteNumber(meanY + (sxy / sxx) * (xAt.value - meanX))
}

function truncateDigits(value: number, digits: number): number {
  const scale = 10 ** digits
  return Math.trunc(value * scale) / scale
}

function percentRank(args: Value[], exclusive: boolean): Value {
  if (args.length < 2 || args.length > 3) return ERR_VAL('#VALUE!')
  const x = toNumber(args[1])
  if (!x.ok) return x.error
  let significance = 3
  if (args.length === 3) {
    const s = toNumber(args[2])
    if (!s.ok) return s.error
    significance = Math.trunc(s.value)
    if (significance < 1) return ERR_VAL('#NUM!')
  }
  const r = collectNumbers([args[0]])
  if (!r.ok) return r.err
  if (r.values.length === 0) return ERR_VAL('#NUM!')
  const sorted = r.values.slice().sort((a, b) => a - b)
  const last = sorted.length - 1
  if (x.value < sorted[0] || x.value > sorted[last]) return ERR_VAL('#N/A')

  let lowerIndex = 0
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] <= x.value) lowerIndex = i
    else break
  }
  const exact = sorted[lowerIndex] === x.value
  const fraction = exact ? 0 : (x.value - sorted[lowerIndex]) / (sorted[lowerIndex + 1] - sorted[lowerIndex])
  const position = lowerIndex + fraction
  const rank = exclusive ? (position + 1) / (sorted.length + 1) : sorted.length === 1 ? 1 : position / last
  return finiteNumber(truncateDigits(rank, significance))
}

const PERCENTRANK: FunctionImpl = (args) => percentRank(args, false)
const PERCENTRANK_EXC: FunctionImpl = (args) => percentRank(args, true)

/** PROB(x_range, prob_range, lower_limit, [upper_limit]). */
const PROB: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 4) return ERR_VAL('#VALUE!')
  const pairs = collectNumberPairs(args[0], args[1])
  if (!pairs.ok) return pairs.err
  if (pairs.pairs.length === 0) return ERR_VAL('#NUM!')

  let probSum = 0
  for (const pair of pairs.pairs) {
    if (pair.y <= 0 || pair.y > 1) return ERR_VAL('#NUM!')
    probSum += pair.y
  }
  if (Math.abs(probSum - 1) > 1e-9) return ERR_VAL('#NUM!')

  const lower = toNumber(args[2])
  if (!lower.ok) return lower.error
  const upper = args.length === 4 ? toNumber(args[3]) : lower
  if (!upper.ok) return upper.error
  const lo = Math.min(lower.value, upper.value)
  const hi = Math.max(lower.value, upper.value)
  let total = 0
  for (const pair of pairs.pairs) {
    if (pair.x >= lo && pair.x <= hi) total += pair.y
  }
  return finiteNumber(total)
}

// ---------------------------------------------------------------------------
// Distribution and test functions
// ---------------------------------------------------------------------------

const SQRT_TWO_PI = Math.sqrt(2 * Math.PI)
const LOG_SQRT_TWO_PI = 0.9189385332046727

function clampProbability(value: number): number {
  if (value < 0 && value > -1e-14) return 0
  if (value > 1 && value < 1 + 1e-14) return 1
  return value
}

function probability(value: number): Value {
  return finiteNumber(clampProbability(value))
}

function standardNormalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_TWO_PI
}

const ERFC_COEFFICIENTS = [
  -1.3026537197817094,
  0.6419697923564903,
  0.019476473204185836,
  -0.009561514786808631,
  -0.000946595344482036,
  0.000366839497852761,
  0.000042523324806907,
  -0.000020278578112534,
  -0.000001624290004647,
  0.00000130365583558,
  0.000000015626441722,
  -0.000000085238095915,
  0.000000006529054439,
  0.000000005059343495,
  -0.000000000991364156,
  -0.000000000227365122,
  0.000000000096467911,
  0.000000000002394038,
  -0.000000000006886027,
  0.000000000000894487,
  0.000000000000313092,
  -0.000000000000112708,
  0.000000000000000381,
  0.000000000000007106,
  -0.000000000000001523,
  -0.000000000000000094,
  0.000000000000000121,
  -0.000000000000000028,
] as const

function erfc(x: number): number {
  const z = Math.abs(x)
  const t = 2 / (2 + z)
  const ty = 4 * t - 2
  let d = 0
  let dd = 0
  for (let i = ERFC_COEFFICIENTS.length - 1; i > 0; i--) {
    const prev = d
    d = ty * d - dd + ERFC_COEFFICIENTS[i]
    dd = prev
  }
  const result = t * Math.exp(-z * z + 0.5 * (ERFC_COEFFICIENTS[0] + ty * d) - dd)
  return x < 0 ? 2 - result : result
}

function standardNormalCdf(x: number): number {
  if (x === Number.POSITIVE_INFINITY) return 1
  if (x === Number.NEGATIVE_INFINITY) return 0
  return clampProbability(0.5 * erfc(-x / Math.SQRT2))
}

function standardNormalInv(p: number): number {
  const a = [
    -39.69683028665376,
    220.9460984245205,
    -275.9285104469687,
    138.357751867269,
    -30.66479806614716,
    2.506628277459239,
  ] as const
  const b = [
    -54.47609879822406,
    161.5858368580409,
    -155.6989798598866,
    66.80131188771972,
    -13.28068155288572,
  ] as const
  const c = [
    -0.007784894002430293,
    -0.3223964580411365,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ] as const
  const d = [
    0.007784695709041462,
    0.3224671290700398,
    2.445134137142996,
    3.754408661907416,
  ] as const
  const low = 0.02425
  const high = 1 - low

  let x: number
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p))
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  } else if (p > high) {
    const q = Math.sqrt(-2 * Math.log1p(-p))
    x =
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  } else {
    const q = p - 0.5
    const r = q * q
    x =
      (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
      q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }

  for (let i = 0; i < 2; i++) {
    const error = standardNormalCdf(x) - p
    const scaled = error / standardNormalPdf(x)
    x -= scaled / (1 + (x * scaled) / 2)
  }
  return x
}

function logGamma(z: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    0.000009984369578019572,
    0.00000015056327351493116,
  ] as const
  if (z < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z)
  }
  const y = z - 1
  let x = 0.9999999999998099
  for (let i = 0; i < coefficients.length; i++) {
    x += coefficients[i] / (y + i + 1)
  }
  const t = y + coefficients.length - 0.5
  return LOG_SQRT_TWO_PI + (y + 0.5) * Math.log(t) - t + Math.log(x)
}

function regularizedBetaContinuedFraction(x: number, a: number, b: number): number {
  const maxIterations = 200
  const eps = 3e-14
  const tiny = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d

  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    h *= d * c

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < eps) break
  }
  return h
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const logFactor = logGamma(a + b) - logGamma(a) - logGamma(b)
  const bt = Math.exp(logFactor + a * Math.log(x) + b * Math.log1p(-x))
  if (x < (a + 1) / (a + b + 2)) {
    return bt * regularizedBetaContinuedFraction(x, a, b) / a
  }
  return 1 - bt * regularizedBetaContinuedFraction(1 - x, b, a) / b
}

function regularizedGammaSeriesP(a: number, x: number): number {
  const maxIterations = 200
  const eps = 1e-14
  let ap = a
  let del = 1 / a
  let sum = del
  for (let n = 1; n <= maxIterations; n++) {
    ap += 1
    del *= x / ap
    sum += del
    if (Math.abs(del) < Math.abs(sum) * eps) break
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a))
}

function regularizedGammaContinuedFractionQ(a: number, x: number): number {
  const maxIterations = 200
  const eps = 1e-14
  const tiny = 1e-300
  let b = x + 1 - a
  if (Math.abs(b) < tiny) b = tiny
  let c = 1 / tiny
  let d = 1 / b
  if (Math.abs(d) < tiny) d = tiny
  let h = d
  for (let i = 1; i <= maxIterations; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < eps) break
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h
}

function regularizedGammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) return Number.NaN
  if (x === 0) return 1
  if (x < a + 1) return 1 - regularizedGammaSeriesP(a, x)
  return regularizedGammaContinuedFractionQ(a, x)
}

function studentTCdf(t: number, df: number): number {
  if (t === 0) return 0.5
  const x = df / (df + t * t)
  const beta = regularizedBeta(x, df / 2, 0.5)
  return t > 0 ? 1 - beta / 2 : beta / 2
}

function studentTInv(p: number, df: number): number {
  if (p === 0.5) return 0
  let lo = -1
  let hi = 1
  while (studentTCdf(lo, df) > p) {
    hi = lo
    lo *= 2
  }
  while (studentTCdf(hi, df) < p) {
    lo = hi
    hi *= 2
  }
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (studentTCdf(mid, df) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function sampleVariance(values: ReadonlyArray<number>): number | undefined {
  if (values.length < 2) return undefined
  return sumSquaredDeviations(values, meanOf(values)) / (values.length - 1)
}

function poissonPmf(k: number, mean: number): number {
  return Math.exp(k * Math.log(mean) - mean - logGamma(k + 1))
}

function poissonCdf(k: number, mean: number): number {
  return regularizedGammaQ(k + 1, mean)
}

const NORM_DIST: FunctionImpl = (args) => {
  if (args.length !== 4) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const mean = numberArg(args[1])
  if (!mean.ok) return mean.err
  const standardDev = numberArg(args[2])
  if (!standardDev.ok) return standardDev.err
  const cumulative = booleanArg(args[3])
  if (!cumulative.ok) return cumulative.err
  if (standardDev.value <= 0) return ERR_VAL('#NUM!')
  const z = (x.value - mean.value) / standardDev.value
  return probability(
    cumulative.value ? standardNormalCdf(z) : standardNormalPdf(z) / standardDev.value,
  )
}

const NORM_S_DIST: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const z = numberArg(args[0])
  if (!z.ok) return z.err
  const cumulative = booleanArg(args[1])
  if (!cumulative.ok) return cumulative.err
  return probability(cumulative.value ? standardNormalCdf(z.value) : standardNormalPdf(z.value))
}

const NORM_INV: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const p = numberArg(args[0])
  if (!p.ok) return p.err
  const mean = numberArg(args[1])
  if (!mean.ok) return mean.err
  const standardDev = numberArg(args[2])
  if (!standardDev.ok) return standardDev.err
  if (p.value <= 0 || p.value >= 1 || standardDev.value <= 0) return ERR_VAL('#NUM!')
  return finiteNumber(mean.value + standardDev.value * standardNormalInv(p.value))
}

const NORM_S_INV: FunctionImpl = (args) => {
  if (args.length !== 1) return ERR_VAL('#VALUE!')
  const p = numberArg(args[0])
  if (!p.ok) return p.err
  if (p.value <= 0 || p.value >= 1) return ERR_VAL('#NUM!')
  return finiteNumber(standardNormalInv(p.value))
}

const NORMSDIST: FunctionImpl = (args) => {
  if (args.length !== 1) return ERR_VAL('#VALUE!')
  const z = numberArg(args[0])
  if (!z.ok) return z.err
  return probability(standardNormalCdf(z.value))
}

const LOGNORM_DIST: FunctionImpl = (args) => {
  if (args.length !== 4) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const mean = numberArg(args[1])
  if (!mean.ok) return mean.err
  const standardDev = numberArg(args[2])
  if (!standardDev.ok) return standardDev.err
  const cumulative = booleanArg(args[3])
  if (!cumulative.ok) return cumulative.err
  if (x.value <= 0 || standardDev.value <= 0) return ERR_VAL('#NUM!')
  const z = (Math.log(x.value) - mean.value) / standardDev.value
  return probability(
    cumulative.value
      ? standardNormalCdf(z)
      : standardNormalPdf(z) / (x.value * standardDev.value),
  )
}

const LOGNORM_INV: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const p = numberArg(args[0])
  if (!p.ok) return p.err
  const mean = numberArg(args[1])
  if (!mean.ok) return mean.err
  const standardDev = numberArg(args[2])
  if (!standardDev.ok) return standardDev.err
  if (p.value <= 0 || p.value >= 1 || standardDev.value <= 0) return ERR_VAL('#NUM!')
  return finiteNumber(Math.exp(mean.value + standardDev.value * standardNormalInv(p.value)))
}

const LOGNORMDIST: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  return LOGNORM_DIST([...args, { kind: 'boolean', value: true }], _ctxStub)
}

const EXPON_DIST: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const lambda = numberArg(args[1])
  if (!lambda.ok) return lambda.err
  const cumulative = booleanArg(args[2])
  if (!cumulative.ok) return cumulative.err
  if (x.value < 0 || lambda.value <= 0) return ERR_VAL('#NUM!')
  return finiteNumber(
    cumulative.value ? -Math.expm1(-lambda.value * x.value) : lambda.value * Math.exp(-lambda.value * x.value),
  )
}

const POISSON_DIST: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const mean = numberArg(args[1])
  if (!mean.ok) return mean.err
  const cumulative = booleanArg(args[2])
  if (!cumulative.ok) return cumulative.err
  if (x.value < 0 || mean.value <= 0) return ERR_VAL('#NUM!')
  const k = Math.trunc(x.value)
  return probability(cumulative.value ? poissonCdf(k, mean.value) : poissonPmf(k, mean.value))
}

const WEIBULL_DIST: FunctionImpl = (args) => {
  if (args.length !== 4) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const alpha = numberArg(args[1])
  if (!alpha.ok) return alpha.err
  const beta = numberArg(args[2])
  if (!beta.ok) return beta.err
  const cumulative = booleanArg(args[3])
  if (!cumulative.ok) return cumulative.err
  if (x.value < 0 || alpha.value <= 0 || beta.value <= 0) return ERR_VAL('#NUM!')
  const scaled = x.value / beta.value
  const power = scaled ** alpha.value
  if (cumulative.value) return probability(-Math.expm1(-power))
  return finiteNumber((alpha.value / beta.value) * scaled ** (alpha.value - 1) * Math.exp(-power))
}

const PHI: FunctionImpl = (args) => {
  if (args.length !== 1) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  return finiteNumber(standardNormalPdf(x.value))
}

const GAUSS: FunctionImpl = (args) => {
  if (args.length !== 1) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  return probability(standardNormalCdf(x.value) - 0.5)
}

const Z_TEST: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3) return ERR_VAL('#VALUE!')
  const r = collectNumbers([args[0]])
  if (!r.ok) return r.err
  const n = r.values.length
  if (n < 2) return ERR_VAL('#DIV/0!')
  const x = numberArg(args[1])
  if (!x.ok) return x.err
  const variance = sampleVariance(r.values)
  if (variance === undefined) return ERR_VAL('#DIV/0!')
  let sigma = Math.sqrt(variance)
  if (args.length === 3) {
    const supplied = numberArg(args[2])
    if (!supplied.ok) return supplied.err
    sigma = supplied.value
  }
  if (sigma <= 0) return ERR_VAL('#DIV/0!')
  const z = (meanOf(r.values) - x.value) / (sigma / Math.sqrt(n))
  return probability(1 - standardNormalCdf(z))
}

const CONFIDENCE_NORM: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const alpha = numberArg(args[0])
  if (!alpha.ok) return alpha.err
  const standardDev = numberArg(args[1])
  if (!standardDev.ok) return standardDev.err
  const sizeRaw = numberArg(args[2])
  if (!sizeRaw.ok) return sizeRaw.err
  const size = Math.trunc(sizeRaw.value)
  if (alpha.value <= 0 || alpha.value >= 1 || standardDev.value <= 0 || size < 1) {
    return ERR_VAL('#NUM!')
  }
  return finiteNumber(standardNormalInv(1 - alpha.value / 2) * standardDev.value / Math.sqrt(size))
}

const CONFIDENCE_T: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const alpha = numberArg(args[0])
  if (!alpha.ok) return alpha.err
  const standardDev = numberArg(args[1])
  if (!standardDev.ok) return standardDev.err
  const sizeRaw = numberArg(args[2])
  if (!sizeRaw.ok) return sizeRaw.err
  if (alpha.value <= 0 || alpha.value >= 1 || standardDev.value <= 0 || sizeRaw.value < 2) {
    return ERR_VAL('#NUM!')
  }
  const size = Math.trunc(sizeRaw.value)
  const t = studentTInv(1 - alpha.value / 2, size - 1)
  return finiteNumber(t * standardDev.value / Math.sqrt(size))
}

function regularizedGammaP(a: number, x: number): number {
  if (x < 0 || a <= 0) return Number.NaN
  if (x === 0) return 0
  if (x < a + 1) return regularizedGammaSeriesP(a, x)
  return 1 - regularizedGammaContinuedFractionQ(a, x)
}

function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b)
}

function betaPdfUnit(x: number, a: number, b: number): number {
  if (x <= 0) {
    if (a === 1) return b
    return a > 1 ? 0 : Number.POSITIVE_INFINITY
  }
  if (x >= 1) {
    if (b === 1) return a
    return b > 1 ? 0 : Number.POSITIVE_INFINITY
  }
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - logBeta(a, b))
}

function betaInvUnit(p: number, a: number, b: number): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  let lo = 0
  let hi = 1
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (regularizedBeta(mid, a, b) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function gammaValue(x: number): number {
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gammaValue(1 - x))
  return Math.exp(logGamma(x))
}

function gammaPdf(x: number, alpha: number, beta: number): number {
  if (x < 0) return Number.NaN
  if (x === 0) {
    if (alpha === 1) return 1 / beta
    return alpha > 1 ? 0 : Number.POSITIVE_INFINITY
  }
  const scaled = x / beta
  return Math.exp((alpha - 1) * Math.log(scaled) - scaled - logGamma(alpha)) / beta
}

function gammaCdf(x: number, alpha: number, beta: number): number {
  if (x <= 0) return 0
  return regularizedGammaP(alpha, x / beta)
}

function inversePositiveCdf(p: number, cdf: (x: number) => number): number {
  if (p <= 0) return 0
  let hi = 1
  while (cdf(hi) < p && hi < Number.MAX_VALUE / 2) hi *= 2
  let lo = 0
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (cdf(mid) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function studentTPdf(x: number, df: number): number {
  const half = (df + 1) / 2
  return Math.exp(
    logGamma(half) -
      logGamma(df / 2) -
      0.5 * Math.log(df * Math.PI) -
      half * Math.log1p((x * x) / df),
  )
}

function fCdf(x: number, df1: number, df2: number): number {
  if (x <= 0) return 0
  const ratio = (df1 * x) / (df1 * x + df2)
  return regularizedBeta(ratio, df1 / 2, df2 / 2)
}

function fPdf(x: number, df1: number, df2: number): number {
  if (x < 0) return Number.NaN
  if (x === 0) {
    if (df1 === 2) return Math.exp((df1 / 2) * Math.log(df1 / df2) - logBeta(df1 / 2, df2 / 2))
    return df1 > 2 ? 0 : Number.POSITIVE_INFINITY
  }
  return Math.exp(
    (df1 / 2) * Math.log(df1 / df2) +
      (df1 / 2 - 1) * Math.log(x) -
      logBeta(df1 / 2, df2 / 2) -
      ((df1 + df2) / 2) * Math.log1p((df1 * x) / df2),
  )
}

function chiSquareCdf(x: number, df: number): number {
  if (x <= 0) return 0
  return regularizedGammaP(df / 2, x / 2)
}

function chiSquarePdf(x: number, df: number): number {
  if (x < 0) return Number.NaN
  const half = df / 2
  if (x === 0) {
    if (half === 1) return 0.5
    return half > 1 ? 0 : Number.POSITIVE_INFINITY
  }
  return Math.exp((half - 1) * Math.log(x) - x / 2 - half * Math.log(2) - logGamma(half))
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)
}

function binomPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n) return 0
  if (p === 0) return k === 0 ? 1 : 0
  if (p === 1) return k === n ? 1 : 0
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p))
}

function binomCdf(k: number, n: number, p: number): number {
  let total = 0
  for (let i = 0; i <= k; i++) total += binomPmf(i, n, p)
  return total
}

function hypergeomPmf(sampleS: number, numSample: number, popS: number, numPop: number): number {
  const logP =
    logChoose(popS, sampleS) +
    logChoose(numPop - popS, numSample - sampleS) -
    logChoose(numPop, numSample)
  return Number.isFinite(logP) ? Math.exp(logP) : 0
}

function hypergeomCdf(sampleS: number, numSample: number, popS: number, numPop: number): number {
  const min = Math.max(0, numSample - (numPop - popS))
  const max = Math.min(sampleS, numSample, popS)
  let total = 0
  for (let k = min; k <= max; k++) total += hypergeomPmf(k, numSample, popS, numPop)
  return total
}

function negbinomPmf(numF: number, numS: number, p: number): number {
  if (p === 1) return numF === 0 ? 1 : 0
  return Math.exp(logChoose(numF + numS - 1, numF) + numS * Math.log(p) + numF * Math.log1p(-p))
}

function negbinomCdf(numF: number, numS: number, p: number): number {
  let total = 0
  for (let k = 0; k <= numF; k++) total += negbinomPmf(k, numS, p)
  return total
}

function integerValue(value: number): number | undefined {
  return Number.isFinite(value) && Math.trunc(value) === value ? value : undefined
}

const GAMMA_FUNC: FunctionImpl = (args) => {
  if (args.length !== 1) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  if (x.value === 0 || (x.value < 0 && Math.trunc(x.value) === x.value)) return ERR_VAL('#NUM!')
  return finiteNumber(gammaValue(x.value))
}

const GAMMALN: FunctionImpl = (args) => {
  if (args.length !== 1) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  if (x.value <= 0) return ERR_VAL('#NUM!')
  return finiteNumber(logGamma(x.value))
}

const BETA_DIST: FunctionImpl = (args) => {
  if (args.length < 4 || args.length > 6) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const alpha = numberArg(args[1])
  if (!alpha.ok) return alpha.err
  const beta = numberArg(args[2])
  if (!beta.ok) return beta.err
  const cumulative = booleanArg(args[3])
  if (!cumulative.ok) return cumulative.err
  const lower = args.length >= 5 ? numberArg(args[4]) : { ok: true, value: 0 } as const
  if (!lower.ok) return lower.err
  const upper = args.length === 6 ? numberArg(args[5]) : { ok: true, value: 1 } as const
  if (!upper.ok) return upper.err
  if (alpha.value <= 0 || beta.value <= 0 || upper.value <= lower.value) return ERR_VAL('#NUM!')
  if (x.value < lower.value || x.value > upper.value) return ERR_VAL('#NUM!')
  const scaled = (x.value - lower.value) / (upper.value - lower.value)
  const result = cumulative.value
    ? regularizedBeta(scaled, alpha.value, beta.value)
    : betaPdfUnit(scaled, alpha.value, beta.value) / (upper.value - lower.value)
  return probability(result)
}

const BETADIST: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 5) return ERR_VAL('#VALUE!')
  return BETA_DIST(
    [args[0], args[1], args[2], { kind: 'boolean', value: true }, ...args.slice(3)],
    _ctxStub,
  )
}

const BETA_INV: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 5) return ERR_VAL('#VALUE!')
  const p = numberArg(args[0])
  if (!p.ok) return p.err
  const alpha = numberArg(args[1])
  if (!alpha.ok) return alpha.err
  const beta = numberArg(args[2])
  if (!beta.ok) return beta.err
  const lower = args.length >= 4 ? numberArg(args[3]) : { ok: true, value: 0 } as const
  if (!lower.ok) return lower.err
  const upper = args.length === 5 ? numberArg(args[4]) : { ok: true, value: 1 } as const
  if (!upper.ok) return upper.err
  if (p.value < 0 || p.value > 1 || alpha.value <= 0 || beta.value <= 0 || upper.value <= lower.value) {
    return ERR_VAL('#NUM!')
  }
  return finiteNumber(lower.value + betaInvUnit(p.value, alpha.value, beta.value) * (upper.value - lower.value))
}

const GAMMA_DIST: FunctionImpl = (args) => {
  if (args.length !== 4) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const alpha = numberArg(args[1])
  if (!alpha.ok) return alpha.err
  const beta = numberArg(args[2])
  if (!beta.ok) return beta.err
  const cumulative = booleanArg(args[3])
  if (!cumulative.ok) return cumulative.err
  if (x.value < 0 || alpha.value <= 0 || beta.value <= 0) return ERR_VAL('#NUM!')
  return probability(
    cumulative.value
      ? gammaCdf(x.value, alpha.value, beta.value)
      : gammaPdf(x.value, alpha.value, beta.value),
  )
}

const GAMMA_INV: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const p = numberArg(args[0])
  if (!p.ok) return p.err
  const alpha = numberArg(args[1])
  if (!alpha.ok) return alpha.err
  const beta = numberArg(args[2])
  if (!beta.ok) return beta.err
  if (p.value < 0 || p.value >= 1 || alpha.value <= 0 || beta.value <= 0) return ERR_VAL('#NUM!')
  return finiteNumber(inversePositiveCdf(p.value, (x) => gammaCdf(x, alpha.value, beta.value)))
}

const BINOM_DIST: FunctionImpl = (args) => {
  if (args.length !== 4) return ERR_VAL('#VALUE!')
  const numS = numberArg(args[0])
  if (!numS.ok) return numS.err
  const trials = numberArg(args[1])
  if (!trials.ok) return trials.err
  const p = numberArg(args[2])
  if (!p.ok) return p.err
  const cumulative = booleanArg(args[3])
  if (!cumulative.ok) return cumulative.err
  const k = integerValue(numS.value)
  const n = integerValue(trials.value)
  if (k === undefined || n === undefined || k < 0 || n < 0 || k > n || p.value < 0 || p.value > 1) {
    return ERR_VAL('#NUM!')
  }
  return probability(cumulative.value ? binomCdf(k, n, p.value) : binomPmf(k, n, p.value))
}

const BINOM_INV: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const trials = numberArg(args[0])
  if (!trials.ok) return trials.err
  const p = numberArg(args[1])
  if (!p.ok) return p.err
  const alpha = numberArg(args[2])
  if (!alpha.ok) return alpha.err
  const n = integerValue(trials.value)
  if (n === undefined || n < 0 || p.value <= 0 || p.value >= 1 || alpha.value <= 0 || alpha.value >= 1) {
    return ERR_VAL('#NUM!')
  }
  for (let k = 0; k <= n; k++) {
    if (binomCdf(k, n, p.value) >= alpha.value) return NUM(k)
  }
  return NUM(n)
}

const BINOM_DIST_RANGE: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 4) return ERR_VAL('#VALUE!')
  const trials = numberArg(args[0])
  if (!trials.ok) return trials.err
  const p = numberArg(args[1])
  if (!p.ok) return p.err
  const lowerRaw = numberArg(args[2])
  if (!lowerRaw.ok) return lowerRaw.err
  const upperRaw = args.length === 4 ? numberArg(args[3]) : lowerRaw
  if (!upperRaw.ok) return upperRaw.err
  if (trials.value < 0 || p.value < 0 || p.value > 1) return ERR_VAL('#NUM!')
  const n = Math.trunc(trials.value)
  const lower = Math.trunc(lowerRaw.value)
  const upper = Math.trunc(upperRaw.value)
  if (lower < 0 || upper < lower || upper > n) return ERR_VAL('#NUM!')
  let total = 0
  for (let k = lower; k <= upper; k++) total += binomPmf(k, n, p.value)
  return probability(total)
}

const CHISQ_DIST: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const df = numberArg(args[1])
  if (!df.ok) return df.err
  const cumulative = booleanArg(args[2])
  if (!cumulative.ok) return cumulative.err
  if (x.value < 0 || df.value <= 0) return ERR_VAL('#NUM!')
  return probability(cumulative.value ? chiSquareCdf(x.value, df.value) : chiSquarePdf(x.value, df.value))
}

const CHISQ_DIST_RT: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const df = numberArg(args[1])
  if (!df.ok) return df.err
  if (x.value < 0 || df.value <= 0) return ERR_VAL('#NUM!')
  return probability(regularizedGammaQ(df.value / 2, x.value / 2))
}

const CHISQ_INV: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const p = numberArg(args[0])
  if (!p.ok) return p.err
  const df = numberArg(args[1])
  if (!df.ok) return df.err
  if (p.value < 0 || p.value >= 1 || df.value <= 0) return ERR_VAL('#NUM!')
  return finiteNumber(inversePositiveCdf(p.value, (x) => chiSquareCdf(x, df.value)))
}

const CHISQ_INV_RT: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const p = numberArg(args[0])
  if (!p.ok) return p.err
  const df = numberArg(args[1])
  if (!df.ok) return df.err
  if (p.value <= 0 || p.value > 1 || df.value <= 0) return ERR_VAL('#NUM!')
  return finiteNumber(inversePositiveCdf(1 - p.value, (x) => chiSquareCdf(x, df.value)))
}

const F_DIST: FunctionImpl = (args) => {
  if (args.length !== 4) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const df1 = numberArg(args[1])
  if (!df1.ok) return df1.err
  const df2 = numberArg(args[2])
  if (!df2.ok) return df2.err
  const cumulative = booleanArg(args[3])
  if (!cumulative.ok) return cumulative.err
  if (x.value < 0 || df1.value <= 0 || df2.value <= 0) return ERR_VAL('#NUM!')
  return probability(cumulative.value ? fCdf(x.value, df1.value, df2.value) : fPdf(x.value, df1.value, df2.value))
}

const F_DIST_RT: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const df1 = numberArg(args[1])
  if (!df1.ok) return df1.err
  const df2 = numberArg(args[2])
  if (!df2.ok) return df2.err
  if (x.value < 0 || df1.value <= 0 || df2.value <= 0) return ERR_VAL('#NUM!')
  return probability(1 - fCdf(x.value, df1.value, df2.value))
}

const F_INV: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const p = numberArg(args[0])
  if (!p.ok) return p.err
  const df1 = numberArg(args[1])
  if (!df1.ok) return df1.err
  const df2 = numberArg(args[2])
  if (!df2.ok) return df2.err
  if (p.value < 0 || p.value >= 1 || df1.value <= 0 || df2.value <= 0) return ERR_VAL('#NUM!')
  return finiteNumber(inversePositiveCdf(p.value, (x) => fCdf(x, df1.value, df2.value)))
}

const F_INV_RT: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const p = numberArg(args[0])
  if (!p.ok) return p.err
  const df1 = numberArg(args[1])
  if (!df1.ok) return df1.err
  const df2 = numberArg(args[2])
  if (!df2.ok) return df2.err
  if (p.value <= 0 || p.value > 1 || df1.value <= 0 || df2.value <= 0) return ERR_VAL('#NUM!')
  return finiteNumber(inversePositiveCdf(1 - p.value, (x) => fCdf(x, df1.value, df2.value)))
}

const T_DIST: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const df = numberArg(args[1])
  if (!df.ok) return df.err
  const cumulative = booleanArg(args[2])
  if (!cumulative.ok) return cumulative.err
  if (df.value <= 0) return ERR_VAL('#NUM!')
  return probability(cumulative.value ? studentTCdf(x.value, df.value) : studentTPdf(x.value, df.value))
}

const T_DIST_RT: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const df = numberArg(args[1])
  if (!df.ok) return df.err
  if (x.value < 0 || df.value <= 0) return ERR_VAL('#NUM!')
  return probability(1 - studentTCdf(x.value, df.value))
}

const T_DIST_2T: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const df = numberArg(args[1])
  if (!df.ok) return df.err
  if (x.value < 0 || df.value <= 0) return ERR_VAL('#NUM!')
  return probability(2 * (1 - studentTCdf(x.value, df.value)))
}

const T_INV: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const p = numberArg(args[0])
  if (!p.ok) return p.err
  const df = numberArg(args[1])
  if (!df.ok) return df.err
  if (p.value <= 0 || p.value >= 1 || df.value <= 0) return ERR_VAL('#NUM!')
  return finiteNumber(studentTInv(p.value, df.value))
}

const T_INV_2T: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const p = numberArg(args[0])
  if (!p.ok) return p.err
  const df = numberArg(args[1])
  if (!df.ok) return df.err
  if (p.value <= 0 || p.value > 1 || df.value <= 0) return ERR_VAL('#NUM!')
  return finiteNumber(studentTInv(1 - p.value / 2, df.value))
}

const TDIST: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  const x = numberArg(args[0])
  if (!x.ok) return x.err
  const dfRaw = numberArg(args[1])
  if (!dfRaw.ok) return dfRaw.err
  const tailsRaw = numberArg(args[2])
  if (!tailsRaw.ok) return tailsRaw.err
  const tails = integerValue(tailsRaw.value)
  const df = Math.trunc(dfRaw.value)
  if (x.value < 0 || df < 1 || tails === undefined || (tails !== 1 && tails !== 2)) return ERR_VAL('#NUM!')
  const upperTail = 1 - studentTCdf(x.value, df)
  return probability(tails === 1 ? upperTail : 2 * upperTail)
}

const HYPGEOM_DIST: FunctionImpl = (args) => {
  if (args.length !== 5) return ERR_VAL('#VALUE!')
  const sampleS = numberArg(args[0])
  if (!sampleS.ok) return sampleS.err
  const numSample = numberArg(args[1])
  if (!numSample.ok) return numSample.err
  const popS = numberArg(args[2])
  if (!popS.ok) return popS.err
  const numPop = numberArg(args[3])
  if (!numPop.ok) return numPop.err
  const cumulative = booleanArg(args[4])
  if (!cumulative.ok) return cumulative.err
  const sampleSI = integerValue(sampleS.value)
  const numSampleI = integerValue(numSample.value)
  const popSI = integerValue(popS.value)
  const numPopI = integerValue(numPop.value)
  if (
    sampleSI === undefined ||
    numSampleI === undefined ||
    popSI === undefined ||
    numPopI === undefined ||
    sampleSI < 0 ||
    numSampleI < 0 ||
    popSI < 0 ||
    numPopI < 0 ||
    popSI > numPopI ||
    numSampleI > numPopI ||
    sampleSI > numSampleI ||
    sampleSI > popSI
  ) {
    return ERR_VAL('#NUM!')
  }
  return probability(
    cumulative.value
      ? hypergeomCdf(sampleSI, numSampleI, popSI, numPopI)
      : hypergeomPmf(sampleSI, numSampleI, popSI, numPopI),
  )
}

const HYPGEOMDIST: FunctionImpl = (args) => {
  if (args.length !== 4) return ERR_VAL('#VALUE!')
  return HYPGEOM_DIST([...args, { kind: 'boolean', value: false }], _ctxStub)
}

const NEGBINOM_DIST: FunctionImpl = (args) => {
  if (args.length !== 4) return ERR_VAL('#VALUE!')
  const numF = numberArg(args[0])
  if (!numF.ok) return numF.err
  const numS = numberArg(args[1])
  if (!numS.ok) return numS.err
  const p = numberArg(args[2])
  if (!p.ok) return p.err
  const cumulative = booleanArg(args[3])
  if (!cumulative.ok) return cumulative.err
  const f = integerValue(numF.value)
  const s = integerValue(numS.value)
  if (f === undefined || s === undefined || f < 0 || s < 1 || p.value <= 0 || p.value > 1) {
    return ERR_VAL('#NUM!')
  }
  return probability(cumulative.value ? negbinomCdf(f, s, p.value) : negbinomPmf(f, s, p.value))
}

const NEGBINOMDIST: FunctionImpl = (args) => {
  if (args.length !== 3) return ERR_VAL('#VALUE!')
  return NEGBINOM_DIST([...args, { kind: 'boolean', value: false }], _ctxStub)
}

function matrixShape(value: Value): { rows: number; cols: number; values: Value[][] } {
  if (value.kind !== 'array') return { rows: 1, cols: 1, values: [[value]] }
  const rows = value.value.length
  const cols = rows === 0 ? 0 : value.value[0].length
  return { rows, cols, values: value.value }
}

const CHISQ_TEST: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const actual = matrixShape(args[0])
  const expected = matrixShape(args[1])
  if (actual.rows !== expected.rows || actual.cols !== expected.cols) return ERR_VAL('#N/A')
  let chi2 = 0
  let pairs = 0
  for (let r = 0; r < actual.rows; r++) {
    for (let c = 0; c < actual.cols; c++) {
      const a = actual.values[r][c]
      const e = expected.values[r][c]
      if (a.kind === 'error') return a
      if (e.kind === 'error') return e
      if (a.kind === 'number' && e.kind === 'number') {
        if (e.value === 0) return ERR_VAL('#DIV/0!')
        const diff = a.value - e.value
        chi2 += (diff * diff) / e.value
        pairs++
      }
    }
  }
  if (pairs < 2) return ERR_VAL('#DIV/0!')
  const df = actual.rows === 1 || actual.cols === 1 ? pairs - 1 : (actual.rows - 1) * (actual.cols - 1)
  if (df <= 0) return ERR_VAL('#DIV/0!')
  return probability(regularizedGammaQ(df / 2, chi2 / 2))
}

const F_TEST: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const xs = collectNumbers([args[0]])
  if (!xs.ok) return xs.err
  const ys = collectNumbers([args[1]])
  if (!ys.ok) return ys.err
  const varX = sampleVariance(xs.values)
  const varY = sampleVariance(ys.values)
  if (varX === undefined || varY === undefined || varX === 0 || varY === 0) return ERR_VAL('#DIV/0!')
  const pRight = 1 - fCdf(varX / varY, xs.values.length - 1, ys.values.length - 1)
  return probability(2 * Math.min(pRight, 1 - pRight))
}

const T_TEST: FunctionImpl = (args) => {
  if (args.length !== 4) return ERR_VAL('#VALUE!')
  const tailsRaw = numberArg(args[2])
  if (!tailsRaw.ok) return tailsRaw.err
  const typeRaw = numberArg(args[3])
  if (!typeRaw.ok) return typeRaw.err
  const tails = integerValue(tailsRaw.value)
  const testType = integerValue(typeRaw.value)
  if (tails === undefined || testType === undefined || (tails !== 1 && tails !== 2) || testType < 1 || testType > 3) {
    return ERR_VAL('#NUM!')
  }

  let tStat: number
  let df: number
  if (testType === 1) {
    const pairs = collectNumberPairs(args[0], args[1])
    if (!pairs.ok) return pairs.err
    if (pairs.pairs.length < 2) return ERR_VAL('#DIV/0!')
    const diffs = pairs.pairs.map((pair) => pair.x - pair.y)
    const variance = sampleVariance(diffs)
    if (variance === undefined || variance === 0) return ERR_VAL('#DIV/0!')
    tStat = meanOf(diffs) / Math.sqrt(variance / diffs.length)
    df = diffs.length - 1
  } else {
    const xs = collectNumbers([args[0]])
    if (!xs.ok) return xs.err
    const ys = collectNumbers([args[1]])
    if (!ys.ok) return ys.err
    const varX = sampleVariance(xs.values)
    const varY = sampleVariance(ys.values)
    if (varX === undefined || varY === undefined) return ERR_VAL('#DIV/0!')
    const meanX = meanOf(xs.values)
    const meanY = meanOf(ys.values)
    const n1 = xs.values.length
    const n2 = ys.values.length
    if (testType === 2) {
      const pooled = ((n1 - 1) * varX + (n2 - 1) * varY) / (n1 + n2 - 2)
      if (pooled <= 0) return ERR_VAL('#DIV/0!')
      tStat = (meanX - meanY) / Math.sqrt(pooled * (1 / n1 + 1 / n2))
      df = n1 + n2 - 2
    } else {
      const seSq = varX / n1 + varY / n2
      if (seSq <= 0) return ERR_VAL('#DIV/0!')
      const dfDen = (varX / n1) ** 2 / (n1 - 1) + (varY / n2) ** 2 / (n2 - 1)
      if (dfDen <= 0) return ERR_VAL('#DIV/0!')
      tStat = (meanX - meanY) / Math.sqrt(seSq)
      df = (seSq * seSq) / dfDen
    }
  }
  if (!Number.isFinite(df) || df <= 0) return ERR_VAL('#NUM!')
  const pOne = 1 - studentTCdf(Math.abs(tStat), df)
  return probability(tails === 1 ? pOne : 2 * pOne)
}

const FREQUENCY: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const data = collectNumbers([args[0]])
  if (!data.ok) return data.err
  const bins = collectNumbers([args[1]])
  if (!bins.ok) return bins.err
  const sortedBins = bins.values.slice().sort((a, b) => a - b)
  const counts = new Array<number>(sortedBins.length + 1).fill(0)
  for (const value of data.values) {
    let bucket = sortedBins.length
    for (let i = 0; i < sortedBins.length; i++) {
      if (value <= sortedBins[i]) {
        bucket = i
        break
      }
    }
    counts[bucket]++
  }
  return { kind: 'array', value: counts.map((count) => [NUM(count)]) }
}

interface NumberMatrixResult {
  readonly ok: true
  readonly rows: number[][]
}

interface MatrixErrorResult {
  readonly ok: false
  readonly err: Value
}

type MatrixResult = NumberMatrixResult | MatrixErrorResult

function matrixArg(value: Value): MatrixResult {
  const convert = (cell: Value): NumberArg => {
    if (cell.kind === 'string') return { ok: false, err: ERR_VAL('#VALUE!') }
    return numberArg(cell)
  }
  if (value.kind !== 'array') {
    const scalar = convert(value)
    if (!scalar.ok) return { ok: false, err: scalar.err }
    return { ok: true, rows: [[scalar.value]] }
  }
  if (value.value.length === 0 || value.value[0].length === 0) {
    return { ok: false, err: ERR_VAL('#VALUE!') }
  }
  const cols = value.value[0].length
  const rows: number[][] = []
  for (const row of value.value) {
    if (row.length !== cols) return { ok: false, err: ERR_VAL('#VALUE!') }
    const outRow: number[] = []
    for (const cell of row) {
      const n = convert(cell)
      if (!n.ok) return { ok: false, err: n.err }
      outRow.push(n.value)
    }
    rows.push(outRow)
  }
  return { ok: true, rows }
}

function transposeMatrix(matrix: ReadonlyArray<ReadonlyArray<number>>): number[][] {
  const rows = matrix.length
  const cols = matrix[0].length
  const out: number[][] = Array.from({ length: cols }, () => new Array<number>(rows).fill(0))
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out[c][r] = matrix[r][c]
  }
  return out
}

function extractKnownY(value: Value): { ok: true; values: number[]; vertical: boolean } | MatrixErrorResult {
  const matrix = matrixArg(value)
  if (!matrix.ok) return matrix
  const rows = matrix.rows.length
  const cols = matrix.rows[0].length
  if (rows === 1) return { ok: true, values: matrix.rows[0].slice(), vertical: false }
  if (cols === 1) return { ok: true, values: matrix.rows.map((row) => row[0]), vertical: true }
  return { ok: false, err: ERR_VAL('#VALUE!') }
}

function extractKnownX(
  value: Value | undefined,
  requiredRows: number,
  yVertical: boolean,
): { ok: true; rows: number[][] } | MatrixErrorResult {
  if (value === undefined) {
    return {
      ok: true,
      rows: Array.from({ length: requiredRows }, (_, index) => [index + 1]),
    }
  }
  const matrix = matrixArg(value)
  if (!matrix.ok) return matrix
  const rows = matrix.rows.length
  const cols = matrix.rows[0].length
  if (yVertical) {
    if (rows === requiredRows) return { ok: true, rows: matrix.rows.map((row) => row.slice()) }
    if (cols === requiredRows) return { ok: true, rows: transposeMatrix(matrix.rows) }
    return { ok: false, err: ERR_VAL('#N/A') }
  }
  if (cols === requiredRows) return { ok: true, rows: transposeMatrix(matrix.rows) }
  if (rows === requiredRows) return { ok: true, rows: matrix.rows.map((row) => row.slice()) }
  return { ok: false, err: ERR_VAL('#N/A') }
}

function invertMatrix(input: ReadonlyArray<ReadonlyArray<number>>): number[][] | undefined {
  const n = input.length
  if (n === 0 || input.some((row) => row.length !== n)) return undefined
  const a = input.map((row) => row.slice())
  const inv: number[][] = Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => (r === c ? 1 : 0)),
  )
  for (let i = 0; i < n; i++) {
    let pivot = i
    let pivotValue = Math.abs(a[i][i])
    for (let r = i + 1; r < n; r++) {
      const value = Math.abs(a[r][i])
      if (value > pivotValue) {
        pivotValue = value
        pivot = r
      }
    }
    if (pivotValue < 1e-12) return undefined
    if (pivot !== i) {
      const aRow = a[i]
      a[i] = a[pivot]
      a[pivot] = aRow
      const invRow = inv[i]
      inv[i] = inv[pivot]
      inv[pivot] = invRow
    }
    const divisor = a[i][i]
    for (let c = 0; c < n; c++) {
      a[i][c] /= divisor
      inv[i][c] /= divisor
    }
    for (let r = 0; r < n; r++) {
      if (r === i) continue
      const factor = a[r][i]
      if (factor === 0) continue
      for (let c = 0; c < n; c++) {
        a[r][c] -= factor * a[i][c]
        inv[r][c] -= factor * inv[i][c]
      }
    }
  }
  return inv
}

interface LinRegFit {
  readonly slopes: number[]
  readonly intercept: number
  readonly withIntercept: boolean
  readonly ssRes: number
  readonly ssTot: number
  readonly se: number[]
  readonly seIntercept: number
  readonly df: number
  readonly kVars: number
}

function linregCore(
  xs: ReadonlyArray<ReadonlyArray<number>>,
  ys: ReadonlyArray<number>,
  withIntercept: boolean,
): { ok: true; fit: LinRegFit } | MatrixErrorResult {
  const n = ys.length
  if (n === 0 || xs.length !== n) return { ok: false, err: ERR_VAL('#N/A') }
  const k = xs[0].length
  if (k === 0 || xs.some((row) => row.length !== k)) return { ok: false, err: ERR_VAL('#N/A') }
  const pEff = k + (withIntercept ? 1 : 0)
  if (n < pEff) return { ok: false, err: ERR_VAL('#N/A') }
  const design: number[][] = Array.from({ length: n }, () => new Array<number>(pEff).fill(0))
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < k; c++) design[r][c] = xs[r][c]
    if (withIntercept) design[r][pEff - 1] = 1
  }

  const xtx: number[][] = Array.from({ length: pEff }, () => new Array<number>(pEff).fill(0))
  const xty = new Array<number>(pEff).fill(0)
  for (let i = 0; i < pEff; i++) {
    for (let j = 0; j < pEff; j++) {
      let total = 0
      for (let r = 0; r < n; r++) total += design[r][i] * design[r][j]
      xtx[i][j] = total
    }
    let total = 0
    for (let r = 0; r < n; r++) total += design[r][i] * ys[r]
    xty[i] = total
  }

  const inverse = invertMatrix(xtx)
  if (!inverse) return { ok: false, err: ERR_VAL('#NUM!') }
  const betas = inverse.map((row) => row.reduce((sum, value, index) => sum + value * xty[index], 0))
  const slopes = betas.slice(0, k)
  const intercept = withIntercept ? betas[pEff - 1] : 0
  const predicted = xs.map((row) => {
    let yHat = withIntercept ? intercept : 0
    for (let c = 0; c < k; c++) yHat += row[c] * slopes[c]
    return yHat
  })
  const yMean = meanOf(ys)
  let ssRes = 0
  let ssTot = 0
  for (let i = 0; i < n; i++) {
    const residual = ys[i] - predicted[i]
    ssRes += residual * residual
    const centered = withIntercept ? ys[i] - yMean : ys[i]
    ssTot += centered * centered
  }
  const df = n - pEff
  const mse = df > 0 ? ssRes / df : 0
  const se = slopes.map((_, index) => {
    const variance = inverse[index][index] * mse
    return variance > 0 ? Math.sqrt(variance) : 0
  })
  const seIntercept = withIntercept && df > 0 ? Math.sqrt(Math.max(inverse[pEff - 1][pEff - 1] * mse, 0)) : 0
  return {
    ok: true,
    fit: {
      slopes,
      intercept,
      withIntercept,
      ssRes,
      ssTot,
      se,
      seIntercept,
      df,
      kVars: k,
    },
  }
}

function linestArray(fit: LinRegFit, stats: boolean, expCoefs: boolean): Value {
  const cols = fit.kVars + 1
  const firstRow: Value[] = []
  for (let i = 0; i < fit.kVars; i++) {
    const slope = fit.slopes[fit.kVars - 1 - i]
    firstRow.push(NUM(expCoefs ? Math.exp(slope) : slope))
  }
  firstRow.push(NUM(expCoefs ? Math.exp(fit.intercept) : fit.intercept))
  if (!stats) return { kind: 'array', value: [firstRow] }

  const rows: Value[][] = [firstRow]
  const seRow: Value[] = []
  for (let i = 0; i < fit.kVars; i++) seRow.push(NUM(fit.se[fit.kVars - 1 - i]))
  seRow.push(NUM(fit.seIntercept))
  rows.push(seRow)

  const r2 = fit.ssTot > 0 ? 1 - fit.ssRes / fit.ssTot : 0
  const seY = fit.df > 0 ? Math.sqrt(fit.ssRes / fit.df) : 0
  rows.push([NUM(r2), NUM(seY), ...Array.from({ length: Math.max(0, cols - 2) }, () => ERR_VAL('#N/A'))])

  const ssReg = Math.max(fit.ssTot - fit.ssRes, 0)
  const fStat = fit.kVars > 0 && fit.df > 0 && fit.ssRes > 0 ? (ssReg / fit.kVars) / (fit.ssRes / fit.df) : 0
  rows.push([NUM(fStat), NUM(fit.df), ...Array.from({ length: Math.max(0, cols - 2) }, () => ERR_VAL('#N/A'))])
  rows.push([NUM(ssReg), NUM(fit.ssRes), ...Array.from({ length: Math.max(0, cols - 2) }, () => ERR_VAL('#N/A'))])
  return { kind: 'array', value: rows }
}

function linestFlags(args: Value[], offset: number): { ok: true; withIntercept: boolean; stats: boolean } | MatrixErrorResult {
  let withIntercept = true
  let stats = false
  if (args.length > offset) {
    const flag = booleanArg(args[offset])
    if (!flag.ok) return { ok: false, err: flag.err }
    withIntercept = flag.value
  }
  if (args.length > offset + 1) {
    const flag = booleanArg(args[offset + 1])
    if (!flag.ok) return { ok: false, err: flag.err }
    stats = flag.value
  }
  return { ok: true, withIntercept, stats }
}

function lineEst(args: Value[], logY: boolean): Value {
  if (args.length < 1 || args.length > 4) return ERR_VAL('#VALUE!')
  const y = extractKnownY(args[0])
  if (!y.ok) return y.err
  const ys = y.values.slice()
  if (logY) {
    for (let i = 0; i < ys.length; i++) {
      if (ys[i] <= 0) return ERR_VAL('#NUM!')
      ys[i] = Math.log(ys[i])
    }
  }
  const x = extractKnownX(args.length >= 2 ? args[1] : undefined, ys.length, y.vertical)
  if (!x.ok) return x.err
  const flags = linestFlags(args, 2)
  if (!flags.ok) return flags.err
  const fit = linregCore(x.rows, ys, flags.withIntercept)
  if (!fit.ok) return fit.err
  return linestArray(fit.fit, flags.stats, logY)
}

function trendGrowth(args: Value[], logY: boolean): Value {
  if (args.length < 1 || args.length > 4) return ERR_VAL('#VALUE!')
  const y = extractKnownY(args[0])
  if (!y.ok) return y.err
  const ys = y.values.slice()
  if (logY) {
    for (let i = 0; i < ys.length; i++) {
      if (ys[i] <= 0) return ERR_VAL('#NUM!')
      ys[i] = Math.log(ys[i])
    }
  }
  const x = extractKnownX(args.length >= 2 ? args[1] : undefined, ys.length, y.vertical)
  if (!x.ok) return x.err
  let withIntercept = true
  if (args.length >= 4) {
    const flag = booleanArg(args[3])
    if (!flag.ok) return flag.err
    withIntercept = flag.value
  }
  const fit = linregCore(x.rows, ys, withIntercept)
  if (!fit.ok) return fit.err

  let newXs: number[][]
  if (args.length >= 3) {
    const matrix = matrixArg(args[2])
    if (!matrix.ok) return matrix.err
    const rows = matrix.rows.length
    const cols = matrix.rows[0].length
    const k = fit.fit.kVars
    if (cols === k) {
      newXs = matrix.rows.map((row) => row.slice())
    } else if (rows === k) {
      newXs = transposeMatrix(matrix.rows)
    } else if (k === 1 && (rows === 1 || cols === 1)) {
      newXs = rows === 1 ? matrix.rows[0].map((value) => [value]) : matrix.rows.map((row) => [row[0]])
    } else {
      return ERR_VAL('#N/A')
    }
  } else {
    newXs = x.rows.map((row) => row.slice())
  }

  const predictions = newXs.map((row) => {
    let yHat = fit.fit.withIntercept ? fit.fit.intercept : 0
    for (let c = 0; c < fit.fit.kVars; c++) yHat += row[c] * fit.fit.slopes[c]
    return NUM(logY ? Math.exp(yHat) : yHat)
  })
  return {
    kind: 'array',
    value: y.vertical ? predictions.map((value) => [value]) : [predictions],
  }
}

const LINEST: FunctionImpl = (args) => lineEst(args, false)
const LOGEST: FunctionImpl = (args) => lineEst(args, true)
const TREND: FunctionImpl = (args) => trendGrowth(args, false)
const GROWTH: FunctionImpl = (args) => trendGrowth(args, true)

const STEYX: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const pairs = collectNumberPairs(args[1], args[0])
  if (!pairs.ok) return pairs.err
  if (pairs.pairs.length < 3) return ERR_VAL('#DIV/0!')
  const { sxx, sxy, syy } = regressionSums(pairs.pairs)
  if (sxx === 0) return ERR_VAL('#DIV/0!')
  const variance = Math.max((syy - (sxy * sxy) / sxx) / (pairs.pairs.length - 2), 0)
  return finiteNumber(Math.sqrt(variance))
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const FUNCTIONS: Record<string, FunctionImpl> = {
  COUNTIF,
  SUMIF,
  COUNTIFS,
  SUMIFS,
  // Phase 8 additions
  MEDIAN,
  MODE,
  'MODE.SNGL': MODE,
  'MODE.MULT': MODE_MULT,
  STDEV,
  'STDEV.S': STDEV,
  STDEVP,
  'STDEV.P': STDEVP,
  VAR,
  'VAR.S': VAR,
  VARP,
  'VAR.P': VARP,
  LARGE,
  SMALL,
  PERCENTILE,
  'PERCENTILE.INC': PERCENTILE,
  'PERCENTILE.EXC': PERCENTILE_EXC,
  QUARTILE,
  'QUARTILE.INC': QUARTILE,
  'QUARTILE.EXC': QUARTILE_EXC,
  RANK,
  RANKEQ: RANK,
  'RANK.EQ': RANK,
  RANKAVG: RANK_AVG,
  'RANK.AVG': RANK_AVG,
  AVERAGEIF,
  AVERAGEIFS,
  MAXIFS,
  MINIFS,
  CORREL,
  PEARSON: CORREL,
  COVAR: COVARIANCE_P,
  'COVAR.P': COVARIANCE_P,
  'COVAR.S': COVARIANCE_S,
  'COVARIANCE.P': COVARIANCE_P,
  'COVARIANCE.S': COVARIANCE_S,
  SLOPE,
  INTERCEPT,
  AVERAGEA,
  AVEDEV,
  DEVSQ,
  MAXA,
  MINA,
  STDEVA,
  STDEVPA,
  VARA,
  VARPA,
  STANDARDIZE,
  GEOMEAN,
  HARMEAN,
  TRIMMEAN,
  FISHER,
  FISHERINV,
  RSQ,
  SKEW,
  'SKEW.P': SKEW_P,
  KURT,
  FORECAST,
  'FORECAST.LINEAR': FORECAST,
  STEYX,
  TREND,
  GROWTH,
  LINEST,
  LOGEST,
  PERCENTRANK,
  'PERCENTRANK.INC': PERCENTRANK,
  'PERCENTRANK.EXC': PERCENTRANK_EXC,
  PROB,
  FREQUENCY,
  'NORM.DIST': NORM_DIST,
  'NORM.S.DIST': NORM_S_DIST,
  'NORM.INV': NORM_INV,
  'NORM.S.INV': NORM_S_INV,
  NORMDIST: NORM_DIST,
  NORMSDIST,
  NORMINV: NORM_INV,
  NORMSINV: NORM_S_INV,
  'LOGNORM.DIST': LOGNORM_DIST,
  'LOGNORM.INV': LOGNORM_INV,
  LOGNORMDIST,
  LOGINV: LOGNORM_INV,
  'EXPON.DIST': EXPON_DIST,
  EXPONDIST: EXPON_DIST,
  'POISSON.DIST': POISSON_DIST,
  POISSON: POISSON_DIST,
  'WEIBULL.DIST': WEIBULL_DIST,
  WEIBULL: WEIBULL_DIST,
  'T.DIST': T_DIST,
  'T.DIST.RT': T_DIST_RT,
  'T.DIST.2T': T_DIST_2T,
  'T.INV': T_INV,
  'T.INV.2T': T_INV_2T,
  TDIST,
  TINV: T_INV_2T,
  'T.TEST': T_TEST,
  TTEST: T_TEST,
  'F.DIST': F_DIST,
  'F.DIST.RT': F_DIST_RT,
  'F.INV': F_INV,
  'F.INV.RT': F_INV_RT,
  FDIST: F_DIST_RT,
  FINV: F_INV_RT,
  'F.TEST': F_TEST,
  FTEST: F_TEST,
  'CHISQ.DIST': CHISQ_DIST,
  'CHISQ.DIST.RT': CHISQ_DIST_RT,
  'CHISQ.INV': CHISQ_INV,
  'CHISQ.INV.RT': CHISQ_INV_RT,
  CHIDIST: CHISQ_DIST_RT,
  CHIINV: CHISQ_INV_RT,
  'CHISQ.TEST': CHISQ_TEST,
  CHITEST: CHISQ_TEST,
  'BETA.DIST': BETA_DIST,
  'BETA.INV': BETA_INV,
  BETADIST,
  BETAINV: BETA_INV,
  'GAMMA.DIST': GAMMA_DIST,
  'GAMMA.INV': GAMMA_INV,
  GAMMADIST: GAMMA_DIST,
  GAMMAINV: GAMMA_INV,
  GAMMA: GAMMA_FUNC,
  GAMMALN,
  'GAMMALN.PRECISE': GAMMALN,
  'BINOM.DIST': BINOM_DIST,
  'BINOM.DIST.RANGE': BINOM_DIST_RANGE,
  'BINOM.INV': BINOM_INV,
  BINOMDIST: BINOM_DIST,
  CRITBINOM: BINOM_INV,
  'HYPGEOM.DIST': HYPGEOM_DIST,
  HYPGEOMDIST,
  'NEGBINOM.DIST': NEGBINOM_DIST,
  NEGBINOMDIST,
  PHI,
  GAUSS,
  'Z.TEST': Z_TEST,
  ZTEST: Z_TEST,
  'CONFIDENCE.NORM': CONFIDENCE_NORM,
  CONFIDENCE: CONFIDENCE_NORM,
  'CONFIDENCE.T': CONFIDENCE_T,
}

// Re-export `EvalContext` for parity with the FunctionImpl contract;
// the helpers above do not consult `ctx` because args arrive pre-resolved.
export type { EvalContext }
