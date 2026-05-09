/** @jsxImportSource solid-js */

import { describe, it, expect } from '@jest/globals'
import { createRoot } from 'solid-js'
import { createSheetStore } from '../src/sheet-store'
import { createJSSheet } from '../src/js-sheet'

function createTestStore() {
  const sheet = createJSSheet()
  return createSheetStore(sheet)
}

describe('createSheetStore', () => {
  it('getCell returns null for unset cell', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      const cell = store.getCell('A1')
      expect(cell.type).toBe('null')
      expect(cell.display).toBe('')
      expect(cell.isError).toBe(false)
      dispose()
    })
  })

  it('setNumber updates cell', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      store.setNumber('A1', 42)
      const cell = store.getCell('A1')
      expect(cell.type).toBe('number')
      expect(cell.display).toBe('42')
      dispose()
    })
  })

  it('setText updates cell', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      store.setText('B2', 'hello')
      const cell = store.getCell('B2')
      expect(cell.type).toBe('text')
      expect(cell.display).toBe('hello')
      dispose()
    })
  })

  it('setFormula computes value', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      store.setNumber('A1', 10)
      store.setNumber('B1', 20)
      store.setFormula('C1', '=A1+B1')
      const cell = store.getCell('C1')
      expect(cell.display).toBe('30')
      dispose()
    })
  })

  it('setFormula auto-updates on dependency change', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      store.setNumber('A1', 5)
      store.setFormula('B1', '=A1*2')
      expect(store.getCell('B1').display).toBe('10')

      store.setNumber('A1', 100)
      expect(store.getCell('B1').display).toBe('200')
      dispose()
    })
  })

  describe('setCellInput', () => {
    it('detects number input', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setCellInput('A1', '42')
        const cell = store.getCell('A1')
        expect(cell.type).toBe('number')
        expect(cell.display).toBe('42')
        dispose()
      })
    })

    it('detects float input', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setCellInput('A1', '3.14')
        expect(store.getCell('A1').type).toBe('number')
        expect(store.getCell('A1').display).toBe('3.14')
        dispose()
      })
    })

    it('detects text input', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setCellInput('A1', 'hello world')
        expect(store.getCell('A1').type).toBe('text')
        expect(store.getCell('A1').display).toBe('hello world')
        dispose()
      })
    })

    it('detects formula input', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 10)
        store.setCellInput('B1', '=A1*3')
        expect(store.getCell('B1').display).toBe('30')
        dispose()
      })
    })

    it('empty input sets text', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setCellInput('A1', '')
        expect(store.getCell('A1').type).toBe('text')
        expect(store.getCell('A1').display).toBe('')
        dispose()
      })
    })

    it('whitespace-only input sets text', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setCellInput('A1', '   ')
        expect(store.getCell('A1').type).toBe('text')
        dispose()
      })
    })

    it('negative number input', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setCellInput('A1', '-5')
        expect(store.getCell('A1').type).toBe('number')
        expect(store.getCell('A1').display).toBe('-5')
        dispose()
      })
    })
  })

  describe('undo / redo', () => {
    it('single setNumber is undoable', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 42)
        expect(store.getCell('A1').display).toBe('42')
        expect(store.canUndo()).toBe(true)
        store.undo()
        expect(store.getCell('A1').type).toBe('null')
        expect(store.canRedo()).toBe(true)
        store.redo()
        expect(store.getCell('A1').display).toBe('42')
        dispose()
      })
    })

    it('undo preserves float precision (no stringify-parse roundtrip)', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        // A value whose decimal expansion round-trips exactly through
        // Number↔String, but where future precision-sensitive callers
        // would notice if we ever stored snap as display string.
        const tricky = 0.1 + 0.2 // 0.30000000000000004
        store.setNumber('A1', tricky)
        store.setNumber('A1', 1)
        store.undo()
        // raw IEEE-754 bits should be identical, not just toString-equal.
        const got = (store.raw as unknown as { get_number: (a: string) => number }).get_number('A1')
        expect(got).toBe(tricky)
        dispose()
      })
    })

    it('undo restores formula source', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 10)
        store.setFormula('B1', '=A1*2')
        expect(store.getFormula('B1')).toBe('=A1*2')
        // Replace with a static value, then undo.
        store.setNumber('B1', 99)
        store.undo()
        expect(store.getFormula('B1')).toBe('=A1*2')
        dispose()
      })
    })

    it('undo preserves primitive error cells', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.raw.set_error?.('A1', '#REF!')
        store.setNumber('A1', 1)
        store.undo()
        expect(store.getCell('A1').type).toBe('error')
        expect(store.getCell('A1').display).toBe('#REF!')
        dispose()
      })
    })

    it('undo preserves primitive boolean cells', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.raw.set_boolean?.('A1', true)
        store.setText('A1', 'x')
        store.undo()
        expect(store.getCell('A1').type).toBe('boolean')
        expect(store.getCell('A1').display).toBe('TRUE')
        dispose()
      })
    })

    it('beginEdit / endEdit groups operations', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.beginEdit()
        store.setNumber('A1', 1)
        store.setNumber('B1', 2)
        store.setNumber('C1', 3)
        store.endEdit()
        // One undo should clear all three.
        store.undo()
        expect(store.getCell('A1').type).toBe('null')
        expect(store.getCell('B1').type).toBe('null')
        expect(store.getCell('C1').type).toBe('null')
        dispose()
      })
    })

    it('new edit clears redo stack', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 1)
        store.undo()
        expect(store.canRedo()).toBe(true)
        store.setNumber('A1', 99)
        expect(store.canRedo()).toBe(false)
        dispose()
      })
    })
  })

  describe('clipboard copy / paste', () => {
    it('round-trips a 2x2 block', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 1)
        store.setNumber('B1', 2)
        store.setNumber('A2', 3)
        store.setNumber('B2', 4)
        const data = store.copy([
          ['A1', 'B1'],
          ['A2', 'B2'],
        ])
        expect(data.cells).toEqual([
          ['1', '2'],
          ['3', '4'],
        ])
        // Paste at D5 — D5=1, E5=2, D6=3, E6=4.
        store.paste('D5', data)
        expect(store.getCell('D5').display).toBe('1')
        expect(store.getCell('E5').display).toBe('2')
        expect(store.getCell('D6').display).toBe('3')
        expect(store.getCell('E6').display).toBe('4')
        dispose()
      })
    })

    it('paste captures formula source, not the result', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 10)
        store.setFormula('B1', '=A1*2')
        const data = store.copy([['B1']])
        expect(data.cells[0][0]).toBe('=A1*2')
        // Paste at the same location — no shift, formula identical.
        store.paste('B1', data)
        expect(store.getFormula('B1')).toBe('=A1*2')
        dispose()
      })
    })

    it('paste shifts relative cell refs by (paste - copy origin)', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 10)
        store.setFormula('B1', '=A1*2')
        const data = store.copy([['B1']])
        // B1 → D5 = +2 cols, +4 rows. A1 ref shifts to C5.
        store.paste('D5', data)
        expect(store.getFormula('D5')).toBe('=C5*2')
        dispose()
      })
    })

    it('paste shifts cross-sheet refs but keeps sheet name', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setFormula('B2', '=Data!A1+1')
        const data = store.copy([['B2']])
        // B2 → C3 = +1 col, +1 row. Data!A1 → Data!B2.
        store.paste('C3', data)
        expect(store.getFormula('C3')).toBe('=Data!B2+1')
        dispose()
      })
    })

    it('paste leaves non-formula values unshifted', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 42)
        const data = store.copy([['A1']])
        store.paste('D5', data)
        expect(store.getCell('D5').display).toBe('42')
        dispose()
      })
    })

    it('clearCell empties + is undoable', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 42)
        store.clearCell('A1')
        expect(store.getCell('A1').type).toBe('null')
        store.undo()
        expect(store.getCell('A1').display).toBe('42')
        dispose()
      })
    })

    it('paste is one undo step', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 1)
        store.setNumber('B1', 2)
        const data = store.copy([['A1', 'B1']])
        store.paste('D1', data)
        expect(store.getCell('D1').display).toBe('1')
        store.undo()
        expect(store.getCell('D1').type).toBe('null')
        expect(store.getCell('E1').type).toBe('null')
        dispose()
      })
    })
  })

  it('raw property exposes underlying sheet', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      expect(store.raw).toBeDefined()
      expect(typeof store.raw.set_number).toBe('function')
      dispose()
    })
  })

  describe('selection', () => {
    it('starts at A1', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        expect(store.selection()).toEqual({ row: 0, col: 0 })
        expect(store.selectionAddr()).toBe('A1')
        dispose()
      })
    })

    it('updates and exposes the address form', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setSelection({ row: 4, col: 2 })
        expect(store.selectionAddr()).toBe('C5')
        dispose()
      })
    })
  })
})
