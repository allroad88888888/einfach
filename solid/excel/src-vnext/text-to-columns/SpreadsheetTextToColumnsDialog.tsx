/** @jsxImportSource solid-js */

import { For, Show, createEffect, createMemo, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  closeTextToColumnsAtom,
  confirmTextToColumnsAtom,
  DEFAULT_DELIMITED_CONFIG,
  DEFAULT_FIXED_CONFIG,
  makeStepThreeState,
  makeStepTwoState,
  previewColumnCount,
  textToColumnsAnchorAtom,
  textToColumnsOpenAtom,
  textToColumnsPreviewAtom,
  textToColumnsSheetIdAtom,
  textToColumnsSourceAtom,
  textToColumnsWizardAtom,
  type ImportCellChunksRequest,
  type TextToColumnsColumnFormat,
  type TextToColumnsDelimitedConfig,
  type TextToColumnsDelimiter,
  type TextToColumnsFixedConfig,
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
  const source = useAtomValue(textToColumnsSourceAtom)

  // Reset wizard state on every false→true open edge so a stale Step 3
  // does not leak into the next session.
  createEffect<boolean>((wasOpen) => {
    const open = isOpen()
    if (open && !wasOpen) {
      // openTextToColumnsAtom already wrote step-1; this is a defensive
      // re-initialize for hosts that flip the open atom directly.
      const current = store.getter(textToColumnsWizardAtom)
      if (current.step !== 'step-1') {
        store.setter(textToColumnsWizardAtom, { step: 'step-1', mode: 'delimited' })
      }
    }
    return open
  }, false)

  createEffect(() => {
    if (!isOpen()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        store.setter(closeTextToColumnsAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  const isSingleColumn = createMemo(() => source().length > 0)
  const columnCount = createMemo(() => previewColumnCount(preview()))
  const stepLabel = createMemo(() => {
    const w = wizard()
    if (w.step === 'step-1') return t('textToColumns.step1.title')
    if (w.step === 'step-2-delimited') return t('textToColumns.step2.delimited.title')
    if (w.step === 'step-2-fixed') return t('textToColumns.step2.fixed.title')
    return t('textToColumns.step3.title')
  })

  /**
   * `Next` is disabled when the wizard step has not collected enough
   * configuration to produce a meaningful split. Step 2 delimited needs
   * at least one delimiter (or an explicit `otherChar`); step 2 fixed
   * needs at least one breakpoint. Without this guard the user can
   * advance to step 3 with a single-token-per-row split and produce a
   * useless commit.
   */
  const nextDisabled = createMemo(() => {
    const w = wizard()
    if (w.step === 'step-3') return true
    if (w.step === 'step-2-delimited') {
      const cfg = w.delimited
      const hasOther = cfg.delimiters.has('other') && cfg.otherChar.length > 0
      const hasNonOther = Array.from(cfg.delimiters).some((d) => d !== 'other')
      return !(hasNonOther || hasOther)
    }
    if (w.step === 'step-2-fixed') {
      return w.fixed.breakpoints.length === 0
    }
    return false
  })

  const nextDisabledReason = createMemo(() => {
    const w = wizard()
    if (w.step === 'step-2-delimited' && nextDisabled()) {
      return t('textToColumns.step2.delimited.needOne')
    }
    if (w.step === 'step-2-fixed' && nextDisabled()) {
      return t('textToColumns.step2.fixed.needOne')
    }
    return undefined
  })

  function setWizard(next: TextToColumnsWizardState) {
    store.setter(textToColumnsWizardAtom, next)
  }

  function handleClose() {
    store.setter(closeTextToColumnsAtom)
  }

  function handleBack() {
    const w = wizard()
    if (w.step === 'step-1') return
    if (w.step === 'step-2-delimited' || w.step === 'step-2-fixed') {
      setWizard({ step: 'step-1', mode: w.mode })
      return
    }
    // Back from step 3 to step 2.
    setWizard(makeStepTwoState(w.mode, w.delimited, w.fixed))
  }

  function handleNext() {
    if (nextDisabled()) return
    const w = wizard()
    if (w.step === 'step-1') {
      setWizard(makeStepTwoState(w.mode))
      return
    }
    if (w.step === 'step-2-delimited') {
      const cols = columnCount()
      setWizard(makeStepThreeState('delimited', cols, w.delimited, DEFAULT_FIXED_CONFIG))
      return
    }
    if (w.step === 'step-2-fixed') {
      const cols = columnCount()
      setWizard(makeStepThreeState('fixed', cols, DEFAULT_DELIMITED_CONFIG, w.fixed))
      return
    }
  }

  async function handleFinish() {
    if (!isSingleColumn()) return
    const plan = store.setter(confirmTextToColumnsAtom)
    if (!plan) return
    const sheetId = store.getter(textToColumnsSheetIdAtom)
    const anchor = store.getter(textToColumnsAnchorAtom)
    if (!sheetId || !anchor) return
    const cells = plan.cells

    async function* chunks() {
      // Single chunk — the source is bounded by the column selection. The
      // backend honors per-cell `preserveAsText: true` so literal `=A1`
      // and `00123` survive.
      yield cells
    }

    const request: ImportCellChunksRequest = {
      kind: 'import-cell-chunks',
      sheetId,
      chunks: chunks(),
      range: plan.sourceRange,
    }
    try {
      await backend.importCellChunks?.(request)
      await refreshVisibleProjection(store, backend, sheetId)
    } catch {
      // Swallow at this layer — host-level error surfaces would be a
      // future addition. The dialog still closes so the user is not
      // trapped.
    }
    store.setter(closeTextToColumnsAtom)
  }

  // --- step 2 delimited handlers ---

  function toggleDelimiter(delim: TextToColumnsDelimiter) {
    const w = wizard()
    if (w.step !== 'step-2-delimited') return
    const next = new Set(w.delimited.delimiters)
    if (next.has(delim)) next.delete(delim)
    else next.add(delim)
    const delimited: TextToColumnsDelimitedConfig = { ...w.delimited, delimiters: next }
    setWizard({ ...w, delimited })
  }

  function setOtherChar(value: string) {
    const w = wizard()
    if (w.step !== 'step-2-delimited') return
    const delimited: TextToColumnsDelimitedConfig = {
      ...w.delimited,
      otherChar: value.charAt(0) ?? '',
    }
    setWizard({ ...w, delimited })
  }

  function setTreatConsecutive(value: boolean) {
    const w = wizard()
    if (w.step !== 'step-2-delimited') return
    const delimited: TextToColumnsDelimitedConfig = {
      ...w.delimited,
      treatConsecutiveAsOne: value,
    }
    setWizard({ ...w, delimited })
  }

  function setTextQualifier(value: TextToColumnsTextQualifier) {
    const w = wizard()
    if (w.step !== 'step-2-delimited') return
    const delimited: TextToColumnsDelimitedConfig = { ...w.delimited, textQualifier: value }
    setWizard({ ...w, delimited })
  }

  // --- step 2 fixed handlers ---

  function setFixedBreakpoints(text: string) {
    const w = wizard()
    if (w.step !== 'step-2-fixed') return
    const bps = text
      .split(/[\s,]+/)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0)
    const fixed: TextToColumnsFixedConfig = { breakpoints: bps }
    setWizard({ ...w, fixed })
  }

  // --- step 3 handlers ---

  function setColumnFormat(colIndex: number, format: TextToColumnsColumnFormat) {
    const w = wizard()
    if (w.step !== 'step-3') return
    const formats = w.formats.slice()
    formats[colIndex] = format
    setWizard({ ...w, formats })
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`text-to-columns-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'text-to-columns-dialog'}
        data-step={wizard().step}
        role="dialog"
        aria-label={t('textToColumns.title')}
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
            onClick={handleClose}
          >
            ×
          </button>
        </div>

        <div class="ttc-body">
          <Show when={!isSingleColumn()}>
            <div class="ttc-error" data-testid="ttc-no-source-error" role="alert">
              {t('textToColumns.error.singleColumn')}
            </div>
          </Show>

          <Show when={wizard().step === 'step-1'}>
            <Step1
              mode={(wizard() as Extract<TextToColumnsWizardState, { step: 'step-1' }>).mode}
              onMode={(m) =>
                setWizard({
                  step: 'step-1',
                  mode: m,
                })
              }
            />
          </Show>

          <Show when={wizard().step === 'step-2-delimited'}>
            <Step2Delimited
              config={
                (
                  wizard() as Extract<TextToColumnsWizardState, { step: 'step-2-delimited' }>
                ).delimited
              }
              onToggle={toggleDelimiter}
              onOther={setOtherChar}
              onTreatConsecutive={setTreatConsecutive}
              onQualifier={setTextQualifier}
            />
          </Show>

          <Show when={wizard().step === 'step-2-fixed'}>
            <Step2Fixed
              config={
                (wizard() as Extract<TextToColumnsWizardState, { step: 'step-2-fixed' }>).fixed
              }
              onBreakpoints={setFixedBreakpoints}
            />
          </Show>

          <Show when={wizard().step === 'step-3'}>
            <Step3
              formats={
                (wizard() as Extract<TextToColumnsWizardState, { step: 'step-3' }>).formats
              }
              columnCount={columnCount()}
              onFormat={setColumnFormat}
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
            disabled={wizard().step === 'step-1'}
            onClick={handleBack}
          >
            {t('textToColumns.back')}
          </button>
          <button
            type="button"
            class="ttc-btn"
            data-testid="ttc-next-button"
            disabled={nextDisabled()}
            title={nextDisabledReason()}
            onClick={handleNext}
          >
            {t('textToColumns.next')}
          </button>
          <Show when={nextDisabledReason()}>
            <span
              class="ttc-next-disabled-hint"
              data-testid="ttc-next-disabled-hint"
              role="status"
            >
              {nextDisabledReason()}
            </span>
          </Show>
          <button
            type="button"
            class="ttc-btn"
            data-testid="ttc-cancel-button"
            onClick={handleClose}
          >
            {t('textToColumns.cancel')}
          </button>
          <button
            type="button"
            class="ttc-btn ttc-btn-primary"
            data-testid="ttc-finish-button"
            disabled={!isSingleColumn() || wizard().step !== 'step-3'}
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
          onChange={() => props.onMode('fixed')}
        />
        {t('textToColumns.step1.fixed')}
      </label>
    </div>
  )
}

interface Step2DelimitedProps {
  config: TextToColumnsDelimitedConfig
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
          onInput={(e) => props.onOther(e.currentTarget.value)}
        />
      </label>
      <label class="ttc-checkbox">
        <input
          type="checkbox"
          data-testid="ttc-consecutive"
          checked={props.config.treatConsecutiveAsOne}
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
          onChange={(e) =>
            props.onQualifier(e.currentTarget.value as TextToColumnsTextQualifier)
          }
        >
          <option value="&quot;">{'"'}</option>
          <option value="'">{"'"}</option>
          <option value="none">{t('textToColumns.step2.delimited.qualifier.none')}</option>
        </select>
      </label>
    </div>
  )
}

interface Step2FixedProps {
  config: TextToColumnsFixedConfig
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
