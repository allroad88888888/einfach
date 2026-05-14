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
}
