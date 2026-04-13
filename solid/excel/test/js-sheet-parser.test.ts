import { describe, expect, it } from '@jest/globals'
import {
  isFormulaReference,
  parseFormula,
  serializeFormula,
  shiftFormulaInput,
} from '../src/js-sheet/parser'

describe('js-sheet formula parser helpers', () => {
  it('parses nested formulas with ranges and comparisons', () => {
    expect(parseFormula('=IF(SUM(A1:B2)>=10,TRUE,"low")')).toEqual({
      kind: 'func',
      name: 'IF',
      args: [
        {
          kind: 'binop',
          op: '>=',
          left: {
            kind: 'func',
            name: 'SUM',
            args: [
              {
                kind: 'range',
                start: { addr: 'A1', absCol: false, absRow: false },
                end: { addr: 'B2', absCol: false, absRow: false },
              },
            ],
          },
          right: { kind: 'number', value: 10 },
        },
        { kind: 'boolean', value: true },
        { kind: 'text', value: 'low' },
      ],
    })
  })

  it('serializes formulas with mixed and absolute references', () => {
    const parsed = parseFormula('=SUM($A1,B$2,$C$3)')
    expect(parsed).not.toBeNull()
    expect(serializeFormula(parsed!)).toBe('=SUM($A1,B$2,$C$3)')
  })

  it('parses and serializes cross-sheet references and ranges', () => {
    expect(parseFormula('=Sheet2!A1')).toEqual({
      kind: 'cell',
      ref: { addr: 'A1', absCol: false, absRow: false, sheetName: 'Sheet2' },
    })

    const parsed = parseFormula('=SUM(Sheet2!A1:B2)')
    expect(parsed).not.toBeNull()
    expect(serializeFormula(parsed!)).toBe('=SUM(Sheet2!A1:B2)')
  })

  it('shifts nested formulas while preserving absolute axes', () => {
    expect(shiftFormulaInput('=SUM(A1:B2)+$C3+D$4+$E$5', 1, 2)).toBe(
      '=SUM(C2:D3)+$C4+F$4+$E$5',
    )
  })

  it('returns null when shifting invalid formula input', () => {
    expect(shiftFormulaInput('=SUM(', 1, 1)).toBeNull()
  })

  it('detects formula references including absolute syntax', () => {
    expect(isFormulaReference('A1')).toBe(true)
    expect(isFormulaReference('$B$2')).toBe(true)
    expect(isFormulaReference('SUM(A1)')).toBe(false)
  })

  it('serializes out-of-bounds relative shifts as #REF! instead of clamping back into the sheet', () => {
    expect(shiftFormulaInput('=A1', -1, 0)).toBe('=#REF!')
    expect(parseFormula('=#REF!')).toEqual({ kind: 'error', value: '#REF!' })
  })
})
