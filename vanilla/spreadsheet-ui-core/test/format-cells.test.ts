import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  closeFormatCellsAtom,
  formatCellsActiveTabAtom,
  formatCellsDraftAtom,
  formatCellsEditorAtom,
  formatCellsSavePayloadAtom,
  openFormatCellsAtom,
  patchFormatCellsDraftAtom,
  saveFormatCellsAtom,
  setFormatCellsActiveTabAtom,
  type FormatCellsDraft,
} from '../src/format-cells'

const RANGE = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }

describe('format-cells atoms', () => {
  test('initial state is closed and derived atoms expose safe defaults', () => {
    const store = createStore()
    expect(store.getter(formatCellsEditorAtom)).toEqual({ status: 'closed' })
    expect(store.getter(formatCellsActiveTabAtom)).toBe('number')
    expect(store.getter(formatCellsDraftAtom)).toBeNull()
    expect(store.getter(formatCellsSavePayloadAtom)).toBeNull()
  })

  test('openFormatCellsAtom seeds draft and defaults activeTab to number', () => {
    const store = createStore()
    const seed: FormatCellsDraft = { bold: true, fontSize: 14 }

    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialFormat: seed,
    })

    const state = store.getter(formatCellsEditorAtom)
    expect(state.status).toBe('open')
    if (state.status !== 'open') throw new Error('unreachable')
    expect(state.sheetId).toBe('sheet-1')
    expect(state.range).toEqual(RANGE)
    expect(state.activeTab).toBe('number')
    expect(state.draft).toEqual({ bold: true, fontSize: 14 })
    expect(state.dirty).toBe(false)
  })

  test('openFormatCellsAtom honours initialTab', () => {
    const store = createStore()
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialTab: 'border',
    })
    expect(store.getter(formatCellsActiveTabAtom)).toBe('border')
  })

  test('openFormatCellsAtom deep-clones the seed format', () => {
    const store = createStore()
    const seed: FormatCellsDraft = {
      borders: { top: { style: 'thin', color: '#000' } },
    }
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialFormat: seed,
    })

    // Mutate the seed AFTER opening — the editor's draft must be untouched.
    if (seed.borders?.top) seed.borders.top.color = '#fff'

    const draft = store.getter(formatCellsDraftAtom)
    expect(draft?.borders?.top?.color).toBe('#000')
  })

  test('setFormatCellsActiveTabAtom updates activeTab without touching draft', () => {
    const store = createStore()
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialFormat: { bold: true },
    })

    store.setter(setFormatCellsActiveTabAtom, 'alignment')
    expect(store.getter(formatCellsActiveTabAtom)).toBe('alignment')
    expect(store.getter(formatCellsDraftAtom)).toEqual({ bold: true })

    store.setter(setFormatCellsActiveTabAtom, 'font')
    expect(store.getter(formatCellsActiveTabAtom)).toBe('font')
  })

  test('setFormatCellsActiveTabAtom is a no-op when editor is closed', () => {
    const store = createStore()
    store.setter(setFormatCellsActiveTabAtom, 'font')
    expect(store.getter(formatCellsEditorAtom)).toEqual({ status: 'closed' })
  })

  test('patchFormatCellsDraftAtom shallow-merges and flips dirty true', () => {
    const store = createStore()
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialFormat: { bold: true, fontSize: 12 },
    })

    store.setter(patchFormatCellsDraftAtom, { italic: true, fontSize: 16 })

    const state = store.getter(formatCellsEditorAtom)
    if (state.status !== 'open') throw new Error('unreachable')
    expect(state.draft).toEqual({ bold: true, italic: true, fontSize: 16 })
    expect(state.dirty).toBe(true)
  })

  test('per-tab draft fields persist across tab switches', () => {
    const store = createStore()
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialFormat: {},
    })

    // Edit Font tab — set bold.
    store.setter(setFormatCellsActiveTabAtom, 'font')
    store.setter(patchFormatCellsDraftAtom, { bold: true })

    // Switch to Border, edit a border.
    store.setter(setFormatCellsActiveTabAtom, 'border')
    store.setter(patchFormatCellsDraftAtom, {
      borders: { top: { style: 'thin' } },
    })

    // Back to Font — bold must still be true.
    store.setter(setFormatCellsActiveTabAtom, 'font')
    const draft = store.getter(formatCellsDraftAtom)
    expect(draft?.bold).toBe(true)
    expect(draft?.borders?.top?.style).toBe('thin')
  })

  test('closeFormatCellsAtom discards draft and returns to closed', () => {
    const store = createStore()
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialFormat: { bold: true },
    })
    store.setter(patchFormatCellsDraftAtom, { italic: true })

    store.setter(closeFormatCellsAtom)
    expect(store.getter(formatCellsEditorAtom)).toEqual({ status: 'closed' })
    expect(store.getter(formatCellsDraftAtom)).toBeNull()
  })

  test('saveFormatCellsAtom closes the editor', () => {
    const store = createStore()
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
    })

    store.setter(saveFormatCellsAtom)
    expect(store.getter(formatCellsEditorAtom)).toEqual({ status: 'closed' })
  })

  test('formatCellsSavePayloadAtom returns sheetId, range, draft when open', () => {
    const store = createStore()
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-2',
      range: { rowStart: 1, rowEnd: 3, colStart: 2, colEnd: 4 },
      initialFormat: { bold: true },
    })
    store.setter(patchFormatCellsDraftAtom, { italic: true })

    expect(store.getter(formatCellsSavePayloadAtom)).toEqual({
      sheetId: 'sheet-2',
      range: { rowStart: 1, rowEnd: 3, colStart: 2, colEnd: 4 },
      format: { bold: true, italic: true },
    })
  })

  test('opening with null initialFormat seeds an empty draft', () => {
    const store = createStore()
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialFormat: null,
    })

    expect(store.getter(formatCellsDraftAtom)).toEqual({})
  })

  test('debug labels follow the spreadsheet.formatCells.* namespace', () => {
    expect(formatCellsEditorAtom.debugLabel).toBe('spreadsheet.formatCells.editor')
    expect(formatCellsActiveTabAtom.debugLabel).toBe('spreadsheet.formatCells.activeTab')
    expect(formatCellsDraftAtom.debugLabel).toBe('spreadsheet.formatCells.draft')
    expect(openFormatCellsAtom.debugLabel).toBe('spreadsheet.formatCells.open')
    expect(closeFormatCellsAtom.debugLabel).toBe('spreadsheet.formatCells.close')
    expect(saveFormatCellsAtom.debugLabel).toBe('spreadsheet.formatCells.save')
    expect(setFormatCellsActiveTabAtom.debugLabel).toBe(
      'spreadsheet.formatCells.setActiveTab',
    )
    expect(patchFormatCellsDraftAtom.debugLabel).toBe('spreadsheet.formatCells.patchDraft')
    expect(formatCellsSavePayloadAtom.debugLabel).toBe('spreadsheet.formatCells.savePayload')
  })
})
