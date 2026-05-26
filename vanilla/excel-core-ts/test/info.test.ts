/**
 * Wave F / F1 — Information function tests.
 *
 * Pins the **non-error-propagating** discipline: every IS* function
 * accepts an error arg and classifies it (TRUE for ISERROR, FALSE for
 * ISNUMBER, etc.) — never short-circuits.
 */

import { describe, expect, test } from '@jest/globals'

import {
  FUNCTIONS,
  ISBLANK,
  ISERR,
  ISERROR,
  ISLOGICAL,
  ISNA,
  ISNUMBER,
  ISTEXT,
  TYPE,
} from '../src/eval/functions/info'
import type { EvalContext, FunctionImpl, Value } from '../src/types'
import { BLANK } from '../src/types'

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const STR = (s: string): Value => ({ kind: 'string', value: s })
const BOOL = (b: boolean): Value => ({ kind: 'boolean', value: b })
const ERR = (code: '#DIV/0!' | '#N/A' | '#NUM!' | '#REF!' | '#VALUE!'): Value => ({
  kind: 'error',
  code,
})
const ARR = (rows: Value[][]): Value => ({ kind: 'array', value: rows })
const TRUEV = BOOL(true)
const FALSEV = BOOL(false)

const ctx: EvalContext = new Proxy(
  {},
  {
    get(_, prop) {
      throw new Error(`info function unexpectedly read ctx.${String(prop)}`)
    },
  },
) as unknown as EvalContext

function call(fn: FunctionImpl, args: Value[]): Value {
  return fn(args, ctx)
}

// ---------------------------------------------------------------------------
// ISNUMBER
// ---------------------------------------------------------------------------

describe('ISNUMBER', () => {
  test('returns TRUE for a number value', () => {
    expect(call(ISNUMBER, [NUM(42)])).toEqual(TRUEV)
  })

  test('returns FALSE for a non-number (string)', () => {
    expect(call(ISNUMBER, [STR('hello')])).toEqual(FALSEV)
  })

  test('returns FALSE for an error (does NOT propagate)', () => {
    expect(call(ISNUMBER, [ERR('#DIV/0!')])).toEqual(FALSEV)
  })

  test('wrong arity → #VALUE!', () => {
    expect(call(ISNUMBER, [])).toEqual(ERR('#VALUE!'))
    expect(call(ISNUMBER, [NUM(1), NUM(2)])).toEqual(ERR('#VALUE!'))
  })
})

// ---------------------------------------------------------------------------
// ISTEXT
// ---------------------------------------------------------------------------

describe('ISTEXT', () => {
  test('returns TRUE for a string', () => {
    expect(call(ISTEXT, [STR('hello')])).toEqual(TRUEV)
  })

  test('returns FALSE for blank', () => {
    expect(call(ISTEXT, [BLANK])).toEqual(FALSEV)
  })

  test('returns FALSE for an error (does NOT propagate)', () => {
    expect(call(ISTEXT, [ERR('#N/A')])).toEqual(FALSEV)
  })

  test('empty string "" still counts as text', () => {
    expect(call(ISTEXT, [STR('')])).toEqual(TRUEV)
  })
})

// ---------------------------------------------------------------------------
// ISBLANK
// ---------------------------------------------------------------------------

describe('ISBLANK', () => {
  test('returns TRUE for blank', () => {
    expect(call(ISBLANK, [BLANK])).toEqual(TRUEV)
  })

  test('returns FALSE for empty string', () => {
    expect(call(ISBLANK, [STR('')])).toEqual(FALSEV)
  })

  test('returns FALSE for an error (does NOT propagate)', () => {
    expect(call(ISBLANK, [ERR('#REF!')])).toEqual(FALSEV)
  })

  test('returns FALSE for zero', () => {
    expect(call(ISBLANK, [NUM(0)])).toEqual(FALSEV)
  })
})

// ---------------------------------------------------------------------------
// ISLOGICAL
// ---------------------------------------------------------------------------

describe('ISLOGICAL', () => {
  test('returns TRUE for boolean true', () => {
    expect(call(ISLOGICAL, [TRUEV])).toEqual(TRUEV)
  })

  test('returns TRUE for boolean false', () => {
    expect(call(ISLOGICAL, [FALSEV])).toEqual(TRUEV)
  })

  test('returns FALSE for the strings "TRUE" / "FALSE"', () => {
    expect(call(ISLOGICAL, [STR('TRUE')])).toEqual(FALSEV)
    expect(call(ISLOGICAL, [STR('FALSE')])).toEqual(FALSEV)
  })

  test('returns FALSE for an error (does NOT propagate)', () => {
    expect(call(ISLOGICAL, [ERR('#VALUE!')])).toEqual(FALSEV)
  })
})

// ---------------------------------------------------------------------------
// ISERROR
// ---------------------------------------------------------------------------

describe('ISERROR', () => {
  test('returns TRUE for #DIV/0!', () => {
    expect(call(ISERROR, [ERR('#DIV/0!')])).toEqual(TRUEV)
  })

  test('returns TRUE for #N/A (catches everything)', () => {
    expect(call(ISERROR, [ERR('#N/A')])).toEqual(TRUEV)
  })

  test('returns FALSE for number', () => {
    expect(call(ISERROR, [NUM(0)])).toEqual(FALSEV)
  })

  test('returns FALSE for blank', () => {
    expect(call(ISERROR, [BLANK])).toEqual(FALSEV)
  })
})

// ---------------------------------------------------------------------------
// ISERR
// ---------------------------------------------------------------------------

describe('ISERR', () => {
  test('returns TRUE for #DIV/0!', () => {
    expect(call(ISERR, [ERR('#DIV/0!')])).toEqual(TRUEV)
  })

  test('returns FALSE for #N/A (the exception)', () => {
    expect(call(ISERR, [ERR('#N/A')])).toEqual(FALSEV)
  })

  test('returns TRUE for other error codes', () => {
    expect(call(ISERR, [ERR('#REF!')])).toEqual(TRUEV)
    expect(call(ISERR, [ERR('#VALUE!')])).toEqual(TRUEV)
    expect(call(ISERR, [ERR('#NUM!')])).toEqual(TRUEV)
  })

  test('returns FALSE for non-error values', () => {
    expect(call(ISERR, [NUM(0)])).toEqual(FALSEV)
    expect(call(ISERR, [STR('hello')])).toEqual(FALSEV)
  })
})

// ---------------------------------------------------------------------------
// ISNA
// ---------------------------------------------------------------------------

describe('ISNA', () => {
  test('returns TRUE for #N/A', () => {
    expect(call(ISNA, [ERR('#N/A')])).toEqual(TRUEV)
  })

  test('returns FALSE for any other error code', () => {
    expect(call(ISNA, [ERR('#DIV/0!')])).toEqual(FALSEV)
    expect(call(ISNA, [ERR('#REF!')])).toEqual(FALSEV)
  })

  test('returns FALSE for non-errors', () => {
    expect(call(ISNA, [NUM(0)])).toEqual(FALSEV)
    expect(call(ISNA, [BLANK])).toEqual(FALSEV)
  })
})

// ---------------------------------------------------------------------------
// TYPE
// ---------------------------------------------------------------------------

describe('TYPE', () => {
  test('returns 1 for number', () => {
    expect(call(TYPE, [NUM(42)])).toEqual(NUM(1))
  })

  test('returns 2 for text', () => {
    expect(call(TYPE, [STR('hello')])).toEqual(NUM(2))
  })

  test('returns 4 for logical', () => {
    expect(call(TYPE, [TRUEV])).toEqual(NUM(4))
  })

  test('returns 16 for error (does NOT propagate)', () => {
    expect(call(TYPE, [ERR('#DIV/0!')])).toEqual(NUM(16))
  })

  test('returns 64 for array', () => {
    expect(call(TYPE, [ARR([[NUM(1), NUM(2)]])])).toEqual(NUM(64))
  })

  test('returns 0 for blank (einfach extension)', () => {
    expect(call(TYPE, [BLANK])).toEqual(NUM(0))
  })

  test('wrong arity → #VALUE!', () => {
    expect(call(TYPE, [])).toEqual(ERR('#VALUE!'))
  })
})

// ---------------------------------------------------------------------------
// FUNCTIONS registry
// ---------------------------------------------------------------------------

describe('FUNCTIONS registry', () => {
  test('exposes all 8 info functions', () => {
    expect(Object.keys(FUNCTIONS).sort()).toEqual([
      'ISBLANK',
      'ISERR',
      'ISERROR',
      'ISLOGICAL',
      'ISNA',
      'ISNUMBER',
      'ISTEXT',
      'TYPE',
    ])
  })

  test('every entry satisfies FunctionImpl shape and does NOT propagate errors', () => {
    for (const [name, fn] of Object.entries(FUNCTIONS)) {
      expect(typeof fn).toBe('function')
      expect(name).toBe(name.toUpperCase())
      // The critical contract: feeding an error returns an actual answer,
      // not the error verbatim.
      const result = fn([ERR('#N/A')], ctx)
      expect(result.kind === 'error' && result.code === '#N/A').toBe(false)
    }
  })
})
