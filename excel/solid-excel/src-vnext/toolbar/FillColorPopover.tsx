import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'

import { useT } from '../../src/i18n'

/**
 * A small color-picker popover anchored beneath the toolbar fill/text color
 * buttons. The picker shows an Excel-style swatch grid plus a "no fill" /
 * "automatic" entry. Selecting a swatch invokes `onPick(hex)` (where `hex` is
 * either a `#rrggbb` string or `''` for "no fill"/"automatic") and closes the
 * popover.
 *
 * Visibility and mode are controlled by the Core-owned toolbar surface state.
 * This view keeps only transient hover feedback and DOM positioning locally.
 */

export type ColorPopoverMode = 'fill' | 'text'

/**
 * Excel-style 8x5 palette (40 swatches). Mirrors the "Standard Colors" + a
 * "Theme Colors" row most Excel users recognise without taking on the cost of
 * a real theme-tinted palette here.
 */
const PALETTE: readonly (readonly string[])[] = [
  // Row 1 — standard chromatics
  ['#000000', '#404040', '#7f7f7f', '#a6a6a6', '#d9d9d9', '#f2f2f2', '#ffffff'],
  // Row 2 — primary accents
  ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0'],
  // Row 3 — extended cools
  ['#0070c0', '#002060', '#7030a0', '#ff66cc', '#a52a2a', '#964b00', '#bf9000'],
  // Row 4 — pastel fills (popular highlight choices)
  ['#fce4d6', '#fff2cc', '#e2efda', '#ddebf7', '#d9e1f2', '#fff0f5', '#f4cccc'],
  // Row 5 — saturated mid-tones
  ['#ffd966', '#f4b084', '#a9d08e', '#9bc2e6', '#8ea9db', '#b4a7d6', '#d5a6bd'],
]

interface FillColorPopoverProps {
  /** Core-derived visibility; this component never owns a second open flag. */
  readonly open: boolean
  /** Core-derived active palette mode. */
  readonly mode: ColorPopoverMode | null
  /**
   * Bounding rect of the anchor button so the popover can position itself just
   * beneath it. We re-read this each time the popover opens.
   */
  readonly anchorRect: () => DOMRect | null
  /** Called with a `#rrggbb` hex string OR `''` to mean "no fill"/"automatic". */
  readonly onPick: (hex: string) => void
  /** Routes dismissal back through the Core close command. */
  readonly onRequestClose: () => void
}

export function FillColorPopover(props: FillColorPopoverProps) {
  const t = useT()
  const [hoverHex, setHoverHex] = createSignal<string | null>(null)
  let containerRef: HTMLDivElement | undefined

  const isOpen = () => props.open && props.mode !== null

  createEffect(() => {
    if (!isOpen()) return
    setHoverHex(null)

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        props.onRequestClose()
      }
    }

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node | null
      if (!target) return
      // Ignore clicks inside the popover itself.
      if (containerRef && containerRef.contains(target)) return
      // Ignore clicks on the anchor buttons — they own the toggle behaviour.
      if (target instanceof Element) {
        const anchor = target.closest(
          '[data-testid="toolbar-btn-fill-color"], [data-testid="toolbar-btn-text-color"]',
        )
        if (anchor) return
      }
      props.onRequestClose()
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown, true)
    onCleanup(() => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown, true)
    })
  })

  const positionStyle = (): Record<string, string> => {
    const rect = props.anchorRect()
    if (!rect) return { display: 'none' }
    return {
      position: 'fixed',
      top: `${rect.bottom + 2}px`,
      left: `${rect.left}px`,
      'z-index': '5000',
    }
  }

  function handlePick(hex: string) {
    props.onPick(hex)
  }

  return (
    <Show when={isOpen()}>
      <div
        ref={(el) => {
          containerRef = el
        }}
        class="spreadsheet-color-popover"
        data-testid="toolbar-color-popover"
        data-mode={props.mode ?? ''}
        role="dialog"
        aria-label={
          props.mode === 'fill' ? t('toolbar.fillColor.title') : t('toolbar.textColor.title')
        }
        style={positionStyle()}
      >
        <button
          type="button"
          class="spreadsheet-color-popover-no-fill"
          data-testid="color-popover-no-fill"
          onClick={() => handlePick('')}
          onMouseEnter={() => setHoverHex('')}
          onMouseLeave={() => setHoverHex(null)}
        >
          <span
            class="spreadsheet-color-popover-no-fill-icon"
            data-mode={props.mode ?? ''}
            aria-hidden="true"
          >
            <Show
              when={props.mode === 'fill'}
              fallback={
                /* Automatic: solid-fill square hints "use default text color" */
                <svg width="14" height="14" viewBox="0 0 14 14">
                  <rect
                    x="1.5"
                    y="1.5"
                    width="11"
                    height="11"
                    fill="#000000"
                    stroke="#8a8a8a"
                    stroke-width="1"
                  />
                </svg>
              }
            >
              {/* No fill: empty square with diagonal red slash */}
              <svg width="14" height="14" viewBox="0 0 14 14">
                <rect
                  x="1.5"
                  y="1.5"
                  width="11"
                  height="11"
                  fill="#ffffff"
                  stroke="#8a8a8a"
                  stroke-width="1"
                />
                <line x1="2" y1="12" x2="12" y2="2" stroke="#d13438" stroke-width="1.5" />
              </svg>
            </Show>
          </span>
          <span class="spreadsheet-color-popover-no-fill-label">
            {props.mode === 'fill'
              ? t('toolbar.colorPopover.noFill')
              : t('toolbar.colorPopover.automatic')}
          </span>
        </button>
        <div class="spreadsheet-color-popover-section-title" aria-hidden="true">
          {t('toolbar.colorPopover.themeColors')}
        </div>
        <div class="spreadsheet-color-popover-grid" role="grid">
          <For each={PALETTE}>
            {(row) => (
              <div class="spreadsheet-color-popover-row" role="row">
                <For each={row}>
                  {(hex) => (
                    <button
                      type="button"
                      class="spreadsheet-color-popover-swatch"
                      role="gridcell"
                      data-testid={`color-popover-swatch-${hex}`}
                      data-color={hex}
                      title={hex}
                      aria-label={hex}
                      style={{ 'background-color': hex }}
                      onClick={() => handlePick(hex)}
                      onMouseEnter={() => setHoverHex(hex)}
                      onMouseLeave={() => setHoverHex(null)}
                    />
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
        <button
          type="button"
          class="spreadsheet-color-popover-more"
          data-testid="color-popover-more-colors"
          disabled
          title={t('toolbar.colorPopover.moreColors')}
        >
          <span class="spreadsheet-color-popover-more-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 14 14">
              <circle cx="7" cy="7" r="5.5" fill="none" stroke="#8a8a8a" stroke-width="1" />
              <path d="M7 1.5 A5.5 5.5 0 0 1 12.5 7 L7 7 Z" fill="#ffc000" />
              <path d="M12.5 7 A5.5 5.5 0 0 1 7 12.5 L7 7 Z" fill="#92d050" />
              <path d="M7 12.5 A5.5 5.5 0 0 1 1.5 7 L7 7 Z" fill="#0070c0" />
              <path d="M1.5 7 A5.5 5.5 0 0 1 7 1.5 L7 7 Z" fill="#c00000" />
            </svg>
          </span>
          <span class="spreadsheet-color-popover-more-label">
            {t('toolbar.colorPopover.moreColors')}
          </span>
        </button>
        <div class="spreadsheet-color-popover-hint" data-testid="color-popover-hint">
          {hoverHex() === ''
            ? props.mode === 'fill'
              ? t('toolbar.colorPopover.noFill')
              : t('toolbar.colorPopover.automatic')
            : (hoverHex() ?? '')}
        </div>
      </div>
    </Show>
  )
}
