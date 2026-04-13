import { describe, expect, it } from '@jest/globals'
import {
  colIndexToLetters,
  colLettersToIndex,
  expandRange,
  formatCellRef,
  isCellAddress,
  normalizeAddr,
  parseAddr,
  parseCellRef,
  shiftCellRef,
} from '../src/js-sheet/address'

describe('js-sheet address helpers', () => {
  it('normalizes addresses by uppercasing and stripping dollar signs', () => {
    expect(normalizeAddr('$b$12')).toBe('B12')
  })

  it('converts column letters to indexes and back', () => {
    expect(colLettersToIndex('A')).toBe(0)
    expect(colLettersToIndex('AZ')).toBe(51)
    expect(colIndexToLetters(0)).toBe('A')
    expect(colIndexToLetters(51)).toBe('AZ')
  })

  it('parses cell addresses and validates bad input', () => {
    expect(parseAddr('C7')).toEqual({ row: 6, col: 2 })
    expect(() => parseAddr('0')).toThrow('Invalid address: 0')
    expect(() => parseAddr('A0')).toThrow('Invalid address: A0')
  })

  it('detects valid cell addresses', () => {
    expect(isCellAddress('AA10')).toBe(true)
    expect(isCellAddress('$b$2')).toBe(true)
    expect(isCellAddress('SUM')).toBe(false)
  })

  it('expands a rectangular range in row-major order', () => {
    expect(expandRange('B2', 'C3')).toEqual(['B2', 'C2', 'B3', 'C3'])
  })

  it('parses and formats mixed and absolute references', () => {
    expect(parseCellRef('$B3')).toEqual({
      addr: 'B3',
      absCol: true,
      absRow: false,
    })
    expect(formatCellRef({
      addr: 'C4',
      absCol: false,
      absRow: true,
    })).toBe('C$4')
  })

  it('shifts only relative axes', () => {
    expect(shiftCellRef({
      addr: 'B2',
      absCol: false,
      absRow: false,
    }, 2, 1)).toEqual({
      addr: 'C4',
      absCol: false,
      absRow: false,
    })

    expect(shiftCellRef({
      addr: 'B2',
      absCol: true,
      absRow: false,
    }, 3, 5)).toEqual({
      addr: 'B5',
      absCol: true,
      absRow: false,
    })
  })

  it('produces #REF!-style invalid references instead of clamping when shifting past row 1 or column A', () => {
    expect(shiftCellRef({
      addr: 'A1',
      absCol: false,
      absRow: false,
    }, -1, 0)).toEqual({
      addr: 'A1',
      absCol: false,
      absRow: false,
      invalid: true,
    })

    expect(formatCellRef(shiftCellRef({
      addr: 'A1',
      absCol: false,
      absRow: false,
    }, 0, -1))).toBe('#REF!')
  })
})
