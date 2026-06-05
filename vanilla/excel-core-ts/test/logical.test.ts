/**
 * Wave C / track C2 — logical built-in tests.
 *
 * Covers all ten functions (IF, IFERROR, IFNA, AND, OR, NOT, IFS,
 * SWITCH, TRUE, FALSE) with ≥ 4 fixtures each, plus the semantic
 * deviations from default error propagation that distinguish each:
 *
 *  - IF: cond-only propagation; chosen branch may be an error.
 *  - IFERROR / IFNA: first-arg error is **swallowed**, not propagated.
 *  - AND / OR / NOT / IFS / SWITCH: default propagation applies.
 */

import {
  AND,
  FALSE,
  IF,
  IFERROR,
  IFNA,
  IFS,
  NOT,
  OR,
  SWITCH,
  TRUE,
  FUNCTIONS,
} from '../src/eval/functions/logical'
import type { EvalContext, Value } from '../src/types'
import { describe, expect, it } from '@jest/globals'

// -----------------------------------------------------------------------------
// Test scaffolding
// -----------------------------------------------------------------------------

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const STR = (s: string): Value => ({ kind: 'string', value: s })
const BOOL = (b: boolean): Value => ({ kind: 'boolean', value: b })
const BLANK: Value = { kind: 'blank' }
const ERR = (code: Extract<Value, { kind: 'error' }>['code']): Value => ({
  kind: 'error',
  code,
})

// EvalContext is unused by the logical impls (they only inspect args),
// but the signature requires it. We pass a sparse stub.
const ctx = {} as unknown as EvalContext

// -----------------------------------------------------------------------------
// IF
// -----------------------------------------------------------------------------

describe('IF', () => {
  it('returns the then-branch when cond is truthy', () => {
    expect(IF([BOOL(true), STR('yes'), STR('no')], ctx)).toEqual(STR('yes'))
  })

  it('returns the else-branch when cond is falsy', () => {
    expect(IF([BOOL(false), STR('yes'), STR('no')], ctx)).toEqual(STR('no'))
  })

  it('defaults else to FALSE when omitted', () => {
    expect(IF([BOOL(false), STR('yes')], ctx)).toEqual(BOOL(false))
  })

  it('coerces numeric 0 to false, non-zero to true', () => {
    expect(IF([NUM(0), NUM(1), NUM(2)], ctx)).toEqual(NUM(2))
    expect(IF([NUM(5), NUM(1), NUM(2)], ctx)).toEqual(NUM(1))
    expect(IF([NUM(-3), NUM(1), NUM(2)], ctx)).toEqual(NUM(1))
  })

  it('returns then-branch verbatim even if it is an error (no propagation from branches)', () => {
    // This is the short-circuit semantic: IF only propagates from cond.
    expect(IF([BOOL(true), ERR('#DIV/0!'), STR('safe')], ctx)).toEqual(ERR('#DIV/0!'))
    expect(IF([BOOL(false), ERR('#DIV/0!'), STR('safe')], ctx)).toEqual(STR('safe'))
  })

  it('propagates error from cond', () => {
    expect(IF([ERR('#REF!'), STR('a'), STR('b')], ctx)).toEqual(ERR('#REF!'))
  })

  it('returns #VALUE! when cond fails to coerce to boolean', () => {
    expect(IF([STR('not-a-bool'), STR('a'), STR('b')], ctx)).toEqual(ERR('#VALUE!'))
  })

  it('returns #VALUE! on wrong arity', () => {
    expect(IF([BOOL(true)], ctx)).toEqual(ERR('#VALUE!'))
    expect(IF([BOOL(true), STR('a'), STR('b'), STR('c')], ctx)).toEqual(ERR('#VALUE!'))
  })
})

// -----------------------------------------------------------------------------
// IFERROR
// -----------------------------------------------------------------------------

describe('IFERROR', () => {
  it('returns value when value is not an error', () => {
    expect(IFERROR([NUM(42), STR('fallback')], ctx)).toEqual(NUM(42))
  })

  it('returns fallback when value is any error (does NOT propagate)', () => {
    expect(IFERROR([ERR('#DIV/0!'), STR('fallback')], ctx)).toEqual(STR('fallback'))
    expect(IFERROR([ERR('#N/A'), STR('fallback')], ctx)).toEqual(STR('fallback'))
    expect(IFERROR([ERR('#REF!'), NUM(0)], ctx)).toEqual(NUM(0))
  })

  it('passes blank through unchanged', () => {
    expect(IFERROR([BLANK, STR('fallback')], ctx)).toEqual(BLANK)
  })

  it('returns fallback even if fallback itself is an error', () => {
    expect(IFERROR([ERR('#DIV/0!'), ERR('#N/A')], ctx)).toEqual(ERR('#N/A'))
  })

  it('returns #VALUE! on wrong arity', () => {
    expect(IFERROR([NUM(1)], ctx)).toEqual(ERR('#VALUE!'))
    expect(IFERROR([NUM(1), NUM(2), NUM(3)], ctx)).toEqual(ERR('#VALUE!'))
  })
})

// -----------------------------------------------------------------------------
// IFNA
// -----------------------------------------------------------------------------

describe('IFNA', () => {
  it('returns value when value is not #N/A', () => {
    expect(IFNA([NUM(42), STR('fallback')], ctx)).toEqual(NUM(42))
    expect(IFNA([STR('hi'), STR('fallback')], ctx)).toEqual(STR('hi'))
  })

  it('returns fallback only for #N/A', () => {
    expect(IFNA([ERR('#N/A'), STR('fallback')], ctx)).toEqual(STR('fallback'))
  })

  it('passes other errors through unchanged', () => {
    expect(IFNA([ERR('#DIV/0!'), STR('fallback')], ctx)).toEqual(ERR('#DIV/0!'))
    expect(IFNA([ERR('#REF!'), STR('fallback')], ctx)).toEqual(ERR('#REF!'))
    expect(IFNA([ERR('#VALUE!'), STR('fallback')], ctx)).toEqual(ERR('#VALUE!'))
  })

  it('returns #VALUE! on wrong arity', () => {
    expect(IFNA([NUM(1)], ctx)).toEqual(ERR('#VALUE!'))
    expect(IFNA([], ctx)).toEqual(ERR('#VALUE!'))
  })
})

// -----------------------------------------------------------------------------
// AND
// -----------------------------------------------------------------------------

describe('AND', () => {
  it('returns TRUE when all args are truthy', () => {
    expect(AND([BOOL(true), BOOL(true), BOOL(true)], ctx)).toEqual(BOOL(true))
    expect(AND([NUM(1), NUM(2), NUM(-5)], ctx)).toEqual(BOOL(true))
  })

  it('returns FALSE when any arg is falsy', () => {
    expect(AND([BOOL(true), BOOL(false), BOOL(true)], ctx)).toEqual(BOOL(false))
    expect(AND([NUM(1), NUM(0), NUM(1)], ctx)).toEqual(BOOL(false))
  })

  it('ignores blank args but uses non-blanks', () => {
    expect(AND([BLANK, BOOL(true), BLANK, BOOL(true)], ctx)).toEqual(BOOL(true))
    expect(AND([BLANK, BOOL(true), BOOL(false)], ctx)).toEqual(BOOL(false))
  })

  it('returns #VALUE! when called with no args or all-blank', () => {
    expect(AND([], ctx)).toEqual(ERR('#VALUE!'))
    expect(AND([BLANK, BLANK], ctx)).toEqual(ERR('#VALUE!'))
  })

  it('propagates the first error encountered', () => {
    expect(AND([BOOL(true), ERR('#DIV/0!'), ERR('#N/A')], ctx)).toEqual(ERR('#DIV/0!'))
  })

  it('returns #VALUE! when a string arg fails to coerce', () => {
    expect(AND([BOOL(true), STR('nope')], ctx)).toEqual(ERR('#VALUE!'))
  })

  // Excel descends into ranges — every cell counts, not just the top-left.
  it('descends into array args (every cell)', () => {
    const arr = (vs: Value[][]): Value => ({ kind: 'array', value: vs })
    // All TRUE inside the array.
    expect(AND([arr([[BOOL(true), BOOL(true)], [BOOL(true), BOOL(true)]])], ctx)).toEqual(
      BOOL(true),
    )
    // One FALSE cell anywhere → FALSE.
    expect(AND([arr([[BOOL(true), BOOL(false)], [BOOL(true), BOOL(true)]])], ctx)).toEqual(
      BOOL(false),
    )
    // Number 0 cell coerces to false.
    expect(AND([arr([[NUM(1), NUM(0), NUM(1)]])], ctx)).toEqual(BOOL(false))
    // Mixed scalar + array.
    expect(AND([BOOL(true), arr([[BOOL(true), BOOL(false)]])], ctx)).toEqual(BOOL(false))
  })

  it('strings inside arrays are silently skipped (Excel quirk)', () => {
    const arr = (vs: Value[][]): Value => ({ kind: 'array', value: vs })
    // String "TRUE" inside a range is ignored — so AND with only a string
    // sees no non-blank cells.
    expect(AND([arr([[STR('hello'), BOOL(true)]])], ctx)).toEqual(BOOL(true))
  })

  it('propagates errors found inside arrays', () => {
    const arr = (vs: Value[][]): Value => ({ kind: 'array', value: vs })
    expect(AND([arr([[BOOL(true), ERR('#N/A')]])], ctx)).toEqual(ERR('#N/A'))
  })
})

// -----------------------------------------------------------------------------
// OR
// -----------------------------------------------------------------------------

describe('OR', () => {
  it('returns TRUE when any arg is truthy', () => {
    expect(OR([BOOL(false), BOOL(true), BOOL(false)], ctx)).toEqual(BOOL(true))
    expect(OR([NUM(0), NUM(0), NUM(7)], ctx)).toEqual(BOOL(true))
  })

  it('returns FALSE when all args are falsy', () => {
    expect(OR([BOOL(false), BOOL(false)], ctx)).toEqual(BOOL(false))
    expect(OR([NUM(0), NUM(0)], ctx)).toEqual(BOOL(false))
  })

  it('ignores blank args', () => {
    expect(OR([BLANK, BOOL(false), BLANK], ctx)).toEqual(BOOL(false))
    expect(OR([BLANK, BOOL(true)], ctx)).toEqual(BOOL(true))
  })

  it('returns #VALUE! on empty / all-blank', () => {
    expect(OR([], ctx)).toEqual(ERR('#VALUE!'))
    expect(OR([BLANK], ctx)).toEqual(ERR('#VALUE!'))
  })

  it('propagates the first error', () => {
    expect(OR([BOOL(false), ERR('#REF!'), ERR('#N/A')], ctx)).toEqual(ERR('#REF!'))
  })

  it('descends into array args (every cell)', () => {
    const arr = (vs: Value[][]): Value => ({ kind: 'array', value: vs })
    // All FALSE inside the array.
    expect(OR([arr([[BOOL(false), BOOL(false)], [BOOL(false), BOOL(false)]])], ctx)).toEqual(
      BOOL(false),
    )
    // One TRUE cell anywhere → TRUE.
    expect(OR([arr([[BOOL(false), BOOL(false)], [BOOL(true), BOOL(false)]])], ctx)).toEqual(
      BOOL(true),
    )
    // Non-zero number cell coerces to true.
    expect(OR([arr([[NUM(0), NUM(0), NUM(7)]])], ctx)).toEqual(BOOL(true))
    // Mixed scalar + array.
    expect(OR([BOOL(false), arr([[BOOL(false), BOOL(true)]])], ctx)).toEqual(BOOL(true))
  })

  it('propagates errors found inside arrays', () => {
    const arr = (vs: Value[][]): Value => ({ kind: 'array', value: vs })
    expect(OR([arr([[BOOL(false), ERR('#REF!')]])], ctx)).toEqual(ERR('#REF!'))
  })
})

// -----------------------------------------------------------------------------
// NOT
// -----------------------------------------------------------------------------

describe('NOT', () => {
  it('inverts TRUE → FALSE and FALSE → TRUE', () => {
    expect(NOT([BOOL(true)], ctx)).toEqual(BOOL(false))
    expect(NOT([BOOL(false)], ctx)).toEqual(BOOL(true))
  })

  it('coerces numbers (0 → TRUE, nonzero → FALSE)', () => {
    expect(NOT([NUM(0)], ctx)).toEqual(BOOL(true))
    expect(NOT([NUM(1)], ctx)).toEqual(BOOL(false))
    expect(NOT([NUM(-99)], ctx)).toEqual(BOOL(false))
  })

  it('propagates errors', () => {
    expect(NOT([ERR('#DIV/0!')], ctx)).toEqual(ERR('#DIV/0!'))
  })

  it('returns #VALUE! on wrong arity', () => {
    expect(NOT([], ctx)).toEqual(ERR('#VALUE!'))
    expect(NOT([BOOL(true), BOOL(true)], ctx)).toEqual(ERR('#VALUE!'))
  })

  it('returns #VALUE! on string that does not coerce', () => {
    expect(NOT([STR('maybe')], ctx)).toEqual(ERR('#VALUE!'))
  })
})

// -----------------------------------------------------------------------------
// IFS
// -----------------------------------------------------------------------------

describe('IFS', () => {
  it('returns the val of the first TRUE cond', () => {
    expect(
      IFS([BOOL(false), STR('first'), BOOL(true), STR('second'), BOOL(true), STR('third')], ctx),
    ).toEqual(STR('second'))
  })

  it('returns #N/A when no cond matches', () => {
    expect(IFS([BOOL(false), STR('a'), BOOL(false), STR('b')], ctx)).toEqual(ERR('#N/A'))
  })

  it('uses numeric coercion (0 → false, nonzero → true)', () => {
    expect(IFS([NUM(0), STR('zero'), NUM(1), STR('one')], ctx)).toEqual(STR('one'))
  })

  it('returns #VALUE! on odd-count args', () => {
    expect(IFS([BOOL(false), STR('a'), BOOL(true)], ctx)).toEqual(ERR('#VALUE!'))
  })

  it('rejects odd-count args even when an earlier pair would match', () => {
    expect(IFS([BOOL(true), STR('hit'), BOOL(false)], ctx)).toEqual(ERR('#VALUE!'))
  })

  it('propagates errors from evaluated conds', () => {
    expect(IFS([ERR('#REF!'), STR('a'), BOOL(true), STR('b')], ctx)).toEqual(ERR('#REF!'))
  })

  it('does NOT inspect unreached vals (error in a later val is fine if earlier cond matched)', () => {
    // First cond is true → returns val1 verbatim; later (cond2 = error) is never read.
    expect(IFS([BOOL(true), STR('ok'), ERR('#N/A'), STR('skipped')], ctx)).toEqual(STR('ok'))
  })

  it('returns #VALUE! on empty args', () => {
    expect(IFS([], ctx)).toEqual(ERR('#VALUE!'))
  })
})

// -----------------------------------------------------------------------------
// SWITCH
// -----------------------------------------------------------------------------

describe('SWITCH', () => {
  it('matches first equal case and returns its val', () => {
    expect(
      SWITCH([STR('b'), STR('a'), NUM(1), STR('b'), NUM(2), STR('c'), NUM(3)], ctx),
    ).toEqual(NUM(2))
  })

  it('returns the default (trailing unpaired arg) on no match', () => {
    expect(SWITCH([NUM(99), NUM(1), STR('one'), NUM(2), STR('two'), STR('default')], ctx)).toEqual(
      STR('default'),
    )
  })

  it('returns #N/A on no match and no default', () => {
    expect(SWITCH([NUM(99), NUM(1), STR('one'), NUM(2), STR('two')], ctx)).toEqual(ERR('#N/A'))
  })

  it('matches strings case-insensitively', () => {
    expect(SWITCH([STR('Hello'), STR('HELLO'), NUM(1), STR('world'), NUM(2)], ctx)).toEqual(NUM(1))
  })

  it('matches numbers strictly (1 !== "1")', () => {
    expect(SWITCH([NUM(1), STR('1'), NUM(99), NUM(1), NUM(42)], ctx)).toEqual(NUM(42))
  })

  it('propagates errors from expr', () => {
    expect(SWITCH([ERR('#REF!'), NUM(1), STR('a')], ctx)).toEqual(ERR('#REF!'))
  })

  it('propagates errors from inspected cases', () => {
    expect(SWITCH([NUM(99), ERR('#DIV/0!'), STR('skipped')], ctx)).toEqual(ERR('#DIV/0!'))
  })

  it('does NOT inspect cases past the match', () => {
    expect(
      SWITCH([NUM(1), NUM(1), STR('hit'), ERR('#REF!'), STR('skipped')], ctx),
    ).toEqual(STR('hit'))
  })

  it('returns #VALUE! when fewer than 3 args (need expr + at least one pair)', () => {
    expect(SWITCH([NUM(1)], ctx)).toEqual(ERR('#VALUE!'))
    expect(SWITCH([NUM(1), NUM(1)], ctx)).toEqual(ERR('#VALUE!'))
  })

  it('matches blank to blank', () => {
    expect(SWITCH([BLANK, BLANK, STR('blank-match'), NUM(0), STR('zero')], ctx)).toEqual(
      STR('blank-match'),
    )
  })
})

// -----------------------------------------------------------------------------
// TRUE / FALSE (zero-arg)
// -----------------------------------------------------------------------------

describe('TRUE', () => {
  it('returns boolean TRUE with no args', () => {
    expect(TRUE([], ctx)).toEqual(BOOL(true))
  })

  it('returns #VALUE! when called with any args', () => {
    expect(TRUE([NUM(1)], ctx)).toEqual(ERR('#VALUE!'))
    expect(TRUE([BOOL(true), BOOL(false)], ctx)).toEqual(ERR('#VALUE!'))
  })

  it('is referenced in the FUNCTIONS registry by name', () => {
    expect(FUNCTIONS.TRUE).toBe(TRUE)
  })

  it('does not consume args for fallback purposes', () => {
    // Sanity: TRUE() ignores fancy inputs by erroring out rather than
    // silently swallowing — caller will see the wrong-arity contract.
    expect(TRUE([BLANK], ctx)).toEqual(ERR('#VALUE!'))
  })
})

describe('FALSE', () => {
  it('returns boolean FALSE with no args', () => {
    expect(FALSE([], ctx)).toEqual(BOOL(false))
  })

  it('returns #VALUE! when called with any args', () => {
    expect(FALSE([NUM(0)], ctx)).toEqual(ERR('#VALUE!'))
    expect(FALSE([STR('x')], ctx)).toEqual(ERR('#VALUE!'))
  })

  it('is referenced in the FUNCTIONS registry by name', () => {
    expect(FUNCTIONS.FALSE).toBe(FALSE)
  })

  it('does not consume args for fallback purposes', () => {
    expect(FALSE([BLANK], ctx)).toEqual(ERR('#VALUE!'))
  })
})

// -----------------------------------------------------------------------------
// Registry sanity
// -----------------------------------------------------------------------------

describe('FUNCTIONS registry', () => {
  it('exports the v1 baseline under uppercase keys (extensible)', () => {
    const keys = new Set(Object.keys(FUNCTIONS))
    const baseline = ['AND', 'FALSE', 'IF', 'IFERROR', 'IFNA', 'IFS', 'NOT', 'OR', 'SWITCH', 'TRUE']
    for (const name of baseline) {
      expect(keys.has(name)).toBe(true)
    }
  })

  it('every registry value is a function', () => {
    for (const fn of Object.values(FUNCTIONS)) {
      expect(typeof fn).toBe('function')
    }
  })
})
