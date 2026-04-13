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

  it('formats numeric display and preserves style through JSON export/import', () => {
    const workbook = createJSWorkbook()
    workbook.set_number('A1', 1234.5)
    workbook.set_format(['A1'], {
      bold: true,
      textColor: '#ff0000',
      numberFormat: {
        kind: 'currency',
        decimals: 1,
        useGrouping: true,
        currencySymbol: '¥',
      },
    })

    expect(workbook.get_display('A1')).toBe('¥1,234.5')
    expect(workbook.get_format('A1').bold).toBe(true)

    const payload = workbook.export_json()
    const restored = createJSWorkbook()

    expect(restored.import_json(payload)).toBe(true)
    expect(restored.get_display('A1')).toBe('¥1,234.5')
    expect(restored.get_format('A1').textColor).toBe('#ff0000')
  })

  it('imports csv into the active sheet and exports quoted csv values', () => {
    const workbook = createJSWorkbook()
    expect(workbook.import_csv('Name,Value\n"hello,world",42\n=1+1,5')).toBe(true)

    expect(workbook.get_input('A2')).toBe('hello,world')
    expect(workbook.get_display('B2')).toBe('42')
    expect(workbook.get_input('A3')).toBe('=1+1')
    expect(workbook.get_display('A3')).toBe('2')

    workbook.set_text('C1', 'x,y')
    const csv = workbook.export_csv()
    expect(csv).toContain('"hello,world"')
    expect(csv).toContain('"x,y"')
    expect(csv).toContain('=1+1')
  })

  it('round-trips Excel-compatible csv import and export in a single unit test', () => {
    const imported = [
      'Item,Amount,Note',
      '"Widget, XL",1234.5,"first line"',
      'Discount,=B2*0.1,"applies formula"',
      'Flag,TRUE,"boolean-like text stays text"',
    ].join('\n')

    const workbook = createJSWorkbook()
    expect(workbook.import_csv(imported)).toBe(true)

    expect(workbook.get_input('A2')).toBe('Widget, XL')
    expect(workbook.get_input('B3')).toBe('=B2*0.1')
    expect(workbook.get_display('B3')).toBe('123.45')
    expect(workbook.get_input('B4')).toBe('TRUE')

    const exported = workbook.export_csv()
    const lines = exported.split('\n')

    expect(lines[0]).toBe('Item,Amount,Note')
    expect(lines[1]).toBe('"Widget, XL",1234.5,first line')
    expect(lines[2]).toBe('Discount,=B2*0.1,applies formula')
    expect(lines[3]).toBe('Flag,TRUE,boolean-like text stays text')

    const roundTripped = createJSWorkbook()
    expect(roundTripped.import_csv(exported)).toBe(true)
    expect(roundTripped.get_input('A2')).toBe('Widget, XL')
    expect(roundTripped.get_input('B3')).toBe('=B2*0.1')
    expect(roundTripped.get_display('B3')).toBe('123.45')
  })
})
