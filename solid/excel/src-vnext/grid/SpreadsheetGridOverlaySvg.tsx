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
  viewportFreezeProjectionAuthorityAtom,
  viewportHiddenAtom,
  viewportMetricsAtom,
  viewportSizeOverridesAtom,
  type CellRange,
  type DisplayCell,
} from '@einfach/spreadsheet-ui-core'
import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { spreadsheetProjectionSnapshotAtom, useSpreadsheetUiStore } from '../provider'
import {
  FILL_HANDLE_SIZE,
  FORMULA_REFERENCE_PALETTE,
  OVERLAY_BORDER_WIDTH,
  OVERLAY_COLORS,
} from './SpreadsheetGridOverlay'
import { computeOverlayRectForRange, type OverlayRect } from './overlayGeometry'

export interface SpreadsheetGridOverlaySvgProps {
  sheetId: string
  getCellRect: (row: number, col: number) => { x: number; y: number; w: number; h: number } | null
  getSurfaceSize: () => { width: number; height: number }
  getCells: () => readonly DisplayCell[]
  getFreezeOrigin?: () => { x: number; y: number }
  getVisibleRows?: () => readonly number[]
  getVisibleCols?: () => readonly number[]
}

type Rect = OverlayRect

interface ColoredRect extends Rect {
  color: string
  testId: string
}

const UNBOUNDED_SELECTION_BOUNDS = {
  rowCount: Number.MAX_SAFE_INTEGER,
  colCount: Number.MAX_SAFE_INTEGER,
}

/**
 * SVG overlay sibling to SpreadsheetGridOverlay (canvas). Renders the same
 * decorations the canvas overlay paints, but as <rect> nodes in a single
 * <svg> sibling that sits where the canvas previously sat. Reuses the host
 * grid's getCellRect / getSurfaceSize bridges so sticky frozen cells stay
 * aligned without any custom scroll plumbing.
 */
export function SpreadsheetGridOverlaySvg(props: SpreadsheetGridOverlaySvgProps) {
  const store = useSpreadsheetUiStore()
  // Two ticks instead of one so the heavier per-cell memos (CF / merge) do not
  // rescan on every selection or pointer change. Geometry tick covers atoms
  // that affect cell positions / which cells are visible; decoration tick
  // covers selection-style atoms. Memos read whichever they actually depend
  // on, so unrelated updates no longer trigger their work.
  const [geometryTick, setGeometryTick] = createSignal(0)
  const [decorationTick, setDecorationTick] = createSignal(0)
  const [size, setSize] = createSignal<{ width: number; height: number }>({ width: 0, height: 0 })

  let svgEl: SVGSVGElement | undefined
  const unsubscribes: Array<() => void> = []
  const syncSize = () => {
    const next = props.getSurfaceSize()
    setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next))
  }
  const bumpGeometry = () => {
    setGeometryTick((t) => t + 1)
    syncSize()
  }
  const bumpDecoration = () => {
    setDecorationTick((t) => t + 1)
  }

  onMount(() => {
    // Decoration atoms — change frequently as users select / drag / type but
    // do not change which cells the projection contains.
    unsubscribes.push(store.sub(selectionRangeAtom, bumpDecoration))
    unsubscribes.push(store.sub(selectionRegionsAtom, bumpDecoration))
    unsubscribes.push(store.sub(activeCellAtom, bumpDecoration))
    unsubscribes.push(store.sub(pointerSessionAtom, bumpDecoration))
    unsubscribes.push(store.sub(clipboardStateAtom, bumpDecoration))
    unsubscribes.push(store.sub(editingSessionAtom, bumpDecoration))
    unsubscribes.push(store.sub(formulaReferenceTokensAtom, bumpDecoration))

    // Geometry atoms — change which rectangles map to which cells. Memos that
    // walk cells (CF / merge borders) only need to re-derive when one of
    // these fires; selection-only changes do not.
    unsubscribes.push(store.sub(viewportMetricsAtom, bumpGeometry))
    unsubscribes.push(store.sub(viewportFreezeAtom, bumpGeometry))
    unsubscribes.push(store.sub(viewportFreezeProjectionAuthorityAtom, bumpGeometry))
    unsubscribes.push(store.sub(viewportSizeOverridesAtom, bumpGeometry))
    unsubscribes.push(store.sub(viewportHiddenAtom, bumpGeometry))
    unsubscribes.push(store.sub(spreadsheetProjectionSnapshotAtom, bumpGeometry))

    bumpGeometry()
    bumpDecoration()

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && svgEl?.parentElement) {
      resizeObserver = new ResizeObserver(() => bumpGeometry())
      resizeObserver.observe(svgEl.parentElement)
    }

    onCleanup(() => {
      resizeObserver?.disconnect()
      for (const unsub of unsubscribes) unsub()
    })
  })

  function rectForRange(range: CellRange): Rect | null {
    return computeOverlayRectForRange({
      range,
      getCellRect: props.getCellRect,
      getVisibleRows: props.getVisibleRows,
      getVisibleCols: props.getVisibleCols,
    })
  }

  // ---------------------------------------------------------------------------
  // Derived geometry (memoized so attribute reads of the same rect re-evaluate
  // exactly once per tick).
  // ---------------------------------------------------------------------------

  // Decoration memos need both ticks: their identity depends on selection/
  // pointer state (decorationTick) AND their pixel position depends on the
  // cell geometry (geometryTick).
  const trackBoth = () => {
    void decorationTick()
    void geometryTick()
  }
  // Cell-walking memos depend only on which cells are visible, which is
  // captured by geometryTick. Selection / pointer changes do not affect them.
  const trackGeometry = () => {
    void geometryTick()
  }

  const primarySelection = createMemo<Rect | null>(() => {
    trackBoth()
    const regions = store.getter(selectionRegionsAtom)
    const region = regions.find((r) => r.sheetId === props.sheetId)
    if (!region) return null
    const range = store.getter(selectionRangeAtom)
    return rectForRange(range)
  })

  const activeCellRect = createMemo<Rect | null>(() => {
    trackBoth()
    const active = store.getter(activeCellAtom)
    const sheetId = active.sheetId ?? props.sheetId
    if (sheetId !== props.sheetId) return null
    return props.getCellRect(active.row, active.col)
  })

  const secondarySelectionRects = createMemo<Rect[]>(() => {
    trackBoth()
    const regions = store.getter(selectionRegionsAtom).filter((r) => r.sheetId === props.sheetId)
    if (regions.length <= 1) return []
    const out: Rect[] = []
    for (let i = 1; i < regions.length; i += 1) {
      const range = getSelectionRange(regions[i], UNBOUNDED_SELECTION_BOUNDS)
      const rect = rectForRange(range)
      if (rect) out.push(rect)
    }
    return out
  })

  const fillPreviewRect = createMemo<Rect | null>(() => {
    trackBoth()
    const ps = store.getter(pointerSessionAtom)
    if (ps.status !== 'active') return null
    if (ps.interaction?.kind !== 'fill-handle') return null
    if (ps.interaction.sheetId !== props.sheetId) return null
    const previewRange = ps.interaction.previewRange
    if (!previewRange) return null
    return rectForRange(previewRange)
  })

  const formulaReferenceRects = createMemo<ColoredRect[]>(() => {
    trackBoth()
    const tokens = store.getter(formulaReferenceTokensAtom)
    if (tokens.length === 0) return []
    const editing = store.getter(editingSessionAtom)
    const editSheet = editing.source?.sheetId ?? null
    const out: ColoredRect[] = []
    for (const token of tokens) {
      const tokenSheet = token.sheetId ?? editSheet
      if (tokenSheet && tokenSheet !== props.sheetId) continue
      const rect = rectForRange(token.range)
      if (!rect) continue
      out.push({
        ...rect,
        color: FORMULA_REFERENCE_PALETTE[token.colorIndex % FORMULA_REFERENCE_PALETTE.length],
        testId: `svg-overlay-formula-ref-${token.colorIndex}`,
      })
    }
    return out
  })

  const mergeBorderRects = createMemo<Rect[]>(() => {
    trackGeometry()
    const cells = props.getCells()
    if (cells.length === 0) return []
    const out: Rect[] = []
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
      const rect = rectForRange(range)
      if (rect) out.push(rect)
    }
    return out
  })

  const conditionalFormatRects = createMemo<Array<Rect & { color: string }>>(() => {
    trackGeometry()
    const cells = props.getCells()
    if (cells.length === 0) return []
    const out: Array<Rect & { color: string }> = []
    for (const cell of cells) {
      const cf = cell.conditionalFormat
      if (!cf || !cf.bgColor) continue
      const rect = props.getCellRect(cell.row, cell.col)
      if (!rect) continue
      out.push({ ...rect, color: cf.bgColor })
    }
    return out
  })

  const clipboardSourceRect = createMemo<Rect | null>(() => {
    trackBoth()
    const clip = store.getter(clipboardStateAtom)
    const intent = clip.intent
    if (!intent) return null
    if (intent.type !== 'clipboard.copy' && intent.type !== 'clipboard.cut') return null
    const source = clip.source ?? intent.request.source
    if (!source) return null
    if (source.sheetId !== props.sheetId) return null
    return rectForRange(source.range)
  })

  // Stroke inset helper — sit inside the cell rect like the canvas overlay's
  // strokeRect(x + width/2, ...) so the stroke does not bleed outside the cell.
  const insetX = (rect: Rect, width: number) => rect.x + width / 2
  const insetY = (rect: Rect, width: number) => rect.y + width / 2
  const insetW = (rect: Rect, width: number) => Math.max(0, rect.w - width)
  const insetH = (rect: Rect, width: number) => Math.max(0, rect.h - width)

  // Formula refs use lineWidth=1.5 but inset by 0.5 (1px) — mirrors the canvas
  // exactly so visual diffs against canvas are zero.
  const FORMULA_REF_STROKE_WIDTH = 1.5
  const FORMULA_REF_INSET_HALF = 0.5
  const CF_OPACITY = 0.35

  return (
    <svg
      ref={svgEl}
      class="spreadsheet-grid-overlay-svg"
      data-testid="grid-overlay-svg"
      aria-hidden="true"
      width={size().width || '100%'}
      height={size().height || '100%'}
      style={{
        position: 'absolute',
        inset: '0',
        'pointer-events': 'none',
        width: '100%',
        height: '100%',
        overflow: 'visible',
      }}
    >
      {/* Z-order matches the canvas render() sequence: CF overlays (bottom),
          merge borders, secondary selections, primary selection, active cell,
          fill handle, fill preview, formula reference tokens (top). */}

      <For each={conditionalFormatRects()}>
        {(rect) => (
          <rect
            data-testid="svg-overlay-cf-bg"
            x={rect.x}
            y={rect.y}
            width={rect.w}
            height={rect.h}
            fill={rect.color}
            fill-opacity={CF_OPACITY}
            stroke="none"
          />
        )}
      </For>

      <For each={mergeBorderRects()}>
        {(rect) => (
          <rect
            data-testid="svg-overlay-merge-border"
            x={insetX(rect, OVERLAY_BORDER_WIDTH.merge)}
            y={insetY(rect, OVERLAY_BORDER_WIDTH.merge)}
            width={insetW(rect, OVERLAY_BORDER_WIDTH.merge)}
            height={insetH(rect, OVERLAY_BORDER_WIDTH.merge)}
            fill="none"
            stroke={OVERLAY_COLORS.mergeBorder}
            stroke-width={OVERLAY_BORDER_WIDTH.merge}
          />
        )}
      </For>

      <For each={secondarySelectionRects()}>
        {(rect) => (
          <>
            <rect
              data-testid="svg-overlay-secondary-selection-fill"
              x={rect.x}
              y={rect.y}
              width={rect.w}
              height={rect.h}
              fill={OVERLAY_COLORS.secondarySelectionFill}
              stroke="none"
            />
            <rect
              data-testid="svg-overlay-secondary-selection-border"
              x={insetX(rect, OVERLAY_BORDER_WIDTH.secondary)}
              y={insetY(rect, OVERLAY_BORDER_WIDTH.secondary)}
              width={insetW(rect, OVERLAY_BORDER_WIDTH.secondary)}
              height={insetH(rect, OVERLAY_BORDER_WIDTH.secondary)}
              fill="none"
              stroke={OVERLAY_COLORS.secondarySelectionBorder}
              stroke-width={OVERLAY_BORDER_WIDTH.secondary}
            />
          </>
        )}
      </For>

      <Show when={primarySelection()} keyed>
        {(rect) => (
          <>
            <rect
              data-testid="svg-overlay-primary-selection-fill"
              x={rect.x}
              y={rect.y}
              width={rect.w}
              height={rect.h}
              fill={OVERLAY_COLORS.primarySelectionFill}
              stroke="none"
            />
            <rect
              data-testid="svg-overlay-primary-selection-border"
              x={insetX(rect, OVERLAY_BORDER_WIDTH.primary)}
              y={insetY(rect, OVERLAY_BORDER_WIDTH.primary)}
              width={insetW(rect, OVERLAY_BORDER_WIDTH.primary)}
              height={insetH(rect, OVERLAY_BORDER_WIDTH.primary)}
              fill="none"
              stroke={OVERLAY_COLORS.primarySelectionBorder}
              stroke-width={OVERLAY_BORDER_WIDTH.primary}
            />
          </>
        )}
      </Show>

      <Show when={activeCellRect()} keyed>
        {(rect) => (
          <rect
            data-testid="svg-overlay-active-cell"
            x={insetX(rect, OVERLAY_BORDER_WIDTH.active)}
            y={insetY(rect, OVERLAY_BORDER_WIDTH.active)}
            width={insetW(rect, OVERLAY_BORDER_WIDTH.active)}
            height={insetH(rect, OVERLAY_BORDER_WIDTH.active)}
            fill="none"
            stroke={OVERLAY_COLORS.activeCellBorder}
            stroke-width={OVERLAY_BORDER_WIDTH.active}
          />
        )}
      </Show>

      <Show when={primarySelection()} keyed>
        {(rect) => (
          <rect
            data-testid="svg-overlay-fill-handle"
            x={rect.x + rect.w - FILL_HANDLE_SIZE}
            y={rect.y + rect.h - FILL_HANDLE_SIZE}
            width={FILL_HANDLE_SIZE}
            height={FILL_HANDLE_SIZE}
            fill={OVERLAY_COLORS.fillHandle}
            stroke={OVERLAY_COLORS.fillHandleStroke}
            stroke-width={1}
          />
        )}
      </Show>

      <Show when={fillPreviewRect()} keyed>
        {(rect) => (
          <rect
            data-testid="svg-overlay-fill-preview"
            x={insetX(rect, OVERLAY_BORDER_WIDTH.drop)}
            y={insetY(rect, OVERLAY_BORDER_WIDTH.drop)}
            width={insetW(rect, OVERLAY_BORDER_WIDTH.drop)}
            height={insetH(rect, OVERLAY_BORDER_WIDTH.drop)}
            fill="none"
            stroke={OVERLAY_COLORS.dropIndicator}
            stroke-width={OVERLAY_BORDER_WIDTH.drop}
            stroke-dasharray="4 3"
          />
        )}
      </Show>

      <Show when={clipboardSourceRect()} keyed>
        {(rect) => (
          <>
            <rect
              data-testid="svg-overlay-marching-ants-halo"
              x={rect.x}
              y={rect.y}
              width={rect.w}
              height={rect.h}
              fill="none"
              stroke={OVERLAY_COLORS.marchingAntsBg}
              stroke-width={OVERLAY_BORDER_WIDTH.marchingAnts + 1}
            />
            <rect
              class="svg-marching-ants-dash"
              data-testid="svg-overlay-marching-ants-dash"
              x={rect.x}
              y={rect.y}
              width={rect.w}
              height={rect.h}
              fill="none"
              stroke={OVERLAY_COLORS.marchingAnts}
              stroke-width={OVERLAY_BORDER_WIDTH.marchingAnts}
              stroke-dasharray="4 3"
            />
          </>
        )}
      </Show>

      <For each={formulaReferenceRects()}>
        {(rect) => (
          <rect
            data-testid={rect.testId}
            x={rect.x + FORMULA_REF_INSET_HALF}
            y={rect.y + FORMULA_REF_INSET_HALF}
            width={Math.max(0, rect.w - 1)}
            height={Math.max(0, rect.h - 1)}
            fill="none"
            stroke={rect.color}
            stroke-width={FORMULA_REF_STROKE_WIDTH}
            stroke-dasharray="4 2"
          />
        )}
      </For>
    </svg>
  )
}
