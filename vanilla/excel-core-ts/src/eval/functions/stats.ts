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
import { toNumber } from '../coerce'

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
    const n = Number(trimmed)
    if (Number.isFinite(n) && /^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) {
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

/** Coerce to a number for ordered comparison; return undefined if no clean coercion. */
function numericComparable(v: Value): number | undefined {
  if (v.kind === 'number') return v.value
  if (v.kind === 'boolean') return v.value ? 1 : 0
  // Strings / blanks / arrays / errors are not ordered against numbers in
  // Excel's criteria semantics.
  return undefined
}

/**
 * Scalar equality used by `=` / `<>`. Type-aware: a number cell never
 * equals a string criterion. Blank vs. empty string is distinct.
 */
function scalarEquals(a: Value, b: Value): boolean {
  if (a.kind === 'error' || b.kind === 'error') return false
  if (a.kind === 'blank' && b.kind === 'blank') return true
  if (a.kind === 'blank' && b.kind === 'string' && b.value === '') return true
  if (b.kind === 'blank' && a.kind === 'string' && a.value === '') return true
  if (a.kind === 'blank' || b.kind === 'blank') return false
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

  // Verify uniform shape.
  const len = pairs.flats[0].length
  for (const arr of pairs.flats) {
    if (arr.length !== len) {
      return { kind: 'error', code: '#VALUE!', message: 'COUNTIFS ranges must share shape' }
    }
  }

  let count = 0
  outer: for (let i = 0; i < len; i++) {
    for (let j = 0; j < pairs.flats.length; j++) {
      const cell = pairs.flats[j][i]
      if (cell.kind === 'error') continue outer
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
  for (const arr of pairs.flats) {
    if (arr.length !== len) {
      return { kind: 'error', code: '#VALUE!', message: 'SUMIFS ranges must share shape' }
    }
  }

  let total = 0
  outer: for (let i = 0; i < len; i++) {
    for (let j = 0; j < pairs.flats.length; j++) {
      const cell = pairs.flats[j][i]
      if (cell.kind === 'error') continue outer
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
): { flats: Value[][]; parsed: ParsedCriterion[] } | { error: Value } {
  const flats: Value[][] = []
  const parsed: ParsedCriterion[] = []
  for (let i = 0; i < args.length; i += 2) {
    const rangeArg = args[i]
    const critArg = args[i + 1]
    const p = parseCriterion(critArg)
    if ('error' in p) return { error: p.error }
    flats.push(flatten(rangeArg))
    parsed.push(p)
  }
  return { flats, parsed }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const FUNCTIONS: Record<string, FunctionImpl> = {
  COUNTIF,
  SUMIF,
  COUNTIFS,
  SUMIFS,
}

// Re-export `EvalContext` for parity with the FunctionImpl contract;
// the helpers above do not consult `ctx` because args arrive pre-resolved.
export type { EvalContext }
