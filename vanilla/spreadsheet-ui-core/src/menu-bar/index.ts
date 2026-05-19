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

// Help overlays (Keyboard Shortcuts / About). Lightweight placeholder dialogs
// driven by a single discriminated atom rather than separate booleans so the
// menu bar can only have one help overlay open at a time.

export type HelpOverlayKind = 'closed' | 'shortcuts' | 'about'

export const helpOverlayAtom = atom<HelpOverlayKind>('closed')
helpOverlayAtom.debugLabel = 'spreadsheet.menuBar.helpOverlay'

export const openHelpOverlayAtom = atom(
  (get) => get(helpOverlayAtom),
  (_get, set, kind: Exclude<HelpOverlayKind, 'closed'>) => {
    set(helpOverlayAtom, kind)
  },
)
openHelpOverlayAtom.debugLabel = 'spreadsheet.menuBar.openHelpOverlay'

export const closeHelpOverlayAtom = atom(
  (get) => get(helpOverlayAtom),
  (_get, set) => {
    set(helpOverlayAtom, 'closed')
  },
)
closeHelpOverlayAtom.debugLabel = 'spreadsheet.menuBar.closeHelpOverlay'

const FILE_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'file.new',
    label: 'menuBar.file.new',
    accessKey: 'N',
    dispatch: { kind: 'placeholder', reason: 'menuBar.placeholder.comingSoon' },
    isAvailable: 'placeholder',
    placeholderMessage: 'menuBar.placeholder.newWorkbook',
  },
  {
    id: 'file.open',
    label: 'menuBar.file.open',
    accessKey: 'O',
    dispatch: { kind: 'placeholder', reason: 'menuBar.placeholder.comingSoon' },
    isAvailable: 'placeholder',
    placeholderMessage: 'menuBar.placeholder.openFile',
  },
  {
    id: 'file.save',
    label: 'menuBar.file.save',
    accessKey: 'S',
    dispatch: { kind: 'placeholder', reason: 'menuBar.placeholder.comingSoon' },
    isAvailable: 'placeholder',
    placeholderMessage: 'menuBar.placeholder.saveFile',
  },
  { kind: 'separator', id: 'file.sep-1' },
  {
    id: 'file.printPreview',
    label: 'menuBar.file.printPreview',
    accessKey: 'P',
    dispatch: { kind: 'toggle-print-preview' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'file.sep-2' },
  {
    id: 'file.close',
    label: 'menuBar.file.close',
    accessKey: 'C',
    dispatch: { kind: 'placeholder', reason: 'menuBar.placeholder.comingSoon' },
    isAvailable: 'placeholder',
    placeholderMessage: 'menuBar.placeholder.closeFile',
  },
]

const EDIT_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'edit.undo',
    label: 'menuBar.edit.undo',
    accessKey: 'U',
    shortcut: 'Ctrl+Z',
    dispatch: { kind: 'undo' },
    isAvailable: 'always',
  },
  {
    id: 'edit.redo',
    label: 'menuBar.edit.redo',
    accessKey: 'R',
    shortcut: 'Ctrl+Y',
    dispatch: { kind: 'redo' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'edit.sep-1' },
  {
    id: 'edit.cut',
    label: 'menuBar.edit.cut',
    accessKey: 'T',
    shortcut: 'Ctrl+X',
    dispatch: { kind: 'cut' },
    isAvailable: 'always',
  },
  {
    id: 'edit.copy',
    label: 'menuBar.edit.copy',
    accessKey: 'C',
    shortcut: 'Ctrl+C',
    dispatch: { kind: 'copy' },
    isAvailable: 'always',
  },
  {
    id: 'edit.paste',
    label: 'menuBar.edit.paste',
    accessKey: 'P',
    shortcut: 'Ctrl+V',
    dispatch: { kind: 'paste' },
    isAvailable: 'always',
  },
  {
    id: 'edit.pasteSpecial',
    label: 'menuBar.edit.pasteSpecial',
    dispatch: { kind: 'placeholder', reason: 'menuBar.placeholder.wave6' },
    isAvailable: 'placeholder',
    placeholderMessage: 'menuBar.placeholder.wave6',
  },
  { kind: 'separator', id: 'edit.sep-2' },
  {
    id: 'edit.find',
    label: 'menuBar.edit.find',
    accessKey: 'F',
    shortcut: 'Ctrl+F',
    dispatch: { kind: 'open-find-replace' },
    isAvailable: 'always',
  },
  {
    id: 'edit.replace',
    label: 'menuBar.edit.replace',
    accessKey: 'E',
    shortcut: 'Ctrl+H',
    dispatch: { kind: 'open-find-replace-replace' },
    isAvailable: 'always',
  },
  {
    id: 'edit.goTo',
    label: 'menuBar.edit.goTo',
    dispatch: { kind: 'placeholder', reason: 'menuBar.placeholder.wave7' },
    isAvailable: 'placeholder',
    placeholderMessage: 'menuBar.placeholder.wave7',
  },
  { kind: 'separator', id: 'edit.sep-3' },
  {
    id: 'edit.delete',
    label: 'menuBar.edit.delete',
    accessKey: 'D',
    dispatch: { kind: 'delete-cells' },
    isAvailable: 'always',
  },
  {
    id: 'edit.selectAll',
    label: 'menuBar.edit.selectAll',
    accessKey: 'A',
    shortcut: 'Ctrl+A',
    dispatch: { kind: 'select-all' },
    isAvailable: 'always',
  },
]

const INSERT_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'insert.rowAbove',
    label: 'menuBar.insert.rowAbove',
    accessKey: 'A',
    dispatch: { kind: 'insert-row-above' },
    isAvailable: 'always',
  },
  {
    id: 'insert.rowBelow',
    label: 'menuBar.insert.rowBelow',
    accessKey: 'B',
    dispatch: { kind: 'insert-row-below' },
    isAvailable: 'always',
  },
  {
    id: 'insert.colLeft',
    label: 'menuBar.insert.colLeft',
    accessKey: 'L',
    dispatch: { kind: 'insert-column-left' },
    isAvailable: 'always',
  },
  {
    id: 'insert.colRight',
    label: 'menuBar.insert.colRight',
    accessKey: 'R',
    dispatch: { kind: 'insert-column-right' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'insert.sep-1' },
  {
    id: 'insert.sheet',
    label: 'menuBar.insert.sheet',
    accessKey: 'S',
    dispatch: { kind: 'insert-sheet' },
    isAvailable: 'always',
  },
  {
    id: 'insert.hyperlink',
    label: 'menuBar.insert.hyperlink',
    dispatch: { kind: 'placeholder', reason: 'menuBar.placeholder.comingSoon' },
    isAvailable: 'placeholder',
    placeholderMessage: 'menuBar.placeholder.hyperlink',
  },
  {
    id: 'insert.comment',
    label: 'menuBar.insert.comment',
    accessKey: 'C',
    dispatch: { kind: 'open-comment-session' },
    isAvailable: 'always',
  },
  {
    id: 'insert.nameManager',
    label: 'menuBar.insert.nameManager',
    accessKey: 'N',
    dispatch: { kind: 'open-name-manager' },
    isAvailable: 'always',
  },
]

const FORMAT_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'format.cells',
    label: 'menuBar.format.cells',
    accessKey: 'E',
    dispatch: { kind: 'open-format-cells' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'format.sep-1' },
  {
    id: 'format.fillColor',
    label: 'menuBar.format.fillColor',
    dispatch: { kind: 'set-fill-color' },
    isAvailable: 'always',
  },
  {
    id: 'format.textColor',
    label: 'menuBar.format.textColor',
    dispatch: { kind: 'set-text-color' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'format.sep-2' },
  {
    id: 'format.bold',
    label: 'menuBar.format.bold',
    accessKey: 'B',
    shortcut: 'Ctrl+B',
    dispatch: { kind: 'toggle-bold' },
    isAvailable: 'always',
  },
  {
    id: 'format.italic',
    label: 'menuBar.format.italic',
    accessKey: 'I',
    shortcut: 'Ctrl+I',
    dispatch: { kind: 'toggle-italic' },
    isAvailable: 'always',
  },
  {
    id: 'format.underline',
    label: 'menuBar.format.underline',
    accessKey: 'U',
    shortcut: 'Ctrl+U',
    dispatch: { kind: 'toggle-underline' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'format.sep-3' },
  {
    id: 'format.conditional',
    label: 'menuBar.format.conditional',
    accessKey: 'C',
    dispatch: { kind: 'open-conditional-format' },
    isAvailable: 'always',
  },
  {
    id: 'format.validation',
    label: 'menuBar.format.validation',
    accessKey: 'V',
    dispatch: { kind: 'open-data-validation' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'format.sep-4' },
  {
    id: 'format.hideRow',
    label: 'menuBar.format.hideRow',
    dispatch: { kind: 'hide-rows' },
    isAvailable: 'always',
  },
  {
    id: 'format.hideCol',
    label: 'menuBar.format.hideCol',
    dispatch: { kind: 'hide-cols' },
    isAvailable: 'always',
  },
  {
    id: 'format.freezePanes',
    label: 'menuBar.format.freezePanes',
    accessKey: 'F',
    dispatch: { kind: 'freeze-panes' },
    isAvailable: 'always',
  },
]

const DATA_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'data.sortAsc',
    label: 'menuBar.data.sortAsc',
    accessKey: 'A',
    dispatch: { kind: 'sort-asc' },
    isAvailable: 'always',
  },
  {
    id: 'data.sortDesc',
    label: 'menuBar.data.sortDesc',
    accessKey: 'D',
    dispatch: { kind: 'sort-desc' },
    isAvailable: 'always',
  },
  {
    id: 'data.filter',
    label: 'menuBar.data.filter',
    accessKey: 'F',
    dispatch: { kind: 'open-filter-dropdown' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'data.sep-1' },
  {
    id: 'data.textToColumns',
    label: 'menuBar.data.textToColumns',
    dispatch: { kind: 'placeholder', reason: 'menuBar.placeholder.wave7' },
    isAvailable: 'placeholder',
    placeholderMessage: 'menuBar.placeholder.wave7',
  },
  {
    id: 'data.removeDuplicates',
    label: 'menuBar.data.removeDuplicates',
    dispatch: { kind: 'placeholder', reason: 'menuBar.placeholder.wave8' },
    isAvailable: 'placeholder',
    placeholderMessage: 'menuBar.placeholder.wave8',
  },
  { kind: 'separator', id: 'data.sep-2' },
  {
    id: 'data.validation',
    label: 'menuBar.data.validation',
    accessKey: 'V',
    dispatch: { kind: 'open-data-validation' },
    isAvailable: 'always',
  },
]

const VIEW_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'view.zoomIn',
    label: 'menuBar.view.zoomIn',
    accessKey: 'I',
    dispatch: { kind: 'zoom-in' },
    isAvailable: 'always',
  },
  {
    id: 'view.zoomOut',
    label: 'menuBar.view.zoomOut',
    accessKey: 'O',
    dispatch: { kind: 'zoom-out' },
    isAvailable: 'always',
  },
  {
    id: 'view.zoomReset',
    label: 'menuBar.view.zoomReset',
    accessKey: 'R',
    dispatch: { kind: 'zoom-reset' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'view.sep-1' },
  {
    id: 'view.formulaBar',
    label: 'menuBar.view.formulaBar',
    accessKey: 'F',
    dispatch: { kind: 'toggle-formula-bar' },
    isAvailable: 'always',
  },
  {
    id: 'view.gridlines',
    label: 'menuBar.view.gridlines',
    accessKey: 'G',
    dispatch: { kind: 'toggle-gridlines' },
    isAvailable: 'always',
  },
  {
    id: 'view.headings',
    label: 'menuBar.view.headings',
    accessKey: 'H',
    dispatch: { kind: 'toggle-headings' },
    isAvailable: 'always',
  },
  { kind: 'separator', id: 'view.sep-2' },
  {
    id: 'view.freeze',
    label: 'menuBar.view.freeze',
    accessKey: 'Z',
    dispatch: { kind: 'freeze-panes' },
    isAvailable: 'always',
  },
  {
    id: 'view.unfreeze',
    label: 'menuBar.view.unfreeze',
    dispatch: { kind: 'unfreeze-panes' },
    isAvailable: 'always',
  },
  {
    id: 'view.fullScreen',
    label: 'menuBar.view.fullScreen',
    accessKey: 'S',
    dispatch: { kind: 'toggle-full-screen' },
    isAvailable: 'always',
  },
]

const HELP_ITEMS: readonly MenuBarEntry[] = [
  {
    id: 'help.shortcuts',
    label: 'menuBar.help.shortcuts',
    accessKey: 'K',
    dispatch: { kind: 'open-keyboard-shortcuts' },
    isAvailable: 'always',
  },
  {
    id: 'help.about',
    label: 'menuBar.help.about',
    accessKey: 'A',
    dispatch: { kind: 'open-about' },
    isAvailable: 'always',
  },
]

export const MENU_BAR_ITEMS: readonly TopMenuDescriptor[] = [
  { id: 'file', label: 'menuBar.file', accessKey: 'F', items: FILE_ITEMS },
  { id: 'edit', label: 'menuBar.edit', accessKey: 'E', items: EDIT_ITEMS },
  { id: 'insert', label: 'menuBar.insert', accessKey: 'I', items: INSERT_ITEMS },
  { id: 'format', label: 'menuBar.format', accessKey: 'O', items: FORMAT_ITEMS },
  { id: 'data', label: 'menuBar.data', accessKey: 'D', items: DATA_ITEMS },
  { id: 'view', label: 'menuBar.view', accessKey: 'V', items: VIEW_ITEMS },
  { id: 'help', label: 'menuBar.help', accessKey: 'H', items: HELP_ITEMS },
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
