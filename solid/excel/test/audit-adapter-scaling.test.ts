/**
 * AUDIT MEASUREMENT / REPRO PINS — mutation-path pattern-family audit
 * (2026-06-12, section D of
 * rust/excel-core/docs/AUDIT_PATTERN_FAMILY_2026-06-12.md).
 *
 * Purpose: this file is NOT a behavior suite. It pins reproductions of
 * the eager-fan-out (P-A) / per-item-ceremony (P-B) / incomplete-teardown
 * (P-D) family inside the worker adapters and the static reference
 * backend. Timings go to console.log; assertions stay deliberately loose
 * so the suite remains green on any hardware. Tests that pin a BUG assert
 * the CURRENT (buggy) behavior on purpose — flip the expectation when the
 * fix lands and move the test into the relevant behavior suite.
 *
 * Pins:
 *  - D-1  P-A  **FIXED** (W2.4) worker-runtime-ts clearRange routes
 *         through the engine's sparse `clearRange` — O(existing cells),
 *         one postWrite batch. The pins below assert the fixed shape
 *         (cleared counts existing cells only; full-column clear is
 *         bounded by sheet content; spill semantics match W1.1).
 *  - D-5  P-D  **FIXED** worker-runtime-ts sheet ops reset
 *         `readFormulaCells` / `importSessions` / `snapshotSessions` in
 *         `rebuildPreservingCells` — the cache-state probe stays honest
 *         and stale sessions fail loudly instead of hitting the wrong
 *         (shifted) sheet index.
 *  - D-4  P-D  **FIXED** worker-workbook-backend deleteSheet drops every
 *         per-sheet host overlay (`dropSheetOverlayState`) — a reused
 *         sheet id starts clean.
 *  - D-7  P-A  **FIXED** worker-workbook-backend caches the filter/sort
 *         displayRows permutation per (content generation, spec, column
 *         band); the 0..EXCEL_MAX wide scan runs once per mutation, repeat
 *         viewport refreshes read a content-bounded source-row band.
 *  - D-8  P-A  **FIXED** worker-runtime-ts range readers enumerate
 *         window ∩ existing via `collectCellsInBounds` (coordinate probe
 *         for viewport windows, sparse map walk for huge ranges).
 *  - D-10 P-B  **FIXED** worker-workbook-backend removeRows groups the
 *         descending row list into contiguous bands — one deleteRows RPC
 *         per band instead of per row.
 *  - C-8  wire **FIXED** bulk import forwards typed `BulkTypedCellInput`
 *         entries — text that looks numeric/boolean/error survives the
 *         bulk path (no parseLiteral re-classification).
 *  - D-2  P-A  static-backend beginUndoableMutation deep-clones the WHOLE
 *         workbook on every undoable mutation (incl. each setCellInput).
 */

import { describe, expect, test } from '@jest/globals'
import { createVisibleProjectionRequest } from '@einfach/spreadsheet-ui-core'

import {
  createWorkerRuntimeTs,
  installWorkerRuntimeTs,
  type WorkerContext,
} from '../src-vnext/adapter/worker-runtime-ts'
import {
  createStaticSpreadsheetBackend,
  createWorkerWorkbookSpreadsheetBackend,
  createWorkerWorkbook,
} from '../src-vnext/adapter'
import type { SparseRangeWire, WorkerLike } from '../src-vnext/adapter'

const now = (): number => performance.now()

interface RpcRequest {
  id: number
  cmd: string
  [key: string]: unknown
}

function makeRpc(runtime = createWorkerRuntimeTs()) {
  let nextId = 1
  const rpc = async (req: Omit<RpcRequest, 'id'>) => {
    const id = nextId++
    const resp = await runtime.handle({ id, ...req } as RpcRequest)
    if (!resp.ok) {
      throw new Error(`${resp.error.code}: ${resp.error.message}`)
    }
    return resp.result
  }
  return { runtime, rpc }
}

/**
 * Duplex in-process "worker" so the real WorkerWorkbookClient + backend
 * stack runs against the TS runtime without spawning a Worker.
 */
function createInProcessWorker(): WorkerLike {
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

describe('audit D-1 · P-A · FIXED (W2.4) · TS runtime clearRange walks existing cells only', () => {
  test('clearRange on an EMPTY sheet touches (and reports) zero cells', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })

    // 200 rows x 50 cols = 10_000 coordinates, ZERO existing cells.
    const t0 = now()
    const cleared = await rpc({
      cmd: 'clearRange',
      range: { sheet: 0, startRow: 0, startCol: 0, endRow: 199, endCol: 49 },
    })
    const elapsed = now() - t0

    // eslint-disable-next-line no-console
    console.log(
      `[audit D-1 FIXED] clearRange 200x50 on empty sheet: cleared=${String(cleared)} ` +
        `in ${elapsed.toFixed(1)} ms — O(existing), not O(area)`,
    )

    // FIXED shape: the engine walks the live cell map filtered by
    // bounds; an empty sheet means zero touches, matching the WASM
    // backend's sparse `clear_range` count semantics.
    expect(cleared).toBe(0)
  })

  test('full-column clearRange (rowEnd 1_048_575) on a 100-cell sheet touches only existing cells', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })

    // 100 real cells in column 0 + 5 cells in column 1 (must survive).
    const cells = []
    for (let row = 0; row < 100; row += 1) {
      cells.push({ sheet: 0, row, col: 0, kind: 'number', value: row })
    }
    for (let row = 0; row < 5; row += 1) {
      cells.push({ sheet: 0, row, col: 1, kind: 'number', value: row })
    }
    await rpc({ cmd: 'restoreSparse', cells })

    // Column-header selection shape: rowEnd = EXCEL_MAX_ROWS - 1
    // (selection/index.ts) forwarded verbatim by the worker backend.
    const t0 = now()
    const cleared = await rpc({
      cmd: 'clearRange',
      range: { sheet: 0, startRow: 0, startCol: 0, endRow: 1_048_575, endCol: 0 },
    })
    const elapsed = now() - t0

    // eslint-disable-next-line no-console
    console.log(
      `[audit D-1 FIXED] full-column clearRange @100 cells: cleared=${String(cleared)} ` +
        `in ${elapsed.toFixed(1)} ms (was ~1M engine calls / ≳1.2 s on an EMPTY sheet)`,
    )

    expect(cleared).toBe(100)
    expect(elapsed).toBeLessThan(50)

    // Column 1 cells are untouched.
    const survivors = (await rpc({
      cmd: 'readCells',
      cells: [{ sheet: 0, addr: 'B1' }, { sheet: 0, addr: 'B5' }],
    })) as Array<{ display: string }>
    expect(survivors.map((c) => c.display)).toEqual(['0', '4'])
  })

  test('spill-region clear matches W1.1 semantics — target-only skip, anchor teardown', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
    await rpc({ cmd: 'setFormulaDetailed', sheet: 0, addr: 'A1', formula: '=SEQUENCE(3, 2)' })

    const readSpill = async () =>
      ((await rpc({
        cmd: 'readCells',
        cells: [
          { sheet: 0, addr: 'A1' },
          { sheet: 0, addr: 'B2' },
          { sheet: 0, addr: 'A3' },
          { sheet: 0, addr: 'B3' },
        ],
      })) as Array<{ display: string }>).map((c) => c.display)
    expect(await readSpill()).toEqual(['1', '4', '5', '6'])

    // Clear rows 2-3 only (spill TARGETS, not the anchor). Targets are
    // virtual projections — no map entry — so the clear touches nothing
    // and the anchor keeps spilling (W1.1 target-only skip).
    const clearedTargets = await rpc({
      cmd: 'clearRange',
      range: { sheet: 0, startRow: 1, startCol: 0, endRow: 2, endCol: 1 },
    })
    expect(clearedTargets).toBe(0)
    expect(await readSpill()).toEqual(['1', '4', '5', '6'])

    // Clear a range covering the ANCHOR: the formula cell is deleted
    // (dep teardown + derive eviction) and the whole spill collapses
    // (W1.1 anchor teardown).
    const clearedAnchor = await rpc({
      cmd: 'clearRange',
      range: { sheet: 0, startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
    })
    expect(clearedAnchor).toBe(1)
    expect(await readSpill()).toEqual(['', '', '', ''])
  })
})

describe('audit D-5 · P-D · FIXED — TS runtime sheet ops drop index-keyed host state', () => {
  test('debugFormulaCacheState reports dirty for a never-read formula after removeSheet shifts indices', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['S1', 'S2', 'S3', 'S4'] })

    // Formula on S3 (idx 2), host-reads it → readFormulaCells gains '2:0:0'.
    await rpc({ cmd: 'setFormulaDetailed', sheet: 2, addr: 'A1', formula: '=1+1' })
    await rpc({ cmd: 'readCells', cells: [{ sheet: 2, addr: 'A1' }] })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 2, addr: 'A1' })).toBe('clean')

    // Formula on S4 (idx 3), never host-read → must be 'dirty'.
    await rpc({ cmd: 'setFormulaDetailed', sheet: 3, addr: 'A1', formula: '=2+2' })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 3, addr: 'A1' })).toBe('dirty')

    // Remove S1 (idx 0): S3 → idx 1, S4 → idx 2. Pre-fix, the stale
    // '2:0:0' entry matched S4!A1 and the probe lied 'clean'.
    await rpc({ cmd: 'removeSheet', sheet: 0 })
    const probed = await rpc({ cmd: 'debugFormulaCacheState', sheet: 2, addr: 'A1' })

    // FLIPPED PIN (was: 'clean', the inherited stale entry):
    // `rebuildPreservingCells` now resets `readFormulaCells` on every
    // sheet op, so the host-read probe is honest again.
    expect(probed).toBe('dirty')

    // The shifted S3 (now idx 1) lost its 'clean' too — the rebuild
    // dropped every cached value — and re-reading restores it.
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 1, addr: 'A1' })).toBe('dirty')
    await rpc({ cmd: 'readCells', cells: [{ sheet: 1, addr: 'A1' }] })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 1, addr: 'A1' })).toBe('clean')
  })

  test('in-flight import + snapshot sessions are invalidated by a structural sheet op', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['S1', 'S2'] })
    await rpc({
      cmd: 'restoreSparse',
      cells: [{ sheet: 1, row: 0, col: 0, kind: 'number', value: 7 }],
    })

    // Open one import session and one chunked snapshot session, both
    // referencing sheet indices that are about to shift.
    const importSession = (await rpc({ cmd: 'beginImport', mode: 'direct' })) as number
    await rpc({
      cmd: 'importChunk',
      sessionId: importSession,
      cells: [{ sheet: 1, row: 1, col: 0, kind: 'number', value: 8 }],
    })
    const snapshotSession = (await rpc({
      cmd: 'beginSnapshotRangeSparse',
      range: { sheet: 1, startRow: 0, startCol: 0, endRow: 10, endCol: 0 },
      rowsPerChunk: 4,
    })) as { sessionId: number }

    // Structural op: removing S1 shifts S2 from idx 1 to idx 0. The
    // staged wires / chunk cursors carry pre-op indices — committing or
    // continuing them would target the wrong sheet.
    await rpc({ cmd: 'removeSheet', sheet: 0 })

    // FIXED (D-5): both sessions were dropped by the sheet op; the next
    // session RPC fails loudly instead of landing on the wrong sheet.
    await expect(
      rpc({ cmd: 'commitImport', sessionId: importSession }),
    ).rejects.toThrow('INVALID_IMPORT_SESSION')
    await expect(
      rpc({ cmd: 'nextSnapshotRangeSparseChunk', sessionId: snapshotSession.sessionId }),
    ).rejects.toThrow('SNAPSHOT_SESSION_MISSING')
  })
})

describe('audit D-4 · P-D · FIXED — worker backend deleteSheet drops per-sheet host overlays', () => {
  test('a new sheet reusing the deleted sheet id starts clean (no inherited overlays)', async () => {
    const backend = createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => createInProcessWorker(),
      sheets: ['One', 'Two'],
    })
    await backend.ready()

    // Stamp every per-sheet overlay table the backend keeps for sheet-2:
    // validation, conditional format, filter/sort, and a sheet-scoped name.
    await backend.setValidationRule?.({
      kind: 'set-validation-rule',
      sheetId: 'sheet-2',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      rule: { kind: 'list', values: ['North', 'South'], dropdown: true },
      mode: 'warn',
    })
    await backend.setConditionalFormatRule?.({
      kind: 'set-conditional-format-rule',
      sheetId: 'sheet-2',
      scope: { range: { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 0 } },
      rule: { kind: 'cell-value', operator: 'gt', value: '0', format: { bgColor: '#ff0000' } },
    })
    await backend.setFilterSort?.({
      kind: 'set-filter-sort',
      sheetId: 'sheet-2',
      rules: [],
      directives: [{ colIndex: 0, direction: 'asc' }],
    })
    await backend.setNamedRange?.({
      kind: 'set-named-range',
      name: 'DEAD_SHEET_NAME',
      scope: { sheetId: 'sheet-2' },
      refersTo: { kind: 'range', sheetId: 'sheet-2', address: 'A1' },
    })

    await backend.deleteSheet?.({ kind: 'delete-sheet', sheetId: 'sheet-2', requestId: 1 })
    const added = await backend.addSheet?.({ kind: 'add-sheet', name: 'Fresh', requestId: 2 })

    // Sheet ids ARE reused after deletion (syncSheetLookup assigns
    // `sheet-${idx+1}`), which is what turned the stale map entries into
    // a user-visible defect rather than a plain leak.
    expect(added?.createdSheet?.id).toBe('sheet-2')

    const projection = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-2',
        requestId: 3,
        window: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )

    // FLIPPED PIN (was: `true` — the new empty sheet projected the dead
    // sheet's validation overlay). deleteSheet now routes through
    // `dropSheetOverlayState`, clearing validationRulesBySheetId,
    // conditionalFormatRulesBySheetId, filterSortBySheetId, the D-7
    // displayRows cache, and sheet-scoped namedRanges.
    expect(projection.cells.some((cell) => cell.validation)).toBe(false)
    expect(projection.cells.some((cell) => cell.conditionalFormat)).toBe(false)

    const conditionalRules = await backend.listConditionalFormatRules?.({
      kind: 'list-conditional-format-rules',
      sheetId: 'sheet-2',
      requestId: 4,
    })
    expect(conditionalRules?.rules).toEqual([])

    const names = await backend.listNamedRanges?.({ kind: 'list-named-ranges', requestId: 5 })
    expect(names?.names.some((entry) => entry.name === 'DEAD_SHEET_NAME')).toBe(false)

    backend.dispose()
  })
})

describe('audit D-7 · P-A · FIXED — filter/sort wide scan runs once per mutation, not per viewport refresh', () => {
  test('repeat reads hit the displayRows cache and request a content-bounded row band', async () => {
    const client = createWorkerWorkbook({ workerFactory: () => createInProcessWorker() })
    const readRanges: SparseRangeWire[] = []
    const spyClient: typeof client = {
      ...client,
      readSparseRange(range) {
        readRanges.push(range)
        return client.readSparseRange(range)
      },
    }
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client: spyClient,
      sheets: ['One'],
    })
    await backend.ready()

    // 31 data rows (descending values so the asc sort actually permutes).
    await backend.importCells?.({
      kind: 'import-cells',
      sheetId: 'sheet-1',
      cells: new Array(31).fill(null).map((_, row) => ({
        row,
        col: 0,
        input: String(100 - row),
      })),
      range: { rowStart: 0, rowEnd: 30, colStart: 0, colEnd: 0 },
    })

    const window = { rowStart: 0, rowEnd: 20, colStart: 0, colEnd: 5 }
    await backend.readVisibleProjection(
      createVisibleProjectionRequest({ sheetId: 'sheet-1', requestId: 1, window }),
    )
    const plainRead = readRanges.at(-1)
    expect(plainRead?.endRow).toBe(20)

    await backend.setFilterSort?.({
      kind: 'set-filter-sort',
      sheetId: 'sheet-1',
      rules: [],
      directives: [{ colIndex: 0, direction: 'asc' }],
      requestId: 2,
    })

    // First read after the spec change: the wide scan is legitimate —
    // the permutation needs every candidate row exactly once.
    const t0 = now()
    await backend.readVisibleProjection(
      createVisibleProjectionRequest({ sheetId: 'sheet-1', requestId: 3, window }),
    )
    const buildMs = now() - t0
    const buildRead = readRanges.at(-1)
    expect(buildRead?.endRow).toBe(1_048_575)

    // Repeat refresh (scroll tick / re-render): FLIPPED PIN — was
    // endRow=1_048_575 on EVERY read; now the cached permutation bounds
    // the read to the source rows that project into the window (within
    // existing content, ≤ row 30 here).
    const t1 = now()
    const refreshed = await backend.readVisibleProjection(
      createVisibleProjectionRequest({ sheetId: 'sheet-1', requestId: 4, window }),
    )
    const refreshMs = now() - t1
    const cachedRead = readRanges.at(-1)

    // eslint-disable-next-line no-console
    console.log(
      `[audit D-7 FIXED] filter/sort reads: build endRow=${String(buildRead?.endRow)} ` +
        `(${buildMs.toFixed(1)} ms) vs cached-refresh endRow=${String(cachedRead?.endRow)} ` +
        `(${refreshMs.toFixed(1)} ms)`,
    )

    expect(cachedRead?.endRow).toBeLessThanOrEqual(30)
    // The cached projection still shows the sorted ordering (ascending
    // values 70..90 in window rows 1..20; header row 0 keeps value 100).
    const row1 = refreshed.cells.find((cell) => cell.row === 1 && cell.col === 0)
    expect(row1?.displayValue).toBe('70')

    // A mutation invalidates the permutation: exactly ONE more wide scan,
    // then refreshes are bounded again.
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 40,
      col: 0,
      input: '1',
      requestId: 5,
    })
    await backend.readVisibleProjection(
      createVisibleProjectionRequest({ sheetId: 'sheet-1', requestId: 6, window }),
    )
    expect(readRanges.at(-1)?.endRow).toBe(1_048_575)
    await backend.readVisibleProjection(
      createVisibleProjectionRequest({ sheetId: 'sheet-1', requestId: 7, window }),
    )
    expect(readRanges.at(-1)?.endRow).toBeLessThanOrEqual(40)

    backend.dispose()
  })
})

describe('audit D-8 · P-A · FIXED — TS runtime range readers are O(window ∩ existing), not O(sheet)', () => {
  test('viewport-window reads on a 100k-cell sheet probe the window instead of walking the map', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })

    // 100_000 cells: rows 0..9_999 × cols 0..9.
    const cells = []
    for (let row = 0; row < 10_000; row += 1) {
      for (let col = 0; col < 10; col += 1) {
        cells.push({ sheet: 0, row, col, kind: 'number', value: row * 10 + col })
      }
    }
    await rpc({ cmd: 'restoreSparse', cells })

    // Warm-up + correctness: a 21×6 window returns exactly window ∩ existing.
    const window = { sheet: 0, startRow: 5_000, startCol: 2, endRow: 5_020, endCol: 7 }
    const first = (await rpc({ cmd: 'readSparseRange', range: window })) as Array<{
      addr: string
    }>
    expect(first).toHaveLength(21 * 6)

    const reads = 100
    const t0 = now()
    for (let i = 0; i < reads; i += 1) {
      await rpc({ cmd: 'readSparseRange', range: window })
      await rpc({ cmd: 'snapshotRangeSparse', range: window })
    }
    const elapsed = now() - t0

    // eslint-disable-next-line no-console
    console.log(
      `[audit D-8 FIXED] ${reads} x (readSparseRange + snapshotRangeSparse) 21x6 window ` +
        `@100k cells: ${elapsed.toFixed(1)} ms total (${(elapsed / reads).toFixed(2)} ms/read pair) ` +
        '— was a full 100k-entry map walk (plus a second spill pass) per read',
    )

    // Deliberately loose for slow hardware; the pre-fix full-map walk
    // (200 passes × 100k entries × key parsing) sits well above this.
    expect(elapsed).toBeLessThan(1_000)

    // Out-of-content windows cost nothing and return nothing.
    const empty = (await rpc({
      cmd: 'readSparseRange',
      range: { sheet: 0, startRow: 900_000, startCol: 0, endRow: 900_020, endCol: 5 },
    })) as unknown[]
    expect(empty).toHaveLength(0)
  })

  test('spill projection still surfaces through bounded window reads', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
    await rpc({ cmd: 'setFormulaDetailed', sheet: 0, addr: 'A1', formula: '=SEQUENCE(3, 2)' })
    // Cache the anchor (spill targets only project from 'clean' anchors).
    await rpc({ cmd: 'readCells', cells: [{ sheet: 0, addr: 'A1' }] })

    const snapshots = (await rpc({
      cmd: 'readSparseRange',
      range: { sheet: 0, startRow: 1, startCol: 0, endRow: 2, endCol: 1 },
    })) as Array<{ addr: string; display: string }>
    expect(snapshots.map((cell) => [cell.addr, cell.display])).toEqual([
      ['A2', '3'],
      ['B2', '4'],
      ['A3', '5'],
      ['B3', '6'],
    ])
  })
})

describe('audit D-10 · P-B · FIXED — removeRows batches contiguous rows into one deleteRows RPC per band', () => {
  test('scattered + clustered rows collapse to one RPC per contiguous band, descending', async () => {
    const client = createWorkerWorkbook({ workerFactory: () => createInProcessWorker() })
    const deleteCalls: Array<{ rowIndex: number; count: number }> = []
    const spyClient: typeof client = {
      ...client,
      deleteRows(sheet, rowIndex, count) {
        deleteCalls.push({ rowIndex, count })
        return client.deleteRows(sheet, rowIndex, count)
      },
    }
    const backend = createWorkerWorkbookSpreadsheetBackend({
      client: spyClient,
      sheets: ['One'],
    })
    await backend.ready()

    const result = await backend.removeRows?.({
      kind: 'remove-rows',
      sheetId: 'sheet-1',
      rows: [3, 4, 5, 1, 9, 8, 12, 4], // duplicates + unsorted + two clusters
    })

    // FLIPPED PIN (was: one single-row RPC per row — 7 calls here). The
    // descending row list groups into contiguous bands: [12], [8..9],
    // [3..5], [1] — four RPCs, each a (start, count) band.
    expect(deleteCalls).toEqual([
      { rowIndex: 12, count: 1 },
      { rowIndex: 8, count: 2 },
      { rowIndex: 3, count: 3 },
      { rowIndex: 1, count: 1 },
    ])
    expect(result?.removedRows).toBe(7)
    expect(result?.affectedRange).toEqual({
      startRow: 1,
      endRow: 12,
      startCol: 0,
      endCol: Number.MAX_SAFE_INTEGER,
    })

    backend.dispose()
  })
})

describe('audit C-8 · wire-type · FIXED — bulk import preserves wire typing end to end', () => {
  test("text wires that LOOK numeric/boolean/formula/error stay text through the bulk path", async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })

    const sessionId = (await rpc({ cmd: 'beginImport', mode: 'atomic' })) as number
    await rpc({
      cmd: 'importChunk',
      sessionId,
      cells: [
        { sheet: 0, row: 0, col: 0, kind: 'text', value: '00123' },
        { sheet: 0, row: 0, col: 1, kind: 'text', value: 'TRUE' },
        { sheet: 0, row: 0, col: 2, kind: 'text', value: '=A1' },
        { sheet: 0, row: 0, col: 3, kind: 'text', value: '#N/A' },
        { sheet: 0, row: 0, col: 4, kind: 'number', value: 42 },
      ],
    })
    await rpc({ cmd: 'commitImport', sessionId })

    const readRow = async () =>
      (await rpc({
        cmd: 'readCells',
        cells: ['A1', 'B1', 'C1', 'D1', 'E1'].map((addr) => ({ sheet: 0, addr })),
      })) as Array<{ display: string; type: string; formula: string; isError: boolean }>

    // FLIPPED PIN (was: importCells routed every wire through input
    // strings, so parseLiteral re-classified text '00123' → number 123,
    // 'TRUE' → boolean, '#N/A' → error). The bulk path now forwards
    // typed entries (`BulkTypedCellInput`) — identical typing to the
    // single-cell `setCell` wire path.
    const cells = await readRow()
    expect(cells.map((cell) => [cell.display, cell.type])).toEqual([
      ['00123', 'text'],
      ['TRUE', 'text'],
      ['=A1', 'text'],
      ['#N/A', 'text'],
      ['42', 'number'],
    ])
    expect(cells[2].formula).toBe('')
    expect(cells[3].isError).toBe(false)

    // Sheet ops rebuild the workbook from the live cell maps — the
    // rebuild must also carry TYPED literals (not input strings), or a
    // simple addSheet would re-introduce the C-8 corruption.
    await rpc({ cmd: 'addSheet', name: 'Sheet2' })
    expect((await readRow()).map((cell) => [cell.display, cell.type])).toEqual([
      ['00123', 'text'],
      ['TRUE', 'text'],
      ['=A1', 'text'],
      ['#N/A', 'text'],
      ['42', 'number'],
    ])
  })
})

describe('audit D-2 · P-A · static backend deep-clones the whole workbook per undoable mutation', () => {
  function seededBackend(cellCount: number) {
    const cells = new Array(cellCount).fill(null).map((_, i) => ({
      row: Math.floor(i / 10),
      col: i % 10,
      displayValue: String(i),
      valueKind: 'number' as const,
    }))
    return createStaticSpreadsheetBackend({ revision: 1, cells })
  }

  async function timeEdits(backend: ReturnType<typeof seededBackend>, edits: number) {
    const t0 = now()
    for (let i = 0; i < edits; i += 1) {
      await backend.setCellInput({
        kind: 'set-cell-input',
        sheetId: 'sheet-1',
        row: 0,
        col: 0,
        input: `edit-${i}`,
        requestId: i,
      })
    }
    return now() - t0
  }

  test('single-cell setCellInput cost scales with TOTAL workbook size (snapshot per keystroke)', async () => {
    const edits = 20
    const small = seededBackend(50)
    const large = seededBackend(20_000)

    const smallMs = await timeEdits(small, edits)
    const largeMs = await timeEdits(large, edits)

    // eslint-disable-next-line no-console
    console.log(
      `[audit D-2] ${edits} x setCellInput: 50-cell book ${smallMs.toFixed(1)} ms ` +
        `vs 20k-cell book ${largeMs.toFixed(1)} ms (ratio ${(largeMs / Math.max(smallMs, 0.01)).toFixed(1)}x) ` +
        '— beginUndoableMutation clones every cell of every sheet, cap 200 snapshots',
    )

    // Deliberately loose: editing one cell in a 20k-cell book must not be
    // FASTER than in a 50-cell book if each edit deep-clones the state;
    // the logged ratio is the real finding (≈ O(workbook) per keystroke).
    expect(largeMs).toBeGreaterThanOrEqual(smallMs)
  })
})
