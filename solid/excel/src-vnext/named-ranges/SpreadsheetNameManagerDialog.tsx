/** @jsxImportSource solid-js */

import { Show, For, createEffect, createSignal, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  nameManagerEditorAtom,
  nameRegistryCacheAtom,
  closeNameManagerAtom,
  sheetTabsSheetsAtom,
  type NamedRange,
  type NamedRangeScope,
  type NamedRangeRefersTo,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

export interface SpreadsheetNameManagerDialogProps {
  class?: string
  'data-testid'?: string
}

function scopeToString(scope: NamedRangeScope): string {
  if (scope === 'workbook') return 'workbook'
  return scope.sheetId
}

function stringToScope(value: string): NamedRangeScope {
  if (value === 'workbook') return 'workbook'
  return { sheetId: value }
}

export function SpreadsheetNameManagerDialog(props: SpreadsheetNameManagerDialogProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const editor = useAtomValue(nameManagerEditorAtom)
  const registry = useAtomValue(nameRegistryCacheAtom)
  const sheets = useAtomValue(sheetTabsSheetsAtom)

  const isOpen = () => editor().status !== 'closed'

  createEffect(() => {
    if (!isOpen()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        store.setter(closeNameManagerAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  const [name, setName] = createSignal('')
  const [scope, setScope] = createSignal<string>('workbook')
  const [refersTo, setRefersTo] = createSignal('')
  const [selectedEntry, setSelectedEntry] = createSignal<NamedRange | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  function refersToString(rt: NamedRangeRefersTo): string {
    return rt.kind === 'range' ? `${rt.sheetId}!${rt.address}` : rt.value
  }

  function populateFromEntry(entry: NamedRange) {
    setSelectedEntry(entry)
    setName(entry.name)
    setScope(scopeToString(entry.scope))
    setRefersTo(refersToString(entry.refersTo))
    setError(null)
  }

  function resetForm() {
    setSelectedEntry(null)
    setName('')
    setScope('workbook')
    setRefersTo('')
    setError(null)
  }

  let wasOpen = false
  createEffect(() => {
    const open = isOpen()
    if (open && !wasOpen) {
      const draft = editor().draft
      if (draft) {
        setSelectedEntry(draft)
        setName(draft.name)
        setScope(scopeToString(draft.scope))
        setRefersTo(refersToString(draft.refersTo))
      } else {
        setSelectedEntry(null)
        setName('')
        setScope('workbook')
        setRefersTo('')
      }
      setError(null)
    }
    wasOpen = open
  })

  function buildRefersTo(): NamedRangeRefersTo {
    const value = refersTo().trim()
    const sep = value.indexOf('!')
    if (sep !== -1) {
      return { kind: 'range', sheetId: value.slice(0, sep), address: value.slice(sep + 1) }
    }
    return { kind: 'constant', value }
  }

  function close() {
    store.setter(closeNameManagerAtom)
    resetForm()
  }

  async function handleSave() {
    if (!backend.setNamedRange) return
    const nameVal = (name() || (editor().draft?.name ?? '')).trim()
    if (nameVal.length === 0) {
      setError('Name is required')
      return
    }
    if (refersTo().trim().length === 0) {
      setError('Refers to is required')
      return
    }
    try {
      await backend.setNamedRange({
        kind: 'set-named-range',
        name: nameVal,
        scope: stringToScope(scope()),
        refersTo: buildRefersTo(),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    close()
  }

  async function handleDelete() {
    if (!backend.deleteNamedRange) return
    const entry = selectedEntry() ?? editor().draft
    if (!entry) return
    try {
      await backend.deleteNamedRange({
        kind: 'delete-named-range',
        name: entry.name,
        scope: entry.scope,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    setSelectedEntry(null)
    setError(null)
  }

  function handleClose() {
    close()
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`name-manager-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'name-manager-dialog'}
        role="dialog"
        aria-modal="true"
        aria-label="Name Manager"
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
        <ul data-testid="name-list">
          <For each={registry()}>
            {(entry) => (
              <li
                data-name={entry.name}
                onClick={() => {
                  populateFromEntry(entry)
                }}
                style={{ cursor: 'pointer' }}
              >
                {entry.name} ({scopeToString(entry.scope)})
              </li>
            )}
          </For>
        </ul>

        <div class="nm-form">
          <label for="name-input">Name</label>
          <input
            id="name-input"
            data-testid="name-input"
            type="text"
            value={name()}
            onInput={(e) => {
              setName(e.currentTarget.value)
            }}
          />

          <label for="name-scope-select">Scope</label>
          <select
            id="name-scope-select"
            data-testid="name-scope-select"
            value={scope()}
            onChange={(e) => {
              setScope(e.currentTarget.value)
            }}
          >
            <option value="workbook">Workbook</option>
            <For each={sheets()}>
              {(sheet) => <option value={sheet.id}>{sheet.name}</option>}
            </For>
          </select>

          <label for="name-refers-to">Refers to</label>
          <input
            id="name-refers-to"
            data-testid="name-refers-to"
            type="text"
            value={refersTo()}
            onInput={(e) => {
              setRefersTo(e.currentTarget.value)
            }}
          />
        </div>

        <Show when={error()}>
          <div data-testid="name-error-text" role="alert">
            {error()}
          </div>
        </Show>

        <div class="nm-actions">
          <button
            type="button"
            data-testid="name-save-button"
            onClick={() => {
              void handleSave()
            }}
          >
            Save
          </button>
          <button
            type="button"
            data-testid="name-delete-button"
            disabled={!selectedEntry() && !editor().draft}
            onClick={() => {
              void handleDelete()
            }}
          >
            Delete
          </button>
          <button
            type="button"
            data-testid="name-close-button"
            onClick={handleClose}
          >
            Close
          </button>
        </div>
      </div>
    </Show>
  )
}
