/** @jsxImportSource solid-js */

import { For, Show, createEffect, createMemo, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  closeRemoveDuplicatesAtom,
  deselectAllKeyColumnsAtom,
  nextHistoryTransactionId,
  pushHistoryAtom,
  removeDuplicatesComparisonAtom,
  removeDuplicatesExcludeHeaderAtom,
  removeDuplicatesKeyColumnsAtom,
  removeDuplicatesOpenAtom,
  removeDuplicatesPreviewAtom,
  removeDuplicatesRangeAtom,
  removeDuplicatesScanInputCellsAtom,
  selectAllKeyColumnsAtom,
  toggleKeyColumnAtom,
  type DisplayCell,
  type RemoveDuplicatesComparison,
} from '@einfach/spreadsheet-ui-core'
import {
  refreshVisibleProjection,
  removeDuplicatesSheetIdAtom,
  removeDuplicatesSupportedAtom,
  useSpreadsheetBackend,
  useSpreadsheetUiStore,
} from '../provider'

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

export function SpreadsheetRemoveDuplicatesDialog(
  props: SpreadsheetRemoveDuplicatesDialogProps,
) {
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
  const supported = useAtomValue(removeDuplicatesSupportedAtom)

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
  const columnDescriptors = createMemo<
    Array<{ col: number; letter: string; label: string }>
  >(() => {
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
  })

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

  const removeDisabled = createMemo<boolean>(() => {
    const p = preview()
    if (!p) return true
    if (p.noKeyColumns) return true
    if (p.duplicateRows.length === 0) return true
    return false
  })

  async function handleConfirm() {
    const r = range()
    const p = preview()
    if (!r || !p || p.noKeyColumns || p.duplicateRows.length === 0) {
      store.setter(closeRemoveDuplicatesAtom)
      return
    }
    // Empty-cells safety check (HIGH bug: projection-failure mass deletion).
    // If the menubar opened the dialog with an empty cell list — typically
    // because `readRangeProjection` rejected or returned nothing — the
    // scanner treats the whole range as blank-tuple duplicates and a
    // confirm would wipe everything. Refuse to commit and surface the
    // friendly `noDuplicates` copy (the existing locale key is the closest
    // semantic fit — "no data loaded" reads the same way to the user).
    const cellList = cells() as ReadonlyArray<DisplayCell>
    const rangeArea = (r.endRow - r.startRow + 1) * (r.endCol - r.startCol + 1)
    if (cellList.length === 0 && rangeArea > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        '[remove-duplicates] confirm refused: no projection cells loaded for selection.',
      )
      store.setter(closeRemoveDuplicatesAtom)
      return
    }
    // Capability re-check at confirm time — the menu hides this surface
    // when the backend omits `removeRows`, but a stale dialog could still
    // be open if the backend was swapped underneath us.
    if (!supported() || !backend.removeRows) {
      // eslint-disable-next-line no-console
      console.warn(
        '[remove-duplicates] backend.removeRows unavailable at confirm; closing dialog.',
      )
      store.setter(closeRemoveDuplicatesAtom)
      return
    }

    // Read sheetId from the snapshot captured when the dialog opened
    // (HIGH bug: wrong-sheet deletion race). Using the live selection at
    // confirm time would delete rows from whichever sheet the user is now
    // viewing, not the sheet the dialog was scanning.
    const sheetId = store.getter(removeDuplicatesSheetIdAtom)
    if (!sheetId) {
      // eslint-disable-next-line no-console
      console.warn('[remove-duplicates] no captured sheetId at confirm; closing dialog.')
      store.setter(closeRemoveDuplicatesAtom)
      return
    }

    try {
      const result = await backend.removeRows({
        kind: 'remove-rows',
        sheetId,
        rows: p.duplicateRows,
      })

      // Record an undoable transaction so Ctrl+Z reverts the removal.
      // `row.delete` is the existing history kind for row removals.
      const projectionRevision =
        typeof result?.revision === 'number'
          ? result.revision
          : Number(result?.revision ?? 0) || 0
      const affected = result?.affectedRange
      const historyAffected = affected
        ? {
            rowStart: affected.startRow,
            rowEnd: affected.endRow,
            colStart: affected.startCol,
            colEnd: affected.endCol,
          }
        : {
            rowStart: r.startRow,
            rowEnd: r.endRow,
            colStart: r.startCol,
            colEnd: r.endCol,
          }
      store.setter(pushHistoryAtom, {
        transactionId: nextHistoryTransactionId(),
        kind: 'row.delete',
        sheetId,
        projectionRevision,
        affectedRange: historyAffected,
      })

      // Repaint the viewport now that the backend mutated cells.
      await refreshVisibleProjection(store, backend, sheetId, 'toolbar')
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[remove-duplicates] backend.removeRows threw:', error)
    } finally {
      store.setter(closeRemoveDuplicatesAtom)
    }
  }

  function handleCancel() {
    store.setter(closeRemoveDuplicatesAtom)
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`remove-duplicates-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'remove-duplicates-dialog'}
        role="dialog"
        aria-label={t('removeDuplicates.title')}
      >
        <div class="rd-header">
          <span class="rd-title">{t('removeDuplicates.title')}</span>
          <button
            type="button"
            class="dialog-close-x"
            data-testid="remove-duplicates-close-x"
            aria-label={t('removeDuplicates.cancel')}
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
              onChange={(event) => {
                store.setter(
                  removeDuplicatesExcludeHeaderAtom,
                  event.currentTarget.checked,
                )
              }}
            />
            {t('removeDuplicates.excludeHeader')}
          </label>

          <fieldset
            class="rd-fieldset"
            data-testid="remove-duplicates-columns-group"
          >
            <legend class="rd-legend">{t('removeDuplicates.columns.legend')}</legend>
            <div class="rd-columns-grid">
              <For each={columnDescriptors()}>
                {(desc) => (
                  <label class="rd-checkbox">
                    <input
                      type="checkbox"
                      data-testid={`remove-duplicates-column-${desc.col}`}
                      checked={keyColumns().has(desc.col)}
                      onChange={() =>
                        store.setter(toggleKeyColumnAtom, desc.col)
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
                onClick={() => store.setter(selectAllKeyColumnsAtom)}
              >
                {t('removeDuplicates.columns.selectAll')}
              </button>
              <button
                type="button"
                class="rd-link-btn"
                data-testid="remove-duplicates-deselect-all"
                onClick={() => store.setter(deselectAllKeyColumnsAtom)}
              >
                {t('removeDuplicates.columns.deselectAll')}
              </button>
            </div>
          </fieldset>

          <fieldset
            class="rd-fieldset"
            data-testid="remove-duplicates-comparison-group"
          >
            <legend class="rd-legend">
              {t('removeDuplicates.comparison.legend')}
            </legend>
            <div class="rd-comparison-grid">
              <For each={COMPARISON_CHOICES}>
                {(choice) => (
                  <label class="rd-radio">
                    <input
                      type="radio"
                      name="remove-duplicates-comparison"
                      data-testid={`remove-duplicates-comparison-${choice}`}
                      checked={comparison() === choice}
                      onChange={() =>
                        store.setter(removeDuplicatesComparisonAtom, choice)
                      }
                    />
                    {t(`removeDuplicates.comparison.${choice}`)}
                  </label>
                )}
              </For>
            </div>
          </fieldset>

          <div class="rd-preview" data-testid="remove-duplicates-preview">
            <div class="rd-preview-label">
              {t('removeDuplicates.preview.label')}
            </div>
            <div class="rd-preview-text">{previewMessage()}</div>
          </div>
        </div>

        <div class="rd-footer">
          <button
            type="button"
            class="rd-btn"
            data-testid="remove-duplicates-cancel-button"
            onClick={handleCancel}
          >
            {t('removeDuplicates.cancel')}
          </button>
          <button
            type="button"
            class="rd-btn rd-btn-primary"
            data-testid="remove-duplicates-confirm-button"
            disabled={removeDisabled()}
            onClick={() => void handleConfirm()}
          >
            {t('removeDuplicates.confirm')}
          </button>
        </div>
      </div>
    </Show>
  )
}
