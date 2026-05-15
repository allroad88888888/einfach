import { Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  closeFilterDropdownAtom,
  filterDropdownAtom,
  filterSortStateAtom,
  setFilterSortAtom,
  type ColumnFilterRule,
  type FilterSortState,
  type SortDirective,
} from '@einfach/spreadsheet-ui-core'

import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

export interface SpreadsheetFilterDropdownProps {
  class?: string
  'data-testid'?: string
}

export function SpreadsheetFilterDropdown(props: SpreadsheetFilterDropdownProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const dropdown = useAtomValue(filterDropdownAtom)
  const filterSortState = useAtomValue(filterSortStateAtom)

  const isOpen = () => dropdown().status === 'open'
  const sheetId = () => (dropdown().status === 'open' ? dropdown().sheetId! : '')
  const colIndex = () => (dropdown().status === 'open' ? dropdown().colIndex! : -1)

  function currentState(): FilterSortState {
    return filterSortState()[sheetId()] ?? { rules: [], directives: [] }
  }

  function currentRulesForCol(): readonly ColumnFilterRule[] {
    return currentState().rules.filter((r) => r.colIndex === colIndex())
  }

  function applyFilterSort(next: FilterSortState) {
    const sid = sheetId()
    store.setter(setFilterSortAtom, { sheetId: sid, state: next })
    if (backend.setFilterSort) {
      void backend.setFilterSort({
        kind: 'set-filter-sort',
        sheetId: sid,
        rules: next.rules,
        directives: next.directives,
      })
    }
  }

  function replaceDirective(direction: 'asc' | 'desc') {
    const col = colIndex()
    const state = currentState()
    const newDirective: SortDirective = { colIndex: col, direction }
    const directives = state.directives.filter((d) => d.colIndex !== col).concat(newDirective)
    applyFilterSort({ ...state, directives })
  }

  function clearColFilter() {
    const col = colIndex()
    const state = currentState()
    const rules = state.rules.filter((r) => r.colIndex !== col)
    applyFilterSort({ ...state, rules })
  }

  function addEqualsFilter() {
    const value = window.prompt('Filter value:')
    if (value === null) return
    const col = colIndex()
    const state = currentState()
    const rule: ColumnFilterRule = { kind: 'equals', colIndex: col, value }
    const rules = state.rules.filter((r) => !(r.kind === 'equals' && r.colIndex === col)).concat(rule)
    applyFilterSort({ ...state, rules })
  }

  function close() {
    store.setter(closeFilterDropdownAtom)
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`filter-dropdown spreadsheet-filter-dropdown ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'filter-dropdown'}
        data-sheet-id={sheetId()}
        data-col-index={colIndex()}
      >
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
        <button
          type="button"
          class="filter-btn"
          data-testid="filter-add-equals"
          onClick={() => addEqualsFilter()}
        >
          Add equals filter
        </button>
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
