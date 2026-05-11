
import { createSignal, Show } from 'solid-js'
import type { SheetStore } from './sheet-store'

/**
 * Render-count probe gate. When the page URL has `?debug=1` (or
 * `?debug=render` for clarity), Cells emit a `data-render-count` attribute
 * incremented every time the display path runs. Used by render-counter
 * e2e to assert "writing A1 made B1 re-render exactly once". Off in
 * production / normal demo use — no observable runtime cost when the
 * query param is absent (the JSX still wraps a span but the attr stays
 * undefined, so Solid emits no DOM mutation for it).
 *
 * Computed once per page load — the URL doesn't change without a reload.
 */
const RENDER_COUNT_DEBUG = (() => {
  if (typeof window === 'undefined') return false
  const debug = new URLSearchParams(window.location.search).get('debug')
  return debug === '1' || debug === 'render'
})()

export interface CellProps {
  addr: string
  store: SheetStore
  /** Reactive accessor — true when this cell is the active selection. */
  selected?: () => boolean
  /**
   * Reactive accessor — true when this cell is part of the current
   * selection range but is NOT the focus cell. Mutually exclusive with
   * `selected` (the focus cell wins so its outline stays distinct).
   */
  inRange?: () => boolean
  /** Called on click to request selection of this cell. */
  onSelect?: () => void
  /** Called on shift+click to extend the range to this cell. */
  onExtendSelect?: () => void
  /** Called on right-click for the cell context menu. */
  onContextMenu?: (e: MouseEvent) => void
}

export function Cell(props: CellProps) {
  const [editing, setEditing] = createSignal(false)
  const [editValue, setEditValue] = createSignal('')

  // Render-counter probe state. Bumped on every cellValue() read, which
  // matches Solid's JSX re-evaluation cadence for this Cell. Closure-local
  // (one counter per Cell instance, not shared).
  let renderCount = 0
  function nextRenderCount() {
    renderCount += 1
    return renderCount
  }

  const cellValue = () => props.store.getCell(props.addr)
  const isSelected = () => (props.selected ? props.selected() : false)
  const isInRange = () => (props.inRange ? props.inRange() : false)
  // Reading cellValue() here is the load-bearing line: it subscribes this
  // accessor to the per-cell tick signal so Solid re-runs renderCountAttr
  // whenever the cell's display would update. Without the dep tracking,
  // the attribute reads "1" forever even as the visible text mutates,
  // because Solid's fine-grained reactivity only re-evaluates accessors
  // that touched a signal.
  const renderCountAttr = () => {
    if (!RENDER_COUNT_DEBUG) return undefined
    cellValue() // dep: re-run on every display update
    return String(nextRenderCount())
  }

  function startEditing() {
    // For formula cells, edit the source formula (`=A1*2`) instead of the
    // computed result (`20`). Without this the formula is silently replaced
    // by a static value on commit (D.11).
    const formula = props.store.getFormula(props.addr)
    setEditValue(formula !== '' ? formula : cellValue().display)
    setEditing(true)
  }

  function commitEdit() {
    // Enter handler calls commit + sets editing=false → unmounts the input,
    // which fires onBlur, which would call commit a second time. Guard with
    // an editing-state check so the second call is a no-op. Fixes TODO 1.2.1
    // (each user keystroke produces one undo entry, not two).
    if (!editing()) return
    props.store.setCellInput(props.addr, editValue())
    setEditing(false)
  }

  function cancelEdit() {
    // Same blur-after-unmount race: set editing=false BEFORE the input loses
    // focus so the onBlur handler's commitEdit short-circuits.
    setEditing(false)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      commitEdit()
    } else if (e.key === 'Escape') {
      cancelEdit()
    }
  }

  function classes() {
    const v = cellValue()
    const sel = isSelected()
    return [
      'cell',
      `cell-${v.type}`,
      v.isError ? 'cell-error' : '',
      sel ? 'cell-selected' : '',
      // Focus cell wins — only draw the lighter range tint on non-focus
      // cells so the outline on the focus cell stays visually distinct.
      !sel && isInRange() ? 'cell-in-range' : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  /**
   * Per-cell inline style — applied to the <td>. Reads the cell's effective
   * format (base + first matching conditional rule). The leading
   * `cellValue()` read is load-bearing: it subscribes this accessor to the
   * per-cell tick signal so style updates flow alongside value updates
   * (set_format fires the same address listener as set_cell).
   */
  function cellStyle() {
    cellValue() // dep: re-run when value OR format changes for this addr
    const fmt = props.store.getEffectiveFormat(props.addr)
    const style: Record<string, string> = {}
    if (fmt.bgColor) style['background'] = fmt.bgColor
    if (fmt.fgColor) style['color'] = fmt.fgColor
    if (fmt.bold) style['font-weight'] = '700'
    if (fmt.italic) style['font-style'] = 'italic'
    if (fmt.align && fmt.align !== 'default') style['text-align'] = fmt.align
    if (fmt.fontSize) style['font-size'] = `${fmt.fontSize}px`
    return style
  }

  function onClick(e: MouseEvent) {
    if (e.shiftKey && props.onExtendSelect) {
      props.onExtendSelect()
    } else {
      props.onSelect?.()
    }
  }

  return (
    <td
      class={classes()}
      style={cellStyle()}
      data-cell-addr={props.addr}
      onClick={onClick}
      onDblClick={startEditing}
      onContextMenu={(e) => props.onContextMenu?.(e)}
    >
      <Show
        when={editing()}
        fallback={
          <span class="cell-display" data-render-count={renderCountAttr()}>
            {cellValue().display}
          </span>
        }
      >
        <input
          class="cell-input"
          value={editValue()}
          onInput={(e) => setEditValue(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          onBlur={commitEdit}
          ref={(el) => setTimeout(() => el.focus(), 0)}
        />
      </Show>
    </td>
  )
}
