import type {
  CellRange,
  PasteRangeRequest,
  PasteSpecialOp,
} from '@einfach/spreadsheet-ui-core'

/**
 * Shared Paste Special computation (parity #11). The static backend is
 * the reference implementation; the worker adapter composes these same
 * pure helpers over RPC reads/writes so both paths carry ONE semantic:
 *
 *  - geometry: the target is clamped to the source shape (transposed when
 *    the transpose flag or the 'transpose' kind is set) — Excel's classic
 *    Paste Special behaviour;
 *  - value leg: formulas paste verbatim (`formula ?? display`). The
 *    reference semantics performs NO reference translation on Paste
 *    Special — only the plain-paste path shifts refs (UI-side, via
 *    `shiftFormulaRefs`, before the import request is built);
 *  - arithmetic ops: the coercion table documented in
 *    `excel/spreadsheet-ui-core/src/paste-special/README.md`;
 *  - skip blanks: a source cell with an empty display and no formula
 *    leaves the target cell untouched (both legs).
 */

export interface PasteRangeGeometry {
  /** Effective transpose flag: the checkbox OR the 'transpose' kind. */
  transpose: boolean
  /** Patch height at the target, accounting for transpose. */
  patchRows: number
  /** Patch width at the target, accounting for transpose. */
  patchCols: number
  /** Whether this pasteKind writes cell inputs (values/formulas). */
  writeValues: boolean
  /** Whether this pasteKind writes cell formats. */
  writeFormats: boolean
  /** Target rectangle really written: anchored at target start, source shape. */
  affectedRange: CellRange
}

export function pasteRangeGeometry(request: PasteRangeRequest): PasteRangeGeometry {
  const src = request.source.range
  const tgt = request.target
  const transpose = request.transpose || request.pasteKind === 'transpose'

  const srcRows = src.rowEnd - src.rowStart + 1
  const srcCols = src.colEnd - src.colStart + 1
  const patchRows = transpose ? srcCols : srcRows
  const patchCols = transpose ? srcRows : srcCols

  const writeValues =
    request.pasteKind === 'values' ||
    request.pasteKind === 'values-and-formats' ||
    request.pasteKind === 'all' ||
    request.pasteKind === 'transpose'

  const writeFormats =
    request.pasteKind === 'formats' ||
    request.pasteKind === 'values-and-formats' ||
    request.pasteKind === 'all'

  // 'column-widths' and 'comments' are accepted as no-ops by the
  // reference backend (neither leg set); a future revision can wire them
  // through the dimension-map / comments stores.

  return {
    transpose,
    patchRows,
    patchCols,
    writeValues,
    writeFormats,
    affectedRange: {
      rowStart: tgt.rowStart,
      rowEnd: tgt.rowStart + patchRows - 1,
      colStart: tgt.colStart,
      colEnd: tgt.colStart + patchCols - 1,
    },
  }
}

/** Map (dr, dc) inside the patch back to a source coordinate, accounting for transpose. */
export function pasteSourceCoord(
  source: CellRange,
  transpose: boolean,
  dr: number,
  dc: number,
): { row: number; col: number } {
  return {
    row: transpose ? source.rowStart + dc : source.rowStart + dr,
    col: transpose ? source.colStart + dr : source.colStart + dc,
  }
}

/** Skip-blanks predicate: empty display AND no formula source. */
export function isPasteSourceBlank(display: string, formula: string | undefined): boolean {
  return display.length === 0 && !formula
}

function numericInput(input: string | undefined): number | null {
  if (input === undefined) return null
  const trimmed = input.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

// Excel error literals follow `#NAME!` / `#DIV/0!` / `#VALUE!` /
// `#REF!` / `#NUM!` / `#N/A` shapes. Pre-paste arithmetic must
// pass an error source/target straight through rather than try to
// coerce a `#...` string to a number.
function isErrorLiteral(input: string | undefined): boolean {
  if (input === undefined) return false
  const trimmed = input.trim()
  return trimmed.startsWith('#') && trimmed.length > 1
}

/**
 * Arithmetic coercion for paste-special ops. Semantics (documented in
 * `excel/spreadsheet-ui-core/src/paste-special/README.md`):
 *
 *   - `op === 'none'` → the source input passes through unchanged.
 *   - error source OR error target → preserve the existing target
 *     (returns `null` to signal the caller to skip the write).
 *   - non-numeric source → preserve the existing target (skip).
 *   - non-numeric target → treated as 0 (Excel behaviour).
 *   - divide-by-zero → emit the `#DIV/0!` error literal.
 *
 * `null` return = skip the write entirely. A returned string is the
 * new cell input.
 */
export function applyPasteArithmetic(
  op: PasteSpecialOp,
  sourceInput: string,
  targetInput: string | undefined,
): string | null {
  if (op === 'none') return sourceInput

  if (isErrorLiteral(sourceInput) || isErrorLiteral(targetInput)) {
    // Pass-through: leave the target untouched.
    return null
  }

  const b = numericInput(sourceInput)
  if (b === null) {
    // Text source — operation undefined for non-numerics; skip
    // rather than overwrite the target with the literal text.
    return null
  }
  const a = numericInput(targetInput) ?? 0

  switch (op) {
    case 'add':
      return String(a + b)
    case 'subtract':
      return String(a - b)
    case 'multiply':
      return String(a * b)
    case 'divide':
      if (b === 0) return '#DIV/0!'
      return String(a / b)
    default:
      return sourceInput
  }
}
