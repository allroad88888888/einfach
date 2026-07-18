import { createStore } from '@einfach/core'
import { describe, expect, it } from '@jest/globals'
import {
  readViewportFreezeCanonicalAtom,
  runViewportFreezeMutationAtom,
  viewportFreezeAtom,
  viewportFreezeLifecycleAtom,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter/static-backend'

describe('vNext static freeze authority', () => {
  it('owns independent canonical freeze config for every sheet', async () => {
    const backend = createStaticSpreadsheetBackend({ sheets: ['First', 'Second'] })

    await expect(
      backend.setFreezeConfig!({
        kind: 'set-freeze-config',
        sheetId: 'sheet-1',
        requestId: 11,
        freeze: { rows: 3, cols: 1 },
      }),
    ).resolves.toEqual({ sheetId: 'sheet-1', requestId: 11, revision: 1 })
    await expect(
      backend.setFreezeConfig!({
        kind: 'set-freeze-config',
        sheetId: 'sheet-2',
        requestId: 12,
        freeze: { rows: 1, cols: 4 },
      }),
    ).resolves.toEqual({ sheetId: 'sheet-2', requestId: 12, revision: 2 })

    await expect(
      backend.readFreezeConfig!({
        kind: 'read-freeze-config',
        sheetId: 'sheet-1',
        requestId: 13,
      }),
    ).resolves.toEqual({
      kind: 'freeze-config',
      sheetId: 'sheet-1',
      requestId: 13,
      revision: 2,
      freeze: { rows: 3, cols: 1 },
    })
    await expect(
      backend.readFreezeConfig!({
        kind: 'read-freeze-config',
        sheetId: 'sheet-2',
        requestId: 14,
      }),
    ).resolves.toEqual({
      kind: 'freeze-config',
      sheetId: 'sheet-2',
      requestId: 14,
      revision: 2,
      freeze: { rows: 1, cols: 4 },
    })
  })

  it('hydrates a fresh Einfach store from Static authority after a remount or sheet switch', async () => {
    const backend = createStaticSpreadsheetBackend({ sheets: ['First', 'Second'] })
    const firstMount = createStore()

    await expect(
      firstMount.setter(runViewportFreezeMutationAtom, {
        source: backend,
        sheetId: 'sheet-1',
        rows: 2,
        cols: 3,
      }),
    ).resolves.toBe('committed')
    expect(firstMount.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 2 },
      colsBySheet: { 'sheet-1': 3 },
    })

    const remounted = createStore()
    await expect(
      remounted.setter(readViewportFreezeCanonicalAtom, {
        source: backend,
        sheetId: 'sheet-1',
      }),
    ).resolves.toBe('committed')
    expect(remounted.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 2 },
      colsBySheet: { 'sheet-1': 3 },
    })

    await expect(
      remounted.setter(readViewportFreezeCanonicalAtom, {
        source: backend,
        sheetId: 'sheet-2',
      }),
    ).resolves.toBe('committed')
    expect(remounted.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 2, 'sheet-2': 0 },
      colsBySheet: { 'sheet-1': 3, 'sheet-2': 0 },
    })
    expect(remounted.getter(viewportFreezeLifecycleAtom)).toMatchObject({
      status: 'committed',
      sheetId: 'sheet-2',
      canonical: { rows: 0, cols: 0 },
    })
  })

  it('rejects invalid or unknown-sheet mutations without creating shadow state', async () => {
    const backend = createStaticSpreadsheetBackend()

    await expect(
      backend.setFreezeConfig!({
        kind: 'set-freeze-config',
        sheetId: 'sheet-1',
        freeze: { rows: -1, cols: 0 },
      }),
    ).rejects.toThrow('non-negative safe integers')
    await expect(
      backend.setFreezeConfig!({
        kind: 'set-freeze-config',
        sheetId: 'missing',
        freeze: { rows: 1, cols: 1 },
      }),
    ).rejects.toThrow('unknown sheet: missing')
    await expect(
      backend.readFreezeConfig!({
        kind: 'read-freeze-config',
        sheetId: 'sheet-1',
      }),
    ).resolves.toMatchObject({ freeze: { rows: 0, cols: 0 } })
  })

  it('returns the actual state revision and rejects stale CAS without writing or bumping', async () => {
    const backend = createStaticSpreadsheetBackend()

    await expect(
      backend.readFreezeConfig!({
        kind: 'read-freeze-config',
        sheetId: 'sheet-1',
        requestId: 20,
        revision: 999,
      }),
    ).resolves.toMatchObject({ requestId: 20, revision: 0, freeze: { rows: 0, cols: 0 } })

    await expect(
      backend.setFreezeConfig!({
        kind: 'set-freeze-config',
        sheetId: 'sheet-1',
        requestId: 21,
        revision: 0,
        freeze: { rows: 1, cols: 2 },
      }),
    ).resolves.toMatchObject({ requestId: 21, revision: 1 })
    await expect(
      backend.setFreezeConfig!({
        kind: 'set-freeze-config',
        sheetId: 'sheet-1',
        requestId: 22,
        revision: 0,
        freeze: { rows: 8, cols: 9 },
      }),
    ).rejects.toThrow('freeze revision conflict')

    await expect(
      backend.readFreezeConfig!({
        kind: 'read-freeze-config',
        sheetId: 'sheet-1',
        requestId: 23,
        revision: 1234,
      }),
    ).resolves.toMatchObject({ requestId: 23, revision: 1, freeze: { rows: 1, cols: 2 } })
  })

  it('preserves the canonical sibling axis during a partial mutation', async () => {
    const backend = createStaticSpreadsheetBackend()
    await backend.setFreezeConfig!({
      kind: 'set-freeze-config',
      sheetId: 'sheet-1',
      freeze: { rows: 1, cols: 4 },
    })
    const store = createStore()

    await expect(
      store.setter(runViewportFreezeMutationAtom, {
        source: backend,
        sheetId: 'sheet-1',
        rows: 3,
      }),
    ).resolves.toBe('committed')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 3 },
      colsBySheet: { 'sheet-1': 4 },
    })
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-1' }),
    ).resolves.toMatchObject({ revision: 2, freeze: { rows: 3, cols: 4 } })
  })

  it('does not clobber a concurrent write between partial preflight and CAS set', async () => {
    const backend = createStaticSpreadsheetBackend()
    await backend.setFreezeConfig!({
      kind: 'set-freeze-config',
      sheetId: 'sheet-1',
      freeze: { rows: 1, cols: 4 },
    })
    let raceArmed = false
    const source: SpreadsheetBackend = {
      ...backend,
      async readFreezeConfig(request) {
        const result = await backend.readFreezeConfig!(request)
        if (raceArmed) {
          raceArmed = false
          await backend.setFreezeConfig!({
            kind: 'set-freeze-config',
            sheetId: request.sheetId,
            requestId: 700,
            freeze: { rows: 8, cols: 9 },
          })
        }
        return result
      },
    }
    const store = createStore()
    await store.setter(readViewportFreezeCanonicalAtom, { source, sheetId: 'sheet-1' })
    raceArmed = true

    await expect(
      store.setter(runViewportFreezeMutationAtom, {
        source,
        sheetId: 'sheet-1',
        rows: 3,
      }),
    ).resolves.toBe('recovery-required')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 1 },
      colsBySheet: { 'sheet-1': 4 },
    })
    expect(store.getter(viewportFreezeLifecycleAtom).status).toBe('recovery-required')
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-1' }),
    ).resolves.toMatchObject({ revision: 2, freeze: { rows: 8, cols: 9 } })
  })

  it('requires recovery when authority advances after ACK but before canonical readback', async () => {
    const backend = createStaticSpreadsheetBackend()
    await backend.setFreezeConfig!({
      kind: 'set-freeze-config',
      sheetId: 'sheet-1',
      freeze: { rows: 1, cols: 2 },
    })
    let raceArmed = false
    const source: SpreadsheetBackend = {
      ...backend,
      async setFreezeConfig(request) {
        const acknowledgement = await backend.setFreezeConfig!(request)
        if (raceArmed) {
          raceArmed = false
          await backend.setFreezeConfig!({
            kind: 'set-freeze-config',
            sheetId: request.sheetId,
            requestId: 800,
            freeze: { rows: 7, cols: 6 },
          })
        }
        return acknowledgement
      },
    }
    const store = createStore()
    await store.setter(readViewportFreezeCanonicalAtom, { source, sheetId: 'sheet-1' })
    raceArmed = true

    await expect(
      store.setter(runViewportFreezeMutationAtom, {
        source,
        sheetId: 'sheet-1',
        rows: 4,
        cols: 5,
      }),
    ).resolves.toBe('recovery-required')
    expect(store.getter(viewportFreezeAtom)).toEqual({
      rowsBySheet: { 'sheet-1': 1 },
      colsBySheet: { 'sheet-1': 2 },
    })
    expect(store.getter(viewportFreezeLifecycleAtom).status).toBe('recovery-required')
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-1' }),
    ).resolves.toMatchObject({ revision: 3, freeze: { rows: 7, cols: 6 } })
  })

  it('replays consecutive canonical freeze mutations through undo and redo in exact order', async () => {
    const backend = createStaticSpreadsheetBackend()
    const first = { rows: 1, cols: 2 }
    const second = { rows: 3, cols: 4 }

    await expect(
      backend.setFreezeConfig!({
        kind: 'set-freeze-config',
        sheetId: 'sheet-1',
        requestId: 30,
        revision: 0,
        freeze: first,
      }),
    ).resolves.toEqual({ sheetId: 'sheet-1', requestId: 30, revision: 1 })
    await expect(
      backend.setFreezeConfig!({
        kind: 'set-freeze-config',
        sheetId: 'sheet-1',
        requestId: 31,
        revision: 1,
        freeze: second,
      }),
    ).resolves.toEqual({ sheetId: 'sheet-1', requestId: 31, revision: 2 })

    const undoSecond = await backend.undoTransaction!({
      kind: 'undo-transaction',
      transactionId: 'freeze-second',
      requestId: 32,
    })
    expect(undoSecond).toMatchObject({ transactionId: 'freeze-second', requestId: 32 })
    await expect(
      backend.readFreezeConfig!({
        kind: 'read-freeze-config',
        sheetId: 'sheet-1',
        requestId: 33,
      }),
    ).resolves.toMatchObject({ requestId: 33, revision: undoSecond.revision, freeze: first })

    const undoFirst = await backend.undoTransaction!({
      kind: 'undo-transaction',
      transactionId: 'freeze-first',
      requestId: 34,
    })
    expect(undoFirst).toMatchObject({ transactionId: 'freeze-first', requestId: 34 })
    await expect(
      backend.readFreezeConfig!({
        kind: 'read-freeze-config',
        sheetId: 'sheet-1',
        requestId: 35,
      }),
    ).resolves.toMatchObject({
      requestId: 35,
      revision: undoFirst.revision,
      freeze: { rows: 0, cols: 0 },
    })

    const redoFirst = await backend.redoTransaction!({
      kind: 'redo-transaction',
      transactionId: 'freeze-first',
      requestId: 36,
    })
    expect(redoFirst).toMatchObject({ transactionId: 'freeze-first', requestId: 36 })
    await expect(
      backend.readFreezeConfig!({
        kind: 'read-freeze-config',
        sheetId: 'sheet-1',
        requestId: 37,
      }),
    ).resolves.toMatchObject({ requestId: 37, revision: redoFirst.revision, freeze: first })

    const redoSecond = await backend.redoTransaction!({
      kind: 'redo-transaction',
      transactionId: 'freeze-second',
      requestId: 38,
    })
    expect(redoSecond).toMatchObject({ transactionId: 'freeze-second', requestId: 38 })
    await expect(
      backend.readFreezeConfig!({
        kind: 'read-freeze-config',
        sheetId: 'sheet-1',
        requestId: 39,
      }),
    ).resolves.toMatchObject({ requestId: 39, revision: redoSecond.revision, freeze: second })
  })

  it('restores and removes a configured sheet freeze across delete undo and redo', async () => {
    const backend = createStaticSpreadsheetBackend({ sheets: ['First', 'Second'] })
    const configured = { rows: 5, cols: 2 }
    await backend.setFreezeConfig!({
      kind: 'set-freeze-config',
      sheetId: 'sheet-2',
      requestId: 40,
      freeze: configured,
    })

    await backend.deleteSheet!({ kind: 'delete-sheet', sheetId: 'sheet-2', requestId: 41 })
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-2', requestId: 42 }),
    ).rejects.toThrow('unknown sheet: sheet-2')

    const restored = await backend.undoTransaction!({
      kind: 'undo-transaction',
      transactionId: 'delete-configured-sheet',
      requestId: 43,
    })
    expect(restored).toMatchObject({ transactionId: 'delete-configured-sheet', requestId: 43 })
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-2', requestId: 44 }),
    ).resolves.toMatchObject({
      requestId: 44,
      revision: restored.revision,
      freeze: configured,
    })

    const removedAgain = await backend.redoTransaction!({
      kind: 'redo-transaction',
      transactionId: 'delete-configured-sheet',
      requestId: 45,
    })
    expect(removedAgain).toMatchObject({
      transactionId: 'delete-configured-sheet',
      requestId: 45,
    })
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-2', requestId: 46 }),
    ).rejects.toThrow('unknown sheet: sheet-2')
  })

  it('does not pollute freeze history when invalid or stale mutations fail validation', async () => {
    const backend = createStaticSpreadsheetBackend()
    const first = { rows: 1, cols: 1 }
    const second = { rows: 2, cols: 3 }
    await backend.setFreezeConfig!({
      kind: 'set-freeze-config',
      sheetId: 'sheet-1',
      revision: 0,
      freeze: first,
    })
    await backend.setFreezeConfig!({
      kind: 'set-freeze-config',
      sheetId: 'sheet-1',
      revision: 1,
      freeze: second,
    })

    await expect(
      backend.setFreezeConfig!({
        kind: 'set-freeze-config',
        sheetId: 'sheet-1',
        freeze: { rows: -1, cols: 0 },
      }),
    ).rejects.toThrow('non-negative safe integers')
    await expect(
      backend.setFreezeConfig!({
        kind: 'set-freeze-config',
        sheetId: 'sheet-1',
        revision: 1,
        freeze: { rows: 8, cols: 9 },
      }),
    ).rejects.toThrow('freeze revision conflict')

    const reverted = await backend.undoTransaction!({
      kind: 'undo-transaction',
      transactionId: 'last-successful-freeze',
      requestId: 47,
    })
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-1', requestId: 48 }),
    ).resolves.toMatchObject({ requestId: 48, revision: reverted.revision, freeze: first })

    const replayed = await backend.redoTransaction!({
      kind: 'redo-transaction',
      transactionId: 'last-successful-freeze',
      requestId: 49,
    })
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: 'sheet-1', requestId: 50 }),
    ).resolves.toMatchObject({ requestId: 50, revision: replayed.revision, freeze: second })
  })
})
