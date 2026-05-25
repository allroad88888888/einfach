import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  activeCellAtom,
  addSelectionRegionAtom,
  clearNonPrimaryRegionsAtom,
  primarySelectionRegionAtom,
  selectAllAtom,
  selectCellAtom,
  selectionRangeAtom,
  selectionRegionsAtom,
  selectionSnapshotAtom,
  setMultiRegionSelectionAtom,
  setSelectionAtom,
  setSelectionBoundsAtom,
} from '../src/selection'
import type { SelectionState } from '../src/selection'
import { dispatchKeyboardInputAtom } from '../src/keyboard'

describe('multi-range selection', () => {
  test('initial state has one region at (0,0) cell', () => {
    const store = createStore()
    const regions = store.getter(selectionRegionsAtom)

    expect(regions).toHaveLength(1)
    expect(regions[0]).toEqual({ kind: 'cell', sheetId: '', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
    expect(store.getter(primarySelectionRegionAtom)).toEqual(regions[0])
  })

  test('setting via legacy setSelectionAtom wraps to multi-range', () => {
    const store = createStore()

    store.setter(setSelectionAtom, { kind: 'cell', sheetId: 'S1', anchor: { row: 1, col: 2 }, focus: { row: 1, col: 2 } })

    const regions = store.getter(selectionRegionsAtom)
    expect(regions).toHaveLength(1)
    expect(regions[0]).toEqual({ kind: 'cell', sheetId: 'S1', anchor: { row: 1, col: 2 }, focus: { row: 1, col: 2 } })
  })

  test('addSelectionRegionAtom appends a region; primaryIndex defaults to new region', () => {
    const store = createStore()

    store.setter(setSelectionAtom, { kind: 'cell', sheetId: 'S1', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
    store.setter(addSelectionRegionAtom, {
      region: { kind: 'cell', sheetId: 'S1', anchor: { row: 3, col: 3 }, focus: { row: 3, col: 3 } },
    })

    const regions = store.getter(selectionRegionsAtom)
    expect(regions).toHaveLength(2)
    expect(store.getter(primarySelectionRegionAtom)).toEqual(regions[1])
    expect(store.getter(activeCellAtom)).toEqual({ sheetId: 'S1', row: 3, col: 3 })
  })

  test('addSelectionRegionAtom with makePrimary: false does not shift primaryIndex', () => {
    const store = createStore()

    store.setter(setSelectionAtom, { kind: 'cell', sheetId: 'S1', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
    store.setter(addSelectionRegionAtom, {
      region: { kind: 'cell', sheetId: 'S1', anchor: { row: 5, col: 5 }, focus: { row: 5, col: 5 } },
      makePrimary: false,
    })

    const regions = store.getter(selectionRegionsAtom)
    expect(regions).toHaveLength(2)
    expect(store.getter(primarySelectionRegionAtom)).toEqual(regions[0])
    expect(store.getter(activeCellAtom)).toEqual({ sheetId: 'S1', row: 0, col: 0 })
  })

  test('clearNonPrimaryRegionsAtom with keepPrimary: true retains primary region only', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 10 })
    store.setter(setSelectionAtom, { kind: 'cell', sheetId: 'S1', anchor: { row: 2, col: 2 }, focus: { row: 2, col: 2 } })
    store.setter(addSelectionRegionAtom, {
      region: { kind: 'cell', sheetId: 'S1', anchor: { row: 4, col: 4 }, focus: { row: 4, col: 4 } },
      makePrimary: false,
    })
    store.setter(addSelectionRegionAtom, {
      region: { kind: 'cell', sheetId: 'S1', anchor: { row: 6, col: 6 }, focus: { row: 6, col: 6 } },
      makePrimary: false,
    })

    expect(store.getter(selectionRegionsAtom)).toHaveLength(3)

    store.setter(clearNonPrimaryRegionsAtom, { keepPrimary: true })

    const regions = store.getter(selectionRegionsAtom)
    expect(regions).toHaveLength(1)
    expect(regions[0]).toEqual({ kind: 'cell', sheetId: 'S1', anchor: { row: 2, col: 2 }, focus: { row: 2, col: 2 } })
  })

  test('clearNonPrimaryRegionsAtom without flag resets to DEFAULT_SELECTION_STATE', () => {
    const store = createStore()

    store.setter(setSelectionAtom, { kind: 'cell', sheetId: 'S1', anchor: { row: 2, col: 2 }, focus: { row: 2, col: 2 } })
    store.setter(addSelectionRegionAtom, {
      region: { kind: 'cell', sheetId: 'S1', anchor: { row: 4, col: 4 }, focus: { row: 4, col: 4 } },
    })

    store.setter(clearNonPrimaryRegionsAtom)

    const regions = store.getter(selectionRegionsAtom)
    expect(regions).toHaveLength(1)
    expect(regions[0]).toEqual({ kind: 'cell', sheetId: '', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
  })

  test('selectAllAtom replaces all regions with a single all region', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, { kind: 'cell', sheetId: 'S1', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
    store.setter(addSelectionRegionAtom, {
      region: { kind: 'cell', sheetId: 'S1', anchor: { row: 3, col: 3 }, focus: { row: 3, col: 3 } },
    })

    expect(store.getter(selectionRegionsAtom)).toHaveLength(2)

    store.setter(selectAllAtom)

    const regions = store.getter(selectionRegionsAtom)
    expect(regions).toHaveLength(1)
    expect(regions[0]).toEqual({ kind: 'all', sheetId: 'S1' })
    expect(store.getter(selectionRangeAtom)).toEqual({ rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 4 })
  })

  test('derived atoms read the primary region', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 10 })
    store.setter(setSelectionAtom, { kind: 'cell', sheetId: 'S1', anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } })
    store.setter(addSelectionRegionAtom, {
      region: { kind: 'range', sheetId: 'S1', anchor: { row: 5, col: 5 }, focus: { row: 7, col: 7 } },
      makePrimary: false,
    })

    expect(store.getter(selectionRegionsAtom)).toHaveLength(2)
    expect(store.getter(activeCellAtom)).toEqual({ sheetId: 'S1', row: 1, col: 1 })
    expect(store.getter(selectionRangeAtom)).toEqual({ rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 })

    const snapshot = store.getter(selectionSnapshotAtom)
    expect(snapshot.activeCell).toEqual({ sheetId: 'S1', row: 1, col: 1 })
    expect(snapshot.range).toEqual({ rowStart: 1, rowEnd: 1, colStart: 1, colEnd: 1 })
  })

  test('arrow key moves primary region only; non-primary regions stay put', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 10 })
    store.setter(setSelectionAtom, { kind: 'cell', sheetId: 'S1', anchor: { row: 2, col: 2 }, focus: { row: 2, col: 2 } })
    store.setter(addSelectionRegionAtom, {
      region: { kind: 'cell', sheetId: 'S1', anchor: { row: 7, col: 7 }, focus: { row: 7, col: 7 } },
      makePrimary: false,
    })

    const regionsBefore = store.getter(selectionRegionsAtom)
    expect(regionsBefore[1]).toEqual({ kind: 'cell', sheetId: 'S1', anchor: { row: 7, col: 7 }, focus: { row: 7, col: 7 } })

    store.setter(dispatchKeyboardInputAtom, { key: 'ArrowRight' })
    store.setter(dispatchKeyboardInputAtom, { key: 'ArrowDown' })

    expect(store.getter(activeCellAtom)).toEqual({ sheetId: 'S1', row: 3, col: 3 })

    const regionsAfter = store.getter(selectionRegionsAtom)
    expect(regionsAfter[1]).toEqual({ kind: 'cell', sheetId: 'S1', anchor: { row: 7, col: 7 }, focus: { row: 7, col: 7 } })
  })

  test('Escape collapses multiple regions through the keyboard core intent', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 10 })
    store.setter(setSelectionAtom, { kind: 'cell', sheetId: 'S1', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
    store.setter(addSelectionRegionAtom, {
      region: { kind: 'cell', sheetId: 'S1', anchor: { row: 3, col: 3 }, focus: { row: 3, col: 3 } },
    })

    const intent = store.setter(dispatchKeyboardInputAtom, { key: 'Escape' })

    expect(intent).toEqual({ type: 'selection.clearNonPrimary', keepPrimary: true })
    expect(store.getter(selectionRegionsAtom)).toEqual([
      { kind: 'cell', sheetId: 'S1', anchor: { row: 3, col: 3 }, focus: { row: 3, col: 3 } },
    ])
  })

  test('Escape with a single region falls through as unhandled navigation input', () => {
    const store = createStore()

    store.setter(setSelectionAtom, { kind: 'cell', sheetId: 'S1', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })

    expect(store.setter(dispatchKeyboardInputAtom, { key: 'Escape' })).toEqual({
      type: 'none',
      reason: 'unhandled',
    })
    expect(store.getter(selectionRegionsAtom)).toEqual([
      { kind: 'cell', sheetId: 'S1', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } },
    ])
  })

  test('selectionRegionsAtom returns a defensive snapshot', () => {
    const store = createStore()

    store.setter(setSelectionAtom, { kind: 'cell', sheetId: 'S1', anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } })
    store.setter(addSelectionRegionAtom, {
      region: { kind: 'cell', sheetId: 'S1', anchor: { row: 4, col: 4 }, focus: { row: 4, col: 4 } },
    })

    const regions = store.getter(selectionRegionsAtom) as SelectionState[]
    expect(() => {
      regions.push({ kind: 'cell', sheetId: 'S1', anchor: { row: 9, col: 9 }, focus: { row: 9, col: 9 } })
    }).toThrow()
    const firstRegion = regions[0]
    if (firstRegion.kind !== 'cell') {
      throw new Error('expected cell region')
    }
    try {
      firstRegion.anchor.row = 99
    } catch {
      // Store implementations may freeze atom snapshots in test mode.
    }

    expect(store.getter(selectionRegionsAtom)).toEqual([
      { kind: 'cell', sheetId: 'S1', anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } },
      { kind: 'cell', sheetId: 'S1', anchor: { row: 4, col: 4 }, focus: { row: 4, col: 4 } },
    ])
  })

  test('selectCellAtom replaces all regions with a single cell region', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 10 })
    store.setter(setSelectionAtom, { kind: 'cell', sheetId: 'S1', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
    store.setter(addSelectionRegionAtom, {
      region: { kind: 'cell', sheetId: 'S1', anchor: { row: 5, col: 5 }, focus: { row: 5, col: 5 } },
    })

    expect(store.getter(selectionRegionsAtom)).toHaveLength(2)

    store.setter(selectCellAtom, { sheetId: 'S1', coord: { row: 3, col: 3 } })

    expect(store.getter(selectionRegionsAtom)).toHaveLength(1)
    expect(store.getter(activeCellAtom)).toEqual({ sheetId: 'S1', row: 3, col: 3 })
  })

  test('single-region path produces identical output to prior implementation', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, { kind: 'range', sheetId: 'S1', anchor: { row: 2, col: 1 }, focus: { row: 4, col: 3 } })

    expect(store.getter(selectionRegionsAtom)).toHaveLength(1)
    expect(store.getter(activeCellAtom)).toEqual({ sheetId: 'S1', row: 4, col: 3 })
    expect(store.getter(selectionRangeAtom)).toEqual({ rowStart: 2, rowEnd: 4, colStart: 1, colEnd: 3 })
    expect(store.getter(primarySelectionRegionAtom)).toEqual({ kind: 'range', sheetId: 'S1', anchor: { row: 2, col: 1 }, focus: { row: 4, col: 3 } })
  })

  describe('setMultiRegionSelectionAtom', () => {
    test('replaces the current selection with the supplied regions in one write', () => {
      const store = createStore()
      store.setter(setSelectionBoundsAtom, { rowCount: 20, colCount: 20 })
      store.setter(setSelectionAtom, { kind: 'cell', sheetId: 'S1', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })
      // Establish a different starting selection so we can assert the replace.
      store.setter(addSelectionRegionAtom, {
        region: { kind: 'cell', sheetId: 'S1', anchor: { row: 9, col: 9 }, focus: { row: 9, col: 9 } },
      })
      expect(store.getter(selectionRegionsAtom)).toHaveLength(2)

      const matches: SelectionState[] = [
        { kind: 'cell', sheetId: 'S1', anchor: { row: 2, col: 2 }, focus: { row: 2, col: 2 } },
        { kind: 'cell', sheetId: 'S1', anchor: { row: 5, col: 1 }, focus: { row: 5, col: 1 } },
        { kind: 'range', sheetId: 'S1', anchor: { row: 7, col: 3 }, focus: { row: 8, col: 4 } },
      ]
      store.setter(setMultiRegionSelectionAtom, { regions: matches })

      expect(store.getter(selectionRegionsAtom)).toHaveLength(3)
      // primaryIndex defaults to 0 when omitted; activeCell snaps to that.
      expect(store.getter(activeCellAtom)).toEqual({ sheetId: 'S1', row: 2, col: 2 })
    })

    test('honors explicit primaryIndex', () => {
      const store = createStore()
      store.setter(setSelectionBoundsAtom, { rowCount: 20, colCount: 20 })
      store.setter(setMultiRegionSelectionAtom, {
        regions: [
          { kind: 'cell', sheetId: 'S1', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } },
          { kind: 'cell', sheetId: 'S1', anchor: { row: 5, col: 5 }, focus: { row: 5, col: 5 } },
        ],
        primaryIndex: 1,
      })
      expect(store.getter(activeCellAtom)).toEqual({ sheetId: 'S1', row: 5, col: 5 })
    })

    test('out-of-range primaryIndex clamps into the regions array', () => {
      const store = createStore()
      store.setter(setSelectionBoundsAtom, { rowCount: 20, colCount: 20 })
      store.setter(setMultiRegionSelectionAtom, {
        regions: [{ kind: 'cell', sheetId: 'S1', anchor: { row: 1, col: 1 }, focus: { row: 1, col: 1 } }],
        primaryIndex: 99,
      })
      expect(store.getter(activeCellAtom)).toEqual({ sheetId: 'S1', row: 1, col: 1 })
    })

    test('empty regions array resets to a single default empty selection on the current sheet', () => {
      const store = createStore()
      store.setter(setSelectionBoundsAtom, { rowCount: 20, colCount: 20 })
      store.setter(setSelectionAtom, {
        kind: 'cell',
        sheetId: 'S2',
        anchor: { row: 4, col: 4 },
        focus: { row: 4, col: 4 },
      })
      store.setter(setMultiRegionSelectionAtom, { regions: [] })
      const regions = store.getter(selectionRegionsAtom)
      expect(regions).toHaveLength(1)
      expect(regions[0].sheetId).toBe('S2')
    })
  })
})
