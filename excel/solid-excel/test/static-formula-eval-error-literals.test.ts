/**
 * Error literal test cases for the static formula evaluator.
 *
 * Verifies that the 13 Excel error tokens recognised by the Rust engine
 * (excel/rust/wasm/src/lib.rs → error_token_to_value_error) are correctly
 * tokenised and evaluated by the static evaluator.
 */

import { describe, expect, it } from '@jest/globals'
import type { DisplayCell } from '@einfach/spreadsheet-ui-core'
import { evaluateFormula, type EvalCellLookup } from '../src-vnext/adapter/static-formula-eval'

/** Creates a lookup backed by a string-keyed cell map. */
function lookupFrom(map: Record<string, string | number>): EvalCellLookup {
  const cellMap = new Map<string, DisplayCell>()
  for (const [addr, value] of Object.entries(map)) {
    const match = /^([A-Z]+)(\d+)$/.exec(addr)
    if (!match) throw new Error(`bad addr ${addr}`)
    const col = match[1].charCodeAt(0) - 65
    const row = Number(match[2]) - 1
    const raw = String(value)
    cellMap.set(`${row}:${col}`, {
      displayValue: raw,
      formula: raw.startsWith('=') ? raw : undefined,
      valueKind: Number.isFinite(Number(raw)) && raw !== '' ? 'number' : 'text',
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

describe('static-formula-eval — error literals', () => {
  it('#REF! evaluates to #REF!', () => {
    expect(ev('=#REF!')).toBe('#REF!')
  })

  it('#REF!+1 propagates the error', () => {
    expect(ev('=#REF!+1')).toBe('#REF!')
  })

  it('1+#REF! propagates the error', () => {
    expect(ev('=1+#REF!')).toBe('#REF!')
  })

  it.each([
    ['#NULL!'],
    ['#DIV/0!'],
    ['#N/A'],
    ['#REF!'],
    ['#VALUE!'],
    ['#NAME?'],
    ['#NUM!'],
    ['#CYCLE!'],
    ['#TYPE!'],
    ['#ARGS!'],
    ['#SPILL!'],
    ['#CALC!'],
    ['#BUSY!'],
  ])('%s evaluates to itself', (token) => {
    expect(ev('=' + token)).toBe(token)
  })

  it('error literal in function arg propagates', () => {
    expect(ev('=SUM(#REF!, 5)')).toBe('#REF!')
  })

  it('error literal in comparison propagates', () => {
    expect(ev('=#REF!>5')).toBe('#REF!')
  })

  it('error literal as IF condition propagates', () => {
    expect(ev('=IF(#N/A, 1, 2)')).toBe('#N/A')
  })

  it('unrecognised # token returns #ERROR!', () => {
    expect(ev('=#UNKNOWN!')).toBe('#ERROR!')
  })
})
