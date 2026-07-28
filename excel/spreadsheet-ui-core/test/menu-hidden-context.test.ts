import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  clearMenuIntentAtom,
  dispatchMenuCommandAtom,
  hideRowsAtom,
  openMenuAtom,
  runViewportHiddenContextMenuCommandAtom,
  selectColumnsAtom,
  selectRowsAtom,
  viewportHiddenAtom,
  viewportHiddenContextMenuCommandAvailabilityAtom,
  type HideColumnsRequest,
  type HideRowsRequest,
  type UnhideColumnsRequest,
  type UnhideRowsRequest,
  type ViewportHiddenPersistencePort,
} from '../src'

function flushMicrotasks(times = 3): Promise<void> {
  let chain = Promise.resolve()
  for (let index = 0; index < times; index += 1) chain = chain.then(() => undefined)
  return chain
}

function createHiddenMirror() {
  const hideRows: HideRowsRequest[] = []
  const unhideRows: UnhideRowsRequest[] = []
  const hideColumns: HideColumnsRequest[] = []
  const unhideColumns: UnhideColumnsRequest[] = []
  const source: ViewportHiddenPersistencePort = {
    async hideRows(request) {
      hideRows.push(request)
      return { sheetId: request.sheetId }
    },
    async unhideRows(request) {
      unhideRows.push(request)
      return { sheetId: request.sheetId }
    },
    async hideColumns(request) {
      hideColumns.push(request)
      return { sheetId: request.sheetId }
    },
    async unhideColumns(request) {
      unhideColumns.push(request)
      return { sheetId: request.sheetId }
    },
  }
  return { source, hideRows, unhideRows, hideColumns, unhideColumns }
}

function openRowMenu(store: ReturnType<typeof createStore>, rowIndex: number) {
  store.setter(openMenuAtom, {
    surface: 'header',
    target: { kind: 'row', sheetId: 'sheet-1', rowIndex },
    position: { x: 10, y: 20 },
  })
}

function openColumnMenu(store: ReturnType<typeof createStore>, colIndex: number) {
  store.setter(openMenuAtom, {
    surface: 'header',
    target: { kind: 'column', sheetId: 'sheet-1', colIndex },
    position: { x: 10, y: 20 },
  })
}

describe('hidden rows and columns context-menu routing (UI-core canonical)', () => {
  test('hides the complete same-axis row selection locally and mirrors the delta', async () => {
    const store = createStore()
    const mirror = createHiddenMirror()
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 })
    openRowMenu(store, 3)

    expect(store.getter(viewportHiddenContextMenuCommandAvailabilityAtom)('row.hide')).toBe(true)
    expect(store.setter(dispatchMenuCommandAtom, 'row.hide')).not.toBeNull()

    expect(
      store.setter(runViewportHiddenContextMenuCommandAtom, {
        source: mirror.source,
        command: 'row.hide',
      }),
    ).toBe('committed')

    // Local state commits synchronously — no readback, no authority gate.
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([2, 3, 4])
    await flushMicrotasks()
    expect(mirror.hideRows).toHaveLength(1)
    expect(mirror.hideRows[0]).toMatchObject({
      kind: 'hide-rows',
      sheetId: 'sheet-1',
      rowIndices: [2, 3, 4],
    })
  })

  test('unhide uses the full local truth — including indices no window ever reported', async () => {
    const store = createStore()
    const mirror = createHiddenMirror()
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [3, 800] })
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 })
    openRowMenu(store, 2)

    expect(store.getter(viewportHiddenContextMenuCommandAvailabilityAtom)('row.unhide')).toBe(true)
    expect(store.setter(dispatchMenuCommandAtom, 'row.unhide')).not.toBeNull()
    expect(
      store.setter(runViewportHiddenContextMenuCommandAtom, {
        source: mirror.source,
        command: 'row.unhide',
      }),
    ).toBe('committed')

    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([800])
    await flushMicrotasks()
    expect(mirror.unhideRows).toHaveLength(1)
    expect(mirror.unhideRows[0]?.rowIndices).toEqual([3])
  })

  test('column commands are symmetric and work without any backend source', () => {
    const store = createStore()
    store.setter(selectColumnsAtom, { sheetId: 'sheet-1', colAnchor: 1, colFocus: 2 })
    openColumnMenu(store, 1)

    expect(store.getter(viewportHiddenContextMenuCommandAvailabilityAtom)('column.hide')).toBe(true)
    expect(store.setter(dispatchMenuCommandAtom, 'column.hide')).not.toBeNull()
    expect(
      store.setter(runViewportHiddenContextMenuCommandAtom, { command: 'column.hide' }),
    ).toBe('committed')
    expect(store.getter(viewportHiddenAtom).colsBySheet['sheet-1']).toEqual([1, 2])

    openColumnMenu(store, 1)
    store.setter(selectColumnsAtom, { sheetId: 'sheet-1', colAnchor: 1, colFocus: 2 })
    openColumnMenu(store, 1)
    expect(store.getter(viewportHiddenContextMenuCommandAvailabilityAtom)('column.unhide')).toBe(
      true,
    )
    expect(store.setter(dispatchMenuCommandAtom, 'column.unhide')).not.toBeNull()
    expect(
      store.setter(runViewportHiddenContextMenuCommandAtom, { command: 'column.unhide' }),
    ).toBe('committed')
    expect(store.getter(viewportHiddenAtom).colsBySheet['sheet-1']).toEqual([])
  })

  test('availability never depends on backend hidden ports', () => {
    const store = createStore()
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 })
    openRowMenu(store, 3)
    // hide: always available for a matching selection — even with no ports anywhere.
    expect(store.getter(viewportHiddenContextMenuCommandAvailabilityAtom)('row.hide')).toBe(true)
    // unhide: gated only by the local selection∩hidden intersection.
    expect(store.getter(viewportHiddenContextMenuCommandAvailabilityAtom)('row.unhide')).toBe(false)
    store.setter(hideRowsAtom, { sheetId: 'sheet-1', indices: [3] })
    openRowMenu(store, 2)
    expect(store.getter(viewportHiddenContextMenuCommandAvailabilityAtom)('row.unhide')).toBe(true)
  })

  test('rejects mismatched selection targets with zero state change', () => {
    const store = createStore()
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 })
    // Target outside the selected rows: grid resets selection on real
    // right-clicks, but Core still fails closed on a stale intent.
    openRowMenu(store, 9)
    expect(store.getter(viewportHiddenContextMenuCommandAvailabilityAtom)('row.hide')).toBe(false)
    expect(store.setter(dispatchMenuCommandAtom, 'row.hide')).not.toBeNull()
    expect(store.setter(runViewportHiddenContextMenuCommandAtom, { command: 'row.hide' })).toBe(
      'invalid',
    )
    expect(store.getter(viewportHiddenAtom)).toEqual({ rowsBySheet: {}, colsBySheet: {} })
  })

  test('revokes cleared intents with zero state change', () => {
    const store = createStore()
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 })
    openRowMenu(store, 3)
    store.setter(dispatchMenuCommandAtom, 'row.hide')
    store.setter(clearMenuIntentAtom)
    expect(store.setter(runViewportHiddenContextMenuCommandAtom, { command: 'row.hide' })).toBe(
      'invalid',
    )
    expect(store.getter(viewportHiddenAtom)).toEqual({ rowsBySheet: {}, colsBySheet: {} })
  })

  test('an unhide with no hidden intersection reports unchanged', () => {
    const store = createStore()
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 })
    openRowMenu(store, 3)
    store.setter(dispatchMenuCommandAtom, 'row.unhide')
    expect(store.setter(runViewportHiddenContextMenuCommandAtom, { command: 'row.unhide' })).toBe(
      'unchanged',
    )
  })
})
