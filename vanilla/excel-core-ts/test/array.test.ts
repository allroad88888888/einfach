/**
 * Wave E / track E1 — array-function tests.
 * Each function gets ≥ 4 fixtures: happy path, error propagation,
 * an edge case, and a shape verification.
 */
import { describe, expect, test } from '@jest/globals'

import { BLANK, type EvalContext, type Value } from '../src'
import { FUNCTIONS } from '../src/eval/functions/array'

const { SEQUENCE, TRANSPOSE, SORT, FILTER, UNIQUE } = FUNCTIONS

const ctx: EvalContext = {
  cells: new Map(),
  refLookup: () => BLANK,
  rangeLookup: () => [[BLANK]],
  crossSheetCells: () => undefined,
  callCustom: () => undefined,
  currentlyEvaluating: new Set(),
  resolveName: () => undefined,
}

const n = (value: number): Value => ({ kind: 'number', value })
const s = (value: string): Value => ({ kind: 'string', value })
const b = (value: boolean): Value => ({ kind: 'boolean', value })
const arr = (matrix: Value[][]): Value => ({ kind: 'array', value: matrix })
const err = (code: '#VALUE!' | '#DIV/0!' | '#N/A'): Value => ({ kind: 'error', code })

describe('SEQUENCE', () => {
  test('3x1 default', () => {
    expect(SEQUENCE([n(3)], ctx)).toEqual(arr([[n(1)], [n(2)], [n(3)]]))
  })

  test('2x3 with start + step', () => {
    expect(SEQUENCE([n(2), n(3), n(10), n(5)], ctx)).toEqual(
      arr([
        [n(10), n(15), n(20)],
        [n(25), n(30), n(35)],
      ]),
    )
  })

  test('error propagation', () => {
    expect(SEQUENCE([err('#DIV/0!')], ctx)).toEqual(err('#DIV/0!'))
  })

  test('rows < 1 surfaces #VALUE!', () => {
    expect(SEQUENCE([n(0)], ctx).kind).toBe('error')
  })

  test('overflow guard rejects rows*cols > 100k', () => {
    const res = SEQUENCE([n(1000), n(1000)], ctx)
    expect(res.kind).toBe('error')
  })
})

describe('TRANSPOSE', () => {
  test('2x3 → 3x2', () => {
    const input = arr([
      [n(1), n(2), n(3)],
      [n(4), n(5), n(6)],
    ])
    expect(TRANSPOSE([input], ctx)).toEqual(
      arr([
        [n(1), n(4)],
        [n(2), n(5)],
        [n(3), n(6)],
      ]),
    )
  })

  test('scalar wraps to 1x1', () => {
    expect(TRANSPOSE([n(7)], ctx)).toEqual(arr([[n(7)]]))
  })

  test('error propagation', () => {
    expect(TRANSPOSE([err('#N/A')], ctx)).toEqual(err('#N/A'))
  })

  test('1xN → Nx1', () => {
    expect(TRANSPOSE([arr([[n(1), n(2), n(3)]])], ctx)).toEqual(
      arr([[n(1)], [n(2)], [n(3)]]),
    )
  })
})

describe('SORT', () => {
  test('default sort asc by first column', () => {
    const m = arr([
      [n(3), s('c')],
      [n(1), s('a')],
      [n(2), s('b')],
    ])
    expect(SORT([m], ctx)).toEqual(
      arr([
        [n(1), s('a')],
        [n(2), s('b')],
        [n(3), s('c')],
      ]),
    )
  })

  test('sort by second column desc', () => {
    const m = arr([
      [s('a'), n(1)],
      [s('b'), n(3)],
      [s('c'), n(2)],
    ])
    expect(SORT([m, n(2), n(-1)], ctx)).toEqual(
      arr([
        [s('b'), n(3)],
        [s('c'), n(2)],
        [s('a'), n(1)],
      ]),
    )
  })

  test('out-of-range sort_index → #VALUE!', () => {
    expect(SORT([arr([[n(1), n(2)]]), n(5)], ctx).kind).toBe('error')
  })

  test('error propagation', () => {
    expect(SORT([err('#DIV/0!')], ctx)).toEqual(err('#DIV/0!'))
  })

  test('sort by_col', () => {
    const m = arr([
      [n(3), n(1), n(2)],
      [s('c'), s('a'), s('b')],
    ])
    expect(SORT([m, n(1), n(1), b(true)], ctx)).toEqual(
      arr([
        [n(1), n(2), n(3)],
        [s('a'), s('b'), s('c')],
      ]),
    )
  })
})

describe('FILTER', () => {
  test('row mask keeps matching rows', () => {
    const m = arr([
      [n(1), s('a')],
      [n(2), s('b')],
      [n(3), s('c')],
    ])
    const mask = arr([[b(true)], [b(false)], [b(true)]])
    expect(FILTER([m, mask], ctx)).toEqual(
      arr([
        [n(1), s('a')],
        [n(3), s('c')],
      ]),
    )
  })

  test('all false with if_empty returns the fallback', () => {
    const m = arr([[n(1)], [n(2)]])
    const mask = arr([[b(false)], [b(false)]])
    expect(FILTER([m, mask, s('none')], ctx)).toEqual(s('none'))
  })

  test('all false without if_empty returns error', () => {
    const m = arr([[n(1)], [n(2)]])
    const mask = arr([[b(false)], [b(false)]])
    expect(FILTER([m, mask], ctx).kind).toBe('error')
  })

  test('shape mismatch → #VALUE!', () => {
    const m = arr([[n(1), n(2), n(3)]])
    const mask = arr([[b(true)], [b(true)]])
    expect(FILTER([m, mask], ctx).kind).toBe('error')
  })

  test('error propagation', () => {
    expect(FILTER([err('#N/A'), arr([[b(true)]])], ctx)).toEqual(err('#N/A'))
  })
})

describe('UNIQUE', () => {
  test('dedupes rows preserving first-seen order', () => {
    const m = arr([[n(1)], [n(2)], [n(1)], [n(3)], [n(2)]])
    expect(UNIQUE([m], ctx)).toEqual(arr([[n(1)], [n(2)], [n(3)]]))
  })

  test('multi-column dedup matches whole row', () => {
    const m = arr([
      [n(1), s('a')],
      [n(1), s('b')],
      [n(1), s('a')],
    ])
    expect(UNIQUE([m], ctx)).toEqual(
      arr([
        [n(1), s('a')],
        [n(1), s('b')],
      ]),
    )
  })

  test('exactly_once keeps only rows seen once', () => {
    const m = arr([[n(1)], [n(2)], [n(1)], [n(3)]])
    expect(UNIQUE([m, b(false), b(true)], ctx)).toEqual(arr([[n(2)], [n(3)]]))
  })

  test('by_col dedupes columns', () => {
    const m = arr([
      [n(1), n(1), n(2)],
      [n(3), n(3), n(4)],
    ])
    expect(UNIQUE([m, b(true)], ctx)).toEqual(
      arr([
        [n(1), n(2)],
        [n(3), n(4)],
      ]),
    )
  })

  test('error propagation', () => {
    expect(UNIQUE([err('#DIV/0!')], ctx)).toEqual(err('#DIV/0!'))
  })
})
