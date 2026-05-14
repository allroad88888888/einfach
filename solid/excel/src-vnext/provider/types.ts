import type { Store } from '@einfach/core'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import type { JSX } from 'solid-js'

export interface SpreadsheetUiCore {
  backend: SpreadsheetBackend
  store: Store
}

export interface SpreadsheetUiProviderProps {
  backend: SpreadsheetBackend
  store?: Store
  children: JSX.Element
}
