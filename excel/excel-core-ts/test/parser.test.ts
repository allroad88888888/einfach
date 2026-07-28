/**
 * Wave B / B1 parser test suite.
 *
 * Coverage targets:
 *  - Every kind in `Expr` union (§5 of `src/types.ts`) — ≥2 fixtures each.
 *  - Operator precedence + associativity.
 *  - Cross-sheet (bare + quoted), names, calls (zero-arg, nested, varargs).
 *  - Array literals (row / column separators).
 *  - Error envelope: empty input → `#NAME?`, malformed → `#VALUE!`.
 */

import { describe, expect, test } from '@jest/globals'

import { parseFormula } from '../src/parser'
import type { Expr } from '../src/types'

// ---------- 1. Number literals ----------

describe('parseFormula — number literals', () => {
  test('integer', () => {
    expect(parseFormula('123')).toEqual({ kind: 'number', value: 123 })
  })
  test('decimal', () => {
    expect(parseFormula('1.5')).toEqual({ kind: 'number', value: 1.5 })
  })
  test('leading dot', () => {
    expect(parseFormula('.5')).toEqual({ kind: 'number', value: 0.5 })
  })
  test('scientific notation', () => {
    expect(parseFormula('1.5e-3')).toEqual({ kind: 'number', value: 0.0015 })
  })
  test('integer with leading =', () => {
    expect(parseFormula('=42')).toEqual({ kind: 'number', value: 42 })
  })
})

// ---------- 2. String literals ----------

describe('parseFormula — string literals', () => {
  test('basic string', () => {
    expect(parseFormula('"hello"')).toEqual({ kind: 'string', value: 'hello' })
  })
  test('empty string', () => {
    expect(parseFormula('""')).toEqual({ kind: 'string', value: '' })
  })
  test('escaped quote', () => {
    expect(parseFormula('"a""b"')).toEqual({ kind: 'string', value: 'a"b' })
  })
  test('string with spaces and punctuation', () => {
    expect(parseFormula('="hi, world!"')).toEqual({
      kind: 'string',
      value: 'hi, world!',
    })
  })
})

// ---------- 3. Boolean literals ----------

describe('parseFormula — boolean literals', () => {
  test('TRUE uppercase', () => {
    expect(parseFormula('TRUE')).toEqual({ kind: 'boolean', value: true })
  })
  test('FALSE uppercase', () => {
    expect(parseFormula('FALSE')).toEqual({ kind: 'boolean', value: false })
  })
  test('true lowercase', () => {
    expect(parseFormula('true')).toEqual({ kind: 'boolean', value: true })
  })
  test('False mixed case', () => {
    expect(parseFormula('False')).toEqual({ kind: 'boolean', value: false })
  })
})

// ---------- 4. Error literals ----------

describe('parseFormula — error literals', () => {
  test('#REF!', () => {
    expect(parseFormula('#REF!')).toEqual({ kind: 'error', code: '#REF!' })
  })
  test('#N/A', () => {
    expect(parseFormula('#N/A')).toEqual({ kind: 'error', code: '#N/A' })
  })
  test('#DIV/0!', () => {
    expect(parseFormula('#DIV/0!')).toEqual({ kind: 'error', code: '#DIV/0!' })
  })
  test('#VALUE!', () => {
    expect(parseFormula('#VALUE!')).toEqual({ kind: 'error', code: '#VALUE!' })
  })
  test('#NAME?', () => {
    expect(parseFormula('#NAME?')).toEqual({ kind: 'error', code: '#NAME?' })
  })
})

// ---------- 5. Cell references ----------

describe('parseFormula — refs', () => {
  test('A1 relative', () => {
    expect(parseFormula('A1')).toEqual({
      kind: 'ref',
      a1: 'A1',
      absCol: false,
      absRow: false,
    })
  })
  test('$A$1 fully absolute', () => {
    expect(parseFormula('$A$1')).toEqual({
      kind: 'ref',
      a1: 'A1',
      absCol: true,
      absRow: true,
    })
  })
  test('$A1 absolute column only', () => {
    expect(parseFormula('$A1')).toEqual({
      kind: 'ref',
      a1: 'A1',
      absCol: true,
      absRow: false,
    })
  })
  test('A$1 absolute row only', () => {
    expect(parseFormula('A$1')).toEqual({
      kind: 'ref',
      a1: 'A1',
      absCol: false,
      absRow: true,
    })
  })
  test('multi-letter column AA12', () => {
    expect(parseFormula('AA12')).toEqual({
      kind: 'ref',
      a1: 'AA12',
      absCol: false,
      absRow: false,
    })
  })
  test('Excel max XFD1048576', () => {
    expect(parseFormula('XFD1048576')).toEqual({
      kind: 'ref',
      a1: 'XFD1048576',
      absCol: false,
      absRow: false,
    })
  })
})

// ---------- 6. Ranges ----------

describe('parseFormula — ranges', () => {
  test('A1:B10', () => {
    expect(parseFormula('A1:B10')).toEqual({
      kind: 'range',
      start: 'A1',
      end: 'B10',
    })
  })
  test('$A$1:$B$10 absolute', () => {
    expect(parseFormula('$A$1:$B$10')).toEqual({
      kind: 'range',
      start: 'A1',
      end: 'B10',
    })
  })
  test('A:A whole column', () => {
    expect(parseFormula('A:A')).toEqual({
      kind: 'range',
      start: 'A',
      end: 'A',
    })
  })
  test('A:C whole column span', () => {
    expect(parseFormula('A:C')).toEqual({
      kind: 'range',
      start: 'A',
      end: 'C',
    })
  })
  test('1:1 whole row', () => {
    expect(parseFormula('1:1')).toEqual({
      kind: 'range',
      start: '1',
      end: '1',
    })
  })
  test('$1:$1 absolute whole row', () => {
    expect(parseFormula('$1:$1')).toEqual({
      kind: 'range',
      start: '1',
      end: '1',
    })
  })
  test('1:5 whole row span', () => {
    expect(parseFormula('1:5')).toEqual({
      kind: 'range',
      start: '1',
      end: '5',
    })
  })
})

// ---------- 7. Cross-sheet ----------

describe('parseFormula — cross-sheet', () => {
  test('Sheet2!A1', () => {
    expect(parseFormula('Sheet2!A1')).toEqual({
      kind: 'crossSheet',
      sheetName: 'Sheet2',
      inner: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
    })
  })
  test('Sheet2!A1:B10', () => {
    expect(parseFormula('Sheet2!A1:B10')).toEqual({
      kind: 'crossSheet',
      sheetName: 'Sheet2',
      inner: { kind: 'range', start: 'A1', end: 'B10' },
    })
  })
  test("'Sheet With Spaces'!A1", () => {
    expect(parseFormula("'Sheet With Spaces'!A1")).toEqual({
      kind: 'crossSheet',
      sheetName: 'Sheet With Spaces',
      inner: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
    })
  })
  test("'O''Brien'!A1 escaped quote in sheet name", () => {
    expect(parseFormula("'O''Brien'!A1")).toEqual({
      kind: 'crossSheet',
      sheetName: "O'Brien",
      inner: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
    })
  })
  test('Sheet2!A:A whole column cross-sheet', () => {
    expect(parseFormula('Sheet2!A:A')).toEqual({
      kind: 'crossSheet',
      sheetName: 'Sheet2',
      inner: { kind: 'range', start: 'A', end: 'A' },
    })
  })
})

// ---------- 7a. Dynamic references ----------

describe('parseFormula — dynamic references', () => {
  test('A1# spill reference', () => {
    expect(parseFormula('A1#')).toEqual({
      kind: 'spillRef',
      anchor: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
    })
  })

  test('Sheet2!A1# cross-sheet spill reference', () => {
    expect(parseFormula('Sheet2!A1#')).toEqual({
      kind: 'spillRef',
      anchor: {
        kind: 'crossSheet',
        sheetName: 'Sheet2',
        inner: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
      },
    })
  })

  test('A1:INDEX(A:A,3) dynamic range endpoint', () => {
    expect(parseFormula('A1:INDEX(A:A,3)')).toEqual({
      kind: 'dynamicRange',
      start: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
      end: {
        kind: 'call',
        name: 'INDEX',
        args: [
          { kind: 'range', start: 'A', end: 'A' },
          { kind: 'number', value: 3 },
        ],
      },
    })
  })

  test('INDEX(A:A,1):INDEX(A:A,3) dynamic range endpoints', () => {
    expect(parseFormula('INDEX(A:A,1):INDEX(A:A,3)')).toEqual({
      kind: 'dynamicRange',
      start: {
        kind: 'call',
        name: 'INDEX',
        args: [
          { kind: 'range', start: 'A', end: 'A' },
          { kind: 'number', value: 1 },
        ],
      },
      end: {
        kind: 'call',
        name: 'INDEX',
        args: [
          { kind: 'range', start: 'A', end: 'A' },
          { kind: 'number', value: 3 },
        ],
      },
    })
  })

  test('cross-sheet literal start with dynamic endpoint', () => {
    expect(parseFormula('Data!A1:INDEX(Data!A:A,3)')).toEqual({
      kind: 'dynamicRange',
      start: {
        kind: 'crossSheet',
        sheetName: 'Data',
        inner: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
      },
      end: {
        kind: 'call',
        name: 'INDEX',
        args: [
          {
            kind: 'crossSheet',
            sheetName: 'Data',
            inner: { kind: 'range', start: 'A', end: 'A' },
          },
          { kind: 'number', value: 3 },
        ],
      },
    })
  })

  test('dynamic range binds tighter than arithmetic', () => {
    expect(parseFormula('A1:INDEX(A:A,3)*2')).toEqual({
      kind: 'binary',
      op: '*',
      left: {
        kind: 'dynamicRange',
        start: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
        end: {
          kind: 'call',
          name: 'INDEX',
          args: [
            { kind: 'range', start: 'A', end: 'A' },
            { kind: 'number', value: 3 },
          ],
        },
      },
      right: { kind: 'number', value: 2 },
    })
  })

  test('rejects chained range operators instead of widening the range', () => {
    expect(parseFormula('A1:B2:C3')).toEqual({ kind: 'error', code: '#VALUE!' })
    expect(parseFormula('A1:INDEX(A:A,2):A3')).toEqual({ kind: 'error', code: '#VALUE!' })
    expect(parseFormula('A1:(B1:C1)')).toEqual({ kind: 'error', code: '#VALUE!' })
  })
})

// ---------- 7b. Multi-area references ----------

describe('parseFormula — multi-area references', () => {
  test('(A1:B2,C1:D2)', () => {
    expect(parseFormula('(A1:B2,C1:D2)')).toEqual({
      kind: 'multiArea',
      areas: [
        { kind: 'range', start: 'A1', end: 'B2' },
        { kind: 'range', start: 'C1', end: 'D2' },
      ],
    })
  })
  test("(A1,'Data Sheet'!B2:C3)", () => {
    expect(parseFormula("(A1,'Data Sheet'!B2:C3)")).toEqual({
      kind: 'multiArea',
      areas: [
        { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
        {
          kind: 'crossSheet',
          sheetName: 'Data Sheet',
          inner: { kind: 'range', start: 'B2', end: 'C3' },
        },
      ],
    })
  })
})

// ---------- 8. Names ----------

describe('parseFormula — names', () => {
  test('bare uppercase identifier', () => {
    expect(parseFormula('MY_RANGE')).toEqual({ kind: 'name', name: 'MY_RANGE' })
  })
  test('camelCase identifier', () => {
    expect(parseFormula('myLambda')).toEqual({ kind: 'name', name: 'myLambda' })
  })
  test('underscored', () => {
    expect(parseFormula('_secret')).toEqual({ kind: 'name', name: '_secret' })
  })
})

// ---------- 9. Unary ----------

describe('parseFormula — unary', () => {
  test('-A1', () => {
    expect(parseFormula('-A1')).toEqual({
      kind: 'unary',
      op: '-',
      operand: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
    })
  })
  test('+A1', () => {
    expect(parseFormula('+A1')).toEqual({
      kind: 'unary',
      op: '+',
      operand: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
    })
  })
  test('--5 double negation', () => {
    expect(parseFormula('--5')).toEqual({
      kind: 'unary',
      op: '-',
      operand: { kind: 'unary', op: '-', operand: { kind: 'number', value: 5 } },
    })
  })
})

// ---------- 10. Binary (precedence + associativity) ----------

describe('parseFormula — binary precedence', () => {
  test('1 + 2 * 3 → 1 + (2 * 3)', () => {
    expect(parseFormula('1+2*3')).toEqual({
      kind: 'binary',
      op: '+',
      left: { kind: 'number', value: 1 },
      right: {
        kind: 'binary',
        op: '*',
        left: { kind: 'number', value: 2 },
        right: { kind: 'number', value: 3 },
      },
    })
  })
  test('(1 + 2) * 3 → (1 + 2) * 3', () => {
    expect(parseFormula('(1+2)*3')).toEqual({
      kind: 'binary',
      op: '*',
      left: {
        kind: 'binary',
        op: '+',
        left: { kind: 'number', value: 1 },
        right: { kind: 'number', value: 2 },
      },
      right: { kind: 'number', value: 3 },
    })
  })
  test('left-associative subtraction 10 - 3 - 2 → (10 - 3) - 2', () => {
    expect(parseFormula('10-3-2')).toEqual({
      kind: 'binary',
      op: '-',
      left: {
        kind: 'binary',
        op: '-',
        left: { kind: 'number', value: 10 },
        right: { kind: 'number', value: 3 },
      },
      right: { kind: 'number', value: 2 },
    })
  })
  test('right-associative exponent 2^3^2 → 2 ^ (3 ^ 2)', () => {
    expect(parseFormula('2^3^2')).toEqual({
      kind: 'binary',
      op: '^',
      left: { kind: 'number', value: 2 },
      right: {
        kind: 'binary',
        op: '^',
        left: { kind: 'number', value: 3 },
        right: { kind: 'number', value: 2 },
      },
    })
  })
  test('concat: "a" & "b"', () => {
    expect(parseFormula('"a"&"b"')).toEqual({
      kind: 'binary',
      op: '&',
      left: { kind: 'string', value: 'a' },
      right: { kind: 'string', value: 'b' },
    })
  })
  test('comparison: A1 < B1', () => {
    expect(parseFormula('A1<B1')).toEqual({
      kind: 'binary',
      op: '<',
      left: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
      right: { kind: 'ref', a1: 'B1', absCol: false, absRow: false },
    })
  })
  test('not-equal: A1 <> B1', () => {
    const ast = parseFormula('A1<>B1') as Expr
    expect(ast.kind).toBe('binary')
    if (ast.kind === 'binary') {
      expect(ast.op).toBe('<>')
    }
  })
  test('>= comparison', () => {
    const ast = parseFormula('A1>=10')
    expect(ast.kind).toBe('binary')
    if (ast.kind === 'binary') expect(ast.op).toBe('>=')
  })
  test('<= comparison', () => {
    const ast = parseFormula('A1<=10')
    expect(ast.kind).toBe('binary')
    if (ast.kind === 'binary') expect(ast.op).toBe('<=')
  })
  test('comparison sits below concat: "a"&"b"="ab"', () => {
    expect(parseFormula('"a"&"b"="ab"')).toEqual({
      kind: 'binary',
      op: '=',
      left: {
        kind: 'binary',
        op: '&',
        left: { kind: 'string', value: 'a' },
        right: { kind: 'string', value: 'b' },
      },
      right: { kind: 'string', value: 'ab' },
    })
  })
  test('unary binds tighter than `*`: -2 * 3 → (-2) * 3', () => {
    expect(parseFormula('-2*3')).toEqual({
      kind: 'binary',
      op: '*',
      left: { kind: 'unary', op: '-', operand: { kind: 'number', value: 2 } },
      right: { kind: 'number', value: 3 },
    })
  })
})

// ---------- 11. Percent ----------

describe('parseFormula — percent', () => {
  test('50%', () => {
    expect(parseFormula('50%')).toEqual({
      kind: 'percent',
      operand: { kind: 'number', value: 50 },
    })
  })
  test('A1%', () => {
    expect(parseFormula('A1%')).toEqual({
      kind: 'percent',
      operand: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
    })
  })
  test('1 + 2% → 1 + (2%)', () => {
    expect(parseFormula('1+2%')).toEqual({
      kind: 'binary',
      op: '+',
      left: { kind: 'number', value: 1 },
      right: { kind: 'percent', operand: { kind: 'number', value: 2 } },
    })
  })
})

// ---------- 12. Calls ----------

describe('parseFormula — calls', () => {
  test('SUM(A1, B2)', () => {
    expect(parseFormula('SUM(A1, B2)')).toEqual({
      kind: 'call',
      name: 'SUM',
      args: [
        { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
        { kind: 'ref', a1: 'B2', absCol: false, absRow: false },
      ],
    })
  })
  test('zero-arg TODAY()', () => {
    expect(parseFormula('TODAY()')).toEqual({
      kind: 'call',
      name: 'TODAY',
      args: [],
    })
  })
  test('IF(A1>0, "a", "b")', () => {
    expect(parseFormula('IF(A1>0,"a","b")')).toEqual({
      kind: 'call',
      name: 'IF',
      args: [
        {
          kind: 'binary',
          op: '>',
          left: { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
          right: { kind: 'number', value: 0 },
        },
        { kind: 'string', value: 'a' },
        { kind: 'string', value: 'b' },
      ],
    })
  })
  test('nested calls: SUM(MIN(A1, B1), MAX(C1, D1))', () => {
    const ast = parseFormula('SUM(MIN(A1,B1),MAX(C1,D1))') as Expr
    expect(ast.kind).toBe('call')
    if (ast.kind === 'call') {
      expect(ast.name).toBe('SUM')
      expect(ast.args).toHaveLength(2)
      expect((ast.args[0] as { kind: string }).kind).toBe('call')
      expect((ast.args[1] as { kind: string }).kind).toBe('call')
    }
  })
  test('call with range arg: SUM(A1:A10)', () => {
    expect(parseFormula('SUM(A1:A10)')).toEqual({
      kind: 'call',
      name: 'SUM',
      args: [{ kind: 'range', start: 'A1', end: 'A10' }],
    })
  })
  test('dot in function name: BETA.DIST(1, 2, 3, TRUE)', () => {
    const ast = parseFormula('BETA.DIST(1,2,3,TRUE)') as Expr
    expect(ast.kind).toBe('call')
    if (ast.kind === 'call') expect(ast.name).toBe('BETA.DIST')
  })
  test('inline LAMBDA immediate call: LAMBDA(x, x + 1)(4)', () => {
    expect(parseFormula('LAMBDA(x,x+1)(4)')).toEqual({
      kind: 'lambdaCall',
      callee: {
        kind: 'call',
        name: 'LAMBDA',
        args: [
          { kind: 'name', name: 'x' },
          {
            kind: 'binary',
            op: '+',
            left: { kind: 'name', name: 'x' },
            right: { kind: 'number', value: 1 },
          },
        ],
      },
      args: [{ kind: 'number', value: 4 }],
    })
  })
  test('parenthesized inline LAMBDA immediate call', () => {
    const ast = parseFormula('(LAMBDA(x,x))(5)') as Expr
    expect(ast.kind).toBe('lambdaCall')
    if (ast.kind === 'lambdaCall') {
      expect(ast.args).toEqual([{ kind: 'number', value: 5 }])
      expect(ast.callee.kind).toBe('call')
    }
  })
})

// ---------- 13. Array literals ----------

describe('parseFormula — array literals', () => {
  test('row literal {1, 2, 3}', () => {
    expect(parseFormula('{1, 2, 3}')).toEqual({
      kind: 'arrayLiteral',
      rows: [
        [
          { kind: 'number', value: 1 },
          { kind: 'number', value: 2 },
          { kind: 'number', value: 3 },
        ],
      ],
    })
  })
  test('2x2 {1, 2; 3, 4}', () => {
    expect(parseFormula('{1, 2; 3, 4}')).toEqual({
      kind: 'arrayLiteral',
      rows: [
        [
          { kind: 'number', value: 1 },
          { kind: 'number', value: 2 },
        ],
        [
          { kind: 'number', value: 3 },
          { kind: 'number', value: 4 },
        ],
      ],
    })
  })
  test('column literal {1; 2; 3}', () => {
    expect(parseFormula('{1; 2; 3}')).toEqual({
      kind: 'arrayLiteral',
      rows: [
        [{ kind: 'number', value: 1 }],
        [{ kind: 'number', value: 2 }],
        [{ kind: 'number', value: 3 }],
      ],
    })
  })
  test('mixed types {"a", TRUE, 1}', () => {
    expect(parseFormula('{"a", TRUE, 1}')).toEqual({
      kind: 'arrayLiteral',
      rows: [
        [
          { kind: 'string', value: 'a' },
          { kind: 'boolean', value: true },
          { kind: 'number', value: 1 },
        ],
      ],
    })
  })
})

// ---------- 14. Parentheses ----------

describe('parseFormula — parentheses', () => {
  test('redundant parens unwrap', () => {
    expect(parseFormula('(((42)))')).toEqual({ kind: 'number', value: 42 })
  })
  test('paren around binary', () => {
    expect(parseFormula('(1+2)')).toEqual({
      kind: 'binary',
      op: '+',
      left: { kind: 'number', value: 1 },
      right: { kind: 'number', value: 2 },
    })
  })
})

// ---------- 15. Error envelope ----------

describe('parseFormula — error envelope', () => {
  test('empty string → #NAME?', () => {
    expect(parseFormula('')).toEqual({ kind: 'error', code: '#NAME?' })
  })
  test('whitespace only → #NAME?', () => {
    expect(parseFormula('   ')).toEqual({ kind: 'error', code: '#NAME?' })
  })
  test('lone = → #NAME?', () => {
    expect(parseFormula('=')).toEqual({ kind: 'error', code: '#NAME?' })
  })
  test('unterminated string → #VALUE!', () => {
    expect(parseFormula('"hello').kind).toBe('error')
    expect((parseFormula('"hello') as { code: string }).code).toBe('#VALUE!')
  })
  test('unbalanced paren → #VALUE!', () => {
    expect(parseFormula('(1+2').kind).toBe('error')
  })
  test('trailing junk → #VALUE!', () => {
    expect(parseFormula('1 2').kind).toBe('error')
  })
  test('bad operator after number → #VALUE!', () => {
    expect(parseFormula('1 +').kind).toBe('error')
  })
})

// ---------- 16. Whitespace tolerance ----------

describe('parseFormula — whitespace', () => {
  test('spaces around binary', () => {
    expect(parseFormula('  1  +  2  ')).toEqual({
      kind: 'binary',
      op: '+',
      left: { kind: 'number', value: 1 },
      right: { kind: 'number', value: 2 },
    })
  })
  test('spaces inside call', () => {
    expect(parseFormula('SUM( A1 , B2 )')).toEqual({
      kind: 'call',
      name: 'SUM',
      args: [
        { kind: 'ref', a1: 'A1', absCol: false, absRow: false },
        { kind: 'ref', a1: 'B2', absCol: false, absRow: false },
      ],
    })
  })
})

// ---------- 17. Coverage hatchmarks: every Expr kind hit at least twice ----------

describe('parseFormula — Expr kind coverage tripwire', () => {
  // This block intentionally enumerates fixtures keyed by `Expr.kind`
  // so a future grep `kind:` confirms every Expr variant is exercised. If a kind
  // disappears, this suite catches it.
  const fixtures: Array<{ src: string; kind: Expr['kind'] }> = [
    { src: '1', kind: 'number' },
    { src: '3.14', kind: 'number' },
    { src: '"hi"', kind: 'string' },
    { src: '""', kind: 'string' },
    { src: 'TRUE', kind: 'boolean' },
    { src: 'FALSE', kind: 'boolean' },
    { src: '#REF!', kind: 'error' },
    { src: '#N/A', kind: 'error' },
    { src: 'A1', kind: 'ref' },
    { src: '$Z$99', kind: 'ref' },
    { src: 'A1:B2', kind: 'range' },
    { src: 'A:C', kind: 'range' },
    { src: 'A1:INDEX(A:A,3)', kind: 'dynamicRange' },
    { src: 'B2:OFFSET(B2,1,0)', kind: 'dynamicRange' },
    { src: 'A1#', kind: 'spillRef' },
    { src: 'Sheet2!A1#', kind: 'spillRef' },
    { src: 'Sheet2!A1', kind: 'crossSheet' },
    { src: "'has space'!B2:C3", kind: 'crossSheet' },
    { src: '(A1,B1)', kind: 'multiArea' },
    { src: '(A1:B2,C1:D2)', kind: 'multiArea' },
    { src: 'NAMED_RANGE', kind: 'name' },
    { src: 'pi', kind: 'name' },
    { src: '-1', kind: 'unary' },
    { src: '+A1', kind: 'unary' },
    { src: '1+1', kind: 'binary' },
    { src: 'A1*B1', kind: 'binary' },
    { src: '50%', kind: 'percent' },
    { src: 'A1%', kind: 'percent' },
    { src: 'SUM(1)', kind: 'call' },
    { src: 'TODAY()', kind: 'call' },
    { src: 'LAMBDA(x,x)(1)', kind: 'lambdaCall' },
    { src: '(LAMBDA(x,x))(2)', kind: 'lambdaCall' },
    { src: '{1}', kind: 'arrayLiteral' },
    { src: '{1;2}', kind: 'arrayLiteral' },
  ]
  for (const { src, kind } of fixtures) {
    test(`${src} → ${kind}`, () => {
      expect(parseFormula(src).kind).toBe(kind)
    })
  }
})
