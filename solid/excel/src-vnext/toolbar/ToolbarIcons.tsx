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
