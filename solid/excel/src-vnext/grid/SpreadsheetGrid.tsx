import {
  cancelEditingAtom,
  cancelPointerAtom,
  commitPointerAtom,
  commitEditingAtom,
  createVisibleProjectionRequest,
  dispatchKeyboardInputAtom,
  editingDraftAtom,
  editingSessionAtom,
  getAdjacentSheetId,
  getViewportColumnWidth,
  getViewportRowHeight,
  getSelectionRange,
  openMenuAtom,
  selectionSnapshotAtom,
  selectAllAtom,
  selectCellAtom,
  selectColumnsAtom,
  selectRowsAtom,
  setViewportColumnWidthAtom,
  setSelectionBoundsAtom,
  setWorkspaceActiveSheetAtom,
  setViewportRowHeightAtom,
  setViewportMetricsAtom,
  sheetTabsSheetsAtom,
  startPointerAtom,
  startEditingAtom,
  updatePointerAtom,
  type DisplayCell,
  type SpreadsheetCellFormat,
  type ViewportMetrics,
  viewportSizeOverridesAtom,
  visibleWindowAtom,
  workspaceSessionAtom,
} from '@einfach/spreadsheet-ui-core'
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  advanceSpreadsheetProjectionRequestIdAtom,
  spreadsheetProjectionSnapshotAtom,
} from '../provider'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

export interface SpreadsheetGridProps {
  sheetId: string
  viewport: ViewportMetrics
  class?: string
  'data-testid'?: string
}

function makeCellKey(row: number, col: number) {
  return `${row}:${col}`
}

function getWindowIndexes(start: number, end: number) {
  if (end < start) {
    return []
  }

  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
}

function getColumnLabel(index: number): string {
  let n = index + 1
  let label = ''

  while (n > 0) {
    const remainder = (n - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    n = Math.floor((n - 1) / 26)
  }

  return label
}

function getCellAddress(row: number, col: number): string {
  return `${getColumnLabel(col)}${row + 1}`
}

function getCellFormatStyle(format: SpreadsheetCellFormat | undefined): Record<string, string> {
  if (!format) return {}

  const style: Record<string, string> = {}
  if (format.bgColor) style['background'] = format.bgColor
  if (format.fgColor) style['color'] = format.fgColor
  if (format.bold) style['font-weight'] = '700'
  if (format.italic) style['font-style'] = 'italic'
  if (format.align && format.align !== 'default') style['text-align'] = format.align
  if (format.fontSize) style['font-size'] = `${format.fontSize}px`
  return style
}

export function SpreadsheetGrid(props: SpreadsheetGridProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const [renderTick, setRenderTick] = createSignal(0)
  let gridRoot: HTMLDivElement | undefined
  let activeResizeCleanup: (() => void) | null = null
  let unsubscribeProjection: (() => void) | null = null
  let unsubscribeSizes: (() => void) | null = null

  function bumpRender() {
    setRenderTick((value) => value + 1)
  }

  function visibleWindow() {
    renderTick()
    return store.getter(visibleWindowAtom)
  }

  function projectionSnapshot() {
    renderTick()
    return store.getter(spreadsheetProjectionSnapshotAtom)
  }

  function selectionSnapshot() {
    renderTick()
    return store.getter(selectionSnapshotAtom)
  }

  function editingSession() {
    renderTick()
    return store.getter(editingSessionAtom)
  }

  function editingDraft() {
    renderTick()
    return store.getter(editingDraftAtom)
  }

  function sizeOverrides() {
    renderTick()
    return store.getter(viewportSizeOverridesAtom)
  }

  function requestProjection() {
    const window = store.getter(visibleWindowAtom)
    if (window.rowEnd < window.rowStart || window.colEnd < window.colStart) {
      store.setter(spreadsheetProjectionSnapshotAtom, {
        status: 'idle',
        request: undefined,
        result: undefined,
        error: undefined,
      })
      bumpRender()
      return undefined
    }

    const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
    const request = createVisibleProjectionRequest({
      sheetId: props.sheetId,
      window,
      requestId,
      reason: 'viewport',
    })

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'loading',
      request,
      result: undefined,
      error: undefined,
    })
    bumpRender()

    return { request, requestId }
  }

  async function loadProjection(requestInfo: ReturnType<typeof requestProjection>) {
    if (!requestInfo) {
      return
    }

    const { request, requestId } = requestInfo
    try {
      const result = await backend.readVisibleProjection(request)
      const current = store.getter(spreadsheetProjectionSnapshotAtom)
      if (current.request?.requestId !== requestId) {
        return
      }
      store.setter(spreadsheetProjectionSnapshotAtom, {
        status: 'ready',
        request,
        result,
        error: undefined,
      })
    } catch (error: unknown) {
      const current = store.getter(spreadsheetProjectionSnapshotAtom)
      if (current.request?.requestId !== requestId) {
        return
      }
      store.setter(spreadsheetProjectionSnapshotAtom, {
        status: 'error',
        request,
        result: undefined,
        error:
          error instanceof Error
            ? { code: 'BACKEND_ERROR', message: error.message }
            : { code: 'BACKEND_ERROR', message: 'Spreadsheet projection failed.' },
      })
    }
    bumpRender()
  }

  onMount(() => {
    unsubscribeProjection = store.sub(spreadsheetProjectionSnapshotAtom, bumpRender)
    unsubscribeSizes = store.sub(viewportSizeOverridesAtom, bumpRender)
    store.setter(setViewportMetricsAtom, props.viewport)
    store.setter(setSelectionBoundsAtom, {
      rowCount: props.viewport.rowCount,
      colCount: props.viewport.colCount,
    })
    bumpRender()
    void loadProjection(requestProjection())
  })

  onCleanup(() => {
    unsubscribeProjection?.()
    unsubscribeSizes?.()
    activeResizeCleanup?.()
    store.setter(cancelPointerAtom)
  })

  async function commitCellEdit() {
    const intent = store.setter(commitEditingAtom, {
      input: store.getter(editingDraftAtom),
      source: 'cell',
      move: 'none',
    })

    if (!intent) {
      return
    }

    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: intent.sheetId,
      row: intent.cell.row,
      col: intent.cell.col,
      input: intent.input,
    })
    await loadProjection(requestProjection())
  }

  async function clearActiveCell() {
    const selection = selectionSnapshot()
    if (selection.selection.sheetId !== props.sheetId) {
      return
    }

    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: props.sheetId,
      row: selection.activeCell.row,
      col: selection.activeCell.col,
      input: '',
    })
    await loadProjection(requestProjection())
  }

  function getCellMap() {
    const map = new Map<string, DisplayCell>()
    for (const cell of projectionSnapshot().result?.cells ?? []) {
      map.set(makeCellKey(cell.row, cell.col), cell)
    }
    return map
  }

  function getRows() {
    const window = visibleWindow()
    return getWindowIndexes(window.rowStart, window.rowEnd)
  }

  function getCols() {
    const window = visibleWindow()
    return getWindowIndexes(window.colStart, window.colEnd)
  }

  function isSelected(row: number, col: number) {
    const selection = selectionSnapshot()
    if (selection.selection.sheetId !== props.sheetId) {
      return false
    }

    const range = getSelectionRange(selection.selection, {
      rowCount: props.viewport.rowCount,
      colCount: props.viewport.colCount,
    })

    return (
      row >= range.rowStart &&
      row <= range.rowEnd &&
      col >= range.colStart &&
      col <= range.colEnd
    )
  }

  function isActive(row: number, col: number) {
    const selection = selectionSnapshot()
    return (
      selection.selection.sheetId === props.sheetId &&
      selection.activeCell.row === row &&
      selection.activeCell.col === col
    )
  }

  function isEditing(row: number, col: number) {
    const editing = editingSession()
    return (
      editing.status === 'drafting' &&
      editing.source?.sheetId === props.sheetId &&
      editing.source.cell.row === row &&
      editing.source.cell.col === col
    )
  }

  function focusGrid() {
    gridRoot?.focus()
  }

  function openContextMenu(
    event: MouseEvent,
    target:
      | { kind: 'cell'; row: number; col: number }
      | { kind: 'range'; row: number; col: number }
      | { kind: 'row'; row: number }
      | { kind: 'column'; col: number }
      | { kind: 'all' },
  ) {
    event.preventDefault()

    if (target.kind === 'cell') {
      store.setter(selectCellAtom, {
        sheetId: props.sheetId,
        coord: { row: target.row, col: target.col },
      })
    } else if (target.kind === 'range') {
      const selection = selectionSnapshot()
      if (
        selection.selection.sheetId !== props.sheetId ||
        selection.selection.kind !== 'range' ||
        target.row < selection.range.rowStart ||
        target.row > selection.range.rowEnd ||
        target.col < selection.range.colStart ||
        target.col > selection.range.colEnd
      ) {
        store.setter(selectCellAtom, {
          sheetId: props.sheetId,
          coord: { row: target.row, col: target.col },
        })
      }
    } else if (target.kind === 'row') {
      store.setter(selectRowsAtom, {
        sheetId: props.sheetId,
        rowAnchor: target.row,
        rowFocus: target.row,
      })
    } else if (target.kind === 'column') {
      store.setter(selectColumnsAtom, {
        sheetId: props.sheetId,
        colAnchor: target.col,
        colFocus: target.col,
      })
    } else {
      store.setter(selectAllAtom, props.sheetId)
    }

    store.setter(openMenuAtom, {
      surface: target.kind === 'cell' || target.kind === 'range' ? 'cell' : 'header',
      target:
        target.kind === 'cell'
          ? {
              kind: 'cell',
              sheetId: props.sheetId,
              cell: { row: target.row, col: target.col },
            }
          : target.kind === 'range'
            ? {
                kind: 'range',
                sheetId: props.sheetId,
                range: selectionSnapshot().range,
              }
          : target.kind === 'row'
            ? {
                kind: 'row',
                sheetId: props.sheetId,
                rowIndex: target.row,
              }
            : target.kind === 'column'
              ? {
                  kind: 'column',
                  sheetId: props.sheetId,
                  colIndex: target.col,
                }
              : {
                  kind: 'all',
                  sheetId: props.sheetId,
                },
      position: {
        x: event.clientX,
        y: event.clientY,
      },
      source: 'pointer',
    })
    bumpRender()
    focusGrid()
  }

  function getCellContextTarget(row: number, col: number): { kind: 'cell' | 'range'; row: number; col: number } {
    const selection = selectionSnapshot()
    if (
      selection.selection.sheetId === props.sheetId &&
      selection.selection.kind === 'range' &&
      row >= selection.range.rowStart &&
      row <= selection.range.rowEnd &&
      col >= selection.range.colStart &&
      col <= selection.range.colEnd
    ) {
      return { kind: 'range', row, col }
    }

    return { kind: 'cell', row, col }
  }

  function selectRow(row: number, extend: boolean) {
    const selection = selectionSnapshot().selection
    const rowAnchor =
      extend && selection.sheetId === props.sheetId && selection.kind === 'row'
        ? selection.rowAnchor
        : row

    store.setter(selectRowsAtom, {
      sheetId: props.sheetId,
      rowAnchor,
      rowFocus: row,
    })
    bumpRender()
    focusGrid()
  }

  function selectColumn(col: number, extend: boolean) {
    const selection = selectionSnapshot().selection
    const colAnchor =
      extend && selection.sheetId === props.sheetId && selection.kind === 'column'
        ? selection.colAnchor
        : col

    store.setter(selectColumnsAtom, {
      sheetId: props.sheetId,
      colAnchor,
      colFocus: col,
    })
    bumpRender()
    focusGrid()
  }

  function startEditingCell(row: number, col: number, source: 'keyboard' | 'cell') {
    const cell = getCell(row, col)
    store.setter(startEditingAtom, {
      sheetId: props.sheetId,
      cell: { row, col },
      draft: cell?.formula ?? cell?.displayValue ?? '',
      source,
    })
    bumpRender()
  }

  async function handleGridKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented) {
      return
    }

    const intent = store.setter(dispatchKeyboardInputAtom, {
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      isComposing: event.isComposing,
      pageRowDelta: Math.max(1, getRows().length),
      pageColDelta: Math.max(1, getCols().length),
    })

    switch (intent.type) {
      case 'selection.move':
      case 'selection.selectAll':
        event.preventDefault()
        bumpRender()
        return
      case 'editing.start': {
        event.preventDefault()
        const active = selectionSnapshot().activeCell
        startEditingCell(active.row, active.col, 'keyboard')
        return
      }
      case 'cell.clear':
        event.preventDefault()
        await clearActiveCell()
        return
      case 'sheet.activate-adjacent': {
        event.preventDefault()
        const nextSheetId = getAdjacentSheetId(
          store.getter(sheetTabsSheetsAtom),
          store.getter(workspaceSessionAtom).activeSheetId,
          intent.direction,
        )
        if (nextSheetId) {
          store.setter(setWorkspaceActiveSheetAtom, { sheetId: nextSheetId })
        }
        return
      }
      default:
        return
    }
  }

  function getCell(row: number, col: number) {
    return getCellMap().get(makeCellKey(row, col))
  }

  function getRenderedRowHeight(row: number) {
    return getViewportRowHeight(sizeOverrides(), props.sheetId, row, props.viewport.rowHeight)
  }

  function getRenderedColumnWidth(col: number) {
    return getViewportColumnWidth(sizeOverrides(), props.sheetId, col, props.viewport.colWidth)
  }

  function getColumnStyle(col: number): Record<string, string> {
    return {
      width: `${getRenderedColumnWidth(col)}px`,
    }
  }

  function getCellBoxStyle(row: number, col: number): Record<string, string> {
    return {
      height: `${getRenderedRowHeight(row)}px`,
      width: `${getRenderedColumnWidth(col)}px`,
    }
  }

  function getRowHeaderStyle(row: number): Record<string, string> {
    return {
      height: `${getRenderedRowHeight(row)}px`,
    }
  }

  function startColumnResize(event: PointerEvent, col: number) {
    event.preventDefault()
    event.stopPropagation()
    activeResizeCleanup?.()

    const startClientX = event.clientX
    const startSize = getRenderedColumnWidth(col)
    let previewSize = startSize
    store.setter(startPointerAtom, {
      kind: 'column-resize',
      sheetId: props.sheetId,
      colIndex: col,
      startSizePx: startSize,
      previewSizePx: startSize,
      source: 'pointer',
    })

    const onPointerMove = (moveEvent: PointerEvent) => {
      previewSize = startSize + moveEvent.clientX - startClientX
      store.setter(updatePointerAtom, {
        kind: 'column-resize',
        previewSizePx: previewSize,
      })
      store.setter(setViewportColumnWidthAtom, {
        sheetId: props.sheetId,
        colIndex: col,
        widthPx: previewSize,
      })
      bumpRender()
    }

    const onPointerUp = () => {
      const intent = store.setter(commitPointerAtom)
      if (intent?.type === 'pointer.column-resize.commit') {
        store.setter(setViewportColumnWidthAtom, {
          sheetId: props.sheetId,
          colIndex: intent.colIndex,
          widthPx: intent.previewSizePx,
        })
      }
      cleanupResize()
      bumpRender()
    }

    const cleanupResize = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      store.setter(cancelPointerAtom)
      activeResizeCleanup = null
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
    activeResizeCleanup = cleanupResize
    bumpRender()
  }

  function startRowResize(event: PointerEvent, row: number) {
    event.preventDefault()
    event.stopPropagation()
    activeResizeCleanup?.()

    const startClientY = event.clientY
    const startSize = getRenderedRowHeight(row)
    let previewSize = startSize
    store.setter(startPointerAtom, {
      kind: 'row-resize',
      sheetId: props.sheetId,
      rowIndex: row,
      startSizePx: startSize,
      previewSizePx: startSize,
      source: 'pointer',
    })

    const onPointerMove = (moveEvent: PointerEvent) => {
      previewSize = startSize + moveEvent.clientY - startClientY
      store.setter(updatePointerAtom, {
        kind: 'row-resize',
        previewSizePx: previewSize,
      })
      store.setter(setViewportRowHeightAtom, {
        sheetId: props.sheetId,
        rowIndex: row,
        heightPx: previewSize,
      })
      bumpRender()
    }

    const onPointerUp = () => {
      const intent = store.setter(commitPointerAtom)
      if (intent?.type === 'pointer.row-resize.commit') {
        store.setter(setViewportRowHeightAtom, {
          sheetId: props.sheetId,
          rowIndex: intent.rowIndex,
          heightPx: intent.previewSizePx,
        })
      }
      cleanupResize()
      bumpRender()
    }

    const cleanupResize = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      store.setter(cancelPointerAtom)
      activeResizeCleanup = null
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
    activeResizeCleanup = cleanupResize
    bumpRender()
  }

  return (
    <div
      ref={gridRoot}
      class={`spreadsheet-grid ${props.class ?? ''}`.trim()}
      data-testid={props['data-testid'] ?? 'spreadsheet-grid'}
      tabIndex={0}
      onKeyDown={(event) => {
        void handleGridKeyDown(event)
      }}
    >
      <table class="spreadsheet-grid-table">
        <tbody>
          <Show when={getRows().length > 0 && getCols().length > 0}>
            <tr>
              <th
                class="spreadsheet-grid-corner"
                data-selected={selectionSnapshot().selection.kind === 'all' ? 'true' : 'false'}
                onClick={() => {
                  store.setter(selectAllAtom, props.sheetId)
                  bumpRender()
                  focusGrid()
                }}
                onContextMenu={(event) => {
                  openContextMenu(event, { kind: 'all' })
                }}
              />
              <For each={getCols()}>
                {(col) => {
                  const selected = () => {
                    const snapshot = selectionSnapshot()
                    return (
                      snapshot.selection.kind === 'column' &&
                      snapshot.selection.sheetId === props.sheetId &&
                      col >= snapshot.range.colStart &&
                      col <= snapshot.range.colEnd
                    )
                  }

                  return (
                    <th
                      class={`spreadsheet-grid-col-header ${selected() ? 'is-selected' : ''}`.trim()}
                      data-col={col}
                      data-selected={selected() ? 'true' : 'false'}
                      style={getColumnStyle(col)}
                      onClick={(event) => {
                        selectColumn(col, event.shiftKey)
                      }}
                      onContextMenu={(event) => {
                        openContextMenu(event, { kind: 'column', col })
                      }}
                    >
                      <span class="spreadsheet-grid-header-label">{getColumnLabel(col)}</span>
                      <button
                        type="button"
                        class="spreadsheet-grid-col-resize-handle"
                        data-testid={`col-resize-${col}`}
                        aria-label={`Resize column ${getColumnLabel(col)}`}
                        onPointerDown={(event) => startColumnResize(event, col)}
                      />
                    </th>
                  )
                }}
              </For>
            </tr>
            <For each={getRows()}>
              {(row) => (
                <tr class="spreadsheet-grid-row">
                  <th
                    class={`spreadsheet-grid-row-header ${
                      selectionSnapshot().selection.kind === 'row' &&
                      selectionSnapshot().selection.sheetId === props.sheetId &&
                      row >= selectionSnapshot().range.rowStart &&
                      row <= selectionSnapshot().range.rowEnd
                        ? 'is-selected'
                        : ''
                    }`.trim()}
                    data-row={row}
                    data-selected={
                      selectionSnapshot().selection.kind === 'row' &&
                      selectionSnapshot().selection.sheetId === props.sheetId &&
                      row >= selectionSnapshot().range.rowStart &&
                      row <= selectionSnapshot().range.rowEnd
                        ? 'true'
                        : 'false'
                    }
                    style={getRowHeaderStyle(row)}
                    onClick={(event) => {
                      selectRow(row, event.shiftKey)
                    }}
                    onContextMenu={(event) => {
                      openContextMenu(event, { kind: 'row', row })
                    }}
                  >
                    <span class="spreadsheet-grid-header-label">{row + 1}</span>
                    <button
                      type="button"
                      class="spreadsheet-grid-row-resize-handle"
                      data-testid={`row-resize-${row}`}
                      aria-label={`Resize row ${row + 1}`}
                      onPointerDown={(event) => startRowResize(event, row)}
                    />
                  </th>
                  <For each={getCols()}>
                    {(col) => {
                      const addr = getCellAddress(row, col)
                      const cell = () => getCell(row, col)
                      const selected = () => isSelected(row, col)
                      const active = () => isActive(row, col)
                      const editing = () => isEditing(row, col)
                      return (
                        <td
                          class={`spreadsheet-grid-cell cell ${
                            selected() ? 'is-selected cell-in-range' : ''
                          } ${
                            active() ? 'cell-active' : ''
                          } ${cell()?.valueKind ? `kind-${cell()?.valueKind}` : ''}`.trim()}
                          data-row={row}
                          data-col={col}
                          data-cell-addr={addr}
                          data-selected={selected() ? 'true' : 'false'}
                          data-active={active() ? 'true' : 'false'}
                          aria-selected={selected() ? 'true' : 'false'}
                          style={getCellBoxStyle(row, col)}
                          onClick={(event) => {
                            store.setter(selectCellAtom, {
                              sheetId: props.sheetId,
                              coord: { row, col },
                              extend: event.shiftKey,
                            })
                            bumpRender()
                            focusGrid()
                          }}
                          onMouseDown={(event) => {
                            if (!event.shiftKey) {
                              return
                            }

                            event.preventDefault()
                            store.setter(selectCellAtom, {
                              sheetId: props.sheetId,
                              coord: { row, col },
                              extend: true,
                            })
                            bumpRender()
                            focusGrid()
                          }}
                          onDblClick={() => {
                            startEditingCell(row, col, 'cell')
                          }}
                          onContextMenu={(event) => {
                            openContextMenu(event, getCellContextTarget(row, col))
                          }}
                        >
                          <Show
                            when={editing()}
                            fallback={
                              <button type="button" class="spreadsheet-grid-cell-button">
                                <span
                                  class="cell-display"
                                  style={getCellFormatStyle(cell()?.format)}
                                >
                                  {cell()?.displayValue ?? ''}
                                </span>
                              </button>
                            }
                          >
                            <input
                              class="cell-input"
                              value={editingDraft()}
                              autofocus
                              onInput={(event) => {
                                store.setter(editingDraftAtom, { draft: event.currentTarget.value })
                                bumpRender()
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  void commitCellEdit()
                                } else if (event.key === 'Escape') {
                                  event.preventDefault()
                                  store.setter(cancelEditingAtom)
                                  bumpRender()
                                }
                              }}
                              onBlur={() => {
                                if (store.getter(editingSessionAtom).status === 'drafting') {
                                  void commitCellEdit()
                                }
                              }}
                            />
                          </Show>
                        </td>
                      )
                    }}
                  </For>
                </tr>
              )}
            </For>
          </Show>
        </tbody>
      </table>
    </div>
  )
}
