/** @jsxImportSource solid-js */

import { describe, it, expect, afterEach } from '@jest/globals'
import { render, cleanup } from '@solidjs/testing-library'
import { Table } from '../src/Table'
import { createSheetStore } from '../src/sheet-store'
import { createJSSheet } from '../src/js-sheet'

afterEach(cleanup)

function createTestStore() {
  return createSheetStore(createJSSheet())
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
})
