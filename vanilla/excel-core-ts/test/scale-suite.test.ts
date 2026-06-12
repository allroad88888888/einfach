/**
 * ALWAYS-ON SCALE SUITE — TS engine side of
 * `rust/excel-core/docs/SCALE_TEST_SUITE_PLAN.md` (S1–S12).
 *
 * Design contract (plan §Design principles):
 *  - Always-on: runs under plain `npx jest`; the whole file must stay
 *    well under the monorepo's 8 s budget (target ≤ 4 s).
 *  - Counters, not clocks: every complexity assertion uses re-eval
 *    counts (`debugFormulaEvalCount`), DepGraph sizes
 *    (`debugDepGraphStats`), atom-cache sizes (`debugAtomCounts`),
 *    revision deltas, or map sizes. NO timing assertions.
 *  - Closed-form values: each shape's doc comment states the arithmetic
 *    identity it asserts (SUM(1..N) = N(N+1)/2, chain tail = N + Δ, …).
 *  - Deterministic: the only randomness is a literal-seeded LCG.
 *
 * TS-engine notes (differences from the Rust side, called out per shape):
 *  - Eager-at-mutation: cached derives re-run synchronously inside the
 *    mutator, so "re-eval count" deltas appear at WRITE time, not at the
 *    next read (Rust is lazy: dirty until read).
 *  - `debugFormulaEvalCount` counts DERIVE runs (anchor evaluations).
 *    Cells evaluated transitively inside one trampoline run do not bump
 *    it — so it measures exactly the key-granular contract: one bump per
 *    true dependent with a cached derive.
 *  - S7: the TS engine has NO structural insert/delete row/col ops
 *    (those are worker-runtime concerns); S7 is scoped to the structural
 *    primitive that DOES exist at engine level: `clearRange` (audit D-1).
 *  - S6: the TS workbook has no removeSheet — the A-6 "remove unrelated
 *    sheet" sub-assert is Rust-only.
 *  - S9: there is no install/restore snapshot API — the roundtrip is
 *    modeled as full-replace (clearRange whole sheet + bulkApply new
 *    content), which is what the worker runtime does on restore.
 */

import { describe, expect, test } from '@jest/globals'

import { keyFor } from '../src/sheet'
import { createWorkbook, type BulkCellInput } from '../src/workbook'
import type { Value } from '../src/types'

const num = (value: number): Value => ({ kind: 'number', value })

/** Deterministic 32-bit LCG (Numerical Recipes constants), literal seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s
  }
}

function makeWb(
  sheets: ReadonlyArray<{ id: string; name: string }> = [{ id: 's1', name: 'Sheet1' }],
) {
  return createWorkbook(sheets)
}

/** A1 = 1, A2 = A1+1, …, A{n} = A{n-1}+1 — tail closed form: A{n} = n. */
function chainCells(n: number): BulkCellInput[] {
  const cells: BulkCellInput[] = [{ row: 0, col: 0, input: '1' }]
  for (let row = 1; row < n; row += 1) {
    cells.push({ row, col: 0, input: `=A${row}+1` })
  }
  return cells
}

// ---------------------------------------------------------------------------
// S1 — Chain
// ---------------------------------------------------------------------------

describe('S1 — chain: tail == N closed form, key-granular re-eval counts', () => {
  test('S1a chain 50k: tail == N; head edit → tail == N+Δ with EXACTLY one derive re-run', () => {
    const N = 50_000
    const wb = makeWb()
    wb.bulkApply('s1', chainCells(N))
    const sheet = wb.sheet('s1')!
    const tail = sheet.formulaCellAtom(keyFor(N - 1, 0))

    // Closed form: A{N} = N. One derive run resolves the whole chain
    // through the trampoline (transitive frames don't bump the counter).
    expect(wb.store.getter(tail)).toEqual(num(N))
    expect(wb.debugFormulaEvalCount(0)).toBe(1)

    // Edit the head: 1 → 11 (Δ = 10). Only ONE cached derive exists (the
    // tail), so exactly one re-derive fires — not chain-length many.
    wb.setCell('s1', 0, 0, '11')
    expect(wb.debugFormulaEvalCount(0)).toBe(2)
    expect(wb.store.getter(tail)).toEqual(num(N + 10))
  })

  // N sized down from the plan's 50k: with EVERY member's derive cached,
  // each re-derive walks its own upstream chain inside its trampoline run
  // (run-local cache), so the all-read variant is O(N²) work by design —
  // the COUNTER contract (== chain length exactly) is size-independent.
  test('S1b chain 384 all read: head edit re-derives EXACTLY chain length, not 2×', () => {
    const N = 384
    const wb = makeWb()
    wb.bulkApply('s1', chainCells(N))
    const sheet = wb.sheet('s1')!
    // Cache every member's derive (N-1 formulas → N-1 derive runs).
    for (let row = 1; row < N; row += 1) {
      wb.store.getter(sheet.formulaCellAtom(keyFor(row, 0)))
    }
    expect(wb.debugFormulaEvalCount(0)).toBe(N - 1)

    // Head edit: every member is a TRUE dependent → each cached derive
    // re-runs exactly once (the C-2 pin: == dependent count, not 2×,
    // not 0). Values shift by Δ = +5 uniformly.
    const before = wb.debugFormulaEvalCount(0)
    wb.setCell('s1', 0, 0, '6')
    expect(wb.debugFormulaEvalCount(0) - before).toBe(N - 1)
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(N - 1, 0)))).toEqual(num(N + 5))
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(1, 0)))).toEqual(num(7))
  })
})

// ---------------------------------------------------------------------------
// S2 — Fanout
// ---------------------------------------------------------------------------

describe('S2 — fanout 20k: edit A1 → bump count == N; unrelated edit → 0', () => {
  test('B_i = A1 + i: closed-form values, exact dependent-count re-evals', () => {
    const N = 20_000
    const wb = makeWb()
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '1') // A1
    const cells: BulkCellInput[] = []
    for (let i = 0; i < N; i += 1) {
      // Spread over 1000 columns starting at col 1 (avoid col 0 = A).
      cells.push({ row: 1 + Math.floor(i / 1000), col: 1 + (i % 1000), input: `=A1+${i}` })
    }
    wb.bulkApply('s1', cells)
    const atomOf = (i: number) =>
      sheet.formulaCellAtom(keyFor(1 + Math.floor(i / 1000), 1 + (i % 1000)))
    for (let i = 0; i < N; i += 1) wb.store.getter(atomOf(i))
    expect(wb.debugFormulaEvalCount(0)).toBe(N)
    // Closed form: B_i = A1 + i = 1 + i (deterministic LCG sampling).
    const rand = lcg(0xC0FFEE)
    for (let k = 0; k < 64; k += 1) {
      const i = rand() % N
      expect(wb.store.getter(atomOf(i))).toEqual(num(1 + i))
    }

    // Edit A1 → EVERY fanout member is a true dependent: exactly N bumps.
    let before = wb.debugFormulaEvalCount(0)
    wb.setCell('s1', 0, 0, '9')
    expect(wb.debugFormulaEvalCount(0) - before).toBe(N)
    expect(wb.store.getter(atomOf(N - 1))).toEqual(num(9 + (N - 1)))

    // Second, UNRELATED edit (cell nothing depends on) → zero re-evals.
    before = wb.debugFormulaEvalCount(0)
    wb.setCell('s1', 5_000, 0, '123')
    expect(wb.debugFormulaEvalCount(0) - before).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// S3 — Fan-in aggregate over 100k
// ---------------------------------------------------------------------------
//
// REAL BUG FOUND AND FIXED BY THIS SUITE (2026-06-12): whole-column/-row
// aggregates (`SUM(A:A)`, `COUNTIF(A:A,…)`) resolved every existing cell
// through `ctx.refLookup` ONE AT A TIME (`sparseValuesForRef`), and
// inside the trampoline shim every uncached LITERAL threw NeedsDep —
// restarting the whole sparse scan+sort per existing cell. Measured
// O(N² log N): 458 ms @ 1k, 1.83 s @ 2k, 7.3 s @ 4k (4× per doubling);
// a 100k whole-col aggregate was an effective hang (~hours). FIX:
// `sparseValuesForRef` now reads literal cells straight from storage
// (semantics-preserving; formula cells keep the refLookup path). After
// the fix: SUM(A:A) + COUNTIF(A:A) over 100k literals = 76 ms total.
// The whole-column tests below are the regression fence for that fix —
// if they start timing out, the fault-per-literal pattern is back.

describe('S3 — fan-in SUM over 100k: closed form, exactly-1 re-eval', () => {
  test('bounded SUM(A1:A100000) == N(N+1)/2; one member edit → exactly 1 re-eval', () => {
    const N = 100_000
    const wb = makeWb()
    const sheet = wb.sheet('s1')!
    const cells: BulkCellInput[] = new Array(N)
    for (let i = 0; i < N; i += 1) {
      cells[i] = { row: i, col: 0, input: String(i + 1) } // A: 1..N
    }
    wb.bulkApply('s1', cells)
    wb.setCell('s1', 0, 1, `=SUM(A1:A${N})`) // B1

    const sum = sheet.formulaCellAtom(keyFor(0, 1))
    // Closed form: SUM(1..N) = N(N+1)/2 = 5 000 050 000.
    expect(wb.store.getter(sum)).toEqual(num((N * (N + 1)) / 2))
    expect(wb.debugFormulaEvalCount(0)).toBe(1)

    // Edit ONE member (value k+1 → k+1+10): exactly 1 formula re-evals
    // (the aggregate), and the sum shifts by exactly Δ = 10.
    const k = 12_345
    wb.setCell('s1', k, 0, String(k + 1 + 10))
    expect(wb.debugFormulaEvalCount(0)).toBe(2)
    expect(wb.store.getter(sum)).toEqual(num((N * (N + 1)) / 2 + 10))

    // Edit OUTSIDE column A → zero re-evals (range index is col-bucketed).
    wb.setCell('s1', 50, 5, '777')
    expect(wb.debugFormulaEvalCount(0)).toBe(2)
    // Edit in column A but BELOW the bounded range → zero re-evals.
    wb.setCell('s1', 500_000, 0, '888')
    expect(wb.debugFormulaEvalCount(0)).toBe(2)
  })

  test('whole-column SUM(A:A) over 100k SPARSE rows: closed form, O(existing) scan', () => {
    const N = 100_000
    const STRIDE = 9 // sparse: rows 0, 9, 18, … (max row 899 991 < 1 048 575)
    const wb = makeWb()
    const sheet = wb.sheet('s1')!
    const cells: BulkCellInput[] = new Array(N)
    for (let i = 0; i < N; i += 1) {
      cells[i] = { row: i * STRIDE, col: 0, input: String(i + 1) }
    }
    wb.bulkApply('s1', cells)
    wb.setCell('s1', 0, 1, '=SUM(A:A)')
    const sum = sheet.formulaCellAtom(keyFor(0, 1))
    // Closed form over the SPARSE column: SUM(1..N) = N(N+1)/2. This is
    // the regression fence for the sparseValuesForRef O(N²) fix — pre-fix
    // this single read took ~hours, post-fix milliseconds.
    expect(wb.store.getter(sum)).toEqual(num((N * (N + 1)) / 2))
    expect(wb.debugFormulaEvalCount(0)).toBe(1)
    // One member edit → exactly 1 re-eval, exact Δ.
    wb.setCell('s1', 12_345 * STRIDE, 0, String(12_346 + 10))
    expect(wb.debugFormulaEvalCount(0)).toBe(2)
    expect(wb.store.getter(sum)).toEqual(num((N * (N + 1)) / 2 + 10))
    // Edit outside column A → zero re-evals.
    wb.setCell('s1', 50, 5, '777')
    expect(wb.debugFormulaEvalCount(0)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// S4 — Criteria aggregates over 100k
// ---------------------------------------------------------------------------

describe('S4 — SUMIF/COUNTIF whole-column over 100k: closed forms', () => {
  test('COUNTIF band count and SUMIF band sums are exact', () => {
    const N = 100_000
    const wb = makeWb()
    const sheet = wb.sheet('s1')!
    const cells: BulkCellInput[] = new Array(N)
    for (let i = 0; i < N; i += 1) {
      cells[i] = { row: i, col: 0, input: String(i + 1) } // A: 1..N
    }
    wb.bulkApply('s1', cells)
    // Whole-column criteria over 100k existing cells — exercises the
    // sparse-iteration path end to end (linear post-S3-fix; COUNTIF(A:A)
    // measured 453 ms @ 1k pre-fix, the full 100k now runs in ~50 ms).
    wb.bulkApply('s1', [
      { row: 0, col: 2, input: '=COUNTIF(A:A,">=50001")' }, // upper half
      { row: 1, col: 2, input: '=SUMIF(A:A,"<=100")' }, // band 1..100
      { row: 2, col: 2, input: '=SUMIF(A:A,">=99901",A:A)' }, // top band
    ])
    // Closed forms: |{50001..100000}| = 50 000; SUM(1..100) = 5050;
    // SUM(99901..100000) = (99901+100000)*100/2.
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(0, 2)))).toEqual(num(50_000))
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(1, 2)))).toEqual(num(5050))
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(2, 2)))).toEqual(
      num(((99_901 + 100_000) * 100) / 2),
    )
    expect(wb.debugFormulaEvalCount(0)).toBe(3)
  })

})

// ---------------------------------------------------------------------------
// S5 — Spill (SEQUENCE 10k)
// ---------------------------------------------------------------------------

describe('S5 — spill 10k: anchor array closed forms; clearing the anchor leaves no orphans', () => {
  test('SUM(A1#) == N(N+1)/2; clear anchor → deps #REF!, caches/dep-graph shrink', () => {
    const N = 10_000
    const wb = makeWb()
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, `=SEQUENCE(${N})`) // A1 — anchor holds the array
    wb.setCell('s1', 0, 1, '=SUM(A1#)') // B1
    wb.setCell('s1', 0, 2, '=ROWS(A1#)') // C1

    const anchor = sheet.formulaCellAtom(keyFor(0, 0))
    const sumDep = sheet.formulaCellAtom(keyFor(0, 1))
    const rowsDep = sheet.formulaCellAtom(keyFor(0, 2))

    // TS spill model: the ANCHOR's value is the whole array; covered
    // cells are virtual (no map entry — `A1#` is the read surface).
    const anchorValue = wb.store.getter(anchor)
    expect(anchorValue.kind).toBe('array')
    if (anchorValue.kind === 'array') {
      expect(anchorValue.value[0][0]).toEqual(num(1))
      expect(anchorValue.value[N - 1][0]).toEqual(num(N))
    }
    // Closed forms: SUM(1..N) = N(N+1)/2; ROWS = N.
    expect(wb.store.getter(sumDep)).toEqual(num((N * (N + 1)) / 2))
    expect(wb.store.getter(rowsDep)).toEqual(num(N))
    expect(wb.debugFormulaEvalCount(0)).toBe(3)
    expect(sheet._internal.debugAtomCounts()).toEqual({ derives: 3, epochs: 3 })
    expect(wb.debugDepGraphStats()).toMatchObject({ installed: 3, pointKeys: 1, broad: 0 })

    // Clear the anchor at scale: the two spill-ref dependents re-derive
    // (exactly 2 evals) to #REF!, the held anchor atom reads BLANK, and
    // the bookkeeping returns to baseline: anchor derive evicted (its
    // epoch survives BY DESIGN), anchor's dep-graph record uninstalled.
    wb.clearCell('s1', 0, 0, 'all')
    expect(wb.debugFormulaEvalCount(0)).toBe(5)
    expect(wb.store.getter(anchor)).toEqual({ kind: 'blank' })
    expect(wb.store.getter(sumDep)).toMatchObject({ kind: 'error', code: '#REF!' })
    expect(wb.store.getter(rowsDep)).toMatchObject({ kind: 'error', code: '#REF!' })
    expect(sheet._internal.debugAtomCounts()).toEqual({ derives: 2, epochs: 3 })
    expect(wb.debugDepGraphStats()).toMatchObject({ installed: 2, pointKeys: 1, broad: 0 })
    // The anchor's storage entry is gone — the live map holds only B1/C1.
    expect(wb.store.getter(sheet.sheetAtom).size).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// S6 — Cross-sheet chain (10 sheets)
// ---------------------------------------------------------------------------

describe('S6 — cross-sheet chain 10 sheets × 3k: tail closed form, cross-sheet propagation', () => {
  test('tail == 10×3k; source edit re-derives the tail once and fires subscribers', () => {
    const SHEETS = 10
    const PER_SHEET = 3_000
    const seeds = Array.from({ length: SHEETS }, (_, k) => ({
      id: `s${k}`,
      name: `Sheet${k + 1}`,
    }))
    const wb = makeWb(seeds)
    for (let k = 0; k < SHEETS; k += 1) {
      const cells: BulkCellInput[] =
        k === 0
          ? [{ row: 0, col: 0, input: '1' }]
          : [{ row: 0, col: 0, input: `=Sheet${k}!A${PER_SHEET}+1` }]
      for (let row = 1; row < PER_SHEET; row += 1) {
        cells.push({ row, col: 0, input: `=A${row}+1` })
      }
      wb.bulkApply(`s${k}`, cells)
    }
    const lastSheet = wb.sheet(`s${SHEETS - 1}`)!
    const tail = lastSheet.formulaCellAtom(keyFor(PER_SHEET - 1, 0))
    let fires = 0
    wb.store.sub(tail, () => {
      fires += 1
    })

    // Closed form: each sheet adds PER_SHEET increments → tail = 10×3k.
    expect(wb.store.getter(tail)).toEqual(num(SHEETS * PER_SHEET))
    // Cross-sheet eval-count semantics: the counter belongs to the sheet
    // owning the ANCHOR derive. Transitive foreign-sheet frames evaluated
    // inside the same trampoline run bump nothing.
    expect(wb.debugFormulaEvalCount(SHEETS - 1)).toBe(1)
    for (let k = 0; k < SHEETS - 1; k += 1) expect(wb.debugFormulaEvalCount(k)).toBe(0)

    // Edit the SOURCE sheet's head (Δ = +10): the dirty BFS crosses all
    // 10 sheets through the workbook DepGraph; the tail (the only cached
    // derive) re-runs exactly once and its subscriber fires exactly once.
    wb.setCell('s0', 0, 0, '11')
    expect(wb.store.getter(tail)).toEqual(num(SHEETS * PER_SHEET + 10))
    expect(wb.debugFormulaEvalCount(SHEETS - 1)).toBe(2)
    expect(fires).toBe(1)
    // NOTE: the Rust A-6 sub-assert ("remove unrelated sheet → subscribers
    // still fire") has no TS twin — the TS workbook has no removeSheet op.
  })
})

// ---------------------------------------------------------------------------
// S7 — Structural at scale (TS scope)
// ---------------------------------------------------------------------------
//
// VERDICT: the TS engine has NO insert/delete row/col primitives — those
// are worker-runtime concerns layered above this package. The structural
// primitive that exists at engine level is `clearRange` (audit D-1/C-4),
// so S7 pins: O(existing) touch counts, exact aggregate shifts, the
// empty-intersection no-op, and (the S7 essence) that a structural edit
// over LAZY formulas does NOT hydrate the dep graph.

describe('S7 — clearRange at scale (TS structural scope; no insert/delete row ops)', () => {
  test('50k cells + whole-col SUM: band clear touches exactly the band, one re-eval', () => {
    const N = 50_000
    const wb = makeWb()
    const sheet = wb.sheet('s1')!
    const cells: BulkCellInput[] = new Array(N)
    for (let i = 0; i < N; i += 1) {
      cells[i] = { row: i, col: 0, input: String(i + 1) } // A: 1..N
    }
    wb.bulkApply('s1', cells)
    wb.setCell('s1', 0, 1, '=SUM(A:A)')
    const sum = sheet.formulaCellAtom(keyFor(0, 1))
    const TOTAL = (N * (N + 1)) / 2
    expect(wb.store.getter(sum)).toEqual(num(TOTAL))
    expect(wb.debugFormulaEvalCount(0)).toBe(1)

    // Clear the middle band rows 12 500..37 499 → exactly 25 000 existing
    // cells touched; the aggregate re-derives exactly ONCE (one postWrite
    // batch), and the sum drops by SUM(12501..37500) closed form.
    const cleared = wb.clearRange(
      's1',
      { rowStart: 12_500, rowEnd: 37_499, colStart: 0, colEnd: 0 },
      'all',
    )
    expect(cleared).toBe(25_000)
    expect(wb.debugFormulaEvalCount(0)).toBe(2)
    const BAND = ((12_501 + 37_500) * 25_000) / 2
    expect(wb.store.getter(sum)).toEqual(num(TOTAL - BAND))

    // Empty intersection → 0 touched, NO propagation: no re-eval, no
    // revision bump (clearing blanks is a value no-op).
    const revBefore = wb.store.getter(sheet.revisionAtom)
    expect(
      wb.clearRange('s1', { rowStart: 500_000, rowEnd: 900_000, colStart: 0, colEnd: 50 }, 'all'),
    ).toBe(0)
    expect(wb.debugFormulaEvalCount(0)).toBe(2)
    expect(wb.store.getter(sheet.revisionAtom)).toBe(revBefore)

    // Whole-column clear at max row bounds (rowEnd 1 048 575): walks the
    // live map, O(existing) — touches exactly the 25 000 survivors.
    const wholeCol = wb.clearRange(
      's1',
      { rowStart: 0, rowEnd: 1_048_575, colStart: 0, colEnd: 0 },
      'all',
    )
    expect(wholeCol).toBe(25_000)
    expect(wb.debugFormulaEvalCount(0)).toBe(3)
    expect(wb.store.getter(sum)).toEqual(num(0))
  })

  test('structural edit over 100k LAZY formulas keeps the dep graph at 0 (no hydration)', () => {
    const N = 100_000
    const wb = makeWb()
    wb.setCell('s1', 0, 0, '1') // A1
    const cells: BulkCellInput[] = new Array(N)
    for (let i = 0; i < N; i += 1) {
      cells[i] = { row: 1 + Math.floor(i / 1000), col: i % 1000, input: `=A1+${i}` }
    }
    wb.bulkApply('s1', cells)
    // Never read → never hydrated: zero dep-graph keys, zero evals.
    expect(wb.debugDepGraphStats()).toEqual({
      installed: 0,
      pointKeys: 0,
      rangeEntries: 0,
      broad: 0,
    })

    // Structural clear of half the formula band: still zero hydration,
    // zero evals — laziness preserved through the structural edit.
    const cleared = wb.clearRange(
      's1',
      { rowStart: 1, rowEnd: 50, colStart: 0, colEnd: 999 },
      'all',
    )
    expect(cleared).toBe(50_000)
    expect(wb.debugFormulaEvalCount(0)).toBe(0)
    expect(wb.debugDepGraphStats()).toEqual({
      installed: 0,
      pointKeys: 0,
      rangeEntries: 0,
      broad: 0,
    })
    // Survivors still evaluate correctly on first read (closed form).
    const sheet = wb.sheet('s1')!
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(51, 0)))).toEqual(num(1 + 50_000))
  })
})

// ---------------------------------------------------------------------------
// S8 — Churn / leak (6k create → overwrite → clear, twice)
// ---------------------------------------------------------------------------

describe('S8 — churn 6k: derives/dep-edges return to baseline; epochs plateau by design', () => {
  test('two churn rounds: no unbounded growth in any parallel table', () => {
    const N = 6_000
    const wb = makeWb()
    const sheet = wb.sheet('s1')!
    wb.setCell('s1', 0, 0, '1') // A1 — every formula's dep
    const at = (i: number) => keyFor(1 + Math.floor(i / 1000), i % 1000)

    const churnRound = (round: number) => {
      const cells: BulkCellInput[] = new Array(N)
      for (let i = 0; i < N; i += 1) {
        cells[i] = { row: 1 + Math.floor(i / 1000), col: i % 1000, input: `=A1+${round}*${i}` }
      }
      wb.bulkApply('s1', cells)
      for (let i = 0; i < N; i += 1) wb.store.getter(sheet.formulaCellAtom(at(i)))
      // Fully hydrated: N derives, N installed formulas, ONE depended-on
      // coordinate (A1) in the point index.
      expect(sheet._internal.debugAtomCounts().derives).toBe(N)
      expect(wb.debugDepGraphStats()).toEqual({
        installed: N,
        pointKeys: 1,
        rangeEntries: 0,
        broad: 0,
      })
      // Closed-form spot check: cell i = 1 + round*i.
      expect(wb.store.getter(sheet.formulaCellAtom(at(N - 1)))).toEqual(num(1 + round * (N - 1)))

      // Overwrite EVERY formula with a literal → C-6 eviction at scale.
      const overwrite: BulkCellInput[] = new Array(N)
      for (let i = 0; i < N; i += 1) {
        overwrite[i] = { row: 1 + Math.floor(i / 1000), col: i % 1000, input: '7' }
      }
      wb.bulkApply('s1', overwrite)
      expect(sheet._internal.debugAtomCounts().derives).toBe(0)
      expect(wb.debugDepGraphStats()).toEqual({
        installed: 0,
        pointKeys: 0,
        rangeEntries: 0,
        broad: 0,
      })

      // Clear the literals → storage back to just A1.
      wb.clearRange('s1', { rowStart: 1, rowEnd: 7, colStart: 0, colEnd: 999 }, 'all')
      expect(wb.store.getter(sheet.sheetAtom).size).toBe(1)
    }

    churnRound(1)
    const evalsAfterRound1 = wb.debugFormulaEvalCount(0)
    const epochsAfterRound1 = sheet._internal.debugAtomCounts().epochs
    // Epoch atoms are RETAINED across eviction by design (codex P1 #1 /
    // f8e6d8c): one per distinct address ever read.
    expect(epochsAfterRound1).toBe(N)

    // A write to a dead-formula address after churn re-derives NOTHING.
    wb.setCell('s1', 1, 0, '5')
    expect(wb.debugFormulaEvalCount(0)).toBe(evalsAfterRound1)
    wb.clearCell('s1', 1, 0, 'all')

    // Round 2 over the SAME addresses: epochs are REUSED, not re-grown —
    // the retained-epoch table plateaus at the high-water mark instead of
    // growing without bound under churn.
    churnRound(2)
    expect(sheet._internal.debugAtomCounts().epochs).toBe(epochsAfterRound1)
    expect(sheet._internal.debugAtomCounts().derives).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// S9 — Install/restore roundtrip 200k (TS: full-replace)
// ---------------------------------------------------------------------------

describe('S9 — full-replace roundtrip 200k: no residue, restore stays lazy', () => {
  // eslint-disable-next-line max-len
  test('replace 200k content: dep stats 0 after restore, closed-form equality, old keys gone', () => {
    const N = 200_000
    const COLS = 200
    const wb = makeWb()
    const sheet = wb.sheet('s1')!

    // Content A: value at (r, c) = r*COLS + c, plus a marker cell and a
    // whole-column aggregate that we READ (so the teardown has real
    // hydrated state to tear down).
    const contentA: BulkCellInput[] = new Array(N)
    for (let i = 0; i < N; i += 1) {
      contentA[i] = { row: Math.floor(i / COLS), col: i % COLS, input: String(i) }
    }
    wb.bulkApply('s1', contentA)
    wb.setCell('s1', 2_000, 0, '999') // marker: exists ONLY in content A
    wb.setCell('s1', 0, 500, '=SUM(A:A)')
    // Closed form: col 0 holds i = r*COLS at rows 0..999 plus the marker:
    // SUM = COLS * (999*1000/2) + 999.
    const sumA = (COLS * (999 * 1000)) / 2 + 999
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(0, 500)))).toEqual(num(sumA))
    expect(wb.debugDepGraphStats().installed).toBe(1)

    // Full-replace teardown: ONE clearRange pass over the whole sheet.
    const cleared = wb.clearRange(
      's1',
      { rowStart: 0, rowEnd: 1_048_575, colStart: 0, colEnd: 16_383 },
      'all',
    )
    expect(cleared).toBe(N + 2) // 200k + marker + the SUM formula
    expect(wb.store.getter(sheet.sheetAtom).size).toBe(0)
    // Hydrated state from the PREVIOUS content is fully torn down.
    expect(wb.debugDepGraphStats()).toEqual({
      installed: 0,
      pointKeys: 0,
      rangeEntries: 0,
      broad: 0,
    })
    expect(sheet._internal.debugAtomCounts().derives).toBe(0)

    // Content B: value at (r, c) = 2*(r*COLS + c) + 1, plus 100 formulas
    // that stay UNREAD — restore must leave them lazy.
    const contentB: BulkCellInput[] = new Array(N)
    for (let i = 0; i < N; i += 1) {
      contentB[i] = { row: Math.floor(i / COLS), col: i % COLS, input: String(2 * i + 1) }
    }
    for (let k = 0; k < 100; k += 1) {
      contentB.push({ row: 5_000 + k, col: 0, input: `=B1+${k}` })
    }
    const evalsBefore = wb.debugFormulaEvalCount(0)
    wb.bulkApply('s1', contentB)
    // Restore is LAZY: nothing evaluated, nothing hydrated.
    expect(wb.debugFormulaEvalCount(0)).toBe(evalsBefore)
    expect(wb.debugDepGraphStats().installed).toBe(0)
    expect(wb.store.getter(sheet.sheetAtom).size).toBe(N + 100)
    // No residue from content A: the marker key is gone.
    expect(wb.store.getter(sheet.sheetAtom).has(keyFor(2_000, 0))).toBe(false)
    // Sampled closed-form equality over content B (seeded LCG).
    const cellsNow = wb.store.getter(sheet.sheetAtom)
    const rand = lcg(0x5EED5)
    for (let k = 0; k < 64; k += 1) {
      const i = rand() % N
      const cell = cellsNow.get(keyFor(Math.floor(i / COLS), i % COLS))!
      expect(cell.value).toEqual(num(2 * i + 1))
    }
  })
})

// ---------------------------------------------------------------------------
// S10 — Boundary: max coordinates, max-width ops, dimension guards
// ---------------------------------------------------------------------------

describe('S10 — boundary: XFD1048576, max-width whole-row ops, 16384-col guards', () => {
  test('refs at the last cell work; out-of-bounds refs are #REF!; SEQUENCE width guard', () => {
    const wb = makeWb()
    const sheet = wb.sheet('s1')!
    // The very last addressable cell: XFD1048576 == (row 1048575, col 16383).
    wb.setCell('s1', 1_048_575, 16_383, '42')
    wb.setCell('s1', 0, 0, '=XFD1048576')
    const ref = sheet.formulaCellAtom(keyFor(0, 0))
    expect(wb.store.getter(ref)).toEqual(num(42))
    // Edit at the boundary propagates: exactly one re-derive.
    wb.setCell('s1', 1_048_575, 16_383, '43')
    expect(wb.debugFormulaEvalCount(0)).toBe(2)
    expect(wb.store.getter(ref)).toEqual(num(43))

    // One past the edge in either dimension → #REF! (no panic).
    wb.setCell('s1', 1, 0, '=XFE1') // col 16384
    wb.setCell('s1', 2, 0, '=A1048577') // row 1048576
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(1, 0)))).toMatchObject({
      kind: 'error',
      code: '#REF!',
    })
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(2, 0)))).toMatchObject({
      kind: 'error',
      code: '#REF!',
    })

    // Spilling wider than the sheet (16385 cols) → #NUM!, bounded work.
    wb.setCell('s1', 3, 0, '=SEQUENCE(1,16385)')
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(3, 0)))).toMatchObject({
      kind: 'error',
      code: '#NUM!',
    })
  })

  test('whole-row aggregate + whole-row clearRange at max width touch O(existing)', () => {
    const K = 100
    const wb = makeWb()
    const sheet = wb.sheet('s1')!
    // K cells spread across the full 16384-col width of row 1 (stride 163).
    const cells: BulkCellInput[] = new Array(K)
    for (let j = 0; j < K; j += 1) {
      cells[j] = { row: 0, col: j * 163, input: String(j + 1) }
    }
    wb.bulkApply('s1', cells)
    wb.setCell('s1', 1, 0, '=SUM(1:1)')
    const sum = sheet.formulaCellAtom(keyFor(1, 0))
    // Closed form: SUM(1..K) = K(K+1)/2 = 5050.
    expect(wb.store.getter(sum)).toEqual(num(5050))
    expect(wb.debugFormulaEvalCount(0)).toBe(1)

    // Whole-row clear at max width (colEnd 16383): walks the live map —
    // touches exactly the K existing row-0 cells, never 16384 coords.
    const cleared = wb.clearRange(
      's1',
      { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 16_383 },
      'all',
    )
    expect(cleared).toBe(K)
    // The wide-range dependent re-derives exactly once → empty sum.
    expect(wb.debugFormulaEvalCount(0)).toBe(2)
    expect(wb.store.getter(sum)).toEqual(num(0))
  })
})

// ---------------------------------------------------------------------------
// S11 — Mutation storm: 10k edits on a 200k sheet
// ---------------------------------------------------------------------------

describe('S11 — mutation storm 10k edits @ 200k cells: Σ re-evals == Σ true dependents', () => {
  test('total derive count == dependents touched (not 10k × cached); closed-form finals', () => {
    const CELLS = 200_000
    const FORMULAS = 1_000
    const EDITS = 10_000
    const wb = makeWb()
    const sheet = wb.sheet('s1')!
    const literals: BulkCellInput[] = new Array(CELLS)
    for (let i = 0; i < CELLS; i += 1) {
      literals[i] = { row: i, col: 0, input: String(i + 1) } // A: 1..200k
    }
    wb.bulkApply('s1', literals)
    // Formula j (col C, row j) depends on exactly ONE cell: A{200j+1}.
    const formulas: BulkCellInput[] = new Array(FORMULAS)
    for (let j = 0; j < FORMULAS; j += 1) {
      formulas[j] = { row: j, col: 2, input: `=A${j * 200 + 1}` }
    }
    wb.bulkApply('s1', formulas)
    for (let j = 0; j < FORMULAS; j += 1) {
      wb.store.getter(sheet.formulaCellAtom(keyFor(j, 2)))
    }
    expect(wb.debugFormulaEvalCount(0)).toBe(FORMULAS)

    // Storm: 10k single-cell edits, LCG-driven. Every 10th edit hits a
    // depended-on row (→ exactly 1 re-derive); the rest hit dep-free
    // rows (→ 0). Σ true dependents over the storm = EDITS / 10.
    const rand = lcg(0x511E57)
    const lastWritten = new Map<number, number>() // formula j → final dep value
    const evalsBefore = wb.debugFormulaEvalCount(0)
    const revBefore = wb.store.getter(sheet.revisionAtom)
    for (let k = 0; k < EDITS; k += 1) {
      if (k % 10 === 0) {
        const j = rand() % FORMULAS
        const value = 1_000_000 + k
        wb.setCell('s1', j * 200, 0, String(value))
        lastWritten.set(j, value)
      } else {
        // Dep-free row: any row ≢ 0 (mod 200) has no dependents.
        const r = (rand() % CELLS) | 1 // odd ⇒ never ≡ 0 (mod 200)
        wb.setCell('s1', r, 0, String(k))
      }
    }
    // THE storm contract: re-evals == Σ dependents-of-each-edit (1 per
    // depended-row edit, 0 per dep-free edit) — NOT EDITS × cached.
    expect(wb.debugFormulaEvalCount(0) - evalsBefore).toBe(EDITS / 10)
    // One revision bump per edit batch.
    expect(wb.store.getter(sheet.revisionAtom) - revBefore).toBe(EDITS)
    // Closed-form finals: formula j == last value written to its dep
    // (or its original A{200j+1} = 200j+1 if never hit).
    const sample = lcg(0xFACADE)
    for (let k = 0; k < 64; k += 1) {
      const j = sample() % FORMULAS
      const expected = lastWritten.get(j) ?? j * 200 + 1
      expect(wb.store.getter(sheet.formulaCellAtom(keyFor(j, 2)))).toEqual(num(expected))
    }
  })
})

// ---------------------------------------------------------------------------
// S12 — Registry at scale (TS-lean)
// ---------------------------------------------------------------------------

describe('S12 — registry at scale: 1k names + 1k custom formulas in ONE batch', () => {
  test('one broad invalidation over 100k formulas (5k cached); throw-rollback at scale', () => {
    const FORMULAS = 100_000
    const READ = 5_000
    const wb = makeWb()
    const sheet = wb.sheet('s1')!
    // Registry baseline BEFORE the formulas exist (cheap recalcs).
    wb.defineName('BASE', { kind: 'value', value: num(1) })
    wb.registerCustomFormula('SCALEFN', (args) => {
      const v = args[0]
      return v.kind === 'number' ? num(3 * v.value) : { kind: 'error', code: '#VALUE!' }
    })
    // 100k formulas referencing the registry: even i → =BASE+i (closed
    // form BASE+i), odd i → =SCALEFN(i) (closed form 3i).
    const cells: BulkCellInput[] = new Array(FORMULAS)
    for (let i = 0; i < FORMULAS; i += 1) {
      cells[i] = {
        row: Math.floor(i / 1000),
        col: i % 1000,
        input: i % 2 === 0 ? `=BASE+${i}` : `=SCALEFN(${i})`,
      }
    }
    wb.bulkApply('s1', cells)
    const atomOf = (i: number) => sheet.formulaCellAtom(keyFor(Math.floor(i / 1000), i % 1000))
    for (let i = 0; i < READ; i += 1) wb.store.getter(atomOf(i))
    expect(wb.debugFormulaEvalCount(0)).toBe(READ)
    expect(wb.store.getter(atomOf(4_998))).toEqual(num(1 + 4_998))
    expect(wb.store.getter(atomOf(4_999))).toEqual(num(3 * 4_999))

    // ONE withBatch carrying 2001 registry mutations → exactly ONE broad
    // invalidation: each cached formula re-derives ONCE (== READ, not
    // READ × 2001), and the workbook revision advances by exactly 1.
    const evalsBefore = wb.debugFormulaEvalCount(0)
    const revBefore = wb.store.getter(sheet.revisionAtom)
    wb.withBatch(() => {
      for (let k = 0; k < 1_000; k += 1) {
        wb.defineName(`NAME_${k}`, { kind: 'value', value: num(k) })
        wb.registerCustomFormula(`FN_${k}`, () => num(k))
      }
      wb.defineName('BASE', { kind: 'value', value: num(1_001) })
    })
    expect(wb.debugFormulaEvalCount(0) - evalsBefore).toBe(READ)
    expect(wb.store.getter(sheet.revisionAtom) - revBefore).toBe(1)
    // Lookups correct after the batch: BASE formulas shifted by +1000.
    expect(wb.store.getter(atomOf(4_998))).toEqual(num(1_001 + 4_998))
    expect(wb.store.getter(atomOf(4_999))).toEqual(num(3 * 4_999))
    wb.setCell('s1', 200, 0, '=NAME_999+FN_42()')
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(200, 0)))).toEqual(num(999 + 42))

    // Throw-rollback at the same scale (audit C-5): the batch aborts for
    // real — zero re-derives, zero revision movement, registries restored.
    const evalsBeforeAbort = wb.debugFormulaEvalCount(0)
    const revBeforeAbort = wb.store.getter(sheet.revisionAtom)
    expect(() =>
      wb.withBatch(() => {
        for (let k = 0; k < 1_000; k += 1) {
          wb.defineName(`GHOST_${k}`, { kind: 'value', value: num(k) })
        }
        wb.defineName('BASE', { kind: 'value', value: num(5) })
        throw new Error('host abort')
      }),
    ).toThrow('host abort')
    expect(wb.debugFormulaEvalCount(0)).toBe(evalsBeforeAbort)
    expect(wb.store.getter(sheet.revisionAtom)).toBe(revBeforeAbort)
    // BASE rolled back to 1001 — cached derives stay consistent.
    expect(wb.store.getter(atomOf(4_998))).toEqual(num(1_001 + 4_998))
    // The ghost names never existed.
    wb.setCell('s1', 201, 0, '=GHOST_500')
    expect(wb.store.getter(sheet.formulaCellAtom(keyFor(201, 0)))).toMatchObject({
      kind: 'error',
      code: '#NAME?',
    })
  })
})

// ---------------------------------------------------------------------------
// Cycle at scale (95ef444 P1 #2 contract at suite scale)
// ---------------------------------------------------------------------------
//
// Ring sized to 384 (not the plan's 1k): with every member's derive
// cached, each read/re-derive walks the ring inside its own trampoline
// run (run-local cache) → O(N²) work by design, same sizing rationale as
// S1b. The CONTRACT asserted — break one member ⇒ re-derive count ==
// cycle size, not 0 — is size-independent.

describe('cycle at scale — 384-member ring: all #CIRCULAR!, break ⇒ all re-derive', () => {
  test('ring reads are #CIRCULAR!; breaking one member re-derives the whole ring', () => {
    const N = 384
    const wb = makeWb()
    const sheet = wb.sheet('s1')!
    // Ring: A{i} = A{i+1} for i < N, A{N} = A1 (1-based A1 refs).
    const cells: BulkCellInput[] = new Array(N)
    for (let i = 0; i < N - 1; i += 1) {
      cells[i] = { row: i, col: 0, input: `=A${i + 2}` }
    }
    cells[N - 1] = { row: N - 1, col: 0, input: '=A1' }
    wb.bulkApply('s1', cells)

    // Read every member once: ALL are #CIRCULAR! (each read is its own
    // derive run → eval count == N exactly).
    for (let i = 0; i < N; i += 1) {
      expect(wb.store.getter(sheet.formulaCellAtom(keyFor(i, 0)))).toMatchObject({
        kind: 'error',
        code: '#CIRCULAR!',
      })
    }
    expect(wb.debugFormulaEvalCount(0)).toBe(N)

    // Break the ring at one member: every OTHER member is a transitive
    // dependent (cycle-cached formulas installed their reverse edges —
    // codex P1 #2), so exactly N-1 cached derives re-run — not 0, and
    // not 2×. The broken member becomes a literal (no derive eval).
    const BREAK_AT = 300 // 0-based row; cell A301 ← literal 7
    const evalsBefore = wb.debugFormulaEvalCount(0)
    wb.setCell('s1', BREAK_AT, 0, '7')
    expect(wb.debugFormulaEvalCount(0) - evalsBefore).toBe(N - 1)
    // Closed form: every surviving member now reads straight through the
    // ring to the literal → ALL equal 7.
    const rand = lcg(0xC1C1E)
    for (let k = 0; k < 32; k += 1) {
      let i = rand() % N
      if (i === BREAK_AT) i = (i + 1) % N
      expect(wb.store.getter(sheet.formulaCellAtom(keyFor(i, 0)))).toEqual(num(7))
    }
  })
})
