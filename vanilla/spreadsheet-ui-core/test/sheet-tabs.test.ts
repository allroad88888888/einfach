import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import type {
  SheetListResult,
  SheetMutationResult,
  SpreadsheetBackend,
  SpreadsheetSheetMetadata,
} from '../src/backend'
import {
  activateSheetTabAtom,
  addSheetTabAtom,
  applySheetTabIntent,
  beginSheetTabRenameAtom,
  cancelSheetTabDeleteAtom,
  commitSheetTabRenameAtom,
  confirmSheetTabDeleteAtom,
  createBeginSheetTabReorderIntent,
  createBeginSheetTabRenameIntent,
  createCommitSheetTabRenameIntent,
  createCommitSheetTabReorderIntent,
  createOpenSheetTabContextMenuIntent,
  createUpdateSheetTabReorderIntent,
  createUpdateSheetTabRenameIntent,
  dispatchSheetTabIntentAtom,
  disposeSheetTabsAtom,
  getAdjacentSheetId,
  initializeSheetTabsAtom,
  normalizeSheetTabDraftName,
  reorderSheetMetadata,
  requestSheetTabDeleteAtom,
  selectionRegionsAtom,
  selectionSnapshotAtom,
  setSheetTabsSheetsAtom,
  setMultiRegionSelectionAtom,
  sheetTabsAtom,
  sheetTabsSheetsAtom,
  workspaceSessionAtom,
} from '../src'

const SHEETS: SpreadsheetSheetMetadata[] = [
  { id: 'sheet-1', name: 'Sheet1', index: 0 },
  { id: 'sheet-2', name: 'Sheet2', index: 1 },
]

function createBackend(overrides: Partial<SpreadsheetBackend> = {}): SpreadsheetBackend {
  return {
    async readVisibleProjection() {
      throw new Error('not used')
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function sheetList(sheets: SpreadsheetSheetMetadata[], revision = 1): SheetListResult {
  return { sheets, revision }
}

describe('sheet tabs core', () => {
  test('owns unloaded -> loading -> ready lifecycle and backend capabilities', async () => {
    const store = createStore()
    const list = deferred<SheetListResult>()
    const backend = createBackend({
      listSheets: () => list.promise,
      async addSheet(request) {
        return { requestId: request.requestId, sheetId: 'sheet-3' }
      },
    })

    expect(store.getter(sheetTabsAtom).phase).toBe('unloaded')
    const loading = store.setter(initializeSheetTabsAtom, { backend, sheets: SHEETS })
    expect(store.getter(sheetTabsAtom)).toMatchObject({
      phase: 'loading',
      loadRequestId: expect.any(Number),
      capabilities: {
        list: true,
        add: true,
        rename: false,
        delete: false,
        reorder: false,
      },
    })
    expect(store.getter(sheetTabsSheetsAtom)).toEqual(SHEETS)

    list.resolve(sheetList(SHEETS, 4))
    await loading

    expect(store.getter(sheetTabsAtom)).toMatchObject({
      phase: 'ready',
      loadRequestId: null,
      error: null,
    })
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-1')
    expect(store.getter(selectionSnapshotAtom).activeCell).toEqual({
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
    })
  })

  test('tracks context menu, rename, and reorder interaction state after ready', async () => {
    const store = createStore()
    const backend = createBackend({
      async listSheets() {
        return sheetList(SHEETS)
      },
      async renameSheet(request) {
        return { requestId: request.requestId, sheetId: request.sheetId }
      },
      async reorderSheet(request) {
        return { requestId: request.requestId, sheetId: request.sheetId }
      },
    })
    await store.setter(initializeSheetTabsAtom, { backend, sheets: SHEETS })

    store.setter(
      dispatchSheetTabIntentAtom,
      createOpenSheetTabContextMenuIntent({ sheetId: 'sheet-1', x: 12.9, y: 6.1 }),
    )
    store.setter(
      dispatchSheetTabIntentAtom,
      createBeginSheetTabRenameIntent({ sheetId: 'sheet-1', draftName: '  Sales  ' })!,
    )
    store.setter(
      dispatchSheetTabIntentAtom,
      createUpdateSheetTabRenameIntent('sheet-1', '  Q1 Sales  ')!,
    )
    store.setter(
      dispatchSheetTabIntentAtom,
      createCommitSheetTabRenameIntent({ sheetId: 'sheet-1', name: ' Q1 Sales ' })!,
    )
    store.setter(
      dispatchSheetTabIntentAtom,
      createBeginSheetTabReorderIntent({ sheetId: 'sheet-1' }),
    )
    store.setter(
      dispatchSheetTabIntentAtom,
      createUpdateSheetTabReorderIntent({
        sheetId: 'sheet-1',
        beforeSheetId: 'sheet-2',
        targetIndex: 1,
      }),
    )
    store.setter(
      dispatchSheetTabIntentAtom,
      createCommitSheetTabReorderIntent({
        sheetId: 'sheet-1',
        beforeSheetId: 'sheet-2',
        targetIndex: 1,
      }),
    )

    expect(store.getter(sheetTabsAtom)).toMatchObject({
      phase: 'ready',
      contextMenu: null,
      rename: null,
      reorder: null,
      lastIntent: {
        type: 'sheet-tab.reorder.commit',
        sheetId: 'sheet-1',
        beforeSheetId: 'sheet-2',
      },
    })
  })

  test('keeps one add pending, blocks duplicate dispatch, then commits acknowledged projection', async () => {
    const store = createStore()
    const add = deferred<SheetMutationResult>()
    let addCalls = 0
    const backend = createBackend({
      async listSheets() {
        return sheetList(SHEETS)
      },
      addSheet(request) {
        addCalls += 1
        return add.promise.then((result) => ({ ...result, requestId: request.requestId }))
      },
    })
    await store.setter(initializeSheetTabsAtom, { backend, sheets: SHEETS })

    const first = store.setter(addSheetTabAtom)
    const second = store.setter(addSheetTabAtom)
    expect(addCalls).toBe(1)
    expect(store.getter(sheetTabsAtom).mutation).toMatchObject({
      kind: 'add',
      phase: 'pending',
    })
    expect(store.getter(sheetTabsSheetsAtom)).toEqual(SHEETS)

    const nextSheets = [...SHEETS, { id: 'sheet-3', name: 'Sheet3', index: 2 }]
    add.resolve({
      sheetId: 'sheet-3',
      activeSheetId: 'sheet-3',
      sheets: nextSheets,
      revision: 2,
    })
    await Promise.all([first, second])

    expect(store.getter(sheetTabsSheetsAtom)).toEqual(nextSheets)
    expect(store.getter(sheetTabsAtom)).toMatchObject({
      mutation: null,
      lastMutation: { kind: 'add', outcome: 'acknowledged' },
      error: null,
    })
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-3')
    expect(store.getter(selectionSnapshotAtom).activeCell).toEqual({
      sheetId: 'sheet-3',
      row: 0,
      col: 0,
    })
  })

  test('keeps a late add ACK from splitting workspace and selection', async () => {
    const store = createStore()
    const add = deferred<SheetMutationResult>()
    const backend = createBackend({
      async listSheets() {
        return sheetList(SHEETS)
      },
      addSheet(request) {
        return add.promise.then((result) => ({ ...result, requestId: request.requestId }))
      },
    })
    await store.setter(initializeSheetTabsAtom, { backend, sheets: SHEETS })
    store.setter(setMultiRegionSelectionAtom, {
      regions: [
        {
          kind: 'range',
          sheetId: 'sheet-1',
          anchor: { row: 1, col: 1 },
          focus: { row: 3, col: 4 },
        },
        {
          kind: 'cell',
          sheetId: 'sheet-1',
          anchor: { row: 8, col: 8 },
          focus: { row: 8, col: 8 },
        },
      ],
      primaryIndex: 0,
    })

    const adding = store.setter(addSheetTabAtom)
    expect(store.setter(activateSheetTabAtom, { sheetId: 'sheet-2' })).toBe(true)
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')
    expect(store.getter(selectionSnapshotAtom).selection).toEqual({
      kind: 'cell',
      sheetId: 'sheet-2',
      anchor: { row: 3, col: 4 },
      focus: { row: 3, col: 4 },
    })
    expect(store.getter(selectionRegionsAtom)).toHaveLength(1)

    const nextSheets = [...SHEETS, { id: 'sheet-3', name: 'Sheet3', index: 2 }]
    add.resolve({
      sheetId: 'sheet-3',
      activeSheetId: 'sheet-3',
      sheets: nextSheets,
    })
    await adding

    expect(store.getter(sheetTabsSheetsAtom)).toEqual(nextSheets)
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')
    expect(store.getter(selectionSnapshotAtom).activeCell).toEqual({
      sheetId: 'sheet-2',
      row: 3,
      col: 4,
    })
    expect(store.setter(activateSheetTabAtom, { sheetId: 'missing' })).toBe(false)
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')
  })

  test('does not let an add ACK reclaim activation after an A-to-B-to-A switch', async () => {
    const store = createStore()
    const add = deferred<SheetMutationResult>()
    const backend = createBackend({
      async listSheets() {
        return sheetList(SHEETS)
      },
      addSheet(request) {
        return add.promise.then((result) => ({ ...result, requestId: request.requestId }))
      },
    })
    await store.setter(initializeSheetTabsAtom, { backend, sheets: SHEETS })

    const adding = store.setter(addSheetTabAtom)
    expect(store.setter(activateSheetTabAtom, { sheetId: 'sheet-2' })).toBe(true)
    expect(store.setter(activateSheetTabAtom, { sheetId: 'sheet-1' })).toBe(true)

    const nextSheets = [...SHEETS, { id: 'sheet-3', name: 'Sheet3', index: 2 }]
    add.resolve({
      sheetId: 'sheet-3',
      activeSheetId: 'sheet-3',
      sheets: nextSheets,
    })
    await adding

    expect(store.getter(sheetTabsSheetsAtom)).toEqual(nextSheets)
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-1')
    expect(store.getter(selectionSnapshotAtom).activeCell).toEqual({
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
    })
  })

  test('leaves the coherent active sheet and selection unchanged when add fails', async () => {
    const store = createStore()
    const add = deferred<SheetMutationResult>()
    const backend = createBackend({
      async listSheets() {
        return sheetList(SHEETS)
      },
      addSheet: () => add.promise,
    })
    await store.setter(initializeSheetTabsAtom, { backend, sheets: SHEETS })
    store.setter(activateSheetTabAtom, { sheetId: 'sheet-2' })
    const before = store.getter(selectionSnapshotAtom)

    const adding = store.setter(addSheetTabAtom)
    add.reject(new Error('add failed'))
    await adding

    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-2')
    expect(store.getter(selectionSnapshotAtom)).toEqual(before)
    expect(store.getter(sheetTabsAtom)).toMatchObject({
      mutation: null,
      lastMutation: { kind: 'add', outcome: 'rejected' },
      error: 'add failed',
    })
  })

  test('acknowledged mutation refreshes the authoritative list before ready', async () => {
    const store = createStore()
    const refresh = deferred<SheetListResult>()
    let listCalls = 0
    const renamed = [{ id: 'sheet-1', name: 'Sales', index: 0 }, SHEETS[1]]
    const backend = createBackend({
      listSheets() {
        listCalls += 1
        return listCalls === 1 ? Promise.resolve(sheetList(SHEETS)) : refresh.promise
      },
      async renameSheet(request) {
        return { requestId: request.requestId, sheetId: request.sheetId, revision: 2 }
      },
    })
    await store.setter(initializeSheetTabsAtom, { backend, sheets: SHEETS })
    store.setter(beginSheetTabRenameAtom, { sheetId: 'sheet-1', draftName: 'Sales' })

    const committing = store.setter(commitSheetTabRenameAtom, { sheetId: 'sheet-1' })
    await Promise.resolve()
    expect(store.getter(sheetTabsAtom).mutation).toMatchObject({
      kind: 'rename',
      phase: 'refreshing',
    })
    expect(store.getter(sheetTabsSheetsAtom)[0]?.name).toBe('Sheet1')

    refresh.resolve(sheetList(renamed, 2))
    await committing
    expect(store.getter(sheetTabsSheetsAtom)[0]?.name).toBe('Sales')
    expect(store.getter(sheetTabsAtom).rename).toBeNull()
  })

  test('rejection and mismatched responses retain drafts and never fake list changes', async () => {
    const rejectedStore = createStore()
    const rejectedBackend = createBackend({
      async listSheets() {
        return sheetList(SHEETS)
      },
      async renameSheet() {
        throw new Error('duplicate sheet name')
      },
    })
    await rejectedStore.setter(initializeSheetTabsAtom, {
      backend: rejectedBackend,
      sheets: SHEETS,
    })
    rejectedStore.setter(beginSheetTabRenameAtom, {
      sheetId: 'sheet-1',
      draftName: 'Sheet2',
    })
    await rejectedStore.setter(commitSheetTabRenameAtom, { sheetId: 'sheet-1' })

    expect(rejectedStore.getter(sheetTabsSheetsAtom)).toEqual(SHEETS)
    expect(rejectedStore.getter(sheetTabsAtom)).toMatchObject({
      rename: { sheetId: 'sheet-1', draftName: 'Sheet2' },
      mutation: null,
      lastMutation: { outcome: 'rejected' },
      error: 'duplicate sheet name',
    })

    const mismatchedStore = createStore()
    const mismatchedBackend = createBackend({
      async listSheets() {
        return sheetList(SHEETS)
      },
      async renameSheet(request) {
        return {
          requestId: (request.requestId ?? 0) + 1,
          sheetId: request.sheetId,
          sheets: [{ ...SHEETS[0], name: request.name }, SHEETS[1]],
        }
      },
    })
    await mismatchedStore.setter(initializeSheetTabsAtom, {
      backend: mismatchedBackend,
      sheets: SHEETS,
    })
    mismatchedStore.setter(beginSheetTabRenameAtom, {
      sheetId: 'sheet-1',
      draftName: 'Sales',
    })
    await mismatchedStore.setter(commitSheetTabRenameAtom, { sheetId: 'sheet-1' })

    expect(mismatchedStore.getter(sheetTabsSheetsAtom)).toEqual(SHEETS)
    expect(mismatchedStore.getter(sheetTabsAtom)).toMatchObject({
      rename: { draftName: 'Sales' },
      lastMutation: { outcome: 'protocol-error' },
    })
  })

  test('delete confirmation is Core state and only commits after explicit confirmation', async () => {
    const store = createStore()
    let deleteCalls = 0
    const backend = createBackend({
      async listSheets() {
        return sheetList(SHEETS)
      },
      async deleteSheet(request) {
        deleteCalls += 1
        return {
          requestId: request.requestId,
          sheetId: request.sheetId,
          activeSheetId: 'sheet-1',
          sheets: [SHEETS[0]],
        }
      },
    })
    await store.setter(initializeSheetTabsAtom, { backend, sheets: SHEETS })
    expect(store.setter(activateSheetTabAtom, { sheetId: 'sheet-2' })).toBe(true)

    expect(store.setter(requestSheetTabDeleteAtom, { sheetId: 'sheet-2' })).toBe(true)
    expect(store.getter(sheetTabsAtom).deleteConfirmation).toEqual({
      sheetId: 'sheet-2',
      sheetName: 'Sheet2',
    })
    expect(deleteCalls).toBe(0)
    store.setter(cancelSheetTabDeleteAtom)
    expect(store.getter(sheetTabsAtom).deleteConfirmation).toBeNull()

    store.setter(requestSheetTabDeleteAtom, { sheetId: 'sheet-2' })
    await store.setter(confirmSheetTabDeleteAtom)
    expect(deleteCalls).toBe(1)
    expect(store.getter(sheetTabsSheetsAtom)).toEqual([SHEETS[0]])
    expect(store.getter(sheetTabsAtom).deleteConfirmation).toBeNull()
    expect(store.getter(workspaceSessionAtom).activeSheetId).toBe('sheet-1')
    expect(store.getter(selectionSnapshotAtom).activeCell).toEqual({
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
    })
  })

  test('new session replaces seed and ignores the old workbook list arriving late', async () => {
    const store = createStore()
    const oldList = deferred<SheetListResult>()
    const newList = deferred<SheetListResult>()
    const oldSeed = [{ id: 'old', name: 'Old seed', index: 0 }]
    const newSeed = [{ id: 'new', name: 'New seed', index: 0 }]
    const oldBackend = createBackend({ listSheets: () => oldList.promise })
    const newBackend = createBackend({ listSheets: () => newList.promise })

    const oldLoading = store.setter(initializeSheetTabsAtom, {
      backend: oldBackend,
      sheets: oldSeed,
    })
    const oldSession = store.getter(sheetTabsAtom).sessionId
    const newLoading = store.setter(initializeSheetTabsAtom, {
      backend: newBackend,
      sheets: newSeed,
    })
    const newSession = store.getter(sheetTabsAtom).sessionId

    expect(newSession).toBeGreaterThan(oldSession)
    expect(store.getter(sheetTabsSheetsAtom)).toEqual(newSeed)
    oldList.resolve(sheetList([{ id: 'old-live', name: 'Old live', index: 0 }]))
    await oldLoading
    expect(store.getter(sheetTabsSheetsAtom)).toEqual(newSeed)
    expect(store.getter(sheetTabsAtom).phase).toBe('loading')

    const newLive = [{ id: 'new-live', name: 'New live', index: 0 }]
    newList.resolve(sheetList(newLive))
    await newLoading
    expect(store.getter(sheetTabsSheetsAtom)).toEqual(newLive)
    expect(store.getter(sheetTabsAtom).phase).toBe('ready')
  })

  test('dispose invalidates an old mutation and separate stores stay independent', async () => {
    const firstStore = createStore()
    const secondStore = createStore()
    const rename = deferred<SheetMutationResult>()
    const firstBackend = createBackend({
      async listSheets() {
        return sheetList(SHEETS)
      },
      renameSheet(request) {
        return rename.promise.then((result) => ({ ...result, requestId: request.requestId }))
      },
    })
    const secondSheets = [{ id: 'other', name: 'Other', index: 0 }]
    const secondBackend = createBackend({
      async listSheets() {
        return sheetList(secondSheets)
      },
    })
    await Promise.all([
      firstStore.setter(initializeSheetTabsAtom, { backend: firstBackend, sheets: SHEETS }),
      secondStore.setter(initializeSheetTabsAtom, {
        backend: secondBackend,
        sheets: secondSheets,
      }),
    ])
    firstStore.setter(beginSheetTabRenameAtom, {
      sheetId: 'sheet-1',
      draftName: 'Stale name',
    })
    const committing = firstStore.setter(commitSheetTabRenameAtom, { sheetId: 'sheet-1' })
    firstStore.setter(disposeSheetTabsAtom)
    rename.resolve({
      sheetId: 'sheet-1',
      sheets: [{ ...SHEETS[0], name: 'Stale name' }, SHEETS[1]],
    })
    await committing

    expect(firstStore.getter(sheetTabsAtom).phase).toBe('unloaded')
    expect(firstStore.getter(sheetTabsSheetsAtom)).toEqual(SHEETS)
    expect(secondStore.getter(sheetTabsSheetsAtom)).toEqual(secondSheets)
    expect(secondStore.getter(sheetTabsAtom).phase).toBe('ready')
  })

  test('rejects empty rename drafts and preserves pure helper contracts', () => {
    const store = createStore()
    const initialState = store.getter(sheetTabsAtom)
    expect(normalizeSheetTabDraftName('   ')).toBeNull()
    expect(createBeginSheetTabRenameIntent({ sheetId: 'sheet-1', draftName: '   ' })).toBeNull()
    expect(createCommitSheetTabRenameIntent({ sheetId: 'sheet-1', name: '   ' })).toBeNull()
    expect(
      applySheetTabIntent(initialState, {
        type: 'sheet-tab.rename.cancel',
        sheetId: 'x',
        reason: 'escape',
      }),
    ).toBe(initialState)
  })

  test('normalizes metadata and resolves/reorders displayed sheet ids', () => {
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

    const sheets = [...SHEETS, { id: 'sheet-3', name: 'Sheet3', index: 2 }]
    expect(getAdjacentSheetId(sheets, 'sheet-1', 'previous')).toBe('sheet-3')
    expect(getAdjacentSheetId(sheets, 'sheet-3', 'next')).toBe('sheet-1')
    expect(getAdjacentSheetId(sheets, 'missing', 'next')).toBe('sheet-1')
    expect(getAdjacentSheetId([], 'sheet-1', 'next')).toBeNull()
    expect(
      reorderSheetMetadata(sheets, {
        sheetId: 'sheet-3',
        beforeSheetId: 'sheet-1',
      }).map((sheet) => sheet.id),
    ).toEqual(['sheet-3', 'sheet-1', 'sheet-2'])
  })
})
