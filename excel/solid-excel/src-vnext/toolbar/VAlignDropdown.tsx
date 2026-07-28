import { For, Show, createEffect, onCleanup } from 'solid-js'
import { useT } from '../../src/i18n'

/**
 * Discrete vertical alignment value emitted from the toolbar v-align
 * dropdown. Maps 1:1 onto the `'vertical-alignment'` toolbar command value
 * contract (`'top' | 'center' | 'bottom'`).
 */
export type VAlignValue = 'top' | 'center' | 'bottom'

export interface VAlignDropdownProps {
  /** Anchored under the toolbar button — the button owns positioning. */
  isOpen: boolean
  /** Currently active v-align on the focused cell, for the depressed row. */
  current: VAlignValue
  /** Apply the alignment and close the dropdown. */
  onSelect: (value: VAlignValue) => void
  /** Click outside / Esc requests a close. */
  onRequestClose: () => void
  /**
   * Root anchor element so click-outside ignores clicks on the toolbar button
   * (otherwise the outside-handler races the button's own toggle).
   */
  anchorRef?: HTMLElement | null
}

interface OptionDescriptor {
  value: VAlignValue
  labelKey: string
  testId: string
}

const OPTIONS: OptionDescriptor[] = [
  { value: 'top', labelKey: 'toolbar.verticalAlignTop', testId: 'toolbar-v-align-top' },
  { value: 'center', labelKey: 'toolbar.verticalAlignMiddle', testId: 'toolbar-v-align-middle' },
  { value: 'bottom', labelKey: 'toolbar.verticalAlignBottom', testId: 'toolbar-v-align-bottom' },
]

export function VAlignDropdown(props: VAlignDropdownProps) {
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
        class="spreadsheet-toolbar-v-align-dropdown"
        role="menu"
        data-testid="toolbar-v-align-dropdown"
        style={{
          position: 'absolute',
          top: '100%',
          left: '0',
          'z-index': 30,
          'min-width': '120px',
          background: '#fff',
          border: '1px solid #d0d0d0',
          'box-shadow': '0 4px 12px rgba(0,0,0,0.12)',
          display: 'flex',
          'flex-direction': 'column',
          padding: '4px 0',
        }}
      >
        <For each={OPTIONS}>
          {(descriptor) => {
            const isActive = () => props.current === descriptor.value
            return (
              <button
                type="button"
                class="spreadsheet-toolbar-v-align-option"
                role="menuitem"
                data-testid={descriptor.testId}
                aria-pressed={isActive()}
                style={{
                  padding: '4px 12px',
                  'text-align': 'left',
                  background: isActive() ? '#eef3ff' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
                onClick={() => props.onSelect(descriptor.value)}
              >
                {t(descriptor.labelKey)}
              </button>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
