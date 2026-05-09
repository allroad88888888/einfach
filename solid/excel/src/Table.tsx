
import { For, Show } from 'solid-js'
import { Cell } from './Cell'
import { FormulaBar } from './FormulaBar'
import { clampCoord, colToLetter, coordToAddr, type CellCoord } from './selection'
import {
  parseClipboardTSV,
  serializeClipboardTSV,
  type SheetStore,
} from './sheet-store'

export interface TableProps {
  store: SheetStore
  rows?: number
  cols?: number
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

  // Selection lives on the store so FormulaBar / future copy-paste / right-
  // click menus all read & write the same source of truth.
  const selected = () => props.store.selection()

  function selectCoord(next: CellCoord) {
    props.store.setSelection(clampCoord(next, rows(), cols()))
  }

  function extendCoord(next: CellCoord) {
    props.store.extendSelection(clampCoord(next, rows(), cols()))
  }

  function move(drow: number, dcol: number, extend = false) {
    const cur = selected()
    const next = { row: cur.row + drow, col: cur.col + dcol }
    if (extend) extendCoord(next)
    else selectCoord(next)
  }

  // Ctrl+C / Ctrl+V handlers — extracted from onKeyDown to keep that switch
  // small and to allow direct unit-call from tests if needed later.
  async function handleCopy(e: KeyboardEvent) {
    e.preventDefault()
    const addrs = props.store.selectionAddrs()
    const data = props.store.copy(addrs)
    const text = serializeClipboardTSV(data)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // No clipboard permission / not in a secure context. Silently swallow
      // — there's nothing user-actionable we can surface from here, and a
      // thrown error would crash the keydown handler.
    }
  }

  async function handlePaste(e: KeyboardEvent) {
    e.preventDefault()
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      return
    }
    if (text === '') return
    const target = coordToAddr(selected())
    // Origin defaults to the paste target so foreign clipboards (no marker)
    // paste literally without shifting refs.
    const data = parseClipboardTSV(text, target)
    props.store.paste(target, data)
  }

  async function handleCut(e: KeyboardEvent) {
    await handleCopy(e)
    const addrs = props.store.selectionAddrs()
    props.store.beginEdit()
    for (const row of addrs) {
      for (const addr of row) props.store.clearCell(addr)
    }
    props.store.endEdit()
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
      if (e.key === 'c' || e.key === 'C') {
        void handleCopy(e)
        return
      }
      if (e.key === 'v' || e.key === 'V') {
        void handlePaste(e)
        return
      }
      if (e.key === 'x' || e.key === 'X') {
        void handleCut(e)
        return
      }
    }

    switch (e.key) {
      case 'ArrowUp':
        move(-1, 0, e.shiftKey)
        e.preventDefault()
        break
      case 'ArrowDown':
        move(1, 0, e.shiftKey)
        e.preventDefault()
        break
      case 'ArrowLeft':
        move(0, -1, e.shiftKey)
        e.preventDefault()
        break
      case 'ArrowRight':
        move(0, 1, e.shiftKey)
        e.preventDefault()
        break
      case 'Tab':
        // Tab always collapses — that's the spreadsheet convention even
        // when shift is held (Shift+Tab moves backward, doesn't extend).
        move(0, e.shiftKey ? -1 : 1)
        e.preventDefault()
        break
      case 'Delete':
      case 'Backspace': {
        // Clear every cell in the selection range. Routed through SheetStore
        // so undo collapses to one entry via beginEdit/endEdit.
        const addrs = props.store.selectionAddrs()
        props.store.beginEdit()
        for (const row of addrs) {
          for (const addr of row) props.store.clearCell(addr)
        }
        props.store.endEdit()
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
        <FormulaBar store={props.store} />
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
