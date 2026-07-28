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

  test('does not trim tabs, newlines, or non-breaking spaces', () => {
    expect(call('TRIM', [str('\thello   world\n')])).toEqual(str('\thello world\n'))
    expect(call('TRIM', [str('\u00a0 hello  world \u00a0')])).toEqual(
      str('\u00a0 hello world \u00a0'),
    )
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

  test('"0" rounds negative halves away from zero', () => {
    expect(call('TEXT', [num(-2.5), str('0')])).toEqual(str('-3'))
  })

  test('"000" pads integer width', () => {
    expect(call('TEXT', [num(7), str('000')])).toEqual(str('007'))
  })

  test('"0.00" pads to two decimals', () => {
    expect(call('TEXT', [num(3.1), str('0.00')])).toEqual(str('3.10'))
  })

  test('"0.00" truncates / rounds to two decimals', () => {
    expect(call('TEXT', [num(3.14159), str('0.00')])).toEqual(str('3.14'))
  })

  test('decimal formats round halves away from zero despite binary float noise', () => {
    expect(call('TEXT', [num(1.005), str('0.00')])).toEqual(str('1.01'))
    expect(call('TEXT', [num(-1.005), str('0.00')])).toEqual(str('-1.01'))
    expect(call('TEXT', [num(0.145), str('0.00')])).toEqual(str('0.15'))
    expect(call('TEXT', [num(2.675), str('0.00')])).toEqual(str('2.68'))
    expect(call('TEXT', [num(1.005), str('#,##0.00')])).toEqual(str('1.01'))
    expect(call('TEXT', [num(0.01005), str('0.00%')])).toEqual(str('1.01%'))
    expect(call('TEXT', [num(9.995), str('0.00E+00')])).toEqual(str('1.00E+01'))
  })

  test('decimal rounding epsilon does not move large exact integers', () => {
    expect(call('TEXT', [num(3000000000000000), str('0.00')])).toEqual(
      str('3000000000000000.00'),
    )
  })

  test('custom format appends quoted literal text', () => {
    expect(call('TEXT', [num(12.34), str('0.0" kg"')])).toEqual(str('12.3 kg'))
  })

  test('custom format preserves literal spaces and spacing controls', () => {
    expect(call('TEXT', [num(12), str(' 0 ')])).toEqual(str(' 12 '))
    expect(call('TEXT', [num(12), str('0.0_);(0.0)')])).toEqual(str('12.0 '))
    expect(call('TEXT', [num(12), str('0*x')])).toEqual(str('12'))
  })

  test('custom format sections ignore semicolons inside quoted literals', () => {
    expect(call('TEXT', [num(12), str('0";kg";0')])).toEqual(str('12;kg'))
  })

  test('"#,##0" inserts thousands separator', () => {
    expect(call('TEXT', [num(1234567), str('#,##0')])).toEqual(str('1,234,567'))
  })

  test('custom format trailing comma scales by thousands', () => {
    expect(call('TEXT', [num(1234567), str('#,##0,')])).toEqual(str('1,235'))
  })

  test('custom format multiple trailing commas scale by millions', () => {
    expect(call('TEXT', [num(1234567890), str('#,##0,,')])).toEqual(str('1,235'))
  })

  test('"#,##0.00" thousands + 2 decimals', () => {
    expect(call('TEXT', [num(1234.5), str('#,##0.00')])).toEqual(str('1,234.50'))
  })

  test('"0%" multiplies by 100 and appends %', () => {
    expect(call('TEXT', [num(0.5), str('0%')])).toEqual(str('50%'))
    expect(call('TEXT', [num(-0.025), str('0%')])).toEqual(str('-3%'))
  })

  test('"0.00%" two-decimal percent', () => {
    expect(call('TEXT', [num(0.12345), str('0.00%')])).toEqual(str('12.35%'))
  })

  test('"$#,##0.00" USD currency', () => {
    expect(call('TEXT', [num(1234.5), str('$#,##0.00')])).toEqual(str('$1,234.50'))
  })

  test('custom format strips bracket color and currency tags', () => {
    expect(call('TEXT', [num(12.34), str('[Red]0.0')])).toEqual(str('12.3'))
    expect(call('TEXT', [num(1234.5), str('[$$-409]#,##0.00')])).toEqual(str('$1,234.50'))
    expect(call('TEXT', [num(1234.5), str('[$¥-411]#,##0.00')])).toEqual(str('¥1,234.50'))
  })

  test('negative number formats with leading sign for thousands format', () => {
    expect(call('TEXT', [num(-1234.5), str('#,##0.00')])).toEqual(str('-1,234.50'))
  })

  test('text input passes through unchanged without text section', () => {
    expect(call('TEXT', [str('already text'), str('0.00')])).toEqual(str('already text'))
  })

  test('text input applies @ placeholder formats', () => {
    expect(call('TEXT', [str('abc'), str('@')])).toEqual(str('abc'))
    expect(call('TEXT', [str('abc'), str('prefix @ suffix')])).toEqual(
      str('prefix abc suffix'),
    )
  })

  test('text input uses the fourth custom-format section', () => {
    const accounting = '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)'

    expect(call('TEXT', [str('abc'), str('0;-0;0;text: @')])).toEqual(str('text: abc'))
    expect(call('TEXT', [str('abc'), str('0;-0;0;')])).toEqual(str(''))
    expect(call('TEXT', [str('abc'), str(accounting)])).toEqual(str(' abc '))
  })

  test('@ text placeholders do not make numeric formats valid', () => {
    expect(call('TEXT', [num(42), str('@')])).toEqual(errVal('#VALUE!'))
    expect(call('TEXT', [num(42), str('prefix @ suffix')])).toEqual(errVal('#VALUE!'))
    expect(call('TEXT', [num(42), str('unsupported')])).toEqual(errVal('#VALUE!'))
  })

  test('date format code formats Excel serials', () => {
    expect(call('TEXT', [num(45306), str('yyyy-mm-dd')])).toEqual(str('2024-01-15'))
  })

  test('date format handles month and weekday names plus quoted literals', () => {
    expect(call('TEXT', [num(44197), str('d-mmm-yyyy')])).toEqual(str('1-Jan-2021'))
    expect(call('TEXT', [num(44197), str('mmmm d, yyyy')])).toEqual(str('January 1, 2021'))
    expect(call('TEXT', [num(44197), str('ddd, mmmm d')])).toEqual(str('Fri, January 1'))
    expect(call('TEXT', [num(44197), str('m"月"d"日"')])).toEqual(str('1月1日'))
  })

  test('time format handles 24-hour and AM/PM clocks', () => {
    expect(call('TEXT', [num(0.5), str('hh:mm:ss')])).toEqual(str('12:00:00'))
    expect(call('TEXT', [num(0.75), str('h:mm AM/PM')])).toEqual(str('6:00 PM'))
    expect(call('TEXT', [num(0.25), str('h:mm A/P')])).toEqual(str('6:00 A'))
    expect(call('TEXT', [num(44197.75), str('yyyy-mm-dd h:mm AM/PM')])).toEqual(
      str('2021-01-01 6:00 PM'),
    )
  })

  test('time format handles elapsed duration and fractional seconds', () => {
    expect(call('TEXT', [num(1.5), str('[h]:mm:ss')])).toEqual(str('36:00:00'))
    expect(call('TEXT', [num(1.5), str('[m]:ss')])).toEqual(str('2160:00'))
    expect(call('TEXT', [num(1.5), str('[s]')])).toEqual(str('129600'))
    expect(call('TEXT', [num(0.5 + 0.123 / 86400), str('hh:mm:ss.000')])).toEqual(
      str('12:00:00.123'),
    )
    expect(call('TEXT', [num(3735.8 / 86400), str('[ss].00')])).toEqual(str('3735.80'))
  })

  test('unknown numeric format code returns #VALUE!', () => {
    expect(call('TEXT', [num(42), str('unsupported')])).toEqual(errVal('#VALUE!'))
  })

  test('negative-format suffix uses the negative section', () => {
    expect(call('TEXT', [num(-1234), str('#,##0;(#,##0)')])).toEqual(str('(1,234)'))
  })

  test('custom format supports conditional and literal-only sections', () => {
    const size = '[>100]"large";[<=100]"small"'
    expect(call('TEXT', [num(150), str(size)])).toEqual(str('large'))
    expect(call('TEXT', [num(50), str(size)])).toEqual(str('small'))
    expect(call('TEXT', [num(0), str('#,##0;-#,##0;"zero"')])).toEqual(str('zero'))
    expect(call('TEXT', [num(0), str('0;-0;;@')])).toEqual(str(''))
    expect(call('TEXT', [num(-5), str('0;;0')])).toEqual(str(''))
  })

  test('custom optional digit placeholders can suppress leading zero', () => {
    expect(call('TEXT', [num(0), str('#')])).toEqual(str(''))
    expect(call('TEXT', [num(0.5), str('#.##')])).toEqual(str('.5'))
    expect(call('TEXT', [num(12), str('###')])).toEqual(str('12'))
  })

  test('custom special masks preserve internal separators', () => {
    expect(call('TEXT', [num(123456789), str('000-00-0000')])).toEqual(str('123-45-6789'))
    expect(call('TEXT', [num(1234), str('000-00-0000')])).toEqual(str('000-00-1234'))
    expect(call('TEXT', [num(4155551234), str('(000) 000-0000')])).toEqual(
      str('(415) 555-1234'),
    )
    expect(call('TEXT', [num(1234), str('00000-0000')])).toEqual(str('00000-1234'))
  })

  test('"0.00E+00" formats scientific notation', () => {
    expect(call('TEXT', [num(12200000), str('0.00E+00')])).toEqual(str('1.22E+07'))
    expect(call('TEXT', [num(0.0122), str('0.00E+00')])).toEqual(str('1.22E-02'))
    expect(call('TEXT', [num(-1234), str('0.00E+00')])).toEqual(str('-1.23E+03'))
  })

  test('"# ?/?" formats simple one-digit fractions', () => {
    expect(call('TEXT', [num(4.34), str('# ?/?')])).toEqual(str('4 1/3'))
    expect(call('TEXT', [num(0.34), str('# ?/?')])).toEqual(str(' 1/3'))
    expect(call('TEXT', [num(2.25), str('# ?/?')])).toEqual(str('2 1/4'))
  })

  test('bracket color tags preserve date, scientific, and fraction paths', () => {
    expect(call('TEXT', [num(45306), str('[Red]yyyy-mm-dd')])).toEqual(str('2024-01-15'))
    expect(call('TEXT', [num(12200000), str('[Red]0.00E+00')])).toEqual(str('1.22E+07'))
    expect(call('TEXT', [num(4.34), str('[Red]# ?/?')])).toEqual(str('4 1/3'))
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
    expect(call('SEARCH', [str('~~'), str('a~b')])).toEqual(num(2))
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

// =============================================================================
// LEFTB / RIGHTB / MIDB / LENB
// =============================================================================

describe('LEFTB / RIGHTB / MIDB / LENB', () => {
  test('ASCII text behaves like character-based variants', () => {
    expect(call('LENB', [str('abcdef')])).toEqual(num(6))
    expect(call('LEFTB', [str('abcdef'), num(3)])).toEqual(str('abc'))
    expect(call('RIGHTB', [str('abcdef'), num(3)])).toEqual(str('def'))
    expect(call('MIDB', [str('abcdef'), num(2), num(3)])).toEqual(str('bcd'))
  })

  test('Japanese full-width characters count as two bytes', () => {
    expect(call('LENB', [str('AあBい')])).toEqual(num(6))
    expect(call('LEFTB', [str('あいA'), num(3)])).toEqual(str('あ'))
    expect(call('RIGHTB', [str('AあBい'), num(3)])).toEqual(str('Bい'))
    expect(call('MIDB', [str('AあBいC'), num(2), num(3)])).toEqual(str('あB'))
  })

  test('partial double-byte boundary is not returned', () => {
    expect(call('LEFTB', [str('あ'), num(1)])).toEqual(str(''))
    expect(call('RIGHTB', [str('あい'), num(3)])).toEqual(str('い'))
  })

  test('MIDB start beyond length returns empty', () => {
    expect(call('MIDB', [str('Aあ'), num(99), num(2)])).toEqual(str(''))
  })

  test('byte counts truncate toward zero', () => {
    expect(call('LEFTB', [str('abcdef'), num(2.9)])).toEqual(str('ab'))
    expect(call('MIDB', [str('abcdef'), num(2.9), num(2.9)])).toEqual(str('bc'))
  })

  test('invalid byte arguments → #VALUE!', () => {
    expect(errCodeOf(call('LEFTB', [str('abc'), num(-1)]))).toBe('#VALUE!')
    expect(errCodeOf(call('RIGHTB', [str('abc'), num(-1)]))).toBe('#VALUE!')
    expect(errCodeOf(call('MIDB', [str('abc'), num(0), num(1)]))).toBe('#VALUE!')
    expect(errCodeOf(call('MIDB', [str('abc'), num(1), num(-1)]))).toBe('#VALUE!')
  })
})

// =============================================================================
// SEARCHB / FINDB
// =============================================================================

describe('SEARCHB', () => {
  test('returns DBCS byte position and ignores case', () => {
    expect(call('SEARCHB', [str('a'), str('あA')])).toEqual(num(3))
  })

  test('supports SEARCH wildcards with byte positions', () => {
    expect(call('SEARCHB', [str('あ?'), str('xxあB')])).toEqual(num(3))
  })

  test('start byte skips earlier matches', () => {
    expect(call('SEARCHB', [str('あ'), str('あxあ'), num(3)])).toEqual(num(4))
  })

  test('not found → #VALUE!', () => {
    expect(errCodeOf(call('SEARCHB', [str('zz'), str('あA')]))).toBe('#VALUE!')
  })

  test('start byte out of range → #VALUE!', () => {
    expect(errCodeOf(call('SEARCHB', [str('A'), str('あA'), num(0)]))).toBe('#VALUE!')
    expect(errCodeOf(call('SEARCHB', [str('A'), str('あA'), num(99)]))).toBe('#VALUE!')
  })
})

describe('FINDB', () => {
  test('returns DBCS byte position and remains case-sensitive', () => {
    expect(call('FINDB', [str('本'), str('熊本A')])).toEqual(num(3))
    expect(errCodeOf(call('FINDB', [str('a'), str('熊本A')]))).toBe('#VALUE!')
  })

  test('start byte skips earlier matches', () => {
    expect(call('FINDB', [str('熊'), str('熊本熊'), num(3)])).toEqual(num(5))
  })

  test('wildcards are literal', () => {
    expect(call('FINDB', [str('A*'), str('あA*')])).toEqual(num(3))
  })

  test('not found → #VALUE!', () => {
    expect(errCodeOf(call('FINDB', [str('xyz'), str('熊本A')]))).toBe('#VALUE!')
  })

  test('start byte out of range → #VALUE!', () => {
    expect(errCodeOf(call('FINDB', [str('A'), str('熊本A'), num(0)]))).toBe('#VALUE!')
    expect(errCodeOf(call('FINDB', [str('A'), str('熊本A'), num(99)]))).toBe('#VALUE!')
  })
})

// =============================================================================
// REPLACEB
// =============================================================================

describe('REPLACEB', () => {
  test('ASCII text behaves like REPLACE', () => {
    expect(call('REPLACEB', [str('abcdef'), num(2), num(3), str('X')])).toEqual(str('aXef'))
  })

  test('replaces Japanese full-width character by byte range', () => {
    expect(call('REPLACEB', [str('AあBいC'), num(2), num(2), str('X')])).toEqual(
      str('AXBいC'),
    )
  })

  test('zero bytes inserts at byte boundary', () => {
    expect(call('REPLACEB', [str('AあB'), num(2), num(0), str('-')])).toEqual(str('A-あB'))
  })

  test('start beyond length appends replacement', () => {
    expect(call('REPLACEB', [str('Aあ'), num(99), num(2), str('Z')])).toEqual(str('AあZ'))
  })

  test('invalid byte arguments → #VALUE!', () => {
    expect(errCodeOf(call('REPLACEB', [str('abc'), num(0), num(1), str('X')]))).toBe('#VALUE!')
    expect(errCodeOf(call('REPLACEB', [str('abc'), num(1), num(-1), str('X')]))).toBe(
      '#VALUE!',
    )
  })
})
