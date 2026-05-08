/** @jsxImportSource solid-js */

import { createSignal, Show } from 'solid-js'
import type { SheetStore } from './sheet-store'

export interface CellProps {
  addr: string
  store: SheetStore
}

export function Cell(props: CellProps) {
  const [editing, setEditing] = createSignal(false)
  const [editValue, setEditValue] = createSignal('')

  const cellValue = () => props.store.getCell(props.addr)

  function startEditing() {
    // For formula cells, edit the source formula (`=A1*2`) instead of the
    // computed result (`20`). Without this the formula is silently replaced
    // by a static value on commit (D.11).
    const formula = props.store.getFormula(props.addr)
    setEditValue(formula !== '' ? formula : cellValue().display)
    setEditing(true)
  }

  function commitEdit() {
    props.store.setCellInput(props.addr, editValue())
    setEditing(false)
  }

  function cancelEdit() {
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
      class={`cell ${cellValue().isError ? 'cell-error' : ''} cell-${cellValue().type}`}
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
          ref={(el) => setTimeout(() => el.focus(), 0)}
        />
      </Show>
    </td>
  )
}
