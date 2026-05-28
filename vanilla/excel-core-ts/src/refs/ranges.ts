/**
 * Range parsing, normalization, iteration, and predicates.
 *
 * Wave B / B3 — pure utilities. No atoms, no store, no Solid, no DOM.
 * Consumed by:
 *   - B1 (parser tokenizer) — `parseRangeString` for `A1:B10` tokens.
 *   - B2 (evaluator refLookup) — `parseA1` (re-exported via `./index.ts`)
 *     for single-cell ref resolution; `expandRange` /
 *     `iterateRange` for ranges piped into built-ins.
 *   - Wave C functions — `iterateRange` for `SUM`, `AVERAGE`, etc.;
 *     `rangesIntersect` / `rangeContains` for `COUNTIFS` correlation.
 *
 * Discipline:
 *  - All inputs are validated; malformed input returns `null` (or empty
 *    iteration) rather than throwing — except `expandRange`, which
 *    throws `RangeTooLargeError` when materialization would exceed
 *    `EXPAND_MAX_CELLS` (callers decide whether to chunk or refuse).
 *  - Whole-column / whole-row references use `EXCEL_MAX_ROW` /
 *    `EXCEL_MAX_COL` sentinels so downstream code can treat them as
 *    plain CellRange — there is no separate "open range" type.
 */

import type { CellCoord, CellKey, CellRange } from '../types'

import {
  EXCEL_MAX_COL,
  EXCEL_MAX_ROW,
  colNameToIndex,
  parseA1,
} from './a1'

/**
 * Hard cap on `expandRange` materialization. Matches the PLAN.md /
 * Go-To convention (`spreadsheet-ui-core` uses 100k for selection
 * preview & find/replace). Iteration via `iterateRange` is uncapped —
 * caller chooses the budget.
 */
export const EXPAND_MAX_CELLS = 100_000

/** Thrown by `expandRange` when the range exceeds `EXPAND_MAX_CELLS`. */
export class RangeTooLargeError extends Error {
  readonly range: CellRange

  readonly cellCount: number

  constructor(range: CellRange, cellCount: number) {
    super(
      `expandRange refused to materialize ${cellCount} cells (cap ${EXPAND_MAX_CELLS}); ` +
        'use iterateRange for unbounded streaming.',
    )
    this.name = 'RangeTooLargeError'
    this.range = range
    this.cellCount = cellCount
  }
}

// =============================================================================
// CellKey helper (re-exported through ./index.ts as well)
// =============================================================================

/**
 * Produce the canonical `<row>:<col>` key. Single source of truth so
 * B1 / B2 / Wave C do not reinvent the format. Matches the convention
 * declared in `docs/ARCHITECTURE.md` §2 and `src/types.ts`.
 */
export function cellKey(coord: CellCoord): CellKey {
  return `${coord.row}:${coord.col}`
}

// =============================================================================
// Single-endpoint parsing helpers (internal)
// =============================================================================

/** Pure-digits endpoint like `"1"` / `"$1"` from a whole-row range. */
const WHOLE_ROW_RE = /^(\$?)([0-9]{1,7})$/
/** Pure-letters endpoint like `"A"` / `"$A"` from a whole-column range. */
const WHOLE_COL_RE = /^(\$?)([A-Za-z]{1,3})$/

interface ParsedEndpoint {
  /** Row index (0-indexed) or `null` when only a column is specified. */
  readonly row: number | null
  /** Col index (0-indexed) or `null` when only a row is specified. */
  readonly col: number | null
}

/**
 * Parse a single range endpoint. Returns `null` for malformed input.
 * Accepts cell refs (`A1`, `$A$1`), whole-col endpoints (`A`, `$A`),
 * and whole-row endpoints (`1`, `$1`). Absolute markers are tolerated
 * but discarded (range expansion does not need them — they're a
 * parser/eval-time concept, not a coord concept).
 */
function parseRangeEndpoint(text: string): ParsedEndpoint | null {
  // Cell ref (letters + digits).
  const cell = parseA1(text)
  if (cell !== null) return { row: cell.row, col: cell.col }

  // Whole-row: digits only.
  const rowMatch = WHOLE_ROW_RE.exec(text)
  if (rowMatch !== null) {
    const digits = rowMatch[2]
    if (digits.length > 1 && digits.charCodeAt(0) === 48) return null
    const rowOneBased = Number(digits)
    if (rowOneBased < 1) return null
    const row = rowOneBased - 1
    if (row > EXCEL_MAX_ROW) return null
    return { row, col: null }
  }

  // Whole-column: letters only.
  const colMatch = WHOLE_COL_RE.exec(text)
  if (colMatch !== null) {
    const col = colNameToIndex(colMatch[2])
    if (col < 0) return null
    return { row: null, col }
  }

  return null
}

// =============================================================================
// parseRange / parseRangeString
// =============================================================================

/**
 * Parse a range from two pre-split endpoint strings. The endpoints may be:
 *   - Both cell refs:           `parseRange('A1', 'B10')`
 *   - Both column letters:      `parseRange('A', 'C')`     -> whole columns
 *   - Both row numbers:         `parseRange('1', '5')`     -> whole rows
 *
 * Mixing cell + row, or cell + column, returns `null` — that shape is
 * not a valid Excel range. Endpoints are normalized so the returned
 * `CellRange` always has `rowStart <= rowEnd` and `colStart <= colEnd`.
 */
export function parseRange(start: string, end: string): CellRange | null {
  const s = parseRangeEndpoint(start)
  const e = parseRangeEndpoint(end)
  if (s === null || e === null) return null

  // Determine shape: both must be the same "kind" (cell / row-only / col-only).
  const sIsRow = s.row !== null && s.col === null
  const sIsCol = s.col !== null && s.row === null
  const sIsCell = s.row !== null && s.col !== null

  const eIsRow = e.row !== null && e.col === null
  const eIsCol = e.col !== null && e.row === null
  const eIsCell = e.row !== null && e.col !== null

  if (sIsCell && eIsCell) {
    return normalizeRange({
      rowStart: s.row as number,
      rowEnd: e.row as number,
      colStart: s.col as number,
      colEnd: e.col as number,
    })
  }
  if (sIsRow && eIsRow) {
    return normalizeRange({
      rowStart: s.row as number,
      rowEnd: e.row as number,
      colStart: 0,
      colEnd: EXCEL_MAX_COL,
    })
  }
  if (sIsCol && eIsCol) {
    return normalizeRange({
      rowStart: 0,
      rowEnd: EXCEL_MAX_ROW,
      colStart: s.col as number,
      colEnd: e.col as number,
    })
  }
  // Mixed shapes are invalid.
  // TODO(B3): Excel accepts `A1:A` (anchored start, open end). Not in
  // scope for v1 — parser will reject it at the tokenizer level.
  return null
}

/**
 * Convenience: parse `"A1:B10"`, `"A:A"`, `"1:1"` (etc.) in one call.
 * Whitespace around the colon is **not** tolerated — Excel formulas
 * are case-insensitive but whitespace-strict. The parser layer (B1)
 * may pre-trim before calling.
 *
 * Returns `null` for malformed input (missing colon, three+ parts,
 * empty endpoint, shape mismatch).
 */
export function parseRangeString(text: string): CellRange | null {
  if (typeof text !== 'string') return null
  const colonIdx = text.indexOf(':')
  if (colonIdx < 0) return null
  // Multiple colons (e.g. cross-sheet `Sheet2!A1:B10` or 3D
  // `Sheet1:Sheet3!A1`) are not handled here — caller is responsible
  // for splitting off the sheet prefix first.
  if (text.indexOf(':', colonIdx + 1) >= 0) return null
  const start = text.slice(0, colonIdx)
  const end = text.slice(colonIdx + 1)
  if (start.length === 0 || end.length === 0) return null
  return parseRange(start, end)
}

// =============================================================================
// Normalization + iteration + expansion
// =============================================================================

/**
 * Ensure `rowStart <= rowEnd` and `colStart <= colEnd`. Idempotent on
 * already-normalized ranges (cheap to call defensively). Returns a fresh
 * object so callers can rely on referential change to invalidate caches.
 */
export function normalizeRange(range: CellRange): CellRange {
  const rowStart = Math.min(range.rowStart, range.rowEnd)
  const rowEnd = Math.max(range.rowStart, range.rowEnd)
  const colStart = Math.min(range.colStart, range.colEnd)
  const colEnd = Math.max(range.colStart, range.colEnd)
  return { rowStart, rowEnd, colStart, colEnd }
}

/**
 * Stream every `(row, col)` in the range, row-major. Generator — does
 * not materialize. Caller controls the budget; for `=SUM(A:A)` (over
 * a million cells), iteration is fine because callers stop early or
 * only touch occupied keys via `cells.get`.
 *
 * Range is normalized internally; passing an inverted range still
 * yields the correct sequence.
 */
export function* iterateRange(range: CellRange): IterableIterator<CellCoord> {
  const n = normalizeRange(range)
  for (let row = n.rowStart; row <= n.rowEnd; row++) {
    for (let col = n.colStart; col <= n.colEnd; col++) {
      yield { row, col }
    }
  }
}

/**
 * Materialize a range as a flat `CellCoord[]`. **Throws**
 * `RangeTooLargeError` when the range would exceed `EXPAND_MAX_CELLS`.
 *
 * Callers that need uncapped traversal (range eval) must use
 * `iterateRange` instead.
 */
export function expandRange(range: CellRange): CellCoord[] {
  const n = normalizeRange(range)
  const rowCount = n.rowEnd - n.rowStart + 1
  const colCount = n.colEnd - n.colStart + 1
  const total = rowCount * colCount
  if (total > EXPAND_MAX_CELLS) {
    throw new RangeTooLargeError(n, total)
  }
  const out: CellCoord[] = new Array(total)
  let i = 0
  for (let row = n.rowStart; row <= n.rowEnd; row++) {
    for (let col = n.colStart; col <= n.colEnd; col++) {
      out[i++] = { row, col }
    }
  }
  return out
}

// =============================================================================
// Predicates
// =============================================================================

/**
 * Does `range` cover `coord`? Both endpoints are inclusive. Normalizes
 * the range internally so an inverted range still answers correctly.
 */
export function rangeContains(range: CellRange, coord: CellCoord): boolean {
  const n = normalizeRange(range)
  return (
    coord.row >= n.rowStart &&
    coord.row <= n.rowEnd &&
    coord.col >= n.colStart &&
    coord.col <= n.colEnd
  )
}

/**
 * Do two ranges share at least one cell? Both ranges are normalized
 * internally. Returns `true` for ranges that touch on the corner
 * (inclusive intersection, matching Excel's convention).
 */
export function rangesIntersect(a: CellRange, b: CellRange): boolean {
  const na = normalizeRange(a)
  const nb = normalizeRange(b)
  return (
    na.rowStart <= nb.rowEnd &&
    nb.rowStart <= na.rowEnd &&
    na.colStart <= nb.colEnd &&
    nb.colStart <= na.colEnd
  )
}
