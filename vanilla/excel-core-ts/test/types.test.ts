/**
 * Wave A smoke test — proves the package is wired into the jest harness
 * and the frozen type contracts compile + are importable.
 *
 * Subsequent phases will add real semantic tests; this file stays as a
 * tripwire that future agents notice if they accidentally break the
 * public surface.
 */
import { describe, expect, test } from '@jest/globals'

import {
  BLANK,
  ERROR_CODES,
  type Cell,
  type EvalContext,
  type Expr,
  type FunctionImpl,
  type SheetMutation,
  type Value,
} from '../src'

describe('@einfach/excel-core-ts — Wave A contracts', () => {
  test('BLANK is the canonical empty value', () => {
    expect(BLANK).toEqual({ kind: 'blank' })
  })

  test('ERROR_CODES enumerates every error token the engine emits', () => {
    expect(ERROR_CODES).toContain('#DIV/0!')
    expect(ERROR_CODES).toContain('#N/A')
    expect(ERROR_CODES).toContain('#NAME?')
    expect(ERROR_CODES).toContain('#REF!')
    expect(ERROR_CODES).toContain('#VALUE!')
    expect(ERROR_CODES).toContain('#CALC!')
    expect(ERROR_CODES).toContain('#CYCLE!')
    expect(ERROR_CODES).toContain('#TYPE!')
    expect(ERROR_CODES).toContain('#ARGS!')
    expect(ERROR_CODES).toContain('#SPILL!')
    expect(ERROR_CODES).toContain('#CIRCULAR!')
  })

  test('Value union is structurally constructible for each variant', () => {
    const samples: Value[] = [
      { kind: 'blank' },
      { kind: 'number', value: 42 },
      { kind: 'string', value: 'hi' },
      { kind: 'boolean', value: true },
      { kind: 'error', code: '#DIV/0!' },
      { kind: 'error', code: '#VALUE!', message: 'cannot coerce' },
      { kind: 'array', value: [[{ kind: 'number', value: 1 }]] },
    ]
    // The cast above is the test — if any variant is missing required
    // fields, tsc would have failed before jest ever ran.
    expect(samples).toHaveLength(7)
  })

  test('Cell can be constructed for literal + formula + with format', () => {
    const literal: Cell = {
      input: '100',
      value: { kind: 'number', value: 100 },
    }
    const formula: Cell = {
      input: '=A1+B2',
      ast: { kind: 'number', value: 0 } satisfies Expr,
      value: { kind: 'number', value: 0 },
    }
    const formatted: Cell = {
      input: 'Total',
      value: { kind: 'string', value: 'Total' },
      format: { bgColor: '#1e3a8a', bold: true },
    }
    expect([literal, formula, formatted]).toHaveLength(3)
  })

  test('SheetMutation accepts each documented kind', () => {
    const muts: SheetMutation[] = [
      { kind: 'set-cell', row: 0, col: 0, input: '=1+2' },
      { kind: 'clear-cell', row: 1, col: 1, target: 'value' },
      { kind: 'clear-cell', row: 2, col: 2, target: 'all' },
      {
        kind: 'bulk-apply',
        cells: [{ row: 3, col: 3, input: 'x' }],
      },
      {
        kind: 'set-format',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        format: { bold: true },
      },
    ]
    expect(muts).toHaveLength(5)
  })

  test('Expr discriminated union covers every AST node Wave B/B1 must emit', () => {
    const exprs: Expr[] = [
      { kind: 'number', value: 1 },
      { kind: 'string', value: 'x' },
      { kind: 'boolean', value: true },
      { kind: 'error', code: '#REF!' },
      { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
      { kind: 'range', start: 'A1', end: 'B2' },
      {
        kind: 'dynamicRange',
        start: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
        end: { kind: 'call', name: 'INDEX', args: [{ kind: 'range', start: 'A', end: 'A' }] },
      },
      {
        kind: 'spillRef',
        anchor: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
      },
      {
        kind: 'crossSheet',
        sheetName: 'Sheet2',
        inner: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
      },
      {
        kind: 'multiArea',
        areas: [
          { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
          { kind: 'range', start: 'B1', end: 'C2' },
        ],
      },
      { kind: 'name', name: 'MY_RANGE' },
      { kind: 'unary', op: '-', operand: { kind: 'number', value: 1 } },
      {
        kind: 'binary',
        op: '+',
        left: { kind: 'number', value: 1 },
        right: { kind: 'number', value: 2 },
      },
      { kind: 'percent', operand: { kind: 'number', value: 50 } },
      { kind: 'call', name: 'SUM', args: [{ kind: 'number', value: 1 }] },
      {
        kind: 'lambdaCall',
        callee: { kind: 'call', name: 'LAMBDA', args: [{ kind: 'name', name: 'x' }] },
        args: [{ kind: 'number', value: 1 }],
      },
      {
        kind: 'arrayLiteral',
        rows: [[{ kind: 'number', value: 1 }]],
      },
    ]
    expect(exprs).toHaveLength(17)
  })

  test('FunctionImpl + EvalContext shapes are callable', () => {
    // A trivial impl proves the signature compiles. Wave C agents will
    // import this same shape from `../src/types`.
    const noop: FunctionImpl = (args, ctx) => {
      void ctx
      return args[0] ?? BLANK
    }
    const ctx: EvalContext = {
      cells: new Map(),
      refLookup: () => BLANK,
      rangeLookup: () => [[BLANK]],
      crossSheetCells: () => undefined,
      callCustom: () => undefined,
      currentlyEvaluating: new Set(),
      resolveName: () => undefined,
    }
    expect(noop([{ kind: 'number', value: 7 }], ctx)).toEqual({
      kind: 'number',
      value: 7,
    })
    expect(noop([], ctx)).toEqual(BLANK)
  })
})
