import { describe, expect, it } from '@jest/globals'
import {
  SpreadsheetGrid,
  SpreadsheetUiProvider,
  createWorkerWorkbook,
  createStaticSpreadsheetBackend,
  createWorkerWorkbookSpreadsheetBackend,
} from '@einfach/solid-excel/vnext'
import * as vNext from '@einfach/solid-excel/vnext'

describe('@einfach/solid-excel/vnext subpath', () => {
  it('exposes the vNext public API without importing demos', () => {
    expect(typeof SpreadsheetUiProvider).toBe('function')
    expect(typeof SpreadsheetGrid).toBe('function')
    expect(typeof createWorkerWorkbook).toBe('function')
    expect(typeof createStaticSpreadsheetBackend).toBe('function')
    expect(typeof createWorkerWorkbookSpreadsheetBackend).toBe('function')
    expect('VNextSmokeDemo' in vNext).toBe(false)
    expect('VNextWorkerDemo' in vNext).toBe(false)
    expect('defaultVNextWorkbookWorkerFactory' in vNext).toBe(false)
  })
})
