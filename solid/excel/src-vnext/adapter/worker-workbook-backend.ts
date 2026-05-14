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
  SetCellInputRequest,
  SetFormatRangeRequest,
  SpreadsheetBackend,
  SpreadsheetCellFormat,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'

import type { CellFormatJSON, FormatRangeSnapshot } from '../../src/types'
import {
  createWorkerWorkbook,
  type CellSnapshotWire,
  type CellWire,
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

  return {
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
      return structuralMutationResult(request, bumpRevision())
    },

    async deleteRows(request: DeleteRowsRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.deleteRows(sheet.idx, request.rowIndex, request.count)
      return structuralMutationResult(request, bumpRevision())
    },

    async insertColumns(request: InsertColumnsRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.insertColumns(sheet.idx, request.colIndex, request.count)
      return structuralMutationResult(request, bumpRevision())
    },

    async deleteColumns(request: DeleteColumnsRequest): Promise<BackendMutationResult> {
      const sheet = await resolveSheet(request.sheetId)
      await client.deleteColumns(sheet.idx, request.colIndex, request.count)
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
