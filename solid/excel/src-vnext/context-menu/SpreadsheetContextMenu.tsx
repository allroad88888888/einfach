import { onCleanup, onMount, For, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  closeMenuAtom,
  createVisibleProjectionRequest,
  dispatchMenuCommandAtom,
  menuStateAtom,
  type MenuCommandIntent,
  type MenuCommandKind,
  type MenuTargetKind,
} from '@einfach/spreadsheet-ui-core'

import {
  advanceSpreadsheetProjectionRequestIdAtom,
  isVisibleProjectionResult,
  spreadsheetProjectionSnapshotAtom,
  useSpreadsheetBackend,
  useSpreadsheetUiStore,
} from '../provider'

export interface SpreadsheetContextMenuProps {
  class?: string
  'data-testid'?: string
}

const commandLabels: Record<MenuCommandKind, string> = {
  'clipboard.copy': 'Copy',
  'clipboard.cut': 'Cut',
  'clipboard.paste': 'Paste',
  'cell.clear': 'Delete',
  'row.insert': 'Insert row',
  'row.delete': 'Delete row',
  'column.insert': 'Insert column',
  'column.delete': 'Delete column',
  'formatting.open': 'Formatting',
}

const commandsByTargetKind: Record<MenuTargetKind, MenuCommandKind[]> = {
  cell: ['clipboard.copy', 'clipboard.cut', 'clipboard.paste', 'cell.clear'],
  range: ['clipboard.copy', 'clipboard.cut', 'clipboard.paste', 'cell.clear'],
  row: ['row.insert', 'row.delete'],
  column: ['column.insert', 'column.delete'],
  all: ['row.insert', 'row.delete', 'column.insert', 'column.delete'],
  'sheet-tab': [],
}

function toInt(value: number) {
  return Math.trunc(value)
}

export function SpreadsheetContextMenu(props: SpreadsheetContextMenuProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const menuState = useAtomValue(menuStateAtom)
  let menuRoot: HTMLDivElement | undefined

  function closeMenu(reason: 'dismissed' | 'committed' = 'dismissed') {
    store.setter(closeMenuAtom, reason)
  }

  function getCurrentWindow() {
    const snapshot = store.getter(spreadsheetProjectionSnapshotAtom)
    if (isVisibleProjectionResult(snapshot.result)) {
      return snapshot.result.window
    }
    if (snapshot.request?.kind === 'visible-window') {
      return snapshot.request.window
    }
    return null
  }

  async function refreshProjection(sheetId: string) {
    const window = getCurrentWindow()
    if (!window) {
      return
    }

    const requestId = store.setter(advanceSpreadsheetProjectionRequestIdAtom)
    const request = createVisibleProjectionRequest({
      sheetId,
      window,
      requestId,
      reason: 'selection',
    })

    store.setter(spreadsheetProjectionSnapshotAtom, {
      status: 'loading',
      request,
      result: undefined,
      error: undefined,
    })

    try {
      const result = await backend.readVisibleProjection(request)
      const current = store.getter(spreadsheetProjectionSnapshotAtom)
      if (current.request?.requestId !== requestId) {
        return
      }
      store.setter(spreadsheetProjectionSnapshotAtom, {
        status: 'ready',
        request,
        result,
        error: undefined,
      })
    } catch (error: unknown) {
      const current = store.getter(spreadsheetProjectionSnapshotAtom)
      if (current.request?.requestId !== requestId) {
        return
      }
      store.setter(spreadsheetProjectionSnapshotAtom, {
        status: 'error',
        request,
        result: undefined,
        error:
          error instanceof Error
            ? { code: 'BACKEND_ERROR', message: error.message }
            : { code: 'BACKEND_ERROR', message: 'Spreadsheet projection failed.' },
      })
    }
  }

  async function executeCommand(intent: MenuCommandIntent) {
    const target = intent.target
    switch (intent.command) {
      case 'cell.clear':
        if (target.kind === 'cell') {
          await backend.setCellInput({
            kind: 'set-cell-input',
            sheetId: target.sheetId,
            row: target.cell.row,
            col: target.cell.col,
            input: '',
          })
        } else if (target.kind === 'range') {
          if (!backend.clearRange) {
            throw new Error('Range clear is not supported by this spreadsheet backend.')
          }
          await backend.clearRange({
            kind: 'clear-range',
            sheetId: target.sheetId,
            range: target.range,
          })
        } else {
          return
        }
        break
      case 'row.insert':
        if (target.kind !== 'row') return
        if (!backend.insertRows) {
          throw new Error('Row insert is not supported by this spreadsheet backend.')
        }
        await backend.insertRows({
          kind: 'insert-rows',
          sheetId: target.sheetId,
          rowIndex: target.rowIndex,
          count: 1,
        })
        break
      case 'row.delete':
        if (target.kind !== 'row') return
        if (!backend.deleteRows) {
          throw new Error('Row delete is not supported by this spreadsheet backend.')
        }
        await backend.deleteRows({
          kind: 'delete-rows',
          sheetId: target.sheetId,
          rowIndex: target.rowIndex,
          count: 1,
        })
        break
      case 'column.insert':
        if (target.kind !== 'column') return
        if (!backend.insertColumns) {
          throw new Error('Column insert is not supported by this spreadsheet backend.')
        }
        await backend.insertColumns({
          kind: 'insert-columns',
          sheetId: target.sheetId,
          colIndex: target.colIndex,
          count: 1,
        })
        break
      case 'column.delete':
        if (target.kind !== 'column') return
        if (!backend.deleteColumns) {
          throw new Error('Column delete is not supported by this spreadsheet backend.')
        }
        await backend.deleteColumns({
          kind: 'delete-columns',
          sheetId: target.sheetId,
          colIndex: target.colIndex,
          count: 1,
        })
        break
      default:
        return
    }
    await refreshProjection(target.sheetId)
  }

  function reportCommandError(error: unknown) {
    const current = store.getter(spreadsheetProjectionSnapshotAtom)
    store.setter(spreadsheetProjectionSnapshotAtom, {
      ...current,
      status: 'error',
      error:
        error instanceof Error
          ? { code: 'BACKEND_ERROR', message: error.message }
          : { code: 'BACKEND_ERROR', message: 'Spreadsheet command failed.' },
    })
  }

  function dispatchCommand(command: MenuCommandKind) {
    const intent = store.setter(dispatchMenuCommandAtom, command)
    if (intent) {
      void executeCommand(intent)
        .catch(reportCommandError)
        .finally(() => {
          setTimeout(() => {
            closeMenu('committed')
          }, 0)
        })
    }
  }

  function onDocumentMouseDown(event: MouseEvent) {
    if (menuState().status !== 'open' || !menuRoot) {
      return
    }

    if (!menuRoot.contains(event.target as Node)) {
      closeMenu()
    }
  }

  function onDocumentKeyDown(event: KeyboardEvent) {
    if (menuState().status !== 'open') {
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu()
    }
  }

  onMount(() => {
    document.addEventListener('mousedown', onDocumentMouseDown, true)
    document.addEventListener('keydown', onDocumentKeyDown, true)

    onCleanup(() => {
      document.removeEventListener('mousedown', onDocumentMouseDown, true)
      document.removeEventListener('keydown', onDocumentKeyDown, true)
    })
  })

  const canRender = () =>
    menuState().status === 'open' && menuState().target !== null && menuState().position !== null
  const commandList = () => {
    const target = menuState().target
    return target ? commandsByTargetKind[target.kind] : []
  }
  const targetRow = () => {
    const target = menuState().target
    return target?.kind === 'row' ? `${target.rowIndex}` : ''
  }
  const targetCol = () => {
    const target = menuState().target
    return target?.kind === 'column' ? `${target.colIndex}` : ''
  }

  return (
    <Show when={canRender()}>
      <div
        class={`context-menu spreadsheet-context-menu ${props.class ?? ''}`.trim()}
        data-testid={props['data-testid'] ?? 'spreadsheet-context-menu'}
        data-menu-status={menuState().status}
        data-menu-surface={menuState().surface ?? ''}
        data-menu-target-kind={menuState().target?.kind ?? ''}
        data-menu-target-sheet-id={menuState().target?.sheetId ?? ''}
        data-menu-target-row={targetRow()}
        data-menu-target-col={targetCol()}
        role="menu"
        style={{
          position: 'absolute',
          left: `${toInt(menuState().position?.x ?? 0)}px`,
          top: `${toInt(menuState().position?.y ?? 0)}px`,
          'z-index': 1000,
        }}
        onContextMenu={(event) => {
          event.preventDefault()
        }}
        ref={(node) => {
          menuRoot = node
        }}
      >
        <For each={commandList()}>
          {(command) => (
            <button
              type="button"
              role="menuitem"
              class="context-menu-item spreadsheet-context-menu-item"
              data-menu-command={command}
              data-testid={`context-menu-command-${command}`}
              onClick={() => {
                dispatchCommand(command)
              }}
            >
              {commandLabels[command]}
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}
