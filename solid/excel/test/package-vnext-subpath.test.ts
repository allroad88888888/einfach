import { describe, expect, it } from '@jest/globals'
import {
  SpreadsheetGrid,
  SpreadsheetUiProvider,
  createStaticSpreadsheetBackend,
  createWorkerWorkbookSpreadsheetBackend,
} from '@einfach/solid-excel/vnext'

describe('@einfach/solid-excel/vnext subpath', () => {
  it('exposes the vNext public API without importing demos', () => {
    expect(typeof SpreadsheetUiProvider).toBe('function')
    expect(typeof SpreadsheetGrid).toBe('function')
    expect(typeof createStaticSpreadsheetBackend).toBe('function')
    expect(typeof createWorkerWorkbookSpreadsheetBackend).toBe('function')
  })
})
