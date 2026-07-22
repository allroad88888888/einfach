/** @jsxImportSource solid-js */

/**
 * Parity item #29 — filter/sort visibility on the WORKER path.
 *
 * Excel HIDDEN-ROW semantics (#27 S5): applying the rules runs one whole-column
 * predicate scan in `setFilterSort`, and the rows it rejects are WITHHELD from
 * the projection while every surviving row keeps its own index. Display row IS
 * source row and row numbers skip (1, 4, 5) exactly as they already did for
 * manually hidden rows. These tests pin:
 *  - identity projection + withheld rows (no compaction, no second
 *    coordinate system),
 *  - the filter-hidden set handed to the engine and returned on the ACK,
 *  - sort as engine data untouched (the display-permutation sort is retired),
 *  - the structured over-cap rejection (fail-closed, no truncation),
 *  - SNAPSHOT visibility: editing a cell does not re-evaluate the rules,
 *  - edits landing on the row the user sees, with no gateway remapping,
 *  - the filter dropdown driving the worker backend end to end.
 */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type { VisibleProjectionResult } from '@einfach/spreadsheet-ui-core'
import {
  filterSortLifecycleAtom,
  filterSortStateAtom,
  openFilterDropdownAtom,
  setWorkspaceActiveSheetAtom,
} from '@einfach/spreadsheet-ui-core'
import type {
  CellRefWire,
  CellSnapshotWire,
  CellWire,
  ColumnFilterRuleWire,
  FilterApplyResultWire,
  SparseRangeWire,
  WorkerWorkbookClient,
} from '../src-vnext/adapter'
import {
  FILTER_SORT_SOURCE_TOO_LARGE,
  MAX_FILTER_SORT_PREDICATE_CELLS,
  createWorkerWorkbookSpreadsheetBackend,
} from '../src-vnext/adapter'
import { buildFilterSortDisplayRows } from '../src-vnext/adapter/filter-predicate'
import { filterHiddenRowsFromDisplayRows } from '../src-vnext/adapter/filter-hidden-rows'
import { SpreadsheetFilterDropdown } from '../src-vnext/filter-sort'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

function toAddr(row: number, col: number): string {
  let value = col + 1
  let label = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return `${label}${row + 1}`
}

function parseAddr(addr: string): { row: number; col: number } {
  const match = addr.toUpperCase().match(/^([A-Z]+)(\d+)$/)!
  let col = 0
  for (let index = 0; index < match[1].length; index += 1) {
    col = col * 26 + (match[1].charCodeAt(index) - 64)
  }
  return { row: Number(match[2]) - 1, col: col - 1 }
}

type FilterFakeClient = WorkerWorkbookClient & {
  calls: {
    listNonEmpty: number
    readSparseRange: SparseRangeWire[]
    readCells: CellRefWire[][]
    setCell: Array<{ sheet: number; addr: string; value: CellWire }>
    setEvalFilterHiddenRows: Array<{ sheet: number; rows: number[] }>
    applyFilter: Array<{ sheet: number; rules: ColumnFilterRuleWire[] }>
    clearFilter: Array<{ sheet: number }>
  }
  seedCell(row: number, col: number, value: string | number): void
  emitDirty(): void
}

/**
 * Focused in-memory client double: only the RPC families the filter/sort
 * path exercises are real (`initWorkbook`, `sheetList`, `listNonEmpty`,
 * `readSparseRange`, `readCells`, `snapshotFormatRange`, the setCell
 * family, dirty events); everything else throws.
 */
function createFilterFakeClient(
  evalFilterHiddenRows: 'record' | 'unsupported' = 'record',
): FilterFakeClient {
  const cells = new Map<string, CellSnapshotWire>()
  const dirtyListeners = new Set<(refs: CellRefWire[]) => void>()
  const calls: FilterFakeClient['calls'] = {
    listNonEmpty: 0,
    readSparseRange: [],
    readCells: [],
    setCell: [],
    setEvalFilterHiddenRows: [],
    applyFilter: [],
    clearFilter: [],
  }

  function key(sheet: number, addr: string) {
    return `${sheet}:${addr.toUpperCase()}`
  }

  function seedCell(row: number, col: number, value: string | number) {
    const addr = toAddr(row, col)
    cells.set(key(0, addr), {
      sheet: 0,
      addr,
      display: String(value),
      type: typeof value === 'number' ? 'number' : 'text',
      isError: false,
      formula: '',
    })
  }

  function unused(name: string): never {
    throw new Error(`${name} not used by the filter/sort fake client`)
  }

  const partial: Partial<WorkerWorkbookClient> = {
    async initWorkbook(sheets = ['Sheet1']) {
      return sheets.map((name, idx) => ({ idx, name }))
    },
    async describeCapabilities() {
      return null
    },
    async sheetList() {
      return [{ idx: 0, name: 'Sheet1' }]
    },
    async listNonEmpty() {
      calls.listNonEmpty += 1
      return [...cells.values()].map((cell) => ({ sheet: cell.sheet, addr: cell.addr }))
    },
    async readSparseRange(range) {
      calls.readSparseRange.push({ ...range })
      return [...cells.values()]
        .filter((cell) => {
          const coord = parseAddr(cell.addr)
          return (
            cell.sheet === range.sheet &&
            coord.row >= range.startRow &&
            coord.row <= range.endRow &&
            coord.col >= range.startCol &&
            coord.col <= range.endCol
          )
        })
        .sort((left, right) => {
          const la = parseAddr(left.addr)
          const ra = parseAddr(right.addr)
          return la.row === ra.row ? la.col - ra.col : la.row - ra.row
        })
    },
    async readCells(refs) {
      calls.readCells.push(refs.map((ref) => ({ ...ref })))
      return refs.map(
        (ref) =>
          cells.get(key(ref.sheet, ref.addr)) ?? {
            sheet: ref.sheet,
            addr: ref.addr.toUpperCase(),
            display: '',
            type: 'null' as const,
            isError: false,
            formula: '',
          },
      )
    },
    async snapshotFormatRange(range) {
      return {
        sheet: range.sheet,
        startRow: range.startRow,
        startCol: range.startCol,
        endRow: range.endRow,
        endCol: range.endCol,
        cellFormats: [],
        rangeFormats: [],
      }
    },
    async snapshotViewportSizes(range) {
      return { ...range, rowHeights: [], colWidths: [] }
    },
    async setCell(sheet, addr, value) {
      calls.setCell.push({ sheet, addr: addr.toUpperCase(), value })
      if (value.type === 'null') {
        cells.delete(key(sheet, addr))
      } else {
        cells.set(key(sheet, addr), {
          sheet,
          addr: addr.toUpperCase(),
          display:
            value.type === 'boolean' ? (value.value ? 'TRUE' : 'FALSE') : String(value.value),
          type: value.type,
          isError: value.type === 'error',
          formula: '',
        })
      }
      return true
    },
    async clearCell(sheet, addr) {
      cells.delete(key(sheet, addr))
      return true
    },
    async setFormulaDetailed() {
      return { ok: true as const }
    },
    // E5: `setFilterSort` now routes through the engine's `applyFilter`, which
    // runs the predicate ONCE and returns the FILTER-hidden rows (plus commits
    // them for SUBTOTAL — a real engine does; this double just returns the
    // answer). The scan is reproduced against the seeded cells with the SAME
    // shared helpers the engine's Rust port mirrors, so the double agrees with
    // the engine cell-for-cell, and the over-cap refusal rides in the resolved
    // value (`{ ok: false, code: 'source-too-large' }`), never a throw.
    async applyFilter(sheet, rules): Promise<FilterApplyResultWire> {
      calls.applyFilter.push({ sheet, rules: rules.map((rule) => ({ ...rule })) })
      let maxRow = -1
      for (const cell of cells.values()) {
        if (cell.sheet !== sheet) continue
        const coord = parseAddr(cell.addr)
        if (coord.row > maxRow) maxRow = coord.row
      }
      const rowCount = maxRow + 1
      const cols = new Set<number>([0])
      for (const rule of rules) cols.add(rule.colIndex)
      const predicateCells = rowCount * cols.size
      if (predicateCells > MAX_FILTER_SORT_PREDICATE_CELLS) {
        return {
          ok: false,
          code: 'source-too-large',
          message: `filter predicate scan needs ${predicateCells} cells; the filter was not applied`,
        }
      }
      const valueAt = (row: number, col: number): string =>
        cells.get(key(sheet, toAddr(row, col)))?.display ?? ''
      const displayRows =
        buildFilterSortDisplayRows(
          { rules },
          { headerRow: 0, startRow: 1, endRow: rowCount },
          valueAt,
        ) ?? []
      return {
        ok: true,
        hiddenRows: filterHiddenRowsFromDisplayRows(displayRows, rowCount),
        scannedRows: rowCount,
        predicateCells,
      }
    },
    async clearFilter(sheet): Promise<FilterApplyResultWire> {
      calls.clearFilter.push({ sheet })
      return { ok: true, hiddenRows: [], scannedRows: 0, predicateCells: 0 }
    },
    // The engine-set restore path used by structural undo/redo of a filtered
    // sheet (`setFilterSort` no longer pushes here — `applyFilter` writes the
    // set itself). Recorded so undo tests can assert the restore.
    async setEvalFilterHiddenRows(sheet, rows) {
      calls.setEvalFilterHiddenRows.push({ sheet, rows: [...rows] })
      if (evalFilterHiddenRows === 'unsupported') {
        // What a wasm-pkg predating the export makes the dispatcher answer
        // (design §6.5 tier 2).
        throw Object.assign(new Error('setEvalFilterHiddenRows is not available'), {
          code: 'UNSUPPORTED',
        })
      }
    },
    onCellsDirty(callback) {
      dirtyListeners.add(callback)
      return () => dirtyListeners.delete(callback)
    },
    onCellsHydrated() {
      return () => {}
    },
    dispose() {
      dirtyListeners.clear()
    },
  }

  const handler: ProxyHandler<Partial<WorkerWorkbookClient>> = {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof WorkerWorkbookClient]
      if (prop === 'calls' || prop === 'seedCell' || prop === 'emitDirty') return undefined
      if (prop === 'then') return undefined
      return () => unused(prop)
    },
  }

  const client = new Proxy(partial, handler) as FilterFakeClient
  return Object.assign(client, {
    calls,
    seedCell,
    emitDirty() {
      for (const listener of dirtyListeners) listener([])
    },
  })
}

function createFilterBackend(
  evalFilterHiddenRows: 'record' | 'unsupported' = 'record',
) {
  const client = createFilterFakeClient(evalFilterHiddenRows)
  const backend = createWorkerWorkbookSpreadsheetBackend({
    client,
    sheets: ['Sheet1'],
  })
  return { client, backend }
}

/** Header + three data rows; scores chosen so desc sort reorders every row. */
function seedPeople(client: FilterFakeClient) {
  client.seedCell(0, 0, 'Name')
  client.seedCell(0, 1, 'Score')
  client.seedCell(1, 0, 'Alpha')
  client.seedCell(1, 1, 1)
  client.seedCell(2, 0, 'Beta')
  client.seedCell(2, 1, 3)
  client.seedCell(3, 0, 'Alpha')
  client.seedCell(3, 1, 2)
}

let nextReadRequestId = 1

function readWindow(
  backend: ReturnType<typeof createFilterBackend>['backend'],
  rowEnd = 9,
): Promise<VisibleProjectionResult> {
  return backend.readVisibleProjection({
    kind: 'visible-window',
    sheetId: 'sheet-1',
    requestId: nextReadRequestId++,
    window: { rowStart: 0, rowEnd, colStart: 0, colEnd: 1 },
  })
}

function cellAt(result: VisibleProjectionResult, row: number, col: number) {
  return result.cells.find((cell) => cell.row === row && cell.col === col)
}

describe('worker adapter setFilterSort projection', () => {
  it('withholds filtered rows and leaves every other row at its own index', async () => {
    const { client, backend } = createFilterBackend()
    seedPeople(client)

    const ack = await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [{ kind: 'equals', colIndex: 0, value: 'Alpha' }],
      requestId: 7,
    })
    // The ACK carries the visibility answer back to UI core, which owns
    // rendering from here on.
    expect(ack).toMatchObject({ sheetId: 'sheet-1', requestId: 7, hiddenRowIndices: [2] })

    const result = await readWindow(backend)
    expect(cellAt(result, 0, 0)).toMatchObject({ displayValue: 'Name' })
    // Source row 3 stays at row 3. Under the retired compaction it would have
    // moved up into display row 2 — the whole point of the flip is that it
    // does not, so the row header can keep reading 1, 2, 4.
    expect(cellAt(result, 1, 0)).toMatchObject({ displayValue: 'Alpha' })
    expect(cellAt(result, 1, 1)).toMatchObject({ displayValue: '1' })
    expect(cellAt(result, 3, 0)).toMatchObject({ displayValue: 'Alpha' })
    expect(cellAt(result, 3, 1)).toMatchObject({ displayValue: '2' })
    // Row 2 is filtered away: withheld entirely, not blanked. "In range yet
    // contributing no cell" is the property visible-cell consumers rely on.
    expect(result.cells.some((cell) => cell.row === 2)).toBe(false)
    expect(result.cells.some((cell) => cell.displayValue === 'Beta')).toBe(false)
  })

  // E5 — the engine's `applyFilter` commits the FILTER-hidden set itself (the
  // separate host push is retired). Without it `SUBTOTAL(1-11)` keeps summing
  // Beta; the adapter forwards the rules and reflects the returned rows.
  it('routes the rules to the engine applyFilter and reflects the returned hidden rows', async () => {
    const { client, backend } = createFilterBackend()
    seedPeople(client)

    const ack = await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [{ kind: 'equals', colIndex: 0, value: 'Alpha' }],
      requestId: 7,
    })

    // The rules are forwarded verbatim to the engine — no separate eval-input
    // push (`applyFilter` writes the engine set), and the ACK carries the
    // SOURCE rows the engine hid: Beta at source row 2.
    expect(client.calls.applyFilter).toEqual([
      { sheet: 0, rules: [{ kind: 'equals', colIndex: 0, value: 'Alpha' }] },
    ])
    expect(client.calls.setEvalFilterHiddenRows).toEqual([])
    expect(ack.hiddenRowIndices).toEqual([2])

    // The mirror is the engine's answer, so the projection withholds exactly the
    // complement of what it shows.
    const result = await readWindow(backend)
    const visibleSourceRows = new Set(result.cells.map((cell) => cell.row))
    expect(visibleSourceRows.has(2)).toBe(false)
    expect([...visibleSourceRows].sort()).toEqual([0, 1, 3])

    // Clearing the rules drops the engine's filter through `clearFilter`
    // (scan-free), so a stale set cannot keep excluding rows that are visible
    // again.
    await backend.setFilterSort!({ kind: 'set-filter-sort', sheetId: 'sheet-1', rules: [] })
    expect(client.calls.clearFilter).toEqual([{ sheet: 0 }])
    expect(client.calls.applyFilter).toHaveLength(1)
  })

  it('never reorders rows and never touches engine data (sort branch retired)', async () => {
    const { client, backend } = createFilterBackend()
    seedPeople(client)

    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [{ kind: 'equals', colIndex: 0, value: 'Alpha' }],
    })

    // Row ORDER is always source order — `setFilterSort` carries no sort
    // payload any more (#24 retired the display permutation for sort).
    const result = await readWindow(backend)
    expect(cellAt(result, 1, 1)).toMatchObject({ displayValue: '1' })
    expect(cellAt(result, 3, 1)).toMatchObject({ displayValue: '2' })
    // Visibility only: no engine writes of any kind happened.
    expect(client.calls.setCell).toHaveLength(0)

    // Clearing brings the withheld row back through `clearFilter`, which never
    // runs the predicate scan (`applyFilter`), so it cannot be blocked by the cap.
    const applies = client.calls.applyFilter.length
    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [],
    })
    expect(client.calls.applyFilter).toHaveLength(applies)
    expect(client.calls.clearFilter).toEqual([{ sheet: 0 }])
    const cleared = await readWindow(backend)
    expect(cellAt(cleared, 2, 1)).toMatchObject({ displayValue: '3' })
  })

  it('rejects an over-cap source with a structured error and stays unfiltered', async () => {
    const { client, backend } = createFilterBackend()
    seedPeople(client)
    // One predicate column (col 0) → the row budget is the cap itself;
    // a cell one row past it pushes the scan over budget.
    client.seedCell(MAX_FILTER_SORT_PREDICATE_CELLS, 0, 'Far')

    await expect(
      backend.setFilterSort!({
        kind: 'set-filter-sort',
        sheetId: 'sheet-1',
        rules: [{ kind: 'equals', colIndex: 0, value: 'Alpha' }],
      }),
    ).rejects.toMatchObject({ code: FILTER_SORT_SOURCE_TOO_LARGE })

    // The filter never activated: every row still projects at its own index.
    const result = await readWindow(backend)
    expect(cellAt(result, 2, 0)).toMatchObject({ displayValue: 'Beta' })
    expect(result.cells.some((cell) => cell.row === 2)).toBe(true)
  })

  // Visibility is a SNAPSHOT taken when the rules are applied, matching Excel:
  // `Data → Reapply` (Ctrl+Alt+L) exists precisely because editing a cell does
  // NOT move its row in or out of a filtered view. The predecessor of this test
  // pinned the opposite — every mutation dropped the cached permutation and the
  // next read re-evaluated the rules — which made our filter live and Excel's
  // not. That behaviour is what the flip retires, so this asserts its absence.
  it('takes visibility as a snapshot: edits never re-evaluate the rules', async () => {
    const { client, backend } = createFilterBackend()
    seedPeople(client)

    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [{ kind: 'equals', colIndex: 0, value: 'Alpha' }],
    })
    expect(client.calls.applyFilter).toHaveLength(1)

    // Projection reads never re-run the predicate: the answer was computed once,
    // above, inside the engine's single `applyFilter`.
    await readWindow(backend)
    await readWindow(backend)
    expect(client.calls.applyFilter).toHaveLength(1)

    // Beta now matches the rule, but the snapshot is not consulted again, so
    // row 2 stays withheld until the rules are re-applied.
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 2,
      col: 0,
      input: 'Alpha',
    })
    const afterEdit = await readWindow(backend)
    expect(client.calls.applyFilter).toHaveLength(1)
    expect(afterEdit.cells.some((cell) => cell.row === 2)).toBe(false)
    expect(cellAt(afterEdit, 3, 0)).toMatchObject({ displayValue: 'Alpha' })

    // Nor does a worker-initiated cellsDirty push (async formula settle).
    client.emitDirty()
    await readWindow(backend)
    expect(client.calls.applyFilter).toHaveLength(1)

    // Re-applying the same rules is the explicit recompute path, and it does
    // re-run `applyFilter` — so the row can always be brought back.
    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [{ kind: 'equals', colIndex: 0, value: 'Alpha' }],
    })
    expect(client.calls.applyFilter).toHaveLength(2)
    const afterReapply = await readWindow(backend)
    expect(cellAt(afterReapply, 2, 0)).toMatchObject({ displayValue: 'Alpha' })
  })
})

const VIEWPORT = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 4,
  viewportWidth: 4,
  rowHeight: 1,
  colWidth: 1,
  rowCount: 10,
  colCount: 10,
  overscanRows: 0,
  overscanCols: 0,
}

async function waitForGrid(container: HTMLElement, cellCount = 16) {
  await waitFor(() => {
    expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(cellCount)
  })
}

function gridCellText(container: HTMLElement, addr: string): string {
  return (
    container.querySelector(`[data-cell-addr="${addr}"] .spreadsheet-grid-cell-button`)
      ?.textContent ?? ''
  )
}

describe('worker path filter/sort UI integration', () => {
  // The W2 gateway's display->source remap used to be load bearing here: an
  // edit on a compacted display row had to be translated back before it reached
  // the engine. Identity mapping removes the translation, so what this pins now
  // is that the edit lands on the row the user is looking at — the property the
  // remap existed to preserve, asserted directly instead of through it.
  it('an edit under an active filter writes the row the user sees', async () => {
    const { client, backend } = createFilterBackend()
    seedPeople(client)
    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [{ kind: 'equals', colIndex: 0, value: 'Alpha' }],
    })

    const store = createStore()
    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))
    await waitForGrid(container)
    // Row 2 (Beta) is filtered away, so row 4 renders directly under row 2 and
    // the header skips — but the surviving row is still addressed as A4/B4.
    await waitFor(() => {
      expect(gridCellText(container, 'B4')).toBe('2')
    })

    fireEvent.click(container.querySelector('[data-cell-addr="B4"] .spreadsheet-grid-cell-button')!)
    fireEvent.dblClick(container.querySelector('[data-cell-addr="B4"]')!)
    const editor = (await waitFor(() => {
      const input = container.querySelector('input.cell-input')
      expect(input).not.toBeNull()
      return input
    })) as HTMLInputElement
    fireEvent.input(editor, { target: { value: '99' } })
    fireEvent.keyDown(editor, { key: 'Enter' })

    await waitFor(() => {
      expect(client.calls.setCell).toHaveLength(1)
    })
    // B4 on screen is B4 in the engine. No coordinate translation involved.
    expect(client.calls.setCell[0]).toMatchObject({
      sheet: 0,
      addr: 'B4',
      value: { type: 'number', value: 99 },
    })
  })

  it('filter dropdown applies rules against the worker backend and hides rows', async () => {
    const { client, backend } = createFilterBackend()
    seedPeople(client)
    const store = createStore()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
        <SpreadsheetFilterDropdown />
      </SpreadsheetUiProvider>
    ))
    await waitForGrid(container)
    await waitFor(() => {
      expect(gridCellText(container, 'A3')).toBe('Beta')
    })

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 0 })
    await waitFor(() => {
      expect(store.getter(filterSortLifecycleAtom).status).toBe('editing')
    })

    const conditionKind = container.querySelector(
      '[data-testid="filter-condition-kind"]',
    ) as HTMLSelectElement
    fireEvent.change(conditionKind, { target: { value: 'equals' } })
    const equalsInput = (await waitFor(() => {
      const input = container.querySelector('[data-testid="filter-equals-input"]')
      expect(input).not.toBeNull()
      return input
    })) as HTMLInputElement
    fireEvent.input(equalsInput, { target: { value: 'Alpha' } })
    fireEvent.click(container.querySelector('[data-testid="filter-add-equals"]')!)

    // Committed ui-core canonical state and the refreshed worker projection.
    await waitFor(() => {
      expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([
        { kind: 'equals', colIndex: 0, value: 'Alpha' },
      ])
      expect(store.getter(filterSortLifecycleAtom).status).toBe('editing')
    })
    await waitFor(() => {
      // Beta's row is hidden rather than compacted away: row 3 is gone from the
      // DOM entirely and row 4 keeps both its data and its number.
      expect(container.querySelector('[data-cell-addr="A3"]')).toBeNull()
      expect(gridCellText(container, 'A4')).toBe('Alpha')
      expect(gridCellText(container, 'B4')).toBe('2')
    })

    // Clearing the filter brings the row back at its own index.
    fireEvent.click(container.querySelector('[data-testid="filter-clear-filter"]')!)
    await waitFor(() => {
      expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([])
      expect(gridCellText(container, 'A3')).toBe('Beta')
      expect(gridCellText(container, 'A4')).toBe('Alpha')
    })
  })
})
