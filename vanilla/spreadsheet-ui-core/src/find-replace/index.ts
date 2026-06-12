import { atom } from '@einfach/core'
import type { SpreadsheetError } from '../shared'
import type {
  FindCursorState,
  FindReplaceQuery,
  ReplaceAllCapInfo,
  SearchRangeResult,
} from './types'

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

/**
 * Non-null when the last replace-all hit the `MAX_FIND_PAGE` cap (audit
 * D-12): only the first `replacedCount` of `totalCount` matches were
 * rewritten. Cleared by `commitFindReplaceQueryAtom` (a fresh search
 * supersedes the notice) and `closeFindReplaceAtom`. Hosts set it AFTER
 * the post-replace re-search so the commit-time clear does not race it.
 */
export const replaceAllCappedAtom = atom<ReplaceAllCapInfo | null>(null)
replaceAllCappedAtom.debugLabel = 'spreadsheet.findReplace.replaceAllCapped'

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
    set(replaceAllCappedAtom, null)
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
    set(replaceAllCappedAtom, null)
  },
)
commitFindReplaceQueryAtom.debugLabel = 'spreadsheet.findReplace.commitQuery'

export const markReplaceAllCappedAtom = atom(
  null,
  (_get, set, info: ReplaceAllCapInfo) => {
    set(replaceAllCappedAtom, info)
  },
)
markReplaceAllCappedAtom.debugLabel = 'spreadsheet.findReplace.markReplaceAllCapped'

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

function normalizeFindReplaceError(error: unknown): SpreadsheetError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const e = error as { code: unknown; message: unknown }
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      return error as SpreadsheetError
    }
  }
  if (error instanceof Error) {
    return { code: 'BACKEND_ERROR', message: error.message }
  }
  return { code: 'BACKEND_ERROR', message: String(error) }
}

export const setFindReplaceErrorAtom = atom(
  null,
  (_get, set, error: unknown) => {
    const normalized = normalizeFindReplaceError(error)
    set(findReplaceCursorAtom, (prev) => ({ ...prev, status: 'error', error: normalized }))
  },
)
setFindReplaceErrorAtom.debugLabel = 'spreadsheet.findReplace.error'
