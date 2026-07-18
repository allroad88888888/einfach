import { atom, createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import type { CellRange } from '../src/shared'
import {
  DEFAULT_SELECTION_BOUNDS,
  DEFAULT_SELECTION_STATE,
  activeCellAtom,
  addSelectionRegionAtom,
  clearNonPrimaryRegionsAtom,
  selectAllAtom,
  selectCellAtom,
  selectColumnsAtom,
  selectRowsAtom,
  selectionAuthorityReceiptIsCurrentAtom,
  selectionAuthorityWitnessAtom,
  selectionAtom,
  selectionBoundsAtom,
  selectionRangeAtom,
  selectionRegionsAtom,
  selectionSnapshotAtom,
  setSelectionBoundsAtom,
  setSelectionAtom,
  setMultiRegionSelectionAtom,
  setPrimaryRegionAtom,
  setSelectionWithAuthorityReceiptAtom,
} from '../src/selection'
import type { SelectionBounds, SelectionState } from '../src/selection'

describe('selection core', () => {
  test('validates a guarded receipt from private authority inside the same transaction', () => {
    const store = createStore()
    const selection = {
      kind: 'cell' as const,
      sheetId: 'Sheet1',
      anchor: { row: 3, col: 4 },
      focus: { row: 3, col: 4 },
    }
    const setAndValidateAtom = atom(null, (_get, set): boolean => {
      const receipt = set(setSelectionWithAuthorityReceiptAtom, selection)
      return receipt !== null && set(selectionAuthorityReceiptIsCurrentAtom, receipt)
    })

    expect(store.setter(setAndValidateAtom)).toBe(true)
    expect(store.getter(selectionAtom)).toEqual(selection)
  })

  test('guarded receipt validation rejects stale and A-B-A selection authority', () => {
    const store = createStore()
    const selectionA = {
      kind: 'cell' as const,
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 2 },
      focus: { row: 1, col: 2 },
    }
    const selectionB = {
      kind: 'cell' as const,
      sheetId: 'Sheet1',
      anchor: { row: 7, col: 8 },
      focus: { row: 7, col: 8 },
    }

    const staleReceipt = store.setter(setSelectionWithAuthorityReceiptAtom, selectionA)
    expect(staleReceipt).not.toBeNull()
    store.setter(setSelectionAtom, selectionB)
    expect(store.setter(selectionAuthorityReceiptIsCurrentAtom, staleReceipt!)).toBe(false)

    const abaReceipt = store.setter(setSelectionWithAuthorityReceiptAtom, selectionA)
    expect(abaReceipt).not.toBeNull()
    store.setter(setSelectionAtom, selectionB)
    store.setter(setSelectionAtom, selectionA)
    expect(store.setter(selectionAuthorityReceiptIsCurrentAtom, abaReceipt!)).toBe(false)
    expect(store.getter(selectionAtom)).toEqual(selectionA)
  })

  test('clamps cell selection to sheet bounds', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(selectCellAtom, {
      sheetId: 'Sheet1',
      coord: { row: 20, col: 9 },
    })

    expect(store.getter(activeCellAtom)).toEqual({
      sheetId: 'Sheet1',
      row: 9,
      col: 4,
    })
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 9,
      rowEnd: 9,
      colStart: 4,
      colEnd: 4,
    })
  })

  test('extends ranges by keeping only anchor and focus boundaries', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 1_000_000, colCount: 16_000 })
    store.setter(selectCellAtom, {
      sheetId: 'Sheet1',
      coord: { row: 2, col: 3 },
    })
    store.setter(selectCellAtom, {
      coord: { row: 999_999, col: 15_999 },
      extend: true,
    })

    expect(store.getter(selectionAtom)).toEqual({
      kind: 'range',
      sheetId: 'Sheet1',
      anchor: { row: 2, col: 3 },
      focus: { row: 999_999, col: 15_999 },
    })
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 2,
      rowEnd: 999_999,
      colStart: 3,
      colEnd: 15_999,
    })
    expect('cells' in store.getter(selectionAtom)).toBe(false)
  })

  test('derives row, column, and all selections from boundaries', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(selectRowsAtom, {
      sheetId: 'Sheet1',
      rowAnchor: 4,
      rowFocus: 2,
    })

    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 2,
      rowEnd: 4,
      colStart: 0,
      colEnd: 4,
    })
    expect(store.getter(activeCellAtom)).toEqual({
      sheetId: 'Sheet1',
      row: 2,
      col: 0,
    })

    store.setter(selectColumnsAtom, {
      colAnchor: 3,
      colFocus: 1,
    })
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 1,
      colEnd: 3,
    })

    store.setter(selectAllAtom)
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 0,
      rowEnd: 9,
      colStart: 0,
      colEnd: 4,
    })
  })

  test('normalizes direct selection writes', () => {
    const store = createStore()

    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 5 })
    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'Sheet1',
      anchor: { row: 50, col: -5 },
      focus: { row: 50, col: -5 },
    })

    expect(store.getter(selectionAtom)).toEqual({
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 9, col: 0 },
      focus: { row: 9, col: 0 },
    })
  })

  test('rotates primary-selection authority across A to B to A without token reuse', () => {
    const store = createStore()
    const selectionA = {
      kind: 'range' as const,
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 3, col: 3 },
    }
    const selectionB = {
      kind: 'cell' as const,
      sheetId: 'Sheet1',
      anchor: { row: 8, col: 8 },
      focus: { row: 8, col: 8 },
    }
    store.setter(setSelectionAtom, selectionA)
    const witnessA = store.getter(selectionAuthorityWitnessAtom)

    store.setter(selectionAtom, selectionB)
    const witnessB = store.getter(selectionAuthorityWitnessAtom)

    store.setter(selectionAtom, selectionA)
    const witnessReturnedA = store.getter(selectionAuthorityWitnessAtom)

    expect(witnessB).not.toBe(witnessA)
    expect(witnessReturnedA).not.toBe(witnessA)
    expect(witnessReturnedA).not.toBe(witnessB)
    expect(store.getter(selectionAtom)).toEqual(selectionA)
  })

  test('bounds and primary writes rotate authority while non-primary-only writes do not', () => {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 10 })
    store.setter(selectAllAtom, 'Sheet1')
    const witnessBeforeBounds = store.getter(selectionAuthorityWitnessAtom)

    store.setter(selectionBoundsAtom, (previous) => ({
      ...previous,
      rowCount: 8,
    }))
    const witnessAfterBounds = store.getter(selectionAuthorityWitnessAtom)
    expect(witnessAfterBounds).not.toBe(witnessBeforeBounds)
    expect(store.getter(selectionRangeAtom)).toEqual({
      rowStart: 0,
      rowEnd: 7,
      colStart: 0,
      colEnd: 9,
    })

    store.setter(addSelectionRegionAtom, {
      region: {
        kind: 'cell',
        sheetId: 'Sheet1',
        anchor: { row: 5, col: 5 },
        focus: { row: 5, col: 5 },
      },
      makePrimary: false,
    })
    expect(store.getter(selectionAuthorityWitnessAtom)).toBe(witnessAfterBounds)

    store.setter(addSelectionRegionAtom, {
      region: {
        kind: 'cell',
        sheetId: 'Sheet1',
        anchor: { row: 6, col: 6 },
        focus: { row: 6, col: 6 },
      },
    })
    expect(store.getter(selectionAuthorityWitnessAtom)).not.toBe(witnessAfterBounds)
  })

  test('selection subscribers observe only the final witness and target pair', () => {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 10 })
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    })
    const priorWitness = store.getter(selectionAuthorityWitnessAtom)
    const observations: Array<{
      readonly witness: object
      readonly selection: SelectionState
      readonly range: CellRange
    }> = []
    const capture = () => {
      observations.push({
        witness: store.getter(selectionAuthorityWitnessAtom),
        selection: store.getter(selectionAtom),
        range: store.getter(selectionRangeAtom),
      })
    }
    const unsubscribeWitness = store.sub(selectionAuthorityWitnessAtom, capture)
    const unsubscribeSelection = store.sub(selectionAtom, capture)
    const unsubscribeRange = store.sub(selectionRangeAtom, capture)

    store.setter(selectionAtom, {
      kind: 'range',
      sheetId: 'Sheet1',
      anchor: { row: 2, col: 3 },
      focus: { row: 4, col: 5 },
    })
    const finalWitness = store.getter(selectionAuthorityWitnessAtom)

    unsubscribeWitness()
    unsubscribeSelection()
    unsubscribeRange()
    expect(finalWitness).not.toBe(priorWitness)
    expect(observations.length).toBeGreaterThan(0)
    for (const observation of observations) {
      expect(observation.witness).toBe(finalWitness)
      expect(observation.selection).toEqual({
        kind: 'range',
        sheetId: 'Sheet1',
        anchor: { row: 2, col: 3 },
        focus: { row: 4, col: 5 },
      })
      expect(observation.range).toEqual({
        rowStart: 2,
        rowEnd: 4,
        colStart: 3,
        colEnd: 5,
      })
    }
  })

  test('bounds subscribers observe only the final witness and target pair', () => {
    const store = createStore()
    store.setter(setSelectionBoundsAtom, { rowCount: 10, colCount: 10 })
    store.setter(selectAllAtom, 'Sheet1')
    const priorWitness = store.getter(selectionAuthorityWitnessAtom)
    const observations: Array<{
      readonly witness: object
      readonly bounds: SelectionBounds
      readonly range: CellRange
    }> = []
    const capture = () => {
      observations.push({
        witness: store.getter(selectionAuthorityWitnessAtom),
        bounds: store.getter(selectionBoundsAtom),
        range: store.getter(selectionRangeAtom),
      })
    }
    const unsubscribeWitness = store.sub(selectionAuthorityWitnessAtom, capture)
    const unsubscribeBounds = store.sub(selectionBoundsAtom, capture)
    const unsubscribeRange = store.sub(selectionRangeAtom, capture)

    store.setter(selectionBoundsAtom, (previous) => ({
      ...previous,
      rowCount: 6,
      colCount: 7,
    }))
    const finalWitness = store.getter(selectionAuthorityWitnessAtom)

    unsubscribeWitness()
    unsubscribeBounds()
    unsubscribeRange()
    expect(finalWitness).not.toBe(priorWitness)
    expect(observations.length).toBeGreaterThan(0)
    for (const observation of observations) {
      expect(observation.witness).toBe(finalWitness)
      expect(observation.bounds).toEqual({ rowCount: 6, colCount: 7 })
      expect(observation.range).toEqual({
        rowStart: 0,
        rowEnd: 5,
        colStart: 0,
        colEnd: 6,
      })
    }
  })

  test('public bounds and multi-selection facades cannot leak mutable authority aliases', () => {
    const store = createStore()
    const directBounds = { rowCount: 10, colCount: 10 }

    store.setter(selectionBoundsAtom, directBounds)
    const witnessBeforeCallerMutation = store.getter(selectionAuthorityWitnessAtom)
    directBounds.rowCount = 2

    expect(store.getter(selectionBoundsAtom)).toEqual({ rowCount: 10, colCount: 10 })
    expect(store.getter(selectionAuthorityWitnessAtom)).toBe(witnessBeforeCallerMutation)
    expect(Object.isFrozen(DEFAULT_SELECTION_BOUNDS)).toBe(true)
    expect(Object.isFrozen(DEFAULT_SELECTION_STATE)).toBe(true)
    expect(Object.isFrozen(DEFAULT_SELECTION_STATE.anchor)).toBe(true)

    const publicBounds = store.getter(selectionBoundsAtom)
    expect(Object.isFrozen(publicBounds)).toBe(true)
    expect(() => {
      publicBounds.rowCount = 3
    }).toThrow(TypeError)

    store.setter(selectionBoundsAtom, (previous) => {
      expect(Object.isFrozen(previous)).toBe(true)
      previous.rowCount = 6
      return previous
    })
    expect(store.getter(selectionBoundsAtom)).toEqual({ rowCount: 10, colCount: 10 })
    expect(store.getter(selectionAuthorityWitnessAtom)).toBe(witnessBeforeCallerMutation)

    const publicMulti = store.getter(addSelectionRegionAtom)
    const publicPrimary = publicMulti.regions[publicMulti.primaryIndex]
    if (publicPrimary === undefined) throw new Error('Expected a primary selection')
    expect(Object.isFrozen(publicMulti)).toBe(true)
    expect(Object.isFrozen(publicMulti.regions)).toBe(true)
    expect(Object.isFrozen(publicPrimary)).toBe(true)
    expect(() => {
      publicPrimary.sheetId = 'forged-sheet'
    }).toThrow(TypeError)
    const publicSnapshot = store.getter(selectionSnapshotAtom)
    expect(Object.isFrozen(publicSnapshot)).toBe(true)
    expect(Object.isFrozen(publicSnapshot.selection)).toBe(true)
    expect(Object.isFrozen(publicSnapshot.activeCell)).toBe(true)
    expect(Object.isFrozen(publicSnapshot.range)).toBe(true)
    expect(Object.isFrozen(store.getter(activeCellAtom))).toBe(true)
    expect(Object.isFrozen(store.getter(selectionRangeAtom))).toBe(true)
    expect(store.getter(selectionAtom).sheetId).toBe('')
  })

  test('rejects every invalid multi-selection primary index without clamping', () => {
    const store = createStore()
    const initial = store.getter(selectionRegionsAtom)
    const region = {
      kind: 'cell' as const,
      sheetId: 'Sheet1',
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    }

    for (const primaryIndex of [-1, 1, Number.MAX_SAFE_INTEGER, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      store.setter(setMultiRegionSelectionAtom, { regions: [region], primaryIndex })
      expect(store.getter(selectionRegionsAtom)).toEqual(initial)
    }

    store.setter(setMultiRegionSelectionAtom, { regions: [], primaryIndex: 1 })
    expect(store.getter(selectionRegionsAtom)).toEqual(initial)
  })

  test('unsafe numeric command inputs are strict no-ops', () => {
    const store = createStore()
    const before = store.getter(selectionSnapshotAtom)
    const beforeWitness = store.getter(selectionAuthorityWitnessAtom)

    store.setter(selectCellAtom, { coord: { row: 1e100, col: 0 } })
    store.setter(selectRowsAtom, { rowAnchor: Number.MAX_SAFE_INTEGER + 1 })
    store.setter(selectColumnsAtom, { colAnchor: 1.25 })
    store.setter(setSelectionBoundsAtom, { rowCount: 1e100, colCount: 4 })

    expect(store.getter(selectionSnapshotAtom)).toEqual(before)
    expect(store.getter(selectionAuthorityWitnessAtom)).toBe(beforeWitness)
  })

  test('every selection write funnel rejects overlong sheet identifiers', () => {
    const overlongSheetId = 's'.repeat(513)
    const cell = {
      kind: 'cell' as const,
      sheetId: overlongSheetId,
      anchor: { row: 1, col: 1 },
      focus: { row: 1, col: 1 },
    }
    const operations: Array<(store: ReturnType<typeof createStore>) => void> = [
      (store) => store.setter(selectionAtom, cell),
      (store) => store.setter(setSelectionAtom, cell),
      (store) => store.setter(setPrimaryRegionAtom, cell),
      (store) =>
        store.setter(selectCellAtom, {
          sheetId: overlongSheetId,
          coord: { row: 1, col: 1 },
        }),
      (store) => store.setter(selectRowsAtom, { sheetId: overlongSheetId, rowAnchor: 1 }),
      (store) => store.setter(selectColumnsAtom, { sheetId: overlongSheetId, colAnchor: 1 }),
      (store) => store.setter(selectAllAtom, overlongSheetId),
      (store) => store.setter(addSelectionRegionAtom, { region: cell }),
      (store) => store.setter(setMultiRegionSelectionAtom, { regions: [cell] }),
    ]

    for (const operation of operations) {
      const store = createStore()
      const before = store.getter(selectionSnapshotAtom)
      const beforeWitness = store.getter(selectionAuthorityWitnessAtom)
      operation(store)
      expect(store.getter(selectionSnapshotAtom)).toEqual(before)
      expect(store.getter(selectionAuthorityWitnessAtom)).toBe(beforeWitness)
    }
  })
})
