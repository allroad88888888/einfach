import { Show, createEffect, createSignal } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import type { CellRange, FindReplaceScope } from '@einfach/spreadsheet-ui-core'
import {
  advanceFindCursorAtom,
  closeFindReplaceAtom,
  commitFindReplaceQueryAtom,
  EXCEL_MAX_COLS,
  EXCEL_MAX_ROWS,
  findReplaceCursorAtom,
  findReplaceOpenAtom,
  selectionSnapshotAtom,
  setFindMatchesAtom,
  setFindReplaceErrorAtom,
  workspaceSessionAtom,
  MAX_FIND_PAGE,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'

export interface SpreadsheetFindReplaceDialogProps {
  class?: string
  'data-testid'?: string
}

export function SpreadsheetFindReplaceDialog(props: SpreadsheetFindReplaceDialogProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const isOpen = useAtomValue(findReplaceOpenAtom)
  const cursor = useAtomValue(findReplaceCursorAtom)

  const [needle, setNeedle] = createSignal('')
  const [replacement, setReplacement] = createSignal('')
  const [caseSensitive, setCaseSensitive] = createSignal(false)
  const [wholeMatch, setWholeMatch] = createSignal(false)
  const [regex, setRegex] = createSignal(false)
  const [searchFormulas, setSearchFormulas] = createSignal(false)
  const [scope, setScope] = createSignal<FindReplaceScope>('sheet')

  createEffect<boolean>((wasOpen) => {
    const open = isOpen()
    if (open && !wasOpen) {
      setNeedle('')
      setReplacement('')
      setCaseSensitive(false)
      setWholeMatch(false)
      setRegex(false)
      setSearchFormulas(false)
      setScope('sheet')
    }
    return open
  }, false)

  function buildQuery() {
    return {
      needle: needle(),
      replacement: replacement() || undefined,
      options: {
        caseSensitive: caseSensitive(),
        wholeMatch: wholeMatch(),
        regex: regex(),
        searchFormulas: searchFormulas(),
        scope: scope(),
      },
    }
  }

  function resolveSearchScope(): { sheetId: string; range: CellRange } {
    const snapshot = store.getter(selectionSnapshotAtom)
    const workspace = store.getter(workspaceSessionAtom)
    const sheetId = snapshot.selection.sheetId || workspace.activeSheetId || ''
    const fullSheetRange: CellRange = {
      rowStart: 0,
      rowEnd: EXCEL_MAX_ROWS - 1,
      colStart: 0,
      colEnd: EXCEL_MAX_COLS - 1,
    }
    if (scope() === 'current-selection') {
      return { sheetId, range: snapshot.range }
    }
    return { sheetId, range: fullSheetRange }
  }

  async function runSearch() {
    if (!backend.searchRange) return
    const query = buildQuery()
    store.setter(commitFindReplaceQueryAtom, query)
    const { sheetId, range } = resolveSearchScope()
    try {
      const result = await backend.searchRange({
        kind: 'search-range',
        sheetId,
        range,
        query,
        pageStart: 0,
        pageSize: MAX_FIND_PAGE,
      })
      store.setter(setFindMatchesAtom, result)
    } catch (err) {
      store.setter(setFindReplaceErrorAtom, {
        code: 'BACKEND_ERROR',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function handleReplaceCurrent() {
    if (!backend.replaceMatches) return
    const c = cursor()
    const match = c.pageMatches[c.currentIndex]
    if (!match) return
    try {
      await backend.replaceMatches({
        kind: 'replace-matches',
        coords: [
          {
            sheetId: match.sheetId,
            coord: match.coord,
            matchStart: match.matchStart,
            matchEnd: match.matchEnd,
          },
        ],
        replacement: replacement(),
      })
    } catch (err) {
      store.setter(setFindReplaceErrorAtom, {
        code: 'BACKEND_ERROR',
        message: err instanceof Error ? err.message : String(err),
      })
      return
    }
    await runSearch()
  }

  async function handleReplaceAll() {
    if (!backend.replaceMatches) return
    const c = cursor()
    if (c.pageMatches.length === 0) return
    try {
      await backend.replaceMatches({
        kind: 'replace-matches',
        coords: c.pageMatches.map((m) => ({
          sheetId: m.sheetId,
          coord: m.coord,
          matchStart: m.matchStart,
          matchEnd: m.matchEnd,
        })),
        replacement: replacement(),
      })
    } catch (err) {
      store.setter(setFindReplaceErrorAtom, {
        code: 'BACKEND_ERROR',
        message: err instanceof Error ? err.message : String(err),
      })
      return
    }
    await runSearch()
  }

  function statusText() {
    const c = cursor()
    if (c.status === 'idle') return ''
    if (c.status === 'searching') return 'Searching…'
    if (c.status === 'error') return 'Search failed'
    if (c.totalCount === 0) return 'No matches'
    return `${c.currentIndex + 1} of ${c.totalCount}`
  }

  function errorText() {
    const c = cursor()
    if (c.status !== 'error') return ''
    return c.error?.message ?? ''
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`find-replace-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'find-replace-dialog'}
        role="dialog"
        aria-label="Find and Replace"
      >
        <div class="find-replace-row">
          <label class="find-replace-label" for="find-needle">
            Find
          </label>
          <input
            id="find-needle"
            class="find-replace-input"
            data-testid="find-needle-input"
            type="text"
            value={needle()}
            onInput={(e) => setNeedle(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void runSearch()
              }
            }}
          />
        </div>

        <div class="find-replace-row">
          <label class="find-replace-label" for="find-replacement">
            Replace with
          </label>
          <input
            id="find-replacement"
            class="find-replace-input"
            data-testid="find-replacement-input"
            type="text"
            value={replacement()}
            onInput={(e) => setReplacement(e.currentTarget.value)}
          />
        </div>

        <div class="find-replace-options">
          <label class="find-replace-option">
            <input
              type="checkbox"
              data-testid="find-opt-case-sensitive"
              checked={caseSensitive()}
              onChange={(e) => setCaseSensitive(e.currentTarget.checked)}
            />
            Case sensitive
          </label>
          <label class="find-replace-option">
            <input
              type="checkbox"
              data-testid="find-opt-whole-match"
              checked={wholeMatch()}
              onChange={(e) => setWholeMatch(e.currentTarget.checked)}
            />
            Whole match
          </label>
          <label class="find-replace-option">
            <input
              type="checkbox"
              data-testid="find-opt-regex"
              checked={regex()}
              onChange={(e) => setRegex(e.currentTarget.checked)}
            />
            Regex
          </label>
          <label class="find-replace-option">
            <input
              type="checkbox"
              data-testid="find-opt-formulas"
              checked={searchFormulas()}
              onChange={(e) => setSearchFormulas(e.currentTarget.checked)}
            />
            Search formulas
          </label>
        </div>

        <div class="find-replace-scope">
          <label class="find-replace-label">Scope</label>
          <select
            data-testid="find-scope-select"
            value={scope()}
            onChange={(e) => setScope(e.currentTarget.value as FindReplaceScope)}
          >
            <option value="sheet">Sheet</option>
            <option value="workbook">Workbook</option>
            <option value="current-selection">Current selection</option>
          </select>
        </div>

        <div class="find-replace-actions">
          <button
            type="button"
            class="find-replace-btn"
            data-testid="find-next-button"
            onClick={() => store.setter(advanceFindCursorAtom, 1)}
          >
            Find next
          </button>
          <button
            type="button"
            class="find-replace-btn"
            data-testid="find-prev-button"
            onClick={() => store.setter(advanceFindCursorAtom, -1)}
          >
            Find prev
          </button>
          <button
            type="button"
            class="find-replace-btn"
            data-testid="replace-button"
            onClick={() => void handleReplaceCurrent()}
          >
            Replace
          </button>
          <button
            type="button"
            class="find-replace-btn"
            data-testid="replace-all-button"
            onClick={() => void handleReplaceAll()}
          >
            Replace all
          </button>
          <button
            type="button"
            class="find-replace-btn find-replace-btn-close"
            data-testid="find-close-button"
            onClick={() => store.setter(closeFindReplaceAtom)}
          >
            Close
          </button>
        </div>

        <div class="find-replace-status" data-testid="find-status-text" aria-live="polite">
          {statusText()}
        </div>
        <Show when={errorText()}>
          <div class="find-replace-error" data-testid="find-error-text" role="alert">
            {errorText()}
          </div>
        </Show>
      </div>
    </Show>
  )
}
