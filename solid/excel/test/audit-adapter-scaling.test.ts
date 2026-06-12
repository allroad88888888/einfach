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
 *  - D-1  P-A  worker-runtime-ts clearRange iterates the dense rectangle
 *         (returns `cleared === area` on an EMPTY sheet; a full-column
 *         selection sends rowEnd = 1_048_575 through this loop).
 *  - D-5  P-D  worker-runtime-ts removeSheet leaves `readFormulaCells`
 *         keyed by the OLD sheet index → debugFormulaCacheState reports
 *         'clean' for a never-read formula on the sheet that shifted in.
 *  - D-4  P-D  worker-workbook-backend deleteSheet leaves the host-side
 *         per-sheet validation map; sheet ids are reused, so a NEW sheet
 *         inherits the deleted sheet's validation rules.
 *  - D-7  P-A  worker-workbook-backend reads rows 0..EXCEL_MAX while any
 *         filter/sort is active — every viewport refresh is O(sheet).
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

describe('audit D-1 · P-A · TS runtime clearRange iterates the dense rectangle', () => {
  test('clearRange on an EMPTY sheet still walks (and reports) every coordinate', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['Sheet1'] })

    // 200 rows x 50 cols = 10_000 coordinates, ZERO existing cells.
    const area = 200 * 50
    const t0 = now()
    const cleared = await rpc({
      cmd: 'clearRange',
      range: { sheet: 0, startRow: 0, startCol: 0, endRow: 199, endCol: 49 },
    })
    const elapsed = now() - t0

    // eslint-disable-next-line no-console
    console.log(
      `[audit D-1] clearRange 200x50 on empty sheet: cleared=${String(cleared)} ` +
        `(expected 0 touched cells) in ${elapsed.toFixed(1)} ms — O(area), not O(existing)`,
    )

    // PIN (buggy shape): the loop visits — and counts — every coordinate
    // in the rectangle even though the sheet is empty. A column selection
    // (rowEnd = 1_048_575, see selection/index.ts EXCEL_MAX_ROWS bounds)
    // routed through SpreadsheetBackend.clearRange would make this loop
    // run ~1M engine calls. Flip to `toBe(0)`-style accounting once the
    // implementation walks the sparse cell map instead.
    expect(cleared).toBe(area)
  })
})

describe('audit D-5 · P-D · TS runtime sheet removal leaves index-keyed read tracking', () => {
  test('debugFormulaCacheState reports clean for a never-read formula after removeSheet shifts indices', async () => {
    const { rpc } = makeRpc()
    await rpc({ cmd: 'initWorkbook', sheets: ['S1', 'S2', 'S3', 'S4'] })

    // Formula on S3 (idx 2), host-reads it → readFormulaCells gains '2:0:0'.
    await rpc({ cmd: 'setFormulaDetailed', sheet: 2, addr: 'A1', formula: '=1+1' })
    await rpc({ cmd: 'readCells', cells: [{ sheet: 2, addr: 'A1' }] })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 2, addr: 'A1' })).toBe('clean')

    // Formula on S4 (idx 3), never host-read → must be 'dirty'.
    await rpc({ cmd: 'setFormulaDetailed', sheet: 3, addr: 'A1', formula: '=2+2' })
    expect(await rpc({ cmd: 'debugFormulaCacheState', sheet: 3, addr: 'A1' })).toBe('dirty')

    // Remove S1 (idx 0): S3 → idx 1, S4 → idx 2. The stale '2:0:0' entry
    // now matches S4!A1, which the host never read.
    await rpc({ cmd: 'removeSheet', sheet: 0 })
    const probed = await rpc({ cmd: 'debugFormulaCacheState', sheet: 2, addr: 'A1' })

    // PIN (bug): should be 'dirty' — the host never observed S4!A1. The
    // removeSheet/moveSheet paths must drop / reindex `readFormulaCells`
    // (and `snapshotSessions` / `importSessions`, same index keying).
    expect(probed).toBe('clean')
  })
})

describe('audit D-4 · P-D · worker backend deleteSheet leaves per-sheet host overlays', () => {
  test('a new sheet reusing the deleted sheet id inherits its validation rules', async () => {
    const backend = createWorkerWorkbookSpreadsheetBackend({
      workerFactory: () => createInProcessWorker(),
      sheets: ['One', 'Two'],
    })
    await backend.ready()

    await backend.setValidationRule?.({
      kind: 'set-validation-rule',
      sheetId: 'sheet-2',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      rule: { kind: 'list', values: ['North', 'South'], dropdown: true },
      mode: 'warn',
    })

    await backend.deleteSheet?.({ kind: 'delete-sheet', sheetId: 'sheet-2', requestId: 1 })
    const added = await backend.addSheet?.({ kind: 'add-sheet', name: 'Fresh', requestId: 2 })

    // Sheet ids ARE reused after deletion (syncSheetLookup assigns
    // `sheet-${idx+1}`), which is what turns the stale map entry into a
    // user-visible defect rather than a plain leak.
    expect(added?.createdSheet?.id).toBe('sheet-2')

    const projection = await backend.readVisibleProjection(
      createVisibleProjectionRequest({
        sheetId: 'sheet-2',
        requestId: 3,
        window: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      }),
    )

    // PIN (bug): the brand-new empty sheet projects the DELETED sheet's
    // validation overlay. deleteSheet must clear validationRulesBySheetId,
    // conditionalFormatRulesBySheetId and filterSortBySheetId (and prune
    // sheet-scoped named ranges) for the removed sheetId.
    expect(projection.cells.some((cell) => cell.validation)).toBe(true)

    backend.dispose()
  })
})

describe('audit D-7 · P-A · worker backend reads the whole sheet per viewport refresh while filter/sort is active', () => {
  test('readVisibleProjection requests rows 0..1_048_575 once a sort directive exists', async () => {
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
    await backend.readVisibleProjection(
      createVisibleProjectionRequest({ sheetId: 'sheet-1', requestId: 3, window }),
    )
    const filteredRead = readRanges.at(-1)

    // eslint-disable-next-line no-console
    console.log(
      `[audit D-7] visible-window read rows: plain endRow=${String(plainRead?.endRow)} ` +
        `vs filter/sort-active endRow=${String(filteredRead?.endRow)}`,
    )

    // PIN: with filter/sort active EVERY viewport refresh (scroll tick,
    // single-cell edit refresh, ...) reads + format-snapshots the full
    // 0..1_048_575 row band and rebuilds the displayRows permutation from
    // scratch — O(sheet) per refresh. A displayRows cache keyed by
    // (sheetId, revision, filterSort state) would bound this to one full
    // scan per mutation instead of per read.
    expect(filteredRead?.endRow).toBe(1_048_575)

    backend.dispose()
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
