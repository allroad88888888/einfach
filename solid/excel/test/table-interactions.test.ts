import { afterEach, beforeEach, describe, expect, it } from '@jest/globals'
import { createRoot } from 'solid-js'
import { createJSSheet } from '../src/js-sheet'
import { createSheetStore } from '../src/sheet-store'
import { createTableInteractions } from '../src/table-interactions'

const clipboardState = {
  text: '',
}

Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: {
    async readText() {
      return clipboardState.text
    },
    async writeText(value: string) {
      clipboardState.text = value
    },
  },
})

type TestContext = {
  store: ReturnType<typeof createSheetStore>
  interactions: ReturnType<typeof createTableInteractions>
}

function withInteractions(
  run: (context: TestContext) => void | Promise<void>,
  options?: { rows?: number; cols?: number },
) {
  return new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const store = createSheetStore(createJSSheet())
      const interactions = createTableInteractions(store, options?.rows ?? 6, options?.cols ?? 6)

      Promise.resolve(run({ store, interactions }))
        .then(() => {
          dispose()
          resolve()
        })
        .catch((error) => {
          dispose()
          reject(error)
        })
    })
  })
}

describe('createTableInteractions', () => {
  beforeEach(() => {
    clipboardState.text = ''
  })

  afterEach(() => {
    clipboardState.text = ''
  })

  it('starts with A1 selected and can expand the current range', async () => {
    await withInteractions(({ interactions }) => {
      expect(interactions.selectedCell()).toBe('A1')
      expect(interactions.selectionRange()).toEqual({ anchor: 'A1', focus: 'A1' })

      interactions.select('B2')
      expect(interactions.selectionRange()).toEqual({ anchor: 'B2', focus: 'B2' })

      interactions.select('D4', true)
      expect(interactions.selectionRange()).toEqual({ anchor: 'B2', focus: 'D4' })
      expect(interactions.isSelected('D4')).toBe(true)
      expect(interactions.isInSelection('C3')).toBe(true)
      expect(interactions.selectionEdges('B2')).toEqual({
        top: true,
        right: false,
        bottom: false,
        left: true,
      })
      expect(interactions.selectionEdges('D4')).toEqual({
        top: false,
        right: true,
        bottom: true,
        left: false,
      })
    })
  })

  it('moves selection with clamping and shift expansion', async () => {
    await withInteractions(({ interactions }) => {
      interactions.moveSelection(1, 1)
      expect(interactions.selectedCell()).toBe('B2')

      interactions.moveSelection(10, 10)
      expect(interactions.selectedCell()).toBe('F6')

      interactions.moveSelection(-1, 0, true)
      expect(interactions.selectionRange()).toEqual({ anchor: 'F6', focus: 'F5' })
      expect(interactions.isInSelection('F6')).toBe(true)
      expect(interactions.isInSelection('F5')).toBe(true)
    })
  })

  it('commits edits and supports undo/redo', async () => {
    await withInteractions(({ store, interactions }) => {
      interactions.commitEdit('A1', '42')
      expect(store.getCell('A1').display).toBe('42')
      expect(interactions.editingCell()).toBeNull()

      interactions.undo()
      expect(store.getCell('A1').type).toBe('null')

      interactions.redo()
      expect(store.getCell('A1').display).toBe('42')
      expect(interactions.selectedCell()).toBe('A1')
    })
  })

  it('keeps redo history when a no-op edit is committed', async () => {
    await withInteractions(({ store, interactions }) => {
      store.setNumber('A1', 10)

      interactions.commitEdit('A1', '20')
      expect(store.getCell('A1').display).toBe('20')

      interactions.undo()
      expect(store.getCell('A1').display).toBe('10')

      interactions.commitEdit('A1', '10')
      interactions.redo()
      expect(store.getCell('A1').display).toBe('20')
    })
  })

  it('clears a rectangular selection and restores it through history', async () => {
    await withInteractions(({ store, interactions }) => {
      store.setText('A1', 'alpha')
      store.setText('B1', 'beta')
      store.setText('A2', 'gamma')
      store.setText('B2', 'delta')

      interactions.select('A1')
      interactions.select('B2', true)
      interactions.clearSelection()

      expect(store.getCell('A1').type).toBe('null')
      expect(store.getCell('B2').type).toBe('null')

      interactions.undo()
      expect(store.getCell('A1').display).toBe('alpha')
      expect(store.getCell('B2').display).toBe('delta')
    })
  })

  it('copies a range to clipboard text and pastes formulas with internal offset first', async () => {
    await withInteractions(async ({ store, interactions }) => {
      store.setNumber('A1', 10)
      store.setFormula('B1', '=A1*2')

      interactions.select('A1')
      interactions.select('B1', true)
      await interactions.copySelection()

      expect(clipboardState.text).toBe('10\t=A1*2')

      interactions.select('C2')
      await interactions.pasteSelection()

      expect(store.getCell('C2').display).toBe('10')
      expect(store.getInput('D2')).toBe('=C2*2')
      expect(store.getCell('D2').display).toBe('20')
    })
  })

  it('locks the current second-paste behavior after internal clipboard paste degrades to text clipboard semantics', async () => {
    await withInteractions(async ({ store, interactions }) => {
      store.setNumber('A1', 10)
      store.setFormula('B1', '=A1*2')

      interactions.select('B1')
      await interactions.copySelection()

      interactions.select('C1')
      await interactions.pasteSelection()
      expect(store.getInput('C1')).toBe('=B1*2')

      interactions.select('D1')
      await interactions.pasteSelection()
      expect(store.getInput('D1')).toBe('=A1*2')
    })
  })

  it('cuts a selection and restores it with undo', async () => {
    await withInteractions(async ({ store, interactions }) => {
      store.setText('A1', 'alpha')
      store.setText('B1', 'beta')

      interactions.select('A1')
      interactions.select('B1', true)
      await interactions.cutSelection()

      expect(store.getCell('A1').type).toBe('null')
      expect(store.getCell('B1').type).toBe('null')
      expect(clipboardState.text).toBe('alpha\tbeta')

      interactions.undo()
      expect(store.getCell('A1').display).toBe('alpha')
      expect(store.getCell('B1').display).toBe('beta')
    })
  })

  it('pastes external TSV when there is no internal clipboard snapshot', async () => {
    await withInteractions(async ({ store, interactions }) => {
      clipboardState.text = '1\t2\n3\t4'

      interactions.select('B2')
      await interactions.pasteSelection()

      expect(store.getCell('B2').display).toBe('1')
      expect(store.getCell('C2').display).toBe('2')
      expect(store.getCell('B3').display).toBe('3')
      expect(store.getCell('C3').display).toBe('4')
    })
  })

  it('cancels editing without mutating the store', async () => {
    await withInteractions(({ store, interactions }) => {
      store.setText('A1', 'keep')
      interactions.setEditingCell('A1')
      interactions.cancelEdit()

      expect(interactions.editingCell()).toBeNull()
      expect(store.getCell('A1').display).toBe('keep')
    })
  })
})
