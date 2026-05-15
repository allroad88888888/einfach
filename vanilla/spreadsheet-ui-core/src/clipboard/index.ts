import { atom } from '@einfach/core'
import type { CellCoord } from '../shared'
import type {
  ClipboardIntent,
  ClipboardOperation,
  ClipboardPayloadDescriptor,
  ClipboardPayloadInput,
  ClipboardState,
  ClipboardTargetDescriptor,
  ClipboardTextData,
  ClipboardTsvPasteChunk,
  ClipboardTsvPasteInput,
  ClipboardTsvPastePlan,
  ClipboardTransferInput,
  ClipboardTransferRequest,
} from './types'

export * from './types'

export const CLIPBOARD_ORIGIN_MARKER_PREFIX = '# einfach-clipboard-origin: '
export const DEFAULT_CLIPBOARD_TSV_PASTE_ROWS_PER_CHUNK = 1000

function copyRange(range: ClipboardTargetDescriptor['range']): ClipboardTargetDescriptor['range'] {
  return {
    rowStart: range.rowStart,
    rowEnd: range.rowEnd,
    colStart: range.colStart,
    colEnd: range.colEnd,
  }
}

function rangeCellCount(range: ClipboardTargetDescriptor['range']): number {
  if (range.rowEnd < range.rowStart || range.colEnd < range.colStart) {
    return 0
  }

  return (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
}

export function createClipboardState(): ClipboardState {
  return {
    status: 'idle',
    intent: null,
    source: null,
    target: null,
    payload: null,
    error: null,
  }
}

export function createClipboardPayloadDescriptor(
  input: ClipboardPayloadInput,
): ClipboardPayloadDescriptor {
  const cellCount = rangeCellCount(input.source.range)

  return {
    kind: 'range',
    source: {
      sheetId: input.source.sheetId,
      range: copyRange(input.source.range),
    },
    serialization: input.serialization ?? 'tab-separated',
    cellCount,
    estimatedBytes: input.estimatedBytes ?? cellCount * 8,
    truncated: input.truncated ?? false,
    includesFormulas: input.includesFormulas ?? false,
    includesErrors: input.includesErrors ?? false,
  }
}

export function createClipboardTransferRequest(
  operation: ClipboardOperation,
  input: ClipboardTransferInput,
): ClipboardTransferRequest {
  return {
    operation,
    source: {
      sheetId: input.source.sheetId,
      range: copyRange(input.source.range),
    },
    payload: createClipboardPayloadDescriptor(input),
    target: input.target
      ? {
          sheetId: input.target.sheetId,
          range: copyRange(input.target.range),
        }
      : null,
    revision: input.revision ?? null,
  }
}

export function createClipboardIntent(
  operation: ClipboardOperation,
  input: ClipboardTransferInput,
): ClipboardIntent {
  return {
    type: `clipboard.${operation}` as ClipboardIntent['type'],
    request: createClipboardTransferRequest(operation, input),
  }
}

export function serializeClipboardTsv(data: ClipboardTextData): string {
  const body = data.cells.map((row) => row.join('\t')).join('\n')
  return `${CLIPBOARD_ORIGIN_MARKER_PREFIX}${data.originAddr}\n${body}`
}

export function parseClipboardTsv(text: string, fallbackOrigin: string): ClipboardTextData {
  const normalized = text.replace(/\r\n?/g, '\n')
  let originAddr = fallbackOrigin
  let body = normalized

  if (normalized.startsWith(CLIPBOARD_ORIGIN_MARKER_PREFIX)) {
    const newlineIndex = normalized.indexOf('\n')
    const markerLine = newlineIndex === -1 ? normalized : normalized.slice(0, newlineIndex)
    originAddr = markerLine.slice(CLIPBOARD_ORIGIN_MARKER_PREFIX.length).trim() || fallbackOrigin
    body = newlineIndex === -1 ? '' : normalized.slice(newlineIndex + 1)
  }

  if (body.endsWith('\n')) body = body.slice(0, -1)

  return {
    originAddr,
    cells: body === '' ? [['']] : body.split('\n').map((row) => row.split('\t')),
  }
}

function columnLabelToIndex(letters: string): number {
  if (letters.length === 0) return -1
  let col = 0
  for (let index = 0; index < letters.length; index += 1) {
    const code = letters.toUpperCase().charCodeAt(index) - 64
    if (code < 1 || code > 26) return -1
    col = col * 26 + code
  }
  return col - 1
}

function indexToColumnLabel(col: number): string {
  let current = col
  let label = ''

  do {
    label = String.fromCharCode(65 + (current % 26)) + label
    current = Math.floor(current / 26) - 1
  } while (current >= 0)

  return label
}

function parseFormulaRefCoord(letters: string, digits: string): { row: number; col: number } | null {
  const col = columnLabelToIndex(letters)
  const row = Number(digits) - 1
  if (col < 0 || !Number.isInteger(row) || row < 0) return null
  return { row, col }
}

function parseA1Coord(addr: string): CellCoord | null {
  const match = /^\s*([A-Za-z]+)(\d+)\s*$/.exec(addr)
  if (!match) return null
  return parseFormulaRefCoord(match[1], match[2])
}

function mapFormulaRefs(
  formula: string,
  mapRef: (row: number, col: number) => { row: number; col: number } | null,
): string {
  const rewriteSegment = (segment: string): string => {
    const refPattern = /(?:([A-Za-z_][A-Za-z0-9_]*)!)?([A-Za-z]+)(\d+)/g
    return segment.replace(refPattern, (full, sheetName, letters, digits) => {
      // name tokens (no trailing digits) bypass the rewriter
      if (!digits || digits.length === 0) return full
      const coord = parseFormulaRefCoord(letters, digits)
      if (!coord) return full

      const moved = mapRef(coord.row, coord.col)
      if (moved === null || moved.row < 0 || moved.col < 0) return '#REF!'

      const nextAddr = `${indexToColumnLabel(moved.col)}${moved.row + 1}`
      return sheetName ? `${sheetName}!${nextAddr}` : nextAddr
    })
  }

  let output = ''
  let segment = ''
  for (let index = 0; index < formula.length; index += 1) {
    const char = formula[index]
    if (char !== '"') {
      segment += char
      continue
    }

    output += rewriteSegment(segment)
    segment = ''
    const start = index
    index += 1
    while (index < formula.length) {
      if (formula[index] === '"') {
        if (formula[index + 1] === '"') {
          index += 2
          continue
        }
        break
      }
      index += 1
    }
    output += formula.slice(start, Math.min(index + 1, formula.length))
  }
  return output + rewriteSegment(segment)
}

export function shiftFormulaRefs(formula: string, drow: number, dcol: number): string {
  return mapFormulaRefs(formula, (row, col) => ({ row: row + drow, col: col + dcol }))
}

function normalizeRowsPerChunk(rowsPerChunk: number | undefined): number {
  if (rowsPerChunk === undefined) return DEFAULT_CLIPBOARD_TSV_PASTE_ROWS_PER_CHUNK
  if (!Number.isFinite(rowsPerChunk)) return DEFAULT_CLIPBOARD_TSV_PASTE_ROWS_PER_CHUNK
  return Math.max(1, Math.floor(rowsPerChunk))
}

function readClipboardLineEnd(
  text: string,
  start: number,
): { lineEnd: number; nextStart: number } {
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\n') return { lineEnd: index, nextStart: index + 1 }
    if (char === '\r') {
      return {
        lineEnd: index,
        nextStart: text[index + 1] === '\n' ? index + 2 : index + 1,
      }
    }
  }

  return { lineEnd: text.length, nextStart: text.length }
}

function readClipboardTsvOriginMarker(
  text: string,
  fallbackOriginAddr: string,
): { bodyStart: number; originAddr: string } {
  if (!text.startsWith(CLIPBOARD_ORIGIN_MARKER_PREFIX)) {
    return { bodyStart: 0, originAddr: fallbackOriginAddr }
  }

  const markerLine = readClipboardLineEnd(text, 0)
  const originAddr =
    text.slice(CLIPBOARD_ORIGIN_MARKER_PREFIX.length, markerLine.lineEnd).trim() ||
    fallbackOriginAddr

  return {
    bodyStart: markerLine.nextStart,
    originAddr,
  }
}

function trimOneTrailingLineBreak(text: string, bodyStart: number): number {
  const bodyEnd = text.length
  if (bodyEnd <= bodyStart) return bodyEnd

  const lastChar = text[bodyEnd - 1]
  if (lastChar === '\n') {
    if (bodyEnd - 2 >= bodyStart && text[bodyEnd - 2] === '\r') return bodyEnd - 2
    return bodyEnd - 1
  }
  if (lastChar === '\r') return bodyEnd - 1

  return bodyEnd
}

function* iterateClipboardTsvRows(
  text: string,
  bodyStart: number,
): IterableIterator<string> {
  const bodyEnd = trimOneTrailingLineBreak(text, bodyStart)
  if (bodyEnd === bodyStart) {
    yield ''
    return
  }

  let rowStart = bodyStart
  while (rowStart <= bodyEnd) {
    let lineEnd = rowStart
    while (lineEnd < bodyEnd && text[lineEnd] !== '\n' && text[lineEnd] !== '\r') {
      lineEnd += 1
    }

    yield text.slice(rowStart, lineEnd)

    if (lineEnd >= bodyEnd) return
    rowStart =
      text[lineEnd] === '\r' && text[lineEnd + 1] === '\n' ? lineEnd + 2 : lineEnd + 1
  }
}

function countTsvFields(rowText: string): number {
  let count = 1
  for (let index = 0; index < rowText.length; index += 1) {
    if (rowText[index] === '\t') count += 1
  }
  return count
}

function rowIncludesFormula(rowText: string): boolean {
  let fieldStart = 0
  for (let index = 0; index <= rowText.length; index += 1) {
    if (index !== rowText.length && rowText[index] !== '\t') continue
    if (rowText[fieldStart] === '=') return true
    fieldStart = index + 1
  }
  return false
}

function measureClipboardTsvPaste(
  text: string,
  bodyStart: number,
): { rowCount: number; colCount: number; cellCount: number; includesFormulas: boolean } {
  let rowCount = 0
  let colCount = 0
  let cellCount = 0
  let includesFormulas = false

  for (const rowText of iterateClipboardTsvRows(text, bodyStart)) {
    const fieldCount = countTsvFields(rowText)
    rowCount += 1
    colCount = Math.max(colCount, fieldCount)
    cellCount += fieldCount
    if (!includesFormulas && rowIncludesFormula(rowText)) includesFormulas = true
  }

  return { rowCount, colCount, cellCount, includesFormulas }
}

function createClipboardTsvPasteChunks(
  text: string,
  bodyStart: number,
  sourceOrigin: CellCoord,
  targetOrigin: CellCoord,
  rowsPerChunk: number,
  shiftFormulas: boolean,
): IterableIterator<ClipboardTsvPasteChunk> {
  const chunkTargetOrigin = {
    row: targetOrigin.row,
    col: targetOrigin.col,
  }
  const drow = chunkTargetOrigin.row - sourceOrigin.row
  const dcol = chunkTargetOrigin.col - sourceOrigin.col

  function* chunks(): IterableIterator<ClipboardTsvPasteChunk> {
    let rowOffset = 0
    let chunkRowStart = chunkTargetOrigin.row
    let rowsInChunk = 0
    let cellsInChunk: ClipboardTsvPasteChunk['cells'] = []

    for (const rowText of iterateClipboardTsvRows(text, bodyStart)) {
      if (rowsInChunk === 0) chunkRowStart = chunkTargetOrigin.row + rowOffset

      const fields = rowText.split('\t')
      for (let colOffset = 0; colOffset < fields.length; colOffset += 1) {
        const rawInput = fields[colOffset]
        cellsInChunk.push({
          row: chunkTargetOrigin.row + rowOffset,
          col: chunkTargetOrigin.col + colOffset,
          input:
            shiftFormulas && rawInput.startsWith('=')
              ? shiftFormulaRefs(rawInput, drow, dcol)
              : rawInput,
        })
      }

      rowOffset += 1
      rowsInChunk += 1

      if (rowsInChunk >= rowsPerChunk) {
        yield {
          rowStart: chunkRowStart,
          rowEnd: chunkRowStart + rowsInChunk - 1,
          rowCount: rowsInChunk,
          cells: cellsInChunk,
        }
        rowsInChunk = 0
        cellsInChunk = []
      }
    }

    if (rowsInChunk > 0) {
      yield {
        rowStart: chunkRowStart,
        rowEnd: chunkRowStart + rowsInChunk - 1,
        rowCount: rowsInChunk,
        cells: cellsInChunk,
      }
    }
  }

  return chunks()
}

export function createClipboardTsvPastePlan(
  input: ClipboardTsvPasteInput,
): ClipboardTsvPastePlan {
  const text = input.text
  const fallbackOriginAddr = input.fallbackOriginAddr ?? 'A1'
  const marker = readClipboardTsvOriginMarker(text, fallbackOriginAddr)
  const sourceOrigin =
    parseA1Coord(marker.originAddr) ??
    parseA1Coord(fallbackOriginAddr) ?? {
      row: input.targetOrigin.row,
      col: input.targetOrigin.col,
    }
  const targetOrigin = {
    row: input.targetOrigin.row,
    col: input.targetOrigin.col,
  }
  const rowsPerChunk = normalizeRowsPerChunk(input.rowsPerChunk)
  const shiftFormulas = input.shiftFormulas ?? true
  const measured = measureClipboardTsvPaste(text, marker.bodyStart)

  return {
    originAddr: marker.originAddr,
    sourceOrigin: {
      row: sourceOrigin.row,
      col: sourceOrigin.col,
    },
    targetOrigin,
    rowCount: measured.rowCount,
    colCount: measured.colCount,
    cellCount: measured.cellCount,
    includesFormulas: measured.includesFormulas,
    estimatedBytes: text.length,
    estimatedRange: {
      rowStart: targetOrigin.row,
      rowEnd: targetOrigin.row + measured.rowCount - 1,
      colStart: targetOrigin.col,
      colEnd: targetOrigin.col + measured.colCount - 1,
    },
    rowsPerChunk,
    chunks: () =>
      createClipboardTsvPasteChunks(
        text,
        marker.bodyStart,
        sourceOrigin,
        targetOrigin,
        rowsPerChunk,
        shiftFormulas,
      ),
  }
}

export function copyClipboardState(
  state: ClipboardState,
  input: ClipboardTransferInput,
): ClipboardState {
  const intent = createClipboardIntent('copy', input)
  return {
    status: 'copying',
    intent,
    source: intent.request.source,
    target: intent.request.target,
    payload: intent.request.payload,
    error: null,
  }
}

export function cutClipboardState(
  state: ClipboardState,
  input: ClipboardTransferInput,
): ClipboardState {
  const intent = createClipboardIntent('cut', input)
  return {
    status: 'cutting',
    intent,
    source: intent.request.source,
    target: intent.request.target,
    payload: intent.request.payload,
    error: null,
  }
}

export function pasteClipboardState(
  state: ClipboardState,
  input: ClipboardTransferInput,
): ClipboardState {
  const intent = createClipboardIntent('paste', input)
  return {
    status: 'pasting',
    intent,
    source: intent.request.source,
    target: intent.request.target,
    payload: intent.request.payload,
    error: null,
  }
}

export function markClipboardReadyState(state: ClipboardState): ClipboardState {
  if (state.payload === null) {
    return state
  }

  return {
    ...state,
    status: 'ready',
  }
}

export function setClipboardErrorState(
  state: ClipboardState,
  error: ClipboardState['error'],
): ClipboardState {
  return {
    ...state,
    status: error === null ? 'idle' : 'error',
    error,
  }
}

export function clearClipboardState(): ClipboardState {
  return createClipboardState()
}

export const clipboardStateAtom = atom<ClipboardState>(createClipboardState())
clipboardStateAtom.debugLabel = 'spreadsheet.clipboard.state'

export const clipboardIntentAtom = atom<ClipboardIntent | null>(null)
clipboardIntentAtom.debugLabel = 'spreadsheet.clipboard.intent'

export const copyClipboardAtom = atom(
  (get) => get(clipboardStateAtom),
  (get, set, input: ClipboardTransferInput) => {
    const nextState = copyClipboardState(get(clipboardStateAtom), input)
    set(clipboardStateAtom, nextState)
    set(clipboardIntentAtom, nextState.intent)
    return nextState.intent
  },
)
copyClipboardAtom.debugLabel = 'spreadsheet.clipboard.copy'

export const cutClipboardAtom = atom(
  (get) => get(clipboardStateAtom),
  (get, set, input: ClipboardTransferInput) => {
    const nextState = cutClipboardState(get(clipboardStateAtom), input)
    set(clipboardStateAtom, nextState)
    set(clipboardIntentAtom, nextState.intent)
    return nextState.intent
  },
)
cutClipboardAtom.debugLabel = 'spreadsheet.clipboard.cut'

export const pasteClipboardAtom = atom(
  (get) => get(clipboardStateAtom),
  (get, set, input: ClipboardTransferInput) => {
    const nextState = pasteClipboardState(get(clipboardStateAtom), input)
    set(clipboardStateAtom, nextState)
    set(clipboardIntentAtom, nextState.intent)
    return nextState.intent
  },
)
pasteClipboardAtom.debugLabel = 'spreadsheet.clipboard.paste'

export const clearClipboardAtom = atom(
  (get) => get(clipboardStateAtom),
  (_get, set) => {
    set(clipboardStateAtom, clearClipboardState())
    set(clipboardIntentAtom, null)
  },
)
clearClipboardAtom.debugLabel = 'spreadsheet.clipboard.clear'

export const markClipboardReadyAtom = atom(
  (get) => get(clipboardStateAtom),
  (get, set) => {
    set(clipboardStateAtom, markClipboardReadyState(get(clipboardStateAtom)))
  },
)
markClipboardReadyAtom.debugLabel = 'spreadsheet.clipboard.ready'

export const setClipboardErrorAtom = atom(
  (get) => get(clipboardStateAtom),
  (get, set, error: ClipboardState['error']) => {
    const nextState = setClipboardErrorState(get(clipboardStateAtom), error)
    set(clipboardStateAtom, nextState)
    return nextState
  },
)
setClipboardErrorAtom.debugLabel = 'spreadsheet.clipboard.error'
