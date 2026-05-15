/** @jsxImportSource solid-js */

import { Show, For, createSignal } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  conditionalFormatEditorAtom,
  conditionalFormatRulesCacheAtom,
  closeConditionalFormatEditorAtom,
  type ConditionalFormatRuleEntry,
  type ConditionalFormatRuleKind,
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
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const editor = useAtomValue(conditionalFormatEditorAtom)
  const rulesCache = useAtomValue(conditionalFormatRulesCacheAtom)

  const isEditing = () => editor().open

  const [selectedKind, setSelectedKind] = createSignal<ConditionalFormatRuleKind>('cell-value')

  function currentKind(): ConditionalFormatRuleKind {
    const draft = editor().draft
    if (draft) return draft.rule.kind as ConditionalFormatRuleKind
    return selectedKind()
  }

  function close() {
    store.setter(closeConditionalFormatEditorAtom)
  }

  async function handleSave() {
    if (!backend.setConditionalFormatRule) return
    const draft = editor().draft
    const kind = currentKind()
    const rule = draft?.rule ?? defaultDraftForKind(kind)
    const scope = draft?.scope ?? { range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 } }
    const sheetId = rulesCache().sheetId ?? ''
    await backend.setConditionalFormatRule({
      kind: 'set-conditional-format-rule',
      sheetId,
      ruleId: draft?.id,
      scope,
      priority: draft?.priority,
      rule,
    })
    close()
  }

  async function handleRemove() {
    if (!backend.removeConditionalFormatRule) return
    const draft = editor().draft
    if (!draft) return
    const sheetId = rulesCache().sheetId ?? ''
    await backend.removeConditionalFormatRule({
      kind: 'remove-conditional-format-rule',
      sheetId,
      ruleId: draft.id,
    })
    close()
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
      </div>
    </Show>
  )
}
