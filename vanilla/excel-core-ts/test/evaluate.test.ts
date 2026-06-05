/**
 * Wave B/B2 evaluator tests.
 *
 * Drives `evaluate()` directly with hand-built AST nodes. Each test pins
 * one rule from `docs/ARCHITECTURE.md` §4 (evaluation flow) and §5 (cycle
 * detection). The evaluator is fed a `cells` snapshot through an
 * inline-built `EvalContext` — no atoms, no Store, no parser — so the
 * arithmetic / coercion / error-propagation rules can be verified in
 * isolation from the workbook layer.
 */

import { describe, expect, test } from '@jest/globals'

import {
  cycleGuardKey,
  evaluate,
  rangeLookupGeneric,
  refLookupGeneric,
} from '../src/eval/evaluate'
import { toNumber, toBoolean, toString as valueToString, propagateError } from '../src/eval/coerce'
import type { Cell, CellKey, EvalContext, Expr, Value } from '../src/types'
import { BLANK } from '../src/types'

function makeCtx(cells: ReadonlyMap<CellKey, Cell>): EvalContext {
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

function makeLiteralCell(value: Value): Cell {
  return { input: String(value.kind === 'number' ? value.value : ''), value }
}

const n = (value: number): Expr => ({ kind: 'number', value })
const b = (value: boolean): Expr => ({ kind: 'boolean', value })
const errExpr = (code: Extract<Value, { kind: 'error' }>['code']): Expr => ({ kind: 'error', code })
const arrExpr = (rows: number[][]): Expr => ({
  kind: 'arrayLiteral',
  rows: rows.map((row) => row.map(n)),
})
const arrayExpr = (rows: Expr[][]): Expr => ({ kind: 'arrayLiteral', rows })
const rangeExpr = (start: string, end: string): Expr => ({ kind: 'range', start, end })
const divZeroExpr: Expr = {
  kind: 'binary',
  op: '/',
  left: n(1),
  right: n(0),
}
const numVal = (value: number): Value => ({ kind: 'number', value })
const boolVal = (value: boolean): Value => ({ kind: 'boolean', value })
const arrVal = (rows: Value[][]): Value => ({ kind: 'array', value: rows })

describe('evaluator — literals + arithmetic', () => {
  test('=1+2*3 evaluates to 7 (operator precedence baked into tree shape)', () => {
    // 1 + (2 * 3)
    const ast: Expr = {
      kind: 'binary',
      op: '+',
      left: { kind: 'number', value: 1 },
      right: {
        kind: 'binary',
        op: '*',
        left: { kind: 'number', value: 2 },
        right: { kind: 'number', value: 3 },
      },
    }
    expect(evaluate(ast, makeCtx(new Map()))).toEqual({ kind: 'number', value: 7 })
  })

  test('string + boolean literals round-trip', () => {
    expect(evaluate({ kind: 'string', value: 'hi' }, makeCtx(new Map()))).toEqual({
      kind: 'string',
      value: 'hi',
    })
    expect(evaluate({ kind: 'boolean', value: true }, makeCtx(new Map()))).toEqual({
      kind: 'boolean',
      value: true,
    })
  })

  test('error literal short-circuits propagation', () => {
    expect(evaluate({ kind: 'error', code: '#REF!' }, makeCtx(new Map()))).toEqual({
      kind: 'error',
      code: '#REF!',
    })
  })

  test('unary minus + percent', () => {
    expect(
      evaluate(
        { kind: 'unary', op: '-', operand: { kind: 'number', value: 5 } },
        makeCtx(new Map()),
      ),
    ).toEqual({ kind: 'number', value: -5 })
    expect(
      evaluate(
        { kind: 'percent', operand: { kind: 'number', value: 50 } },
        makeCtx(new Map()),
      ),
    ).toEqual({ kind: 'number', value: 0.5 })
  })

  test('divide-by-zero surfaces #DIV/0!', () => {
    const ast: Expr = {
      kind: 'binary',
      op: '/',
      left: { kind: 'number', value: 10 },
      right: { kind: 'number', value: 0 },
    }
    expect(evaluate(ast, makeCtx(new Map()))).toEqual({ kind: 'error', code: '#DIV/0!' })
  })

  test('string concat with "&"', () => {
    const ast: Expr = {
      kind: 'binary',
      op: '&',
      left: { kind: 'string', value: 'foo' },
      right: { kind: 'string', value: 'bar' },
    }
    expect(evaluate(ast, makeCtx(new Map()))).toEqual({ kind: 'string', value: 'foobar' })
  })

  test('comparison ops return booleans', () => {
    const eq: Expr = {
      kind: 'binary',
      op: '=',
      left: { kind: 'number', value: 1 },
      right: { kind: 'number', value: 1 },
    }
    expect(evaluate(eq, makeCtx(new Map()))).toEqual({ kind: 'boolean', value: true })
    const lt: Expr = {
      kind: 'binary',
      op: '<',
      left: { kind: 'number', value: 1 },
      right: { kind: 'number', value: 2 },
    }
    expect(evaluate(lt, makeCtx(new Map()))).toEqual({ kind: 'boolean', value: true })
  })

  test('binary operators broadcast arrays against scalars and matching arrays', () => {
    expect(
      evaluate(
        { kind: 'binary', op: '+', left: arrExpr([[1], [2], [3]]), right: n(10) },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[numVal(11)], [numVal(12)], [numVal(13)]]))

    expect(
      evaluate(
        {
          kind: 'binary',
          op: '*',
          left: arrExpr([[1, 2], [3, 4]]),
          right: arrExpr([[10, 20], [30, 40]]),
        },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[numVal(10), numVal(40)], [numVal(90), numVal(160)]]))
  })

  test('binary operators broadcast row and column vectors', () => {
    expect(
      evaluate(
        {
          kind: 'binary',
          op: '+',
          left: arrExpr([[1], [2], [3]]),
          right: arrExpr([[10, 20]]),
        },
        makeCtx(new Map()),
      ),
    ).toEqual(
      arrVal([
        [numVal(11), numVal(21)],
        [numVal(12), numVal(22)],
        [numVal(13), numVal(23)],
      ]),
    )
  })

  test('binary broadcast refuses outputs above the array cell cap', () => {
    const col = Array.from({ length: 1025 }, (_, i) => [i + 1])
    const row = [Array.from({ length: 1025 }, (_, i) => i + 1)]

    expect(
      evaluate(
        {
          kind: 'binary',
          op: '+',
          left: arrExpr(col),
          right: arrExpr(row),
        },
        makeCtx(new Map()),
      ),
    ).toEqual({ kind: 'error', code: '#VALUE!', message: 'array result exceeds cell cap' })
  })

  test('binary array comparisons broadcast and incompatible shapes return #VALUE!', () => {
    expect(
      evaluate(
        { kind: 'binary', op: '=', left: arrExpr([[1], [2]]), right: arrExpr([[1], [3]]) },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[boolVal(true)], [boolVal(false)]]))

    expect(
      evaluate(
        { kind: 'binary', op: '+', left: arrExpr([[1, 2], [3, 4]]), right: arrExpr([[1, 2, 3]]) },
        makeCtx(new Map()),
      ),
    ).toEqual({ kind: 'error', code: '#VALUE!' })
  })

  test('array IF selects per element and preserves branch laziness', () => {
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'IF',
          args: [
            arrayExpr([[b(true)], [b(false)]]),
            arrExpr([[1], [2]]),
            arrExpr([[3], [4]]),
          ],
        },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[numVal(1)], [numVal(4)]]))

    expect(
      evaluate(
        {
          kind: 'call',
          name: 'IF',
          args: [arrayExpr([[b(true)], [b(true)]]), arrExpr([[1], [2]]), divZeroExpr],
        },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[numVal(1)], [numVal(2)]]))
  })

  test('array IFERROR and IFNA replace only caught error cells', () => {
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'IFERROR',
          args: [arrayExpr([[n(1), errExpr('#N/A')]]), n(0)],
        },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[numVal(1), numVal(0)]]))

    expect(
      evaluate(
        {
          kind: 'call',
          name: 'IFNA',
          args: [arrayExpr([[errExpr('#N/A')], [errExpr('#DIV/0!')]]), n(9)],
        },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[numVal(9)], [{ kind: 'error', code: '#DIV/0!' }]]))
  })

  test('array CHOOSE selects per index and reports invalid indexes per cell', () => {
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'CHOOSE',
          args: [arrayExpr([[n(1), n(2)]]), n(10), n(20)],
        },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[numVal(10), numVal(20)]]))

    expect(
      evaluate(
        {
          kind: 'call',
          name: 'CHOOSE',
          args: [arrayExpr([[n(1), n(3)]]), n(10), divZeroExpr],
        },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[numVal(10), { kind: 'error', code: '#VALUE!' }]]))
  })

  test('array IFS selects the first matching branch per element', () => {
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'IFS',
          args: [
            arrayExpr([[b(false), b(true)]]),
            arrExpr([[1, 2]]),
            b(true),
            n(9),
          ],
        },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[numVal(9), numVal(2)]]))

    expect(
      evaluate(
        {
          kind: 'call',
          name: 'IFS',
          args: [arrayExpr([[b(true), b(true)]]), arrExpr([[1, 2]]), b(true), divZeroExpr],
        },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[numVal(1), numVal(2)]]))
  })

  test('array SWITCH matches and defaults per element', () => {
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'SWITCH',
          args: [arrExpr([[1, 2, 3]]), n(1), n(10), n(2), arrExpr([[20, 21, 22]]), n(0)],
        },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[numVal(10), numVal(21), numVal(0)]]))

    expect(
      evaluate(
        {
          kind: 'call',
          name: 'SWITCH',
          args: [
            arrExpr([[1, 2]]),
            arrExpr([[1, 3]]),
            n(10),
            arrExpr([[0, 2]]),
            n(20),
          ],
        },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[numVal(10), numVal(20)]]))
  })

  test('SUM streams whole-column refs without materializing the range', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['1:0', makeLiteralCell({ kind: 'string', value: '5' })],
      ['1048575:0', makeLiteralCell(numVal(2))],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }
    expect(
      evaluate(
        { kind: 'call', name: 'SUM', args: [rangeExpr('A', 'A'), n(4)] },
        ctx,
      ),
    ).toEqual(numVal(7))
  })

  test('numeric aggregators stream whole-column refs without materializing the range', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['1:0', makeLiteralCell({ kind: 'string', value: '5' })],
      ['2:0', makeLiteralCell(numVal(-3))],
      ['1048575:0', makeLiteralCell(numVal(5))],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }

    expect(evaluate({ kind: 'call', name: 'COUNT', args: [rangeExpr('A', 'A')] }, ctx)).toEqual(
      numVal(3),
    )
    expect(evaluate({ kind: 'call', name: 'AVERAGE', args: [rangeExpr('A', 'A')] }, ctx)).toEqual(
      numVal(1),
    )
    expect(evaluate({ kind: 'call', name: 'MIN', args: [rangeExpr('A', 'A')] }, ctx)).toEqual(
      numVal(-3),
    )
    expect(evaluate({ kind: 'call', name: 'MAX', args: [rangeExpr('A', 'A')] }, ctx)).toEqual(
      numVal(5),
    )
  })

  test('SUBTOTAL streams whole-column refs without materializing the range', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['1:0', makeLiteralCell({ kind: 'string', value: '5' })],
      ['2:0', makeLiteralCell(BLANK)],
      ['1048575:0', makeLiteralCell(numVal(2))],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }

    expect(
      evaluate(
        { kind: 'call', name: 'SUBTOTAL', args: [n(9), rangeExpr('A', 'A'), n(4)] },
        ctx,
      ),
    ).toEqual(numVal(7))
    expect(
      evaluate({ kind: 'call', name: 'SUBTOTAL', args: [n(3), rangeExpr('A', 'A')] }, ctx),
    ).toEqual(numVal(3))
  })

  test('AGGREGATE streams whole-column refs and honors ignore-error option', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['1:0', makeLiteralCell({ kind: 'error', code: '#REF!' })],
      ['2:0', makeLiteralCell(numVal(4))],
      ['1048575:0', makeLiteralCell(numVal(9))],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }

    expect(
      evaluate(
        { kind: 'call', name: 'AGGREGATE', args: [n(9), n(0), rangeExpr('A', 'A')] },
        ctx,
      ),
    ).toEqual({ kind: 'error', code: '#REF!' })
    expect(
      evaluate(
        { kind: 'call', name: 'AGGREGATE', args: [n(9), n(2), rangeExpr('A', 'A')] },
        ctx,
      ),
    ).toEqual(numVal(14))
    expect(
      evaluate(
        { kind: 'call', name: 'AGGREGATE', args: [n(9), n(4), rangeExpr('A', 'A')] },
        ctx,
      ),
    ).toEqual({ kind: 'error', code: '#REF!' })
    expect(
      evaluate(
        { kind: 'call', name: 'AGGREGATE', args: [n(14), n(6), rangeExpr('A', 'A'), n(2)] },
        ctx,
      ),
    ).toEqual(numVal(4))
  })

  test('TAKE slices huge refs before materializing the source range', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(7))],
      ['1048575:0', makeLiteralCell(numVal(42))],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }

    expect(
      evaluate(
        { kind: 'call', name: 'TAKE', args: [rangeExpr('A', 'XFD'), n(1), n(1)] },
        ctx,
      ),
    ).toEqual(arrVal([[numVal(7)]]))
    expect(
      evaluate({ kind: 'call', name: 'TAKE', args: [rangeExpr('A', 'A'), n(-1)] }, ctx),
    ).toEqual(arrVal([[numVal(42)]]))
  })

  test('DROP slices huge refs before materializing and rejects oversized outputs', () => {
    const cells = new Map<CellKey, Cell>([
      ['1048575:0', makeLiteralCell(numVal(42))],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }

    expect(
      evaluate(
        { kind: 'call', name: 'DROP', args: [rangeExpr('A', 'A'), n(1_048_575)] },
        ctx,
      ),
    ).toEqual(arrVal([[numVal(42)]]))
    expect(
      evaluate(
        { kind: 'call', name: 'DROP', args: [rangeExpr('A', 'XFD'), n(1), n(1)] },
        ctx,
      ),
    ).toMatchObject({ kind: 'error', code: '#VALUE!' })
  })

  test('COUNTA streams whole-column refs and counts present non-blanks', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['1:0', makeLiteralCell({ kind: 'string', value: '' })],
      ['2:0', makeLiteralCell(BLANK)],
      ['3:0', makeLiteralCell({ kind: 'error', code: '#REF!' })],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }

    expect(evaluate({ kind: 'call', name: 'COUNTA', args: [rangeExpr('A', 'A')] }, ctx)).toEqual(
      numVal(3),
    )
  })

  test('COUNTBLANK streams whole-column refs and counts implicit blanks', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['1:0', makeLiteralCell({ kind: 'string', value: '' })],
      ['2:0', makeLiteralCell(BLANK)],
      ['3:0', makeLiteralCell({ kind: 'error', code: '#REF!' })],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }

    expect(
      evaluate({ kind: 'call', name: 'COUNTBLANK', args: [rangeExpr('A', 'A')] }, ctx),
    ).toEqual(numVal(1_048_574))
  })

  test('COUNTIF streams whole-column refs with numeric-string criteria', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['1:0', makeLiteralCell(numVal(-1))],
      ['1048575:0', makeLiteralCell({ kind: 'string', value: '2' })],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'COUNTIF',
          args: [rangeExpr('A', 'A'), { kind: 'string', value: '>0' }],
        },
        ctx,
      ),
    ).toEqual(numVal(2))
  })

  test('COUNTIF whole-column blank criteria count implicit blanks', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['1:0', makeLiteralCell({ kind: 'string', value: '' })],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'COUNTIF',
          args: [rangeExpr('A', 'A'), { kind: 'string', value: '' }],
        },
        ctx,
      ),
    ).toEqual(numVal(1_048_575))
  })

  test('SUMIF streams whole-column range and sum_range refs', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['0:1', makeLiteralCell(numVal(10))],
      ['1:0', makeLiteralCell(numVal(-1))],
      ['1:1', makeLiteralCell(numVal(999))],
      ['1048575:0', makeLiteralCell({ kind: 'string', value: '2' })],
      ['1048575:1', makeLiteralCell({ kind: 'string', value: '20' })],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'SUMIF',
          args: [
            rangeExpr('A', 'A'),
            { kind: 'string', value: '>0' },
            rangeExpr('B', 'B'),
          ],
        },
        ctx,
      ),
    ).toEqual(numVal(30))
  })

  test('SUMIF whole-column blank criteria include missing check cells with present sum cells', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['0:1', makeLiteralCell(numVal(10))],
      ['1:1', makeLiteralCell(numVal(20))],
      ['2:0', makeLiteralCell({ kind: 'string', value: '' })],
      ['2:1', makeLiteralCell({ kind: 'string', value: '30' })],
      ['3:0', makeLiteralCell({ kind: 'error', code: '#VALUE!' })],
      ['3:1', makeLiteralCell(numVal(40))],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'SUMIF',
          args: [rangeExpr('A', 'A'), { kind: 'string', value: '' }, rangeExpr('B', 'B')],
        },
        ctx,
      ),
    ).toEqual(numVal(50))
  })

  test('AVERAGEIF streams whole-column range and average_range refs', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['0:1', makeLiteralCell(numVal(10))],
      ['1:0', makeLiteralCell(numVal(-1))],
      ['1:1', makeLiteralCell(numVal(999))],
      ['1048575:0', makeLiteralCell({ kind: 'string', value: '2' })],
      ['1048575:1', makeLiteralCell({ kind: 'string', value: '20' })],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'AVERAGEIF',
          args: [
            rangeExpr('A', 'A'),
            { kind: 'string', value: '>0' },
            rangeExpr('B', 'B'),
          ],
        },
        ctx,
      ),
    ).toEqual(numVal(15))
  })

  test('AVERAGEIF whole-column blank criteria include sparse average cells', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['0:1', makeLiteralCell(numVal(10))],
      ['1:1', makeLiteralCell(numVal(20))],
      ['2:0', makeLiteralCell({ kind: 'string', value: '' })],
      ['2:1', makeLiteralCell({ kind: 'string', value: '30' })],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'AVERAGEIF',
          args: [rangeExpr('A', 'A'), { kind: 'string', value: '' }, rangeExpr('B', 'B')],
        },
        ctx,
      ),
    ).toEqual(numVal(25))
  })

  test('AVERAGEIF sparse criteria range errors propagate', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell({ kind: 'error', code: '#VALUE!' })],
      ['0:1', makeLiteralCell(numVal(10))],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'AVERAGEIF',
          args: [rangeExpr('A', 'A'), { kind: 'string', value: 'x' }, rangeExpr('B', 'B')],
        },
        ctx,
      ),
    ).toEqual({ kind: 'error', code: '#VALUE!' })
  })

  test('COUNTIFS and SUMIFS stream whole-column criteria refs', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['0:1', makeLiteralCell({ kind: 'string', value: 'x' })],
      ['0:2', makeLiteralCell(numVal(10))],
      ['1:0', makeLiteralCell(numVal(-1))],
      ['1:1', makeLiteralCell({ kind: 'string', value: 'x' })],
      ['1:2', makeLiteralCell(numVal(999))],
      ['5:0', makeLiteralCell(numVal(3))],
      ['5:1', makeLiteralCell({ kind: 'string', value: 'y' })],
      ['5:2', makeLiteralCell(numVal(30))],
      ['1048575:0', makeLiteralCell({ kind: 'string', value: '2' })],
      ['1048575:1', makeLiteralCell({ kind: 'string', value: 'x' })],
      ['1048575:2', makeLiteralCell({ kind: 'string', value: '20' })],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }

    expect(
      evaluate(
        {
          kind: 'call',
          name: 'COUNTIFS',
          args: [
            rangeExpr('A', 'A'),
            { kind: 'string', value: '>0' },
            rangeExpr('B', 'B'),
            { kind: 'string', value: 'x' },
          ],
        },
        ctx,
      ),
    ).toEqual(numVal(2))
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'SUMIFS',
          args: [
            rangeExpr('C', 'C'),
            rangeExpr('A', 'A'),
            { kind: 'string', value: '>0' },
            rangeExpr('B', 'B'),
            { kind: 'string', value: 'x' },
          ],
        },
        ctx,
      ),
    ).toEqual(numVal(30))
  })

  test('COUNTIFS streams whole-column blank criteria including implicit blanks', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['0:1', makeLiteralCell({ kind: 'string', value: 'x' })],
      ['1:1', makeLiteralCell({ kind: 'string', value: 'x' })],
      ['2:0', makeLiteralCell({ kind: 'string', value: '' })],
      ['2:1', makeLiteralCell({ kind: 'string', value: 'x' })],
      ['3:1', makeLiteralCell({ kind: 'string', value: 'y' })],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }

    expect(
      evaluate(
        {
          kind: 'call',
          name: 'COUNTIFS',
          args: [
            rangeExpr('A', 'A'),
            { kind: 'string', value: '' },
            rangeExpr('B', 'B'),
            { kind: 'string', value: 'x' },
          ],
        },
        ctx,
      ),
    ).toEqual(numVal(2))
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'COUNTIFS',
          args: [
            rangeExpr('A', 'A'),
            { kind: 'string', value: '' },
            rangeExpr('B', 'B'),
            { kind: 'string', value: '' },
          ],
        },
        ctx,
      ),
    ).toEqual(numVal(1_048_572))
  })

  test('SUMIFS streams whole-column blank criteria with sparse sum cells', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['0:1', makeLiteralCell({ kind: 'string', value: 'x' })],
      ['0:2', makeLiteralCell(numVal(10))],
      ['1:1', makeLiteralCell({ kind: 'string', value: 'x' })],
      ['1:2', makeLiteralCell(numVal(20))],
      ['2:0', makeLiteralCell({ kind: 'string', value: '' })],
      ['2:1', makeLiteralCell({ kind: 'string', value: 'x' })],
      ['2:2', makeLiteralCell({ kind: 'string', value: '30' })],
      ['3:2', makeLiteralCell(numVal(40))],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }

    expect(
      evaluate(
        {
          kind: 'call',
          name: 'SUMIFS',
          args: [
            rangeExpr('C', 'C'),
            rangeExpr('A', 'A'),
            { kind: 'string', value: '' },
            rangeExpr('B', 'B'),
            { kind: 'string', value: 'x' },
          ],
        },
        ctx,
      ),
    ).toEqual(numVal(50))
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'SUMIFS',
          args: [
            rangeExpr('C', 'C'),
            rangeExpr('A', 'A'),
            { kind: 'string', value: '' },
            rangeExpr('B', 'B'),
            { kind: 'string', value: '' },
          ],
        },
        ctx,
      ),
    ).toEqual(numVal(40))
  })

  test('AVERAGEIFS MAXIFS and MINIFS stream whole-column refs', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['0:1', makeLiteralCell({ kind: 'string', value: 'x' })],
      ['0:2', makeLiteralCell(numVal(10))],
      ['1:0', makeLiteralCell(numVal(-1))],
      ['1:1', makeLiteralCell({ kind: 'string', value: 'x' })],
      ['1:2', makeLiteralCell(numVal(999))],
      ['5:0', makeLiteralCell(numVal(3))],
      ['5:1', makeLiteralCell({ kind: 'string', value: 'y' })],
      ['5:2', makeLiteralCell(numVal(30))],
      ['1048575:0', makeLiteralCell(numVal(2))],
      ['1048575:1', makeLiteralCell({ kind: 'string', value: 'x' })],
      ['1048575:2', makeLiteralCell(numVal(20))],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }

    const criteria: Expr[] = [
      rangeExpr('A', 'A'),
      { kind: 'string', value: '>0' },
      rangeExpr('B', 'B'),
      { kind: 'string', value: 'x' },
    ]

    expect(
      evaluate({ kind: 'call', name: 'AVERAGEIFS', args: [rangeExpr('C', 'C'), ...criteria] }, ctx),
    ).toEqual(numVal(15))
    expect(
      evaluate({ kind: 'call', name: 'MAXIFS', args: [rangeExpr('C', 'C'), ...criteria] }, ctx),
    ).toEqual(numVal(20))
    expect(
      evaluate({ kind: 'call', name: 'MINIFS', args: [rangeExpr('C', 'C'), ...criteria] }, ctx),
    ).toEqual(numVal(10))
  })

  test('AVERAGEIFS MAXIFS and MINIFS stream whole-column blank criteria', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell(numVal(1))],
      ['0:1', makeLiteralCell({ kind: 'string', value: 'x' })],
      ['0:2', makeLiteralCell(numVal(10))],
      ['1:2', makeLiteralCell(numVal(20))],
      ['2:0', makeLiteralCell({ kind: 'string', value: '' })],
      ['2:1', makeLiteralCell({ kind: 'string', value: '' })],
      ['2:2', makeLiteralCell(numVal(30))],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }

    const criteria: Expr[] = [
      rangeExpr('A', 'A'),
      { kind: 'string', value: '' },
      rangeExpr('B', 'B'),
      { kind: 'string', value: '' },
    ]

    expect(
      evaluate({ kind: 'call', name: 'AVERAGEIFS', args: [rangeExpr('C', 'C'), ...criteria] }, ctx),
    ).toEqual(numVal(25))
    expect(
      evaluate({ kind: 'call', name: 'MAXIFS', args: [rangeExpr('C', 'C'), ...criteria] }, ctx),
    ).toEqual(numVal(30))
    expect(
      evaluate({ kind: 'call', name: 'MINIFS', args: [rangeExpr('C', 'C'), ...criteria] }, ctx),
    ).toEqual(numVal(20))
  })

  test('sparse IFS aggregators propagate whole-column criteria errors', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell({ kind: 'error', code: '#VALUE!' })],
      ['0:2', makeLiteralCell(numVal(10))],
    ])
    const ctx = makeCtx(cells)
    ctx.rangeLookup = () => {
      throw new Error('rangeLookup should not be called')
    }

    const criterion: Expr[] = [rangeExpr('A', 'A'), { kind: 'string', value: '>0' }]
    const expected = { kind: 'error', code: '#VALUE!' }
    expect(evaluate({ kind: 'call', name: 'COUNTIFS', args: criterion }, ctx)).toEqual(expected)
    expect(
      evaluate({ kind: 'call', name: 'SUMIFS', args: [rangeExpr('C', 'C'), ...criterion] }, ctx),
    ).toEqual(expected)
    expect(
      evaluate({ kind: 'call', name: 'AVERAGEIFS', args: [rangeExpr('C', 'C'), ...criterion] }, ctx),
    ).toEqual(expected)
    expect(
      evaluate({ kind: 'call', name: 'MAXIFS', args: [rangeExpr('C', 'C'), ...criterion] }, ctx),
    ).toEqual(expected)
    expect(
      evaluate({ kind: 'call', name: 'MINIFS', args: [rangeExpr('C', 'C'), ...criterion] }, ctx),
    ).toEqual(expected)
  })

  test('evaluator-owned FILTER empty result returns #CALC! without if_empty', () => {
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'FILTER',
          args: [arrExpr([[1], [2]]), arrayExpr([[b(false)], [b(false)]])],
        },
        makeCtx(new Map()),
      ),
    ).toEqual({ kind: 'error', code: '#CALC!', message: 'FILTER returned empty result' })
  })

  test('evaluator-owned FILTER keeps if_empty lazy', () => {
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'FILTER',
          args: [arrExpr([[1], [2]]), arrayExpr([[b(true)], [b(false)]]), divZeroExpr],
        },
        makeCtx(new Map()),
      ),
    ).toEqual(arrVal([[numVal(1)]]))
  })

  test('array literals reject nested dynamic-array cells before TOCOL can leak them', () => {
    expect(
      evaluate(
        {
          kind: 'call',
          name: 'TOCOL',
          args: [
            arrayExpr([
              [{ kind: 'call', name: 'SEQUENCE', args: [n(2)] }, n(3)],
            ]),
          ],
        },
        makeCtx(new Map()),
      ),
    ).toMatchObject({ kind: 'error', code: '#CALC!' })
  })
})

describe('evaluator — refs against a seeded snapshot', () => {
  test('=A1+B1 with A1=10, B1=20 → 30 (one snapshot, two Map.get calls)', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell({ kind: 'number', value: 10 })],
      ['0:1', makeLiteralCell({ kind: 'number', value: 20 })],
    ])
    const ast: Expr = {
      kind: 'binary',
      op: '+',
      left: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
      right: { kind: 'ref', a1: 'B1', absCol: false, absRow: false },
    }
    expect(evaluate(ast, makeCtx(cells))).toEqual({ kind: 'number', value: 30 })
  })

  test('=A1*B1 short-circuits when A1 is #REF! (Excel first-error-wins)', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell({ kind: 'error', code: '#REF!' })],
      ['0:1', makeLiteralCell({ kind: 'number', value: 20 })],
    ])
    const ast: Expr = {
      kind: 'binary',
      op: '*',
      left: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
      right: { kind: 'ref', a1: 'B1', absCol: false, absRow: false },
    }
    expect(evaluate(ast, makeCtx(cells))).toEqual({ kind: 'error', code: '#REF!' })
  })

  test('missing cell reads as BLANK, coerces to 0 in arithmetic', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell({ kind: 'number', value: 7 })],
    ])
    const ast: Expr = {
      kind: 'binary',
      op: '+',
      left: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
      right: { kind: 'ref', a1: 'Z99', absCol: false, absRow: false },
    }
    expect(evaluate(ast, makeCtx(cells))).toEqual({ kind: 'number', value: 7 })
  })

  test('invalid A1 ref surfaces #REF!', () => {
    const ast: Expr = { kind: 'ref', a1: 'NOT_A_REF', absCol: false, absRow: false }
    expect(evaluate(ast, makeCtx(new Map()))).toEqual({ kind: 'error', code: '#REF!' })
  })

  test('range expansion returns 2-D array with blanks materialized', () => {
    const cells = new Map<CellKey, Cell>([
      ['0:0', makeLiteralCell({ kind: 'number', value: 1 })],
      ['1:1', makeLiteralCell({ kind: 'number', value: 4 })],
    ])
    const ast: Expr = { kind: 'range', start: 'A1', end: 'B2' }
    expect(evaluate(ast, makeCtx(cells))).toEqual({
      kind: 'array',
      value: [
        [{ kind: 'number', value: 1 }, BLANK],
        [BLANK, { kind: 'number', value: 4 }],
      ],
    })
  })
})

describe('evaluator — cycle detection (ARCH §5)', () => {
  test('mutually-referential formulas A1=B1+1, B1=A1+1 → #CIRCULAR!', () => {
    // A1 = B1 + 1
    const astA1: Expr = {
      kind: 'binary',
      op: '+',
      left: { kind: 'ref', a1: 'B1', absCol: false, absRow: false },
      right: { kind: 'number', value: 1 },
    }
    // B1 = A1 + 1
    const astB1: Expr = {
      kind: 'binary',
      op: '+',
      left: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
      right: { kind: 'number', value: 1 },
    }
    const cells = new Map<CellKey, Cell>([
      ['0:0', { input: '=B1+1', ast: astA1, value: BLANK }],
      ['0:1', { input: '=A1+1', ast: astB1, value: BLANK }],
    ])
    const ctx = makeCtx(cells)
    // Seed the cycle set with A1 as the top-level cell being evaluated
    // (this is what `formulaCellAtom`'s derive does). Use the composite
    // tag so cross-sheet collisions are impossible.
    ctx.currentlyEvaluating.add(cycleGuardKey(cells, '0:0'))
    const result = evaluate(astA1, ctx)
    // The propagation goes: A1 evaluates B1 (which references A1 → #CIRCULAR!),
    // then A1's binary `+` propagates the error verbatim.
    expect(result).toEqual({ kind: 'error', code: '#CIRCULAR!' })
  })

  test('self-reference (A1=A1+1) → #CIRCULAR!', () => {
    const ast: Expr = {
      kind: 'binary',
      op: '+',
      left: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
      right: { kind: 'number', value: 1 },
    }
    const cells = new Map<CellKey, Cell>([
      ['0:0', { input: '=A1+1', ast, value: BLANK }],
    ])
    const ctx = makeCtx(cells)
    ctx.currentlyEvaluating.add(cycleGuardKey(cells, '0:0'))
    expect(evaluate(ast, ctx)).toEqual({ kind: 'error', code: '#CIRCULAR!' })
  })
})

describe('evaluator — unimplemented surfaces return #NAME?', () => {
  test('=UNKNOWN_FN() returns #NAME? (Wave C will register functions)', () => {
    const ast: Expr = { kind: 'call', name: 'UNKNOWN_FN', args: [] }
    const result = evaluate(ast, makeCtx(new Map()))
    expect(result.kind).toBe('error')
    expect((result as { code: string }).code).toBe('#NAME?')
  })

  test('bare name with no binding returns #NAME?', () => {
    const ast: Expr = { kind: 'name', name: 'MY_UNDEFINED_NAME' }
    expect(evaluate(ast, makeCtx(new Map()))).toEqual({
      kind: 'error',
      code: '#NAME?',
    })
  })

  test('cross-sheet ref with no resolver returns #REF!', () => {
    const ast: Expr = {
      kind: 'crossSheet',
      sheetName: 'GhostSheet',
      inner: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
    }
    expect(evaluate(ast, makeCtx(new Map()))).toEqual({
      kind: 'error',
      code: '#REF!',
    })
  })
})

describe('coerce helpers', () => {
  test('toNumber covers each Value variant', () => {
    expect(toNumber({ kind: 'blank' })).toEqual({ ok: true, value: 0 })
    expect(toNumber({ kind: 'number', value: 42 })).toEqual({ ok: true, value: 42 })
    expect(toNumber({ kind: 'boolean', value: true })).toEqual({ ok: true, value: 1 })
    expect(toNumber({ kind: 'string', value: '3.14' })).toEqual({ ok: true, value: 3.14 })
    const bad = toNumber({ kind: 'string', value: 'foo' })
    expect(bad.ok).toBe(false)
  })

  test('toBoolean strings recognize TRUE / FALSE case-insensitively', () => {
    expect(toBoolean({ kind: 'string', value: 'true' })).toEqual({ ok: true, value: true })
    expect(toBoolean({ kind: 'string', value: 'False' })).toEqual({ ok: true, value: false })
    expect(toBoolean({ kind: 'string', value: 'yes' }).ok).toBe(false)
  })

  test('valueToString round-trips numbers + booleans into display strings', () => {
    expect(valueToString({ kind: 'number', value: 1.5 })).toEqual({ ok: true, value: '1.5' })
    expect(valueToString({ kind: 'boolean', value: false })).toEqual({
      ok: true,
      value: 'FALSE',
    })
  })

  test('propagateError finds the first error in arg list', () => {
    expect(
      propagateError([
        { kind: 'number', value: 1 },
        { kind: 'error', code: '#REF!' },
        { kind: 'error', code: '#VALUE!' },
      ]),
    ).toEqual({ kind: 'error', code: '#REF!' })
    expect(propagateError([{ kind: 'number', value: 1 }])).toBeUndefined()
  })
})
