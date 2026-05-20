import { describe, expect, it } from '@jest/globals'
import type { DisplayCell } from '@einfach/spreadsheet-ui-core'
import {
  evaluateFormula,
  type EvalCellLookup,
} from '../src-vnext/adapter/static-formula-eval'

/**
 * Lookup helper for tests. Backs a small grid by string-keyed cell map.
 * Numeric strings become numeric cells; anything else stays text. Formulas
 * (any value starting with '=') store as `cell.formula` so cyclic + chained
 * eval work.
 */
function lookupFrom(map: Record<string, string | number>): EvalCellLookup {
  const cellMap = new Map<string, DisplayCell>()
  for (const [addr, value] of Object.entries(map)) {
    const match = /^([A-Z]+)(\d+)$/.exec(addr)
    if (!match) throw new Error(`bad addr ${addr}`)
    const col = match[1].charCodeAt(0) - 65
    const row = Number(match[2]) - 1
    const raw = String(value)
    const isFormula = raw.startsWith('=')
    const isNumeric = !isFormula && Number.isFinite(Number(raw)) && raw !== ''
    cellMap.set(`${row}:${col}`, {
      displayValue: raw,
      formula: isFormula ? raw : undefined,
      valueKind: isFormula ? 'text' : isNumeric ? 'number' : 'text',
    } as DisplayCell)
  }
  return {
    get(row, col) {
      return cellMap.get(`${row}:${col}`)
    },
  }
}

function ev(formula: string, map: Record<string, string | number> = {}) {
  return evaluateFormula(formula, lookupFrom(map))
}

describe('static-formula-eval — arithmetic + refs', () => {
  it('adds numeric refs', () => {
    expect(ev('=A1+B1', { A1: 3, B1: 4 })).toBe(7)
  })

  it('division by zero surfaces #DIV/0!', () => {
    expect(ev('=10/0')).toBe('#DIV/0!')
  })

  it('parse error surfaces #ERROR!', () => {
    expect(ev('=BAD(')).toBe('#ERROR!')
  })

  it('detects cycles', () => {
    expect(ev('=A1', { A1: '=A1' })).toBe('#CYCLE!')
  })

  it('unary minus binds tighter than binary -', () => {
    expect(ev('=-2*3')).toBe(-6)
  })
})

describe('static-formula-eval — string literals + CONCAT', () => {
  it('returns a string literal as-is', () => {
    expect(ev('="hi"')).toBe('hi')
  })

  it('CONCAT joins literals + refs + ranges', () => {
    expect(ev('=CONCAT("x=", A1)', { A1: 5 })).toBe('x=5')
    expect(ev('=CONCAT(A1:A3)', { A1: 'a', A2: 'b', A3: 'c' })).toBe('abc')
  })

  it('arithmetic on a string surfaces #VALUE!', () => {
    expect(ev('=A1+1', { A1: 'hi' })).toBe('#VALUE!')
  })
})

describe('static-formula-eval — comparison operators', () => {
  it.each([
    ['=1>0', 1],
    ['=1<0', 0],
    ['=1=1', 1],
    ['=1<>1', 0],
    ['=2>=2', 1],
    ['=2<=2', 1],
  ])('%s evaluates to %s', (input, expected) => {
    expect(ev(input)).toBe(expected)
  })

  it('cross-type comparison returns 0', () => {
    expect(ev('="a"=1')).toBe(0)
  })
})

describe('static-formula-eval — IF', () => {
  it('takes the true branch when the condition is truthy', () => {
    expect(ev('=IF(1, "yes", "no")')).toBe('yes')
    expect(ev('=IF(A1>0, A1*10, 0)', { A1: 5 })).toBe(50)
  })

  it('takes the false branch when the condition is 0 / false-ish', () => {
    expect(ev('=IF(0, "yes", "no")')).toBe('no')
    expect(ev('=IF("false", "yes", "no")')).toBe('no')
  })

  it('treats missing third arg as 0', () => {
    expect(ev('=IF(0, 5)')).toBe(0)
  })

  it('propagates errors through the condition', () => {
    expect(ev('=IF(1/0, 1, 2)')).toBe('#DIV/0!')
  })
})

describe('static-formula-eval — SUMIF / COUNTIF', () => {
  const grid = { A1: 5, A2: 15, A3: 25, A4: 35 }

  it('SUMIF with comparison criteria sums matching cells', () => {
    expect(ev('=SUMIF(A1:A4, ">10")', grid)).toBe(75)
    expect(ev('=SUMIF(A1:A4, "<=15")', grid)).toBe(20)
  })

  it('SUMIF with a separate sum_range sums the parallel range', () => {
    expect(
      ev('=SUMIF(A1:A4, ">10", B1:B4)', {
        ...grid,
        B1: 100,
        B2: 200,
        B3: 300,
        B4: 400,
      }),
    ).toBe(900)
  })

  it('COUNTIF with literal criteria counts string matches case-insensitively', () => {
    expect(
      ev('=COUNTIF(A1:A3, "apple")', { A1: 'Apple', A2: 'banana', A3: 'APPLE' }),
    ).toBe(2)
  })

  it('COUNTIF with comparison criteria counts numeric matches', () => {
    expect(ev('=COUNTIF(A1:A4, ">10")', grid)).toBe(3)
  })

  it('COUNTIF with <> excludes matching value', () => {
    expect(ev('=COUNTIF(A1:A4, "<>15")', grid)).toBe(3)
  })
})

describe('static-formula-eval — ABS / ROUND', () => {
  it('ABS strips sign', () => {
    expect(ev('=ABS(0-7)')).toBe(7)
    expect(ev('=ABS(7)')).toBe(7)
  })

  it('ROUND rounds to N digits', () => {
    expect(ev('=ROUND(3.14159, 2)')).toBe(3.14)
    expect(ev('=ROUND(2.5, 0)')).toBe(3)
  })
})

describe('static-formula-eval — TRUE/FALSE + AND/OR/NOT', () => {
  it('bare TRUE/FALSE evaluate to 1/0', () => {
    expect(ev('=TRUE')).toBe(1)
    expect(ev('=FALSE')).toBe(0)
    expect(ev('=TRUE+TRUE')).toBe(2)
  })

  it('AND returns 1 iff every argument is truthy', () => {
    expect(ev('=AND(1, 1, 1)')).toBe(1)
    expect(ev('=AND(1, 0, 1)')).toBe(0)
    expect(ev('=AND(TRUE, A1>0)', { A1: 5 })).toBe(1)
  })

  it('OR returns 1 iff at least one argument is truthy', () => {
    expect(ev('=OR(0, 0, 1)')).toBe(1)
    expect(ev('=OR(FALSE, FALSE)')).toBe(0)
  })

  it('NOT inverts truthiness', () => {
    expect(ev('=NOT(0)')).toBe(1)
    expect(ev('=NOT(5)')).toBe(0)
    expect(ev('=NOT(TRUE)')).toBe(0)
  })

  it('AND returns 0 on the first falsy even when a later arg is an error', () => {
    // Args are evaluated eagerly via parseArgList, so `1/0` does evaluate
    // to #DIV/0! — but the AND reducer short-circuits when it sees the
    // initial 0 and never consults the second arg.
    expect(ev('=AND(0, 1/0)')).toBe(0)
  })
})

describe('static-formula-eval — text functions', () => {
  it('LEN returns character count', () => {
    expect(ev('=LEN("hello")')).toBe(5)
    expect(ev('=LEN(A1)', { A1: 'banana' })).toBe(6)
    expect(ev('=LEN(123)')).toBe(3)
  })

  it('LOWER / UPPER swap case', () => {
    expect(ev('=LOWER("HeLLo")')).toBe('hello')
    expect(ev('=UPPER("hello")')).toBe('HELLO')
  })

  it('TRIM strips edges and collapses internal whitespace', () => {
    expect(ev('=TRIM("  a   b  c  ")')).toBe('a b c')
  })
})

describe('static-formula-eval — SQRT / MOD', () => {
  it('SQRT returns positive root', () => {
    expect(ev('=SQRT(16)')).toBe(4)
    expect(ev('=SQRT(2)')).toBeCloseTo(1.41421356)
  })

  it('SQRT of negative returns #NUM!', () => {
    expect(ev('=SQRT(0-9)')).toBe('#NUM!')
  })

  it('MOD returns remainder', () => {
    expect(ev('=MOD(10, 3)')).toBe(1)
    expect(ev('=MOD(0-10, 3)')).toBe(2)
  })

  it('MOD by zero surfaces #DIV/0!', () => {
    expect(ev('=MOD(5, 0)')).toBe('#DIV/0!')
  })
})

describe('static-formula-eval — nesting + chaining', () => {
  it('IF over SUM with a ref-based threshold', () => {
    expect(ev('=IF(SUM(A1:A3)>=50, "big", "small")', { A1: 20, A2: 20, A3: 20 })).toBe('big')
  })

  it('chained formulas compose through ref resolution', () => {
    // A1=SUM(B1:C1)=30; A2=A1*2=60
    expect(ev('=A1*2', { A1: '=SUM(B1:C1)', B1: 10, C1: 20 })).toBe(60)
  })

  it('cycles inside nested calls still trip #CYCLE!', () => {
    expect(ev('=A1', { A1: '=SUM(A1)' })).toBe('#CYCLE!')
  })
})
