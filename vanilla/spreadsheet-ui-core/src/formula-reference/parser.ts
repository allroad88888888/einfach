import type { CellRange } from '../shared'

export interface FormulaReferenceToken {
  /** Char offset (inclusive) into the draft where this token starts. */
  start: number
  /** Char offset (exclusive) into the draft where this token ends. */
  end: number
  /** Verbatim token text from the draft (e.g. 'B2', 'Sheet2!A1:C3'). */
  text: string
  /** Sheet id this token refers to, or null when no explicit prefix is present. */
  sheetId: string | null
  /** Resolved 0-based range. Single-cell tokens use rowStart=rowEnd, colStart=colEnd. */
  range: CellRange
  /** Stable color slot, assigned in document order. Hosts can map to a palette. */
  colorIndex: number
}

const COLUMN_LABEL_RE = /[A-Z]+/

function columnLabelToIndex(label: string): number {
  let result = 0
  for (let i = 0; i < label.length; i += 1) {
    result = result * 26 + (label.charCodeAt(i) - 64)
  }
  return result - 1
}

function parseA1(token: string): { row: number; col: number } | null {
  const colMatch = COLUMN_LABEL_RE.exec(token)
  if (!colMatch || colMatch.index !== 0) return null
  const colPart = colMatch[0]
  const rowPart = token.slice(colPart.length)
  if (rowPart.length === 0) return null
  const rowOneBased = Number(rowPart)
  if (!Number.isInteger(rowOneBased) || rowOneBased < 1) return null
  const col = columnLabelToIndex(colPart)
  if (col < 0) return null
  return { row: rowOneBased - 1, col }
}

// Matches one A1 / A1:B2 / Sheet!A1 / 'Quoted sheet'!A1:B2 reference.
// Group 1: optional sheet prefix (unquoted)
// Group 2: optional sheet prefix (single-quoted, unescaped)
// Group 3: start cell
// Group 4: optional ":endCell"
// eslint-disable-next-line max-len
const TOKEN_RE = /(?:(?:([A-Za-z_][\w]*)|'((?:[^']|'')+)')!)?(\$?[A-Z]+\$?\d+)(?::(\$?[A-Z]+\$?\d+))?/g

/**
 * Scan a formula draft (without the leading '=') and return every cell /
 * range reference token in left-to-right order. The function is purely
 * lexical; it does not validate that referenced cells actually exist.
 *
 * - `currentSheetId` is used to fill `sheetId` for tokens with no explicit
 *   sheet prefix.
 * - The draft may include or omit the leading '='; the parser scans the
 *   entire string in either case.
 * - Tokens are deduplicated by their resolved range key; the `colorIndex`
 *   stays stable across duplicates (so highlighting the same cell twice in
 *   the formula gets the same color).
 */
export function parseFormulaReferences(
  draft: string,
  currentSheetId: string | null,
): FormulaReferenceToken[] {
  const tokens: FormulaReferenceToken[] = []
  if (!draft) return tokens

  // Skip the leading '=' so positions report against the full draft.
  const colorByKey = new Map<string, number>()
  let nextColor = 0

  TOKEN_RE.lastIndex = 0
  for (let match: RegExpExecArray | null; (match = TOKEN_RE.exec(draft)) !== null; ) {
    const [full, sheetUnquoted, sheetQuoted, startRaw, endRaw] = match
    const start = match.index
    const end = start + full.length

    const sheetId = sheetUnquoted ?? sheetQuoted?.replace(/''/g, "'") ?? currentSheetId
    const startCoord = parseA1(startRaw.replace(/\$/g, ''))
    if (!startCoord) continue
    const endCoord = endRaw ? parseA1(endRaw.replace(/\$/g, '')) : startCoord
    if (!endCoord) continue

    const range: CellRange = {
      rowStart: Math.min(startCoord.row, endCoord.row),
      rowEnd: Math.max(startCoord.row, endCoord.row),
      colStart: Math.min(startCoord.col, endCoord.col),
      colEnd: Math.max(startCoord.col, endCoord.col),
    }

    const key =
      `${sheetId ?? '<active>'}:${range.rowStart}:${range.colStart}:${range.rowEnd}:${range.colEnd}`
    let colorIndex = colorByKey.get(key)
    if (colorIndex === undefined) {
      colorIndex = nextColor
      nextColor += 1
      colorByKey.set(key, colorIndex)
    }

    tokens.push({
      start,
      end,
      text: full,
      sheetId,
      range,
      colorIndex,
    })
  }

  return tokens
}
