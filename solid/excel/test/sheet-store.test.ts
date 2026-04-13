/** @jsxImportSource solid-js */

import { describe, it, expect } from '@jest/globals'
import { createRoot } from 'solid-js'
import { createSheetStore } from '../src/sheet-store'
import { createJSSheet } from '../src/js-sheet'
import type { ISheet } from '../src/types'

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

  it('clearCell clears values back to null', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      store.setText('B2', 'hello')
      store.clearCell('B2')
      const cell = store.getCell('B2')
      expect(cell.type).toBe('null')
      expect(cell.display).toBe('')
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

    it('empty input clears the cell', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setText('A1', 'hello')
        store.setCellInput('A1', '')
        expect(store.getCell('A1').type).toBe('null')
        expect(store.getCell('A1').display).toBe('')
        dispose()
      })
    })

    it('whitespace-only input clears the cell', () => {
      createRoot((dispose) => {
        const store = createTestStore()
        store.setText('A1', 'hello')
        store.setCellInput('A1', '   ')
        expect(store.getCell('A1').type).toBe('null')
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

  it('raw property exposes underlying sheet', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      expect(store.raw).toBeDefined()
      expect(typeof store.raw.set_number).toBe('function')
      dispose()
    })
  })

  it('batchSetInputs applies mixed inputs in one call', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      store.batchSetInputs([
        { addr: 'A1', input: '42' },
        { addr: 'B1', input: 'hello' },
        { addr: 'C1', input: '=A1*2' },
        { addr: 'D1', input: '' },
      ])

      expect(store.getCell('A1').display).toBe('42')
      expect(store.getCell('B1').display).toBe('hello')
      expect(store.getCell('C1').display).toBe('84')
      expect(store.getCell('D1').type).toBe('null')
      dispose()
    })
  })

  it('getInputSnapshot returns the raw input for each requested cell', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      store.setNumber('A1', 42)
      store.setFormula('B1', '=A1*2')

      expect(store.getInputSnapshot(['A1', 'B1', 'C1'])).toEqual([
        { addr: 'A1', input: '42' },
        { addr: 'B1', input: '=A1*2' },
        { addr: 'C1', input: '' },
      ])
      dispose()
    })
  })

  it('batchSetInputs does not refresh tracked cells when the sheet rejects the batch', () => {
    createRoot((dispose) => {
      const cells = new Map<string, {
        display: string
        input: string
        type: string
        isError: boolean
        number: number
      }>([
        ['A1', {
          display: '1',
          input: '1',
          type: 'number',
          isError: false,
          number: 1,
        }],
      ])

      const sheet: ISheet = {
        set_number(addr, value) {
          cells.set(addr, {
            display: String(value),
            input: String(value),
            type: 'number',
            isError: false,
            number: value,
          })
        },
        set_text(addr, value) {
          cells.set(addr, {
            display: value,
            input: value,
            type: 'text',
            isError: false,
            number: Number.NaN,
          })
        },
        set_formula(addr, formula) {
          cells.set(addr, {
            display: '#VALUE!',
            input: formula,
            type: 'error',
            isError: true,
            number: Number.NaN,
          })
        },
        clear_cell(addr) {
          cells.set(addr, {
            display: '',
            input: '',
            type: 'null',
            isError: false,
            number: Number.NaN,
          })
        },
        batch_set_inputs(addrs, inputs) {
          for (let index = 0; index < addrs.length; index += 1) {
            cells.set(addrs[index], {
              display: inputs[index],
              input: inputs[index],
              type: 'text',
              isError: false,
              number: Number.NaN,
            })
          }
          return false
        },
        get_display(addr) {
          return cells.get(addr)?.display ?? ''
        },
        get_input(addr) {
          return cells.get(addr)?.input ?? ''
        },
        get_number(addr) {
          return cells.get(addr)?.number ?? Number.NaN
        },
        get_type(addr) {
          return cells.get(addr)?.type ?? 'null'
        },
        is_error(addr) {
          return cells.get(addr)?.isError ?? false
        },
      }

      const store = createSheetStore(sheet)
      expect(store.getCell('A1').display).toBe('1')

      const ok = store.batchSetInputs([{ addr: 'A1', input: '2' }])
      expect(ok).toBe(false)
      expect(sheet.get_display('A1')).toBe('2')
      expect(store.getCell('A1').display).toBe('1')
      dispose()
    })
  })

  it('getInput preserves the original formula text', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      store.setNumber('A1', 10)
      store.setFormula('B1', '=A1*3')

      expect(store.getCell('B1').display).toBe('30')
      expect(store.getInput('B1')).toBe('=A1*3')
      dispose()
    })
  })

  it('invalid formulas become error cells while preserving input', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      store.setFormula('A1', '=SUM(')

      expect(store.getCell('A1').isError).toBe(true)
      expect(store.getCell('A1').display).toBe('#VALUE!')
      expect(store.getInput('A1')).toBe('=SUM(')
      dispose()
    })
  })

  it('phase two formulas flow through the store', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      store.setNumber('A1', 6)
      store.setNumber('A2', 12)
      store.setFormula('B1', '=IF(A2>10,"大","小")')
      store.setFormula('B2', '=SUMIF(A1:A2,">10")')

      expect(store.getCell('B1').type).toBe('text')
      expect(store.getCell('B1').display).toBe('大')
      expect(store.getCell('B2').display).toBe('12')
      dispose()
    })
  })
})
