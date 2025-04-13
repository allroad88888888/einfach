import { describe, expect, test } from '@jest/globals'
import { atom, createStore } from '@einfach/core'
import { createUndoRedo } from '../../src/utils/createUndoRedo'

describe('undo redo ', () => {
  test('easy', () => {
    const numberAtom = atom(0)
    const store = createStore()

    const { undoAtom, redoAtom, watchAtom } = createUndoRedo(store)
    watchAtom(numberAtom)
    expect(store.getter(undoAtom)).toBe(false)
    expect(store.getter(redoAtom)).toBe(false)
    store.setter(numberAtom, 1)
    store.setter(numberAtom, 2)
    store.setter(numberAtom, 3)
    expect(store.getter(undoAtom)).toBe(true)
    expect(store.getter(redoAtom)).toBe(false)
    store.setter(undoAtom)
    expect(store.getter(undoAtom)).toBe(true)
    expect(store.getter(redoAtom)).toBe(true)
    expect(store.getter(numberAtom)).toBe(2)
    store.setter(undoAtom)
    expect(store.getter(numberAtom)).toBe(1)
    store.setter(redoAtom)
    store.setter(redoAtom)
    expect(store.getter(numberAtom)).toBe(3)
    expect(store.getter(undoAtom)).toBe(true)
    expect(store.getter(redoAtom)).toBe(false)
  })

  test('double', () => {
    const numberAtom = atom(0)
    const stringAtom = atom('')
    const store = createStore()
    const { undoAtom, redoAtom, watchAtom, undo, redo } = createUndoRedo(store)
    watchAtom(numberAtom)
    watchAtom(stringAtom)

    store.setter(numberAtom, 1)
    store.setter(stringAtom, 'init')
    store.setter(numberAtom, 2)
    expect(store.getter(undoAtom)).toBe(true)
    expect(store.getter(redoAtom)).toBe(false)

    undo()
    expect(store.getter(numberAtom)).toBe(1)
    expect(store.getter(stringAtom)).toBe('init')
    undo()
    expect(store.getter(numberAtom)).toBe(1)
    expect(store.getter(stringAtom)).toBe('')
    redo()
    expect(store.getter(numberAtom)).toBe(1)
    expect(store.getter(stringAtom)).toBe('init')
  })

  test('transaction', () => {
    const numberAtom = atom(0)
    const stringAtom = atom('')
    const store = createStore()
    const { watchAtom, undo, redo, mergeState, redoAtom } = createUndoRedo(store)
    watchAtom(numberAtom)
    watchAtom(stringAtom)

    mergeState(() => {
      store.setter(numberAtom, 1)
      store.setter(stringAtom, 'init')
      store.setter(numberAtom, 2)
    })

    undo()
    expect(store.getter(numberAtom)).toBe(0)
    expect(store.getter(stringAtom)).toBe('')
    expect(store.getter(redoAtom)).toBe(true)
    redo()
    expect(store.getter(numberAtom)).toBe(2)
    expect(store.getter(stringAtom)).toBe('init')
  })

  test('transaction-error', () => {
    const numberAtom = atom(0)
    const stringAtom = atom('')
    const store = createStore()
    const { watchAtom, mergeState, redoAtom } = createUndoRedo(store)
    watchAtom(numberAtom)
    watchAtom(stringAtom)
    store.setter(numberAtom, 1)
    try {
      mergeState(() => {
        store.setter(numberAtom, 2)
        store.setter(stringAtom, 'init')
        throw 'error'
        store.setter(numberAtom, 3)
      })
    } catch (error) {
      if (error !== 'error') {
        throw error
      }
    }

    expect(store.getter(numberAtom)).toBe(1)
    expect(store.getter(stringAtom)).toBe('')
    expect(store.getter(redoAtom)).toBe(false)
  })
  test('transaction-error-null', () => {
    const numberAtom = atom(0)
    const stringAtom = atom('')
    const store = createStore()
    const { watchAtom, mergeState, redoAtom, undoAtom } = createUndoRedo(store)
    watchAtom(numberAtom)
    watchAtom(stringAtom)
    store.setter(numberAtom, 1)
    try {
      mergeState(() => {
        throw 'error'
      })
    } catch (error) {
      if (error !== 'error') {
        throw error
      }
    }

    expect(store.getter(numberAtom)).toBe(1)
    expect(store.getter(stringAtom)).toBe('')

    expect(store.getter(undoAtom)).toBe(true)
    expect(store.getter(redoAtom)).toBe(false)
  })

  test('transaction-null-todo', () => {
    const numberAtom = atom(0)
    const stringAtom = atom('')
    const store = createStore()
    const { watchAtom, mergeState, redoAtom, undoAtom } = createUndoRedo(store)
    watchAtom(numberAtom)
    watchAtom(stringAtom)
    mergeState(() => {})

    expect(store.getter(undoAtom)).toBe(false)
    expect(store.getter(redoAtom)).toBe(false)

    expect(store.getter(numberAtom)).toBe(0)
    expect(store.getter(stringAtom)).toBe('')
  })

  test('resetByNow', () => {
    const numberAtom = atom(0)
    const stringAtom = atom('')
    const store = createStore()
    const { watchAtom, redoAtom, undoAtom, resetByNow, undo } = createUndoRedo(store)
    watchAtom(numberAtom)
    watchAtom(stringAtom)

    store.setter(numberAtom, 1)
    store.setter(numberAtom, 2)
    store.setter(numberAtom, 3)
    store.setter(numberAtom, 4)
    store.setter(stringAtom, '1')
    expect(store.getter(undoAtom)).toBe(true)
    expect(store.getter(redoAtom)).toBe(false)

    resetByNow()
    expect(store.getter(numberAtom)).toBe(4)
    expect(store.getter(stringAtom)).toBe('1')

    expect(store.getter(undoAtom)).toBe(false)
    expect(store.getter(redoAtom)).toBe(false)

    store.setter(numberAtom, 5)
    store.setter(numberAtom, 6)
    store.setter(stringAtom, '3')
    expect(store.getter(numberAtom)).toBe(6)
    expect(store.getter(stringAtom)).toBe('3')
    undo()
    undo()
    undo()
    expect(store.getter(numberAtom)).toBe(4)

    expect(store.getter(undoAtom)).toBe(false)
    expect(store.getter(redoAtom)).toBe(true)
  })
})
