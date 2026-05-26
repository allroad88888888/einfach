/** @jsxImportSource solid-js */

import { For, Show, createEffect, onCleanup } from 'solid-js'
import type { JSX } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import { resolveProjectionSourceRanges } from '../provider/projection-coordinates'
import { refreshVisibleProjection } from '../provider/projection-refresh'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'
import {
  CURRENCY_FORMAT_OPTIONS,
  DATE_TIME_FORMAT_OPTIONS,
  NUMBER_FORMAT_OPTIONS,
  closeNumberFormatDialogAtom,
  numberFormatDialogAtom,
  numberFormatDialogSavePayloadAtom,
  patchNumberFormatDialogAtom,
  saveNumberFormatDialogAtom,
  type CurrencyFormatOption,
  type NumberFormatDialogKind,
  type NumberFormatDialogOpenState,
  type PatternFormatOption,
} from './number-format-dialog-atoms'
import './number-format-dialog.css'

export interface SpreadsheetNumberFormatDialogsProps {
  class?: string
  'data-testid'?: string
}

const TITLE_KEYS: Record<NumberFormatDialogKind, string> = {
  currency: 'numberFormatDialog.currency.title',
  dateTime: 'numberFormatDialog.dateTime.title',
  number: 'numberFormatDialog.number.title',
}

function currencyPreview(option: CurrencyFormatOption, digits: number): string {
  const safeDigits = Math.max(0, Math.min(6, Math.round(digits)))
  const fraction = safeDigits > 0 ? `.${'0'.repeat(safeDigits)}` : ''
  const gap = option.symbol.length > 1 ? ' ' : ''
  if (option.pos === 'after') return `1,234${fraction}${gap}${option.symbol}`
  return `${option.symbol}${gap}1,234${fraction}`
}

export function SpreadsheetNumberFormatDialogs(
  props: SpreadsheetNumberFormatDialogsProps,
): JSX.Element {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const state = useAtomValue(numberFormatDialogAtom)

  const dialog = () => {
    const current = state()
    return current.status === 'open' ? current : null
  }

  createEffect(() => {
    if (!dialog()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        store.setter(closeNumberFormatDialogAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  function setSelectedId(selectedId: string) {
    store.setter(patchNumberFormatDialogAtom, { selectedId })
  }

  function setDigits(raw: string) {
    const parsed = Number(raw)
    store.setter(patchNumberFormatDialogAtom, {
      digits: Number.isFinite(parsed) ? parsed : 0,
    })
  }

  function closeDialog() {
    store.setter(closeNumberFormatDialogAtom)
  }

  async function saveDialog() {
    const payload = store.getter(numberFormatDialogSavePayloadAtom)
    if (!payload) return

    if (backend.setFormatRange) {
      try {
        const sourceRanges = resolveProjectionSourceRanges(
          store,
          payload.sheetId,
          payload.range,
        )
        for (const sourceRange of sourceRanges) {
          await backend.setFormatRange({
            kind: 'set-format-range',
            sheetId: payload.sheetId,
            range: sourceRange,
            format: payload.format,
          })
        }
        await refreshVisibleProjection(store, backend, payload.sheetId)
      } catch {
        return
      }
    }

    store.setter(saveNumberFormatDialogAtom)
  }

  function renderCurrencyList(open: NumberFormatDialogOpenState) {
    return (
      <>
        <label class="number-format-dialog-decimals">
          <span>{t('numberFormatDialog.decimalPlaces')}</span>
          <input
            type="number"
            min="0"
            max="20"
            data-testid="number-format-dialog-decimals"
            value={open.digits}
            onInput={(event) => setDigits(event.currentTarget.value)}
          />
        </label>
        <div
          class="number-format-dialog-list number-format-dialog-currency-list"
          role="listbox"
          aria-label={t('numberFormatDialog.currency.listLabel')}
        >
          <For each={CURRENCY_FORMAT_OPTIONS}>
            {(option) => (
              <button
                type="button"
                class={`number-format-dialog-row ${
                  open.selectedId === option.id ? 'number-format-dialog-row-selected' : ''
                }`.trim()}
                data-testid={`number-format-dialog-option-${option.id}`}
                role="option"
                aria-selected={open.selectedId === option.id}
                onClick={() => setSelectedId(option.id)}
              >
                <span class="number-format-dialog-row-label">{t(option.labelKey)}</span>
                <span class="number-format-dialog-row-preview">
                  {currencyPreview(option, open.digits)}
                </span>
              </button>
            )}
          </For>
        </div>
      </>
    )
  }

  function renderPatternList(
    open: NumberFormatDialogOpenState,
    options: readonly PatternFormatOption[],
    labelKey: string,
  ) {
    return (
      <div
        class="number-format-dialog-list number-format-dialog-pattern-list"
        role="listbox"
        aria-label={t(labelKey)}
      >
        <For each={options}>
          {(option) => (
            <button
              type="button"
              class={`number-format-dialog-row ${
                open.selectedId === option.id ? 'number-format-dialog-row-selected' : ''
              }`.trim()}
              data-testid={`number-format-dialog-option-${option.id}`}
              role="option"
              aria-selected={open.selectedId === option.id}
              onClick={() => setSelectedId(option.id)}
            >
              <span class="number-format-dialog-row-label">{t(option.exampleKey)}</span>
              <span class="number-format-dialog-row-pattern">{option.pattern}</span>
            </button>
          )}
        </For>
      </div>
    )
  }

  function renderBody(open: NumberFormatDialogOpenState) {
    if (open.kind === 'currency') return renderCurrencyList(open)
    if (open.kind === 'dateTime') {
      return renderPatternList(
        open,
        DATE_TIME_FORMAT_OPTIONS,
        'numberFormatDialog.dateTime.listLabel',
      )
    }
    return renderPatternList(open, NUMBER_FORMAT_OPTIONS, 'numberFormatDialog.number.listLabel')
  }

  return (
    <Show when={dialog()}>
      {(open) => (
        <div
          class={`number-format-dialog ${props.class ?? ''}`.trim()}
          data-testid={props['data-testid'] ?? 'number-format-dialog'}
          data-dialog-kind={open().kind}
          role="dialog"
          aria-modal="true"
          aria-labelledby="number-format-dialog-title"
        >
          <div class="number-format-dialog-header">
            <h2 class="number-format-dialog-title" id="number-format-dialog-title">
              {t(TITLE_KEYS[open().kind])}
            </h2>
            <button
              type="button"
              class="dialog-close-x"
              data-testid="number-format-dialog-close"
              aria-label={t('dialog.close.label')}
              onClick={closeDialog}
            >
              ×
            </button>
          </div>

          <div class="number-format-dialog-body">{renderBody(open())}</div>

          <div class="number-format-dialog-actions">
            <button
              type="button"
              data-testid="number-format-dialog-cancel"
              onClick={closeDialog}
            >
              {t('formatCells.cancel')}
            </button>
            <button type="button" data-testid="number-format-dialog-save" onClick={saveDialog}>
              {t('formatCells.save')}
            </button>
          </div>
        </div>
      )}
    </Show>
  )
}
