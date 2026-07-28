import type { Store } from '@einfach/core'
import type { NamedRangeControllerPort, SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import type { JSX } from 'solid-js'

/** Explicit host capability port; intentionally independent of SpreadsheetBackend. */
export type NamedRangeCapabilityPort = Required<
  Pick<NamedRangeControllerPort, 'readNamedRangeCapabilities'>
>

export interface SpreadsheetUiCore {
  backend: SpreadsheetBackend
  store: Store
}

export interface SpreadsheetUiProviderProps {
  backend: SpreadsheetBackend
  /** Workbook-local custom sequences used by auto-fill detection and execution. */
  customFillSeriesLists?: Readonly<Record<string, readonly string[]>>
  namedRangeCapabilityPort?: NamedRangeCapabilityPort
  store?: Store
  children: JSX.Element
}
