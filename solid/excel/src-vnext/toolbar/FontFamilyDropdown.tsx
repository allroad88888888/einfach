/** @jsxImportSource solid-js */

import { For, Show, createEffect, onCleanup } from 'solid-js'
import type { JSX } from 'solid-js'

/**
 * Catalog of font families offered by the toolbar font-family dropdown.
 * The first entry, Arial, is the implicit default when a cell has no
 * `format.fontFamily` set — the toolbar reflects that in its button label.
 */
export const FONT_FAMILY_OPTIONS: readonly string[] = [
  'Arial',
  'Calibri',
  'Helvetica',
  'Times New Roman',
  'Courier New',
  'Verdana',
  'Georgia',
  'SF Pro',
  '微软雅黑',
  '宋体',
  '黑体',
]

export const DEFAULT_FONT_FAMILY = 'Arial'

export interface FontFamilyDropdownProps {
  open: boolean
  /** Absolute viewport rect of the toolbar anchor button. */
  anchorRect: DOMRect | null
  /** Anchor element — clicks on it are ignored by the click-outside handler. */
  anchorEl?: HTMLElement | null
  /** Currently selected family (used to mark the active row). */
  current: string
  onSelect: (family: string) => void
  onClose: () => void
}

export function FontFamilyDropdown(props: FontFamilyDropdownProps): JSX.Element {
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
      'min-width': '160px',
      'max-height': '320px',
      'overflow-y': 'auto',
      padding: '4px 0',
    }
  }

  return (
    <Show when={props.open}>
      <div
        ref={(el) => (rootRef = el)}
        class="spreadsheet-toolbar-font-family-dropdown"
        data-testid="toolbar-font-family-dropdown"
        role="menu"
        style={style()}
      >
        <For each={FONT_FAMILY_OPTIONS}>
          {(family) => {
            const isActive = family === props.current
            return (
              <button
                type="button"
                class={`spreadsheet-toolbar-font-family-option ${
                  isActive ? 'fmt-btn-active' : ''
                }`.trim()}
                data-testid={`toolbar-font-family-item-${family}`}
                data-font-family={family}
                role="menuitem"
                style={{
                  width: '100%',
                  padding: '4px 12px',
                  'text-align': 'left',
                  background: isActive ? '#f0f0f0' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  font: 'inherit',
                  'font-family': family,
                }}
                onClick={() => props.onSelect(family)}
              >
                {family}
              </button>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
