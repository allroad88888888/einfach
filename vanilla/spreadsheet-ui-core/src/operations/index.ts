import type { CellCoord, CellRange } from '../shared'

export type SpreadsheetOperationSource =
  | 'keyboard'
  | 'formula-bar'
  | 'selection'
  | 'sheet-tabs'
  | 'toolbar'
  | 'clipboard'
  | 'diagnostics'
  | 'programmatic'
  | 'test'

export type SpreadsheetOperationKind =
  | 'cell.set-input'
  | 'row.insert'
  | 'row.delete'
  | 'column.insert'
  | 'column.delete'
  | 'sheet.add'
  | 'sheet.delete'
  | 'sheet.rename'
  | 'sheet.reorder'

export interface SpreadsheetOperationBase {
  kind: SpreadsheetOperationKind
  source?: SpreadsheetOperationSource
  requestId?: number
  revision?: number | string
}

export interface SetCellOperationIntent extends SpreadsheetOperationBase {
  kind: 'cell.set-input'
  sheetId: string
  row: number
  col: number
  input: string
}

export interface InsertRowsOperationIntent extends SpreadsheetOperationBase {
  kind: 'row.insert'
  sheetId: string
  rowIndex: number
  count: number
}

export interface DeleteRowsOperationIntent extends SpreadsheetOperationBase {
  kind: 'row.delete'
  sheetId: string
  rowIndex: number
  count: number
}

export interface InsertColumnsOperationIntent extends SpreadsheetOperationBase {
  kind: 'column.insert'
  sheetId: string
  colIndex: number
  count: number
}

export interface DeleteColumnsOperationIntent extends SpreadsheetOperationBase {
  kind: 'column.delete'
  sheetId: string
  colIndex: number
  count: number
}

export interface AddSheetOperationIntent extends SpreadsheetOperationBase {
  kind: 'sheet.add'
  sheetName: string
  beforeSheetId: string | null
  afterSheetId: string | null
}

export interface DeleteSheetOperationIntent extends SpreadsheetOperationBase {
  kind: 'sheet.delete'
  sheetId: string
}

export interface RenameSheetOperationIntent extends SpreadsheetOperationBase {
  kind: 'sheet.rename'
  sheetId: string
  sheetName: string
}

export interface ReorderSheetOperationIntent extends SpreadsheetOperationBase {
  kind: 'sheet.reorder'
  sheetId: string
  beforeSheetId: string | null
  afterSheetId: string | null
  targetIndex: number | null
}

export type SpreadsheetOperationIntent =
  | SetCellOperationIntent
  | InsertRowsOperationIntent
  | DeleteRowsOperationIntent
  | InsertColumnsOperationIntent
  | DeleteColumnsOperationIntent
  | AddSheetOperationIntent
  | DeleteSheetOperationIntent
  | RenameSheetOperationIntent
  | ReorderSheetOperationIntent

export interface OperationContext {
  source?: SpreadsheetOperationSource
  requestId?: number
  revision?: number | string
}

export interface SetCellOperationInput extends OperationContext, CellCoord {
  sheetId: string
  input: string
}

export interface RowOperationInput extends OperationContext {
  sheetId: string
  rowIndex: number
  count: number
}

export interface ColumnOperationInput extends OperationContext {
  sheetId: string
  colIndex: number
  count: number
}

export interface AddSheetOperationInput extends OperationContext {
  sheetName: string
  beforeSheetId?: string | null
  afterSheetId?: string | null
}

export interface DeleteSheetOperationInput extends OperationContext {
  sheetId: string
}

export interface RenameSheetOperationInput extends OperationContext {
  sheetId: string
  sheetName: string
}

export interface ReorderSheetOperationInput extends OperationContext {
  sheetId: string
  beforeSheetId?: string | null
  afterSheetId?: string | null
  targetIndex?: number | null
}

export function createSetCellOperation(input: SetCellOperationInput): SetCellOperationIntent {
  return {
    kind: 'cell.set-input',
    sheetId: input.sheetId,
    row: normalizeIndex(input.row),
    col: normalizeIndex(input.col),
    input: input.input,
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  }
}

export function createInsertRowsOperation(
  input: RowOperationInput,
): InsertRowsOperationIntent {
  return createRowOperation('row.insert', input)
}

export function createDeleteRowsOperation(
  input: RowOperationInput,
): DeleteRowsOperationIntent {
  return createRowOperation('row.delete', input)
}

export function createInsertColumnsOperation(
  input: ColumnOperationInput,
): InsertColumnsOperationIntent {
  return createColumnOperation('column.insert', input)
}

export function createDeleteColumnsOperation(
  input: ColumnOperationInput,
): DeleteColumnsOperationIntent {
  return createColumnOperation('column.delete', input)
}

export function createAddSheetOperation(input: AddSheetOperationInput): AddSheetOperationIntent {
  const sheetName = normalizeSheetName(input.sheetName)

  if (sheetName === null) {
    throw new RangeError('Sheet name must not be empty.')
  }

  return {
    kind: 'sheet.add',
    sheetName,
    beforeSheetId: input.beforeSheetId ?? null,
    afterSheetId: input.afterSheetId ?? null,
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  }
}

export function createDeleteSheetOperation(
  input: DeleteSheetOperationInput,
): DeleteSheetOperationIntent {
  return {
    kind: 'sheet.delete',
    sheetId: input.sheetId,
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  }
}

export function createRenameSheetOperation(
  input: RenameSheetOperationInput,
): RenameSheetOperationIntent {
  const sheetName = normalizeSheetName(input.sheetName)

  if (sheetName === null) {
    throw new RangeError('Sheet name must not be empty.')
  }

  return {
    kind: 'sheet.rename',
    sheetId: input.sheetId,
    sheetName,
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  }
}

export function createReorderSheetOperation(
  input: ReorderSheetOperationInput,
): ReorderSheetOperationIntent {
  if (
    input.beforeSheetId === undefined &&
    input.afterSheetId === undefined &&
    input.targetIndex === undefined
  ) {
    throw new RangeError('A reorder operation needs a placement hint.')
  }

  return {
    kind: 'sheet.reorder',
    sheetId: input.sheetId,
    beforeSheetId: input.beforeSheetId ?? null,
    afterSheetId: input.afterSheetId ?? null,
    targetIndex: normalizeOptionalIndex(input.targetIndex ?? null),
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  }
}

export function isSheetMutationOperation(
  operation: SpreadsheetOperationIntent,
): operation is
  | AddSheetOperationIntent
  | DeleteSheetOperationIntent
  | RenameSheetOperationIntent
  | ReorderSheetOperationIntent {
  return (
    operation.kind === 'sheet.add' ||
    operation.kind === 'sheet.delete' ||
    operation.kind === 'sheet.rename' ||
    operation.kind === 'sheet.reorder'
  )
}

export function getOperationSheetIds(operation: SpreadsheetOperationIntent): string[] {
  switch (operation.kind) {
    case 'cell.set-input':
    case 'row.insert':
    case 'row.delete':
    case 'column.insert':
    case 'column.delete':
    case 'sheet.delete':
    case 'sheet.rename':
    case 'sheet.reorder':
      return [operation.sheetId]
    case 'sheet.add':
      return []
    default:
      return []
  }
}

export function getOperationCellRange(
  operation: SpreadsheetOperationIntent,
): CellRange | null {
  if (operation.kind !== 'cell.set-input') {
    return null
  }

  return {
    rowStart: operation.row,
    rowEnd: operation.row,
    colStart: operation.col,
    colEnd: operation.col,
  }
}

function createRowOperation<K extends 'row.insert' | 'row.delete'>(
  kind: K,
  input: RowOperationInput,
): K extends 'row.insert' ? InsertRowsOperationIntent : DeleteRowsOperationIntent {
  const count = normalizeCount(input.count)

  return {
    kind,
    sheetId: input.sheetId,
    rowIndex: normalizeIndex(input.rowIndex),
    count,
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  } as K extends 'row.insert' ? InsertRowsOperationIntent : DeleteRowsOperationIntent
}

function createColumnOperation<K extends 'column.insert' | 'column.delete'>(
  kind: K,
  input: ColumnOperationInput,
): K extends 'column.insert' ? InsertColumnsOperationIntent : DeleteColumnsOperationIntent {
  const count = normalizeCount(input.count)

  return {
    kind,
    sheetId: input.sheetId,
    colIndex: normalizeIndex(input.colIndex),
    count,
    source: input.source,
    requestId: input.requestId,
    revision: input.revision,
  } as K extends 'column.insert' ? InsertColumnsOperationIntent : DeleteColumnsOperationIntent
}

function normalizeSheetName(name: string): string | null {
  const trimmed = name.trim()

  return trimmed.length === 0 ? null : trimmed
}

function normalizeIndex(index: number): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError('Indices must be non-negative integers.')
  }

  return index
}

function normalizeCount(count: number): number {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError('Counts must be positive integers.')
  }

  return count
}

function normalizeOptionalIndex(index: number | null): number | null {
  if (index === null) {
    return null
  }

  return normalizeIndex(index)
}
