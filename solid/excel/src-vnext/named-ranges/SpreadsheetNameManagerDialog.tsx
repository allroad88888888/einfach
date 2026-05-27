/** @jsxImportSource solid-js */

import { Show, For, createEffect, onCleanup } from 'solid-js'
import { atom } from '@einfach/core'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  nameManagerEditorAtom,
  nameManagerKindDraftAtom,
  nameManagerNameDraftAtom,
  nameManagerParamsDraftAtom,
  nameManagerRefersToDraftAtom,
  nameManagerScopeDraftAtom,
  nameRegistryCacheAtom,
  setNameRegistryAtom,
  closeNameManagerAtom,
  sheetTabsSheetsAtom,
  type NameManagerKind,
  type NamedRange,
  type NamedRangeScope,
  type NamedRangeRefersTo,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

export interface SpreadsheetNameManagerDialogProps {
  class?: string
  'data-testid'?: string
}

// Per-instance dialog state that need not survive 1.9.12 Provider remount
// hazards (resolved in `2b7d65e` but we keep atom-backing as the standard
// pattern — see `project_solid_provider_remount.md`). These atoms are
// instantiated alongside the dialog component below.

function scopeToString(scope: NamedRangeScope): string {
  if (scope === 'workbook') return 'workbook'
  return scope.sheetId
}

function stringToScope(value: string): NamedRangeScope {
  if (value === 'workbook') return 'workbook'
  return { sheetId: value }
}

function refersToToFormFields(rt: NamedRangeRefersTo): {
  kind: NameManagerKind
  refersTo: string
  params: string
} {
  if (rt.kind === 'range') {
    return { kind: 'range', refersTo: `${rt.sheetId}!${rt.address}`, params: '' }
  }
  if (rt.kind === 'lambda') {
    return { kind: 'lambda', refersTo: rt.body, params: rt.params.join(', ') }
  }
  // constant / value
  return { kind: 'value', refersTo: rt.value, params: '' }
}

// Local error atom (per-dialog instance, not exported — would normally live
// in `spreadsheet-ui-core` but the error string is purely UI state).
const errorAtom = atom<string | null>(null)
errorAtom.debugLabel = 'spreadsheet.nameManager.error.local'

// Locally-tracked selected entry — needed to know which row the Delete
// button targets. Identity by name + scope-stringified.
const selectedEntryAtom = atom<NamedRange | null>(null)
selectedEntryAtom.debugLabel = 'spreadsheet.nameManager.selectedEntry'

export function SpreadsheetNameManagerDialog(props: SpreadsheetNameManagerDialogProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const editor = useAtomValue(nameManagerEditorAtom)
  const registry = useAtomValue(nameRegistryCacheAtom)
  const sheets = useAtomValue(sheetTabsSheetsAtom)
  const name = useAtomValue(nameManagerNameDraftAtom)
  const scope = useAtomValue(nameManagerScopeDraftAtom)
  const refersTo = useAtomValue(nameManagerRefersToDraftAtom)
  const kind = useAtomValue(nameManagerKindDraftAtom)
  const params = useAtomValue(nameManagerParamsDraftAtom)
  const selectedEntry = useAtomValue(selectedEntryAtom)
  const error = useAtomValue(errorAtom)

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

  function setName(value: string) {
    store.setter(nameManagerNameDraftAtom, value)
  }
  function setScope(value: string) {
    store.setter(nameManagerScopeDraftAtom, value)
  }
  function setRefersTo(value: string) {
    store.setter(nameManagerRefersToDraftAtom, value)
  }
  function setKind(value: NameManagerKind) {
    store.setter(nameManagerKindDraftAtom, value)
  }
  function setParams(value: string) {
    store.setter(nameManagerParamsDraftAtom, value)
  }
  function setSelectedEntry(value: NamedRange | null) {
    store.setter(selectedEntryAtom, value)
  }
  function setError(value: string | null) {
    store.setter(errorAtom, value)
  }

  function populateFromEntry(entry: NamedRange) {
    const form = refersToToFormFields(entry.refersTo)
    setSelectedEntry(entry)
    setName(entry.name)
    setScope(scopeToString(entry.scope))
    setKind(form.kind)
    setParams(form.params)
    setRefersTo(form.refersTo)
    setError(null)
  }

  function resetForm() {
    setSelectedEntry(null)
    setName('')
    setScope('workbook')
    setKind('range')
    setParams('')
    setRefersTo('')
    setError(null)
  }

  // Reset on the closed→open edge. Uses the atoms directly so the
  // per-instance state survives any consumer remount (1.9.12 hazard:
  // historically the component body could re-execute, dropping `let`
  // locals; atom values persist).
  createEffect((wasOpen: boolean) => {
    const open = isOpen()
    if (open && !wasOpen) {
      const draft = editor().draft
      if (draft) {
        const form = refersToToFormFields(draft.refersTo)
        setSelectedEntry(draft)
        setName(draft.name)
        setScope(scopeToString(draft.scope))
        setKind(form.kind)
        setParams(form.params)
        setRefersTo(form.refersTo)
      } else {
        setSelectedEntry(null)
        setName('')
        setScope('workbook')
        setKind('range')
        setParams('')
        setRefersTo('')
      }
      setError(null)
    }
    return open
  }, false)

  function buildRefersTo(): NamedRangeRefersTo | null {
    const value = refersTo().trim()
    const currentKind = kind()
    if (currentKind === 'lambda') {
      const paramList = params()
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
      const body = value.startsWith('=') ? value : `=${value}`
      if (body.length <= 1) return null
      return { kind: 'lambda', params: paramList, body }
    }
    if (currentKind === 'range') {
      const sep = value.indexOf('!')
      if (sep !== -1) {
        return { kind: 'range', sheetId: value.slice(0, sep), address: value.slice(sep + 1) }
      }
      // Treat range-without-sheet-prefix as the active scope sheet, or the
      // first sheet for workbook-scoped names.
      const scopeVal = scope()
      const sheetId = scopeVal === 'workbook' ? sheets()[0]?.id ?? '' : scopeVal
      return { kind: 'range', sheetId, address: value }
    }
    return { kind: 'constant', value }
  }

  function close() {
    store.setter(closeNameManagerAtom)
    resetForm()
  }

  async function refreshNameRegistry() {
    if (!backend.listNamedRanges) {
      store.setter(setNameRegistryAtom, {
        names: registry(),
      })
      return
    }
    const result = await backend.listNamedRanges({ kind: 'list-named-ranges' })
    store.setter(setNameRegistryAtom, result)
  }

  async function handleSave() {
    if (!backend.setNamedRange) return
    const nameVal = (name() || (editor().draft?.name ?? '')).trim()
    if (nameVal.length === 0) {
      setError(t('nameManager.error.nameRequired'))
      return
    }
    if (refersTo().trim().length === 0) {
      setError(t('nameManager.error.refersToRequired'))
      return
    }
    const built = buildRefersTo()
    if (!built) {
      setError(t('nameManager.error.refersToRequired'))
      return
    }
    if (built.kind === 'lambda' && built.params.length === 0) {
      setError(t('nameManager.error.paramsRequired'))
      return
    }
    try {
      await backend.setNamedRange({
        kind: 'set-named-range',
        name: nameVal,
        scope: stringToScope(scope()),
        refersTo: built,
      })
      await refreshNameRegistry()
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
      await refreshNameRegistry()
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

  function refersToLabel(): string {
    return kind() === 'lambda' ? t('nameManager.lambdaBody') : t('nameManager.refersTo')
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`name-manager-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'name-manager-dialog'}
        role="dialog"
        aria-modal="true"
        aria-label={t('nameManager.title')}
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
          <label for="name-input">{t('nameManager.name')}</label>
          <input
            id="name-input"
            data-testid="name-input"
            type="text"
            value={name()}
            onInput={(e) => {
              setName(e.currentTarget.value)
            }}
          />

          <label for="name-scope-select">{t('nameManager.scope')}</label>
          <select
            id="name-scope-select"
            data-testid="name-scope-select"
            value={scope()}
            onChange={(e) => {
              setScope(e.currentTarget.value)
            }}
          >
            <option value="workbook">{t('nameManager.scope.workbook')}</option>
            <For each={sheets()}>
              {(sheet) => <option value={sheet.id}>{sheet.name}</option>}
            </For>
          </select>

          <label for="name-mgr-kind-select">{t('nameManager.kind')}</label>
          <select
            id="name-mgr-kind-select"
            data-testid="name-mgr-kind-select"
            value={kind()}
            onChange={(e) => {
              setKind(e.currentTarget.value as NameManagerKind)
            }}
          >
            <option value="range">{t('nameManager.kind.range')}</option>
            <option value="value">{t('nameManager.kind.value')}</option>
            <option value="lambda">{t('nameManager.kind.lambda')}</option>
          </select>

          <Show when={kind() === 'lambda'}>
            <label for="name-mgr-params-input">{t('nameManager.params')}</label>
            <input
              id="name-mgr-params-input"
              data-testid="name-mgr-params-input"
              type="text"
              placeholder="x, y, z"
              value={params()}
              onInput={(e) => {
                setParams(e.currentTarget.value)
              }}
            />
          </Show>

          <label for="name-refers-to">{refersToLabel()}</label>
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
            {t('nameManager.save')}
          </button>
          <button
            type="button"
            data-testid="name-delete-button"
            disabled={!selectedEntry() && !editor().draft}
            onClick={() => {
              void handleDelete()
            }}
          >
            {t('nameManager.delete')}
          </button>
          <button
            type="button"
            data-testid="name-close-button"
            onClick={handleClose}
          >
            {t('nameManager.close')}
          </button>
        </div>
      </div>
    </Show>
  )
}
