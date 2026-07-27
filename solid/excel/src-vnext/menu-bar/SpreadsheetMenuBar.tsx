import { For, Show, createEffect, createMemo, onCleanup, onMount } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import { useT } from '../../src/i18n'
import {
  addSheetTabAtom,
  beginProjectionAtom,
  closeFindReplaceAtom,
  closeHelpOverlayAtom,
  closeTopMenuAtom,
  copyClipboardAtom,
  captureFilterSortCapabilityAtom,
  captureRemoveDuplicatesCapabilityAtom,
  captureTableCapabilityAtom,
  createInsertColumnsOperation,
  createInsertRowsOperation,
  createTableSupportedAtom,
  cutClipboardAtom,
  dispatchToolbarFormatCommandAtom,
  filterSortEntrypointProjectionAtom,
  findMenuByAccessKey,
  groupSelectionAtom,
  helpOverlayAtom,
  isMenuItemDescriptor,
  MENU_BAR_ITEMS,
  openCommentSessionAtom,
  openConditionalFormatEditorAtom,
  openFilterDropdownFromEntrypointAtom,
  openFindReplaceAtom,
  openFormatCellsAtom,
  openGoToAtom,
  openHelpOverlayAtom,
  openNameManagerAtom,
  openPasteSpecialAtom,
  openProtectionUnlockAtom,
  openRemoveDuplicatesFromSelectionAtom,
  openTopMenuAtom,
  openValidationRuleEditorAtom,
  pasteSpecialCapabilityAtom,
  pasteClipboardAtom,
  protectSheetAtom,
  reapplyFilterAtom,
  reapplyFilterDisabledReasonAtom,
  rejectProjectionAtom,
  hideColumnsAtom,
  hideRowsAtom,
  reportCopyAsStatusAtom,
  resolveProjectionAtom,
  retryFilterSortRefreshAtom,
  removeDuplicatesCapabilityAtom,
  runAutoFillAtom,
  runCreateTableAtom,
  runToggleTableTotalsAtSelectionAtom,
  runPhysicalSortAtom,
  runStructureOperationAtom,
  tableDiagnosticAtom,
  lastCreatedTableNameAtom,
  lastToggledTableTotalsAtom,
  toggleTableTotalsSupportedAtom,
  unhideViewportSelectionAtom,
  runTextToColumnsEntrypointAtom,
  selectAllAtom,
  selectionSnapshotAtom,
  setFreezeConfigAtom,
  toggleFormulaBarAtom,
  toggleGridlinesAtom,
  toggleHeadingsAtom,
  togglePrintPreviewAtom,
  unprotectSheetAtom,
  ungroupSelectionAtom,
  topMenuOpenAtom,
  textToColumnsEntrypointProjectionAtom,
  viewportShowFormulaBarAtom,
  viewportShowGridlinesAtom,
  viewportShowHeadingsAtom,
  workspaceSessionAtom,
  type AutoFillControllerPort,
  type CellRange,
  type MenuBarEntry,
  type MenuItemDescriptor,
  type MenuItemDispatch,
  type RangeProjectionResult,
  type StructureOperationIntent,
  type TopMenuDescriptor,
  type TopMenuId,
} from '@einfach/spreadsheet-ui-core'

import {
  dispatchCopyAs,
  dispatchRedo,
  dispatchUndo,
  refreshVisibleProjection,
  resolveSortRange,
  textToColumnsSupportedAtom,
  useSpreadsheetBackend,
  useSpreadsheetUiStore,
} from '../provider'

export interface SpreadsheetMenuBarProps {
  class?: string
  'data-testid'?: string
  hiddenItemIds?: readonly string[]
}

export function SpreadsheetMenuBar(props: SpreadsheetMenuBarProps) {
  const store = useSpreadsheetUiStore()
  const backend = useSpreadsheetBackend()
  const openState = useAtomValue(topMenuOpenAtom)
  const helpOverlay = useAtomValue(helpOverlayAtom)
  const showGridlines = useAtomValue(viewportShowGridlinesAtom)
  const showHeadings = useAtomValue(viewportShowHeadingsAtom)
  const showFormulaBar = useAtomValue(viewportShowFormulaBarAtom)
  const pasteSpecialCapability = useAtomValue(pasteSpecialCapabilityAtom)
  const textToColumnsSupported = useAtomValue(textToColumnsSupportedAtom)
  const removeDuplicatesCapability = useAtomValue(removeDuplicatesCapabilityAtom)
  const createTableSupported = useAtomValue(createTableSupportedAtom)
  const toggleTableTotalsSupported = useAtomValue(toggleTableTotalsSupportedAtom)
  const tableDiagnostic = useAtomValue(tableDiagnosticAtom)
  const lastCreatedTableName = useAtomValue(lastCreatedTableNameAtom)
  const lastToggledTableTotals = useAtomValue(lastToggledTableTotalsAtom)
  const filterSortEntrypoint = useAtomValue(filterSortEntrypointProjectionAtom)
  const textToColumnsEntrypoint = useAtomValue(textToColumnsEntrypointProjectionAtom)
  const reapplyDisabledReason = useAtomValue(reapplyFilterDisabledReasonAtom)
  let rootRef: HTMLDivElement | undefined

  createEffect(() => {
    store.setter(captureFilterSortCapabilityAtom, backend)
    store.setter(captureRemoveDuplicatesCapabilityAtom, backend)
    store.setter(captureTableCapabilityAtom, backend)
  })

  // Worker backends resolve their fail-closed runtime capability witness
  // asynchronously (describeCapabilities lands after initWorkbook), so
  // port presence sampled at mount can be pre-witness. Recapture once the
  // backend reports ready so the capability atoms hold post-witness
  // truth. Backends without ready() (static, test doubles) are already
  // truthful at mount and skip this.
  onMount(() => {
    const readyable = backend as typeof backend & { ready?: () => Promise<unknown> }
    void readyable.ready
      ?.call(backend)
      .then(() => {
        store.setter(captureFilterSortCapabilityAtom, backend)
        store.setter(captureRemoveDuplicatesCapabilityAtom, backend)
        store.setter(captureTableCapabilityAtom, backend)
      })
      .catch(() => {})
  })

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

  function disabledReasonForDispatch(dispatch: MenuItemDispatch): string | null {
    switch (dispatch.kind) {
      // freeze-panes / unfreeze-panes: freeze is UI-core canonical — the
      // view fact is always available regardless of backend ports.
      case 'open-filter-dropdown':
      case 'sort-asc':
      case 'sort-desc':
        return filterSortEntrypoint().disabledReason
      case 'reapply-filter':
        // Greys out with "no active filter on this sheet" as well as the
        // shared capability / busy-lane reasons — a pure UI-core derivation.
        return reapplyDisabledReason()
      case 'open-text-to-columns':
        return textToColumnsEntrypoint().disabledReason
      default:
        return null
    }
  }

  /**
   * Resolve a capability-gated menu item. Known keys today:
   *   - `'pasteSpecial'`  → host backend implements `pasteRange`
   *   - `'textToColumns'` → host backend implements `importCellChunks`
   *   - `'removeRows'`    → Core reports exact range-read and row-removal
   *                         capabilities (Data → Remove Duplicates)
   *   - `'sortRange'`     → host backend exposes the physical-sort port
   *                         (Data → Sort asc/desc). No port → no sort at
   *                         all (#24 retired the display permutation).
   *   - `'insertRows'` / `'insertColumns'` → host backend exposes the
   *     structural port. Read directly off the backend PER dropdown
   *     render (the dropdown remounts on every open), NOT captured at
   *     mount: worker backends withhold these ports once their async
   *     fail-closed capability witness resolves, so post-ready opens
   *     must see the withheld truth.
   * Returning false makes the dropdown entry hide entirely (vs.
   * show-as-disabled for the placeholder case).
   */
  function resolveCapability(key: string | undefined): boolean {
    if (!key) return false
    switch (key) {
      case 'pasteSpecial':
        return pasteSpecialCapability()
      case 'textToColumns':
        return textToColumnsSupported()
      case 'removeRows':
        return removeDuplicatesCapability().canRead && removeDuplicatesCapability().canRemove
      case 'createTable':
        return createTableSupported()
      case 'toggleTableTotals':
        return toggleTableTotalsSupported()
      case 'insertRows':
        return backend.insertRows != null
      case 'insertColumns':
        return backend.insertColumns != null
      case 'sortRange':
        return backend.sortRange != null
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
    if (item.isAvailable === 'placeholder' || disabledReasonForDispatch(item.dispatch)) return
    routeDispatch(item.dispatch)
    store.setter(closeTopMenuAtom)
  }

  function retryFilterSortRefresh() {
    void store.setter(retryFilterSortRefreshAtom, {
      refreshProjection: (sheetId) => refreshVisibleProjection(store, backend, sheetId),
    })
  }

  function runTextToColumnsEntrypoint() {
    void store.setter(runTextToColumnsEntrypointAtom, { source: backend })
  }

  function runRemoveDuplicatesEntrypoint() {
    void store.setter(openRemoveDuplicatesFromSelectionAtom, { source: backend })
  }

  function runStructureOperation(intent: StructureOperationIntent) {
    void store.setter(runStructureOperationAtom, {
      intent,
      source: backend,
      refreshProjection: (sheetId) => refreshVisibleProjection(store, backend, sheetId),
    })
  }

  function getActiveSheetId(): string | null {
    const snap = store.getter(selectionSnapshotAtom)
    if (snap.selection.sheetId) return snap.selection.sheetId
    const ws = store.getter(workspaceSessionAtom)
    return ws.activeSheetId ?? null
  }

  async function readAutoFillRangeProjection(
    sheetId: string,
    range: Readonly<CellRange>,
  ): Promise<RangeProjectionResult | null> {
    const begin = store.setter(beginProjectionAtom, {
      kind: 'range',
      sheetId,
      range: { ...range },
      reason: 'toolbar',
    })
    if (begin.status !== 'started' || begin.request.kind !== 'range') return null

    const request = begin.request
    try {
      const result = await backend.readRangeProjection(request)
      const outcome = store.setter(resolveProjectionAtom, { request, result })
      return outcome.status === 'accepted' && outcome.result.kind === 'range'
        ? outcome.result
        : null
    } catch (error) {
      store.setter(rejectProjectionAtom, { request, error })
      throw error
    }
  }

  function createAutoFillController(): AutoFillControllerPort {
    return {
      readRangeProjection: readAutoFillRangeProjection,
      setCellInput: (request) => backend.setCellInput(request),
      ...(backend.fillSeries ? { fillSeries: (request) => backend.fillSeries!(request) } : {}),
      ...(backend.fillRange ? { fillRange: (request) => backend.fillRange!(request) } : {}),
      ...(backend.importCells ? { importCells: (request) => backend.importCells!(request) } : {}),
      ...(backend.resolveDataEdge
        ? { resolveDataEdge: (request) => backend.resolveDataEdge!(request) }
        : {}),
    }
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
        if (!store.getter(pasteSpecialCapabilityAtom)) return
        store.setter(openPasteSpecialAtom)
        return
      case 'edit.copyAs': {
        const snap = store.getter(selectionSnapshotAtom)
        const sheetId = snap.selection.sheetId || getActiveSheetId() || ''
        if (!sheetId) return
        // Match the toolbar pattern: surface async failure via the
        // error atom rather than letting a rejection float up as an
        // unhandled promise (Firefox / file:// can reject the backend
        // projection if the worker is mid-restart).
        void dispatchCopyAs(store, backend, { sheetId, range: snap.range }).catch(() => {
          store.setter(reportCopyAsStatusAtom, { kind: 'failed' })
        })
        return
      }
      case 'fill-selection': {
        const sheetId = store.getter(workspaceSessionAtom).activeSheetId
        if (!sheetId) return
        const snap = store.getter(selectionSnapshotAtom)
        void store.setter(runAutoFillAtom, {
          entrypoint: 'fill-command',
          sheetId,
          selectionRange: { ...snap.range },
          direction: dispatch.direction,
          source: createAutoFillController(),
          refreshProjection: (target) =>
            refreshVisibleProjection(store, backend, target, 'toolbar'),
        })
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
        runTextToColumnsEntrypoint()
        return
      }
      case 'open-remove-duplicates': {
        runRemoveDuplicatesEntrypoint()
        return
      }
      case 'create-table': {
        const snap = store.getter(selectionSnapshotAtom)
        const sheetId = snap.activeCell.sheetId || getActiveSheetId() || ''
        if (!sheetId) return
        // Create over the current selection with an engine-auto name.
        // Capability split + structured-reject mapping lives in
        // `runCreateTableAtom`; the diagnostic surfaces via the status row.
        void store.setter(runCreateTableAtom, {
          source: backend,
          sheetId,
          range: snap.range,
          refreshProjection: (target: string) => refreshVisibleProjection(store, backend, target),
        })
        return
      }
      case 'toggle-table-totals': {
        const snap = store.getter(selectionSnapshotAtom)
        const sheetId = snap.activeCell.sheetId || getActiveSheetId() || ''
        if (!sheetId) return
        // Resolve the table under the active cell and flip its totals row.
        // Selection→table resolution + the "no table here" diagnostic live in
        // `runToggleTableTotalsAtSelectionAtom`; the write refreshes the
        // visible projection so the SUBTOTAL cell renders.
        void store.setter(runToggleTableTotalsAtSelectionAtom, {
          source: backend,
          sheetId,
          cell: { row: snap.activeCell.row, col: snap.activeCell.col },
          refreshProjection: (target?: string) =>
            refreshVisibleProjection(store, backend, target ?? sheetId),
        })
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
        store.setter(openFilterDropdownFromEntrypointAtom, {
          source: backend,
          entrypoint: 'menu-bar',
        })
        return
      }
      case 'reapply-filter': {
        void store.setter(reapplyFilterAtom, {
          source: backend,
          entrypoint: 'menu-bar',
          refreshProjection: (sheetId) => refreshVisibleProjection(store, backend, sheetId),
        })
        return
      }
      case 'insert-row-above':
      case 'insert-row-below': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        const snap = store.getter(selectionSnapshotAtom)
        const rowIndex =
          dispatch.kind === 'insert-row-above' ? snap.range.rowStart : snap.range.rowEnd + 1
        runStructureOperation(
          createInsertRowsOperation({
            sheetId,
            rowIndex,
            count: 1,
          }),
        )
        return
      }
      case 'insert-column-left':
      case 'insert-column-right': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        const snap = store.getter(selectionSnapshotAtom)
        const colIndex =
          dispatch.kind === 'insert-column-left' ? snap.range.colStart : snap.range.colEnd + 1
        runStructureOperation(
          createInsertColumnsOperation({
            sheetId,
            colIndex,
            count: 1,
          }),
        )
        return
      }
      case 'insert-sheet': {
        void store.setter(addSheetTabAtom)
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
      // hide-rows / hide-cols / unhide-rows / unhide-cols: hidden state is
      // UI-core canonical — the commands commit locally and mirror into the
      // backend ports only when present, so they work on every backend.
      case 'hide-rows': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        const snap = store.getter(selectionSnapshotAtom)
        const rows: number[] = []
        for (let r = snap.range.rowStart; r <= snap.range.rowEnd; r += 1) rows.push(r)
        store.setter(hideRowsAtom, { sheetId, indices: rows, source: backend })
        return
      }
      case 'hide-cols': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        const snap = store.getter(selectionSnapshotAtom)
        const cols: number[] = []
        for (let c = snap.range.colStart; c <= snap.range.colEnd; c += 1) cols.push(c)
        store.setter(hideColumnsAtom, { sheetId, indices: cols, source: backend })
        return
      }
      case 'unhide-rows':
      case 'unhide-cols':
        store.setter(unhideViewportSelectionAtom, {
          action: dispatch.kind === 'unhide-rows' ? 'unhide-rows' : 'unhide-columns',
          source: backend,
        })
        return
      case 'freeze-panes': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        const snap = store.getter(selectionSnapshotAtom)
        store.setter(setFreezeConfigAtom, {
          source: backend,
          sheetId,
          rows: snap.activeCell.row,
          cols: snap.activeCell.col,
        })
        return
      }
      case 'unfreeze-panes': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        store.setter(setFreezeConfigAtom, {
          source: backend,
          sheetId,
          rows: 0,
          cols: 0,
        })
        return
      }
      // protect-sheet / unprotect-sheet / unlock-range: protection is
      // UI-core canonical — commands commit locally and mirror into the
      // optional backend persistence ports only when present, so they
      // work on every backend (including the worker runtimes, which
      // expose no protection port).
      case 'protect-sheet': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        store.setter(protectSheetAtom, { sheetId, source: backend })
        return
      }
      case 'unprotect-sheet': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        store.setter(unprotectSheetAtom, { sheetId, source: backend })
        return
      }
      case 'unlock-range': {
        const sheetId = getActiveSheetId()
        if (!sheetId) return
        const snap = store.getter(selectionSnapshotAtom)
        store.setter(openProtectionUnlockAtom, { sheetId, range: snap.range })
        return
      }
      // outline-group / outline-ungroup: outline metadata is UI-core
      // canonical — the commands resolve the current selection and commit
      // locally; collapse visibility reuses the hidden canonical sets.
      case 'outline-group-rows':
      case 'outline-group-cols':
        store.setter(groupSelectionAtom, {
          axis: dispatch.kind === 'outline-group-rows' ? 'row' : 'column',
          source: backend,
        })
        return
      case 'outline-ungroup-rows':
      case 'outline-ungroup-cols':
        store.setter(ungroupSelectionAtom, {
          axis: dispatch.kind === 'outline-ungroup-rows' ? 'row' : 'column',
          source: backend,
        })
        return
      case 'sort-asc':
      case 'sort-desc': {
        const direction = dispatch.kind === 'sort-asc' ? 'asc' : 'desc'
        // One physical-sort command through the engine `sortRange` port. The
        // entries are capability-gated on that port (#24), so reaching here
        // without it is impossible from the menu — guarded anyway.
        void (async () => {
          const snap = store.getter(selectionSnapshotAtom)
          const sheetId = snap.activeCell.sheetId || getActiveSheetId()
          if (!sheetId) return
          if (typeof backend.sortRange !== 'function') return
          const range = await resolveSortRange(store, backend, sheetId, snap.activeCell)
          void store.setter(runPhysicalSortAtom, {
            source: backend,
            entrypoint: 'menu-bar',
            direction,
            range,
            refreshProjection: (target) => refreshVisibleProjection(store, backend, target),
          })
        })()
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
        data-filter-sort-status={filterSortEntrypoint().status}
        data-filter-sort-error={filterSortEntrypoint().error || undefined}
        data-text-to-columns-entrypoint-status={textToColumnsEntrypoint().status}
        data-text-to-columns-entrypoint-error={textToColumnsEntrypoint().error || undefined}
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
              getDisabledReason={disabledReasonForDispatch}
              resolveCapability={resolveCapability}
              hiddenItemIds={props.hiddenItemIds}
            />
          )}
        </For>
      </div>
      <Show when={filterSortEntrypoint().error}>
        {(error) => (
          <span role="status" data-testid="menu-bar-filter-sort-status">
            {error()}
          </span>
        )}
      </Show>
      <Show when={filterSortEntrypoint().status === 'refresh-failed'}>
        <button
          type="button"
          data-testid="menu-bar-filter-sort-refresh-retry"
          aria-label="Retry filter and sort refresh"
          onClick={retryFilterSortRefresh}
        >
          ↻
        </button>
      </Show>
      <Show when={textToColumnsEntrypoint().status === 'loading'}>
        <span role="status" data-testid="menu-bar-text-to-columns-loading">
          Loading Text to Columns source…
        </span>
      </Show>
      <Show when={textToColumnsEntrypoint().error}>
        {(error) => (
          <span role="status" data-testid="menu-bar-text-to-columns-status">
            {error()}
          </span>
        )}
      </Show>
      <Show when={textToColumnsEntrypoint().canRetry}>
        <button
          type="button"
          data-testid="menu-bar-text-to-columns-retry"
          aria-label="Retry loading Text to Columns source"
          onClick={runTextToColumnsEntrypoint}
        >
          ↻
        </button>
      </Show>
      <Show when={lastCreatedTableName()}>
        {(name) => (
          <span role="status" data-testid="menu-bar-create-table-status" data-table-name={name()}>
            {name()}
          </span>
        )}
      </Show>
      <Show when={lastToggledTableTotals()}>
        {(totals) => (
          <span
            role="status"
            data-testid="menu-bar-toggle-totals-status"
            data-table-name={totals().name}
            data-has-totals={totals().hasTotals ? 'true' : 'false'}
          >
            {totals().name}
          </span>
        )}
      </Show>
      <Show when={tableDiagnostic()}>
        {(diagnostic) => (
          <span
            role="status"
            data-testid="menu-bar-create-table-error"
            data-table-diagnostic-code={diagnostic().code}
          >
            {diagnostic().message}
          </span>
        )}
      </Show>
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
  getDisabledReason: (dispatch: MenuItemDispatch) => string | null
  resolveCapability: (key: string | undefined) => boolean
  hiddenItemIds?: readonly string[]
}

function MenuBarTopButton(props: MenuBarTopButtonProps) {
  const t = useT()
  const entries = createMemo(() =>
    filterHostVisibleEntries(props.menu.items, props.hiddenItemIds ?? []),
  )
  return (
    // a11y: `role="none"` strips the wrapper's generic role so the ARIA tree
    // under role="menubar" is menubar → menuitem, matching the APG pattern
    // (`li[role=none] > a[role=menuitem]`). Without it axe reports
    // `aria-required-children` (critical) on `.spreadsheet-menu-bar`.
    <div class="menu-bar-top" role="none" data-testid={`menu-bar-top-${props.menu.id}`}>
      <button
        type="button"
        class={`menu-bar-button ${props.isOpen ? 'menu-bar-button-open' : ''}`.trim()}
        data-testid={`menu-bar-button-${props.menu.id}`}
        role="menuitem"
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
          <For each={entries()}>
            {(entry) => (
              <MenuBarDropdownEntry
                entry={entry}
                onActivate={props.onItemActivate}
                getChecked={props.getChecked}
                getDisabledReason={props.getDisabledReason}
                resolveCapability={props.resolveCapability}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function filterHostVisibleEntries(
  entries: readonly MenuBarEntry[],
  hiddenItemIds: readonly string[],
): readonly MenuBarEntry[] {
  if (hiddenItemIds.length === 0) return entries

  const hiddenIds = new Set(hiddenItemIds)
  const filtered: MenuBarEntry[] = []
  let pendingSeparator: MenuBarEntry | null = null

  for (const entry of entries) {
    if (isMenuItemDescriptor(entry) && hiddenIds.has(entry.id)) continue

    if (!isMenuItemDescriptor(entry)) {
      if (filtered.length > 0 && pendingSeparator === null) pendingSeparator = entry
      continue
    }

    if (pendingSeparator) {
      filtered.push(pendingSeparator)
      pendingSeparator = null
    }
    filtered.push(entry)
  }

  return filtered
}

interface MenuBarDropdownEntryProps {
  entry: MenuBarEntry
  onActivate: (item: MenuItemDescriptor) => void
  getChecked: (dispatch: MenuItemDispatch) => boolean | undefined
  getDisabledReason: (dispatch: MenuItemDispatch) => string | null
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
          getDisabledReason={props.getDisabledReason}
        />
      </Show>
    </Show>
  )
}

function DropdownItemButton(props: {
  item: MenuItemDescriptor
  onActivate: (item: MenuItemDescriptor) => void
  getChecked: (dispatch: MenuItemDispatch) => boolean | undefined
  getDisabledReason: (dispatch: MenuItemDispatch) => string | null
}) {
  const t = useT()
  const disabledReason = () => props.getDisabledReason(props.item.dispatch)
  const isDisabled = () => props.item.isAvailable === 'placeholder' || disabledReason() !== null
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
        disabledReason() ??
        (isDisabled()
          ? props.item.placeholderMessage
            ? t(props.item.placeholderMessage)
            : ''
          : (props.item.shortcut ?? ''))
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
          {props.kind === 'shortcuts' ? t('help.shortcuts.title') : t('help.about.title')}
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
