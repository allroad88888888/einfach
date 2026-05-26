import type { DisplayCell } from '../backend/types'
import type { CopyAsInput, CopyAsRect } from './types'

function makeKey(row: number, col: number): string {
  return `${row},${col}`
}

function inRect(rect: CopyAsRect, row: number, col: number): boolean {
  return (
    row >= rect.startRow &&
    row <= rect.endRow &&
    col >= rect.startCol &&
    col <= rect.endCol
  )
}

function indexCells(cells: ReadonlyArray<DisplayCell>): Map<string, DisplayCell> {
  const m = new Map<string, DisplayCell>()
  for (const cell of cells) m.set(makeKey(cell.row, cell.col), cell)
  return m
}

/**
 * Cells that should render blank in the GFM table. GFM tables cannot
 * express row/colspan, so we drop merge content into the *anchor cell only*
 * and leave every other covered cell blank. We detect "covered" via either
 * direction in the projection:
 *
 * - Cells that carry `mergedSpan` are anchors — we mark every non-(row,col)
 *   coordinate of the span as covered.
 * - Cells that carry `mergeAnchor` are covered — they always render blank.
 *   In particular this catches the case where the anchor is OUTSIDE the
 *   selection rect (so the anchor cell isn't in the projection at all),
 *   which would otherwise leave the covered cells rendering their
 *   placeholder `displayValue` and leak phantom content.
 *
 * For the four combinations of anchor/covered × in-rect/out-of-rect:
 *
 * | anchor in rect | covered in rect | behaviour                          |
 * |----------------|-----------------|------------------------------------|
 * | yes            | yes             | anchor writes content; covered blank |
 * | yes            | no              | anchor writes content; covered N/A   |
 * | no             | yes             | covered renders blank (no leakage)   |
 * | no             | no              | merge irrelevant                     |
 */
function collectMergeCovered(
  cells: ReadonlyArray<DisplayCell>,
  rect: CopyAsRect,
): Set<string> {
  const covered = new Set<string>()

  for (const cell of cells) {
    const span = cell.mergedSpan
    if (span) {
      const rows = Math.max(1, span.rows)
      const cols = Math.max(1, span.cols)
      for (let r = cell.row; r < cell.row + rows; r += 1) {
        for (let c = cell.col; c < cell.col + cols; c += 1) {
          if (r === cell.row && c === cell.col) continue
          if (!inRect(rect, r, c)) continue
          covered.add(makeKey(r, c))
        }
      }
    }

    // Covered cell carrying a back-reference to its (possibly out-of-rect)
    // anchor — always treat the cell itself as blank when it falls inside
    // the selection.
    if (cell.mergeAnchor && inRect(rect, cell.row, cell.col)) {
      // Anchor's own coordinate isn't a covered cell — guard the case where
      // a buggy projection sets `mergeAnchor` pointing to itself.
      if (cell.mergeAnchor.row !== cell.row || cell.mergeAnchor.col !== cell.col) {
        covered.add(makeKey(cell.row, cell.col))
      }
    }
  }

  return covered
}

/**
 * Escape characters that have meaning in a GFM table cell:
 *   - `|` would prematurely close the column.
 *   - `\` must be doubled so we don't accidentally escape a following pipe.
 *   - Newlines become `<br>` because GFM table cells are single-line.
 */
function escapeMarkdownCell(raw: string): string {
  return raw
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, '<br>')
}

function wrapFormatting(text: string, cell: DisplayCell | undefined): string {
  if (!cell || !cell.format) return text
  // Empty strings stay empty even with bold/italic — wrapping `**` around an
  // empty string produces `****`, which GFM renderers parse as literal text.
  if (text === '') return text
  let out = text
  if (cell.format.italic) out = `*${out}*`
  if (cell.format.bold) out = `**${out}**`
  // Underline / strikethrough / colors — GFM tables can't carry these,
  // dropped silently.
  return out
}

function buildCellContent(cell: DisplayCell | undefined): string {
  if (!cell) return ''
  const raw = cell.displayValue
  if (raw == null) return ''
  return wrapFormatting(escapeMarkdownCell(raw), cell)
}

export function encodeSelectionAsMarkdown(input: CopyAsInput): string {
  const { rect, cells } = input
  const index = indexCells(cells)
  const covered = collectMergeCovered(cells, rect)
  const colCount = rect.endCol - rect.startCol + 1

  const renderRow = (row: number): string => {
    const parts: string[] = []
    for (let col = rect.startCol; col <= rect.endCol; col += 1) {
      const key = makeKey(row, col)
      if (covered.has(key)) {
        parts.push('')
      } else {
        parts.push(buildCellContent(index.get(key)))
      }
    }
    return `| ${parts.join(' | ')} |`
  }

  const lines: string[] = []
  lines.push(renderRow(rect.startRow))
  // GFM separator — three dashes per column is the minimum that satisfies
  // every renderer; we use exactly three regardless of header width.
  const sep = '|' + Array.from({ length: colCount }, () => ' --- ').join('|') + '|'
  lines.push(sep)
  for (let row = rect.startRow + 1; row <= rect.endRow; row += 1) {
    lines.push(renderRow(row))
  }

  return lines.join('\n')
}
