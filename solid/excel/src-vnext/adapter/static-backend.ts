import type {
  DisplayCell,
  ProjectionRevision,
  RangeProjectionRequest,
  RangeProjectionResult,
  ClearRangeRequest,
  SetCellInputRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import type {
  StaticProjectionRequest,
  StaticProjectionResult,
  StaticSeedCells,
  StaticSeedMatrix,
  StaticSeedValue,
  StaticSpreadsheetSeedInput,
} from './types'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSeedCell(value: unknown): value is DisplayCell {
  return (
    isObject(value) &&
    typeof value.row === 'number' &&
    typeof value.col === 'number' &&
    typeof value.displayValue === 'string'
  )
}

function cloneCell(cell: DisplayCell): DisplayCell {
  const clone: DisplayCell = {
    row: cell.row,
    col: cell.col,
    displayValue: cell.displayValue,
  }

  if (cell.valueKind) clone.valueKind = cell.valueKind
  if (cell.formula !== undefined) clone.formula = cell.formula
  if (cell.error) clone.error = cell.error
  if (cell.formatKey !== undefined) clone.formatKey = cell.formatKey

  return clone
}

function keyFor(row: number, col: number): string {
  return `${row}:${col}`
}

function compareCells(left: DisplayCell, right: DisplayCell): number {
  return left.row === right.row ? left.col - right.col : left.row - right.row
}

function valueToDisplayCell(row: number, col: number, value: StaticSeedValue): DisplayCell | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    return { row, col, displayValue: value, valueKind: 'string' }
  }
  if (typeof value === 'number') {
    return {
      row,
      col,
      displayValue: Number.isFinite(value) ? String(value) : String(value),
      valueKind: 'number',
    }
  }
  if (typeof value === 'boolean') {
    return { row, col, displayValue: value ? 'TRUE' : 'FALSE', valueKind: 'boolean' }
  }
  return null
}

function matrixToCells(matrix: StaticSeedMatrix): DisplayCell[] {
  const cells: DisplayCell[] = []

  matrix.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      const cell = valueToDisplayCell(rowIndex, colIndex, value)
      if (cell) cells.push(cell)
    })
  })

  return cells
}

function sparseCellsToCells(cells: StaticSeedCells): DisplayCell[] {
  return cells
    .filter(isSeedCell)
    .map(cloneCell)
    .sort(compareCells)
}

function normalizeSeed(input: StaticSpreadsheetSeedInput): {
  cells: Map<string, DisplayCell>
  revision: ProjectionRevision
} {
  if (Array.isArray(input)) {
    const cells = input.length > 0 && input.some((item) => Array.isArray(item))
      ? matrixToCells(input as StaticSeedMatrix)
      : sparseCellsToCells(input as StaticSeedCells)

    return {
      cells: new Map(cells.map((cell) => [keyFor(cell.row, cell.col), cell] as const)),
      revision: 0,
    }
  }

  const seed = input as StaticSpreadsheetSeedInput & {
    cells?: StaticSeedCells
    matrix?: StaticSeedMatrix
    revision?: ProjectionRevision
  }
  const cells = [
    ...(seed.matrix ? matrixToCells(seed.matrix) : []),
    ...(seed.cells ? sparseCellsToCells(seed.cells) : []),
  ]

  return {
    cells: new Map(cells.map((cell) => [keyFor(cell.row, cell.col), cell] as const)),
    revision: seed.revision ?? 0,
  }
}

function isCellInsideRange(cell: DisplayCell, range: { rowStart: number; rowEnd: number; colStart: number; colEnd: number }): boolean {
  return (
    cell.row >= range.rowStart &&
    cell.row <= range.rowEnd &&
    cell.col >= range.colStart &&
    cell.col <= range.colEnd
  )
}

function buildProjectionResult(
  request: StaticProjectionRequest,
  cells: Map<string, DisplayCell>,
  revision: ProjectionRevision,
): StaticProjectionResult {
  const range = request.kind === 'visible-window' ? request.window : request.range
  const resultCells = [...cells.values()]
    .filter((cell) => isCellInsideRange(cell, range))
    .map(cloneCell)
    .sort(compareCells)

  if (request.kind === 'visible-window') {
    const result: VisibleProjectionResult = {
      kind: 'visible-window',
      sheetId: request.sheetId,
      requestId: request.requestId,
      revision: request.revision ?? revision,
      window: {
        rowStart: range.rowStart,
        rowEnd: range.rowEnd,
        colStart: range.colStart,
        colEnd: range.colEnd,
      },
      cells: resultCells,
    }
    return result
  }

  const result: RangeProjectionResult = {
    kind: 'range',
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision ?? revision,
    range: {
      rowStart: range.rowStart,
      rowEnd: range.rowEnd,
      colStart: range.colStart,
      colEnd: range.colEnd,
    },
    cells: resultCells,
  }
  return result
}

function bumpRevision(revision: ProjectionRevision): ProjectionRevision {
  if (typeof revision === 'number' && Number.isFinite(revision)) {
    return revision + 1
  }
  return revision
}

function updateCell(
  cells: Map<string, DisplayCell>,
  request: SetCellInputRequest,
): DisplayCell | null {
  if (request.input.length === 0) {
    cells.delete(keyFor(request.row, request.col))
    return null
  }

  const cell: DisplayCell = {
    row: request.row,
    col: request.col,
    displayValue: request.input,
    valueKind: 'string',
  }

  cells.set(keyFor(request.row, request.col), cell)
  return cell
}

function clearRange(cells: Map<string, DisplayCell>, request: ClearRangeRequest): number {
  let cleared = 0

  for (const [key, cell] of [...cells.entries()]) {
    if (isCellInsideRange(cell, request.range)) {
      cells.delete(key)
      cleared += 1
    }
  }

  return cleared
}

export function matrixToDisplayCells(matrix: StaticSeedMatrix): DisplayCell[] {
  return matrixToCells(matrix)
}

export function sparseCellsToDisplayCells(cells: StaticSeedCells): DisplayCell[] {
  return sparseCellsToCells(cells)
}

export function matrixToVisibleProjectionResult(
  matrix: StaticSeedMatrix,
  request: VisibleProjectionRequest,
  revision?: ProjectionRevision,
): VisibleProjectionResult {
  return buildProjectionResult(request, new Map(matrixToCells(matrix).map((cell) => [keyFor(cell.row, cell.col), cell] as const)), revision ?? 0) as VisibleProjectionResult
}

export function matrixToRangeProjectionResult(
  matrix: StaticSeedMatrix,
  request: RangeProjectionRequest,
  revision?: ProjectionRevision,
): RangeProjectionResult {
  return buildProjectionResult(request, new Map(matrixToCells(matrix).map((cell) => [keyFor(cell.row, cell.col), cell] as const)), revision ?? 0) as RangeProjectionResult
}

export function sparseCellsToVisibleProjectionResult(
  cells: StaticSeedCells,
  request: VisibleProjectionRequest,
  revision?: ProjectionRevision,
): VisibleProjectionResult {
  return buildProjectionResult(request, new Map(sparseCellsToCells(cells).map((cell) => [keyFor(cell.row, cell.col), cell] as const)), revision ?? 0) as VisibleProjectionResult
}

export function sparseCellsToRangeProjectionResult(
  cells: StaticSeedCells,
  request: RangeProjectionRequest,
  revision?: ProjectionRevision,
): RangeProjectionResult {
  return buildProjectionResult(request, new Map(sparseCellsToCells(cells).map((cell) => [keyFor(cell.row, cell.col), cell] as const)), revision ?? 0) as RangeProjectionResult
}

export function createStaticSpreadsheetBackend(
  seed: StaticSpreadsheetSeedInput = [],
): SpreadsheetBackend {
  const state = normalizeSeed(seed)

  return {
    async readVisibleProjection(request) {
      return buildProjectionResult(request, state.cells, state.revision) as VisibleProjectionResult
    },
    async readRangeProjection(request) {
      return buildProjectionResult(request, state.cells, state.revision) as RangeProjectionResult
    },
    async setCellInput(request) {
      updateCell(state.cells, request)
      state.revision = bumpRevision(state.revision)

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        affectedRange: {
          rowStart: request.row,
          rowEnd: request.row,
          colStart: request.col,
          colEnd: request.col,
        },
      }
    },
    async clearRange(request) {
      clearRange(state.cells, request)
      state.revision = bumpRevision(state.revision)

      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: request.revision ?? state.revision,
        affectedRange: {
          rowStart: request.range.rowStart,
          rowEnd: request.range.rowEnd,
          colStart: request.range.colStart,
          colEnd: request.range.colEnd,
        },
      }
    },
  }
}
