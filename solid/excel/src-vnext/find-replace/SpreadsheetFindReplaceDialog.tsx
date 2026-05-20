import { Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import type { CellRange, FindReplaceScope } from '@einfach/spreadsheet-ui-core'
import {
  advanceFindCursorAtom,
  closeFindReplaceAtom,
  commitFindReplaceQueryAtom,
  EXCEL_MAX_COLS,
  EXCEL_MAX_ROWS,
  findReplaceCursorAtom,
  findReplaceOpenAtom,
  scrollToCellAtom,
  selectionSnapshotAtom,
  setFindMatchesAtom,
  setFindReplaceErrorAtom,
  setSelectionAtom,
  workspaceSessionAtom,
  MAX_FIND_PAGE,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'
import './find-replace-dialog.css'

export interface SpreadsheetFindReplaceDialogProps {
  class?: string
  'data-testid'?: string
}

type FindReplaceTab = 'find' | 'replace'

export function SpreadsheetFindReplaceDialog(props: SpreadsheetFindReplaceDialogProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const isOpen = useAtomValue(findReplaceOpenAtom)
  const cursor = useAtomValue(findReplaceCursorAtom)

  const [activeTab, setActiveTab] = createSignal<FindReplaceTab>('find')
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
      setActiveTab('find')
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

  createEffect(() => {
    if (!isOpen()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        store.setter(closeFindReplaceAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

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
      focusCurrentMatch()
    } catch (err) {
      store.setter(setFindReplaceErrorAtom, {
        code: 'BACKEND_ERROR',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function focusCurrentMatch() {
    const c = store.getter(findReplaceCursorAtom)
    const match = c.pageMatches[c.currentIndex]
    if (!match) return
    store.setter(setSelectionAtom, {
      kind: 'cell',
      sheetId: match.sheetId,
      anchor: match.coord,
      focus: match.coord,
    })
    store.setter(scrollToCellAtom, { coord: match.coord })
  }

  async function handleFindStep(direction: 1 | -1) {
    const c = store.getter(findReplaceCursorAtom)
    if (c.totalCount === 0 || c.pageMatches.length === 0) {
      if (needle().length > 0) {
        await runSearch()
      }
      return
    }
    store.setter(advanceFindCursorAtom, direction)
    focusCurrentMatch()
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
        data-active-tab={activeTab()}
        role="dialog"
        aria-label="Find and Replace"
      >
        {/* === Header === */}
        <div class="fr-header">
          <span class="fr-title">查找和替换</span>
          <button
            type="button"
            class="dialog-close-x"
            data-testid="dialog-close-x"
            aria-label={t('dialog.close.label')}
            onClick={() => store.setter(closeFindReplaceAtom)}
          >
            ×
          </button>
        </div>

        {/* === Tab strip === */}
        <div class="fr-tabs" role="tablist">
          <button
            type="button"
            class="fr-tab"
            role="tab"
            aria-selected={activeTab() === 'find'}
            data-testid="find-tab"
            onClick={() => setActiveTab('find')}
          >
            查找
          </button>
          <button
            type="button"
            class="fr-tab"
            role="tab"
            aria-selected={activeTab() === 'replace'}
            data-testid="replace-tab"
            onClick={() => setActiveTab('replace')}
          >
            替换
          </button>
        </div>

        {/* === Body === */}
        <div class="fr-body">
          <div class="fr-field">
            <label class="fr-field-label" for="find-needle">
              查找内容
            </label>
            <input
              id="find-needle"
              class="fr-input"
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
            <span class="fr-step-group">
              <button
                type="button"
                class="fr-step-btn"
                data-testid="find-prev-button"
                aria-label="上一个"
                title="上一个"
                onClick={() => void handleFindStep(-1)}
              >
                ↑
              </button>
              <button
                type="button"
                class="fr-step-btn"
                data-testid="find-next-button"
                aria-label="下一个"
                title="下一个"
                onClick={() => void handleFindStep(1)}
              >
                ↓
              </button>
            </span>
          </div>

          <div class="fr-field fr-field-replace" data-replace-only="true">
            <label class="fr-field-label" for="find-replacement">
              替换为
            </label>
            <input
              id="find-replacement"
              class="fr-input"
              data-testid="find-replacement-input"
              type="text"
              value={replacement()}
              onInput={(e) => setReplacement(e.currentTarget.value)}
            />
          </div>

          <div class="fr-options">
            <label class="fr-option">
              <input
                type="checkbox"
                data-testid="find-opt-case-sensitive"
                checked={caseSensitive()}
                onChange={(e) => setCaseSensitive(e.currentTarget.checked)}
              />
              区分大小写
            </label>
            <label class="fr-option">
              <input
                type="checkbox"
                data-testid="find-opt-whole-match"
                checked={wholeMatch()}
                onChange={(e) => setWholeMatch(e.currentTarget.checked)}
              />
              单元格匹配
            </label>
            <label class="fr-option">
              <input
                type="checkbox"
                data-testid="find-opt-formulas"
                checked={searchFormulas()}
                onChange={(e) => setSearchFormulas(e.currentTarget.checked)}
              />
              公式搜索
            </label>
            <label class="fr-option">
              <input
                type="checkbox"
                data-testid="find-opt-regex"
                checked={regex()}
                onChange={(e) => setRegex(e.currentTarget.checked)}
              />
              正则匹配
            </label>
          </div>

          <div class="fr-scope">
            <label class="fr-field-label" for="find-scope-select">
              范围
            </label>
            <select
              id="find-scope-select"
              class="fr-select"
              data-testid="find-scope-select"
              value={scope()}
              onChange={(e) => setScope(e.currentTarget.value as FindReplaceScope)}
            >
              <option value="sheet">工作表</option>
              <option value="workbook">工作簿</option>
              <option value="current-selection">当前选区</option>
            </select>
          </div>
        </div>

        {/* === Status / error === */}
        <div class="fr-status" data-testid="find-status-text" aria-live="polite">
          {statusText()}
        </div>
        <Show when={errorText()}>
          <div class="fr-error" data-testid="find-error-text" role="alert">
            {errorText()}
          </div>
        </Show>

        {/* === Footer === */}
        <div class="fr-footer">
          <button
            type="button"
            class="fr-btn"
            data-testid="replace-all-button"
            data-replace-only="true"
            onClick={() => void handleReplaceAll()}
          >
            全部替换
          </button>
          <button
            type="button"
            class="fr-btn"
            data-testid="replace-button"
            data-replace-only="true"
            onClick={() => void handleReplaceCurrent()}
          >
            替换
          </button>
          <button
            type="button"
            class="fr-btn fr-btn-primary"
            data-testid="find-close-button"
            onClick={() => store.setter(closeFindReplaceAtom)}
          >
            关闭
          </button>
        </div>
      </div>
    </Show>
  )
}
