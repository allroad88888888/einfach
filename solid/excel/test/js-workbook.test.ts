import { describe, expect, it } from '@jest/globals'
import { createJSWorkbook } from '../src/js-workbook'

async function loadExcelJS() {
  return await import('exceljs') as unknown as {
    Workbook: new () => {
      addWorksheet: (name: string, options?: Record<string, unknown>) => any
      xlsx: { writeBuffer: () => Promise<ArrayBuffer | Uint8Array> }
    }
  }
}

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
    const parsed = JSON.parse(payload) as {
      activeSheetIndex: number
      sheets: Array<{
        name: string
        metadata: { rowCount: number; colCount: number; freezeTopRow: boolean; freezeFirstColumn: boolean }
        rowHeights: Array<[number, number]>
        colWidths: Array<[number, number]>
        cells: Array<[string, { type: string; value: number | string | boolean | null }]>
        formulas: Array<[string, string]>
        formats: Array<[string, unknown]>
        mergedRanges: string[]
      }>
    }
    parsed.sheets[0].mergedRanges = ['A1:B1']

    expect(restored.import_json(JSON.stringify(parsed))).toBe(true)
    const restoredPayload = JSON.parse(restored.export_json()) as typeof parsed
    expect(restored.get_display('A1')).toBe('¥1,234.5')
    expect(restored.get_format('A1').textColor).toBe('#ff0000')
    expect(restoredPayload.sheets[0].mergedRanges).toEqual(['A1:B1'])
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

  it('imports xlsx workbooks with formulas, styles, freeze panes, and dimensions', async () => {
    const ExcelJS = await loadExcelJS()
    const source = new ExcelJS.Workbook()
    const sheet1 = source.addWorksheet('Sheet1', {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }],
    })
    const sheet2 = source.addWorksheet('Sheet2')

    sheet1.getCell('A1').value = 1234.5
    sheet1.getCell('A1').font = { bold: true, italic: true, size: 16, color: { argb: 'FFFF0000' } }
    sheet1.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FF00' } }
    sheet1.getCell('A1').alignment = { horizontal: 'right', vertical: 'middle' }
    sheet1.getCell('A1').border = {
      top: { style: 'thin', color: { argb: 'FF112233' } },
      right: { style: 'thin', color: { argb: 'FF112233' } },
      bottom: { style: 'thin', color: { argb: 'FF112233' } },
      left: { style: 'thin', color: { argb: 'FF112233' } },
    }
    sheet1.getCell('A1').numFmt = '"¥"#,##0.0'
    sheet1.getCell('B1').value = { formula: 'A1*2', result: 2469 }
    sheet1.getRow(1).height = 36
    sheet1.getColumn(1).width = 180
    sheet2.getCell('A1').value = 'inputs'
    sheet1.mergeCells('D4:E4')
    sheet1.getCell('D4').value = 'merged'

    const bytes = await source.xlsx.writeBuffer()
    const workbook = createJSWorkbook()

    await expect(workbook.import_xlsx(new Uint8Array(bytes))).resolves.toBe(true)
    expect(workbook.sheet_count()).toBe(2)
    expect(workbook.freeze_top_row()).toBe(true)
    expect(workbook.freeze_first_column()).toBe(true)
    expect(workbook.row_height(0)).toBe(36)
    expect(workbook.col_width(0)).toBe(180)
    expect(workbook.get_input('B1')).toBe('=A1*2')
    expect(workbook.get_display('B1')).toBe('2469')
    expect(workbook.get_format('A1')).toEqual(expect.objectContaining({
      bold: true,
      italic: true,
      fontSize: 16,
      textColor: '#ff0000',
      backgroundColor: '#00ff00',
      horizontalAlign: 'right',
      verticalAlign: 'middle',
      borderStyle: 'solid',
      borderColor: '#112233',
    }))
    expect(workbook.get_format('A1').numberFormat).toEqual({
      kind: 'currency',
      decimals: 1,
      useGrouping: true,
      currencySymbol: '¥',
    })
    expect(workbook.get_input('D4')).toBe('merged')
  })

  it('round-trips xlsx export and import while preserving workbook structure', async () => {
    const workbook = createJSWorkbook({
      sheets: [
        { name: 'Sheet1', rows: 20, cols: 10 },
        { name: 'Sheet2', rows: 20, cols: 10 },
      ],
    })

    workbook.set_number('A1', 1234.5)
    workbook.set_formula('B1', '=A1*2')
    workbook.set_format(['A1'], {
      bold: true,
      backgroundColor: '#00ff00',
      textColor: '#ff0000',
      numberFormat: {
        kind: 'currency',
        decimals: 1,
        useGrouping: true,
        currencySymbol: '¥',
      },
    })
    workbook.set_row_height(0, 34)
    workbook.set_col_width(0, 168)
    workbook.set_freeze_top_row(true)
    workbook.set_freeze_first_column(true)
    workbook.set_active_sheet(1)
    workbook.set_text('A1', 'inputs')
    workbook.set_active_sheet(0)

    const exported = await workbook.export_xlsx()
    const restored = createJSWorkbook()
    await expect(restored.import_xlsx(exported)).resolves.toBe(true)

    expect(restored.sheet_count()).toBe(2)
    expect(restored.sheet_name(1)).toBe('Sheet2')
    expect(restored.get_input('B1')).toBe('=A1*2')
    expect(restored.get_display('B1')).toBe('2469')
    expect(restored.row_height(0)).toBe(34)
    expect(restored.col_width(0)).toBe(168)
    expect(restored.freeze_top_row()).toBe(true)
    expect(restored.freeze_first_column()).toBe(true)
    expect(restored.get_format('A1')).toEqual(expect.objectContaining({
      bold: true,
      textColor: '#ff0000',
      backgroundColor: '#00ff00',
    }))
    restored.set_active_sheet(1)
    expect(restored.get_input('A1')).toBe('inputs')
  })

  it('exports merged ranges into xlsx while keeping the master cell content and independent formulas', async () => {
    const ExcelJS = await loadExcelJS()
    const workbook = createJSWorkbook()
    const snapshot = workbook.snapshot()
    snapshot.sheets[0] = {
      ...snapshot.sheets[0],
      cells: [
        ['A1', { type: 'text', value: '标题' }],
        ['A2', { type: 'number', value: 123 }],
        ['B1', { type: 'text', value: 'ignored covered value' }],
      ],
      formulas: [['B2', '=A2*2']],
      mergedRanges: ['A1:C1'],
    }
    workbook.restore(snapshot)

    const exported = await workbook.export_xlsx()
    const restoredExcel = new ExcelJS.Workbook() as any
    await restoredExcel.xlsx.load(exported.slice().buffer)

    const sheet = restoredExcel.getWorksheet('Sheet1')
    expect(sheet?.model?.merges).toContain('A1:C1')
    expect(sheet?.getCell('A1').value).toBe('标题')
    expect(sheet?.getCell('B1').value).toBe('标题')
    expect(sheet?.getCell('B1').master?.address).toBe('A1')
    expect(sheet?.getCell('B2').formula).toBe('A2*2')
  })

  it('ignores invalid or overlapping merged ranges during xlsx export', async () => {
    const ExcelJS = await loadExcelJS()
    const workbook = createJSWorkbook()
    const snapshot = workbook.snapshot()
    snapshot.sheets[0] = {
      ...snapshot.sheets[0],
      cells: [['A1', { type: 'text', value: '标题' }]],
      mergedRanges: ['A1:A1', 'A1:B1', 'B1:C1', 'bad'],
    }
    workbook.restore(snapshot)

    const exported = await workbook.export_xlsx()
    const restoredExcel = new ExcelJS.Workbook() as any
    await restoredExcel.xlsx.load(exported.slice().buffer)

    const sheet = restoredExcel.getWorksheet('Sheet1')
    expect(sheet?.model?.merges).toEqual(['A1:B1'])
  })
})
