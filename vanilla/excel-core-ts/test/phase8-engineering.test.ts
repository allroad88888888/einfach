/**
 * Phase 8 — engineering function tests.
 *
 * Base conversions (DEC2BIN/OCT/HEX, BIN/OCT/HEX2DEC), bit ops
 * (BITAND/OR/XOR/LSHIFT/RSHIFT), comparators (DELTA, GESTEP).
 */

import { describe, expect, test } from '@jest/globals'

import {
  BIN2DEC,
  BITAND,
  BITLSHIFT,
  BITOR,
  BITRSHIFT,
  BITXOR,
  DEC2BIN,
  DEC2HEX,
  DEC2OCT,
  DELTA,
  GESTEP,
  HEX2DEC,
  OCT2DEC,
} from '../src/eval/functions/engineering'
import type { EvalContext, FunctionImpl, Value } from '../src/types'

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const STR = (s: string): Value => ({ kind: 'string', value: s })
const ERR = (code: '#DIV/0!' | '#N/A' | '#NUM!' | '#VALUE!'): Value => ({
  kind: 'error',
  code,
})

const ctx: EvalContext = new Proxy(
  {},
  {
    get(_, prop) {
      throw new Error(`phase8 eng unexpectedly read ctx.${String(prop)}`)
    },
  },
) as unknown as EvalContext

const call = (fn: FunctionImpl, args: Value[]): Value => fn(args, ctx)

describe('DEC2BIN', () => {
  test('5 → "101"', () => expect(call(DEC2BIN, [NUM(5)])).toEqual(STR('101')))
  test('0 → "0"', () => expect(call(DEC2BIN, [NUM(0)])).toEqual(STR('0')))
  test('with places: 5, 8 → "00000101"', () =>
    expect(call(DEC2BIN, [NUM(5), NUM(8)])).toEqual(STR('00000101')))
  test('out of range → #NUM!', () =>
    expect(call(DEC2BIN, [NUM(10000)])).toEqual(ERR('#NUM!')))
})

describe('DEC2HEX', () => {
  test('255 → "FF"', () => expect(call(DEC2HEX, [NUM(255)])).toEqual(STR('FF')))
  test('with places: 255, 4 → "00FF"', () =>
    expect(call(DEC2HEX, [NUM(255), NUM(4)])).toEqual(STR('00FF')))
  test('non-numeric → #VALUE!', () =>
    expect(call(DEC2HEX, [STR('abc')])).toEqual(ERR('#VALUE!')))
})

describe('DEC2OCT', () => {
  test('8 → "10"', () => expect(call(DEC2OCT, [NUM(8)])).toEqual(STR('10')))
  test('63 → "77"', () => expect(call(DEC2OCT, [NUM(63)])).toEqual(STR('77')))
  test('negative round-trip', () => {
    // -1 in 10-digit octal w/ 2s complement
    const r = call(DEC2OCT, [NUM(-1)])
    expect(r.kind).toBe('string')
  })
})

describe('BIN2DEC / OCT2DEC / HEX2DEC', () => {
  test('BIN2DEC("101") = 5', () => expect(call(BIN2DEC, [STR('101')])).toEqual(NUM(5)))
  test('OCT2DEC("77") = 63', () => expect(call(OCT2DEC, [STR('77')])).toEqual(NUM(63)))
  test('HEX2DEC("FF") = 255', () => expect(call(HEX2DEC, [STR('FF')])).toEqual(NUM(255)))
  test('invalid digits → #NUM!', () => expect(call(BIN2DEC, [STR('123')])).toEqual(ERR('#NUM!')))
})

describe('BITAND / BITOR / BITXOR', () => {
  test('BITAND(5, 3) = 1', () => expect(call(BITAND, [NUM(5), NUM(3)])).toEqual(NUM(1)))
  test('BITOR(5, 3) = 7', () => expect(call(BITOR, [NUM(5), NUM(3)])).toEqual(NUM(7)))
  test('BITXOR(5, 3) = 6', () => expect(call(BITXOR, [NUM(5), NUM(3)])).toEqual(NUM(6)))
  test('negative → #NUM!', () => expect(call(BITAND, [NUM(-1), NUM(0)])).toEqual(ERR('#NUM!')))
})

describe('BITLSHIFT / BITRSHIFT', () => {
  test('BITLSHIFT(1, 4) = 16', () => expect(call(BITLSHIFT, [NUM(1), NUM(4)])).toEqual(NUM(16)))
  test('BITRSHIFT(16, 2) = 4', () => expect(call(BITRSHIFT, [NUM(16), NUM(2)])).toEqual(NUM(4)))
  test('BITLSHIFT shift > 53 → #NUM!', () =>
    expect(call(BITLSHIFT, [NUM(1), NUM(60)])).toEqual(ERR('#NUM!')))
})

describe('DELTA', () => {
  test('equal → 1', () => expect(call(DELTA, [NUM(5), NUM(5)])).toEqual(NUM(1)))
  test('not equal → 0', () => expect(call(DELTA, [NUM(5), NUM(3)])).toEqual(NUM(0)))
  test('single arg uses 0 default: DELTA(0) = 1', () => expect(call(DELTA, [NUM(0)])).toEqual(NUM(1)))
})

describe('GESTEP', () => {
  test('n >= step → 1', () => expect(call(GESTEP, [NUM(5), NUM(3)])).toEqual(NUM(1)))
  test('n < step → 0', () => expect(call(GESTEP, [NUM(2), NUM(3)])).toEqual(NUM(0)))
  test('single arg uses 0 default: GESTEP(5) = 1', () =>
    expect(call(GESTEP, [NUM(5)])).toEqual(NUM(1)))
})
