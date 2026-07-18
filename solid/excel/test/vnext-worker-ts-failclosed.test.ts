/**
 * Fail-closed honesty for the TS worker runtime (#31 follow-up).
 *
 * The TS runtime used to answer several command families it does NOT
 * implement with success-shaped fake ACKs:
 *   - insertRows / deleteRows / insertColumns / deleteColumns → `true`
 *     (no-op; removeRows over it reported invented deletion counts)
 *   - setFormatRange → `0`, snapshotFormatRange → empty snapshot,
 *     restoreFormatSnapshot → `0`
 *   - beginExportRangeTsv / nextExportRangeTsvChunk → one EMPTY chunk
 *     (chunked exports silently produced '')
 *   - restorePersistenceV1 → `restored_formats: 0` while silently
 *     dropping any snapshot formats block AND wiping the custom-formula
 *     registry
 *
 * This suite pins the honest contract:
 *   1. RPC level — those commands answer a structured
 *      `{ ok: false, error: { code: 'UNSUPPORTED' } }` envelope, and
 *      `describeCapabilities` declares the families `false`.
 *   2. Adapter level — `createWorkerWorkbookSpreadsheetBackend` reads
 *      the witness during init and withholds the matching optional
 *      `SpreadsheetBackend` ports (port absent → UI hides the entry;
 *      same fail-closed pattern as the removeRowsExact witness).
 *   3. Legacy runtimes (the WASM runtime answers UNKNOWN_COMMAND to the
 *      handshake) map to a `null` witness — the adapter keeps the
 *      legacy full-trust contract, so the WASM path is unchanged.
 */

import { describe, expect, test } from '@jest/globals'
import { createVisibleProjectionRequest } from '@einfach/spreadsheet-ui-core'

import {
  createWorkerRuntimeTs,
  installWorkerRuntimeTs,
  TS_WORKER_RUNTIME_CAPABILITIES,
  type ExcelCoreTsWorkerRuntime,
  type WorkerContext,
} from '../src-vnext/adapter/worker-runtime-ts'
import {
  createWorkerWorkbook,
  createWorkerWorkbookSpreadsheetBackend,
} from '../src-vnext/adapter'
import type { WorkerLike } from '../src-vnext/adapter'

type RpcResponse = Awaited<ReturnType<ExcelCoreTsWorkerRuntime['handle']>>

function makeRpc(runtime = createWorkerRuntimeTs()) {
  let nextId = 1
  const raw = (req: { cmd: string; [key: string]: unknown }): Promise<RpcResponse> =>
    runtime.handle({ id: nextId++, ...req })
  return { runtime, raw }
}

function expectOk(resp: RpcResponse): unknown {
  if (!resp.ok) {
    throw new Error(`expected ok envelope, got ${resp.error.code}: ${resp.error.message}`)
  }
  return resp.result
}

function expectUnsupported(resp: RpcResponse): void {
  expect(resp.ok).toBe(false)
  if (resp.ok) return
  expect(resp.error.code).toBe('UNSUPPORTED')
}

/**
 * Duplex in-process "worker" wired to the real TS runtime, so the real
 * WorkerWorkbookClient + backend stack runs without spawning a Worker.
 * (Same shape as audit-adapter-scaling.test.ts.)
 */
function createInProcessTsWorker(): WorkerLike {
  const toWorker: Array<(e: MessageEvent) => void> = []
  const toClient: Array<(e: MessageEvent) => void> = []
  const workerCtx: WorkerContext = {
    postMessage(msg: unknown) {
      for (const listener of [...toClient]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type, listener) {
      toWorker.push(listener)
    },
  }
  installWorkerRuntimeTs(workerCtx)
  return {
    postMessage(msg: unknown) {
      for (const listener of [...toWorker]) listener({ data: msg } as MessageEvent)
    },
    addEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      toClient.push(listener)
    },
    removeEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      const index = toClient.indexOf(listener)
      if (index >= 0) toClient.splice(index, 1)
    },
    terminate() {},
  }
}

/**
 * Legacy-shaped protocol worker: understands the init/read handshake the
 * backend needs and answers everything else — including
 * `describeCapabilities` — with UNKNOWN_COMMAND, exactly like the WASM
 * runtime (which predates the handshake). Lets the suite pin the
 * full-trust default without loading WASM.
 */
function createLegacyProtocolWorker(): WorkerLike {
  const listeners: Array<(e: MessageEvent) => void> = []
  const respond = (payload: unknown) => {
    queueMicrotask(() => {
      for (const listener of [...listeners]) listener({ data: payload } as MessageEvent)
    })
  }
  return {
    postMessage(msg: unknown) {
      const { id, cmd } = msg as { id: number; cmd: string }
      if (cmd === 'initWorkbook' || cmd === 'sheetList') {
        respond({ id, ok: true, result: [{ idx: 0, name: 'Sheet1' }] })
        return
      }
      respond({
        id,
        ok: false,
        error: { code: 'UNKNOWN_COMMAND', message: `unknown command: ${cmd}` },
      })
    },
    addEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      listeners.push(listener)
    },
    removeEventListener(_type: 'message', listener: (e: MessageEvent) => void) {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    },
    terminate() {},
  }
}

describe('TS worker runtime — structured UNSUPPORTED instead of success-shaped fake ACKs', () => {
  test('describeCapabilities declares every unimplemented family false', async () => {
    const { raw } = makeRpc()
    await raw({ cmd: 'initWorkbook', sheets: ['Sheet1'] })

    const witness = {
      structuralEdits: false,
      formats: false,
      formatSnapshots: false,
      tsvChunkExport: false,
      persistenceFormats: false,
    }
    expect(expectOk(await raw({ cmd: 'describeCapabilities' }))).toEqual(witness)
    expect({ ...TS_WORKER_RUNTIME_CAPABILITIES }).toEqual(witness)
  })

  test('structural commands refuse with UNSUPPORTED and leave the workbook untouched', async () => {
    const { raw } = makeRpc()
    await raw({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
    await raw({ cmd: 'setCell', sheet: 0, addr: 'A3', value: { type: 'number', value: 7 } })

    // Previously every one of these returned a success-shaped `true`
    // without moving a single cell.
    expectUnsupported(await raw({ cmd: 'insertRows', sheet: 0, rowIndex: 0, count: 2 }))
    expectUnsupported(await raw({ cmd: 'deleteRows', sheet: 0, rowIndex: 0, count: 2 }))
    expectUnsupported(await raw({ cmd: 'insertColumns', sheet: 0, colIndex: 0, count: 1 }))
    expectUnsupported(await raw({ cmd: 'deleteColumns', sheet: 0, colIndex: 0, count: 1 }))

    const cells = expectOk(
      await raw({ cmd: 'readCells', cells: [{ sheet: 0, addr: 'A3' }] }),
    ) as Array<{ display: string }>
    expect(cells[0].display).toBe('7')
  })

  test('format commands refuse with UNSUPPORTED (no zero-count / empty-snapshot ACKs)', async () => {
    const { raw } = makeRpc()
    await raw({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
    const range = { sheet: 0, startRow: 0, startCol: 0, endRow: 1, endCol: 1 }

    expectUnsupported(await raw({ cmd: 'setFormatRange', range, fmt: { bgColor: '#ff0000' } }))
    expectUnsupported(await raw({ cmd: 'snapshotFormatRange', range }))
    expectUnsupported(
      await raw({
        cmd: 'restoreFormatSnapshot',
        snapshot: { ...range, cellFormats: [], rangeFormats: [] },
      }),
    )
  })

  test('chunked TSV export refuses; single-shot exportRangeTsv still carries real content', async () => {
    const { raw } = makeRpc()
    await raw({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
    await raw({ cmd: 'setCell', sheet: 0, addr: 'A1', value: { type: 'text', value: 'hello' } })
    await raw({ cmd: 'setCell', sheet: 0, addr: 'B1', value: { type: 'number', value: 42 } })
    const range = { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 1 }

    // Previously beginExportRangeTsv opened a fake session and
    // nextExportRangeTsvChunk emitted one EMPTY done-chunk — chunked
    // exports produced '' end to end.
    expectUnsupported(await raw({ cmd: 'beginExportRangeTsv', range, rowsPerChunk: 8 }))
    expectUnsupported(await raw({ cmd: 'nextExportRangeTsvChunk', sessionId: 1 }))
    // Nothing was cancelled because no session can exist.
    expect(expectOk(await raw({ cmd: 'cancelExport', sessionId: 1 }))).toBe(false)

    expect(expectOk(await raw({ cmd: 'exportRangeTsv', range }))).toBe('hello\t42')
  })

  test('restorePersistenceV1 refuses a formats block BEFORE touching any state', async () => {
    const { raw } = makeRpc()
    await raw({ cmd: 'initWorkbook', sheets: ['Keep'] })
    await raw({ cmd: 'setCell', sheet: 0, addr: 'A1', value: { type: 'number', value: 1 } })

    expectUnsupported(
      await raw({
        cmd: 'restorePersistenceV1',
        snapshot: {
          version: 1,
          sheets: [{ idx: 0, name: 'Other' }],
          cells: [],
          formats: [
            {
              sheet: 0,
              startRow: 0,
              startCol: 0,
              endRow: 0,
              endCol: 0,
              cellFormats: [],
              rangeFormats: [
                {
                  startRow: 0,
                  startCol: 0,
                  endRow: 0,
                  endCol: 0,
                  format: { bgColor: '#ff0000' },
                },
              ],
            },
          ],
        },
      }),
    )

    // The refusal must not have half-restored: same sheet, same cell.
    expect(expectOk(await raw({ cmd: 'sheetList' }))).toEqual([{ idx: 0, name: 'Keep' }])
    const cells = expectOk(
      await raw({ cmd: 'readCells', cells: [{ sheet: 0, addr: 'A1' }] }),
    ) as Array<{ display: string }>
    expect(cells[0].display).toBe('1')
  })

  test('restorePersistenceV1 without formats works and keeps custom-formula registrations', async () => {
    const { raw } = makeRpc()
    await raw({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
    expectOk(
      await raw({
        cmd: 'registerCustomFormula',
        name: 'MYTWICE',
        source: 'return args[0] * 2',
        isAsync: false,
      }),
    )

    const stats = expectOk(
      await raw({
        cmd: 'restorePersistenceV1',
        snapshot: {
          version: 1,
          sheets: [{ idx: 0, name: 'Sheet1' }],
          cells: [
            { sheet: 0, addr: 'A1', row: 0, col: 0, kind: 'number', value: 21 },
            { sheet: 0, addr: 'B1', row: 0, col: 1, kind: 'formula', value: '=MYTWICE(A1)' },
          ],
        },
      }),
    )
    expect(stats).toEqual({ restored_cells: 2, restored_formats: 0, sheets: 1 })

    // Previously the restore wiped the registry, so B1 read back #NAME?.
    const cells = expectOk(
      await raw({ cmd: 'readCells', cells: [{ sheet: 0, addr: 'B1' }] }),
    ) as Array<{ display: string; isError: boolean }>
    expect(cells[0].isError).toBe(false)
    expect(cells[0].display).toBe('42')
  })
})

describe('TS worker backend — the capability handshake withholds unimplemented ports', () => {
  test('structural and format ports read undefined after ready() (UI hides the entries)', async () => {
    const backend = createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => createInProcessTsWorker(),
      sheets: ['Sheet1'],
      // Even an (incorrect) host opt-in cannot beat the runtime's own
      // structuralEdits:false witness — both must agree.
      removeRowsExactCapability: 'worker-engine-delete-rows',
    })
    await backend.ready()

    expect(backend.insertRows).toBeUndefined()
    expect(backend.deleteRows).toBeUndefined()
    expect(backend.insertColumns).toBeUndefined()
    expect(backend.deleteColumns).toBeUndefined()
    expect(backend.removeRows).toBeUndefined()
    expect(backend.removeRowsExact).toBeUndefined()
    expect(backend.setFormatRange).toBeUndefined()

    backend.dispose()
  })

  test('the protocol client surfaces UNSUPPORTED instead of a fabricated success', async () => {
    const client = createWorkerWorkbook({ workerFactory: () => createInProcessTsWorker() })
    await client.initWorkbook(['Sheet1'])

    await expect(client.describeCapabilities?.()).resolves.toEqual({
      ...TS_WORKER_RUNTIME_CAPABILITIES,
    })
    await expect(client.insertRows(0, 0, 1)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await expect(client.deleteRows(0, 0, 1)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    await expect(
      client.setFormatRange(
        { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        { bgColor: '#ff0000' },
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' })

    client.dispose()
  })

  test('reads and exports still work through the honest fallbacks (no empty-string TSV)', async () => {
    const backend = createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => createInProcessTsWorker(),
      sheets: ['Sheet1'],
    })
    await backend.ready()
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 0,
      input: 'hello',
      requestId: 1,
    })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 0,
      col: 1,
      input: '42',
      requestId: 2,
    })

    // Projection reads skip the unsupported format snapshot and overlay
    // an empty format map (truthful — the runtime models no formats).
    const projection = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 3,
        window: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      }),
    )
    expect(
      projection.cells.find((cell) => cell.row === 0 && cell.col === 0)?.displayValue,
    ).toBe('hello')

    // The chunk-session path is bypassed (tsvChunkExport: false) in
    // favor of the really-implemented single-shot export. Previously
    // both of these produced ''.
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 }
    const exported = await backend.exportRangeTsv?.({
      kind: 'export-range-tsv',
      sheetId: 'sheet-1',
      range,
      requestId: 4,
    })
    expect(exported?.text).toBe('hello\t42')

    const chunks: string[] = []
    await backend.consumeExportRangeTsvChunks?.(
      { kind: 'export-range-tsv', sheetId: 'sheet-1', range, requestId: 5 },
      (chunk) => {
        chunks.push(chunk.text)
      },
    )
    expect(chunks).toEqual(['hello\t42'])

    backend.dispose()
  })
})

describe('legacy runtimes without the handshake keep the full-trust contract (WASM path)', () => {
  test('UNKNOWN_COMMAND maps to a null witness and every port stays exposed', async () => {
    const client = createWorkerWorkbook({ workerFactory: () => createLegacyProtocolWorker() })
    await expect(client.describeCapabilities?.()).resolves.toBeNull()

    const backend = createWorkerWorkbookSpreadsheetBackend({
      client,
      sheets: ['Sheet1'],
      removeRowsExactCapability: 'worker-engine-delete-rows',
    })
    await backend.ready()

    expect(typeof backend.insertRows).toBe('function')
    expect(typeof backend.deleteRows).toBe('function')
    expect(typeof backend.insertColumns).toBe('function')
    expect(typeof backend.deleteColumns).toBe('function')
    expect(typeof backend.removeRows).toBe('function')
    expect(typeof backend.removeRowsExact).toBe('function')
    expect(typeof backend.setFormatRange).toBe('function')

    backend.dispose()
  })
})
