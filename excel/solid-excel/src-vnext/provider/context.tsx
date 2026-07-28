import { createContext, useContext } from 'solid-js'
import type { SpreadsheetUiCore } from './types'

export const SpreadsheetUiContext = createContext<SpreadsheetUiCore | undefined>(undefined)

export function useSpreadsheetUiCoreContext(): SpreadsheetUiCore {
  const context = useContext(SpreadsheetUiContext)
  if (!context) {
    throw new Error('SpreadsheetUiProvider is required.')
  }
  return context
}
