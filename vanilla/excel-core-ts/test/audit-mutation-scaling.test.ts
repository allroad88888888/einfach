/**
 * AUDIT MEASUREMENT PINS — mutation-path pattern-family audit (2026-06-12).
 *
 * Purpose: this file is NOT a behavior suite. It exists to pin timed
 * reproductions of the eager-fan-out / per-item-ceremony / bypassed-
 * propagation / incomplete-teardown pattern family hunted across the
 * Rust engine (see rust/excel-core/docs/AUDIT_PATTERN_FAMILY_2026-06-12.md,
 * section C). Timings go to console.log; assertions stay deliberately
 * loose so the suite remains green on any hardware. Do not tighten the
 * assertions into perf gates — the numbers feed the audit doc, nothing
 * else.
 *
 * Patterns measured:
 *  - P-A  whole-Map clone per single-cell edit (workbook.ts applyCell)
 *  - P-A  store-level eager re-derive of every cached formula atom on
 *         any sheetAtom bump (vanilla/core store.ts flushPending →
 *         dependenciesChange)
 *  - P-A  defineName / setLocale outside withBatch → recalculateAllSheets
 *         clones EVERY sheet
 *  - P-B  per-cell clearCell loops (mirrors worker-runtime-ts clearRange)
 *  - P-D  formulaAtomCache / backDependenciesMap never evict — deleted
 *         formulas keep their derive atoms in the flush walk forever
 *  - wire-type caveat re-verify: bulkApply('00123') loses leading zeros
 */

import { describe, expect, test } from '@jest/globals'

import { createWorkbook, type BulkCellInput } from '../src/workbook'
import { keyFor } from '../src/sheet'

const now = (): number => performance.now()

function literals(count: number, cols = 1000): BulkCellInput[] {
  const out: BulkCellInput[] = new Array(count)
  for (let i = 0; i < count; i += 1) {
    out[i] = { row: Math.floor(i / cols), col: i % cols, input: String(i) }
  }
  return out
}

/** Time `edits` single-cell writes, return median ms per edit. */
function medianSetCellMs(
  wb: ReturnType<typeof createWorkbook>,
  sheetId: string,
  edits = 5,
): number {
  const times: number[] = []
  for (let i = 0; i < edits; i += 1) {
    const t0 = now()
    wb.setCell(sheetId, 2000 + i, 0, String(i))
    times.push(now() - t0)
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)]
}

describe('AUDIT P-A: whole-Map clone per single-cell edit (workbook.ts applyCell)', () => {
  test.each([10_000, 100_000, 1_000_000])(
    'setCell cost after bulk-loading %i literal cells',
    (count) => {
      const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
      const t0 = now()
      wb.bulkApply('s1', literals(count))
      const loadMs = now() - t0
      const editMs = medianSetCellMs(wb, 's1')
      // eslint-disable-next-line no-console
      console.log(
        `[P-A clone] cells=${count} bulkLoad=${loadMs.toFixed(1)}ms ` +
          `median setCell=${editMs.toFixed(2)}ms/edit`,
      )
      expect(editMs).toBeGreaterThanOrEqual(0)
    },
    300_000,
  )
})

describe('AUDIT P-A: store flushPending re-derives every cached formula on any write', () => {
  test.each([1_000, 10_000, 100_000])(
    'one setCell with %i previously-read formulas cached',
    (formulaCount) => {
      const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
      const sheet = wb.sheet('s1')!
      // One literal everything references, then N independent formulas.
      wb.setCell('s1', 0, 0, '1')
      const cells: BulkCellInput[] = []
      for (let i = 0; i < formulaCount; i += 1) {
        cells.push({ row: 1 + Math.floor(i / 1000), col: i % 1000, input: `=A1+${i}` })
      }
      wb.bulkApply('s1', cells)
      // Read every formula once → derive cached + registered as a
      // back-dependency of sheetAtom in vanilla/core.
      const tRead0 = now()
      for (let i = 0; i < formulaCount; i += 1) {
        wb.store.getter(sheet.formulaCellAtom(keyFor(1 + Math.floor(i / 1000), i % 1000)))
      }
      const readMs = now() - tRead0
      const evalsBefore = wb.debugFormulaEvalCount(0)
      // Mutate ONE unrelated literal cell. flushPending walks every
      // cached derive because they all depend on the (new-identity)
      // sheet Map.
      const t0 = now()
      wb.setCell('s1', 5000, 0, '42')
      const editMs = now() - t0
      const evalsAfter = wb.debugFormulaEvalCount(0)
      // eslint-disable-next-line no-console
      console.log(
        `[P-A flush] formulasRead=${formulaCount} firstReadAll=${readMs.toFixed(1)}ms ` +
          `one setCell=${editMs.toFixed(1)}ms re-evals=${evalsAfter - evalsBefore}`,
      )
      expect(editMs).toBeGreaterThanOrEqual(0)
    },
    300_000,
  )
})

describe('AUDIT P-A: defineName / setLocale outside withBatch clone every sheet', () => {
  test('one defineName on 3 sheets x 100k cells vs 50 names inside withBatch', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 's2', name: 'Sheet2' },
      { id: 's3', name: 'Sheet3' },
    ])
    for (const id of ['s1', 's2', 's3']) wb.bulkApply(id, literals(100_000))

    const t0 = now()
    wb.defineName('ONE_NAME', { kind: 'value', value: { kind: 'number', value: 1 } })
    const oneNameMs = now() - t0

    const t1 = now()
    wb.withBatch(() => {
      for (let i = 0; i < 50; i += 1) {
        wb.defineName(`BATCH_${i}`, { kind: 'value', value: { kind: 'number', value: i } })
      }
    })
    const batch50Ms = now() - t1

    const t2 = now()
    for (let i = 0; i < 50; i += 1) {
      wb.defineName(`LOOSE_${i}`, { kind: 'value', value: { kind: 'number', value: i } })
    }
    const loose50Ms = now() - t2

    const t3 = now()
    wb.recalc()
    const recalcMs = now() - t3

    const t4 = now()
    wb.setLocale('de-DE')
    const localeMs = now() - t4

    // eslint-disable-next-line no-console
    console.log(
      `[P-A recalcAll] 3x100k cells: defineName(1)=${oneNameMs.toFixed(1)}ms ` +
        `withBatch(50 names)=${batch50Ms.toFixed(1)}ms loose(50 names)=${loose50Ms.toFixed(1)}ms ` +
        `recalc()=${recalcMs.toFixed(1)}ms setLocale=${localeMs.toFixed(1)}ms`,
    )
    expect(oneNameMs).toBeGreaterThanOrEqual(0)
  }, 300_000)
})

describe('AUDIT P-B: per-cell clearCell loop (worker-runtime-ts clearRange shape)', () => {
  test('100 clearCell calls on a 100k-cell sheet — each clones the full Map', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.bulkApply('s1', literals(100_000))
    const t0 = now()
    for (let i = 0; i < 100; i += 1) {
      wb.clearCell('s1', 0, i, 'all')
    }
    const loopMs = now() - t0
    // eslint-disable-next-line no-console
    console.log(
      `[P-B clear loop] 100 clearCell @100k cells: total=${loopMs.toFixed(1)}ms ` +
        `(${(loopMs / 100).toFixed(2)}ms/cell)`,
    )
    expect(loopMs).toBeGreaterThanOrEqual(0)
  }, 300_000)
})

describe('AUDIT P-D: deleted formulas leave derive atoms in the flush walk forever', () => {
  test('setCell cost stays elevated after all 10k formulas are overwritten to literals', () => {
    const formulaCount = 10_000
    // Baseline: same map size, never any formulas read.
    const base = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    base.bulkApply('s1', literals(formulaCount + 1))
    const baselineMs = medianSetCellMs(base, 's1')

    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '1')
    const cells: BulkCellInput[] = []
    for (let i = 0; i < formulaCount; i += 1) {
      cells.push({ row: 1 + Math.floor(i / 1000), col: i % 1000, input: `=A1+${i}` })
    }
    wb.bulkApply('s1', cells)
    for (let i = 0; i < formulaCount; i += 1) {
      wb.store.getter(sheet.formulaCellAtom(keyFor(1 + Math.floor(i / 1000), i % 1000)))
    }
    // "Delete" every formula (overwrite with plain literals → no ast).
    const overwrite: BulkCellInput[] = cells.map((c) => ({ ...c, input: '7' }))
    wb.bulkApply('s1', overwrite)
    // The formula derive atoms are now semantically dead, but
    // formulaAtomCache + backDependenciesMap(sheetAtom) still hold all
    // 10k of them — every subsequent write re-walks (and re-derives)
    // each one.
    const afterDeleteMs = medianSetCellMs(wb, 's1')
    // eslint-disable-next-line no-console
    console.log(
      `[P-D orphan derives] 10k formulas read-then-overwritten: ` +
        `setCell=${afterDeleteMs.toFixed(2)}ms vs never-formula baseline=${baselineMs.toFixed(2)}ms ` +
        `(stale-walk overhead=${(afterDeleteMs - baselineMs).toFixed(2)}ms)`,
    )
    expect(afterDeleteMs).toBeGreaterThanOrEqual(0)
  }, 300_000)
})

describe('AUDIT P-C: withBatch throw leaves names mutated but never invalidates', () => {
  test('defineName inside a throwing batch: registry updated, cached formula stays stale', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '=MYNAME')
    const a = sheet.formulaCellAtom(keyFor(0, 0))
    const before = wb.store.getter(a)
    expect(before).toEqual({ kind: 'error', code: '#NAME?' })

    expect(() =>
      wb.withBatch(() => {
        wb.defineName('MYNAME', { kind: 'value', value: { kind: 'number', value: 99 } })
        throw new Error('host abort')
      }),
    ).toThrow('host abort')

    // The name IS in the registry (defineName mutated the map before the
    // throw), but the deferred recalc was swallowed — the cached derive
    // is never invalidated and keeps serving #NAME? until some unrelated
    // mutation happens to bump the sheetAtom.
    const after = wb.store.getter(a)
    // eslint-disable-next-line no-console
    console.log(
      `[P-C batch-throw] post-throw read of =MYNAME -> ${JSON.stringify(after)} ` +
        `(registry already holds MYNAME=99)`,
    )
    // Pin the CURRENT (inconsistent) behavior: stale #NAME? despite the
    // registry mutation having been applied.
    expect(after).toEqual({ kind: 'error', code: '#NAME?' })

    // An unrelated cell write "heals" it — proving the registry mutation
    // was live the whole time and only the invalidation was skipped.
    wb.setCell('s1', 9, 9, '1')
    expect(wb.store.getter(a)).toEqual({ kind: 'number', value: 99 })
  })
})

describe('AUDIT wire-type caveat: bulkApply re-classifies text through parseLiteral', () => {
  test("bulkApply '00123' becomes number 123 (leading zeros lost); setCellValue preserves", () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.bulkApply('s1', [{ row: 0, col: 0, input: '00123' }])
    wb.setCellValue('s1', 0, 1, { kind: 'string', value: '00123' })
    const cells = wb.store.getter(wb.sheet('s1')!.sheetAtom)
    const viaBulk = cells.get(keyFor(0, 0))!.value
    const viaTyped = cells.get(keyFor(0, 1))!.value
    // eslint-disable-next-line no-console
    console.log(
      `[wire-type] bulkApply('00123') -> ${JSON.stringify(viaBulk)}; ` +
        `setCellValue text -> ${JSON.stringify(viaTyped)}`,
    )
    // Pin the CURRENT (lossy) behavior so a silent change is visible.
    expect(viaBulk).toEqual({ kind: 'number', value: 123 })
    expect(viaTyped).toEqual({ kind: 'string', value: '00123' })
  })
})
