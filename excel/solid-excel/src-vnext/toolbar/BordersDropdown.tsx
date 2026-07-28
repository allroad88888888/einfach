import { For, Show, createEffect, onCleanup } from 'solid-js'
import { useT } from '../../src/i18n'

/**
 * Discrete border preset emitted from the toolbar borders dropdown.
 *
 * For multi-cell selections the calling toolbar splits the patch per cell
 * (corner cells get two sides for "outer", etc.). For a single-cell
 * selection "all" and "outer" coincide and "inner" is a no-op.
 */
export type BordersPreset =
  | 'all'
  | 'outer'
  | 'inner'
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'none'

export interface BordersDropdownProps {
  /** Anchored under the toolbar button — the button owns positioning. */
  isOpen: boolean
  /** Multi-cell selection => "inner" is enabled. */
  isMultiCell: boolean
  /** Apply the preset and close the dropdown. */
  onSelect: (preset: BordersPreset) => void
  /** Click outside / Esc requests a close. */
  onRequestClose: () => void
  /**
   * Root anchor element so click-outside ignores clicks on the toolbar button
   * (otherwise the outside-handler races the button's own toggle).
   */
  anchorRef?: HTMLElement | null
}

interface PresetDescriptor {
  preset: BordersPreset
  labelKey: string
  testId: string
  /** When false the option is rendered disabled (e.g. "inner" on 1x1). */
  enabledFor: 'always' | 'multi'
}

const PRESETS: PresetDescriptor[] = [
  { preset: 'all', labelKey: 'toolbar.borders.all', testId: 'toolbar-borders-all', enabledFor: 'always' },
  { preset: 'outer', labelKey: 'toolbar.borders.outer', testId: 'toolbar-borders-outer', enabledFor: 'always' },
  { preset: 'inner', labelKey: 'toolbar.borders.inner', testId: 'toolbar-borders-inner', enabledFor: 'multi' },
  { preset: 'top', labelKey: 'toolbar.borders.top', testId: 'toolbar-borders-top', enabledFor: 'always' },
  { preset: 'right', labelKey: 'toolbar.borders.right', testId: 'toolbar-borders-right', enabledFor: 'always' },
  { preset: 'bottom', labelKey: 'toolbar.borders.bottom', testId: 'toolbar-borders-bottom', enabledFor: 'always' },
  { preset: 'left', labelKey: 'toolbar.borders.left', testId: 'toolbar-borders-left', enabledFor: 'always' },
  { preset: 'none', labelKey: 'toolbar.borders.none', testId: 'toolbar-borders-none', enabledFor: 'always' },
]

export function BordersDropdown(props: BordersDropdownProps) {
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
  // open (canonical toolbar popup pattern, see NumberFormatDropdown). A
  // permanently-attached listener is a landmine: after one open/close cycle
  // `rootRef` points at a detached node, so every later outside mousedown
  // (e.g. inside a sibling popup) called `onRequestClose()` and cleared the
  // shared toolbar surface between mousedown and click — real clicks inside
  // the sibling popup never landed. Pinned by toolbar-number-format e2e
  // ("percent dropdown applies to the selected visible row after sorting").
  createEffect(() => {
    if (!props.isOpen) return
    document.addEventListener('mousedown', onDocPointerDown, true)
    document.addEventListener('keydown', onDocKeyDown)
    onCleanup(() => {
      document.removeEventListener('mousedown', onDocPointerDown, true)
      document.removeEventListener('keydown', onDocKeyDown)
    })
  })

  function isEnabled(descriptor: PresetDescriptor): boolean {
    if (descriptor.enabledFor === 'always') return true
    return props.isMultiCell
  }

  return (
    <Show when={props.isOpen}>
      <div
        ref={rootRef}
        class="spreadsheet-toolbar-borders-dropdown"
        role="menu"
        data-testid="toolbar-borders-dropdown"
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
              class="spreadsheet-toolbar-borders-option"
              role="menuitem"
              data-testid={descriptor.testId}
              disabled={!isEnabled(descriptor)}
              style={{
                padding: '4px 12px',
                'text-align': 'left',
                background: 'transparent',
                border: 'none',
                cursor: isEnabled(descriptor) ? 'pointer' : 'not-allowed',
                opacity: isEnabled(descriptor) ? 1 : 0.5,
                font: 'inherit',
              }}
              onClick={() => {
                if (!isEnabled(descriptor)) return
                props.onSelect(descriptor.preset)
              }}
            >
              {t(descriptor.labelKey)}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
