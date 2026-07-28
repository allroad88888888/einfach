import { Show, createEffect, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  closeValidationRuleEditorAtom,
  runDataValidationMutationAtom,
  updateValidationRuleFormAtom,
  validationRuleEditorAtom,
  validationRuleFormAtom,
  type CellRange,
  type ValidationMode,
  type ValidationRuleKind,
} from '@einfach/spreadsheet-ui-core'
import { refreshVisibleProjection, useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

// Pull in the dialog stylesheet as a side-effect import. Vite picks the
// dynamic-import target up statically and bundles the CSS into the chunk;
// the runtime guard skips evaluation under jest so unit tests aren't
// blocked when no CSS transform is configured. The co-located
// `.css.d.ts` keeps tsc satisfied under the Bundler moduleResolution.
if (typeof process === 'undefined' || !process.env.JEST_WORKER_ID) {
  void import('./data-validation-dialog.css')
}

export interface SpreadsheetDataValidationDialogProps {
  class?: string
  'data-testid'?: string
  sheetId?: string
}

function colLabel(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    const rem = (value - 1) % 26
    label = String.fromCharCode(65 + rem) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}

function rangeLabel(range: CellRange | undefined, noRangeLabel: string): string {
  if (!range) return noRangeLabel
  const tl = `${colLabel(range.colStart)}${range.rowStart + 1}`
  const br = `${colLabel(range.colEnd)}${range.rowEnd + 1}`
  return tl === br ? tl : `${tl}:${br}`
}

export function SpreadsheetDataValidationDialog(props: SpreadsheetDataValidationDialogProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const editor = useAtomValue(validationRuleEditorAtom)
  const form = useAtomValue(validationRuleFormAtom)

  const isEditing = () => editor().status === 'editing'

  createEffect(() => {
    if (!isEditing()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        store.setter(closeValidationRuleEditorAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  async function handleSave() {
    await store.setter(runDataValidationMutationAtom, {
      action: 'save',
      sheetId: props.sheetId,
      setRule: backend.setValidationRule
        ? (request) => backend.setValidationRule!(request)
        : undefined,
      acceptAcknowledgedResult: (result) =>
        refreshVisibleProjection(store, backend, result.sheetId),
    })
  }

  async function handleClear() {
    await store.setter(runDataValidationMutationAtom, {
      action: 'clear',
      sheetId: props.sheetId,
      clearRule: backend.clearValidationRule
        ? (request) => backend.clearValidationRule!(request)
        : undefined,
      acceptAcknowledgedResult: (result) =>
        refreshVisibleProjection(store, backend, result.sheetId),
    })
  }

  function handleCancel() {
    store.setter(closeValidationRuleEditorAtom)
  }

  return (
    <Show when={isEditing()}>
      <div
        class={`validation-dialog spreadsheet-validation-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'validation-dialog'}
        role="dialog"
        aria-busy={editor().pending}
        aria-label={t('dataValidation.title')}
      >
        <div class="dv-dialog-header">
          <span class="dv-dialog-title">{t('dataValidation.title')}</span>
          <button
            type="button"
            class="dialog-close-x"
            data-testid="dialog-close-x"
            aria-label={t('dialog.close.label')}
            onClick={handleCancel}
          >
            ×
          </button>
        </div>

        <div class="dv-dialog-body">
          <div class="dv-range-row">
            <span class="dv-range-label">{t('dataValidation.range')}</span>
            <span class="validation-range" data-testid="validation-range">
              {rangeLabel(editor().range, t('dataValidation.noRange'))}
            </span>
          </div>

          <div class="dv-form-row">
            <label>
              {t('dataValidation.ruleType')}
              <select
                class="validation-kind-select"
                data-testid="validation-kind-select"
                value={form().kind}
                disabled={editor().pending}
                onChange={(e) => {
                  store.setter(updateValidationRuleFormAtom, {
                    kind: (e.target as HTMLSelectElement).value as ValidationRuleKind,
                  })
                }}
              >
                <option value="list">{t('dataValidation.rule.list')}</option>
                <option value="range">{t('dataValidation.rule.range')}</option>
                <option value="regex">{t('dataValidation.rule.regex')}</option>
                <option value="formula">{t('dataValidation.rule.formula')}</option>
              </select>
            </label>
          </div>

          <Show when={form().kind === 'list'}>
            <div class="dv-form-row">
              <label>
                {t('dataValidation.values')}
                <input
                  type="text"
                  class="validation-list-values"
                  data-testid="validation-list-values"
                  value={form().listValues}
                  disabled={editor().pending}
                  onInput={(e) => {
                    store.setter(updateValidationRuleFormAtom, {
                      listValues: (e.target as HTMLInputElement).value,
                    })
                  }}
                />
              </label>
            </div>
          </Show>

          <Show when={form().kind === 'range'}>
            <div class="dv-form-row">
              <label>{t('dataValidation.minMax')}</label>
              <div class="dv-range-pair">
                <input
                  type="number"
                  class="validation-range-min"
                  data-testid="validation-range-min"
                  aria-label={t('dataValidation.min')}
                  placeholder={t('dataValidation.min')}
                  value={form().rangeMin}
                  disabled={editor().pending}
                  onInput={(e) => {
                    store.setter(updateValidationRuleFormAtom, {
                      rangeMin: (e.target as HTMLInputElement).value,
                    })
                  }}
                />
                <input
                  type="number"
                  class="validation-range-max"
                  data-testid="validation-range-max"
                  aria-label={t('dataValidation.max')}
                  placeholder={t('dataValidation.max')}
                  value={form().rangeMax}
                  disabled={editor().pending}
                  onInput={(e) => {
                    store.setter(updateValidationRuleFormAtom, {
                      rangeMax: (e.target as HTMLInputElement).value,
                    })
                  }}
                />
              </div>
            </div>
          </Show>

          <Show when={form().kind === 'regex'}>
            <div class="dv-form-row">
              <label>
                {t('dataValidation.pattern')}
                <input
                  type="text"
                  class="validation-regex-pattern"
                  data-testid="validation-regex-pattern"
                  value={form().regexPattern}
                  disabled={editor().pending}
                  onInput={(e) => {
                    store.setter(updateValidationRuleFormAtom, {
                      regexPattern: (e.target as HTMLInputElement).value,
                    })
                  }}
                />
              </label>
            </div>
          </Show>

          <Show when={form().kind === 'formula'}>
            <div class="dv-form-row">
              <label>
                {t('dataValidation.formula')}
                <input
                  type="text"
                  class="validation-formula-text"
                  data-testid="validation-formula-text"
                  value={form().formulaText}
                  disabled={editor().pending}
                  onInput={(e) => {
                    store.setter(updateValidationRuleFormAtom, {
                      formulaText: (e.target as HTMLInputElement).value,
                    })
                  }}
                />
              </label>
            </div>
          </Show>

          <div class="dv-form-row">
            <label>
              {t('dataValidation.mode')}
              <select
                class="validation-mode-select"
                data-testid="validation-mode-select"
                value={form().mode}
                disabled={editor().pending}
                onChange={(e) => {
                  store.setter(updateValidationRuleFormAtom, {
                    mode: (e.target as HTMLSelectElement).value as ValidationMode,
                  })
                }}
              >
                <option value="warn">{t('dataValidation.mode.warn')}</option>
                <option value="reject">{t('dataValidation.mode.reject')}</option>
              </select>
            </label>
          </div>
        </div>

        <Show when={editor().error}>
          <div class="dv-error" data-testid="validation-error-text" role="alert">
            {editor().error}
          </div>
        </Show>

        <div class="dv-dialog-footer">
          <button
            type="button"
            class="validation-clear-button"
            data-testid="validation-clear-button"
            data-variant="danger"
            disabled={editor().pending}
            onClick={() => {
              void handleClear()
            }}
          >
            {t('dataValidation.clear')}
          </button>
          <button
            type="button"
            class="validation-cancel-button"
            data-testid="validation-cancel-button"
            onClick={handleCancel}
          >
            {t('dataValidation.cancel')}
          </button>
          <button
            type="button"
            class="validation-save-button"
            data-testid="validation-save-button"
            data-variant="primary"
            disabled={editor().pending}
            onClick={() => {
              void handleSave()
            }}
          >
            {t('dataValidation.save')}
          </button>
        </div>
      </div>
    </Show>
  )
}
