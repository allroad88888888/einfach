import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  clearMenuIntentAtom,
  closeMenuAtom,
  createMenuCommandIntent,
  createMenuOpenIntent,
  dispatchMenuCommandAtom,
  dispatchMenuIntentAtom,
  menuCommandIntentAtom,
  menuHighlightAtom,
  menuIntentAtom,
  menuPositionAtom,
  menuStateAtom,
  menuTargetAtom,
  openMenuAtom,
  updateMenuHighlightAtom,
} from '../src/menu'

describe('menu core', () => {
  test('opens with a compact target, updates highlight, emits command intent, and closes', () => {
    const store = createStore()

    const opened = store.setter(openMenuAtom, {
      surface: 'cell',
      target: {
        kind: 'range',
        sheetId: 'sheet-1',
        range: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 },
      },
      position: { x: 12.8, y: 9.2 },
      source: 'pointer',
    })

    expect(opened).toMatchObject({
      status: 'open',
      surface: 'cell',
      target: {
        kind: 'range',
        sheetId: 'sheet-1',
        range: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 },
      },
      position: { x: 12, y: 9 },
      highlightedCommand: null,
    })
    expect(store.getter(menuTargetAtom)).toEqual({
      kind: 'range',
      sheetId: 'sheet-1',
      range: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 },
    })
    expect(store.getter(menuPositionAtom)).toEqual({ x: 12, y: 9 })

    store.setter(updateMenuHighlightAtom, 'clipboard.copy')

    expect(store.getter(menuHighlightAtom)).toBe('clipboard.copy')
    expect(store.getter(menuIntentAtom)).toEqual({
      type: 'menu.highlight',
      command: 'clipboard.copy',
    })

    const commandIntent = store.setter(dispatchMenuCommandAtom, 'clipboard.copy')

    expect(commandIntent).toEqual({
      type: 'menu.command',
      command: 'clipboard.copy',
      surface: 'cell',
      target: {
        kind: 'range',
        sheetId: 'sheet-1',
        range: { rowStart: 1, rowEnd: 2, colStart: 3, colEnd: 4 },
      },
    })
    expect(store.getter(menuCommandIntentAtom)).toEqual(commandIntent)

    const closed = store.setter(closeMenuAtom, 'committed')

    expect(closed).toEqual({
      status: 'closed',
      surface: null,
      target: null,
      position: null,
      highlightedCommand: null,
    })
    expect(store.getter(menuStateAtom)).toEqual(closed)
  })

  test('rejects invalid targets and incompatible commands without widening state', () => {
    const store = createStore()

    expect(
      createMenuOpenIntent({
        surface: 'cell',
        target: {
          kind: 'row',
          sheetId: 'sheet-1',
          rowIndex: 2,
        },
        position: { x: 0, y: 0 },
      }),
    ).toBeNull()

    expect(
      store.setter(openMenuAtom, {
        surface: 'header',
        target: {
          kind: 'column',
          sheetId: '',
          colIndex: 1,
        },
        position: { x: NaN, y: 4 },
      }),
    ).toEqual({
      status: 'closed',
      surface: null,
      target: null,
      position: null,
      highlightedCommand: null,
    })

    store.setter(
      dispatchMenuIntentAtom,
      {
        type: 'menu.open',
        surface: 'header',
        target: {
          kind: 'column',
          sheetId: 'sheet-1',
          colIndex: 5,
        },
        position: { x: 4, y: 8 },
        source: 'programmatic',
      },
    )

    expect(
      createMenuCommandIntent('row.insert', {
        surface: 'header',
        target: {
          kind: 'column',
          sheetId: 'sheet-1',
          colIndex: 1,
        },
      }),
    ).toBeNull()
    expect(store.setter(dispatchMenuCommandAtom, 'row.insert')).toBeNull()

    store.setter(clearMenuIntentAtom)
    expect(store.getter(menuIntentAtom)).toBeNull()
  })

  test('preserves compact descriptors and supports direct intent dispatch', () => {
    const store = createStore()

    const intent = createMenuOpenIntent({
      surface: 'context',
      target: {
        kind: 'sheet-tab',
        sheetId: 'sheet-a',
      },
      position: { x: 3.9, y: 7.1 },
      source: 'keyboard',
    })

    expect(intent).toEqual({
      type: 'menu.open',
      surface: 'context',
      target: {
        kind: 'sheet-tab',
        sheetId: 'sheet-a',
      },
      position: { x: 3, y: 7 },
      source: 'keyboard',
    })

    store.setter(dispatchMenuIntentAtom, intent!)

    expect(store.getter(menuStateAtom)).toEqual({
      status: 'open',
      surface: 'context',
      target: {
        kind: 'sheet-tab',
        sheetId: 'sheet-a',
      },
      position: { x: 3, y: 7 },
      highlightedCommand: null,
    })

    expect(
      createMenuCommandIntent('formatting.open', {
        surface: 'context',
        target: {
          kind: 'sheet-tab',
          sheetId: 'sheet-a',
        },
      }),
    ).toBeNull()
  })
})
