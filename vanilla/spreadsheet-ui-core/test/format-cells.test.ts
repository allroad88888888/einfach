import { describe, expect, jest, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  closeFormatCellsAtom,
  formatCellsActiveTabAtom,
  formatCellsDraftAtom,
  formatCellsEditorAtom,
  formatCellsSaveBlockedAtom,
  formatCellsSaveLedgerAtom,
  formatCellsSavePayloadAtom,
  openFormatCellsAtom,
  patchFormatCellsDraftAtom,
  runFormatCellsSaveAtom,
  saveFormatCellsAtom,
  setFormatCellsActiveTabAtom,
  type FormatCellsDraft,
  type RunFormatCellsSaveInput,
} from '../src/format-cells'
import type { CellRange } from '../src'

const RANGE = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function successfulPorts(
  overrides: Partial<RunFormatCellsSaveInput> = {},
): RunFormatCellsSaveInput {
  return {
    resolveSourceRanges: (_sheetId, range) => [range],
    setFormatRange: (request) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    }),
    refreshProjection: () => undefined,
    ...overrides,
  }
}

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

  test('saveFormatCellsAtom delegates to the guarded save lifecycle', async () => {
    const store = createStore()
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
    })

    await store.setter(saveFormatCellsAtom, successfulPorts())
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
    expect(setFormatCellsActiveTabAtom.debugLabel).toBe('spreadsheet.formatCells.setActiveTab')
    expect(patchFormatCellsDraftAtom.debugLabel).toBe('spreadsheet.formatCells.patchDraft')
    expect(formatCellsSavePayloadAtom.debugLabel).toBe('spreadsheet.formatCells.savePayload')
  })
})

describe('format-cells Core-owned save lifecycle', () => {
  test('publishes pending before the port, fans out source ranges, refreshes, then records only a local acknowledgement', async () => {
    const store = createStore()
    const sourceRanges: readonly CellRange[] = [
      { rowStart: 8, rowEnd: 8, colStart: 0, colEnd: 0 },
      { rowStart: 3, rowEnd: 3, colStart: 0, colEnd: 0 },
    ]
    const calls: string[] = []
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialFormat: { bold: true },
    })

    const result = await store.setter(
      runFormatCellsSaveAtom,
      successfulPorts({
        resolveSourceRanges: () => sourceRanges,
        setFormatRange: (request) => {
          const state = store.getter(formatCellsEditorAtom)
          expect(state.status).toBe('open')
          if (state.status !== 'open') throw new Error('unreachable')
          expect(state.phase).toBe('pending-published')
          expect(state.pending).toBe(true)
          calls.push(`set:${request.range.rowStart}`)
          return {
            sheetId: request.sheetId,
            requestId: request.requestId,
            affectedRange: request.range,
          }
        },
        refreshProjection: () => calls.push('refresh'),
      }),
    )

    expect(result).toBe('local-acknowledged')
    expect(calls).toEqual(['set:8', 'set:3', 'refresh'])
    expect(store.getter(formatCellsEditorAtom)).toEqual({ status: 'closed' })
    expect(store.getter(formatCellsSaveLedgerAtom)).toMatchObject([
      { status: 'local-acknowledged', sheetId: 'sheet-1', range: RANGE },
    ])
    expect(store.getter(formatCellsSaveLedgerAtom).map((attempt) => attempt.status)).not.toContain(
      'applied',
    )
  })

  test.each([
    [
      'throws',
      () => {
        throw new Error('projection map unavailable')
      },
    ],
    ['returns an empty list', () => []],
    ['returns an invalid range', () => [{ rowStart: -1, rowEnd: 0, colStart: 0, colEnd: 0 }]],
  ])(
    'keeps a retryable ErrorOpen when source-range resolution %s before the write boundary',
    async (_label, resolver) => {
      const store = createStore()
      const setFormatRange = jest.fn()
      store.setter(openFormatCellsAtom, {
        sheetId: 'sheet-1',
        range: RANGE,
        initialFormat: { italic: true },
      })

      await expect(
        store.setter(
          runFormatCellsSaveAtom,
          successfulPorts({ resolveSourceRanges: resolver, setFormatRange }),
        ),
      ).resolves.toBe('error-open')

      const state = store.getter(formatCellsEditorAtom)
      expect(state.status).toBe('open')
      if (state.status !== 'open') throw new Error('unreachable')
      expect(state).toMatchObject({
        phase: 'error-open',
        pending: false,
        requestId: null,
        draft: { italic: true },
      })
      expect(setFormatRange).not.toHaveBeenCalled()
      expect(store.getter(formatCellsSaveLedgerAtom)).toEqual([])
      expect(store.getter(formatCellsSaveBlockedAtom)).toBe(false)

      await expect(store.setter(runFormatCellsSaveAtom, successfulPorts())).resolves.toBe(
        'local-acknowledged',
      )
    },
  )

  test('treats synchronous reentry and timeout before the first write as deterministic ErrorOpen', async () => {
    const store = createStore()
    const never = deferred<readonly CellRange[]>()
    store.setter(openFormatCellsAtom, { sheetId: 'sheet-1', range: RANGE })

    // Self-referential: the port's `resolveSourceRanges` closes over
    // `reentrantPorts` to re-enter the save atom, so the binding must exist
    // (as `let`) before the object that captures it is assigned.
    let reentrantPorts!: RunFormatCellsSaveInput
    // eslint-disable-next-line prefer-const -- assigned exactly once, but must predate its own self-referential initializer
    reentrantPorts = successfulPorts({
      resolveSourceRanges: () => {
        void store.setter(runFormatCellsSaveAtom, reentrantPorts)
        return [RANGE]
      },
    })
    await expect(store.setter(runFormatCellsSaveAtom, reentrantPorts)).resolves.toBe('error-open')
    expect(store.getter(formatCellsSaveLedgerAtom)).toEqual([])
    expect(store.getter(formatCellsSaveBlockedAtom)).toBe(false)

    await expect(
      store.setter(
        runFormatCellsSaveAtom,
        successfulPorts({ resolveSourceRanges: () => never.promise, timeoutMs: 1 }),
      ),
    ).resolves.toBe('error-open')
    expect(store.getter(formatCellsSaveLedgerAtom)).toEqual([])
    expect(store.getter(formatCellsSaveBlockedAtom)).toBe(false)
  })

  test.each([
    [
      'synchronous provider throw',
      successfulPorts({
        setFormatRange: () => {
          throw new Error('provider threw after launch')
        },
      }),
    ],
    [
      'provider rejection',
      successfulPorts({
        setFormatRange: () => Promise.reject(new Error('provider rejected after launch')),
      }),
    ],
    [
      'provider timeout',
      successfulPorts({
        setFormatRange: () => new Promise<never>(() => undefined),
        timeoutMs: 1,
      }),
    ],
    [
      'mismatched acknowledgement',
      successfulPorts({
        setFormatRange: (request) => ({
          sheetId: request.sheetId,
          requestId: (request.requestId ?? 0) + 1,
          affectedRange: request.range,
        }),
      }),
    ],
    [
      'projection refresh failure',
      successfulPorts({ refreshProjection: () => Promise.reject(new Error('refresh failed')) }),
    ],
  ])('blocks with OutcomeUnknown after the write boundary on %s', async (_label, ports) => {
    const store = createStore()
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-1',
      range: RANGE,
      initialFormat: { bold: true },
    })

    await expect(store.setter(runFormatCellsSaveAtom, ports)).resolves.toBe('outcome-unknown')
    const state = store.getter(formatCellsEditorAtom)
    expect(state.status).toBe('open')
    if (state.status !== 'open') throw new Error('unreachable')
    expect(state).toMatchObject({
      phase: 'outcome-unknown-blocked',
      pending: false,
      draft: { bold: true },
    })
    expect(store.getter(formatCellsSaveLedgerAtom)).toMatchObject([{ status: 'outcome-unknown' }])
    expect(store.getter(formatCellsSaveBlockedAtom)).toBe(true)
    await expect(store.setter(runFormatCellsSaveAtom, successfulPorts())).resolves.toBe('blocked')
  })

  test('blocks an ordinary double save without poisoning the first save', async () => {
    const store = createStore()
    const pendingAck = deferred<unknown>()
    let requestSnapshot: { sheetId: string; requestId: number; affectedRange: CellRange } | null =
      null
    store.setter(openFormatCellsAtom, { sheetId: 'sheet-1', range: RANGE })
    const ports = successfulPorts({
      setFormatRange: (request) => {
        requestSnapshot = {
          sheetId: request.sheetId,
          requestId: request.requestId ?? 0,
          affectedRange: request.range,
        }
        return pendingAck.promise
      },
    })

    const first = store.setter(runFormatCellsSaveAtom, ports)
    await Promise.resolve()
    await Promise.resolve()
    expect(requestSnapshot).not.toBeNull()
    await expect(store.setter(runFormatCellsSaveAtom, ports)).resolves.toBe('blocked')
    pendingAck.resolve(requestSnapshot)
    await expect(first).resolves.toBe('local-acknowledged')
    expect(store.getter(formatCellsEditorAtom)).toEqual({ status: 'closed' })
  })

  test('late settlement cannot close or overwrite a reopened session', async () => {
    const store = createStore()
    const pendingAck = deferred<unknown>()
    let acknowledgement: unknown
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-old',
      range: RANGE,
      initialFormat: { bold: true },
    })
    const first = store.setter(
      runFormatCellsSaveAtom,
      successfulPorts({
        setFormatRange: (request) => {
          acknowledgement = {
            sheetId: request.sheetId,
            requestId: request.requestId,
            affectedRange: request.range,
          }
          return pendingAck.promise
        },
      }),
    )
    await Promise.resolve()
    await Promise.resolve()

    store.setter(closeFormatCellsAtom)
    store.setter(openFormatCellsAtom, {
      sheetId: 'sheet-new',
      range: { rowStart: 4, rowEnd: 4, colStart: 1, colEnd: 1 },
      initialFormat: { italic: true },
    })
    pendingAck.resolve(acknowledgement)
    await expect(first).resolves.toBe('outcome-unknown')

    const reopened = store.getter(formatCellsEditorAtom)
    expect(reopened.status).toBe('open')
    if (reopened.status !== 'open') throw new Error('unreachable')
    expect(reopened).toMatchObject({
      sheetId: 'sheet-new',
      phase: 'editing',
      pending: false,
      draft: { italic: true },
    })
  })
})
