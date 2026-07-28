import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { Portal } from 'solid-js/web'

/**
 * One entry in a context menu. Either an interactive item (label + onSelect,
 * optionally disabled) or a visual divider rendered as an `<hr>`.
 *
 * Dividers are NOT focusable / clickable — keyboard navigation skips them.
 */
export type ContextMenuItem =
  | { label: string; onSelect: () => void; disabled?: boolean }
  | { divider: true }

export interface ContextMenuProps {
  /** Items + dividers, rendered in order. Empty list still mounts (caller's job to avoid). */
  items: ContextMenuItem[]
  /** Pointer x coord (px, viewport). Menu is clamped to the viewport on mount. */
  x: number
  /** Pointer y coord (px, viewport). */
  y: number
  /** Called when the menu wants to close: outside click, Escape, or item activation. */
  onClose: () => void
}

function isDivider(item: ContextMenuItem): item is { divider: true } {
  return 'divider' in item && item.divider === true
}

/**
 * Reusable right-click menu. Portals to `document.body` so it escapes any
 * overflow-clipped ancestor (the Excel table-wrapper scrolls, which would
 * otherwise hide the menu).
 *
 * Behaviour contract:
 *   - Outside click → onClose
 *   - Escape → onClose
 *   - ArrowDown / ArrowUp → cycle highlight over enabled items (skips dividers + disabled)
 *   - Enter → activate highlighted item
 *   - Item click → activate that item (+ close)
 *   - Position clamped to viewport so the menu never overflows the right/bottom edges
 */
export function ContextMenu(props: ContextMenuProps) {
  // Pre-compute the indices of items that can receive keyboard focus.
  // Dividers and disabled entries are skipped during ArrowUp/Down cycling.
  const focusableIndices = () => {
    const out: number[] = []
    props.items.forEach((it, i) => {
      if (isDivider(it)) return
      if (it.disabled) return
      out.push(i)
    })
    return out
  }

  const [highlight, setHighlight] = createSignal<number>(-1)
  const [pos, setPos] = createSignal({ x: props.x, y: props.y })
  let menuEl: HTMLDivElement | undefined

  /** Measure the rendered menu and pin its top-left so right/bottom edges
   * never overflow the viewport. Called after layout (onMount + every time
   * the trigger coords change). The previous version of the second
   * effect just re-applied the raw (props.x, props.y), which silently
   * wiped onMount's clamp and let bottom-of-page triggers (sheet-tab
   * right-click) push the menu off-screen — fixed by routing both code
   * paths through this single function. */
  function clampToViewport() {
    if (!menuEl) return
    const rect = menuEl.getBoundingClientRect()
    const vw = typeof window !== 'undefined' ? window.innerWidth : rect.right
    const vh = typeof window !== 'undefined' ? window.innerHeight : rect.bottom
    const PAD = 4
    let nx = props.x
    let ny = props.y
    if (nx + rect.width + PAD > vw) nx = Math.max(PAD, vw - rect.width - PAD)
    if (ny + rect.height + PAD > vh) ny = Math.max(PAD, vh - rect.height - PAD)
    setPos({ x: nx, y: ny })
  }

  onMount(clampToViewport)

  // Re-clamp when x/y change while the menu is open (rare — the host
  // usually unmounts + remounts on a new right-click, but cheap to handle).
  createEffect(() => {
    // Read both deps so Solid tracks them.
    void props.x
    void props.y
    clampToViewport()
  })

  function activate(idx: number) {
    const item = props.items[idx]
    if (!item || isDivider(item) || item.disabled) return
    item.onSelect()
    props.onClose()
  }

  function onDocumentMouseDown(e: MouseEvent) {
    if (!menuEl) return
    if (menuEl.contains(e.target as Node)) return
    props.onClose()
  }

  function onDocumentKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      props.onClose()
      return
    }
    const focusable = focusableIndices()
    if (focusable.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const cur = highlight()
      const curPos = focusable.indexOf(cur)
      const nextPos = curPos < 0 ? 0 : (curPos + 1) % focusable.length
      setHighlight(focusable[nextPos])
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const cur = highlight()
      const curPos = focusable.indexOf(cur)
      const nextPos =
        curPos < 0 ? focusable.length - 1 : (curPos - 1 + focusable.length) % focusable.length
      setHighlight(focusable[nextPos])
    } else if (e.key === 'Enter') {
      const cur = highlight()
      if (cur >= 0) {
        e.preventDefault()
        activate(cur)
      }
    }
  }

  onMount(() => {
    // mousedown (not click) so the close fires before any click-handler on
    // the cell beneath the menu — matters for cell selection consistency.
    document.addEventListener('mousedown', onDocumentMouseDown, true)
    document.addEventListener('keydown', onDocumentKeyDown, true)
  })

  onCleanup(() => {
    document.removeEventListener('mousedown', onDocumentMouseDown, true)
    document.removeEventListener('keydown', onDocumentKeyDown, true)
  })

  return (
    <Portal mount={typeof document !== 'undefined' ? document.body : undefined}>
      <div
        ref={menuEl}
        class="context-menu"
        role="menu"
        style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
        // Trap contextmenu inside the menu — otherwise right-clicking on the
        // menu itself would re-trigger the browser's native menu.
        onContextMenu={(e) => e.preventDefault()}
      >
        <For each={props.items}>
          {(item, i) => (
            <Show
              when={!isDivider(item)}
              fallback={<hr class="context-menu-divider" />}
            >
              {(() => {
                const it = item as { label: string; onSelect: () => void; disabled?: boolean }
                const isHighlighted = () => highlight() === i()
                return (
                  <button
                    type="button"
                    role="menuitem"
                    class={`context-menu-item ${isHighlighted() ? 'context-menu-item-highlight' : ''}`}
                    disabled={it.disabled}
                    onMouseEnter={() => setHighlight(i())}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      activate(i())
                    }}
                  >
                    {it.label}
                  </button>
                )
              })()}
            </Show>
          )}
        </For>
      </div>
    </Portal>
  )
}
