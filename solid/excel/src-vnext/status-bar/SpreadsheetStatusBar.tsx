import { useAtomValue } from '@einfach/solid'
import {
  menuCommandIntentAtom,
  selectionSnapshotAtom,
  toolbarIntentAtom,
  visibleWindowAtom,
  type CellCoord,
  type CellRange,
  type MenuCommandIntent,
  type ProjectionSnapshot,
  type SelectionState,
  type ToolbarIntent,
} from '@einfach/spreadsheet-ui-core'

import { spreadsheetProjectionSnapshotAtom } from '../provider'

export interface SpreadsheetStatusBarProps {
  class?: string
  'data-testid'?: string
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

function toA1(cell: CellCoord): string {
  return `${getColumnLabel(cell.col)}${cell.row + 1}`
}

function countRange(range: CellRange): number {
  if (range.rowEnd < range.rowStart || range.colEnd < range.colStart) {
    return 0
  }

  return (range.rowEnd - range.rowStart + 1) * (range.colEnd - range.colStart + 1)
}

function formatRange(selection: SelectionState, range: CellRange): string {
  switch (selection.kind) {
    case 'cell':
      return toA1(selection.focus)
    case 'range':
      return `${toA1({ row: range.rowStart, col: range.colStart })}:${toA1({
        row: range.rowEnd,
        col: range.colEnd,
      })}`
    case 'row':
      return `${range.rowStart + 1}:${range.rowEnd + 1}`
    case 'column':
      return `${getColumnLabel(range.colStart)}:${getColumnLabel(range.colEnd)}`
    case 'all':
      return 'All'
    default:
      return ''
  }
}

function formatProjectionStatus(snapshot: ProjectionSnapshot): string {
  switch (snapshot.status) {
    case 'idle':
      return 'Idle'
    case 'loading':
      return 'Loading'
    case 'ready':
      return 'Ready'
    case 'error':
      return snapshot.error?.message ?? 'Error'
    default:
      return 'Unknown'
  }
}

function formatVisibleWindow(snapshot: ProjectionSnapshot, fallbackWindow: CellRange): string {
  const window = snapshot.result?.kind === 'visible-window' ? snapshot.result.window : fallbackWindow
  return `${countRange(window)} cells`
}

function formatLoadedValues(snapshot: ProjectionSnapshot): string {
  const loaded = snapshot.result?.cells.length ?? 0
  return `${loaded} loaded`
}

function formatToolbarIntent(intent: ToolbarIntent | null): string | null {
  if (intent?.type === 'toolbar.format.command') {
    return `Toolbar ${intent.command}`
  }

  if (intent?.type === 'toolbar.surface.open') {
    return `Toolbar ${intent.surface.id}`
  }

  return null
}

function formatMenuIntent(intent: MenuCommandIntent | null): string | null {
  if (!intent) {
    return null
  }

  return `Menu ${intent.command}`
}

export function SpreadsheetStatusBar(props: SpreadsheetStatusBarProps) {
  const selectionSnapshot = useAtomValue(selectionSnapshotAtom)
  const projectionSnapshot = useAtomValue(spreadsheetProjectionSnapshotAtom)
  const visibleWindow = useAtomValue(visibleWindowAtom)
  const toolbarIntent = useAtomValue(toolbarIntentAtom)
  const menuCommandIntent = useAtomValue(menuCommandIntentAtom)

  const activeAddress = () => toA1(selectionSnapshot().activeCell)
  const selectionText = () =>
    formatRange(selectionSnapshot().selection, selectionSnapshot().range)
  const projectionText = () => formatProjectionStatus(projectionSnapshot())
  const visibleCellsText = () => formatVisibleWindow(projectionSnapshot(), visibleWindow())
  const loadedValuesText = () => formatLoadedValues(projectionSnapshot())
  const commandText = () =>
    formatMenuIntent(menuCommandIntent()) ?? formatToolbarIntent(toolbarIntent()) ?? 'Ready'

  return (
    <div
      class={`spreadsheet-status-bar ${props.class ?? ''}`.trim()}
      data-testid={props['data-testid'] ?? 'spreadsheet-status-bar'}
    >
      <span class="spreadsheet-status-bar-item" data-testid="status-active-cell">
        {activeAddress()}
      </span>
      <span class="spreadsheet-status-bar-item" data-testid="status-selection">
        {selectionText()}
      </span>
      <span class="spreadsheet-status-bar-item" data-testid="status-projection">
        {projectionText()}
      </span>
      <span class="spreadsheet-status-bar-item" data-testid="status-visible-cells">
        {visibleCellsText()}
      </span>
      <span class="spreadsheet-status-bar-item" data-testid="status-loaded-values">
        {loadedValuesText()}
      </span>
      <span class="spreadsheet-status-bar-item" data-testid="status-last-command">
        {commandText()}
      </span>
    </div>
  )
}
