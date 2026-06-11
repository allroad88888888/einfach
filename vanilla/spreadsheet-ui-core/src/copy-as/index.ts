import { atom } from '@einfach/core'
import type { DisplayCell } from '../backend/types'
import type { CopyAsInput, CopyAsResult, CopyAsTextResult } from './types'
import { encodeSelectionAsHtml } from './html-encoder'
import { encodeSelectionAsMarkdown } from './markdown-encoder'

export * from './types'
export { encodeSelectionAsHtml } from './html-encoder'
export { encodeSelectionAsMarkdown } from './markdown-encoder'
export { encodeSelectionAsImage, MAX_EXPORT_PIXELS } from './encodeSelectionAsImage'
export type {
  EncodeSelectionAsImageInput,
  EncodeSelectionAsImageResult,
  EncodeSelectionAsImageSuccess,
  EncodeSelectionAsImageFailure,
  EncodeSelectionAsImageFailureKind,
} from './encodeSelectionAsImage'

/**
 * Last successful copy-as result. Solid host writes this after a clipboard
 * write succeeds; tests and the diagnostics overlay read it. `null` until
 * the first copy-as in a session. Source atom — no derived consumers in
 * core today.
 */
export const lastCopyAsAtom = atom<CopyAsResult | null>(null)
lastCopyAsAtom.debugLabel = 'spreadsheet.copyAs.last'

function makeKey(row: number, col: number): string {
  return `${row},${col}`
}

function indexCells(cells: ReadonlyArray<DisplayCell>): Map<string, DisplayCell> {
  const m = new Map<string, DisplayCell>()
  for (const cell of cells) m.set(makeKey(cell.row, cell.col), cell)
  return m
}

function collectMergeCovered(cells: ReadonlyArray<DisplayCell>): Set<string> {
  const covered = new Set<string>()
  for (const cell of cells) {
    const span = cell.mergedSpan
    if (!span) continue
    const rows = Math.max(1, span.rows)
    const cols = Math.max(1, span.cols)
    for (let r = cell.row; r < cell.row + rows; r += 1) {
      for (let c = cell.col; c < cell.col + cols; c += 1) {
        if (r === cell.row && c === cell.col) continue
        covered.add(makeKey(r, c))
      }
    }
  }
  return covered
}

/**
 * Escape a cell's display value for plain-text (TSV) output. Inner tabs and
 * line breaks become single spaces — this matches what Excel does when it
 * writes a multi-line cell to the clipboard's text/plain flavour, and keeps
 * the TSV grid one row per `\n`.
 */
function escapePlainText(raw: string): string {
  return raw.replace(/\r\n|\r|\n/g, ' ').replace(/\t/g, ' ')
}

export function encodeSelectionAsPlainText(input: CopyAsInput): string {
  const { rect, cells } = input
  const index = indexCells(cells)
  const covered = collectMergeCovered(cells)

  const rowLines: string[] = []
  for (let row = rect.startRow; row <= rect.endRow; row += 1) {
    const parts: string[] = []
    for (let col = rect.startCol; col <= rect.endCol; col += 1) {
      const key = makeKey(row, col)
      if (covered.has(key)) {
        parts.push('')
        continue
      }
      const cell = index.get(key)
      const raw = cell?.displayValue
      parts.push(raw == null ? '' : escapePlainText(raw))
    }
    rowLines.push(parts.join('\t'))
  }
  return rowLines.join('\n')
}

/**
 * Convenience helper: build all three flavours in a single pass over the
 * same input. Solid host uses this to populate the `ClipboardItem` triple
 * + the `lastCopyAsAtom` snapshot.
 */
export function encodeSelectionForClipboard(input: CopyAsInput): CopyAsTextResult {
  return {
    html: encodeSelectionAsHtml(input),
    plainText: encodeSelectionAsPlainText(input),
    markdown: encodeSelectionAsMarkdown(input),
  }
}
