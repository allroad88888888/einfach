export type TopMenuId = 'file' | 'edit' | 'insert' | 'format' | 'data' | 'view' | 'help'

export type TopMenuOpenState = { kind: 'idle' } | { kind: 'open'; menu: TopMenuId }

/**
 * A menu item declaration. The Solid host reads this registry to render
 * the dropdowns and resolve clicks to atom dispatches.
 *
 * `isAvailable` is three-state. `'capability'` means the host must
 * resolve `capabilityKey` against a backend port flag (e.g. for
 * `pasteSpecial` → `backend.pasteRange != null`) and hide the entry
 * when the flag is false. Wave 7.3 added this for Paste Special.
 */
export interface MenuItemDescriptor {
  id: string
  label: string
  accessKey?: string
  shortcut?: string
  dispatch: MenuItemDispatch
  isAvailable?: 'always' | 'placeholder' | 'capability'
  /**
   * Capability key resolved by the host when `isAvailable` is
   * `'capability'`. The host's known keys today:
   * - `'pasteSpecial'` → `backend.pasteRange != null`
   * - `'textToColumns'` → `backend.importCellChunks != null`
   * - `'removeRows'` → `backend.removeRows != null` (Remove Duplicates)
   * - `'createTable'` → `backend.createTable != null` (Data → Create table;
   *   host resolves it through `createTableSupportedAtom`)
   * - `'insertRows'` → `backend.insertRows != null` (structural row edits;
   *   read PER menu open — worker backends may withhold the port only
   *   after their async capability witness resolves)
   * - `'insertColumns'` → `backend.insertColumns != null` (structural
   *   column edits; same per-open read)
   *
   * TODO(paste-special review LOW #5): tighten this to a union of the
   * known capability literals so typos in registry entries become
   * compile errors. Deferred because it's a cross-cutting menu-bar API
   * change that touches every host adapter; tracked separately from
   * Paste Special wave 7.3.
   */
  capabilityKey?: string
  placeholderMessage?: string
}

export interface MenuItemSeparator {
  kind: 'separator'
  id: string
}

export type MenuBarEntry = MenuItemDescriptor | MenuItemSeparator

export interface TopMenuDescriptor {
  id: TopMenuId
  label: string
  accessKey: string
  items: readonly MenuBarEntry[]
}

export type MenuItemDispatch =
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'cut' }
  | { kind: 'copy' }
  | { kind: 'edit.copyAs' }
  | { kind: 'paste' }
  | { kind: 'edit.pasteSpecial' }
  | { kind: 'select-all' }
  | { kind: 'delete-cells' }
  | { kind: 'open-find-replace' }
  | { kind: 'open-find-replace-replace' }
  | { kind: 'edit.goTo' }
  | { kind: 'toggle-print-preview' }
  | { kind: 'open-name-manager' }
  | { kind: 'open-comment-session' }
  | { kind: 'open-conditional-format' }
  | { kind: 'open-data-validation' }
  | { kind: 'open-text-to-columns' }
  | { kind: 'open-remove-duplicates' }
  | { kind: 'create-table' }
  | { kind: 'open-format-cells' }
  | { kind: 'open-filter-dropdown' }
  | { kind: 'insert-row-above' }
  | { kind: 'insert-row-below' }
  | { kind: 'insert-column-left' }
  | { kind: 'insert-column-right' }
  | { kind: 'insert-sheet' }
  | { kind: 'toggle-bold' }
  | { kind: 'toggle-italic' }
  | { kind: 'toggle-underline' }
  | { kind: 'set-fill-color' }
  | { kind: 'set-text-color' }
  | { kind: 'hide-rows' }
  | { kind: 'unhide-rows' }
  | { kind: 'hide-cols' }
  | { kind: 'unhide-cols' }
  | { kind: 'freeze-panes' }
  | { kind: 'unfreeze-panes' }
  | { kind: 'protect-sheet' }
  | { kind: 'unprotect-sheet' }
  | { kind: 'unlock-range' }
  | { kind: 'sort-asc' }
  | { kind: 'sort-desc' }
  | { kind: 'outline-group-rows' }
  | { kind: 'outline-ungroup-rows' }
  | { kind: 'outline-group-cols' }
  | { kind: 'outline-ungroup-cols' }
  | { kind: 'toggle-formula-bar' }
  | { kind: 'toggle-gridlines' }
  | { kind: 'toggle-headings' }
  | { kind: 'toggle-full-screen' }
  | { kind: 'zoom-in' }
  | { kind: 'zoom-out' }
  | { kind: 'zoom-reset' }
  | { kind: 'open-about' }
  | { kind: 'open-keyboard-shortcuts' }
  | { kind: 'placeholder'; reason: string }
