import { For, Show, createMemo, onCleanup, onMount } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  closeFindReplaceAtom,
  closeHelpOverlayAtom,
  closeTopMenuAtom,
  copyClipboardAtom,
  cutClipboardAtom,
  dispatchSortAtom,
  dispatchToolbarFormatCommandAtom,
  findMenuByAccessKey,
  helpOverlayAtom,
  isMenuItemDescriptor,
  issueFilterSortSyncTicketAtom,
  MENU_BAR_ITEMS,
  nextHistoryTransactionId,
  openCommentSessionAtom,
  openConditionalFormatEditorAtom,
  openFilterDropdownAtom,
  openFindReplaceAtom,
  openFormatCellsAtom,
  openGoToAtom,
  openHelpOverlayAtom,
  openNameManagerAtom,
  openPasteSpecialAtom,
  openTextToColumnsAtom,
  openTopMenuAtom,
  openValidationRuleEditorAtom,
  pasteClipboardAtom,
  pushHistoryAtom,
  selectAllAtom,
  selectionSnapshotAtom,
  setFilterSortErrorAtom,
  setViewportFreezeAtom,
  setViewportHiddenAtom,
  toggleFormulaBarAtom,
  toggleGridlinesAtom,
  toggleHeadingsAtom,
  togglePrintPreviewAtom,
  topMenuOpenAtom,
  viewportShowFormulaBarAtom,
  viewportShowGridlinesAtom,
  viewportShowHeadingsAtom,
  workspaceSessionAtom,
  type MenuBarEntry,
  type MenuItemDescriptor,
  type MenuItemDispatch,
  type TopMenuDescriptor,
  type TopMenuId,
} from '@einfach/spreadsheet-ui-core'

import {
  dispatchRedo,
  dispatchUndo,
  pasteSpecialSupportedAtom,
  refreshVisibleProjection,
  textToColumnsSupportedAtom,
  useSpreadsheetBackend,
  useSpreadsheetUiStore,
} from '../provider'

export interface SpreadsheetMenuBarProps {
  class?: string
  'data-testid'?: string
}

export function SpreadsheetMenuBar(props: SpreadsheetMenuBarProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const openState = useAtomValue(topMenuOpenAtom)
  const helpOverlay = useAtomValue(helpOverlayAtom)
  const showGridlines = useAtomValue(viewportShowGridlinesAtom)
  const showHeadings = useAtomValue(viewportShowHeadingsAtom)
  const showFormulaBar = useAtomValue(viewportShowFormulaBarAtom)
  const pasteSpecialSupported = useAtomValue(pasteSpecialSupportedAtom)
  const textToColumnsSupported = useAtomValue(textToColumnsSupportedAtom)
  let rootRef: HTMLDivElement | undefined

  function checkedForDispatch(dispatch: MenuItemDispatch): boolean | undefined {
    switch (dispatch.kind) {
      case 'toggle-gridlines':
        return showGridlines()
      case 'toggle-headings':
        return showHeadings()
      case 'toggle-formula-bar':
        return showFormulaBar()
      default:
        return undefined
    }
  }

  /**
   * Resolve a capability-gated menu item. Known keys today:
   *   - `'pasteSpecial'`  → host backend implements `pasteRange`
   *   - `'textToColumns'` → host backend implements `importCellChunks`
   * Returning false makes the dropdown entry hide entirely (vs.
   * show-as-disabled for the placeholder case).
   */
  function resolveCapability(key: string | undefined): boolean {
    if (!key) return false
    switch (key) {
      case 'pasteSpecial':
        return pasteSpecialSupported()
      case 'textToColumns':
        return textToColumnsSupported()
      default:
        return false
    }
  }

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
        void dispatchUndo(store, backend)
        return
      case 'redo':
        void dispatchRedo(store, backend)
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
      case 'edit.pasteSpecial':
        store.setter(openPasteSpecialAtom)
        return
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
      case 'edit.goTo':
        store.setter(openGoToAtom)
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
      case 'open-text-to-columns': {
        const snap = store.getter(selectionSnapshotAtom)
        const sheetId = snap.selection.sheetId || getActiveSheetId() || ''
        if (!sheetId) return
        // Text to Columns requires a single source column. Surface the
        // dialog regardless — the dialog itself shows the disable
        // message when the selection spans multiple columns. We still
        // forward the (single-col) range so the dialog can hydrate.
        const range = snap.range
        const colIndex = range.colStart
        void (async () => {
          const rows: { sourceRow: number; text: string }[] = []
          if (range.colStart === range.colEnd) {
            const projection = await backend.readRangeProjection({
              kind: 'range',
              sheetId,
              range,
              requestId: 0,
              reason: 'toolbar',
            })
            const byRow = new Map<number, string>()
            for (const cell of projection.cells) {
              if (cell.col === colIndex) byRow.set(cell.row, cell.displayValue ?? '')
            }
            for (let r = range.rowStart; r <= range.rowEnd; r += 1) {
              rows.push({ sourceRow: r, text: byRow.get(r) ?? '' })
            }
          }
          store.setter(openTextToColumnsAtom, {
            sheetId,
            anchor: { row: range.rowStart, col: colIndex },
            rows,
          })
        })()
        return
      }
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
      case 'insert-row-below': {
        const sheetId = getActiveSheetId()
        if (!sheetId || !backend.insertRows) return
        const snap = store.getter(selectionSnapshotAtom)
        const rowIndex =
          dispatch.kind === 'insert-row-above' ? snap.range.rowStart : snap.range.rowEnd + 1
        void (async () => {
          const result = await backend.insertRows!({
            kind: 'insert-rows',
            sheetId,
            rowIndex,
            count: 1,
          })
          const rev =
            typeof result?.revision === 'number'
              ? result.revision
              : Number(result?.revision ?? 0) || 0
          store.setter(pushHistoryAtom, {
            transactionId: nextHistoryTransactionId(),
            kind: 'row.insert',
            sheetId,
            projectionRevision: rev,
            affectedRange: result?.affectedRange,
          })
          await refreshVisibleProjection(store, backend, sheetId)
        })()
        return
      }
      case 'insert-column-left':
      case 'insert-column-right': {
        const sheetId = getActiveSheetId()
        if (!sheetId || !backend.insertColumns) return
        const snap = store.getter(selectionSnapshotAtom)
        const colIndex =
          dispatch.kind === 'insert-column-left' ? snap.range.colStart : snap.range.colEnd + 1
        void (async () => {
          const result = await backend.insertColumns!({
            kind: 'insert-columns',
            sheetId,
            colIndex,
            count: 1,
          })
          const rev =
            typeof result?.revision === 'number'
              ? result.revision
              : Number(result?.revision ?? 0) || 0
          store.setter(pushHistoryAtom, {
            transactionId: nextHistoryTransactionId(),
            kind: 'column.insert',
            sheetId,
            projectionRevision: rev,
            affectedRange: result?.affectedRange,
          })
          await refreshVisibleProjection(store, backend, sheetId)
        })()
        return
      }
      case 'insert-sheet': {
        if (!backend.addSheet) return
        void (async () => {
          await backend.addSheet!({ kind: 'add-sheet' })
        })()
        return
      }
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
      case 'sort-desc': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        const snap = store.getter(selectionSnapshotAtom)
        const colIndex = snap.range.colStart
        const direction = dispatch.kind === 'sort-asc' ? 'asc' : 'desc'
        const next = store.setter(dispatchSortAtom, {
          sheetId,
          colIndex,
          direction,
        })
        if (backend.setFilterSort) {
          const ticket = store.setter(issueFilterSortSyncTicketAtom) as number
          void (async () => {
            try {
              await backend.setFilterSort!({
                kind: 'set-filter-sort',
                sheetId,
                rules: next.rules,
                directives: next.directives,
              })
              store.setter(setFilterSortErrorAtom, null)
              void ticket
              await refreshVisibleProjection(store, backend, sheetId)
            } catch (err) {
              store.setter(setFilterSortErrorAtom, err)
            }
          })()
        }
        return
      }
      case 'toggle-formula-bar':
        store.setter(toggleFormulaBarAtom)
        return
      case 'toggle-gridlines':
        store.setter(toggleGridlinesAtom)
        return
      case 'toggle-headings':
        store.setter(toggleHeadingsAtom)
        return
      case 'toggle-full-screen':
      case 'zoom-in':
      case 'zoom-out':
      case 'zoom-reset':
        return
      case 'open-about':
        store.setter(openHelpOverlayAtom, 'about')
        return
      case 'open-keyboard-shortcuts':
        store.setter(openHelpOverlayAtom, 'shortcuts')
        return
      case 'placeholder':
        return
      default:
        return
    }
  }

  return (
    <>
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
              getChecked={checkedForDispatch}
              resolveCapability={resolveCapability}
            />
          )}
        </For>
      </div>
      <HelpOverlayDialog kind={helpOverlay()} onClose={() => store.setter(closeHelpOverlayAtom)} />
    </>
  )
}

interface MenuBarTopButtonProps {
  menu: TopMenuDescriptor
  isOpen: boolean
  onClick: () => void
  onHover: () => void
  onItemActivate: (item: MenuItemDescriptor) => void
  getChecked: (dispatch: MenuItemDispatch) => boolean | undefined
  resolveCapability: (key: string | undefined) => boolean
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
              <MenuBarDropdownEntry
                entry={entry}
                onActivate={props.onItemActivate}
                getChecked={props.getChecked}
                resolveCapability={props.resolveCapability}
              />
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
  getChecked: (dispatch: MenuItemDispatch) => boolean | undefined
  resolveCapability: (key: string | undefined) => boolean
}

function MenuBarDropdownEntry(props: MenuBarDropdownEntryProps) {
  // Hide capability-gated entries when the host can't fulfil them.
  // Separators stay visible — they're cosmetic and rare-enough that
  // hiding them as well would require knowing about adjacent items.
  const isHidden = () => {
    if (!isMenuItemDescriptor(props.entry)) return false
    const item = props.entry as MenuItemDescriptor
    if (item.isAvailable !== 'capability') return false
    return !props.resolveCapability(item.capabilityKey)
  }
  return (
    <Show when={!isHidden()}>
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
          getChecked={props.getChecked}
        />
      </Show>
    </Show>
  )
}

function DropdownItemButton(props: {
  item: MenuItemDescriptor
  onActivate: (item: MenuItemDescriptor) => void
  getChecked: (dispatch: MenuItemDispatch) => boolean | undefined
}) {
  const t = useT()
  const isDisabled = () => props.item.isAvailable === 'placeholder'
  const checked = () => props.getChecked(props.item.dispatch)
  const hasCheck = () => checked() !== undefined
  return (
    <button
      type="button"
      class={`menu-bar-item ${isDisabled() ? 'menu-bar-item-disabled' : ''} ${
        hasCheck() ? 'menu-bar-item-checkable' : ''
      }`.trim()}
      role={hasCheck() ? 'menuitemcheckbox' : 'menuitem'}
      data-testid={`menu-bar-item-${props.item.id}`}
      disabled={isDisabled()}
      aria-checked={hasCheck() ? (checked() ? 'true' : 'false') : undefined}
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

interface HelpOverlayDialogProps {
  kind: 'closed' | 'shortcuts' | 'about'
  onClose: () => void
}

const KEYBOARD_SHORTCUTS: ReadonlyArray<{ keys: string; labelKey: string }> = [
  { keys: 'Ctrl+Z', labelKey: 'help.shortcuts.undo' },
  { keys: 'Ctrl+Y', labelKey: 'help.shortcuts.redo' },
  { keys: 'Ctrl+C', labelKey: 'help.shortcuts.copy' },
  { keys: 'Ctrl+X', labelKey: 'help.shortcuts.cut' },
  { keys: 'Ctrl+V', labelKey: 'help.shortcuts.paste' },
  { keys: 'Ctrl+F', labelKey: 'help.shortcuts.find' },
  { keys: 'Ctrl+H', labelKey: 'help.shortcuts.replace' },
  { keys: 'Ctrl+A', labelKey: 'help.shortcuts.selectAll' },
  { keys: 'F2', labelKey: 'help.shortcuts.edit' },
  { keys: 'Esc', labelKey: 'help.shortcuts.cancel' },
]

function HelpOverlayDialog(props: HelpOverlayDialogProps) {
  const t = useT()
  const isOpen = () => props.kind !== 'closed'
  return (
    <Show when={isOpen()}>
      <div
        class="spreadsheet-help-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="spreadsheet-help-overlay-title"
        data-testid={`spreadsheet-help-overlay-${props.kind}`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            props.onClose()
          }
        }}
      >
        <h2 class="spreadsheet-help-overlay-title" id="spreadsheet-help-overlay-title">
          {props.kind === 'shortcuts'
            ? t('help.shortcuts.title')
            : t('help.about.title')}
        </h2>
        <Show
          when={props.kind === 'shortcuts'}
          fallback={
            <p
              class="spreadsheet-help-overlay-body"
              data-testid="spreadsheet-help-overlay-about-body"
            >
              {t('help.about.body')}
            </p>
          }
        >
          <ul
            class="spreadsheet-help-overlay-shortcut-list"
            data-testid="spreadsheet-help-overlay-shortcut-list"
          >
            <For each={KEYBOARD_SHORTCUTS}>
              {(item) => (
                <li class="spreadsheet-help-overlay-shortcut-item">
                  <kbd class="spreadsheet-help-overlay-keys">{item.keys}</kbd>
                  <span class="spreadsheet-help-overlay-label">{t(item.labelKey)}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <div class="spreadsheet-help-overlay-actions">
          <button
            type="button"
            class="spreadsheet-help-overlay-close"
            data-testid="spreadsheet-help-overlay-close"
            onClick={() => props.onClose()}
          >
            {t('help.close')}
          </button>
        </div>
      </div>
    </Show>
  )
}
