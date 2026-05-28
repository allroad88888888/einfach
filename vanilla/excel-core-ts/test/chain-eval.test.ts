/**
 * Chain-eval regression tests for the cross-cell trampoline introduced
 * in `eval/evaluate.ts` (see `evaluateCellTrampolined`).
 *
 * Before the trampoline, a formula chain of the form
 *   A1 = 1
 *   A2 = A1 + 1
 *   …
 *   A1000 = A999 + 1
 * blew V8's default ~1 MB JS call stack at ~1000 cells because every
 * `ref` lookup recursed through `evaluate → refLookupGeneric →
 * resolveCell → evaluate`. The trampoline flattens the cross-cell
 * recursion onto an explicit work stack, so chains of 100k+ now
 * resolve.
 *
 * These tests verify:
 *  - depths of 100 / 1k / 10k / 100k all evaluate correctly
 *  - the chain composes with `IF` (which short-circuits at AST level)
 *  - cycles still surface `#CIRCULAR!` (no regression in cycle
 *    detection now that it lives in the trampoline's `inProgress`
 *    set instead of `currentlyEvaluating`)
 *  - mutating the root re-flows through the chain
 *  - range-based chains (`=SUM(B1:B100)`) work
 *
 * Performance: depths up to 100k run in well under the 30 s jest
 * default timeout on a 2024 laptop; we still set explicit timeouts so
 * a slow CI box doesn't silently truncate the chain.
 */

import { describe, expect, test } from '@jest/globals'

import { createWorkbook } from '../src/workbook'
import { keyFor } from '../src/sheet'
import type { Value } from '../src/types'

// Build A1=1, A2=A1+1, …, A{depth}=A{depth-1}+1 and return the address
// of the deepest cell (0-indexed row).
function buildChain(wb: ReturnType<typeof createWorkbook>, sheetId: string, depth: number): string {
  // bulkApply for speed — 100k sequential setCell calls is slow because
  // every call clones the Map.
  const cells: Array<{ row: number; col: number; input: string }> = [
    { row: 0, col: 0, input: '1' },
  ]
  for (let row = 1; row < depth; row += 1) {
    // Excel addressing: row 0 = A1, so A(row+1) refers to row=row.
    // The cell at row=row references row=row-1, which is A(row).
    cells.push({ row, col: 0, input: `=A${row}+1` })
  }
  wb.bulkApply(sheetId, cells)
  return keyFor(depth - 1, 0)
}

function readNumber(value: Value): number {
  expect(value.kind).toBe('number')
  if (value.kind !== 'number') throw new Error('expected number')
  return value.value
}

describe('chain-eval — deep cross-cell dependency chains', () => {
  test('Chain100: A100 = 100 (sanity)', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const lastKey = buildChain(wb, 's1', 100)
    const atom = wb.sheet('s1')!.formulaCellAtom(lastKey)
    expect(readNumber(wb.store.getter(atom))).toBe(100)
  })

  test(
    'Chain1k: A1000 = 1000 (pre-fix this blew V8\'s stack)',
    () => {
      const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
      const lastKey = buildChain(wb, 's1', 1_000)
      const atom = wb.sheet('s1')!.formulaCellAtom(lastKey)
      const start = Date.now()
      const value = wb.store.getter(atom)
      const ms = Date.now() - start
      // eslint-disable-next-line no-process-env
      if (process.env.EINFACH_CHAIN_LOG) {
        // Intentionally use process.stderr to bypass the no-console rule
        // while still surfacing the perf number when explicitly opted in.
        process.stderr.write(`chain1k: ${ms}ms\n`)
      }
      expect(readNumber(value)).toBe(1_000)
    },
    30_000,
  )

  test(
    'Chain10k: A10000 = 10000',
    () => {
      const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
      const lastKey = buildChain(wb, 's1', 10_000)
      const atom = wb.sheet('s1')!.formulaCellAtom(lastKey)
      const start = Date.now()
      const value = wb.store.getter(atom)
      const ms = Date.now() - start
      // eslint-disable-next-line no-process-env
      if (process.env.EINFACH_CHAIN_LOG) {
        process.stderr.write(`chain10k: ${ms}ms\n`)
      }
      expect(readNumber(value)).toBe(10_000)
    },
    60_000,
  )

  test(
    'Chain100k: A100000 = 100000',
    () => {
      const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
      const lastKey = buildChain(wb, 's1', 100_000)
      const atom = wb.sheet('s1')!.formulaCellAtom(lastKey)
      const start = Date.now()
      const value = wb.store.getter(atom)
      const ms = Date.now() - start
      // eslint-disable-next-line no-process-env
      if (process.env.EINFACH_CHAIN_LOG) {
        process.stderr.write(`chain100k: ${ms}ms\n`)
      }
      expect(readNumber(value)).toBe(100_000)
    },
    300_000,
  )

  test('cycle: A1=A2, A2=A1 → #CIRCULAR! on both reads', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '=A2')
    wb.setCell('s1', 1, 0, '=A1')
    const a1 = wb.sheet('s1')!.formulaCellAtom('0:0')
    const a2 = wb.sheet('s1')!.formulaCellAtom('1:0')
    const v1 = wb.store.getter(a1)
    const v2 = wb.store.getter(a2)
    expect(v1).toEqual({ kind: 'error', code: '#CIRCULAR!' })
    expect(v2).toEqual({ kind: 'error', code: '#CIRCULAR!' })
  })

  test('cycle inside a deep chain: A1=A1000, A2=A1+1 … A1000=A999+1 → #CIRCULAR!', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    // First build the chain normally.
    const cells: Array<{ row: number; col: number; input: string }> = [
      { row: 0, col: 0, input: '=A1000' }, // A1 references A1000 (closes the loop)
    ]
    for (let row = 1; row < 1000; row += 1) {
      cells.push({ row, col: 0, input: `=A${row}+1` })
    }
    wb.bulkApply('s1', cells)
    const atom = wb.sheet('s1')!.formulaCellAtom(keyFor(999, 0))
    // The chain has no base case → the trampoline must report
    // #CIRCULAR! rather than blow the stack or hang.
    const value = wb.store.getter(atom)
    expect(value.kind).toBe('error')
    if (value.kind === 'error') expect(value.code).toBe('#CIRCULAR!')
  })

  test('mutation: building chain then mutating A1 re-flows the value', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const lastKey = buildChain(wb, 's1', 100)
    const atom = wb.sheet('s1')!.formulaCellAtom(lastKey)
    expect(readNumber(wb.store.getter(atom))).toBe(100)
    // Bump A1 from 1 → 11. Chain length stays 100 → A100 = 110.
    wb.setCell('s1', 0, 0, '11')
    expect(readNumber(wb.store.getter(atom))).toBe(110)
  })

  test('range-based chain: A1 = SUM(B1:B100), B1..B100 = 1..100 → 5050', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const cells: Array<{ row: number; col: number; input: string }> = []
    for (let row = 0; row < 100; row += 1) {
      cells.push({ row, col: 1, input: String(row + 1) })
    }
    cells.push({ row: 0, col: 0, input: '=SUM(B1:B100)' })
    wb.bulkApply('s1', cells)
    const atom = wb.sheet('s1')!.formulaCellAtom('0:0')
    expect(readNumber(wb.store.getter(atom))).toBe(5050)
  })

  test('range-of-formulas chain: A1 = SUM(B1:B100), B(k) = B(k-1)+1 → 5050', () => {
    // B1 is the seed, B2..B100 each reference the cell above.
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const cells: Array<{ row: number; col: number; input: string }> = [
      { row: 0, col: 1, input: '1' }, // B1 = 1
    ]
    for (let row = 1; row < 100; row += 1) {
      cells.push({ row, col: 1, input: `=B${row}+1` }) // B(row+1) = B(row)+1
    }
    cells.push({ row: 0, col: 0, input: '=SUM(B1:B100)' }) // A1
    wb.bulkApply('s1', cells)
    const atom = wb.sheet('s1')!.formulaCellAtom('0:0')
    // SUM(1, 2, …, 100) = 5050
    expect(readNumber(wb.store.getter(atom))).toBe(5050)
  })

  test('IF short-circuit preserved inside the trampoline (no spurious cycle)', () => {
    // A1 = IF(TRUE, 0, A2); A2 = A1. With short-circuit, A1 should
    // resolve to 0 — the else branch (A2) is never visited, so the
    // A2 → A1 → A2 cycle never triggers.
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '=IF(TRUE, 0, A2)')
    wb.setCell('s1', 1, 0, '=A1')
    const a1 = wb.sheet('s1')!.formulaCellAtom('0:0')
    const a2 = wb.sheet('s1')!.formulaCellAtom('1:0')
    expect(wb.store.getter(a1)).toEqual({ kind: 'number', value: 0 })
    expect(wb.store.getter(a2)).toEqual({ kind: 'number', value: 0 })
  })
})
