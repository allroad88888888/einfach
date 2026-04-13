/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import { WorkbookView } from '../src/WorkbookView'
import { createJSWorkbook } from '../src/js-workbook'
import { createWorkbookStore } from '../src/workbook-store'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('WorkbookView', () => {
  it('restores autosaved workbooks and applies toolbar formatting to the current selection', async () => {
    const seed = createJSWorkbook()
    seed.set_number('A1', 1234.5)
    seed.set_format(['A1'], {
      numberFormat: {
        kind: 'currency',
        decimals: 2,
        useGrouping: true,
        currencySymbol: '¥',
      },
    })
    window.localStorage.setItem('excel-phase6-test', seed.export_json())

    const store = createWorkbookStore(createJSWorkbook())
    const { container, getByRole, getByLabelText } = render(() => (
      <WorkbookView persistenceKey="excel-phase6-test" store={store} />
    ))

    await waitFor(() => {
      expect(container.querySelector('.cell-display')?.textContent).toBe('¥1,234.50')
    })

    const firstCell = container.querySelector('td.cell') as HTMLTableCellElement
    fireEvent.click(firstCell)
    fireEvent.click(getByRole('button', { name: 'Bold' }))
    fireEvent.change(getByLabelText('Number format'), { target: { value: 'percent' } })
    fireEvent.input(getByLabelText('Decimal places'), { target: { value: '1' } })

    await waitFor(() => {
      expect(firstCell.getAttribute('style') ?? '').toContain('font-weight: 700')
      expect(container.querySelector('.cell-display')?.textContent).toBe('123,450.0%')
      expect(window.localStorage.getItem('excel-phase6-test')).toContain('"bold": true')
    })
  })
})
