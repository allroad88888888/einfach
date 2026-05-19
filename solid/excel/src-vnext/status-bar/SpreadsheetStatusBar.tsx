import { useAtomValue, useSetAtom, useStore } from '@einfach/solid'
import { createEffect, createMemo, For, onCleanup } from 'solid-js'
import {
  keyboardModeAtom,
  menuCommandIntentAtom,
  resetZoomLevelAtom,
  selectionAggregatesAtom,
  selectionSnapshotAtom,
  setViewModeAtom,
  setZoomLevelAtom,
  statusBarAggregateConfigAtom,
  statusBarAggregateTruncatedAtom,
  statusBarProjectionCellsAtom,
  toggleStatusBarAggregateAtom,
  toolbarIntentAtom,
  viewModeAtom,
  visibleWindowAtom,
  ZOOM_LEVEL_MAX,
  ZOOM_LEVEL_MIN,
  ZOOM_LEVEL_PRESETS,
  zoomLevelAtom,
  type CellCoord,
  type CellRange,
  type DisplayCell,
  type KeyboardMode,
  type MenuCommandIntent,
  type ProjectionSnapshot,
  type SelectionState,
  type StatusBarAggregateConfig,
  type StatusBarAggregateKey,
  type StatusBarInputMode,
  type StatusBarViewMode,
  type ToolbarIntent,
} from '@einfach/spreadsheet-ui-core'

import { spreadsheetProjectionSnapshotAtom } from '../provider'
import { useT } from '../../src/i18n'

export type SpreadsheetStatusBarSection =
  | 'cell-address'
  | 'selection'
  | 'projection'
  | 'visible-cells'
  | 'loaded-values'
  | 'last-command'
  | 'aggregates'
  | 'view-modes'
  | 'zoom'
  | 'mode-badge'

const DEFAULT_SECTIONS: readonly SpreadsheetStatusBarSection[] = [
  'cell-address',
  'selection',
  'projection',
  'visible-cells',
  'loaded-values',
  'last-command',
  'aggregates',
  'view-modes',
  'zoom',
  'mode-badge',
]

export interface SpreadsheetStatusBarProps {
  class?: string
  'data-testid'?: string
  sections?: readonly SpreadsheetStatusBarSection[]
  orientation?: 'horizontal' | 'vertical'
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

const AGGREGATE_LABEL_KEYS: Record<StatusBarAggregateKey, string> = {
  sum: 'status.aggregate.sum',
  average: 'status.aggregate.average',
  count: 'status.aggregate.count',
  numericCount: 'status.aggregate.numericCount',
  min: 'status.aggregate.min',
  max: 'status.aggregate.max',
}

const AGGREGATE_ORDER: readonly StatusBarAggregateKey[] = [
  'sum',
  'average',
  'count',
  'numericCount',
  'min',
  'max',
]

function formatAggregateValue(key: StatusBarAggregateKey, value: number): string {
  if (key === 'count' || key === 'numericCount') {
    return String(value)
  }
  if (!Number.isFinite(value)) {
    return '0'
  }
  if (Number.isInteger(value)) {
    return String(value)
  }
  // Excel-standard: round to 2 decimal places then trim trailing zeros.
  // 180.357143 -> "180.36", 1.5 -> "1.5", 1.234 -> "1.23".
  return value.toFixed(2).replace(/\.?0+$/, '')
}

function rangesIntersect(a: CellRange, b: CellRange): boolean {
  return (
    a.rowStart <= b.rowEnd &&
    a.rowEnd >= b.rowStart &&
    a.colStart <= b.colEnd &&
    a.colEnd >= b.colStart
  )
}

function rangeContains(outer: CellRange, inner: CellRange): boolean {
  return (
    outer.rowStart <= inner.rowStart &&
    outer.rowEnd >= inner.rowEnd &&
    outer.colStart <= inner.colStart &&
    outer.colEnd >= inner.colEnd
  )
}

const KEYBOARD_MODE_TO_BADGE: Record<KeyboardMode, StatusBarInputMode> = {
  navigation: 'ready',
  editing: 'edit',
  'formula-reference': 'point',
}

const INPUT_MODE_LABEL_KEY: Record<StatusBarInputMode, string> = {
  ready: 'status.inputMode.ready',
  edit: 'status.inputMode.edit',
  enter: 'status.inputMode.enter',
  point: 'status.inputMode.point',
}

const VIEW_MODE_BUTTONS: ReadonlyArray<{ value: StatusBarViewMode; label: string }> = [
  { value: 'normal', label: 'status.viewMode.normal' },
  { value: 'page-break-preview', label: 'status.viewMode.pageBreak' },
  { value: 'page-layout', label: 'status.viewMode.pageLayout' },
]

export function SpreadsheetStatusBar(props: SpreadsheetStatusBarProps) {
  const store = useStore()
  const t = useT()
  const selectionSnapshot = useAtomValue(selectionSnapshotAtom)
  const projectionSnapshot = useAtomValue(spreadsheetProjectionSnapshotAtom)
  const visibleWindow = useAtomValue(visibleWindowAtom)
  const toolbarIntent = useAtomValue(toolbarIntentAtom)
  const menuCommandIntent = useAtomValue(menuCommandIntentAtom)
  const aggregates = useAtomValue(selectionAggregatesAtom)
  const aggregateConfig = useAtomValue(statusBarAggregateConfigAtom)
  const zoomLevel = useAtomValue(zoomLevelAtom)
  const viewMode = useAtomValue(viewModeAtom)
  const keyboardMode = useAtomValue(keyboardModeAtom)

  const toggleAggregate = useSetAtom(toggleStatusBarAggregateAtom)
  const setZoom = useSetAtom(setZoomLevelAtom)
  const resetZoom = useSetAtom(resetZoomLevelAtom)
  const setViewMode = useSetAtom(setViewModeAtom)

  // Mirror projection cells into the vanilla atom so the aggregates derivation
  // stays host-agnostic. Also surface a `truncated` hint when the selection
  // exceeds the visible projection window.
  createEffect(() => {
    const snapshot = projectionSnapshot()
    const cells: readonly DisplayCell[] = snapshot.result?.cells ?? []
    store.setter(statusBarProjectionCellsAtom, cells)

    const range = selectionSnapshot().range
    const window =
      snapshot.result?.kind === 'visible-window' ? snapshot.result.window : visibleWindow()
    const truncated =
      countRange(range) > 0 && countRange(window) > 0
        ? !rangeContains(window, range) && rangesIntersect(window, range)
        : false
    store.setter(statusBarAggregateTruncatedAtom, truncated)
  })

  onCleanup(() => {
    store.setter(statusBarProjectionCellsAtom, [])
    store.setter(statusBarAggregateTruncatedAtom, false)
  })

  const activeAddress = createMemo(() => toA1(selectionSnapshot().activeCell))
  const selectionText = createMemo(() =>
    formatRange(selectionSnapshot().selection, selectionSnapshot().range),
  )
  const projectionText = createMemo(() => formatProjectionStatus(projectionSnapshot()))
  const visibleCellsText = createMemo(() =>
    formatVisibleWindow(projectionSnapshot(), visibleWindow()),
  )
  const loadedValuesText = createMemo(() => formatLoadedValues(projectionSnapshot()))
  const commandText = createMemo(
    () => formatMenuIntent(menuCommandIntent()) ?? formatToolbarIntent(toolbarIntent()) ?? 'Ready',
  )

  const inputMode = createMemo<StatusBarInputMode>(() => KEYBOARD_MODE_TO_BADGE[keyboardMode()])

  const zoomPercent = createMemo(() => Math.round(zoomLevel() * 100))
  const zoomSliderValue = createMemo(() => zoomPercent())

  const visibleAggregates = createMemo(() => {
    const config = aggregateConfig()
    return AGGREGATE_ORDER.filter((key) => config[key])
  })

  const aggregateValue = (key: StatusBarAggregateKey): number => {
    const a = aggregates()
    switch (key) {
      case 'sum':
        return a.sum
      case 'average':
        return a.average
      case 'count':
        return a.count
      case 'numericCount':
        return a.numericCount
      case 'min':
        return a.min
      case 'max':
        return a.max
      default:
        return 0
    }
  }

  const handleSliderInput = (event: Event) => {
    const target = event.currentTarget as HTMLInputElement
    const value = Number(target.value)
    if (Number.isFinite(value)) {
      setZoom(value / 100)
    }
  }

  const sections = createMemo<readonly SpreadsheetStatusBarSection[]>(
    () => props.sections ?? DEFAULT_SECTIONS,
  )
  const showSection = (section: SpreadsheetStatusBarSection) => sections().includes(section)
  const orientation = createMemo(() => props.orientation ?? 'horizontal')

  return (
    <div
      class={`spreadsheet-status-bar spreadsheet-status-bar--${orientation()} ${props.class ?? ''}`.trim()}
      data-testid={props['data-testid'] ?? 'spreadsheet-status-bar'}
      data-orientation={orientation()}
    >
      {showSection('cell-address') ? (
        <span class="spreadsheet-status-bar-item" data-testid="status-active-cell">
          {activeAddress()}
        </span>
      ) : null}
      {showSection('selection') ? (
        <span class="spreadsheet-status-bar-item" data-testid="status-selection">
          {selectionText()}
        </span>
      ) : null}
      {showSection('projection') ? (
        <span class="spreadsheet-status-bar-item" data-testid="status-projection">
          {projectionText()}
        </span>
      ) : null}
      {showSection('visible-cells') ? (
        <span class="spreadsheet-status-bar-item" data-testid="status-visible-cells">
          {visibleCellsText()}
        </span>
      ) : null}
      {showSection('loaded-values') ? (
        <span class="spreadsheet-status-bar-item" data-testid="status-loaded-values">
          {loadedValuesText()}
        </span>
      ) : null}
      {showSection('last-command') ? (
        <span class="spreadsheet-status-bar-item" data-testid="status-last-command">
          {commandText()}
        </span>
      ) : null}

      {showSection('aggregates') ? (
        <span
          class="spreadsheet-status-bar-aggregates"
          data-testid="status-aggregates"
          data-truncated={aggregates().truncated ? 'true' : 'false'}
        >
        <For each={AGGREGATE_ORDER}>
          {(key) => {
            const enabled = () => Boolean(aggregateConfig()[key])
            return (
              <button
                type="button"
                class="spreadsheet-status-bar-aggregate"
                data-testid={`status-aggregate-${key}`}
                data-enabled={enabled() ? 'true' : 'false'}
                aria-pressed={enabled()}
                onClick={() => toggleAggregate(key)}
              >
                <span class="spreadsheet-status-bar-aggregate-label">
                  {t(AGGREGATE_LABEL_KEYS[key])}
                </span>
                {enabled() ? (
                  <span
                    class="spreadsheet-status-bar-aggregate-value"
                    data-testid={`status-aggregate-${key}-value`}
                  >
                    {formatAggregateValue(key, aggregateValue(key))}
                  </span>
                ) : null}
              </button>
            )
          }}
        </For>
          {visibleAggregates().length === 0 ? (
            <span class="spreadsheet-status-bar-aggregate-empty" data-testid="status-aggregates-empty">
              No aggregates
            </span>
          ) : null}
        </span>
      ) : null}

      {showSection('view-modes') ? (
        <span class="spreadsheet-status-bar-view-modes" data-testid="status-view-modes">
          <For each={VIEW_MODE_BUTTONS}>
            {(item) => (
              <button
                type="button"
                class="spreadsheet-status-bar-view-mode"
                data-testid={`status-view-mode-${item.value}`}
                data-active={viewMode() === item.value ? 'true' : 'false'}
                aria-pressed={viewMode() === item.value}
                onClick={() => setViewMode(item.value)}
              >
                {t(item.label)}
              </button>
            )}
          </For>
        </span>
      ) : null}

      {showSection('zoom') ? (
        <span class="spreadsheet-status-bar-zoom" data-testid="status-zoom">
          <For each={ZOOM_LEVEL_PRESETS}>
            {(preset) => (
              <button
                type="button"
                class="spreadsheet-status-bar-zoom-preset"
                data-testid={`status-zoom-preset-${Math.round(preset * 100)}`}
                data-active={zoomLevel() === preset ? 'true' : 'false'}
                aria-pressed={zoomLevel() === preset}
                onClick={() => setZoom(preset)}
              >
                {Math.round(preset * 100)}%
              </button>
            )}
          </For>
          <input
            type="range"
            class="spreadsheet-status-bar-zoom-slider"
            data-testid="status-zoom-slider"
            min={Math.round(ZOOM_LEVEL_MIN * 100)}
            max={Math.round(ZOOM_LEVEL_MAX * 100)}
            step="1"
            value={zoomSliderValue()}
            onInput={handleSliderInput}
          />
          <button
            type="button"
            class="spreadsheet-status-bar-zoom-value"
            data-testid="status-zoom-value"
            aria-label="Reset zoom to 100%"
            onClick={() => resetZoom()}
          >
            {zoomPercent()}%
          </button>
        </span>
      ) : null}

      {showSection('mode-badge') ? (
        <span
          class="spreadsheet-status-bar-mode-badge"
          data-testid="status-mode-badge"
          data-mode={inputMode()}
        >
          {t(INPUT_MODE_LABEL_KEY[inputMode()])}
        </span>
      ) : null}
    </div>
  )
}

export type {
  StatusBarAggregateConfig,
  StatusBarAggregateKey,
  StatusBarInputMode,
  StatusBarViewMode,
}
