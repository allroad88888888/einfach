import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  DEFAULT_HISTORY_CAP,
  canRedoAtom,
  canUndoAtom,
  clearHistoryAtom,
  historyInFlightAtom,
  historyStackAtom,
  pushHistoryAtom,
  redoHistoryAtom,
  resolveHistoryAtom,
  undoHistoryAtom,
  type HistoryEntry,
} from '../src/history'

function makeEntry(id: string, rev = 0): HistoryEntry {
  return {
    transactionId: id,
    kind: 'cell.set-input',
    sheetId: 'sheet-1',
    projectionRevision: rev,
  }
}

describe('history stack', () => {
  test('push appends an entry and advances cursor', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    const state = store.getter(historyStackAtom)
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0].transactionId).toBe('tx-1')
    expect(state.cursor).toBe(1)
  })

  test('push past cap evicts oldest; length stays at cap', () => {
    const store = createStore()
    for (let i = 0; i < DEFAULT_HISTORY_CAP + 5; i += 1) {
      store.setter(pushHistoryAtom, makeEntry(`tx-${i}`, i))
    }
    const state = store.getter(historyStackAtom)
    expect(state.entries).toHaveLength(DEFAULT_HISTORY_CAP)
    expect(state.cursor).toBe(DEFAULT_HISTORY_CAP)
    // Oldest entries (tx-0 through tx-4) are gone
    expect(state.entries[0].transactionId).toBe('tx-5')
    expect(state.entries[DEFAULT_HISTORY_CAP - 1].transactionId).toBe(`tx-${DEFAULT_HISTORY_CAP + 4}`)
  })

  test('canUndo is false on empty stack', () => {
    const store = createStore()
    expect(store.getter(canUndoAtom)).toBe(false)
  })

  test('canUndo is true after one push', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1'))
    expect(store.getter(canUndoAtom)).toBe(true)
  })

  test('canRedo is false after push', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1'))
    expect(store.getter(canRedoAtom)).toBe(false)
  })

  test('canRedo is true after undo, false after redo', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1'))
    store.setter(undoHistoryAtom)
    store.setter(resolveHistoryAtom, { transactionId: 'tx-1', ok: true })
    expect(store.getter(canRedoAtom)).toBe(true)
    store.setter(redoHistoryAtom)
    store.setter(resolveHistoryAtom, { transactionId: 'tx-1', ok: true })
    expect(store.getter(canRedoAtom)).toBe(false)
  })

  test('push mid-stack truncates redo tail', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1'))
    store.setter(pushHistoryAtom, makeEntry('tx-2'))
    store.setter(undoHistoryAtom)
    store.setter(resolveHistoryAtom, { transactionId: 'tx-2', ok: true })
    // cursor is now at 1; push a new entry to truncate tx-2
    store.setter(pushHistoryAtom, makeEntry('tx-3'))
    const state = store.getter(historyStackAtom)
    expect(state.entries).toHaveLength(2)
    expect(state.entries[1].transactionId).toBe('tx-3')
    expect(store.getter(canRedoAtom)).toBe(false)
  })

  test('undoHistoryAtom returns null when canUndo is false', () => {
    const store = createStore()
    const result = store.setter(undoHistoryAtom)
    expect(result).toBeNull()
    expect(store.getter(historyStackAtom).cursor).toBe(0)
  })

  test('redoHistoryAtom returns null when canRedo is false', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1'))
    const result = store.setter(redoHistoryAtom)
    expect(result).toBeNull()
    expect(store.getter(historyStackAtom).cursor).toBe(1)
  })

  test('inFlight is set during undo and cleared by resolve', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1'))
    store.setter(undoHistoryAtom)
    expect(store.getter(historyInFlightAtom)).toBe(true)
    store.setter(resolveHistoryAtom, { transactionId: 'tx-1', ok: true })
    expect(store.getter(historyInFlightAtom)).toBe(false)
  })

  test('second undo while in-flight returns null', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1'))
    store.setter(pushHistoryAtom, makeEntry('tx-2'))
    store.setter(undoHistoryAtom)
    // still in-flight
    const result = store.setter(undoHistoryAtom)
    expect(result).toBeNull()
  })

  test('resolveHistoryAtom with ok: false clears the full stack', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1'))
    store.setter(undoHistoryAtom)
    store.setter(resolveHistoryAtom, { transactionId: 'tx-1', ok: false })
    const state = store.getter(historyStackAtom)
    expect(state.entries).toHaveLength(0)
    expect(state.cursor).toBe(0)
    expect(state.inFlight).toBe(false)
  })

  test('multiple sequential undos decrement cursor each time', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    store.setter(pushHistoryAtom, makeEntry('tx-2', 2))
    store.setter(pushHistoryAtom, makeEntry('tx-3', 3))

    store.setter(undoHistoryAtom)
    store.setter(resolveHistoryAtom, { transactionId: 'tx-3', ok: true })
    expect(store.getter(historyStackAtom).cursor).toBe(2)

    store.setter(undoHistoryAtom)
    store.setter(resolveHistoryAtom, { transactionId: 'tx-2', ok: true })
    expect(store.getter(historyStackAtom).cursor).toBe(1)
  })

  test('multiple sequential redos increment cursor each time', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1', 1))
    store.setter(pushHistoryAtom, makeEntry('tx-2', 2))

    store.setter(undoHistoryAtom)
    store.setter(resolveHistoryAtom, { transactionId: 'tx-2', ok: true })
    store.setter(undoHistoryAtom)
    store.setter(resolveHistoryAtom, { transactionId: 'tx-1', ok: true })
    expect(store.getter(historyStackAtom).cursor).toBe(0)

    store.setter(redoHistoryAtom)
    store.setter(resolveHistoryAtom, { transactionId: 'tx-1', ok: true })
    expect(store.getter(historyStackAtom).cursor).toBe(1)

    store.setter(redoHistoryAtom)
    store.setter(resolveHistoryAtom, { transactionId: 'tx-2', ok: true })
    expect(store.getter(historyStackAtom).cursor).toBe(2)
  })

  test('undo entry carries the correct transactionId and projectionRevision', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-42', 7))
    const entry = store.setter(undoHistoryAtom)
    expect(entry).not.toBeNull()
    expect(entry!.transactionId).toBe('tx-42')
    expect(entry!.projectionRevision).toBe(7)
  })

  test('clearHistoryAtom resets stack and inFlight', () => {
    const store = createStore()
    store.setter(pushHistoryAtom, makeEntry('tx-1'))
    store.setter(undoHistoryAtom)
    store.setter(clearHistoryAtom)
    const state = store.getter(historyStackAtom)
    expect(state.entries).toHaveLength(0)
    expect(state.cursor).toBe(0)
    expect(state.inFlight).toBe(false)
  })

  test('stack push is bounded: entries have no payload, only metadata', () => {
    const store = createStore()
    const entry = makeEntry('tx-bounded', 99)
    store.setter(pushHistoryAtom, entry)
    const stored = store.getter(historyStackAtom).entries[0]
    expect(Object.keys(stored).sort()).toEqual(
      ['transactionId', 'kind', 'sheetId', 'projectionRevision'].sort(),
    )
  })
})
