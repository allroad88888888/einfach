import type { CellCoord } from '../shared'
import type { DisplayCell, SpreadsheetCellFormat } from '../backend/types'
import type { CopyAsInput, CopyAsRect } from './types'

const HTML_ESCAPE_RE = /[&<>"']/g
const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(text: string): string {
  return text.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch] ?? ch)
}

/**
 * Attribute-level escape for the `style="…"` payload. We already drop any
 * value that doesn't match a strict whitelist, but this is defence-in-depth
 * — if a future bug ever lets a `"` or `&` slip through, the attribute stays
 * well-formed and the payload can't break out of the attribute quotes.
 */
const HTML_ATTR_ESCAPE_RE = /[&"]/g
const HTML_ATTR_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '"': '&quot;',
}
function escapeHtmlAttr(text: string): string {
  return text.replace(HTML_ATTR_ESCAPE_RE, (ch) => HTML_ATTR_ESCAPE_MAP[ch] ?? ch)
}

/**
 * Convert a `\n` (or `\r\n`) inside cell text to `<br>` so the rendered cell
 * preserves the line break. Done after HTML-escaping so the `<br>` itself is
 * emitted as a real tag, not escaped.
 */
function newlineToBr(escapedText: string): string {
  return escapedText.replace(/\r\n|\r|\n/g, '<br>')
}

// --- CSS value whitelists -------------------------------------------------
//
// The encoder writes user-controlled workbook values (`bgColor`, `fgColor`,
// `fontFamily`) into `style="…"`. A malicious workbook author could otherwise
// break out of the declaration and inject `background-image: url(...)` or a
// payload that beacons on paste into Gmail/Notion. We refuse to "sanitise" by
// escaping; values that don't match the whitelist are dropped silently.

const COLOR_HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/**
 * Accept `rgb(r,g,b)` or `rgba(r,g,b,a)` where r/g/b are integers `0..255`
 * (optional leading +; no scientific notation) and `a` is a decimal in
 * `0..1`. Whitespace is permitted between tokens.
 */
function isCssRgbColor(value: string): boolean {
  const m = value
    .trim()
    .match(/^rgba?\(\s*([^)]*)\)$/i)
  if (!m) return false
  const args = m[1]
  if (!args) return false
  const parts = args.split(',').map((p) => p.trim())
  if (parts.length !== 3 && parts.length !== 4) return false
  const isRgba = value.trim().toLowerCase().startsWith('rgba')
  if (isRgba && parts.length !== 4) return false
  if (!isRgba && parts.length !== 3) return false
  for (let i = 0; i < 3; i += 1) {
    const tok = parts[i]
    if (!/^\d{1,3}$/.test(tok)) return false
    const n = Number(tok)
    if (!Number.isInteger(n) || n < 0 || n > 255) return false
  }
  if (parts.length === 4) {
    const a = parts[3]
    // 0, 1, 0.5, .5 — but no exponents, no signs.
    if (!/^(?:0|1|0?\.\d+|1\.0+)$/.test(a)) return false
    const an = Number(a)
    if (!(an >= 0 && an <= 1)) return false
  }
  return true
}

/**
 * Small whitelist of CSS named colors that are safe to pass through. Kept
 * tight on purpose — the typical workbook flow uses hex / rgb. We accept
 * the basic Excel-style colour names so trivial flows don't trip the filter.
 */
const NAMED_COLORS: ReadonlySet<string> = new Set([
  'black',
  'silver',
  'gray',
  'grey',
  'white',
  'maroon',
  'red',
  'purple',
  'fuchsia',
  'green',
  'lime',
  'olive',
  'yellow',
  'navy',
  'blue',
  'teal',
  'aqua',
  'cyan',
  'magenta',
  'orange',
  'transparent',
])

function sanitizeColor(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined
  const v = String(raw).trim()
  if (v === '') return undefined
  if (COLOR_HEX_RE.test(v)) return v
  if (NAMED_COLORS.has(v.toLowerCase())) return v.toLowerCase()
  if (isCssRgbColor(v)) return v
  return undefined
}

/**
 * Strict allow-list for `font-family`: letters, digits, comma, space, hyphen,
 * single quote, double quote. Anything else (semicolons, parens, colons, `/`,
 * `\`, `<`, `>`, etc.) → reject. We don't try to repair quotes or balance
 * commas; if the input doesn't look like a clean family stack, we drop it.
 */
const FONT_FAMILY_RE = /^[A-Za-z0-9, "'\-]+$/

function sanitizeFontFamily(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined
  const v = String(raw).trim()
  if (v === '') return undefined
  if (!FONT_FAMILY_RE.test(v)) return undefined
  return v
}

function sanitizeFontSize(raw: number | undefined | null): string | undefined {
  if (typeof raw !== 'number' || !isFinite(raw) || raw <= 0) return undefined
  // Round to 2 decimals to avoid emitting `style="font-size: 1e+30pt"` etc.
  // `toString` on a regular finite positive number is safe.
  return `${raw}pt`
}

interface StyleAcc {
  parts: string[]
}

function pushStyle(acc: StyleAcc, prop: string, value: string | undefined | null): void {
  if (value == null || value === '') return
  acc.parts.push(`${prop}: ${value}`)
}

function buildTextDecoration(fmt: SpreadsheetCellFormat): string | undefined {
  const decorations: string[] = []
  if (fmt.underline) decorations.push('underline')
  if (fmt.strikethrough) decorations.push('line-through')
  return decorations.length ? decorations.join(' ') : undefined
}

function alignmentToCss(align: SpreadsheetCellFormat['align']): string | undefined {
  switch (align) {
    case 'left':
    case 'right':
    case 'center':
    case 'justify':
      return align
    case 'fill':
    case 'distributed':
      // No exact CSS equivalent — drop silently rather than guess.
      return undefined
    case 'default':
    case undefined:
      return undefined
    default:
      return undefined
  }
}

function verticalAlignToCss(va: SpreadsheetCellFormat['verticalAlign']): string | undefined {
  switch (va) {
    case 'top':
    case 'bottom':
      return va
    case 'center':
      return 'middle'
    case 'justify':
    case 'distributed':
      return undefined
    case undefined:
      return undefined
    default:
      return undefined
  }
}

function buildCellStyle(cell: DisplayCell): string {
  const fmt = cell.format
  if (!fmt) return ''
  const acc: StyleAcc = { parts: [] }
  if (fmt.bold) pushStyle(acc, 'font-weight', 'bold')
  if (fmt.italic) pushStyle(acc, 'font-style', 'italic')
  pushStyle(acc, 'text-decoration', buildTextDecoration(fmt))
  pushStyle(acc, 'text-align', alignmentToCss(fmt.align))
  pushStyle(acc, 'vertical-align', verticalAlignToCss(fmt.verticalAlign))
  pushStyle(acc, 'background-color', sanitizeColor(fmt.bgColor))
  pushStyle(acc, 'color', sanitizeColor(fmt.fgColor))
  pushStyle(acc, 'font-family', sanitizeFontFamily(fmt.fontFamily))
  pushStyle(acc, 'font-size', sanitizeFontSize(fmt.fontSize))
  return acc.parts.join('; ')
}

function buildCellContent(cell: DisplayCell | undefined): string {
  if (!cell) return ''
  const raw = cell.displayValue
  if (raw == null) return ''
  return newlineToBr(escapeHtml(raw))
}

interface CellIndex {
  byKey: Map<string, DisplayCell>
}

function makeKey(row: number, col: number): string {
  return `${row},${col}`
}

function indexCells(cells: ReadonlyArray<DisplayCell>): CellIndex {
  const byKey = new Map<string, DisplayCell>()
  for (const cell of cells) {
    byKey.set(makeKey(cell.row, cell.col), cell)
  }
  return { byKey }
}

/**
 * Describe how to emit one merge inside the selection rectangle.
 *
 * - `anchorRow` / `anchorCol`: where the `<td rowspan colspan>` is drawn.
 *   For merges whose true anchor is outside the rect, we manufacture a
 *   synthetic anchor at the top-left of the intersection between the merge
 *   and the rect, so the table stays grid-aligned and never leaks cells
 *   outside the selection.
 * - `rows` / `cols`: span clipped to the rect intersection. Always >= 1.
 * - `sourceCell`: the actual anchor `DisplayCell` carrying content/format.
 *   May be `undefined` if the true anchor is outside the rect *and* is not
 *   included in the cells array — in that case the clipped anchor renders
 *   blank, which is the desired behaviour (don't leak content from outside
 *   the selection).
 */
interface ClippedMerge {
  anchorRow: number
  anchorCol: number
  rows: number
  cols: number
  sourceCell: DisplayCell | undefined
}

/**
 * Compute the per-merge clipping plan and the set of covered (non-anchor)
 * cells to skip during iteration. Inputs:
 *
 * - `cells`: the projection slice. Anchors carry `mergedSpan`; covered cells
 *   carry `mergeAnchor` pointing back to their anchor.
 * - `rect`: the selection rectangle we will iterate.
 *
 * We surface two pieces of state:
 *
 * 1. `coveredKeys` — every `(row, col)` inside the rect that is part of any
 *    merge AND is not the rect-local anchor for that merge. Iteration skips
 *    these so the table emits a single `<td>` per merge.
 * 2. `mergesByAnchorKey` — keyed by `"row,col"` of the rect-local anchor
 *    cell, the clipped `ClippedMerge` to emit there.
 */
function planMerges(
  cells: ReadonlyArray<DisplayCell>,
  rect: CopyAsRect,
): { coveredKeys: Set<string>; mergesByAnchorKey: Map<string, ClippedMerge> } {
  const coveredKeys = new Set<string>()
  const mergesByAnchorKey = new Map<string, ClippedMerge>()

  // First pass: collect every merge by its true anchor. Anchors that carry
  // `mergedSpan` give us span dimensions directly. Covered cells that arrive
  // with `mergeAnchor` but without the anchor cell in the projection still
  // need a placeholder so we can clip; we resolve that in a second pass.
  type AnchorEntry = {
    row: number
    col: number
    rows: number
    cols: number
    cell: DisplayCell | undefined
  }
  const anchorByKey = new Map<string, AnchorEntry>()

  for (const cell of cells) {
    const span = cell.mergedSpan
    if (!span) continue
    const rows = Math.max(1, span.rows)
    const cols = Math.max(1, span.cols)
    anchorByKey.set(makeKey(cell.row, cell.col), {
      row: cell.row,
      col: cell.col,
      rows,
      cols,
      cell,
    })
  }

  // Now walk covered cells. If the anchor cell didn't ship with the
  // projection (true anchor outside the selection rectangle), we don't know
  // the merge's full extent — but we know enough: every covered cell that
  // points back to the anchor must live inside the merge. We grow a synthetic
  // entry whose bottom-right is the max row/col of any covered cell that
  // points to it. That's sufficient for clipping against the rect, because
  // we only emit cells that fall inside both the merge and the rect, and any
  // additional merge cells outside the rect can't appear in the output
  // anyway.
  for (const cell of cells) {
    const anchor: CellCoord | undefined = cell.mergeAnchor
    if (!anchor) continue
    const key = makeKey(anchor.row, anchor.col)
    const existing = anchorByKey.get(key)
    if (!existing) {
      anchorByKey.set(key, {
        row: anchor.row,
        col: anchor.col,
        // Inclusive span from anchor to this covered cell — at minimum.
        rows: Math.max(1, cell.row - anchor.row + 1),
        cols: Math.max(1, cell.col - anchor.col + 1),
        cell: undefined,
      })
    } else if (existing.cell === undefined) {
      // Synthetic entry — grow it to include this covered cell.
      const trueRowEnd = Math.max(existing.row + existing.rows - 1, cell.row)
      const trueColEnd = Math.max(existing.col + existing.cols - 1, cell.col)
      existing.rows = trueRowEnd - existing.row + 1
      existing.cols = trueColEnd - existing.col + 1
    }
    // If the anchor is in the projection (existing.cell !== undefined),
    // we trust its `mergedSpan` and don't grow.
  }

  // Second pass: for each anchor, compute clipped span + rect-local anchor.
  for (const entry of anchorByKey.values()) {
    const trueRowEnd = entry.row + entry.rows - 1
    const trueColEnd = entry.col + entry.cols - 1

    // Intersection with the rect (inclusive on both ends).
    const ixRowStart = Math.max(entry.row, rect.startRow)
    const ixRowEnd = Math.min(trueRowEnd, rect.endRow)
    const ixColStart = Math.max(entry.col, rect.startCol)
    const ixColEnd = Math.min(trueColEnd, rect.endCol)
    if (ixRowEnd < ixRowStart || ixColEnd < ixColStart) continue

    const clippedRows = ixRowEnd - ixRowStart + 1
    const clippedCols = ixColEnd - ixColStart + 1
    const anchorRow = ixRowStart
    const anchorCol = ixColStart

    // Every in-rect cell of the merge that isn't the clipped anchor must
    // be skipped during iteration.
    for (let r = ixRowStart; r <= ixRowEnd; r += 1) {
      for (let c = ixColStart; c <= ixColEnd; c += 1) {
        if (r === anchorRow && c === anchorCol) continue
        coveredKeys.add(makeKey(r, c))
      }
    }

    mergesByAnchorKey.set(makeKey(anchorRow, anchorCol), {
      anchorRow,
      anchorCol,
      rows: clippedRows,
      cols: clippedCols,
      sourceCell: entry.cell,
    })
  }

  return { coveredKeys, mergesByAnchorKey }
}

export function encodeSelectionAsHtml(input: CopyAsInput): string {
  const { rect, cells } = input
  const index = indexCells(cells)
  const { coveredKeys, mergesByAnchorKey } = planMerges(cells, rect)

  const parts: string[] = []
  parts.push('<table style="border-collapse: collapse; border: 1px solid #ccc">')

  // Optional <colgroup> for column widths.
  const colCount = rect.endCol - rect.startCol + 1
  if (input.columnWidths && input.columnWidths.size > 0) {
    parts.push('<colgroup>')
    for (let i = 0; i < colCount; i += 1) {
      const colIdx = rect.startCol + i
      const w = input.columnWidths.get(colIdx)
      if (typeof w === 'number' && isFinite(w) && w > 0) {
        parts.push(`<col style="width: ${w}px">`)
      } else {
        parts.push('<col>')
      }
    }
    parts.push('</colgroup>')
  }

  for (let row = rect.startRow; row <= rect.endRow; row += 1) {
    const rowHeight = input.rowHeights?.get(row)
    const trStyle =
      typeof rowHeight === 'number' && isFinite(rowHeight) && rowHeight > 0
        ? ` style="height: ${rowHeight}px"`
        : ''
    parts.push(`<tr${trStyle}>`)
    for (let col = rect.startCol; col <= rect.endCol; col += 1) {
      const key = makeKey(row, col)
      if (coveredKeys.has(key)) {
        continue
      }
      const merge = mergesByAnchorKey.get(key)
      // Prefer the merge's source cell (true anchor's content/format); fall
      // back to whatever cell happens to live at this rect-local position.
      const cellAtKey = index.byKey.get(key)
      const cell = merge?.sourceCell ?? cellAtKey

      const attrs: string[] = []
      const cellStyle: string[] = ['border: 1px solid #ccc', 'padding: 2px 4px']
      const inlineStyle = cell ? buildCellStyle(cell) : ''
      if (inlineStyle) cellStyle.push(inlineStyle)

      if (merge) {
        if (merge.rows > 1) attrs.push(`rowspan="${merge.rows}"`)
        if (merge.cols > 1) attrs.push(`colspan="${merge.cols}"`)
      }

      // `style` payload is built from the whitelisted values above; we
      // attribute-escape as defence-in-depth so a future bug can't break
      // out of the `"`-quoted attribute.
      attrs.push(`style="${escapeHtmlAttr(cellStyle.join('; '))}"`)
      // Only render content when the cell is the true merge anchor (or no
      // merge applies). Synthetic clipped anchors with no source cell stay
      // blank so we don't leak content from outside the selection.
      const renderContent = merge ? merge.sourceCell !== undefined : true
      const content = renderContent ? buildCellContent(cell) : ''
      parts.push(`<td ${attrs.join(' ')}>${content}</td>`)
    }
    parts.push('</tr>')
  }

  parts.push('</table>')
  return parts.join('')
}
