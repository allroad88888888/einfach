import { Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  closeValidationRuleEditorAtom,
  validationRuleEditorAtom,
  type CellRange,
  type ValidationMode,
  type ValidationRule,
  type ValidationRuleKind,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'

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

function rangeLabel(range: CellRange | undefined): string {
  if (!range) return 'no range selected'
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
    await backend.setValidationRule?.({
      kind: 'set-validation-rule',
      sheetId: props.sheetId ?? '',
      range: e.range,
      rule: buildRule(),
      mode: mode(),
    })
    store.setter(closeValidationRuleEditorAtom)
  }

  async function handleClear() {
    const e = editor()
    if (e.status !== 'editing' || !e.range) return
    await backend.clearValidationRule?.({
      kind: 'clear-validation-rule',
      sheetId: props.sheetId ?? '',
      range: e.range,
    })
    store.setter(closeValidationRuleEditorAtom)
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
        aria-label="Data validation"
      >
        <div class="dv-dialog-header">
          <span class="dv-dialog-title">Data validation</span>
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
            <span class="dv-range-label">Range</span>
            <span class="validation-range" data-testid="validation-range">
              {rangeLabel(editor().range)}
            </span>
          </div>

          <div class="dv-form-row">
            <label>
              Rule type
              <select
                class="validation-kind-select"
                data-testid="validation-kind-select"
                value={kind()}
                onChange={(e) => {
                  setKind((e.target as HTMLSelectElement).value as ValidationRuleKind)
                }}
              >
                <option value="list">List</option>
                <option value="range">Range</option>
                <option value="regex">Regex</option>
                <option value="formula">Formula</option>
              </select>
            </label>
          </div>

          <Show when={kind() === 'list'}>
            <div class="dv-form-row">
              <label>
                Values (comma-separated)
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
              <label>Min/Max</label>
              <div class="dv-range-pair">
                <input
                  type="number"
                  class="validation-range-min"
                  data-testid="validation-range-min"
                  aria-label="Min"
                  placeholder="Min"
                  value={rangeMin()}
                  onInput={(e) => {
                    setRangeMin((e.target as HTMLInputElement).value)
                  }}
                />
                <input
                  type="number"
                  class="validation-range-max"
                  data-testid="validation-range-max"
                  aria-label="Max"
                  placeholder="Max"
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
                Pattern
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
                Formula
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
              Mode
              <select
                class="validation-mode-select"
                data-testid="validation-mode-select"
                value={mode()}
                onChange={(e) => {
                  setMode((e.target as HTMLSelectElement).value as ValidationMode)
                }}
              >
                <option value="warn">Warn</option>
                <option value="reject">Reject</option>
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
            Clear
          </button>
          <button
            type="button"
            class="validation-cancel-button"
            data-testid="validation-cancel-button"
            onClick={handleCancel}
          >
            取消
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
            确定
          </button>
        </div>
      </div>
    </Show>
  )
}
