/** @jsxImportSource solid-js */

import { createStore } from '@einfach/core'
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  DisplayCell,
  SpreadsheetBackend,
  VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import {
  addOutlineGroupAtom,
  getOutlineGroupsForSheet,
  outlineAtom,
  selectRowsAtom,
  selectColumnsAtom,
  viewportHiddenAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetMenuBar } from '../src-vnext/menu-bar'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { setLocale } from '../src/i18n'

beforeEach(() => {
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  setLocale('en')
})

afterEach(() => {
  cleanup()
  jest.restoreAllMocks()
})

const VIEWPORT = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 10,
  viewportWidth: 8,
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

function createBackend(): SpreadsheetBackend {
  return {
    async readVisibleProjection(request) {
      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision,
        cells: buildCells(request.window),
      }
    },
    async readRangeProjection(request) {
      return {
        kind: 'range',
        sheetId: request.sheetId,
        range: { ...request.range },
        requestId: request.requestId,
        revision: request.revision,
        cells: [],
      }
    },
    async setCellInput(request) {
      return { sheetId: request.sheetId, requestId: request.requestId, revision: 1 }
    },
  }
}

function renderGrid(store: ReturnType<typeof createStore>, backend = createBackend()) {
  return render(() => (
    <SpreadsheetUiProvider backend={backend} store={store}>
      <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
    </SpreadsheetUiProvider>
  ))
}

describe('SpreadsheetGrid outline gutter', () => {
  it('renders no gutter chrome for sheets without groups', async () => {
    const store = createStore()
    const { container } = renderGrid(store)
    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-row-header[data-row="1"]')).not.toBeNull()
    })
    expect(container.querySelector('[data-testid="outline-row-levels"]')).toBeNull()
    expect(container.querySelector('.spreadsheet-grid-outline-row-cell')).toBeNull()
    expect(container.querySelector('[data-testid="outline-col-band"]')).toBeNull()
  })

  it('shows the row gutter with a toggle and level buttons once rows are grouped', async () => {
    const store = createStore()
    const { container } = renderGrid(store)
    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-row-header[data-row="4"]')).not.toBeNull()
    })

    store.setter(addOutlineGroupAtom, { sheetId: 'sheet-1', axis: 'row', start: 1, end: 3 })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="outline-row-levels"]')).not.toBeNull()
    })
    // Toggle renders on the summary row right after the group.
    const toggle = container.querySelector('[data-testid="outline-row-toggle-1-3"]')
    expect(toggle).not.toBeNull()
    expect(toggle!.closest('[data-outline-row="4"]')).not.toBeNull()
    expect(toggle!.getAttribute('data-collapsed')).toBe('false')
    // Level buttons 1..maxLevel+1.
    expect(container.querySelector('[data-testid="outline-row-level-1"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="outline-row-level-2"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="outline-row-level-3"]')).toBeNull()
  })

  it('collapse toggle hides the grouped rows and expand restores them', async () => {
    const store = createStore()
    const { container } = renderGrid(store)
    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-row-header[data-row="4"]')).not.toBeNull()
    })
    store.setter(addOutlineGroupAtom, { sheetId: 'sheet-1', axis: 'row', start: 1, end: 3 })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="outline-row-toggle-1-3"]')).not.toBeNull()
    })

    fireEvent.click(container.querySelector('[data-testid="outline-row-toggle-1-3"]')!)
    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-row-header[data-row="1"]')).toBeNull()
    })
    expect(container.querySelector('.spreadsheet-grid-row-header[data-row="3"]')).toBeNull()
    expect(container.querySelector('.spreadsheet-grid-row-header[data-row="4"]')).not.toBeNull()
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([1, 2, 3])
    const collapsedToggle = container.querySelector('[data-testid="outline-row-toggle-1-3"]')
    expect(collapsedToggle!.getAttribute('data-collapsed')).toBe('true')

    fireEvent.click(collapsedToggle!)
    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-row-header[data-row="1"]')).not.toBeNull()
    })
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([])
  })

  it('level buttons collapse and expand via collapse-to-level semantics', async () => {
    const store = createStore()
    const { container } = renderGrid(store)
    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-row-header[data-row="4"]')).not.toBeNull()
    })
    store.setter(addOutlineGroupAtom, { sheetId: 'sheet-1', axis: 'row', start: 1, end: 3 })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="outline-row-level-1"]')).not.toBeNull()
    })

    fireEvent.click(container.querySelector('[data-testid="outline-row-level-1"]')!)
    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-row-header[data-row="1"]')).toBeNull()
    })
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([1, 2, 3])

    fireEvent.click(container.querySelector('[data-testid="outline-row-level-2"]')!)
    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-row-header[data-row="1"]')).not.toBeNull()
    })
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([])
  })

  it('renders the column outline band with toggles for column groups', async () => {
    const store = createStore()
    const { container } = renderGrid(store)
    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-col-header[data-col="4"]')).not.toBeNull()
    })
    store.setter(addOutlineGroupAtom, { sheetId: 'sheet-1', axis: 'column', start: 1, end: 2 })
    await waitFor(() => {
      expect(container.querySelector('[data-testid="outline-col-band"]')).not.toBeNull()
    })
    const toggle = container.querySelector('[data-testid="outline-col-toggle-1-2"]')
    expect(toggle).not.toBeNull()
    expect(toggle!.closest('[data-outline-col="3"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="outline-col-levels"]')).not.toBeNull()

    fireEvent.click(toggle!)
    await waitFor(() => {
      expect(container.querySelector('.spreadsheet-grid-col-header[data-col="1"]')).toBeNull()
    })
    expect(store.getter(viewportHiddenAtom).colsBySheet['sheet-1']).toEqual([1, 2])
  })
})

describe('SpreadsheetMenuBar outline entries', () => {
  function renderMenuBar(store: ReturnType<typeof createStore>) {
    return render(() => (
      <SpreadsheetUiProvider backend={createBackend()} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))
  }

  async function openDataMenu(container: HTMLElement) {
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    await waitFor(() => {
      expect(container.querySelector('[data-testid="menu-bar-item-data.groupRows"]')).not.toBeNull()
    })
  }

  it('lists the localized group and ungroup entries in the Data menu', async () => {
    const store = createStore()
    const { container } = renderMenuBar(store)
    await openDataMenu(container)
    expect(
      container.querySelector('[data-testid="menu-bar-item-data.groupRows"]')!.textContent,
    ).toContain('Group Rows')
    expect(
      container.querySelector('[data-testid="menu-bar-item-data.ungroupRows"]')!.textContent,
    ).toContain('Ungroup Rows')
    expect(
      container.querySelector('[data-testid="menu-bar-item-data.groupCols"]')!.textContent,
    ).toContain('Group Columns')
    expect(
      container.querySelector('[data-testid="menu-bar-item-data.ungroupCols"]')!.textContent,
    ).toContain('Ungroup Columns')
  })

  it('Group Rows groups the selected rows and Ungroup Rows removes them again', async () => {
    const store = createStore()
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 1, rowFocus: 3 })
    const { container } = renderMenuBar(store)

    await openDataMenu(container)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.groupRows"]')!)
    expect(getOutlineGroupsForSheet(store.getter(outlineAtom), 'sheet-1', 'row')).toEqual([
      { start: 1, end: 3, collapsed: false },
    ])

    await openDataMenu(container)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.ungroupRows"]')!)
    expect(getOutlineGroupsForSheet(store.getter(outlineAtom), 'sheet-1', 'row')).toEqual([])
  })

  it('Group Columns groups the selected columns', async () => {
    const store = createStore()
    store.setter(selectColumnsAtom, { sheetId: 'sheet-1', colAnchor: 2, colFocus: 4 })
    const { container } = renderMenuBar(store)

    await openDataMenu(container)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.groupCols"]')!)
    expect(getOutlineGroupsForSheet(store.getter(outlineAtom), 'sheet-1', 'column')).toEqual([
      { start: 2, end: 4, collapsed: false },
    ])
  })
})
