import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStore } from '@einfach/core'
import type { AtomSetParameters, AtomState } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  closeHelpOverlayAtom,
  closeTopMenuAtom,
  helpOverlayAtom,
  MENU_BAR_ITEMS,
  openHelpOverlayAtom,
  openTopMenuAtom,
  topMenuHighlightAtom,
  topMenuOpenAtom,
  type HelpOverlayKind,
  type TopMenuId,
  type TopMenuOpenState,
} from '../src/menu-bar'

type AtomHasPublicWrite<Entity> = Entity extends { write: unknown } ? true : false
type TypesEqual<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false

const PUBLIC_STATE_IS_READ_ONLY: readonly [
  AtomHasPublicWrite<typeof topMenuOpenAtom>,
  AtomHasPublicWrite<typeof topMenuHighlightAtom>,
  AtomHasPublicWrite<typeof helpOverlayAtom>,
] = [false, false, false]

const COMMANDS_ARE_WRITABLE: readonly [
  AtomHasPublicWrite<typeof openTopMenuAtom>,
  AtomHasPublicWrite<typeof closeTopMenuAtom>,
  AtomHasPublicWrite<typeof openHelpOverlayAtom>,
  AtomHasPublicWrite<typeof closeHelpOverlayAtom>,
] = [true, true, true, true]

const COMMAND_TYPES_ARE_STABLE: readonly [
  TypesEqual<AtomSetParameters<typeof openTopMenuAtom>, [TopMenuId]>,
  TypesEqual<AtomSetParameters<typeof closeTopMenuAtom>, []>,
  TypesEqual<AtomSetParameters<typeof openHelpOverlayAtom>, [Exclude<HelpOverlayKind, 'closed'>]>,
  TypesEqual<AtomSetParameters<typeof closeHelpOverlayAtom>, []>,
  TypesEqual<AtomState<typeof openTopMenuAtom>, TopMenuOpenState>,
  TypesEqual<AtomState<typeof closeTopMenuAtom>, TopMenuOpenState>,
  TypesEqual<AtomState<typeof openHelpOverlayAtom>, HelpOverlayKind>,
  TypesEqual<AtomState<typeof closeHelpOverlayAtom>, HelpOverlayKind>,
] = [true, true, true, true, true, true, true, true]

const COMMAND_WRITE_SIGNATURES: readonly [
  AtomSetParameters<typeof openTopMenuAtom>,
  AtomSetParameters<typeof closeTopMenuAtom>,
  AtomSetParameters<typeof openHelpOverlayAtom>,
  AtomSetParameters<typeof closeHelpOverlayAtom>,
] = [
  ['file' satisfies TopMenuId],
  [],
  ['shortcuts' satisfies Exclude<HelpOverlayKind, 'closed'>],
  [],
]

const COMMAND_READ_VALUES: readonly [
  AtomState<typeof openTopMenuAtom>,
  AtomState<typeof closeTopMenuAtom>,
  AtomState<typeof openHelpOverlayAtom>,
  AtomState<typeof closeHelpOverlayAtom>,
] = [
  { kind: 'idle' } satisfies TopMenuOpenState,
  { kind: 'idle' } satisfies TopMenuOpenState,
  'closed' satisfies HelpOverlayKind,
  'closed' satisfies HelpOverlayKind,
]

describe('menu bar state boundary', () => {
  test('registers directional Edit fill commands in their own post-paste group', () => {
    const edit = MENU_BAR_ITEMS.find((menu) => menu.id === 'edit')
    const ids = edit?.items.map((item) => item.id)
    const pasteSpecialIndex = ids?.indexOf('edit.pasteSpecial') ?? -1

    expect(ids?.slice(pasteSpecialIndex, pasteSpecialIndex + 8)).toEqual([
      'edit.pasteSpecial',
      'edit.sep-2',
      'edit.fillDown',
      'edit.fillUp',
      'edit.fillRight',
      'edit.fillLeft',
      'edit.sep-fill',
      'edit.find',
    ])
    expect(edit?.items.slice(pasteSpecialIndex + 2, pasteSpecialIndex + 6)).toEqual([
      {
        id: 'edit.fillDown',
        label: 'menuBar.edit.fillDown',
        dispatch: { kind: 'fill-selection', direction: 'down' },
        isAvailable: 'always',
      },
      {
        id: 'edit.fillUp',
        label: 'menuBar.edit.fillUp',
        dispatch: { kind: 'fill-selection', direction: 'up' },
        isAvailable: 'always',
      },
      {
        id: 'edit.fillRight',
        label: 'menuBar.edit.fillRight',
        dispatch: { kind: 'fill-selection', direction: 'right' },
        isAvailable: 'always',
      },
      {
        id: 'edit.fillLeft',
        label: 'menuBar.edit.fillLeft',
        dispatch: { kind: 'fill-selection', direction: 'left' },
        isAvailable: 'always',
      },
    ])
  })

  test('registers always-available Format unhide row and column commands', () => {
    const format = MENU_BAR_ITEMS.find((menu) => menu.id === 'format')

    expect(format?.items.find((item) => 'id' in item && item.id === 'format.unhideRow')).toEqual({
      id: 'format.unhideRow',
      label: 'menuBar.format.unhideRow',
      dispatch: { kind: 'unhide-rows' },
      isAvailable: 'always',
    })
    expect(format?.items.find((item) => 'id' in item && item.id === 'format.unhideCol')).toEqual({
      id: 'format.unhideCol',
      label: 'menuBar.format.unhideCol',
      dispatch: { kind: 'unhide-cols' },
      isAvailable: 'always',
    })
  })

  test('registers Data -> Reapply next to Filter, gated by a disabled reason', () => {
    const data = MENU_BAR_ITEMS.find((menu) => menu.id === 'data')
    const ids = data?.items.flatMap((item) => ('id' in item ? [item.id] : []))

    expect(data?.items.find((item) => 'id' in item && item.id === 'data.reapply')).toEqual({
      id: 'data.reapply',
      label: 'menuBar.data.reapply',
      accessKey: 'Y',
      shortcut: 'Ctrl+Alt+L',
      dispatch: { kind: 'reapply-filter' },
      // `'always'` rather than `'capability'` on purpose: Reapply's usual
      // unavailable case is "no filter active right now", and an entry that
      // appears and vanishes as the user filters would be worse than one that
      // greys out. Availability is carried entirely by
      // `reapplyFilterDisabledReasonAtom`, like `data.filter` above it.
      isAvailable: 'always',
    })
    // Reapply belongs with the filter it re-runs, before the first separator.
    expect(ids?.indexOf('data.reapply')).toBe((ids?.indexOf('data.filter') ?? -1) + 1)
  })

  test('publishes read-only state and rejects reflective writes without mutation', () => {
    const store = createStore()

    expect(PUBLIC_STATE_IS_READ_ONLY).toEqual([false, false, false])
    expect(
      [topMenuOpenAtom, topMenuHighlightAtom, helpOverlayAtom].map(
        (stateAtom) => 'write' in stateAtom,
      ),
    ).toEqual([false, false, false])

    store.setter(openTopMenuAtom, 'file')
    store.setter(openHelpOverlayAtom, 'shortcuts')
    const before = [
      store.getter(topMenuOpenAtom),
      store.getter(topMenuHighlightAtom),
      store.getter(helpOverlayAtom),
    ]

    const attemptedValues = [{ kind: 'open', menu: 'data' }, 'forged-item', 'about']
    for (const [index, stateAtom] of [
      topMenuOpenAtom,
      topMenuHighlightAtom,
      helpOverlayAtom,
    ].entries()) {
      expect(() => Reflect.apply(store.setter, store, [stateAtom, attemptedValues[index]])).toThrow(
        TypeError,
      )
    }

    expect([
      store.getter(topMenuOpenAtom),
      store.getter(topMenuHighlightAtom),
      store.getter(helpOverlayAtom),
    ]).toEqual(before)
  })

  test('keeps command atoms writable with their current readable values and signatures', () => {
    const store = createStore()

    expect(COMMANDS_ARE_WRITABLE).toEqual([true, true, true, true])
    expect(COMMAND_TYPES_ARE_STABLE).toEqual([true, true, true, true, true, true, true, true])
    expect(
      [openTopMenuAtom, closeTopMenuAtom, openHelpOverlayAtom, closeHelpOverlayAtom].map(
        (commandAtom) => 'write' in commandAtom,
      ),
    ).toEqual([true, true, true, true])
    expect(COMMAND_WRITE_SIGNATURES).toEqual([['file'], [], ['shortcuts'], []])
    expect([
      store.getter(openTopMenuAtom),
      store.getter(closeTopMenuAtom),
      store.getter(openHelpOverlayAtom),
      store.getter(closeHelpOverlayAtom),
    ]).toEqual(COMMAND_READ_VALUES)

    store.setter(openTopMenuAtom, 'view')
    expect(store.getter(openTopMenuAtom)).toEqual({ kind: 'open', menu: 'view' })
    expect(store.getter(closeTopMenuAtom)).toEqual({ kind: 'open', menu: 'view' })

    store.setter(openHelpOverlayAtom, 'about')
    expect(store.getter(openHelpOverlayAtom)).toBe('about')
    expect(store.getter(closeHelpOverlayAtom)).toBe('about')
  })

  test('moves top menus through idle, open, switch, and close while clearing highlight', () => {
    const store = createStore()
    const secondStore = createStore()

    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
    expect(store.getter(topMenuHighlightAtom)).toBeNull()

    store.setter(openTopMenuAtom, 'file')
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'open', menu: 'file' })
    expect(store.getter(topMenuHighlightAtom)).toBeNull()

    store.setter(openTopMenuAtom, 'edit')
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'open', menu: 'edit' })
    expect(store.getter(topMenuHighlightAtom)).toBeNull()

    store.setter(closeTopMenuAtom)
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
    expect(store.getter(topMenuHighlightAtom)).toBeNull()
    expect(secondStore.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  test('moves the help overlay through closed, shortcuts, about, and closed', () => {
    const store = createStore()

    expect(store.getter(helpOverlayAtom)).toBe('closed')
    store.setter(openHelpOverlayAtom, 'shortcuts')
    expect(store.getter(helpOverlayAtom)).toBe('shortcuts')
    store.setter(openHelpOverlayAtom, 'about')
    expect(store.getter(helpOverlayAtom)).toBe('about')
    store.setter(closeHelpOverlayAtom)
    expect(store.getter(helpOverlayAtom)).toBe('closed')
  })

  test('keeps backing atoms private and all public state writes behind commands', () => {
    const source = readFileSync(
      join(process.cwd(), 'vanilla/spreadsheet-ui-core/src/menu-bar/index.ts'),
      'utf8',
    )

    for (const name of ['topMenuOpenAtom', 'topMenuHighlightAtom', 'helpOverlayAtom']) {
      expect(source).toMatch(new RegExp(`export const ${name}: Atom<`))
      expect(source).not.toMatch(new RegExp(`set\\(${name}\\s*[,)]`))
    }
    for (const name of [
      'topMenuOpenBackingAtom',
      'topMenuHighlightBackingAtom',
      'helpOverlayBackingAtom',
    ]) {
      expect(source).toMatch(new RegExp(`const ${name} = atom<`))
      expect(source).not.toMatch(new RegExp(`export const ${name}`))
    }
    expect(source).not.toMatch(/export const (?:set|move|highlight)TopMenuHighlightAtom/)
  })
})
