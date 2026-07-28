/**
 * Wave F — recursive LAMBDA support.
 *
 * Verifies the two pieces that together unlock Excel-style recursive
 * LAMBDA:
 *
 *   1. Lazy `IF` in `evaluate.ts`'s `'call'` arm. Only the chosen branch
 *      is evaluated, so `FACT(n) = IF(n<=1, 1, n*FACT(n-1))` doesn't
 *      recurse into the unreachable else-branch on the base case.
 *
 *   2. A LAMBDA-call depth guard (`MAX_LAMBDA_CALL_DEPTH`) on
 *      `EvalContext.lambdaCallDepth`. A pathological non-terminating
 *      recursion surfaces `#NUM!` instead of throwing
 *      `RangeError: Maximum call stack size exceeded`.
 *
 * Plus a `#CALC!` check for bare-LAMBDA-no-call — paired with this work
 * because both turn on real Excel parity for the LAMBDA story.
 *
 * Fixtures match the AGENT_COLLABORATION acceptance list (FACT, FIB,
 * mutual recursion EVEN/ODD, runaway recursion, bare-LAMBDA `#CALC!`).
 */

import { describe, expect, test } from '@jest/globals'

import { createWorkbook } from '../src/workbook'
import type { Expr, Value } from '../src/types'

// -----------------------------------------------------------------------------
// AST helpers (kept inline so this file is self-contained for review)
// -----------------------------------------------------------------------------

const num = (v: number): Expr => ({ kind: 'number', value: v })
const nameRef = (n: string): Expr => ({ kind: 'name', name: n })
const callExpr = (n: string, ...args: Expr[]): Expr => ({
  kind: 'call',
  name: n,
  args,
})
const bin = (op: '+' | '-' | '*' | '<' | '<=' | '=' | '>'): (l: Expr, r: Expr) => Expr =>
  (left, right) => ({ kind: 'binary', op, left, right })
const sub = bin('-')
const mul = bin('*')
const add = bin('+')
const lte = bin('<=')
const lt = bin('<')
const eq = bin('=')

function readA1(wb: ReturnType<typeof createWorkbook>, sheetId: string, row = 0, col = 0): Value {
  const sheet = wb.sheet(sheetId)!
  return wb.store.getter(sheet.formulaCellAtom(`${row}:${col}`))
}

// FACT(n) = IF(n<=1, 1, n * FACT(n-1))
function defineFact(wb: ReturnType<typeof createWorkbook>): void {
  wb.defineName('FACT', {
    kind: 'lambda',
    params: ['n'],
    body: callExpr(
      'IF',
      lte(nameRef('n'), num(1)),
      num(1),
      mul(nameRef('n'), callExpr('FACT', sub(nameRef('n'), num(1)))),
    ),
  })
}

// FIB(n) = IF(n<2, n, FIB(n-1) + FIB(n-2))
function defineFib(wb: ReturnType<typeof createWorkbook>): void {
  wb.defineName('FIB', {
    kind: 'lambda',
    params: ['n'],
    body: callExpr(
      'IF',
      lt(nameRef('n'), num(2)),
      nameRef('n'),
      add(
        callExpr('FIB', sub(nameRef('n'), num(1))),
        callExpr('FIB', sub(nameRef('n'), num(2))),
      ),
    ),
  })
}

// -----------------------------------------------------------------------------
// FACT
// -----------------------------------------------------------------------------

describe('recursive LAMBDA: FACT(n)', () => {
  test('FACT(0) = 1 (base case taken immediately)', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    defineFact(wb)
    wb.setCell('s1', 0, 0, '=FACT(0)')
    expect(readA1(wb, 's1')).toEqual({ kind: 'number', value: 1 })
  })

  test('FACT(1) = 1', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    defineFact(wb)
    wb.setCell('s1', 0, 0, '=FACT(1)')
    expect(readA1(wb, 's1')).toEqual({ kind: 'number', value: 1 })
  })

  test('FACT(5) = 120', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    defineFact(wb)
    wb.setCell('s1', 0, 0, '=FACT(5)')
    expect(readA1(wb, 's1')).toEqual({ kind: 'number', value: 120 })
  })

  test('FACT(10) = 3628800', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    defineFact(wb)
    wb.setCell('s1', 0, 0, '=FACT(10)')
    expect(readA1(wb, 's1')).toEqual({ kind: 'number', value: 3628800 })
  })
})

// -----------------------------------------------------------------------------
// FIB
// -----------------------------------------------------------------------------

describe('recursive LAMBDA: FIB(n) — tree recursion', () => {
  test('FIB(0) = 0', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    defineFib(wb)
    wb.setCell('s1', 0, 0, '=FIB(0)')
    expect(readA1(wb, 's1')).toEqual({ kind: 'number', value: 0 })
  })

  test('FIB(1) = 1', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    defineFib(wb)
    wb.setCell('s1', 0, 0, '=FIB(1)')
    expect(readA1(wb, 's1')).toEqual({ kind: 'number', value: 1 })
  })

  test('FIB(10) = 55', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    defineFib(wb)
    wb.setCell('s1', 0, 0, '=FIB(10)')
    expect(readA1(wb, 's1')).toEqual({ kind: 'number', value: 55 })
  })
})

// -----------------------------------------------------------------------------
// Mutual recursion: EVEN(n) ↔ ODD(n)
// -----------------------------------------------------------------------------

describe('mutual recursion: EVEN/ODD', () => {
  // EVEN(n) = IF(n=0, TRUE, ODD(n-1))
  // ODD(n)  = IF(n=0, FALSE, EVEN(n-1))
  function defineEvenOdd(wb: ReturnType<typeof createWorkbook>): void {
    wb.defineName('EVEN_N', {
      kind: 'lambda',
      params: ['n'],
      body: callExpr(
        'IF',
        eq(nameRef('n'), num(0)),
        { kind: 'boolean', value: true },
        callExpr('ODD_N', sub(nameRef('n'), num(1))),
      ),
    })
    wb.defineName('ODD_N', {
      kind: 'lambda',
      params: ['n'],
      body: callExpr(
        'IF',
        eq(nameRef('n'), num(0)),
        { kind: 'boolean', value: false },
        callExpr('EVEN_N', sub(nameRef('n'), num(1))),
      ),
    })
  }

  test('EVEN_N(4) = TRUE', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    defineEvenOdd(wb)
    wb.setCell('s1', 0, 0, '=EVEN_N(4)')
    expect(readA1(wb, 's1')).toEqual({ kind: 'boolean', value: true })
  })

  test('ODD_N(7) = TRUE', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    defineEvenOdd(wb)
    wb.setCell('s1', 0, 0, '=ODD_N(7)')
    expect(readA1(wb, 's1')).toEqual({ kind: 'boolean', value: true })
  })

  test('EVEN_N(5) = FALSE', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    defineEvenOdd(wb)
    wb.setCell('s1', 0, 0, '=EVEN_N(5)')
    expect(readA1(wb, 's1')).toEqual({ kind: 'boolean', value: false })
  })
})

// -----------------------------------------------------------------------------
// Stack-overflow guard
// -----------------------------------------------------------------------------

describe('stack-overflow guard', () => {
  test('non-terminating recursion surfaces #NUM!, not RangeError', () => {
    // BAD(n) = BAD(n) — no base case at all.
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('BAD', {
      kind: 'lambda',
      params: ['n'],
      body: callExpr('BAD', nameRef('n')),
    })
    wb.setCell('s1', 0, 0, '=BAD(1)')
    // The depth guard catches the runaway recursion before the JS stack
    // is exhausted; the result is a sensible #NUM! envelope rather than
    // a thrown RangeError.
    expect(() => {
      const v = readA1(wb, 's1')
      expect(v.kind).toBe('error')
      if (v.kind === 'error') {
        // #NUM! is Excel's overflow code; #CALC! would also be acceptable.
        expect(['#NUM!', '#CALC!']).toContain(v.code)
      }
    }).not.toThrow()
  })

  test('FACT with a large (still terminating) input stays within the depth budget', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    defineFact(wb)
    // 20! = 2,432,902,008,176,640,000 — safely within IEEE-754 doubles.
    wb.setCell('s1', 0, 0, '=FACT(20)')
    expect(readA1(wb, 's1')).toEqual({ kind: 'number', value: 2432902008176640000 })
  })
})

// -----------------------------------------------------------------------------
// #CALC! for bare LAMBDA
// -----------------------------------------------------------------------------

describe('bare LAMBDA name → #CALC!', () => {
  test('=FACT (with no call parens) surfaces #CALC!', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    defineFact(wb)
    wb.setCell('s1', 0, 0, '=FACT')
    const v = readA1(wb, 's1')
    expect(v.kind).toBe('error')
    if (v.kind === 'error') {
      expect(v.code).toBe('#CALC!')
      expect(v.message ?? '').toContain('LAMBDA')
    }
  })
})
