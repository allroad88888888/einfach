import { For, onCleanup, onMount, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  createBeginSheetTabRenameIntent,
  createBeginSheetTabReorderIntent,
  createCancelSheetTabRenameIntent,
  createCancelSheetTabReorderIntent,
  createCloseSheetTabContextMenuIntent,
  createCommitSheetTabRenameIntent,
  createCommitSheetTabReorderIntent,
  createOpenSheetTabContextMenuIntent,
  createUpdateSheetTabRenameIntent,
  createUpdateSheetTabReorderIntent,
  dispatchSheetTabIntentAtom,
  patchSheetTabsSheetNameAtom,
  setSheetTabsSheetsAtom,
  setWorkspaceActiveSheetAtom,
  sheetTabsAtom,
  sheetTabsSheetsAtom,
  type SheetMutationResult,
  type SpreadsheetSheetMetadata,
  workspaceSessionAtom,
} from '@einfach/spreadsheet-ui-core'

import { useSpreadsheetBackend, useSpreadsheetUiStore } from '../provider'

export interface SpreadsheetSheetMetadataInput {
  id: string
  name: string
  index?: number
}

export interface SpreadsheetSheetTabsProps {
  sheets: readonly SpreadsheetSheetMetadataInput[]
  class?: string
  'data-testid'?: string
}

export function SpreadsheetSheetTabs(props: SpreadsheetSheetTabsProps) {
  const backend = useSpreadsheetBackend()
  const store = useSpreadsheetUiStore()
  const workspace = useAtomValue(workspaceSessionAtom)
  const sheetTabs = useAtomValue(sheetTabsAtom)
  const sheets = useAtomValue(sheetTabsSheetsAtom)
  let renameInput: HTMLInputElement | null = null
  let disposed = false
  let sheetListRequestSeq = 0
  let reorderCleanup: (() => void) | null = null

  function setActiveSheet(sheetId: string) {
    store.setter(setWorkspaceActiveSheetAtom, { sheetId })
  }

  function seedSheets() {
    if (store.getter(sheetTabsSheetsAtom).length > 0) {
      return
    }

    store.setter(setSheetTabsSheetsAtom, {
      sheets: props.sheets.map((sheet, index) => ({
        id: sheet.id,
        name: sheet.name,
        index: sheet.index ?? index,
      })),
    })
  }

  function resolveFallbackActiveSheet(
    sheetList: readonly SpreadsheetSheetMetadata[],
    preferredSheetId?: string | null,
  ): string | null {
    if (preferredSheetId && sheetList.some((sheet) => sheet.id === preferredSheetId)) {
      return preferredSheetId
    }

    const currentSheetId = store.getter(workspaceSessionAtom).activeSheetId
    if (currentSheetId && sheetList.some((sheet) => sheet.id === currentSheetId)) {
      return currentSheetId
    }

    return sheetList[0]?.id ?? null
  }

  function commitSheetList(
    sheetList: readonly SpreadsheetSheetMetadata[],
    revision?: SheetMutationResult['revision'],
    preferredActiveSheetId?: string | null,
  ) {
    store.setter(setSheetTabsSheetsAtom, {
      sheets: sheetList,
      revision,
    })

    const activeSheetId = resolveFallbackActiveSheet(sheetList, preferredActiveSheetId)
    if (activeSheetId !== store.getter(workspaceSessionAtom).activeSheetId) {
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: activeSheetId })
    }
  }

  async function refreshSheets(preferredActiveSheetId?: string | null) {
    if (!backend.listSheets) {
      const sheetList = store.getter(sheetTabsSheetsAtom)
      const activeSheetId = resolveFallbackActiveSheet(sheetList, preferredActiveSheetId)
      if (activeSheetId !== store.getter(workspaceSessionAtom).activeSheetId) {
        store.setter(setWorkspaceActiveSheetAtom, { sheetId: activeSheetId })
      }
      return
    }

    const requestSeq = ++sheetListRequestSeq
    const result = await backend.listSheets()
    if (disposed || requestSeq !== sheetListRequestSeq) {
      return
    }

    commitSheetList(result.sheets, result.revision, preferredActiveSheetId)
  }

  function commitSheetMutationResult(
    result: SheetMutationResult,
    preferredActiveSheetId =
      result.activeSheetId ?? result.createdSheet?.id ?? result.sheetId ?? null,
  ) {
    sheetListRequestSeq += 1
    if (result.sheets) {
      commitSheetList(
        result.sheets,
        result.revision,
        preferredActiveSheetId,
      )
      return
    }

    void refreshSheets(preferredActiveSheetId)
  }

  function nextSheetName() {
    const used = new Set(sheets().map((sheet) => sheet.name))
    let index = sheets().length + 1
    let name = `Sheet${index}`

    while (used.has(name)) {
      index += 1
      name = `Sheet${index}`
    }

    return name
  }

  function closeContextMenu(reason: 'dismissed' | 'sheet-changed' | 'committed' | 'cancelled') {
    store.setter(dispatchSheetTabIntentAtom, createCloseSheetTabContextMenuIntent(reason))
  }

  async function addSheet() {
    if (!backend.addSheet) {
      return
    }

    const result = await backend.addSheet({
      kind: 'add-sheet',
      name: nextSheetName(),
    })
    commitSheetMutationResult(result)
  }

  function beginRename(sheetId: string, draftName: string) {
    const intent = createBeginSheetTabRenameIntent({
      sheetId,
      draftName,
      source: 'pointer',
    })

    if (!intent) {
      return
    }

    store.setter(dispatchSheetTabIntentAtom, intent)
  }

  async function commitRename(sheetId: string, draft: string) {
    const intent = createCommitSheetTabRenameIntent({
      sheetId,
      name: draft,
      source: 'pointer',
    })

    if (!intent) {
      return
    }

    if (intent.type !== 'sheet-tab.rename.commit') {
      return
    }

    if (backend.renameSheet) {
      try {
        const result = await backend.renameSheet({
          kind: 'rename-sheet',
          sheetId,
          name: intent.name,
        })
        store.setter(dispatchSheetTabIntentAtom, intent)
        commitSheetMutationResult(result)
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error))
      }
      return
    }

    store.setter(dispatchSheetTabIntentAtom, intent)
    store.setter(patchSheetTabsSheetNameAtom, { sheetId, name: intent.name })
  }

  function cancelRename(sheetId: string, reason: 'escape' | 'blur' = 'escape') {
    const intent = createCancelSheetTabRenameIntent(sheetId, reason)

    store.setter(dispatchSheetTabIntentAtom, intent)
  }

  function tabDropPlacement(event: PointerEvent, sheetId: string) {
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-sheet-tab-item]')
    const targetSheetId = target?.dataset.sheetId

    if (!target || !targetSheetId || targetSheetId === sheetId) {
      return null
    }

    const rect = target.getBoundingClientRect()
    const targetIndex = sheets().findIndex((sheet) => sheet.id === targetSheetId)
    const before = event.clientX < rect.left + rect.width / 2

    return {
      beforeSheetId: before ? targetSheetId : null,
      afterSheetId: before ? null : targetSheetId,
      targetIndex: targetIndex < 0 ? null : before ? targetIndex : targetIndex + 1,
    }
  }

  function beginReorder(sheetId: string, event: PointerEvent) {
    if (!backend.reorderSheet || sheets().length <= 1) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    reorderCleanup?.()
    closeContextMenu('sheet-changed')
    try {
      ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    } catch {
      // Synthetic pointer events in tests may not have an active pointer capture session.
    }
    store.setter(
      dispatchSheetTabIntentAtom,
      createBeginSheetTabReorderIntent({
        sheetId,
        source: 'pointer',
      }),
    )

    const onPointerMove = (moveEvent: PointerEvent) => {
      updateReorder(sheetId, moveEvent)
    }
    const onPointerUp = (upEvent: PointerEvent) => {
      clearReorderListeners()
      void commitReorder(sheetId, upEvent)
    }

    reorderCleanup = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      reorderCleanup = null
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }

  function updateReorder(sheetId: string, event: PointerEvent) {
    const reorder = store.getter(sheetTabsAtom).reorder
    if (!reorder || reorder.sheetId !== sheetId) {
      return
    }

    const placement = tabDropPlacement(event, sheetId)
    if (!placement) {
      return
    }

    store.setter(
      dispatchSheetTabIntentAtom,
      createUpdateSheetTabReorderIntent({
        sheetId,
        ...placement,
      }),
    )
  }

  async function commitReorder(sheetId: string, event: PointerEvent) {
    const reorder = store.getter(sheetTabsAtom).reorder
    if (!reorder || reorder.sheetId !== sheetId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    try {
      ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
    } catch {
      // See the matching setPointerCapture guard in beginReorder.
    }

    const placement = {
      beforeSheetId: reorder.beforeSheetId,
      afterSheetId: reorder.afterSheetId,
      targetIndex: reorder.targetIndex,
    }

    const intent = createCommitSheetTabReorderIntent({
      sheetId,
      ...placement,
    })

    if (!backend.reorderSheet) {
      store.setter(dispatchSheetTabIntentAtom, createCancelSheetTabReorderIntent(sheetId, 'blur'))
      return
    }

    try {
      const activeSheetId = store.getter(workspaceSessionAtom).activeSheetId
      const result = await backend.reorderSheet({
        kind: 'reorder-sheet',
        sheetId,
        ...placement,
      })
      store.setter(dispatchSheetTabIntentAtom, intent)
      commitSheetMutationResult(result, activeSheetId)
    } catch (error) {
      store.setter(dispatchSheetTabIntentAtom, createCancelSheetTabReorderIntent(sheetId, 'blur'))
      window.alert(error instanceof Error ? error.message : String(error))
    }
  }

  function clearReorderListeners() {
    reorderCleanup?.()
  }

  function cancelReorder(sheetId: string) {
    clearReorderListeners()
    const reorder = store.getter(sheetTabsAtom).reorder
    if (reorder?.sheetId !== sheetId) {
      return
    }

    store.setter(dispatchSheetTabIntentAtom, createCancelSheetTabReorderIntent(sheetId, 'blur'))
  }

  function reorderDropSide(sheetId: string): 'before' | 'after' | null {
    const reorder = sheetTabs().reorder
    if (!reorder) {
      return null
    }
    if (reorder.beforeSheetId === sheetId) return 'before'
    if (reorder.afterSheetId === sheetId) return 'after'
    return null
  }

  function onRenameInput(sheetId: string, event: InputEvent) {
    const input = event.currentTarget as HTMLInputElement
    const intent = createUpdateSheetTabRenameIntent(sheetId, input.value)

    if (!intent) {
      return
    }

    store.setter(dispatchSheetTabIntentAtom, intent)
  }

  function onRenameInputKeyDown(event: KeyboardEvent) {
    const target = event.currentTarget as HTMLInputElement | null
    if (!target || target.tagName !== 'INPUT') {
      return
    }

    const sheetId = target.getAttribute('data-sheet-tab-rename-input')
    const rename = sheetTabs().rename

    if (!sheetId || !rename || rename.sheetId !== sheetId) {
      return
    }

    if (event.key === 'Enter' || event.code === 'Enter' || event.keyCode === 13) {
      event.preventDefault()
      void commitRename(sheetId, target.value)
      return
    }

    if (event.key === 'Escape' || event.code === 'Escape' || event.keyCode === 27) {
      event.preventDefault()
      cancelRename(sheetId, 'escape')
    }
  }

  function bindRenameInput(node: HTMLInputElement | null) {
    if (renameInput === node) {
      return
    }

    if (renameInput) {
      renameInput.removeEventListener('keydown', onRenameInputKeyDown)
    }

    renameInput = node

    if (renameInput) {
      renameInput.addEventListener('keydown', onRenameInputKeyDown)
      renameInput.focus()
      renameInput.select()
    }
  }

  function openContextMenu(event: MouseEvent, sheetId: string) {
    event.preventDefault()
    const intent = createOpenSheetTabContextMenuIntent({
      sheetId,
      x: event.clientX,
      y: event.clientY,
      source: 'context-menu',
    })

    store.setter(dispatchSheetTabIntentAtom, intent)
  }

  function beginContextRename() {
    const contextMenu = sheetTabs().contextMenu
    if (!contextMenu) {
      return
    }

    const sheet = sheets().find((item) => item.id === contextMenu.sheetId)
    closeContextMenu('committed')
    if (!sheet) {
      return
    }

    beginRename(sheet.id, sheet.name)
  }

  async function deleteContextSheet() {
    const contextMenu = sheetTabs().contextMenu
    if (!contextMenu || !backend.deleteSheet) {
      return
    }

    const sheet = sheets().find((item) => item.id === contextMenu.sheetId)
    closeContextMenu('committed')
    if (!sheet) {
      return
    }

    const confirmed = window.confirm(`Delete sheet "${sheet.name}"?`)
    if (!confirmed) {
      return
    }

    try {
      const result = await backend.deleteSheet({
        kind: 'delete-sheet',
        sheetId: sheet.id,
      })
      commitSheetMutationResult(result)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  }

  onMount(() => {
    seedSheets()
    void refreshSheets()
  })

  onCleanup(() => {
    disposed = true
    clearReorderListeners()
    if (renameInput) {
      renameInput.removeEventListener('keydown', onRenameInputKeyDown)
    }
  })

  return (
    <div
      class={`sheet-tabs spreadsheet-sheet-tabs ${props.class ?? ''}`.trim()}
      role="tablist"
      data-testid={props['data-testid'] ?? 'spreadsheet-sheet-tabs'}
    >
      <For each={sheets()}>
        {(sheet) => {
          const isActive = () => workspace().activeSheetId === sheet.id
          const isRenaming = () => sheetTabs().rename?.sheetId === sheet.id

          return (
            <div
              class="spreadsheet-sheet-tab-item"
              data-sheet-id={sheet.id}
              data-sheet-tab-item
              data-reorder-active={sheetTabs().reorder?.sheetId === sheet.id ? 'true' : 'false'}
              data-reorder-drop={reorderDropSide(sheet.id) ?? undefined}
            >
              <button
                type="button"
                class="spreadsheet-sheet-tab-reorder"
                data-testid={`sheet-tab-reorder-${sheet.id}`}
                aria-label={`Move ${sheet.name}`}
                title="Move sheet"
                disabled={!backend.reorderSheet || sheets().length <= 1}
                onPointerDown={(event) => beginReorder(sheet.id, event)}
                onPointerCancel={() => cancelReorder(sheet.id)}
              >
                <span class="spreadsheet-sheet-tab-reorder-grip" aria-hidden="true">⠿</span>
              </button>
              <Show
                when={!isRenaming()}
                fallback={
                  <input
                    class="spreadsheet-sheet-tab-rename"
                    type="text"
                    data-sheet-tab-rename-input={sheet.id}
                    value={sheetTabs().rename?.draftName ?? sheet.name}
                    onInput={(event) => onRenameInput(sheet.id, event)}
                    onBlur={() => cancelRename(sheet.id, 'blur')}
                    ref={bindRenameInput}
                  />
                }
              >
                <button
                  type="button"
                  role="tab"
                  class={`sheet-tab spreadsheet-sheet-tab${
                    isActive() ? ' sheet-tab-active is-active' : ''
                  }`}
                  data-active={isActive() ? 'true' : 'false'}
                  data-sheet-id={sheet.id}
                  onClick={() => setActiveSheet(sheet.id)}
                  onDblClick={() => beginRename(sheet.id, sheet.name)}
                  onContextMenu={(event) => openContextMenu(event, sheet.id)}
                >
                  {sheet.name}
                </button>
              </Show>
            </div>
          )
        }}
      </For>
      <button
        type="button"
        class="sheet-tab-add spreadsheet-sheet-tab-add"
        data-testid="sheet-tab-add"
        aria-label="Add sheet"
        title="Add sheet"
        disabled={!backend.addSheet}
        onClick={() => void addSheet()}
      >
        +
      </button>
      <Show when={sheetTabs().contextMenu}>
        {(contextMenu) => (
          <div
            class="spreadsheet-sheet-tab-context-menu"
            role="menu"
            data-testid="sheet-tab-context-menu"
            style={{
              left: `${contextMenu().x}px`,
              top: `${contextMenu().y}px`,
            }}
          >
            <button
              type="button"
              role="menuitem"
              data-testid="sheet-tab-menu-rename"
              onClick={beginContextRename}
            >
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="sheet-tab-menu-delete"
              disabled={!backend.deleteSheet || sheets().length <= 1}
              onClick={() => void deleteContextSheet()}
            >
              Delete
            </button>
          </div>
        )}
      </Show>
    </div>
  )
}
