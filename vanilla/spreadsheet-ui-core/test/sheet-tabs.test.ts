import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  applySheetTabIntent,
  createBeginSheetTabReorderIntent,
  createBeginSheetTabRenameIntent,
  createCommitSheetTabRenameIntent,
  createCommitSheetTabReorderIntent,
  createOpenSheetTabContextMenuIntent,
  createUpdateSheetTabReorderIntent,
  createUpdateSheetTabRenameIntent,
  dispatchSheetTabIntentAtom,
  getAdjacentSheetId,
  normalizeSheetTabDraftName,
  setSheetTabsSheetsAtom,
  sheetTabsAtom,
  sheetTabsSheetsAtom,
} from '../src/sheet-tabs'

describe('sheet tabs core', () => {
  test('tracks context menu, rename, and reorder interaction state', () => {
    const store = createStore()

    store.setter(
      dispatchSheetTabIntentAtom,
      createOpenSheetTabContextMenuIntent({
        sheetId: 'sheet-1',
        x: 12.9,
        y: 6.1,
      }),
    )

    store.setter(
      dispatchSheetTabIntentAtom,
      createBeginSheetTabRenameIntent({
        sheetId: 'sheet-1',
        draftName: '  Sales  ',
      })!,
    )

    expect(createBeginSheetTabRenameIntent({
      sheetId: 'sheet-1',
      draftName: '  Sales  ',
    })).toMatchObject({
      type: 'sheet-tab.rename.begin',
      draftName: '  Sales  ',
    })
    expect(createUpdateSheetTabRenameIntent('sheet-1', '  Q1 Sales  ')).toEqual({
      type: 'sheet-tab.rename.change',
      sheetId: 'sheet-1',
      draftName: '  Q1 Sales  ',
    })

    store.setter(
      dispatchSheetTabIntentAtom,
      createUpdateSheetTabRenameIntent('sheet-1', '  Q1 Sales  ')!,
    )

    store.setter(
      dispatchSheetTabIntentAtom,
      createCommitSheetTabRenameIntent({
        sheetId: 'sheet-1',
        name: ' Q1 Sales ',
      })!,
    )

    store.setter(
      dispatchSheetTabIntentAtom,
      createBeginSheetTabReorderIntent({
        sheetId: 'sheet-1',
      }),
    )

    store.setter(
      dispatchSheetTabIntentAtom,
      createUpdateSheetTabReorderIntent({
        sheetId: 'sheet-1',
        beforeSheetId: 'sheet-3',
        afterSheetId: null,
        targetIndex: 2,
      }),
    )

    store.setter(
      dispatchSheetTabIntentAtom,
      createCommitSheetTabReorderIntent({
        sheetId: 'sheet-1',
        beforeSheetId: 'sheet-3',
        afterSheetId: null,
        targetIndex: 2,
      }),
    )

    expect(store.getter(sheetTabsAtom)).toEqual({
      contextMenu: null,
      rename: null,
      reorder: null,
      lastIntent: {
        type: 'sheet-tab.reorder.commit',
        sheetId: 'sheet-1',
        beforeSheetId: 'sheet-3',
        afterSheetId: null,
        targetIndex: 2,
      },
    })
  })

  test('rejects empty rename drafts and leaves current state unchanged', () => {
    const store = createStore()

    const initialState = store.getter(sheetTabsAtom)
    expect(normalizeSheetTabDraftName('   ')).toBeNull()
    expect(createBeginSheetTabRenameIntent({ sheetId: 'sheet-1', draftName: '   ' })).toBeNull()
    expect(createCommitSheetTabRenameIntent({ sheetId: 'sheet-1', name: '   ' })).toBeNull()

    expect(applySheetTabIntent(initialState, { type: 'sheet-tab.rename.cancel', sheetId: 'x', reason: 'escape' })).toBe(initialState)
  })

  test('stores normalized workbook sheet metadata without materializing cell state', () => {
    const store = createStore()

    store.setter(setSheetTabsSheetsAtom, {
      revision: 3,
      sheets: [
        { id: ' sheet-1 ', name: ' Sheet1 ', index: 7 },
        { id: 'sheet-2', name: 'Sheet2', index: 1 },
        { id: 'sheet-2', name: 'Duplicate id', index: 2 },
        { id: '', name: 'Bad', index: 3 },
      ],
    })

    expect(store.getter(sheetTabsSheetsAtom)).toEqual([
      { id: 'sheet-1', name: 'Sheet1', index: 7 },
      { id: 'sheet-2', name: 'Sheet2', index: 1 },
    ])
  })

  test('resolves adjacent sheet ids in displayed order with wraparound', () => {
    const sheets = [
      { id: 'sheet-1', name: 'Sheet1', index: 0 },
      { id: 'sheet-2', name: 'Sheet2', index: 1 },
      { id: 'sheet-3', name: 'Sheet3', index: 2 },
    ]

    expect(getAdjacentSheetId(sheets, 'sheet-1', 'next')).toBe('sheet-2')
    expect(getAdjacentSheetId(sheets, 'sheet-1', 'previous')).toBe('sheet-3')
    expect(getAdjacentSheetId(sheets, 'sheet-3', 'next')).toBe('sheet-1')
    expect(getAdjacentSheetId(sheets, 'missing', 'next')).toBe('sheet-1')
    expect(getAdjacentSheetId([], 'sheet-1', 'next')).toBeNull()
  })
})
