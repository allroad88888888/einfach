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
  <svg {...SVG_PROPS}>
    <path
      d="M5 3h3.6a2.4 2.4 0 0 1 0 4.8H5zM5 7.8h4.2a2.6 2.6 0 0 1 0 5.2H5z"
      fill="currentColor"
      stroke="currentColor"
      stroke-width="0.8"
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
    <rect x="2.5" y="3.5" width="11" height="9" />
    <path d="M5.5 5.5 8 8l-2.5 2.5M10.5 5.5 8 8l2.5 2.5" />
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
    <text
      x="2"
      y="12"
      font-size="10"
      font-family="serif"
      fill="currentColor"
      stroke="none"
    >
      A
    </text>
    <path d="m10 6 1.5-1.5L13 6M11.5 4.5V10" />
  </svg>
)

export const FontSizeDownIcon = (): JSX.Element => (
  <svg {...SVG_PROPS}>
    <text
      x="3"
      y="11"
      font-size="8"
      font-family="serif"
      fill="currentColor"
      stroke="none"
    >
      A
    </text>
    <path d="m10 8 1.5 1.5L13 8M11.5 9.5V4" />
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
    <path d="M3 3h10l-3.5 5L11 13H6L3 3z" />
    <line x1="2" y1="14" x2="14" y2="14" stroke-dasharray="1.5 1.2" />
    <line x1="11.5" y1="2.5" x2="14" y2="5" stroke-width="1.2" />
    <line x1="14" y1="2.5" x2="11.5" y2="5" stroke-width="1.2" />
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
