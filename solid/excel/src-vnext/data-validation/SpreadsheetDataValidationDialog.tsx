import { Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  closeValidationRuleEditorAtom,
  selectionSnapshotAtom,
  validationRuleEditorAtom,
  workspaceSessionAtom,
  type CellRange,
  type ValidationMode,
  type ValidationRule,
  type ValidationRuleKind,
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

  const [kind, setKind] = createSignal<ValidationRuleKind>('list')
  const [mode, setMode] = createSignal<ValidationMode>('warn')
  const [listValues, setListValues] = createSignal('')
  const [rangeMin, setRangeMin] = createSignal('')
  const [rangeMax, setRangeMax] = createSignal('')
  const [regexPattern, setRegexPattern] = createSignal('')
  const [formulaText, setFormulaText] = createSignal('')

  function resetDraftFields() {
    const e = editor()
    const draft = e.status === 'editing' ? e.draft : undefined
    setKind(draft?.kind ?? 'list')
    setMode(e.status === 'editing' ? e.mode ?? 'warn' : 'warn')
    setListValues(draft?.kind === 'list' ? draft.values.join(', ') : '')
    setRangeMin(draft?.kind === 'range' && draft.min !== undefined ? String(draft.min) : '')
    setRangeMax(draft?.kind === 'range' && draft.max !== undefined ? String(draft.max) : '')
    setRegexPattern(draft?.kind === 'regex' ? draft.pattern : '')
    setFormulaText(draft?.kind === 'formula' ? draft.formula : '')
  }

  createEffect((wasEditing: boolean) => {
    const editing = isEditing()
    if (editing && !wasEditing) resetDraftFields()
    if (!editing && wasEditing) resetDraftFields()
    return editing
  }, false)

  function resolveSheetId(): string {
    if (props.sheetId && props.sheetId.length > 0) return props.sheetId
    const workspaceSheetId = store.getter(workspaceSessionAtom).activeSheetId
    if (workspaceSheetId && workspaceSheetId.length > 0) return workspaceSheetId
    return store.getter(selectionSnapshotAtom).selection.sheetId
  }

  function buildRule(): ValidationRule {
    const k = kind()
    if (k === 'list') {
      return {
        kind: 'list',
        values: listValues()
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean),
        dropdown: true,
      }
    }
    if (k === 'range') {
      const min = rangeMin() !== '' ? Number(rangeMin()) : undefined
      const max = rangeMax() !== '' ? Number(rangeMax()) : undefined
      return { kind: 'range', min, max }
    }
    if (k === 'regex') {
      return { kind: 'regex', pattern: regexPattern() }
    }
    return { kind: 'formula', formula: formulaText() }
  }

  async function handleSave() {
    const e = editor()
    if (e.status !== 'editing' || !e.range) return
    const sheetId = resolveSheetId()
    if (!sheetId) return
    await backend.setValidationRule?.({
      kind: 'set-validation-rule',
      sheetId,
      range: e.range,
      rule: buildRule(),
      mode: mode(),
    })
    store.setter(closeValidationRuleEditorAtom)
    await refreshVisibleProjection(store, backend, sheetId)
  }

  async function handleClear() {
    const e = editor()
    if (e.status !== 'editing' || !e.range) return
    const sheetId = resolveSheetId()
    if (!sheetId) return
    await backend.clearValidationRule?.({
      kind: 'clear-validation-rule',
      sheetId,
      range: e.range,
    })
    store.setter(closeValidationRuleEditorAtom)
    await refreshVisibleProjection(store, backend, sheetId)
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
                value={kind()}
                onChange={(e) => {
                  setKind((e.target as HTMLSelectElement).value as ValidationRuleKind)
                }}
              >
                <option value="list">{t('dataValidation.rule.list')}</option>
                <option value="range">{t('dataValidation.rule.range')}</option>
                <option value="regex">{t('dataValidation.rule.regex')}</option>
                <option value="formula">{t('dataValidation.rule.formula')}</option>
              </select>
            </label>
          </div>

          <Show when={kind() === 'list'}>
            <div class="dv-form-row">
              <label>
                {t('dataValidation.values')}
                <input
                  type="text"
                  class="validation-list-values"
                  data-testid="validation-list-values"
                  value={listValues()}
                  onInput={(e) => {
                    setListValues((e.target as HTMLInputElement).value)
                  }}
                />
              </label>
            </div>
          </Show>

          <Show when={kind() === 'range'}>
            <div class="dv-form-row">
              <label>{t('dataValidation.minMax')}</label>
              <div class="dv-range-pair">
                <input
                  type="number"
                  class="validation-range-min"
                  data-testid="validation-range-min"
                  aria-label={t('dataValidation.min')}
                  placeholder={t('dataValidation.min')}
                  value={rangeMin()}
                  onInput={(e) => {
                    setRangeMin((e.target as HTMLInputElement).value)
                  }}
                />
                <input
                  type="number"
                  class="validation-range-max"
                  data-testid="validation-range-max"
                  aria-label={t('dataValidation.max')}
                  placeholder={t('dataValidation.max')}
                  value={rangeMax()}
                  onInput={(e) => {
                    setRangeMax((e.target as HTMLInputElement).value)
                  }}
                />
              </div>
            </div>
          </Show>

          <Show when={kind() === 'regex'}>
            <div class="dv-form-row">
              <label>
                {t('dataValidation.pattern')}
                <input
                  type="text"
                  class="validation-regex-pattern"
                  data-testid="validation-regex-pattern"
                  value={regexPattern()}
                  onInput={(e) => {
                    setRegexPattern((e.target as HTMLInputElement).value)
                  }}
                />
              </label>
            </div>
          </Show>

          <Show when={kind() === 'formula'}>
            <div class="dv-form-row">
              <label>
                {t('dataValidation.formula')}
                <input
                  type="text"
                  class="validation-formula-text"
                  data-testid="validation-formula-text"
                  value={formulaText()}
                  onInput={(e) => {
                    setFormulaText((e.target as HTMLInputElement).value)
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
                value={mode()}
                onChange={(e) => {
                  setMode((e.target as HTMLSelectElement).value as ValidationMode)
                }}
              >
                <option value="warn">{t('dataValidation.mode.warn')}</option>
                <option value="reject">{t('dataValidation.mode.reject')}</option>
              </select>
            </label>
          </div>
        </div>

        <div class="dv-dialog-footer">
          <button
            type="button"
            class="validation-clear-button"
            data-testid="validation-clear-button"
            data-variant="danger"
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
