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
