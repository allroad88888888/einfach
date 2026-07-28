/**
 * Wave E / track E1 — array-function tests.
 * Each function gets ≥ 4 fixtures: happy path, error propagation,
 * an edge case, and a shape verification.
 */
import { describe, expect, test } from '@jest/globals'

import { BLANK, type EvalContext, type Value } from '../src'
import { FUNCTIONS } from '../src/eval/functions/array'

const {
  SEQUENCE,
  TRANSPOSE,
  SORT,
  FILTER,
  UNIQUE,
  WRAPROWS,
  WRAPCOLS,
  CHOOSECOLS,
  CHOOSEROWS,
  TAKE,
  DROP,
  EXPAND,
  HSTACK,
  VSTACK,
  TOCOL,
  TOROW,
  RANDARRAY,
  SORTBY,
} = FUNCTIONS

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
const err = (code: Extract<Value, { kind: 'error' }>['code']): Value => ({ kind: 'error', code })

function expectError(value: Value, code: Extract<Value, { kind: 'error' }>['code']): void {
  expect(value).toMatchObject({ kind: 'error', code })
}

function expectArray(value: Value): Value[][] {
  expect(value.kind).toBe('array')
  if (value.kind !== 'array') return []
  return value.value
}

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

  test('overflow guard rejects rows*cols above the Excel grid cap', () => {
    const res = SEQUENCE([n(1025), n(1024)], ctx)
    expect(res.kind).toBe('error')
  })
})

describe('array result cap guards', () => {
  const overCapColumns = 1_048_577
  const wideBlank = () => arr([Array.from({ length: overCapColumns }, () => BLANK)])
  const wideNumbers = () => arr([Array.from({ length: overCapColumns }, (_, index) => n(index))])

  test('TRANSPOSE and SORT reject over-cap shaped results', () => {
    const wide = wideBlank()
    expectError(TRANSPOSE([wide], ctx), '#VALUE!')
    expectError(SORT([wide, n(1), n(1), b(true)], ctx), '#VALUE!')
  })

  test('FILTER and UNIQUE reject over-cap shaped results', () => {
    const wide = wideBlank()
    const mask = arr([Array.from({ length: overCapColumns }, () => b(true))])
    expectError(FILTER([wide, mask], ctx), '#VALUE!')
    expectError(UNIQUE([wideNumbers(), b(true)], ctx), '#VALUE!')
  })

  test('TAKE, DROP, and SORTBY reject over-cap shaped results', () => {
    const wideRow = Array.from({ length: overCapColumns }, () => BLANK)
    const wide = arr([wideRow])
    expectError(TAKE([wide, n(1)], ctx), '#VALUE!')
    expectError(DROP([arr([wideRow, wideRow]), n(1)], ctx), '#VALUE!')
    const keys = arr([Array.from({ length: overCapColumns }, (_, index) => n(index))])
    expectError(SORTBY([wide, keys], ctx), '#VALUE!')
  })
})

describe('array scalar-cell and shape guards', () => {
  test('TOCOL and TOROW reject nested array cells', () => {
    const nested = arr([[arr([[n(1)], [n(2)]]), n(3)]])
    expectError(TOCOL([nested], ctx), '#CALC!')
    expectError(TOROW([nested], ctx), '#CALC!')
  })

  test('WRAPROWS and WRAPCOLS reject nested array pad values', () => {
    const vector = arr([[n(1), n(2), n(3)]])
    const pad = arr([[s('pad')]])
    // Excel requires pad_with to be a scalar; rejecting up front surfaces
    // `#VALUE!`. (Previously this was caught incidentally as `#CALC!` only
    // when the pad cell actually appeared in the output.)
    expectError(WRAPROWS([vector, n(2), pad], ctx), '#VALUE!')
    expectError(WRAPCOLS([vector, n(2), pad], ctx), '#VALUE!')
  })

  test('rejects results wider than the Excel column limit', () => {
    // Excel's column bound (XFD == 16,384) yields `#NUM!`, distinct from
    // the engine cell-cap which surfaces `#VALUE!`.
    expectError(SEQUENCE([n(1), n(16_385)], ctx), '#NUM!')

    const vector = SEQUENCE([n(16_385)], ctx)
    expect(vector.kind).toBe('array')
    expectError(WRAPCOLS([vector, n(1)], ctx), '#NUM!')
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

  test('sort_order must be 1 or -1 after truncation', () => {
    const m = arr([[n(2)], [n(1)]])
    expectError(SORT([m, n(1), n(0)], ctx), '#VALUE!')
    expectError(SORT([m, n(1), n(2)], ctx), '#VALUE!')
    expect(SORT([m, n(1), n(-1.9)], ctx)).toEqual(arr([[n(2)], [n(1)]]))
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
    expectError(FILTER([m, mask], ctx), '#CALC!')
  })

  test('shape mismatch → #VALUE!', () => {
    const m = arr([[n(1), n(2), n(3)]])
    const mask = arr([[b(true)], [b(true)]])
    expect(FILTER([m, mask], ctx).kind).toBe('error')
  })

  test('error propagation', () => {
    expect(FILTER([err('#N/A'), arr([[b(true)]])], ctx)).toEqual(err('#N/A'))
  })

  test('if_empty is only observed when the filtered result is empty', () => {
    const m = arr([[n(1)], [n(2)]])
    expect(FILTER([m, arr([[b(true)], [b(false)]]), err('#DIV/0!')], ctx)).toEqual(
      arr([[n(1)]]),
    )
    expect(FILTER([m, arr([[b(false)], [b(false)]]), err('#DIV/0!')], ctx)).toEqual(
      err('#DIV/0!'),
    )
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

  test('exactly_once with no remaining rows returns #CALC!', () => {
    const m = arr([[n(1)], [n(1)]])
    expectError(UNIQUE([m, b(false), b(true)], ctx), '#CALC!')
  })
})

describe('WRAPROWS', () => {
  test('wraps a row vector by rows with default #N/A padding', () => {
    expect(WRAPROWS([arr([[n(1), n(2), n(3), n(4), n(5)]]), n(2)], ctx)).toEqual(
      arr([
        [n(1), n(2)],
        [n(3), n(4)],
        [n(5), err('#N/A')],
      ]),
    )
  })

  test('wraps a column vector and uses custom padding', () => {
    expect(WRAPROWS([arr([[n(1)], [n(2)], [n(3)]]), n(2), s('x')], ctx)).toEqual(
      arr([
        [n(1), n(2)],
        [n(3), s('x')],
      ]),
    )
  })

  test('wrap count greater than vector length returns one unpadded row', () => {
    expect(WRAPROWS([arr([[n(1), n(2), n(3)]]), n(5)], ctx)).toEqual(
      arr([[n(1), n(2), n(3)]]),
    )
  })

  test('rejects non-vectors and wrap_count less than one', () => {
    expectError(WRAPROWS([arr([[n(1), n(2)], [n(3), n(4)]]), n(2)], ctx), '#VALUE!')
    expectError(WRAPROWS([arr([[n(1), n(2)]]), n(0)], ctx), '#NUM!')
  })
})

describe('WRAPCOLS', () => {
  test('wraps a row vector by columns with default #N/A padding', () => {
    expect(WRAPCOLS([arr([[n(1), n(2), n(3), n(4), n(5)]]), n(2)], ctx)).toEqual(
      arr([
        [n(1), n(3), n(5)],
        [n(2), n(4), err('#N/A')],
      ]),
    )
  })

  test('wraps a column vector and uses custom padding', () => {
    expect(WRAPCOLS([arr([[n(1)], [n(2)], [n(3)]]), n(2), s('x')], ctx)).toEqual(
      arr([
        [n(1), n(3)],
        [n(2), s('x')],
      ]),
    )
  })

  test('wrap count greater than vector length returns one unpadded column', () => {
    expect(WRAPCOLS([arr([[n(1), n(2), n(3)]]), n(5)], ctx)).toEqual(
      arr([[n(1)], [n(2)], [n(3)]]),
    )
  })

  test('rejects non-vectors and wrap_count less than one', () => {
    expectError(WRAPCOLS([arr([[n(1), n(2)], [n(3), n(4)]]), n(2)], ctx), '#VALUE!')
    expectError(WRAPCOLS([arr([[n(1), n(2)]]), n(0)], ctx), '#NUM!')
  })
})

describe('CHOOSECOLS', () => {
  const input = arr([
    [n(1), n(2), n(3)],
    [n(4), n(5), n(6)],
  ])

  test('picks and reorders positive and negative columns', () => {
    expect(CHOOSECOLS([input, n(3), n(1), n(-1)], ctx)).toEqual(
      arr([
        [n(3), n(1), n(3)],
        [n(6), n(4), n(6)],
      ]),
    )
  })

  test('selector array expands in row-major order', () => {
    expect(CHOOSECOLS([input, arr([[n(2), n(1)]])], ctx)).toEqual(
      arr([
        [n(2), n(1)],
        [n(5), n(4)],
      ]),
    )
  })

  test('zero or out-of-range selector returns #VALUE!', () => {
    expectError(CHOOSECOLS([input, n(0)], ctx), '#VALUE!')
    expectError(CHOOSECOLS([input, n(4)], ctx), '#VALUE!')
  })

  test('error propagation', () => {
    expect(CHOOSECOLS([err('#DIV/0!'), n(1)], ctx)).toEqual(err('#DIV/0!'))
  })
})

describe('CHOOSEROWS', () => {
  const input = arr([
    [n(1), s('a')],
    [n(2), s('b')],
    [n(3), s('c')],
  ])

  test('picks and reorders positive and negative rows', () => {
    expect(CHOOSEROWS([input, n(3), n(1), n(-1)], ctx)).toEqual(
      arr([
        [n(3), s('c')],
        [n(1), s('a')],
        [n(3), s('c')],
      ]),
    )
  })

  test('selector array preserves selected row width', () => {
    expect(CHOOSEROWS([input, arr([[n(2), n(1)]])], ctx)).toEqual(
      arr([
        [n(2), s('b')],
        [n(1), s('a')],
      ]),
    )
  })

  test('zero or out-of-range selector returns #VALUE!', () => {
    expectError(CHOOSEROWS([input, n(0)], ctx), '#VALUE!')
    expectError(CHOOSEROWS([input, n(-4)], ctx), '#VALUE!')
  })

  test('error propagation', () => {
    expect(CHOOSEROWS([err('#N/A'), n(1)], ctx)).toEqual(err('#N/A'))
  })
})

describe('TAKE', () => {
  const input = arr([
    [n(1), n(2), n(3)],
    [n(4), n(5), n(6)],
    [n(7), n(8), n(9)],
  ])

  test('takes leading rows and columns', () => {
    expect(TAKE([input, n(2), n(2)], ctx)).toEqual(
      arr([
        [n(1), n(2)],
        [n(4), n(5)],
      ]),
    )
  })

  test('negative counts take from the end', () => {
    expect(TAKE([input, n(-2), n(-2)], ctx)).toEqual(
      arr([
        [n(5), n(6)],
        [n(8), n(9)],
      ]),
    )
  })

  test('zero count returns #CALC!', () => {
    expectError(TAKE([input, n(0)], ctx), '#CALC!')
  })

  test('error propagation', () => {
    expect(TAKE([err('#DIV/0!'), n(1)], ctx)).toEqual(err('#DIV/0!'))
  })
})

describe('DROP', () => {
  const input = arr([
    [n(1), n(2), n(3)],
    [n(4), n(5), n(6)],
    [n(7), n(8), n(9)],
  ])

  test('drops leading rows and columns', () => {
    expect(DROP([input, n(1), n(1)], ctx)).toEqual(
      arr([
        [n(5), n(6)],
        [n(8), n(9)],
      ]),
    )
  })

  test('negative counts drop from the end', () => {
    expect(DROP([input, n(-1), n(-1)], ctx)).toEqual(
      arr([
        [n(1), n(2)],
        [n(4), n(5)],
      ]),
    )
  })

  test('dropping all rows returns #CALC!', () => {
    expectError(DROP([input, n(3)], ctx), '#CALC!')
  })

  test('error propagation', () => {
    expect(DROP([err('#N/A'), n(1)], ctx)).toEqual(err('#N/A'))
  })
})

describe('EXPAND', () => {
  test('expands with default #N/A padding', () => {
    expect(EXPAND([arr([[n(1)], [n(2)]]), n(3), n(2)], ctx)).toEqual(
      arr([
        [n(1), err('#N/A')],
        [n(2), err('#N/A')],
        [err('#N/A'), err('#N/A')],
      ]),
    )
  })

  test('custom pad value fills new cells', () => {
    expect(EXPAND([arr([[n(1), n(2)]]), n(2), n(3), s('pad')], ctx)).toEqual(
      arr([
        [n(1), n(2), s('pad')],
        [s('pad'), s('pad'), s('pad')],
      ]),
    )
  })

  test('smaller target shape returns #VALUE!', () => {
    expectError(EXPAND([arr([[n(1), n(2)]]), n(1), n(1)], ctx), '#VALUE!')
  })

  test('error propagation for required args', () => {
    expect(EXPAND([arr([[n(1)]]), err('#DIV/0!')], ctx)).toEqual(err('#DIV/0!'))
  })

  // Issue 4 (Hume): pad_with must be a scalar. An array argument leaks
  // nested arrays into the result, which downstream rendering cannot
  // handle — reject up front with `#VALUE!`.
  test('rejects array-typed pad_with', () => {
    expectError(
      EXPAND([arr([[n(1)]]), n(2), n(2), arr([[n(99), n(99)]])], ctx),
      '#VALUE!',
    )
  })
})

// Issue 4 (Hume) consolidated coverage: every pad-bearing array
// function rejects an array-typed pad argument up front.
describe('Hume — array-typed pad_with is rejected at the call site', () => {
  test('WRAPROWS rejects array pad', () => {
    expectError(
      WRAPROWS([arr([[n(1), n(2)]]), n(2), arr([[n(99)]])], ctx),
      '#VALUE!',
    )
  })

  test('WRAPCOLS rejects array pad', () => {
    expectError(
      WRAPCOLS([arr([[n(1), n(2)]]), n(2), arr([[n(99)]])], ctx),
      '#VALUE!',
    )
  })

  test('EXPAND rejects array pad even when source fills the target', () => {
    // 2x2 source filling a 2x2 target — pad is never used in the
    // output. Without the explicit guard, the pad would slip through;
    // the explicit guard surfaces the error regardless.
    expectError(
      EXPAND([arr([[n(1), n(2)], [n(3), n(4)]]), n(2), n(2), arr([[n(99)]])], ctx),
      '#VALUE!',
    )
  })
})

describe('HSTACK', () => {
  test('combines arrays horizontally', () => {
    expect(HSTACK([arr([[n(1)], [n(2)]]), arr([[n(3), n(4)], [n(5), n(6)]])], ctx)).toEqual(
      arr([
        [n(1), n(3), n(4)],
        [n(2), n(5), n(6)],
      ]),
    )
  })

  test('pads shorter inputs with #N/A', () => {
    expect(HSTACK([arr([[n(1)], [n(2)]]), arr([[n(3)]])], ctx)).toEqual(
      arr([
        [n(1), n(3)],
        [n(2), err('#N/A')],
      ]),
    )
  })

  test('scalar input wraps to 1x1', () => {
    expect(HSTACK([n(1), arr([[n(2)], [n(3)]])], ctx)).toEqual(
      arr([
        [n(1), n(2)],
        [err('#N/A'), n(3)],
      ]),
    )
  })

  test('error propagation', () => {
    expect(HSTACK([arr([[n(1)]]), err('#DIV/0!')], ctx)).toEqual(err('#DIV/0!'))
  })
})

describe('VSTACK', () => {
  test('combines arrays vertically', () => {
    expect(VSTACK([arr([[n(1), n(2)]]), arr([[n(3), n(4)], [n(5), n(6)]])], ctx)).toEqual(
      arr([
        [n(1), n(2)],
        [n(3), n(4)],
        [n(5), n(6)],
      ]),
    )
  })

  test('pads narrower inputs with #N/A', () => {
    expect(VSTACK([arr([[n(1), n(2)]]), arr([[n(3)]])], ctx)).toEqual(
      arr([
        [n(1), n(2)],
        [n(3), err('#N/A')],
      ]),
    )
  })

  test('scalar input wraps to 1x1', () => {
    expect(VSTACK([arr([[n(1), n(2)]]), n(3)], ctx)).toEqual(
      arr([
        [n(1), n(2)],
        [n(3), err('#N/A')],
      ]),
    )
  })

  test('error propagation', () => {
    expect(VSTACK([arr([[n(1)]]), err('#N/A')], ctx)).toEqual(err('#N/A'))
  })
})

describe('TOCOL', () => {
  const input = arr([
    [n(1), BLANK, err('#DIV/0!')],
    [n(2), n(3), n(4)],
  ])

  test('flattens row-major into a column', () => {
    expect(TOCOL([arr([[n(1), n(2)], [n(3), n(4)]])], ctx)).toEqual(
      arr([[n(1)], [n(2)], [n(3)], [n(4)]]),
    )
  })

  test('scan_by_column flattens column-major', () => {
    expect(TOCOL([arr([[n(1), n(2)], [n(3), n(4)]]), n(0), b(true)], ctx)).toEqual(
      arr([[n(1)], [n(3)], [n(2)], [n(4)]]),
    )
  })

  test('ignore mode 3 skips blanks and errors', () => {
    expect(TOCOL([input, n(3)], ctx)).toEqual(arr([[n(1)], [n(2)], [n(3)], [n(4)]]))
  })

  test('invalid ignore mode and scalar error propagate', () => {
    expectError(TOCOL([input, n(4)], ctx), '#VALUE!')
    expect(TOCOL([err('#N/A')], ctx)).toEqual(err('#N/A'))
    expectError(TOCOL([err('#N/A'), n(2)], ctx), '#CALC!')
  })
})

describe('TOROW', () => {
  const input = arr([
    [n(1), BLANK, err('#DIV/0!')],
    [n(2), n(3), n(4)],
  ])

  test('flattens row-major into a row', () => {
    expect(TOROW([arr([[n(1), n(2)], [n(3), n(4)]])], ctx)).toEqual(
      arr([[n(1), n(2), n(3), n(4)]]),
    )
  })

  test('scan_by_column flattens column-major', () => {
    expect(TOROW([arr([[n(1), n(2)], [n(3), n(4)]]), n(0), b(true)], ctx)).toEqual(
      arr([[n(1), n(3), n(2), n(4)]]),
    )
  })

  test('ignore mode 2 skips errors but keeps blanks', () => {
    expect(TOROW([input, n(2)], ctx)).toEqual(arr([[n(1), BLANK, n(2), n(3), n(4)]]))
  })

  test('invalid ignore mode and scalar error propagate', () => {
    expectError(TOROW([input, n(-1)], ctx), '#VALUE!')
    expect(TOROW([err('#DIV/0!')], ctx)).toEqual(err('#DIV/0!'))
    expectError(TOROW([err('#DIV/0!'), n(3)], ctx), '#CALC!')
  })
})

describe('RANDARRAY', () => {
  test('default returns a 1x1 number in [0, 1)', () => {
    const value = expectArray(RANDARRAY([], ctx))
    expect(value).toHaveLength(1)
    expect(value[0]).toHaveLength(1)
    expect(value[0][0].kind).toBe('number')
    if (value[0][0].kind === 'number') {
      expect(value[0][0].value).toBeGreaterThanOrEqual(0)
      expect(value[0][0].value).toBeLessThan(1)
    }
  })

  test('whole_number returns integers inside the requested shape and bounds', () => {
    const value = expectArray(RANDARRAY([n(2), n(3), n(5), n(7), b(true)], ctx))
    expect(value).toHaveLength(2)
    expect(value[0]).toHaveLength(3)
    for (const row of value) {
      for (const cell of row) {
        expect(cell.kind).toBe('number')
        if (cell.kind === 'number') {
          expect(Number.isInteger(cell.value)).toBe(true)
          expect(cell.value).toBeGreaterThanOrEqual(5)
          expect(cell.value).toBeLessThanOrEqual(7)
        }
      }
    }
  })

  test('invalid dimensions or reversed bounds return errors', () => {
    expectError(RANDARRAY([n(0)], ctx), '#VALUE!')
    expectError(RANDARRAY([n(1), n(1), n(2), n(1)], ctx), '#NUM!')
  })

  test('error propagation', () => {
    expect(RANDARRAY([err('#DIV/0!')], ctx)).toEqual(err('#DIV/0!'))
  })
})

describe('SORTBY', () => {
  test('sorts rows by a matching key column', () => {
    const data = arr([
      [s('c'), n(3)],
      [s('a'), n(1)],
      [s('b'), n(2)],
    ])
    const keys = arr([[n(3)], [n(1)], [n(2)]])
    expect(SORTBY([data, keys], ctx)).toEqual(
      arr([
        [s('a'), n(1)],
        [s('b'), n(2)],
        [s('c'), n(3)],
      ]),
    )
  })

  test('uses multiple keys and sort orders', () => {
    const data = arr([
      [s('a'), n(2)],
      [s('b'), n(1)],
      [s('c'), n(3)],
    ])
    const group = arr([[n(1)], [n(1)], [n(2)]])
    const score = arr([[n(2)], [n(1)], [n(3)]])
    expect(SORTBY([data, group, n(1), score, n(-1)], ctx)).toEqual(
      arr([
        [s('a'), n(2)],
        [s('b'), n(1)],
        [s('c'), n(3)],
      ]),
    )
  })

  test('sorts columns when by_array is a row vector', () => {
    const data = arr([
      [s('b'), s('a'), s('c')],
      [n(2), n(1), n(3)],
    ])
    const keys = arr([[n(2), n(1), n(3)]])
    expect(SORTBY([data, keys], ctx)).toEqual(
      arr([
        [s('a'), s('b'), s('c')],
        [n(1), n(2), n(3)],
      ]),
    )
  })

  test('invalid by_array shape and key errors propagate', () => {
    expectError(SORTBY([arr([[n(1)], [n(2)]]), arr([[n(1), n(2)], [n(3), n(4)]])], ctx), '#VALUE!')
    expect(SORTBY([arr([[n(1)], [n(2)]]), arr([[n(1)], [err('#N/A')]])], ctx)).toEqual(err('#N/A'))
  })
})

describe('FUNCTIONS registry', () => {
  test('exposes dynamic array additions', () => {
    const keys = new Set(Object.keys(FUNCTIONS))
    for (const name of [
      'CHOOSECOLS', 'CHOOSEROWS', 'TAKE', 'DROP', 'EXPAND', 'HSTACK',
      'VSTACK', 'TOCOL', 'TOROW', 'RANDARRAY', 'SORTBY', 'WRAPROWS', 'WRAPCOLS',
    ]) {
      expect(keys.has(name)).toBe(true)
    }
  })
})
