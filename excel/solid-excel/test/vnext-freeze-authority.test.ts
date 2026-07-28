import { createStore } from '@einfach/core'
import { describe, expect, it } from '@jest/globals'
import {
  createInsertRowsOperation,
  historyStackAtom,
  hydrateViewportFreezeAtom,
  runStructureOperationAtom,
  runRedoHistoryAtom,
  runUndoHistoryAtom,
  setFreezeConfigAtom,
  viewportFreezeAtom,
  viewportFreezeDiagnosticAtom,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter/static-backend'

// Freeze is UI-core canonical (CANONICAL_OWNERSHIP flip step 1). The
// static backend's freeze storage remains as the reference persistence
// hook: a one-shot hydration seed on first sheet load and a
// fire-and-forget mirror for local commits. These tests pin the flipped
// contract — local commit without ports, one-shot seeding, local-replay
// undo/redo, and structural-shift remap of the local canonical band.

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('vNext freeze — local canonical with static persistence hook', () => {
  it('static persistence hook keeps independent per-sheet freeze storage', async () => {
    const backend = createStaticSpreadsheetBackend({ sheets: ['First', 'Second'] })

    await backend.setFreezeConfig!({
      kind: 'set-freeze-config',
      sheetId: 'sheet-1',
      freeze: { rows: 3, cols: 1 },
    })
    await backend.setFreezeConfig!({
      kind: 'set-freeze-config',
      sheetId: 'sheet-2',
      freeze: { rows: 1, cols: 4 },
    })

    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-1' }),
    ).resolves.toMatchObject({ freeze: { rows: 3, cols: 1 } })
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-2' }),
    ).resolves.toMatchObject({ freeze: { rows: 1, cols: 4 } })
  })

  it('commits locally and mirrors into the static backend fire-and-forget', async () => {
    const backend = createStaticSpreadsheetBackend()
    const store = createStore()

    expect(
      store.setter(setFreezeConfigAtom, { source: backend, sheetId: 'sheet-1', rows: 2, cols: 3 }),
    ).toBe('committed')
    // Local commit is synchronous.
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 2 },
      colsBySheet: { 'sheet-1': 3 },
    })
    await flush()
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-1' }),
    ).resolves.toMatchObject({ freeze: { rows: 2, cols: 3 } })
  })

  it('hydrates a fresh store once per sheet from the persistence hook', async () => {
    const backend = createStaticSpreadsheetBackend({ sheets: ['First', 'Second'] })
    const firstMount = createStore()
    firstMount.setter(setFreezeConfigAtom, {
      source: backend,
      sheetId: 'sheet-1',
      rows: 2,
      cols: 3,
    })
    await flush()

    const remounted = createStore()
    await expect(
      remounted.setter(hydrateViewportFreezeAtom, { source: backend, sheetId: 'sheet-1' }),
    ).resolves.toBe('hydrated')
    await expect(
      remounted.setter(hydrateViewportFreezeAtom, { source: backend, sheetId: 'sheet-2' }),
    ).resolves.toBe('hydrated')
    expect(remounted.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 2, 'sheet-2': 0 },
      colsBySheet: { 'sheet-1': 3, 'sheet-2': 0 },
    })

    // One-shot: a second hydration never re-reads or clobbers.
    await expect(
      remounted.setter(hydrateViewportFreezeAtom, { source: backend, sheetId: 'sheet-1' }),
    ).resolves.toBe('skipped')
  })

  it('freeze is fully available on a backend without any freeze ports', async () => {
    const backend = createStaticSpreadsheetBackend()
    const portless: SpreadsheetBackend = {
      ...backend,
      readFreezeConfig: undefined,
      setFreezeConfig: undefined,
    }
    const store = createStore()

    await expect(
      store.setter(hydrateViewportFreezeAtom, { source: portless, sheetId: 'sheet-1' }),
    ).resolves.toBe('unsupported')
    expect(
      store.setter(setFreezeConfigAtom, { source: portless, sheetId: 'sheet-1', rows: 4, cols: 1 }),
    ).toBe('committed')
    await flush()
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 4 },
      colsBySheet: { 'sheet-1': 1 },
    })
    expect(store.getter(viewportFreezeDiagnosticAtom)).toBeNull()
  })

  it('preserves the sibling axis during a partial local mutation and in the mirror', async () => {
    const backend = createStaticSpreadsheetBackend()
    const store = createStore()
    store.setter(setFreezeConfigAtom, { source: backend, sheetId: 'sheet-1', rows: 1, cols: 4 })
    store.setter(setFreezeConfigAtom, { source: backend, sheetId: 'sheet-1', rows: 3 })
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 3 },
      colsBySheet: { 'sheet-1': 4 },
    })
    await flush()
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-1' }),
    ).resolves.toMatchObject({ freeze: { rows: 3, cols: 4 } })
  })

  it('a failing persistence hook records a diagnostic and never rolls back', async () => {
    const backend = createStaticSpreadsheetBackend()
    const store = createStore()
    // Unknown sheet: the static hook rejects, local canonical still commits.
    expect(
      store.setter(setFreezeConfigAtom, { source: backend, sheetId: 'missing', rows: 1, cols: 1 }),
    ).toBe('committed')
    await flush()
    expect(store.getter(viewportFreezeAtom).rowsBySheet['missing']).toBe(1)
    expect(store.getter(viewportFreezeDiagnosticAtom)).toMatchObject({
      kind: 'persist-failed',
      sheetId: 'missing',
    })
  })

  it('replays Freeze A → B → undo B → undo A → redo A → redo B through local history', async () => {
    const backend = createStaticSpreadsheetBackend()
    const store = createStore()
    const historyInput = () => ({
      source: backend,
      refreshProjection: async () => undefined,
    })

    store.setter(setFreezeConfigAtom, { source: backend, sheetId: 'sheet-1', rows: 1, cols: 2 })
    store.setter(setFreezeConfigAtom, { source: backend, sheetId: 'sheet-1', rows: 3, cols: 4 })

    await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 1 },
      colsBySheet: { 'sheet-1': 2 },
    })

    await expect(store.setter(runUndoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(store.getter(viewportFreezeAtom)).toEqual({ rowsBySheet: {}, colsBySheet: {} })

    await expect(store.setter(runRedoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 1 },
      colsBySheet: { 'sheet-1': 2 },
    })

    await expect(store.setter(runRedoHistoryAtom, historyInput())).resolves.toBe('completed')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 3 },
      colsBySheet: { 'sheet-1': 4 },
    })

    // Undo/redo mirrored the replayed configs into the persistence hook.
    await flush()
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-1' }),
    ).resolves.toMatchObject({ freeze: { rows: 3, cols: 4 } })
  })

  it('invalid inputs never create history entries', () => {
    const store = createStore()
    expect(store.setter(setFreezeConfigAtom, { sheetId: 'sheet-1', rows: -1, cols: 0 })).toBe(
      'invalid',
    )
    expect(store.setter(setFreezeConfigAtom, { sheetId: '', rows: 1, cols: 1 })).toBe('invalid')
    expect(store.setter(setFreezeConfigAtom, { sheetId: 'sheet-1', rows: 0, cols: 0 })).toBe(
      'unchanged',
    )
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
  })

  it('remaps the local freeze band from a structural-shift mutation result', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [
        ['A1', 'B1'],
        ['A2', 'B2'],
        ['A3', 'B3'],
        ['A4', 'B4'],
      ],
    })
    const store = createStore()
    store.setter(setFreezeConfigAtom, { source: backend, sheetId: 'sheet-1', rows: 3, cols: 1 })
    await flush()

    await expect(
      store.setter(runStructureOperationAtom, {
        source: backend,
        intent: createInsertRowsOperation({
          sheetId: 'sheet-1',
          rowIndex: 1,
          count: 2,
          source: 'test',
        }),
        refreshProjection: async () => undefined,
      }),
    ).resolves.toBe('completed')

    // Insert above the freeze line grows the local band; cols untouched.
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 5 },
      colsBySheet: { 'sheet-1': 1 },
    })
    // The static persistence hook remapped its own persisted copy the
    // same way, so hydration on a later mount stays consistent.
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-1' }),
    ).resolves.toMatchObject({ freeze: { rows: 5, cols: 1 } })
  })
})
