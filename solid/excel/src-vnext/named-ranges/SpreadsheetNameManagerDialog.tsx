/** @jsxImportSource solid-js */

import { For, Show, createEffect, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { locale, useT } from '../../src/i18n'
import {
  closeNameManagerAtom,
  deleteNameManagerEntryAtom,
  nameManagerEditorAtom,
  nameManagerKindDraftAtom,
  nameManagerNameDraftAtom,
  nameManagerParamsDraftAtom,
  nameManagerRefersToDraftAtom,
  nameManagerScopeDraftAtom,
  nameManagerSelectedEntryAtom,
  nameManagerSessionIdAtom,
  namedRangeCapabilitiesAtom,
  namedRangeMutationBlockedAtom,
  namedRangeMutationStateAtom,
  namedRangeRegistryStateAtom,
  openNameManagerAtom,
  saveNameManagerAtom,
  sheetTabsSheetsAtom,
  workspaceSessionAtom,
  type NameManagerKind,
  type NamedRange,
  type NamedRangeBackendCapabilities,
  type NamedRangeScope,
} from '@einfach/spreadsheet-ui-core'
import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

export interface SpreadsheetNameManagerDialogProps {
  class?: string
  'data-testid'?: string
}

function scopeToString(scope: NamedRangeScope): string {
  return scope === 'workbook' ? 'workbook' : `sheet:${scope.sheetId}`
}

function scopeKind(scope: string): 'workbook' | 'sheet' {
  return scope === 'workbook' ? 'workbook' : 'sheet'
}

function bindingKind(kind: NameManagerKind): keyof NamedRangeBackendCapabilities['bindings'] {
  return kind === 'value' ? 'constant' : kind
}

const STATUS_COPY = {
  en: {
    capabilityUnavailable: 'Name operations are unavailable for this workbook.',
    confirmedNotApplied: 'The change was not applied. Your draft is kept.',
    deleteSelectionRequired: 'Select a name to delete.',
    invalidNameOrReference: 'The name or reference is invalid.',
    ledgerFull: 'The name operation history is full. Try again after it is resolved.',
    operationUnavailable: 'This name operation is currently unavailable.',
    operationUnsupported: 'This name operation is not supported.',
    outcomeUnknown: 'The operation result could not be confirmed. Your draft is kept.',
    projectionUnknown: 'The name list could not be confirmed. No change was sent.',
    refreshing: 'Refreshing the name list…',
    workbookContextChanged: 'The workbook context changed. Review the draft and try again.',
  },
  zh: {
    capabilityUnavailable: '当前工作簿暂不支持名称操作。',
    confirmedNotApplied: '本次更改未应用，草稿已保留。',
    deleteSelectionRequired: '请选择要删除的名称。',
    invalidNameOrReference: '名称或引用无效。',
    ledgerFull: '名称操作记录已满，请等待当前操作解决后重试。',
    operationUnavailable: '当前名称操作不可用。',
    operationUnsupported: '当前名称操作不受支持。',
    outcomeUnknown: '操作结果尚未确认，草稿已保留。',
    projectionUnknown: '名称列表尚未确认，未发送新的更改。',
    refreshing: '正在刷新名称列表…',
    workbookContextChanged: '工作簿上下文已变化，请检查草稿后重试。',
  },
} as const

type StatusCopyKey = keyof (typeof STATUS_COPY)['en']

const CORE_ERROR_COPY_KEY: Readonly<Record<string, StatusCopyKey>> = Object.freeze({
  名称能力不可用: 'capabilityUnavailable',
  名称列表正在刷新: 'refreshing',
  名称列表未确认: 'projectionUnknown',
  当前名称操作不可用: 'operationUnavailable',
  当前名称操作不受支持: 'operationUnsupported',
  名称操作记录已满: 'ledgerFull',
  工作簿上下文已变化: 'workbookContextChanged',
  请选择要删除的名称: 'deleteSelectionRequired',
  名称或引用无效: 'invalidNameOrReference',
  操作结果未确认: 'outcomeUnknown',
})

export function SpreadsheetNameManagerDialog(props: SpreadsheetNameManagerDialogProps) {
  const t = useT()
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const editor = useAtomValue(nameManagerEditorAtom)
  const capability = useAtomValue(namedRangeCapabilitiesAtom)
  const registry = useAtomValue(namedRangeRegistryStateAtom)
  const mutation = useAtomValue(namedRangeMutationStateAtom)
  const mutationBlocked = useAtomValue(namedRangeMutationBlockedAtom)
  const selectedEntry = useAtomValue(nameManagerSelectedEntryAtom)
  const sessionId = useAtomValue(nameManagerSessionIdAtom)
  const workspace = useAtomValue(workspaceSessionAtom)
  const sheets = useAtomValue(sheetTabsSheetsAtom)
  const name = useAtomValue(nameManagerNameDraftAtom)
  const scope = useAtomValue(nameManagerScopeDraftAtom)
  const refersTo = useAtomValue(nameManagerRefersToDraftAtom)
  const kind = useAtomValue(nameManagerKindDraftAtom)
  const params = useAtomValue(nameManagerParamsDraftAtom)

  const isOpen = () => editor().status !== 'closed'
  const interactionLocked = () =>
    mutation().status === 'pending' || registry().status === 'refreshing'

  const controllerReady = () =>
    capability().status === 'ready' && registry().status === 'ready' && !mutationBlocked()

  function supportsCurrentSave(): boolean {
    if (!controllerReady()) return false
    const currentCapability = capability().capabilities
    if (currentCapability === null) return false
    if (!currentCapability.scopes.includes(scopeKind(scope()))) return false
    const currentBinding = bindingKind(kind())
    if (!currentCapability.bindings[currentBinding]) return false
    return currentBinding !== 'range' || currentCapability.rangeSemantics !== 'unsupported'
  }

  function supportsCurrentDelete(): boolean {
    if (!controllerReady()) return false
    const entry = selectedEntry() ?? editor().draft
    const currentCapability = capability().capabilities
    if (entry === undefined || entry === null || currentCapability === null) return false
    return (
      currentCapability.delete &&
      currentCapability.scopes.includes(entry.scope === 'workbook' ? 'workbook' : 'sheet')
    )
  }

  function isSelected(entry: NamedRange): boolean {
    const current = selectedEntry()
    return (
      current !== null &&
      current.name === entry.name &&
      scopeToString(current.scope) === scopeToString(entry.scope)
    )
  }

  function statusMessage(): string | null {
    const copy = STATUS_COPY[locale()]
    const currentMutation = mutation()
    if (currentMutation.status === 'blocked' && currentMutation.error === '名称或引用无效') {
      if (name().trim().length === 0) return t('nameManager.error.nameRequired')
      if (refersTo().trim().length === 0) return t('nameManager.error.refersToRequired')
    }
    if (currentMutation.error !== null) {
      const copyKey = CORE_ERROR_COPY_KEY[currentMutation.error]
      return copyKey === undefined ? currentMutation.error : copy[copyKey]
    }
    if (currentMutation.status === 'outcome-unknown') return copy.outcomeUnknown
    if (currentMutation.status === 'confirmed-not-applied') return copy.confirmedNotApplied
    if (registry().status === 'projection-unknown') return copy.projectionUnknown
    if (capability().status === 'unavailable') return copy.capabilityUnavailable
    if (registry().status === 'refreshing') return copy.refreshing
    return null
  }

  createEffect(() => {
    if (!isOpen()) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      store.setter(closeNameManagerAtom)
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  function selectEntry(entry: NamedRange): void {
    store.setter(openNameManagerAtom, { status: 'editing-existing', draft: entry })
  }

  function save(): void {
    store.setter(saveNameManagerAtom, {
      source: backend,
      sessionId: sessionId(),
      activeSheetId: workspace().activeSheetId ?? sheets()[0]?.id,
    })
  }

  function remove(): void {
    store.setter(deleteNameManagerEntryAtom, {
      source: backend,
      sessionId: sessionId(),
    })
  }

  function refersToLabel(): string {
    return kind() === 'lambda' ? t('nameManager.lambdaBody') : t('nameManager.refersTo')
  }

  return (
    <Show when={isOpen()}>
      <div
        class={`name-manager-dialog ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'name-manager-dialog'}
        data-capability-status={capability().status}
        data-registry-status={registry().status}
        data-mutation-status={mutation().status}
        role="dialog"
        aria-modal="true"
        aria-label={t('nameManager.title')}
      >
        <button
          type="button"
          class="dialog-close-x"
          data-testid="dialog-close-x"
          aria-label={t('dialog.close.label')}
          onClick={() => store.setter(closeNameManagerAtom)}
        >
          ×
        </button>

        <ul data-testid="name-list">
          <For each={registry().names}>
            {(entry) => (
              <li data-name={entry.name}>
                <button
                  type="button"
                  aria-pressed={isSelected(entry)}
                  disabled={interactionLocked()}
                  onClick={() => selectEntry(entry)}
                >
                  {entry.name} ({scopeToString(entry.scope)})
                </button>
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
            disabled={interactionLocked()}
            onInput={(event) => store.setter(nameManagerNameDraftAtom, event.currentTarget.value)}
          />

          <label for="name-scope-select">{t('nameManager.scope')}</label>
          <select
            id="name-scope-select"
            data-testid="name-scope-select"
            value={scope()}
            disabled={interactionLocked()}
            onChange={(event) => store.setter(nameManagerScopeDraftAtom, event.currentTarget.value)}
          >
            <option value="workbook">{t('nameManager.scope.workbook')}</option>
            <For each={sheets()}>
              {(sheet) => <option value={`sheet:${sheet.id}`}>{sheet.name}</option>}
            </For>
          </select>

          <label for="name-mgr-kind-select">{t('nameManager.kind')}</label>
          <select
            id="name-mgr-kind-select"
            data-testid="name-mgr-kind-select"
            value={kind()}
            disabled={interactionLocked()}
            onChange={(event) =>
              store.setter(nameManagerKindDraftAtom, event.currentTarget.value as NameManagerKind)
            }
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
              disabled={interactionLocked()}
              onInput={(event) =>
                store.setter(nameManagerParamsDraftAtom, event.currentTarget.value)
              }
            />
          </Show>

          <label for="name-refers-to">{refersToLabel()}</label>
          <input
            id="name-refers-to"
            data-testid="name-refers-to"
            type="text"
            value={refersTo()}
            disabled={interactionLocked()}
            onInput={(event) =>
              store.setter(nameManagerRefersToDraftAtom, event.currentTarget.value)
            }
          />
        </div>

        <Show when={statusMessage()}>
          {(message) => (
            <div data-testid="name-error-text" role="status">
              {message()}
            </div>
          )}
        </Show>

        <div class="nm-actions">
          <button
            type="button"
            data-testid="name-save-button"
            disabled={!supportsCurrentSave()}
            onClick={save}
          >
            {t('nameManager.save')}
          </button>
          <button
            type="button"
            data-testid="name-delete-button"
            disabled={!supportsCurrentDelete()}
            onClick={remove}
          >
            {t('nameManager.delete')}
          </button>
          <button
            type="button"
            data-testid="name-close-button"
            onClick={() => store.setter(closeNameManagerAtom)}
          >
            {t('nameManager.close')}
          </button>
        </div>
      </div>
    </Show>
  )
}
