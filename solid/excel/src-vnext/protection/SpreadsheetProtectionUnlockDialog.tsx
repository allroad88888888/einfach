/** @jsxImportSource solid-js */

import { Show, createEffect, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  closeProtectionUnlockAtom,
  protectionUnlockPasswordAtom,
  protectionUnlockStateAtom,
  refreshProtectionUnlockAtom,
  setProtectionUnlockPasswordAtom,
  submitProtectionUnlockAtom,
  type SubmitProtectionUnlockInput,
  type VerifySheetProtectionPort,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'

export interface SpreadsheetProtectionUnlockDialogProps {
  class?: string
  'data-testid'?: string
  /** Optional host password verifier. A rejection prevents the range-lock mutation. */
  verifySheetProtection?: VerifySheetProtectionPort
}

export function SpreadsheetProtectionUnlockDialog(props: SpreadsheetProtectionUnlockDialogProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const state = useAtomValue(protectionUnlockStateAtom)
  const password = useAtomValue(protectionUnlockPasswordAtom)

  createEffect(() => {
    if (!state().isOpen) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        handleClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  function handleClose() {
    store.setter(closeProtectionUnlockAtom)
  }

  function handleUnlock() {
    const verifySheetProtection = props.verifySheetProtection
    const input: SubmitProtectionUnlockInput = {
      ...(verifySheetProtection ? { verifySheetProtection } : {}),
      setRangeLock: backend.setRangeLock?.bind(backend),
      readSheetProtection: backend.readSheetProtection?.bind(backend),
    }
    return store.setter(submitProtectionUnlockAtom, input)
  }

  function handleRefresh() {
    const readSheetProtection = backend.readSheetProtection?.bind(backend)
    if (!readSheetProtection) return
    return store.setter(refreshProtectionUnlockAtom, { readSheetProtection })
  }

  function targetLabel(): string {
    const target = state().target
    if (!target) return ''
    if (!target.range) {
      return t('protection.unlock.target.sheet', { sheetId: target.sheetId })
    }
    const r = target.range
    return t('protection.unlock.target.range', {
      sheetId: target.sheetId,
      rowStart: r.rowStart + 1,
      rowEnd: r.rowEnd + 1,
      colStart: r.colStart + 1,
      colEnd: r.colEnd + 1,
    })
  }

  return (
    <Show when={state().isOpen}>
      <div
        class={`protection-unlock-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'protection-unlock-dialog'}
        role="dialog"
        aria-modal="true"
        aria-label={t('protection.unlock.ariaLabel')}
      >
        <button
          type="button"
          class="dialog-close-x"
          data-testid="dialog-close-x"
          aria-label={t('dialog.close.label')}
          onClick={handleClose}
        >
          ×
        </button>
        <div class="protection-unlock-row">
          <span class="protection-unlock-target" data-testid="protection-unlock-target">
            {targetLabel()}
          </span>
        </div>
        <div class="protection-unlock-row">
          <label class="protection-unlock-label" for="protection-unlock-password">
            {t('protection.unlock.password')}
          </label>
          <input
            id="protection-unlock-password"
            class="protection-unlock-input"
            data-testid="protection-unlock-password"
            type="password"
            value={password()}
            disabled={state().pending || state().recoveryRequired}
            onInput={(e) => store.setter(setProtectionUnlockPasswordAtom, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !state().recoveryRequired) {
                e.preventDefault()
                void handleUnlock()
              }
            }}
          />
        </div>

        <Show when={state().error}>
          <div class="protection-unlock-error" data-testid="protection-unlock-error" role="alert">
            {state().error}
          </div>
        </Show>

        <div class="protection-unlock-actions">
          <Show
            when={state().recoveryRequired}
            fallback={
              <button
                type="button"
                class="protection-unlock-btn"
                data-testid="protection-unlock-confirm"
                disabled={state().pending}
                onClick={() => void handleUnlock()}
              >
                {t('protection.unlock.confirm')}
              </button>
            }
          >
            <button
              type="button"
              class="protection-unlock-btn"
              data-testid="protection-unlock-refresh"
              disabled={state().pending}
              onClick={() => void handleRefresh()}
            >
              {t('protection.unlock.refresh')}
            </button>
          </Show>
          <button
            type="button"
            class="protection-unlock-btn protection-unlock-btn-cancel"
            data-testid="protection-unlock-cancel"
            onClick={handleClose}
          >
            {t('protection.unlock.cancel')}
          </button>
        </div>
      </div>
    </Show>
  )
}
