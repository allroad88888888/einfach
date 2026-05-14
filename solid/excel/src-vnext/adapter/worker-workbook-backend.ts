import type {
  BackendMutationResult,
  CellRange,
  DisplayCell,
  ProjectionRevision,
  RangeProjectionRequest,
  RangeProjectionResult,
  SetCellInputRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'

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
    const snapshots = await client.readSparseRange(toSparseRange(sheet.idx, range))
    const cells = snapshots
      .map(snapshotToDisplayCell)
      .filter((cell): cell is DisplayCell => cell !== null)
      .sort((left, right) => (left.row === right.row ? left.col - right.col : left.row - right.row))

    return {
      cells,
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
