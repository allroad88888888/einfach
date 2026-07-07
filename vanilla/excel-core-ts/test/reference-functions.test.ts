import { describe, expect, test } from '@jest/globals'

import { createWorkbook } from '../src/workbook'
import { keyFor } from '../src/sheet'
import type { Value, Workbook } from '../src/types'

function read(wb: Workbook, sheetId: string, row: number, col: number): Value {
  const sheet = wb.sheet(sheetId)
  if (!sheet) throw new Error(`missing sheet ${sheetId}`)
  return wb.store.getter(sheet.formulaCellAtom(keyFor(row, col)))
}

const num = (value: number): Value => ({ kind: 'number', value })
const str = (value: string): Value => ({ kind: 'string', value })
const arr = (value: Value[][]): Value => ({ kind: 'array', value })

describe('reference/workbook-aware functions', () => {
  test('SHEET and SHEETS use workbook sheet metadata', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 'data', name: 'Data' },
      { id: 'notes', name: 'Notes' },
    ])

    wb.setCell('s1', 0, 0, '=SHEET(Data!A1)')
    wb.setCell('s1', 1, 0, '=SHEET(Notes!A1)')
    wb.setCell('s1', 2, 0, '=SHEET()')
    wb.setCell('notes', 0, 0, '=SHEET()')
    wb.setCell('s1', 3, 0, '=SHEETS()')
    wb.setCell('s1', 4, 0, '=SHEET(Missing!A1)')
    wb.setCell('s1', 5, 0, '=SHEETS(Missing!A1)')

    expect(read(wb, 's1', 0, 0)).toEqual(num(2))
    expect(read(wb, 's1', 1, 0)).toEqual(num(3))
    expect(read(wb, 's1', 2, 0)).toEqual(num(1))
    expect(read(wb, 'notes', 0, 0)).toEqual(num(3))
    expect(read(wb, 's1', 3, 0)).toEqual(num(3))
    expect(read(wb, 's1', 4, 0)).toEqual({ kind: 'error', code: '#REF!' })
    expect(read(wb, 's1', 5, 0)).toEqual({ kind: 'error', code: '#REF!' })
  })

  test('FORMULATEXT returns same-sheet and cross-sheet formula source', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 'data', name: 'Data' },
    ])
    wb.setCell('s1', 0, 0, '2')
    wb.setCell('s1', 0, 1, '=A1*3')
    wb.setCell('data', 0, 2, '=42+1')

    wb.setCell('s1', 0, 3, '=FORMULATEXT(B1)')
    wb.setCell('s1', 1, 3, '=FORMULATEXT(A1)')
    wb.setCell('s1', 2, 3, '=FORMULATEXT(Data!C1)')

    expect(read(wb, 's1', 0, 3)).toEqual(str('=A1*3'))
    expect(read(wb, 's1', 1, 3)).toEqual({ kind: 'error', code: '#N/A' })
    expect(read(wb, 's1', 2, 3)).toEqual(str('=42+1'))
  })

  test('CELL reports current cell and reference metadata', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, 'hello')
    wb.setCell('s1', 1, 1, '99')
    wb.setCell('s1', 7, 1, '=1+1')

    wb.setCell('s1', 6, 2, '=CELL("row")')
    wb.setCell('s1', 0, 2, '=CELL("address",B2)')
    wb.setCell('s1', 1, 2, '=CELL("contents",B2)')
    wb.setCell('s1', 2, 2, '=CELL("type",A1)')
    wb.setCell('s1', 3, 2, '=CELL("prefix",A1)')
    wb.setCell('s1', 4, 2, '=CELL("col",B2)')
    wb.setCell('s1', 5, 2, '=CELL("address",OFFSET(A1,1,1))')
    wb.setCell('s1', 6, 3, '=FORMULATEXT(OFFSET(A1,7,1))')
    wb.setCell('s1', 0, 4, '=CELL("color",B2)')
    wb.setCell('s1', 1, 4, '=CELL("parentheses",B2)')
    wb.setCell('s1', 2, 4, '=CELL("format",B2)')
    wb.setCell('s1', 3, 4, '=CELL("filename",B2)')

    expect(read(wb, 's1', 6, 2)).toEqual(num(7))
    expect(read(wb, 's1', 0, 2)).toEqual(str('$B$2'))
    expect(read(wb, 's1', 1, 2)).toEqual(num(99))
    expect(read(wb, 's1', 2, 2)).toEqual(str('l'))
    expect(read(wb, 's1', 3, 2)).toEqual(str("'"))
    expect(read(wb, 's1', 4, 2)).toEqual(num(2))
    expect(read(wb, 's1', 5, 2)).toEqual(str('$B$2'))
    expect(read(wb, 's1', 6, 3)).toEqual(str('=1+1'))
    expect(read(wb, 's1', 0, 4)).toEqual(num(0))
    expect(read(wb, 's1', 1, 4)).toEqual(num(0))
    expect(read(wb, 's1', 2, 4)).toEqual(str('G'))
    expect(read(wb, 's1', 3, 4)).toEqual(str(''))
  })

  test('CELL address includes cross-sheet prefixes and quotes sheet names', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 'data', name: 'Data' },
      { id: 'space', name: 'Data Sheet' },
      { id: 'quote', name: "O'Brien" },
    ])
    wb.setCell('data', 2, 2, '7')
    wb.setCell('space', 0, 0, '8')
    wb.setCell('quote', 0, 0, '9')

    wb.setCell('s1', 0, 5, '=CELL("address",Data!C3)')
    wb.setCell('s1', 1, 5, '=CELL("address",\'Data Sheet\'!A1)')
    wb.setCell('s1', 2, 5, '=CELL("address",\'O\'\'Brien\'!A1)')
    wb.setCell('s1', 3, 5, '=CELL("address",INDIRECT("\'Data Sheet\'!A1"))')

    expect(read(wb, 's1', 0, 5)).toEqual(str('Data!$C$3'))
    expect(read(wb, 's1', 1, 5)).toEqual(str("'Data Sheet'!$A$1"))
    expect(read(wb, 's1', 2, 5)).toEqual(str("'O''Brien'!$A$1"))
    expect(read(wb, 's1', 3, 5)).toEqual(str("'Data Sheet'!$A$1"))
  })

  test('LET and LAMBDA preserve scoped reference identity for reference-aware functions', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 'data', name: 'Data' },
    ])
    wb.setCell('data', 0, 0, '1')
    wb.setCell('data', 1, 0, '2')
    wb.setCell('data', 2, 0, '3')
    wb.setCell('data', 2, 2, '7')
    wb.setCell('data', 4, 0, '=SUM(A1:A3)')

    wb.setCell('s1', 0, 0, '=LET(r,Data!C3,CELL("address",r))')
    wb.setCell('s1', 1, 0, '=LAMBDA(r,CELL("address",r))(Data!C3)')
    wb.setCell('s1', 2, 0, '=LAMBDA(r,FORMULATEXT(r))(Data!A5)')
    wb.setCell('s1', 3, 0, '=LAMBDA(r,SUM(INDEX(r,1):INDEX(r,3)))(Data!A:A)')
    wb.setCell('s1', 4, 0, '=LET(r,Data!C3,r+1)')

    expect(read(wb, 's1', 0, 0)).toEqual(str('Data!$C$3'))
    expect(read(wb, 's1', 1, 0)).toEqual(str('Data!$C$3'))
    expect(read(wb, 's1', 2, 0)).toEqual(str('=SUM(A1:A3)'))
    expect(read(wb, 's1', 3, 0)).toEqual(num(6))
    expect(read(wb, 's1', 4, 0)).toEqual(num(8))
  })

  test('ROW/COLUMN/ROWS/COLUMNS use current cell and reference metadata', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])

    wb.setCell('s1', 6, 2, '=ROW()')
    wb.setCell('s1', 6, 3, '=COLUMN()')
    wb.setCell('s1', 0, 0, '=ROW(B2)')
    wb.setCell('s1', 0, 1, '=COLUMN(B2)')
    wb.setCell('s1', 0, 2, '=ROWS(B2:C4)')
    wb.setCell('s1', 0, 3, '=COLUMNS(B2:C4)')
    wb.setCell('s1', 10, 0, '=ROW(B2:B4)')
    wb.setCell('s1', 10, 4, '=COLUMN(B2:D2)')
    wb.setCell('s1', 14, 0, '=ROW(OFFSET(A1,1,0,2,1))')
    wb.setCell('s1', 14, 3, '=ROWS(OFFSET(A1,1,0,3,2))')
    wb.setCell('s1', 17, 0, '=COLUMN(INDIRECT("C1"))')
    wb.setCell('s1', 17, 1, '=COLUMNS(INDIRECT("B2:D2"))')
    wb.setCell('s1', 18, 0, '=ROW(CHOOSE(2,A1,B2))')
    wb.setCell('s1', 18, 1, '=CELL("address",CHOOSE(2,A1,B2))')

    expect(read(wb, 's1', 6, 2)).toEqual(num(7))
    expect(read(wb, 's1', 6, 3)).toEqual(num(4))
    expect(read(wb, 's1', 0, 0)).toEqual(num(2))
    expect(read(wb, 's1', 0, 1)).toEqual(num(2))
    expect(read(wb, 's1', 0, 2)).toEqual(num(3))
    expect(read(wb, 's1', 0, 3)).toEqual(num(2))
    expect(read(wb, 's1', 10, 0)).toEqual(arr([[num(2)], [num(3)], [num(4)]]))
    expect(read(wb, 's1', 10, 4)).toEqual(arr([[num(2), num(3), num(4)]]))
    expect(read(wb, 's1', 14, 0)).toEqual(arr([[num(2)], [num(3)]]))
    expect(read(wb, 's1', 14, 3)).toEqual(num(3))
    expect(read(wb, 's1', 17, 0)).toEqual(num(3))
    expect(read(wb, 's1', 17, 1)).toEqual(num(3))
    expect(read(wb, 's1', 18, 0)).toEqual(num(2))
    expect(read(wb, 's1', 18, 1)).toEqual(str('$B$2'))
  })

  test('INDIRECT resolves same-sheet and cross-sheet A1 text', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 'data', name: 'Data' },
    ])
    wb.setCell('s1', 1, 1, '99')
    wb.setCell('s1', 4, 0, '1')
    wb.setCell('s1', 5, 0, '2')
    wb.setCell('data', 2, 2, '7')

    wb.setCell('s1', 0, 0, '=INDIRECT("B2")')
    wb.setCell('s1', 0, 3, '=SUM(INDIRECT("A5:A6"))')
    wb.setCell('s1', 1, 3, '=INDIRECT("Data!C3")')
    wb.setCell('s1', 2, 3, '=INDIRECT("R1C1",FALSE)')
    wb.setCell('s1', 3, 3, '=SUM(INDIRECT("R5C1:R6C1",FALSE))')
    wb.setCell('s1', 4, 4, '=INDIRECT("R[-3]C[-3]",FALSE)')
    wb.setCell('s1', 5, 4, '=INDIRECT("Data!R3C3",FALSE)')

    expect(read(wb, 's1', 0, 0)).toEqual(num(99))
    expect(read(wb, 's1', 0, 3)).toEqual(num(3))
    expect(read(wb, 's1', 1, 3)).toEqual(num(7))
    expect(read(wb, 's1', 2, 3)).toEqual(num(99))
    expect(read(wb, 's1', 3, 3)).toEqual(num(3))
    expect(read(wb, 's1', 4, 4)).toEqual(num(99))
    expect(read(wb, 's1', 5, 4)).toEqual(num(7))
  })

  test('OFFSET returns scalar and range values and tracks range deps', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '1')
    wb.setCell('s1', 1, 0, '2')
    wb.setCell('s1', 2, 0, '3')

    wb.setCell('s1', 0, 1, '=OFFSET(A1,1,0)')
    wb.setCell('s1', 1, 1, '=SUM(OFFSET(A1,0,0,3,1))')
    wb.setCell('s1', 2, 1, '=OFFSET(A1,-1,0)')

    expect(read(wb, 's1', 0, 1)).toEqual(num(2))
    expect(read(wb, 's1', 1, 1)).toEqual(num(6))
    expect(read(wb, 's1', 2, 1)).toEqual({ kind: 'error', code: '#REF!' })

    wb.setCell('s1', 1, 0, '20')
    expect(read(wb, 's1', 1, 1)).toEqual(num(24))
  })

  test('INDEX can feed reference-aware functions', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '1')
    wb.setCell('s1', 1, 1, '99')
    wb.setCell('s1', 0, 2, '7')
    wb.setCell('s1', 1, 2, '8')
    wb.setCell('s1', 2, 0, '=1+1')

    wb.setCell('s1', 0, 3, '=CELL("address",INDEX(A1:B2,2,2))')
    wb.setCell('s1', 1, 3, '=OFFSET(INDEX(A1:B2,1,1),1,1)')
    wb.setCell('s1', 2, 3, '=ROWS(INDEX(A1:B3,0,1))')
    wb.setCell('s1', 3, 3, '=FORMULATEXT(INDEX(A1:B3,3,1))')
    wb.setCell('s1', 4, 3, '=CELL("address",INDEX((A1:A2,C1:C2),2,1,2))')
    wb.setCell('s1', 5, 3, '=INDEX((A1:A2,C1:C2),2,1,2)')
    wb.setCell('s1', 6, 3, '=INDEX((A1:A2,C1:C2),1,1,3)')
    wb.setCell('s1', 7, 3, '=ROWS(INDEX(A1:A3,0))')

    expect(read(wb, 's1', 0, 3)).toEqual(str('$B$2'))
    expect(read(wb, 's1', 1, 3)).toEqual(num(99))
    expect(read(wb, 's1', 2, 3)).toEqual(num(3))
    expect(read(wb, 's1', 3, 3)).toEqual(str('=1+1'))
    expect(read(wb, 's1', 4, 3)).toEqual(str('$C$2'))
    expect(read(wb, 's1', 5, 3)).toEqual(num(8))
    expect(read(wb, 's1', 6, 3)).toEqual({ kind: 'error', code: '#REF!' })
    expect(read(wb, 's1', 7, 3)).toEqual(num(3))
  })

  test('spill references materialize anchor arrays for reference-aware functions', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 'data', name: 'Data' },
    ])

    wb.setCell('s1', 0, 0, '=SEQUENCE(2,2)')
    wb.setCell('data', 0, 0, '=SEQUENCE(2,1,10)')
    wb.setCell('s1', 0, 4, '=SUM(A1#)')
    wb.setCell('s1', 1, 4, '=ROWS(A1#)')
    wb.setCell('s1', 2, 4, '=COLUMNS(A1#)')
    wb.setCell('s1', 3, 4, '=INDEX(A1#,2,2)')
    wb.setCell('s1', 4, 4, '=SUM(Data!A1#)')
    wb.setCell('s1', 5, 4, '=CELL("contents",A1#)')

    expect(read(wb, 's1', 0, 4)).toEqual(num(10))
    expect(read(wb, 's1', 1, 4)).toEqual(num(2))
    expect(read(wb, 's1', 2, 4)).toEqual(num(2))
    expect(read(wb, 's1', 3, 4)).toEqual(num(4))
    expect(read(wb, 's1', 4, 4)).toEqual(num(21))
    expect(read(wb, 's1', 5, 4)).toEqual(num(1))

    wb.setCell('s1', 0, 0, '=SEQUENCE(3,1)')
    expect(read(wb, 's1', 0, 4)).toEqual(num(6))
    expect(read(wb, 's1', 1, 4)).toEqual(num(3))
    expect(read(wb, 's1', 2, 4)).toEqual(num(1))
  })

  test('direct spill references preserve 1x1 array identity', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '=SEQUENCE(1,1)')
    wb.setCell('s1', 0, 1, '=A1#')
    wb.setCell('s1', 0, 2, '=B1#')

    expect(read(wb, 's1', 0, 1)).toEqual(arr([[num(1)]]))
    expect(read(wb, 's1', 0, 2)).toEqual(arr([[num(1)]]))
  })

  test('spill references reject scalar anchors', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '1')
    wb.setCell('s1', 0, 1, '=A1#')

    expect(read(wb, 's1', 0, 1)).toMatchObject({ kind: 'error', code: '#REF!' })
  })

  test('spill references propagate anchor #SPILL! when the anchor exceeds sheet bounds', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 1048575, 0, '=SEQUENCE(2,1)')
    wb.setCell('s1', 0, 1, '=A1048576#')

    expect(read(wb, 's1', 1048575, 0)).toMatchObject({ kind: 'error', code: '#SPILL!' })
    expect(read(wb, 's1', 0, 1)).toMatchObject({ kind: 'error', code: '#SPILL!' })
  })

  test('dynamic range endpoints can come from reference-returning functions', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '1')
    wb.setCell('s1', 1, 0, '2')
    wb.setCell('s1', 2, 0, '3')
    wb.setCell('s1', 3, 0, '4')
    wb.setCell('s1', 0, 3, '=SUM(A1:INDEX(A:A,3))')
    wb.setCell('s1', 1, 3, '=ROWS(A1:INDEX(A:A,3))')
    wb.setCell('s1', 2, 3, '=A1:1+2')
    wb.setCell('s1', 3, 3, '=SUM(INDEX(A:A,1):INDEX(A:A,3))')
    wb.setCell('s1', 4, 3, '=SUM(1:INDEX(A:A,3))')

    expect(read(wb, 's1', 0, 3)).toEqual(num(6))
    expect(read(wb, 's1', 1, 3)).toEqual(num(3))
    expect(read(wb, 's1', 2, 3)).toEqual({ kind: 'error', code: '#VALUE!' })
    expect(read(wb, 's1', 3, 3)).toEqual(num(6))
    expect(read(wb, 's1', 4, 3)).toEqual({ kind: 'error', code: '#VALUE!' })
  })

  test('dynamic range can start from a cross-sheet literal and end at INDEX', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 'data', name: 'Data' },
    ])
    wb.setCell('data', 0, 0, '1')
    wb.setCell('data', 1, 0, '2')
    wb.setCell('data', 2, 0, '3')
    wb.setCell('data', 3, 0, '4')
    wb.setCell('s1', 0, 0, '=SUM(Data!A1:INDEX(Data!A:A,3))')
    wb.setCell('s1', 1, 0, '=ROWS(Data!A1:INDEX(Data!A:A,3))')

    expect(read(wb, 's1', 0, 0)).toEqual(num(6))
    expect(read(wb, 's1', 1, 0)).toEqual(num(3))
  })

  test('ISFORMULA and ISREF inspect references in formula evaluation', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 'data', name: 'Data' },
    ])
    wb.setCell('s1', 0, 0, '1')
    wb.setCell('s1', 0, 1, '=A1+1')
    wb.setCell('data', 0, 0, '=42')
    wb.defineName('DATA_FORMULA', {
      kind: 'range',
      sheetName: 'Data',
      start: 'A1',
      end: 'A1',
    })

    wb.setCell('s1', 0, 3, '=ISFORMULA(B1)')
    wb.setCell('s1', 1, 3, '=ISFORMULA(A1)')
    wb.setCell('s1', 2, 3, '=ISFORMULA(INDEX(A1:B1,1,2))')
    wb.setCell('s1', 3, 3, '=ISFORMULA(DATA_FORMULA)')
    wb.setCell('s1', 4, 3, '=ISREF(B1)')
    wb.setCell('s1', 5, 3, '=ISREF(1+2)')
    wb.setCell('s1', 6, 3, '=ISREF(INDEX(A1:B1,1,2))')
    wb.setCell('s1', 7, 3, '=ISREF(INDIRECT("not-a-ref"))')
    wb.setCell('s1', 8, 3, '=ISREF((A1,B1))')
    wb.setCell('s1', 9, 3, '=ISREF((A1,Missing!A1))')

    expect(read(wb, 's1', 0, 3)).toEqual({ kind: 'boolean', value: true })
    expect(read(wb, 's1', 1, 3)).toEqual({ kind: 'boolean', value: false })
    expect(read(wb, 's1', 2, 3)).toEqual({ kind: 'boolean', value: true })
    expect(read(wb, 's1', 3, 3)).toEqual({ kind: 'boolean', value: true })
    expect(read(wb, 's1', 4, 3)).toEqual({ kind: 'boolean', value: true })
    expect(read(wb, 's1', 5, 3)).toEqual({ kind: 'boolean', value: false })
    expect(read(wb, 's1', 6, 3)).toEqual({ kind: 'boolean', value: true })
    expect(read(wb, 's1', 7, 3)).toEqual({ kind: 'boolean', value: false })
    expect(read(wb, 's1', 8, 3)).toEqual({ kind: 'boolean', value: true })
    expect(read(wb, 's1', 9, 3)).toEqual({ kind: 'boolean', value: false })
  })

  test('AREAS counts supported single-area references', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 'data', name: 'Data' },
    ])
    wb.setCell('s1', 0, 5, '=AREAS(A1:B2)')
    wb.setCell('s1', 1, 5, '=AREAS(Data!A1)')
    wb.setCell('s1', 2, 5, '=AREAS(1+2)')
    wb.setCell('s1', 3, 5, '=AREAS((A1:B2,C1:D2,Data!A1))')
    wb.defineName('DATA_REF', { kind: 'range', sheetName: 'Data', start: 'A1', end: 'A1' })
    wb.setCell('s1', 4, 5, '=AREAS(DATA_REF)')
    wb.setCell('s1', 5, 5, '=AREAS(OFFSET(A1,0,0,1,1))')
    wb.setCell('s1', 6, 5, '=AREAS(CHOOSE(2,A1,B1))')
    wb.setCell('s1', 7, 5, '=AREAS((A1:B2,Missing!A1))')

    expect(read(wb, 's1', 0, 5)).toEqual(num(1))
    expect(read(wb, 's1', 1, 5)).toEqual(num(1))
    expect(read(wb, 's1', 2, 5)).toEqual({ kind: 'error', code: '#VALUE!' })
    expect(read(wb, 's1', 3, 5)).toEqual(num(3))
    expect(read(wb, 's1', 4, 5)).toEqual(num(1))
    expect(read(wb, 's1', 5, 5)).toEqual(num(1))
    expect(read(wb, 's1', 6, 5)).toEqual(num(1))
    expect(read(wb, 's1', 7, 5)).toEqual({ kind: 'error', code: '#REF!' })
  })

  test('multi-area references can be consumed by aggregate functions', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 'data', name: 'Data' },
    ])
    wb.setCell('s1', 0, 0, '1')
    wb.setCell('s1', 1, 0, '2')
    wb.setCell('s1', 0, 2, '3')
    wb.setCell('s1', 1, 2, '4')
    wb.setCell('data', 0, 0, '10')

    wb.setCell('s1', 4, 0, '=SUM((A1:A2,C1:C2,Data!A1))')
    wb.setCell('s1', 4, 1, '=COUNT((A1:A2,C1:C2,Data!A1))')
    wb.setCell('s1', 4, 2, '=MAX((A1:A2,C1:C2,Data!A1))')

    expect(read(wb, 's1', 4, 0)).toEqual(num(20))
    expect(read(wb, 's1', 4, 1)).toEqual(num(5))
    expect(read(wb, 's1', 4, 2)).toEqual(num(10))
  })

  test('SHEET on a multi-area reference returns the first area sheet number', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 'data', name: 'Data' },
    ])
    wb.setCell('s1', 0, 0, '=SHEET((A1:B2,C1:D2))')
    wb.setCell('s1', 1, 0, '=SHEET((Data!A1:B2,A1:B2))')
    wb.setCell('s1', 2, 0, '=SHEET((A1:B2,Missing!A1:B2))')

    expect(read(wb, 's1', 0, 0)).toEqual(num(1))
    expect(read(wb, 's1', 1, 0)).toEqual(num(2))
    expect(read(wb, 's1', 2, 0)).toEqual({ kind: 'error', code: '#REF!' })
  })

  test('INDIRECT supports whole-column and whole-row text references', () => {
    const wb = createWorkbook([
      { id: 's1', name: 'Sheet1' },
      { id: 'data', name: 'Data' },
      { id: 'space', name: 'Data Sheet' },
      { id: 'quote', name: "O'Brien" },
    ])
    wb.setCell('s1', 0, 0, '5')
    wb.setCell('s1', 1, 0, '7')
    wb.setCell('s1', 0, 1, '3')
    wb.setCell('s1', 0, 2, '11')
    wb.setCell('data', 0, 0, '100')
    wb.setCell('data', 1, 0, '23')
    wb.setCell('space', 0, 0, '41')
    wb.setCell('quote', 0, 0, '17')

    wb.setCell('s1', 5, 5, '=SUM(INDIRECT("A:A"))')
    wb.setCell('s1', 6, 5, '=SUM(INDIRECT("1:1"))')
    wb.setCell('s1', 7, 5, '=SUM(INDIRECT("Sheet1!A:A"))')
    wb.setCell('s1', 8, 5, '=SUM(INDIRECT("Data!A:A"))')
    wb.setCell('s1', 9, 5, '=SUM(INDIRECT("$A:$A"))')
    wb.setCell('s1', 10, 5, '=SUM(INDIRECT("$1:$1"))')
    wb.setCell('s1', 11, 5, '=SUM(INDIRECT("\'Data Sheet\'!A:A"))')
    wb.setCell('s1', 12, 5, '=INDIRECT("\'O\'\'Brien\'!A1")')
    wb.setCell('s1', 13, 5, '=SUM($1:$1)')

    expect(read(wb, 's1', 5, 5)).toEqual(num(12))
    expect(read(wb, 's1', 6, 5)).toEqual(num(19))
    expect(read(wb, 's1', 7, 5)).toEqual(num(12))
    expect(read(wb, 's1', 8, 5)).toEqual(num(123))
    expect(read(wb, 's1', 9, 5)).toEqual(num(12))
    expect(read(wb, 's1', 10, 5)).toEqual(num(19))
    expect(read(wb, 's1', 11, 5)).toEqual(num(41))
    expect(read(wb, 's1', 12, 5)).toEqual(num(17))
    expect(read(wb, 's1', 13, 5)).toEqual(num(19))
  })

  test('CELL info_types color/filename/format/parentheses return degraded defaults', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '1')

    wb.setCell('s1', 2, 0, '=CELL("color",A1)')
    wb.setCell('s1', 3, 0, '=CELL("filename",A1)')
    wb.setCell('s1', 4, 0, '=CELL("format",A1)')
    wb.setCell('s1', 5, 0, '=CELL("parentheses",A1)')

    expect(read(wb, 's1', 2, 0)).toEqual(num(0))
    expect(read(wb, 's1', 3, 0)).toEqual(str(''))
    expect(read(wb, 's1', 4, 0)).toEqual(str('G'))
    expect(read(wb, 's1', 5, 0)).toEqual(num(0))
  })

  // Fermat P2 — when `index_num` is an array, CHOOSE broadcasts: each cell of
  // the index array picks from the corresponding `args[i]` (1-indexed). With
  // refs, each picked source contributes its cell at the same (r,c) in the
  // result. `{1;2}` is a 2-row column vector → result is `{A1; B2}` (top of
  // arg-1, bottom of arg-2). Out-of-range indices surface `#VALUE!` per cell.
  test('CHOOSE with column-vector index broadcasts per-element pick on refs', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '1')
    wb.setCell('s1', 1, 0, '2')
    wb.setCell('s1', 0, 1, '10')
    wb.setCell('s1', 1, 1, '20')

    wb.setCell('s1', 0, 5, '=CHOOSE({1;2}, A1:A2, B1:B2)')

    expect(read(wb, 's1', 0, 5)).toEqual(arr([[num(1)], [num(20)]]))
  })

  test('CHOOSE with row-vector index over scalar args returns an array', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 5, '=CHOOSE({1,2,3}, "a", "b", "c")')

    expect(read(wb, 's1', 0, 5)).toEqual(arr([[str('a'), str('b'), str('c')]]))
  })

  // Fermat P2 — `INDEX(...):INDEX(...)` builds a dynamic range from the two
  // INDEX results. The parser threads the colon through `dynamicRange` and the
  // evaluator materializes both endpoints to runtime refs.
  test('INDEX:INDEX dynamic-range endpoints form a runtime range', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    for (let i = 0; i < 10; i += 1) wb.setCell('s1', i, 0, String(i + 1))

    wb.setCell('s1', 0, 5, '=SUM(INDEX(A1:A10,3):INDEX(A1:A10,8))')
    wb.setCell('s1', 1, 5, '=COUNT(INDEX(A1:A5,1):INDEX(A1:A5,3))')

    expect(read(wb, 's1', 0, 5)).toEqual(num(33))
    expect(read(wb, 's1', 1, 5)).toEqual(num(3))
  })
})
