import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import type {
  SpreadsheetBorders,
  SpreadsheetCellFormat,
} from '../src/backend/types'
import {
  dispatchToolbarFormatCommandAtom,
  getToolbarCommandAvailability,
  isToolbarDropdownKind,
  openToolbarDropdownAtom,
  toolbarActiveSurfaceAtom,
  toolbarIntentAtom,
} from '../src/toolbar'
import { selectCellAtom } from '../src/selection'
import { setWorkspaceActiveSheetAtom } from '../src/workspace'
import { startEditingAtom } from '../src/editing'

describe('cell-format-expansion', () => {
  test('SpreadsheetCellFormat accepts border fields', () => {
    const fmt: SpreadsheetCellFormat = {
      borders: { top: { style: 'thin', color: '#000' } },
    }
    expect(fmt.borders?.top?.style).toBe('thin')
    expect(fmt.borders?.top?.color).toBe('#000')
  })

  test('SpreadsheetCellFormat accepts underline, strikethrough, wrap, indent', () => {
    const fmt: SpreadsheetCellFormat = {
      underline: true,
      strikethrough: true,
      wrap: true,
      indent: 2,
    }
    expect(fmt.underline).toBe(true)
    expect(fmt.strikethrough).toBe(true)
    expect(fmt.wrap).toBe(true)
    expect(fmt.indent).toBe(2)
  })

  test('borders.top.style: none is accepted as explicit erase signal', () => {
    const borders: SpreadsheetBorders = { top: { style: 'none' } }
    expect(borders.top?.style).toBe('none')
  })

  test('openToolbarDropdownAtom accepts border kind', () => {
    const store = createStore()
    store.setter(openToolbarDropdownAtom, { dropdown: 'border' })
    expect(store.getter(toolbarActiveSurfaceAtom)).toEqual({
      kind: 'dropdown',
      id: 'border',
    })
    expect(store.getter(toolbarIntentAtom)).toEqual({
      type: 'toolbar.surface.open',
      source: 'toolbar',
      surface: { kind: 'dropdown', id: 'border' },
    })
  })

  test('isToolbarDropdownKind returns true for border', () => {
    expect(isToolbarDropdownKind('border')).toBe(true)
    expect(isToolbarDropdownKind('alignment')).toBe(true)
    expect(isToolbarDropdownKind('number-format')).toBe(true)
    expect(isToolbarDropdownKind('text-color')).toBe(false)
  })

  test('getToolbarCommandAvailability returns true for new commands when canStyleSelection', () => {
    const availability = getToolbarCommandAvailability({
      sheetId: 'Sheet1',
      selectionKind: 'cell',
      editingMode: 'idle',
    })
    expect(availability.underline).toBe(true)
    expect(availability.strikethrough).toBe(true)
    expect(availability.wrap).toBe(true)
    expect(availability.indent).toBe(true)
    expect(availability.border).toBe(true)
  })

  test('getToolbarCommandAvailability returns false for new commands when editing', () => {
    const availability = getToolbarCommandAvailability({
      sheetId: 'Sheet1',
      selectionKind: 'cell',
      editingMode: 'drafting',
    })
    expect(availability.underline).toBe(false)
    expect(availability.strikethrough).toBe(false)
    expect(availability.wrap).toBe(false)
    expect(availability.indent).toBe(false)
    expect(availability.border).toBe(false)
  })

  test('dispatchToolbarFormatCommandAtom with underline produces correct intent', () => {
    const store = createStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'Sheet1' })
    store.setter(selectCellAtom, { sheetId: 'Sheet1', coord: { row: 0, col: 0 } })

    const intent = store.setter(dispatchToolbarFormatCommandAtom, { command: 'underline' })
    expect(intent).toEqual({
      type: 'toolbar.format.command',
      source: 'toolbar',
      sheetId: 'Sheet1',
      selectionKind: 'cell',
      command: 'underline',
      value: null,
    })
  })

  test('dispatchToolbarFormatCommandAtom suppressed when editing (drafting)', () => {
    const store = createStore()
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'Sheet1' })
    store.setter(selectCellAtom, { sheetId: 'Sheet1', coord: { row: 0, col: 0 } })
    store.setter(startEditingAtom, {
      sheetId: 'Sheet1',
      cell: { row: 0, col: 0 },
      draft: 'x',
      source: 'cell',
    })

    const intent = store.setter(dispatchToolbarFormatCommandAtom, { command: 'underline' })
    expect(intent).toBeNull()
  })
})
