import { createStore, type Store } from '@einfach/core'
import type { SpreadsheetBackend } from './backend'

export interface SpreadsheetUiCoreOptions {
  backend: SpreadsheetBackend
  store?: Store
}

export interface SpreadsheetUiCore {
  backend: SpreadsheetBackend
  store: Store
}

export function createSpreadsheetUi(options: SpreadsheetUiCoreOptions): SpreadsheetUiCore {
  return {
    backend: options.backend,
    store: options.store ?? createStore(),
  }
}
