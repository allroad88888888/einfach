/** @jsxImportSource solid-js */

/**
 * #27 — `Ctrl+Alt+L` (Excel's `Data → Reapply`) at the host wiring layer.
 *
 * The shortcut fires globally, so the interesting cases are the ones where it
 * must do NOTHING: no filter on the sheet, and no `setFilterSort` port. Unlike
 * Ctrl+Alt+V this opens no dialog, so the gate lives entirely in
 * `reapplyFilterAtom` / `reapplyFilterDisabledReasonAtom` and the grid just
 * dispatches — these tests pin that the gate actually holds through the real
 * component, not only through a direct atom call.
 */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  DisplayCell,
  SetFilterSortRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  getFilterHiddenRowsForSheet,
  setFilterSortAtom,
  setWorkspaceActiveSheetAtom,
  viewportFilterHiddenAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

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

function buildCells(window: VisibleProjectionRequest['window']): DisplayCell[] {
  const cells: DisplayCell[] = []
  for (let row = window.rowStart; row <= window.rowEnd; row += 1) {
    for (let col = window.colStart; col <= window.colEnd; col += 1) {
      cells.push({ row, col, displayValue: `${row},${col}` })
    }
  }
  return cells
}

function createBackend(opts: {
  withFilterSort: boolean
  requests?: SetFilterSortRequest[]
}): SpreadsheetBackend {
  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request) {
      const result: VisibleProjectionResult = {
        kind: 'visible-window',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision,
        cells: buildCells(request.window),
      }
      return result
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
  }
  if (opts.withFilterSort) {
    backend.setFilterSort = async (request) => {
      opts.requests?.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 3,
        hiddenRowIndices: [2, 5],
      }
    }
  }
  return backend
}

const RULES = [{ kind: 'equals' as const, colIndex: 0, value: 'Alpha' }]

async function mountGrid(store: ReturnType<typeof createStore>, backend: SpreadsheetBackend) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  const { container } = render(() => (
    <SpreadsheetUiProvider backend={backend} store={store}>
      <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
    </SpreadsheetUiProvider>
  ))
  await waitFor(() => {
    expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
  })
  return container
}

function pressReapply(container: HTMLElement, overrides: Record<string, unknown> = {}) {
  fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, {
    key: 'l',
    ctrlKey: true,
    altKey: true,
    ...overrides,
  })
}

describe('Ctrl+Alt+L (Data -> Reapply) grid wiring', () => {
  it('re-sends the committed rules and re-commits the fresh hidden set', async () => {
    const store = createStore()
    const requests: SetFilterSortRequest[] = []
    const backend = createBackend({ withFilterSort: true, requests })
    const container = await mountGrid(store, backend)
    store.setter(setFilterSortAtom, { sheetId: 'sheet-1', state: { rules: RULES } })

    pressReapply(container)

    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toMatchObject({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: RULES,
    })
    await waitFor(() =>
      expect(getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), 'sheet-1')).toEqual(
        [2, 5],
      ),
    )
  })

  it('COUNTER-EXAMPLE: is a silent no-op with no active filter', async () => {
    const store = createStore()
    const requests: SetFilterSortRequest[] = []
    const backend = createBackend({ withFilterSort: true, requests })
    const container = await mountGrid(store, backend)
    // No rules committed — nothing to re-run.

    pressReapply(container)
    await Promise.resolve()

    expect(requests).toHaveLength(0)
    expect(getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), 'sheet-1')).toEqual(
      [],
    )
  })

  it('is a no-op when the backend exposes no setFilterSort port', async () => {
    const store = createStore()
    const backend = createBackend({ withFilterSort: false })
    const container = await mountGrid(store, backend)
    store.setter(setFilterSortAtom, { sheetId: 'sheet-1', state: { rules: RULES } })

    pressReapply(container)
    await Promise.resolve()

    expect(getFilterHiddenRowsForSheet(store.getter(viewportFilterHiddenAtom), 'sheet-1')).toEqual(
      [],
    )
  })

  it('does not claim bare Ctrl+L or Ctrl+Shift+Alt+L', async () => {
    const store = createStore()
    const requests: SetFilterSortRequest[] = []
    const backend = createBackend({ withFilterSort: true, requests })
    const container = await mountGrid(store, backend)
    store.setter(setFilterSortAtom, { sheetId: 'sheet-1', state: { rules: RULES } })

    pressReapply(container, { altKey: false })
    pressReapply(container, { shiftKey: true })
    await Promise.resolve()

    // Excel binds Ctrl+L to Create Table and Ctrl+Shift+L to the filter
    // toggle; neither is ours to swallow.
    expect(requests).toHaveLength(0)

    pressReapply(container)
    await waitFor(() => expect(requests).toHaveLength(1))
  })
})
