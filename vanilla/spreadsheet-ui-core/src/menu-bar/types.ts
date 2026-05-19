export type TopMenuId = 'file' | 'edit' | 'insert' | 'format' | 'data' | 'view' | 'help'

export type TopMenuOpenState =
  | { kind: 'idle' }
  | { kind: 'open'; menu: TopMenuId }

/**
 * A menu item declaration. The Solid host reads this registry to render
 * the dropdowns and resolve clicks to atom dispatches.
 */
export interface MenuItemDescriptor {
  id: string
  label: string
  accessKey?: string
  shortcut?: string
  dispatch: MenuItemDispatch
  isAvailable?: 'always' | 'placeholder'
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
  | { kind: 'paste' }
  | { kind: 'select-all' }
  | { kind: 'delete-cells' }
  | { kind: 'open-find-replace' }
  | { kind: 'open-find-replace-replace' }
  | { kind: 'toggle-print-preview' }
  | { kind: 'open-name-manager' }
  | { kind: 'open-comment-session' }
  | { kind: 'open-conditional-format' }
  | { kind: 'open-data-validation' }
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
  | { kind: 'hide-cols' }
  | { kind: 'freeze-panes' }
  | { kind: 'unfreeze-panes' }
  | { kind: 'sort-asc' }
  | { kind: 'sort-desc' }
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
