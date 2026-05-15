import { atom } from '@einfach/core'
import type { FindCursorState, FindReplaceQuery, SearchRangeResult } from './types'

export * from './types'

export const MAX_FIND_PAGE = 500

const INITIAL_CURSOR: FindCursorState = {
  status: 'idle',
  currentIndex: 0,
  totalCount: 0,
  pageMatches: [],
}

export const findReplaceQueryAtom = atom<FindReplaceQuery | null>(null)
findReplaceQueryAtom.debugLabel = 'spreadsheet.findReplace.query'

export const findReplaceCursorAtom = atom<FindCursorState>({ ...INITIAL_CURSOR })
findReplaceCursorAtom.debugLabel = 'spreadsheet.findReplace.cursor'

export const findReplaceOpenAtom = atom<boolean>(false)
findReplaceOpenAtom.debugLabel = 'spreadsheet.findReplace.open'

export const openFindReplaceAtom = atom(
  null,
  (_get, set) => {
    set(findReplaceOpenAtom, true)
  },
)
openFindReplaceAtom.debugLabel = 'spreadsheet.findReplace.open'

export const closeFindReplaceAtom = atom(
  null,
  (_get, set) => {
    set(findReplaceOpenAtom, false)
    set(findReplaceQueryAtom, null)
    set(findReplaceCursorAtom, { ...INITIAL_CURSOR })
  },
)
closeFindReplaceAtom.debugLabel = 'spreadsheet.findReplace.close'

export const commitFindReplaceQueryAtom = atom(
  null,
  (_get, set, query: FindReplaceQuery) => {
    set(findReplaceQueryAtom, query)
    set(findReplaceCursorAtom, {
      status: 'searching',
      currentIndex: 0,
      totalCount: 0,
      pageMatches: [],
    })
  },
)
commitFindReplaceQueryAtom.debugLabel = 'spreadsheet.findReplace.commitQuery'

export const setFindMatchesAtom = atom(
  null,
  (_get, set, result: SearchRangeResult) => {
    const truncated = result.matches.slice(0, MAX_FIND_PAGE)
    set(findReplaceCursorAtom, {
      status: 'ready',
      currentIndex: 0,
      totalCount: result.totalCount,
      pageMatches: truncated,
    })
  },
)
setFindMatchesAtom.debugLabel = 'spreadsheet.findReplace.setMatches'

export const advanceFindCursorAtom = atom(
  null,
  (get, set, direction: 1 | -1) => {
    const cursor = get(findReplaceCursorAtom)
    const count = cursor.pageMatches.length
    if (count === 0) return
    const next = (cursor.currentIndex + direction + count) % count
    set(findReplaceCursorAtom, { ...cursor, currentIndex: next })
  },
)
advanceFindCursorAtom.debugLabel = 'spreadsheet.findReplace.advance'

export const setFindReplaceErrorAtom = atom(
  null,
  (_get, set, _error: unknown) => {
    set(findReplaceCursorAtom, (prev) => ({ ...prev, status: 'error' }))
  },
)
setFindReplaceErrorAtom.debugLabel = 'spreadsheet.findReplace.error'
