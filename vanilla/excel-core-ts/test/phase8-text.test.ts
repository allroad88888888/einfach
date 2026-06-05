/**
 * Phase 8 — text function additions tests.
 *
 * Covers REPLACE, SUBSTITUTE, REPT, CHAR, CODE, EXACT, PROPER, T, CLEAN,
 * TEXTJOIN, UNICODE, UNICHAR.
 */

import { describe, expect, test } from '@jest/globals'

import { FUNCTIONS } from '../src/eval/functions/text'
import type { EvalContext, FunctionImpl, Value } from '../src/types'

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const STR = (s: string): Value => ({ kind: 'string', value: s })
const BOOL = (b: boolean): Value => ({ kind: 'boolean', value: b })
const BLANK: Value = { kind: 'blank' }
const ARR = (rows: Value[][]): Value => ({ kind: 'array', value: rows })
const ERR = (code: '#DIV/0!' | '#N/A' | '#NUM!' | '#VALUE!' | '#REF!'): Value => ({
  kind: 'error',
  code,
})

const ctx: EvalContext = new Proxy(
  {},
  {
    get(_, prop) {
      throw new Error(`phase8 text unexpectedly read ctx.${String(prop)}`)
    },
  },
) as unknown as EvalContext

const get = (name: string): FunctionImpl => {
  const f = FUNCTIONS[name]
  if (!f) throw new Error(`No function ${name} in registry`)
  return f
}
const call = (name: string, args: Value[]): Value => get(name)(args, ctx)

describe('REPLACE', () => {
  test('replaces middle chars', () =>
    expect(call('REPLACE', [STR('Hello World'), NUM(7), NUM(5), STR('there')])).toEqual(
      STR('Hello there'),
    ))
  test('zero num_chars: pure insertion', () =>
    expect(call('REPLACE', [STR('abcde'), NUM(3), NUM(0), STR('X')])).toEqual(STR('abXcde')))
  test('start < 1 → #VALUE!', () =>
    expect(call('REPLACE', [STR('abc'), NUM(0), NUM(1), STR('X')])).toEqual(ERR('#VALUE!')))
})

describe('SUBSTITUTE', () => {
  test('replace all occurrences by default', () =>
    expect(call('SUBSTITUTE', [STR('a-b-c'), STR('-'), STR('|')])).toEqual(STR('a|b|c')))
  test('replace only nth instance', () =>
    expect(call('SUBSTITUTE', [STR('a-b-c-d'), STR('-'), STR('|'), NUM(2)])).toEqual(
      STR('a-b|c-d'),
    ))
  test('empty old_text → unchanged', () =>
    expect(call('SUBSTITUTE', [STR('hello'), STR(''), STR('X')])).toEqual(STR('hello')))
})

describe('REPT', () => {
  test('repeats N times', () => expect(call('REPT', [STR('ab'), NUM(3)])).toEqual(STR('ababab')))
  test('zero times → ""', () => expect(call('REPT', [STR('ab'), NUM(0)])).toEqual(STR('')))
  test('negative → #VALUE!', () => expect(call('REPT', [STR('ab'), NUM(-1)])).toEqual(ERR('#VALUE!')))
})

describe('CHAR / CODE', () => {
  test("CHAR(65) = 'A'", () => expect(call('CHAR', [NUM(65)])).toEqual(STR('A')))
  test("CODE('A') = 65", () => expect(call('CODE', [STR('A')])).toEqual(NUM(65)))
  test('CHAR(0) → #VALUE!', () => expect(call('CHAR', [NUM(0)])).toEqual(ERR('#VALUE!')))
  test('CHAR only accepts 1..255', () => expect(call('CHAR', [NUM(256)])).toEqual(ERR('#VALUE!')))
  test('CODE("") → #VALUE!', () => expect(call('CODE', [STR('')])).toEqual(ERR('#VALUE!')))
  test('CODE rejects characters outside 1..255', () =>
    expect(call('CODE', [STR('中')])).toEqual(ERR('#VALUE!')))
})

describe('EXACT', () => {
  test('case-sensitive equal', () => expect(call('EXACT', [STR('Foo'), STR('Foo')])).toEqual(BOOL(true)))
  test('case-sensitive not equal', () =>
    expect(call('EXACT', [STR('Foo'), STR('foo')])).toEqual(BOOL(false)))
  test('numbers coerce to text first', () =>
    expect(call('EXACT', [NUM(5), STR('5')])).toEqual(BOOL(true)))
})

describe('PROPER', () => {
  test('Title Case basic', () =>
    expect(call('PROPER', [STR('hello world')])).toEqual(STR('Hello World')))
  test('uppercase input gets lowercased except first letters', () =>
    expect(call('PROPER', [STR('HELLO WORLD')])).toEqual(STR('Hello World')))
  test("apostrophes break words: o'connor → O'Connor", () =>
    expect(call('PROPER', [STR("o'connor")])).toEqual(STR("O'Connor")))
})

describe('T', () => {
  test('string passthrough', () => expect(call('T', [STR('hello')])).toEqual(STR('hello')))
  test('number → ""', () => expect(call('T', [NUM(5)])).toEqual(STR('')))
  test('error propagates', () => expect(call('T', [ERR('#N/A')])).toEqual(ERR('#N/A')))
})

describe('CLEAN', () => {
  test('strip ASCII control chars', () =>
    expect(call('CLEAN', [STR('hello\x01\x02world')])).toEqual(STR('helloworld')))
  test('preserves printable text', () =>
    expect(call('CLEAN', [STR('hi there')])).toEqual(STR('hi there')))
  test('error propagates', () => expect(call('CLEAN', [ERR('#REF!')])).toEqual(ERR('#REF!')))
})

describe('TEXTJOIN', () => {
  test('joins with delimiter', () =>
    expect(call('TEXTJOIN', [STR('-'), BOOL(true), STR('a'), STR('b'), STR('c')])).toEqual(
      STR('a-b-c'),
    ))
  test('ignore_empty=TRUE skips blanks', () =>
    expect(call('TEXTJOIN', [STR(','), BOOL(true), STR('a'), STR(''), BLANK, STR('c')])).toEqual(
      STR('a,c'),
    ))
  test('ignore_empty=FALSE includes blanks', () =>
    expect(call('TEXTJOIN', [STR(','), BOOL(false), STR('a'), STR(''), STR('c')])).toEqual(
      STR('a,,c'),
    ))
  test('returns #VALUE! when result exceeds 32767 characters', () =>
    expect(call('TEXTJOIN', [STR(''), BOOL(true), STR('x'.repeat(32767)), STR('x')])).toEqual(
      ERR('#VALUE!'),
    ))
})

describe('UNICODE / UNICHAR', () => {
  test("UNICHAR(65) = 'A'", () => expect(call('UNICHAR', [NUM(65)])).toEqual(STR('A')))
  test("UNICODE('A') = 65", () => expect(call('UNICODE', [STR('A')])).toEqual(NUM(65)))
  test('UNICHAR for emoji', () =>
    expect(call('UNICHAR', [NUM(0x1f600)])).toEqual(STR(String.fromCodePoint(0x1f600))))
  test('UNICODE for non-ANSI text', () =>
    expect(call('UNICODE', [STR('中')])).toEqual(NUM('中'.codePointAt(0)!)))
  test('surrogate code points are invalid', () => {
    expect(call('UNICHAR', [NUM(0xd800)])).toEqual(ERR('#VALUE!'))
    expect(call('UNICHAR', [NUM(0xdfff)])).toEqual(ERR('#VALUE!'))
    expect(call('UNICODE', [STR('\uD800')])).toEqual(ERR('#VALUE!'))
  })
})

describe('TEXTBEFORE / TEXTAFTER', () => {
  test('default and nth positive occurrence', () => {
    expect(call('TEXTBEFORE', [STR('alpha-beta-gamma'), STR('-')])).toEqual(STR('alpha'))
    expect(call('TEXTAFTER', [STR('alpha-beta-gamma'), STR('-'), NUM(2)])).toEqual(STR('gamma'))
  })

  test('negative instance counts from the right', () => {
    expect(call('TEXTBEFORE', [STR('a-b-c-d'), STR('-'), NUM(-1)])).toEqual(STR('a-b-c'))
    expect(call('TEXTAFTER', [STR('a-b-c-d'), STR('-'), NUM(-1)])).toEqual(STR('d'))
  })

  test('case-insensitive mode and delimiter arrays', () => {
    expect(call('TEXTBEFORE', [STR('axb'), STR('X'), NUM(1), NUM(1)])).toEqual(STR('a'))
    expect(call('TEXTAFTER', [STR('a,b;c'), ARR([[STR(','), STR(';')]])])).toEqual(STR('b;c'))
  })

  test('match_end creates virtual boundary matches', () => {
    expect(call('TEXTBEFORE', [STR('Socrates'), STR(' '), NUM(1), NUM(0), NUM(1)])).toEqual(
      STR('Socrates'),
    )
    expect(call('TEXTAFTER', [STR('a-b'), STR('-'), NUM(-1), NUM(0), NUM(1)])).toEqual(STR(''))
  })

  test('empty delimiter matches immediately', () => {
    expect(call('TEXTBEFORE', [STR('abc'), STR('')])).toEqual(STR(''))
    expect(call('TEXTAFTER', [STR('abc'), STR('')])).toEqual(STR('abc'))
    expect(call('TEXTBEFORE', [STR('abc'), STR(''), NUM(-1)])).toEqual(STR('abc'))
    expect(call('TEXTAFTER', [STR('abc'), STR(''), NUM(-1)])).toEqual(STR(''))
  })

  test('not found uses #N/A by default or custom fallback', () => {
    expect(call('TEXTBEFORE', [STR('abc'), STR('-')])).toEqual(ERR('#N/A'))
    expect(call('TEXTBEFORE', [STR('abc'), STR('-'), NUM(1), NUM(0), NUM(0), STR('miss')])).toEqual(
      STR('miss'),
    )
  })

  test('invalid instance and upstream errors propagate', () => {
    expect(call('TEXTAFTER', [STR('abc'), STR('-'), NUM(0)])).toEqual(ERR('#VALUE!'))
    expect(call('TEXTBEFORE', [ERR('#REF!'), STR('-')])).toEqual(ERR('#REF!'))
  })
})

describe('TEXTSPLIT', () => {
  test('splits by column delimiter into a row array', () => {
    expect(call('TEXTSPLIT', [STR('a,b,c'), STR(',')])).toEqual(
      ARR([[STR('a'), STR('b'), STR('c')]]),
    )
  })

  test('splits by row and column delimiters and pads jagged rows with #N/A', () => {
    expect(call('TEXTSPLIT', [STR('a,b;c,d,e'), STR(','), STR(';')])).toEqual(
      ARR([[STR('a'), STR('b'), ERR('#N/A')], [STR('c'), STR('d'), STR('e')]]),
    )
  })

  test('ignore_empty and case-insensitive match mode', () => {
    expect(call('TEXTSPLIT', [STR('a,,B,'), STR(','), STR(''), BOOL(true)])).toEqual(
      ARR([[STR('a'), STR('B')]]),
    )
    expect(call('TEXTSPLIT', [STR('axb'), STR('X'), STR(''), BOOL(false), NUM(1)])).toEqual(
      ARR([[STR('a'), STR('b')]]),
    )
  })

  test('array delimiters and empty text', () => {
    expect(call('TEXTSPLIT', [STR('a,b;c'), ARR([[STR(','), STR(';')]])])).toEqual(
      ARR([[STR('a'), STR('b'), STR('c')]]),
    )
    expect(call('TEXTSPLIT', [STR(''), STR(',')])).toEqual(ARR([[STR('')]]))
  })

  test('invalid match mode and errors propagate', () => {
    expect(call('TEXTSPLIT', [STR('a,b'), STR(','), STR(''), BOOL(false), NUM(2)])).toEqual(
      ERR('#VALUE!'),
    )
    expect(call('TEXTSPLIT', [ERR('#DIV/0!'), STR(',')])).toEqual(ERR('#DIV/0!'))
  })
})

describe('REGEXTEST / REGEXEXTRACT / REGEXREPLACE', () => {
  test('REGEXTEST supports case mode and invalid patterns', () => {
    expect(call('REGEXTEST', [STR('hello'), STR('ell')])).toEqual(BOOL(true))
    expect(call('REGEXTEST', [STR('Hello'), STR('hello')])).toEqual(BOOL(false))
    expect(call('REGEXTEST', [STR('Hello'), STR('hello'), NUM(1)])).toEqual(BOOL(true))
    expect(call('REGEXTEST', [STR('hello'), STR('[')])).toEqual(ERR('#VALUE!'))
  })

  test('REGEXEXTRACT returns first match or all matches', () => {
    expect(call('REGEXEXTRACT', [STR('abc123def'), STR('[0-9]+')])).toEqual(STR('123'))
    expect(call('REGEXEXTRACT', [STR('a1 b2 c3'), STR('[a-z][0-9]'), NUM(1)])).toEqual(
      ARR([[STR('a1')], [STR('b2')], [STR('c3')]]),
    )
    expect(call('REGEXEXTRACT', [STR('SoniaBrown'), STR('([A-Z][a-z]+)([A-Z][a-z]+)'), NUM(2)])).toEqual(
      ARR([[STR('Sonia'), STR('Brown')]]),
    )
  })

  test('REGEXEXTRACT no match and error propagation', () => {
    expect(call('REGEXEXTRACT', [STR('abc'), STR('[0-9]+')])).toEqual(ERR('#N/A'))
    expect(call('REGEXEXTRACT', [ERR('#N/A'), STR('[0-9]+')])).toEqual(ERR('#N/A'))
  })

  test('REGEXREPLACE replaces all, nth occurrence, and case-insensitive matches', () => {
    expect(call('REGEXREPLACE', [STR('a1 b2 c3'), STR('[0-9]'), STR('X')])).toEqual(
      STR('aX bX cX'),
    )
    expect(call('REGEXREPLACE', [STR('a1 b2 c3'), STR('[0-9]'), STR('X'), NUM(2)])).toEqual(
      STR('a1 bX c3'),
    )
    expect(
      call('REGEXREPLACE', [STR('HELLO hello'), STR('hello'), STR('X'), NUM(0), NUM(1)]),
    ).toEqual(STR('X X'))
    expect(
      call('REGEXREPLACE', [
        STR('SoniaBrown'),
        STR('([A-Z][a-z]+)([A-Z][a-z]+)'),
        STR('$2, $1'),
      ]),
    ).toEqual(STR('Brown, Sonia'))
  })

  test('REGEXREPLACE missing nth match returns original text', () => {
    expect(call('REGEXREPLACE', [STR('a1'), STR('[0-9]'), STR('X'), NUM(3)])).toEqual(STR('a1'))
    expect(call('REGEXREPLACE', [STR('a1 b2 c3'), STR('[0-9]'), STR('X'), NUM(-1)])).toEqual(
      STR('a1 b2 cX'),
    )
  })
})

describe('NUMBERVALUE / DOLLAR / FIXED', () => {
  test('NUMBERVALUE parses default separators, swapped separators, and percents', () => {
    expect(call('NUMBERVALUE', [STR('1,234.56')])).toEqual(NUM(1234.56))
    expect(call('NUMBERVALUE', [STR('1.234,56'), STR(','), STR('.')])).toEqual(NUM(1234.56))
    expect(call('NUMBERVALUE', [STR('100%%')])).toEqual(NUM(0.01))
    expect(call('NUMBERVALUE', [STR('')])).toEqual(NUM(0))
  })

  test('NUMBERVALUE rejects same separators and propagates errors', () => {
    expect(call('NUMBERVALUE', [STR('1.2'), STR('.'), STR('.')])).toEqual(ERR('#VALUE!'))
    expect(call('NUMBERVALUE', [ERR('#REF!')])).toEqual(ERR('#REF!'))
  })

  test('DOLLAR formats currency with defaults, negatives, and decimals', () => {
    expect(call('DOLLAR', [NUM(1234.567)])).toEqual(STR('$1,234.57'))
    expect(call('DOLLAR', [NUM(-1234.5)])).toEqual(STR('($1,234.50)'))
    expect(call('DOLLAR', [NUM(1234.567), NUM(0)])).toEqual(STR('$1,235'))
  })

  test('FIXED formats numbers and honors no_commas', () => {
    expect(call('FIXED', [NUM(1234.567)])).toEqual(STR('1,234.57'))
    expect(call('FIXED', [NUM(-1234.5)])).toEqual(STR('-1,234.50'))
    expect(call('FIXED', [NUM(1234.567), NUM(2), BOOL(true)])).toEqual(STR('1234.57'))
  })
})

describe('ROMAN / ARABIC', () => {
  test('classic round trip and empty ARABIC', () => {
    expect(call('ROMAN', [NUM(1994)])).toEqual(STR('MCMXCIV'))
    expect(call('ARABIC', [STR('mcmxciv')])).toEqual(NUM(1994))
    expect(call('ARABIC', [STR('')])).toEqual(NUM(0))
  })

  test('supports concise forms and boolean form aliases', () => {
    expect(call('ROMAN', [NUM(499), NUM(0)])).toEqual(STR('CDXCIX'))
    expect(call('ROMAN', [NUM(499), NUM(1)])).toEqual(STR('LDVLIV'))
    expect(call('ROMAN', [NUM(499), NUM(2)])).toEqual(STR('XDIX'))
    expect(call('ROMAN', [NUM(499), NUM(3)])).toEqual(STR('VDIV'))
    expect(call('ROMAN', [NUM(499), NUM(4)])).toEqual(STR('ID'))
    expect(call('ROMAN', [NUM(1999), BOOL(true)])).toEqual(STR('MCMXCIX'))
    expect(call('ROMAN', [NUM(1999), BOOL(false)])).toEqual(STR('MIM'))
  })

  test('invalid inputs return #VALUE!', () => {
    expect(call('ROMAN', [NUM(4000)])).toEqual(ERR('#VALUE!'))
    expect(call('ROMAN', [NUM(1994), NUM(5)])).toEqual(ERR('#VALUE!'))
    expect(call('ARABIC', [STR('hello')])).toEqual(ERR('#VALUE!'))
    expect(call('ARABIC', [NUM(123)])).toEqual(ERR('#VALUE!'))
  })
})

describe('VALUETOTEXT / ARRAYTOTEXT', () => {
  test('VALUETOTEXT concise and strict formats', () => {
    expect(call('VALUETOTEXT', [STR('abc')])).toEqual(STR('abc'))
    expect(call('VALUETOTEXT', [STR('a"b'), NUM(1)])).toEqual(STR('"a""b"'))
    expect(call('VALUETOTEXT', [BOOL(true), NUM(1)])).toEqual(STR('TRUE'))
  })

  test('ARRAYTOTEXT renders grids and scalar strict braces', () => {
    const grid = ARR([[NUM(10), NUM(20)], [NUM(5), STR('text')]])
    expect(call('ARRAYTOTEXT', [grid])).toEqual(STR('10,20;5,text'))
    expect(call('ARRAYTOTEXT', [grid, NUM(1)])).toEqual(STR('{10,20;5,"text"}'))
    expect(call('ARRAYTOTEXT', [STR('x'), NUM(1)])).toEqual(STR('{"x"}'))
  })

  test('nested array errors propagate', () => {
    expect(call('ARRAYTOTEXT', [ARR([[STR('ok'), ERR('#N/A')]])])).toEqual(ERR('#N/A'))
    expect(call('VALUETOTEXT', [ARR([[ERR('#REF!')]])])).toEqual(ERR('#REF!'))
  })
})

describe('ENCODEURL', () => {
  test('encodes reserved characters and UTF-8 bytes', () => {
    expect(call('ENCODEURL', [STR('hello world')])).toEqual(STR('hello%20world'))
    expect(call('ENCODEURL', [STR('a-_.~b')])).toEqual(STR('a-_.~b'))
    expect(call('ENCODEURL', [STR('a/b?c=d&e')])).toEqual(STR('a%2Fb%3Fc%3Dd%26e'))
    expect(call('ENCODEURL', [STR('€')])).toEqual(STR('%E2%82%AC'))
  })

  test('empty input, numeric coercion, and errors', () => {
    expect(call('ENCODEURL', [STR('')])).toEqual(STR(''))
    expect(call('ENCODEURL', [NUM(123)])).toEqual(STR('123'))
    expect(call('ENCODEURL', [ERR('#N/A')])).toEqual(ERR('#N/A'))
  })
})

describe('ASC / JIS / DBCS', () => {
  test('ASCII width conversion round-trips', () => {
    expect(call('JIS', [STR('ABC xyz')])).toEqual(STR('ＡＢＣ　ｘｙｚ'))
    expect(call('ASC', [STR('ＡＢＣ　ｘｙｚ')])).toEqual(STR('ABC xyz'))
    expect(call('DBCS', [STR('AB')])).toEqual(call('JIS', [STR('AB')]))
  })

  test('voiced kana compose and decompose', () => {
    expect(call('ASC', [STR('ガパヴ')])).toEqual(STR('ｶﾞﾊﾟｳﾞ'))
    expect(call('JIS', [STR('ｶﾞﾊﾟｳﾞ')])).toEqual(STR('ガパヴ'))
  })

  test('yen quirk, empty input, and errors', () => {
    expect(call('ASC', [STR('￥100')])).toEqual(STR('\\100'))
    expect(call('JIS', [STR('')])).toEqual(STR(''))
    expect(call('ASC', [ERR('#REF!')])).toEqual(ERR('#REF!'))
  })
})

describe('HYPERLINK / IMAGE', () => {
  test('HYPERLINK returns friendly text or URL text', () => {
    expect(call('HYPERLINK', [STR('https://example.com'), STR('click me')])).toEqual(
      STR('click me'),
    )
    expect(call('HYPERLINK', [STR('https://example.com')])).toEqual(STR('https://example.com'))
    expect(call('HYPERLINK', [STR('u'), NUM(42)])).toEqual(STR('42'))
  })

  test('IMAGE returns structured text payloads', () => {
    expect(call('IMAGE', [STR('https://example.com/cat.jpg')])).toEqual(
      STR('<IMAGE: https://example.com/cat.jpg>'),
    )
    expect(call('IMAGE', [STR('u'), STR('a "cat"'), NUM(3), NUM(120), NUM(240)])).toEqual(
      STR('<IMAGE: u alt="a \\"cat\\"" sizing=3 height=120 width=240>'),
    )
  })

  test('IMAGE validates source, sizing, dimensions, and propagates errors', () => {
    expect(call('IMAGE', [STR('')])).toEqual(ERR('#VALUE!'))
    expect(call('IMAGE', [STR('u'), STR('a'), NUM(5)])).toEqual(ERR('#VALUE!'))
    expect(call('IMAGE', [STR('u'), STR('a'), NUM(3)])).toEqual(ERR('#VALUE!'))
    expect(call('IMAGE', [STR('u'), STR('a'), NUM(3), NUM(0), NUM(100)])).toEqual(
      ERR('#VALUE!'),
    )
    expect(call('IMAGE', [ERR('#DIV/0!')])).toEqual(ERR('#DIV/0!'))
  })
})

describe('TRANSLATE / PHONETIC', () => {
  test('TRANSLATE maps each find codepoint to corresponding replace codepoint', () => {
    expect(call('TRANSLATE', [STR('hello'), STR('l'), STR('L')])).toEqual(STR('heLLo'))
    expect(call('TRANSLATE', [STR('abcdef'), STR('ace'), STR('ACE')])).toEqual(STR('AbCdEf'))
  })

  test('TRANSLATE deletes find chars with no replace counterpart', () => {
    // find "lo" but replace is only "L" — 'o' in find has no counterpart and is deleted.
    expect(call('TRANSLATE', [STR('hello world'), STR('lo'), STR('L')])).toEqual(STR('heLL wrLd'))
  })

  test('TRANSLATE codepoint-aware (emoji counts as one)', () => {
    expect(call('TRANSLATE', [STR('a😀b'), STR('😀'), STR('X')])).toEqual(STR('aXb'))
  })

  test('TRANSLATE propagates errors', () => {
    expect(call('TRANSLATE', [ERR('#N/A'), STR('en'), STR('fr')])).toEqual(ERR('#N/A'))
    expect(call('TRANSLATE', [STR('x'), ERR('#REF!'), STR('y')])).toEqual(ERR('#REF!'))
  })

  test('PHONETIC degrades to TEXT passthrough (no furigana metadata)', () => {
    expect(call('PHONETIC', [STR('こんにちは')])).toEqual(STR('こんにちは'))
    expect(call('PHONETIC', [STR('東京')])).toEqual(STR('東京'))
  })

  test('PHONETIC coerces non-string scalars and handles blank', () => {
    expect(call('PHONETIC', [NUM(42)])).toEqual(STR('42'))
    expect(call('PHONETIC', [BLANK])).toEqual(STR(''))
  })

  test('PHONETIC takes top-left cell of a range', () => {
    expect(
      call('PHONETIC', [
        ARR([
          [STR('first'), STR('second')],
          [STR('third'), STR('fourth')],
        ]),
      ]),
    ).toEqual(STR('first'))
  })

  test('PHONETIC propagates errors', () => {
    expect(call('PHONETIC', [ERR('#REF!')])).toEqual(ERR('#REF!'))
  })
})
