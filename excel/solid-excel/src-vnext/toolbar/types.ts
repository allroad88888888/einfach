import type { JSX } from 'solid-js'
import type {
  ToolbarCommandAvailability,
  ToolbarFormatCommandKind,
} from '@einfach/spreadsheet-ui-core'

export interface SpreadsheetToolbarProps {
  class?: string
  'data-testid'?: string
}

export interface SpreadsheetToolbarCommand {
  command: ToolbarFormatCommandKind
  label: string
  title: string
  testId: string
  value?: string | null
  isEnabled: (availability: ToolbarCommandAvailability) => boolean
  /**
   * Optional SVG (or any JSX) glyph that replaces the i18n label inside the
   * button when present. The button still uses `title` for the tooltip and
   * `aria-label`, so screen readers see the localized verb even when the
   * visible content is an icon.
   */
  icon?: () => JSX.Element
}
