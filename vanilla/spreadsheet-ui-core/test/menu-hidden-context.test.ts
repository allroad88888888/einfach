import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  clearMenuIntentAtom,
  dispatchMenuCommandAtom,
  hydrateViewportSizeProjectionAtom,
  openMenuAtom,
  runViewportHiddenContextMenuCommandAtom,
  selectColumnsAtom,
  selectRowsAtom,
  selectionAtom,
  setViewportHiddenAtom,
  viewportHiddenAtom,
  viewportHiddenContextMenuCommandAvailabilityAtom,
  viewportHiddenLifecycleAtom,
  viewportHiddenProjectionAuthorityAtom,
  type HideColumnsRequest,
  type HideRowsRequest,
  type UnhideColumnsRequest,
  type UnhideRowsRequest,
  type ViewportHiddenControllerPort,
  type ViewportSizeProjectionRequest,
} from '../src'

function createHiddenSource(initialRows: readonly number[] = [], initialCols: readonly number[] = []) {
  let rows = [...initialRows]
  let cols = [...initialCols]
  let revision = 1
  const reads: ViewportSizeProjectionRequest[] = []
  const hideRows: HideRowsRequest[] = []
  const unhideRows: UnhideRowsRequest[] = []
  const hideColumns: HideColumnsRequest[] = []
  const unhideColumns: UnhideColumnsRequest[] = []

  const source: ViewportHiddenControllerPort = {
    async readViewportSizeProjection(request) {
      reads.push(request)
      return {
        kind: 'viewport-size',
        sheetId: request.sheetId,
        window: { ...request.window },
        requestId: request.requestId,
        revision: request.revision ?? revision,
        rowHeights: [],
        colWidths: [],
        hiddenRowIndices: rows.filter(
          (index) => index >= request.window.rowStart && index <= request.window.rowEnd,
        ),
        hiddenColIndices: cols.filter(
          (index) => index >= request.window.colStart && index <= request.window.colEnd,
        ),
      }
    },
    async hideRows(request) {
      hideRows.push(request)
      rows = [...new Set([...rows, ...request.rowIndices])].sort((left, right) => left - right)
      revision += 1
      return { sheetId: request.sheetId, requestId: request.requestId, revision }
    },
    async unhideRows(request) {
      unhideRows.push(request)
      rows = rows.filter((index) => !request.rowIndices.includes(index))
      revision += 1
      return { sheetId: request.sheetId, requestId: request.requestId, revision }
    },
    async hideColumns(request) {
      hideColumns.push(request)
      cols = [...new Set([...cols, ...request.colIndices])].sort((left, right) => left - right)
      revision += 1
      return { sheetId: request.sheetId, requestId: request.requestId, revision }
    },
    async unhideColumns(request) {
      unhideColumns.push(request)
      cols = cols.filter((index) => !request.colIndices.includes(index))
      revision += 1
      return { sheetId: request.sheetId, requestId: request.requestId, revision }
    },
  }

  return { source, reads, hideRows, unhideRows, hideColumns, unhideColumns }
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

describe('hidden rows and columns context-menu routing', () => {
  test('hides the complete same-axis row selection and commits canonical projection state', async () => {
    const store = createStore()
    const backend = createHiddenSource()
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 })
    openRowMenu(store, 3)

    expect(
      store.getter(viewportHiddenContextMenuCommandAvailabilityAtom)(backend.source, 'row.hide'),
    ).toBe(true)
    expect(store.setter(dispatchMenuCommandAtom, 'row.hide')).not.toBeNull()

    await expect(
      store.setter(runViewportHiddenContextMenuCommandAtom, {
        source: backend.source,
        command: 'row.hide',
      }),
    ).resolves.toBe('ready')

    expect(backend.hideRows).toHaveLength(1)
    expect(backend.hideRows[0]).toMatchObject({
      kind: 'hide-rows',
      sheetId: 'sheet-1',
      rowIndices: [2, 3, 4],
    })
    expect(backend.reads.at(-1)?.window).toEqual({
      rowStart: 2,
      rowEnd: 4,
      colStart: 0,
      colEnd: 0,
    })
    expect(store.getter(viewportHiddenAtom).rowsBySheet['sheet-1']).toEqual([2, 3, 4])
  })

  test('unhides only the canonically confirmed hidden intersection in a column selection', async () => {
    const store = createStore()
    const backend = createHiddenSource([], [3, 8])
    store.setter(selectColumnsAtom, { sheetId: 'sheet-1', colAnchor: 2, colFocus: 4 })
    await expect(
      store.setter(hydrateViewportSizeProjectionAtom, {
        source: backend.source,
        sheetId: 'sheet-1',
        window: { rowStart: 0, rowEnd: 0, colStart: 2, colEnd: 4 },
      }),
    ).resolves.toBe('ready')
    openColumnMenu(store, 2)

    expect(
      store.getter(viewportHiddenContextMenuCommandAvailabilityAtom)(
        backend.source,
        'column.unhide',
      ),
    ).toBe(true)
    expect(store.setter(dispatchMenuCommandAtom, 'column.unhide')).not.toBeNull()

    await expect(
      store.setter(runViewportHiddenContextMenuCommandAtom, {
        source: backend.source,
        command: 'column.unhide',
      }),
    ).resolves.toBe('ready')

    expect(backend.unhideColumns).toHaveLength(1)
    expect(backend.unhideColumns[0]?.colIndices).toEqual([3])
    expect(store.getter(viewportHiddenAtom).colsBySheet['sheet-1']).toEqual([])
  })

  test('fails closed with zero transport for unsupported or mismatched selection targets', async () => {
    const store = createStore()
    const unsupported: ViewportHiddenControllerPort = {}
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 })
    openRowMenu(store, 3)

    expect(
      store.getter(viewportHiddenContextMenuCommandAvailabilityAtom)(unsupported, 'row.hide'),
    ).toBe(false)
    expect(store.setter(dispatchMenuCommandAtom, 'row.hide')).not.toBeNull()
    await expect(
      store.setter(runViewportHiddenContextMenuCommandAtom, {
        source: unsupported,
        command: 'row.hide',
      }),
    ).resolves.toBe('unsupported')

    const backend = createHiddenSource()
    openRowMenu(store, 9)
    expect(
      store.getter(viewportHiddenContextMenuCommandAvailabilityAtom)(backend.source, 'row.hide'),
    ).toBe(false)
    expect(store.setter(dispatchMenuCommandAtom, 'row.hide')).not.toBeNull()
    await expect(
      store.setter(runViewportHiddenContextMenuCommandAtom, {
        source: backend.source,
        command: 'row.hide',
      }),
    ).resolves.toBe('blocked')
    expect(backend.hideRows).toHaveLength(0)
    expect(backend.reads).toHaveLength(0)
  })

  test('revokes stale intents and preserves an active canonical lifecycle with zero extra transport', async () => {
    const store = createStore()
    let resolveMutation!: (value: { sheetId: string; requestId?: number; revision: number }) => void
    const mutation = new Promise<{ sheetId: string; requestId?: number; revision: number }>(
      (resolve) => {
        resolveMutation = resolve
      },
    )
    let hideCalls = 0
    let readCalls = 0
    let activeRequest: HideRowsRequest | undefined
    const source: ViewportHiddenControllerPort = {
      hideRows(request) {
        hideCalls += 1
        activeRequest = request
        return mutation
      },
      async readViewportSizeProjection(request) {
        readCalls += 1
        return {
          kind: 'viewport-size',
          sheetId: request.sheetId,
          window: { ...request.window },
          requestId: request.requestId,
          revision: request.revision ?? 1,
          rowHeights: [],
          colWidths: [],
          hiddenRowIndices: [2, 3, 4],
          hiddenColIndices: [],
        }
      },
    }
    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 })
    openRowMenu(store, 3)
    store.setter(dispatchMenuCommandAtom, 'row.hide')

    const first = store.setter(runViewportHiddenContextMenuCommandAtom, {
      source,
      command: 'row.hide',
    })
    expect(store.getter(viewportHiddenLifecycleAtom).status).toBe('pending')
    await expect(
      store.setter(runViewportHiddenContextMenuCommandAtom, {
        source,
        command: 'row.hide',
      }),
    ).resolves.toBe('blocked')
    expect(hideCalls).toBe(1)
    expect(readCalls).toBe(0)
    expect(store.getter(viewportHiddenLifecycleAtom).status).toBe('pending')

    resolveMutation({
      sheetId: 'sheet-1',
      requestId: activeRequest?.requestId,
      revision: 2,
    })
    await expect(first).resolves.toBe('ready')

    store.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 5, rowFocus: 5 })
    openRowMenu(store, 5)
    await expect(
      store.setter(runViewportHiddenContextMenuCommandAtom, {
        source,
        command: 'row.hide',
      }),
    ).resolves.toBe('blocked')
    expect(hideCalls).toBe(1)
    expect(readCalls).toBe(1)
    expect(store.getter(selectionAtom)).toMatchObject({ rowAnchor: 5, rowFocus: 5 })
  })

  test('revalidates revoked capability, canonical revision authority, and intent with zero transport', async () => {
    const capabilityStore = createStore()
    const capabilityBackend = createHiddenSource()
    capabilityStore.setter(selectRowsAtom, {
      sheetId: 'sheet-1',
      rowAnchor: 2,
      rowFocus: 4,
    })
    openRowMenu(capabilityStore, 3)
    capabilityStore.setter(dispatchMenuCommandAtom, 'row.hide')
    expect(
      capabilityStore.getter(viewportHiddenContextMenuCommandAvailabilityAtom)(
        capabilityBackend.source,
        'row.hide',
      ),
    ).toBe(true)

    delete capabilityBackend.source.hideRows
    expect(
      capabilityStore.getter(viewportHiddenContextMenuCommandAvailabilityAtom)(
        capabilityBackend.source,
        'row.hide',
      ),
    ).toBe(false)
    await expect(
      capabilityStore.setter(runViewportHiddenContextMenuCommandAtom, {
        source: capabilityBackend.source,
        command: 'row.hide',
      }),
    ).resolves.toBe('unsupported')
    expect(capabilityBackend.hideRows).toHaveLength(0)
    expect(capabilityBackend.reads).toHaveLength(0)

    const revisionStore = createStore()
    const revisionBackend = createHiddenSource([3])
    revisionStore.setter(selectRowsAtom, {
      sheetId: 'sheet-1',
      rowAnchor: 2,
      rowFocus: 4,
    })
    await revisionStore.setter(hydrateViewportSizeProjectionAtom, {
      source: revisionBackend.source,
      sheetId: 'sheet-1',
      window: { rowStart: 2, rowEnd: 4, colStart: 0, colEnd: 0 },
    })
    openRowMenu(revisionStore, 2)
    revisionStore.setter(dispatchMenuCommandAtom, 'row.unhide')
    expect(
      revisionStore.getter(viewportHiddenContextMenuCommandAvailabilityAtom)(
        revisionBackend.source,
        'row.unhide',
      ),
    ).toBe(true)
    revisionBackend.reads.length = 0

    revisionStore.setter(setViewportHiddenAtom, { sheetId: 'sheet-1', rows: [3] })
    expect(revisionStore.getter(viewportHiddenProjectionAuthorityAtom)).toMatchObject({
      ready: false,
      revision: null,
    })
    expect(
      revisionStore.getter(viewportHiddenContextMenuCommandAvailabilityAtom)(
        revisionBackend.source,
        'row.unhide',
      ),
    ).toBe(false)
    await expect(
      revisionStore.setter(runViewportHiddenContextMenuCommandAtom, {
        source: revisionBackend.source,
        command: 'row.unhide',
      }),
    ).resolves.toBe('blocked')
    expect(revisionBackend.unhideRows).toHaveLength(0)
    expect(revisionBackend.reads).toHaveLength(0)

    const intentStore = createStore()
    const intentBackend = createHiddenSource()
    intentStore.setter(selectRowsAtom, { sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 })
    openRowMenu(intentStore, 3)
    intentStore.setter(dispatchMenuCommandAtom, 'row.hide')
    intentStore.setter(clearMenuIntentAtom)
    expect(
      intentStore.getter(viewportHiddenContextMenuCommandAvailabilityAtom)(
        intentBackend.source,
        'row.hide',
      ),
    ).toBe(true)
    await expect(
      intentStore.setter(runViewportHiddenContextMenuCommandAtom, {
        source: intentBackend.source,
        command: 'row.hide',
      }),
    ).resolves.toBe('blocked')
    expect(intentBackend.hideRows).toHaveLength(0)
    expect(intentBackend.reads).toHaveLength(0)
  })
})
