import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  MAX_FIND_PAGE,
  advanceFindCursorAtom,
  closeFindReplaceAtom,
  commitFindReplaceQueryAtom,
  findReplaceCursorAtom,
  findReplaceOpenAtom,
  findReplaceQueryAtom,
  markReplaceAllCappedAtom,
  openFindReplaceAtom,
  replaceAllCappedAtom,
  setFindMatchesAtom,
  setFindReplaceErrorAtom,
} from '../src/find-replace'
import type { FindMatch, FindReplaceQuery, SearchRangeResult } from '../src/find-replace'

function makeQuery(needle: string): FindReplaceQuery {
  return { needle, options: { scope: 'sheet' } }
}

function makeMatch(row: number, col: number): FindMatch {
  return { coord: { row, col }, sheetId: 'sheet1', matchStart: 0, matchEnd: 3 }
}

function makeResult(matches: FindMatch[], totalCount: number): SearchRangeResult {
  return {
    kind: 'search-range',
    sheetId: 'sheet1',
    matches,
    pageStart: 0,
    totalCount,
  }
}

describe('find-replace', () => {
  test('initial state: query null, cursor idle, open false', () => {
    const store = createStore()
    expect(store.getter(findReplaceQueryAtom)).toBeNull()
    expect(store.getter(findReplaceCursorAtom)).toEqual({
      status: 'idle',
      currentIndex: 0,
      totalCount: 0,
      pageMatches: [],
    })
    expect(store.getter(findReplaceOpenAtom)).toBe(false)
  })

  test('openFindReplaceAtom sets open true', () => {
    const store = createStore()
    store.setter(openFindReplaceAtom)
    expect(store.getter(findReplaceOpenAtom)).toBe(true)
  })

  test('closeFindReplaceAtom resets open, query, and cursor', () => {
    const store = createStore()
    store.setter(openFindReplaceAtom)
    store.setter(commitFindReplaceQueryAtom, makeQuery('foo'))
    store.setter(closeFindReplaceAtom)
    expect(store.getter(findReplaceOpenAtom)).toBe(false)
    expect(store.getter(findReplaceQueryAtom)).toBeNull()
    expect(store.getter(findReplaceCursorAtom)).toEqual({
      status: 'idle',
      currentIndex: 0,
      totalCount: 0,
      pageMatches: [],
    })
  })

  test('commitFindReplaceQueryAtom sets query and cursor status to searching', () => {
    const store = createStore()
    const query = makeQuery('foo')
    store.setter(commitFindReplaceQueryAtom, query)
    expect(store.getter(findReplaceQueryAtom)).toEqual(query)
    expect(store.getter(findReplaceCursorAtom).status).toBe('searching')
    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(0)
    expect(store.getter(findReplaceCursorAtom).totalCount).toBe(0)
    expect(store.getter(findReplaceCursorAtom).pageMatches).toEqual([])
  })

  test('setFindMatchesAtom updates cursor with matches and ready status', () => {
    const store = createStore()
    store.setter(commitFindReplaceQueryAtom, makeQuery('foo'))
    const matches = [makeMatch(0, 0), makeMatch(1, 0), makeMatch(2, 0)]
    store.setter(setFindMatchesAtom, makeResult(matches, 3))
    const cursor = store.getter(findReplaceCursorAtom)
    expect(cursor.status).toBe('ready')
    expect(cursor.totalCount).toBe(3)
    expect(cursor.pageMatches).toHaveLength(3)
    expect(cursor.currentIndex).toBe(0)
  })

  test('setFindMatchesAtom truncates pageMatches to MAX_FIND_PAGE', () => {
    const store = createStore()
    const matches = Array.from({ length: MAX_FIND_PAGE + 10 }, (_, i) => makeMatch(i, 0))
    store.setter(setFindMatchesAtom, makeResult(matches, matches.length))
    const cursor = store.getter(findReplaceCursorAtom)
    expect(cursor.pageMatches).toHaveLength(MAX_FIND_PAGE)
    expect(cursor.totalCount).toBe(MAX_FIND_PAGE + 10)
  })

  test('advanceFindCursorAtom(1) advances and wraps from last to first', () => {
    const store = createStore()
    const matches = [makeMatch(0, 0), makeMatch(1, 0), makeMatch(2, 0)]
    store.setter(setFindMatchesAtom, makeResult(matches, 3))

    store.setter(advanceFindCursorAtom, 1)
    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(1)

    store.setter(advanceFindCursorAtom, 1)
    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(2)

    // wrap: last → first
    store.setter(advanceFindCursorAtom, 1)
    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(0)
  })

  test('advanceFindCursorAtom(-1) retreats and wraps from first to last', () => {
    const store = createStore()
    const matches = [makeMatch(0, 0), makeMatch(1, 0), makeMatch(2, 0)]
    store.setter(setFindMatchesAtom, makeResult(matches, 3))

    // wrap: first → last
    store.setter(advanceFindCursorAtom, -1)
    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(2)

    store.setter(advanceFindCursorAtom, -1)
    expect(store.getter(findReplaceCursorAtom).currentIndex).toBe(1)
  })

  test('setFindReplaceErrorAtom sets status to error', () => {
    const store = createStore()
    store.setter(commitFindReplaceQueryAtom, makeQuery('foo'))
    store.setter(setFindReplaceErrorAtom, new Error('backend failure'))
    expect(store.getter(findReplaceCursorAtom).status).toBe('error')
  })

  test('replaceAllCappedAtom starts null and markReplaceAllCappedAtom sets it (audit D-12)', () => {
    const store = createStore()
    expect(store.getter(replaceAllCappedAtom)).toBeNull()
    store.setter(markReplaceAllCappedAtom, { replacedCount: MAX_FIND_PAGE, totalCount: 1234 })
    expect(store.getter(replaceAllCappedAtom)).toEqual({
      replacedCount: MAX_FIND_PAGE,
      totalCount: 1234,
    })
  })

  test('commitFindReplaceQueryAtom clears the replace-all capped notice', () => {
    const store = createStore()
    store.setter(markReplaceAllCappedAtom, { replacedCount: 500, totalCount: 800 })
    store.setter(commitFindReplaceQueryAtom, makeQuery('foo'))
    expect(store.getter(replaceAllCappedAtom)).toBeNull()
  })

  test('closeFindReplaceAtom clears the replace-all capped notice', () => {
    const store = createStore()
    store.setter(openFindReplaceAtom)
    store.setter(markReplaceAllCappedAtom, { replacedCount: 500, totalCount: 800 })
    store.setter(closeFindReplaceAtom)
    expect(store.getter(replaceAllCappedAtom)).toBeNull()
  })
})
