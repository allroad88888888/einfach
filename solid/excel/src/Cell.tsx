
import { createSignal, Show } from 'solid-js'
import type { SheetStore } from './sheet-store'

export interface CellProps {
  addr: string
  store: SheetStore
  /** Reactive accessor — true when this cell is the active selection. */
  selected?: () => boolean
  /**
   * Reactive accessor — true when this cell is part of the current
   * selection range but is NOT the focus cell. Mutually exclusive with
   * `selected` (the focus cell wins so its outline stays distinct).
   */
  inRange?: () => boolean
  /** Called on click to request selection of this cell. */
  onSelect?: () => void
  /** Called on shift+click to extend the range to this cell. */
  onExtendSelect?: () => void
}

export function Cell(props: CellProps) {
  const [editing, setEditing] = createSignal(false)
  const [editValue, setEditValue] = createSignal('')

  const cellValue = () => props.store.getCell(props.addr)
  const isSelected = () => (props.selected ? props.selected() : false)
  const isInRange = () => (props.inRange ? props.inRange() : false)

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

  function classes() {
    const v = cellValue()
    const sel = isSelected()
    return [
      'cell',
      `cell-${v.type}`,
      v.isError ? 'cell-error' : '',
      sel ? 'cell-selected' : '',
      // Focus cell wins — only draw the lighter range tint on non-focus
      // cells so the outline on the focus cell stays visually distinct.
      !sel && isInRange() ? 'cell-in-range' : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  function onClick(e: MouseEvent) {
    if (e.shiftKey && props.onExtendSelect) {
      props.onExtendSelect()
    } else {
      props.onSelect?.()
    }
  }

  return (
    <td
      class={classes()}
      data-cell-addr={props.addr}
      onClick={onClick}
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
