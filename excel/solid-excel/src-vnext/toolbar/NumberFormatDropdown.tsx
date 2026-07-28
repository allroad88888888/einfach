/** @jsxImportSource solid-js */

import { For, Show, createEffect, onCleanup } from 'solid-js'
import type { JSX } from 'solid-js'
import { useT } from '../../src/i18n'

/**
 * Stable identifier for each row in the number-format dropdown. The toolbar's
 * `commandFormat` switch maps these back to a `SpreadsheetNumberFormat`. Custom
 * (`'Custom'`) is a sentinel row: clicking it forwards `onSelect('Custom')` so
 * the host can open the full Format Cells dialog on the Number tab.
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

/**
 * Reserved sub-format identifiers historically used by the lightweight
 * "more number formats" dialogs (currency / date-time / number). Wave 5 routes
 * the Custom row directly to the full Format Cells dialog so the dropdown no
 * longer renders a submenu, but the type stays exported because the
 * SpreadsheetNumberFormatDialogs harness keeps the lightweight dialogs around
 * for the unit-test suite and host integrations that prefer them.
 */
export type NumberFormatCustomMenuId = 'currency' | 'dateTime' | 'number'

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
  /**
   * Kept optional for backwards compatibility with hosts that wired the
   * lightweight "more number formats" path. The dropdown no longer renders a
   * submenu — Wave 5 routes the Custom row through `onSelect('Custom')` and
   * the host opens the full Format Cells dialog.
   */
  onCustomSelect?: (id: NumberFormatCustomMenuId) => void
  onClose: () => void
  class?: string
  'data-testid'?: string
}

/**
 * Floating dropdown anchored beneath the toolbar's number-format button. The
 * caller owns the open-state signal and the anchor rect — the component just
 * paints, wires click-outside / Esc, and surfaces the row choice. The Custom
 * row is a normal `onSelect('Custom')` item; the host decides whether to open
 * the full Format Cells dialog or one of the lightweight per-category dialogs.
 */
export function NumberFormatDropdown(props: NumberFormatDropdownProps): JSX.Element {
  const t = useT()
  let rootRef: HTMLDivElement | undefined

  createEffect(() => {
    if (!props.open) return

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
          )}
        </For>
      </div>
    </Show>
  )
}
