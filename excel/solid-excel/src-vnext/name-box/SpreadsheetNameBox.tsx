/** @jsxImportSource solid-js */

import { onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  blurNameBoxAtom,
  commitNameBoxAtom,
  focusNameBoxAtom,
  nameBoxDisplayAtom,
  nameBoxErrorAtom,
  nameBoxFocusedAtom,
  nameBoxInputAtom,
  nameBoxLastCommittedAtom,
  nameBoxModeAtom,
  revertNameBoxAtom,
  scrollToCellAtom,
  selectionSnapshotAtom,
  setWorkspaceActiveSheetAtom,
  updateNameBoxInputAtom,
  workspaceSessionAtom,
  type NameBoxCommitTarget,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider/hooks'

export interface SpreadsheetNameBoxProps {
  class?: string
  'data-testid'?: string
}

export function SpreadsheetNameBox(props: SpreadsheetNameBoxProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const t = useT()
  const display = useAtomValue(nameBoxDisplayAtom)
  const mode = useAtomValue(nameBoxModeAtom)
  const error = useAtomValue(nameBoxErrorAtom)
  const focused = useAtomValue(nameBoxFocusedAtom)
  const input = useAtomValue(nameBoxInputAtom)

  // These tokens belong only to the mounted DOM node. Product state and the
  // authoritative edit-session witness remain in spreadsheet-ui-core.
  let inputRef: HTMLInputElement | undefined
  let domSessionId: number | undefined
  let handledBlurSessionId: number | undefined

  onCleanup(() => {
    const sessionId = domSessionId
    if (sessionId !== undefined) {
      store.setter(blurNameBoxAtom, { sessionId })
    }
    inputRef = undefined
    domSessionId = undefined
    handledBlurSessionId = undefined
  })

  function renderedValue(): string {
    return focused() ? input() : display()
  }

  function onInput(event: InputEvent) {
    const target = event.currentTarget as HTMLInputElement | null
    const sessionId = domSessionId
    if (!target || sessionId === undefined) return
    const accepted = store.setter(updateNameBoxInputAtom, {
      input: target.value,
      sessionId,
    })
    if (!accepted) {
      target.value = renderedValue()
    }
  }

  function commitCurrent(sessionId: number): NameBoxCommitTarget {
    const snapshot = store.getter(selectionSnapshotAtom)
    const workspace = store.getter(workspaceSessionAtom)
    // The workspace sheet is the canonical fallback before a selection has
    // acquired its sheet witness (for example, immediately after mount).
    const sheetId =
      snapshot.selection.sheetId && snapshot.selection.sheetId.length > 0
        ? snapshot.selection.sheetId
        : (workspace.activeSheetId ?? '')
    const activeSheetId = workspace.activeSheetId ?? sheetId
    const target = store.setter(commitNameBoxAtom, {
      input: store.getter(nameBoxInputAtom),
      sheetId,
      source: backend,
      sessionId,
    })

    if (target.kind === 'named-range' && target.sheetId !== activeSheetId) {
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: target.sheetId })
    }

    if (target.kind === 'cell' || target.kind === 'range' || target.kind === 'named-range') {
      const coord =
        target.kind === 'cell'
          ? target.coord
          : target.kind === 'range'
            ? { row: target.range.rowStart, col: target.range.colStart }
            : target.range
              ? { row: target.range.rowStart, col: target.range.colStart }
              : target.coord
      if (coord) {
        store.setter(scrollToCellAtom, { coord })
      }
    }
    return target
  }

  function focusGridAfterCommit() {
    const grid = inputRef
      ?.closest('.demo-page, [data-testid$="-demo"]')
      ?.querySelector('.spreadsheet-grid') as HTMLElement | null
    grid?.focus()
  }

  function finishHandledSession(sessionId: number) {
    store.setter(blurNameBoxAtom, { sessionId })
    if (domSessionId === sessionId) {
      domSessionId = undefined
      handledBlurSessionId = undefined
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    const sessionId = domSessionId
    if (sessionId === undefined) return

    if (event.key === 'Enter' || event.code === 'Enter') {
      event.preventDefault()
      handledBlurSessionId = sessionId
      const target = commitCurrent(sessionId)
      inputRef?.blur()
      finishHandledSession(sessionId)
      if (!(target.kind === 'invalid' && target.reason === 'stale-session')) {
        focusGridAfterCommit()
      }
      return
    }
    if (event.key === 'Escape' || event.key === 'Esc' || event.code === 'Escape') {
      event.preventDefault()
      handledBlurSessionId = sessionId
      store.setter(revertNameBoxAtom, { sessionId })
      inputRef?.blur()
      finishHandledSession(sessionId)
    }
  }

  function onFocus(event: FocusEvent) {
    domSessionId = store.setter(focusNameBoxAtom)
    handledBlurSessionId = undefined
    const target = event.currentTarget as HTMLInputElement | null
    target?.select()
  }

  function onBlur() {
    const sessionId = domSessionId
    if (sessionId === undefined) return

    if (handledBlurSessionId === sessionId) {
      handledBlurSessionId = undefined
    } else {
      const current = store.getter(nameBoxInputAtom)
      const unchanged = current === store.getter(nameBoxLastCommittedAtom)
      if (unchanged || current.trim().length === 0) {
        store.setter(revertNameBoxAtom, { sessionId })
      } else {
        commitCurrent(sessionId)
      }
    }

    store.setter(blurNameBoxAtom, { sessionId })
    if (domSessionId === sessionId) {
      domSessionId = undefined
    }
  }

  const className = () => {
    const parts = ['name-box spreadsheet-name-box']
    if (props.class) parts.push(props.class)
    if (error()) parts.push('name-box--error')
    return parts.join(' ').trim()
  }
  const errorMessageId = () => `${props['data-testid'] ?? 'name-box'}-error-message`

  return (
    <div
      class={className()}
      data-testid={props['data-testid'] ?? 'name-box'}
      data-mode={mode()}
      data-error={error() ? 'true' : 'false'}
    >
      <input
        class="name-box-input spreadsheet-name-box-input"
        data-testid="name-box-input"
        type="text"
        aria-label={t('nameBox.label')}
        aria-invalid={error() ? 'true' : undefined}
        aria-describedby={error() ? errorMessageId() : undefined}
        value={renderedValue()}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        ref={(node) => {
          inputRef = node
        }}
      />
      {error() ? (
        <span
          id={errorMessageId()}
          class="spreadsheet-name-box-error-message"
          data-testid="name-box-error"
          role="alert"
        >
          {t('nameBox.error')}
        </span>
      ) : null}
    </div>
  )
}
