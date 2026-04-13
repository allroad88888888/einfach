/** @jsxImportSource solid-js */

import { describe, it, expect, afterEach } from '@jest/globals'
import { render, cleanup, fireEvent, waitFor } from '@solidjs/testing-library'
import { Table } from '../src/Table'
import { createSheetStore } from '../src/sheet-store'
import { createJSSheet } from '../src/js-sheet'
import { createJSWorkbook } from '../src/js-workbook'
import { createWorkbookStore } from '../src/workbook-store'

afterEach(cleanup)

const clipboardState = {
  text: '',
}

Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: {
    async readText() {
      return clipboardState.text
    },
    async writeText(value: string) {
      clipboardState.text = value
    },
  },
})

function createTestStore() {
  return createSheetStore(createJSSheet())
}

function createWorkbookTestStore() {
  return createWorkbookStore(createJSWorkbook({ sheets: [{ name: 'Sheet1', rows: 6, cols: 6 }] }))
}

describe('Table', () => {
  it('renders column headers A-J for 10 cols', () => {
    const store = createTestStore()
    const { container } = render(() => <Table store={store} rows={3} cols={10} />)
    const headers = container.querySelectorAll('th.col-header')
    expect(headers.length).toBe(10)
    expect(headers[0].textContent).toBe('A')
    expect(headers[1].textContent).toBe('B')
    expect(headers[9].textContent).toBe('J')
  })

  it('renders row numbers 1-3 for 3 rows', () => {
    const store = createTestStore()
    const { container } = render(() => <Table store={store} rows={3} cols={2} />)
    const rowHeaders = container.querySelectorAll('tbody td.row-header')
    expect(rowHeaders.length).toBe(3)
    expect(rowHeaders[0].textContent).toBe('1')
    expect(rowHeaders[1].textContent).toBe('2')
    expect(rowHeaders[2].textContent).toBe('3')
  })

  it('renders correct number of cells', () => {
    const store = createTestStore()
    const { container } = render(() => <Table store={store} rows={4} cols={3} />)
    const cells = container.querySelectorAll('td.cell')
    expect(cells.length).toBe(12) // 4 rows × 3 cols
  })

  it('defaults to 20 rows and 10 cols', () => {
    const store = createTestStore()
    const { container } = render(() => <Table store={store} />)
    const cells = container.querySelectorAll('td.cell')
    expect(cells.length).toBe(200) // 20 × 10
  })

  it('displays cell values', () => {
    const store = createTestStore()
    store.setNumber('A1', 42)
    store.setText('B1', 'hello')

    const { container } = render(() => <Table store={store} rows={2} cols={3} />)
    const displays = container.querySelectorAll('.cell-display')

    // A1 should show 42
    expect(displays[0].textContent).toBe('42')
    // B1 should show hello
    expect(displays[1].textContent).toBe('hello')
  })

  it('displays formula results', () => {
    const store = createTestStore()
    store.setNumber('A1', 10)
    store.setNumber('B1', 20)
    store.setFormula('C1', '=A1+B1')

    const { container } = render(() => <Table store={store} rows={1} cols={3} />)
    const displays = container.querySelectorAll('.cell-display')

    expect(displays[2].textContent).toBe('30')
  })

  it('has a wrapper div with class', () => {
    const store = createTestStore()
    const { container } = render(() => <Table store={store} rows={1} cols={1} />)
    expect(container.querySelector('.excel-table-wrapper')).not.toBeNull()
  })

  it('renders table element with class', () => {
    const store = createTestStore()
    const { container } = render(() => <Table store={store} rows={1} cols={1} />)
    expect(container.querySelector('table.excel-table')).not.toBeNull()
  })

  it('renders with custom small size', () => {
    const store = createTestStore()
    const { container } = render(() => <Table store={store} rows={2} cols={2} />)
    const colHeaders = container.querySelectorAll('th.col-header')
    const rowHeaders = container.querySelectorAll('tbody td.row-header')
    expect(colHeaders.length).toBe(2)
    expect(rowHeaders.length).toBe(2)
    expect(colHeaders[0].textContent).toBe('A')
    expect(colHeaders[1].textContent).toBe('B')
  })

  it('selects a cell on click and extends selection with shift-click', () => {
    const store = createTestStore()
    const { container } = render(() => <Table store={store} rows={3} cols={3} />)
    const cells = container.querySelectorAll('td.cell')

    fireEvent.click(cells[0])
    expect(cells[0].classList.contains('cell-selected')).toBe(true)

    fireEvent.click(cells[4], { shiftKey: true })
    expect(cells[0].classList.contains('cell-in-selection')).toBe(true)
    expect(cells[4].classList.contains('cell-in-selection')).toBe(true)
  })

  it('moves the active cell with arrow keys and expands with shift+arrow', () => {
    const store = createTestStore()
    const { container } = render(() => <Table store={store} rows={3} cols={3} />)
    const wrapper = container.querySelector('.excel-table-wrapper') as HTMLDivElement
    const cells = container.querySelectorAll('td.cell')

    expect(cells[0].classList.contains('cell-selected')).toBe(true)

    fireEvent.keyDown(wrapper, { key: 'ArrowRight' })
    expect(cells[1].classList.contains('cell-selected')).toBe(true)

    fireEvent.keyDown(wrapper, { key: 'ArrowDown', shiftKey: true })
    expect(cells[1].classList.contains('cell-in-selection')).toBe(true)
    expect(cells[4].classList.contains('cell-in-selection')).toBe(true)
  })

  it('clears the selected cell with Delete', () => {
    const store = createTestStore()
    store.setNumber('A1', 42)
    const { container } = render(() => <Table store={store} rows={2} cols={2} />)
    const wrapper = container.querySelector('.excel-table-wrapper') as HTMLDivElement
    const cells = container.querySelectorAll('td.cell')

    fireEvent.click(cells[0])
    fireEvent.keyDown(wrapper, { key: 'Delete' })

    expect(store.getCell('A1').type).toBe('null')
  })

  it('copies and pastes a range using keyboard shortcuts', async () => {
    const store = createTestStore()
    store.setNumber('A1', 10)
    store.setFormula('B1', '=A1*2')
    const { container } = render(() => <Table store={store} rows={3} cols={4} />)
    const wrapper = container.querySelector('.excel-table-wrapper') as HTMLDivElement
    const cells = container.querySelectorAll('td.cell')

    fireEvent.click(cells[0])
    fireEvent.click(cells[1], { shiftKey: true })
    fireEvent.keyDown(wrapper, { key: 'c', ctrlKey: true })

    fireEvent.click(cells[6])
    fireEvent.keyDown(wrapper, { key: 'v', ctrlKey: true })

    await waitFor(() => {
      expect(store.getCell('C2').display).toBe('10')
      expect(store.getInput('D2')).toBe('=C2*2')
      expect(store.getCell('D2').display).toBe('20')
    })
  })

  it('cuts a range and undo/redo restores it', async () => {
    const store = createTestStore()
    store.setText('A1', 'alpha')
    store.setText('B1', 'beta')
    const { container } = render(() => <Table store={store} rows={2} cols={3} />)
    const wrapper = container.querySelector('.excel-table-wrapper') as HTMLDivElement
    const cells = container.querySelectorAll('td.cell')

    fireEvent.click(cells[0])
    fireEvent.click(cells[1], { shiftKey: true })
    fireEvent.keyDown(wrapper, { key: 'x', ctrlKey: true })

    await waitFor(() => {
      expect(store.getCell('A1').type).toBe('null')
      expect(store.getCell('B1').type).toBe('null')
    })

    fireEvent.keyDown(wrapper, { key: 'z', ctrlKey: true })
    expect(store.getCell('A1').display).toBe('alpha')
    expect(store.getCell('B1').display).toBe('beta')

    fireEvent.keyDown(wrapper, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(store.getCell('A1').type).toBe('null')
    expect(store.getCell('B1').type).toBe('null')

    fireEvent.keyDown(wrapper, { key: 'z', ctrlKey: true })
    expect(store.getCell('A1').display).toBe('alpha')
    expect(store.getCell('B1').display).toBe('beta')

    fireEvent.keyDown(wrapper, { key: 'y', ctrlKey: true })
    expect(store.getCell('A1').type).toBe('null')
    expect(store.getCell('B1').type).toBe('null')
  })

  it('pastes external TSV when no internal clipboard is present', async () => {
    clipboardState.text = '1\t2\n3\t4'
    const store = createTestStore()
    const { container } = render(() => <Table store={store} rows={3} cols={3} />)
    const wrapper = container.querySelector('.excel-table-wrapper') as HTMLDivElement
    const cells = container.querySelectorAll('td.cell')

    fireEvent.click(cells[4])
    fireEvent.keyDown(wrapper, { key: 'v', ctrlKey: true })

    await waitFor(() => {
      expect(store.getCell('B2').display).toBe('1')
      expect(store.getCell('C2').display).toBe('2')
      expect(store.getCell('B3').display).toBe('3')
      expect(store.getCell('C3').display).toBe('4')
    })
  })

  it('opens row and column context menus for workbook-backed tables', () => {
    const store = createWorkbookTestStore()
    const { container, getByText } = render(() => <Table store={store} />)

    const rowHeaders = container.querySelectorAll('tbody td.row-header')
    const colHeaders = container.querySelectorAll('th.col-header')

    fireEvent.contextMenu(rowHeaders[0])
    expect(getByText('Insert Row Above')).toBeInTheDocument()
    expect(getByText('Freeze Top Row')).toBeInTheDocument()

    fireEvent.contextMenu(colHeaders[0])
    expect(getByText('Insert Column Left')).toBeInTheDocument()
    expect(getByText('Freeze First Column')).toBeInTheDocument()
  })

  it('resizes and freezes workbook-backed tables through header affordances', async () => {
    const store = createWorkbookTestStore()
    const { container, getByLabelText, getByText } = render(() => <Table store={store} />)

    fireEvent.contextMenu(container.querySelectorAll('tbody td.row-header')[0])
    fireEvent.click(getByText('Freeze Top Row'))
    expect(store.freezeTopRow()).toBe(true)

    const handle = getByLabelText('Resize column A')
    fireEvent.mouseDown(handle, { clientX: 0 })
    fireEvent.mouseMove(window, { clientX: 44 })
    fireEvent.mouseUp(window)

    await waitFor(() => {
      expect(store.colWidth(0)).toBeGreaterThan(120)
    })
  })
})
