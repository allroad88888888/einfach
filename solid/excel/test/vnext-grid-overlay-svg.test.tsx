/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import type { DisplayCell, SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import {
  addSelectionRegionAtom,
  copyClipboardAtom,
  cutClipboardAtom,
  hydrateViewportFreezeAtom,
  selectCellAtom,
  setSelectionAtom,
  startPointerAtom,
} from '@einfach/spreadsheet-ui-core'
import {
  FILL_HANDLE_SIZE,
  OVERLAY_BORDER_WIDTH,
  OVERLAY_COLORS,
} from '../src-vnext/grid/SpreadsheetGridOverlay'
import { SpreadsheetGridOverlaySvg } from '../src-vnext/grid/SpreadsheetGridOverlaySvg'
import { SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(cleanup)

const CELL_W = 50
const CELL_H = 20
const HEADER_W = 30
const HEADER_H = 18

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function createFakeBackend(freeze = { rows: 0, cols: 0 }): SpreadsheetBackend {
  let revision = 0
  return {
    async readVisibleProjection(request) {
      return {
        kind: 'visible-window',
        requestId: request.requestId,
        sheetId: request.sheetId,
        revision: 1,
        window: request.window,
        cells: [],
      }
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
    async readFreezeConfig(request) {
      return {
        kind: 'freeze-config',
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision,
        freeze: { ...freeze },
      }
    },
    async setFreezeConfig(request) {
      if (request.revision !== undefined && request.revision !== revision) {
        throw new Error('freeze revision conflict')
      }
      freeze = { ...request.freeze }
      revision += 1
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision,
      }
    },
  }
}

function rectFor(row: number, col: number) {
  return {
    x: HEADER_W + col * CELL_W,
    y: HEADER_H + row * CELL_H,
    w: CELL_W,
    h: CELL_H,
  }
}

interface MountOptions {
  store?: ReturnType<typeof createStore>
  backend?: SpreadsheetBackend
  sheetId?: string
  cells?: DisplayCell[]
}

function mount(options: MountOptions = {}) {
  const store = options.store ?? createStore()
  const sheetId = options.sheetId ?? 'sheet-1'
  const backend = options.backend ?? createFakeBackend()
  const utils = render(() => (
    <SpreadsheetUiProvider backend={backend} store={store}>
      <div style={{ position: 'relative', width: '400px', height: '200px' }}>
        <SpreadsheetGridOverlaySvg
          sheetId={sheetId}
          getCellRect={(row, col) => rectFor(row, col)}
          getSurfaceSize={() => ({ width: 400, height: 200 })}
          getCells={() => options.cells ?? []}
          getFreezeOrigin={() => ({ x: HEADER_W, y: HEADER_H })}
        />
      </div>
    </SpreadsheetUiProvider>
  ))
  return { ...utils, store }
}

describe('SpreadsheetGridOverlaySvg', () => {
  it('mounts a pointer-events: none SVG with aria-hidden', async () => {
    const { container } = mount()
    await flush()
    const svg = container.querySelector('[data-testid="grid-overlay-svg"]') as SVGSVGElement
    expect(svg).toBeTruthy()
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    // aria-hidden + pointer-events: none already removes it from accessibility +
    // focus chains in all modern browsers; the legacy SVG `focusable` attribute
    // only matters for IE, which we don't support.
    expect((svg as unknown as HTMLElement).style.pointerEvents).toBe('none')
  })

  it('draws the primary selection rect with correct x/y/width/height', async () => {
    const store = createStore()
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 1 },
    })
    const { container } = mount({ store })
    await flush()

    const border = await waitFor(() => {
      const node = container.querySelector(
        '[data-testid="svg-overlay-primary-selection-border"]',
      ) as SVGRectElement | null
      expect(node).toBeTruthy()
      return node!
    })
    const w = OVERLAY_BORDER_WIDTH.primary
    expect(Number(border.getAttribute('x'))).toBe(HEADER_W + w / 2)
    expect(Number(border.getAttribute('y'))).toBe(HEADER_H + w / 2)
    expect(Number(border.getAttribute('width'))).toBe(2 * CELL_W - w)
    expect(Number(border.getAttribute('height'))).toBe(2 * CELL_H - w)
    expect(border.getAttribute('stroke')).toBe(OVERLAY_COLORS.primarySelectionBorder)
    expect(Number(border.getAttribute('stroke-width'))).toBe(w)

    const fill = container.querySelector(
      '[data-testid="svg-overlay-primary-selection-fill"]',
    ) as SVGRectElement
    expect(fill.getAttribute('fill')).toBe(OVERLAY_COLORS.primarySelectionFill)
  })

  it('draws the active cell border with the active stroke width', async () => {
    const store = createStore()
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 2 } })
    const { container } = mount({ store })
    await flush()

    const active = await waitFor(() => {
      const node = container.querySelector(
        '[data-testid="svg-overlay-active-cell"]',
      ) as SVGRectElement | null
      expect(node).toBeTruthy()
      return node!
    })
    const w = OVERLAY_BORDER_WIDTH.active
    expect(Number(active.getAttribute('stroke-width'))).toBe(w)
    expect(active.getAttribute('stroke')).toBe(OVERLAY_COLORS.activeCellBorder)
    expect(Number(active.getAttribute('x'))).toBe(HEADER_W + 2 * CELL_W + w / 2)
    expect(Number(active.getAttribute('y'))).toBe(HEADER_H + 1 * CELL_H + w / 2)
  })

  it('positions the fill handle centered on the bottom-right corner of the primary selection', async () => {
    const store = createStore()
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 1 },
    })
    const { container } = mount({ store })
    await flush()

    const handle = await waitFor(() => {
      const node = container.querySelector(
        '[data-testid="svg-overlay-fill-handle"]',
      ) as SVGRectElement | null
      expect(node).toBeTruthy()
      return node!
    })
    const s = FILL_HANDLE_SIZE
    // Canvas parity: handle square ENDS at the bottom-right corner of the
    // selection, i.e. top-left = corner - SIZE, not corner - SIZE/2.
    const cornerX = HEADER_W + 2 * CELL_W
    const cornerY = HEADER_H + 2 * CELL_H
    expect(Number(handle.getAttribute('x'))).toBe(cornerX - s)
    expect(Number(handle.getAttribute('y'))).toBe(cornerY - s)
    expect(Number(handle.getAttribute('width'))).toBe(s)
    expect(Number(handle.getAttribute('height'))).toBe(s)
    expect(handle.getAttribute('fill')).toBe(OVERLAY_COLORS.fillHandle)
    expect(handle.getAttribute('stroke')).toBe(OVERLAY_COLORS.fillHandleStroke)
  })

  it('does not render selection / handle nodes when there is no region for the sheet', async () => {
    const store = createStore()
    // Selection on a different sheet — shouldn't paint on sheet-1.
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'other-sheet',
      anchor: { row: 0, col: 0 },
      focus: { row: 1, col: 1 },
    })
    const { container } = mount({ store, sheetId: 'sheet-1' })
    await flush()

    expect(
      container.querySelector('[data-testid="svg-overlay-primary-selection-border"]'),
    ).toBeNull()
    expect(container.querySelector('[data-testid="svg-overlay-fill-handle"]')).toBeNull()
  })

  it('does not paint the active cell when the active sheet differs from the viewport sheet', async () => {
    const store = createStore()
    store.setter(selectCellAtom, { sheetId: 'other-sheet', coord: { row: 0, col: 0 } })
    const { container } = mount({ store, sheetId: 'sheet-1' })
    await flush()
    expect(container.querySelector('[data-testid="svg-overlay-active-cell"]')).toBeNull()
  })

  it('re-renders the primary selection when atoms change after mount', async () => {
    const store = createStore()
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    const { container } = mount({ store })
    await flush()

    let border = (await waitFor(() => {
      const n = container.querySelector(
        '[data-testid="svg-overlay-primary-selection-border"]',
      ) as SVGRectElement | null
      expect(n).toBeTruthy()
      return n!
    })) as SVGRectElement
    const w = OVERLAY_BORDER_WIDTH.primary
    expect(Number(border.getAttribute('width'))).toBe(CELL_W - w)

    // Expand selection — width should grow.
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 2 },
    })
    await waitFor(() => {
      const node = container.querySelector(
        '[data-testid="svg-overlay-primary-selection-border"]',
      ) as SVGRectElement | null
      expect(node).toBeTruthy()
      expect(Number(node!.getAttribute('width'))).toBe(3 * CELL_W - w)
      border = node!
    })
  })

  it('still produces correct geometry when the active cell is inside a frozen pane', async () => {
    // Frozen-pane case: the SVG overlay uses getCellRect, which in production
    // queries the actual sticky <td> via getBoundingClientRect. Our stub returns
    // a math-derived rect; the contract here is just "frozen state present →
    // selection still drawn for that cell."
    const store = createStore()
    const backend = createFakeBackend({ rows: 2, cols: 2 })
    await store.setter(hydrateViewportFreezeAtom, {
      source: backend,
      sheetId: 'sheet-1',
    })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })

    const { container } = mount({ store, backend })
    await flush()

    const active = await waitFor(() => {
      const node = container.querySelector(
        '[data-testid="svg-overlay-active-cell"]',
      ) as SVGRectElement | null
      expect(node).toBeTruthy()
      return node!
    })
    const w = OVERLAY_BORDER_WIDTH.active
    expect(Number(active.getAttribute('x'))).toBe(HEADER_W + w / 2)
    expect(Number(active.getAttribute('y'))).toBe(HEADER_H + w / 2)
  })

  it('draws a separate border + fill rect for each secondary selection region', async () => {
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
    const { container } = mount({ store })
    await flush()

    const border = await waitFor(() => {
      const n = container.querySelector(
        '[data-testid="svg-overlay-secondary-selection-border"]',
      ) as SVGRectElement | null
      expect(n).toBeTruthy()
      return n!
    })
    const w = OVERLAY_BORDER_WIDTH.secondary
    expect(Number(border.getAttribute('x'))).toBe(HEADER_W + 2 * CELL_W + w / 2)
    expect(Number(border.getAttribute('y'))).toBe(HEADER_H + 2 * CELL_H + w / 2)
    expect(border.getAttribute('stroke')).toBe(OVERLAY_COLORS.secondarySelectionBorder)
    expect(Number(border.getAttribute('stroke-width'))).toBe(w)

    const fill = container.querySelector(
      '[data-testid="svg-overlay-secondary-selection-fill"]',
    ) as SVGRectElement
    expect(fill).toBeTruthy()
    expect(fill.getAttribute('fill')).toBe(OVERLAY_COLORS.secondarySelectionFill)
  })

  it('draws merge cell borders for each cell that carries a mergedSpan', async () => {
    const store = createStore()
    const mergedCell: DisplayCell = {
      row: 1,
      col: 1,
      value: 'merged',
      display: 'merged',
      mergedSpan: { rows: 2, cols: 3 },
    } as unknown as DisplayCell
    const { container } = mount({ store, cells: [mergedCell] })
    await flush()

    const border = await waitFor(() => {
      const n = container.querySelector(
        '[data-testid="svg-overlay-merge-border"]',
      ) as SVGRectElement | null
      expect(n).toBeTruthy()
      return n!
    })
    const w = OVERLAY_BORDER_WIDTH.merge
    // Anchor at (1,1) with span 2x3 → bottom-right corner at row=2, col=3.
    expect(Number(border.getAttribute('x'))).toBe(HEADER_W + 1 * CELL_W + w / 2)
    expect(Number(border.getAttribute('y'))).toBe(HEADER_H + 1 * CELL_H + w / 2)
    expect(Number(border.getAttribute('width'))).toBe(3 * CELL_W - w)
    expect(Number(border.getAttribute('height'))).toBe(2 * CELL_H - w)
    expect(border.getAttribute('stroke')).toBe(OVERLAY_COLORS.mergeBorder)
  })

  it('paints a conditional-format background rect for cells with cf.bgColor', async () => {
    const store = createStore()
    const cfCell: DisplayCell = {
      row: 3,
      col: 4,
      value: 42,
      display: '42',
      conditionalFormat: { bgColor: '#ff8800' },
    } as unknown as DisplayCell
    const { container } = mount({ store, cells: [cfCell] })
    await flush()

    const bg = await waitFor(() => {
      const n = container.querySelector(
        '[data-testid="svg-overlay-cf-bg"]',
      ) as SVGRectElement | null
      expect(n).toBeTruthy()
      return n!
    })
    expect(Number(bg.getAttribute('x'))).toBe(HEADER_W + 4 * CELL_W)
    expect(Number(bg.getAttribute('y'))).toBe(HEADER_H + 3 * CELL_H)
    expect(Number(bg.getAttribute('width'))).toBe(CELL_W)
    expect(Number(bg.getAttribute('height'))).toBe(CELL_H)
    expect(bg.getAttribute('fill')).toBe('#ff8800')
    // 35% opacity matches canvas globalAlpha = 0.35.
    expect(Number(bg.getAttribute('fill-opacity'))).toBeCloseTo(0.35, 2)
  })

  it('does not paint cf overlay nodes for cells without conditionalFormat', async () => {
    const cells: DisplayCell[] = [
      { row: 0, col: 0, value: 'a', display: 'a' } as unknown as DisplayCell,
      { row: 1, col: 0, value: 'b', display: 'b' } as unknown as DisplayCell,
    ]
    const { container } = mount({ cells })
    await flush()
    expect(container.querySelectorAll('[data-testid="svg-overlay-cf-bg"]').length).toBe(0)
  })

  it('renders a dashed fill-preview rect when a fill-handle pointer session is active', async () => {
    const store = createStore()
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 0 },
    })
    store.setter(startPointerAtom, {
      kind: 'fill-handle',
      sheetId: 'sheet-1',
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      focus: { row: 3, col: 0 },
      previewRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
      direction: 'down',
      source: 'pointer',
    })
    const { container } = mount({ store })
    await flush()

    const preview = await waitFor(() => {
      const n = container.querySelector(
        '[data-testid="svg-overlay-fill-preview"]',
      ) as SVGRectElement | null
      expect(n).toBeTruthy()
      return n!
    })
    expect(preview.getAttribute('stroke')).toBe(OVERLAY_COLORS.dropIndicator)
    expect(preview.getAttribute('stroke-dasharray')).toBe('4 3')
    const w = OVERLAY_BORDER_WIDTH.drop
    // previewRange 0..3 rows in col 0 → height = 4 * CELL_H, inset by stroke.
    expect(Number(preview.getAttribute('height'))).toBe(4 * CELL_H - w)
    expect(Number(preview.getAttribute('width'))).toBe(CELL_W - w)
  })

  it('does not render fill-preview when the pointer session is idle', async () => {
    const { container } = mount()
    await flush()
    expect(container.querySelector('[data-testid="svg-overlay-fill-preview"]')).toBeNull()
  })

  it('renders the marching-ants halo + dash pair when the clipboard has a copy intent', async () => {
    const store = createStore()
    store.setter(copyClipboardAtom, {
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 1, rowEnd: 2, colStart: 1, colEnd: 2 },
      },
      serialization: 'tab-separated',
    })
    const { container } = mount({ store })
    await flush()

    const halo = await waitFor(() => {
      const n = container.querySelector(
        '[data-testid="svg-overlay-marching-ants-halo"]',
      ) as SVGRectElement | null
      expect(n).toBeTruthy()
      return n!
    })
    const dash = container.querySelector(
      '[data-testid="svg-overlay-marching-ants-dash"]',
    ) as SVGRectElement
    expect(dash).toBeTruthy()
    // Halo + dash share the exact same x/y/w/h (no inset; matches canvas).
    expect(halo.getAttribute('x')).toBe(dash.getAttribute('x'))
    expect(halo.getAttribute('y')).toBe(dash.getAttribute('y'))
    expect(halo.getAttribute('width')).toBe(dash.getAttribute('width'))
    expect(halo.getAttribute('height')).toBe(dash.getAttribute('height'))
    // The dash carries the CSS class that runs the @keyframes — all ants
    // rects in the document share a single animation-name, so multiple
    // overlays stay in phase.
    expect(dash.classList.contains('svg-marching-ants-dash')).toBe(true)
    expect(dash.getAttribute('stroke-dasharray')).toBe('4 3')
  })

  it('renders marching ants for cut intent as well as copy', async () => {
    const store = createStore()
    store.setter(cutClipboardAtom, {
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      },
      serialization: 'tab-separated',
    })
    const { container } = mount({ store })
    await flush()
    expect(
      container.querySelector('[data-testid="svg-overlay-marching-ants-dash"]'),
    ).toBeTruthy()
  })

  it('does not render marching ants when the clipboard is idle', async () => {
    const { container } = mount()
    await flush()
    expect(container.querySelector('[data-testid="svg-overlay-marching-ants-halo"]')).toBeNull()
    expect(container.querySelector('[data-testid="svg-overlay-marching-ants-dash"]')).toBeNull()
  })

  it('does not render marching ants when the clipboard source is on another sheet', async () => {
    const store = createStore()
    store.setter(copyClipboardAtom, {
      source: {
        sheetId: 'other-sheet',
        range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      },
      serialization: 'tab-separated',
    })
    const { container } = mount({ store, sheetId: 'sheet-1' })
    await flush()
    expect(container.querySelector('[data-testid="svg-overlay-marching-ants-dash"]')).toBeNull()
  })
})
