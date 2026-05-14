import type {
  BackendMutationResult,
  CellRange,
  ClearRangeRequest,
  DeleteColumnsRequest,
  DeleteRowsRequest,
  DisplayCell,
  InsertColumnsRequest,
  InsertRowsRequest,
  ProjectionRevision,
  RangeProjectionRequest,
  RangeProjectionResult,
  ReorderSheetRequest,
  ResolveDataEdgeRequest,
  ResolveDataEdgeResult,
  SetCellInputRequest,
  SetColumnWidthRequest,
  SetFormatRangeRequest,
  SetRowHeightRequest,
  SheetMutationResult,
  SpreadsheetBackend,
  SpreadsheetCellFormat,
  SpreadsheetSheetMetadata,
  VisibleProjectionRequest,
  ViewportSizeProjectionRequest,
  ViewportSizeProjectionResult,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import { reorderSheetMetadata } from '@einfach/spreadsheet-ui-core'

import type { CellFormatJSON, FormatRangeSnapshot } from '../../src/types'
import {
  createWorkerWorkbook,
  type CellSnapshotWire,
  type CellWire,
  type SparseCellWire,
  type SparseRangeWire,
  type WorkerLike,
  type WorkerWorkbookClient,
  type WorkbookSheetMeta,
} from '../../src/wasm-workbook-proxy'

export interface WorkerWorkbookBackendSheetInput {
  id?: string
  name: string
}

export interface WorkerWorkbookSpreadsheetBackendOptions {
  client?: WorkerWorkbookClient
  workerFactory?: () => WorkerLike
  sheets?: readonly (string | WorkerWorkbookBackendSheetInput)[]
  revision?: ProjectionRevision
  afterInit?: (
    client: WorkerWorkbookClient,
    sheets: WorkerWorkbookBackendSheet[],
  ) => Promise<void> | void
}

export interface WorkerWorkbookSpreadsheetBackend extends SpreadsheetBackend {
  ready(): Promise<WorkerWorkbookBackendSheet[]>
  sheets(): WorkerWorkbookBackendSheet[]
  dispose(): void
}

export interface WorkerWorkbookBackendSheet {
  id: string
  idx: number
  name: string
}

type SheetLookup = {
  sheets: WorkerWorkbookBackendSheet[]
  byId: Map<string, WorkerWorkbookBackendSheet>
}

const DEFAULT_SHEETS = ['Sheet1']

function normalizeSheetInputs(
  sheets: readonly (string | WorkerWorkbookBackendSheetInput)[] | undefined,
): WorkerWorkbookBackendSheetInput[] {
  const input = sheets && sheets.length > 0 ? sheets : DEFAULT_SHEETS
  return input.map((sheet, index) =>
    typeof sheet === 'string'
      ? {
          id: `sheet-${index + 1}`,
          name: sheet,
        }
      : {
          id: sheet.id ?? `sheet-${index + 1}`,
          name: sheet.name,
        },
  )
}

function buildSheetLookup(
  inputs: WorkerWorkbookBackendSheetInput[],
  metas: WorkbookSheetMeta[],
): SheetLookup {
  const sheets = metas.map((meta, index) => {
    const input = inputs[index]
    return {
      id: input?.id ?? `sheet-${meta.idx + 1}`,
      idx: meta.idx,
      name: meta.name,
    }
  })
  const byId = new Map<string, WorkerWorkbookBackendSheet>()

  for (const sheet of sheets) {
    byId.set(sheet.id, sheet)
    byId.set(sheet.name, sheet)
    byId.set(String(sheet.idx), sheet)
    byId.set(`sheet-${sheet.idx + 1}`, sheet)
  }

  return { sheets, byId }
}

function buildSheetLookupFromSheets(sheets: WorkerWorkbookBackendSheet[]): SheetLookup {
  const byId = new Map<string, WorkerWorkbookBackendSheet>()

  for (const sheet of sheets) {
    byId.set(sheet.id, sheet)
    byId.set(sheet.name, sheet)
    byId.set(String(sheet.idx), sheet)
    byId.set(`sheet-${sheet.idx + 1}`, sheet)
  }

  return { sheets, byId }
}

function syncSheetLookup(
  metas: WorkbookSheetMeta[],
  existingSheets: readonly WorkerWorkbookBackendSheet[],
): SheetLookup {
  const usedIds = new Set<string>()
  const sheets = metas.map((meta, index) => {
    const existing =
      existingSheets.find((sheet) => sheet.name === meta.name) ??
      existingSheets[index] ??
      existingSheets.find((sheet) => sheet.idx === meta.idx)
    let id = existing?.id ?? `sheet-${meta.idx + 1}`

    if (usedIds.has(id)) {
      let nextIdIndex = meta.idx + 1
      do {
        nextIdIndex += 1
        id = `sheet-${nextIdIndex}`
      } while (usedIds.has(id))
    }

    usedIds.add(id)
    return {
      id,
      idx: meta.idx,
      name: meta.name,
    }
  })

  return buildSheetLookupFromSheets(sheets)
}

function toSheetMetadata(
  sheets: readonly WorkerWorkbookBackendSheet[],
): SpreadsheetSheetMetadata[] {
  return sheets.map((sheet, index) => ({
    id: sheet.id,
    name: sheet.name,
    index,
  }))
}

function orderWorkerSheets(
  sheets: readonly WorkerWorkbookBackendSheet[],
  orderIds: readonly string[] | null,
): WorkerWorkbookBackendSheet[] {
  if (!orderIds) {
    return sheets.map((sheet) => ({ ...sheet }))
  }

  const byId = new Map(sheets.map((sheet) => [sheet.id, sheet]))
  const ordered: WorkerWorkbookBackendSheet[] = []
  const used = new Set<string>()

  for (const id of orderIds) {
    const sheet = byId.get(id)
    if (!sheet || used.has(sheet.id)) continue
    ordered.push({ ...sheet })
    used.add(sheet.id)
  }

  for (const sheet of sheets) {
    if (used.has(sheet.id)) continue
    ordered.push({ ...sheet })
    used.add(sheet.id)
  }

  return ordered
}

function hasSameSheetOrder(
  left: readonly WorkerWorkbookBackendSheet[],
  right: readonly WorkerWorkbookBackendSheet[],
): boolean {
  return left.length === right.length && left.every((sheet, index) => sheet.id === right[index]?.id)
}

function normalizeDimensionSize(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.max(1, Math.round(value))
}

function shiftDimensionMap(
  sizes: Map<number, number>,
  index: number,
  count: number,
  direction: 1 | -1,
) {
  const next = new Map<number, number>()
  const deleteEnd = index + count - 1

  for (const [sizeIndex, size] of sizes) {
    if (direction === -1 && sizeIndex >= index && sizeIndex <= deleteEnd) {
      continue
    }

    const nextIndex =
      sizeIndex >= (direction === 1 ? index : deleteEnd + 1)
        ? sizeIndex + count * direction
        : sizeIndex
    if (nextIndex >= 0) {
      next.set(nextIndex, size)
    }
  }

  sizes.clear()
  for (const [sizeIndex, size] of next) sizes.set(sizeIndex, size)
}

function getColumnLabel(index: number): string {
  let value = index + 1
  let label = ''

  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }

  return label
}

function toA1(row: number, col: number): string {
  return `${getColumnLabel(col)}${row + 1}`
}

function parseA1(addr: string): { row: number; col: number } | null {
  const match = addr.toUpperCase().match(/^([A-Z]+)(\d+)$/)
  if (!match) {
    return null
  }

  let col = 0
  for (let index = 0; index < match[1].length; index += 1) {
    col = col * 26 + (match[1].charCodeAt(index) - 64)
  }

  const row = Number(match[2]) - 1
  if (!Number.isInteger(row) || row < 0) {
    return null
  }

  return {
    row,
    col: col - 1,
  }
}

function toSparseRange(sheet: number, range: CellRange): SparseRangeWire {
  return {
    sheet,
    startRow: range.rowStart,
    startCol: range.colStart,
    endRow: range.rowEnd,
    endCol: range.colEnd,
  }
}

function structuralMutationResult(
  request:
    | InsertRowsRequest
    | DeleteRowsRequest
    | InsertColumnsRequest
    | DeleteColumnsRequest,
  revision: ProjectionRevision,
): BackendMutationResult {
  return {
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision ?? revision,
  }
}

function cloneFormat(format: SpreadsheetCellFormat): SpreadsheetCellFormat {
  const clone: SpreadsheetCellFormat = { ...format }
  if (format.numberFormat) clone.numberFormat = { ...format.numberFormat }
  return clone
}

function normalizeFormat(
  format: SpreadsheetCellFormat | null | undefined,
): SpreadsheetCellFormat | undefined {
  if (!format || isDefaultFormat(format)) return undefined
  return cloneFormat(format)
}

function isDefaultFormat(format: SpreadsheetCellFormat): boolean {
  const numberFormat = format.numberFormat
  const numberFormatIsDefault = !numberFormat || numberFormat.kind === 'general'

  return (
    !format.bold &&
    !format.italic &&
    (format.align === undefined || format.align === 'default') &&
    format.fontSize === undefined &&
    (format.fgColor === undefined || format.fgColor.length === 0) &&
    (format.bgColor === undefined || format.bgColor.length === 0) &&
    numberFormatIsDefault
  )
}

function keyFor(row: number, col: number): string {
  return `${row}:${col}`
}

function isCoordInsideRange(
  row: number,
  col: number,
  range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
): boolean {
  return (
    row >= range.rowStart &&
    row <= range.rowEnd &&
    col >= range.colStart &&
    col <= range.colEnd
  )
}

function snapshotCellFormatKey(snapshot: FormatRangeSnapshot['cellFormats'][number]): string | null {
  const coord = parseA1(snapshot.addr)
  if (!coord) return null
  return keyFor(coord.row, coord.col)
}

function getEffectiveFormat(
  row: number,
  col: number,
  snapshot: FormatRangeSnapshot,
): SpreadsheetCellFormat | undefined {
  for (const cellFormat of snapshot.cellFormats) {
    const key = snapshotCellFormatKey(cellFormat)
    if (key === keyFor(row, col)) {
      return normalizeFormat(cellFormat.format)
    }
  }

  for (let index = snapshot.rangeFormats.length - 1; index >= 0; index -= 1) {
    const layer = snapshot.rangeFormats[index]
    const layerRange = {
      rowStart: layer.startRow,
      rowEnd: layer.endRow,
      colStart: layer.startCol,
      colEnd: layer.endCol,
    }
    if (!isCoordInsideRange(row, col, layerRange)) continue
    return isDefaultFormat(layer.format) ? undefined : cloneFormat(layer.format)
  }

  return undefined
}

function mergeFormatsIntoCells(
  cells: DisplayCell[],
  range: CellRange,
  snapshot: FormatRangeSnapshot,
): DisplayCell[] {
  const cellMap = new Map<string, DisplayCell>()

  for (const cell of cells) {
    const format = getEffectiveFormat(cell.row, cell.col, snapshot)
    cellMap.set(keyFor(cell.row, cell.col), format ? { ...cell, format } : cell)
  }

  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    for (let col = range.colStart; col <= range.colEnd; col += 1) {
      const key = keyFor(row, col)
      if (cellMap.has(key)) continue
      const format = getEffectiveFormat(row, col, snapshot)
      if (!format) continue
      cellMap.set(key, {
        row,
        col,
        displayValue: '',
        valueKind: 'blank',
        format,
      })
    }
  }

  return [...cellMap.values()].sort((left, right) =>
    left.row === right.row ? left.col - right.col : left.row - right.row,
  )
}

function snapshotToDisplayCell(snapshot: CellSnapshotWire): DisplayCell | null {
  const coord = parseA1(snapshot.addr)
  if (!coord) {
    return null
  }

  if (snapshot.type === 'null' && snapshot.formula === '' && snapshot.display === '') {
    return null
  }

  const valueKind = snapshot.isError
    ? 'error'
    : snapshot.type === 'text'
      ? 'string'
      : snapshot.type === 'null'
        ? 'blank'
        : snapshot.type

  const cell: DisplayCell = {
    row: coord.row,
    col: coord.col,
    displayValue: snapshot.display,
    valueKind,
  }

  if (snapshot.formula !== '') {
    cell.formula = snapshot.formula
  }
  if (snapshot.isError) {
    cell.error = {
      code: 'BACKEND_ERROR',
      message: snapshot.display,
    }
  }

  return cell
}

function toCellWire(input: string): CellWire {
  const trimmed = input.trim()
  if (trimmed === '') {
    return { type: 'null' }
  }

  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) {
    return { type: 'number', value: numeric }
  }

  return { type: 'text', value: trimmed }
}

function createBackendError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function normalizeCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 1
  }
  return Math.max(1, Math.trunc(value))
}

function clampIndex(value: number, count: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(Math.trunc(value), normalizeCount(count) - 1))
}

function resolveLineDataEdge(
  fromIndex: number,
  occupiedIndexes: readonly number[],
  maxIndex: number,
  direction: -1 | 1,
): number {
  const occupied = new Set(occupiedIndexes)
  const currentIsNonBlank = occupied.has(fromIndex)

  if (direction > 0) {
    if (currentIsNonBlank && occupied.has(fromIndex + 1)) {
      let index = fromIndex + 1
      while (index < maxIndex && occupied.has(index + 1)) {
        index += 1
      }
      return index
    }

    const next = occupiedIndexes.find((index) => index > fromIndex)
    return next ?? maxIndex
  }

  if (currentIsNonBlank && occupied.has(fromIndex - 1)) {
    let index = fromIndex - 1
    while (index > 0 && occupied.has(index - 1)) {
      index -= 1
    }
    return index
  }

  for (let index = occupiedIndexes.length - 1; index >= 0; index -= 1) {
    const occupiedIndex = occupiedIndexes[index]
    if (occupiedIndex < fromIndex) {
      return occupiedIndex
    }
  }

  return 0
}

function uniqueSortedIndexes(indexes: readonly number[]): number[] {
  return [...new Set(indexes)].sort((left, right) => left - right)
}

export function createWorkerWorkbookSpreadsheetBackend(
  options: WorkerWorkbookSpreadsheetBackendOptions,
): WorkerWorkbookSpreadsheetBackend {
  const resolvedClient =
    options.client ??
    (options.workerFactory ? createWorkerWorkbook({ workerFactory: options.workerFactory }) : null)

  if (!resolvedClient) {
    throw new Error('createWorkerWorkbookSpreadsheetBackend requires client or workerFactory')
  }

  const sheetInputs = normalizeSheetInputs(options.sheets)
  let lookup: SheetLookup = { sheets: [], byId: new Map() }
  let revision = options.revision ?? 0
  let disposed = false
  let sheetOrderIds: string[] | null = null
  const rowHeightsBySheetId = new Map<string, Map<number, number>>()
  const colWidthsBySheetId = new Map<string, Map<number, number>>()
  const client: WorkerWorkbookClient = resolvedClient
  const readyPromise = client
    .initWorkbook(sheetInputs.map((sheet) => sheet.name))
    .then(async (metas) => {
      lookup = buildSheetLookup(sheetInputs, metas)
      await options.afterInit?.(client, lookup.sheets)
      return lookup.sheets
    })

  const offDirty = client.onCellsDirty(() => {
    bumpRevision()
  })

  function bumpRevision(): ProjectionRevision {
    if (typeof revision === 'number' && Number.isFinite(revision)) {
      revision += 1
    }
    return revision
  }

  async function refreshSheetLookup(
    existingSheets: readonly WorkerWorkbookBackendSheet[] = lookup.sheets,
  ): Promise<WorkerWorkbookBackendSheet[]> {
    await readyPromise
    const metas = await client.sheetList()
    const synced = syncSheetLookup(metas, existingSheets)
    const orderedSheets = orderWorkerSheets(synced.sheets, sheetOrderIds)
    if (sheetOrderIds) {
      sheetOrderIds = orderedSheets.map((sheet) => sheet.id)
    }
    lookup = buildSheetLookupFromSheets(orderedSheets)
    return lookup.sheets
  }

  function sheetMutationResult(
    requestId: number | undefined,
    extra: Partial<SheetMutationResult> = {},
  ): SheetMutationResult {
    const { revision: resultRevision, ...rest } = extra
    return {
      ...rest,
      requestId,
      revision: resultRevision ?? revision,
      sheets: toSheetMetadata(lookup.sheets),
    }
  }

  function normalizeSheetName(name: string | undefined, fallback: string): string {
    const normalized = name?.trim() ?? ''
    return normalized.length > 0 ? normalized : fallback
  }

  function getRowHeights(sheetId: string): Map<number, number> {
    let rows = rowHeightsBySheetId.get(sheetId)
    if (!rows) {
      rows = new Map()
      rowHeightsBySheetId.set(sheetId, rows)
    }
    return rows
  }

  function getColWidths(sheetId: string): Map<number, number> {
    let cols = colWidthsBySheetId.get(sheetId)
    if (!cols) {
      cols = new Map()
      colWidthsBySheetId.set(sheetId, cols)
    }
    return cols
  }

  async function readViewportSizeProjection(
    request: ViewportSizeProjectionRequest,
  ): Promise<ViewportSizeProjectionResult> {
    await resolveSheet(request.sheetId)
    const rowHeights = [...getRowHeights(request.sheetId).entries()]
      .filter(([rowIndex]) => rowIndex >= request.window.rowStart && rowIndex <= request.window.rowEnd)
      .map(([rowIndex, heightPx]) => ({ rowIndex, heightPx }))
      .sort((left, right) => left.rowIndex - right.rowIndex)
    const colWidths = [...getColWidths(request.sheetId).entries()]
      .filter(([colIndex]) => colIndex >= request.window.colStart && colIndex <= request.window.colEnd)
      .map(([colIndex, widthPx]) => ({ colIndex, widthPx }))
      .sort((left, right) => left.colIndex - right.colIndex)

    return {
      kind: 'viewport-size',
      sheetId: request.sheetId,
      window: { ...request.window },
      requestId: request.requestId,
      revision: request.revision ?? revision,
      rowHeights,
      colWidths,
    }
  }

  function nextSheetName(): string {
    const used = new Set(lookup.sheets.map((sheet) => sheet.name))
    let index = lookup.sheets.length + 1
    let name = `Sheet${index}`

    while (used.has(name)) {
      index += 1
      name = `Sheet${index}`
    }

    return name
  }

  async function resolveSheet(sheetId: string): Promise<WorkerWorkbookBackendSheet> {
    await readyPromise
    const sheet = lookup.byId.get(sheetId)
    if (!sheet) {
      throw createBackendError('INVALID_SHEET', `unknown worker workbook sheet: ${sheetId}`)
    }
    return sheet
  }

  async function readRange(
    sheetId: string,
    range: CellRange,
    requestRevision?: ProjectionRevision,
  ): Promise<{ cells: DisplayCell[]; revision?: ProjectionRevision }> {
    const sheet = await resolveSheet(sheetId)
    const sparseRange = toSparseRange(sheet.idx, range)
    const [snapshots, formatSnapshot] = await Promise.all([
      client.readSparseRange(sparseRange),
      client.snapshotFormatRange(sparseRange),
    ])
    const cells = snapshots
      .map(snapshotToDisplayCell)
      .filter((cell): cell is DisplayCell => cell !== null)
      .sort((left, right) => (left.row === right.row ? left.col - right.col : left.row - right.row))

    return {
      cells: mergeFormatsIntoCells(cells, range, formatSnapshot),
      revision: requestRevision ?? revision,
    }
  }

  async function resolveWorkerDataEdge(
    request: ResolveDataEdgeRequest,
  ): Promise<ResolveDataEdgeResult> {
    const sheet = await resolveSheet(request.sheetId)
    const rowCount = normalizeCount(request.bounds.rowCount)
    const colCount = normalizeCount(request.bounds.colCount)
    const from = {
      row: clampIndex(request.from.row, rowCount),
      col: clampIndex(request.from.col, colCount),
    }

    if (request.direction === 'left' || request.direction === 'right') {
      const cells = await client.snapshotRangeSparse({
        sheet: sheet.idx,
        startRow: from.row,
        endRow: from.row,
        startCol: 0,
        endCol: colCount - 1,
      })
      const occupiedCols = uniqueSortedIndexes(
        cells.map((cell: SparseCellWire) => clampIndex(cell.col, colCount)),
      )
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? revision,
        target: {
          row: from.row,
          col: resolveLineDataEdge(
            from.col,
            occupiedCols,
            colCount - 1,
            request.direction === 'right' ? 1 : -1,
          ),
        },
      }
    }

    const cells = await client.snapshotRangeSparse({
      sheet: sheet.idx,
      startRow: 0,
      endRow: rowCount - 1,
      startCol: from.col,
      endCol: from.col,
    })
    const occupiedRows = uniqueSortedIndexes(
      cells.map((cell: SparseCellWire) => clampIndex(cell.row, rowCount)),
    )
    return {
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: request.revision ?? revision,
      target: {
        row: resolveLineDataEdge(
          from.row,
          occupiedRows,
          rowCount - 1,
          request.direction === 'down' ? 1 : -1,
        ),
        col: from.col,
      },
    }
  }

  return {
    async listSheets() {
      await refreshSheetLookup()
      return {
        revision,
        sheets: toSheetMetadata(lookup.sheets),
      }
    },

    async readVisibleProjection(request: VisibleProjectionRequest): Promise<VisibleProjectionResult> {
      const result = await readRange(
        request.sheetId,
        request.window,
        request.revision,
      )

      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: result.revision,
        window: { ...request.window },
        cells: result.cells,
      }
    },

    async readRangeProjection(request: RangeProjectionRequest): Promise<RangeProjectionResult> {
      const result = await readRange(
        request.sheetId,
        request.range,
        request.revision,
      )

      return {
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: result.revision,
        range: { ...request.range },
        cells: result.cells,
      }
    },

    async readViewportSizeProjection(
      request: ViewportSizeProjectionRequest,
    ): Promise<ViewportSizeProjectionResult> {
      return readViewportSizeProjection(request)
    },

    async setCellInput(request: SetCellInputRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      const addr = toA1(request.row, request.col)
      const trimmed = request.input.trim()

      if (trimmed === '') {
        await client.clearCell(sheet.idx, addr)
      } else if (trimmed.startsWith('=')) {
        await client.setFormulaDetailed(sheet.idx, addr, trimmed)
      } else {
        await client.setCell(sheet.idx, addr, toCellWire(request.input))
      }

      const nextRevision = bumpRevision()
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
        affectedRange: {
          rowStart: request.row,
          rowEnd: request.row,
          colStart: request.col,
          colEnd: request.col,
        },
      }
    },

    async clearRange(request: ClearRangeRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.clearRange(toSparseRange(sheet.idx, request.range))
      const nextRevision = bumpRevision()

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
        affectedRange: {
          rowStart: request.range.rowStart,
          rowEnd: request.range.rowEnd,
          colStart: request.range.colStart,
          colEnd: request.range.colEnd,
        },
      }
    },

    async insertRows(request: InsertRowsRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.insertRows(sheet.idx, request.rowIndex, request.count)
      shiftDimensionMap(getRowHeights(request.sheetId), request.rowIndex, request.count, 1)
      return structuralMutationResult(request, bumpRevision())
    },

    async deleteRows(request: DeleteRowsRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.deleteRows(sheet.idx, request.rowIndex, request.count)
      shiftDimensionMap(getRowHeights(request.sheetId), request.rowIndex, request.count, -1)
      return structuralMutationResult(request, bumpRevision())
    },

    async insertColumns(request: InsertColumnsRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.insertColumns(sheet.idx, request.colIndex, request.count)
      shiftDimensionMap(getColWidths(request.sheetId), request.colIndex, request.count, 1)
      return structuralMutationResult(request, bumpRevision())
    },

    async deleteColumns(request: DeleteColumnsRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.deleteColumns(sheet.idx, request.colIndex, request.count)
      shiftDimensionMap(getColWidths(request.sheetId), request.colIndex, request.count, -1)
      return structuralMutationResult(request, bumpRevision())
    },

    async setFormatRange(request: SetFormatRangeRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.setFormatRange(
        toSparseRange(sheet.idx, request.range),
        request.format as CellFormatJSON | null | undefined,
      )
      const nextRevision = bumpRevision()

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
        affectedRange: {
          rowStart: request.range.rowStart,
          rowEnd: request.range.rowEnd,
          colStart: request.range.colStart,
          colEnd: request.range.colEnd,
        },
      }
    },

    async setRowHeight(request: SetRowHeightRequest): Promise<BackendMutationResult> {
      await resolveSheet(request.sheetId)
      getRowHeights(request.sheetId).set(
        request.rowIndex,
        normalizeDimensionSize(request.heightPx),
      )
      const nextRevision = bumpRevision()

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
      }
    },

    async setColumnWidth(request: SetColumnWidthRequest): Promise<BackendMutationResult> {
      await resolveSheet(request.sheetId)
      getColWidths(request.sheetId).set(
        request.colIndex,
        normalizeDimensionSize(request.widthPx),
      )
      const nextRevision = bumpRevision()

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? nextRevision,
      }
    },

    async resolveDataEdge(request: ResolveDataEdgeRequest): Promise<ResolveDataEdgeResult> {
      return resolveWorkerDataEdge(request)
    },

    async addSheet(request): Promise<SheetMutationResult> {
      await readyPromise
      const name = normalizeSheetName(request.name, nextSheetName())
      const addedIdx = await client.addSheet(name)
      const nextRevision = bumpRevision()
      await refreshSheetLookup(lookup.sheets)
      const createdSheet =
        lookup.sheets.find((sheet) => sheet.idx === addedIdx) ?? lookup.sheets.at(-1)
      const createdIndex = createdSheet
        ? lookup.sheets.findIndex((sheet) => sheet.id === createdSheet.id)
        : -1
      const createdMetadata = createdSheet
        ? { id: createdSheet.id, name: createdSheet.name, index: Math.max(createdIndex, 0) }
        : undefined

      return sheetMutationResult(request.requestId, {
        sheetId: createdMetadata?.id,
        activeSheetId: createdMetadata?.id ?? null,
        revision: request.revision ?? nextRevision,
        createdSheet: createdMetadata,
      })
    },

    async renameSheet(request): Promise<SheetMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      const name = normalizeSheetName(request.name, '')

      if (name.length === 0) {
        throw createBackendError('INVALID_SHEET_NAME', 'sheet name cannot be empty')
      }

      const ok = await client.renameSheet(sheet.idx, name)
      if (!ok) {
        throw createBackendError('SHEET_RENAME_FAILED', `cannot rename sheet to: ${name}`)
      }

      const nextRevision = bumpRevision()
      const optimisticSheets = lookup.sheets.map((item) =>
        item.id === request.sheetId ? { ...item, name } : item,
      )
      await refreshSheetLookup(optimisticSheets)

      return sheetMutationResult(request.requestId, {
        sheetId: request.sheetId,
        activeSheetId: request.sheetId,
        revision: request.revision ?? nextRevision,
      })
    },

    async deleteSheet(request): Promise<SheetMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      const deleteDisplayIndex = lookup.sheets.findIndex((item) => item.id === request.sheetId)

      if (lookup.sheets.length <= 1) {
        throw createBackendError('SHEET_DELETE_FAILED', 'cannot delete the last sheet')
      }

      const ok = await client.removeSheet(sheet.idx)
      if (!ok) {
        throw createBackendError('SHEET_DELETE_FAILED', `cannot delete sheet: ${request.sheetId}`)
      }

      const nextRevision = bumpRevision()
      const remainingSheets = lookup.sheets.filter((item) => item.id !== request.sheetId)
      rowHeightsBySheetId.delete(request.sheetId)
      colWidthsBySheetId.delete(request.sheetId)
      await refreshSheetLookup(remainingSheets)
      const activeSheetId =
        lookup.sheets[Math.min(Math.max(deleteDisplayIndex, 0), lookup.sheets.length - 1)]?.id ??
        null

      return sheetMutationResult(request.requestId, {
        sheetId: request.sheetId,
        activeSheetId,
        revision: request.revision ?? nextRevision,
      })
    },

    async reorderSheet(request: ReorderSheetRequest): Promise<SheetMutationResult> {
      await resolveSheet(request.sheetId)
      const nextSheets = reorderSheetMetadata(toSheetMetadata(lookup.sheets), request)
      const nextIds = nextSheets.map((sheet) => sheet.id)
      const orderedSheets = orderWorkerSheets(lookup.sheets, nextIds)
      const changed = !hasSameSheetOrder(lookup.sheets, orderedSheets)

      sheetOrderIds = nextIds
      lookup = buildSheetLookupFromSheets(orderedSheets)

      return sheetMutationResult(request.requestId, {
        sheetId: request.sheetId,
        activeSheetId: request.sheetId,
        revision: request.revision ?? (changed ? bumpRevision() : revision),
      })
    },

    ready() {
      return readyPromise
    },

    sheets() {
      return lookup.sheets.map((sheet) => ({ ...sheet }))
    },

    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      offDirty()
      client.dispose()
    },
  }
}
