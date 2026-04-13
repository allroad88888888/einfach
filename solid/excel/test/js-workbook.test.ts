import { describe, expect, it } from '@jest/globals'
import { createJSWorkbook } from '../src/js-workbook'

describe('createJSWorkbook', () => {
  it('evaluates cross-sheet formulas and preserves raw input', () => {
    const workbook = createJSWorkbook({
      sheets: [
        { name: 'Sheet1', rows: 10, cols: 10 },
        { name: 'Sheet2', rows: 10, cols: 10 },
      ],
    })

    workbook.set_number('A1', 10)
    workbook.set_active_sheet(1)
    workbook.set_number('A1', 5)
    workbook.set_active_sheet(0)
    workbook.set_formula('B1', '=Sheet2!A1+A1')

    expect(workbook.get_display('B1')).toBe('15')
    expect(workbook.get_input('B1')).toBe('=Sheet2!A1+A1')
  })

  it('rewrites formulas for row and column structure edits', () => {
    const workbook = createJSWorkbook({
      sheets: [
        { name: 'Sheet1', rows: 12, cols: 12 },
        { name: 'Sheet2', rows: 12, cols: 12 },
      ],
    })

    workbook.set_formula('B4', '=A2')
    workbook.insert_row(1, 1)
    expect(workbook.get_input('B5')).toBe('=A3')
    workbook.delete_row(2, 1)
    expect(workbook.get_input('B4')).toBe('=#REF!')

    workbook.set_formula('C1', '=Sheet2!B1')
    workbook.set_active_sheet(1)
    workbook.insert_col(0, 1)
    workbook.set_active_sheet(0)
    expect(workbook.get_input('C1')).toBe('=Sheet2!C1')
  })

  it('renames and deletes sheets while updating dependent formulas', () => {
    const workbook = createJSWorkbook({
      sheets: [
        { name: 'Sheet1', rows: 10, cols: 10 },
        { name: 'Sheet2', rows: 10, cols: 10 },
      ],
    })

    workbook.set_formula('A1', '=Sheet2!B2')
    expect(workbook.rename_sheet(1, 'Inputs')).toBe(true)
    expect(workbook.get_input('A1')).toBe('=Inputs!B2')
    expect(workbook.remove_sheet(1)).toBe(true)
    expect(workbook.get_input('A1')).toBe('=#REF!')
    expect(workbook.get_display('A1')).toBe('#REF!')
  })

  it('tracks row/column sizes and freeze flags per active sheet', () => {
    const workbook = createJSWorkbook()
    workbook.set_row_height(0, 18)
    workbook.set_col_width(0, 40)
    workbook.set_freeze_top_row(true)
    workbook.set_freeze_first_column(true)

    expect(workbook.row_height(0)).toBe(24)
    expect(workbook.col_width(0)).toBe(56)
    expect(workbook.freeze_top_row()).toBe(true)
    expect(workbook.freeze_first_column()).toBe(true)
  })
})
