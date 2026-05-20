import type { JSX } from 'solid-js'

/**
 * Univer-style toolbar glyphs. Each icon is a self-contained 16x16 SVG that
 * inherits text color via `currentColor` so the active / disabled / hover
 * states of the parent button continue to drive the visual treatment.
 *
 * The icons replace the i18n verb labels that used to render inside each
 * toolbar button. ARIA still pulls the localized verb from `title` /
 * `aria-label`, so screen readers and keyboard tooltips are unaffected.
 */

const SVG_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.5,
  'stroke-linecap': 'round' as const,
  'stroke-linejoin': 'round' as const,
  'aria-hidden': true,
  focusable: false,
} as const

export const BoldIcon = (): JSX.Element => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    {/*
      Fill-only "B" — no stroke. The previous version layered a 0.8px stroke
      on top of the fill which renders as a sub-pixel halo at 14-16px display
      sizes (the path edges land on fractional pixel boundaries). Pure fill
      with thicker bar geometry stays crisp at any zoom.
     */}
    <path
      d="M4.5 3h4a2.5 2.5 0 0 1 1.8 4.25A2.7 2.7 0 0 1 9 13H4.5V3zm2 1.6v2.7h2a1.35 1.35 0 0 0 0-2.7h-2zm0 4.3v2.5h2.5a1.25 1.25 0 0 0 0-2.5H6.5z"
      fill="currentColor"
    />
  </svg>
)

export const ItalicIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <line x1="10" y1="3" x2="6" y2="13" />
    <line x1="7" y1="3" x2="12" y2="3" />
    <line x1="4" y1="13" x2="9" y2="13" />
  </svg>
)

export const UnderlineIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <path d="M4 3v5.5a4 4 0 0 0 8 0V3" />
    <line x1="3" y1="13.5" x2="13" y2="13.5" />
  </svg>
)

export const AlignLeftIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <line x1="3" y1="4" x2="13" y2="4" />
    <line x1="3" y1="7.5" x2="9" y2="7.5" />
    <line x1="3" y1="11" x2="11" y2="11" />
  </svg>
)

export const AlignCenterIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <line x1="3" y1="4" x2="13" y2="4" />
    <line x1="5" y1="7.5" x2="11" y2="7.5" />
    <line x1="4" y1="11" x2="12" y2="11" />
  </svg>
)

export const AlignRightIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <line x1="3" y1="4" x2="13" y2="4" />
    <line x1="7" y1="7.5" x2="13" y2="7.5" />
    <line x1="5" y1="11" x2="13" y2="11" />
  </svg>
)

export const FillColorIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <path d="M3.5 8.5 8 4l4.5 4.5L8 13z" />
    <path d="M8 4 6 2" />
    <circle cx="13" cy="11.5" r="1" fill="currentColor" />
    <rect x="3" y="13.5" width="10" height="1.2" fill="#ffd966" stroke="none" />
  </svg>
)

export const TextColorIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <path d="M4 11 7.5 3h1L12 11" />
    <line x1="5" y1="8" x2="11" y2="8" />
    <rect x="3" y="13" width="10" height="1.5" fill="#e64545" stroke="none" />
  </svg>
)

export const NumberFormatIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <text
      x="8"
      y="11"
      text-anchor="middle"
      font-size="8"
      font-family="system-ui, -apple-system, sans-serif"
      font-weight="600"
      fill="currentColor"
      stroke="none"
    >
      123
    </text>
  </svg>
)

export const VAlignTopIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <line x1="3" y1="3" x2="13" y2="3" />
    <line x1="8" y1="5.5" x2="8" y2="13" />
    <path d="m5.5 8 2.5-2.5L10.5 8" />
  </svg>
)

export const VAlignMiddleIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <line x1="3" y1="8" x2="13" y2="8" />
    <line x1="8" y1="3" x2="8" y2="6" />
    <line x1="8" y1="10" x2="8" y2="13" />
    <path d="m6.5 4.5 1.5-1.5 1.5 1.5" />
    <path d="m6.5 11.5 1.5 1.5 1.5-1.5" />
  </svg>
)

export const VAlignBottomIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <line x1="3" y1="13" x2="13" y2="13" />
    <line x1="8" y1="3" x2="8" y2="10.5" />
    <path d="m5.5 8 2.5 2.5L10.5 8" />
  </svg>
)

export const FormatPainterIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <rect x="3" y="2.5" width="9" height="3" rx="0.5" />
    <path d="M3.5 5.5h8v2.5a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1z" />
    <path d="M7 9v2a1 1 0 0 0 1 1h0v1.5" />
    <rect x="6.5" y="13.5" width="3" height="1.5" rx="0.3" />
  </svg>
)

export const MergeCellsIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    {/*
      4-cell grid that collapses inward:
        - heavy outer rect = merged boundary
        - dashed inner crosshatch = cell walls "fading away"
        - center arrows pointing inward = collapse
      Closer to the classic Excel / Univer merge glyph than the previous
      rectangle-with-crossing-arrows (which read more like "swap").
     */}
    <rect x="2" y="3" width="12" height="10" stroke-width="1.6" />
    <line x1="8" y1="3.2" x2="8" y2="6" stroke-dasharray="1.4 1.2" />
    <line x1="8" y1="10" x2="8" y2="12.8" stroke-dasharray="1.4 1.2" />
    <line x1="2.2" y1="8" x2="5" y2="8" stroke-dasharray="1.4 1.2" />
    <line x1="11" y1="8" x2="13.8" y2="8" stroke-dasharray="1.4 1.2" />
    <path d="M6 8h4" stroke-width="1.4" />
    <path d="M6.5 7l-1 1 1 1M9.5 7l1 1-1 1" stroke-width="1.4" />
  </svg>
)

export const UnmergeCellsIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <rect x="2.5" y="3.5" width="11" height="9" />
    <line x1="8" y1="3.5" x2="8" y2="12.5" />
    <path d="m6 6 2 2-2 2M10 6l-2 2 2 2" />
  </svg>
)

export const StrikethroughIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <line x1="3" y1="8" x2="13" y2="8" />
    <path d="M5 5a3 3 0 0 1 3-2 3 3 0 0 1 3 3M5 11a3 3 0 0 0 3 2 3 3 0 0 0 3-3" />
  </svg>
)

export const WrapIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <line x1="3" y1="4" x2="13" y2="4" />
    <path d="M3 8h7a2.5 2.5 0 1 1 0 5H8.5l1 1m0-2-1 1" />
    <line x1="3" y1="12" x2="6" y2="12" />
  </svg>
)

export const RotationIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <text
      x="4"
      y="13"
      font-size="9"
      font-family="serif"
      font-style="italic"
      fill="currentColor"
      stroke="none"
      transform="rotate(-25 8 8)"
    >
      ab
    </text>
    <line x1="2.5" y1="13.5" x2="13.5" y2="13.5" />
  </svg>
)

export const BordersIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <rect x="2.5" y="2.5" width="11" height="11" />
    <line x1="8" y1="2.5" x2="8" y2="13.5" />
    <line x1="2.5" y1="8" x2="13.5" y2="8" />
  </svg>
)

export const FontSizeUpIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    {/* Larger "A" glyph + clearer up arrow. Previous version drew "A" at
        font-size 10 starting at x=2 — visually undersized next to the
        16x16 button. Bumped to font-size 12 and the arrow stroke to 1.6. */}
    <text
      x="1.5"
      y="13"
      font-size="12"
      font-family="Georgia, 'Times New Roman', serif"
      font-weight="700"
      fill="currentColor"
      stroke="none"
    >
      A
    </text>
    <path d="M12 4v7" stroke-width="1.6" />
    <path d="m9.6 6.2 2.4-2.4 2.4 2.4" stroke-width="1.6" />
  </svg>
)

export const FontSizeDownIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    {/* Smaller "A" (visually one rank below FontSizeUpIcon) with a clear
        down arrow. */}
    <text
      x="2.5"
      y="12"
      font-size="10"
      font-family="Georgia, 'Times New Roman', serif"
      font-weight="700"
      fill="currentColor"
      stroke="none"
    >
      A
    </text>
    <path d="M12 4v7" stroke-width="1.6" />
    <path d="m9.6 8.8 2.4 2.4 2.4-2.4" stroke-width="1.6" />
  </svg>
)

export const PasteIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <rect x="3" y="3" width="10" height="11" rx="0.5" />
    <rect x="5.5" y="2" width="5" height="2.5" rx="0.4" fill="currentColor" />
  </svg>
)

export const PercentIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <circle cx="5" cy="5" r="1.6" />
    <circle cx="11" cy="11" r="1.6" />
    <line x1="13" y1="3" x2="3" y2="13" />
  </svg>
)

export const CurrencyIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <line x1="8" y1="2.5" x2="8" y2="13.5" />
    <path d="M11 4.5H6.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H5" />
  </svg>
)

export const UndoIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <path d="M3 7h7.5a3.5 3.5 0 0 1 0 7H7" />
    <path d="m5.5 4.5-2.5 2.5 2.5 2.5" />
  </svg>
)

export const RedoIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <path d="M13 7H5.5a3.5 3.5 0 0 0 0 7H9" />
    <path d="m10.5 4.5 2.5 2.5-2.5 2.5" />
  </svg>
)

export const ClearFormatIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    {/*
      "Eraser swept over text" composition — the universal Excel/Univer
      glyph for clear formatting:
        - background "T" letter (formatted text being erased)
        - eraser shape on top, angled, with a clean separating line
        - small flecks suggesting the format dust being removed
      Heavier strokes (1.6) so the icon reads at 14-16px sizes.
     */}
    {/* The "T" letter being cleaned */}
    <line x1="3" y1="3.5" x2="9" y2="3.5" stroke-width="1.6" />
    <line x1="6" y1="3.5" x2="6" y2="9.5" stroke-width="1.6" />
    {/* Eraser body — rounded rectangle on a tilt */}
    <path
      d="M8 14.5 5 11.5l6-6 3 3-6 6z"
      fill="#fff"
      stroke="currentColor"
      stroke-width="1.5"
    />
    {/* Divider between the eraser's pink top and white pad */}
    <line x1="7" y1="9.5" x2="10" y2="12.5" stroke-width="1.5" />
  </svg>
)

export const ChevronDownIcon = (): JSX.Element => (
  <svg
    width="8"
    height="8"
    viewBox="0 0 8 8"
    fill="none"
    stroke="currentColor"
    stroke-width="1.2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M1.5 3 4 5.5 6.5 3" />
  </svg>
)
