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

  describe('structural edits retarget formula refs', () => {
    it('insert_row shifts refs at or below the insertion point', () => {
      const sheet = createJSSheet()
      sheet.set_number('A5', 10)
      sheet.set_formula('B1', '=A5*2')
      expect(sheet.get_number('B1')).toBe(20)

      sheet.insert_row?.(2, 1)
      // A5 → A6; formula source should now read A6.
      expect(sheet.get_formula('B1')).toBe('=A6*2')
      // And the value still resolves correctly.
      expect(sheet.get_number('B1')).toBe(20)
    })

    it('delete_row turns refs into the deleted band into #REF!', () => {
      const sheet = createJSSheet()
      sheet.set_number('A5', 10)
      sheet.set_formula('B1', '=A5*2')
      sheet.delete_row?.(4, 1) // delete row 5 (0-based row 4)
      const f = sheet.get_formula('B1')
      expect(f).toContain('#REF!')
    })

    it('insert_col shifts refs at or after the insertion column', () => {
      const sheet = createJSSheet()
      sheet.set_number('C1', 7)
      sheet.set_formula('A1', '=C1+1')
      sheet.insert_col?.(1, 1) // insert before col B (index 1) → C → D
      expect(sheet.get_formula('A1')).toBe('=D1+1')
    })

    it('delete_col turns refs in the deleted band into #REF!', () => {
      const sheet = createJSSheet()
      sheet.set_number('C1', 7)
      sheet.set_formula('A1', '=C1+1')
      sheet.delete_col?.(2, 1) // delete col C
      expect(sheet.get_formula('A1')).toContain('#REF!')
    })

    it('does not shift refs inside string literals', () => {
      const sheet = createJSSheet()
      sheet.set_number('A5', 10)
      sheet.set_formula('B1', '=A5+"B5"')
      sheet.insert_row?.(2, 1)
      expect(sheet.get_formula('B1')).toBe('=A6+"B5"')
    })

    it('relocates multi-letter columns correctly', () => {
      const sheet = createJSSheet()
      sheet.set_number('AA1', 7)
      sheet.insert_col?.(0, 1)
      expect(sheet.get_display('AB1')).toBe('7')
      expect(sheet.get_type('AA1')).toBe('null')
    })
  })
})
