import { addrToCoord, colToLetter } from './selection'

/**
 * Shift every cell reference inside a formula by `(drow, dcol)`. Used for:
 *   - paste: relative refs translate by (paste_origin - copy_origin)
 *   - row/col insert/delete in the JS mock (parity with Rust shift_addr_*)
 *
 * Cell refs at or past `threshold` (when supplied) are shifted; refs above
 * are left alone. `threshold = undefined` means shift all refs.
 *
 * If a referenced cell ends up out of the deleted band — caller signals
 * this by returning a negative coord from `predicate` — the ref becomes
 * `#REF!` (Excel parity).
 *
 * Limitations:
 *   - Doesn't understand absolute refs (`$A$1`); the AST doesn't have them
 *     yet either.
 *   - Cross-sheet refs (`Sheet1!A1`) shift the address part only; sheet
 *     name is preserved verbatim.
 *   - Range refs `A1:B3` shift both endpoints.
 *   - Function names that look like cell refs (e.g. a hypothetical `A1`)
 *     would falsely shift. The current grammar disallows function names
 *     matching `[A-Z]+\d+`, so this is moot in practice.
 */
export function shiftFormulaRefs(
  formula: string,
  drow: number,
  dcol: number,
): string {
  return mapFormulaRefs(formula, (row, col) => ({ row: row + drow, col: col + dcol }))
}

/**
 * Shift refs only when they fall in / past a row-insert band. Refs at
 * `at` or below shift down by `count`; refs above are unchanged.
 */
export function shiftFormulaForRowInsert(
  formula: string,
  at: number,
  count: number,
): string {
  return mapFormulaRefs(formula, (row, col) =>
    row >= at ? { row: row + count, col } : { row, col },
  )
}

/**
 * Shift refs for row delete. Refs inside [at, at+count) become #REF!;
 * refs at or past `at + count` shift up by `count`.
 */
export function shiftFormulaForRowDelete(
  formula: string,
  at: number,
  count: number,
): string {
  return mapFormulaRefs(formula, (row, col) => {
    if (row >= at && row < at + count) return null
    if (row >= at + count) return { row: row - count, col }
    return { row, col }
  })
}

export function shiftFormulaForColInsert(
  formula: string,
  at: number,
  count: number,
): string {
  return mapFormulaRefs(formula, (row, col) =>
    col >= at ? { row, col: col + count } : { row, col },
  )
}

export function shiftFormulaForColDelete(
  formula: string,
  at: number,
  count: number,
): string {
  return mapFormulaRefs(formula, (row, col) => {
    if (col >= at && col < at + count) return null
    if (col >= at + count) return { row, col: col - count }
    return { row, col }
  })
}

/** Internal: walk every cell ref, apply `f`. `null` return = #REF!. */
function mapFormulaRefs(
  formula: string,
  f: (row: number, col: number) => { row: number; col: number } | null,
): string {
  const rewriteSegment = (segment: string): string => {
    // Match cell refs and cross-sheet refs separately. Ranges (A1:B2) get
    // matched as two independent refs joined by ':'.
    const refPattern = /(?:([A-Za-z_][A-Za-z0-9_]*)!)?([A-Za-z]+)(\d+)/g
    return segment.replace(refPattern, (full, sheetName, letters, digits) => {
      const c = addrToCoord(`${letters}${digits}`)
      if (!c) return full
      const moved = f(c.row, c.col)
      if (moved === null || moved.row < 0 || moved.col < 0) return '#REF!'
      const newAddr = `${colToLetter(moved.col)}${moved.row + 1}`
      return sheetName ? `${sheetName}!${newAddr}` : newAddr
    })
  }

  let out = ''
  let segment = ''
  for (let i = 0; i < formula.length; i += 1) {
    const ch = formula[i]
    if (ch !== '"') {
      segment += ch
      continue
    }

    out += rewriteSegment(segment)
    segment = ''
    const start = i
    i += 1
    while (i < formula.length) {
      if (formula[i] === '"') {
        // Excel-style escaped quote inside a string literal.
        if (formula[i + 1] === '"') {
          i += 2
          continue
        }
        break
      }
      i += 1
    }
    out += formula.slice(start, Math.min(i + 1, formula.length))
  }
  return out + rewriteSegment(segment)
}
