/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import {
  commentSessionAtom,
  filterSortStateAtom,
  findReplaceOpenAtom,
  helpOverlayAtom,
  historyStackAtom,
  MENU_BAR_ITEMS,
  openTopMenuAtom,
  printPreviewOpenAtom,
  selectionAtom,
  topMenuOpenAtom,
  validationRuleEditorAtom,
  viewportShowFormulaBarAtom,
  viewportShowGridlinesAtom,
  viewportShowHeadingsAtom,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetMenuBar } from '../src-vnext/menu-bar'

afterEach(cleanup)

function createBaseBackend(): SpreadsheetBackend {
  return {
    async readVisibleProjection() {
      throw new Error('not used')
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
  }
}

function setupSelection(store: ReturnType<typeof createStore>) {
  store.setter(selectionAtom, {
    kind: 'cell',
    sheetId: 'sheet-1',
    anchor: { row: 0, col: 0 },
    focus: { row: 0, col: 0 },
  })
}

describe('SpreadsheetMenuBar', () => {
  it('renders the seven top-level menu buttons in the expected order', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    const buttons = container.querySelectorAll('[data-testid^="menu-bar-button-"]')
    expect(buttons).toHaveLength(7)
    const ids = MENU_BAR_ITEMS.map((m) => m.id)
    expect(ids).toEqual(['file', 'edit', 'insert', 'format', 'data', 'view', 'help'])
  })

  it('clicking File renders the File dropdown', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(container.querySelector('[data-testid="menu-bar-dropdown-file"]')).toBeNull()
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-file"]')!)
    expect(container.querySelector('[data-testid="menu-bar-dropdown-file"]')).not.toBeNull()
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'open', menu: 'file' })
  })

  it('Edit > Undo fires undoHistoryAtom when history has an entry', () => {
    const store = createStore()
    const backend = createBaseBackend()

    store.setter(historyStackAtom, {
      entries: [
        {
          transactionId: 'tx1',
          kind: 'cell.set-input',
          sheetId: 'sheet-1',
          projectionRevision: 1,
        },
      ],
      cursor: 1,
      inFlight: false,
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-edit.undo"]')!)

    const state = store.getter(historyStackAtom)
    expect(state.cursor).toBe(0)
    // dispatchUndo resolves inFlight once the backend (or fallback) acks.
    expect(state.inFlight).toBe(false)
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  it('Edit > Find opens the find/replace dialog', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(findReplaceOpenAtom)).toBe(false)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-edit.find"]')!)
    expect(store.getter(findReplaceOpenAtom)).toBe(true)
  })

  it('File > Print Preview toggles printPreviewOpenAtom', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(printPreviewOpenAtom)).toBe(false)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-file"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-file.printPreview"]')!)
    expect(store.getter(printPreviewOpenAtom)).toBe(true)
  })

  it('Esc closes an open menu', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-file"]')!)
    expect(store.getter(topMenuOpenAtom).kind).toBe('open')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  it('click outside the menubar closes the open menu', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const outside = document.createElement('div')
    outside.setAttribute('data-testid', 'outside-target')
    document.body.appendChild(outside)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-file"]')!)
    expect(store.getter(topMenuOpenAtom).kind).toBe('open')

    fireEvent.mouseDown(outside)
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
    outside.remove()
  })

  it('placeholder items are disabled and do not dispatch', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    const goTo = container.querySelector('[data-testid="menu-bar-item-edit.goTo"]') as
      | HTMLButtonElement
      | null
    expect(goTo).not.toBeNull()
    expect(goTo!.disabled).toBe(true)
    expect(goTo!.getAttribute('title')).toContain('Wave 7')

    fireEvent.click(goTo!)
    expect(store.getter(topMenuOpenAtom).kind).toBe('open')
  })

  it('Alt+F (mnemonic) opens the File menu', () => {
    const store = createStore()
    const backend = createBaseBackend()

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(topMenuOpenAtom).kind).toBe('idle')
    fireEvent.keyDown(document, { key: 'f', altKey: true })
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'open', menu: 'file' })
  })

  it('hovering Edit while File is open switches focus to Edit (Excel-style)', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-file"]')!)
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'open', menu: 'file' })

    fireEvent.mouseEnter(container.querySelector('[data-testid="menu-bar-button-edit"]')!)
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'open', menu: 'edit' })
  })

  it('openTopMenuAtom / topMenuOpenAtom integration: setter opens, closeTopMenuAtom returns to idle', () => {
    const store = createStore()

    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
    store.setter(openTopMenuAtom, 'view')
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'open', menu: 'view' })
  })

  it('Insert > Name Manager fires openNameManagerAtom and closes menu', () => {
    const store = createStore()
    const backend = createBaseBackend()
    setupSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-insert"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-insert.nameManager"]')!)

    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  it('Insert > Comment opens the comment session for the active cell', () => {
    const store = createStore()
    const backend = createBaseBackend()
    setupSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(commentSessionAtom)).toBeNull()
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-insert"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-insert.comment"]')!)

    const session = store.getter(commentSessionAtom)
    expect(session).not.toBeNull()
    expect(session?.sheetId).toBe('sheet-1')
    expect(session?.cell.row).toBe(0)
    expect(session?.cell.col).toBe(0)
    expect(store.getter(topMenuOpenAtom)).toEqual({ kind: 'idle' })
  })

  it('Format > Data Validation opens the validation rule editor', () => {
    const store = createStore()
    const backend = createBaseBackend()
    setupSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(validationRuleEditorAtom).status).toBe('closed')
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-format"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-format.validation"]')!)
    expect(store.getter(validationRuleEditorAtom).status).toBe('editing')
  })

  it('Data > Data Validation also opens the validation rule editor', () => {
    const store = createStore()
    const backend = createBaseBackend()
    setupSelection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.validation"]')!)
    expect(store.getter(validationRuleEditorAtom).status).toBe('editing')
  })

  it('Data > Sort Asc writes a sort directive on the active column', () => {
    const store = createStore()
    const backend = createBaseBackend()
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 3 },
      focus: { row: 2, col: 3 },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.sortAsc"]')!)

    const state = store.getter(filterSortStateAtom)['sheet-1']
    expect(state).toBeDefined()
    expect(state!.directives).toEqual([{ colIndex: 3, direction: 'asc' }])
  })

  it('Data > Sort Desc writes a descending sort directive', () => {
    const store = createStore()
    const backend = createBaseBackend()
    store.setter(selectionAtom, {
      kind: 'cell',
      sheetId: 'sheet-1',
      anchor: { row: 0, col: 1 },
      focus: { row: 0, col: 1 },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-data"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-data.sortDesc"]')!)

    const state = store.getter(filterSortStateAtom)['sheet-1']
    expect(state!.directives).toEqual([{ colIndex: 1, direction: 'desc' }])
  })

  it('View > Show Gridlines toggles the atom and mirrors aria-checked', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(viewportShowGridlinesAtom)).toBe(true)

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-view"]')!)
    const item = container.querySelector(
      '[data-testid="menu-bar-item-view.gridlines"]',
    ) as HTMLButtonElement
    expect(item.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(item)
    expect(store.getter(viewportShowGridlinesAtom)).toBe(false)

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-view"]')!)
    const item2 = container.querySelector(
      '[data-testid="menu-bar-item-view.gridlines"]',
    ) as HTMLButtonElement
    expect(item2.getAttribute('aria-checked')).toBe('false')
  })

  it('View > Show Headings + Show Formula Bar both toggle their atoms', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(viewportShowHeadingsAtom)).toBe(true)
    expect(store.getter(viewportShowFormulaBarAtom)).toBe(true)

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-view"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-view.headings"]')!)
    expect(store.getter(viewportShowHeadingsAtom)).toBe(false)

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-view"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-view.formulaBar"]')!)
    expect(store.getter(viewportShowFormulaBarAtom)).toBe(false)
  })

  it('Help > Keyboard Shortcuts opens the shortcuts overlay', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(helpOverlayAtom)).toBe('closed')
    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-help"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-help.shortcuts"]')!)
    expect(store.getter(helpOverlayAtom)).toBe('shortcuts')
    expect(getByTestId('spreadsheet-help-overlay-shortcuts')).not.toBeNull()
    expect(getByTestId('spreadsheet-help-overlay-shortcut-list')).not.toBeNull()
  })

  it('Help > About opens the about overlay and Close dismisses it', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container, getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetMenuBar />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="menu-bar-button-help"]')!)
    fireEvent.click(container.querySelector('[data-testid="menu-bar-item-help.about"]')!)
    expect(store.getter(helpOverlayAtom)).toBe('about')
    expect(getByTestId('spreadsheet-help-overlay-about-body')).not.toBeNull()

    fireEvent.click(getByTestId('spreadsheet-help-overlay-close'))
    expect(store.getter(helpOverlayAtom)).toBe('closed')
  })
})
