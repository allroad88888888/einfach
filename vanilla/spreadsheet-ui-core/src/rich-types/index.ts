export * from './types'

import type { DisplayCell } from '../backend/types'
import type { DisplayCellRichValue, HyperlinkValue, RichTextValue } from './types'

export function getRichValueText(value: DisplayCellRichValue): string {
  switch (value.kind) {
    case 'hyperlink':
      return value.label
    case 'rich-text':
      return value.runs.map((r) => r.text).join('')
    case 'number':
      return String(value.value)
    case 'boolean':
      return String(value.value)
    case 'error':
      return value.message
  }
}

export function isHyperlinkValue(value: DisplayCellRichValue): value is HyperlinkValue {
  return value.kind === 'hyperlink'
}

export function isRichTextValue(value: DisplayCellRichValue): value is RichTextValue {
  return value.kind === 'rich-text'
}

export function getDisplayCellText(cell: DisplayCell): string {
  return cell.richValue !== undefined ? getRichValueText(cell.richValue) : cell.displayValue
}
