/** @jsxImportSource solid-js */

import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { locale, useT } from '../../src/i18n'
import {
  allTablesAtom,
  closeNameManagerAtom,
  deleteNameManagerEntryAtom,
  lastRenamedTableAtom,
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
  refreshTableCatalogAtom,
  runDeleteTableAtom,
  runRenameTableAtom,
  saveNameManagerAtom,
  sheetTabsSheetsAtom,
  tableDiagnosticAtom,
  workspaceSessionAtom,
  type NameManagerKind,
  type NamedRange,
  type NamedRangeBackendCapabilities,
  type NamedRangeScope,
  type SpreadsheetTableDescriptor,
  type TableDiagnosticCode,
} from '@einfach/spreadsheet-ui-core'
import { refreshVisibleProjection, useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

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

/**
 * Table-diagnostic code → i18n key. UI core publishes an English fallback
 * message on `tableDiagnosticAtom`; the dialog localizes the codes it can
 * actually produce and falls back to the core message for the rest, so a
 * new engine reject code is still visible rather than silently swallowed.
 */
const TABLE_DIAGNOSTIC_COPY_KEY: Readonly<Partial<Record<TableDiagnosticCode, string>>> =
  Object.freeze({
    capability: 'nameManager.tables.error.capability',
    'invalid-name': 'nameManager.tables.error.invalidName',
    'name-like-cell-ref': 'nameManager.tables.error.nameLikeCellRef',
    'name-conflict': 'nameManager.tables.error.nameConflict',
    'reserved-name': 'nameManager.tables.error.reservedName',
    'name-unchanged': 'nameManager.tables.error.nameUnchanged',
    'not-found': 'nameManager.tables.error.notFound',
    'outcome-unknown': 'nameManager.tables.error.outcomeUnknown',
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
  const allTables = useAtomValue(allTablesAtom)
  const tableDiagnostic = useAtomValue(tableDiagnosticAtom)
  const lastRenamedTable = useAtomValue(lastRenamedTableAtom)

  // Per-row inline editors. Only one row may be in rename or delete-confirm
  // mode at a time; both are keyed by the table's canonical name.
  const [renamingTable, setRenamingTable] = createSignal<string | null>(null)
  const [renameDraft, setRenameDraft] = createSignal('')
  const [pendingDeleteTable, setPendingDeleteTable] = createSignal<string | null>(null)

  const isOpen = () => editor().status !== 'closed'
  // Read-only Excel Table catalog. The engine registry is canonical; the
  // dialog only lists the last `listTables` projection. Degrades by port
  // presence — a backend whose engine has no Table model omits `listTables`
  // and the whole region is hidden.
  const tablesSupported = () => typeof backend.listTables === 'function'
  // Row actions degrade independently of the listing: a backend that can
  // list tables but not mutate their definitions renders no action buttons.
  const renameTableSupported = () => typeof backend.renameTable === 'function'
  const deleteTableSupported = () => typeof backend.deleteTable === 'function'
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

  function tableStatusMessage(): string | null {
    const diagnostic = tableDiagnostic()
    if (diagnostic === null) return null
    const copyKey = TABLE_DIAGNOSTIC_COPY_KEY[diagnostic.code]
    return copyKey === undefined ? diagnostic.message : t(copyKey)
  }

  // Refresh the table catalog on the closed → open edge so the list reflects
  // the canonical engine registry each time the dialog opens, and drop any
  // half-finished row editor from the previous session.
  createEffect<boolean>((wasOpen) => {
    const open = isOpen()
    if (open && !wasOpen) {
      setRenamingTable(null)
      setRenameDraft('')
      setPendingDeleteTable(null)
      if (tablesSupported()) store.setter(refreshTableCatalogAtom, backend)
    }
    return open
  }, false)

  // Close the inline rename editor off the APPLIED witness, not off the
  // dispatch: a structured reject never publishes a witness, so the row stays
  // in edit mode with the draft the user typed and the diagnostic below it.
  createEffect<{ from: string; to: string } | null>((previous) => {
    const applied = lastRenamedTable()
    if (applied !== null && applied !== previous && renamingTable() === applied.from) {
      setRenamingTable(null)
      setRenameDraft('')
    }
    return applied
  }, null)

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

  function beginRenameTable(table: SpreadsheetTableDescriptor): void {
    setPendingDeleteTable(null)
    setRenamingTable(table.name)
    setRenameDraft(table.name)
  }

  // Fire-and-forget dispatch: `runRenameTableAtom` owns the transport, the
  // capability split, and the diagnostic. The inline editor closes off the
  // applied witness (below), never off an awaited result — so a rejected
  // rename keeps the row in edit mode with the typed draft intact.
  function commitRenameTable(table: SpreadsheetTableDescriptor): void {
    void store.setter(runRenameTableAtom, {
      source: backend,
      name: table.name,
      newName: renameDraft(),
      sheetId: table.sheetId,
      refreshProjection: (sheetId?: string) =>
        refreshVisibleProjection(store, backend, sheetId, 'toolbar'),
    })
  }

  function cancelRenameTable(): void {
    setRenamingTable(null)
    setRenameDraft('')
  }

  function confirmDeleteTable(table: SpreadsheetTableDescriptor): void {
    setPendingDeleteTable(null)
    void store.setter(runDeleteTableAtom, {
      source: backend,
      name: table.name,
      sheetId: table.sheetId,
      refreshProjection: (sheetId?: string) =>
        refreshVisibleProjection(store, backend, sheetId, 'toolbar'),
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

        <Show when={tablesSupported()}>
          <section class="nm-tables" data-testid="name-manager-tables">
            <h3 class="nm-tables-title">{t('nameManager.tables.title')}</h3>
            <Show
              when={allTables().length > 0}
              fallback={
                <p class="nm-tables-empty" data-testid="name-manager-tables-empty">
                  {t('nameManager.tables.empty')}
                </p>
              }
            >
              <ul class="nm-tables-list" data-testid="name-manager-tables-list">
                <For each={allTables()}>
                  {(table) => (
                    <li class="nm-table-row" data-table-name={table.name}>
                      <span class="nm-table-name">{table.name}</span>
                      <span class="nm-table-location">
                        {t('nameManager.tables.location', {
                          sheet: table.sheetName,
                          range: table.range,
                        })}
                      </span>
                      <span class="nm-table-columns">
                        {t('nameManager.tables.columns', {
                          columns: table.columns.join(', '),
                        })}
                      </span>
                      <Show when={table.hasTotals}>
                        <span class="nm-table-totals" data-testid="name-manager-table-totals">
                          {t('nameManager.tables.hasTotals')}
                        </span>
                      </Show>

                      <Show when={renamingTable() === table.name}>
                        <span class="nm-table-rename">
                          <input
                            type="text"
                            class="nm-table-rename-input"
                            data-testid="name-manager-table-rename-input"
                            aria-label={t('nameManager.tables.rename.label', { name: table.name })}
                            value={renameDraft()}
                            onInput={(event) => setRenameDraft(event.currentTarget.value)}
                          />
                          <button
                            type="button"
                            data-testid="name-manager-table-rename-save"
                            onClick={() => commitRenameTable(table)}
                          >
                            {t('nameManager.tables.rename.save')}
                          </button>
                          <button
                            type="button"
                            data-testid="name-manager-table-rename-cancel"
                            onClick={cancelRenameTable}
                          >
                            {t('nameManager.tables.cancel')}
                          </button>
                        </span>
                      </Show>

                      <Show when={pendingDeleteTable() === table.name}>
                        <span class="nm-table-delete-confirm" role="alert">
                          <span data-testid="name-manager-table-delete-prompt">
                            {t('nameManager.tables.delete.prompt', { name: table.name })}
                          </span>
                          <button
                            type="button"
                            data-testid="name-manager-table-delete-confirm"
                            onClick={() => confirmDeleteTable(table)}
                          >
                            {t('nameManager.tables.delete.confirm')}
                          </button>
                          <button
                            type="button"
                            data-testid="name-manager-table-delete-cancel"
                            onClick={() => setPendingDeleteTable(null)}
                          >
                            {t('nameManager.tables.cancel')}
                          </button>
                        </span>
                      </Show>

                      <span class="nm-table-actions">
                        <Show when={renameTableSupported() && renamingTable() !== table.name}>
                          <button
                            type="button"
                            data-testid="name-manager-table-rename"
                            onClick={() => beginRenameTable(table)}
                          >
                            {t('nameManager.tables.rename')}
                          </button>
                        </Show>
                        <Show when={deleteTableSupported() && pendingDeleteTable() !== table.name}>
                          <button
                            type="button"
                            data-testid="name-manager-table-delete"
                            onClick={() => setPendingDeleteTable(table.name)}
                          >
                            {t('nameManager.tables.delete')}
                          </button>
                        </Show>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            <Show when={tableStatusMessage()}>
              {(message) => (
                <div
                  class="nm-tables-error"
                  data-testid="name-manager-tables-error"
                  data-table-diagnostic-code={tableDiagnostic()?.code}
                  role="status"
                >
                  {message()}
                </div>
              )}
            </Show>
          </section>
        </Show>
      </div>
    </Show>
  )
}
