import {
  activeCellAtom,
  clipboardStateAtom,
  editingSessionAtom,
  formulaReferenceTokensAtom,
  getSelectionRange,
  pointerSessionAtom,
  selectionRangeAtom,
  selectionRegionsAtom,
  viewportFreezeAtom,
  viewportHiddenAtom,
  viewportMetricsAtom,
  viewportSizeOverridesAtom,
  type CellRange,
  type ClipboardState,
  type DisplayCell,
  type FormulaReferenceToken,
  type PointerSessionState,
  type SelectionState,
} from '@einfach/spreadsheet-ui-core'
import { onCleanup, onMount } from 'solid-js'
import type { Store } from '@einfach/core'
import { spreadsheetProjectionSnapshotAtom } from '../provider'
import { useSpreadsheetUiStore } from '../provider'

// Stable color palette for formula-reference highlights. Indexed by colorIndex
// from the parsed token list — same token text → same slot so the box and
// (future) inline text color stay in sync across re-renders.
export const FORMULA_REFERENCE_PALETTE = [
  '#1d6f42', // green
  '#c75450', // red
  '#3478f6', // blue
  '#b54793', // magenta
  '#d97706', // amber
  '#0891b2', // teal
] as const

// Excel-ish accent colors. Single source of truth so tests can assert exactly.
export const OVERLAY_COLORS = {
  primarySelectionFill: 'rgba(33, 115, 70, 0.10)',
  primarySelectionBorder: '#217346',
  secondarySelectionFill: 'rgba(33, 115, 70, 0.06)',
  secondarySelectionBorder: '#7fb89a',
  activeCellBorder: '#217346',
  fillHandle: '#217346',
  fillHandleStroke: '#ffffff',
  mergeBorder: '#8f8f8f',
  freezeDivider: '#a0a0a0',
  marchingAnts: '#217346',
  marchingAntsBg: '#ffffff',
  dropIndicator: '#3478f6',
  dataBarPositive: 'rgba(33, 115, 70, 0.35)',
  dataBarNegative: 'rgba(192, 64, 64, 0.35)',
  colorScaleFallback: 'rgba(33, 115, 70, 0.20)',
} as const

export const OVERLAY_BORDER_WIDTH = {
  primary: 2,
  secondary: 1,
  active: 2,
  merge: 1,
  freeze: 2,
  marchingAnts: 1.5,
  drop: 2,
} as const

export const FILL_HANDLE_SIZE = 6

export interface OverlayContext {
  canvas: HTMLCanvasElement | { width: number; height: number }
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineDashOffset: number
  globalAlpha: number
  setLineDash(segments: number[]): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  strokeRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  fill(): void
  save(): void
  restore(): void
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient
}

export type OverlayContextFactory = (canvas: HTMLCanvasElement) => OverlayContext | null

export interface OverlayViewportProvider {
  getCellRect(row: number, col: number): { x: number; y: number; w: number; h: number } | null
  getSurfaceSize(): { width: number; height: number }
  getSheetId(): string
  getCells(): readonly DisplayCell[]
  getFreezeOrigin(): { x: number; y: number }
}

export type OverlayDirtyReason =
  | 'selection'
  | 'pointer'
  | 'clipboard'
  | 'viewport'
  | 'metrics'
  | 'projection'
  | 'resize'
  | 'marching-ants'

interface OverlaySnapshot {
  selectionRegions: readonly SelectionState[]
  activeCell: { row: number; col: number; sheetId: string }
  selectionRange: CellRange
  pointerSession: PointerSessionState
  clipboard: ClipboardState
  freezeRows: number
  freezeCols: number
  marchingAntsOffset: number
  formulaReferenceTokens: readonly FormulaReferenceToken[]
  formulaReferenceSheetId: string | null
}

export class OverlayRenderer {
  private canvas: HTMLCanvasElement | null = null
  private ctx: OverlayContext | null = null
  private store: Store | null = null
  private viewport: OverlayViewportProvider | null = null
  private dpr = 1
  private cssWidth = 0
  private cssHeight = 0
  private rafHandle: number | null = null
  private marchingAntsHandle: number | null = null
  private marchingAntsOffset = 0
  private dirty = false
  private contextFactory: OverlayContextFactory
  private unsubscribes: Array<() => void> = []

  constructor(contextFactory?: OverlayContextFactory) {
    this.contextFactory = contextFactory ?? defaultContextFactory
  }

  attach(canvas: HTMLCanvasElement, store: Store, viewport: OverlayViewportProvider): void {
    this.canvas = canvas
    this.store = store
    this.viewport = viewport
    this.ctx = this.contextFactory(canvas)
    this.subscribeAtoms()
    this.resize()
    this.markDirty('resize')
  }

  detach(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
    this.stopMarchingAnts()
    for (const unsub of this.unsubscribes) {
      unsub()
    }
    this.unsubscribes = []
    this.canvas = null
    this.ctx = null
    this.store = null
    this.viewport = null
  }

  markDirty(_reason: OverlayDirtyReason): void {
    if (this.dirty) {
      return
    }
    this.dirty = true
    if (this.rafHandle !== null) {
      return
    }
    this.rafHandle = scheduleFrame(() => {
      this.rafHandle = null
      if (!this.dirty) {
        return
      }
      this.dirty = false
      this.render()
    })
  }

  resize(): void {
    if (!this.canvas || !this.viewport) {
      return
    }
    const size = this.viewport.getSurfaceSize()
    this.dpr = readDevicePixelRatio()
    this.cssWidth = Math.max(0, size.width)
    this.cssHeight = Math.max(0, size.height)
    this.canvas.width = Math.max(1, Math.round(this.cssWidth * this.dpr))
    this.canvas.height = Math.max(1, Math.round(this.cssHeight * this.dpr))
    this.canvas.style.width = `${this.cssWidth}px`
    this.canvas.style.height = `${this.cssHeight}px`
  }

  renderNow(): void {
    this.dirty = false
    this.render()
  }

  getMarchingAntsOffset(): number {
    return this.marchingAntsOffset
  }

  private subscribeAtoms(): void {
    if (!this.store) return
    const store = this.store
    const wake = (reason: OverlayDirtyReason) => () => {
      this.markDirty(reason)
      this.refreshMarchingAnts()
    }
    this.unsubscribes.push(store.sub(selectionRangeAtom, wake('selection')))
    this.unsubscribes.push(store.sub(selectionRegionsAtom, wake('selection')))
    this.unsubscribes.push(store.sub(activeCellAtom, wake('selection')))
    this.unsubscribes.push(store.sub(pointerSessionAtom, wake('pointer')))
    this.unsubscribes.push(store.sub(clipboardStateAtom, wake('clipboard')))
    this.unsubscribes.push(store.sub(viewportMetricsAtom, wake('metrics')))
    this.unsubscribes.push(store.sub(viewportFreezeAtom, wake('viewport')))
    this.unsubscribes.push(store.sub(viewportSizeOverridesAtom, wake('metrics')))
    this.unsubscribes.push(store.sub(viewportHiddenAtom, wake('viewport')))
    this.unsubscribes.push(store.sub(spreadsheetProjectionSnapshotAtom, wake('projection')))
    this.unsubscribes.push(store.sub(editingSessionAtom, wake('selection')))
    this.unsubscribes.push(store.sub(formulaReferenceTokensAtom, wake('selection')))
    this.refreshMarchingAnts()
  }

  private refreshMarchingAnts(): void {
    if (!this.store) return
    const clip = this.store.getter(clipboardStateAtom)
    const wantAnts = clip.intent?.type === 'clipboard.copy' || clip.intent?.type === 'clipboard.cut'
    if (wantAnts && this.marchingAntsHandle === null) {
      this.startMarchingAnts()
    } else if (!wantAnts && this.marchingAntsHandle !== null) {
      this.stopMarchingAnts()
    }
  }

  private startMarchingAnts(): void {
    const tick = () => {
      this.marchingAntsOffset = (this.marchingAntsOffset + 1) % 1000
      this.markDirty('marching-ants')
      this.marchingAntsHandle = scheduleAntsFrame(tick)
    }
    this.marchingAntsHandle = scheduleAntsFrame(tick)
  }

  private stopMarchingAnts(): void {
    if (this.marchingAntsHandle !== null) {
      cancelAntsFrame(this.marchingAntsHandle)
      this.marchingAntsHandle = null
    }
  }

  private snapshot(): OverlaySnapshot | null {
    if (!this.store || !this.viewport) return null
    const store = this.store
    const sheetId = this.viewport.getSheetId()
    const freeze = store.getter(viewportFreezeAtom)
    const selection = store.getter(selectionRangeAtom)
    const regions = store.getter(selectionRegionsAtom)
    const active = store.getter(activeCellAtom)
    const ps = store.getter(pointerSessionAtom)
    const clip = store.getter(clipboardStateAtom)
    const editing = store.getter(editingSessionAtom)
    const tokens = store.getter(formulaReferenceTokensAtom)
    return {
      selectionRegions: regions,
      activeCell: { row: active.row, col: active.col, sheetId: active.sheetId ?? sheetId },
      selectionRange: selection,
      pointerSession: ps,
      clipboard: clip,
      freezeRows: freeze.rowsBySheet[sheetId] ?? 0,
      freezeCols: freeze.colsBySheet[sheetId] ?? 0,
      marchingAntsOffset: this.marchingAntsOffset,
      formulaReferenceTokens: tokens,
      formulaReferenceSheetId: editing.source?.sheetId ?? null,
    }
  }

  private render(): void {
    const ctx = this.ctx
    const viewport = this.viewport
    if (!ctx || !viewport) return
    const snap = this.snapshot()
    if (!snap) return

    const dpr = this.dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight)

    const sheetId = viewport.getSheetId()
    const cells = viewport.getCells()

    this.drawFreezeDividers(ctx, viewport, snap)
    this.drawConditionalFormatOverlays(ctx, viewport, cells)
    this.drawMergeBorders(ctx, viewport, cells)
    this.drawSecondarySelections(ctx, viewport, snap, sheetId)
    this.drawPrimarySelection(ctx, viewport, snap, sheetId)
    this.drawActiveCell(ctx, viewport, snap, sheetId)
    this.drawFillHandle(ctx, viewport, snap, sheetId)
    this.drawFillPreview(ctx, viewport, snap, sheetId)
    this.drawClipboardSource(ctx, viewport, snap)
    this.drawFormulaReferenceTokens(ctx, viewport, snap, sheetId)
  }

  private drawFormulaReferenceTokens(
    ctx: OverlayContext,
    viewport: OverlayViewportProvider,
    snap: OverlaySnapshot,
    sheetId: string,
  ): void {
    if (snap.formulaReferenceTokens.length === 0) return
    // Only paint tokens whose sheet matches the visible viewport. The editing
    // session may live on another sheet (mid-edit when the user switches),
    // in which case we just skip painting here.
    for (const token of snap.formulaReferenceTokens) {
      const tokenSheet = token.sheetId ?? snap.formulaReferenceSheetId
      if (tokenSheet && tokenSheet !== sheetId) continue
      const rect = this.rectForRange(viewport, token.range)
      if (!rect) continue
      const color = FORMULA_REFERENCE_PALETTE[token.colorIndex % FORMULA_REFERENCE_PALETTE.length]
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.setLineDash([4, 2])
      ctx.strokeRect(
        rect.x + 0.5,
        rect.y + 0.5,
        Math.max(0, rect.w - 1),
        Math.max(0, rect.h - 1),
      )
      ctx.setLineDash([])
    }
  }

  private rectForRange(
    viewport: OverlayViewportProvider,
    range: CellRange,
  ): { x: number; y: number; w: number; h: number } | null {
    const start = viewport.getCellRect(range.rowStart, range.colStart)
    const end = viewport.getCellRect(range.rowEnd, range.colEnd)
    if (!start || !end) return null
    const x = Math.min(start.x, end.x)
    const y = Math.min(start.y, end.y)
    const w = Math.max(start.x + start.w, end.x + end.w) - x
    const h = Math.max(start.y + start.h, end.y + end.h) - y
    return { x, y, w, h }
  }

  private drawRangeOutline(
    ctx: OverlayContext,
    rect: { x: number; y: number; w: number; h: number },
    fill: string | null,
    border: string,
    width: number,
  ): void {
    if (fill) {
      ctx.fillStyle = fill
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
    }
    ctx.strokeStyle = border
    ctx.lineWidth = width
    ctx.setLineDash([])
    ctx.strokeRect(
      rect.x + width / 2,
      rect.y + width / 2,
      Math.max(0, rect.w - width),
      Math.max(0, rect.h - width),
    )
  }

  private drawPrimarySelection(
    ctx: OverlayContext,
    viewport: OverlayViewportProvider,
    snap: OverlaySnapshot,
    sheetId: string,
  ): void {
    const region = snap.selectionRegions.find((r) => r.sheetId === sheetId)
    if (!region) return
    const rect = this.rectForRange(viewport, snap.selectionRange)
    if (!rect) return
    this.drawRangeOutline(
      ctx,
      rect,
      OVERLAY_COLORS.primarySelectionFill,
      OVERLAY_COLORS.primarySelectionBorder,
      OVERLAY_BORDER_WIDTH.primary,
    )
  }

  private drawSecondarySelections(
    ctx: OverlayContext,
    viewport: OverlayViewportProvider,
    snap: OverlaySnapshot,
    sheetId: string,
  ): void {
    const regions = snap.selectionRegions.filter((r) => r.sheetId === sheetId)
    if (regions.length <= 1) return
    for (let i = 1; i < regions.length; i += 1) {
      const region = regions[i]
      const range = getSelectionRange(region, {
        rowCount: Number.MAX_SAFE_INTEGER,
        colCount: Number.MAX_SAFE_INTEGER,
      })
      const rect = this.rectForRange(viewport, range)
      if (!rect) continue
      this.drawRangeOutline(
        ctx,
        rect,
        OVERLAY_COLORS.secondarySelectionFill,
        OVERLAY_COLORS.secondarySelectionBorder,
        OVERLAY_BORDER_WIDTH.secondary,
      )
    }
  }

  private drawActiveCell(
    ctx: OverlayContext,
    viewport: OverlayViewportProvider,
    snap: OverlaySnapshot,
    sheetId: string,
  ): void {
    if (snap.activeCell.sheetId !== sheetId) return
    const rect = viewport.getCellRect(snap.activeCell.row, snap.activeCell.col)
    if (!rect) return
    const width = OVERLAY_BORDER_WIDTH.active
    ctx.strokeStyle = OVERLAY_COLORS.activeCellBorder
    ctx.lineWidth = width
    ctx.setLineDash([])
    ctx.strokeRect(
      rect.x + width / 2,
      rect.y + width / 2,
      Math.max(0, rect.w - width),
      Math.max(0, rect.h - width),
    )
  }

  private drawFillHandle(
    ctx: OverlayContext,
    viewport: OverlayViewportProvider,
    snap: OverlaySnapshot,
    sheetId: string,
  ): void {
    const region = snap.selectionRegions.find((r) => r.sheetId === sheetId)
    if (!region) return
    const rect = this.rectForRange(viewport, snap.selectionRange)
    if (!rect) return
    const size = FILL_HANDLE_SIZE
    const x = rect.x + rect.w - size / 2
    const y = rect.y + rect.h - size / 2
    ctx.fillStyle = OVERLAY_COLORS.fillHandle
    ctx.fillRect(x - size / 2, y - size / 2, size, size)
    ctx.strokeStyle = OVERLAY_COLORS.fillHandleStroke
    ctx.lineWidth = 1
    ctx.setLineDash([])
    ctx.strokeRect(x - size / 2, y - size / 2, size, size)
  }

  private drawFillPreview(
    ctx: OverlayContext,
    viewport: OverlayViewportProvider,
    snap: OverlaySnapshot,
    sheetId: string,
  ): void {
    const ps = snap.pointerSession
    if (ps.status !== 'active') return
    if (ps.interaction?.kind !== 'fill-handle') return
    if (ps.interaction.sheetId !== sheetId) return
    const previewRange = ps.interaction.previewRange
    if (!previewRange) return
    const rect = this.rectForRange(viewport, previewRange)
    if (!rect) return
    ctx.strokeStyle = OVERLAY_COLORS.dropIndicator
    ctx.lineWidth = OVERLAY_BORDER_WIDTH.drop
    ctx.setLineDash([4, 3])
    ctx.strokeRect(rect.x + 1, rect.y + 1, Math.max(0, rect.w - 2), Math.max(0, rect.h - 2))
    ctx.setLineDash([])
  }

  private drawMergeBorders(
    ctx: OverlayContext,
    viewport: OverlayViewportProvider,
    cells: readonly DisplayCell[],
  ): void {
    for (const cell of cells) {
      if (!cell.mergedSpan) continue
      const rows = Math.max(1, Math.trunc(cell.mergedSpan.rows))
      const cols = Math.max(1, Math.trunc(cell.mergedSpan.cols))
      const range: CellRange = {
        rowStart: cell.row,
        rowEnd: cell.row + rows - 1,
        colStart: cell.col,
        colEnd: cell.col + cols - 1,
      }
      const rect = this.rectForRange(viewport, range)
      if (!rect) continue
      ctx.strokeStyle = OVERLAY_COLORS.mergeBorder
      ctx.lineWidth = OVERLAY_BORDER_WIDTH.merge
      ctx.setLineDash([])
      ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, Math.max(0, rect.w - 1), Math.max(0, rect.h - 1))
    }
  }

  private drawConditionalFormatOverlays(
    ctx: OverlayContext,
    viewport: OverlayViewportProvider,
    cells: readonly DisplayCell[],
  ): void {
    for (const cell of cells) {
      const cf = cell.conditionalFormat
      if (!cf) continue
      const rect = viewport.getCellRect(cell.row, cell.col)
      if (!rect) continue
      if (cf.bgColor) {
        ctx.fillStyle = cf.bgColor
        ctx.globalAlpha = 0.35
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
        ctx.globalAlpha = 1
      }
    }
  }

  private drawFreezeDividers(
    ctx: OverlayContext,
    viewport: OverlayViewportProvider,
    snap: OverlaySnapshot,
  ): void {
    if (snap.freezeRows <= 0 && snap.freezeCols <= 0) return
    const origin = viewport.getFreezeOrigin()
    ctx.strokeStyle = OVERLAY_COLORS.freezeDivider
    ctx.lineWidth = OVERLAY_BORDER_WIDTH.freeze
    ctx.setLineDash([])
    const surface = viewport.getSurfaceSize()
    if (snap.freezeRows > 0) {
      const lastFrozenRow = snap.freezeRows - 1
      const rect = viewport.getCellRect(lastFrozenRow, 0)
      if (rect) {
        const y = rect.y + rect.h
        ctx.beginPath()
        ctx.moveTo(origin.x, y)
        ctx.lineTo(surface.width, y)
        ctx.stroke()
      }
    }
    if (snap.freezeCols > 0) {
      const lastFrozenCol = snap.freezeCols - 1
      const rect = viewport.getCellRect(0, lastFrozenCol)
      if (rect) {
        const x = rect.x + rect.w
        ctx.beginPath()
        ctx.moveTo(x, origin.y)
        ctx.lineTo(x, surface.height)
        ctx.stroke()
      }
    }
  }

  private drawClipboardSource(
    ctx: OverlayContext,
    viewport: OverlayViewportProvider,
    snap: OverlaySnapshot,
  ): void {
    const clip = snap.clipboard
    const intent = clip.intent
    if (!intent) return
    if (intent.type !== 'clipboard.copy' && intent.type !== 'clipboard.cut') return
    const source = clip.source ?? intent.request.source
    if (!source) return
    if (source.sheetId !== viewport.getSheetId()) return
    const rect = this.rectForRange(viewport, source.range)
    if (!rect) return
    ctx.save()
    ctx.strokeStyle = OVERLAY_COLORS.marchingAntsBg
    ctx.lineWidth = OVERLAY_BORDER_WIDTH.marchingAnts + 1
    ctx.setLineDash([])
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
    ctx.strokeStyle = OVERLAY_COLORS.marchingAnts
    ctx.lineWidth = OVERLAY_BORDER_WIDTH.marchingAnts
    ctx.setLineDash([4, 3])
    ctx.lineDashOffset = -(snap.marchingAntsOffset % 7)
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h)
    ctx.setLineDash([])
    ctx.lineDashOffset = 0
    ctx.restore()
  }
}

function defaultContextFactory(canvas: HTMLCanvasElement): OverlayContext | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  return ctx as unknown as OverlayContext
}

function readDevicePixelRatio(): number {
  if (typeof window === 'undefined') return 1
  const dpr = window.devicePixelRatio
  return typeof dpr === 'number' && Number.isFinite(dpr) && dpr > 0 ? dpr : 1
}

function scheduleFrame(cb: () => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(cb)
  }
  return setTimeout(cb, 16) as unknown as number
}

function scheduleAntsFrame(cb: () => void): number {
  return setTimeout(cb, 120) as unknown as number
}

function cancelAntsFrame(handle: number): void {
  clearTimeout(handle)
}

export interface SpreadsheetGridOverlayProps {
  sheetId: string
  getCellRect: (row: number, col: number) => { x: number; y: number; w: number; h: number } | null
  getSurfaceSize: () => { width: number; height: number }
  getCells: () => readonly DisplayCell[]
  getFreezeOrigin?: () => { x: number; y: number }
  contextFactory?: OverlayContextFactory
  onRendererReady?: (renderer: OverlayRenderer) => void
}

export function SpreadsheetGridOverlay(props: SpreadsheetGridOverlayProps) {
  const store = useSpreadsheetUiStore()
  let canvas: HTMLCanvasElement | undefined
  const renderer = new OverlayRenderer(props.contextFactory)

  onMount(() => {
    if (!canvas) return
    const viewport: OverlayViewportProvider = {
      getCellRect: (row, col) => props.getCellRect(row, col),
      getSurfaceSize: () => props.getSurfaceSize(),
      getSheetId: () => props.sheetId,
      getCells: () => props.getCells(),
      getFreezeOrigin: () => props.getFreezeOrigin?.() ?? { x: 0, y: 0 },
    }
    renderer.attach(canvas, store, viewport)
    props.onRendererReady?.(renderer)

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
      resizeObserver = new ResizeObserver(() => {
        renderer.resize()
        renderer.markDirty('resize')
      })
      resizeObserver.observe(canvas.parentElement)
    }

    onCleanup(() => {
      resizeObserver?.disconnect()
      renderer.detach()
    })
  })

  return (
    <canvas
      ref={canvas}
      class="spreadsheet-grid-overlay-canvas"
      data-testid="grid-overlay-canvas"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: '0',
        'pointer-events': 'none',
        width: '100%',
        height: '100%',
      }}
    />
  )
}
