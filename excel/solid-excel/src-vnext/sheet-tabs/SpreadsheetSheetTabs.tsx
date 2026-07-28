import { For, onCleanup, onMount, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  activateSheetTabAtom,
  addSheetTabAtom,
  beginSheetTabRenameAtom,
  cancelSheetTabDeleteAtom,
  commitSheetTabRenameAtom,
  commitSheetTabReorderAtom,
  confirmSheetTabDeleteAtom,
  createBeginSheetTabReorderIntent,
  createCancelSheetTabRenameIntent,
  createCancelSheetTabReorderIntent,
  createCloseSheetTabContextMenuIntent,
  createOpenSheetTabContextMenuIntent,
  createUpdateSheetTabRenameIntent,
  createUpdateSheetTabReorderIntent,
  dispatchSheetTabIntentAtom,
  disposeSheetTabsAtom,
  initializeSheetTabsAtom,
  requestSheetTabDeleteAtom,
  sheetTabsAtom,
  sheetTabsSheetsAtom,
  type SheetTabMutationKind,
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
  let reorderCleanup: (() => void) | null = null

  function setActiveSheet(sheetId: string) {
    store.setter(activateSheetTabAtom, { sheetId })
  }

  function commandDisabled(kind: SheetTabMutationKind): boolean {
    const state = sheetTabs()
    return state.phase !== 'ready' || state.mutation !== null || !state.capabilities[kind]
  }

  function commandTitle(kind: SheetTabMutationKind, label: string): string {
    const state = sheetTabs()
    if (state.phase === 'loading') return 'Loading the live sheet list'
    if (state.mutation !== null) return 'Another sheet change is in progress'
    if (!state.capabilities.list) return `${label} is unavailable without a live sheet list`
    if (!state.capabilities[kind]) return `${label} is unavailable in this workbook backend`
    return label
  }

  function closeContextMenu(reason: 'dismissed' | 'sheet-changed' | 'committed' | 'cancelled') {
    store.setter(dispatchSheetTabIntentAtom, createCloseSheetTabContextMenuIntent(reason))
  }

  function beginRename(sheetId: string, draftName: string) {
    store.setter(beginSheetTabRenameAtom, {
      sheetId,
      draftName,
      source: 'pointer',
    })
  }

  function cancelRename(sheetId: string, reason: 'escape' | 'blur' = 'escape') {
    store.setter(dispatchSheetTabIntentAtom, createCancelSheetTabRenameIntent(sheetId, reason))
  }

  function tabDropPlacement(event: PointerEvent, sheetId: string) {
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-sheet-tab-item]')
    const targetSheetId = target?.dataset.sheetId

    if (!target || !targetSheetId || targetSheetId === sheetId) return null

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
    if (commandDisabled('reorder') || sheets().length <= 1) return

    event.preventDefault()
    event.stopPropagation()
    reorderCleanup?.()
    closeContextMenu('sheet-changed')
    try {
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    } catch {
      // Synthetic pointer events may not have an active capture session.
    }
    store.setter(
      dispatchSheetTabIntentAtom,
      createBeginSheetTabReorderIntent({
        sheetId,
        source: 'pointer',
      }),
    )

    const onPointerMove = (moveEvent: PointerEvent) => updateReorder(sheetId, moveEvent)
    const onPointerUp = (upEvent: PointerEvent) => {
      clearReorderListeners()
      commitReorder(sheetId, upEvent)
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
    if (!reorder || reorder.sheetId !== sheetId) return

    const placement = tabDropPlacement(event, sheetId)
    if (!placement) return

    store.setter(
      dispatchSheetTabIntentAtom,
      createUpdateSheetTabReorderIntent({
        sheetId,
        ...placement,
      }),
    )
  }

  function commitReorder(sheetId: string, event: PointerEvent) {
    const reorder = store.getter(sheetTabsAtom).reorder
    if (!reorder || reorder.sheetId !== sheetId) return

    event.preventDefault()
    event.stopPropagation()
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
    } catch {
      // See the matching setPointerCapture guard.
    }
    void store.setter(commitSheetTabReorderAtom, { sheetId })
  }

  function clearReorderListeners() {
    reorderCleanup?.()
  }

  function cancelReorder(sheetId: string) {
    clearReorderListeners()
    const reorder = store.getter(sheetTabsAtom).reorder
    if (reorder?.sheetId !== sheetId) return
    store.setter(dispatchSheetTabIntentAtom, createCancelSheetTabReorderIntent(sheetId, 'blur'))
  }

  function reorderDropSide(sheetId: string): 'before' | 'after' | null {
    const reorder = sheetTabs().reorder
    if (!reorder) return null
    if (reorder.beforeSheetId === sheetId) return 'before'
    if (reorder.afterSheetId === sheetId) return 'after'
    return null
  }

  function onRenameInput(sheetId: string, event: InputEvent) {
    const input = event.currentTarget as HTMLInputElement
    const intent = createUpdateSheetTabRenameIntent(sheetId, input.value)
    if (intent) store.setter(dispatchSheetTabIntentAtom, intent)
  }

  function onRenameInputKeyDown(event: KeyboardEvent) {
    const target = event.currentTarget as HTMLInputElement | null
    if (!target || target.tagName !== 'INPUT') return

    const sheetId = target.getAttribute('data-sheet-tab-rename-input')
    const rename = sheetTabs().rename
    if (!sheetId || !rename || rename.sheetId !== sheetId) return

    if (event.key === 'Enter' || event.code === 'Enter' || event.keyCode === 13) {
      event.preventDefault()
      void store.setter(commitSheetTabRenameAtom, { sheetId })
      return
    }

    if (event.key === 'Escape' || event.code === 'Escape' || event.keyCode === 27) {
      event.preventDefault()
      cancelRename(sheetId, 'escape')
    }
  }

  function bindRenameInput(node: HTMLInputElement | null) {
    if (renameInput === node) return
    renameInput?.removeEventListener('keydown', onRenameInputKeyDown)
    renameInput = node
    if (renameInput) {
      renameInput.addEventListener('keydown', onRenameInputKeyDown)
      renameInput.focus()
      renameInput.select()
    }
  }

  function openContextMenu(event: MouseEvent, sheetId: string) {
    event.preventDefault()
    store.setter(
      dispatchSheetTabIntentAtom,
      createOpenSheetTabContextMenuIntent({
        sheetId,
        x: event.clientX,
        y: event.clientY,
        source: 'context-menu',
      }),
    )
  }

  function beginContextRename() {
    const contextMenu = sheetTabs().contextMenu
    if (!contextMenu) return
    const sheet = sheets().find((item) => item.id === contextMenu.sheetId)
    closeContextMenu('committed')
    if (sheet) beginRename(sheet.id, sheet.name)
  }

  function requestContextDelete() {
    const contextMenu = sheetTabs().contextMenu
    if (!contextMenu) return
    store.setter(requestSheetTabDeleteAtom, { sheetId: contextMenu.sheetId })
  }

  onMount(() => {
    void store.setter(initializeSheetTabsAtom, {
      backend,
      sheets: props.sheets.map((sheet, index) => ({
        id: sheet.id,
        name: sheet.name,
        index: sheet.index ?? index,
      })),
    })
  })

  onCleanup(() => {
    clearReorderListeners()
    renameInput?.removeEventListener('keydown', onRenameInputKeyDown)
    store.setter(disposeSheetTabsAtom)
  })

  return (
    <div
      class={`sheet-tabs spreadsheet-sheet-tabs ${props.class ?? ''}`.trim()}
      role="tablist"
      data-testid={props['data-testid'] ?? 'spreadsheet-sheet-tabs'}
      aria-busy={sheetTabs().phase === 'loading' || sheetTabs().mutation !== null}
    >
      <Show when={sheetTabs().phase === 'loading'}>
        <span role="status" data-testid="sheet-tabs-loading">
          Loading sheets…
        </span>
      </Show>
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
                title={commandTitle('reorder', 'Move sheet')}
                disabled={commandDisabled('reorder') || sheets().length <= 1}
                onPointerDown={(event) => beginReorder(sheet.id, event)}
                onPointerCancel={() => cancelReorder(sheet.id)}
              >
                <span class="spreadsheet-sheet-tab-reorder-grip" aria-hidden="true">
                  ⠿
                </span>
              </button>
              <Show
                when={!isRenaming()}
                fallback={
                  <input
                    class="spreadsheet-sheet-tab-rename"
                    type="text"
                    data-sheet-tab-rename-input={sheet.id}
                    value={sheetTabs().rename?.draftName ?? sheet.name}
                    disabled={sheetTabs().mutation !== null}
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
        title={commandTitle('add', 'Add sheet')}
        disabled={commandDisabled('add')}
        onClick={() => void store.setter(addSheetTabAtom)}
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
              title={commandTitle('rename', 'Rename sheet')}
              disabled={commandDisabled('rename')}
              onClick={beginContextRename}
            >
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="sheet-tab-menu-delete"
              title={commandTitle('delete', 'Delete sheet')}
              disabled={commandDisabled('delete') || sheets().length <= 1}
              onClick={requestContextDelete}
            >
              Delete
            </button>
          </div>
        )}
      </Show>
      <Show when={sheetTabs().deleteConfirmation}>
        {(confirmation) => (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="sheet-tab-delete-title"
            data-testid="sheet-tab-delete-confirmation"
          >
            <p id="sheet-tab-delete-title">Delete sheet “{confirmation().sheetName}”?</p>
            <button
              type="button"
              data-testid="sheet-tab-delete-cancel"
              disabled={sheetTabs().mutation !== null}
              onClick={() => store.setter(cancelSheetTabDeleteAtom)}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="sheet-tab-delete-confirm"
              disabled={sheetTabs().mutation !== null}
              onClick={() => void store.setter(confirmSheetTabDeleteAtom)}
            >
              Delete
            </button>
          </div>
        )}
      </Show>
      <Show when={sheetTabs().error}>
        {(error) => (
          <span role="alert" data-testid="sheet-tabs-error">
            {error()}
          </span>
        )}
      </Show>
    </div>
  )
}
