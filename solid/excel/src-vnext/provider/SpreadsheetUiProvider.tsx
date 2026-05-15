import { createStore } from '@einfach/core'
import { Provider as SolidProvider } from '@einfach/solid'
import { createSpreadsheetUi } from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiContext } from './context'
import { spreadsheetBackendAtom } from './atoms'
import type { SpreadsheetUiProviderProps } from './types'

export function SpreadsheetUiProvider(props: SpreadsheetUiProviderProps) {
  const core = createSpreadsheetUi({
    backend: props.backend,
    store: props.store ?? createStore(),
  })
  core.store.setter(spreadsheetBackendAtom, props.backend)

  return (
    <SolidProvider store={core.store}>
      <SpreadsheetUiContext.Provider value={core}>{props.children}</SpreadsheetUiContext.Provider>
    </SolidProvider>
  )
}
