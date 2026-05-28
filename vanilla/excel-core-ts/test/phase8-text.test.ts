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
  test('CODE("") → #VALUE!', () => expect(call('CODE', [STR('')])).toEqual(ERR('#VALUE!')))
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
})

describe('UNICODE / UNICHAR', () => {
  test("UNICHAR(65) = 'A'", () => expect(call('UNICHAR', [NUM(65)])).toEqual(STR('A')))
  test("UNICODE('A') = 65", () => expect(call('UNICODE', [STR('A')])).toEqual(NUM(65)))
  test('UNICHAR for emoji', () =>
    expect(call('UNICHAR', [NUM(0x1f600)])).toEqual(STR(String.fromCodePoint(0x1f600))))
})
