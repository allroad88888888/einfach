/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { render, cleanup, fireEvent, waitFor } from '@solidjs/testing-library'
import type {
  ClearRangeRequest,
  DisplayCell,
  FillRangeRequest,
  FillSeriesRequest,
  SetCellInputRequest,
  SpreadsheetBackend,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import { clipboardStateAtom, setSheetProtectionAtom } from '@einfach/spreadsheet-ui-core'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

function flushMicrotasks() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

function dispatchPointerEvent(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  coordinates: { clientX?: number; clientY?: number },
) {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: coordinates.clientX ?? 0,
      clientY: coordinates.clientY ?? 0,
    }),
  )
}

function createGatewayBackend() {
  const setCellInputRequests: SetCellInputRequest[] = []
  const clearRangeRequests: ClearRangeRequest[] = []
  const fillRangeRequests: FillRangeRequest[] = []
  const fillSeriesRequests: FillSeriesRequest[] = []

  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request) {
      const cells: DisplayCell[] = []
      const result: VisibleProjectionResult = {
        kind: 'visible-window',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision,
        cells,
      }
      return result
    },
    async readRangeProjection(request) {
      return {
        kind: 'range',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 21,
        range: { ...request.range },
        cells: [] as DisplayCell[],
      }
    },
    async setCellInput(request) {
      setCellInputRequests.push(request)
      return { sheetId: request.sheetId, requestId: request.requestId, revision: 22 }
    },
    async clearRange(request) {
      clearRangeRequests.push(request)
      return { sheetId: request.sheetId, requestId: request.requestId, revision: 23 }
    },
    async fillRange(request) {
      fillRangeRequests.push(request)
      return { sheetId: request.sheetId, affectedRange: request.targetRange }
    },
    async fillSeries(request) {
      fillSeriesRequests.push(request)
      return { sheetId: request.sheetId, requestId: request.requestId, revision: 24 }
    },
  }

  return {
    backend,
    setCellInputRequests,
    clearRangeRequests,
    fillRangeRequests,
    fillSeriesRequests,
  }
}

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

function renderGrid(backend: SpreadsheetBackend, store: ReturnType<typeof createStore>) {
  return render(() => (
    <SpreadsheetUiProvider backend={backend} store={store}>
      <SpreadsheetGrid sheetId="sheet-1" viewport={VIEWPORT} data-testid="grid" />
    </SpreadsheetUiProvider>
  ))
}

async function waitForGrid(container: HTMLElement, cellCount = 16) {
  await waitFor(() => {
    expect(container.querySelectorAll('td.spreadsheet-grid-cell')).toHaveLength(cellCount)
  })
}

describe('vNext mutation gateway — grid paths', () => {
  it('Delete on a protected sheet is blocked with zero transport', async () => {
    const store = createStore()
    const { backend, clearRangeRequests, setCellInputRequests } = createGatewayBackend()
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: [] },
    })

    const { container } = renderGrid(backend, store)
    await waitForGrid(container)

    fireEvent.click(container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!)
    fireEvent.click(container.querySelector('[data-cell-addr="B2"] .spreadsheet-grid-cell-button')!, {
      shiftKey: true,
    })
    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, { key: 'Delete' })

    await flushMicrotasks()
    expect(clearRangeRequests).toHaveLength(0)
    expect(setCellInputRequests).toHaveLength(0)
  })

  it('paste on a protected sheet is blocked with zero transport and a clipboard error', async () => {
    const store = createStore()
    const { backend, setCellInputRequests } = createGatewayBackend()
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: { mode: 'protected', unlockedRanges: [] },
    })

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: jest.fn<() => Promise<string>>().mockResolvedValue('pasted'),
      },
    })

    const { container } = renderGrid(backend, store)
    await waitForGrid(container)

    fireEvent.click(container.querySelector('[data-cell-addr="B2"] .spreadsheet-grid-cell-button')!)
    fireEvent.keyDown(container.querySelector('[data-testid="grid"]')!, { key: 'v', ctrlKey: true })

    await waitFor(() => {
      expect(store.getter(clipboardStateAtom).status).toBe('error')
    })
    expect(setCellInputRequests).toHaveLength(0)
    expect(store.getter(clipboardStateAtom).error).toMatchObject({
      code: 'MUTATION_BLOCKED_LOCKED',
    })
  })

  it('fill onto locked cells is blocked with zero transport', async () => {
    const store = createStore()
    const {
      backend,
      setCellInputRequests,
      fillRangeRequests,
      fillSeriesRequests,
    } = createGatewayBackend()
    // Only the source cell A1 is unlocked; the fill targets stay locked.
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: {
        mode: 'protected',
        unlockedRanges: [{ rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }],
      },
    })

    const { container, getByTestId } = renderGrid(backend, store)
    await waitForGrid(container)

    fireEvent.click(container.querySelector('[data-cell-addr="A1"] .spreadsheet-grid-cell-button')!)

    const targetCell = container.querySelector('[data-cell-addr="A3"]') as HTMLElement
    const originalElementFromPoint = document.elementFromPoint
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => targetCell,
    })

    try {
      dispatchPointerEvent(getByTestId('fill-handle-A1'), 'pointerdown', { clientX: 1, clientY: 1 })
      dispatchPointerEvent(window, 'pointermove', { clientX: 1, clientY: 3 })
      dispatchPointerEvent(window, 'pointerup', { clientX: 1, clientY: 3 })
      await flushMicrotasks()
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      })
    }

    expect(setCellInputRequests).toHaveLength(0)
    expect(fillRangeRequests).toHaveLength(0)
    expect(fillSeriesRequests).toHaveLength(0)
  })
})
