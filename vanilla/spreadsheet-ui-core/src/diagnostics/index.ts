import { atom, type Atom } from '@einfach/core'
import type { ProjectionValidationError } from '../projection'
import type { CellCoord, CellRange, SpreadsheetError } from '../shared'

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export type DiagnosticSource =
  | 'formula-bar'
  | 'projection'
  | 'backend'
  | 'workspace'
  | 'sheet-tabs'
  | 'operations'

export type DiagnosticCode =
  | SpreadsheetError['code']
  | ProjectionValidationError['code']
  | 'TAB_RENAME_EMPTY'
  | 'TAB_REORDER_INVALID'
  | 'OPERATION_INVALID'
  | 'WORKSPACE_STALE_PROJECTION'

export interface SpreadsheetDiagnostic {
  id: string
  severity: DiagnosticSeverity
  source: DiagnosticSource
  code: DiagnosticCode
  message: string
  sheetId?: string
  cell?: CellCoord
  range?: CellRange
  cellCount?: number
  maxCells?: number
  requestId?: number
  revision?: number | string
}

export interface DiagnosticsState {
  items: SpreadsheetDiagnostic[]
}

export interface DiagnosticContext {
  id?: string
  source?: DiagnosticSource
  sheetId?: string
  cell?: CellCoord
  range?: CellRange
  cellCount?: number
  maxCells?: number
  requestId?: number
  revision?: number | string
}

export const DEFAULT_MAX_DIAGNOSTICS = 20

export const DEFAULT_DIAGNOSTICS_STATE: DiagnosticsState = {
  items: [],
}

export function createDiagnosticId(
  source: DiagnosticSource,
  code: DiagnosticCode,
  requestId?: number,
  revision?: number | string,
): string {
  return [source, code, requestId ?? '', revision ?? ''].join(':')
}

export function createSpreadsheetDiagnostic(
  input: {
    severity: DiagnosticSeverity
    source: DiagnosticSource
    code: DiagnosticCode
    message: string
  } & DiagnosticContext,
): SpreadsheetDiagnostic {
  return {
    id: input.id ?? createDiagnosticId(input.source, input.code, input.requestId, input.revision),
    severity: input.severity,
    source: input.source,
    code: input.code,
    message: input.message,
    sheetId: input.sheetId,
    cell: input.cell,
    range: input.range,
    cellCount: input.cellCount,
    maxCells: input.maxCells,
    requestId: input.requestId,
    revision: input.revision,
  }
}

export function mapSpreadsheetErrorToDiagnostic(
  error: SpreadsheetError,
  context: DiagnosticContext = {},
): SpreadsheetDiagnostic {
  return createSpreadsheetDiagnostic({
    severity: getErrorSeverity(error.code),
    source: context.source ?? getErrorSource(error.code),
    code: error.code,
    message: error.message,
    ...context,
  })
}

export function mapProjectionValidationErrorToDiagnostic(
  error: ProjectionValidationError,
  context: DiagnosticContext = {},
): SpreadsheetDiagnostic {
  return createSpreadsheetDiagnostic({
    severity: getProjectionValidationSeverity(error.code),
    source: context.source ?? 'projection',
    code: error.code,
    message: error.message,
    range: error.range,
    cellCount: error.cellCount,
    maxCells: error.maxCells,
    ...context,
  })
}

export function limitDiagnostics(
  items: SpreadsheetDiagnostic[],
  maxItems = DEFAULT_MAX_DIAGNOSTICS,
): SpreadsheetDiagnostic[] {
  if (maxItems < 1) {
    return []
  }

  if (items.length <= maxItems) {
    return items.slice()
  }

  return items.slice(items.length - maxItems)
}

export function appendDiagnostics(
  state: DiagnosticsState,
  ...items: SpreadsheetDiagnostic[]
): DiagnosticsState {
  return {
    items: limitDiagnostics([...state.items, ...items]),
  }
}

export function replaceDiagnostics(
  _state: DiagnosticsState,
  ...items: SpreadsheetDiagnostic[]
): DiagnosticsState {
  return {
    items: limitDiagnostics(items),
  }
}

export function clearDiagnostics(): DiagnosticsState {
  return {
    items: [],
  }
}

const diagnosticsBackingAtom = atom<DiagnosticsState>(DEFAULT_DIAGNOSTICS_STATE)
diagnosticsBackingAtom.debugLabel = 'spreadsheet.diagnostics.stateBacking'

export const diagnosticsAtom: Atom<DiagnosticsState> = atom((get) => get(diagnosticsBackingAtom))
diagnosticsAtom.debugLabel = 'spreadsheet.diagnostics.state'

export const appendDiagnosticsAtom = atom(
  (get) => get(diagnosticsAtom),
  (get, set, ...items: SpreadsheetDiagnostic[]): DiagnosticsState => {
    const nextState = appendDiagnostics(get(diagnosticsBackingAtom), ...items)
    set(diagnosticsBackingAtom, nextState)
    return nextState
  },
)
appendDiagnosticsAtom.debugLabel = 'spreadsheet.diagnostics.append'

export const replaceDiagnosticsAtom = atom(
  (get) => get(diagnosticsAtom),
  (_get, set, ...items: SpreadsheetDiagnostic[]): DiagnosticsState => {
    const nextState = replaceDiagnostics(DEFAULT_DIAGNOSTICS_STATE, ...items)
    set(diagnosticsBackingAtom, nextState)
    return nextState
  },
)
replaceDiagnosticsAtom.debugLabel = 'spreadsheet.diagnostics.replace'

export const clearDiagnosticsAtom = atom(
  (get) => get(diagnosticsAtom),
  (_get, set): DiagnosticsState => {
    set(diagnosticsBackingAtom, DEFAULT_DIAGNOSTICS_STATE)
    return DEFAULT_DIAGNOSTICS_STATE
  },
)
clearDiagnosticsAtom.debugLabel = 'spreadsheet.diagnostics.clear'

function getErrorSeverity(code: SpreadsheetError['code']): DiagnosticSeverity {
  switch (code) {
    case 'CANCELLED':
      return 'info'
    case 'BACKEND_ERROR':
    case 'INVALID_FORMULA':
    case 'FORMULA_CYCLE':
    case 'OUT_OF_BOUNDS':
      return 'error'
    default:
      return 'error'
  }
}

function getErrorSource(code: SpreadsheetError['code']): DiagnosticSource {
  switch (code) {
    case 'INVALID_FORMULA':
    case 'FORMULA_CYCLE':
      return 'formula-bar'
    case 'OUT_OF_BOUNDS':
      return 'projection'
    case 'CANCELLED':
    case 'BACKEND_ERROR':
    default:
      return 'backend'
  }
}

function getProjectionValidationSeverity(
  code: ProjectionValidationError['code'],
): DiagnosticSeverity {
  switch (code) {
    case 'RANGE_TOO_LARGE':
    case 'STALE_RESULT':
      return 'warning'
    default:
      return 'error'
  }
}
