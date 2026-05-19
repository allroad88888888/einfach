/** @jsxImportSource solid-js */

import { Show, createEffect, createSignal } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  closeProtectionUnlockAtom,
  issueProtectionUnlockSyncTicketAtom,
  protectionUnlockStateAtom,
  protectionUnlockSyncTicketAtom,
  setProtectionUnlockErrorAtom,
  setProtectionUnlockPendingAtom,
  type CellRange,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'

export interface SpreadsheetProtectionUnlockDialogProps {
  class?: string
  'data-testid'?: string
  /** Optional credential verifier. When supplied, the dialog calls this before
   *  invoking the backend.setRangeLock call; rejection blocks the unlock and
   *  surfaces the rejection message via the error slot. */
  verifySheetProtection?: (input: {
    sheetId: string
    range?: CellRange
    password: string
  }) => Promise<{ ok: boolean; message?: string }>
}

export function SpreadsheetProtectionUnlockDialog(props: SpreadsheetProtectionUnlockDialogProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const state = useAtomValue(protectionUnlockStateAtom)

  const [password, setPassword] = createSignal('')

  createEffect<boolean>((wasOpen) => {
    const open = state().isOpen
    if (open && !wasOpen) {
      setPassword('')
    }
    return open
  }, false)

  function handleClose() {
    // Advance the ticket so any in-flight unlock resolves into a no-op
    // instead of writing into a future reopened dialog's state.
    store.setter(issueProtectionUnlockSyncTicketAtom)
    store.setter(closeProtectionUnlockAtom)
  }

  async function handleUnlock() {
    const current = state()
    if (!current.isOpen || !current.target) return
    const pwd = password()

    const ticket = store.setter(issueProtectionUnlockSyncTicketAtom) as number
    store.setter(setProtectionUnlockPendingAtom, true)

    function isStale(): boolean {
      return ticket !== store.getter(protectionUnlockSyncTicketAtom)
    }

    if (props.verifySheetProtection) {
      try {
        const result = await props.verifySheetProtection({
          sheetId: current.target.sheetId,
          range: current.target.range,
          password: pwd,
        })
        if (isStale()) return
        if (!result.ok) {
          store.setter(setProtectionUnlockErrorAtom, result.message ?? 'Incorrect password')
          return
        }
      } catch (err) {
        if (isStale()) return
        store.setter(
          setProtectionUnlockErrorAtom,
          err instanceof Error ? err.message : String(err),
        )
        return
      }
    }

    if (backend.setRangeLock && current.target.range) {
      try {
        await backend.setRangeLock({
          kind: 'set-range-lock',
          sheetId: current.target.sheetId,
          range: current.target.range,
          locked: false,
        })
        if (isStale()) return
      } catch (err) {
        if (isStale()) return
        store.setter(
          setProtectionUnlockErrorAtom,
          err instanceof Error ? err.message : String(err),
        )
        return
      }
    }

    if (isStale()) return
    store.setter(closeProtectionUnlockAtom)
  }

  function targetLabel(): string {
    const target = state().target
    if (!target) return ''
    if (!target.range) return target.sheetId
    const r = target.range
    return `${target.sheetId} r${r.rowStart}-${r.rowEnd} c${r.colStart}-${r.colEnd}`
  }

  return (
    <Show when={state().isOpen}>
      <div
        class={`protection-unlock-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'protection-unlock-dialog'}
        role="dialog"
        aria-modal="true"
        aria-label="Unlock protected range"
      >
        <div class="protection-unlock-row">
          <span class="protection-unlock-target" data-testid="protection-unlock-target">
            {targetLabel()}
          </span>
        </div>
        <div class="protection-unlock-row">
          <label class="protection-unlock-label" for="protection-unlock-password">
            Password
          </label>
          <input
            id="protection-unlock-password"
            class="protection-unlock-input"
            data-testid="protection-unlock-password"
            type="password"
            value={password()}
            disabled={state().pending}
            onInput={(e) => setPassword(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void handleUnlock()
              }
            }}
          />
        </div>

        <Show when={state().error}>
          <div
            class="protection-unlock-error"
            data-testid="protection-unlock-error"
            role="alert"
          >
            {state().error}
          </div>
        </Show>

        <div class="protection-unlock-actions">
          <button
            type="button"
            class="protection-unlock-btn"
            data-testid="protection-unlock-confirm"
            disabled={state().pending}
            onClick={() => void handleUnlock()}
          >
            Unlock
          </button>
          <button
            type="button"
            class="protection-unlock-btn protection-unlock-btn-cancel"
            data-testid="protection-unlock-cancel"
            onClick={handleClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </Show>
  )
}
