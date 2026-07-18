import { Show, createEffect, createMemo, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  captureFilterSortCapabilityAtom,
  closeFilterDropdownAtom,
  filterDropdownAtom,
  filterSortCapabilityAtom,
  filterSortCanCloseAtom,
  filterSortDraftAtom,
  filterSortErrorAtom,
  filterSortLifecycleAtom,
  filterSortStateAtom,
  getColumnLabel,
  runFilterSortMutationAtom,
  retryFilterSortRefreshAtom,
  updateFilterSortAvailableValuesAtom,
  updateFilterSortDraftAtom,
  type ColumnFilterRule,
  type FilterConditionKind,
  type FilterSortDraftPatch,
  type FilterSortMutationIntent,
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

const EMPTY_STATE: FilterSortState = { rules: [], directives: [] }

function isSummaryLabel(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase()
  return normalized === 'total' || normalized === 'summary'
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every((value) => rightSet.has(value))
}

function ruleSummary(rule: ColumnFilterRule): string {
  switch (rule.kind) {
    case 'equals':
      return `= ${rule.value}`
    case 'contains':
      return `* ${rule.value}`
    case 'range':
      if (rule.min !== undefined && rule.max !== undefined) return `${rule.min}..${rule.max}`
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
  const draft = useAtomValue(filterSortDraftAtom)
  const lifecycle = useAtomValue(filterSortLifecycleAtom)
  const capabilityAvailable = useAtomValue(filterSortCapabilityAtom)
  const canClose = useAtomValue(filterSortCanCloseAtom)
  const errorText = useAtomValue(filterSortErrorAtom)
  const projectionSnapshot = useAtomValue(spreadsheetProjectionSnapshotAtom)

  const isOpen = createMemo(() => dropdown().status === 'open')
  const sheetId = createMemo(() => (dropdown().status === 'open' ? dropdown().sheetId! : ''))
  const colIndex = createMemo(() => (dropdown().status === 'open' ? dropdown().colIndex! : -1))
  const columnLabel = createMemo(() => (colIndex() >= 0 ? getColumnLabel(colIndex()) : ''))
  const currentState = createMemo<FilterSortState>(
    () => filterSortState()[sheetId()] ?? EMPTY_STATE,
  )
  const currentRulesForCol = createMemo<readonly ColumnFilterRule[]>(() =>
    currentState().rules.filter((rule) => rule.colIndex === colIndex()),
  )
  const currentSortForCol = createMemo(() =>
    currentState().directives.find((directive) => directive.colIndex === colIndex()),
  )
  const availableValues = createMemo(() => draft().availableValues)
  const filteredValues = createMemo(() => {
    const needle = draft().searchInput.trim().toLocaleLowerCase()
    if (!needle) return availableValues()
    return availableValues().filter((value) =>
      (value || t('filterSort.blank')).toLocaleLowerCase().includes(needle),
    )
  })
  const selectedValueSet = createMemo(() => new Set(draft().selectedValues))
  const allValuesSelected = createMemo(() => sameValues(draft().selectedValues, availableValues()))
  const visibleValuesSelected = createMemo(() => {
    const visible = filteredValues()
    if (visible.length === 0) return false
    const selected = selectedValueSet()
    return visible.every((value) => selected.has(value))
  })
  const mutationDisabled = createMemo(() => {
    const status = lifecycle().status
    return (
      !capabilityAvailable() ||
      status === 'pending' ||
      status === 'local-acknowledged' ||
      status === 'refreshing' ||
      status === 'refresh-failed' ||
      status === 'outcome-unknown'
    )
  })

  // The capability witness is projected into Core; the backend object is never retained there.
  createEffect(() => {
    store.setter(captureFilterSortCapabilityAtom, backend)
  })

  // DOM/projection collection stays in Solid; Core owns cache merging and selection semantics.
  createEffect(() => {
    const currentDropdown = dropdown()
    const currentDraft = draft()
    const result = projectionSnapshot().result
    if (
      currentDropdown.status !== 'open' ||
      currentDraft.sheetId !== currentDropdown.sheetId ||
      currentDraft.colIndex !== currentDropdown.colIndex ||
      result?.sheetId !== currentDropdown.sheetId
    ) {
      return
    }

    const rowLabels = new Map<number, string>()
    for (const cell of result.cells) {
      if (cell.col === 0) rowLabels.set(cell.row, cell.displayValue ?? '')
    }
    const values = new Set<string>()
    for (const cell of result.cells) {
      if (cell.col !== currentDropdown.colIndex || cell.row === 0) continue
      if (isSummaryLabel(rowLabels.get(cell.row) ?? '')) continue
      values.add(cell.displayValue ?? '')
    }
    store.setter(updateFilterSortAvailableValuesAtom, {
      sessionId: currentDraft.sessionId,
      sheetId: currentDropdown.sheetId!,
      colIndex: currentDropdown.colIndex!,
      values: [...values],
    })
  })

  function updateDraft(patch: FilterSortDraftPatch) {
    store.setter(updateFilterSortDraftAtom, { sessionId: draft().sessionId, patch })
  }

  function run(intent: FilterSortMutationIntent) {
    void store.setter(runFilterSortMutationAtom, {
      source: backend,
      sessionId: draft().sessionId,
      intent,
      refreshProjection: (targetSheetId) => refreshVisibleProjection(store, backend, targetSheetId),
    })
  }

  function toggleValue(value: string, checked: boolean) {
    const selected = new Set(draft().selectedValues)
    if (checked) selected.add(value)
    else selected.delete(value)
    updateDraft({ selectedValues: [...selected], selectionMode: 'explicit' })
  }

  function toggleVisibleValues(checked: boolean) {
    const selected = new Set(draft().selectedValues)
    for (const value of filteredValues()) {
      if (checked) selected.add(value)
      else selected.delete(value)
    }
    updateDraft({ selectedValues: [...selected], selectionMode: 'explicit' })
  }

  function close() {
    store.setter(closeFilterDropdownAtom)
  }

  function retryRefresh() {
    void store.setter(retryFilterSortRefreshAtom, {
      refreshProjection: (targetSheetId) => refreshVisibleProjection(store, backend, targetSheetId),
    })
  }

  createEffect(() => {
    if (!isOpen()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (!canClose()) return
      store.setter(closeFilterDropdownAtom)
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
        data-filter-sort-status={lifecycle().status}
        data-filter-sort-can-close={canClose() ? 'true' : 'false'}
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
            disabled={!canClose()}
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
            {currentRulesForCol().map((rule, index) => (
              <span class="filter-rule" data-rule-index={index} data-rule-kind={rule.kind}>
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
              disabled={mutationDisabled()}
              onClick={() => run({ kind: 'sort', direction: 'asc' })}
            >
              {t('filterSort.sortAsc')}
            </button>
            <button
              type="button"
              class="filter-btn"
              data-testid="filter-sort-desc"
              disabled={mutationDisabled()}
              onClick={() => run({ kind: 'sort', direction: 'desc' })}
            >
              {t('filterSort.sortDesc')}
            </button>
            <button
              type="button"
              class="filter-btn"
              data-testid="filter-clear-sort"
              disabled={mutationDisabled()}
              onClick={() => run({ kind: 'clear-sort' })}
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
            value={draft().searchInput}
            disabled={mutationDisabled()}
            placeholder={t('filterSort.searchValues')}
            onInput={(event) => updateDraft({ searchInput: event.currentTarget.value })}
          />
          <label class="filter-value-option filter-value-option-all">
            <input
              data-testid="filter-values-select-visible"
              type="checkbox"
              checked={visibleValuesSelected()}
              disabled={mutationDisabled()}
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
                    disabled={mutationDisabled()}
                    onChange={(event) => toggleValue(value, event.currentTarget.checked)}
                  />
                  <span>{value === '' ? t('filterSort.blank') : value}</span>
                </label>
              ))}
            </Show>
          </div>
          <div class="filter-values-count" data-testid="filter-values-count">
            {draft().selectedValues.length} / {availableValues().length}
            {allValuesSelected() ? ` ${t('filterSort.allSelected')}` : ''}
          </div>
        </div>

        <div class="filter-section">
          <div class="filter-section-title">{t('filterSort.conditionSection')}</div>
          <select
            class="filter-condition-select"
            data-testid="filter-condition-kind"
            value={draft().conditionKind}
            disabled={mutationDisabled()}
            onChange={(event) =>
              updateDraft({ conditionKind: event.currentTarget.value as FilterConditionKind })
            }
          >
            <option value="none">{t('filterSort.conditionNone')}</option>
            <option value="equals">{t('filterSort.equals')}</option>
            <option value="contains">{t('filterSort.contains')}</option>
            <option value="range">{t('filterSort.range')}</option>
          </select>

          <Show when={draft().conditionKind === 'equals'}>
            <input
              id="filter-equals-input"
              class="filter-condition-input filter-equals-input"
              data-testid="filter-equals-input"
              type="text"
              value={draft().equalsInput}
              disabled={mutationDisabled()}
              placeholder={t('filterSort.equals')}
              onInput={(event) => updateDraft({ equalsInput: event.currentTarget.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !mutationDisabled()) {
                  event.preventDefault()
                  run({ kind: 'apply-draft' })
                }
              }}
            />
          </Show>
          <Show when={draft().conditionKind === 'contains'}>
            <input
              class="filter-condition-input"
              data-testid="filter-contains-input"
              type="text"
              value={draft().containsInput}
              disabled={mutationDisabled()}
              placeholder={t('filterSort.contains')}
              onInput={(event) => updateDraft({ containsInput: event.currentTarget.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !mutationDisabled()) {
                  event.preventDefault()
                  run({ kind: 'apply-draft' })
                }
              }}
            />
          </Show>
          <Show when={draft().conditionKind === 'range'}>
            <div class="filter-range-row">
              <input
                class="filter-condition-input"
                data-testid="filter-range-min-input"
                type="number"
                value={draft().rangeMinInput}
                disabled={mutationDisabled()}
                placeholder={t('filterSort.rangeMin')}
                onInput={(event) => updateDraft({ rangeMinInput: event.currentTarget.value })}
              />
              <input
                class="filter-condition-input"
                data-testid="filter-range-max-input"
                type="number"
                value={draft().rangeMaxInput}
                disabled={mutationDisabled()}
                placeholder={t('filterSort.rangeMax')}
                onInput={(event) => updateDraft({ rangeMaxInput: event.currentTarget.value })}
              />
            </div>
          </Show>
        </div>

        <Show when={errorText().length > 0}>
          <div class="filter-error" data-testid="filter-error-text" role="alert">
            {errorText()}
          </div>
        </Show>

        <Show when={lifecycle().status === 'refresh-failed'}>
          <button
            type="button"
            class="filter-btn filter-btn-secondary"
            data-testid="filter-refresh-retry"
            aria-label="Retry filter and sort refresh"
            onClick={retryRefresh}
          >
            ↻
          </button>
        </Show>

        <div class="filter-footer">
          <div class="filter-footer-group">
            <button
              type="button"
              class="filter-btn filter-btn-secondary"
              data-testid="filter-clear-filter"
              disabled={mutationDisabled()}
              onClick={() => run({ kind: 'clear-filter' })}
            >
              {t('filterSort.clearFilter')}
            </button>
            <button
              type="button"
              class="filter-btn filter-btn-secondary"
              data-testid="filter-clear"
              disabled={mutationDisabled()}
              onClick={() => run({ kind: 'clear-column' })}
            >
              {t('filterSort.clear')}
            </button>
          </div>
          <div class="filter-footer-group">
            <button
              type="button"
              class="filter-btn filter-btn-secondary"
              data-testid="filter-close"
              disabled={!canClose()}
              onClick={() => close()}
            >
              {t('filterSort.cancel')}
            </button>
            <button
              type="button"
              class="filter-btn filter-btn-primary"
              data-testid="filter-add-equals"
              disabled={mutationDisabled()}
              onClick={() => run({ kind: 'apply-draft' })}
            >
              {t('filterSort.apply')}
            </button>
          </div>
        </div>
      </div>
    </Show>
  )
}
