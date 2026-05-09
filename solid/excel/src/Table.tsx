/** @jsxImportSource solid-js */

import { For, Show, createSignal } from 'solid-js'
import { Cell } from './Cell'
import { FormulaBar } from './FormulaBar'
import { clampCoord, colToLetter, coordToAddr, type CellCoord } from './selection'
import type { SheetStore } from './sheet-store'

export interface TableProps {
  store: SheetStore
  rows?: number
  cols?: number
  /**
   * Optional controlled selection. If provided, Table reads selection
   * from it and reports changes via `onSelectionChange`. If omitted,
   * Table maintains its own selection internally.
   */
  selected?: () => CellCoord
  onSelectionChange?: (next: CellCoord) => void
  /** Render an Excel-style formula bar above the grid. */
  formulaBar?: boolean
}

/** Build cell address from row/col: (0,0)→"A1" */
function cellAddr(row: number, col: number): string {
  return coordToAddr({ row, col })
}

export function Table(props: TableProps) {
  const rows = () => props.rows ?? 20
  const cols = () => props.cols ?? 10

  const rowIndices = () => Array.from({ length: rows() }, (_, i) => i)
  const colIndices = () => Array.from({ length: cols() }, (_, i) => i)

  const [internalSel, setInternalSel] = createSignal<CellCoord>({ row: 0, col: 0 })
  const selected = () => (props.selected ? props.selected() : internalSel())

  function selectCoord(next: CellCoord) {
    const clamped = clampCoord(next, rows(), cols())
    if (props.onSelectionChange) {
      props.onSelectionChange(clamped)
    } else {
      setInternalSel(clamped)
    }
  }

  function move(drow: number, dcol: number) {
    const cur = selected()
    selectCoord({ row: cur.row + drow, col: cur.col + dcol })
  }

  function onKeyDown(e: KeyboardEvent) {
    // Skip if the user is editing inside a Cell input — Cell's own handler
    // owns Enter / Escape / arrow semantics during edit.
    const target = e.target as HTMLElement | null
    if (target && target.tagName === 'INPUT') return

    const meta = e.ctrlKey || e.metaKey
    if (meta) {
      // Undo / redo. Cmd/Ctrl + Z = undo; + Shift+Z or + Y = redo.
      if (e.key === 'z' || e.key === 'Z') {
        if (e.shiftKey) {
          props.store.redo()
        } else {
          props.store.undo()
        }
        e.preventDefault()
        return
      }
      if (e.key === 'y' || e.key === 'Y') {
        props.store.redo()
        e.preventDefault()
        return
      }
    }

    switch (e.key) {
      case 'ArrowUp':
        move(-1, 0)
        e.preventDefault()
        break
      case 'ArrowDown':
        move(1, 0)
        e.preventDefault()
        break
      case 'ArrowLeft':
        move(0, -1)
        e.preventDefault()
        break
      case 'ArrowRight':
        move(0, 1)
        e.preventDefault()
        break
      case 'Tab':
        move(0, e.shiftKey ? -1 : 1)
        e.preventDefault()
        break
      case 'Delete':
      case 'Backspace': {
        // Clear the selected cell. Routed through SheetStore so undo works.
        const cur = selected()
        props.store.clearCell(coordToAddr(cur))
        e.preventDefault()
        break
      }
      // Enter / F2 / typing-into-cell are not handled here yet — those go
      // through Cell's edit-mode entry. ROADMAP 1B follow-up.
    }
  }

  return (
    <div
      class="excel-table-wrapper"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <Show when={props.formulaBar}>
        <FormulaBar
          store={props.store}
          activeAddr={() => coordToAddr(selected())}
        />
      </Show>
      <table class="excel-table">
        <thead>
          <tr>
            <th class="row-header"></th>
            <For each={colIndices()}>
              {(col) => <th class="col-header">{colToLetter(col)}</th>}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={rowIndices()}>
            {(row) => (
              <tr>
                <td class="row-header">{row + 1}</td>
                <For each={colIndices()}>
                  {(col) => {
                    const isSelected = () =>
                      selected().row === row && selected().col === col
                    return (
                      <Cell
                        addr={cellAddr(row, col)}
                        store={props.store}
                        selected={isSelected}
                        onSelect={() => selectCoord({ row, col })}
                      />
                    )
                  }}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}
