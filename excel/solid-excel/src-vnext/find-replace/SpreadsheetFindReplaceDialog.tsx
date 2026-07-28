import { Show, createEffect, onCleanup } from 'solid-js'
import { useAtomValue, useSetAtom } from '@einfach/solid'
import { useT } from '../../src/i18n'
import type {
  FindReplaceScope,
  ReplaceMatchesRequest,
  ReplaceMatchesResult,
} from '@einfach/spreadsheet-ui-core'
import {
  captureFindReplaceCapabilityAtom,
  closeFindReplaceAtom,
  findReplaceCapabilityProjectionAtom,
  findReplaceCursorAtom,
  findReplaceErrorAtom,
  findReplaceFormAtom,
  findReplaceMutationBlockedAtom,
  findReplaceOpenAtom,
  findReplacePendingAtom,
  findReplaceRefreshRecoveryAtom,
  replaceAllCappedAtom,
  runFindReplaceMutationAtom,
  runFindReplaceRefreshRecoveryAtom,
  runFindReplaceSearchAtom,
  selectionSnapshotAtom,
  stepFindReplaceAtom,
  syncFindReplaceTargetAtom,
  updateFindReplaceFormAtom,
  workspaceSessionAtom,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'
import { refreshVisibleProjection } from '../provider/projection-refresh'
import './find-replace-dialog.css'

export interface SpreadsheetFindReplaceDialogProps {
  class?: string
  'data-testid'?: string
}

export function SpreadsheetFindReplaceDialog(props: SpreadsheetFindReplaceDialogProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const searchRange = backend.searchRange?.bind(backend)
  const replaceMatches = backend.replaceMatches?.bind(backend)
  const capability = useAtomValue(findReplaceCapabilityProjectionAtom)
  const isOpen = useAtomValue(findReplaceOpenAtom)
  const cursor = useAtomValue(findReplaceCursorAtom)
  const error = useAtomValue(findReplaceErrorAtom)
  const form = useAtomValue(findReplaceFormAtom)
  const mutationBlocked = useAtomValue(findReplaceMutationBlockedAtom)
  const pending = useAtomValue(findReplacePendingAtom)
  const refreshRecovery = useAtomValue(findReplaceRefreshRecoveryAtom)
  const replaceAllCapped = useAtomValue(replaceAllCappedAtom)
  const selectionSnapshot = useAtomValue(selectionSnapshotAtom)
  const workspaceSession = useAtomValue(workspaceSessionAtom)
  const closeDialog = useSetAtom(closeFindReplaceAtom)
  const runMutation = useSetAtom(runFindReplaceMutationAtom)
  const runRefreshRecovery = useSetAtom(runFindReplaceRefreshRecoveryAtom)
  const runSearchCommand = useSetAtom(runFindReplaceSearchAtom)
  const step = useSetAtom(stepFindReplaceAtom)
  const syncTarget = useSetAtom(syncFindReplaceTargetAtom)
  const updateForm = useSetAtom(updateFindReplaceFormAtom)

  createEffect(() => {
    store.setter(captureFindReplaceCapabilityAtom, backend)
  })

  createEffect(() => {
    if (!isOpen()) return
    workspaceSession()
    selectionSnapshot()
    syncTarget()
  })

  createEffect(() => {
    if (!isOpen()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeDialog()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  function runSearch() {
    if (!capability().findEnabled) return
    return runSearchCommand({
      searchRange,
    })
  }

  function handleFindStep(direction: 1 | -1) {
    if (!capability().findEnabled) return
    return step({
      direction,
      searchRange,
    })
  }

  function acceptAcknowledgedResult(_result: ReplaceMatchesResult, request: ReplaceMatchesRequest) {
    const sheetId = request.coords[0]?.sheetId
    if (sheetId === undefined) return
    return refreshVisibleProjection(store, backend, sheetId)
  }

  function handleReplace(action: 'replace-current' | 'replace-all') {
    if (!capability().replaceEnabled) return
    return runMutation({
      action,
      replaceMatches,
      searchRange,
      acceptAcknowledgedResult,
    })
  }

  function handleRefreshRecovery() {
    if (!capability().findEnabled) return
    return runRefreshRecovery({
      searchRange,
      acceptAcknowledgedResult,
    })
  }

  function statusText() {
    const c = cursor()
    if (c.status === 'idle') return ''
    if (c.status === 'searching') return t('findReplace.status.searching')
    if (c.status === 'error') return t('findReplace.status.failed')
    if (c.totalCount === 0) return t('findReplace.status.noMatches')
    return t('findReplace.status.count', {
      current: c.currentIndex + 1,
      total: c.totalCount,
    })
  }

  function errorText() {
    return error()?.message ?? ''
  }

  function replaceDisabled() {
    return pending() || mutationBlocked() || !capability().replaceEnabled
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`find-replace-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'find-replace-dialog'}
        data-active-tab={form().activeTab}
        data-capability={capability().capability}
        role="dialog"
        aria-label={t('findReplace.title')}
      >
        <div class="fr-header">
          <span class="fr-title">{t('findReplace.title')}</span>
          <button
            type="button"
            class="dialog-close-x"
            data-testid="dialog-close-x"
            aria-label={t('dialog.close.label')}
            onClick={closeDialog}
          >
            ×
          </button>
        </div>

        <div class="fr-tabs" role="tablist">
          <button
            type="button"
            class="fr-tab"
            role="tab"
            aria-selected={form().activeTab === 'find'}
            data-testid="find-tab"
            onClick={() => updateForm({ activeTab: 'find' })}
          >
            {t('findReplace.findTab')}
          </button>
          <button
            type="button"
            class="fr-tab"
            role="tab"
            aria-selected={form().activeTab === 'replace'}
            data-testid="replace-tab"
            disabled={!capability().replaceEnabled}
            onClick={() => updateForm({ activeTab: 'replace' })}
          >
            {t('findReplace.replaceTab')}
          </button>
        </div>

        <div class="fr-body">
          <div class="fr-field">
            <label class="fr-field-label" for="find-needle">
              {t('findReplace.findWhat')}
            </label>
            <input
              id="find-needle"
              class="fr-input"
              data-testid="find-needle-input"
              type="text"
              value={form().needle}
              onInput={(e) => updateForm({ needle: e.currentTarget.value })}
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
                aria-label={t('findReplace.prev')}
                title={t('findReplace.prev')}
                disabled={pending() || !capability().findEnabled}
                onClick={() => void handleFindStep(-1)}
              >
                ↑
              </button>
              <button
                type="button"
                class="fr-step-btn"
                data-testid="find-next-button"
                aria-label={t('findReplace.next')}
                title={t('findReplace.next')}
                disabled={pending() || !capability().findEnabled}
                onClick={() => void handleFindStep(1)}
              >
                ↓
              </button>
            </span>
          </div>

          <div class="fr-field fr-field-replace" data-replace-only="true">
            <label class="fr-field-label" for="find-replacement">
              {t('findReplace.replaceWith')}
            </label>
            <input
              id="find-replacement"
              class="fr-input"
              data-testid="find-replacement-input"
              type="text"
              value={form().replacement}
              disabled={!capability().replaceEnabled}
              onInput={(e) => updateForm({ replacement: e.currentTarget.value })}
            />
          </div>

          <div class="fr-options">
            <label class="fr-option">
              <input
                type="checkbox"
                data-testid="find-opt-case-sensitive"
                checked={form().caseSensitive}
                onChange={(e) => updateForm({ caseSensitive: e.currentTarget.checked })}
              />
              {t('findReplace.caseSensitive')}
            </label>
            <label class="fr-option">
              <input
                type="checkbox"
                data-testid="find-opt-whole-match"
                checked={form().wholeMatch}
                onChange={(e) => updateForm({ wholeMatch: e.currentTarget.checked })}
              />
              {t('findReplace.wholeMatch')}
            </label>
            <label class="fr-option">
              <input
                type="checkbox"
                data-testid="find-opt-formulas"
                checked={form().searchFormulas}
                onChange={(e) => updateForm({ searchFormulas: e.currentTarget.checked })}
              />
              {t('findReplace.searchFormulas')}
            </label>
            <label class="fr-option">
              <input
                type="checkbox"
                data-testid="find-opt-regex"
                checked={form().regex}
                onChange={(e) => updateForm({ regex: e.currentTarget.checked })}
              />
              {t('findReplace.regex')}
            </label>
          </div>

          <div class="fr-scope">
            <label class="fr-field-label" for="find-scope-select">
              {t('findReplace.scope')}
            </label>
            <select
              id="find-scope-select"
              class="fr-select"
              data-testid="find-scope-select"
              value={form().scope}
              onChange={(e) => updateForm({ scope: e.currentTarget.value as FindReplaceScope })}
            >
              <option value="sheet">{t('findReplace.scope.sheet')}</option>
              <option value="workbook" disabled>
                {t('findReplace.scope.workbook')}
              </option>
              <option value="current-selection">{t('findReplace.scope.selection')}</option>
            </select>
          </div>
        </div>

        <div class="fr-status" data-testid="find-status-text" aria-live="polite">
          {statusText()}
        </div>
        <Show when={replaceAllCapped()}>
          <div class="fr-capped" data-testid="replace-all-capped-text" role="status">
            {t('findReplace.replaceAll.capped', {
              acknowledged: replaceAllCapped()?.acknowledgedProjectionCount ?? 0,
              total: replaceAllCapped()?.totalCount ?? 0,
            })}
          </div>
        </Show>
        <Show when={errorText()}>
          <div class="fr-error" data-testid="find-error-text" role="alert">
            {errorText()}
          </div>
        </Show>
        <Show when={refreshRecovery().status !== 'idle'}>
          <div
            class="fr-status"
            data-testid="find-refresh-status"
            data-phase={refreshRecovery().phase ?? undefined}
            role="status"
          >
            {t('findReplace.status.refreshing')}
          </div>
        </Show>

        <div class="fr-footer">
          <Show when={refreshRecovery().status === 'required'}>
            <button
              type="button"
              class="fr-btn"
              data-testid="find-refresh-retry-button"
              disabled={!capability().findEnabled}
              onClick={() => void handleRefreshRecovery()}
            >
              {t('findReplace.action.retryRefresh')}
            </button>
          </Show>
          <button
            type="button"
            class="fr-btn"
            data-testid="replace-all-button"
            data-replace-only="true"
            disabled={replaceDisabled()}
            onClick={() => void handleReplace('replace-all')}
          >
            {t('findReplace.replaceAll')}
          </button>
          <button
            type="button"
            class="fr-btn"
            data-testid="replace-button"
            data-replace-only="true"
            disabled={replaceDisabled()}
            onClick={() => void handleReplace('replace-current')}
          >
            {t('findReplace.replace')}
          </button>
          <button
            type="button"
            class="fr-btn fr-btn-primary"
            data-testid="find-close-button"
            onClick={closeDialog}
          >
            {t('findReplace.close')}
          </button>
        </div>
      </div>
    </Show>
  )
}
