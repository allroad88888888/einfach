/** @jsxImportSource solid-js */

import { describe, it, expect } from '@jest/globals'
import { createRoot } from 'solid-js'
import {
  createSheetStore,
  parseClipboardTSV,
  serializeClipboardTSV,
} from '../src/sheet-store'
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

    it('clearCellRange keeps small ranges as one undoable edit', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 1)
        store.setNumber('B1', 2)
        store.clearCellRange({ row: 0, col: 0 }, { row: 0, col: 1 })

        expect(store.getCell('A1').type).toBe('null')
        expect(store.getCell('B1').type).toBe('null')

        store.undo()
        expect(store.getCell('A1').display).toBe('1')
        expect(store.getCell('B1').display).toBe('2')
        dispose()
      })
    })

    it('clearSelectionRange uses backend clear_range for large rectangles', () => {
      createRoot((dispose) => {
        const sheet = createJSSheet()
        let clearCellCount = 0
        let clearRangeArgs: number[] | undefined
        const clearCell = sheet.clear_cell.bind(sheet)
        sheet.clear_cell = (addr) => {
          clearCellCount += 1
          clearCell(addr)
        }
        sheet.clear_range = (startRow, startCol, endRow, endCol) => {
          clearRangeArgs = [startRow, startCol, endRow, endCol]
          return 0
        }
        const store = createSheetStore(sheet)
        store.setNumber('A1', 1)
        expect(store.canUndo()).toBe(true)
        store.setSelectionAnchor({ row: 0, col: 0 })
        store.extendSelection({ row: 999, col: 999 })

        store.clearSelectionRange()

        expect(clearRangeArgs).toEqual([0, 0, 999, 999])
        expect(clearCellCount).toBe(0)
        expect(store.canUndo()).toBe(false)
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

    // === Structural undo ===
    // See docs/STRUCTURAL_UNDO.md for the snapshot + inverse-op contract.
    it('insertRow is undoable — content shifts back', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 1)
        store.setNumber('A2', 2)
        store.setNumber('A3', 3)
        store.insertRow(1, 1)
        expect(store.getCell('A1').display).toBe('1')
        expect(store.getCell('A2').type).toBe('null')
        expect(store.getCell('A3').display).toBe('2')
        store.undo()
        expect(store.getCell('A1').display).toBe('1')
        expect(store.getCell('A2').display).toBe('2')
        expect(store.getCell('A3').display).toBe('3')
        dispose()
      })
    })

    it('deleteRow is undoable — deleted content comes back', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 1)
        store.setText('A2', 'deleted')
        store.setNumber('A3', 3)
        store.deleteRow(1, 1)
        expect(store.getCell('A2').display).toBe('3')
        store.undo()
        expect(store.getCell('A1').display).toBe('1')
        expect(store.getCell('A2').display).toBe('deleted')
        expect(store.getCell('A3').display).toBe('3')
        dispose()
      })
    })

    it('deleteRow with a formula in deleted band restores formula source', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 10)
        store.setNumber('A3', 5)
        store.setFormula('A2', '=A1+A3')
        expect(store.getCell('A2').display).toBe('15')
        store.deleteRow(1, 1)
        // After: A1=10, A2 now holds the old A3 value (5)
        expect(store.getCell('A2').display).toBe('5')
        store.undo()
        // Formula at A2 should be restored to its original source.
        expect(store.getFormula('A2')).toBe('=A1+A3')
        expect(store.getCell('A2').display).toBe('15')
        dispose()
      })
    })

    it('insertCol then redo round-trips', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 1)
        store.setNumber('B1', 2)
        store.insertCol(1, 1)
        expect(store.getCell('B1').type).toBe('null')
        expect(store.getCell('C1').display).toBe('2')
        store.undo()
        expect(store.getCell('B1').display).toBe('2')
        store.redo()
        expect(store.getCell('B1').type).toBe('null')
        expect(store.getCell('C1').display).toBe('2')
        dispose()
      })
    })

    it('deleteCol is undoable — deleted column content comes back', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 1)
        store.setNumber('B1', 2)
        store.setNumber('C1', 3)
        store.deleteCol(1, 1)
        expect(store.getCell('B1').display).toBe('3')
        store.undo()
        expect(store.getCell('A1').display).toBe('1')
        expect(store.getCell('B1').display).toBe('2')
        expect(store.getCell('C1').display).toBe('3')
        dispose()
      })
    })

    it('structural edit flushes an open beginEdit batch first', () => {
      // Both should be undoable independently: structural is its own frame.
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 1)
        store.beginEdit()
        store.setNumber('A1', 99)
        // No endEdit — structural should flush the pending batch.
        store.insertRow(0, 1)
        expect(store.getCell('A2').display).toBe('99')
        // First undo reverses the insertRow.
        store.undo()
        expect(store.getCell('A1').display).toBe('99')
        // Second undo reverses the value edit.
        store.undo()
        expect(store.getCell('A1').display).toBe('1')
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

  describe('selection range', () => {
    it('setSelection collapses to a single cell', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setSelection({ row: 2, col: 3 })
        const r = store.selectionRange()
        expect(r.anchor).toEqual({ row: 2, col: 3 })
        expect(r.focus).toEqual({ row: 2, col: 3 })
        expect(store.selectionAddrs()).toEqual([['D3']])
        dispose()
      })
    })

    it('extendSelection moves focus only (anchor stays put)', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setSelectionAnchor({ row: 1, col: 1 })
        store.extendSelection({ row: 3, col: 2 })
        const r = store.selectionRange()
        expect(r.anchor).toEqual({ row: 1, col: 1 })
        expect(r.focus).toEqual({ row: 3, col: 2 })
        // selection() / selectionAddr() track the focus end.
        expect(store.selectionAddr()).toBe('C4')
        dispose()
      })
    })

    it('selectionAddrs returns row-major grid for forward range', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        // Anchor at B2 (row 1, col 1), extend to D4 (row 3, col 3).
        store.setSelectionAnchor({ row: 1, col: 1 })
        store.extendSelection({ row: 3, col: 3 })
        expect(store.selectionAddrs()).toEqual([
          ['B2', 'C2', 'D2'],
          ['B3', 'C3', 'D3'],
          ['B4', 'C4', 'D4'],
        ])
        dispose()
      })
    })

    it('selectionAddrs normalizes backward range (focus < anchor)', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        // Anchor at D4, extend "backward" to B2.
        store.setSelectionAnchor({ row: 3, col: 3 })
        store.extendSelection({ row: 1, col: 1 })
        expect(store.selectionAddrs()).toEqual([
          ['B2', 'C2', 'D2'],
          ['B3', 'C3', 'D3'],
          ['B4', 'C4', 'D4'],
        ])
        // selection() still reflects focus, not the rectangle's top-left.
        expect(store.selectionAddr()).toBe('B2')
        dispose()
      })
    })

    it('setSelection after extendSelection collapses again', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setSelectionAnchor({ row: 0, col: 0 })
        store.extendSelection({ row: 2, col: 2 })
        // A click somewhere else collapses the range.
        store.setSelection({ row: 5, col: 5 })
        expect(store.selectionAddrs()).toEqual([['F6']])
        dispose()
      })
    })
  })

  describe('clipboard TSV serialization helpers', () => {
    it('serialize → parse round-trips a 2x3 grid with origin', () => {
      const serialized = serializeClipboardTSV({
        cells: [
          ['1', '2', '3'],
          ['hello', '=A1+1', ''],
        ],
        originAddr: 'C7',
      })
      // First line must be the marker so a same-app paste recovers origin.
      expect(serialized.startsWith('# einfach-clipboard-origin: C7\n')).toBe(true)
      // Body is plain TSV — pasteable into a real spreadsheet too.
      expect(serialized).toContain('1\t2\t3\nhello\t=A1+1\t')

      const parsed = parseClipboardTSV(serialized, 'A1')
      expect(parsed.originAddr).toBe('C7')
      expect(parsed.cells).toEqual([
        ['1', '2', '3'],
        ['hello', '=A1+1', ''],
      ])
    })

    it('parse without marker uses fallback origin', () => {
      // Foreign clipboard (real Excel, vim, etc.) — no marker line.
      const parsed = parseClipboardTSV('1\t2\n3\t4\n', 'D5')
      expect(parsed.originAddr).toBe('D5')
      expect(parsed.cells).toEqual([
        ['1', '2'],
        ['3', '4'],
      ])
    })

    it('parse normalizes CRLF line endings', () => {
      const parsed = parseClipboardTSV('1\t2\r\n3\t4', 'A1')
      expect(parsed.cells).toEqual([
        ['1', '2'],
        ['3', '4'],
      ])
    })

    it('parse strips a single trailing newline', () => {
      const parsed = parseClipboardTSV('1\t2\n', 'A1')
      // Without strip we'd get a phantom 3rd row [''] from the trailing \n.
      expect(parsed.cells).toEqual([['1', '2']])
    })

    it('parse falls back to origin when marker line is empty', () => {
      // Marker present but empty after the colon → fall back, not '' origin.
      const parsed = parseClipboardTSV('# einfach-clipboard-origin: \n1\t2', 'A1')
      expect(parsed.originAddr).toBe('A1')
      expect(parsed.cells).toEqual([['1', '2']])
    })
  })

  describe('copy + paste roundtrip via selectionAddrs', () => {
    it('copies a 2x3 range, paste at same origin restores values + formula', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        // Seed B2:D3 with a mix of numbers + a formula.
        store.setNumber('B2', 1)
        store.setNumber('C2', 2)
        store.setNumber('D2', 3)
        store.setNumber('B3', 10)
        store.setFormula('C3', '=B3+1')
        store.setText('D3', 'x')

        // Build the rectangular addr grid the way Table.tsx will.
        store.setSelectionAnchor({ row: 1, col: 1 })
        store.extendSelection({ row: 2, col: 3 })
        const addrs = store.selectionAddrs()
        expect(addrs).toEqual([
          ['B2', 'C2', 'D2'],
          ['B3', 'C3', 'D3'],
        ])

        const data = store.copy(addrs)
        expect(data.originAddr).toBe('B2')
        expect(data.cells).toEqual([
          ['1', '2', '3'],
          ['10', '=B3+1', 'x'],
        ])

        // Now wipe and re-paste at the same origin — formula stays
        // unchanged (no shift) and values come back.
        store.beginEdit()
        for (const row of addrs) for (const a of row) store.clearCell(a)
        store.endEdit()
        expect(store.getCell('B2').type).toBe('null')

        store.paste('B2', data)
        expect(store.getCell('B2').display).toBe('1')
        expect(store.getCell('D2').display).toBe('3')
        expect(store.getCell('B3').display).toBe('10')
        expect(store.getFormula('C3')).toBe('=B3+1')
        expect(store.getCell('D3').display).toBe('x')
        dispose()
      })
    })

    it('serialize → parse → paste roundtrips through the system-clipboard format', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setNumber('A1', 5)
        store.setNumber('B1', 6)
        store.setFormula('C1', '=A1+B1')
        const data = store.copy([['A1', 'B1', 'C1']])
        const text = serializeClipboardTSV(data)
        // Simulate a paste at D5: parser recovers A1 origin from marker.
        const parsed = parseClipboardTSV(text, 'D5')
        expect(parsed.originAddr).toBe('A1')
        store.paste('D5', parsed)
        expect(store.getCell('D5').display).toBe('5')
        expect(store.getCell('E5').display).toBe('6')
        // A1+B1 shifted by (D5 - A1) = (+3 col, +4 row) → D5+E5 = 11.
        expect(store.getFormula('F5')).toBe('=D5+E5')
        expect(store.getCell('F5').display).toBe('11')
        dispose()
      })
    })
  })
})
