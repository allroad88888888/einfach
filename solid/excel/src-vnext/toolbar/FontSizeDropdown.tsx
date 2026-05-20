/** @jsxImportSource solid-js */

import { For, Show, createEffect, onCleanup } from 'solid-js'
import type { JSX } from 'solid-js'

/**
 * Font sizes (in px) offered by the toolbar font-size dropdown. The toolbar
 * A+/A- buttons step through arbitrary integer sizes — they do not snap to
 * this list. The default when no size is set is `DEFAULT_FONT_SIZE`.
 */
export const FONT_SIZE_OPTIONS: readonly number[] = [8, 9, 10, 11, 12, 14, 16, 18, 24, 36, 48]

export const DEFAULT_FONT_SIZE = 12
export const FONT_SIZE_MIN = 1
export const FONT_SIZE_MAX = 72

export interface FontSizeDropdownProps {
  open: boolean
  anchorRect: DOMRect | null
  anchorEl?: HTMLElement | null
  current: number
  onSelect: (size: number) => void
  onClose: () => void
}

export function FontSizeDropdown(props: FontSizeDropdownProps): JSX.Element {
  let rootRef: HTMLDivElement | undefined

  createEffect(() => {
    if (!props.open) return

    function onDocPointerDown(event: MouseEvent) {
      if (!rootRef) return
      const target = event.target as Node | null
      if (target && rootRef.contains(target)) return
      if (target && props.anchorEl && props.anchorEl.contains(target)) return
      props.onClose()
    }

    function onDocKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        props.onClose()
      }
    }

    document.addEventListener('mousedown', onDocPointerDown, true)
    document.addEventListener('keydown', onDocKeyDown)
    onCleanup(() => {
      document.removeEventListener('mousedown', onDocPointerDown, true)
      document.removeEventListener('keydown', onDocKeyDown)
    })
  })

  function style(): JSX.CSSProperties {
    const rect = props.anchorRect
    if (!rect) {
      return { display: 'none' }
    }
    return {
      position: 'fixed',
      top: `${rect.bottom + 2}px`,
      left: `${rect.left}px`,
      'z-index': '500',
      background: '#fff',
      border: '1px solid #d0d0d0',
      'box-shadow': '0 4px 12px rgba(0,0,0,0.12)',
      'min-width': '80px',
      'max-height': '320px',
      'overflow-y': 'auto',
      padding: '4px 0',
    }
  }

  return (
    <Show when={props.open}>
      <div
        ref={(el) => (rootRef = el)}
        class="spreadsheet-toolbar-font-size-dropdown"
        data-testid="toolbar-font-size-dropdown"
        role="menu"
        style={style()}
      >
        <For each={FONT_SIZE_OPTIONS}>
          {(size) => {
            const isActive = size === props.current
            return (
              <button
                type="button"
                class={`spreadsheet-toolbar-font-size-option ${
                  isActive ? 'fmt-btn-active' : ''
                }`.trim()}
                data-testid={`toolbar-font-size-item-${size}`}
                data-font-size={String(size)}
                role="menuitem"
                style={{
                  width: '100%',
                  padding: '4px 12px',
                  'text-align': 'left',
                  background: isActive ? '#f0f0f0' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
                onClick={() => props.onSelect(size)}
              >
                {size}
              </button>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
