import { useAtomValue, useStore } from '@einfach/solid'
import type { Store } from '@einfach/core'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import { spreadsheetBackendAtom } from './atoms'

export function useSpreadsheetUiCore() {
  return {
    backend: useSpreadsheetBackend(),
    store: useSpreadsheetUiStore(),
  }
}

export function useSpreadsheetUiStore(): Store {
  return useStore()
}

export function useSpreadsheetBackend(): SpreadsheetBackend {
  const backend = useAtomValue(spreadsheetBackendAtom)
  const resolvedBackend = backend()
  if (!resolvedBackend) {
    throw new Error('SpreadsheetUiProvider is required.')
  }
  return resolvedBackend
}
