import { For } from 'solid-js'
import { Cell } from './Cell'
import type { SheetStore } from './sheet-store'

export interface TableProps {
  store: SheetStore
  rows?: number
  cols?: number
}

/** Convert 0-based column index to letter(s): 0→A, 25→Z, 26→AA */
function colToLetter(col: number): string {
  let result = ''
  let c = col
  do {
    result = String.fromCharCode(65 + (c % 26)) + result
    c = Math.floor(c / 26) - 1
  } while (c >= 0)
  return result
}

/** Build cell address from row/col: (0,0)→"A1" */
function cellAddr(row: number, col: number): string {
  return `${colToLetter(col)}${row + 1}`
}

export function Table(props: TableProps) {
  const rows = () => props.rows ?? 20
  const cols = () => props.cols ?? 10

  const rowIndices = () => Array.from({ length: rows() }, (_, i) => i)
  const colIndices = () => Array.from({ length: cols() }, (_, i) => i)

  return (
    <div class="excel-table-wrapper">
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
                  {(col) => (
                    <Cell
                      addr={cellAddr(row, col)}
                      store={props.store}
                    />
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}
