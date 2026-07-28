/** @jsxImportSource solid-js */

import { For, Show, createEffect, createMemo, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  captureRemoveDuplicatesCapabilityAtom,
  closeRemoveDuplicatesAtom,
  dispatchRemoveDuplicatesIntentAtom,
  removeDuplicatesBusyAtom,
  removeDuplicatesCanCloseAtom,
  removeDuplicatesCanConfirmAtom,
  removeDuplicatesComparisonAtom,
  removeDuplicatesErrorAtom,
  removeDuplicatesExcludeHeaderAtom,
  removeDuplicatesKeyColumnsAtom,
  removeDuplicatesLifecycleAtom,
  removeDuplicatesOpenAtom,
  removeDuplicatesPreviewAtom,
  removeDuplicatesRangeAtom,
  removeDuplicatesScanInputCellsAtom,
  removeDuplicatesSessionAtom,
  runRemoveDuplicatesConfirmAtom,
  type DisplayCell,
  type RemoveDuplicatesComparison,
} from '@einfach/spreadsheet-ui-core'
import { refreshVisibleProjection, useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

// CSS import gated like other vnext dialogs — jest skips the dynamic
// import so unit tests aren't blocked by the lack of a CSS transform.
if (typeof process === 'undefined' || !process.env.JEST_WORKER_ID) {
  void import('./remove-duplicates-dialog.css')
}

export interface SpreadsheetRemoveDuplicatesDialogProps {
  class?: string
  'data-testid'?: string
}

const COMPARISON_CHOICES: ReadonlyArray<RemoveDuplicatesComparison> = [
  'exact',
  'caseInsensitive',
  'trim',
  'trimAndIgnoreCase',
]

/** A-Z, AA-AZ, ... Excel-style column letters. */
function columnLetter(index: number): string {
  let n = index
  let out = ''
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  }
  return out
}

export function SpreadsheetRemoveDuplicatesDialog(props: SpreadsheetRemoveDuplicatesDialogProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const isOpen = useAtomValue(removeDuplicatesOpenAtom)
  const range = useAtomValue(removeDuplicatesRangeAtom)
  const cells = useAtomValue(removeDuplicatesScanInputCellsAtom)
  const keyColumns = useAtomValue(removeDuplicatesKeyColumnsAtom)
  const comparison = useAtomValue(removeDuplicatesComparisonAtom)
  const excludeHeader = useAtomValue(removeDuplicatesExcludeHeaderAtom)
  const preview = useAtomValue(removeDuplicatesPreviewAtom)
  const session = useAtomValue(removeDuplicatesSessionAtom)
  const lifecycle = useAtomValue(removeDuplicatesLifecycleAtom)
  const error = useAtomValue(removeDuplicatesErrorAtom)
  const canClose = useAtomValue(removeDuplicatesCanCloseAtom)
  const canConfirm = useAtomValue(removeDuplicatesCanConfirmAtom)
  const busy = useAtomValue(removeDuplicatesBusyAtom)

  createEffect(() => {
    store.setter(captureRemoveDuplicatesCapabilityAtom, backend)
  })

  // Reset-on-open lives store-side inside `openRemoveDuplicatesAtom`
  // (range + cells + default key set + open flag flipped in one setter).
  // We deliberately do NOT mirror that via `createEffect<boolean>` open-edge:
  // under Solid 1.9.12 the consumer body re-executes on unrelated atom
  // mutations, which would re-fire the edge with a stale prev and clobber
  // the user's column / comparison choices mid-interaction. This is the
  // canonical pattern from SpreadsheetPasteSpecialDialog — see CLAUDE.md
  // "Known limitation: solid-js 1.9.12 Provider interaction".

  createEffect(() => {
    if (!isOpen()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        store.setter(closeRemoveDuplicatesAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  // Column descriptor list derived from the current range. Header labels
  // come from the first-row cells when `excludeHeader` is on, falling
  // back to "Column A/B/..." when the header value is missing or the
  // option is off.
  const columnDescriptors = createMemo<Array<{ col: number; letter: string; label: string }>>(
    () => {
      const r = range()
      if (!r) return []
      const headerRow = r.startRow
      const headerByCol = new Map<number, string>()
      if (excludeHeader()) {
        for (const cell of cells() as ReadonlyArray<DisplayCell>) {
          if (cell.row !== headerRow) continue
          const display = cell.displayValue ?? ''
          if (display.trim().length > 0) headerByCol.set(cell.col, display)
        }
      }
      const out: Array<{ col: number; letter: string; label: string }> = []
      for (let col = r.startCol; col <= r.endCol; col += 1) {
        const letter = columnLetter(col)
        const header = headerByCol.get(col)
        out.push({ col, letter, label: header ? `${letter} — ${header}` : letter })
      }
      return out
    },
  )

  const previewMessage = createMemo<string>(() => {
    const p = preview()
    if (!p) return ''
    if (p.noKeyColumns) {
      return t('removeDuplicates.preview.noKeyColumns')
    }
    // Zero-duplicate UX branch (LOW finding): when keyColumns are set but
    // no duplicates were found, the "Will remove 0 of N rows" summary
    // reads as a degenerate case. The locale already ships a friendlier
    // `noDuplicates` string for exactly this state — surface it.
    if (p.duplicateRows.length === 0) {
      return t('removeDuplicates.preview.noDuplicates')
    }
    return t('removeDuplicates.preview.summary', {
      duplicates: p.duplicateRows.length,
      scanned: p.scannedRows,
      unique: p.uniqueRows,
    })
  })

  function handleConfirm() {
    const sessionId = session()?.sessionId
    if (sessionId === undefined) return
    void store.setter(runRemoveDuplicatesConfirmAtom, {
      source: backend,
      sessionId,
      refreshProjection: (sheetId) => refreshVisibleProjection(store, backend, sheetId, 'toolbar'),
    })
  }

  function handleCancel() {
    store.setter(closeRemoveDuplicatesAtom)
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`remove-duplicates-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'remove-duplicates-dialog'}
        data-status={lifecycle().status}
        role="dialog"
        aria-label={t('removeDuplicates.title')}
        aria-busy={busy()}
      >
        <div class="rd-header">
          <span class="rd-title">{t('removeDuplicates.title')}</span>
          <button
            type="button"
            class="dialog-close-x"
            data-testid="remove-duplicates-close-x"
            aria-label={t('removeDuplicates.cancel')}
            disabled={!canClose()}
            onClick={handleCancel}
          >
            ×
          </button>
        </div>

        <div class="rd-body">
          <label class="rd-option">
            <input
              type="checkbox"
              data-testid="remove-duplicates-exclude-header"
              checked={excludeHeader()}
              disabled={lifecycle().status !== 'editing'}
              onChange={(event) => {
                store.setter(dispatchRemoveDuplicatesIntentAtom, {
                  kind: 'set-exclude-header',
                  excludeHeader: event.currentTarget.checked,
                })
              }}
            />
            {t('removeDuplicates.excludeHeader')}
          </label>

          <fieldset class="rd-fieldset" data-testid="remove-duplicates-columns-group">
            <legend class="rd-legend">{t('removeDuplicates.columns.legend')}</legend>
            <div class="rd-columns-grid">
              <For each={columnDescriptors()}>
                {(desc) => (
                  <label class="rd-checkbox">
                    <input
                      type="checkbox"
                      data-testid={`remove-duplicates-column-${desc.col}`}
                      checked={keyColumns().has(desc.col)}
                      disabled={lifecycle().status !== 'editing'}
                      onChange={() =>
                        store.setter(dispatchRemoveDuplicatesIntentAtom, {
                          kind: 'toggle-key-column',
                          column: desc.col,
                        })
                      }
                    />
                    {desc.label}
                  </label>
                )}
              </For>
            </div>
            <div class="rd-column-actions">
              <button
                type="button"
                class="rd-link-btn"
                data-testid="remove-duplicates-select-all"
                disabled={lifecycle().status !== 'editing'}
                onClick={() =>
                  store.setter(dispatchRemoveDuplicatesIntentAtom, {
                    kind: 'select-all-key-columns',
                  })
                }
              >
                {t('removeDuplicates.columns.selectAll')}
              </button>
              <button
                type="button"
                class="rd-link-btn"
                data-testid="remove-duplicates-deselect-all"
                disabled={lifecycle().status !== 'editing'}
                onClick={() =>
                  store.setter(dispatchRemoveDuplicatesIntentAtom, {
                    kind: 'deselect-all-key-columns',
                  })
                }
              >
                {t('removeDuplicates.columns.deselectAll')}
              </button>
            </div>
          </fieldset>

          <fieldset class="rd-fieldset" data-testid="remove-duplicates-comparison-group">
            <legend class="rd-legend">{t('removeDuplicates.comparison.legend')}</legend>
            <div class="rd-comparison-grid">
              <For each={COMPARISON_CHOICES}>
                {(choice) => (
                  <label class="rd-radio">
                    <input
                      type="radio"
                      name="remove-duplicates-comparison"
                      data-testid={`remove-duplicates-comparison-${choice}`}
                      checked={comparison() === choice}
                      disabled={lifecycle().status !== 'editing'}
                      onChange={() =>
                        store.setter(dispatchRemoveDuplicatesIntentAtom, {
                          kind: 'set-comparison',
                          comparison: choice,
                        })
                      }
                    />
                    {t(`removeDuplicates.comparison.${choice}`)}
                  </label>
                )}
              </For>
            </div>
          </fieldset>

          <div class="rd-preview" data-testid="remove-duplicates-preview">
            <div class="rd-preview-label">{t('removeDuplicates.preview.label')}</div>
            <div class="rd-preview-text">{previewMessage()}</div>
          </div>
          <Show when={error().length > 0}>
            <div role="alert" data-testid="remove-duplicates-error">
              {error()}
            </div>
          </Show>
        </div>

        <div class="rd-footer">
          <button
            type="button"
            class="rd-btn"
            data-testid="remove-duplicates-cancel-button"
            disabled={!canClose()}
            onClick={handleCancel}
          >
            {t('removeDuplicates.cancel')}
          </button>
          <button
            type="button"
            class="rd-btn rd-btn-primary"
            data-testid="remove-duplicates-confirm-button"
            disabled={!canConfirm()}
            onClick={handleConfirm}
          >
            {t('removeDuplicates.confirm')}
          </button>
        </div>
      </div>
    </Show>
  )
}
