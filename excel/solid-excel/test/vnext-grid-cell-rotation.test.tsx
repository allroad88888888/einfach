/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  DisplayCell,
  SpreadsheetBackend,
  VisibleProjectionRequest,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetGrid } from '../src-vnext/grid'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

const viewport = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 2,
  viewportWidth: 4,
  rowHeight: 1,
  colWidth: 1,
  rowCount: 2,
  colCount: 4,
  overscanRows: 0,
  overscanCols: 0,
}

function createProjectionBackend(initialCells: DisplayCell[]) {
  let cells = initialCells
  const contentChangeHandlers = new Set<() => void>()

  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request: VisibleProjectionRequest) {
      return {
        kind: 'visible-window',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision,
        cells,
      }
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
    subscribeContentChanges(handler) {
      contentChangeHandlers.add(handler)
      return () => contentChangeHandlers.delete(handler)
    },
  }

  return {
    backend,
    publish(nextCells: DisplayCell[]) {
      cells = nextCells
      for (const handler of contentChangeHandlers) handler()
    },
  }
}

function renderGrid(backend: SpreadsheetBackend) {
  const store = createStore()
  // Rotation is a DOM-cell concern. Keep the overlay on its SVG path so the
  // jsdom integration does not depend on a canvas implementation.
  window.history.replaceState(null, '', '/?svgOverlay=1')
  return render(() => (
    <SpreadsheetUiProvider backend={backend} store={store}>
      <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
    </SpreadsheetUiProvider>
  ))
}

function getCell(container: HTMLElement, address: string): HTMLElement {
  const cell = container.querySelector(`[data-cell-addr="${address}"]`)
  if (!(cell instanceof HTMLElement)) throw new Error(`missing cell ${address}`)
  return cell
}

function getDisplay(container: HTMLElement, address: string): HTMLElement {
  const display = getCell(container, address).querySelector('.cell-display')
  if (!(display instanceof HTMLElement)) throw new Error(`missing display for ${address}`)
  return display
}

describe('vNext grid canonical cell rotation projection', () => {
  it('maps defaults, both numeric bounds, and vertical text from DisplayCell.format', async () => {
    const { backend } = createProjectionBackend([
      { row: 0, col: 0, displayValue: 'default' },
      { row: 0, col: 1, displayValue: 'zero', format: { rotation: 0 } },
      { row: 0, col: 2, displayValue: 'positive', format: { rotation: 45 } },
      { row: 0, col: 3, displayValue: 'vertical', format: { rotation: 'vertical' } },
      { row: 1, col: 0, displayValue: 'negative', format: { rotation: -45 } },
      { row: 1, col: 1, displayValue: 'upper bound', format: { rotation: 90 } },
      { row: 1, col: 2, displayValue: 'lower bound', format: { rotation: -90 } },
    ])
    const { container } = renderGrid(backend)

    await waitFor(() => {
      expect(getDisplay(container, 'C2').textContent).toBe('lower bound')
    })

    for (const address of ['A1', 'B1']) {
      const display = getDisplay(container, address)
      expect(display.style.transform).toBe('')
      expect(display.style.transformOrigin).toBe('')
      expect(display.style.writingMode).toBe('')
    }

    for (const [address, degrees] of [
      ['C1', 45],
      ['A2', -45],
      ['B2', 90],
      ['C2', -90],
    ] as const) {
      const display = getDisplay(container, address)
      expect(display.style.transform).toBe(`rotate(${degrees}deg)`)
      expect(display.style.transformOrigin).toBe('center center')
      expect(display.style.display).toBe('inline-block')
      expect(display.style.writingMode).toBe('')
    }

    const vertical = getDisplay(container, 'D1')
    expect(vertical.style.writingMode).toBe('vertical-rl')
    expect(vertical.style.textOrientation).toBe('mixed')
    expect(vertical.style.transform).toBe('')
  })

  it('updates and clears rotation from the latest projection without regressing selection or edit', async () => {
    const projection = createProjectionBackend([
      {
        row: 0,
        col: 0,
        displayValue: 'before',
        valueKind: 'string',
        format: { rotation: 45 },
      },
    ])
    const { container } = renderGrid(projection.backend)

    await waitFor(() => {
      expect(getDisplay(container, 'A1').style.transform).toBe('rotate(45deg)')
    })

    const cell = getCell(container, 'A1')
    fireEvent.click(cell)

    await waitFor(() => {
      expect(cell.dataset.active).toBe('true')
      expect(cell.querySelector('[data-testid="fill-handle-A1"]')).not.toBeNull()
    })

    projection.publish([
      {
        row: 0,
        col: 0,
        displayValue: 'updated',
        valueKind: 'string',
        format: { rotation: -45 },
      },
    ])

    await waitFor(() => {
      expect(getDisplay(container, 'A1').textContent).toBe('updated')
      expect(getDisplay(container, 'A1').style.transform).toBe('rotate(-45deg)')
      expect(cell.dataset.active).toBe('true')
    })

    fireEvent.dblClick(cell)

    await waitFor(() => {
      const input = cell.querySelector('.cell-input')
      expect(input).toBeInstanceOf(HTMLInputElement)
      expect((input as HTMLInputElement).value).toBe('updated')
      expect((input as HTMLInputElement).style.transform).toBe('')
      expect((input as HTMLInputElement).style.writingMode).toBe('')
      expect(cell.querySelector('.cell-display')).toBeNull()
      expect(cell.querySelector('[data-testid="fill-handle-A1"]')).toBeNull()
      expect(cell.dataset.active).toBe('true')
    })

    fireEvent.keyDown(cell.querySelector('.cell-input')!, { key: 'Escape' })

    await waitFor(() => {
      expect(getDisplay(container, 'A1').style.transform).toBe('rotate(-45deg)')
      expect(cell.querySelector('[data-testid="fill-handle-A1"]')).not.toBeNull()
    })

    projection.publish([
      {
        row: 0,
        col: 0,
        displayValue: 'cleared',
        valueKind: 'string',
      },
    ])

    await waitFor(() => {
      const display = getDisplay(container, 'A1')
      expect(display.textContent).toBe('cleared')
      expect(display.style.transform).toBe('')
      expect(display.style.transformOrigin).toBe('')
      expect(display.style.display).toBe('')
      expect(display.style.writingMode).toBe('')
      expect(cell.dataset.active).toBe('true')
      expect(cell.querySelector('[data-testid="fill-handle-A1"]')).not.toBeNull()
    })
  })
})
