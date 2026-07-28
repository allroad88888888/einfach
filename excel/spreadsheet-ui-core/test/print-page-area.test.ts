import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  DEFAULT_PRINT_CONFIG,
  clearPrintConfigAtom,
  pageSetupDialogOpenAtom,
  printConfigStateAtom,
  printPreviewOpenAtom,
  setPrintConfigAtom,
  shiftManualPageBreaks,
  togglePageSetupDialogAtom,
  togglePrintPreviewAtom,
  type ManualPageBreak,
  type PrintConfig,
} from '../src/print'

function makeConfig(overrides?: Partial<PrintConfig>): PrintConfig {
  return { ...DEFAULT_PRINT_CONFIG, ...overrides }
}

describe('print-page-area', () => {
  test('initial state: empty config map, preview closed, dialog closed', () => {
    const store = createStore()
    expect(store.getter(printConfigStateAtom)).toEqual({})
    expect(store.getter(printPreviewOpenAtom)).toBe(false)
    expect(store.getter(pageSetupDialogOpenAtom)).toBe(false)
  })

  test('setPrintConfigAtom stores config keyed by sheetId', () => {
    const store = createStore()
    const config = makeConfig({
      printArea: { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 4 },
    })
    store.setter(setPrintConfigAtom, { sheetId: 'A', config })
    expect(store.getter(printConfigStateAtom)).toEqual({ A: config })
  })

  test('subsequent setPrintConfigAtom for same sheetId overwrites', () => {
    const store = createStore()
    const config1 = makeConfig({ orientation: 'portrait' })
    const config2 = makeConfig({ orientation: 'landscape' })
    store.setter(setPrintConfigAtom, { sheetId: 'A', config: config1 })
    store.setter(setPrintConfigAtom, { sheetId: 'A', config: config2 })
    expect(store.getter(printConfigStateAtom)['A']).toEqual(config2)
  })

  test('setPrintConfigAtom for different sheetIds are independent', () => {
    const store = createStore()
    const configA = makeConfig({ orientation: 'portrait' })
    const configB = makeConfig({ orientation: 'landscape' })
    store.setter(setPrintConfigAtom, { sheetId: 'A', config: configA })
    store.setter(setPrintConfigAtom, { sheetId: 'B', config: configB })
    const map = store.getter(printConfigStateAtom)
    expect(map['A']).toEqual(configA)
    expect(map['B']).toEqual(configB)
  })

  test('clearPrintConfigAtom removes only the target sheet entry', () => {
    const store = createStore()
    const configA = makeConfig()
    const configB = makeConfig({ orientation: 'landscape' })
    store.setter(setPrintConfigAtom, { sheetId: 'A', config: configA })
    store.setter(setPrintConfigAtom, { sheetId: 'B', config: configB })
    store.setter(clearPrintConfigAtom, 'A')
    const map = store.getter(printConfigStateAtom)
    expect('A' in map).toBe(false)
    expect(map['B']).toEqual(configB)
  })

  test('togglePrintPreviewAtom flips boolean', () => {
    const store = createStore()
    expect(store.getter(printPreviewOpenAtom)).toBe(false)
    store.setter(togglePrintPreviewAtom)
    expect(store.getter(printPreviewOpenAtom)).toBe(true)
    store.setter(togglePrintPreviewAtom)
    expect(store.getter(printPreviewOpenAtom)).toBe(false)
  })

  test('togglePageSetupDialogAtom flips boolean independently', () => {
    const store = createStore()
    expect(store.getter(pageSetupDialogOpenAtom)).toBe(false)
    store.setter(togglePageSetupDialogAtom)
    expect(store.getter(pageSetupDialogOpenAtom)).toBe(true)
    store.setter(togglePageSetupDialogAtom)
    expect(store.getter(pageSetupDialogOpenAtom)).toBe(false)
  })

  test('preview and dialog toggle independently', () => {
    const store = createStore()
    store.setter(togglePrintPreviewAtom)
    expect(store.getter(printPreviewOpenAtom)).toBe(true)
    expect(store.getter(pageSetupDialogOpenAtom)).toBe(false)
    store.setter(togglePageSetupDialogAtom)
    expect(store.getter(printPreviewOpenAtom)).toBe(true)
    expect(store.getter(pageSetupDialogOpenAtom)).toBe(true)
  })

  test('undefined printArea degrades gracefully', () => {
    const store = createStore()
    const config = makeConfig({ printArea: undefined })
    store.setter(setPrintConfigAtom, { sheetId: 'A', config })
    expect(store.getter(printConfigStateAtom)['A'].printArea).toBeUndefined()
  })

  test('PrintScale percent variant round-trips through JSON', () => {
    const config = makeConfig({ scale: { kind: 'percent', percent: 75 } })
    const roundTripped = JSON.parse(JSON.stringify(config)) as PrintConfig
    expect(roundTripped.scale).toEqual({ kind: 'percent', percent: 75 })
  })

  test('PrintScale fit variant round-trips through JSON', () => {
    const config = makeConfig({ scale: { kind: 'fit', pagesWide: 2, pagesTall: 3 } })
    const roundTripped = JSON.parse(JSON.stringify(config)) as PrintConfig
    expect(roundTripped.scale).toEqual({ kind: 'fit', pagesWide: 2, pagesTall: 3 })
  })

  describe('shiftManualPageBreaks', () => {
    test('spec example: shift [5,10] row breaks from index 6 by +2 → [5,12]', () => {
      const breaks: ManualPageBreak[] = [
        { axis: 'row', index: 5 },
        { axis: 'row', index: 10 },
      ]
      expect(shiftManualPageBreaks(breaks, 'row', 6, 2)).toEqual([
        { axis: 'row', index: 5 },
        { axis: 'row', index: 12 },
      ])
    })

    test('spec example: shift [5,10] row breaks from index 8 by -3 → [5,7]', () => {
      const breaks: ManualPageBreak[] = [
        { axis: 'row', index: 5 },
        { axis: 'row', index: 10 },
      ]
      expect(shiftManualPageBreaks(breaks, 'row', 8, -3)).toEqual([
        { axis: 'row', index: 5 },
        { axis: 'row', index: 7 },
      ])
    })

    test('does not affect breaks below fromIndex', () => {
      const breaks: ManualPageBreak[] = [{ axis: 'row', index: 3 }]
      expect(shiftManualPageBreaks(breaks, 'row', 5, 2)).toEqual([{ axis: 'row', index: 3 }])
    })

    test('does not affect breaks on other axis', () => {
      const breaks: ManualPageBreak[] = [
        { axis: 'row', index: 5 },
        { axis: 'column', index: 5 },
        { axis: 'row', index: 10 },
      ]
      const result = shiftManualPageBreaks(breaks, 'row', 6, 2)
      expect(result).toEqual([
        { axis: 'row', index: 5 },
        { axis: 'column', index: 5 },
        { axis: 'row', index: 12 },
      ])
    })

    test('returns same array reference when delta is 0', () => {
      const breaks: ManualPageBreak[] = [{ axis: 'row', index: 5 }]
      expect(shiftManualPageBreaks(breaks, 'row', 0, 0)).toBe(breaks)
    })

    test('shifts column breaks', () => {
      const breaks: ManualPageBreak[] = [
        { axis: 'column', index: 3 },
        { axis: 'column', index: 8 },
      ]
      expect(shiftManualPageBreaks(breaks, 'column', 4, 2)).toEqual([
        { axis: 'column', index: 3 },
        { axis: 'column', index: 10 },
      ])
    })

    test('empty breaks array returns empty array', () => {
      expect(shiftManualPageBreaks([], 'row', 0, 1)).toEqual([])
    })
  })
})
