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
  viewportWidth: 2,
  rowHeight: 1,
  colWidth: 1,
  rowCount: 2,
  colCount: 2,
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
  // The border integration is independent from the optional canvas overlay;
  // use its SVG implementation so jsdom does not require a canvas context.
  window.history.replaceState(null, '', '/?svgOverlay=1')
  return render(() => (
    <SpreadsheetUiProvider backend={backend} store={store}>
      <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} />
    </SpreadsheetUiProvider>
  ))
}

function getCell(container: HTMLElement, address: string): HTMLElement {
  const cell = container.querySelector(`[data-cell-addr="${address}"]`)
  if (!(cell instanceof HTMLElement)) throw new Error(`missing cell ${address}`)
  return cell
}

function getBorder(cell: HTMLElement, side: string): HTMLElement {
  const border = cell.querySelector(`[data-cell-border-side="${side}"]`)
  if (!(border instanceof HTMLElement)) throw new Error(`missing ${side} border`)
  return border
}

describe('vNext grid cell border rendering', () => {
  it('renders no border, one side, and four independently styled sides', async () => {
    const { backend } = createProjectionBackend([
      { row: 0, col: 0, displayValue: 'none' },
      {
        row: 0,
        col: 1,
        displayValue: 'explicit none',
        format: { borders: { top: { style: 'none', color: '#ff0000' } } },
      },
      {
        row: 1,
        col: 0,
        displayValue: 'one side',
        format: { borders: { top: { style: 'dashed', color: '#ff0000' } } },
      },
      {
        row: 1,
        col: 1,
        displayValue: 'four sides',
        format: {
          borders: {
            top: { style: 'thin' },
            right: { style: 'medium', color: '#00ff00' },
            bottom: { style: 'thick', color: '#0000ff' },
            left: { style: 'double', color: '#123456' },
          },
        },
      },
    ])
    const { container } = renderGrid(backend)

    await waitFor(() => {
      expect(getCell(container, 'B2').textContent).toContain('four sides')
    })

    expect(getCell(container, 'A1').querySelectorAll('[data-cell-border-side]')).toHaveLength(0)
    expect(getCell(container, 'B1').querySelectorAll('[data-cell-border-side]')).toHaveLength(0)
    expect(getCell(container, 'B1').hasAttribute('data-borders')).toBe(false)

    const oneSideCell = getCell(container, 'A2')
    expect(oneSideCell.dataset.borders).toBe('top')
    expect(oneSideCell.querySelectorAll('[data-cell-border-side]')).toHaveLength(1)
    const dashedTop = getBorder(oneSideCell, 'top')
    expect(dashedTop.dataset.borderStyle).toBe('dashed')
    expect(dashedTop.dataset.borderColor).toBe('#ff0000')
    expect(dashedTop.style.borderTopWidth).toBe('1px')
    expect(dashedTop.style.borderTopStyle).toBe('dashed')
    expect(dashedTop.style.borderTopColor).toBe('#ff0000')

    const fourSideCell = getCell(container, 'B2')
    expect(fourSideCell.dataset.borders).toBe('top right bottom left')
    expect(fourSideCell.querySelectorAll('[data-cell-border-side]')).toHaveLength(4)

    const thinTop = getBorder(fourSideCell, 'top')
    expect(thinTop.dataset.borderColor).toBe('#000000')
    expect(thinTop.style.borderTop).toBe('1px solid #000000')

    const mediumRight = getBorder(fourSideCell, 'right')
    expect(mediumRight.style.borderRight).toBe('2px solid #00ff00')

    const thickBottom = getBorder(fourSideCell, 'bottom')
    expect(thickBottom.style.borderBottom).toBe('3px solid #0000ff')

    const doubleLeft = getBorder(fourSideCell, 'left')
    expect(doubleLeft.style.borderLeft).toBe('3px double #123456')
  })

  it('rerenders only from the latest canonical projection cells', async () => {
    const projection = createProjectionBackend([
      {
        row: 0,
        col: 0,
        displayValue: 'before',
        format: { borders: { top: { style: 'thin', color: '#ff0000' } } },
      },
    ])
    const { container } = renderGrid(projection.backend)

    await waitFor(() => {
      expect(getBorder(getCell(container, 'A1'), 'top').dataset.borderColor).toBe('#ff0000')
    })

    projection.publish([
      {
        row: 0,
        col: 0,
        displayValue: 'after',
        format: { borders: { bottom: { style: 'dotted', color: '#800080' } } },
      },
    ])

    await waitFor(() => {
      const cell = getCell(container, 'A1')
      expect(cell.textContent).toContain('after')
      expect(cell.querySelector('[data-cell-border-side="top"]')).toBeNull()
      expect(getBorder(cell, 'bottom').dataset.borderColor).toBe('#800080')
    })

    const dottedBottom = getBorder(getCell(container, 'A1'), 'bottom')
    expect(dottedBottom.style.borderBottom).toBe('1px dotted #800080')

    projection.publish([
      {
        row: 0,
        col: 0,
        displayValue: 'removed',
        format: { borders: { bottom: { style: 'none' } } },
      },
    ])

    await waitFor(() => {
      const cell = getCell(container, 'A1')
      expect(cell.textContent).toContain('removed')
      expect(cell.querySelectorAll('[data-cell-border-side]')).toHaveLength(0)
      expect(cell.hasAttribute('data-borders')).toBe(false)
    })
  })

  it('keeps the active selection and fill handle above non-interactive border overlays', async () => {
    const { backend } = createProjectionBackend([
      {
        row: 0,
        col: 0,
        displayValue: 'selected',
        format: {
          borders: {
            top: { style: 'thin' },
            right: { style: 'thin' },
            bottom: { style: 'thin' },
            left: { style: 'thin' },
          },
        },
      },
    ])
    const { container } = renderGrid(backend)

    await waitFor(() => {
      expect(getCell(container, 'A1').textContent).toContain('selected')
    })

    const cell = getCell(container, 'A1')
    fireEvent.click(cell)

    await waitFor(() => {
      expect(cell.dataset.active).toBe('true')
      expect(cell.classList.contains('cell-active')).toBe(true)
      expect(cell.querySelector('[data-testid="fill-handle-A1"]')).not.toBeNull()
    })

    expect(cell.querySelectorAll('[data-cell-border-side]')).toHaveLength(4)
    for (const border of cell.querySelectorAll<HTMLElement>('[data-cell-border-side]')) {
      expect(border.style.position).toBe('absolute')
      expect(border.style.pointerEvents).toBe('none')
      expect(border.style.zIndex).toBe('1')
    }
    // The existing cell class supplies position:relative in styles.css; the
    // border renderer must not replace the parent's layout or active outline.
    expect(cell.classList.contains('spreadsheet-grid-cell')).toBe(true)
    expect(cell.style.position).toBe('')
    expect(cell.style.outline).toBe('')
  })
})
