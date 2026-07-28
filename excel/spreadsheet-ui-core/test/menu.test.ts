import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStore } from '@einfach/core'
import type { AtomSetParameters, AtomSetResult, AtomState } from '@einfach/core'
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
  type MenuCloseReason,
  type MenuCommandKind,
  type MenuIntent,
  type MenuOpenInput,
  type MenuState,
  updateMenuHighlightAtom,
} from '../src/menu'

type AtomHasPublicWrite<Entity> = Entity extends { write: unknown } ? true : false

const CLOSED_MENU_STATE = {
  status: 'closed',
  surface: null,
  target: null,
  position: null,
  highlightedCommand: null,
} satisfies MenuState

const PUBLIC_STATE_IS_READ_ONLY: readonly [
  AtomHasPublicWrite<typeof menuStateAtom>,
  AtomHasPublicWrite<typeof menuIntentAtom>,
] = [false, false]

const COMMANDS_ARE_WRITABLE: readonly [
  AtomHasPublicWrite<typeof dispatchMenuIntentAtom>,
  AtomHasPublicWrite<typeof openMenuAtom>,
  AtomHasPublicWrite<typeof closeMenuAtom>,
  AtomHasPublicWrite<typeof updateMenuHighlightAtom>,
  AtomHasPublicWrite<typeof dispatchMenuCommandAtom>,
  AtomHasPublicWrite<typeof clearMenuIntentAtom>,
] = [true, true, true, true, true, true]

const COMMAND_WRITE_SIGNATURES: readonly [
  AtomSetParameters<typeof dispatchMenuIntentAtom>,
  AtomSetParameters<typeof openMenuAtom>,
  AtomSetParameters<typeof closeMenuAtom>,
  AtomSetParameters<typeof updateMenuHighlightAtom>,
  AtomSetParameters<typeof dispatchMenuCommandAtom>,
  AtomSetParameters<typeof clearMenuIntentAtom>,
] = [
  [{ type: 'menu.close', reason: 'dismissed' } satisfies MenuIntent],
  [
    {
      surface: 'cell',
      target: { kind: 'cell', sheetId: 'sheet-1', cell: { row: 0, col: 0 } },
      position: { x: 0, y: 0 },
    } satisfies MenuOpenInput,
  ],
  ['committed' satisfies MenuCloseReason],
  ['clipboard.copy' satisfies MenuCommandKind],
  ['clipboard.copy' satisfies MenuCommandKind],
  [],
]

const COMMAND_READ_VALUES: readonly [
  AtomState<typeof dispatchMenuIntentAtom>,
  AtomState<typeof openMenuAtom>,
  AtomState<typeof closeMenuAtom>,
  AtomState<typeof updateMenuHighlightAtom>,
  AtomState<typeof dispatchMenuCommandAtom>,
  AtomState<typeof clearMenuIntentAtom>,
] = [CLOSED_MENU_STATE, CLOSED_MENU_STATE, CLOSED_MENU_STATE, CLOSED_MENU_STATE, null, null]

const COMMAND_WRITE_RESULTS: readonly [
  AtomSetResult<typeof dispatchMenuIntentAtom>,
  AtomSetResult<typeof openMenuAtom>,
  AtomSetResult<typeof closeMenuAtom>,
  AtomSetResult<typeof updateMenuHighlightAtom>,
  AtomSetResult<typeof dispatchMenuCommandAtom>,
  AtomSetResult<typeof clearMenuIntentAtom>,
] = [CLOSED_MENU_STATE, CLOSED_MENU_STATE, CLOSED_MENU_STATE, CLOSED_MENU_STATE, null, undefined]

describe('menu core', () => {
  test('publishes read-only state, rejects reflective writes, and isolates stores', () => {
    const firstStore = createStore()
    const secondStore = createStore()

    expect(PUBLIC_STATE_IS_READ_ONLY).toEqual([false, false])
    expect([menuStateAtom, menuIntentAtom].map((stateAtom) => 'write' in stateAtom)).toEqual([
      false,
      false,
    ])

    firstStore.setter(openMenuAtom, {
      surface: 'cell',
      target: { kind: 'cell', sheetId: 'sheet-1', cell: { row: 1, col: 2 } },
      position: { x: 10, y: 20 },
    })
    firstStore.setter(updateMenuHighlightAtom, 'clipboard.copy')
    const stateBeforeWrite = firstStore.getter(menuStateAtom)
    const intentBeforeWrite = firstStore.getter(menuIntentAtom)

    const unsafeSet = firstStore.setter as unknown as (target: unknown, value: unknown) => unknown
    expect(() => unsafeSet(menuStateAtom, CLOSED_MENU_STATE)).toThrow(TypeError)
    expect(() => unsafeSet(menuIntentAtom, { type: 'menu.close', reason: 'cancelled' })).toThrow(
      TypeError,
    )

    expect(firstStore.getter(menuStateAtom)).toEqual(stateBeforeWrite)
    expect(firstStore.getter(menuIntentAtom)).toEqual(intentBeforeWrite)
    expect(secondStore.getter(menuStateAtom)).toEqual(CLOSED_MENU_STATE)
    expect(secondStore.getter(menuIntentAtom)).toBeNull()
  })

  test('keeps every command writable with its existing getter and return semantics', () => {
    const store = createStore()
    const commandAtoms = [
      dispatchMenuIntentAtom,
      openMenuAtom,
      closeMenuAtom,
      updateMenuHighlightAtom,
      dispatchMenuCommandAtom,
      clearMenuIntentAtom,
    ]

    expect(COMMANDS_ARE_WRITABLE).toEqual([true, true, true, true, true, true])
    expect(commandAtoms.map((commandAtom) => 'write' in commandAtom)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ])
    expect(COMMAND_WRITE_SIGNATURES).toHaveLength(6)
    expect(COMMAND_WRITE_RESULTS).toHaveLength(6)
    expect([
      store.getter(dispatchMenuIntentAtom),
      store.getter(openMenuAtom),
      store.getter(closeMenuAtom),
      store.getter(updateMenuHighlightAtom),
      store.getter(dispatchMenuCommandAtom),
      store.getter(clearMenuIntentAtom),
    ]).toEqual(COMMAND_READ_VALUES)

    const opened = store.setter(openMenuAtom, {
      surface: 'cell',
      target: { kind: 'cell', sheetId: 'sheet-1', cell: { row: 1, col: 2 } },
      position: { x: 10, y: 20 },
    })
    expect([
      store.getter(dispatchMenuIntentAtom),
      store.getter(openMenuAtom),
      store.getter(closeMenuAtom),
      store.getter(updateMenuHighlightAtom),
    ]).toEqual([opened, opened, opened, opened])
    expect(store.getter(dispatchMenuCommandAtom)).toBeNull()
    expect(store.getter(clearMenuIntentAtom)).toMatchObject({ type: 'menu.open' })

    const highlighted = store.setter(updateMenuHighlightAtom, 'clipboard.copy')
    expect(highlighted.highlightedCommand).toBe('clipboard.copy')

    const command = store.setter(dispatchMenuCommandAtom, 'clipboard.copy')
    expect(store.getter(dispatchMenuCommandAtom)).toEqual(command)
    expect(store.getter(clearMenuIntentAtom)).toEqual(command)
    expect(store.setter(clearMenuIntentAtom)).toBeUndefined()
    expect(store.getter(dispatchMenuCommandAtom)).toBeNull()
    expect(store.getter(clearMenuIntentAtom)).toBeNull()
  })

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

    const dispatched = store.setter(dispatchMenuIntentAtom, intent!)

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
    expect(dispatched).toEqual(store.getter(menuStateAtom))

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

  test('keeps backing atoms private and public state writes behind commands', () => {
    const source = readFileSync(
      join(process.cwd(), 'excel/spreadsheet-ui-core/src/menu/index.ts'),
      'utf8',
    )

    for (const name of ['menuStateAtom', 'menuIntentAtom']) {
      expect(source).toMatch(new RegExp(`export const ${name}: Atom<`))
      expect(source).not.toMatch(new RegExp(`set\\(${name}\\s*[,)]`))
    }
    for (const name of ['menuStateBackingAtom', 'menuIntentBackingAtom']) {
      expect(source).toMatch(new RegExp(`const ${name} = atom<`))
      expect(source).not.toMatch(new RegExp(`export const ${name}`))
    }
    expect(source.match(/set\(\s*(?:menuStateAtom|menuIntentAtom)\s*,/g) ?? []).toHaveLength(0)
  })
})
