import { For, Show, createMemo, onCleanup, onMount } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  closeFindReplaceAtom,
  closeTopMenuAtom,
  copyClipboardAtom,
  cutClipboardAtom,
  dispatchToolbarFormatCommandAtom,
  findMenuByAccessKey,
  isMenuItemDescriptor,
  MENU_BAR_ITEMS,
  openCommentSessionAtom,
  openConditionalFormatEditorAtom,
  openFilterDropdownAtom,
  openFindReplaceAtom,
  openFormatCellsAtom,
  openNameManagerAtom,
  openTopMenuAtom,
  openValidationRuleEditorAtom,
  pasteClipboardAtom,
  redoHistoryAtom,
  selectAllAtom,
  selectionSnapshotAtom,
  setViewportFreezeAtom,
  setViewportHiddenAtom,
  togglePrintPreviewAtom,
  topMenuOpenAtom,
  undoHistoryAtom,
  workspaceSessionAtom,
  type MenuBarEntry,
  type MenuItemDescriptor,
  type MenuItemDispatch,
  type TopMenuDescriptor,
  type TopMenuId,
} from '@einfach/spreadsheet-ui-core'

import { useSpreadsheetUiStore } from '../provider'

export interface SpreadsheetMenuBarProps {
  class?: string
  'data-testid'?: string
}

export function SpreadsheetMenuBar(props: SpreadsheetMenuBarProps) {
  const store = useSpreadsheetUiStore()
  const openState = useAtomValue(topMenuOpenAtom)
  let rootRef: HTMLDivElement | undefined

  const openMenu = createMemo<TopMenuId | null>(() => {
    const s = openState()
    return s.kind === 'open' ? s.menu : null
  })

  function onDocPointerDown(e: MouseEvent) {
    if (!rootRef) return
    const target = e.target as Node | null
    if (target && rootRef.contains(target)) return
    if (openMenu() !== null) {
      store.setter(closeTopMenuAtom)
    }
  }

  function onDocKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (openMenu() !== null) {
        e.preventDefault()
        store.setter(closeTopMenuAtom)
      }
      return
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
      const menu = findMenuByAccessKey(e.key)
      if (menu) {
        e.preventDefault()
        store.setter(openTopMenuAtom, menu.id)
      }
    }
  }

  onMount(() => {
    document.addEventListener('mousedown', onDocPointerDown, true)
    document.addEventListener('keydown', onDocKeyDown)
  })

  onCleanup(() => {
    document.removeEventListener('mousedown', onDocPointerDown, true)
    document.removeEventListener('keydown', onDocKeyDown)
  })

  function handleTopButtonClick(menuId: TopMenuId) {
    if (openMenu() === menuId) {
      store.setter(closeTopMenuAtom)
    } else {
      store.setter(openTopMenuAtom, menuId)
    }
  }

  function handleTopButtonHover(menuId: TopMenuId) {
    if (openMenu() !== null && openMenu() !== menuId) {
      store.setter(openTopMenuAtom, menuId)
    }
  }

  function dispatchItem(item: MenuItemDescriptor) {
    if (item.isAvailable === 'placeholder') return
    routeDispatch(item.dispatch)
    store.setter(closeTopMenuAtom)
  }

  function getActiveSheetId(): string | null {
    const snap = store.getter(selectionSnapshotAtom)
    if (snap.selection.sheetId) return snap.selection.sheetId
    const ws = store.getter(workspaceSessionAtom)
    return ws.activeSheetId ?? null
  }

  function routeDispatch(dispatch: MenuItemDispatch) {
    switch (dispatch.kind) {
      case 'undo':
        store.setter(undoHistoryAtom)
        return
      case 'redo':
        store.setter(redoHistoryAtom)
        return
      case 'cut':
      case 'copy':
      case 'paste': {
        const snap = store.getter(selectionSnapshotAtom)
        const sheetId = snap.selection.sheetId || getActiveSheetId() || ''
        if (!sheetId) return
        const input = { source: { sheetId, range: snap.range } }
        if (dispatch.kind === 'cut') store.setter(cutClipboardAtom, input)
        else if (dispatch.kind === 'copy') store.setter(copyClipboardAtom, input)
        else store.setter(pasteClipboardAtom, input)
        return
      }
      case 'select-all': {
        const sheetId = getActiveSheetId() ?? undefined
        store.setter(selectAllAtom, sheetId)
        return
      }
      case 'delete-cells':
        return
      case 'open-find-replace':
        store.setter(closeFindReplaceAtom)
        store.setter(openFindReplaceAtom)
        return
      case 'open-find-replace-replace':
        store.setter(openFindReplaceAtom)
        return
      case 'toggle-print-preview':
        store.setter(togglePrintPreviewAtom)
        return
      case 'open-name-manager':
        store.setter(openNameManagerAtom, { status: 'editing-new' })
        return
      case 'open-comment-session': {
        const snap = store.getter(selectionSnapshotAtom)
        const sheetId = snap.selection.sheetId || getActiveSheetId() || ''
        if (!sheetId) return
        store.setter(openCommentSessionAtom, {
          sheetId,
          cell: snap.activeCell,
        })
        return
      }
      case 'open-conditional-format':
        store.setter(openConditionalFormatEditorAtom, null)
        return
      case 'open-data-validation':
        store.setter(openValidationRuleEditorAtom, {})
        return
      case 'open-format-cells': {
        const snap = store.getter(selectionSnapshotAtom)
        const sheetId = snap.selection.sheetId || getActiveSheetId() || ''
        if (!sheetId) return
        store.setter(openFormatCellsAtom, {
          sheetId,
          range: snap.range,
        })
        return
      }
      case 'open-filter-dropdown': {
        const snap = store.getter(selectionSnapshotAtom)
        const sheetId = snap.selection.sheetId || getActiveSheetId() || ''
        if (!sheetId) return
        store.setter(openFilterDropdownAtom, {
          sheetId,
          colIndex: snap.range.colStart,
        })
        return
      }
      case 'insert-row-above':
      case 'insert-row-below':
      case 'insert-column-left':
      case 'insert-column-right':
      case 'insert-sheet':
        return
      case 'toggle-bold': {
        const sheetId = getActiveSheetId() ?? undefined
        store.setter(dispatchToolbarFormatCommandAtom, { command: 'bold', sheetId })
        return
      }
      case 'toggle-italic': {
        const sheetId = getActiveSheetId() ?? undefined
        store.setter(dispatchToolbarFormatCommandAtom, { command: 'italic', sheetId })
        return
      }
      case 'toggle-underline':
        return
      case 'set-fill-color': {
        const sheetId = getActiveSheetId() ?? undefined
        store.setter(dispatchToolbarFormatCommandAtom, {
          command: 'fill-color',
          value: '#ffd966',
          sheetId,
        })
        return
      }
      case 'set-text-color': {
        const sheetId = getActiveSheetId() ?? undefined
        store.setter(dispatchToolbarFormatCommandAtom, {
          command: 'text-color',
          value: '#000000',
          sheetId,
        })
        return
      }
      case 'hide-rows': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        const snap = store.getter(selectionSnapshotAtom)
        const rows: number[] = []
        for (let r = snap.range.rowStart; r <= snap.range.rowEnd; r += 1) rows.push(r)
        store.setter(setViewportHiddenAtom, { sheetId, rows })
        return
      }
      case 'hide-cols': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        const snap = store.getter(selectionSnapshotAtom)
        const cols: number[] = []
        for (let c = snap.range.colStart; c <= snap.range.colEnd; c += 1) cols.push(c)
        store.setter(setViewportHiddenAtom, { sheetId, cols })
        return
      }
      case 'freeze-panes': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        const snap = store.getter(selectionSnapshotAtom)
        store.setter(setViewportFreezeAtom, {
          sheetId,
          rows: snap.activeCell.row,
          cols: snap.activeCell.col,
        })
        return
      }
      case 'unfreeze-panes': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        store.setter(setViewportFreezeAtom, { sheetId, rows: 0, cols: 0 })
        return
      }
      case 'sort-asc':
      case 'sort-desc':
        return
      case 'toggle-formula-bar':
      case 'toggle-gridlines':
      case 'toggle-headings':
      case 'toggle-full-screen':
      case 'zoom-in':
      case 'zoom-out':
      case 'zoom-reset':
      case 'open-about':
      case 'open-keyboard-shortcuts':
        return
      case 'placeholder':
        return
      default:
        return
    }
  }

  return (
    <div
      ref={rootRef}
      class={`spreadsheet-menu-bar ${props.class ?? ''}`.trim()}
      role="menubar"
      data-testid={props['data-testid'] ?? 'spreadsheet-menu-bar'}
    >
      <For each={MENU_BAR_ITEMS}>
        {(menu) => (
          <MenuBarTopButton
            menu={menu}
            isOpen={openMenu() === menu.id}
            onClick={() => handleTopButtonClick(menu.id)}
            onHover={() => handleTopButtonHover(menu.id)}
            onItemActivate={dispatchItem}
          />
        )}
      </For>
    </div>
  )
}

interface MenuBarTopButtonProps {
  menu: TopMenuDescriptor
  isOpen: boolean
  onClick: () => void
  onHover: () => void
  onItemActivate: (item: MenuItemDescriptor) => void
}

function MenuBarTopButton(props: MenuBarTopButtonProps) {
  const t = useT()
  return (
    <div class="menu-bar-top" data-testid={`menu-bar-top-${props.menu.id}`}>
      <button
        type="button"
        class={`menu-bar-button ${props.isOpen ? 'menu-bar-button-open' : ''}`.trim()}
        data-testid={`menu-bar-button-${props.menu.id}`}
        aria-haspopup="menu"
        aria-expanded={props.isOpen}
        accessKey={props.menu.accessKey.toLowerCase()}
        onClick={() => props.onClick()}
        onMouseEnter={() => props.onHover()}
      >
        {t(props.menu.label)}
      </button>
      <Show when={props.isOpen}>
        <div
          class="menu-bar-dropdown"
          role="menu"
          data-testid={`menu-bar-dropdown-${props.menu.id}`}
        >
          <For each={props.menu.items}>
            {(entry) => (
              <MenuBarDropdownEntry entry={entry} onActivate={props.onItemActivate} />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

interface MenuBarDropdownEntryProps {
  entry: MenuBarEntry
  onActivate: (item: MenuItemDescriptor) => void
}

function MenuBarDropdownEntry(props: MenuBarDropdownEntryProps) {
  return (
    <Show
      when={isMenuItemDescriptor(props.entry)}
      fallback={
        <div
          class="menu-bar-separator"
          role="separator"
          data-testid={`menu-bar-separator-${(props.entry as { id: string }).id}`}
        />
      }
    >
      <DropdownItemButton
        item={props.entry as MenuItemDescriptor}
        onActivate={props.onActivate}
      />
    </Show>
  )
}

function DropdownItemButton(props: {
  item: MenuItemDescriptor
  onActivate: (item: MenuItemDescriptor) => void
}) {
  const t = useT()
  const isDisabled = () => props.item.isAvailable === 'placeholder'
  return (
    <button
      type="button"
      class={`menu-bar-item ${isDisabled() ? 'menu-bar-item-disabled' : ''}`.trim()}
      role="menuitem"
      data-testid={`menu-bar-item-${props.item.id}`}
      disabled={isDisabled()}
      title={
        isDisabled()
          ? props.item.placeholderMessage
            ? t(props.item.placeholderMessage)
            : ''
          : (props.item.shortcut ?? '')
      }
      onClick={() => props.onActivate(props.item)}
    >
      <span class="menu-bar-item-label">{t(props.item.label)}</span>
      <Show when={props.item.shortcut}>
        <span class="menu-bar-item-shortcut">{props.item.shortcut}</span>
      </Show>
    </button>
  )
}
