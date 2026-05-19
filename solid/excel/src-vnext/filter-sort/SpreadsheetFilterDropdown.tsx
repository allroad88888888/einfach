import { Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  clearColumnFilterSortAtom,
  closeFilterDropdownAtom,
  filterDropdownAtom,
  filterSortErrorAtom,
  filterSortStateAtom,
  filterSortSyncTicketAtom,
  issueFilterSortSyncTicketAtom,
  setFilterSortAtom,
  setFilterSortErrorAtom,
  type ColumnFilterRule,
  type FilterSortState,
  type SortDirective,
} from '@einfach/spreadsheet-ui-core'

import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

export interface SpreadsheetFilterDropdownProps {
  class?: string
  'data-testid'?: string
}

const EMPTY_STATE: FilterSortState = { rules: [], directives: [] }

export function SpreadsheetFilterDropdown(props: SpreadsheetFilterDropdownProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const dropdown = useAtomValue(filterDropdownAtom)
  const filterSortState = useAtomValue(filterSortStateAtom)
  const errorText = useAtomValue(filterSortErrorAtom)
  const [equalsInput, setEqualsInput] = createSignal('')

  const isOpen = createMemo(() => dropdown().status === 'open')
  const sheetId = createMemo(() => (dropdown().status === 'open' ? dropdown().sheetId! : ''))
  const colIndex = createMemo(() => (dropdown().status === 'open' ? dropdown().colIndex! : -1))
  const currentState = createMemo<FilterSortState>(
    () => filterSortState()[sheetId()] ?? EMPTY_STATE,
  )
  const currentRulesForCol = createMemo<readonly ColumnFilterRule[]>(() =>
    currentState().rules.filter((r) => r.colIndex === colIndex()),
  )

  createEffect(
    on(
      () => `${sheetId()}::${colIndex()}`,
      () => setEqualsInput(''),
      { defer: true },
    ),
  )

  async function syncBackend(sid: string, next: FilterSortState) {
    if (!backend.setFilterSort) {
      store.setter(setFilterSortErrorAtom, null)
      return
    }
    const ticket = store.setter(issueFilterSortSyncTicketAtom) as number
    try {
      await backend.setFilterSort({
        kind: 'set-filter-sort',
        sheetId: sid,
        rules: next.rules,
        directives: next.directives,
      })
      if (ticket !== store.getter(filterSortSyncTicketAtom)) return
      store.setter(setFilterSortErrorAtom, null)
    } catch (err) {
      if (ticket !== store.getter(filterSortSyncTicketAtom)) return
      store.setter(setFilterSortErrorAtom, err)
    }
  }

  function applyFilterSort(next: FilterSortState) {
    const sid = sheetId()
    store.setter(setFilterSortAtom, { sheetId: sid, state: next })
    void syncBackend(sid, next)
  }

  function replaceDirective(direction: 'asc' | 'desc') {
    const col = colIndex()
    const state = currentState()
    const newDirective: SortDirective = { colIndex: col, direction }
    const directives = state.directives.filter((d) => d.colIndex !== col).concat(newDirective)
    applyFilterSort({ ...state, directives })
  }

  function clearColFilter() {
    const sid = sheetId()
    const col = colIndex()
    store.setter(clearColumnFilterSortAtom, { sheetId: sid, colIndex: col })
    const next = store.getter(filterSortStateAtom)[sid] ?? EMPTY_STATE
    void syncBackend(sid, next)
  }

  function applyEqualsFilter() {
    const value = equalsInput()
    const col = colIndex()
    const state = currentState()
    const rule: ColumnFilterRule = { kind: 'equals', colIndex: col, value }
    const rules = state.rules
      .filter((r) => !(r.kind === 'equals' && r.colIndex === col))
      .concat(rule)
    applyFilterSort({ ...state, rules })
  }

  function close() {
    store.setter(closeFilterDropdownAtom)
  }

  createEffect(() => {
    if (!isOpen()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        store.setter(closeFilterDropdownAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  return (
    <Show when={isOpen()}>
      <div
        class={`filter-dropdown spreadsheet-filter-dropdown ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'filter-dropdown'}
        data-sheet-id={sheetId()}
        data-col-index={colIndex()}
        role="dialog"
        aria-label="Filter and sort"
      >
        <button
          type="button"
          class="dialog-close-x"
          data-testid="dialog-close-x"
          aria-label={t('dialog.close.label')}
          onClick={() => close()}
        >
          ×
        </button>
        <div class="filter-dropdown-rules">
          {currentRulesForCol().map((rule, i) => (
            <div class="filter-rule" data-rule-index={i} data-rule-kind={rule.kind}>
              {rule.kind === 'equals' ? `= ${rule.value}` : rule.kind}
            </div>
          ))}
        </div>
        <button
          type="button"
          class="filter-btn"
          data-testid="filter-sort-asc"
          onClick={() => replaceDirective('asc')}
        >
          Sort A→Z
        </button>
        <button
          type="button"
          class="filter-btn"
          data-testid="filter-sort-desc"
          onClick={() => replaceDirective('desc')}
        >
          Sort Z→A
        </button>
        <button
          type="button"
          class="filter-btn"
          data-testid="filter-clear"
          onClick={() => clearColFilter()}
        >
          Clear filter
        </button>
        <div class="filter-equals-row">
          <label class="filter-equals-label" for="filter-equals-input">
            Equals
          </label>
          <input
            id="filter-equals-input"
            class="filter-equals-input"
            data-testid="filter-equals-input"
            type="text"
            value={equalsInput()}
            onInput={(e) => setEqualsInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyEqualsFilter()
              }
            }}
          />
          <button
            type="button"
            class="filter-btn"
            data-testid="filter-add-equals"
            onClick={() => applyEqualsFilter()}
          >
            Add equals filter
          </button>
        </div>
        <Show when={errorText().length > 0}>
          <div class="filter-error" data-testid="filter-error-text" role="alert">
            {errorText()}
          </div>
        </Show>
        <button
          type="button"
          class="filter-btn"
          data-testid="filter-close"
          onClick={() => close()}
        >
          Close
        </button>
      </div>
    </Show>
  )
}
