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
// Phase 8 additions — descriptive stats
// ---------------------------------------------------------------------------

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const ERR_VAL = (
  code: '#DIV/0!' | '#N/A' | '#NUM!' | '#VALUE!',
  message?: string,
): Value => (message ? { kind: 'error', code, message } : { kind: 'error', code })

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

/** AVERAGEIF(range, criterion, [averageRange]) */
const AVERAGEIF: FunctionImpl = (args, _ctx) => {
  if (args.length < 2 || args.length > 3) return ERR_VAL('#VALUE!')
  const [range, criterion, avgRange] = args
  const parsed = parseCriterion(criterion)
  if ('error' in parsed) return parsed.error
  const checkCells = flatten(range)
  const sumCells = avgRange ? flatten(avgRange) : checkCells
  const n = Math.min(checkCells.length, sumCells.length)
  let total = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    const probe = checkCells[i]
    if (probe.kind === 'error') continue
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
  for (const arr of pairs.flats) {
    if (arr.length !== len) return ERR_VAL('#VALUE!')
  }
  let total = 0
  let count = 0
  outer: for (let i = 0; i < len; i++) {
    for (let j = 0; j < pairs.flats.length; j++) {
      const cell = pairs.flats[j][i]
      if (cell.kind === 'error') continue outer
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
  for (const arr of pairs.flats) {
    if (arr.length !== len) return ERR_VAL('#VALUE!')
  }
  let best = Number.NEGATIVE_INFINITY
  let seen = false
  outer: for (let i = 0; i < len; i++) {
    for (let j = 0; j < pairs.flats.length; j++) {
      const cell = pairs.flats[j][i]
      if (cell.kind === 'error') continue outer
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
  for (const arr of pairs.flats) {
    if (arr.length !== len) return ERR_VAL('#VALUE!')
  }
  let best = Number.POSITIVE_INFINITY
  let seen = false
  outer: for (let i = 0; i < len; i++) {
    for (let j = 0; j < pairs.flats.length; j++) {
      const cell = pairs.flats[j][i]
      if (cell.kind === 'error') continue outer
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
  const a = collectNumbers([args[0]])
  if (!a.ok) return a.err
  const b = collectNumbers([args[1]])
  if (!b.ok) return b.err
  if (a.values.length !== b.values.length) return ERR_VAL('#N/A')
  if (a.values.length === 0) return ERR_VAL('#DIV/0!')
  const n = a.values.length
  const meanA = a.values.reduce((s, x) => s + x, 0) / n
  const meanB = b.values.reduce((s, x) => s + x, 0) / n
  let cov = 0
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    const da = a.values[i] - meanA
    const db = b.values[i] - meanB
    cov += da * db
    sa += da * da
    sb += db * db
  }
  if (sa === 0 || sb === 0) return ERR_VAL('#DIV/0!')
  return NUM(cov / Math.sqrt(sa * sb))
}

/** SLOPE(known_ys, known_xs) — linear regression slope. */
const SLOPE: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const ys = collectNumbers([args[0]])
  if (!ys.ok) return ys.err
  const xs = collectNumbers([args[1]])
  if (!xs.ok) return xs.err
  if (ys.values.length !== xs.values.length) return ERR_VAL('#N/A')
  const n = ys.values.length
  if (n < 2) return ERR_VAL('#DIV/0!')
  const meanX = xs.values.reduce((s, x) => s + x, 0) / n
  const meanY = ys.values.reduce((s, y) => s + y, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = xs.values[i] - meanX
    num += dx * (ys.values[i] - meanY)
    den += dx * dx
  }
  if (den === 0) return ERR_VAL('#DIV/0!')
  return NUM(num / den)
}

/** INTERCEPT(known_ys, known_xs) — y-intercept of linear regression. */
const INTERCEPT: FunctionImpl = (args) => {
  if (args.length !== 2) return ERR_VAL('#VALUE!')
  const ys = collectNumbers([args[0]])
  if (!ys.ok) return ys.err
  const xs = collectNumbers([args[1]])
  if (!xs.ok) return xs.err
  if (ys.values.length !== xs.values.length) return ERR_VAL('#N/A')
  const n = ys.values.length
  if (n < 2) return ERR_VAL('#DIV/0!')
  const meanX = xs.values.reduce((s, x) => s + x, 0) / n
  const meanY = ys.values.reduce((s, y) => s + y, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = xs.values[i] - meanX
    num += dx * (ys.values[i] - meanY)
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
  STDEV,
  STDEVP,
  VAR,
  VARP,
  LARGE,
  SMALL,
  PERCENTILE,
  QUARTILE,
  RANK,
  AVERAGEIF,
  AVERAGEIFS,
  MAXIFS,
  MINIFS,
  CORREL,
  SLOPE,
  INTERCEPT,
  AVERAGEA,
}

// Re-export `EvalContext` for parity with the FunctionImpl contract;
// the helpers above do not consult `ctx` because args arrive pre-resolved.
export type { EvalContext }
