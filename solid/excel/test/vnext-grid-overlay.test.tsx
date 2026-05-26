/** @jsxImportSource solid-js */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, render, waitFor, fireEvent } from '@solidjs/testing-library'
import type {
  DisplayCell,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  addSelectionRegionAtom,
  clipboardStateAtom,
  copyClipboardAtom,
  cutClipboardAtom,
  selectCellAtom,
  setSelectionAtom,
  setViewportFreezeAtom,
  visibleWindowAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetGrid } from '../src-vnext/grid'
import {
  OverlayRenderer,
  OVERLAY_COLORS,
  OVERLAY_BORDER_WIDTH,
  FILL_HANDLE_SIZE,
  SpreadsheetGridOverlay,
  type OverlayContext,
  type OverlayViewportProvider,
} from '../src-vnext/grid/SpreadsheetGridOverlay'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

function flushMicrotasks() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

interface CtxCall {
  op: string
  args: unknown[]
}

function createRecordingContext(width = 400, height = 300): {
  ctx: OverlayContext
  calls: CtxCall[]
} {
  const calls: CtxCall[] = []
  const state: {
    fillStyle: string | CanvasGradient | CanvasPattern
    strokeStyle: string | CanvasGradient | CanvasPattern
    lineWidth: number
    lineDashOffset: number
    globalAlpha: number
  } = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineDashOffset: 0,
    globalAlpha: 1,
  }

  const recordOp = (op: string, ...args: unknown[]) => {
    calls.push({ op, args })
  }

  const ctx: OverlayContext = {
    canvas: { width, height },
    get fillStyle() {
      return state.fillStyle
    },
    set fillStyle(value) {
      state.fillStyle = value
      recordOp('set:fillStyle', value)
    },
    get strokeStyle() {
      return state.strokeStyle
    },
    set strokeStyle(value) {
      state.strokeStyle = value
      recordOp('set:strokeStyle', value)
    },
    get lineWidth() {
      return state.lineWidth
    },
    set lineWidth(value) {
      state.lineWidth = value
      recordOp('set:lineWidth', value)
    },
    get lineDashOffset() {
      return state.lineDashOffset
    },
    set lineDashOffset(value) {
      state.lineDashOffset = value
      recordOp('set:lineDashOffset', value)
    },
    get globalAlpha() {
      return state.globalAlpha
    },
    set globalAlpha(value) {
      state.globalAlpha = value
      recordOp('set:globalAlpha', value)
    },
    setLineDash(segments) {
      recordOp('setLineDash', segments)
    },
    setTransform(a, b, c, d, e, f) {
      recordOp('setTransform', a, b, c, d, e, f)
    },
    clearRect(x, y, w, h) {
      recordOp('clearRect', x, y, w, h)
    },
    fillRect(x, y, w, h) {
      recordOp('fillRect', x, y, w, h, state.fillStyle)
    },
    strokeRect(x, y, w, h) {
      recordOp('strokeRect', x, y, w, h, state.strokeStyle, state.lineWidth)
    },
    beginPath() {
      recordOp('beginPath')
    },
    moveTo(x, y) {
      recordOp('moveTo', x, y)
    },
    lineTo(x, y) {
      recordOp('lineTo', x, y)
    },
    stroke() {
      recordOp('stroke')
    },
    fill() {
      recordOp('fill')
    },
    save() {
      recordOp('save')
    },
    restore() {
      recordOp('restore')
    },
    createLinearGradient(x0, y0, x1, y1) {
      recordOp('createLinearGradient', x0, y0, x1, y1)
      return { addColorStop: () => undefined } as unknown as CanvasGradient
    },
  }

  return { ctx, calls }
}

const CELL_W = 50
const CELL_H = 20
const HEADER_W = 30
const HEADER_H = 18

function makeViewportProvider(
  _store: ReturnType<typeof createStore>,
  options: {
    sheetId?: string
    cells?: DisplayCell[]
    rowCount?: number
    colCount?: number
    visibleRows?: number[]
    visibleCols?: number[]
  } = {},
): OverlayViewportProvider {
  const provider: OverlayViewportProvider = {
    getSheetId: () => options.sheetId ?? 'sheet-1',
    getCells: () => options.cells ?? [],
    getCellRect: (row, col) => ({
      x: HEADER_W + col * CELL_W,
      y: HEADER_H + row * CELL_H,
      w: CELL_W,
      h: CELL_H,
    }),
    getSurfaceSize: () => ({
      width: HEADER_W + (options.colCount ?? 10) * CELL_W,
      height: HEADER_H + (options.rowCount ?? 10) * CELL_H,
    }),
    getFreezeOrigin: () => ({ x: HEADER_W, y: HEADER_H }),
  }
  if (options.visibleRows) {
    provider.getVisibleRows = () => options.visibleRows!
  }
  if (options.visibleCols) {
    provider.getVisibleCols = () => options.visibleCols!
  }
  return provider
}

function makeCanvas(): HTMLCanvasElement {
  return document.createElement('canvas')
}

function findStrokeRectForColor(calls: CtxCall[], color: string): CtxCall[] {
  return calls.filter(
    (c) => c.op === 'strokeRect' && typeof c.args[4] === 'string' && c.args[4] === color,
  )
}

function findFillRectForColor(calls: CtxCall[], color: string): CtxCall[] {
  return calls.filter(
    (c) => c.op === 'fillRect' && typeof c.args[4] === 'string' && c.args[4] === color,
  )
}

describe('OverlayRenderer', () => {
  it('draws a primary selection rectangle at the correct pixel coords', () => {
    const store = createStore()
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 1 },
    })

    const { ctx, calls } = createRecordingContext()
    const renderer = new OverlayRenderer(() => ctx)
    const canvas = makeCanvas()
    const viewport = makeViewportProvider(store)

    renderer.attach(canvas, store, viewport)
    renderer.renderNow()

    const strokes = findStrokeRectForColor(calls, OVERLAY_COLORS.primarySelectionBorder)
    expect(strokes.length).toBeGreaterThanOrEqual(1)
    const primary = strokes[0]
    const width = OVERLAY_BORDER_WIDTH.primary
    expect(primary.args[0]).toBe(HEADER_W + width / 2)
    expect(primary.args[1]).toBe(HEADER_H + width / 2)
    expect(primary.args[2]).toBe(2 * CELL_W - width)
    expect(primary.args[3]).toBe(2 * CELL_H - width)

    renderer.detach()
  })

  it('clips a full-column selection to visible rows before drawing the outline', () => {
    const store = createStore()
    store.setter(setSelectionAtom, {
      kind: 'column',
      sheetId: 'sheet-1',
      colAnchor: 2,
      colFocus: 2,
    })

    const { ctx, calls } = createRecordingContext()
    const renderer = new OverlayRenderer(() => ctx)
    const canvas = makeCanvas()
    const viewport = makeViewportProvider(store, {
      visibleRows: [10, 11, 12],
      visibleCols: [1, 2, 3],
    })

    renderer.attach(canvas, store, viewport)
    renderer.renderNow()

    const primary = findStrokeRectForColor(calls, OVERLAY_COLORS.primarySelectionBorder)
    expect(primary.length).toBeGreaterThanOrEqual(1)
    const width = OVERLAY_BORDER_WIDTH.primary
    expect(primary[0].args[0]).toBe(HEADER_W + 2 * CELL_W + width / 2)
    expect(primary[0].args[1]).toBe(HEADER_H + 10 * CELL_H + width / 2)
    expect(primary[0].args[2]).toBe(CELL_W - width)
    expect(primary[0].args[3]).toBe(3 * CELL_H - width)

    renderer.detach()
  })

  it('draws a separate rectangle for each secondary selection region', () => {
    const store = createStore()
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(addSelectionRegionAtom, {
      region: {
        kind: 'range',
        sheetId: 'sheet-1',
        anchor: { row: 2, col: 2 },
        focus: { row: 3, col: 3 },
      },
    })

    const { ctx, calls } = createRecordingContext()
    const renderer = new OverlayRenderer(() => ctx)
    renderer.attach(makeCanvas(), store, makeViewportProvider(store))
    renderer.renderNow()

    const secondary = findStrokeRectForColor(calls, OVERLAY_COLORS.secondarySelectionBorder)
    const primary = findStrokeRectForColor(calls, OVERLAY_COLORS.primarySelectionBorder)
    expect(primary.length).toBeGreaterThanOrEqual(1)
    expect(secondary.length).toBe(1)
    const w = OVERLAY_BORDER_WIDTH.secondary
    expect(secondary[0].args[0]).toBe(HEADER_W + 2 * CELL_W + w / 2)
    expect(secondary[0].args[1]).toBe(HEADER_H + 2 * CELL_H + w / 2)

    renderer.detach()
  })

  it('draws a thicker active-cell border distinct from secondary borders', () => {
    const store = createStore()
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 2, col: 2 },
    })

    const { ctx, calls } = createRecordingContext()
    const renderer = new OverlayRenderer(() => ctx)
    renderer.attach(makeCanvas(), store, makeViewportProvider(store))
    renderer.renderNow()

    const activeStrokes = calls.filter(
      (c) => c.op === 'strokeRect' && c.args[5] === OVERLAY_BORDER_WIDTH.active,
    )
    expect(activeStrokes.length).toBeGreaterThanOrEqual(1)

    renderer.detach()
  })

  it('draws the fill handle as a small square at the bottom-right of the primary range', () => {
    const store = createStore()
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 1 },
    })

    const { ctx, calls } = createRecordingContext()
    const renderer = new OverlayRenderer(() => ctx)
    renderer.attach(makeCanvas(), store, makeViewportProvider(store))
    renderer.renderNow()

    const fills = findFillRectForColor(calls, OVERLAY_COLORS.fillHandle)
    expect(fills.length).toBeGreaterThanOrEqual(1)
    const handle = fills[fills.length - 1]
    const cx = HEADER_W + 2 * CELL_W
    const cy = HEADER_H + 2 * CELL_H
    expect(handle.args[0]).toBe(cx - FILL_HANDLE_SIZE)
    expect(handle.args[1]).toBe(cy - FILL_HANDLE_SIZE)
    expect(handle.args[2]).toBe(FILL_HANDLE_SIZE)
    expect(handle.args[3]).toBe(FILL_HANDLE_SIZE)

    renderer.detach()
  })

  it('draws a merge cell border for cells with mergedSpan', () => {
    const store = createStore()
    const cells: DisplayCell[] = [
      {
        row: 1,
        col: 1,
        displayValue: 'merged',
        mergedSpan: { rows: 2, cols: 3 },
      },
    ]

    const { ctx, calls } = createRecordingContext()
    const renderer = new OverlayRenderer(() => ctx)
    renderer.attach(makeCanvas(), store, makeViewportProvider(store, { cells }))
    renderer.renderNow()

    const mergeStrokes = findStrokeRectForColor(calls, OVERLAY_COLORS.mergeBorder)
    expect(mergeStrokes).toHaveLength(1)
    expect(mergeStrokes[0].args[2]).toBe(3 * CELL_W - 1)
    expect(mergeStrokes[0].args[3]).toBe(2 * CELL_H - 1)

    renderer.detach()
  })

  it('draws a frozen pane divider when viewportFreezeAtom is non-zero', () => {
    const store = createStore()
    store.setter(setViewportFreezeAtom, {
      sheetId: 'sheet-1',
      rows: 2,
      cols: 1,
    })

    const { ctx, calls } = createRecordingContext()
    const renderer = new OverlayRenderer(() => ctx)
    renderer.attach(makeCanvas(), store, makeViewportProvider(store))
    renderer.renderNow()

    const strokeCalls = calls.filter((c) => c.op === 'stroke')
    expect(strokeCalls.length).toBeGreaterThanOrEqual(2)
    const moveTos = calls.filter((c) => c.op === 'moveTo')
    const lineTos = calls.filter((c) => c.op === 'lineTo')
    expect(moveTos.length).toBeGreaterThanOrEqual(2)
    expect(lineTos.length).toBeGreaterThanOrEqual(2)

    const horizontalMoves = moveTos.filter(
      (c) => c.args[0] === HEADER_W && c.args[1] === HEADER_H + 2 * CELL_H,
    )
    expect(horizontalMoves).toHaveLength(1)
    const verticalMoves = moveTos.filter(
      (c) => c.args[0] === HEADER_W + CELL_W && c.args[1] === HEADER_H,
    )
    expect(verticalMoves).toHaveLength(1)

    renderer.detach()
  })

  it('draws marching ants over the clipboard source on copy and advances the dash offset', () => {
    jest.useFakeTimers()
    try {
      const store = createStore()
      store.setter(setSelectionAtom, {
        kind: 'cell',
        sheetId: 'sheet-1',
        anchor: { row: 0, col: 0 },
        focus: { row: 0, col: 0 },
      })
      store.setter(copyClipboardAtom, {
        source: {
          sheetId: 'sheet-1',
          range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 2 },
        },
        serialization: 'tab-separated',
      })

      const { ctx, calls } = createRecordingContext()
      const renderer = new OverlayRenderer(() => ctx)
      renderer.attach(makeCanvas(), store, makeViewportProvider(store))
      renderer.renderNow()

      const initialAnts = findStrokeRectForColor(calls, OVERLAY_COLORS.marchingAnts)
      expect(initialAnts.length).toBeGreaterThanOrEqual(1)
      const startingOffset = renderer.getMarchingAntsOffset()

      jest.advanceTimersByTime(360)
      const callCountBefore = calls.length
      renderer.renderNow()
      expect(renderer.getMarchingAntsOffset()).toBeGreaterThan(startingOffset)
      expect(calls.length).toBeGreaterThan(callCountBefore)

      renderer.detach()
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not draw clipboard-source ants when the clipboard intent is idle', () => {
    const store = createStore()
    const { ctx, calls } = createRecordingContext()
    const renderer = new OverlayRenderer(() => ctx)
    renderer.attach(makeCanvas(), store, makeViewportProvider(store))
    renderer.renderNow()

    const ants = findStrokeRectForColor(calls, OVERLAY_COLORS.marchingAnts)
    expect(ants).toHaveLength(0)
    expect(store.getter(clipboardStateAtom).intent).toBeNull()

    renderer.detach()
  })

  it('draws marching ants on cut as well as copy', () => {
    const store = createStore()
    store.setter(cutClipboardAtom, {
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      },
      serialization: 'tab-separated',
    })

    const { ctx, calls } = createRecordingContext()
    const renderer = new OverlayRenderer(() => ctx)
    renderer.attach(makeCanvas(), store, makeViewportProvider(store))
    renderer.renderNow()

    const ants = findStrokeRectForColor(calls, OVERLAY_COLORS.marchingAnts)
    expect(ants.length).toBeGreaterThanOrEqual(1)

    renderer.detach()
  })

  it('scales the canvas backing store by window.devicePixelRatio', () => {
    const store = createStore()
    const originalDpr = window.devicePixelRatio
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 2,
    })

    try {
      const { ctx, calls } = createRecordingContext()
      const renderer = new OverlayRenderer(() => ctx)
      const canvas = makeCanvas()
      const viewport = makeViewportProvider(store, { rowCount: 4, colCount: 4 })
      renderer.attach(canvas, store, viewport)
      const expectedCssW = HEADER_W + 4 * CELL_W
      const expectedCssH = HEADER_H + 4 * CELL_H
      expect(canvas.width).toBe(expectedCssW * 2)
      expect(canvas.height).toBe(expectedCssH * 2)
      expect(canvas.style.width).toBe(`${expectedCssW}px`)
      expect(canvas.style.height).toBe(`${expectedCssH}px`)

      renderer.renderNow()
      const transform = calls.find((c) => c.op === 'setTransform')
      expect(transform).toBeTruthy()
      expect(transform?.args[0]).toBe(2)
      expect(transform?.args[3]).toBe(2)

      renderer.detach()
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        value: originalDpr,
      })
    }
  })

  it('draws conditional-format overlays under selection rectangles for cells with conditionalFormat', () => {
    const store = createStore()
    const cells: DisplayCell[] = [
      {
        row: 0,
        col: 0,
        displayValue: '5',
        valueKind: 'number',
        conditionalFormat: { bgColor: '#aaffaa' },
      },
    ]

    const { ctx, calls } = createRecordingContext()
    const renderer = new OverlayRenderer(() => ctx)
    renderer.attach(makeCanvas(), store, makeViewportProvider(store, { cells }))
    renderer.renderNow()

    const cfFills = findFillRectForColor(calls, '#aaffaa')
    expect(cfFills).toHaveLength(1)
    expect(cfFills[0].args[0]).toBe(HEADER_W)
    expect(cfFills[0].args[1]).toBe(HEADER_H)
    expect(cfFills[0].args[2]).toBe(CELL_W)
    expect(cfFills[0].args[3]).toBe(CELL_H)

    renderer.detach()
  })

  it('schedules a single rAF when multiple atom changes happen in the same frame', () => {
    const store = createStore()
    const rafSpy = jest.spyOn(window, 'requestAnimationFrame')
    try {
      const { ctx } = createRecordingContext()
      const renderer = new OverlayRenderer(() => ctx)
      renderer.attach(makeCanvas(), store, makeViewportProvider(store))
      const initialCalls = rafSpy.mock.calls.length

      store.setter(setSelectionAtom, {
        kind: 'cell',
        sheetId: 'sheet-1',
        anchor: { row: 1, col: 1 },
        focus: { row: 1, col: 1 },
      })
      store.setter(setSelectionAtom, {
        kind: 'cell',
        sheetId: 'sheet-1',
        anchor: { row: 2, col: 2 },
        focus: { row: 2, col: 2 },
      })
      store.setter(setSelectionAtom, {
        kind: 'cell',
        sheetId: 'sheet-1',
        anchor: { row: 3, col: 3 },
        focus: { row: 3, col: 3 },
      })

      expect(rafSpy.mock.calls.length - initialCalls).toBeLessThanOrEqual(1)

      renderer.detach()
    } finally {
      rafSpy.mockRestore()
    }
  })
})

function buildCells(window: VisibleProjectionRequest['window']): DisplayCell[] {
  const cells: DisplayCell[] = []
  for (let row = window.rowStart; row <= window.rowEnd; row += 1) {
    for (let col = window.colStart; col <= window.colEnd; col += 1) {
      cells.push({ row, col, displayValue: `${row},${col}` })
    }
  }
  return cells
}

function createFakeBackend(): SpreadsheetBackend {
  return {
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
}

describe('SpreadsheetGridOverlay integration', () => {
  let consoleErrSpy: ReturnType<typeof jest.spyOn> | null = null
  beforeEach(() => {
    consoleErrSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleErrSpy?.mockRestore()
  })

  it('mounts a pointer-events: none canvas inside the grid', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 2,
      viewportWidth: 2,
      rowHeight: 20,
      colWidth: 50,
      rowCount: 4,
      colCount: 4,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await flushMicrotasks()
    await waitFor(() => {
      expect(container.querySelector('[data-testid="grid-overlay-canvas"]')).toBeTruthy()
    })
    const canvas = container.querySelector(
      '[data-testid="grid-overlay-canvas"]',
    ) as HTMLCanvasElement
    expect(canvas.getAttribute('aria-hidden')).toBe('true')
    expect(canvas.style.pointerEvents).toBe('none')
    expect(canvas.style.position).toBe('absolute')
  })

  it('keeps DOM cell clicks reaching the underlying <td> with the canvas in place', async () => {
    const store = createStore()
    const backend = createFakeBackend()
    const viewport = {
      scrollTop: 0,
      scrollLeft: 0,
      viewportHeight: 4,
      viewportWidth: 4,
      rowHeight: 1,
      colWidth: 1,
      rowCount: 8,
      colCount: 8,
      overscanRows: 0,
      overscanCols: 0,
    }

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetGrid sheetId="sheet-1" viewport={viewport} data-testid="grid" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(container.querySelectorAll('td.spreadsheet-grid-cell').length).toBeGreaterThan(0)
    })

    const cellButton = container.querySelector(
      '[data-cell-addr="B2"] .spreadsheet-grid-cell-button',
    ) as HTMLElement
    expect(cellButton).toBeTruthy()
    fireEvent.click(cellButton)

    await waitFor(() => {
      const sel = container.querySelector('[data-cell-addr="B2"]')
      expect(sel?.getAttribute('data-active')).toBe('true')
    })
  })

  it('redraws on selection changes but does not redraw on a pure read of visibleWindowAtom', async () => {
    const store = createStore()
    const captured: { renderer: OverlayRenderer | null } = { renderer: null }
    const { ctx, calls } = createRecordingContext()

    const Wrapper = () => (
      <SpreadsheetUiProvider backend={createFakeBackend()} store={store}>
        <div style={{ position: 'relative', width: '400px', height: '200px' }}>
          <SpreadsheetGridOverlay
            sheetId="sheet-1"
            contextFactory={() => ctx}
            getCellRect={(row, col) => ({
              x: col * CELL_W,
              y: row * CELL_H,
              w: CELL_W,
              h: CELL_H,
            })}
            getSurfaceSize={() => ({ width: 400, height: 200 })}
            getCells={() => []}
            onRendererReady={(renderer) => {
              captured.renderer = renderer
            }}
          />
        </div>
      </SpreadsheetUiProvider>
    )

    render(() => <Wrapper />)
    await flushMicrotasks()
    expect(captured.renderer).not.toBeNull()

    captured.renderer?.renderNow()
    const baselineCalls = calls.length
    store.getter(visibleWindowAtom)
    await new Promise((r) => setTimeout(r, 20))
    expect(calls.length).toBe(baselineCalls)

    store.setter(selectCellAtom, {
      sheetId: 'sheet-1',
      coord: { row: 2, col: 1 },
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.length).toBeGreaterThan(baselineCalls)
  })
})
