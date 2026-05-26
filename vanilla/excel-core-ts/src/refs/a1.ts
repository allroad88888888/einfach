/**
 * A1-notation <-> (row, col) translation, plus column-letter helpers.
 *
 * Wave B / B3 — pure utilities. No atoms, no store, no Solid, no DOM.
 * Every function is fully described by its inputs.
 *
 * Conventions
 *  - Row / col are **0-indexed integers**. `A1 == { row: 0, col: 0 }`,
 *    `B2 == { row: 1, col: 1 }`, `AA1 == { row: 0, col: 26 }`,
 *    `XFD1048576 == { row: 1048575, col: 16383 }`.
 *  - Letters are case-insensitive in user input; normalized to uppercase
 *    on the way out.
 *  - Absolute flags (`$`) are **preserved** in `parseA1` output so the
 *    parser can round-trip diagnostics. They have no effect on the
 *    underlying coord — range expansion / evaluator ignore them.
 *  - Out-of-range input (col > XFD, row > 1048576, row 0, leading 0,
 *    empty letters, empty digits) returns `null` from `parseA1`.
 *
 * Cross-reference: `docs/ARCHITECTURE.md` §2 (CellKey), `docs/PLAN.md` §5
 * (refs/ subpackage layout).
 */

/** Last valid 0-indexed column (`XFD` == 16383). */
export const EXCEL_MAX_COL = 16383

/** Last valid 0-indexed row (Excel allows 1..1048576, hence 1048575). */
export const EXCEL_MAX_ROW = 1048575

/** Output of `parseA1`. Absolute flags reflect the `$` prefixes literally. */
export interface ParsedA1 {
  readonly row: number
  readonly col: number
  readonly absRow: boolean
  readonly absCol: boolean
}

/** Input accepted by `formatA1`. Absolute flags default to `false`. */
export interface FormatA1Input {
  readonly row: number
  readonly col: number
  readonly absRow?: boolean
  readonly absCol?: boolean
}

// =============================================================================
// Column letter <-> index
// =============================================================================

/**
 * `'A'` -> 0, `'Z'` -> 25, `'AA'` -> 26, `'XFD'` -> 16383. Lowercase is
 * accepted. Returns `-1` for empty / non-letter input or for values
 * past `EXCEL_MAX_COL`; callers should treat that as a parse failure.
 *
 * Excel's column scheme is **bijective base-26** (no zero digit), so the
 * recurrence is `idx = (idx + 1) * 26 + (letter - 'A')` with the convention
 * that `'A'` represents 1 internally. We subtract 1 at the end to land
 * back on 0-indexed.
 */
export function colNameToIndex(name: string): number {
  if (name.length === 0) return -1
  let idx = 0
  for (let i = 0; i < name.length; i++) {
    const ch = name.charCodeAt(i)
    // 'A'..'Z' = 65..90, 'a'..'z' = 97..122
    let digit: number
    if (ch >= 65 && ch <= 90) {
      digit = ch - 65 + 1
    } else if (ch >= 97 && ch <= 122) {
      digit = ch - 97 + 1
    } else {
      return -1
    }
    idx = idx * 26 + digit
  }
  const zeroBased = idx - 1
  if (zeroBased > EXCEL_MAX_COL) return -1
  return zeroBased
}

/**
 * Inverse of `colNameToIndex`. `0 -> 'A'`, `25 -> 'Z'`, `26 -> 'AA'`,
 * `16383 -> 'XFD'`. Throws `RangeError` for negative or > max col so
 * misuse surfaces immediately (the function is internal to refs and the
 * evaluator — out-of-range here means a logic bug upstream).
 */
export function colIndexToName(idx: number): string {
  if (!Number.isInteger(idx) || idx < 0 || idx > EXCEL_MAX_COL) {
    throw new RangeError(`colIndexToName: ${idx} is out of [0, ${EXCEL_MAX_COL}]`)
  }
  // Bijective base-26 emission: at each step subtract 1, peel off the
  // low digit, divide by 26. Reverse at the end.
  let n = idx
  let out = ''
  while (true) {
    const digit = n % 26
    out = String.fromCharCode(65 + digit) + out
    n = Math.floor(n / 26) - 1
    if (n < 0) break
  }
  return out
}

// =============================================================================
// A1 <-> { row, col, absRow, absCol }
// =============================================================================

// Matches: optional `$`, 1-3 letters, optional `$`, 1-7 digits. Anchored
// on both ends to reject trailing garbage. Bounds checks happen in code
// (XFD / 1048576) — regex only validates shape.
const A1_RE = /^(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})$/

/**
 * Parse an A1-style cell reference. Returns `null` for any malformed
 * input (empty, missing letters or digits, out-of-bounds column or row,
 * leading-zero row like `A01`).
 *
 * Accepts (with optional `$` prefixes on either part):
 *   `A1`, `Z1`, `AA1`, `XFD1048576`, `$A$1`, `$A1`, `A$1`,
 *   lowercase variants (`a1`, `xfd1048576`).
 *
 * Rejects:
 *   empty / whitespace, `A`, `1`, `$1`, `$$A1`, `A1$`, `A0`, `A01`,
 *   `XFE1` (column > XFD), `A1048577` (row > max), `AAAA1` (4 letters).
 *
 * The returned `absRow` / `absCol` mirror the literal `$` prefixes —
 * the underlying coord is the same regardless.
 */
export function parseA1(a1: string): ParsedA1 | null {
  if (typeof a1 !== 'string') return null
  const m = A1_RE.exec(a1)
  if (m === null) return null
  const [, absColMark, letters, absRowMark, digits] = m
  // Reject leading-zero rows: Excel rejects `A01`. Single `0` would
  // already fail the row-bound check below, but `A01` would otherwise
  // round-trip to `A1` silently.
  if (digits.length > 1 && digits.charCodeAt(0) === 48) return null
  const col = colNameToIndex(letters)
  if (col < 0) return null
  // `digits` is 1..7 chars of [0-9]; max valid integer is 1048576.
  const rowOneBased = Number(digits)
  if (rowOneBased < 1) return null
  const row = rowOneBased - 1
  if (row > EXCEL_MAX_ROW) return null
  return {
    row,
    col,
    absRow: absRowMark === '$',
    absCol: absColMark === '$',
  }
}

/**
 * Inverse of `parseA1`. Emits `$` markers per the absolute flags.
 *
 * Throws `RangeError` if row/col are out of bounds — the function is
 * a low-level helper; bound checking is the caller's job (parser, AST
 * pretty-printer, projection emitter).
 */
export function formatA1(coord: FormatA1Input): string {
  const { row, col, absRow = false, absCol = false } = coord
  if (!Number.isInteger(row) || row < 0 || row > EXCEL_MAX_ROW) {
    throw new RangeError(`formatA1: row ${row} out of [0, ${EXCEL_MAX_ROW}]`)
  }
  if (!Number.isInteger(col) || col < 0 || col > EXCEL_MAX_COL) {
    throw new RangeError(`formatA1: col ${col} out of [0, ${EXCEL_MAX_COL}]`)
  }
  const colPart = (absCol ? '$' : '') + colIndexToName(col)
  const rowPart = (absRow ? '$' : '') + String(row + 1)
  return colPart + rowPart
}
