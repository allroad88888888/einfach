/**
 * Wave E / E3 — LAMBDA support inside the evaluator.
 *
 * Exercises the two new evaluator behaviors:
 *
 *  1. `EvalContext.lambdaScope` short-circuits `NameExpr` resolution so a
 *     parameter name shadows any workbook-level defined name. Verified by
 *     hand-built ASTs that feed the evaluator directly.
 *
 *  2. The `CallExpr` arm dispatches to `resolveName(...).kind === 'lambda'`
 *     after a built-in lookup miss. The body re-evaluates against a fresh
 *     sub-context whose `lambdaScope` maps each declared param to the
 *     call-site argument value. Verified by registering LAMBDA bindings
 *     via `Workbook.defineName(...)` and reading the resulting formula
 *     cell value.
 *
 * Each fixture pins one rule from `docs/ARCHITECTURE.md §9` or
 * `docs/PLAN.md §6 phase 6+7`. Rule-by-fixture:
 *
 *   - zero-arg LAMBDA → returns body value verbatim.
 *   - single-arg LAMBDA → `=DOUBLE(5)` → 10.
 *   - two-arg LAMBDA → `=ADD(2,3)` → 5.
 *   - nested call to a built-in inside the LAMBDA body → uses the engine
 *     registry, not the host registry.
 *   - LAMBDA recursively calling itself by name → returns `#CIRCULAR!`
 *     because cycle detection at the cell-derive level catches the
 *     re-entry into the same formula cell.
 *   - LAMBDA referenced by name without parens (bare `NameExpr`) →
 *     returns `#CALC!` with a diagnostic message (Excel parity — the
 *     calc engine cannot reduce a function value to a scalar).
 *
 * Plus a couple of scope-edge cases:
 *
 *   - LAMBDA param shadows a defined name (`X = 100` + `LAMBDA(x) = x+1`)
 *     resolves the param, not the workbook value.
 *   - Missing arg binds to BLANK inside the body (not undefined).
 */

import { describe, expect, test } from '@jest/globals'

import { createWorkbook } from '../src/workbook'
import { evaluate, rangeLookupGeneric, refLookupGeneric } from '../src/eval/evaluate'
import type { Cell, CellKey, EvalContext, Expr, Value } from '../src/types'

function makeCtx(
  cells: ReadonlyMap<CellKey, Cell> = new Map(),
  overrides: Partial<EvalContext> = {},
): EvalContext {
  const ctx: EvalContext = {
    cells,
    currentlyEvaluating: new Set(),
    refLookup: (a1) => refLookupGeneric(a1, cells, ctx),
    rangeLookup: (start, end) => rangeLookupGeneric(start, end, cells, ctx),
    crossSheetCells: () => undefined,
    callCustom: () => undefined,
    resolveName: () => undefined,
    ...overrides,
  }
  return ctx
}

function readCell(
  wb: ReturnType<typeof createWorkbook>,
  sheetId: string,
  row: number,
  col: number,
): Value {
  const sheet = wb.sheet(sheetId)!
  const a = sheet.formulaCellAtom(`${row}:${col}`)
  return wb.store.getter(a)
}

const num = (v: number): Expr => ({ kind: 'number', value: v })
const nameRef = (n: string): Expr => ({ kind: 'name', name: n })
const callExpr = (n: string, ...args: Expr[]): Expr => ({
  kind: 'call',
  name: n,
  args,
})

describe('LAMBDA scope (NameExpr resolution)', () => {
  test('lambdaScope short-circuits NameExpr — returns the scoped Value, not a workbook name', () => {
    // `resolveName` would return a number binding for 'X', but the
    // lambdaScope wins.
    const ctx = makeCtx(new Map(), {
      lambdaScope: new Map([['X', { kind: 'number', value: 999 } as Value]]),
      resolveName: (n) =>
        n === 'X' ? { kind: 'value', value: { kind: 'number', value: 1 } } : undefined,
    })
    expect(evaluate(nameRef('X'), ctx)).toEqual({ kind: 'number', value: 999 })
  })

  test('NameExpr without a lambdaScope entry falls through to resolveName', () => {
    const ctx = makeCtx(new Map(), {
      lambdaScope: new Map([['X', { kind: 'number', value: 1 } as Value]]),
      resolveName: (n) =>
        n === 'Y' ? { kind: 'value', value: { kind: 'number', value: 7 } } : undefined,
    })
    expect(evaluate(nameRef('Y'), ctx)).toEqual({ kind: 'number', value: 7 })
  })

  test('LAMBDA name referenced without parens surfaces #CALC!', () => {
    const ctx = makeCtx(new Map(), {
      resolveName: (n) =>
        n === 'F'
          ? { kind: 'lambda', params: ['x'], body: nameRef('x') }
          : undefined,
    })
    const res = evaluate(nameRef('F'), ctx)
    expect(res.kind).toBe('error')
    if (res.kind === 'error') {
      expect(res.code).toBe('#CALC!')
      expect(res.message).toContain('LAMBDA')
    }
  })
})

describe('LAMBDA dispatch via Workbook.defineName + formulaCellAtom', () => {
  test('zero-arg LAMBDA: MYK() returns 3.14 (uses a non-builtin name)', () => {
    // Renamed from PI — phase-8 added PI() as a built-in, and built-ins
    // take dispatch precedence over user-defined names, so the original
    // assertion is no longer realistic. MYK avoids the collision.
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('MYK', { kind: 'lambda', params: [], body: num(3.14) })
    wb.setCell('s1', 0, 0, '=MYK()')
    expect(readCell(wb, 's1', 0, 0)).toEqual({ kind: 'number', value: 3.14 })
  })

  test('single-arg LAMBDA: DOUBLE(x) = x*2 → =DOUBLE(5) → 10', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('DOUBLE', {
      kind: 'lambda',
      params: ['x'],
      body: {
        kind: 'binary',
        op: '*',
        left: nameRef('x'),
        right: num(2),
      },
    })
    wb.setCell('s1', 0, 0, '=DOUBLE(5)')
    expect(readCell(wb, 's1', 0, 0)).toEqual({ kind: 'number', value: 10 })
  })

  test('two-arg LAMBDA: ADD(a,b) = a+b → =ADD(2,3) → 5', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('ADD', {
      kind: 'lambda',
      params: ['a', 'b'],
      body: {
        kind: 'binary',
        op: '+',
        left: nameRef('a'),
        right: nameRef('b'),
      },
    })
    wb.setCell('s1', 0, 0, '=ADD(2,3)')
    expect(readCell(wb, 's1', 0, 0)).toEqual({ kind: 'number', value: 5 })
  })

  test('LAMBDA body calls a built-in: SQUARE(x) = POWER(x,2) → =SQUARE(4) → 16', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('SQUARE', {
      kind: 'lambda',
      params: ['x'],
      body: callExpr('POWER', nameRef('x'), num(2)),
    })
    wb.setCell('s1', 0, 0, '=SQUARE(4)')
    expect(readCell(wb, 's1', 0, 0)).toEqual({ kind: 'number', value: 16 })
  })

  test('LAMBDA scope wins over a workbook defined name with the same identifier', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('X', { kind: 'value', value: { kind: 'number', value: 100 } })
    wb.defineName('ID', { kind: 'lambda', params: ['x'], body: nameRef('x') })
    wb.setCell('s1', 0, 0, '=ID(7)')
    // Without param-shadowing, this would return 100. The lambdaScope
    // map placed at call time must win.
    expect(readCell(wb, 's1', 0, 0)).toEqual({ kind: 'number', value: 7 })
  })

  test('missing arg binds to BLANK in the body — falls through to coercion #VALUE!? — current behavior: BLANK', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    // body = `x`; calling with no args should bind x → BLANK and return BLANK.
    wb.defineName('GETX', { kind: 'lambda', params: ['x'], body: nameRef('x') })
    wb.setCell('s1', 0, 0, '=GETX()')
    expect(readCell(wb, 's1', 0, 0)).toEqual({ kind: 'blank' })
  })

  test('extra args past declared params return #VALUE!', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    // Avoid names that look like A1-style refs (parser would tokenize
    // `ID1` as a cell reference, not a name).
    wb.defineName('PICK_FIRST', {
      kind: 'lambda',
      params: ['x'],
      body: nameRef('x'),
    })
    wb.setCell('s1', 0, 0, '=PICK_FIRST(11, 1/0)')
    expect(readCell(wb, 's1', 0, 0)).toEqual({ kind: 'error', code: '#VALUE!' })
  })

  test('workbook named LAMBDA does not dynamically capture caller params', () => {
    // OUTER(a) = INNER(2) where INNER(b) = a + b
    // Workbook-level INNER is not an inline closure, so it cannot see
    // OUTER's local `a`.
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('INNER', {
      kind: 'lambda',
      params: ['b'],
      body: { kind: 'binary', op: '+', left: nameRef('a'), right: nameRef('b') },
    })
    wb.defineName('OUTER', {
      kind: 'lambda',
      params: ['a'],
      body: callExpr('INNER', num(2)),
    })
    wb.setCell('s1', 0, 0, '=OUTER(10)')
    expect(readCell(wb, 's1', 0, 0)).toEqual({ kind: 'error', code: '#NAME?' })
  })

  test('workbook defined LAMBDA names are case-insensitive', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('DOUBLE', {
      kind: 'lambda',
      params: ['x'],
      body: { kind: 'binary', op: '*', left: nameRef('x'), right: num(2) },
    })
    wb.setCell('s1', 0, 0, '=double(5)')
    expect(readCell(wb, 's1', 0, 0)).toEqual({ kind: 'number', value: 10 })
  })

  test('recursive LAMBDA via IF terminates (lazy IF + depth guard) — FACT(5) → 120', () => {
    // Excel's IF is lazy in its branches: each branch is only evaluated
    // when chosen. The evaluator's `'call'` arm special-cases `IF` so a
    // textbook recursive LAMBDA like
    //   FACT(n) = IF(n<=1, 1, n*FACT(n-1))
    // doesn't recurse into the unreachable else-branch and blow the JS
    // stack. A depth guard (MAX_LAMBDA_CALL_DEPTH) catches pathological
    // self-reference; see `test/lambda-recursive.test.ts` for end-to-end
    // coverage (FACT / Fibonacci / mutual recursion / stack-overflow).
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('FACT', {
      kind: 'lambda',
      params: ['n'],
      body: callExpr(
        'IF',
        {
          kind: 'binary',
          op: '<=',
          left: nameRef('n'),
          right: num(1),
        },
        num(1),
        {
          kind: 'binary',
          op: '*',
          left: nameRef('n'),
          right: callExpr('FACT', {
            kind: 'binary',
            op: '-',
            left: nameRef('n'),
            right: num(1),
          }),
        },
      ),
    })
    wb.setCell('s1', 0, 0, '=FACT(5)')
    expect(readCell(wb, 's1', 0, 0)).toEqual({ kind: 'number', value: 120 })
  })

  test('NON-recursive LAMBDA nesting is fine — chain ADD(ADD(1,2),ADD(3,4)) → 10', () => {
    // Counterexample to the recursion test above: deep but FINITE
    // nesting of LAMBDA calls works because each call returns before
    // the next dispatches. Proves the eager-arg limitation is specific
    // to self-reference inside IF/IFS/SWITCH branches.
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('SUMTWOARGS', {
      kind: 'lambda',
      params: ['a', 'b'],
      body: { kind: 'binary', op: '+', left: nameRef('a'), right: nameRef('b') },
    })
    wb.setCell('s1', 0, 0, '=SUMTWOARGS(SUMTWOARGS(1, 2), SUMTWOARGS(3, 4))')
    expect(readCell(wb, 's1', 0, 0)).toEqual({ kind: 'number', value: 10 })
  })

  test('cell self-recursion via LAMBDA: =FOO() where FOO body invokes the same cell triggers #CIRCULAR!', () => {
    // A LAMBDA body that *reads* the cell hosting the call to itself
    // re-enters via the ref lookup, which is what the cycle guard
    // protects against. =FOO() in A1, FOO body = A1 + 1.
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('FOO', {
      kind: 'lambda',
      params: [],
      body: {
        kind: 'binary',
        op: '+',
        left: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
        right: num(1),
      },
    })
    wb.setCell('s1', 0, 0, '=FOO()')
    const v = readCell(wb, 's1', 0, 0)
    expect(v.kind).toBe('error')
    if (v.kind === 'error') expect(v.code).toBe('#CIRCULAR!')
  })

  test('LAMBDA body with a SUM over a range arg resolved from a cell', () => {
    // SUMSQ(a, b) = SUM(a, b)  (degenerate but proves arg unwrapping).
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('SUMTWO', {
      kind: 'lambda',
      params: ['a', 'b'],
      body: callExpr('SUM', nameRef('a'), nameRef('b')),
    })
    wb.setCell('s1', 0, 0, '10')
    wb.setCell('s1', 0, 1, '32')
    wb.setCell('s1', 1, 0, '=SUMTWO(A1, B1)')
    expect(readCell(wb, 's1', 1, 0)).toEqual({ kind: 'number', value: 42 })
  })

  test('non-LAMBDA name in CallExpr position falls through to custom dispatch → #NAME? when nothing registered', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    // 'NOPE' is not a built-in, not a LAMBDA, not a custom — must yield #NAME?.
    wb.setCell('s1', 0, 0, '=NOPE(1)')
    const v = readCell(wb, 's1', 0, 0)
    expect(v.kind).toBe('error')
    if (v.kind === 'error') expect(v.code).toBe('#NAME?')
  })
})
