/** @jsxImportSource solid-js */
import { For, Show, createSignal } from 'solid-js'
import { Cell } from './Cell'
import type { SheetStore } from './sheet-store'
import { createTableInteractions } from './table-interactions'
import type { WorkbookStore } from './workbook-store'

export interface TableProps {
  store: SheetStore | WorkbookStore
  rows?: number
  cols?: number
  interactions?: ReturnType<typeof createTableInteractions>
}

type ContextMenuState =
  | { kind: 'row'; index: number; x: number; y: number }
  | { kind: 'col'; index: number; x: number; y: number }
  | { kind: 'cell'; addr: string; x: number; y: number }
  | null

function colToLetter(col: number): string {
  let result = ''
  let current = col
  do {
    result = String.fromCharCode(65 + (current % 26)) + result
    current = Math.floor(current / 26) - 1
  } while (current >= 0)
  return result
}

function cellAddr(row: number, col: number): string {
  return `${colToLetter(col)}${row + 1}`
}

function isWorkbookStore(store: SheetStore | WorkbookStore): store is WorkbookStore {
  return typeof (store as WorkbookStore).rowCount === 'function'
}

export function Table(props: TableProps) {
  const rows = () => isWorkbookStore(props.store) ? props.store.rowCount() : (props.rows ?? 20)
  const cols = () => isWorkbookStore(props.store) ? props.store.colCount() : (props.cols ?? 10)
  const interactions = props.interactions ?? createTableInteractions(props.store, rows, cols)
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState>(null)
  let wrapperRef: HTMLDivElement | undefined

  const rowIndices = () => Array.from({ length: rows() }, (_, index) => index)
  const colIndices = () => Array.from({ length: cols() }, (_, index) => index)

  function focusWrapper() {
    wrapperRef?.focus()
  }

  function columnWidth(index: number) {
    return isWorkbookStore(props.store) ? props.store.colWidth(index) : 96
  }

  function rowHeight(index: number) {
    return isWorkbookStore(props.store) ? props.store.rowHeight(index) : 28
  }

  function freezeTopRow() {
    return isWorkbookStore(props.store) ? props.store.freezeTopRow() : false
  }

  function freezeFirstColumn() {
    return isWorkbookStore(props.store) ? props.store.freezeFirstColumn() : false
  }

  function handleSelect(addr: string, extend: boolean) {
    focusWrapper()
    interactions.select(addr, extend)
    setContextMenu(null)
  }

  function workbookStore() {
    return isWorkbookStore(props.store) ? props.store : null
  }

  function recordSnapshotMutation(kind: string, handler: () => void, focusAddr?: string) {
    const workbook = workbookStore()
    if (!workbook) {
      handler()
      return
    }

    const before = workbook.takeSnapshot()
    handler()
    const after = workbook.takeSnapshot()
    interactions.recordSnapshotChange(kind, before, after, focusAddr)
  }

  function isAccel(event: KeyboardEvent) {
    return event.ctrlKey || event.metaKey
  }

  function onKeyDown(event: KeyboardEvent) {
    if (interactions.editingCell()) return

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      interactions.moveSelection(-1, 0, event.shiftKey)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      interactions.moveSelection(1, 0, event.shiftKey)
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      interactions.moveSelection(0, -1, event.shiftKey)
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      interactions.moveSelection(0, 1, event.shiftKey)
      return
    }
    if (event.key === 'Delete') {
      event.preventDefault()
      interactions.clearSelection()
      return
    }

    if (!isAccel(event)) return

    const key = event.key.toLowerCase()
    if (key === 'c') {
      event.preventDefault()
      void interactions.copySelection()
      return
    }
    if (key === 'x') {
      event.preventDefault()
      void interactions.cutSelection()
      return
    }
    if (key === 'v') {
      event.preventDefault()
      void interactions.pasteSelection()
      return
    }
    if (key === 'z' && event.shiftKey) {
      event.preventDefault()
      interactions.redo()
      return
    }
    if (key === 'z') {
      event.preventDefault()
      interactions.undo()
      return
    }
    if (key === 'y') {
      event.preventDefault()
      interactions.redo()
    }
  }

  function openRowMenu(event: MouseEvent, index: number) {
    event.preventDefault()
    focusWrapper()
    setContextMenu({ kind: 'row', index, x: event.clientX, y: event.clientY })
  }

  function openColMenu(event: MouseEvent, index: number) {
    event.preventDefault()
    focusWrapper()
    setContextMenu({ kind: 'col', index, x: event.clientX, y: event.clientY })
  }

  function openCellMenu(event: MouseEvent, addr: string) {
    event.preventDefault()
    interactions.select(addr, false)
    focusWrapper()
    setContextMenu({ kind: 'cell', addr, x: event.clientX, y: event.clientY })
  }

  function beginResize(axis: 'row' | 'col', index: number, event: MouseEvent) {
    if (!isWorkbookStore(props.store)) return
    event.preventDefault()
    event.stopPropagation()

    const before = props.store.takeSnapshot()
    const startPosition = axis === 'col' ? event.clientX : event.clientY
    const startSize = axis === 'col' ? props.store.colWidth(index) : props.store.rowHeight(index)

    const onMove = (moveEvent: MouseEvent) => {
      const delta = (axis === 'col' ? moveEvent.clientX : moveEvent.clientY) - startPosition
      const workbook = workbookStore()
      if (!workbook) return
      if (axis === 'col') {
        workbook.setColWidth(index, startSize + delta)
      } else {
        workbook.setRowHeight(index, startSize + delta)
      }
    }

    const onUp = () => {
      const workbook = workbookStore()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (!workbook) return
      const after = workbook.takeSnapshot()
      interactions.recordSnapshotChange(axis === 'col' ? 'resize_col' : 'resize_row', before, after, interactions.selectedCell())
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      class="excel-table-wrapper"
      onClick={() => setContextMenu(null)}
      onKeyDown={onKeyDown}
      ref={(element) => {
        wrapperRef = element
      }}
      tabIndex={0}
    >
      <table class="excel-table">
        <thead>
          <tr>
            <th class={`row-header corner-header ${freezeTopRow() ? 'sticky-top' : ''} ${freezeFirstColumn() ? 'sticky-left' : ''}`}></th>
            <For each={colIndices()}>
              {(col) => (
                <th
                  class={`col-header ${freezeTopRow() ? 'sticky-top' : ''} ${freezeFirstColumn() && col === 0 ? 'sticky-left sticky-first-col' : ''}`}
                  onContextMenu={(event) => openColMenu(event, col)}
                  style={{ width: `${columnWidth(col)}px`, 'min-width': `${columnWidth(col)}px` }}
                >
                  <span>{colToLetter(col)}</span>
                  <Show when={isWorkbookStore(props.store)}>
                    <button
                      aria-label={`Resize column ${colToLetter(col)}`}
                      class="resize-handle resize-handle-col"
                      onMouseDown={(event) => beginResize('col', col, event)}
                      type="button"
                    />
                  </Show>
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={rowIndices()}>
            {(row) => (
              <tr style={{ height: `${rowHeight(row)}px` }}>
                <td
                  class={`row-header ${freezeFirstColumn() ? 'sticky-left' : ''} ${freezeTopRow() && row === 0 ? 'sticky-first-row' : ''}`}
                  onContextMenu={(event) => openRowMenu(event, row)}
                  style={{ height: `${rowHeight(row)}px` }}
                >
                  <span>{row + 1}</span>
                  <Show when={isWorkbookStore(props.store)}>
                    <button
                      aria-label={`Resize row ${row + 1}`}
                      class="resize-handle resize-handle-row"
                      onMouseDown={(event) => beginResize('row', row, event)}
                      type="button"
                    />
                  </Show>
                </td>
                <For each={colIndices()}>
                  {(col) => {
                    const addr = cellAddr(row, col)
                    return (
                      <Cell
                        activeEditing={interactions.editingCell() === addr}
                        addr={addr}
                        inSelection={interactions.isInSelection(addr)}
                        onCancelEdit={() => interactions.cancelEdit()}
                        onCommitEdit={(input) => interactions.commitEdit(addr, input)}
                        onContextMenu={(event) => openCellMenu(event, addr)}
                        onEditingChange={(editing) => interactions.setEditingCell(editing ? addr : null)}
                        onSelect={(extend) => handleSelect(addr, extend)}
                        selected={interactions.isSelected(addr)}
                        selectionEdges={interactions.selectionEdges(addr)}
                        store={props.store}
                      />
                    )
                  }}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>

      <Show when={contextMenu()}>
        {(menu) => (
          <div
            class="table-context-menu"
            style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
          >
            <Show when={menu().kind === 'row' && isWorkbookStore(props.store)}>
              <button
                onClick={() => {
                  const workbook = workbookStore()
                  if (!workbook) return
                  recordSnapshotMutation('insert_row', () => workbook.insertRow((menu() as { index: number }).index), interactions.selectionTopLeft())
                  setContextMenu(null)
                }}
                type="button"
              >
                Insert Row Above
              </button>
              <button
                onClick={() => {
                  const workbook = workbookStore()
                  if (!workbook) return
                  recordSnapshotMutation('insert_row', () => workbook.insertRow((menu() as { index: number }).index + 1), interactions.selectionTopLeft())
                  setContextMenu(null)
                }}
                type="button"
              >
                Insert Row Below
              </button>
              <button
                onClick={() => {
                  const workbook = workbookStore()
                  if (!workbook) return
                  recordSnapshotMutation('delete_row', () => workbook.deleteRow((menu() as { index: number }).index), interactions.selectionTopLeft())
                  setContextMenu(null)
                }}
                type="button"
              >
                Delete Row
              </button>
              <button
                onClick={() => {
                  const workbook = workbookStore()
                  if (!workbook) return
                  recordSnapshotMutation('freeze_toggle', () => workbook.setFreezeTopRow(!workbook.freezeTopRow()), interactions.selectionTopLeft())
                  setContextMenu(null)
                }}
                type="button"
              >
                {workbookStore()?.freezeTopRow() ? 'Unfreeze Top Row' : 'Freeze Top Row'}
              </button>
            </Show>

            <Show when={menu().kind === 'col' && isWorkbookStore(props.store)}>
              <button
                onClick={() => {
                  const workbook = workbookStore()
                  if (!workbook) return
                  recordSnapshotMutation('insert_col', () => workbook.insertCol((menu() as { index: number }).index), interactions.selectionTopLeft())
                  setContextMenu(null)
                }}
                type="button"
              >
                Insert Column Left
              </button>
              <button
                onClick={() => {
                  const workbook = workbookStore()
                  if (!workbook) return
                  recordSnapshotMutation('insert_col', () => workbook.insertCol((menu() as { index: number }).index + 1), interactions.selectionTopLeft())
                  setContextMenu(null)
                }}
                type="button"
              >
                Insert Column Right
              </button>
              <button
                onClick={() => {
                  const workbook = workbookStore()
                  if (!workbook) return
                  recordSnapshotMutation('delete_col', () => workbook.deleteCol((menu() as { index: number }).index), interactions.selectionTopLeft())
                  setContextMenu(null)
                }}
                type="button"
              >
                Delete Column
              </button>
              <button
                onClick={() => {
                  const workbook = workbookStore()
                  if (!workbook) return
                  recordSnapshotMutation('freeze_toggle', () => workbook.setFreezeFirstColumn(!workbook.freezeFirstColumn()), interactions.selectionTopLeft())
                  setContextMenu(null)
                }}
                type="button"
              >
                {workbookStore()?.freezeFirstColumn() ? 'Unfreeze First Column' : 'Freeze First Column'}
              </button>
            </Show>

            <Show when={menu().kind === 'cell'}>
              <button
                onClick={() => {
                  void interactions.copySelection()
                  setContextMenu(null)
                }}
                type="button"
              >
                Copy
              </button>
              <button
                onClick={() => {
                  void interactions.pasteSelection()
                  setContextMenu(null)
                }}
                type="button"
              >
                Paste
              </button>
              <button
                onClick={() => {
                  interactions.clearSelection()
                  setContextMenu(null)
                }}
                type="button"
              >
                Clear
              </button>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}
