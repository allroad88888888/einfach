/** @jsxImportSource solid-js */
import { createSignal, Show } from 'solid-js'
import type { SheetStore } from './sheet-store'
import type { CellFormat } from './types'
import type { WorkbookStore } from './workbook-store'

export interface CellProps {
  addr: string
  store: SheetStore | WorkbookStore
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
  const cellFormat = (): CellFormat => 'getCellFormat' in props.store
    ? props.store.getCellFormat(props.addr)
    : {
        bold: false,
        italic: false,
        fontSize: null,
        textColor: null,
        backgroundColor: null,
        horizontalAlign: null,
        verticalAlign: null,
        borderStyle: 'none',
        borderColor: null,
        numberFormat: {
          kind: 'general',
          decimals: 2,
          useGrouping: false,
          currencySymbol: '$',
        },
      }
  const editing = () => props.activeEditing ?? localEditing()
  const style = () => ({
    'font-weight': cellFormat().bold ? '700' : undefined,
    'font-style': cellFormat().italic ? 'italic' : undefined,
    'font-size': cellFormat().fontSize ? `${cellFormat().fontSize}px` : undefined,
    color: cellFormat().textColor ?? undefined,
    'background-color': props.inSelection ? undefined : cellFormat().backgroundColor ?? undefined,
    'text-align': cellFormat().horizontalAlign ?? undefined,
    'vertical-align': cellFormat().verticalAlign === 'middle' ? 'middle' : cellFormat().verticalAlign ?? undefined,
    border: cellFormat().borderStyle === 'solid'
      ? `1px solid ${cellFormat().borderColor ?? '#b8c4d6'}`
      : undefined,
  })

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
      style={style()}
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
