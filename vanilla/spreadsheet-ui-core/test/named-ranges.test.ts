import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  closeNameManagerAtom,
  nameManagerEditorAtom,
  nameRegistryCacheAtom,
  NAMED_RANGE_CACHE_MAX,
  openNameManagerAtom,
  setNameRegistryAtom,
  type NamedRange,
} from '../src/named-ranges'

function makeRange(name: string): NamedRange {
  return {
    name,
    scope: 'workbook',
    refersTo: { kind: 'range', sheetId: 'sheet-1', address: 'A1:B2' },
  }
}

describe('named-ranges atoms', () => {
  test('initial cache is empty', () => {
    const store = createStore()
    expect(store.getter(nameRegistryCacheAtom)).toEqual([])
  })

  test('setNameRegistryAtom replaces the cache wholesale', () => {
    const store = createStore()

    store.setter(setNameRegistryAtom, {
      names: [makeRange('Alpha'), makeRange('Beta')],
    })
    expect(store.getter(nameRegistryCacheAtom)).toHaveLength(2)
    expect(store.getter(nameRegistryCacheAtom)[0].name).toBe('Alpha')

    store.setter(setNameRegistryAtom, {
      names: [makeRange('Gamma')],
    })
    expect(store.getter(nameRegistryCacheAtom)).toHaveLength(1)
    expect(store.getter(nameRegistryCacheAtom)[0].name).toBe('Gamma')
  })

  test('push beyond cap truncates oldest entries (FIFO)', () => {
    const store = createStore()

    const items = Array.from({ length: NAMED_RANGE_CACHE_MAX + 1 }, (_, i) =>
      makeRange(`Name${i}`),
    )

    store.setter(setNameRegistryAtom, { names: items })

    const cache = store.getter(nameRegistryCacheAtom)
    expect(cache).toHaveLength(NAMED_RANGE_CACHE_MAX)
    expect(cache[0].name).toBe('Name1')
    expect(cache[cache.length - 1].name).toBe(`Name${NAMED_RANGE_CACHE_MAX}`)
  })

  test('openNameManagerAtom sets editor state', () => {
    const store = createStore()

    store.setter(openNameManagerAtom, { status: 'editing-new' })
    expect(store.getter(nameManagerEditorAtom)).toEqual({ status: 'editing-new' })

    const draft = makeRange('MyName')
    store.setter(openNameManagerAtom, { status: 'editing-existing', draft })
    expect(store.getter(nameManagerEditorAtom)).toEqual({
      status: 'editing-existing',
      draft,
    })
  })

  test('closeNameManagerAtom resets editor to closed', () => {
    const store = createStore()

    store.setter(openNameManagerAtom, { status: 'editing-new' })
    store.setter(closeNameManagerAtom)
    expect(store.getter(nameManagerEditorAtom)).toEqual({ status: 'closed' })
  })
})
