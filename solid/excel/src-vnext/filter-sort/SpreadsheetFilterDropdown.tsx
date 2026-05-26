import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  closeFilterDropdownAtom,
  dispatchSortAtom,
  filterDropdownAtom,
  filterSortErrorAtom,
  filterSortStateAtom,
  filterSortSyncTicketAtom,
  getColumnLabel,
  issueFilterSortSyncTicketAtom,
  setFilterSortAtom,
  setFilterSortErrorAtom,
  type ColumnFilterRule,
  type FilterSortState,
} from '@einfach/spreadsheet-ui-core'

import {
  refreshVisibleProjection,
  spreadsheetProjectionSnapshotAtom,
  useSpreadsheetBackend,
  useSpreadsheetUiStore,
} from '../provider'

export interface SpreadsheetFilterDropdownProps {
  class?: string
  'data-testid'?: string
}

type ConditionKind = 'none' | 'equals' | 'contains' | 'range'

const EMPTY_STATE: FilterSortState = { rules: [], directives: [] }

function isSummaryLabel(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase()
  return normalized === 'total' || normalized === 'summary'
}

function sortFilterValues(values: readonly string[]): string[] {
  return [...values].sort((left, right) => {
    if (left === '') return -1
    if (right === '') return 1
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((value) => rightSet.has(value))
}

function parseNumberInput(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function ruleSummary(rule: ColumnFilterRule): string {
  switch (rule.kind) {
    case 'equals':
      return `= ${rule.value}`
    case 'contains':
      return `* ${rule.value}`
    case 'range':
      if (rule.min !== undefined && rule.max !== undefined) {
        return `${rule.min}..${rule.max}`
      }
      if (rule.min !== undefined) return `>= ${rule.min}`
      if (rule.max !== undefined) return `<= ${rule.max}`
      return 'range'
    case 'list':
      return `${rule.values.length} values`
  }
}

export function SpreadsheetFilterDropdown(props: SpreadsheetFilterDropdownProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const dropdown = useAtomValue(filterDropdownAtom)
  const filterSortState = useAtomValue(filterSortStateAtom)
  const errorText = useAtomValue(filterSortErrorAtom)
  const projectionSnapshot = useAtomValue(spreadsheetProjectionSnapshotAtom)

  const [searchInput, setSearchInput] = createSignal('')
  const [selectedValues, setSelectedValues] = createSignal<string[]>([])
  const [conditionKind, setConditionKind] = createSignal<ConditionKind>('none')
  const [equalsInput, setEqualsInput] = createSignal('')
  const [containsInput, setContainsInput] = createSignal('')
  const [rangeMinInput, setRangeMinInput] = createSignal('')
  const [rangeMaxInput, setRangeMaxInput] = createSignal('')
  const [cachedAvailableValues, setCachedAvailableValues] = createSignal<string[]>([])

  let lastDraftKey = ''
  let cachedValuesKey = ''

  const isOpen = createMemo(() => dropdown().status === 'open')
  const sheetId = createMemo(() => (dropdown().status === 'open' ? dropdown().sheetId! : ''))
  const colIndex = createMemo(() => (dropdown().status === 'open' ? dropdown().colIndex! : -1))
  const columnLabel = createMemo(() =>
    colIndex() >= 0 ? getColumnLabel(colIndex()) : '',
  )
  const currentState = createMemo<FilterSortState>(
    () => filterSortState()[sheetId()] ?? EMPTY_STATE,
  )
  const currentRulesForCol = createMemo<readonly ColumnFilterRule[]>(() =>
    currentState().rules.filter((rule) => rule.colIndex === colIndex()),
  )
  const currentSortForCol = createMemo(() =>
    currentState().directives.find((directive) => directive.colIndex === colIndex()),
  )
  const listRule = createMemo(() =>
    currentRulesForCol().find((rule): rule is Extract<ColumnFilterRule, { kind: 'list' }> =>
      rule.kind === 'list',
    ),
  )

  function collectProjectionValues(): string[] {
    const result = projectionSnapshot().result
    const values = new Set<string>()
    if (result?.sheetId === sheetId()) {
      const rowLabels = new Map<number, string>()
      for (const cell of result.cells) {
        if (cell.col === 0) {
          rowLabels.set(cell.row, cell.displayValue ?? '')
        }
      }
      for (const cell of result.cells) {
        if (cell.col !== colIndex()) continue
        if (cell.row === 0) continue
        if (isSummaryLabel(rowLabels.get(cell.row) ?? '')) continue
        values.add(cell.displayValue ?? '')
      }
    }
    return sortFilterValues([...values])
  }

  createEffect(() => {
    if (!isOpen()) return
    const key = `${sheetId()}::${colIndex()}`
    const projectionValues = collectProjectionValues()
    if (key !== cachedValuesKey) {
      cachedValuesKey = key
      setCachedAvailableValues(projectionValues)
      return
    }
    if (projectionValues.length === 0) return
    setCachedAvailableValues((previous) =>
      sortFilterValues([...new Set([...previous, ...projectionValues])]),
    )
  })

  const availableValues = createMemo(() => {
    const values = new Set(cachedAvailableValues())
    for (const value of listRule()?.values ?? []) {
      values.add(value)
    }
    return sortFilterValues([...values])
  })

  const filteredValues = createMemo(() => {
    const needle = searchInput().trim().toLocaleLowerCase()
    if (!needle) return availableValues()
    return availableValues().filter((value) =>
      (value || t('filterSort.blank')).toLocaleLowerCase().includes(needle),
    )
  })

  const selectedValueSet = createMemo(() => new Set(selectedValues()))
  const allValuesSelected = createMemo(() => sameValues(selectedValues(), availableValues()))
  const visibleValuesSelected = createMemo(() => {
    const visible = filteredValues()
    if (visible.length === 0) return false
    const selected = selectedValueSet()
    return visible.every((value) => selected.has(value))
  })

  createEffect(() => {
    if (!isOpen()) return
    const rules = currentRulesForCol()
    const values = availableValues()
    const key = `${sheetId()}::${colIndex()}::${JSON.stringify(rules)}::${values.join('\u0000')}`
    if (key === lastDraftKey) return
    lastDraftKey = key

    setSearchInput('')
    setSelectedValues(listRule() ? [...listRule()!.values] : values)

    const equalsRule = rules.find((rule) => rule.kind === 'equals')
    const containsRule = rules.find((rule) => rule.kind === 'contains')
    const rangeRule = rules.find((rule) => rule.kind === 'range')
    if (equalsRule?.kind === 'equals') {
      setConditionKind('equals')
      setEqualsInput(equalsRule.value)
      setContainsInput('')
      setRangeMinInput('')
      setRangeMaxInput('')
    } else if (containsRule?.kind === 'contains') {
      setConditionKind('contains')
      setEqualsInput('')
      setContainsInput(containsRule.value)
      setRangeMinInput('')
      setRangeMaxInput('')
    } else if (rangeRule?.kind === 'range') {
      setConditionKind('range')
      setEqualsInput('')
      setContainsInput('')
      setRangeMinInput(rangeRule.min === undefined ? '' : String(rangeRule.min))
      setRangeMaxInput(rangeRule.max === undefined ? '' : String(rangeRule.max))
    } else {
      setConditionKind('equals')
      setEqualsInput('')
      setContainsInput('')
      setRangeMinInput('')
      setRangeMaxInput('')
    }
  })

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
      await refreshVisibleProjection(store, backend, sid)
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
    const sid = sheetId()
    const col = colIndex()
    const next = store.setter(dispatchSortAtom, { sheetId: sid, colIndex: col, direction })
    void syncBackend(sid, next)
  }

  function clearSort() {
    const sid = sheetId()
    const col = colIndex()
    const state = store.getter(filterSortStateAtom)[sid] ?? EMPTY_STATE
    const next = {
      rules: state.rules,
      directives: state.directives.filter((directive) => directive.colIndex !== col),
    }
    store.setter(setFilterSortAtom, { sheetId: sid, state: next })
    void syncBackend(sid, next)
  }

  function clearFilterRules() {
    const sid = sheetId()
    const col = colIndex()
    const state = store.getter(filterSortStateAtom)[sid] ?? EMPTY_STATE
    const next = {
      rules: state.rules.filter((rule) => rule.colIndex !== col),
      directives: state.directives,
    }
    store.setter(setFilterSortAtom, { sheetId: sid, state: next })
    void syncBackend(sid, next)
  }

  function clearColumnFilterSort() {
    const sid = sheetId()
    const col = colIndex()
    const state = store.getter(filterSortStateAtom)[sid] ?? EMPTY_STATE
    const next = {
      rules: state.rules.filter((rule) => rule.colIndex !== col),
      directives: state.directives.filter((directive) => directive.colIndex !== col),
    }
    store.setter(setFilterSortAtom, { sheetId: sid, state: next })
    void syncBackend(sid, next)
  }

  function applyFilterDraft() {
    const col = colIndex()
    const state = currentState()
    const rules: ColumnFilterRule[] = state.rules.filter((rule) => rule.colIndex !== col)
    const values = availableValues()
    const selected = selectedValues().filter((value) => values.includes(value))

    if (values.length > 0 && !sameValues(selected, values)) {
      rules.push({ kind: 'list', colIndex: col, values: selected })
    }

    if (conditionKind() === 'equals' && equalsInput().length > 0) {
      rules.push({ kind: 'equals', colIndex: col, value: equalsInput() })
    } else if (conditionKind() === 'contains' && containsInput().length > 0) {
      rules.push({ kind: 'contains', colIndex: col, value: containsInput() })
    } else if (conditionKind() === 'range') {
      const min = parseNumberInput(rangeMinInput())
      const max = parseNumberInput(rangeMaxInput())
      if (min !== undefined || max !== undefined) {
        rules.push({ kind: 'range', colIndex: col, min, max })
      }
    }

    applyFilterSort({ ...state, rules })
  }

  function toggleValue(value: string, checked: boolean) {
    const selected = new Set(selectedValues())
    if (checked) {
      selected.add(value)
    } else {
      selected.delete(value)
    }
    setSelectedValues(sortFilterValues([...selected]))
  }

  function toggleVisibleValues(checked: boolean) {
    const selected = new Set(selectedValues())
    for (const value of filteredValues()) {
      if (checked) selected.add(value)
      else selected.delete(value)
    }
    setSelectedValues(sortFilterValues([...selected]))
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
        aria-label={t('filterSort.title')}
      >
        <div class="filter-dropdown-header">
          <div>
            <div class="filter-dropdown-title">{t('filterSort.title')}</div>
            <div class="filter-dropdown-subtitle">
              {t('filterSort.column', { column: columnLabel() })}
            </div>
          </div>
          <button
            type="button"
            class="dialog-close-x"
            data-testid="dialog-close-x"
            aria-label={t('dialog.close.label')}
            onClick={() => close()}
          >
            ×
          </button>
        </div>

        <Show when={currentRulesForCol().length > 0 || currentSortForCol()}>
          <div class="filter-dropdown-rules" data-testid="filter-active-summary">
            {currentSortForCol() ? (
              <span class="filter-rule" data-rule-kind="sort">
                {currentSortForCol()!.direction === 'asc'
                  ? t('filterSort.sortAsc')
                  : t('filterSort.sortDesc')}
              </span>
            ) : null}
            {currentRulesForCol().map((rule, i) => (
              <span class="filter-rule" data-rule-index={i} data-rule-kind={rule.kind}>
                {ruleSummary(rule)}
              </span>
            ))}
          </div>
        </Show>

        <div class="filter-section">
          <div class="filter-section-title">{t('filterSort.sortSection')}</div>
          <div class="filter-action-row">
            <button
              type="button"
              class="filter-btn"
              data-testid="filter-sort-asc"
              onClick={() => replaceDirective('asc')}
            >
              {t('filterSort.sortAsc')}
            </button>
            <button
              type="button"
              class="filter-btn"
              data-testid="filter-sort-desc"
              onClick={() => replaceDirective('desc')}
            >
              {t('filterSort.sortDesc')}
            </button>
            <button
              type="button"
              class="filter-btn"
              data-testid="filter-clear-sort"
              onClick={() => clearSort()}
            >
              {t('filterSort.clearSort')}
            </button>
          </div>
        </div>

        <div class="filter-section">
          <div class="filter-section-title">{t('filterSort.valuesSection')}</div>
          <input
            class="filter-search-input"
            data-testid="filter-search-input"
            type="search"
            value={searchInput()}
            placeholder={t('filterSort.searchValues')}
            onInput={(event) => setSearchInput(event.currentTarget.value)}
          />
          <label class="filter-value-option filter-value-option-all">
            <input
              data-testid="filter-values-select-visible"
              type="checkbox"
              checked={visibleValuesSelected()}
              onChange={(event) => toggleVisibleValues(event.currentTarget.checked)}
            />
            <span>{t('filterSort.selectVisible')}</span>
          </label>
          <div class="filter-values-list" data-testid="filter-values-list">
            <Show
              when={filteredValues().length > 0}
              fallback={<div class="filter-empty-values">{t('filterSort.noValues')}</div>}
            >
              {filteredValues().map((value) => (
                <label class="filter-value-option" data-filter-value={value}>
                  <input
                    type="checkbox"
                    data-testid={`filter-value-${value === '' ? '__blank__' : value}`}
                    checked={selectedValueSet().has(value)}
                    onChange={(event) => toggleValue(value, event.currentTarget.checked)}
                  />
                  <span>{value === '' ? t('filterSort.blank') : value}</span>
                </label>
              ))}
            </Show>
          </div>
          <div class="filter-values-count" data-testid="filter-values-count">
            {selectedValues().length} / {availableValues().length}
            {allValuesSelected() ? ` ${t('filterSort.allSelected')}` : ''}
          </div>
        </div>

        <div class="filter-section">
          <div class="filter-section-title">{t('filterSort.conditionSection')}</div>
          <select
            class="filter-condition-select"
            data-testid="filter-condition-kind"
            value={conditionKind()}
            onChange={(event) => setConditionKind(event.currentTarget.value as ConditionKind)}
          >
            <option value="none">{t('filterSort.conditionNone')}</option>
            <option value="equals">{t('filterSort.equals')}</option>
            <option value="contains">{t('filterSort.contains')}</option>
            <option value="range">{t('filterSort.range')}</option>
          </select>

          <Show when={conditionKind() === 'equals'}>
            <input
              id="filter-equals-input"
              class="filter-condition-input filter-equals-input"
              data-testid="filter-equals-input"
              type="text"
              value={equalsInput()}
              placeholder={t('filterSort.equals')}
              onInput={(event) => setEqualsInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  applyFilterDraft()
                }
              }}
            />
          </Show>
          <Show when={conditionKind() === 'contains'}>
            <input
              class="filter-condition-input"
              data-testid="filter-contains-input"
              type="text"
              value={containsInput()}
              placeholder={t('filterSort.contains')}
              onInput={(event) => setContainsInput(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  applyFilterDraft()
                }
              }}
            />
          </Show>
          <Show when={conditionKind() === 'range'}>
            <div class="filter-range-row">
              <input
                class="filter-condition-input"
                data-testid="filter-range-min-input"
                type="number"
                value={rangeMinInput()}
                placeholder={t('filterSort.rangeMin')}
                onInput={(event) => setRangeMinInput(event.currentTarget.value)}
              />
              <input
                class="filter-condition-input"
                data-testid="filter-range-max-input"
                type="number"
                value={rangeMaxInput()}
                placeholder={t('filterSort.rangeMax')}
                onInput={(event) => setRangeMaxInput(event.currentTarget.value)}
              />
            </div>
          </Show>
        </div>

        <Show when={errorText().length > 0}>
          <div class="filter-error" data-testid="filter-error-text" role="alert">
            {errorText()}
          </div>
        </Show>

        <div class="filter-footer">
          <div class="filter-footer-group">
            <button
              type="button"
              class="filter-btn filter-btn-secondary"
              data-testid="filter-clear-filter"
              onClick={() => clearFilterRules()}
            >
              {t('filterSort.clearFilter')}
            </button>
            <button
              type="button"
              class="filter-btn filter-btn-secondary"
              data-testid="filter-clear"
              onClick={() => clearColumnFilterSort()}
            >
              {t('filterSort.clear')}
            </button>
          </div>
          <div class="filter-footer-group">
            <button
              type="button"
              class="filter-btn filter-btn-secondary"
              data-testid="filter-close"
              onClick={() => close()}
            >
              {t('filterSort.cancel')}
            </button>
            <button
              type="button"
              class="filter-btn filter-btn-primary"
              data-testid="filter-add-equals"
              onClick={() => applyFilterDraft()}
            >
              {t('filterSort.apply')}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
