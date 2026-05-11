
import { createEffect, createSignal, For, on, Show } from 'solid-js'
import { Cell } from './Cell'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { FormatToolbar } from './FormatToolbar'
import { FormulaBar } from './FormulaBar'
import { addrToCoord, clampCoord, colToLetter, coordToAddr, type CellCoord } from './selection'
import {
  parseClipboardTSV,
  serializeClipboardTSV,
  type SheetStore,
} from './sheet-store'

export interface TableProps {
  store: SheetStore
  rows?: number
  cols?: number
  /** Render an Excel-style formula bar above the grid. */
  formulaBar?: boolean
  /** Render the Phase 6 format toolbar above the grid (Bold/Italic/Align/
   *  Number-format/Background/Text-color). Opt-in like `formulaBar`. */
  toolbar?: boolean
  /**
   * Render only the rows visible inside the scroll viewport (plus a small
   * overscan). Opt-in — default off keeps the original "render every row"
   * behavior for tiny tables where the DOM cost is irrelevant and tests
   * assert on every cell being present. For grids over a few hundred rows
   * pass `virtualize` so the DOM stays bounded.
   */
  virtualize?: boolean
}

/** Row height in CSS pixels — must match `.excel-table td { height: 26px }`
 * in styles.css. Used to translate scrollTop ↔ row index for windowing. */
const ROW_HEIGHT = 26

/** Rows rendered outside the visible viewport on each side. Hides the
 * "blank flash" during fast scrolls without inflating the DOM. */
const OVERSCAN = 4

/** Build cell address from row/col: (0,0)→"A1" */
function cellAddr(row: number, col: number): string {
  return coordToAddr({ row, col })
}

export function Table(props: TableProps) {
  const rows = () => props.rows ?? 20
  const cols = () => props.cols ?? 10

  const colIndices = () => Array.from({ length: cols() }, (_, i) => i)

  // === Row virtualization ===
  // `scrollTop` / `viewportH` drive the visible window. Both are 0 until the
  // wrapper mounts + its first onScroll / measurement; that's fine because
  // the initial `visibleRowEnd` then falls back to `min(rows, OVERSCAN +
  // initial_visible)` — see `visibleRange()` below.
  let wrapperEl: HTMLDivElement | undefined
  const [scrollTop, setScrollTop] = createSignal(0)
  const [viewportH, setViewportH] = createSignal(0)

  /** [start, end) window of row indices to render. Inclusive overscan on
   *  both sides. Falls back to "all rows" when virtualization is off. */
  function visibleRange(): [number, number] {
    if (!props.virtualize) return [0, rows()]
    const top = scrollTop()
    const h = viewportH() || rows() * ROW_HEIGHT // pre-mount: render all
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN)
    const visible = Math.ceil(h / ROW_HEIGHT)
    const last = Math.min(rows(), first + visible + OVERSCAN * 2)
    return [first, last]
  }

  /** The window expanded to an inclusive array of indices for `<For>`. */
  const rowIndices = () => {
    const [start, end] = visibleRange()
    const out = new Array<number>(end - start)
    for (let i = 0; i < out.length; i++) out[i] = start + i
    return out
  }

  /** Heights of the top / bottom spacer rows that keep total scroll height
   *  equal to `rows * ROW_HEIGHT` even though we only render the window. */
  const topPad = () => visibleRange()[0] * ROW_HEIGHT
  const botPad = () => (rows() - visibleRange()[1]) * ROW_HEIGHT

  // Selection lives on the store so FormulaBar / future copy-paste / right-
  // click menus all read & write the same source of truth.
  const selected = () => props.store.selection()
  const range = () => props.store.selectionRange()

  function selectCoord(next: CellCoord) {
    props.store.setSelection(clampCoord(next, rows(), cols()))
  }

  function extendCoord(next: CellCoord) {
    props.store.extendSelection(clampCoord(next, rows(), cols()))
  }

  function move(drow: number, dcol: number, extend = false) {
    const cur = selected()
    const next = { row: cur.row + drow, col: cur.col + dcol }
    if (extend) extendCoord(next)
    else selectCoord(next)
  }

  /** Keep the focus cell inside the visible window when arrow-keys / paste
   * push it off-screen. No-op when virtualization is off (the cell is
   * always in the DOM and the browser's own focus scroll suffices). */
  createEffect(
    on(
      () => selected().row,
      (row) => {
        if (!props.virtualize || !wrapperEl) return
        // Header occupies the top ~ROW_HEIGHT; offset so the focus cell
        // doesn't land flush under the sticky header.
        const top = row * ROW_HEIGHT
        const headerH = ROW_HEIGHT
        const viewTop = wrapperEl.scrollTop
        const viewBot = viewTop + wrapperEl.clientHeight - headerH
        if (top < viewTop) wrapperEl.scrollTop = top
        else if (top + ROW_HEIGHT > viewBot)
          wrapperEl.scrollTop = top + ROW_HEIGHT - wrapperEl.clientHeight + headerH
      },
    ),
  )

  // Ctrl+C / Ctrl+V handlers — extracted from onKeyDown to keep that switch
  // small and to allow direct unit-call from tests if needed later.
  async function handleCopy(e: KeyboardEvent) {
    e.preventDefault()
    const addrs = props.store.selectionAddrs()
    const data = props.store.copy(addrs)
    const text = serializeClipboardTSV(data)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // No clipboard permission / not in a secure context. Silently swallow
      // — there's nothing user-actionable we can surface from here, and a
      // thrown error would crash the keydown handler.
    }
  }

  async function handlePaste(e: KeyboardEvent) {
    e.preventDefault()
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      return
    }
    if (text === '') return
    const target = coordToAddr(selected())
    // Origin defaults to the paste target so foreign clipboards (no marker)
    // paste literally without shifting refs.
    const data = parseClipboardTSV(text, target)
    props.store.paste(target, data)
  }

  async function handleCut(e: KeyboardEvent) {
    await handleCopy(e)
    const addrs = props.store.selectionAddrs()
    props.store.beginEdit()
    for (const row of addrs) {
      for (const addr of row) props.store.clearCell(addr)
    }
    props.store.endEdit()
  }

  // === Context menu state ===
  // Only one menu visible at a time — opening a second context-menu trigger
  // closes the previous via the same signal slot.
  const [menu, setMenu] = createSignal<{
    x: number
    y: number
    items: ContextMenuItem[]
  } | null>(null)

  function openMenu(e: MouseEvent, items: ContextMenuItem[]) {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  function closeMenu() {
    setMenu(null)
  }

  // --- Mouse-driven equivalents of handleCopy/handlePaste/handleCut for the
  // cell menu. Same semantics, just no KeyboardEvent.preventDefault to worry
  // about. The keyboard handlers stay the source of truth for shortcuts.
  async function ctxCopy() {
    const addrs = props.store.selectionAddrs()
    const data = props.store.copy(addrs)
    const text = serializeClipboardTSV(data)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // No clipboard permission — same swallow as the keyboard handler.
    }
  }

  async function ctxPaste() {
    let text = ''
    try {
      text = await navigator.clipboard.readText()
    } catch {
      return
    }
    if (text === '') return
    const target = coordToAddr(selected())
    const data = parseClipboardTSV(text, target)
    props.store.paste(target, data)
  }

  async function ctxCut() {
    await ctxCopy()
    const addrs = props.store.selectionAddrs()
    props.store.beginEdit()
    for (const row of addrs) {
      for (const addr of row) props.store.clearCell(addr)
    }
    props.store.endEdit()
  }

  function ctxClearSelection() {
    const addrs = props.store.selectionAddrs()
    props.store.beginEdit()
    for (const row of addrs) {
      for (const addr of row) props.store.clearCell(addr)
    }
    props.store.endEdit()
  }

  function clearColumn(col: number) {
    props.store.beginEdit()
    for (let r = 0; r < rows(); r++) {
      props.store.clearCell(coordToAddr({ row: r, col }))
    }
    props.store.endEdit()
  }

  function clearRow(row: number) {
    props.store.beginEdit()
    for (let c = 0; c < cols(); c++) {
      props.store.clearCell(coordToAddr({ row, col: c }))
    }
    props.store.endEdit()
  }

  function colMenuItems(col: number): ContextMenuItem[] {
    return [
      { label: 'Insert column before', onSelect: () => props.store.insertCol(col, 1) },
      { label: 'Insert column after', onSelect: () => props.store.insertCol(col + 1, 1) },
      { label: 'Delete column', onSelect: () => props.store.deleteCol(col, 1) },
      { label: 'Clear column', onSelect: () => clearColumn(col) },
    ]
  }

  function rowMenuItems(row: number): ContextMenuItem[] {
    return [
      { label: 'Insert row above', onSelect: () => props.store.insertRow(row, 1) },
      { label: 'Insert row below', onSelect: () => props.store.insertRow(row + 1, 1) },
      { label: 'Delete row', onSelect: () => props.store.deleteRow(row, 1) },
      { label: 'Clear row', onSelect: () => clearRow(row) },
    ]
  }

  function cellMenuItems(addr: string): ContextMenuItem[] {
    const coord = addrToCoord(addr) ?? { row: 0, col: 0 }
    return [
      { label: 'Cut', onSelect: () => void ctxCut() },
      { label: 'Copy', onSelect: () => void ctxCopy() },
      { label: 'Paste', onSelect: () => void ctxPaste() },
      { label: 'Clear', onSelect: () => ctxClearSelection() },
      { divider: true },
      { label: 'Insert row above', onSelect: () => props.store.insertRow(coord.row, 1) },
      { label: 'Insert row below', onSelect: () => props.store.insertRow(coord.row + 1, 1) },
      { label: 'Insert column before', onSelect: () => props.store.insertCol(coord.col, 1) },
      { label: 'Insert column after', onSelect: () => props.store.insertCol(coord.col + 1, 1) },
    ]
  }

  function onKeyDown(e: KeyboardEvent) {
    // Skip if the user is editing inside a Cell input — Cell's own handler
    // owns Enter / Escape / arrow semantics during edit.
    const target = e.target as HTMLElement | null
    if (target && target.tagName === 'INPUT') return

    const meta = e.ctrlKey || e.metaKey
    if (meta) {
      // Undo / redo. Cmd/Ctrl + Z = undo; + Shift+Z or + Y = redo.
      if (e.key === 'z' || e.key === 'Z') {
        if (e.shiftKey) {
          props.store.redo()
        } else {
          props.store.undo()
        }
        e.preventDefault()
        return
      }
      if (e.key === 'y' || e.key === 'Y') {
        props.store.redo()
        e.preventDefault()
        return
      }
      if (e.key === 'c' || e.key === 'C') {
        void handleCopy(e)
        return
      }
      if (e.key === 'v' || e.key === 'V') {
        void handlePaste(e)
        return
      }
      if (e.key === 'x' || e.key === 'X') {
        void handleCut(e)
        return
      }
    }

    switch (e.key) {
      case 'ArrowUp':
        move(-1, 0, e.shiftKey)
        e.preventDefault()
        break
      case 'ArrowDown':
        move(1, 0, e.shiftKey)
        e.preventDefault()
        break
      case 'ArrowLeft':
        move(0, -1, e.shiftKey)
        e.preventDefault()
        break
      case 'ArrowRight':
        move(0, 1, e.shiftKey)
        e.preventDefault()
        break
      case 'Tab':
        // Tab always collapses — that's the spreadsheet convention even
        // when shift is held (Shift+Tab moves backward, doesn't extend).
        move(0, e.shiftKey ? -1 : 1)
        e.preventDefault()
        break
      case 'Delete':
      case 'Backspace': {
        // Clear every cell in the selection range. Routed through SheetStore
        // so undo collapses to one entry via beginEdit/endEdit.
        const addrs = props.store.selectionAddrs()
        props.store.beginEdit()
        for (const row of addrs) {
          for (const addr of row) props.store.clearCell(addr)
        }
        props.store.endEdit()
        e.preventDefault()
        break
      }
      // Enter / F2 / typing-into-cell are not handled here yet — those go
      // through Cell's edit-mode entry. ROADMAP 1B follow-up.
    }
  }

  /** Total column count in the body (incl. row-header). Needed by the spacer
   * `<td colspan>` so the spacer row collapses to a single empty cell that
   * still spans the table width visually. */
  const totalBodyCols = () => cols() + 1

  return (
    <div
      class="excel-table-wrapper"
      tabIndex={0}
      onKeyDown={onKeyDown}
      ref={(el) => {
        wrapperEl = el
        // Capture initial viewport height; updates flow through onScroll +
        // a ResizeObserver below.
        setViewportH(el.clientHeight)
        if (typeof ResizeObserver !== 'undefined') {
          const ro = new ResizeObserver(() => setViewportH(el.clientHeight))
          ro.observe(el)
        }
      }}
      onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
    >
      <Show when={props.toolbar}>
        <FormatToolbar store={props.store} />
      </Show>
      <Show when={props.formulaBar}>
        <FormulaBar store={props.store} />
      </Show>
      <table class="excel-table">
        <thead>
          <tr>
            <th class="row-header"></th>
            <For each={colIndices()}>
              {(col) => (
                <th
                  class="col-header"
                  onContextMenu={(e) => openMenu(e, colMenuItems(col))}
                >
                  {colToLetter(col)}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <Show when={props.virtualize && topPad() > 0}>
            <tr class="virt-spacer" aria-hidden="true">
              <td colSpan={totalBodyCols()} style={{ height: `${topPad()}px`, padding: 0 }} />
            </tr>
          </Show>
          <For each={rowIndices()}>
            {(row) => (
              <tr>
                <td
                  class="row-header"
                  onContextMenu={(e) => openMenu(e, rowMenuItems(row))}
                >
                  {row + 1}
                </td>
                <For each={colIndices()}>
                  {(col) => {
                    const isSelected = () =>
                      selected().row === row && selected().col === col
                    // Cheap rectangle hit-test against the normalized
                    // anchor/focus rect. Recomputed per access — the
                    // surrounding `range()` accessor is the signal
                    // subscription, so Solid only rerenders the class
                    // string per cell, not the whole row.
                    const isInRange = () => {
                      const r = range()
                      const r0 = Math.min(r.anchor.row, r.focus.row)
                      const r1 = Math.max(r.anchor.row, r.focus.row)
                      const c0 = Math.min(r.anchor.col, r.focus.col)
                      const c1 = Math.max(r.anchor.col, r.focus.col)
                      return row >= r0 && row <= r1 && col >= c0 && col <= c1
                    }
                    const addr = cellAddr(row, col)
                    return (
                      <Cell
                        addr={addr}
                        store={props.store}
                        selected={isSelected}
                        inRange={isInRange}
                        onSelect={() => selectCoord({ row, col })}
                        onExtendSelect={() => extendCoord({ row, col })}
                        onContextMenu={(e) => {
                          // Move selection to this cell first so Cut / Copy
                          // / Paste / Clear act on what the user right-
                          // clicked, matching spreadsheet convention.
                          selectCoord({ row, col })
                          openMenu(e, cellMenuItems(addr))
                        }}
                      />
                    )
                  }}
                </For>
              </tr>
            )}
          </For>
          <Show when={props.virtualize && botPad() > 0}>
            <tr class="virt-spacer" aria-hidden="true">
              <td colSpan={totalBodyCols()} style={{ height: `${botPad()}px`, padding: 0 }} />
            </tr>
          </Show>
        </tbody>
      </table>
      <Show when={menu()}>
        {(m) => (
          <ContextMenu
            items={m().items}
            x={m().x}
            y={m().y}
            onClose={closeMenu}
          />
        )}
      </Show>
    </div>
  )
}
