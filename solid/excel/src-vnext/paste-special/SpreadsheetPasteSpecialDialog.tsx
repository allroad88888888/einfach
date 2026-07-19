/** @jsxImportSource solid-js */

import { Show, createEffect, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  PASTE_SPECIAL_UNSUPPORTED_KIND_ERROR,
  closePasteSpecialAtom,
  confirmPasteSpecialAtom,
  isPasteSpecialKindSupported,
  pasteSpecialBackendKindError,
  patchPasteSpecialOptionsAtom,
  pasteSpecialCanCloseAtom,
  pasteSpecialCanConfirmAtom,
  pasteSpecialCanEditAtom,
  pasteSpecialErrorAtom,
  pasteSpecialLifecycleAtom,
  pasteSpecialOpenAtom,
  pasteSpecialOptionsAtom,
  pasteSpecialSessionAtom,
  pasteSpecialSupportedKindsAtom,
  resolveContentMutationAtom,
  type PasteSpecialKind,
  type PasteSpecialOp,
} from '@einfach/spreadsheet-ui-core'
import { refreshVisibleProjection, useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

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

const PASTE_OPS: readonly PasteSpecialOp[] = ['none', 'add', 'subtract', 'multiply', 'divide']

export function SpreadsheetPasteSpecialDialog(props: SpreadsheetPasteSpecialDialogProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const isOpen = useAtomValue(pasteSpecialOpenAtom)
  const options = useAtomValue(pasteSpecialOptionsAtom)
  const session = useAtomValue(pasteSpecialSessionAtom)
  const lifecycle = useAtomValue(pasteSpecialLifecycleAtom)
  const error = useAtomValue(pasteSpecialErrorAtom)
  const canEdit = useAtomValue(pasteSpecialCanEditAtom)
  const canClose = useAtomValue(pasteSpecialCanCloseAtom)
  const canConfirm = useAtomValue(pasteSpecialCanConfirmAtom)
  const supportedKinds = useAtomValue(pasteSpecialSupportedKindsAtom)

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
        if (canClose()) store.setter(closePasteSpecialAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  async function handleConfirm() {
    const currentSession = session()
    if (currentSession === null) return
    // Mutation gateway: the frozen Core session can only express its original
    // contiguous display-coordinate target, so a protection block or any
    // active display→source row remap fails closed here — zero transport, and
    // the gateway records the structured diagnostic + lastBlock.
    if (currentSession.sheetId !== null && currentSession.target !== null) {
      const resolution = store.setter(resolveContentMutationAtom, {
        kind: 'paste-range',
        sheetId: currentSession.sheetId,
        range: currentSession.target,
        requireIdentityMapping: true,
      })
      if (resolution.status === 'blocked') return
    }
    await store.setter(confirmPasteSpecialAtom, {
      source: backend,
      sessionId: currentSession.sessionId,
      refreshProjection: (sheetId) => refreshVisibleProjection(store, backend, sheetId, 'toolbar'),
    })
  }

  function handleCancel() {
    store.setter(closePasteSpecialAtom)
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`paste-special-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'paste-special-dialog'}
        data-lifecycle={lifecycle().status}
        role="dialog"
        aria-label={t('pasteSpecial.title')}
        aria-busy={
          lifecycle().status === 'pending' ||
          lifecycle().status === 'local-acknowledged' ||
          lifecycle().status === 'refreshing'
        }
      >
        <div class="ps-header">
          <span class="ps-title">{t('pasteSpecial.title')}</span>
          <button
            type="button"
            class="dialog-close-x"
            data-testid="paste-special-close-x"
            aria-label={t('pasteSpecial.cancel')}
            disabled={!canClose()}
            onClick={handleCancel}
          >
            ×
          </button>
        </div>

        <div class="ps-body">
          <fieldset class="ps-fieldset" data-testid="paste-special-kind-group">
            <legend class="ps-legend">{t('pasteSpecial.kind.legend')}</legend>
            {PASTE_KINDS.map((kind) => {
              const supportedKind = isPasteSpecialKindSupported(kind)
              // Backend capability subdivision: a kind the captured
              // backend excluded (e.g. format-leg kinds on a runtime
              // with no format model) renders disabled with the same
              // structured reason Core would block the confirm with.
              const backendSupported = () => supportedKinds().includes(kind)
              return (
                <label
                  class="ps-radio"
                  title={
                    !supportedKind
                      ? PASTE_SPECIAL_UNSUPPORTED_KIND_ERROR
                      : backendSupported()
                        ? undefined
                        : pasteSpecialBackendKindError(kind)
                  }
                >
                  <input
                    type="radio"
                    name="paste-special-kind"
                    data-testid={`paste-special-kind-${kind}`}
                    checked={options().kind === kind}
                    disabled={!canEdit() || !supportedKind || !backendSupported()}
                    onChange={() => store.setter(patchPasteSpecialOptionsAtom, { kind })}
                  />
                  {t(`pasteSpecial.kind.${kind}`)}
                </label>
              )
            })}
          </fieldset>

          <p data-testid="paste-special-unsupported-explanation">
            {PASTE_SPECIAL_UNSUPPORTED_KIND_ERROR}
          </p>

          <div class="ps-field">
            <label class="ps-field-label" for="paste-special-op">
              {t('pasteSpecial.op.legend')}
            </label>
            <select
              id="paste-special-op"
              class="ps-select"
              data-testid="paste-special-op-select"
              value={options().op}
              disabled={!canEdit()}
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
                disabled={!canEdit()}
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
                disabled={!canEdit()}
                onChange={(event) =>
                  store.setter(patchPasteSpecialOptionsAtom, {
                    skipBlanks: event.currentTarget.checked,
                  })
                }
              />
              {t('pasteSpecial.skipBlanks')}
            </label>
          </div>

          <Show when={error()}>
            <p role="alert" data-testid="paste-special-error">
              {error()}
            </p>
          </Show>
        </div>

        <div class="ps-footer">
          <button
            type="button"
            class="ps-btn"
            data-testid="paste-special-cancel-button"
            disabled={!canClose()}
            onClick={handleCancel}
          >
            {t('pasteSpecial.cancel')}
          </button>
          <button
            type="button"
            class="ps-btn ps-btn-primary"
            data-testid="paste-special-confirm-button"
            disabled={!canConfirm()}
            onClick={() => void handleConfirm()}
          >
            {t('pasteSpecial.confirm')}
          </button>
        </div>
      </div>
    </Show>
  )
}
