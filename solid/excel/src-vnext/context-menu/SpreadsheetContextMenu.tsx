import { onCleanup, onMount, For, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  closeMenuAtom,
  dispatchMenuCommandAtom,
  menuStateAtom,
  type MenuCommandKind,
  type MenuTargetKind,
} from '@einfach/spreadsheet-ui-core'

import { useSpreadsheetUiStore } from '../provider'

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
  cell: [
    'clipboard.copy',
    'clipboard.cut',
    'clipboard.paste',
    'cell.clear',
    'row.insert',
    'row.delete',
    'column.insert',
    'column.delete',
  ],
  range: [
    'clipboard.copy',
    'clipboard.cut',
    'clipboard.paste',
    'cell.clear',
    'row.insert',
    'row.delete',
    'column.insert',
    'column.delete',
  ],
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
  const menuState = useAtomValue(menuStateAtom)
  let menuRoot: HTMLDivElement | undefined

  function closeMenu(reason: 'dismissed' | 'committed' = 'dismissed') {
    store.setter(closeMenuAtom, reason)
  }

  function dispatchCommand(command: MenuCommandKind) {
    const intent = store.setter(dispatchMenuCommandAtom, command)
    if (intent) {
      setTimeout(() => {
        closeMenu('committed')
      }, 0)
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
