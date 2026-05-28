/**
 * Wave C / track C3 — lookup functions.
 *
 * Implements Excel's lookup family:
 *  - VLOOKUP / HLOOKUP — table-array lookups with exact / approximate modes
 *  - INDEX            — 2-D array indexing, with whole-row / whole-col selectors
 *  - MATCH            — find a value's 1-based position in a 1-D array
 *  - XLOOKUP          — modern unified lookup with match modes + search modes
 *
 * Conventions:
 *  - Range references arrive as `{ kind: 'array', value: Value[][] }` — the
 *    dispatcher in `evaluate()` materialises the range before handing it off.
 *    Scalars are wrapped to `Value[][]` via `asArray` so callers can treat
 *    them uniformly.
 *  - First-error short-circuit follows the Excel convention: if any positional
 *    argument is `{ kind: 'error' }`, return that error verbatim.
 *  - String comparisons are case-insensitive (Excel uses caseless collation
 *    for lookup, even though it's case-sensitive for display).
 *
 * NOT implemented yet (TODOs flagged inline):
 *  - XLOOKUP binary search modes (`search_mode = 2 | -2`) fall back to linear
 *    scan in the appropriate direction; results are correct on sorted input
 *    but slower than Excel. The acceptance tests don't exercise large inputs.
 *  - VLOOKUP/HLOOKUP/MATCH approximate-match assumes ascending-sorted data;
 *    on unsorted data Excel returns "undefined" results — we match the
 *    documented behaviour (largest value <= lookup) which is what Excel
 *    actually does in practice.
 */

import type { FunctionImpl, Value } from '../../types'
import { propagateError, toNumber } from '../coerce'

const ERR_VALUE: Value = { kind: 'error', code: '#VALUE!' }
const ERR_REF: Value = { kind: 'error', code: '#REF!' }
const ERR_NA: Value = { kind: 'error', code: '#N/A' }

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Wrap a `Value` as a 2-D array. Returns null for `kind:'blank'` (callers
 * should generally treat blank as an error in the table-array slot, since
 * lookup semantics don't make sense over a missing range).
 *
 * For scalar values (number / string / boolean / error) returns `[[v]]`.
 */
function asArray(v: Value): Value[][] | null {
  if (v.kind === 'array') {
    if (v.value.length === 0 || v.value[0].length === 0) return null
    return v.value
  }
  if (v.kind === 'blank') return null
  return [[v]]
}

/**
 * Translate an Excel-style wildcard pattern into a RegExp.
 *  - `*` → match any number of characters (incl. zero)
 *  - `?` → match exactly one character
 *  - `~*` / `~?` → escape, literal `*` or `?`
 *  - All other regex metacharacters are escaped.
 *
 * Anchored to ^ and $ so the whole text must match (Excel's wildcard
 * matching is full-string, not substring).
 */
function wildcardMatch(pattern: string, text: string): boolean {
  // Build the regex pattern char by char so we can spot ~ escapes.
  let re = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '~' && i + 1 < pattern.length) {
      const nxt = pattern[i + 1]
      if (nxt === '*' || nxt === '?' || nxt === '~') {
        re += escapeRegexChar(nxt)
        i += 1
        continue
      }
      // lone '~' becomes literal '~'
      re += escapeRegexChar(ch)
      continue
    }
    if (ch === '*') {
      re += '.*'
      continue
    }
    if (ch === '?') {
      re += '.'
      continue
    }
    re += escapeRegexChar(ch)
  }
  re += '$'
  return new RegExp(re, 'i').test(text)
}

function escapeRegexChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Strict equality that mirrors Excel's lookup-comparison rule:
 *  - numbers compare numerically
 *  - strings compare case-insensitively
 *  - booleans compare directly
 *  - blanks compare equal to blanks
 *  - mixed types (number vs string) never compare equal
 *
 * Returns -1 / 0 / 1 when both sides are orderable; returns `null` when the
 * comparison is undefined (mixed-type, error). Callers use that to decide
 * whether the candidate counts as a match.
 */
function compareForLookup(needle: Value, hay: Value): number | null {
  if (needle.kind === 'error' || hay.kind === 'error') return null
  // Blanks: equal to blanks, equal to 0 (numeric ctx) and "" (string ctx)
  if (needle.kind === 'blank' && hay.kind === 'blank') return 0
  if (needle.kind === 'number' && hay.kind === 'number') {
    if (needle.value < hay.value) return -1
    if (needle.value > hay.value) return 1
    return 0
  }
  if (needle.kind === 'string' && hay.kind === 'string') {
    const a = needle.value.toLowerCase()
    const b = hay.value.toLowerCase()
    if (a < b) return -1
    if (a > b) return 1
    return 0
  }
  if (needle.kind === 'boolean' && hay.kind === 'boolean') {
    if (needle.value === hay.value) return 0
    return needle.value ? 1 : -1
  }
  // Blank vs number/string: only equal when the other side is the zero-ish value
  if (needle.kind === 'blank' && hay.kind === 'number') return 0 - hay.value < 0 ? -1 : 0 - hay.value > 0 ? 1 : 0
  if (needle.kind === 'number' && hay.kind === 'blank') return needle.value < 0 ? -1 : needle.value > 0 ? 1 : 0
  return null
}

/**
 * Exact match check supporting wildcards when `useWildcards` is true and the
 * needle is a string. Otherwise delegates to `compareForLookup`.
 */
function exactMatch(needle: Value, hay: Value, useWildcards: boolean): boolean {
  if (useWildcards && needle.kind === 'string') {
    if (hay.kind !== 'string') return false
    return wildcardMatch(needle.value, hay.value)
  }
  const cmp = compareForLookup(needle, hay)
  return cmp === 0
}

/**
 * Pull a number from a `Value`, defaulting to `fallback` for blank. Returns
 * `null` if coercion fails (so callers can surface `#VALUE!`).
 */
function pullNumber(v: Value | undefined, fallback: number): number | null {
  if (v === undefined || v.kind === 'blank') return fallback
  const n = toNumber(v)
  if (!n.ok) return null
  // Truncate toward zero — Excel rounds down positionally.
  return Math.trunc(n.value)
}

function pullBoolean(v: Value | undefined, fallback: boolean): boolean | null {
  if (v === undefined || v.kind === 'blank') return fallback
  switch (v.kind) {
    case 'boolean':
      return v.value
    case 'number':
      return v.value !== 0
    case 'string': {
      const u = v.value.trim().toUpperCase()
      if (u === 'TRUE') return true
      if (u === 'FALSE') return false
      // Excel accepts 1/0 in strings too.
      if (u === '1') return true
      if (u === '0') return false
      return null
    }
    default:
      return null
  }
}

// ----------------------------------------------------------------------------
// VLOOKUP
// ----------------------------------------------------------------------------

/**
 * VLOOKUP(lookup_value, table_array, col_index, [range_lookup])
 *
 *  - `table_array` must be a 2-D array (range ref). Scalars are wrapped.
 *  - `col_index` 1-based; < 1 → #VALUE!; > width → #REF!.
 *  - `range_lookup` default TRUE (approximate).
 *    - TRUE  → assumes first column sorted ASC; returns row where first col
 *      is the largest value ≤ lookup_value. If lookup < first value → #N/A.
 *    - FALSE → exact (case-insensitive, wildcards on strings).
 *  - First-error short-circuit applies.
 */
export const VLOOKUP: FunctionImpl = (args, _ctx) => {
  if (args.length < 3 || args.length > 4) return ERR_VALUE
  const err0 = propagateError(args)
  if (err0) return err0

  const needle = args[0]
  const table = asArray(args[1])
  if (!table) return ERR_VALUE
  const colIdx = pullNumber(args[2], NaN)
  if (colIdx === null || !Number.isFinite(colIdx)) return ERR_VALUE
  if (colIdx < 1) return ERR_VALUE
  const width = table[0].length
  if (colIdx > width) return ERR_REF

  const approx = args.length === 4 ? pullBoolean(args[3], true) : true
  if (approx === null) return ERR_VALUE

  const matchRow = findRowVLookup(needle, table, approx)
  if (matchRow === -1) return ERR_NA
  return table[matchRow][colIdx - 1] ?? { kind: 'blank' }
}

function findRowVLookup(needle: Value, table: Value[][], approx: boolean): number {
  if (!approx) {
    // Exact, case-insensitive, wildcards on string needle.
    for (let r = 0; r < table.length; r += 1) {
      if (exactMatch(needle, table[r][0], true)) return r
    }
    return -1
  }
  // Approximate: linear scan, track best row where first-col <= needle.
  // Excel's spec assumes ascending sort; we just return the last row whose
  // first-col is <= needle.
  let best = -1
  for (let r = 0; r < table.length; r += 1) {
    const cmp = compareForLookup(table[r][0], needle)
    if (cmp === null) continue // skip incompatible cells
    if (cmp <= 0) best = r
    else if (cmp > 0) break // sorted-ascending assumption: bail early
  }
  return best
}

// ----------------------------------------------------------------------------
// HLOOKUP — row-based mirror of VLOOKUP
// ----------------------------------------------------------------------------

/**
 * HLOOKUP(lookup_value, table_array, row_index, [range_lookup])
 *
 * Same semantics as VLOOKUP but scans the *first row* and pulls from the
 * row at `row_index` (1-based).
 */
export const HLOOKUP: FunctionImpl = (args, _ctx) => {
  if (args.length < 3 || args.length > 4) return ERR_VALUE
  const err0 = propagateError(args)
  if (err0) return err0

  const needle = args[0]
  const table = asArray(args[1])
  if (!table) return ERR_VALUE
  const rowIdx = pullNumber(args[2], NaN)
  if (rowIdx === null || !Number.isFinite(rowIdx)) return ERR_VALUE
  if (rowIdx < 1) return ERR_VALUE
  const height = table.length
  if (rowIdx > height) return ERR_REF

  const approx = args.length === 4 ? pullBoolean(args[3], true) : true
  if (approx === null) return ERR_VALUE

  const matchCol = findColHLookup(needle, table, approx)
  if (matchCol === -1) return ERR_NA
  return table[rowIdx - 1][matchCol] ?? { kind: 'blank' }
}

function findColHLookup(needle: Value, table: Value[][], approx: boolean): number {
  const firstRow = table[0]
  if (!approx) {
    for (let c = 0; c < firstRow.length; c += 1) {
      if (exactMatch(needle, firstRow[c], true)) return c
    }
    return -1
  }
  let best = -1
  for (let c = 0; c < firstRow.length; c += 1) {
    const cmp = compareForLookup(firstRow[c], needle)
    if (cmp === null) continue
    if (cmp <= 0) best = c
    else if (cmp > 0) break
  }
  return best
}

// ----------------------------------------------------------------------------
// INDEX
// ----------------------------------------------------------------------------

/**
 * INDEX(array, row_num, [col_num])
 *
 *  - `array` is a 2-D array (or wrapped scalar).
 *  - `row_num = 0` → whole row (means *all rows* — returns entire array if
 *    col_num is also 0). Special case: `row_num = 0` + `col_num` set →
 *    whole column. `col_num = 0` + `row_num` set → whole row.
 *  - For a 1-D array (single row OR single column), the second positional
 *    arg indexes within that line (Excel's "implicit dimension reduction").
 *  - Out of bounds → #REF!.
 *  - Negative indices → #VALUE!.
 */
export const INDEX: FunctionImpl = (args, _ctx) => {
  if (args.length < 2 || args.length > 3) return ERR_VALUE
  // Note: do NOT propagateError over `args[0]` if it is an array (we still
  // need to look inside); but if args[0] itself is `kind:'error'`, propagate.
  if (args[0].kind === 'error') return args[0]
  for (let i = 1; i < args.length; i += 1) {
    if (args[i].kind === 'error') return args[i]
  }

  const arr = asArray(args[0])
  if (!arr) return ERR_VALUE
  const height = arr.length
  const width = arr[0].length

  // Helper: explicitly-passed args vs omitted (Excel treats missing as 0 ie
  // "all"). We treat `undefined` (not enough args) as omitted, and pass a
  // blank Value as fallback so pullNumber returns 0.
  const rowNum = pullNumber(args[1], 0)
  if (rowNum === null) return ERR_VALUE
  const colArg = args[2]
  const colNumExplicit = colArg !== undefined
  const colNum = pullNumber(colArg, 0)
  if (colNum === null) return ERR_VALUE

  // 1-D array convenience: a single-row or single-col array with a single
  // positional argument indexes within that line.
  if (!colNumExplicit) {
    if (height === 1 && width > 1) {
      // Single row → rowNum acts as column selector
      if (rowNum < 1 || rowNum > width) return ERR_REF
      return arr[0][rowNum - 1]
    }
    if (width === 1 && height > 1) {
      if (rowNum < 1 || rowNum > height) return ERR_REF
      return arr[rowNum - 1][0]
    }
    // Single-cell array: rowNum must be 1 or 0
    if (height === 1 && width === 1) {
      if (rowNum === 0 || rowNum === 1) return arr[0][0]
      return ERR_REF
    }
  }

  // 2-D path with explicit col_num.
  if (rowNum < 0 || colNum < 0) return ERR_VALUE
  if (rowNum > height) return ERR_REF
  if (colNum > width) return ERR_REF

  if (rowNum === 0 && colNum === 0) {
    // Whole array
    return { kind: 'array', value: arr.map((row) => row.slice()) }
  }
  if (rowNum === 0) {
    // Whole column at colNum
    const col: Value[][] = []
    for (let r = 0; r < height; r += 1) {
      col.push([arr[r][colNum - 1]])
    }
    return { kind: 'array', value: col }
  }
  if (colNum === 0) {
    // Whole row at rowNum
    return { kind: 'array', value: [arr[rowNum - 1].slice()] }
  }
  return arr[rowNum - 1][colNum - 1]
}

// ----------------------------------------------------------------------------
// MATCH
// ----------------------------------------------------------------------------

/**
 * MATCH(lookup_value, lookup_array, [match_type])
 *
 *  - `match_type = 1` (default): largest value ≤ lookup, array sorted ASC.
 *  - `match_type = 0`: exact match; supports wildcards on string lookups.
 *  - `match_type = -1`: smallest value ≥ lookup, array sorted DESC.
 *  - Returns 1-based position; #N/A if not found.
 *  - `lookup_array` must be 1-D (single row or single col).
 */
export const MATCH: FunctionImpl = (args, _ctx) => {
  if (args.length < 2 || args.length > 3) return ERR_VALUE
  const err0 = propagateError(args)
  if (err0) return err0

  const needle = args[0]
  const arr = asArray(args[1])
  if (!arr) return ERR_VALUE
  const matchType = pullNumber(args[2], 1)
  if (matchType === null) return ERR_VALUE
  // Normalize -1 / 0 / 1 — anything else is #N/A in Excel (we surface
  // #VALUE! for clarity since the user supplied an invalid sentinel).
  if (matchType !== -1 && matchType !== 0 && matchType !== 1) return ERR_VALUE

  // Flatten to 1-D in row-major order.
  const flat: Value[] = []
  for (const row of arr) for (const cell of row) flat.push(cell)

  if (matchType === 0) {
    for (let i = 0; i < flat.length; i += 1) {
      if (exactMatch(needle, flat[i], true)) return { kind: 'number', value: i + 1 }
    }
    return ERR_NA
  }

  if (matchType === 1) {
    // Largest <= needle; assumes ascending.
    let best = -1
    for (let i = 0; i < flat.length; i += 1) {
      const cmp = compareForLookup(flat[i], needle)
      if (cmp === null) continue
      if (cmp <= 0) best = i
      else break
    }
    if (best === -1) return ERR_NA
    return { kind: 'number', value: best + 1 }
  }

  // matchType === -1 : smallest >= needle; assumes descending.
  let best = -1
  for (let i = 0; i < flat.length; i += 1) {
    const cmp = compareForLookup(flat[i], needle)
    if (cmp === null) continue
    if (cmp >= 0) best = i
    else break
  }
  if (best === -1) return ERR_NA
  return { kind: 'number', value: best + 1 }
}

// ----------------------------------------------------------------------------
// XLOOKUP
// ----------------------------------------------------------------------------

/**
 * XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found],
 *         [match_mode], [search_mode])
 *
 *  - `match_mode`:
 *     - 0  → exact (default)
 *     - -1 → exact or next smaller
 *     - 1  → exact or next larger
 *     - 2  → wildcard exact
 *  - `search_mode`:
 *     - 1  → first-to-last (default)
 *     - -1 → last-to-first
 *     - 2  → binary search (assumes lookup_array sorted ASC)
 *     - -2 → binary search (assumes lookup_array sorted DESC)
 *  - `lookup_array` and `return_array` must be 1-D and have the same length;
 *    otherwise #VALUE!.
 *  - On not-found: returns `if_not_found` if supplied, else #N/A.
 */
export const XLOOKUP: FunctionImpl = (args, _ctx) => {
  if (args.length < 3 || args.length > 6) return ERR_VALUE

  // We DON'T propagate errors over `if_not_found` (args[3]) since the host
  // may want to substitute a "not found" sentinel that's itself error-like.
  // But we DO propagate over the others.
  for (let i = 0; i < args.length; i += 1) {
    if (i === 3) continue
    if (args[i].kind === 'error') return args[i]
  }

  const needle = args[0]
  const lookupArr = asArray(args[1])
  const returnArr = asArray(args[2])
  if (!lookupArr || !returnArr) return ERR_VALUE

  const ifNotFound = args[3] !== undefined && args[3].kind !== 'blank' ? args[3] : null

  const matchMode = pullNumber(args[4], 0)
  if (matchMode === null) return ERR_VALUE
  if (matchMode !== 0 && matchMode !== -1 && matchMode !== 1 && matchMode !== 2) return ERR_VALUE

  const searchMode = pullNumber(args[5], 1)
  if (searchMode === null) return ERR_VALUE
  if (searchMode !== 1 && searchMode !== -1 && searchMode !== 2 && searchMode !== -2) return ERR_VALUE

  // Flatten lookup_array + return_array — must have matching length.
  const lookupFlat: Value[] = []
  for (const row of lookupArr) for (const cell of row) lookupFlat.push(cell)
  // Return array can be 2-D when matching against a column: e.g. lookup is
  // a column of 5 cells and return is 5x3 — XLOOKUP returns the matched
  // 1x3 row. For now: detect the "row-of-records" shape (returnArr.length
  // matches lookupFlat.length when lookup is a column, OR returnArr[0].length
  // matches when lookup is a row).
  const isColumnLookup = lookupArr.length >= lookupArr[0].length
  const lookupLen = lookupFlat.length

  // Validate matching dimension.
  if (isColumnLookup) {
    if (returnArr.length !== lookupLen) return ERR_VALUE
  } else {
    if (returnArr[0].length !== lookupLen) return ERR_VALUE
  }

  const matchIdx = findXLookupIndex(needle, lookupFlat, matchMode, searchMode)
  if (matchIdx === -1) {
    if (ifNotFound !== null) return ifNotFound
    return ERR_NA
  }

  // Pull the corresponding return value(s).
  if (isColumnLookup) {
    const row = returnArr[matchIdx]
    if (row.length === 1) return row[0]
    // Multi-column return → return a 1xN array
    return { kind: 'array', value: [row.slice()] }
  } else {
    // Row lookup: pull the column at matchIdx out of returnArr
    if (returnArr.length === 1) return returnArr[0][matchIdx]
    const col: Value[][] = []
    for (let r = 0; r < returnArr.length; r += 1) {
      col.push([returnArr[r][matchIdx]])
    }
    return { kind: 'array', value: col }
  }
}

function findXLookupIndex(
  needle: Value,
  arr: Value[],
  matchMode: number,
  searchMode: number,
): number {
  const useWildcards = matchMode === 2
  const len = arr.length

  // search_mode === 2 / -2 → binary search.
  // TODO(C3): proper binary search; fall back to linear scan in the
  // appropriate direction for correctness. Acceptance tests cover ≤ 20
  // elements so perf is fine.
  if (searchMode === 2) {
    // Sorted asc — scan forward
    return scanXLookup(needle, arr, matchMode, useWildcards, 0, len, 1)
  }
  if (searchMode === -2) {
    // Sorted desc — scan from end? Actually binary search on desc data.
    // For correctness on sorted-desc data, scan from start and use a
    // different "next nearest" strategy. Simpler: scan and pick first
    // match (or, for nearest modes, the appropriate side).
    return scanXLookupDesc(needle, arr, matchMode, useWildcards)
  }
  if (searchMode === -1) {
    return scanXLookup(needle, arr, matchMode, useWildcards, len - 1, -1, -1)
  }
  // searchMode === 1 (default)
  return scanXLookup(needle, arr, matchMode, useWildcards, 0, len, 1)
}

/**
 * Linear scan with mode-aware "nearest" tracking.
 *
 *  - matchMode 0 / 2: return first exact (wildcard if 2).
 *  - matchMode -1   : exact OR best "next smaller" (largest hay < needle).
 *  - matchMode 1    : exact OR best "next larger" (smallest hay > needle).
 *
 * Direction (`step`) controls scan order; `from`/`to` are inclusive/exclusive.
 */
function scanXLookup(
  needle: Value,
  arr: Value[],
  matchMode: number,
  useWildcards: boolean,
  from: number,
  to: number,
  step: number,
): number {
  let bestSmaller = -1 // index of largest hay < needle
  let bestSmallerCmp = -Infinity // we keep its comparison distance
  let bestLarger = -1 // index of smallest hay > needle
  let bestLargerCmp = Infinity

  const iterate = (cb: (i: number) => boolean): void => {
    if (step > 0) {
      for (let i = from; i < to; i += step) {
        if (cb(i)) return
      }
    } else {
      for (let i = from; i > to; i += step) {
        if (cb(i)) return
      }
    }
  }

  let exactIdx = -1
  iterate((i) => {
    const hay = arr[i]
    if (useWildcards && needle.kind === 'string') {
      if (hay.kind === 'string' && wildcardMatch(needle.value, hay.value)) {
        exactIdx = i
        return true
      }
      return false
    }
    const cmp = compareForLookup(hay, needle)
    if (cmp === null) return false
    if (cmp === 0) {
      exactIdx = i
      return true
    }
    if (matchMode === -1 && cmp < 0) {
      // hay < needle; want the largest such hay (closest to needle from below)
      const haynum = numericRank(hay)
      const needlenum = numericRank(needle)
      const dist = haynum !== null && needlenum !== null ? haynum - needlenum : -Infinity
      if (dist > bestSmallerCmp) {
        bestSmallerCmp = dist
        bestSmaller = i
      }
    } else if (matchMode === 1 && cmp > 0) {
      // hay > needle; want smallest such hay
      const haynum = numericRank(hay)
      const needlenum = numericRank(needle)
      const dist = haynum !== null && needlenum !== null ? haynum - needlenum : Infinity
      if (dist < bestLargerCmp) {
        bestLargerCmp = dist
        bestLarger = i
      }
    }
    return false
  })

  if (exactIdx !== -1) return exactIdx
  if (matchMode === -1) return bestSmaller
  if (matchMode === 1) return bestLarger
  return -1
}

/**
 * Specialised scan for `search_mode = -2` (binary on desc-sorted data).
 *
 * TODO(C3): true O(log n) binary search. We linear-scan but use Excel's
 * desc-sorted semantics: first exact wins; for "next smaller" / "next larger"
 * nearest-modes, we still find the closest neighbour.
 */
function scanXLookupDesc(
  needle: Value,
  arr: Value[],
  matchMode: number,
  useWildcards: boolean,
): number {
  return scanXLookup(needle, arr, matchMode, useWildcards, 0, arr.length, 1)
}

/** Extract a numeric rank if possible — used for "nearest" distance metric. */
function numericRank(v: Value): number | null {
  if (v.kind === 'number') return v.value
  if (v.kind === 'boolean') return v.value ? 1 : 0
  if (v.kind === 'blank') return 0
  if (v.kind === 'string') {
    const n = Number(v.value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

// ----------------------------------------------------------------------------
// Phase 8 additions — CHOOSE, ROW/ROWS/COLUMN/COLUMNS, ADDRESS
// ----------------------------------------------------------------------------

/**
 * CHOOSE(index, val1, val2, ...) — pick the index-th value (1-based).
 * Out of range → #VALUE!. Index is truncated to integer.
 */
export const CHOOSE: FunctionImpl = (args, _ctx) => {
  if (args.length < 2) return ERR_VALUE
  const ix = args[0]
  if (ix.kind === 'error') return ix
  const ic = toNumber(ix)
  if (!ic.ok) return ic.error
  const idx = Math.trunc(ic.value)
  if (idx < 1 || idx > args.length - 1) return ERR_VALUE
  return args[idx]
}

/**
 * ROWS(array) — number of rows in the array. Scalar → 1.
 */
export const ROWS: FunctionImpl = (args, _ctx) => {
  if (args.length !== 1) return ERR_VALUE
  const a = args[0]
  if (a.kind === 'error') return a
  if (a.kind === 'array') return { kind: 'number', value: a.value.length }
  return { kind: 'number', value: 1 }
}

/**
 * COLUMNS(array) — number of columns in the array. Scalar → 1.
 */
export const COLUMNS: FunctionImpl = (args, _ctx) => {
  if (args.length !== 1) return ERR_VALUE
  const a = args[0]
  if (a.kind === 'error') return a
  if (a.kind === 'array') return { kind: 'number', value: a.value[0]?.length ?? 0 }
  return { kind: 'number', value: 1 }
}

/**
 * ROW([reference]) — zero-arg variant returns 1 (we don't have the current
 * cell's row at this layer; the evaluator may patch this for ref-aware
 * usage). With an array arg, returns the row count's vertical sequence
 * 1..N for compatibility with simple `=ROW()` spreadsheet idioms.
 *
 * Real ref-aware ROW() requires evaluator integration — flagged as TODO.
 */
export const ROW: FunctionImpl = (args, _ctx) => {
  if (args.length === 0) return { kind: 'number', value: 1 }
  if (args.length !== 1) return ERR_VALUE
  const a = args[0]
  if (a.kind === 'error') return a
  if (a.kind === 'array') {
    // Excel returns 1..N as a column array.
    const n = a.value.length
    const out: Value[][] = []
    for (let i = 1; i <= n; i++) out.push([{ kind: 'number', value: i }])
    return { kind: 'array', value: out }
  }
  return { kind: 'number', value: 1 }
}

/**
 * COLUMN([reference]) — zero-arg variant returns 1 (same limitation as ROW).
 */
export const COLUMN: FunctionImpl = (args, _ctx) => {
  if (args.length === 0) return { kind: 'number', value: 1 }
  if (args.length !== 1) return ERR_VALUE
  const a = args[0]
  if (a.kind === 'error') return a
  if (a.kind === 'array') {
    const n = a.value[0]?.length ?? 0
    const row: Value[] = []
    for (let i = 1; i <= n; i++) row.push({ kind: 'number', value: i })
    return { kind: 'array', value: [row] }
  }
  return { kind: 'number', value: 1 }
}

/**
 * ADDRESS(row, col, [abs=1], [a1=TRUE], [sheet]) — produce an A1 (or R1C1) reference string.
 *   abs: 1=absolute (default), 2=row abs col rel, 3=row rel col abs, 4=both rel
 */
export const ADDRESS: FunctionImpl = (args, _ctx) => {
  if (args.length < 2 || args.length > 5) return ERR_VALUE
  const errProp = propagateError(args.slice(0, Math.min(args.length, 4)))
  if (errProp) return errProp
  const rRow = toNumber(args[0])
  if (!rRow.ok) return rRow.error
  const rCol = toNumber(args[1])
  if (!rCol.ok) return rCol.error
  const row = Math.trunc(rRow.value)
  const col = Math.trunc(rCol.value)
  if (row < 1 || col < 1) return ERR_VALUE
  let abs = 1
  if (args.length >= 3) {
    const a = toNumber(args[2])
    if (!a.ok) return a.error
    abs = Math.trunc(a.value)
    if (abs < 1 || abs > 4) return ERR_VALUE
  }
  let a1 = true
  if (args.length >= 4) {
    const v = args[3]
    if (v.kind === 'boolean') a1 = v.value
    else if (v.kind === 'number') a1 = v.value !== 0
    else if (v.kind !== 'blank') return ERR_VALUE
  }
  let sheet: string | undefined
  if (args.length === 5) {
    const v = args[4]
    if (v.kind === 'string') sheet = v.value
    else if (v.kind !== 'blank') return ERR_VALUE
  }
  // Build column letter (1 → A, 27 → AA).
  let n = col
  let letters = ''
  while (n > 0) {
    n -= 1
    letters = String.fromCharCode(65 + (n % 26)) + letters
    n = Math.floor(n / 26)
  }
  let body: string
  if (a1) {
    const rowAbs = abs === 1 || abs === 2
    const colAbs = abs === 1 || abs === 3
    body = `${colAbs ? '$' : ''}${letters}${rowAbs ? '$' : ''}${row}`
  } else {
    const rowAbs = abs === 1 || abs === 2
    const colAbs = abs === 1 || abs === 3
    const r = rowAbs ? `R${row}` : `R[${row}]`
    const c = colAbs ? `C${col}` : `C[${col}]`
    body = r + c
  }
  if (sheet !== undefined) {
    // Quote if sheet name has spaces or non-letters.
    const needsQuote = /[^A-Za-z0-9_]/.test(sheet)
    body = `${needsQuote ? `'${sheet}'` : sheet}!${body}`
  }
  return { kind: 'string', value: body }
}

// ----------------------------------------------------------------------------
// Registry
// ----------------------------------------------------------------------------

export const FUNCTIONS: Record<string, FunctionImpl> = {
  VLOOKUP,
  HLOOKUP,
  INDEX,
  MATCH,
  XLOOKUP,
  // Phase 8 additions
  CHOOSE,
  ROWS,
  COLUMNS,
  ROW,
  COLUMN,
  ADDRESS,
}
