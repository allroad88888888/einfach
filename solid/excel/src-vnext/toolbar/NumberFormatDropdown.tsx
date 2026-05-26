/** @jsxImportSource solid-js */

import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import type { JSX } from 'solid-js'
import { useT } from '../../src/i18n'

/**
 * Stable identifier for each row in the number-format dropdown. The toolbar's
 * `commandFormat` switch maps these back to a `SpreadsheetNumberFormat`. Custom
 * (`'Custom'`) is a sentinel row: hovering or clicking it reveals the
 * right-side submenu for the lightweight format dialogs.
 *
 * `WanYuan` is reserved for the CN-specific 10000-unit format. The current
 * `SpreadsheetNumberFormat` union has no first-class kind for it and our
 * custom-pattern scaler does not support the `/10000` divisor cleanly, so
 * the row renders disabled until Wave 6.x adds the variant.
 */
export type NumberFormatId =
  | 'Auto'
  | 'Text'
  | 'Number'
  | 'Percent'
  | 'Scientific'
  | 'NumberThousands'
  | 'Accounting'
  | 'WanYuan'
  | 'Currency'
  | 'DateShort'
  | 'DateLong'
  | 'Time12'
  | 'Time24'
  | 'DateTime12'
  | 'DateTime24'
  | 'Custom'

export interface NumberFormatDropdownItem {
  id: NumberFormatId
  /** i18n key for the left-column label. */
  labelKey: string
  /** Pre-formatted preview string shown in the right column. */
  preview: string
  /** When set, the row is rendered disabled. */
  disabled?: boolean
}

export type NumberFormatCustomMenuId = 'currency' | 'dateTime' | 'number'

interface NumberFormatCustomMenuItem {
  id: NumberFormatCustomMenuId
  labelKey: string
  testId: string
}

const CUSTOM_FORMAT_ITEMS: readonly NumberFormatCustomMenuItem[] = [
  {
    id: 'currency',
    labelKey: 'numberFormatDropdown.customCurrency',
    testId: 'number-format-more-currency',
  },
  {
    id: 'dateTime',
    labelKey: 'numberFormatDropdown.customDateTime',
    testId: 'number-format-more-date-time',
  },
  {
    id: 'number',
    labelKey: 'numberFormatDropdown.customNumber',
    testId: 'number-format-more-number',
  },
]

/**
 * The 16-row catalog, in the order shown in the reference image. Previews are
 * inline literals (not derived from the engine) so the dropdown stays free of
 * a per-row evaluation pass.
 */
export const NUMBER_FORMAT_ITEMS: readonly NumberFormatDropdownItem[] = [
  { id: 'Auto', labelKey: 'numberFormatDropdown.auto', preview: '' },
  { id: 'Text', labelKey: 'numberFormatDropdown.text', preview: '' },
  { id: 'Number', labelKey: 'numberFormatDropdown.number', preview: '1000.12' },
  { id: 'Percent', labelKey: 'numberFormatDropdown.percent', preview: '12.21%' },
  { id: 'Scientific', labelKey: 'numberFormatDropdown.scientific', preview: '1.01E+5' },
  {
    id: 'NumberThousands',
    labelKey: 'numberFormatDropdown.numberThousands',
    preview: '1,234.56',
  },
  { id: 'Accounting', labelKey: 'numberFormatDropdown.accounting', preview: '¥1,234.56' },
  { id: 'WanYuan', labelKey: 'numberFormatDropdown.wanYuan', preview: '1.2', disabled: true },
  { id: 'Currency', labelKey: 'numberFormatDropdown.currency', preview: '¥1200.09' },
  { id: 'DateShort', labelKey: 'numberFormatDropdown.dateShort', preview: '2017-11-29' },
  { id: 'DateLong', labelKey: 'numberFormatDropdown.dateLong', preview: '1930年8月5日' },
  { id: 'Time12', labelKey: 'numberFormatDropdown.time12', preview: '3:00 PM' },
  { id: 'Time24', labelKey: 'numberFormatDropdown.time24', preview: '15:00' },
  {
    id: 'DateTime12',
    labelKey: 'numberFormatDropdown.dateTime12',
    preview: '2017-11-29 3:00 PM',
  },
  {
    id: 'DateTime24',
    labelKey: 'numberFormatDropdown.dateTime24',
    preview: '2017-11-29 15:00',
  },
  { id: 'Custom', labelKey: 'numberFormatDropdown.custom', preview: '' },
]

export interface NumberFormatDropdownProps {
  open: boolean
  /** Absolute viewport coordinates of the anchor button's bounding rect. */
  anchorRect: DOMRect | null
  /**
   * The anchor element. Clicks on it are *not* treated as click-outside so the
   * toggle button can close the dropdown without immediately re-opening it.
   */
  anchorEl?: HTMLElement | null
  onSelect: (id: NumberFormatId) => void
  onCustomSelect: (id: NumberFormatCustomMenuId) => void
  onClose: () => void
  class?: string
  'data-testid'?: string
}

/**
 * Floating dropdown anchored beneath the toolbar's number-format button. The
 * caller owns the open-state signal and the anchor rect — the component just
 * paints, wires click-outside / Esc, and surfaces the row choice. Custom owns a
 * nested submenu; the caller decides which lightweight dialog to open.
 */
export function NumberFormatDropdown(props: NumberFormatDropdownProps): JSX.Element {
  const t = useT()
  const [customMenuOpen, setCustomMenuOpen] = createSignal(false)
  let rootRef: HTMLDivElement | undefined

  createEffect(() => {
    if (!props.open) {
      setCustomMenuOpen(false)
      return
    }

    function onDocPointerDown(event: MouseEvent) {
      if (!rootRef) return
      const target = event.target as Node | null
      if (target && rootRef.contains(target)) return
      // Ignore clicks on the toggle anchor — the anchor's own click handler
      // owns the close path so we do not race with it (close-then-reopen).
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
    }
  }

  function selectCustomItem(id: NumberFormatCustomMenuId) {
    setCustomMenuOpen(false)
    props.onClose()
    props.onCustomSelect(id)
  }

  return (
    <Show when={props.open}>
      <div
        ref={(el) => (rootRef = el)}
        class={`number-format-dropdown ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'number-format-dropdown'}
        role="menu"
        aria-label={t('toolbar.numberFormat.title')}
        style={style()}
      >
        <For each={NUMBER_FORMAT_ITEMS}>
          {(item) => (
            <Show
              when={item.id === 'Custom'}
              fallback={
                <button
                  type="button"
                  class={`number-format-dropdown-item ${
                    item.disabled ? 'number-format-dropdown-item-disabled' : ''
                  }`.trim()}
                  data-testid={`number-format-item-${item.id}`}
                  data-format-id={item.id}
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    if (item.disabled) return
                    props.onSelect(item.id)
                  }}
                >
                  <span class="number-format-dropdown-label">{t(item.labelKey)}</span>
                  <span class="number-format-dropdown-preview">{item.preview}</span>
                </button>
              }
            >
              <div
                class={`number-format-dropdown-custom ${
                  customMenuOpen() ? 'number-format-dropdown-custom-open' : ''
                }`.trim()}
                onMouseEnter={() => setCustomMenuOpen(true)}
                onMouseLeave={() => setCustomMenuOpen(false)}
              >
                <button
                  type="button"
                  class="number-format-dropdown-item number-format-dropdown-item-with-submenu"
                  data-testid={`number-format-item-${item.id}`}
                  data-format-id={item.id}
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={customMenuOpen()}
                  onPointerEnter={() => setCustomMenuOpen(true)}
                  onMouseEnter={() => setCustomMenuOpen(true)}
                  onClick={() => setCustomMenuOpen(true)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setCustomMenuOpen(true)
                    }
                  }}
                >
                  <span class="number-format-dropdown-label">{t(item.labelKey)}</span>
                  <span class="number-format-dropdown-submenu-arrow" aria-hidden="true" />
                </button>
                <Show when={customMenuOpen()}>
                  <div
                    class="number-format-dropdown-submenu"
                    data-testid="number-format-custom-submenu"
                    role="menu"
                    aria-label={t(item.labelKey)}
                  >
                    <For each={CUSTOM_FORMAT_ITEMS}>
                      {(customItem) => (
                        <button
                          type="button"
                          class="number-format-dropdown-submenu-item"
                          data-testid={customItem.testId}
                          role="menuitem"
                          onClick={() => selectCustomItem(customItem.id)}
                        >
                          {t(customItem.labelKey)}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          )}
        </For>
      </div>
    </Show>
  )
}
