/**
 * Wave C / C4 — text function tests.
 *
 * Each fixture covers one Excel-specified behavior. Emoji tests pin the
 * Unicode-correct code-point split (LEN/LEFT/MID), distinguishing our
 * behavior from JS `.length` (which would count UTF-16 code units).
 */

import { describe, expect, test } from '@jest/globals'

import { FUNCTIONS } from '../src/eval/functions/text'
import type { EvalContext, Value } from '../src/types'

// =============================================================================
// Test scaffolding
// =============================================================================

/**
 * A barebones `EvalContext`. None of the text functions touch ctx (they're
 * pure value-in / value-out), but the FunctionImpl signature still wants
 * one. We hand them a stub that throws on access — that way a regression
 * that *does* start touching ctx will fail loudly in tests.
 */
const stubCtx: EvalContext = {
  cells: new Map(),
  refLookup: () => {
    throw new Error('text functions should not call refLookup')
  },
  rangeLookup: () => {
    throw new Error('text functions should not call rangeLookup')
  },
  crossSheetCells: () => undefined,
  callCustom: () => undefined,
  currentlyEvaluating: new Set(),
  resolveName: () => undefined,
}

const num = (value: number): Value => ({ kind: 'number', value })
const str = (value: string): Value => ({ kind: 'string', value })
const bool = (value: boolean): Value => ({ kind: 'boolean', value })
const blank: Value = { kind: 'blank' }
const arr = (rows: Value[][]): Value => ({ kind: 'array', value: rows })
const errVal = (code: Value['kind'] extends 'error' ? never : string): Value =>
  ({ kind: 'error', code: code as never })

function call(name: keyof typeof FUNCTIONS, args: Value[]): Value {
  return FUNCTIONS[name](args, stubCtx)
}

// =============================================================================
// CONCATENATE
// =============================================================================

describe('CONCATENATE', () => {
  test('joins two strings', () => {
    expect(call('CONCATENATE', [str('foo'), str('bar')])).toEqual(str('foobar'))
  })

  test('coerces numbers + booleans to strings', () => {
    expect(call('CONCATENATE', [str('x='), num(42), str(', '), bool(true)])).toEqual(
      str('x=42, TRUE'),
    )
  })

  test('blank becomes empty string', () => {
    expect(call('CONCATENATE', [str('A'), blank, str('B')])).toEqual(str('AB'))
  })

  test('propagates error from any arg', () => {
    expect(call('CONCATENATE', [str('ok'), errVal('#DIV/0!')])).toEqual({
      kind: 'error',
      code: '#DIV/0!',
    })
  })

  test('zero args → #VALUE!', () => {
    const r = call('CONCATENATE', [])
    expect(r.kind).toBe('error')
  })

  test('array arg coerces to top-left (legacy behavior, unlike CONCAT)', () => {
    expect(
      call('CONCATENATE', [str('start:'), arr([[str('a'), str('b')], [str('c'), str('d')]])]),
    ).toEqual(str('start:a'))
  })
})

// =============================================================================
// CONCAT
// =============================================================================

describe('CONCAT', () => {
  test('joins scalar args like CONCATENATE', () => {
    expect(call('CONCAT', [str('foo'), str('bar')])).toEqual(str('foobar'))
  })

  test('flattens 2D array in row-major order', () => {
    expect(
      call('CONCAT', [
        arr([
          [str('a'), str('b')],
          [str('c'), str('d')],
        ]),
      ]),
    ).toEqual(str('abcd'))
  })

  test('mixes flat args + array args', () => {
    expect(
      call('CONCAT', [str('['), arr([[num(1), num(2)], [num(3)]]), str(']')]),
    ).toEqual(str('[123]'))
  })

  test('propagates error nested in array', () => {
    expect(
      call('CONCAT', [arr([[str('ok'), errVal('#N/A')]])]),
    ).toEqual({ kind: 'error', code: '#N/A' })
  })

  test('empty 1x0 array yields nothing', () => {
    expect(call('CONCAT', [arr([[]]), str('x')])).toEqual(str('x'))
  })
})

// =============================================================================
// LEFT
// =============================================================================

describe('LEFT', () => {
  test('default num_chars = 1', () => {
    expect(call('LEFT', [str('hello')])).toEqual(str('h'))
  })

  test('explicit num_chars', () => {
    expect(call('LEFT', [str('hello'), num(3)])).toEqual(str('hel'))
  })

  test('num_chars > length returns whole string', () => {
    expect(call('LEFT', [str('hi'), num(99)])).toEqual(str('hi'))
  })

  test('num_chars = 0 returns empty', () => {
    expect(call('LEFT', [str('abc'), num(0)])).toEqual(str(''))
  })

  test('negative num_chars → #VALUE!', () => {
    expect(call('LEFT', [str('abc'), num(-1)])).toEqual({ kind: 'error', code: '#VALUE!' })
  })

  test('fractional num_chars truncates toward zero', () => {
    expect(call('LEFT', [str('hello'), num(2.9)])).toEqual(str('he'))
  })

  test('emoji counted as 1 codepoint, not 2 UTF-16 units', () => {
    // 🎉 (PARTY POPPER, U+1F389) is a 4-byte / 2-UTF-16-unit codepoint.
    // LEFT('🎉🎉🎉', 2) returns 2 emoji, not 1 emoji + half of the second.
    expect(call('LEFT', [str('🎉🎉🎉'), num(2)])).toEqual(str('🎉🎉'))
  })
})

// =============================================================================
// RIGHT
// =============================================================================

describe('RIGHT', () => {
  test('default num_chars = 1', () => {
    expect(call('RIGHT', [str('hello')])).toEqual(str('o'))
  })

  test('explicit num_chars', () => {
    expect(call('RIGHT', [str('hello'), num(3)])).toEqual(str('llo'))
  })

  test('num_chars > length returns whole string', () => {
    expect(call('RIGHT', [str('hi'), num(99)])).toEqual(str('hi'))
  })

  test('num_chars = 0 returns empty', () => {
    expect(call('RIGHT', [str('abc'), num(0)])).toEqual(str(''))
  })

  test('negative num_chars → #VALUE!', () => {
    expect(call('RIGHT', [str('abc'), num(-1)])).toEqual({ kind: 'error', code: '#VALUE!' })
  })

  test('coerces number arg to string before slicing', () => {
    expect(call('RIGHT', [num(12345), num(2)])).toEqual(str('45'))
  })
})

// =============================================================================
// MID
// =============================================================================

describe('MID', () => {
  test('basic substring (1-based start)', () => {
    expect(call('MID', [str('abcdef'), num(2), num(3)])).toEqual(str('bcd'))
  })

  test('start = 1 returns prefix', () => {
    expect(call('MID', [str('abcdef'), num(1), num(2)])).toEqual(str('ab'))
  })

  test('start < 1 → #VALUE!', () => {
    expect(call('MID', [str('abc'), num(0), num(2)])).toEqual({
      kind: 'error',
      code: '#VALUE!',
    })
  })

  test('start > length returns empty', () => {
    expect(call('MID', [str('abc'), num(99), num(2)])).toEqual(str(''))
  })

  test('num_chars < 0 → #VALUE!', () => {
    expect(call('MID', [str('abc'), num(1), num(-1)])).toEqual({
      kind: 'error',
      code: '#VALUE!',
    })
  })

  test('num_chars beyond end clamps to remaining length', () => {
    expect(call('MID', [str('abc'), num(2), num(99)])).toEqual(str('bc'))
  })

  test('emoji codepoint indexing (start=2 over emoji)', () => {
    // Without Array.from, MID('🎉ABC', 2, 3) would slice into the
    // surrogate pair and return mojibake. With codepoint split it
    // returns "ABC".
    expect(call('MID', [str('🎉ABC'), num(2), num(3)])).toEqual(str('ABC'))
  })
})

// =============================================================================
// LEN
// =============================================================================

describe('LEN', () => {
  test('plain ASCII string', () => {
    expect(call('LEN', [str('hello')])).toEqual(num(5))
  })

  test('empty string → 0', () => {
    expect(call('LEN', [str('')])).toEqual(num(0))
  })

  test('coerces non-strings (number → its String() length)', () => {
    expect(call('LEN', [num(12345)])).toEqual(num(5))
  })

  test('emoji counted as 1 codepoint (Unicode-correct, not UTF-16)', () => {
    // String('🎉').length === 2 in JS; LEN must return 1.
    expect(call('LEN', [str('🎉')])).toEqual(num(1))
    expect(call('LEN', [str('🎉🎉🎉')])).toEqual(num(3))
  })

  test('blank → 0', () => {
    expect(call('LEN', [blank])).toEqual(num(0))
  })
})

// =============================================================================
// LOWER / UPPER
// =============================================================================

describe('LOWER', () => {
  test('basic ASCII', () => {
    expect(call('LOWER', [str('HELLO')])).toEqual(str('hello'))
  })

  test('mixed case', () => {
    expect(call('LOWER', [str('Hello World')])).toEqual(str('hello world'))
  })

  test('already lowercase passthrough', () => {
    expect(call('LOWER', [str('foo')])).toEqual(str('foo'))
  })

  test('number coerced before lowercasing', () => {
    expect(call('LOWER', [num(42)])).toEqual(str('42'))
  })
})

describe('UPPER', () => {
  test('basic ASCII', () => {
    expect(call('UPPER', [str('hello')])).toEqual(str('HELLO'))
  })

  test('mixed case', () => {
    expect(call('UPPER', [str('Hello World')])).toEqual(str('HELLO WORLD'))
  })

  test('already uppercase passthrough', () => {
    expect(call('UPPER', [str('FOO')])).toEqual(str('FOO'))
  })

  test('boolean coerces to "TRUE"/"FALSE"', () => {
    expect(call('UPPER', [bool(true)])).toEqual(str('TRUE'))
  })
})

// =============================================================================
// TRIM
// =============================================================================

describe('TRIM', () => {
  test('strips leading and trailing whitespace', () => {
    expect(call('TRIM', [str('   hello   ')])).toEqual(str('hello'))
  })

  test('collapses interior runs to a single space (Excel rule)', () => {
    expect(call('TRIM', [str('hello   world')])).toEqual(str('hello world'))
  })

  test('combined: leading + interior + trailing', () => {
    expect(call('TRIM', [str('  hello   world   ')])).toEqual(str('hello world'))
  })

  test('no whitespace → passthrough', () => {
    expect(call('TRIM', [str('hello')])).toEqual(str('hello'))
  })

  test('empty string → empty string', () => {
    expect(call('TRIM', [str('')])).toEqual(str(''))
  })

  test('all-whitespace → empty', () => {
    expect(call('TRIM', [str('     ')])).toEqual(str(''))
  })
})

// =============================================================================
// TEXT
// =============================================================================

describe('TEXT', () => {
  test('"0" formats integer', () => {
    expect(call('TEXT', [num(42), str('0')])).toEqual(str('42'))
  })

  test('"0" rounds fractional', () => {
    expect(call('TEXT', [num(42.7), str('0')])).toEqual(str('43'))
  })

  test('"0.00" pads to two decimals', () => {
    expect(call('TEXT', [num(3.1), str('0.00')])).toEqual(str('3.10'))
  })

  test('"0.00" truncates / rounds to two decimals', () => {
    expect(call('TEXT', [num(3.14159), str('0.00')])).toEqual(str('3.14'))
  })

  test('"#,##0" inserts thousands separator', () => {
    expect(call('TEXT', [num(1234567), str('#,##0')])).toEqual(str('1,234,567'))
  })

  test('"#,##0.00" thousands + 2 decimals', () => {
    expect(call('TEXT', [num(1234.5), str('#,##0.00')])).toEqual(str('1,234.50'))
  })

  test('"0%" multiplies by 100 and appends %', () => {
    expect(call('TEXT', [num(0.5), str('0%')])).toEqual(str('50%'))
  })

  test('"0.00%" two-decimal percent', () => {
    expect(call('TEXT', [num(0.12345), str('0.00%')])).toEqual(str('12.35%'))
  })

  test('"$#,##0.00" USD currency', () => {
    expect(call('TEXT', [num(1234.5), str('$#,##0.00')])).toEqual(str('$1,234.50'))
  })

  test('negative number formats with leading sign for thousands format', () => {
    expect(call('TEXT', [num(-1234.5), str('#,##0.00')])).toEqual(str('-1,234.50'))
  })

  test('text input passes through unchanged (Excel rule)', () => {
    expect(call('TEXT', [str('already text'), str('0.00')])).toEqual(str('already text'))
  })

  test('unknown format code falls back to String(n) (TODO: broader parser)', () => {
    // We document this as a punt — out-of-scope format codes return raw String(n).
    expect(call('TEXT', [num(42), str('yyyy-mm-dd')])).toEqual(str('42'))
  })

  test('negative-format suffix punted: positive section applied (out of scope)', () => {
    // "#,##0;(#,##0)" is the negative-suffix form; we keep only the positive
    // section per task brief. Negative values format with the positive
    // format (so `-1234` → `-1,234`, not `(1,234)`).
    expect(call('TEXT', [num(-1234), str('#,##0;(#,##0)')])).toEqual(str('-1,234'))
  })

  test('error propagation', () => {
    expect(call('TEXT', [errVal('#REF!'), str('0')])).toEqual({
      kind: 'error',
      code: '#REF!',
    })
  })
})

// =============================================================================
// VALUE
// =============================================================================

describe('VALUE', () => {
  test('parses bare digit string', () => {
    expect(call('VALUE', [str('42')])).toEqual(num(42))
  })

  test('parses decimal', () => {
    expect(call('VALUE', [str('3.14')])).toEqual(num(3.14))
  })

  test('strips leading $', () => {
    expect(call('VALUE', [str('$1234.50')])).toEqual(num(1234.5))
  })

  test('strips thousands separator', () => {
    expect(call('VALUE', [str('1,234,567')])).toEqual(num(1234567))
  })

  test('trailing % divides by 100', () => {
    expect(call('VALUE', [str('50%')])).toEqual(num(0.5))
  })

  test('combined: $, thousands, decimal', () => {
    expect(call('VALUE', [str('$1,234.56')])).toEqual(num(1234.56))
  })

  test('leading minus negates', () => {
    expect(call('VALUE', [str('-1,000')])).toEqual(num(-1000))
  })

  test('whitespace tolerated', () => {
    expect(call('VALUE', [str('  42  ')])).toEqual(num(42))
  })

  test('passthrough for number input', () => {
    expect(call('VALUE', [num(7)])).toEqual(num(7))
  })

  test('boolean coerces TRUE→1 / FALSE→0', () => {
    expect(call('VALUE', [bool(true)])).toEqual(num(1))
    expect(call('VALUE', [bool(false)])).toEqual(num(0))
  })

  test('blank → 0', () => {
    expect(call('VALUE', [blank])).toEqual(num(0))
  })

  test('garbage string → #VALUE!', () => {
    expect(call('VALUE', [str('not a number')])).toEqual({ kind: 'error', code: '#VALUE!' })
  })

  test('empty string → #VALUE!', () => {
    expect(call('VALUE', [str('')])).toEqual({ kind: 'error', code: '#VALUE!' })
  })

  test('malformed thousands (e.g. leading comma) → #VALUE!', () => {
    expect(call('VALUE', [str(',123')])).toEqual({ kind: 'error', code: '#VALUE!' })
  })

  test('error propagation', () => {
    expect(call('VALUE', [errVal('#N/A')])).toEqual({ kind: 'error', code: '#N/A' })
  })
})

// =============================================================================
// SEARCH  (Wave F / F1)
// =============================================================================

// Helper for SEARCH/FIND tests — strips the optional `message` field
// on error results so we can compare against `{kind, code}` only.
function errCodeOf(v: Value): string | undefined {
  if (v.kind !== 'error') return undefined
  return v.code
}

describe('SEARCH', () => {
  test('case-insensitive position (1-based)', () => {
    // "LO" appears at index 4 ('l') and 'o' is index 5, "LO" matches starting at 'l' (pos 4).
    expect(call('SEARCH', [str('LO'), str('hello world')])).toEqual(num(4))
    expect(call('SEARCH', [str('hello'), str('Hello World')])).toEqual(num(1))
  })

  test('start argument restricts search window', () => {
    // 'o' at pos 5 (in 'hello'); next 'o' at pos 8 (in 'world'). start=6 → 8.
    expect(call('SEARCH', [str('o'), str('hello world'), num(6)])).toEqual(num(8))
  })

  test('not found → #VALUE!', () => {
    expect(errCodeOf(call('SEARCH', [str('xyz'), str('hello world')]))).toBe('#VALUE!')
  })

  test('wildcard ? matches single char', () => {
    expect(call('SEARCH', [str('h?llo'), str('hello world')])).toEqual(num(1))
  })

  test('wildcard * matches any run', () => {
    expect(call('SEARCH', [str('h*o'), str('hello world')])).toEqual(num(1))
  })

  test('~* escapes wildcard', () => {
    // 'a*' literal at position 5 in 'abc a* def'.
    expect(call('SEARCH', [str('a~*'), str('abc a* def')])).toEqual(num(5))
    expect(errCodeOf(call('SEARCH', [str('a~*'), str('abc def')]))).toBe('#VALUE!')
  })

  test('start < 1 → #VALUE!', () => {
    expect(errCodeOf(call('SEARCH', [str('h'), str('hello'), num(0)]))).toBe('#VALUE!')
  })

  test('error propagation', () => {
    expect(call('SEARCH', [errVal('#N/A'), str('hello')])).toEqual({
      kind: 'error',
      code: '#N/A',
    })
  })
})

// =============================================================================
// FIND  (Wave F / F1)
// =============================================================================

describe('FIND', () => {
  test('case-sensitive position (1-based)', () => {
    expect(call('FIND', [str('lo'), str('hello world')])).toEqual(num(4))
  })

  test('case mismatch → #VALUE! (no fallback)', () => {
    expect(errCodeOf(call('FIND', [str('LO'), str('hello world')]))).toBe('#VALUE!')
  })

  test('start argument restricts search', () => {
    expect(call('FIND', [str('o'), str('hello world'), num(6)])).toEqual(num(8))
  })

  test('wildcards are literal (no expansion)', () => {
    expect(call('FIND', [str('h*o'), str('hello h*o!')])).toEqual(num(7))
  })

  test('not found → #VALUE!', () => {
    expect(errCodeOf(call('FIND', [str('xyz'), str('hello world')]))).toBe('#VALUE!')
  })

  test('start < 1 → #VALUE!', () => {
    expect(errCodeOf(call('FIND', [str('h'), str('hello'), num(0)]))).toBe('#VALUE!')
  })

  test('error propagation', () => {
    expect(call('FIND', [errVal('#REF!'), str('hello')])).toEqual({
      kind: 'error',
      code: '#REF!',
    })
  })
})
