import { For, Show, createEffect, onCleanup } from 'solid-js'
import type { SpreadsheetRotation } from '@einfach/spreadsheet-ui-core'
import { useT } from '../../src/i18n'

/**
 * Discrete rotation preset emitted from the toolbar rotation dropdown.
 *
 * Numeric values are degrees in `[-90, 90]`; `'vertical'` switches the cell
 * to CSS writing-mode for character-stacked text.
 */
export type RotationPreset = SpreadsheetRotation

export interface RotationDropdownProps {
  /** Anchored under the toolbar button — the button owns positioning. */
  isOpen: boolean
  /** Apply the preset and close the dropdown. */
  onSelect: (preset: RotationPreset) => void
  /** Click outside / Esc requests a close. */
  onRequestClose: () => void
  /**
   * Root anchor element so click-outside ignores clicks on the toolbar button
   * (otherwise the outside-handler races the button's own toggle).
   */
  anchorRef?: HTMLElement | null
}

interface PresetDescriptor {
  preset: RotationPreset
  labelKey: string
  testId: string
}

const PRESETS: PresetDescriptor[] = [
  { preset: 0, labelKey: 'toolbar.rotation.0', testId: 'toolbar-rotation-0' },
  { preset: 45, labelKey: 'toolbar.rotation.45', testId: 'toolbar-rotation-45' },
  { preset: 90, labelKey: 'toolbar.rotation.90', testId: 'toolbar-rotation-90' },
  { preset: -45, labelKey: 'toolbar.rotation.-45', testId: 'toolbar-rotation-neg45' },
  { preset: -90, labelKey: 'toolbar.rotation.-90', testId: 'toolbar-rotation-neg90' },
  { preset: 'vertical', labelKey: 'toolbar.rotation.vertical', testId: 'toolbar-rotation-vertical' },
]

export function RotationDropdown(props: RotationDropdownProps) {
  const t = useT()
  let rootRef: HTMLDivElement | undefined

  function onDocPointerDown(event: MouseEvent) {
    if (!rootRef) return
    const target = event.target as Node | null
    if (!target) return
    if (rootRef.contains(target)) return
    if (props.anchorRef && props.anchorRef.contains(target)) return
    props.onRequestClose()
  }

  function onDocKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      props.onRequestClose()
    }
  }

  // Attach the document-level dismiss listeners only while the dropdown is
  // open — see BordersDropdown for the stale-`rootRef` failure mode this
  // gating prevents.
  createEffect(() => {
    if (!props.isOpen) return
    document.addEventListener('mousedown', onDocPointerDown, true)
    document.addEventListener('keydown', onDocKeyDown)
    onCleanup(() => {
      document.removeEventListener('mousedown', onDocPointerDown, true)
      document.removeEventListener('keydown', onDocKeyDown)
    })
  })

  return (
    <Show when={props.isOpen}>
      <div
        ref={rootRef}
        class="spreadsheet-toolbar-rotation-dropdown"
        role="menu"
        data-testid="toolbar-rotation-dropdown"
        style={{
          position: 'absolute',
          top: '100%',
          left: '0',
          'z-index': 30,
          'min-width': '140px',
          background: '#fff',
          border: '1px solid #d0d0d0',
          'box-shadow': '0 4px 12px rgba(0,0,0,0.12)',
          display: 'flex',
          'flex-direction': 'column',
          padding: '4px 0',
        }}
      >
        <For each={PRESETS}>
          {(descriptor) => (
            <button
              type="button"
              class="spreadsheet-toolbar-rotation-option"
              role="menuitem"
              data-testid={descriptor.testId}
              style={{
                padding: '4px 12px',
                'text-align': 'left',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                font: 'inherit',
              }}
              onClick={() => props.onSelect(descriptor.preset)}
            >
              {t(descriptor.labelKey)}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
