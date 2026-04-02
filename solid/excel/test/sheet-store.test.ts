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

  it('raw property exposes underlying sheet', () => {
    createRoot((dispose) => {
      const store = createTestStore()
      expect(store.raw).toBeDefined()
      expect(typeof store.raw.set_number).toBe('function')
      dispose()
    })
  })
})
