import { describe, expect, test } from '@jest/globals'

import {
  BLANK,
  createWorkbook,
  evaluate,
  getBuiltinFunction,
  listBuiltinNames,
  parseFormula,
} from '../src'
import type { Cell, CellKey, EvalContext, Expr, Value } from '../src/types'
import { rangeLookupGeneric, refLookupGeneric } from '../src/eval/evaluate'

function makeCtx(cells: ReadonlyMap<CellKey, Cell> = new Map()): EvalContext {
  const ctx: EvalContext = {
    cells,
    currentlyEvaluating: new Set(),
    refLookup: (a1) => refLookupGeneric(a1, cells, ctx),
    rangeLookup: (start, end) => rangeLookupGeneric(start, end, cells, ctx),
    crossSheetCells: () => undefined,
    callCustom: () => undefined,
    resolveName: () => undefined,
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
  return wb.store.getter(sheet.formulaCellAtom(`${row}:${col}`))
}

const num = (value: number): Value => ({ kind: 'number', value })
const bool = (value: boolean): Value => ({ kind: 'boolean', value })
const nameRef = (name: string): Expr => ({ kind: 'name', name })
const callExpr = (name: string, ...args: Expr[]): Expr => ({ kind: 'call', name, args })

function expectArray(value: Value): Value[][] {
  expect(value.kind).toBe('array')
  return value.kind === 'array' ? value.value : []
}

function workbookWithColumn(values: readonly number[]): ReturnType<typeof createWorkbook> {
  const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
  values.forEach((value, index) => wb.setCell('s1', index, 0, String(value)))
  return wb
}

describe('LET and ISOMITTED evaluator-aware forms', () => {
  test('evaluator-aware names are visible through the built-in registry list', () => {
    const names = listBuiltinNames()
    for (const name of [
      'LET',
      'LAMBDA',
      'ISOMITTED',
      'MAP',
      'REDUCE',
      'SCAN',
      'BYROW',
      'BYCOL',
      'MAKEARRAY',
    ]) {
      expect(names).toContain(name)
      expect(getBuiltinFunction(name)).toBeDefined()
    }
  })

  test('LET binds scalar names sequentially', () => {
    const result = evaluate(parseFormula('=LET(x, 5, y, x + 2, y * x)'), makeCtx())
    expect(result).toEqual(num(35))
  })

  test('LET binding shadows workbook names inside the result expression', () => {
    const ctx: EvalContext = {
      ...makeCtx(),
      resolveName: (name) =>
        name === 'x' ? { kind: 'value', value: num(100) } : undefined,
    }
    expect(evaluate(parseFormula('=LET(x, 2, x + 1)'), ctx)).toEqual(num(3))
  })

  test('LET local names are case-insensitive', () => {
    expect(evaluate(parseFormula('=LET(x, 2, X + 1)'), makeCtx())).toEqual(num(3))
  })

  test('LET-bound LAMBDA can recursively call itself', () => {
    const result = evaluate(
      parseFormula('=LET(f, LAMBDA(n, IF(n<=1, 1, n*f(n-1))), f(5))'),
      makeCtx(),
    )
    expect(result).toEqual(num(120))
  })

  test('LET scope does not leak into a referenced formula cell', () => {
    const cells = new Map<CellKey, Cell>([
      [
        '0:0',
        {
          input: '=x',
          ast: nameRef('x'),
          value: BLANK,
        },
      ],
    ])
    const result = evaluate(parseFormula('=LET(x, 2, A1)'), makeCtx(cells))
    expect(result).toMatchObject({ kind: 'error', code: '#NAME?' })
  })

  test('ISOMITTED distinguishes a missing named-LAMBDA argument from a provided one', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('MISSING_SECOND', {
      kind: 'lambda',
      params: ['a', 'b'],
      body: callExpr('ISOMITTED', nameRef('b')),
    })
    wb.setCell('s1', 0, 0, '=MISSING_SECOND(1)')
    wb.setCell('s1', 1, 0, '=MISSING_SECOND(1, 2)')
    expect(readCell(wb, 's1', 0, 0)).toEqual(bool(true))
    expect(readCell(wb, 's1', 1, 0)).toEqual(bool(false))
  })

  test('bare inline LAMBDA returns #CALC! when it is not immediately invoked', () => {
    const result = evaluate(parseFormula('=LAMBDA(x, x)'), makeCtx())
    expect(result).toMatchObject({ kind: 'error', code: '#CALC!' })
  })

  test('inline LAMBDA can be immediately invoked', () => {
    const result = evaluate(parseFormula('=LAMBDA(x, x + 1)(4)'), makeCtx())
    expect(result).toEqual(num(5))
  })

  test('LAMBDA parameter names are case-insensitive', () => {
    const result = evaluate(parseFormula('=LAMBDA(x, X)(4)'), makeCtx())
    expect(result).toEqual(num(4))
  })

  test('parenthesized inline LAMBDA can be immediately invoked', () => {
    const result = evaluate(parseFormula('=(LAMBDA(x, y, x*y))(3, 4)'), makeCtx())
    expect(result).toEqual(num(12))
  })

  test('immediately invoked LAMBDA captures outer LET scalar bindings', () => {
    const result = evaluate(parseFormula('=LET(n, 7, LAMBDA(x, x+n)(3))'), makeCtx())
    expect(result).toEqual(num(10))
  })

  test('immediately invoked LAMBDA supports omitted arguments', () => {
    const result = evaluate(parseFormula('=LAMBDA(x, ISOMITTED(x))()'), makeCtx())
    expect(result).toEqual(bool(true))
  })

  test('ISOMITTED outside LAMBDA is not available', () => {
    const result = evaluate(parseFormula('=ISOMITTED(A1)'), makeCtx())
    expect(result).toEqual({ kind: 'error', code: '#NAME?' })
  })

  test('ISOMITTED inside LET but outside LAMBDA is not available', () => {
    const result = evaluate(parseFormula('=LET(x, 1, ISOMITTED(x))'), makeCtx())
    expect(result).toEqual({ kind: 'error', code: '#NAME?' })
  })

  test('LET inside LAMBDA preserves omitted parameter tracking', () => {
    const result = evaluate(parseFormula('=LAMBDA(x, LET(y, 1, ISOMITTED(x)))()'), makeCtx())
    expect(result).toEqual(bool(true))
  })

  test('immediately invoked LAMBDA can return a LAMBDA that is immediately invoked', () => {
    const result = evaluate(parseFormula('=LAMBDA(x, LAMBDA(y, x+y))(2)(3)'), makeCtx())
    expect(result).toEqual(num(5))
  })

  test('selector functions can carry inline LAMBDA values to an immediate call site', () => {
    expect(evaluate(parseFormula('=CHOOSE(1, LAMBDA(x, x+1))(4)'), makeCtx())).toEqual(num(5))
    expect(evaluate(parseFormula('=IF(TRUE, LAMBDA(x, x*2), LAMBDA(x, 0))(5)'), makeCtx()))
      .toEqual(num(10))
    expect(
      evaluate(
        parseFormula('=SWITCH("b", "a", LAMBDA(x, 0), "b", LAMBDA(x, x+3))(4)'),
        makeCtx(),
      ),
    ).toEqual(num(7))
    expect(
      evaluate(
        parseFormula('=IFS(FALSE, LAMBDA(x, 0), TRUE, LAMBDA(x, x*3))(4)'),
        makeCtx(),
      ),
    ).toEqual(num(12))
    expect(evaluate(parseFormula('=IFERROR(1/0, LAMBDA(x, x+5))(6)'), makeCtx()))
      .toEqual(num(11))
    expect(evaluate(parseFormula('=IFNA(NA(), LAMBDA(x, x+1))(7)'), makeCtx()))
      .toEqual(num(8))
    expect(evaluate(parseFormula('=FILTER({1}, {FALSE}, LAMBDA(x, x+1))(4)'), makeCtx()))
      .toEqual(num(5))
    expect(evaluate(parseFormula('=XLOOKUP(9, {1}, {2}, LAMBDA(x, x+1))(4)'), makeCtx()))
      .toEqual(num(5))
  })

  test('selector functions only evaluate the branch they select', () => {
    expect(evaluate(parseFormula('=IFS(TRUE, 1, TRUE, 1/0)'), makeCtx())).toEqual(num(1))
    expect(evaluate(parseFormula('=SWITCH(1, 1, 2, 2, 1/0)'), makeCtx())).toEqual(num(2))
    expect(evaluate(parseFormula('=IFERROR(1, 1/0)'), makeCtx())).toEqual(num(1))
    expect(evaluate(parseFormula('=IFNA(1, 1/0)'), makeCtx())).toEqual(num(1))
    expect(evaluate(parseFormula('=CHOOSE(2, 1/0, 42)'), makeCtx())).toEqual(num(42))
    expect(expectArray(evaluate(parseFormula('=FILTER({1;2}, {TRUE;FALSE}, 1/0)'), makeCtx())))
      .toEqual([[num(1)]])
    expect(evaluate(parseFormula('=XLOOKUP(1, {1}, {2}, 1/0)'), makeCtx())).toEqual(num(2))
    expect(evaluate(parseFormula('=XLOOKUP(1, {1}, {#N/A}, 99)'), makeCtx()))
      .toMatchObject({ kind: 'error', code: '#N/A' })
  })

  test('LAMBDA parameters can receive function-valued arguments internally', () => {
    const result = evaluate(parseFormula('=LAMBDA(f, f(2))(LAMBDA(x, x+1))'), makeCtx())
    expect(result).toEqual(num(3))
  })

  test('LET-bound maker LAMBDA can return a function and invoke it', () => {
    const result = evaluate(parseFormula('=LET(make, LAMBDA(x, LAMBDA(y, x+y)), make(2)(3))'), makeCtx())
    expect(result).toEqual(num(5))
  })

  test('defined-name LAMBDA can return a function and invoke it', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.defineName('MAKEADD', {
      kind: 'lambda',
      params: ['x'],
      body: callExpr(
        'LAMBDA',
        nameRef('y'),
        {
          kind: 'binary',
          op: '+',
          left: nameRef('x'),
          right: nameRef('y'),
        },
      ),
    })
    wb.setCell('s1', 0, 0, '=MAKEADD(4)(5)')
    expect(readCell(wb, 's1', 0, 0)).toEqual(num(9))
  })
})

describe('higher-order LAMBDA array functions', () => {
  test('MAP over a range with an inline LAMBDA returns a same-shape array', () => {
    const wb = workbookWithColumn([1, 2, 3])
    wb.setCell('s1', 0, 1, '=MAP(A1:A3, LAMBDA(x, x*x))')
    expect(expectArray(readCell(wb, 's1', 0, 1))).toEqual([
      [num(1)],
      [num(4)],
      [num(9)],
    ])
  })

  test('LET-bound LAMBDA can be passed to MAP by name', () => {
    const wb = workbookWithColumn([10, 20, 30])
    wb.setCell('s1', 0, 1, '=LET(square, LAMBDA(x, x*x), MAP(A1:A3, square))')
    expect(expectArray(readCell(wb, 's1', 0, 1))).toEqual([
      [num(100)],
      [num(400)],
      [num(900)],
    ])
  })

  test('inline LAMBDA captures an outer LET scalar while MAP applies it per cell', () => {
    const wb = workbookWithColumn([1, 2, 3])
    wb.setCell('s1', 0, 1, '=LET(mult, 3, MAP(A1:A3, LAMBDA(x, x*mult)))')
    expect(expectArray(readCell(wb, 's1', 0, 1))).toEqual([
      [num(3)],
      [num(6)],
      [num(9)],
    ])
  })

  test('defined-name LAMBDA can be passed to MAP by bare name', () => {
    const wb = workbookWithColumn([1, 2, 3])
    wb.defineName('inc', {
      kind: 'lambda',
      params: ['x'],
      body: {
        kind: 'binary',
        op: '+',
        left: nameRef('x'),
        right: { kind: 'number', value: 1 },
      },
    })
    wb.setCell('s1', 0, 1, '=MAP(A1:A3, inc)')
    expect(expectArray(readCell(wb, 's1', 0, 1))).toEqual([
      [num(2)],
      [num(3)],
      [num(4)],
    ])
  })

  test('REDUCE returns the final accumulator and SCAN returns running accumulators', () => {
    const wb = workbookWithColumn([1, 2, 3, 4])
    wb.setCell('s1', 0, 1, '=REDUCE(0, A1:A4, LAMBDA(acc, x, acc+x))')
    wb.setCell('s1', 0, 2, '=SCAN(0, A1:A4, LAMBDA(acc, x, acc+x))')
    expect(readCell(wb, 's1', 0, 1)).toEqual(num(10))
    expect(expectArray(readCell(wb, 's1', 0, 2))).toEqual([
      [num(1)],
      [num(3)],
      [num(6)],
      [num(10)],
    ])
  })

  test('REDUCE rejects over-cap input arrays', () => {
    const row = Array.from({ length: 1024 }, () => num(1))
    const big: Value = { kind: 'array', value: Array.from({ length: 1025 }, () => row) }
    const ctx: EvalContext = {
      ...makeCtx(),
      resolveName: (name) => name === 'BIG' ? { kind: 'value', value: big } : undefined,
    }
    const result = evaluate(parseFormula('=REDUCE(0, BIG, LAMBDA(acc, x, acc+x))'), ctx)
    expect(result).toMatchObject({ kind: 'error', code: '#VALUE!' })
  })

  test('BYROW and BYCOL pass row/column arrays to the callback LAMBDA', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    const values = [
      [1, 2, 3],
      [4, 5, 6],
    ]
    values.forEach((row, r) => row.forEach((value, c) => wb.setCell('s1', r, c, String(value))))
    wb.setCell('s1', 0, 3, '=BYROW(A1:C2, LAMBDA(r, SUM(r)))')
    wb.setCell('s1', 0, 4, '=BYCOL(A1:C2, LAMBDA(c, SUM(c)))')
    expect(expectArray(readCell(wb, 's1', 0, 3))).toEqual([[num(6)], [num(15)]])
    expect(expectArray(readCell(wb, 's1', 0, 4))).toEqual([[num(5), num(7), num(9)]])
  })

  test('BYROW and BYCOL reject over-cap input arrays', () => {
    const row = Array.from({ length: 1024 }, () => num(1))
    const big: Value = { kind: 'array', value: Array.from({ length: 1025 }, () => row) }
    const ctx: EvalContext = {
      ...makeCtx(),
      resolveName: (name) => name === 'BIG' ? { kind: 'value', value: big } : undefined,
    }
    expect(evaluate(parseFormula('=BYROW(BIG, LAMBDA(r, SUM(r)))'), ctx))
      .toMatchObject({ kind: 'error', code: '#VALUE!' })
    expect(evaluate(parseFormula('=BYCOL(BIG, LAMBDA(c, SUM(c)))'), ctx))
      .toMatchObject({ kind: 'error', code: '#VALUE!' })
  })

  test('MAKEARRAY calls the LAMBDA with 1-based row and column indexes', () => {
    const result = evaluate(parseFormula('=MAKEARRAY(2, 3, LAMBDA(i, j, i*j))'), makeCtx())
    expect(expectArray(result)).toEqual([
      [num(1), num(2), num(3)],
      [num(2), num(4), num(6)],
    ])
  })

  test('MAKEARRAY rejects results wider than the Excel column limit', () => {
    // 16,385 exceeds Excel's XFD column bound (16,384) — `#NUM!` per
    // Excel-compatible shape guard.
    const result = evaluate(parseFormula('=MAKEARRAY(1, 16385, LAMBDA(r, c, c))'), makeCtx())
    expect(result).toMatchObject({ kind: 'error', code: '#NUM!' })
  })

  test('MAP and SCAN keep scalar callback errors inside result cells', () => {
    const mapped = evaluate(parseFormula('=MAP({1,-1}, LAMBDA(x, SQRT(x)))'), makeCtx())
    expect(expectArray(mapped)).toEqual([[num(1), { kind: 'error', code: '#NUM!' }]])

    const scanned = evaluate(parseFormula('=SCAN(0, {1,-1}, LAMBDA(acc, x, SQRT(x)))'), makeCtx())
    expect(expectArray(scanned)).toEqual([[num(1), { kind: 'error', code: '#NUM!' }]])
  })

  test('higher-order array callbacks reject nested array results', () => {
    const nestedArray = {
      kind: 'error',
      code: '#CALC!',
      message: 'array result was not expanded',
    }
    expect(evaluate(parseFormula('=MAP({1,2}, LAMBDA(x, {x,x}))'), makeCtx())).toEqual(nestedArray)
    expect(evaluate(parseFormula('=SCAN(0, {1,2}, LAMBDA(acc, x, {acc,x}))'), makeCtx()))
      .toEqual(nestedArray)
    expect(evaluate(parseFormula('=BYROW({1;2}, LAMBDA(r, {1,2}))'), makeCtx())).toEqual(
      nestedArray,
    )
    expect(evaluate(parseFormula('=BYCOL({1,2}, LAMBDA(c, {1;2}))'), makeCtx())).toEqual(
      nestedArray,
    )
    expect(evaluate(parseFormula('=MAKEARRAY(1, 1, LAMBDA(r, c, {1,2}))'), makeCtx())).toEqual(
      nestedArray,
    )
  })

  test('higher-order functions accept an immediately invoked LAMBDA that returns a LAMBDA', () => {
    const wb = workbookWithColumn([1, 2, 3])
    wb.setCell('s1', 0, 1, '=MAP(A1:A3, LAMBDA(n, LAMBDA(x, x+n))(10))')
    expect(expectArray(readCell(wb, 's1', 0, 1))).toEqual([
      [num(11)],
      [num(12)],
      [num(13)],
    ])
  })

  test('higher-order functions accept selector-returned inline LAMBDA callbacks', () => {
    const wb = workbookWithColumn([1, 2, 3])
    wb.setCell('s1', 0, 1, '=MAP(A1:A3, CHOOSE(1, LAMBDA(x, x+10)))')
    expect(expectArray(readCell(wb, 's1', 0, 1))).toEqual([
      [num(11)],
      [num(12)],
      [num(13)],
    ])
  })

  test('higher-order functions reject callback arity mismatches', () => {
    const result = evaluate(parseFormula('=MAP({1,2}, LAMBDA(a, b, a+b))'), makeCtx())
    expect(result).toMatchObject({ kind: 'error', code: '#VALUE!' })
  })

  test('unknown higher-order callback name surfaces #VALUE!', () => {
    const result = evaluate(parseFormula('=MAP({1,2}, missing_lambda)'), makeCtx())
    expect(result).toMatchObject({ kind: 'error', code: '#VALUE!' })
  })

  test('empty cells remain BLANK when MAP receives a range containing gaps', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '2')
    wb.setCell('s1', 2, 0, '4')
    wb.setCell('s1', 0, 1, '=MAP(A1:A3, LAMBDA(x, x))')
    expect(expectArray(readCell(wb, 's1', 0, 1))).toEqual([[num(2)], [BLANK], [num(4)]])
  })

  // -------------------------------------------------------------------
  // Issue 1 (Hume): MAP/FILTER with whole-column input must iterate the
  // non-empty cells sparsely from the sheet snapshot rather than
  // materializing 1,048,576 blanks.
  // -------------------------------------------------------------------

  test('MAP over a whole-column ref iterates only non-empty cells', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '1')
    wb.setCell('s1', 1, 0, '2')
    wb.setCell('s1', 99, 0, '3')
    wb.setCell('s1', 0, 1, '=MAP(A:A, LAMBDA(x, x*10))')
    const started = Date.now()
    const result = readCell(wb, 's1', 0, 1)
    const elapsed = Date.now() - started
    // Sparse iteration must complete fast — materializing 1M blanks
    // would push elapsed well above this bound.
    expect(elapsed).toBeLessThan(100)
    expect(expectArray(result)).toEqual([[num(10)], [num(20)], [num(30)]])
  })

  test('FILTER over a whole-column ref iterates only non-empty cells', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '1')
    wb.setCell('s1', 1, 0, '2')
    wb.setCell('s1', 99, 0, '3')
    wb.setCell('s1', 0, 1, '=FILTER(A:A, A:A > 1)')
    const started = Date.now()
    const result = readCell(wb, 's1', 0, 1)
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(100)
    expect(expectArray(result)).toEqual([[num(2)], [num(3)]])
  })

  // -------------------------------------------------------------------
  // Issue 2 (Hume): REDUCE/BYROW/BYCOL enforce ARRAY_CELL_CAP on input.
  // The existing 1025x1024 fixture exercises the matrix-array path; this
  // case exercises the chained input where the inner producer would
  // itself need to overflow the grid first.
  // -------------------------------------------------------------------

  test('REDUCE rejects a chained over-cap input from MAKEARRAY', () => {
    const result = evaluate(
      parseFormula('=REDUCE(0, MAKEARRAY(2000000, 1, LAMBDA(r, c, r)), LAMBDA(a, v, a + v))'),
      makeCtx(),
    )
    // MAKEARRAY surfaces `#NUM!` (rows > Excel grid bound) and REDUCE
    // propagates it.
    expect(result.kind).toBe('error')
    expect(result).toMatchObject({ kind: 'error', code: '#NUM!' })
  })

  // -------------------------------------------------------------------
  // Issue 3 (Hume): 16,384 column bound enforced consistently.
  // -------------------------------------------------------------------

  test('SEQUENCE/MAKEARRAY column-bound surfaces #NUM!', () => {
    expect(evaluate(parseFormula('=SEQUENCE(1, 16385)'), makeCtx()))
      .toMatchObject({ kind: 'error', code: '#NUM!' })
    expect(evaluate(parseFormula('=MAKEARRAY(1, 16385, LAMBDA(r, c, c))'), makeCtx()))
      .toMatchObject({ kind: 'error', code: '#NUM!' })
  })
})
