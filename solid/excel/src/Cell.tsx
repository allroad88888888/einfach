/** @jsxImportSource solid-js */
import { createSignal, Show } from 'solid-js'
import type { SheetStore } from './sheet-store'

export interface CellProps {
  addr: string
  store: SheetStore
  selected?: boolean
  inSelection?: boolean
  selectionEdges?: {
    top: boolean
    right: boolean
    bottom: boolean
    left: boolean
  }
  activeEditing?: boolean
  onSelect?: (extend: boolean) => void
  onContextMenu?: (event: MouseEvent) => void
  onEditingChange?: (editing: boolean) => void
  onCommitEdit?: (input: string) => void
  onCancelEdit?: () => void
}

export function Cell(props: CellProps) {
  const [localEditing, setLocalEditing] = createSignal(false)
  const [editValue, setEditValue] = createSignal('')

  const cellValue = () => props.store.getCell(props.addr)
  const editing = () => props.activeEditing ?? localEditing()

  function setEditing(next: boolean) {
    if (props.onEditingChange) {
      props.onEditingChange(next)
    } else {
      setLocalEditing(next)
    }
  }

  function startEditing() {
    props.onSelect?.(false)
    setEditValue(props.store.getInput(props.addr))
    setEditing(true)
  }

  function commitEdit() {
    if (props.onCommitEdit) {
      props.onCommitEdit(editValue())
    } else {
      props.store.setCellInput(props.addr, editValue())
    }
    setEditing(false)
  }

  function cancelEdit() {
    props.onCancelEdit?.()
    setEditing(false)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      commitEdit()
    } else if (e.key === 'Escape') {
      cancelEdit()
    }
  }

  return (
    <td
      class={`cell ${cellValue().isError ? 'cell-error' : ''} cell-${cellValue().type} ${props.selected ? 'cell-selected' : ''} ${props.inSelection ? 'cell-in-selection' : ''} ${props.selectionEdges?.top ? 'cell-range-top' : ''} ${props.selectionEdges?.right ? 'cell-range-right' : ''} ${props.selectionEdges?.bottom ? 'cell-range-bottom' : ''} ${props.selectionEdges?.left ? 'cell-range-left' : ''}`}
      onClick={(e) => props.onSelect?.(e.shiftKey)}
      onContextMenu={(event) => props.onContextMenu?.(event)}
      onDblClick={startEditing}
    >
      <Show
        when={editing()}
        fallback={<span class="cell-display">{cellValue().display}</span>}
      >
        <input
          class="cell-input"
          value={editValue()}
          onInput={(e) => setEditValue(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          onBlur={commitEdit}
          ref={(el) => {
            if (el) {
              setTimeout(() => el.focus(), 0)
            }
          }}
        />
      </Show>
    </td>
  )
}
