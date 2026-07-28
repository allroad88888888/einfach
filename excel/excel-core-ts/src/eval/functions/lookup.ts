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
 * Approximate-match performance:
 *  - VLOOKUP / HLOOKUP / MATCH approximate mode uses binary search on the
 *    assumed sorted column / row (`O(log n)`). On mixed-type or unsortable
 *    input the binary helper signals "abort" and the caller falls back to
 *    the legacy linear scan — Excel's spec is undefined on unsorted data,
 *    but the linear path preserves the previously documented behaviour
 *    (largest hay <= needle, skipping incompatible cells).
 *  - XLOOKUP `search_mode = 2 / -2` use the same binary helper (asc / desc)
 *    and fall back to the linear scan when the input is unsortable or when
 *    wildcards are requested (Excel rejects wildcards with binary search,
 *    but to keep us forgiving we fall back instead of erroring).
 */

import type { FunctionImpl, Value } from '../../types'
import { propagateError, toNumber } from '../coerce'

const ERR_VALUE: Value = { kind: 'error', code: '#VALUE!' }
const ERR_REF: Value = { kind: 'error', code: '#REF!' }
const ERR_NA: Value = { kind: 'error', code: '#N/A' }

export type XLookupCoreResult =
  | { readonly kind: 'value'; readonly value: Value }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'error'; readonly error: Value }

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
    const hayText = wildcardHaystackText(hay)
    if (hayText === undefined) return false
    return wildcardMatch(needle.value, hayText)
  }
  const cmp = compareForLookup(needle, hay)
  return cmp === 0
}

function wildcardHaystackText(value: Value): string | undefined {
  switch (value.kind) {
    case 'string':
      return value.value
    case 'number':
      return String(value.value)
    case 'boolean':
      return value.value ? 'TRUE' : 'FALSE'
    case 'blank':
      return ''
    case 'array':
    case 'error':
      return undefined
  }
}

// ----------------------------------------------------------------------------
// Binary search helpers (shared by VLOOKUP / HLOOKUP / MATCH / XLOOKUP)
// ----------------------------------------------------------------------------

/**
 * Sentinel returned by `binarySearchSorted` when the array isn't reliably
 * sortable in the assumed direction (mixed types, errors, blanks-vs-string).
 * Callers fall back to a linear scan to preserve Excel's "undefined on
 * unsorted data" leniency.
 */
const BSEARCH_UNSORTABLE = -2

/**
 * Binary search over `arr` (assumed sorted in `direction`). All comparisons
 * are PHYSICAL — i.e., `cmp` here means `compareForLookup(arr[mid], target)`
 * with values ascending naturally (numbers numerically, strings lexically).
 * The `direction` parameter only tells the helper how to navigate the
 * partitions (which half is "before" vs "after" target), not how to flip
 * the semantics of the result.
 *
 * Modes:
 *  - `'exact'`  → any index where arr[i] == target, or -1 if none.
 *  - `'lte'`    → the index whose value is the LARGEST physical value that
 *                 is ≤ target. In an asc array that's the rightmost cell
 *                 ≤ target; in a desc array that's the leftmost cell
 *                 ≤ target. Used for XLOOKUP matchMode=-1 ("exact or next
 *                 smaller") and MATCH match_type=1.
 *  - `'gte'`    → the index whose value is the SMALLEST physical value that
 *                 is ≥ target. In an asc array that's the leftmost cell
 *                 ≥ target; in a desc array that's the rightmost cell
 *                 ≥ target. Used for XLOOKUP matchMode=1 ("exact or next
 *                 larger") and MATCH match_type=-1.
 *
 * Returns `BSEARCH_UNSORTABLE` when any compared cell is non-orderable vs
 * the target (compareForLookup → null), so the caller can fall back to the
 * linear scan that the rest of the file already implements.
 */
function binarySearchSorted(
  arr: ReadonlyArray<Value>,
  target: Value,
  mode: 'exact' | 'lte' | 'gte',
  direction: 'asc' | 'desc',
): number {
  const n = arr.length
  if (n === 0) return -1
  let lo = 0
  let hi = n - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const rawCmp = compareForLookup(arr[mid], target)
    if (rawCmp === null) return BSEARCH_UNSORTABLE
    if (rawCmp === 0) {
      if (mode === 'exact') return mid
      best = mid
      // For lte we want the rightmost (asc) / leftmost (desc) equal element.
      // For gte we want the leftmost (asc) / rightmost (desc) equal element.
      // We're traversing in physical order, so:
      //  - asc + lte → continue right
      //  - asc + gte → continue left
      //  - desc + lte → continue left
      //  - desc + gte → continue right
      const continueRight =
        (direction === 'asc' && mode === 'lte') ||
        (direction === 'desc' && mode === 'gte')
      if (continueRight) lo = mid + 1
      else hi = mid - 1
      continue
    }
    // rawCmp != 0: arr[mid] is physically below (rawCmp<0) or above (rawCmp>0) target.
    if (rawCmp < 0) {
      // arr[mid] < target physically. For lte this is a candidate. For gte
      // we need to look at the side where larger values live.
      if (mode === 'lte') best = mid
      if (direction === 'asc') {
        lo = mid + 1 // larger values are to the right
      } else {
        hi = mid - 1 // in desc, larger values are to the left
      }
    } else {
      // arr[mid] > target physically. For gte this is a candidate.
      if (mode === 'gte') best = mid
      if (direction === 'asc') {
        hi = mid - 1 // smaller values are to the left
      } else {
        lo = mid + 1 // in desc, smaller values are to the right
      }
    }
  }
  return best
}

/**
 * Approximate match for VLOOKUP / HLOOKUP / MATCH(type=1) on ascending data.
 * Returns largest index where arr[i] <= needle, or -1 if none / unsortable.
 *
 * Signals unsortable via BSEARCH_UNSORTABLE so the caller can fall back to
 * the legacy linear walk.
 */
function binaryApproxAsc(arr: ReadonlyArray<Value>, needle: Value): number {
  return binarySearchSorted(arr, needle, 'lte', 'asc')
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
  // Approximate: binary search the first column (assumed ascending sort
  // per Excel spec) for the largest row where col0 <= needle. On mixed-type
  // or otherwise unsortable input the binary helper bails and we fall back
  // to the legacy linear walk.
  const firstCol: Value[] = []
  for (let r = 0; r < table.length; r += 1) firstCol.push(table[r][0])
  const bin = binaryApproxAsc(firstCol, needle)
  if (bin !== BSEARCH_UNSORTABLE) return bin
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
  // Approximate: same binary-search-with-linear-fallback approach as VLOOKUP.
  const bin = binaryApproxAsc(firstRow, needle)
  if (bin !== BSEARCH_UNSORTABLE) return bin
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
    // Largest <= needle; assumes ascending. Binary search first; on
    // unsortable input fall back to the linear walk.
    const bin = binarySearchSorted(flat, needle, 'lte', 'asc')
    if (bin !== BSEARCH_UNSORTABLE) {
      if (bin === -1) return ERR_NA
      return { kind: 'number', value: bin + 1 }
    }
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

  // matchType === -1 : smallest >= needle; assumes descending. Binary search
  // returns the smallest physical value still >= needle (rightmost cell ≥
  // needle in a descending array).
  const bin = binarySearchSorted(flat, needle, 'gte', 'desc')
  if (bin !== BSEARCH_UNSORTABLE) {
    if (bin === -1) return ERR_NA
    return { kind: 'number', value: bin + 1 }
  }
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

  const ifNotFound = args[3] !== undefined && args[3].kind !== 'blank' ? args[3] : null
  const result = resolveXLookupValue(args[0], args[1], args[2], args[4], args[5])
  switch (result.kind) {
    case 'value':
      return result.value
    case 'error':
      return result.error
    case 'notFound':
      return ifNotFound ?? ERR_NA
  }
}

export function resolveXLookupValue(
  needle: Value,
  lookupValue: Value,
  returnValue: Value,
  matchModeArg?: Value,
  searchModeArg?: Value,
): XLookupCoreResult {
  for (const arg of [needle, lookupValue, returnValue, matchModeArg, searchModeArg]) {
    if (arg?.kind === 'error') return { kind: 'error', error: arg }
  }

  const lookupArr = asArray(lookupValue)
  const returnArr = asArray(returnValue)
  if (!lookupArr || !returnArr) return { kind: 'error', error: ERR_VALUE }

  const matchMode = pullNumber(matchModeArg, 0)
  if (matchMode === null) return { kind: 'error', error: ERR_VALUE }
  if (matchMode !== 0 && matchMode !== -1 && matchMode !== 1 && matchMode !== 2) {
    return { kind: 'error', error: ERR_VALUE }
  }

  const searchMode = pullNumber(searchModeArg, 1)
  if (searchMode === null) return { kind: 'error', error: ERR_VALUE }
  if (searchMode !== 1 && searchMode !== -1 && searchMode !== 2 && searchMode !== -2) {
    return { kind: 'error', error: ERR_VALUE }
  }
  if (matchMode === 2 && (searchMode === 2 || searchMode === -2)) {
    return { kind: 'error', error: ERR_VALUE }
  }

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
    if (returnArr.length !== lookupLen) return { kind: 'error', error: ERR_VALUE }
  } else {
    if (returnArr[0].length !== lookupLen) return { kind: 'error', error: ERR_VALUE }
  }

  const matchIdx = findXLookupIndex(needle, lookupFlat, matchMode, searchMode)
  if (matchIdx === -1) return { kind: 'notFound' }

  // Pull the corresponding return value(s).
  if (isColumnLookup) {
    const row = returnArr[matchIdx]
    if (row.length === 1) return { kind: 'value', value: row[0] }
    // Multi-column return → return a 1xN array
    return { kind: 'value', value: { kind: 'array', value: [row.slice()] } }
  } else {
    // Row lookup: pull the column at matchIdx out of returnArr
    if (returnArr.length === 1) return { kind: 'value', value: returnArr[0][matchIdx] }
    const col: Value[][] = []
    for (let r = 0; r < returnArr.length; r += 1) {
      col.push([returnArr[r][matchIdx]])
    }
    return { kind: 'value', value: { kind: 'array', value: col } }
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

  // search_mode === 2 / -2 → binary search on sorted data.
  // Excel rejects wildcards with binary search (matchMode=2 + searchMode=±2
  // is filtered out one level up), but for safety we fall back to linear if
  // anyone reaches here with wildcards or with non-orderable cells.
  if (searchMode === 2 || searchMode === -2) {
    const direction = searchMode === 2 ? 'asc' : 'desc'
    const bin = binaryXLookup(needle, arr, matchMode, direction)
    if (bin !== BSEARCH_UNSORTABLE) return bin
    // Fall through to linear scan — preserves "soft" semantics on unsortable
    // input rather than emitting a spurious #N/A.
    return scanXLookup(needle, arr, matchMode, useWildcards, 0, len, 1)
  }
  if (searchMode === -1) {
    return scanXLookup(needle, arr, matchMode, useWildcards, len - 1, -1, -1)
  }
  // searchMode === 1 (default)
  return scanXLookup(needle, arr, matchMode, useWildcards, 0, len, 1)
}

/**
 * Binary-search variant for XLOOKUP `search_mode = ±2`.
 *
 *  - matchMode 0 → exact match (no nearest fallback). Returns -1 when not
 *    found.
 *  - matchMode -1 → "exact or next smaller" — largest hay <= needle in
 *    ascending mode; in descending mode the first hay that's <= needle
 *    (mapped via `binarySearchSorted` with mode='lte', direction='desc').
 *  - matchMode 1 → "exact or next larger" — smallest hay >= needle.
 *
 * Returns BSEARCH_UNSORTABLE when the binary helper hits an unsortable
 * comparison, so the caller can fall back to the linear scan path.
 */
function binaryXLookup(
  needle: Value,
  arr: Value[],
  matchMode: number,
  direction: 'asc' | 'desc',
): number {
  if (matchMode === 0) {
    return binarySearchSorted(arr, needle, 'exact', direction)
  }
  if (matchMode === -1) {
    return binarySearchSorted(arr, needle, 'lte', direction)
  }
  if (matchMode === 1) {
    return binarySearchSorted(arr, needle, 'gte', direction)
  }
  // matchMode === 2 (wildcards) — Excel disallows with binary modes; bail.
  return BSEARCH_UNSORTABLE
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
      if (!exactMatch(needle, hay, true)) return false
      exactIdx = i
      return true
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

function gridToVector(grid: Value[][]): Value[] | null {
  if (grid.length === 1) return grid[0].slice()
  if (grid[0].length === 1) return grid.map((row) => row[0])
  return null
}

function hasWildcardPattern(value: Value): boolean {
  if (value.kind !== 'string') return false
  for (let i = 0; i < value.value.length; i += 1) {
    const ch = value.value[i]
    if (ch === '~') {
      i += 1
      continue
    }
    if (ch === '*' || ch === '?') return true
  }
  return false
}

function lookupVectorWalk(keys: Value[], result: Value[], needle: Value): Value {
  if (keys.length === 0 || keys.length !== result.length) return ERR_VALUE
  let best = -1
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    if (key.kind === 'error') return key
    const cmp = compareForLookup(key, needle)
    if (cmp !== null && cmp <= 0) best = i
  }
  return best === -1 ? ERR_NA : result[best]
}

// ----------------------------------------------------------------------------
// LOOKUP / XMATCH
// ----------------------------------------------------------------------------

/**
 * LOOKUP(lookup_value, lookup_vector, [result_vector]) — approximate
 * exact-or-next-smaller lookup. The two-argument array form searches the
 * first row/column and returns from the opposite edge, matching Excel's
 * legacy array form.
 */
export const LOOKUP: FunctionImpl = (args, _ctx) => {
  if (args.length < 2 || args.length > 3) return ERR_VALUE
  if (args[0].kind === 'error') return args[0]
  if (args[1].kind === 'error') return args[1]
  if (args[2]?.kind === 'error') return args[2]

  const lookupGrid = asArray(args[1])
  if (!lookupGrid) return ERR_VALUE
  const rows = lookupGrid.length
  const cols = lookupGrid[0].length

  if (args.length === 2) {
    if (rows === 1 || cols === 1) {
      const vector = gridToVector(lookupGrid)
      if (!vector) return ERR_VALUE
      return lookupVectorWalk(vector, vector, args[0])
    }
    if (cols >= rows) {
      return lookupVectorWalk(lookupGrid[0], lookupGrid[rows - 1], args[0])
    }
    return lookupVectorWalk(
      lookupGrid.map((row) => row[0]),
      lookupGrid.map((row) => row[cols - 1]),
      args[0],
    )
  }

  const lookupVector = gridToVector(lookupGrid)
  if (!lookupVector) return ERR_VALUE
  const resultGrid = asArray(args[2])
  if (!resultGrid) return ERR_VALUE
  const resultVector = gridToVector(resultGrid)
  if (!resultVector) return ERR_VALUE
  return lookupVectorWalk(lookupVector, resultVector, args[0])
}

/**
 * XMATCH(lookup_value, lookup_array, [match_mode], [search_mode]) — returns
 * the 1-based match position. Binary modes are accepted but resolved via the
 * same linear scan used by XLOOKUP in this TS runtime.
 */
export const XMATCH: FunctionImpl = (args, _ctx) => {
  if (args.length < 2 || args.length > 4) return ERR_VALUE
  if (args[0].kind === 'error') return args[0]
  if (args[1].kind === 'error') return args[1]

  const matchMode = pullNumber(args[2], 0)
  if (matchMode === null) return ERR_VALUE
  if (matchMode !== -1 && matchMode !== 0 && matchMode !== 1 && matchMode !== 2) return ERR_VALUE

  const searchMode = pullNumber(args[3], 1)
  if (searchMode === null) return ERR_VALUE
  if (
    searchMode !== -2 &&
    searchMode !== -1 &&
    searchMode !== 1 &&
    searchMode !== 2
  )
    return ERR_VALUE
  if (matchMode === 2 && (searchMode === 2 || searchMode === -2)) return ERR_VALUE

  const grid = asArray(args[1])
  if (!grid) return ERR_VALUE
  const items: Value[] = []
  for (const row of grid) {
    for (const item of row) {
      if (item.kind === 'error') return item
      items.push(item)
    }
  }
  if (items.length === 0) return ERR_VALUE

  const needle = args[0]
  const useWildcards = matchMode === 2 || (matchMode === 0 && hasWildcardPattern(needle))
  const indices: number[] = []
  if (searchMode === -1) {
    for (let i = items.length - 1; i >= 0; i -= 1) indices.push(i)
  } else {
    for (let i = 0; i < items.length; i += 1) indices.push(i)
  }

  let best = -1
  let bestDiff = Infinity
  const needleRank = numericRank(needle)
  for (const i of indices) {
    const item = items[i]
    if (exactMatch(needle, item, useWildcards)) return { kind: 'number', value: i + 1 }
    if (matchMode !== -1 && matchMode !== 1) continue
    const itemRank = numericRank(item)
    if (needleRank === null || itemRank === null) continue
    const diff = matchMode === -1 ? needleRank - itemRank : itemRank - needleRank
    if (diff >= 0 && diff < bestDiff) {
      best = i
      bestDiff = diff
    }
  }

  return best === -1 ? ERR_NA : { kind: 'number', value: best + 1 }
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
 * cell's row at this plain FunctionImpl layer; workbook-backed evaluation
 * handles ref/current-cell-aware ROW in the evaluator. With an array arg,
 * returns the row count's vertical sequence
 * 1..N for compatibility with simple `=ROW()` spreadsheet idioms.
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
 * COLUMN([reference]) — zero-arg variant returns 1 in the plain FunctionImpl
 * layer; workbook-backed evaluation handles ref/current-cell-aware COLUMN.
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
  LOOKUP,
  XMATCH,
  // Phase 8 additions
  CHOOSE,
  ROWS,
  COLUMNS,
  ROW,
  COLUMN,
  ADDRESS,
}
