/**
 * AUDIT MEASUREMENT / REPRO PINS — mutation-path pattern-family audit
 * (2026-06-12, section D of
 * excel/rust/excel-core/docs/AUDIT_PATTERN_FAMILY_2026-06-12.md).
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
 *  - D-5  P-D  **FIXED** worker-runtime-ts sheet ops discard import and
 *         snapshot sessions whose indices may shift. Formula-cache probes
 *         delegate to the Workbook's atomm-derived state, so they carry no
 *         index-keyed worker cache across a structural operation.
 *  - D-4  P-D  **FIXED** worker-workbook-backend deleteSheet drops every
 *         per-sheet host overlay (`dropSheetOverlayState`) — a reused
 *         sheet id starts clean.
 *  - D-7  P-A  **FIXED** worker-workbook-backend omits the unsupported
 *         filter/sort port. Canonical viewport reads stay window-bounded;
 *         no host display-row state, wide scan, or fake revision exists.
 *  - D-8  P-A  **FIXED** worker-runtime-ts range readers enumerate
 *         window ∩ existing via `collectCellsInBounds` (coordinate probe
 *         for viewport windows, sparse map walk for huge ranges).
 *  - D-9  P-A  **FIXED** upstream writes rederive the materialized
 *         Workbook formula atoms on their owning sheet. The worker keeps no
 *         host-read invalidation map or cross-sheet dirty-state simulation.
 *  - D-10 P-B  **FIXED** worker-workbook-backend removeRows groups the
 *         descending row list into contiguous bands — one deleteRows RPC
 *         per band instead of per row.
 *  - C-8  wire **FIXED** bulk import forwards typed `BulkTypedCellInput`
 *         entries — text that looks numeric/boolean/error survives the
 *         bulk path (no parseLiteral re-classification).
 *  - D-2  P-A  FIXED — static-backend history records per-mutation
 *         reverse deltas (before-values of touched entries only); the
 *         pin below now asserts O(change), not O(workbook).
 *  - D-11 P-A  **FIXED** worker-workbook-backend conditional-format
 *         overlay sorts rules once per application (first half) AND
 *         pre-filters the sorted list to rules whose scope intersects
 *         the window's source-coordinate band (second half) — rules
 *         scoped entirely outside the viewport cost zero per-cell work.
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
import { applyConditionalFormatOverlay } from '../src-vnext/adapter/worker-workbook-backend'
import type { SparseRangeWire, WorkerLike } from '../src-vnext/adapter'
import type {
  CellRange,
  ConditionalFormatRuleEntry,
  DisplayCell,
} from '@einfach/spreadsheet-ui-core'

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
      cells: [
        { sheet: 0, addr: 'B1' },
        { sheet: 0, addr: 'B5' },
      ],
    })) as Array<{ display: string }>
    expect(survivors.map((c) => c.display)).toEqual(['0', '4'])
  })

  test('spill-region clear matches W1.1 semantics — target-only skip, anchor teardown', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })
    await rpc({ cmd: 'setFormulaDetailed', sheet: 0, addr: 'A1', formula: '=SEQUENCE(3, 2)' })

    const readSpill = async () =>
      (
        (await rpc({
          cmd: 'readCells',
          cells: [
            { sheet: 0, addr: 'A1' },
            { sheet: 0, addr: 'B2' },
            { sheet: 0, addr: 'A3' },
            { sheet: 0, addr: 'B3' },
          ],
        })) as Array<{ display: string }>
      ).map((c) => c.display)
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

describe('audit D-5 · P-D · FIXED — structural sheet ops keep probes bound to Workbook state', () => {
  test('debugFormulaCacheState follows the shifted Workbook sheet after removeSheet', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['S1', 'S2', 'S3', 'S4'] })

    // Formula writes run the Workbook's cycle check, materializing the
    // formula atoms. The direct probe therefore reports Store state rather
    // than a worker-local host-read record.
    await rpc({ cmd: 'setFormulaDetailed', sheet: 2, addr: 'A1', formula: '=1+1' })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 2, addr: 'A1' })).toBe('clean')

    await rpc({ cmd: 'setFormulaDetailed', sheet: 3, addr: 'A1', formula: '=2+2' })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 3, addr: 'A1' })).toBe('clean')

    // Remove S1 (idx 0): S3 -> idx 1, S4 -> idx 2. Rebuilding the Workbook
    // recreates lazy formula atoms, so the direct probe reports their actual
    // unmaterialized state; no index-keyed worker state is available to leak.
    await rpc({ cmd: 'removeSheet', sheet: 0 })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 2, addr: 'A1' })).toBe('dirty')
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 1, addr: 'A1' })).toBe('dirty')
    expect(
      await rpc({
        cmd: 'readCells',
        cells: [
          { sheet: 1, addr: 'A1' },
          { sheet: 2, addr: 'A1' },
        ],
      }),
    ).toEqual([
      expect.objectContaining({ display: '2' }),
      expect.objectContaining({ display: '4' }),
    ])
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 1, addr: 'A1' })).toBe('clean')
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 2, addr: 'A1' })).toBe('clean')
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
    await expect(rpc({ cmd: 'commitImport', sessionId: importSession })).rejects.toThrow(
      'INVALID_IMPORT_SESSION',
    )
    await expect(
      rpc({ cmd: 'nextSnapshotRangeSparseChunk', sessionId: snapshotSession.sessionId }),
    ).rejects.toThrow('SNAPSHOT_SESSION_MISSING')
  })
})

describe('audit D-9 · P-A · FIXED — atomm derivation stays scoped to the owning sheet', () => {
  test('an upstream write rederives its sheet without evaluating an unrelated sheet', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['S1', 'S2'] })

    await rpc({ cmd: 'setCell', sheet: 0, addr: 'B1', value: { type: 'number', value: 1 } })
    await rpc({ cmd: 'setCell', sheet: 1, addr: 'B1', value: { type: 'number', value: 2 } })
    await rpc({ cmd: 'setFormulaDetailed', sheet: 0, addr: 'A1', formula: '=B1' })
    await rpc({ cmd: 'setFormulaDetailed', sheet: 1, addr: 'A1', formula: '=B1' })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 0, addr: 'A1' })).toBe('clean')
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 1, addr: 'A1' })).toBe('clean')
    expect(await rpc({ cmd: 'debugFormulaEvalCount', sheet: 0 })).toBe(1)
    expect(await rpc({ cmd: 'debugFormulaEvalCount', sheet: 1 })).toBe(1)

    // One upstream write on S1 synchronously rederives S1!A1. S2's atom is
    // untouched: no worker-side Map is consulted or invalidated.
    await rpc({ cmd: 'setCell', sheet: 0, addr: 'B1', value: { type: 'number', value: 5 } })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 0, addr: 'A1' })).toBe('clean')
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 1, addr: 'A1' })).toBe('clean')
    expect(await rpc({ cmd: 'debugFormulaEvalCount', sheet: 0 })).toBe(2)
    expect(await rpc({ cmd: 'debugFormulaEvalCount', sheet: 1 })).toBe(1)
    expect(
      await rpc({
        cmd: 'readCells',
        cells: [
          { sheet: 0, addr: 'A1' },
          { sheet: 1, addr: 'A1' },
        ],
      }),
    ).toEqual([
      expect.objectContaining({ display: '5' }),
      expect.objectContaining({ display: '2' }),
    ])
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
    // validation, conditional format, and a sheet-scoped name.
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
    // conditionalFormatRulesBySheetId, and sheet-scoped namedRanges.
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

describe('audit D-7 · P-A · SUPERSEDED by E5 — the filter predicate is engine-owned; the TS runtime fail-closes filter', () => {
  // Was: parity #29 / #27 S5 landed `setFilterSort` as a BOUNDED ADAPTER SCAN
  // (one single-column predicate read per predicate column) that withheld rows.
  // E5 (design-engine-hidden-rows) sinks the predicate itself into the engine:
  // the adapter no longer scans — it forwards the rules to `applyFilter` and
  // reflects the returned rows. The TS worker runtime has no such engine, so it
  // declares `engineHiddenState: false` and the adapter WITHHOLDS the
  // `setFilterSort` port entirely (fail-closed), rather than faking a scan the
  // TS core cannot do. The projection therefore stays canonical here — this is
  // the honest post-E5 state of what used to be a bounded-scan finding.
  test('withholds setFilterSort on the TS runtime and leaves the projection canonical', async () => {
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
      revision: 11,
    })
    await backend.ready()

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
    const before = await backend.readVisibleProjection(
      createVisibleProjectionRequest({ sheetId: 'sheet-1', requestId: 1, window }),
    )
    expect(before.cells.find((cell) => cell.row === 1 && cell.col === 0)?.displayValue).toBe('99')

    // Fail-closed: the `engineHiddenState: false` witness withholds the port, so
    // UI-core hides the filter entry. Never a fake ACK, never an adapter scan.
    expect(backend.setFilterSort).toBeUndefined()
    expect(backend.readSheetHiddenState).toBeUndefined()

    // No filter can be applied, so the projection is unchanged: source row 1
    // still reads 99, and only the single window read was issued (no predicate
    // scan — the finding this block used to audit no longer exists in the
    // adapter at all).
    const after = await backend.readVisibleProjection(
      createVisibleProjectionRequest({ sheetId: 'sheet-1', requestId: 3, window }),
    )
    expect(after.cells.find((cell) => cell.row === 1 && cell.col === 0)?.displayValue).toBe('99')
    expect(readRanges).toEqual([
      { sheet: 0, startRow: 0, endRow: 20, startCol: 0, endCol: 5 },
      { sheet: 0, startRow: 0, endRow: 20, startCol: 0, endCol: 5 },
    ])

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
    // Fail-closed follow-up (#31): the real TS runtime now declares
    // `structuralEdits: false` and answers deleteRows with a structured
    // UNSUPPORTED error, so this ADAPTER band-batching pin stands in a
    // structural-capable engine: a no-claims witness plus a genuine ACK.
    const spyClient: typeof client = {
      ...client,
      async describeCapabilities() {
        return null
      },
      deleteRows(sheet, rowIndex, count) {
        deleteCalls.push({ rowIndex, count })
        return Promise.resolve(true)
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
  test('text wires that LOOK numeric/boolean/formula/error stay text through the bulk path', async () => {
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

describe('audit D-2 · P-A · FIXED — static backend history is reverse deltas, not workbook clones', () => {
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

  test('single-cell setCellInput cost is O(change), not O(workbook) (reverse-delta history)', async () => {
    const edits = 20
    const small = seededBackend(50)
    const large = seededBackend(20_000)

    const smallMs = await timeEdits(small, edits)
    const largeMs = await timeEdits(large, edits)

    // eslint-disable-next-line no-console
    console.log(
      `[audit D-2 FIXED] ${edits} x setCellInput: 50-cell book ${smallMs.toFixed(1)} ms ` +
        `vs 20k-cell book ${largeMs.toFixed(1)} ms (ratio ${(largeMs / Math.max(smallMs, 0.01)).toFixed(1)}x) ` +
        '— was 0.5 ms vs 57.3 ms (108x) when beginUndoableMutation deep-cloned the workbook',
    )

    // FLIPPED PIN (was: largeMs >= smallMs, pinning the O(workbook)
    // clone). History entries are now per-mutation reverse deltas — a
    // single-cell edit records one before-value regardless of workbook
    // size, so 20 edits at 20k cells must stay within ~2x of 50 cells
    // (5 ms absolute floor absorbs sub-ms timer jitter).
    expect(largeMs).toBeLessThan(Math.max(smallMs * 2, 5))
  })
})

describe('audit D-11 · P-A · FIXED — conditional-format rules are pre-filtered by window bounds', () => {
  async function seededBackend(
    rules: ReadonlyArray<{
      priority: number
      range: CellRange
      bgColor: string
      gt: string
    }>,
  ) {
    const backend = createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => createInProcessWorker(),
      sheets: ['One'],
    })
    await backend.ready()
    await backend.importCells?.({
      kind: 'import-cells',
      sheetId: 'sheet-1',
      cells: new Array(5).fill(null).map((_, row) => ({ row, col: 0, input: String(row + 1) })),
      range: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 0 },
    })
    for (const rule of rules) {
      await backend.setConditionalFormatRule?.({
        kind: 'set-conditional-format-rule',
        sheetId: 'sheet-1',
        scope: { range: rule.range },
        priority: rule.priority,
        rule: {
          kind: 'cell-value',
          operator: 'gt',
          value: rule.gt,
          format: { bgColor: rule.bgColor },
        },
      })
    }
    return backend
  }

  test('out-of-window rules leave the overlay output byte-identical (precedence preserved)', async () => {
    const window = { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 3 }
    // Two in-window rules with OVERLAPPING scopes — priority 1 (gt '2',
    // red) must keep beating priority 3 (gt '0', green) for rows 2..4.
    const inWindowRules = [
      {
        priority: 1,
        range: { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 0 },
        bgColor: '#f00',
        gt: '2',
      },
      {
        priority: 3,
        range: { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 0 },
        bgColor: '#0f0',
        gt: '0',
      },
    ]
    // Rules scoped entirely outside the window's row band / column band,
    // bracketing the in-window rules in priority order.
    const outOfWindowRules = [
      {
        priority: 0,
        range: { rowStart: 500_000, rowEnd: 500_009, colStart: 0, colEnd: 3 },
        bgColor: '#00f',
        gt: '0',
      },
      {
        priority: 2,
        range: { rowStart: 0, rowEnd: 9, colStart: 100, colEnd: 110 },
        bgColor: '#ff0',
        gt: '0',
      },
    ]

    const noisy = await seededBackend([...outOfWindowRules, ...inWindowRules])
    const clean = await seededBackend(inWindowRules)

    const readWindow = async (backend: Awaited<ReturnType<typeof seededBackend>>) =>
      (
        await backend.readVisibleProjection(
          createVisibleProjectionRequest({ sheetId: 'sheet-1', requestId: 1, window }),
        )
      ).cells

    const noisyCells = await readWindow(noisy)
    const cleanCells = await readWindow(clean)

    // The pre-filter is a pure superset test: with the out-of-window
    // rules present the projection must be IDENTICAL to the run that
    // never registered them.
    expect(noisyCells).toEqual(cleanCells)

    // Precedence sanity inside the window: value 3 (row 2) matches both
    // surviving rules — priority 1 wins; value 1 (row 0) only matches
    // priority 3.
    const byRow = new Map(noisyCells.map((cell) => [cell.row, cell]))
    expect(byRow.get(2)?.conditionalFormat).toMatchObject({ bgColor: '#f00' })
    expect(byRow.get(0)?.conditionalFormat).toMatchObject({ bgColor: '#0f0' })

    noisy.dispose()
    clean.dispose()
  })

  test('whole-column rule survives the pre-filter for any window in its column band', async () => {
    const backend = createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => createInProcessWorker(),
      sheets: ['One'],
    })
    await backend.ready()
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: 'sheet-1',
      row: 5_000,
      col: 0,
      input: '7',
      requestId: 1,
    })
    // Unbounded row scope (whole column A) — must intersect ANY window
    // in that column band, including one 5k rows down.
    await backend.setConditionalFormatRule?.({
      kind: 'set-conditional-format-rule',
      sheetId: 'sheet-1',
      scope: { range: { rowStart: 0, rowEnd: 1_048_575, colStart: 0, colEnd: 0 } },
      priority: 0,
      rule: { kind: 'cell-value', operator: 'gt', value: '0', format: { bgColor: '#f00' } },
    })
    // Bounded rule far above the window — must be filtered out without
    // bleeding into the projected cell.
    await backend.setConditionalFormatRule?.({
      kind: 'set-conditional-format-rule',
      sheetId: 'sheet-1',
      scope: { range: { rowStart: 0, rowEnd: 10, colStart: 0, colEnd: 0 } },
      priority: 1,
      rule: { kind: 'cell-value', operator: 'gt', value: '0', format: { bgColor: '#00f' } },
    })

    const projection = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 2,
        window: { rowStart: 4_995, rowEnd: 5_005, colStart: 0, colEnd: 2 },
      }),
    )
    const cell = projection.cells.find((entry) => entry.row === 5_000 && entry.col === 0)
    expect(cell?.displayValue).toBe('7')
    expect(cell?.conditionalFormat).toMatchObject({ bgColor: '#f00' })

    backend.dispose()
  })

  test('out-of-window rules never enter the per-cell loop (scope-range read counter)', () => {
    const countingRange = (range: CellRange): { range: CellRange; counter: { reads: number } } => {
      const counter = { reads: 0 }
      const proxied = new Proxy(range, {
        get(target, prop, receiver) {
          if (
            prop === 'rowStart' ||
            prop === 'rowEnd' ||
            prop === 'colStart' ||
            prop === 'colEnd'
          ) {
            counter.reads += 1
          }
          return Reflect.get(target, prop, receiver)
        },
      })
      return { range: proxied, counter }
    }

    const cellCount = 50
    const cells: DisplayCell[] = new Array(cellCount).fill(null).map((_, row) => ({
      row,
      col: 0,
      displayValue: '1',
      valueKind: 'number' as const,
    }))
    const window: CellRange = { rowStart: 0, rowEnd: cellCount - 1, colStart: 0, colEnd: 0 }

    const inWindow = countingRange({ rowStart: 0, rowEnd: cellCount - 1, colStart: 0, colEnd: 0 })
    const outOfWindow = countingRange({
      rowStart: 1_000,
      rowEnd: 1_010,
      colStart: 0,
      colEnd: 0,
    })
    const entries: ConditionalFormatRuleEntry[] = [
      {
        id: 'cf-out',
        scope: { range: outOfWindow.range },
        priority: 0,
        rule: { kind: 'cell-value', operator: 'gt', value: '0', format: { bgColor: '#00f' } },
      },
      {
        id: 'cf-in',
        scope: { range: inWindow.range },
        priority: 1,
        rule: { kind: 'cell-value', operator: 'gt', value: '0', format: { bgColor: '#f00' } },
      },
    ]

    const overlaid = applyConditionalFormatOverlay(cells, entries, window)
    expect(overlaid.every((cell) => cell.conditionalFormat?.bgColor === '#f00')).toBe(true)

    // eslint-disable-next-line no-console
    console.log(
      `[audit D-11 FIXED] scope-range coordinate reads over ${cellCount} cells: ` +
        `in-window rule=${inWindow.counter.reads}, out-of-window rule=${outOfWindow.counter.reads} ` +
        '— was ~4 reads PER CELL for every rule regardless of scope',
    )

    // FLIPPED PIN (was: the out-of-window rule paid isCoordInsideRange
    // for every projected cell — ≥ cellCount coordinate reads). The
    // pre-filter's single rangesIntersect test reads at most the four
    // coordinates once; the surviving in-window rule still pays the
    // per-cell membership test.
    expect(outOfWindow.counter.reads).toBeLessThanOrEqual(4)
    expect(inWindow.counter.reads).toBeGreaterThanOrEqual(cellCount)
  })
})
