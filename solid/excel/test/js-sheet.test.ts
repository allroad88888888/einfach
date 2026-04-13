import { describe, it, expect } from '@jest/globals'
import { createJSSheet } from '../src/js-sheet'

describe('createJSSheet', () => {
  it('new cell returns null type', () => {
    const sheet = createJSSheet()
    expect(sheet.get_type('A1')).toBe('null')
    expect(sheet.get_display('A1')).toBe('')
  })

  it('set and get number', () => {
    const sheet = createJSSheet()
    sheet.set_number('A1', 42)
    expect(sheet.get_type('A1')).toBe('number')
    expect(sheet.get_number('A1')).toBe(42)
    expect(sheet.get_display('A1')).toBe('42')
  })

  it('set and get text', () => {
    const sheet = createJSSheet()
    sheet.set_text('B2', 'hello')
    expect(sheet.get_type('B2')).toBe('text')
    expect(sheet.get_display('B2')).toBe('hello')
    expect(sheet.get_number('B2')).toBeNaN()
  })

  it('set and get float display', () => {
    const sheet = createJSSheet()
    sheet.set_number('A1', 3.14)
    expect(sheet.get_display('A1')).toBe('3.14')
  })

  it('overwrite cell value', () => {
    const sheet = createJSSheet()
    sheet.set_number('A1', 1)
    sheet.set_number('A1', 99)
    expect(sheet.get_number('A1')).toBe(99)
  })

  it('clear_cell removes cell content', () => {
    const sheet = createJSSheet()
    sheet.set_text('A1', 'hello')
    sheet.clear_cell('A1')
    expect(sheet.get_type('A1')).toBe('null')
    expect(sheet.get_display('A1')).toBe('')
  })

  it('multiple cells are independent', () => {
    const sheet = createJSSheet()
    sheet.set_number('A1', 10)
    sheet.set_number('B1', 20)
    sheet.set_text('C1', 'hi')
    expect(sheet.get_number('A1')).toBe(10)
    expect(sheet.get_number('B1')).toBe(20)
    expect(sheet.get_display('C1')).toBe('hi')
  })

  describe('formulas', () => {
    it('simple addition', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 10)
      sheet.set_number('B1', 20)
      sheet.set_formula('C1', '=A1+B1')
      expect(sheet.get_number('C1')).toBe(30)
      expect(sheet.get_display('C1')).toBe('30')
    })

    it('formula auto-recalculates', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 5)
      sheet.set_formula('B1', '=A1*2')
      expect(sheet.get_number('B1')).toBe(10)

      sheet.set_number('A1', 100)
      expect(sheet.get_number('B1')).toBe(200)
    })

    it('formula with subtraction', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 100)
      sheet.set_number('A2', 30)
      sheet.set_formula('A3', '=A1-A2')
      expect(sheet.get_number('A3')).toBe(70)
    })

    it('formula with multiplication and division', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 12)
      sheet.set_number('B1', 4)
      sheet.set_formula('C1', '=A1/B1')
      expect(sheet.get_number('C1')).toBe(3)
    })

    it('division by zero returns error', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 10)
      sheet.set_number('B1', 0)
      sheet.set_formula('C1', '=A1/B1')
      expect(sheet.is_error('C1')).toBe(true)
      expect(sheet.get_display('C1')).toBe('#DIV/0!')
    })

    it('SUM range', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 1)
      sheet.set_number('A2', 2)
      sheet.set_number('A3', 3)
      sheet.set_formula('A4', '=SUM(A1:A3)')
      expect(sheet.get_number('A4')).toBe(6)
    })

    it('SUM range recalculates on change', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 1)
      sheet.set_number('A2', 2)
      sheet.set_formula('A3', '=SUM(A1:A2)')
      expect(sheet.get_number('A3')).toBe(3)

      sheet.set_number('A1', 10)
      expect(sheet.get_number('A3')).toBe(12)
    })

    it('unset cell defaults to 0 in formula', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 5)
      sheet.set_formula('C1', '=A1+B1')
      expect(sheet.get_number('C1')).toBe(5)
    })

    it('clearing formula by setting value', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 10)
      sheet.set_formula('B1', '=A1*2')
      expect(sheet.get_number('B1')).toBe(20)

      sheet.set_number('B1', 99)
      expect(sheet.get_number('B1')).toBe(99)

      // Changing A1 should no longer affect B1
      sheet.set_number('A1', 1)
      expect(sheet.get_number('B1')).toBe(99)
    })

    it('supports multi-argument spreadsheet functions', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 85)
      sheet.set_number('A2', 92)
      sheet.set_number('A3', 78)
      sheet.set_number('A4', 95)
      sheet.set_number('A5', 60)

      sheet.set_formula('B1', '=SUM(A1,A2,A3,A4,A5)')
      sheet.set_formula('B2', '=AVERAGE(A1,A2,A3,A4,A5)')
      sheet.set_formula('B3', '=COUNT(A1,A2,A3,A4,A5)')
      sheet.set_formula('B4', '=MIN(A1,A2,A3,A4,A5)')
      sheet.set_formula('B5', '=MAX(A1,A2,A3,A4,A5)')

      expect(sheet.get_number('B1')).toBe(410)
      expect(sheet.get_number('B2')).toBe(82)
      expect(sheet.get_number('B3')).toBe(5)
      expect(sheet.get_number('B4')).toBe(60)
      expect(sheet.get_number('B5')).toBe(95)
    })

    it('supports IF formulas and formula chains', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 5)
      sheet.set_formula('B1', '=IF(A1,1,0)')
      sheet.set_formula('C1', '=B1+10')
      sheet.set_formula('D1', '=C1*2')

      expect(sheet.get_number('B1')).toBe(1)
      expect(sheet.get_number('C1')).toBe(11)
      expect(sheet.get_number('D1')).toBe(22)

      sheet.set_number('A1', 0)
      expect(sheet.get_number('B1')).toBe(0)
      expect(sheet.get_number('C1')).toBe(10)
      expect(sheet.get_number('D1')).toBe(20)
    })

    it('supports multi-letter columns', () => {
      const sheet = createJSSheet()
      sheet.set_number('AA1', 10)
      sheet.set_number('AB1', 15)
      sheet.set_formula('AC1', '=AA1+AB1')
      expect(sheet.get_number('AC1')).toBe(25)
    })

    it('preserves raw formula input for editing', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 10)
      sheet.set_formula('B1', '=A1*3')

      expect(sheet.get_display('B1')).toBe('30')
      expect(sheet.get_input('B1')).toBe('=A1*3')

      sheet.set_number('B1', 99)
      expect(sheet.get_input('B1')).toBe('99')
    })

    it('returns a controlled error for invalid formulas', () => {
      const sheet = createJSSheet()
      sheet.set_formula('A1', '=SUM(')

      expect(sheet.is_error('A1')).toBe(true)
      expect(sheet.get_display('A1')).toBe('#VALUE!')
      expect(sheet.get_input('A1')).toBe('=SUM(')
    })

    it('supports comparison operators and boolean results', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 10)
      sheet.set_number('B1', 20)

      sheet.set_formula('C1', '=A1<B1')
      sheet.set_formula('D1', '=A1>=10')

      expect(sheet.get_display('C1')).toBe('TRUE')
      expect(sheet.get_display('D1')).toBe('TRUE')
      expect(sheet.get_type('C1')).toBe('boolean')
    })

    it('supports power and concatenation operators', () => {
      const sheet = createJSSheet()
      sheet.set_text('A1', 'Hello')
      sheet.set_formula('B1', '=A1&" World"')
      sheet.set_formula('C1', '=2^3^2')

      expect(sheet.get_display('B1')).toBe('Hello World')
      expect(sheet.get_display('C1')).toBe('512')
    })

    it('supports logical and math functions from phase two', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 12)
      sheet.set_number('A2', 3)

      sheet.set_formula('B1', '=AND(A1>10,A2<5)')
      sheet.set_formula('B2', '=OR(A1<10,A2=3)')
      sheet.set_formula('B3', '=NOT(A2=0)')
      sheet.set_formula('B4', '=ROUND(12.345,2)')
      sheet.set_formula('B5', '=MOD(A1,A2)')

      expect(sheet.get_display('B1')).toBe('TRUE')
      expect(sheet.get_display('B2')).toBe('TRUE')
      expect(sheet.get_display('B3')).toBe('TRUE')
      expect(sheet.get_display('B4')).toBe('12.35')
      expect(sheet.get_display('B5')).toBe('0')
    })

    it('supports text functions and conditional aggregates', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 2)
      sheet.set_number('A2', 8)
      sheet.set_number('A3', 12)
      sheet.set_text('B1', ' hello world ')

      sheet.set_formula('C1', '=COUNTIF(A1:A3,">5")')
      sheet.set_formula('C2', '=SUMIF(A1:A3,">5")')
      sheet.set_formula('C3', '=LEFT(TRIM(B1),5)')
      sheet.set_formula('C4', '=TEXT(1234.56,"#,##0.00")')

      expect(sheet.get_display('C1')).toBe('2')
      expect(sheet.get_display('C2')).toBe('20')
      expect(sheet.get_display('C3')).toBe('hello')
      expect(sheet.get_display('C4')).toBe('1,234.56')
    })

    it('batch_set_inputs supports mixed values and clearing', () => {
      const sheet = createJSSheet()
      const ok = sheet.batch_set_inputs(
        ['A1', 'B1', 'C1', 'D1'],
        ['42', 'hello', '=A1*2', ''],
      )

      expect(ok).toBe(true)
      expect(sheet.get_display('A1')).toBe('42')
      expect(sheet.get_display('B1')).toBe('hello')
      expect(sheet.get_display('C1')).toBe('84')
      expect(sheet.get_type('D1')).toBe('null')
    })

    it('evaluates shifted invalid references as #REF!', () => {
      const sheet = createJSSheet()
      sheet.set_formula('A1', '=#REF!+1')

      expect(sheet.is_error('A1')).toBe(true)
      expect(sheet.get_display('A1')).toBe('#REF!')
      expect(sheet.get_input('A1')).toBe('=#REF!+1')
    })
  })

  describe('is_error', () => {
    it('returns false for normal cells', () => {
      const sheet = createJSSheet()
      sheet.set_number('A1', 42)
      expect(sheet.is_error('A1')).toBe(false)
    })

    it('returns false for unset cells', () => {
      const sheet = createJSSheet()
      expect(sheet.is_error('Z99')).toBe(false)
    })
  })
})
