import { onCleanup } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  createBeginSheetTabRenameIntent,
  createCancelSheetTabRenameIntent,
  createCommitSheetTabRenameIntent,
  createUpdateSheetTabRenameIntent,
  dispatchSheetTabIntentAtom,
  setWorkspaceActiveSheetAtom,
  sheetTabsAtom,
  workspaceSessionAtom,
} from '@einfach/spreadsheet-ui-core'

import { useSpreadsheetUiStore } from '../provider'

export interface SpreadsheetSheetMetadata {
  id: string
  name: string
}

export interface SpreadsheetSheetTabsProps {
  sheets: SpreadsheetSheetMetadata[]
  class?: string
  'data-testid'?: string
}

export function SpreadsheetSheetTabs(props: SpreadsheetSheetTabsProps) {
  const store = useSpreadsheetUiStore()
  const workspace = useAtomValue(workspaceSessionAtom)
  const sheetTabs = useAtomValue(sheetTabsAtom)
  let renameInput: HTMLInputElement | null = null

  function setActiveSheet(sheetId: string) {
    store.setter(setWorkspaceActiveSheetAtom, { sheetId })
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

  function commitRename(sheetId: string, draft: string) {
    const intent = createCommitSheetTabRenameIntent({
      sheetId,
      name: draft,
      source: 'pointer',
    })

    if (!intent) {
      return
    }

    store.setter(dispatchSheetTabIntentAtom, intent)
  }

  function cancelRename(sheetId: string, reason: 'escape' | 'blur' = 'escape') {
    const intent = createCancelSheetTabRenameIntent(sheetId, reason)

    store.setter(dispatchSheetTabIntentAtom, intent)
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
      commitRename(sheetId, target.value)
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
    }
  }

  onCleanup(() => {
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
      {props.sheets.map((sheet) => {
        const isActive = workspace().activeSheetId === sheet.id
        const isRenaming = sheetTabs().rename?.sheetId === sheet.id

        if (isRenaming) {
          return (
            <div class="spreadsheet-sheet-tab-item" data-sheet-id={sheet.id}>
              <input
                class="spreadsheet-sheet-tab-rename"
                type="text"
                data-sheet-tab-rename-input={sheet.id}
                value={sheetTabs().rename?.draftName ?? sheet.name}
                onInput={(event) => onRenameInput(sheet.id, event)}
                onBlur={() => cancelRename(sheet.id, 'blur')}
                ref={bindRenameInput}
              />
            </div>
          )
        }

        return (
          <div class="spreadsheet-sheet-tab-item" data-sheet-id={sheet.id}>
            <button
              type="button"
              role="tab"
              class={`sheet-tab spreadsheet-sheet-tab${
                isActive ? ' sheet-tab-active is-active' : ''
              }`}
              data-active={isActive ? 'true' : 'false'}
              data-sheet-id={sheet.id}
              onClick={() => setActiveSheet(sheet.id)}
              onDblClick={() => beginRename(sheet.id, sheet.name)}
            >
              {sheet.name}
            </button>
          </div>
        )
      })}
    </div>
  )
}
