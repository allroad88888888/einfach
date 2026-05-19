/** @jsxImportSource solid-js */

import { createEffect, createSignal, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  commitNameBoxAtom,
  nameBoxDisplayAtom,
  nameBoxErrorAtom,
  nameBoxInputAtom,
  nameBoxModeAtom,
  rangeToA1,
  revertNameBoxAtom,
  selectionSnapshotAtom,
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
  const display = useAtomValue(nameBoxDisplayAtom)
  const mode = useAtomValue(nameBoxModeAtom)
  const error = useAtomValue(nameBoxErrorAtom)
  const inputValue = useAtomValue(nameBoxInputAtom)

  const [focused, setFocused] = createSignal(false)
  const [lastCommittedValue, setLastCommittedValue] = createSignal('')
  let inputRef: HTMLInputElement | undefined

  // Keep the input atom in sync with the display whenever the user is not
  // actively typing. This drives both the initial render and the
  // post-selection-change refresh.
  createEffect(() => {
    if (mode() === 'idle' && !focused()) {
      const next = display()
      const current = store.getter(nameBoxInputAtom)
      if (current !== next) {
        store.setter(nameBoxInputAtom, next)
      }
      setLastCommittedValue(next)
    }
  })

  function onInput(event: InputEvent) {
    const target = event.target as HTMLInputElement | null
    if (!target) return
    store.setter(nameBoxInputAtom, target.value)
    if (store.getter(nameBoxModeAtom) !== 'typing') {
      store.setter(nameBoxModeAtom, 'typing')
    }
  }

  async function maybeDefineName(target: NameBoxCommitTarget) {
    if (target.kind !== 'define-name') return
    if (!backend.setNamedRange) {
      store.setter(nameBoxErrorAtom, true)
      store.setter(nameBoxInputAtom, store.getter(nameBoxDisplayAtom))
      return
    }
    try {
      await backend.setNamedRange({
        kind: 'set-named-range',
        name: target.name,
        scope: 'workbook',
        refersTo: {
          kind: 'range',
          sheetId: target.sheetId,
          address: rangeToA1(target.range),
        },
      })
    } catch {
      store.setter(nameBoxErrorAtom, true)
      store.setter(nameBoxInputAtom, store.getter(nameBoxDisplayAtom))
    }
  }

  async function commitCurrent() {
    const raw = store.getter(nameBoxInputAtom)
    const snapshot = store.getter(selectionSnapshotAtom)
    const target = store.setter(commitNameBoxAtom, {
      input: raw,
      sheetId: snapshot.selection.sheetId,
    })
    if (target.kind === 'define-name') {
      await maybeDefineName(target)
    }
    setLastCommittedValue(store.getter(nameBoxInputAtom))
  }

  function revertCurrent() {
    store.setter(revertNameBoxAtom)
    setLastCommittedValue(store.getter(nameBoxInputAtom))
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.code === 'Enter') {
      event.preventDefault()
      void commitCurrent().then(() => {
        inputRef?.blur()
      })
      return
    }
    if (event.key === 'Escape' || event.key === 'Esc' || event.code === 'Escape') {
      event.preventDefault()
      revertCurrent()
      inputRef?.blur()
    }
  }

  function onFocus(event: FocusEvent) {
    setFocused(true)
    store.setter(nameBoxModeAtom, 'typing')
    setLastCommittedValue(store.getter(nameBoxInputAtom))
    const target = event.currentTarget as HTMLInputElement | null
    target?.select()
  }

  function onBlur() {
    setFocused(false)
    const current = store.getter(nameBoxInputAtom)
    if (current === lastCommittedValue()) {
      // Unchanged blur is a no-op; restore canonical display.
      store.setter(nameBoxModeAtom, 'idle')
      store.setter(nameBoxInputAtom, store.getter(nameBoxDisplayAtom))
      return
    }
    if (current.trim().length === 0) {
      store.setter(nameBoxModeAtom, 'idle')
      store.setter(nameBoxInputAtom, store.getter(nameBoxDisplayAtom))
      return
    }
    void commitCurrent()
  }

  function bindInputRef(node: HTMLInputElement | undefined | null) {
    if (!node || inputRef === node) return
    inputRef = node
    onCleanup(() => {
      if (inputRef === node) inputRef = undefined
    })
  }

  const className = () => {
    const parts = ['name-box spreadsheet-name-box']
    if (props.class) parts.push(props.class)
    if (error()) parts.push('name-box--error')
    return parts.join(' ').trim()
  }

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
        aria-label="Name box"
        value={inputValue()}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        ref={(node) => bindInputRef(node)}
      />
    </div>
  )
}
