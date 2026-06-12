/**
 * AUDIT MEASUREMENT PINS — mutation-path pattern-family audit (2026-06-12).
 *
 * Purpose: this file is NOT a behavior suite. It pins the measured
 * outcomes of the eager-fan-out / per-item-ceremony / bypassed-
 * propagation / incomplete-teardown pattern family hunted across the
 * Rust engine (see rust/excel-core/docs/AUDIT_PATTERN_FAMILY_2026-06-12.md,
 * section C). Timings go to console.log; the timed assertions use
 * generous margins (the fixed paths are 50-1000× under them on Apple
 * Silicon) so the suite stays green on any reasonable hardware.
 *
 * Status after KEY_GRANULAR_INVALIDATION (Wave 2 / W2.2):
 *  - C-1 FIXED — storage mutates in place; a single-cell edit is O(1)
 *         in sheet size (was: whole-Map clone, 107 ms @ 1M cells).
 *  - C-2 FIXED — mutations dirty O(dependents-of-written-keys) via the
 *         workbook DepGraph; re-eval count == true dependent count
 *         (was: every cached derive re-ran, 503 ms @ 100k formulas).
 *         NOTE: the FIRST setter after a large burst of host reads
 *         additionally drains vanilla/core's pending-read bookkeeping
 *         once (amortized O(1) per read; pre-existing core behavior,
 *         logged separately below).
 *  - C-6 FIXED — overwriting/clearing a formula uninstalls its dep
 *         edges and evicts its derive + epoch atoms (was: orphaned
 *         derives cost ~40× per edit forever).
 *  - P-A  defineName / setLocale outside withBatch remain DELIBERATELY
 *         broad (registry-driven full invalidation, audit C-3) — but no
 *         longer clone any sheet, so the absolute cost collapsed.
 *  - P-B  per-cell clearCell loops (C-4): each clear is now
 *         O(dependents), no longer a full clone + full flush (was
 *         5.1-5.3 ms/cell @ 100k cells; now ~0.002 ms/cell). W2.4 adds
 *         the range-shaped bulk primitive `Workbook.clearRange`
 *         (O(existing cells in rect), ONE postWrite batch) and routes
 *         worker-runtime-ts clearRange through it (audit D-1).
 *  - P-C  withBatch throw — FIXED (C-5): registries roll back on abort.
 *  - wire-type caveat re-verify: bulkApply('00123') loses leading zeros
 *         (unchanged, still pinned).
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

describe('AUDIT C-1 (FIXED): single-cell edit cost is O(1) in sheet size', () => {
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
        `[C-1 FIXED in-place] cells=${count} bulkLoad=${loadMs.toFixed(1)}ms ` +
          `median setCell=${editMs.toFixed(3)}ms/edit`,
      )
      // WAS 107.6 ms @ 1M cells (whole-Map clone). Now in-place:
      // ~0.01 ms at every size. Margin is generous (W2.2 acceptance: <2ms).
      expect(editMs).toBeLessThan(2)
    },
    300_000,
  )
})

describe('AUDIT C-2 (FIXED): mutations dirty O(dependents), not O(cached formulas)', () => {
  test.each([1_000, 10_000, 100_000])(
    'one unrelated setCell with %i previously-read formulas cached',
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
      // Read every formula once → derive cached; deps lazily installed
      // into the workbook DepGraph (Rust hydrate-on-read mirror).
      const tRead0 = now()
      for (let i = 0; i < formulaCount; i += 1) {
        wb.store.getter(sheet.formulaCellAtom(keyFor(1 + Math.floor(i / 1000), i % 1000)))
      }
      const readMs = now() - tRead0
      // The first setter after a host-read burst drains vanilla/core's
      // pending-read bookkeeping (amortized O(1) per read; pre-existing
      // core behavior unrelated to the mutation path). Time it
      // separately so the per-edit pin below measures the edit itself.
      const tDrain0 = now()
      wb.setCell('s1', 4999, 0, '41')
      const drainMs = now() - tDrain0
      const evalsBefore = wb.debugFormulaEvalCount(0)
      // Mutate ONE unrelated literal cell. Key-granular invalidation:
      // no cached formula depends on it → ZERO re-derives.
      const editMs = medianSetCellMs(wb, 's1')
      const evalsAfter = wb.debugFormulaEvalCount(0)
      // eslint-disable-next-line no-console
      console.log(
        `[C-2 FIXED dirty-set] formulasRead=${formulaCount} firstReadAll=${readMs.toFixed(1)}ms ` +
          `readBacklogDrain=${drainMs.toFixed(1)}ms median setCell=${editMs.toFixed(3)}ms ` +
          `re-evals=${evalsAfter - evalsBefore}`,
      )
      // WAS 503 ms / 100 000 re-evals @ 100k. Now: zero re-evals and
      // sub-millisecond edits (W2.2 acceptance: <10ms).
      expect(evalsAfter - evalsBefore).toBe(0)
      expect(editMs).toBeLessThan(10)
    },
    300_000,
  )

  test('re-eval count equals TRUE dependent count, not cached-formula count', () => {
    const dependentCount = 100
    const unrelatedCount = 9_900
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '1') // A1 — the dep of the first 100 formulas
    wb.setCell('s1', 0, 1, '2') // B1 — the dep of the other 9 900
    const cells: BulkCellInput[] = []
    for (let i = 0; i < dependentCount + unrelatedCount; i += 1) {
      const ref = i < dependentCount ? 'A1' : 'B1'
      cells.push({ row: 1 + Math.floor(i / 1000), col: i % 1000, input: `=${ref}+${i}` })
    }
    wb.bulkApply('s1', cells)
    for (let i = 0; i < dependentCount + unrelatedCount; i += 1) {
      wb.store.getter(sheet.formulaCellAtom(keyFor(1 + Math.floor(i / 1000), i % 1000)))
    }
    // Drain the read backlog so the eval delta below is the edit's own.
    wb.setCell('s1', 5000, 0, '0')
    const evalsBefore = wb.debugFormulaEvalCount(0)
    wb.setCell('s1', 0, 0, '7') // mutate A1
    const evalsAfter = wb.debugFormulaEvalCount(0)
    // eslint-disable-next-line no-console
    console.log(
      `[C-2 FIXED dependent-count] cached=${dependentCount + unrelatedCount} ` +
        `write A1 -> re-evals=${evalsAfter - evalsBefore} (true dependents=${dependentCount})`,
    )
    // Exactly the 100 true dependents re-derive — not all 10 000 cached.
    expect(evalsAfter - evalsBefore).toBe(dependentCount)
    // And the dependents really picked up the new value.
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(1, 0)))).toEqual({
      kind: 'number',
      value: 7,
    })
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(1, dependentCount)))).toEqual({
      kind: 'number',
      value: 2 + dependentCount,
    })
  }, 300_000)
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

describe('AUDIT P-B (C-4): per-cell clearCell loop (worker-runtime-ts clearRange shape)', () => {
  test('100 clearCell calls on a 100k-cell sheet — in-place post-W2.2', () => {
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

describe('AUDIT C-6 (FIXED): overwritten formulas evict their derive atoms', () => {
  // eslint-disable-next-line max-len
  test('setCell cost returns to baseline after all 10k formulas are overwritten to literals', () => {
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
    const atomBeforeOverwrite = sheet.formulaCellAtom(keyFor(1, 0))
    // "Delete" every formula (overwrite with plain literals → no ast).
    // C-6 fix: each overwrite uninstalls the formula's dep edges and
    // evicts its derive + epoch atoms from the sheet caches.
    const overwrite: BulkCellInput[] = cells.map((c) => ({ ...c, input: '7' }))
    wb.bulkApply('s1', overwrite)
    const afterDeleteMs = medianSetCellMs(wb, 's1')
    // eslint-disable-next-line no-console
    console.log(
      '[C-6 FIXED eviction] 10k formulas read-then-overwritten: ' +
        `setCell=${afterDeleteMs.toFixed(3)}ms ` +
        `vs never-formula baseline=${baselineMs.toFixed(3)}ms ` +
        `(residual overhead=${(afterDeleteMs - baselineMs).toFixed(3)}ms)`,
    )
    // WAS 16-17 ms vs 0.4 ms baseline (~40× permanent drag). Now the
    // orphans are gone — both medians sit at ~0.01 ms; assert the
    // generous absolute bound.
    expect(afterDeleteMs).toBeLessThan(2)
    // Eviction is observable: asking for the cell's atom again builds a
    // FRESH atom (the orphan was dropped from the cache) and it serves
    // the literal.
    const atomAfterOverwrite = sheet.formulaCellAtom(keyFor(1, 0))
    expect(atomAfterOverwrite).not.toBe(atomBeforeOverwrite)
    expect(wb.store.getter(atomAfterOverwrite)).toEqual({ kind: 'number', value: 7 })
  }, 300_000)
})

describe('AUDIT P-C (FIXED): withBatch throw rolls back registry mutations', () => {
  // eslint-disable-next-line max-len
  test('defineName inside a throwing batch: registry rolled back, formula stays consistently #NAME?', () => {
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

    // FIXED (audit C-5): the throw aborts the batch for real — the
    // registry write is rolled back, so the cached derive's #NAME? is
    // CONSISTENT with the registry, not stale.
    const after = wb.store.getter(a)
    // eslint-disable-next-line no-console
    console.log(
      `[P-C batch-throw FIXED] post-throw read of =MYNAME -> ${JSON.stringify(after)} ` +
        '(registry rolled back, MYNAME undefined)',
    )
    expect(after).toEqual({ kind: 'error', code: '#NAME?' })

    // An unrelated cell write must NOT "heal" the formula to 99 — the
    // rollback removed MYNAME from the registry, so the re-derive still
    // resolves to #NAME?. (Pre-fix this flipped to 99: the proof of the
    // registry/cache disagreement.)
    wb.setCell('s1', 9, 9, '1')
    expect(wb.store.getter(a)).toEqual({ kind: 'error', code: '#NAME?' })
  })
})

describe('AUDIT wire-type caveat (C-8) — FIXED: typed bulkApply entries skip parseLiteral', () => {
  test("typed bulk entry preserves text '00123'; raw input strings still infer", () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    // Raw input-string entries keep `setCell` semantics by design: the
    // string runs through parseLiteral inference. This is the documented
    // contract for untyped input, NOT the C-8 bug.
    wb.bulkApply('s1', [{ row: 0, col: 0, input: '00123' }])
    // Typed entries (the C-8 fix) carry the producer's classification
    // through the bulk fast path — identical to setCellValue.
    wb.bulkApply('s1', [
      { row: 0, col: 1, value: { kind: 'string', value: '00123' } },
      { row: 0, col: 2, value: { kind: 'string', value: '=A1' } },
      { row: 0, col: 3, value: { kind: 'string', value: 'TRUE' } },
      { row: 0, col: 4, value: { kind: 'number', value: 1.5 } },
      { row: 0, col: 5, value: { kind: 'boolean', value: true } },
    ])
    wb.setCellValue('s1', 1, 0, { kind: 'string', value: '00123' })
    const cells = wb.store.getter(wb.sheet('s1')!.sheetAtom)
    const viaRawInput = cells.get(keyFor(0, 0))!.value
    const viaTypedBulk = cells.get(keyFor(0, 1))!.value
    // eslint-disable-next-line no-console
    console.log(
      `[wire-type FIXED] bulkApply input:'00123' -> ${JSON.stringify(viaRawInput)}; ` +
        `bulkApply typed text -> ${JSON.stringify(viaTypedBulk)}`,
    )
    expect(viaRawInput).toEqual({ kind: 'number', value: 123 })
    // FIXED (C-8): the typed bulk path preserves the wire type.
    expect(viaTypedBulk).toEqual({ kind: 'string', value: '00123' })
    expect(cells.get(keyFor(0, 2))!.value).toEqual({ kind: 'string', value: '=A1' })
    expect(cells.get(keyFor(0, 2))!.ast).toBeUndefined()
    expect(cells.get(keyFor(0, 3))!.value).toEqual({ kind: 'string', value: 'TRUE' })
    expect(cells.get(keyFor(0, 4))!.value).toEqual({ kind: 'number', value: 1.5 })
    expect(cells.get(keyFor(0, 5))!.value).toEqual({ kind: 'boolean', value: true })
    expect(cells.get(keyFor(1, 0))!.value).toEqual({ kind: 'string', value: '00123' })

    // Typed blank clears the entry like setCellValue (delete when no format).
    wb.bulkApply('s1', [{ row: 0, col: 4, value: { kind: 'blank' } }])
    expect(wb.store.getter(wb.sheet('s1')!.sheetAtom).has(keyFor(0, 4))).toBe(false)
  })
})
