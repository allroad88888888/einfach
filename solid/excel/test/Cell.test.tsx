/** @jsxImportSource solid-js */

import { describe, it, expect, afterEach, jest } from '@jest/globals'
import { render, cleanup, fireEvent } from '@solidjs/testing-library'
import { Cell } from '../src/Cell'
import { createSheetStore } from '../src/sheet-store'
import { createJSSheet } from '../src/js-sheet'

afterEach(cleanup)

function createTestStore() {
  return createSheetStore(createJSSheet())
}

describe('Cell', () => {
  it('renders empty cell', () => {
    const store = createTestStore()
    const { container } = render(() => <Cell addr="A1" store={store} />)
    const td = container.querySelector('td.cell')
    expect(td).not.toBeNull()
    const display = container.querySelector('.cell-display')
    expect(display).not.toBeNull()
    expect(display!.textContent).toBe('')
  })

  it('renders cell with number value', () => {
    const store = createTestStore()
    store.setNumber('A1', 42)
    const { container } = render(() => <Cell addr="A1" store={store} />)
    const display = container.querySelector('.cell-display')
    expect(display!.textContent).toBe('42')
  })

  it('renders cell with text value', () => {
    const store = createTestStore()
    store.setText('A1', 'hello')
    const { container } = render(() => <Cell addr="A1" store={store} />)
    expect(container.querySelector('.cell-display')!.textContent).toBe('hello')
  })

  it('renders cell with formula result', () => {
    const store = createTestStore()
    store.setNumber('A1', 10)
    store.setNumber('B1', 20)
    store.setFormula('C1', '=A1+B1')
    const { container } = render(() => <Cell addr="C1" store={store} />)
    expect(container.querySelector('.cell-display')!.textContent).toBe('30')
  })

  it('applies error class for error cells', () => {
    const store = createTestStore()
    store.setNumber('A1', 10)
    store.setNumber('B1', 0)
    store.setFormula('C1', '=A1/B1')
    const { container } = render(() => <Cell addr="C1" store={store} />)
    const td = container.querySelector('td.cell')
    expect(td!.classList.contains('cell-error')).toBe(true)
  })

  it('applies type class', () => {
    const store = createTestStore()
    store.setNumber('A1', 5)
    const { container } = render(() => <Cell addr="A1" store={store} />)
    const td = container.querySelector('td.cell')
    expect(td!.classList.contains('cell-number')).toBe(true)
  })

  it('enters edit mode on double-click', () => {
    const store = createTestStore()
    store.setNumber('A1', 42)
    const { container } = render(() => <Cell addr="A1" store={store} />)
    const td = container.querySelector('td.cell')!

    // Before double-click: display mode
    expect(container.querySelector('.cell-display')).not.toBeNull()
    expect(container.querySelector('.cell-input')).toBeNull()

    // Double-click
    fireEvent.dblClick(td)

    // After double-click: edit mode
    expect(container.querySelector('.cell-input')).not.toBeNull()
    const input = container.querySelector('.cell-input') as HTMLInputElement
    expect(input.value).toBe('42')
  })

  it('commits edit on Enter', () => {
    const store = createTestStore()
    store.setNumber('A1', 10)
    const { container } = render(() => <Cell addr="A1" store={store} />)
    const td = container.querySelector('td.cell')!

    fireEvent.dblClick(td)
    const input = container.querySelector('.cell-input') as HTMLInputElement

    // Type new value
    fireEvent.input(input, { target: { value: '99' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // Should exit edit mode
    expect(container.querySelector('.cell-input')).toBeNull()
    expect(container.querySelector('.cell-display')!.textContent).toBe('99')
  })

  it('cancels edit on Escape', () => {
    const store = createTestStore()
    store.setNumber('A1', 10)
    const { container } = render(() => <Cell addr="A1" store={store} />)
    const td = container.querySelector('td.cell')!

    fireEvent.dblClick(td)
    const input = container.querySelector('.cell-input') as HTMLInputElement

    fireEvent.input(input, { target: { value: '999' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    // Should revert to original
    expect(container.querySelector('.cell-input')).toBeNull()
    expect(container.querySelector('.cell-display')!.textContent).toBe('10')
  })

  it('commits edit on blur', () => {
    const store = createTestStore()
    store.setNumber('A1', 10)
    const { container } = render(() => <Cell addr="A1" store={store} />)
    const td = container.querySelector('td.cell')!

    fireEvent.dblClick(td)
    const input = container.querySelector('.cell-input') as HTMLInputElement

    fireEvent.input(input, { target: { value: '55' } })
    fireEvent.blur(input)

    expect(container.querySelector('.cell-input')).toBeNull()
    expect(container.querySelector('.cell-display')!.textContent).toBe('55')
  })

  it('can input a formula', () => {
    const store = createTestStore()
    store.setNumber('A1', 10)
    const { container } = render(() => <Cell addr="B1" store={store} />)
    const td = container.querySelector('td.cell')!

    fireEvent.dblClick(td)
    const input = container.querySelector('.cell-input') as HTMLInputElement

    fireEvent.input(input, { target: { value: '=A1*3' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(container.querySelector('.cell-display')!.textContent).toBe('30')
  })

  it('reopens formula cells with the original formula input', () => {
    const store = createTestStore()
    store.setNumber('A1', 10)
    store.setFormula('B1', '=A1*3')
    const { container } = render(() => <Cell addr="B1" store={store} />)
    const td = container.querySelector('td.cell')!

    expect(container.querySelector('.cell-display')!.textContent).toBe('30')

    fireEvent.dblClick(td)

    const input = container.querySelector('.cell-input') as HTMLInputElement
    expect(input.value).toBe('=A1*3')
  })

  it('shows a controlled error for invalid formulas', () => {
    const store = createTestStore()
    const { container } = render(() => <Cell addr="A1" store={store} />)
    const td = container.querySelector('td.cell')!

    fireEvent.dblClick(td)
    const input = container.querySelector('.cell-input') as HTMLInputElement
    fireEvent.input(input, { target: { value: '=SUM(' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(container.querySelector('.cell-display')!.textContent).toBe('#VALUE!')
    expect(td.classList.contains('cell-error')).toBe(true)
  })

  it('can input text', () => {
    const store = createTestStore()
    const { container } = render(() => <Cell addr="A1" store={store} />)
    const td = container.querySelector('td.cell')!

    fireEvent.dblClick(td)
    const input = container.querySelector('.cell-input') as HTMLInputElement

    fireEvent.input(input, { target: { value: 'hello world' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(container.querySelector('.cell-display')!.textContent).toBe('hello world')
  })

  it('calls onSelect with shift state in controlled mode', () => {
    const store = createTestStore()
    const onSelect = jest.fn()
    const { container } = render(() => <Cell addr="A1" onSelect={onSelect} store={store} />)
    const td = container.querySelector('td.cell')!

    fireEvent.click(td)
    fireEvent.click(td, { shiftKey: true })

    expect(onSelect).toHaveBeenNthCalledWith(1, false)
    expect(onSelect).toHaveBeenNthCalledWith(2, true)
  })

  it('double-click enters controlled editing and announces selection first', () => {
    const store = createTestStore()
    store.setFormula('A1', '=1+1')
    const onSelect = jest.fn()
    const onEditingChange = jest.fn()
    const { container } = render(() => (
      <Cell
        activeEditing={false}
        addr="A1"
        onEditingChange={onEditingChange}
        onSelect={onSelect}
        store={store}
      />
    ))
    const td = container.querySelector('td.cell')!

    fireEvent.dblClick(td)

    expect(onSelect).toHaveBeenCalledWith(false)
    expect(onEditingChange).toHaveBeenCalledWith(true)
  })

  it('commits edits through controlled callbacks', () => {
    const store = createTestStore()
    const onCommitEdit = jest.fn()
    const onEditingChange = jest.fn()
    const { container } = render(() => (
      <Cell
        activeEditing
        addr="A1"
        onCommitEdit={onCommitEdit}
        onEditingChange={onEditingChange}
        store={store}
      />
    ))
    const input = container.querySelector('.cell-input') as HTMLInputElement

    fireEvent.input(input, { target: { value: '99' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onCommitEdit).toHaveBeenCalledWith('99')
    expect(onEditingChange).toHaveBeenCalledWith(false)
  })

  it('cancels edits through controlled callbacks', () => {
    const store = createTestStore()
    const onCancelEdit = jest.fn()
    const onEditingChange = jest.fn()
    const { container } = render(() => (
      <Cell
        activeEditing
        addr="A1"
        onCancelEdit={onCancelEdit}
        onEditingChange={onEditingChange}
        store={store}
      />
    ))
    const input = container.querySelector('.cell-input') as HTMLInputElement

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onCancelEdit).toHaveBeenCalled()
    expect(onEditingChange).toHaveBeenCalledWith(false)
  })
})
