import { describe, expect, test } from '@jest/globals'
import type {
  AutoFillReportWire,
  AutoFillRequestWire,
  CellFormatJSON,
  CellRefWire,
  FormatRangeSnapshot,
  SparseCellWire,
  SparseRangeWire,
  WorkerRuntimeCapabilitiesResponseWire,
  WorkerWorkbookClient,
  WorkbookSheetMeta,
} from '../src-vnext/adapter'
import {
  createWorkerWorkbookSpreadsheetBackend,
  WORKER_UNDO_STACK_CAP,
} from '../src-vnext/adapter'

const SHEET_ID = 'sheet-1'

type ApplyHandler = (
  request: AutoFillRequestWire,
  client: AutoFillFakeClient,
) => Promise<AutoFillReportWire> | AutoFillReportWire

type AutoFillFakeClient = WorkerWorkbookClient & {
  readonly applyCalls: number
  readonly lastApplyRequest: AutoFillRequestWire | null
  putCell(cell: SparseCellWire): void
  putFormat(sheet: number, row: number, col: number, format: CellFormatJSON): void
  readCell(sheet: number, row: number, col: number): SparseCellWire | undefined
  readFormat(sheet: number, row: number, col: number): CellFormatJSON | undefined
  emitDirty(cells: CellRefWire[]): void
  setApplyHandler(handler: ApplyHandler): void
  setSnapshotHook(hook: ((call: number) => void) | null): void
  setRestoreHook(hook: ((call: number) => void) | null): void
  setSparseRestoreHook(hook: ((call: number) => void) | null): void
  failNextValueSnapshot(): void
}

function address(row: number, col: number): string {
  let column = col + 1
  let label = ''
  while (column > 0) {
    const remainder = (column - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    column = Math.floor((column - 1) / 26)
  }
  return `${label}${row + 1}`
}

function key(sheet: number, row: number, col: number): string {
  return `${sheet}:${row}:${col}`
}

function inRange(row: number, col: number, range: SparseRangeWire): boolean {
  return (
    row >= range.startRow &&
    row <= range.endRow &&
    col >= range.startCol &&
    col <= range.endCol
  )
}

function cloneCell(cell: SparseCellWire): SparseCellWire {
  return { ...cell }
}

function cloneFormat(format: CellFormatJSON): CellFormatJSON {
  return {
    ...format,
    ...(format.numberFormat ? { numberFormat: { ...format.numberFormat } } : {}),
    ...(format.borders
      ? {
          borders: Object.fromEntries(
            Object.entries(format.borders).map(([side, spec]) => [
              side,
              spec ? { ...spec } : spec,
            ]),
          ),
        }
      : {}),
  }
}

function createAutoFillFakeClient(options?: {
  capability?: WorkerRuntimeCapabilitiesResponseWire | null
  exposeApply?: boolean
}): AutoFillFakeClient {
  const cells = new Map<string, SparseCellWire>()
  const formats = new Map<string, CellFormatJSON>()
  const dirtyListeners = new Set<(cells: CellRefWire[]) => void>()
  let snapshotCalls = 0
  let snapshotHook: ((call: number) => void) | null = null
  let restoreCalls = 0
  let restoreHook: ((call: number) => void) | null = null
  let sparseRestoreCalls = 0
  let sparseRestoreHook: ((call: number) => void) | null = null
  let rejectNextValueSnapshot = false
  let applyCalls = 0
  let lastApplyRequest: AutoFillRequestWire | null = null
  let applyHandler: ApplyHandler = (request, client) => {
    const writeRow = request.direction === 'down' ? request.sourceRange.endRow + 1 : 0
    client.putCell({
      sheet: request.sheet,
      addr: address(writeRow, request.sourceRange.startCol),
      row: writeRow,
      col: request.sourceRange.startCol,
      kind: 'number',
      value: 7,
    })
    client.emitDirty([
      { sheet: request.sheet, addr: address(writeRow, request.sourceRange.startCol) },
    ])
    return {
      writeRange: {
        startRow: writeRow,
        startCol: request.sourceRange.startCol,
        endRow: request.targetRange.endRow,
        endCol: request.targetRange.endCol,
      },
      written: 1,
    }
  }

  const partial: Partial<WorkerWorkbookClient> = {
    async initWorkbook(sheets = ['Sheet1']): Promise<WorkbookSheetMeta[]> {
      return sheets.map((name, idx) => ({ idx, name }))
    },
    async describeCapabilities() {
      return options && 'capability' in options
        ? options.capability ?? null
        : { scope: 'auto-fill', autoFill: true }
    },
    async snapshotRangeSparse(range) {
      snapshotCalls += 1
      snapshotHook?.(snapshotCalls)
      if (rejectNextValueSnapshot) {
        rejectNextValueSnapshot = false
        throw new Error('value snapshot unavailable')
      }
      return [...cells.values()]
        .filter(
          (cell) =>
            cell.sheet === range.sheet && inRange(cell.row, cell.col, range),
        )
        .map(cloneCell)
    },
    async snapshotFormatRange(range): Promise<FormatRangeSnapshot> {
      return {
        ...range,
        cellFormats: [...formats.entries()]
          .flatMap(([entryKey, format]) => {
            const [sheet, row, col] = entryKey.split(':').map(Number)
            return sheet === range.sheet && inRange(row, col, range)
              ? [{ addr: address(row, col), format: cloneFormat(format) }]
              : []
          }),
        rangeFormats: [],
      }
    },
    async clearRange(range) {
      restoreCalls += 1
      restoreHook?.(restoreCalls)
      let cleared = 0
      for (const [entryKey, cell] of cells) {
        if (cell.sheet === range.sheet && inRange(cell.row, cell.col, range)) {
          cells.delete(entryKey)
          cleared += 1
        }
      }
      return cleared
    },
    async restoreSparse(snapshot) {
      sparseRestoreCalls += 1
      sparseRestoreHook?.(sparseRestoreCalls)
      for (const cell of snapshot) cells.set(key(cell.sheet, cell.row, cell.col), cloneCell(cell))
      return snapshot.length
    },
    async restoreFormatSnapshot(snapshot) {
      const sheet = snapshot.sheet ?? 0
      for (const entryKey of [...formats.keys()]) {
        const [entrySheet, row, col] = entryKey.split(':').map(Number)
        if (
          entrySheet === sheet &&
          row >= snapshot.startRow &&
          row <= snapshot.endRow &&
          col >= snapshot.startCol &&
          col <= snapshot.endCol
        ) {
          formats.delete(entryKey)
        }
      }
      for (const entry of snapshot.cellFormats) {
        const match = /^([A-Z]+)([1-9]\d*)$/.exec(entry.addr)
        if (!match) continue
        let col = 0
        for (const char of match[1]) col = col * 26 + char.charCodeAt(0) - 64
        formats.set(
          key(sheet, Number(match[2]) - 1, col - 1),
          cloneFormat(entry.format),
        )
      }
      return snapshot.cellFormats.length
    },
    onCellsDirty(callback) {
      dirtyListeners.add(callback)
      return () => dirtyListeners.delete(callback)
    },
    onCellsHydrated() {
      return () => {}
    },
    dispose() {},
  }

  const controls = {
    putCell(cell: SparseCellWire) {
      cells.set(key(cell.sheet, cell.row, cell.col), cloneCell(cell))
    },
    putFormat(sheet: number, row: number, col: number, format: CellFormatJSON) {
      formats.set(key(sheet, row, col), cloneFormat(format))
    },
    readCell(sheet: number, row: number, col: number) {
      const cell = cells.get(key(sheet, row, col))
      return cell ? cloneCell(cell) : undefined
    },
    readFormat(sheet: number, row: number, col: number) {
      const format = formats.get(key(sheet, row, col))
      return format ? cloneFormat(format) : undefined
    },
    emitDirty(refs: CellRefWire[]) {
      for (const listener of dirtyListeners) listener(refs)
    },
    setApplyHandler(handler: ApplyHandler) {
      applyHandler = handler
    },
    setSnapshotHook(hook: ((call: number) => void) | null) {
      snapshotHook = hook
    },
    setRestoreHook(hook: ((call: number) => void) | null) {
      restoreHook = hook
    },
    setSparseRestoreHook(hook: ((call: number) => void) | null) {
      sparseRestoreHook = hook
    },
    failNextValueSnapshot() {
      rejectNextValueSnapshot = true
    },
  }
  const client = Object.assign(partial, controls) as AutoFillFakeClient
  Object.defineProperties(client, {
    applyCalls: { get: () => applyCalls },
    lastApplyRequest: { get: () => lastApplyRequest },
  })
  if (options?.exposeApply !== false) {
    client.applyAutoFill = async (request) => {
      applyCalls += 1
      lastApplyRequest = request
      return applyHandler(request, client)
    }
  }
  return client
}

async function createBackend(
  options?: Parameters<typeof createAutoFillFakeClient>[0] & {
    revision?: number | string
  },
) {
  const client = createAutoFillFakeClient(options)
  const backend = createWorkerWorkbookSpreadsheetBackend({
    client,
    sheets: ['Sheet1'],
    revision: options?.revision ?? 59,
  })
  await backend.ready()
  return { client, backend }
}

function fillRangeRequest(revision: number | string = 59) {
  return {
    kind: 'fill-range' as const,
    sheetId: SHEET_ID,
    requestId: 1,
    revision,
    sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
    targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
    direction: 'down' as const,
  }
}

function noWriteSeriesRequest(revision: number | string = 59) {
  return {
    kind: 'fill-series' as const,
    sheetId: SHEET_ID,
    requestId: 2,
    revision,
    sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
    targetRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
    direction: 'down' as const,
    series: 'integer-step' as const,
    step: 2,
  }
}

function customListRequest(locale: string) {
  return {
    kind: 'fill-series' as const,
    sheetId: SHEET_ID,
    requestId: 12,
    revision: 59,
    sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
    targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
    direction: 'down' as const,
    series: 'custom-list' as const,
    step: 1,
    list: {
      listName: 'Fiscal',
      values: ['One', 'Two'],
      locale,
    },
  }
}

describe('worker native AutoFill transaction boundary', () => {
  test('exposes ports only when capability and native RPC are both present', async () => {
    const missingWitness = await createBackend({ capability: null })
    expect(missingWitness.backend.fillRange).toBeUndefined()
    missingWitness.backend.dispose()

    const falseWitness = await createBackend({
      capability: { scope: 'auto-fill', autoFill: false },
    })
    expect(falseWitness.backend.fillRange).toBeUndefined()
    falseWitness.backend.dispose()

    const missingMethod = await createBackend({ exposeApply: false })
    expect(missingMethod.backend.fillRange).toBeUndefined()
    missingMethod.backend.dispose()

    const supported = await createBackend()
    expect(supported.backend.fillRange).toEqual(expect.any(Function))
    expect(supported.backend.fillSeries).toEqual(expect.any(Function))
    supported.backend.dispose()
  })

  test('rejects stale requests before the native RPC', async () => {
    const { client, backend } = await createBackend()

    await expect(
      backend.fillRange!({ ...fillRangeRequest(), revision: 58 }),
    ).rejects.toMatchObject({ code: 'INVALID_AUTO_FILL' })
    expect(client.applyCalls).toBe(0)
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 13,
      }),
    ).resolves.toMatchObject({ revision: 59, applied: false })
    backend.dispose()
  })

  test('copy no-op validates the sheet but performs no native RPC or history mutation', async () => {
    const { client, backend } = await createBackend()
    const noOp = {
      ...fillRangeRequest(),
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
    }

    await expect(backend.fillRange!(noOp)).resolves.toMatchObject({
      revision: 59,
      applied: false,
      historyTransactionCount: 0,
    })
    expect(client.applyCalls).toBe(0)
    await expect(
      backend.fillRange!({ ...noOp, sheetId: 'missing-sheet' }),
    ).rejects.toMatchObject({ code: 'INVALID_SHEET' })
    expect(client.applyCalls).toBe(0)
    backend.dispose()
  })

  test.each(['en', 'zh', 'tr', 'az'])(
    'forwards the supported canonical locale %s without rewriting it',
    async (locale) => {
      const { client, backend } = await createBackend()

      await expect(backend.fillSeries!(customListRequest(locale))).resolves.toMatchObject({
        revision: 60,
        applied: true,
      })
      expect(client.lastApplyRequest?.list).toEqual({
        listName: 'Fiscal',
        values: ['One', 'Two'],
        locale,
      })
      backend.dispose()
    },
  )

  test('rejects an unsupported locale before the native RPC', async () => {
    const { client, backend } = await createBackend()

    await expect(backend.fillSeries!(customListRequest('fr'))).rejects.toMatchObject({
      code: 'INVALID_AUTO_FILL',
    })
    expect(client.applyCalls).toBe(0)
    backend.dispose()
  })

  test('rejects a target range over the auto-fill cell budget before the native RPC', async () => {
    // Two full columns (2 * MAX_AUTO_FILL_CELLS) — well over the
    // one-full-Excel-column budget. `prepareAutoFillWireRequest` mirrors
    // the engine's own `MAX_AUTO_FILL_CELLS` cap so hosts fail fast without
    // a worker round trip.
    const { client, backend } = await createBackend()

    await expect(
      backend.fillRange!({
        ...fillRangeRequest(),
        sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
        targetRange: { rowStart: 0, rowEnd: 1_048_575, colStart: 0, colEnd: 1 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_AUTO_FILL' })
    expect(client.applyCalls).toBe(0)
    backend.dispose()
  })

  test('normal fill is one RPC, one revision and one undo/redo transaction with formats', async () => {
    const { client, backend } = await createBackend()
    client.putCell({
      sheet: 0,
      addr: 'A3',
      row: 2,
      col: 0,
      kind: 'number',
      value: 3,
    })
    client.putFormat(0, 2, 0, { bgColor: '#111111' })
    client.setApplyHandler((_request, fake) => {
      fake.putCell({
        sheet: 0,
        addr: 'A3',
        row: 2,
        col: 0,
        kind: 'number',
        value: 7,
      })
      fake.putFormat(0, 2, 0, { bgColor: '#777777', bold: true })
      fake.emitDirty([{ sheet: 0, addr: 'A3' }])
      return {
        writeRange: { startRow: 2, startCol: 0, endRow: 2, endCol: 0 },
        written: 1,
      }
    })

    await expect(backend.fillRange!(fillRangeRequest())).resolves.toMatchObject({
      revision: 60,
      applied: true,
      historyTransactionCount: 1,
      historyDisposition: 'undoable',
    })
    expect(client.applyCalls).toBe(1)

    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'auto-fill-1',
        requestId: 3,
      }),
    ).resolves.toMatchObject({ revision: 61 })
    expect(client.readCell(0, 2, 0)).toMatchObject({ value: 3 })
    expect(client.readFormat(0, 2, 0)).toEqual({ bgColor: '#111111' })

    await expect(
      backend.redoTransaction!({
        kind: 'redo-transaction',
        transactionId: 'auto-fill-1',
        requestId: 4,
      }),
    ).resolves.toMatchObject({ revision: 62 })
    expect(client.readCell(0, 2, 0)).toMatchObject({ value: 7 })
    expect(client.readFormat(0, 2, 0)).toEqual({
      bgColor: '#777777',
      bold: true,
    })
    backend.dispose()
  })

  test.each([
    'seed values conflict with step',
    'formula dependency cycle would be introduced',
  ])(
    'no-write series turns native semantic rejection into a proven no-op: %s',
    async (reason) => {
      const { client, backend } = await createBackend()
      let refreshes = 0
      backend.subscribeContentChanges?.(() => {
        refreshes += 1
      })
      client.setApplyHandler(() => {
        throw Object.assign(new Error(reason), {
          code: 'AUTO_FILL_REJECTED',
        })
      })

      await expect(backend.fillSeries!(noWriteSeriesRequest())).resolves.toMatchObject({
        revision: 59,
        applied: false,
        historyTransactionCount: 0,
        historyDisposition: 'none',
        notAppliedReason: reason,
      })
      expect(client.applyCalls).toBe(1)
      expect(refreshes).toBe(0)
      await expect(
        backend.undoTransaction!({
          kind: 'undo-transaction',
          transactionId: 'none',
          requestId: 5,
        }),
      ).resolves.toMatchObject({ revision: 59, applied: false })
      backend.dispose()
    },
  )

  test('no-write series validation never swallows an unrelated dirty event', async () => {
    const { client, backend } = await createBackend()
    let refreshes = 0
    backend.subscribeContentChanges?.(() => {
      refreshes += 1
    })
    client.setApplyHandler((_request, fake) => {
      fake.emitDirty([{ sheet: 0, addr: 'Z99' }])
      return { writeRange: null, written: 0 }
    })

    await expect(backend.fillSeries!(noWriteSeriesRequest())).resolves.toMatchObject({
      revision: 60,
      applied: false,
      historyTransactionCount: 0,
    })
    expect(client.applyCalls).toBe(1)
    expect(refreshes).toBe(1)
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 9,
      }),
    ).resolves.toMatchObject({ revision: 60, applied: false })
    backend.dispose()
  })

  test('generic no-write validation failure remains outcome-unknown', async () => {
    const { client, backend } = await createBackend()
    let refreshes = 0
    backend.subscribeContentChanges?.(() => {
      refreshes += 1
    })
    client.setApplyHandler(() => {
      throw Object.assign(new Error('worker response channel failed'), {
        code: 'RPC_FAILED',
      })
    })

    await expect(backend.fillSeries!(noWriteSeriesRequest())).rejects.toMatchObject({
      code: 'AUTO_FILL_OUTCOME_UNKNOWN',
      outcome: 'unknown',
      revision: 60,
    })
    expect(client.applyCalls).toBe(1)
    expect(refreshes).toBe(1)
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 18,
      }),
    ).resolves.toMatchObject({ revision: 60, applied: false })
    backend.dispose()
  })

  test('observer exceptions cannot replace a canonical outcome-unknown error', async () => {
    const { client, backend } = await createBackend()
    backend.subscribeContentChanges?.(() => {
      throw new Error('projection observer failed')
    })
    client.setApplyHandler(() => {
      throw new Error('generic post-dispatch failure')
    })

    await expect(backend.fillSeries!(noWriteSeriesRequest())).rejects.toMatchObject({
      code: 'AUTO_FILL_OUTCOME_UNKNOWN',
      outcome: 'unknown',
      revision: 60,
    })
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 181,
      }),
    ).resolves.toMatchObject({ revision: 60, applied: false })
    backend.dispose()
  })

  test('observer exceptions cannot turn a semantic rejection into outcome-unknown', async () => {
    const { client, backend } = await createBackend()
    backend.subscribeContentChanges?.(() => {
      throw new Error('projection observer failed')
    })
    client.setApplyHandler((_request, fake) => {
      fake.emitDirty([{ sheet: 0, addr: 'A3' }])
      throw Object.assign(new Error('invalid series seed'), {
        code: 'AUTO_FILL_REJECTED',
      })
    })

    await expect(backend.fillRange!(fillRangeRequest())).resolves.toMatchObject({
      revision: 60,
      applied: false,
      notAppliedReason: 'invalid series seed',
    })
    backend.dispose()
  })

  test('observer exceptions cannot replace a committed success ACK', async () => {
    const { backend } = await createBackend()
    backend.subscribeContentChanges?.(() => {
      throw new Error('projection observer failed')
    })

    await expect(backend.fillRange!(fillRangeRequest())).resolves.toMatchObject({
      revision: 60,
      applied: true,
      historyTransactionCount: 1,
    })
    backend.dispose()
  })

  test('semantic rejection preserves an earlier fill transaction and its revision', async () => {
    const { client, backend } = await createBackend()
    client.putCell({
      sheet: 0,
      addr: 'A3',
      row: 2,
      col: 0,
      kind: 'number',
      value: 3,
    })

    await expect(backend.fillRange!(fillRangeRequest())).resolves.toMatchObject({
      revision: 60,
      applied: true,
    })

    let refreshes = 0
    backend.subscribeContentChanges?.(() => {
      refreshes += 1
    })
    client.setApplyHandler(() => {
      throw Object.assign(new Error('source values do not define this series'), {
        code: 'AUTO_FILL_REJECTED',
      })
    })

    await expect(
      backend.fillRange!({
        ...fillRangeRequest(60),
        requestId: 19,
      }),
    ).resolves.toMatchObject({
      revision: 60,
      applied: false,
      historyTransactionCount: 0,
      historyDisposition: 'none',
      notAppliedReason: 'source values do not define this series',
    })
    expect(refreshes).toBe(0)

    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'prior-fill',
        requestId: 20,
      }),
    ).resolves.toMatchObject({ revision: 61 })
    expect(client.readCell(0, 2, 0)).toMatchObject({ value: 3 })
    backend.dispose()
  })

  test('a dirty event deferred inside a semantic rejection is an independent epoch', async () => {
    const { client, backend } = await createBackend()
    let refreshes = 0
    backend.subscribeContentChanges?.(() => {
      refreshes += 1
    })
    client.setApplyHandler((_request, fake) => {
      fake.emitDirty([{ sheet: 0, addr: 'A3' }])
      throw Object.assign(new Error('source values are invalid'), {
        code: 'AUTO_FILL_REJECTED',
      })
    })

    await expect(backend.fillRange!(fillRangeRequest())).resolves.toMatchObject({
      revision: 60,
      applied: false,
      historyTransactionCount: 0,
      notAppliedReason: 'source values are invalid',
    })
    expect(refreshes).toBe(1)
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 21,
      }),
    ).resolves.toMatchObject({ revision: 60, applied: false })
    backend.dispose()
  })

  test('post-dispatch native rejection is explicit outcome-unknown', async () => {
    const { client, backend } = await createBackend()
    let refreshes = 0
    backend.subscribeContentChanges?.(() => {
      refreshes += 1
    })
    client.setApplyHandler((_request, fake) => {
      fake.putCell({
        sheet: 0,
        addr: 'A3',
        row: 2,
        col: 0,
        kind: 'number',
        value: 999,
      })
      fake.emitDirty([{ sheet: 0, addr: 'A3' }])
      throw Object.assign(new Error('response serialization failed'), {
        code: 'RPC_FAILED',
      })
    })

    await expect(backend.fillRange!(fillRangeRequest())).rejects.toMatchObject({
      code: 'AUTO_FILL_OUTCOME_UNKNOWN',
      outcome: 'unknown',
      revision: 60,
    })
    expect(client.readCell(0, 2, 0)).toMatchObject({ value: 999 })
    expect(refreshes).toBe(1)
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 10,
      }),
    ).resolves.toMatchObject({ revision: 60, applied: false })
    backend.dispose()
  })

  test('dirty epoch during the before snapshot aborts before the native RPC', async () => {
    const { client, backend } = await createBackend()
    client.setSnapshotHook((call) => {
      if (call === 1) client.emitDirty([{ sheet: 0, addr: 'Z99' }])
    })

    await expect(backend.fillRange!(fillRangeRequest())).rejects.toMatchObject({
      code: 'INVALID_AUTO_FILL',
    })
    expect(client.applyCalls).toBe(0)
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 6,
      }),
    ).resolves.toMatchObject({ revision: 60, applied: false })
    backend.dispose()
  })

  test('dirty epoch during the after snapshot is never overwritten by an old revision budget', async () => {
    const { client, backend } = await createBackend()
    client.setSnapshotHook((call) => {
      if (call === 2) client.emitDirty([{ sheet: 0, addr: 'Z99' }])
    })

    await expect(backend.fillRange!(fillRangeRequest())).resolves.toMatchObject({
      revision: 61,
      applied: true,
      historyTransactionCount: 1,
    })
    expect(client.applyCalls).toBe(1)
    backend.dispose()
  })

  test('malformed native ACK rolls back from the captured before image', async () => {
    const { client, backend } = await createBackend()
    client.putCell({
      sheet: 0,
      addr: 'A3',
      row: 2,
      col: 0,
      kind: 'number',
      value: 3,
    })
    client.putFormat(0, 2, 0, { bgColor: '#333333' })
    client.setApplyHandler((_request, fake) => {
      fake.putCell({
        sheet: 0,
        addr: 'A3',
        row: 2,
        col: 0,
        kind: 'number',
        value: 999,
      })
      fake.putFormat(0, 2, 0, { bgColor: '#999999' })
      fake.emitDirty([{ sheet: 0, addr: 'A3' }])
      return {
        writeRange: { startRow: 2, startCol: 0, endRow: 2, endCol: 0 },
        written: 0,
      }
    })

    await expect(backend.fillRange!(fillRangeRequest())).rejects.toMatchObject({
      code: 'INVALID_AUTO_FILL_REPORT',
    })
    expect(client.readCell(0, 2, 0)).toMatchObject({ value: 3 })
    expect(client.readFormat(0, 2, 0)).toEqual({ bgColor: '#333333' })
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 7,
      }),
    ).resolves.toMatchObject({ revision: 59, applied: false })
    backend.dispose()
  })

  test('verified rollback preserves unrelated dirty revision and refresh', async () => {
    const { client, backend } = await createBackend()
    let refreshes = 0
    backend.subscribeContentChanges?.(() => {
      refreshes += 1
    })
    client.putCell({
      sheet: 0,
      addr: 'A3',
      row: 2,
      col: 0,
      kind: 'number',
      value: 3,
    })
    client.setRestoreHook((call) => {
      if (call === 1) client.emitDirty([{ sheet: 0, addr: 'Z99' }])
    })
    client.setApplyHandler((_request, fake) => {
      fake.putCell({
        sheet: 0,
        addr: 'A3',
        row: 2,
        col: 0,
        kind: 'number',
        value: 999,
      })
      fake.emitDirty([{ sheet: 0, addr: 'A3' }])
      return {
        writeRange: { startRow: 2, startCol: 0, endRow: 2, endCol: 0 },
        written: 0,
      }
    })

    await expect(backend.fillRange!(fillRangeRequest())).rejects.toMatchObject({
      code: 'INVALID_AUTO_FILL_REPORT',
    })
    expect(client.readCell(0, 2, 0)).toMatchObject({ value: 3 })
    expect(refreshes).toBe(1)
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 11,
      }),
    ).resolves.toMatchObject({ revision: 60, applied: false })
    backend.dispose()
  })

  test('malformed ACK without a before image is explicit outcome-unknown and refreshes', async () => {
    const { client, backend } = await createBackend()
    let refreshes = 0
    backend.subscribeContentChanges?.(() => {
      refreshes += 1
    })
    client.failNextValueSnapshot()
    client.setApplyHandler((_request, fake) => {
      fake.putCell({
        sheet: 0,
        addr: 'A3',
        row: 2,
        col: 0,
        kind: 'number',
        value: 999,
      })
      fake.emitDirty([{ sheet: 0, addr: 'A3' }])
      return {
        writeRange: { startRow: 2, startCol: 0, endRow: 2, endCol: 0 },
        written: 0,
      }
    })

    await expect(backend.fillRange!(fillRangeRequest())).rejects.toMatchObject({
      code: 'AUTO_FILL_OUTCOME_UNKNOWN',
      outcome: 'unknown',
      revision: 60,
    })
    expect(client.readCell(0, 2, 0)).toMatchObject({ value: 999 })
    expect(refreshes).toBe(1)
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 8,
      }),
    ).resolves.toMatchObject({ revision: 60, applied: false })
    backend.dispose()
  })

  test('undo clear followed by restore failure clears both history directions', async () => {
    const { client, backend } = await createBackend()
    client.putCell({
      sheet: 0,
      addr: 'A3',
      row: 2,
      col: 0,
      kind: 'number',
      value: 3,
    })
    await backend.fillRange!(fillRangeRequest())

    let refreshes = 0
    backend.subscribeContentChanges?.(() => {
      refreshes += 1
    })
    client.setSparseRestoreHook(() => {
      throw new Error('restore before-image failed')
    })

    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'partial-undo',
        requestId: 30,
      }),
    ).rejects.toMatchObject({
      code: 'AUTO_FILL_OUTCOME_UNKNOWN',
      outcome: 'unknown',
      revision: 61,
    })
    expect(client.readCell(0, 2, 0)).toBeUndefined()
    expect(refreshes).toBe(1)
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 31,
      }),
    ).resolves.toMatchObject({ revision: 61, applied: false })
    await expect(
      backend.redoTransaction!({
        kind: 'redo-transaction',
        transactionId: 'none',
        requestId: 32,
      }),
    ).resolves.toMatchObject({ revision: 61, applied: false })
    backend.dispose()
  })

  test('redo clear followed by restore failure clears both history directions', async () => {
    const { client, backend } = await createBackend()
    client.putCell({
      sheet: 0,
      addr: 'A3',
      row: 2,
      col: 0,
      kind: 'number',
      value: 3,
    })
    await backend.fillRange!(fillRangeRequest())
    await backend.undoTransaction!({
      kind: 'undo-transaction',
      transactionId: 'partial-redo',
      requestId: 33,
    })

    let refreshes = 0
    backend.subscribeContentChanges?.(() => {
      refreshes += 1
    })
    client.setSparseRestoreHook(() => {
      throw new Error('restore after-image failed')
    })

    await expect(
      backend.redoTransaction!({
        kind: 'redo-transaction',
        transactionId: 'partial-redo',
        requestId: 34,
      }),
    ).rejects.toMatchObject({
      code: 'AUTO_FILL_OUTCOME_UNKNOWN',
      outcome: 'unknown',
      revision: 62,
    })
    expect(client.readCell(0, 2, 0)).toBeUndefined()
    expect(refreshes).toBe(1)
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 35,
      }),
    ).resolves.toMatchObject({ revision: 62, applied: false })
    await expect(
      backend.redoTransaction!({
        kind: 'redo-transaction',
        transactionId: 'none',
        requestId: 36,
      }),
    ).resolves.toMatchObject({ revision: 62, applied: false })
    backend.dispose()
  })

  test.each([
    ['outside-range', [{ sheet: 0, addr: 'Z99' }]],
    ['empty', []],
  ] as Array<[string, CellRefWire[]]>)(
    '%s dirty during failed history replay remains an independent epoch',
    async (_label, dirtyCells) => {
      const { client, backend } = await createBackend()
      client.putCell({
        sheet: 0,
        addr: 'A3',
        row: 2,
        col: 0,
        kind: 'number',
        value: 3,
      })
      await backend.fillRange!(fillRangeRequest())

      let refreshes = 0
      backend.subscribeContentChanges?.(() => {
        refreshes += 1
      })
      client.setSparseRestoreHook(() => {
        client.emitDirty([...dirtyCells])
        throw new Error('restore failed after independent dirty')
      })

      await expect(
        backend.undoTransaction!({
          kind: 'undo-transaction',
          transactionId: 'dirty-partial',
          requestId: 37,
        }),
      ).rejects.toMatchObject({
        code: 'AUTO_FILL_OUTCOME_UNKNOWN',
        revision: 62,
      })
      expect(refreshes).toBe(2)
      await expect(
        backend.undoTransaction!({
          kind: 'undo-transaction',
          transactionId: 'none',
          requestId: 38,
        }),
      ).resolves.toMatchObject({ revision: 62, applied: false })
      backend.dispose()
    },
  )

  test('MAX_SAFE partial replay rolls into an exact string witness and keeps advancing', async () => {
    const startRevision = Number.MAX_SAFE_INTEGER - 2
    const { client, backend } = await createBackend({ revision: startRevision })
    client.putCell({
      sheet: 0,
      addr: 'A3',
      row: 2,
      col: 0,
      kind: 'number',
      value: 3,
    })
    await expect(
      backend.fillRange!(fillRangeRequest(startRevision)),
    ).resolves.toMatchObject({ revision: Number.MAX_SAFE_INTEGER - 1 })

    let refreshes = 0
    backend.subscribeContentChanges?.(() => {
      refreshes += 1
    })
    client.setSparseRestoreHook(() => {
      client.emitDirty([{ sheet: 0, addr: 'Z99' }])
      throw new Error('partial replay at numeric boundary')
    })

    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'max-safe-partial',
        requestId: 39,
      }),
    ).rejects.toMatchObject({
      code: 'AUTO_FILL_OUTCOME_UNKNOWN',
      outcome: 'unknown',
      revision: '9007199254740992',
    })
    expect(refreshes).toBe(2)

    // A plain dirty event outside AutoFill never advances an opaque/BigInt
    // revision witness — only AutoFill's own finalize sites do that. The
    // shared revision counter otherwise keeps HEAD's "non-numeric revision
    // passes through unchanged" contract, so this independent event still
    // refreshes projections but leaves the witness itself unmoved.
    client.emitDirty([{ sheet: 0, addr: 'Z100' }])
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 40,
      }),
    ).resolves.toMatchObject({
      revision: '9007199254740992',
      applied: false,
    })
    expect(refreshes).toBe(3)
    backend.dispose()
  })

  test('multiple independent dirty events cannot exhaust the success ACK revision', async () => {
    const startRevision = Number.MAX_SAFE_INTEGER - 2
    const { client, backend } = await createBackend({ revision: startRevision })
    client.setApplyHandler((request, fake) => {
      fake.putCell({
        sheet: request.sheet,
        addr: 'A3',
        row: 2,
        col: 0,
        kind: 'number',
        value: 7,
      })
      fake.emitDirty([{ sheet: 0, addr: 'Z99' }])
      fake.emitDirty([{ sheet: 0, addr: 'Z100' }])
      return {
        writeRange: { startRow: 2, startCol: 0, endRow: 2, endCol: 0 },
        written: 1,
      }
    })

    await expect(
      backend.fillRange!(fillRangeRequest(startRevision)),
    ).resolves.toMatchObject({
      revision: '9007199254740992',
      applied: true,
      historyTransactionCount: 1,
    })
    expect(client.applyCalls).toBe(1)
    backend.dispose()
  })

  test('opaque revision no-write failure stays unknown and a later dirty event still refreshes', async () => {
    const { client, backend } = await createBackend({ revision: 'opaque-v1' })
    let refreshes = 0
    backend.subscribeContentChanges?.(() => {
      refreshes += 1
    })
    client.setApplyHandler(() => {
      throw new Error('generic failure with opaque revision')
    })

    await expect(
      backend.fillSeries!(noWriteSeriesRequest('opaque-v1')),
    ).rejects.toMatchObject({
      code: 'AUTO_FILL_OUTCOME_UNKNOWN',
      outcome: 'unknown',
      revision: 'worker-auto-fill:opaque-v1:1',
    })
    // A plain dirty event outside AutoFill still refreshes projections, but
    // it goes through the shared (non-AutoFill) revision bump, which keeps
    // HEAD's "non-numeric revision passes through unchanged" contract — only
    // AutoFill's own finalize sites advance the opaque witness.
    client.emitDirty([{ sheet: 0, addr: 'Z99' }])
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 41,
      }),
    ).resolves.toMatchObject({
      revision: 'worker-auto-fill:opaque-v1:1',
      applied: false,
    })
    expect(refreshes).toBe(2)
    backend.dispose()
  })

  test('opaque lone-surrogate revisions stay total after success and unknown outcomes', async () => {
    const initialRevision = '\uD800'
    const firstRevision = 'worker-auto-fill:~d800:1'
    const { client, backend } = await createBackend({ revision: initialRevision })

    await expect(
      backend.fillRange!(fillRangeRequest(initialRevision)),
    ).resolves.toMatchObject({
      revision: firstRevision,
      applied: true,
    })

    client.setApplyHandler(() => {
      throw new Error('generic validation transport failure')
    })
    await expect(
      backend.fillSeries!(noWriteSeriesRequest(firstRevision)),
    ).rejects.toMatchObject({
      code: 'AUTO_FILL_OUTCOME_UNKNOWN',
      outcome: 'unknown',
      revision: 'worker-auto-fill:~d800:2',
    })

    // Same as above: a plain dirty event outside AutoFill refreshes but does
    // not advance the opaque witness — only AutoFill's own finalize sites do.
    client.emitDirty([{ sheet: 0, addr: 'Z99' }])
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'none',
        requestId: 42,
      }),
    ).resolves.toMatchObject({
      revision: 'worker-auto-fill:~d800:2',
      applied: false,
    })
    backend.dispose()
  })

  test('auto-fill remains one transaction when the bounded undo stack rolls over', async () => {
    const { client, backend } = await createBackend()
    let revision = 59
    for (let index = 0; index <= WORKER_UNDO_STACK_CAP; index += 1) {
      const result = await backend.fillRange!({
        ...fillRangeRequest(revision),
        requestId: 1000 + index,
      })
      expect(result).toMatchObject({
        applied: true,
        historyTransactionCount: 1,
      })
      revision = result.revision as number
    }
    expect(client.applyCalls).toBe(WORKER_UNDO_STACK_CAP + 1)

    for (let index = 0; index < WORKER_UNDO_STACK_CAP; index += 1) {
      const result = await backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: `cap-${index}`,
        requestId: 1200 + index,
      })
      expect(result).not.toMatchObject({ applied: false })
    }
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'evicted-oldest',
        requestId: 1400,
      }),
    ).resolves.toMatchObject({ applied: false })
    backend.dispose()
  })
})
