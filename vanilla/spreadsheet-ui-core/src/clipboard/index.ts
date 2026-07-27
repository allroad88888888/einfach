import { atom, type Atom } from '@einfach/core'
import type { CellCoord, CellRange } from '../shared'
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

const EXCEL_MAX_FORMULA_ROW_INDEX = 1_048_575
const EXCEL_MAX_FORMULA_COL_INDEX = 16_383

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

function parseFormulaRefCoord(
  letters: string,
  digits: string,
): { row: number; col: number } | null {
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

const FORMULA_IDENTIFIER_CHAR_PATTERN = /[\p{L}\p{M}\p{N}\p{Pc}.\\$\u200C\u200D]/u

function formulaCodePointAt(value: string, index: number): string | undefined {
  const codePoint = value.codePointAt(index)
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint)
}

function formulaCodePointBefore(value: string, index: number): string | undefined {
  if (index <= 0) return undefined

  const previous = value.charCodeAt(index - 1)
  if (previous >= 0xdc00 && previous <= 0xdfff && index >= 2) {
    const leading = value.charCodeAt(index - 2)
    if (leading >= 0xd800 && leading <= 0xdbff) {
      return value.slice(index - 2, index)
    }
  }
  return value[index - 1]
}

function isFormulaIdentifierChar(char: string | undefined): boolean {
  return char !== undefined && FORMULA_IDENTIFIER_CHAR_PATTERN.test(char)
}

function isFormulaFunctionCallHead(formula: string, tokenEnd: number): boolean {
  let next = tokenEnd
  while (next < formula.length && /\s/.test(formula[next])) next += 1
  return formula[next] === '('
}

function scanFormulaQuotedSegment(formula: string, start: number, quote: '"' | "'"): number | null {
  let index = start + 1
  while (index < formula.length) {
    if (formula[index] !== quote) {
      index += 1
      continue
    }
    if (formula[index + 1] === quote) {
      index += 2
      continue
    }
    return index + 1
  }
  return null
}

function isInExcelFormulaGrid(row: number, col: number): boolean {
  return (
    Number.isInteger(row) &&
    Number.isInteger(col) &&
    row >= 0 &&
    col >= 0 &&
    row <= EXCEL_MAX_FORMULA_ROW_INDEX &&
    col <= EXCEL_MAX_FORMULA_COL_INDEX
  )
}

interface FormulaRefScanToken {
  readonly row: number
  readonly col: number
  readonly start: number
  readonly end: number
  readonly qualifier?: string
  readonly qualifierSeparator?: number
}

interface FormulaRefMapResult {
  readonly formula: string
  readonly complete: boolean
}

interface FormulaRefScanVisitor {
  readonly visitRef?: (token: FormulaRefScanToken) => void
  readonly visitPunctuation?: (kind: ':' | '!', index: number) => void
}

interface FormulaRefQualifier {
  readonly name: string
  readonly separator: number
}

function findUnquotedFormulaRefQualifier(
  formula: string,
  referenceStart: number,
): FormulaRefQualifier | undefined {
  let separator = referenceStart - 1
  while (separator >= 0 && /\s/.test(formula[separator])) separator -= 1
  if (formula[separator] !== '!') return undefined

  let qualifierStart = separator
  while (qualifierStart > 0) {
    const previous = formulaCodePointBefore(formula, qualifierStart)
    if (!isFormulaIdentifierChar(previous)) break
    qualifierStart -= previous?.length ?? 0
  }
  if (qualifierStart === separator) return undefined

  return {
    name: formula.slice(qualifierStart, separator),
    separator,
  }
}

function mapFormulaRefs(
  formula: string,
  mapRef: (
    row: number,
    col: number,
    anchors: { rowAbsolute: boolean; colAbsolute: boolean },
  ) => { row: number; col: number } | null,
  visitor: FormulaRefScanVisitor = {},
): FormulaRefMapResult {
  let output = ''
  let index = 0
  let pendingQualifier: FormulaRefQualifier | undefined
  const a1RefPattern = /(\$?)([A-Za-z]+)(\$?)(\d+)/y
  while (index < formula.length) {
    const char = formula[index]

    if (char === '[' || char === ']') return { formula, complete: false }

    if (char === '"' || char === "'") {
      const segmentEnd = scanFormulaQuotedSegment(formula, index, char)
      if (segmentEnd === null) return { formula, complete: false }

      if (char === "'") {
        const qualifier = formula.slice(index, segmentEnd)
        if (qualifier.includes('[') || qualifier.includes(']')) {
          return { formula, complete: false }
        }
        if (formula[segmentEnd] !== '!') return { formula, complete: false }

        const name = formula
          .slice(index + 1, segmentEnd - 1)
          .replace(/''/g, "'")
        if (name.length === 0) return { formula, complete: false }
        pendingQualifier = { name, separator: segmentEnd }
        visitor.visitPunctuation?.('!', segmentEnd)
        output += formula.slice(index, segmentEnd + 1)
        index = segmentEnd + 1
      } else {
        if (pendingQualifier) return { formula, complete: false }
        output += formula.slice(index, segmentEnd)
        index = segmentEnd
      }
      continue
    }

    if (pendingQualifier && /\s/.test(char)) {
      output += char
      index += 1
      continue
    }

    a1RefPattern.lastIndex = index
    const match = a1RefPattern.exec(formula)
    if (!match) {
      if (pendingQualifier) return { formula, complete: false }
      if (char === ':' || char === '!') {
        visitor.visitPunctuation?.(char, index)
      }
      output += char
      index += 1
      continue
    }

    const [full, colAnchor, letters, rowAnchor, digits] = match
    const tokenEnd = index + full.length
    if (
      isFormulaIdentifierChar(formulaCodePointBefore(formula, index)) ||
      isFormulaIdentifierChar(formulaCodePointAt(formula, tokenEnd)) ||
      isFormulaFunctionCallHead(formula, tokenEnd) ||
      formula[tokenEnd] === '!'
    ) {
      if (pendingQualifier) return { formula, complete: false }
      output += full
      index = tokenEnd
      continue
    }

    const coord = parseFormulaRefCoord(letters, digits)
    if (!coord || !isInExcelFormulaGrid(coord.row, coord.col)) {
      if (pendingQualifier) return { formula, complete: false }
      output += full
      index = tokenEnd
      continue
    }

    const qualifier = pendingQualifier ?? findUnquotedFormulaRefQualifier(formula, index)
    visitor.visitRef?.({
      row: coord.row,
      col: coord.col,
      start: index,
      end: tokenEnd,
      ...(qualifier
        ? {
            qualifier: qualifier.name,
            qualifierSeparator: qualifier.separator,
          }
        : {}),
    })
    pendingQualifier = undefined
    const moved = mapRef(coord.row, coord.col, {
      rowAbsolute: rowAnchor === '$',
      colAbsolute: colAnchor === '$',
    })
    if (moved === null || !isInExcelFormulaGrid(moved.row, moved.col)) {
      output += '#REF!'
      index = tokenEnd
      continue
    }

    output += `${colAnchor}${indexToColumnLabel(moved.col)}${rowAnchor}${moved.row + 1}`
    index = tokenEnd
  }
  if (pendingQualifier) return { formula, complete: false }
  return { formula: output, complete: true }
}

export function shiftFormulaRefs(formula: string, drow: number, dcol: number): string {
  return mapFormulaRefs(formula, (row, col, anchors) => ({
    row: anchors.rowAbsolute ? row : row + drow,
    col: anchors.colAbsolute ? col : col + dcol,
  })).formula
}

/**
 * A lexically complete ordinary A1 reference. A missing qualifier means the
 * reference is relative to the sheet containing the formula.
 */
export interface FormulaA1ReferenceRange extends CellRange {
  readonly qualifier?: string
}

export type FormulaReferenceRangeScan = readonly FormulaA1ReferenceRange[] | null

/**
 * Collect ordinary A1 dependencies with the exact lexical boundaries used
 * when shifting copied formulas. `null` means the scanner could not safely
 * classify the whole expression; callers must not infer a partial dependency
 * set.
 */
export function collectFormulaReferenceRanges(formula: string): FormulaReferenceRangeScan {
  const tokens: FormulaRefScanToken[] = []
  const colonPositions = new Set<number>()
  const bangPositions = new Set<number>()
  const scan = mapFormulaRefs(
    formula,
    (row, col) => ({ row, col }),
    {
      visitRef: (token) => tokens.push(token),
      visitPunctuation: (kind, index) => {
        if (kind === ':') colonPositions.add(index)
        else bangPositions.add(index)
      },
    },
  )
  if (!scan.complete) return null

  const references: FormulaA1ReferenceRange[] = []
  const consumedColons = new Set<number>()
  const consumedBangs = new Set<number>()
  for (let index = 0; index < tokens.length; index += 1) {
    const start = tokens[index]
    const end = tokens[index + 1]
    const separator = end ? formula.slice(start.end, end.start) : ''
    if (end && /^\s*:\s*$/.test(separator)) {
      if (!start.qualifier && end.qualifier) return null
      if (
        start.qualifier &&
        end.qualifier &&
        start.qualifier !== end.qualifier
      ) {
        return null
      }

      const colonPosition = start.end + separator.indexOf(':')
      consumedColons.add(colonPosition)
      if (start.qualifierSeparator !== undefined) {
        consumedBangs.add(start.qualifierSeparator)
      }
      if (end.qualifierSeparator !== undefined) {
        consumedBangs.add(end.qualifierSeparator)
      }
      references.push({
        ...(start.qualifier ? { qualifier: start.qualifier } : {}),
        rowStart: Math.min(start.row, end.row),
        rowEnd: Math.max(start.row, end.row),
        colStart: Math.min(start.col, end.col),
        colEnd: Math.max(start.col, end.col),
      })
      index += 1
      continue
    }

    if (start.qualifierSeparator !== undefined) {
      consumedBangs.add(start.qualifierSeparator)
    }
    references.push({
      ...(start.qualifier ? { qualifier: start.qualifier } : {}),
      rowStart: start.row,
      rowEnd: start.row,
      colStart: start.col,
      colEnd: start.col,
    })
  }

  for (const position of colonPositions) {
    if (!consumedColons.has(position)) return null
  }
  for (const position of bangPositions) {
    if (!consumedBangs.has(position)) return null
  }

  return references
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

const clipboardStateBackingAtom = atom<ClipboardState>(createClipboardState())
clipboardStateBackingAtom.debugLabel = 'spreadsheet.clipboard.stateBacking'

export const clipboardStateAtom: Atom<ClipboardState> = atom((get) =>
  get(clipboardStateBackingAtom),
)
clipboardStateAtom.debugLabel = 'spreadsheet.clipboard.state'

const clipboardIntentBackingAtom = atom<ClipboardIntent | null>(null)
clipboardIntentBackingAtom.debugLabel = 'spreadsheet.clipboard.intentBacking'

export const clipboardIntentAtom: Atom<ClipboardIntent | null> = atom((get) =>
  get(clipboardIntentBackingAtom),
)
clipboardIntentAtom.debugLabel = 'spreadsheet.clipboard.intent'

export const copyClipboardAtom = atom(
  (get) => get(clipboardStateBackingAtom),
  (get, set, input: ClipboardTransferInput) => {
    const nextState = copyClipboardState(get(clipboardStateBackingAtom), input)
    set(clipboardStateBackingAtom, nextState)
    set(clipboardIntentBackingAtom, nextState.intent)
    return nextState.intent
  },
)
copyClipboardAtom.debugLabel = 'spreadsheet.clipboard.copy'

export const cutClipboardAtom = atom(
  (get) => get(clipboardStateBackingAtom),
  (get, set, input: ClipboardTransferInput) => {
    const nextState = cutClipboardState(get(clipboardStateBackingAtom), input)
    set(clipboardStateBackingAtom, nextState)
    set(clipboardIntentBackingAtom, nextState.intent)
    return nextState.intent
  },
)
cutClipboardAtom.debugLabel = 'spreadsheet.clipboard.cut'

export const pasteClipboardAtom = atom(
  (get) => get(clipboardStateBackingAtom),
  (get, set, input: ClipboardTransferInput) => {
    const nextState = pasteClipboardState(get(clipboardStateBackingAtom), input)
    set(clipboardStateBackingAtom, nextState)
    set(clipboardIntentBackingAtom, nextState.intent)
    return nextState.intent
  },
)
pasteClipboardAtom.debugLabel = 'spreadsheet.clipboard.paste'

export const clearClipboardAtom = atom(
  (get) => get(clipboardStateBackingAtom),
  (_get, set) => {
    set(clipboardStateBackingAtom, clearClipboardState())
    set(clipboardIntentBackingAtom, null)
  },
)
clearClipboardAtom.debugLabel = 'spreadsheet.clipboard.clear'

export const markClipboardReadyAtom = atom(
  (get) => get(clipboardStateBackingAtom),
  (get, set) => {
    set(
      clipboardStateBackingAtom,
      markClipboardReadyState(get(clipboardStateBackingAtom)),
    )
  },
)
markClipboardReadyAtom.debugLabel = 'spreadsheet.clipboard.ready'

export const setClipboardErrorAtom = atom(
  (get) => get(clipboardStateBackingAtom),
  (get, set, error: ClipboardState['error']) => {
    const nextState = setClipboardErrorState(get(clipboardStateBackingAtom), error)
    set(clipboardStateBackingAtom, nextState)
    return nextState
  },
)
setClipboardErrorAtom.debugLabel = 'spreadsheet.clipboard.error'
