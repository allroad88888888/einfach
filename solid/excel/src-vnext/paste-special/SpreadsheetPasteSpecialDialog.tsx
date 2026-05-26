/** @jsxImportSource solid-js */

import { Show, createEffect, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  clipboardStateAtom,
  closePasteSpecialAtom,
  nextHistoryTransactionId,
  patchPasteSpecialOptionsAtom,
  pasteSpecialOpenAtom,
  pasteSpecialOptionsAtom,
  pushHistoryAtom,
  selectionSnapshotAtom,
  workspaceSessionAtom,
  type PasteSpecialKind,
  type PasteSpecialOp,
} from '@einfach/spreadsheet-ui-core'
import {
  pasteSpecialSupportedAtom,
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
  void import('./paste-special-dialog.css')
}

export interface SpreadsheetPasteSpecialDialogProps {
  class?: string
  'data-testid'?: string
}

const PASTE_KINDS: readonly PasteSpecialKind[] = [
  'values',
  'formats',
  'values-and-formats',
  'all',
  'transpose',
  'column-widths',
  'comments',
]

const PASTE_OPS: readonly PasteSpecialOp[] = [
  'none',
  'add',
  'subtract',
  'multiply',
  'divide',
]

export function SpreadsheetPasteSpecialDialog(
  props: SpreadsheetPasteSpecialDialogProps,
) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const isOpen = useAtomValue(pasteSpecialOpenAtom)
  const options = useAtomValue(pasteSpecialOptionsAtom)
  const supported = useAtomValue(pasteSpecialSupportedAtom)

  // Reset-on-open is owned by `openPasteSpecialAtom` (a write-only
  // command atom that flips open + writes defaults in a single setter).
  // We deliberately avoid mirroring that reset in a `createEffect<bool>`
  // wasOpen → open edge detector here: under Solid 1.9.12 the provider
  // re-mount hazard causes the consumer body to re-execute on unrelated
  // atom mutations, and the createEffect would re-fire with stale prev
  // state, wiping user selections mid-interaction. Keeping the reset
  // store-side (single source of truth) is the canonical workaround,
  // per CLAUDE.md "Known limitation: solid-js 1.9.12 Provider interaction".
  createEffect(() => {
    if (!isOpen()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        store.setter(closePasteSpecialAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  async function handleConfirm() {
    const opts = options()
    // Capability re-check: the menu hides this surface when the backend
    // omits `pasteRange`, but a stale dialog could still be open during
    // a backend swap. Close on miss + warn.
    if (!supported() || !backend.pasteRange) {
      // eslint-disable-next-line no-console
      console.warn(
        '[paste-special] backend.pasteRange unavailable at confirm; closing dialog.',
      )
      store.setter(closePasteSpecialAtom)
      return
    }

    const clipboard = store.getter(clipboardStateAtom)
    const snapshot = store.getter(selectionSnapshotAtom)
    const workspace = store.getter(workspaceSessionAtom)
    const sheetId = snapshot.selection.sheetId || workspace.activeSheetId || ''

    if (!sheetId || !clipboard.source || !clipboard.payload) {
      // eslint-disable-next-line no-console
      console.warn(
        '[paste-special] clipboard source or active selection missing; closing dialog.',
      )
      store.setter(closePasteSpecialAtom)
      return
    }

    const targetRange = { ...snapshot.range }
    try {
      const result = await backend.pasteRange({
        kind: 'paste-range',
        sheetId,
        target: targetRange,
        source: {
          sheetId: clipboard.source.sheetId,
          range: { ...clipboard.source.range },
          payload: clipboard.payload,
        },
        pasteKind: opts.kind,
        op: opts.op,
        transpose: opts.transpose,
        skipBlanks: opts.skipBlanks,
      })

      // Record a history entry so Ctrl+Z can revert the paste. The host's
      // dispatchUndo will call `backend.undoTransaction` (when present)
      // and the static reference backend pops the most recent mutation.
      const projectionRevision =
        typeof result?.revision === 'number'
          ? result.revision
          : Number(result?.revision ?? 0) || 0
      store.setter(pushHistoryAtom, {
        transactionId: nextHistoryTransactionId(),
        kind: 'cells.import',
        sheetId,
        projectionRevision,
        affectedRange: result?.affectedRange ?? targetRange,
      })

      // Repaint the viewport now that backend cells changed. Mirrors how
      // the plain Ctrl+V handler in SpreadsheetGrid finishes the flow.
      await refreshVisibleProjection(store, backend, sheetId, 'toolbar')
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[paste-special] backend.pasteRange threw:', error)
    } finally {
      store.setter(closePasteSpecialAtom)
    }
  }

  function handleCancel() {
    store.setter(closePasteSpecialAtom)
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`paste-special-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'paste-special-dialog'}
        role="dialog"
        aria-label={t('pasteSpecial.title')}
      >
        <div class="ps-header">
          <span class="ps-title">{t('pasteSpecial.title')}</span>
          <button
            type="button"
            class="dialog-close-x"
            data-testid="paste-special-close-x"
            aria-label={t('pasteSpecial.cancel')}
            onClick={handleCancel}
          >
            ×
          </button>
        </div>

        <div class="ps-body">
          <fieldset class="ps-fieldset" data-testid="paste-special-kind-group">
            <legend class="ps-legend">{t('pasteSpecial.kind.legend')}</legend>
            {PASTE_KINDS.map((kind) => (
              <label class="ps-radio">
                <input
                  type="radio"
                  name="paste-special-kind"
                  data-testid={`paste-special-kind-${kind}`}
                  checked={options().kind === kind}
                  onChange={() =>
                    store.setter(patchPasteSpecialOptionsAtom, { kind })
                  }
                />
                {t(`pasteSpecial.kind.${kind}`)}
              </label>
            ))}
          </fieldset>

          <div class="ps-field">
            <label class="ps-field-label" for="paste-special-op">
              {t('pasteSpecial.op.legend')}
            </label>
            <select
              id="paste-special-op"
              class="ps-select"
              data-testid="paste-special-op-select"
              value={options().op}
              onChange={(event) =>
                store.setter(patchPasteSpecialOptionsAtom, {
                  op: event.currentTarget.value as PasteSpecialOp,
                })
              }
            >
              {PASTE_OPS.map((op) => (
                <option value={op}>{t(`pasteSpecial.op.${op}`)}</option>
              ))}
            </select>
          </div>

          <div class="ps-options">
            <label class="ps-option">
              <input
                type="checkbox"
                data-testid="paste-special-transpose"
                checked={options().transpose}
                onChange={(event) =>
                  store.setter(patchPasteSpecialOptionsAtom, {
                    transpose: event.currentTarget.checked,
                  })
                }
              />
              {t('pasteSpecial.transpose')}
            </label>
            <label class="ps-option">
              <input
                type="checkbox"
                data-testid="paste-special-skip-blanks"
                checked={options().skipBlanks}
                onChange={(event) =>
                  store.setter(patchPasteSpecialOptionsAtom, {
                    skipBlanks: event.currentTarget.checked,
                  })
                }
              />
              {t('pasteSpecial.skipBlanks')}
            </label>
          </div>
        </div>

        <div class="ps-footer">
          <button
            type="button"
            class="ps-btn"
            data-testid="paste-special-cancel-button"
            onClick={handleCancel}
          >
            {t('pasteSpecial.cancel')}
          </button>
          <button
            type="button"
            class="ps-btn ps-btn-primary"
            data-testid="paste-special-confirm-button"
            onClick={() => void handleConfirm()}
          >
            {t('pasteSpecial.confirm')}
          </button>
        </div>
      </div>
    </Show>
  )
}
