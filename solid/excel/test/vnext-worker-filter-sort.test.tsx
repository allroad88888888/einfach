/** @jsxImportSource solid-js */

/**
 * Parity item #29 — filter/sort visibility on the WORKER path.
 *
 * The adapter mirrors the ui-core canonical rules after `setFilterSort`
 * ACKs and computes the display permutation at projection time with the
 * shared pure helper (`buildFilterSortDisplayRows`), reading predicate
 * values over existing RPCs inside a declared cap. These tests pin:
 *  - display compaction + `originalRow` on the projection,
 *  - sort as a display permutation (engine data untouched),
 *  - the structured over-cap rejection (fail-closed, no truncation),
 *  - cache reuse and invalidation on mutations / cellsDirty pushes,
 *  - the W2 mutation-gateway round trip (edit a display row → the
 *    engine write lands on the source row),
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
  SparseRangeWire,
  WorkerWorkbookClient,
} from '../src-vnext/adapter'
import {
  FILTER_SORT_SOURCE_TOO_LARGE,
  MAX_FILTER_SORT_PREDICATE_CELLS,
  createWorkerWorkbookSpreadsheetBackend,
} from '../src-vnext/adapter'
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
function createFilterFakeClient(): FilterFakeClient {
  const cells = new Map<string, CellSnapshotWire>()
  const dirtyListeners = new Set<(refs: CellRefWire[]) => void>()
  const calls: FilterFakeClient['calls'] = {
    listNonEmpty: 0,
    readSparseRange: [],
    readCells: [],
    setCell: [],
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

function createFilterBackend() {
  const client = createFilterFakeClient()
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
  it('compacts filtered rows into display rows carrying originalRow', async () => {
    const { client, backend } = createFilterBackend()
    seedPeople(client)

    const ack = await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [{ kind: 'equals', colIndex: 0, value: 'Alpha' }],
      requestId: 7,
    })
    expect(ack).toMatchObject({ sheetId: 'sheet-1', requestId: 7 })

    const result = await readWindow(backend)
    // Header row passes through.
    expect(cellAt(result, 0, 0)).toMatchObject({ displayValue: 'Name', originalRow: 0 })
    // Source row 1 stays at display row 1; source row 3 compacts to display row 2.
    expect(cellAt(result, 1, 0)).toMatchObject({ displayValue: 'Alpha', originalRow: 1 })
    expect(cellAt(result, 1, 1)).toMatchObject({ displayValue: '1', originalRow: 1 })
    expect(cellAt(result, 2, 0)).toMatchObject({ displayValue: 'Alpha', originalRow: 3 })
    expect(cellAt(result, 2, 1)).toMatchObject({ displayValue: '2', originalRow: 3 })
    // The Beta row is filtered out and nothing renders past the data.
    expect(result.cells.some((cell) => cell.displayValue === 'Beta')).toBe(false)
    expect(result.cells.some((cell) => cell.row >= 3)).toBe(false)
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
    expect(cellAt(result, 1, 1)).toMatchObject({ displayValue: '1', originalRow: 1 })
    expect(cellAt(result, 2, 1)).toMatchObject({ displayValue: '2', originalRow: 3 })
    // Visibility-only permutation: no engine writes of any kind happened.
    expect(client.calls.setCell).toHaveLength(0)

    // Clearing restores the identity projection with no originalRow facts.
    const scans = client.calls.listNonEmpty
    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [],
    })
    // Clearing never runs the predicate scan, so it cannot be blocked by the cap.
    expect(client.calls.listNonEmpty).toBe(scans)
    const cleared = await readWindow(backend)
    expect(cellAt(cleared, 2, 1)).toMatchObject({ displayValue: '3' })
    expect(cleared.cells.every((cell) => cell.originalRow === undefined)).toBe(true)
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

    // The filter never activated: identity projection, no originalRow.
    const result = await readWindow(backend)
    expect(cellAt(result, 2, 0)).toMatchObject({ displayValue: 'Beta' })
    expect(result.cells.every((cell) => cell.originalRow === undefined)).toBe(true)
  })

  it('caches the permutation and recomputes after mutations and cellsDirty pushes', async () => {
    const { client, backend } = createFilterBackend()
    seedPeople(client)

    await backend.setFilterSort!({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [{ kind: 'equals', colIndex: 0, value: 'Alpha' }],
    })
    expect(client.calls.listNonEmpty).toBe(1)

    // Cached: repeated projection reads do not rescan.
    await readWindow(backend)
    await readWindow(backend)
    expect(client.calls.listNonEmpty).toBe(1)

    // A host mutation invalidates: Beta becomes Alpha and joins the view.
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 2,
      col: 0,
      input: 'Alpha',
    })
    const afterEdit = await readWindow(backend)
    expect(client.calls.listNonEmpty).toBe(2)
    expect(cellAt(afterEdit, 2, 0)).toMatchObject({ displayValue: 'Alpha', originalRow: 2 })
    expect(cellAt(afterEdit, 3, 0)).toMatchObject({ displayValue: 'Alpha', originalRow: 3 })

    // A worker-initiated cellsDirty push (async formula settle) also invalidates.
    client.emitDirty()
    await readWindow(backend)
    expect(client.calls.listNonEmpty).toBe(3)
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
  it('W2 gateway: editing a display row under an active filter writes the source row', async () => {
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
    // Display row 2 (addr row 3) shows source row 3.
    await waitFor(() => {
      expect(gridCellText(container, 'B3')).toBe('2')
    })

    fireEvent.click(container.querySelector('[data-cell-addr="B3"] .spreadsheet-grid-cell-button')!)
    fireEvent.dblClick(container.querySelector('[data-cell-addr="B3"]')!)
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
    // Display row 2 → source row 3 → engine address B4, not B3.
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
      // Beta is hidden; source row 3 compacts up into display row 2 (addr row 3).
      expect(gridCellText(container, 'A3')).toBe('Alpha')
      expect(gridCellText(container, 'B3')).toBe('2')
      expect(gridCellText(container, 'A4')).toBe('')
    })

    // Sorting from the dropdown reorders the visible rows through the same lane.
    fireEvent.click(container.querySelector('[data-testid="filter-clear-filter"]')!)
    await waitFor(() => {
      expect(store.getter(filterSortStateAtom)['sheet-1']?.rules).toEqual([])
      expect(gridCellText(container, 'A3')).toBe('Beta')
    })
  })
})
