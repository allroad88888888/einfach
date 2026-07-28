/** @jsxImportSource solid-js */

import { For, Show, createEffect, createMemo, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  captureTextToColumnsCapabilityAtom,
  closeTextToColumnsAtom,
  dispatchTextToColumnsIntentAtom,
  runTextToColumnsFinishAtom,
  textToColumnsCanCloseAtom,
  textToColumnsCanEditAtom,
  textToColumnsCanFinishAtom,
  textToColumnsCanGoBackAtom,
  textToColumnsCanGoNextAtom,
  textToColumnsColumnCountAtom,
  textToColumnsErrorAtom,
  textToColumnsHasSourceAtom,
  textToColumnsLifecycleAtom,
  textToColumnsNextBlockReasonAtom,
  textToColumnsOpenAtom,
  textToColumnsPreviewAtom,
  textToColumnsSessionAtom,
  textToColumnsWizardAtom,
  type TextToColumnsColumnFormat,
  type TextToColumnsDelimitedConfig,
  type TextToColumnsDelimiter,
  type TextToColumnsFixedConfig,
  type TextToColumnsIntent,
  type TextToColumnsTextQualifier,
  type TextToColumnsWizardState,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'
import { refreshVisibleProjection } from '../provider/projection-refresh'
import './text-to-columns-dialog.css'

export interface SpreadsheetTextToColumnsDialogProps {
  class?: string
  'data-testid'?: string
}

const DELIMITER_KEYS: readonly TextToColumnsDelimiter[] = [
  'tab',
  'semicolon',
  'comma',
  'space',
  'other',
]

export function SpreadsheetTextToColumnsDialog(props: SpreadsheetTextToColumnsDialogProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const isOpen = useAtomValue(textToColumnsOpenAtom)
  const wizard = useAtomValue(textToColumnsWizardAtom)
  const preview = useAtomValue(textToColumnsPreviewAtom)
  const session = useAtomValue(textToColumnsSessionAtom)
  const lifecycle = useAtomValue(textToColumnsLifecycleAtom)
  const error = useAtomValue(textToColumnsErrorAtom)
  const hasSource = useAtomValue(textToColumnsHasSourceAtom)
  const columnCount = useAtomValue(textToColumnsColumnCountAtom)
  const nextBlockReason = useAtomValue(textToColumnsNextBlockReasonAtom)
  const canEdit = useAtomValue(textToColumnsCanEditAtom)
  const canClose = useAtomValue(textToColumnsCanCloseAtom)
  const canGoBack = useAtomValue(textToColumnsCanGoBackAtom)
  const canGoNext = useAtomValue(textToColumnsCanGoNextAtom)
  const canFinish = useAtomValue(textToColumnsCanFinishAtom)

  // The adapter reports method presence; Core owns the resulting eligibility.
  createEffect(() => {
    store.setter(captureTextToColumnsCapabilityAtom, backend)
  })

  createEffect(() => {
    if (!isOpen()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        if (canClose()) store.setter(closeTextToColumnsAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  const stepLabel = createMemo(() => {
    const w = wizard()
    if (w.step === 'step-1') return t('textToColumns.step1.title')
    if (w.step === 'step-2-delimited') return t('textToColumns.step2.delimited.title')
    if (w.step === 'step-2-fixed') return t('textToColumns.step2.fixed.title')
    return t('textToColumns.step3.title')
  })

  const nextDisabledReason = createMemo(() => {
    if (nextBlockReason() === 'delimiter-required') {
      return t('textToColumns.step2.delimited.needOne')
    }
    if (nextBlockReason() === 'breakpoint-required') {
      return t('textToColumns.step2.fixed.needOne')
    }
    return undefined
  })

  function dispatch(intent: TextToColumnsIntent) {
    store.setter(dispatchTextToColumnsIntentAtom, intent)
  }

  function handleClose() {
    if (canClose()) store.setter(closeTextToColumnsAtom)
  }

  function handleBack() {
    dispatch({ kind: 'back' })
  }

  function handleNext() {
    dispatch({ kind: 'next' })
  }

  async function handleFinish() {
    const current = session()
    if (current === null) return
    await store.setter(runTextToColumnsFinishAtom, {
      source: backend,
      sessionId: current.sessionId,
      refreshProjection: (sheetId) => refreshVisibleProjection(store, backend, sheetId),
    })
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`text-to-columns-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'text-to-columns-dialog'}
        data-step={wizard().step}
        data-lifecycle={lifecycle().status}
        role="dialog"
        aria-label={t('textToColumns.title')}
        aria-busy={
          lifecycle().status === 'pending' ||
          lifecycle().status === 'local-acknowledged' ||
          lifecycle().status === 'refreshing'
        }
      >
        <div class="ttc-header">
          <span class="ttc-title">{t('textToColumns.title')}</span>
          <span class="ttc-step-label" data-testid="ttc-step-label">
            {stepLabel()}
          </span>
          <button
            type="button"
            class="dialog-close-x"
            data-testid="dialog-close-x"
            aria-label={t('dialog.close.label')}
            disabled={!canClose()}
            onClick={handleClose}
          >
            ×
          </button>
        </div>

        <div class="ttc-body">
          <Show when={!hasSource()}>
            <div class="ttc-error" data-testid="ttc-no-source-error" role="alert">
              {t('textToColumns.error.singleColumn')}
            </div>
          </Show>
          <Show when={error().length > 0}>
            <div class="ttc-error" data-testid="ttc-mutation-error" role="alert">
              {error()}
            </div>
          </Show>

          <Show when={wizard().step === 'step-1'}>
            <Step1
              mode={(wizard() as Extract<TextToColumnsWizardState, { step: 'step-1' }>).mode}
              disabled={!canEdit()}
              onMode={(mode) => dispatch({ kind: 'set-mode', mode })}
            />
          </Show>

          <Show when={wizard().step === 'step-2-delimited'}>
            <Step2Delimited
              config={
                (wizard() as Extract<TextToColumnsWizardState, { step: 'step-2-delimited' }>)
                  .delimited
              }
              disabled={!canEdit()}
              onToggle={(delimiter) => dispatch({ kind: 'toggle-delimiter', delimiter })}
              onOther={(value) => dispatch({ kind: 'set-other-char', value })}
              onTreatConsecutive={(value) => dispatch({ kind: 'set-treat-consecutive', value })}
              onQualifier={(value) => dispatch({ kind: 'set-text-qualifier', value })}
            />
          </Show>

          <Show when={wizard().step === 'step-2-fixed'}>
            <Step2Fixed
              config={
                (wizard() as Extract<TextToColumnsWizardState, { step: 'step-2-fixed' }>).fixed
              }
              disabled={!canEdit()}
              onBreakpoints={(value) => dispatch({ kind: 'set-fixed-breakpoints', value })}
            />
          </Show>

          <Show when={wizard().step === 'step-3'}>
            <Step3
              formats={(wizard() as Extract<TextToColumnsWizardState, { step: 'step-3' }>).formats}
              columnCount={columnCount()}
              disabled={!canEdit()}
              onFormat={(columnIndex, format) =>
                dispatch({ kind: 'set-column-format', columnIndex, format })
              }
            />
          </Show>

          <div class="ttc-preview" data-testid="ttc-preview">
            <div class="ttc-preview-header">{t('textToColumns.preview')}</div>
            <div class="ttc-preview-scroll">
              <table>
                <tbody>
                  <For each={preview()}>
                    {(row) => (
                      <tr data-testid={`ttc-preview-row-${row.sourceRow}`}>
                        <For each={row.tokens}>
                          {(token, i) => (
                            <td data-testid={`ttc-preview-cell-${row.sourceRow}-${i()}`}>
                              {token}
                            </td>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="ttc-footer">
          <button
            type="button"
            class="ttc-btn"
            data-testid="ttc-back-button"
            disabled={!canGoBack()}
            onClick={handleBack}
          >
            {t('textToColumns.back')}
          </button>
          <button
            type="button"
            class="ttc-btn"
            data-testid="ttc-next-button"
            disabled={!canGoNext()}
            title={nextDisabledReason()}
            onClick={handleNext}
          >
            {t('textToColumns.next')}
          </button>
          <Show when={nextDisabledReason()}>
            <span class="ttc-next-disabled-hint" data-testid="ttc-next-disabled-hint" role="status">
              {nextDisabledReason()}
            </span>
          </Show>
          <button
            type="button"
            class="ttc-btn"
            data-testid="ttc-cancel-button"
            disabled={!canClose()}
            onClick={handleClose}
          >
            {t('textToColumns.cancel')}
          </button>
          <button
            type="button"
            class="ttc-btn ttc-btn-primary"
            data-testid="ttc-finish-button"
            disabled={!canFinish()}
            onClick={() => void handleFinish()}
          >
            {t('textToColumns.finish')}
          </button>
        </div>
      </div>
    </Show>
  )
}

interface Step1Props {
  mode: 'delimited' | 'fixed'
  disabled: boolean
  onMode: (mode: 'delimited' | 'fixed') => void
}

function Step1(props: Step1Props) {
  const t = useT()
  return (
    <div class="ttc-section" data-testid="ttc-step-1">
      <p class="ttc-section-title">{t('textToColumns.step1.title')}</p>
      <label class="ttc-radio">
        <input
          type="radio"
          name="ttc-mode"
          data-testid="ttc-mode-delimited"
          checked={props.mode === 'delimited'}
          disabled={props.disabled}
          onChange={() => props.onMode('delimited')}
        />
        {t('textToColumns.step1.delimited')}
      </label>
      <label class="ttc-radio">
        <input
          type="radio"
          name="ttc-mode"
          data-testid="ttc-mode-fixed"
          checked={props.mode === 'fixed'}
          disabled={props.disabled}
          onChange={() => props.onMode('fixed')}
        />
        {t('textToColumns.step1.fixed')}
      </label>
    </div>
  )
}

interface Step2DelimitedProps {
  config: TextToColumnsDelimitedConfig
  disabled: boolean
  onToggle: (delim: TextToColumnsDelimiter) => void
  onOther: (value: string) => void
  onTreatConsecutive: (value: boolean) => void
  onQualifier: (value: TextToColumnsTextQualifier) => void
}

function Step2Delimited(props: Step2DelimitedProps) {
  const t = useT()
  return (
    <div class="ttc-section" data-testid="ttc-step-2-delimited">
      <p class="ttc-section-title">{t('textToColumns.step2.delimited.title')}</p>
      <div class="ttc-delim-grid">
        <For each={DELIMITER_KEYS}>
          {(delim) => (
            <label class="ttc-checkbox">
              <input
                type="checkbox"
                data-testid={`ttc-delim-${delim}`}
                checked={props.config.delimiters.has(delim)}
                disabled={props.disabled}
                onChange={() => props.onToggle(delim)}
              />
              {t(`textToColumns.step2.delimited.${delim}`)}
            </label>
          )}
        </For>
      </div>
      <label class="ttc-field-row">
        {t('textToColumns.step2.delimited.otherChar')}
        <input
          type="text"
          class="ttc-input"
          data-testid="ttc-delim-other-char"
          value={props.config.otherChar}
          maxLength={1}
          disabled={props.disabled}
          onInput={(e) => props.onOther(e.currentTarget.value)}
        />
      </label>
      <label class="ttc-checkbox">
        <input
          type="checkbox"
          data-testid="ttc-consecutive"
          checked={props.config.treatConsecutiveAsOne}
          disabled={props.disabled}
          onChange={(e) => props.onTreatConsecutive(e.currentTarget.checked)}
        />
        {t('textToColumns.step2.delimited.consecutive')}
      </label>
      <label class="ttc-field-row">
        {t('textToColumns.step2.delimited.qualifier')}
        <select
          class="ttc-select"
          data-testid="ttc-qualifier"
          value={props.config.textQualifier}
          disabled={props.disabled}
          onChange={(e) => props.onQualifier(e.currentTarget.value as TextToColumnsTextQualifier)}
        >
          <option value='"'>{'"'}</option>
          <option value="'">{"'"}</option>
          <option value="none">{t('textToColumns.step2.delimited.qualifier.none')}</option>
        </select>
      </label>
    </div>
  )
}

interface Step2FixedProps {
  config: TextToColumnsFixedConfig
  disabled: boolean
  onBreakpoints: (raw: string) => void
}

function Step2Fixed(props: Step2FixedProps) {
  const t = useT()
  return (
    <div class="ttc-section" data-testid="ttc-step-2-fixed">
      <p class="ttc-section-title">{t('textToColumns.step2.fixed.title')}</p>
      <label class="ttc-field-row">
        {t('textToColumns.step2.fixed.breakpoints')}
        <input
          type="text"
          class="ttc-input"
          data-testid="ttc-breakpoints"
          value={props.config.breakpoints.join(',')}
          disabled={props.disabled}
          onInput={(e) => props.onBreakpoints(e.currentTarget.value)}
          placeholder="3,7,11"
        />
      </label>
      <p class="ttc-help">{t('textToColumns.step2.fixed.hint')}</p>
    </div>
  )
}

interface Step3Props {
  formats: readonly TextToColumnsColumnFormat[]
  columnCount: number
  disabled: boolean
  onFormat: (colIndex: number, format: TextToColumnsColumnFormat) => void
}

function Step3(props: Step3Props) {
  const t = useT()
  const columns = createMemo(() => {
    const out: number[] = []
    for (let i = 0; i < Math.max(props.columnCount, props.formats.length); i += 1) {
      out.push(i)
    }
    return out
  })
  return (
    <div class="ttc-section" data-testid="ttc-step-3">
      <p class="ttc-section-title">{t('textToColumns.step3.title')}</p>
      <p class="ttc-help">{t('textToColumns.step3.hint')}</p>
      <div class="ttc-format-grid">
        <For each={columns()}>
          {(col) => (
            <label class="ttc-field-row">
              {`#${col + 1}`}
              <select
                class="ttc-select"
                data-testid={`ttc-format-${col}`}
                value={props.formats[col] ?? 'general'}
                disabled={props.disabled}
                onChange={(e) =>
                  props.onFormat(col, e.currentTarget.value as TextToColumnsColumnFormat)
                }
              >
                <option value="general">{t('textToColumns.step3.format.general')}</option>
                <option value="text">{t('textToColumns.step3.format.text')}</option>
                {/*
                  Date parsing is not yet implemented end-to-end (would need
                  locale-aware token recognition + a typed cell input the
                  backend understands). Keep the option visible but disabled
                  so users see the feature is planned without being misled
                  into picking a no-op. TODO(text-to-columns): wire actual
                  date parsing through `preserveAsText: false` + a typed
                  ImportCellPlan when we add a date input channel.
                */}
                <option
                  value="date"
                  disabled
                  title={t('textToColumns.step3.format.dateUnsupported')}
                  data-testid={`ttc-format-${col}-date`}
                >
                  {t('textToColumns.step3.format.date')}
                </option>
                <option value="skip">{t('textToColumns.step3.format.skip')}</option>
              </select>
            </label>
          )}
        </For>
      </div>
    </div>
  )
}
