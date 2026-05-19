import { atom } from '@einfach/core'
import type { MenuBarEntry, TopMenuDescriptor, TopMenuId, TopMenuOpenState } from './types'

export * from './types'

const IDLE_STATE: TopMenuOpenState = { kind: 'idle' }

export const topMenuOpenAtom = atom<TopMenuOpenState>(IDLE_STATE)
topMenuOpenAtom.debugLabel = 'spreadsheet.menuBar.openCategory'

export const topMenuHighlightAtom = atom<string | null>(null)
topMenuHighlightAtom.debugLabel = 'spreadsheet.menuBar.highlight'

export const openTopMenuAtom = atom(
  (get) => get(topMenuOpenAtom),
  (_get, set, menu: TopMenuId) => {
    set(topMenuOpenAtom, { kind: 'open', menu })
    set(topMenuHighlightAtom, null)
  },
)
openTopMenuAtom.debugLabel = 'spreadsheet.menuBar.open'

export const closeTopMenuAtom = atom(
  (get) => get(topMenuOpenAtom),
  (_get, set) => {
    set(topMenuOpenAtom, IDLE_STATE)
    set(topMenuHighlightAtom, null)
  },
)
closeTopMenuAtom.debugLabel = 'spreadsheet.menuBar.close'

const FILE_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'file.new',
    label: 'New',
    accessKey: 'N',
    dispatch: { kind: 'placeholder', reason: 'Coming soon' },
    isAvailable: 'placeholder',
    placeholderMessage: 'New workbook is not wired yet',
  },
  {
    id: 'file.open',
    label: 'Open…',
    accessKey: 'O',
    dispatch: { kind: 'placeholder', reason: 'Coming soon' },
    isAvailable: 'placeholder',
    placeholderMessage: 'Open is not wired yet',
  },
  {
    id: 'file.save',
    label: 'Save',
    accessKey: 'S',
    dispatch: { kind: 'placeholder', reason: 'Coming soon' },
    isAvailable: 'placeholder',
    placeholderMessage: 'Save is not wired yet',
  },
  { kind: 'separator', id: 'file.sep-1' },
  {
    id: 'file.printPreview',
    label: 'Print Preview',
    accessKey: 'P',
    dispatch: { kind: 'toggle-print-preview' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'file.sep-2' },
  {
    id: 'file.close',
    label: 'Close',
    accessKey: 'C',
    dispatch: { kind: 'placeholder', reason: 'Coming soon' },
    isAvailable: 'placeholder',
    placeholderMessage: 'Close is not wired yet',
  },
]

const EDIT_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'edit.undo',
    label: 'Undo',
    accessKey: 'U',
    shortcut: 'Ctrl+Z',
    dispatch: { kind: 'undo' },
    isAvailable: 'always',
  },
  {
    id: 'edit.redo',
    label: 'Redo',
    accessKey: 'R',
    shortcut: 'Ctrl+Y',
    dispatch: { kind: 'redo' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'edit.sep-1' },
  {
    id: 'edit.cut',
    label: 'Cut',
    accessKey: 'T',
    shortcut: 'Ctrl+X',
    dispatch: { kind: 'cut' },
    isAvailable: 'always',
  },
  {
    id: 'edit.copy',
    label: 'Copy',
    accessKey: 'C',
    shortcut: 'Ctrl+C',
    dispatch: { kind: 'copy' },
    isAvailable: 'always',
  },
  {
    id: 'edit.paste',
    label: 'Paste',
    accessKey: 'P',
    shortcut: 'Ctrl+V',
    dispatch: { kind: 'paste' },
    isAvailable: 'always',
  },
  {
    id: 'edit.pasteSpecial',
    label: 'Paste Special…',
    dispatch: { kind: 'placeholder', reason: 'Coming in Wave 6' },
    isAvailable: 'placeholder',
    placeholderMessage: 'Coming in Wave 6',
  },
  { kind: 'separator', id: 'edit.sep-2' },
  {
    id: 'edit.find',
    label: 'Find…',
    accessKey: 'F',
    shortcut: 'Ctrl+F',
    dispatch: { kind: 'open-find-replace' },
    isAvailable: 'always',
  },
  {
    id: 'edit.replace',
    label: 'Replace…',
    accessKey: 'E',
    shortcut: 'Ctrl+H',
    dispatch: { kind: 'open-find-replace-replace' },
    isAvailable: 'always',
  },
  {
    id: 'edit.goTo',
    label: 'Go To…',
    dispatch: { kind: 'placeholder', reason: 'Coming in Wave 7' },
    isAvailable: 'placeholder',
    placeholderMessage: 'Coming in Wave 7',
  },
  { kind: 'separator', id: 'edit.sep-3' },
  {
    id: 'edit.delete',
    label: 'Delete Cells',
    accessKey: 'D',
    dispatch: { kind: 'delete-cells' },
    isAvailable: 'always',
  },
  {
    id: 'edit.selectAll',
    label: 'Select All',
    accessKey: 'A',
    shortcut: 'Ctrl+A',
    dispatch: { kind: 'select-all' },
    isAvailable: 'always',
  },
]

const INSERT_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'insert.rowAbove',
    label: 'Insert Row Above',
    accessKey: 'A',
    dispatch: { kind: 'insert-row-above' },
    isAvailable: 'always',
  },
  {
    id: 'insert.rowBelow',
    label: 'Insert Row Below',
    accessKey: 'B',
    dispatch: { kind: 'insert-row-below' },
    isAvailable: 'always',
  },
  {
    id: 'insert.colLeft',
    label: 'Insert Column Left',
    accessKey: 'L',
    dispatch: { kind: 'insert-column-left' },
    isAvailable: 'always',
  },
  {
    id: 'insert.colRight',
    label: 'Insert Column Right',
    accessKey: 'R',
    dispatch: { kind: 'insert-column-right' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'insert.sep-1' },
  {
    id: 'insert.sheet',
    label: 'Insert Sheet',
    accessKey: 'S',
    dispatch: { kind: 'insert-sheet' },
    isAvailable: 'always',
  },
  {
    id: 'insert.hyperlink',
    label: 'Hyperlink…',
    dispatch: { kind: 'placeholder', reason: 'Coming soon' },
    isAvailable: 'placeholder',
    placeholderMessage: 'Hyperlink editor not wired yet',
  },
  {
    id: 'insert.comment',
    label: 'Comment',
    accessKey: 'C',
    dispatch: { kind: 'open-comment-session' },
    isAvailable: 'always',
  },
  {
    id: 'insert.nameManager',
    label: 'Name Manager…',
    accessKey: 'N',
    dispatch: { kind: 'open-name-manager' },
    isAvailable: 'always',
  },
]

const FORMAT_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'format.cells',
    label: 'Format Cells…',
    dispatch: { kind: 'placeholder', reason: 'Coming in Wave 6' },
    isAvailable: 'placeholder',
    placeholderMessage: 'Coming in Wave 6',
  },
  { kind: 'separator', id: 'format.sep-1' },
  {
    id: 'format.fillColor',
    label: 'Cell Color',
    dispatch: { kind: 'set-fill-color' },
    isAvailable: 'always',
  },
  {
    id: 'format.textColor',
    label: 'Text Color',
    dispatch: { kind: 'set-text-color' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'format.sep-2' },
  {
    id: 'format.bold',
    label: 'Bold',
    accessKey: 'B',
    shortcut: 'Ctrl+B',
    dispatch: { kind: 'toggle-bold' },
    isAvailable: 'always',
  },
  {
    id: 'format.italic',
    label: 'Italic',
    accessKey: 'I',
    shortcut: 'Ctrl+I',
    dispatch: { kind: 'toggle-italic' },
    isAvailable: 'always',
  },
  {
    id: 'format.underline',
    label: 'Underline',
    accessKey: 'U',
    shortcut: 'Ctrl+U',
    dispatch: { kind: 'toggle-underline' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'format.sep-3' },
  {
    id: 'format.conditional',
    label: 'Conditional Formatting…',
    accessKey: 'C',
    dispatch: { kind: 'open-conditional-format' },
    isAvailable: 'always',
  },
  {
    id: 'format.validation',
    label: 'Data Validation…',
    accessKey: 'V',
    dispatch: { kind: 'open-data-validation' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'format.sep-4' },
  {
    id: 'format.hideRow',
    label: 'Hide Row',
    dispatch: { kind: 'hide-rows' },
    isAvailable: 'always',
  },
  {
    id: 'format.hideCol',
    label: 'Hide Column',
    dispatch: { kind: 'hide-cols' },
    isAvailable: 'always',
  },
  {
    id: 'format.freezePanes',
    label: 'Freeze Panes',
    accessKey: 'F',
    dispatch: { kind: 'freeze-panes' },
    isAvailable: 'always',
  },
]

const DATA_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'data.sortAsc',
    label: 'Sort Ascending',
    accessKey: 'A',
    dispatch: { kind: 'sort-asc' },
    isAvailable: 'always',
  },
  {
    id: 'data.sortDesc',
    label: 'Sort Descending',
    accessKey: 'D',
    dispatch: { kind: 'sort-desc' },
    isAvailable: 'always',
  },
  {
    id: 'data.filter',
    label: 'Filter…',
    accessKey: 'F',
    dispatch: { kind: 'open-filter-dropdown' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'data.sep-1' },
  {
    id: 'data.textToColumns',
    label: 'Text to Columns…',
    dispatch: { kind: 'placeholder', reason: 'Coming in Wave 7' },
    isAvailable: 'placeholder',
    placeholderMessage: 'Coming in Wave 7',
  },
  {
    id: 'data.removeDuplicates',
    label: 'Remove Duplicates…',
    dispatch: { kind: 'placeholder', reason: 'Coming in Wave 8' },
    isAvailable: 'placeholder',
    placeholderMessage: 'Coming in Wave 8',
  },
  { kind: 'separator', id: 'data.sep-2' },
  {
    id: 'data.validation',
    label: 'Data Validation…',
    accessKey: 'V',
    dispatch: { kind: 'open-data-validation' },
    isAvailable: 'always',
  },
]

const VIEW_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'view.zoomIn',
    label: 'Zoom In',
    accessKey: 'I',
    dispatch: { kind: 'zoom-in' },
    isAvailable: 'always',
  },
  {
    id: 'view.zoomOut',
    label: 'Zoom Out',
    accessKey: 'O',
    dispatch: { kind: 'zoom-out' },
    isAvailable: 'always',
  },
  {
    id: 'view.zoomReset',
    label: 'Zoom to 100%',
    accessKey: 'R',
    dispatch: { kind: 'zoom-reset' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'view.sep-1' },
  {
    id: 'view.formulaBar',
    label: 'Show Formula Bar',
    accessKey: 'F',
    dispatch: { kind: 'toggle-formula-bar' },
    isAvailable: 'always',
  },
  {
    id: 'view.gridlines',
    label: 'Show Gridlines',
    accessKey: 'G',
    dispatch: { kind: 'toggle-gridlines' },
    isAvailable: 'always',
  },
  {
    id: 'view.headings',
    label: 'Show Headings',
    accessKey: 'H',
    dispatch: { kind: 'toggle-headings' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'view.sep-2' },
  {
    id: 'view.freeze',
    label: 'Freeze Panes',
    accessKey: 'Z',
    dispatch: { kind: 'freeze-panes' },
    isAvailable: 'always',
  },
  {
    id: 'view.unfreeze',
    label: 'Unfreeze Panes',
    dispatch: { kind: 'unfreeze-panes' },
    isAvailable: 'always',
  },
  {
    id: 'view.fullScreen',
    label: 'Full Screen',
    accessKey: 'S',
    dispatch: { kind: 'toggle-full-screen' },
    isAvailable: 'always',
  },
]

const HELP_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'help.shortcuts',
    label: 'Keyboard Shortcuts',
    accessKey: 'K',
    dispatch: { kind: 'open-keyboard-shortcuts' },
    isAvailable: 'always',
  },
  {
    id: 'help.about',
    label: 'About',
    accessKey: 'A',
    dispatch: { kind: 'open-about' },
    isAvailable: 'always',
  },
]

export const MENU_BAR_ITEMS: readonly TopMenuDescriptor[] = [
  { id: 'file', label: 'File', accessKey: 'F', items: FILE_ITEMS },
  { id: 'edit', label: 'Edit', accessKey: 'E', items: EDIT_ITEMS },
  { id: 'insert', label: 'Insert', accessKey: 'I', items: INSERT_ITEMS },
  { id: 'format', label: 'Format', accessKey: 'O', items: FORMAT_ITEMS },
  { id: 'data', label: 'Data', accessKey: 'D', items: DATA_ITEMS },
  { id: 'view', label: 'View', accessKey: 'V', items: VIEW_ITEMS },
  { id: 'help', label: 'Help', accessKey: 'H', items: HELP_ITEMS },
]

export function isMenuItemDescriptor(
  entry: MenuBarEntry,
): entry is Exclude<MenuBarEntry, { kind: 'separator' }> {
  return !('kind' in entry) || entry.kind !== 'separator'
}

export function findTopMenu(id: TopMenuId): TopMenuDescriptor | undefined {
  return MENU_BAR_ITEMS.find((menu) => menu.id === id)
}

export function findMenuByAccessKey(letter: string): TopMenuDescriptor | undefined {
  const upper = letter.toUpperCase()
  return MENU_BAR_ITEMS.find((menu) => menu.accessKey.toUpperCase() === upper)
}
