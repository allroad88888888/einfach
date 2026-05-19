/** @jsxImportSource solid-js */

import { Show, For, createSignal, createEffect, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  conditionalFormatEditorAtom,
  conditionalFormatRulesCacheAtom,
  closeConditionalFormatEditorAtom,
  selectionSnapshotAtom,
  workspaceSessionAtom,
  type ConditionalFormatRuleEntry,
  type ConditionalFormatRuleKind,
  type ConditionalFormatScope,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

export interface SpreadsheetConditionalFormatDialogProps {
  class?: string
  'data-testid'?: string
}

const ruleKinds: ConditionalFormatRuleKind[] = [
  'cell-value',
  'formula',
  'data-bar',
  'color-scale',
  'top-bottom',
]

const kindLabels: Record<ConditionalFormatRuleKind, string> = {
  'cell-value': 'Cell value',
  formula: 'Formula',
  'data-bar': 'Data bar',
  'color-scale': 'Color scale',
  'top-bottom': 'Top/Bottom',
}

function defaultDraftForKind(kind: ConditionalFormatRuleKind): ConditionalFormatRuleEntry['rule'] {
  switch (kind) {
    case 'cell-value':
      return { kind: 'cell-value', operator: 'eq', value: '', format: {} }
    case 'formula':
      return { kind: 'formula', formula: '', format: {} }
    case 'data-bar':
      return { kind: 'data-bar' }
    case 'color-scale':
      return { kind: 'color-scale', minColor: '#ff0000', maxColor: '#00ff00' }
    case 'top-bottom':
      return { kind: 'top-bottom', direction: 'top', count: 10, format: {} }
  }
}

export function SpreadsheetConditionalFormatDialog(
  props: SpreadsheetConditionalFormatDialogProps,
) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const editor = useAtomValue(conditionalFormatEditorAtom)
  const rulesCache = useAtomValue(conditionalFormatRulesCacheAtom)

  const isEditing = () => editor().open

  const [selectedKind, setSelectedKind] = createSignal<ConditionalFormatRuleKind>('cell-value')
  const [errorText, setErrorText] = createSignal<string | null>(null)
  let lastSyncedDraftId: string | undefined

  createEffect((prevOpen: boolean) => {
    const open = isEditing()
    if (open && !prevOpen && !editor().draft) {
      setSelectedKind('cell-value')
      lastSyncedDraftId = undefined
    }
    if (!open && prevOpen) {
      setErrorText(null)
    }
    return open
  }, false)

  createEffect(() => {
    if (!isEditing()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        store.setter(closeConditionalFormatEditorAtom)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  function currentKind(): ConditionalFormatRuleKind {
    const draft = editor().draft
    if (draft && draft.id !== lastSyncedDraftId) {
      lastSyncedDraftId = draft.id
      setSelectedKind(draft.rule.kind as ConditionalFormatRuleKind)
    }
    if (!draft) lastSyncedDraftId = undefined
    return selectedKind()
  }

  function resolveSheetId(): string {
    const workspaceSheetId = store.getter(workspaceSessionAtom).activeSheetId
    if (workspaceSheetId && workspaceSheetId.length > 0) return workspaceSheetId
    return rulesCache().sheetId ?? ''
  }

  function resolveScope(): ConditionalFormatScope {
    const draft = editor().draft
    if (draft?.scope) return draft.scope
    const snapshot = store.getter(selectionSnapshotAtom)
    return { range: snapshot.range }
  }

  function close() {
    store.setter(closeConditionalFormatEditorAtom)
  }

  async function handleSave() {
    if (!backend.setConditionalFormatRule) return
    setErrorText(null)
    const draft = editor().draft
    const kind = currentKind()
    const useDraftRule = draft && draft.rule.kind === kind
    const rule = useDraftRule ? draft.rule : defaultDraftForKind(kind)
    const scope = resolveScope()
    const sheetId = resolveSheetId()
    try {
      await backend.setConditionalFormatRule({
        kind: 'set-conditional-format-rule',
        sheetId,
        ruleId: draft?.id,
        scope,
        priority: draft?.priority,
        rule,
      })
      close()
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRemove() {
    if (!backend.removeConditionalFormatRule) return
    setErrorText(null)
    const draft = editor().draft
    if (!draft) return
    const sheetId = resolveSheetId()
    try {
      await backend.removeConditionalFormatRule({
        kind: 'remove-conditional-format-rule',
        sheetId,
        ruleId: draft.id,
      })
      close()
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err))
    }
  }

  function handleCancel() {
    close()
  }

  function onKindChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value as ConditionalFormatRuleKind
    setSelectedKind(value)
  }

  return (
    <Show when={isEditing()}>
      <div
        class={`conditional-format-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'conditional-format-dialog'}
        role="dialog"
        aria-modal="true"
        aria-label="Conditional formatting"
      >
        <button
          type="button"
          class="dialog-close-x"
          data-testid="dialog-close-x"
          aria-label={t('dialog.close.label')}
          onClick={close}
        >
          ×
        </button>
        <ul data-testid="cf-rule-list">
          <For each={rulesCache().rules}>
            {(entry) => (
              <li data-rule-id={entry.id} data-rule-kind={entry.rule.kind}>
                {entry.rule.kind} — priority {entry.priority}
              </li>
            )}
          </For>
        </ul>

        <div class="cf-form">
          <label for="cf-rule-kind-select">Rule type</label>
          <select
            id="cf-rule-kind-select"
            data-testid="cf-rule-kind-select"
            value={currentKind()}
            onChange={onKindChange}
          >
            <For each={ruleKinds}>
              {(kind) => <option value={kind}>{kindLabels[kind]}</option>}
            </For>
          </select>
        </div>

        <div class="cf-actions">
          <button
            type="button"
            data-testid="cf-save-button"
            onClick={() => {
              void handleSave()
            }}
          >
            Save
          </button>
          <button
            type="button"
            data-testid="cf-remove-button"
            disabled={!editor().draft}
            onClick={() => {
              void handleRemove()
            }}
          >
            Remove
          </button>
          <button
            type="button"
            data-testid="cf-cancel-button"
            onClick={handleCancel}
          >
            Cancel
          </button>
        </div>

        <Show when={errorText()}>
          <div class="cf-error" data-testid="cf-error-text" role="alert">
            {errorText()}
          </div>
        </Show>
      </div>
    </Show>
  )
}
