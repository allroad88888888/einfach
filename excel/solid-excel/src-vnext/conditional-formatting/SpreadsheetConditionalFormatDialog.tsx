/** @jsxImportSource solid-js */

import { Show, For, createEffect, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  conditionalFormatEditorAtom,
  conditionalFormatRulesCacheAtom,
  closeConditionalFormatEditorAtom,
  runConditionalFormatMutationAtom,
  setConditionalFormatEditorKindAtom,
  type ConditionalFormatRuleKind,
} from '@einfach/spreadsheet-ui-core'
import { refreshVisibleProjection, useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

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

export function SpreadsheetConditionalFormatDialog(props: SpreadsheetConditionalFormatDialogProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const editor = useAtomValue(conditionalFormatEditorAtom)
  const rulesCache = useAtomValue(conditionalFormatRulesCacheAtom)

  const isEditing = () => editor().open

  function kindLabel(kind: ConditionalFormatRuleKind): string {
    return t(`conditionalFormat.kind.${kind}`)
  }

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

  function currentKind(): ConditionalFormatRuleKind {
    return editor().selectedKind
  }

  function close() {
    store.setter(closeConditionalFormatEditorAtom)
  }

  async function handleSave() {
    await store.setter(runConditionalFormatMutationAtom, {
      action: 'save',
      setRule: backend.setConditionalFormatRule
        ? (request) => backend.setConditionalFormatRule!(request)
        : undefined,
      listRules: backend.listConditionalFormatRules
        ? (request) => backend.listConditionalFormatRules!(request)
        : undefined,
      acceptAcknowledgedResult: (result) =>
        refreshVisibleProjection(store, backend, result.sheetId),
    })
  }

  async function handleRemove() {
    await store.setter(runConditionalFormatMutationAtom, {
      action: 'remove',
      removeRule: backend.removeConditionalFormatRule
        ? (request) => backend.removeConditionalFormatRule!(request)
        : undefined,
      listRules: backend.listConditionalFormatRules
        ? (request) => backend.listConditionalFormatRules!(request)
        : undefined,
      acceptAcknowledgedResult: (result) =>
        refreshVisibleProjection(store, backend, result.sheetId),
    })
  }

  function handleCancel() {
    close()
  }

  function onKindChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value as ConditionalFormatRuleKind
    store.setter(setConditionalFormatEditorKindAtom, value)
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
                disabled={editor().pending}
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

        <Show when={editor().error}>
          <div class="cf-error" data-testid="cf-error-text" role="alert">
            {editor().error}
          </div>
        </Show>

        <div class="cf-dialog-footer">
          <button
            type="button"
            data-testid="cf-remove-button"
            data-variant="danger"
            disabled={!editor().draft || editor().pending}
            onClick={() => {
              void handleRemove()
            }}
          >
            {t('conditionalFormat.remove')}
          </button>
          <span class="cf-error-spacer" />
          <button type="button" data-testid="cf-cancel-button" onClick={handleCancel}>
            {t('conditionalFormat.cancel')}
          </button>
          <button
            type="button"
            data-testid="cf-save-button"
            data-variant="primary"
            disabled={editor().pending}
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
