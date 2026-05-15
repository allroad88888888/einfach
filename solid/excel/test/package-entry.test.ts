import { describe, expect, it, jest } from '@jest/globals'

jest.mock('../src/App', () => ({
  App: () => null,
}))

import { createJSSheet, Table, vNext } from '../src'

describe('@einfach/solid-excel package entry', () => {
  it('keeps the legacy surface while exposing the vNext namespace', () => {
    expect(typeof createJSSheet).toBe('function')
    expect(typeof Table).toBe('function')

    expect(typeof vNext.SpreadsheetUiProvider).toBe('function')
    expect(typeof vNext.SpreadsheetGrid).toBe('function')
    expect(typeof vNext.createStaticSpreadsheetBackend).toBe('function')
    expect(typeof vNext.createWorkerWorkbookSpreadsheetBackend).toBe('function')
  })
})
