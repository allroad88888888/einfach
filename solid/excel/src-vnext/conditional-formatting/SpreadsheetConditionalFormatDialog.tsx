/** @jsxImportSource solid-js */

import { Show, For, createSignal, createEffect, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  conditionalFormatEditorAtom,
  conditionalFormatRulesCacheAtom,
  closeConditionalFormatEditorAtom,
  selectionSnapshotAtom,
  setConditionalFormatRulesAtom,
  workspaceSessionAtom,
  type ConditionalFormatRuleEntry,
  type ConditionalFormatRuleKind,
  type ConditionalFormatScope,
} from '@einfach/spreadsheet-ui-core'
import {
  refreshVisibleProjection,
  useSpreadsheetBackend,
  useSpreadsheetUiStore,
} from '../provider'

// Pull in the dialog stylesheet as a side-effect import. Vite picks the
// dynamic-import target up statically and bundles the CSS into the chunk;
// the runtime guard skips evaluation under jest so unit tests aren't
// blocked when no CSS transform is configured. The co-located
// `.css.d.ts` keeps tsc satisfied under the Bundler moduleResolution.
if (typeof process === 'undefined' || !process.env.JEST_WORKER_ID) {
  void import('./conditional-format-dialog.css')
}

export interface SpreadsheetConditionalFormatDialogProps {
  class?: string
  'data-testid'?: string
}

const ruleKinds: ConditionalFormatRuleKind[] = [
  'cell-value',
  'formula',
  'data-bar',
  'color-scale',
  'top-bottom',
]

function defaultDraftForKind(kind: ConditionalFormatRuleKind): ConditionalFormatRuleEntry['rule'] {
  switch (kind) {
    case 'cell-value':
      return { kind: 'cell-value', operator: 'gt', value: '0', format: { bgColor: '#fef3c7' } }
    case 'formula':
      return { kind: 'formula', formula: '=TRUE()', format: { bgColor: '#fef3c7' } }
    case 'data-bar':
      return { kind: 'data-bar' }
    case 'color-scale':
      return { kind: 'color-scale', minColor: '#ff0000', maxColor: '#00ff00' }
    case 'top-bottom':
      return { kind: 'top-bottom', direction: 'top', count: 10, format: { bgColor: '#fef3c7' } }
  }
}

export function SpreadsheetConditionalFormatDialog(
  props: SpreadsheetConditionalFormatDialogProps,
) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const editor = useAtomValue(conditionalFormatEditorAtom)
  const rulesCache = useAtomValue(conditionalFormatRulesCacheAtom)

  const isEditing = () => editor().open

  const [selectedKind, setSelectedKind] = createSignal<ConditionalFormatRuleKind>('cell-value')
  const [errorText, setErrorText] = createSignal<string | null>(null)
  const [lastSyncedDraftId, setLastSyncedDraftId] = createSignal<string | undefined>(undefined)

  function kindLabel(kind: ConditionalFormatRuleKind): string {
    return t(`conditionalFormat.kind.${kind}`)
  }

  createEffect((prevOpen: boolean) => {
    const open = isEditing()
    if (open && !prevOpen && !editor().draft) {
      setSelectedKind('cell-value')
      setLastSyncedDraftId(undefined)
    }
    if (!open && prevOpen) {
      setErrorText(null)
      setLastSyncedDraftId(undefined)
    }
    return open
  }, false)

  createEffect(() => {
    if (!isEditing()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        store.setter(closeConditionalFormatEditorAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  createEffect(() => {
    if (!isEditing()) return
    const draft = editor().draft
    if (draft && draft.id !== lastSyncedDraftId()) {
      setLastSyncedDraftId(draft.id)
      setSelectedKind(draft.rule.kind as ConditionalFormatRuleKind)
    }
    if (!draft && lastSyncedDraftId() !== undefined) setLastSyncedDraftId(undefined)
  })

  function currentKind(): ConditionalFormatRuleKind {
    return selectedKind()
  }

  function resolveSheetId(): string {
    const workspaceSheetId = store.getter(workspaceSessionAtom).activeSheetId
    if (workspaceSheetId && workspaceSheetId.length > 0) return workspaceSheetId
    return rulesCache().sheetId ?? ''
  }

  function resolveScope(): ConditionalFormatScope {
    const draft = editor().draft
    if (draft?.scope) return draft.scope
    const snapshot = store.getter(selectionSnapshotAtom)
    return { range: snapshot.range }
  }

  function close() {
    store.setter(closeConditionalFormatEditorAtom)
  }

  async function refreshRulesCache(sheetId: string) {
    if (!backend.listConditionalFormatRules) {
      const rules = rulesCache().rules
      store.setter(setConditionalFormatRulesAtom, { sheetId, rules })
      return
    }
    const result = await backend.listConditionalFormatRules({
      kind: 'list-conditional-format-rules',
      sheetId,
    })
    store.setter(setConditionalFormatRulesAtom, {
      sheetId: result.sheetId,
      rules: result.rules,
    })
  }

  async function handleSave() {
    if (!backend.setConditionalFormatRule) return
    setErrorText(null)
    const draft = editor().draft
    const kind = currentKind()
    const useDraftRule = draft && draft.rule.kind === kind
    const rule = useDraftRule ? draft.rule : defaultDraftForKind(kind)
    const scope = resolveScope()
    const sheetId = resolveSheetId()
    try {
      await backend.setConditionalFormatRule({
        kind: 'set-conditional-format-rule',
        sheetId,
        ruleId: draft?.id,
        scope,
        priority: draft?.priority,
        rule,
      })
      await refreshRulesCache(sheetId)
      close()
      await refreshVisibleProjection(store, backend, sheetId)
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRemove() {
    if (!backend.removeConditionalFormatRule) return
    setErrorText(null)
    const draft = editor().draft
    if (!draft) return
    const sheetId = resolveSheetId()
    try {
      await backend.removeConditionalFormatRule({
        kind: 'remove-conditional-format-rule',
        sheetId,
        ruleId: draft.id,
      })
      await refreshRulesCache(sheetId)
      close()
      await refreshVisibleProjection(store, backend, sheetId)
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
    }
  }

  function handleCancel() {
    close()
  }

  function onKindChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value as ConditionalFormatRuleKind
    setSelectedKind(value)
  }

  return (
    <Show when={isEditing()}>
      <div
        class={`conditional-format-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'conditional-format-dialog'}
        role="dialog"
        aria-modal="true"
        aria-label={t('conditionalFormat.title')}
      >
        <div class="cf-dialog-header">
          <span class="cf-dialog-title">{t('conditionalFormat.title')}</span>
          <button
            type="button"
            class="dialog-close-x"
            data-testid="dialog-close-x"
            aria-label={t('dialog.close.label')}
            onClick={close}
          >
            ×
          </button>
        </div>

        <div class="cf-dialog-body">
          <div class="cf-rules-section">
            <span class="cf-section-label">{t('conditionalFormat.existingRules')}</span>
            <ul class="cf-rule-list" data-testid="cf-rule-list">
              <For each={rulesCache().rules}>
                {(entry) => (
                  <li data-rule-id={entry.id} data-rule-kind={entry.rule.kind}>
                    {kindLabel(entry.rule.kind)} - {t('conditionalFormat.priority')}{' '}
                    {entry.priority}
                  </li>
                )}
              </For>
            </ul>
          </div>

          <div class="cf-form">
            <div class="cf-form-row">
              <label class="cf-form-label" for="cf-rule-kind-select">
                {t('conditionalFormat.ruleType')}
              </label>
              <select
                id="cf-rule-kind-select"
                data-testid="cf-rule-kind-select"
                value={currentKind()}
                onChange={onKindChange}
              >
                <For each={ruleKinds}>
                  {(kind) => <option value={kind}>{kindLabel(kind)}</option>}
                </For>
              </select>
            </div>

            <div class="cf-rule-preview" aria-hidden="true">
              <span class="cf-rule-preview-swatch" />
              <span class="cf-rule-preview-text">
                {t('conditionalFormat.preview')} - {kindLabel(currentKind())}
              </span>
            </div>
          </div>
        </div>

        <Show when={errorText()}>
          <div class="cf-error" data-testid="cf-error-text" role="alert">
            {errorText()}
          </div>
        </Show>

        <div class="cf-dialog-footer">
          <button
            type="button"
            data-testid="cf-remove-button"
            data-variant="danger"
            disabled={!editor().draft}
            onClick={() => {
              void handleRemove()
            }}
          >
            {t('conditionalFormat.remove')}
          </button>
          <span class="cf-error-spacer" />
          <button
            type="button"
            data-testid="cf-cancel-button"
            onClick={handleCancel}
          >
            {t('conditionalFormat.cancel')}
          </button>
          <button
            type="button"
            data-testid="cf-save-button"
            data-variant="primary"
            onClick={() => {
              void handleSave()
            }}
          >
            {t('conditionalFormat.save')}
          </button>
        </div>
      </div>
    </Show>
  )
}
