import type { CellCoord, CellRange, SheetRef, SpreadsheetError } from '../shared'
import type { ProjectionRevision } from '../backend/types'

export type FindReplaceStatus = 'idle' | 'searching' | 'ready' | 'error'

export type FindReplaceScope = 'sheet' | 'workbook' | 'current-selection'

export type FindReplaceTarget = 'displayValue' | 'formula'

export interface FindReplaceOptions {
  caseSensitive?: boolean
  wholeMatch?: boolean
  regex?: boolean
  searchFormulas?: boolean
  scope: FindReplaceScope
}

export interface FindReplaceQuery {
  needle: string
  replacement?: string
  options: FindReplaceOptions
}

export interface FindMatch {
  coord: CellCoord
  sheetId: string
  matchStart: number
  matchEnd: number
}

export interface FindCursorState {
  status: FindReplaceStatus
  currentIndex: number
  totalCount: number
  pageMatches: FindMatch[]
  error?: SpreadsheetError
}

/**
 * Replace-all cap surface (audit D-12). `pageMatches` is bounded at
 * `MAX_FIND_PAGE` (500), so a replace-all over a larger result set only
 * rewrites the current page. When that happens the host marks this
 * 'capped' status so the dialog can tell the user "replaced first
 * `replacedCount` of `totalCount` — run again for the rest" instead of
 * silently leaving matches 501..N untouched.
 */
export interface ReplaceAllCapInfo {
  replacedCount: number
  totalCount: number
}

export interface FindRangeRequest extends SheetRef {
  kind: 'find-range'
  query: FindReplaceQuery
  pageSize: number
  pageOffset: number
  requestId?: number
  revision?: ProjectionRevision
}

export interface FindRangeResult extends SheetRef {
  kind: 'find-range'
  requestId?: number
  revision?: ProjectionRevision
  matches: FindMatch[]
  total: number
  pageOffset: number
  truncated?: boolean
}

export interface SearchRangeRequest extends SheetRef {
  kind: 'search-range'
  range: CellRange
  query: FindReplaceQuery
  pageStart: number
  pageSize: number
  requestId?: number
  revision?: ProjectionRevision
}

export interface SearchRangeResult extends SheetRef {
  kind: 'search-range'
  matches: FindMatch[]
  pageStart: number
  totalCount: number
  requestId?: number
  revision?: ProjectionRevision
}

export interface ReplaceMatchInput {
  sheetId: string
  coord: CellCoord
  matchStart: number
  matchEnd: number
}

export interface ReplaceMatchesRequest {
  kind: 'replace-matches'
  coords: ReplaceMatchInput[]
  replacement: string
  requestId?: number
  revision?: ProjectionRevision
}

export interface ReplaceMatchesResult {
  replacedCount: number
  requestId?: number
  revision?: ProjectionRevision
}
