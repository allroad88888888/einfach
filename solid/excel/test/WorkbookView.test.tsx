/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import { WorkbookView } from '../src/WorkbookView'
import { createJSWorkbook } from '../src/js-workbook'
import { createWorkbookStore } from '../src/workbook-store'

async function loadExcelJS() {
  return await import('exceljs') as unknown as {
    Workbook: new () => {
      addWorksheet: (name: string, options?: Record<string, unknown>) => any
      xlsx: { writeBuffer: () => Promise<ArrayBuffer | Uint8Array> }
    }
  }
}

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

  it('imports and exports excel files from the toolbar', async () => {
    const ExcelJS = await loadExcelJS()
    const source = new ExcelJS.Workbook()
    const worksheet = source.addWorksheet('Sheet1', {
      views: [{ state: 'frozen', ySplit: 1 }],
    })
    worksheet.getCell('A1').value = 42
    worksheet.getCell('B1').value = { formula: 'A1*2', result: 84 }
    const xlsxBytes = await source.xlsx.writeBuffer()

    const store = createWorkbookStore(createJSWorkbook())
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    let createdBlobUrl = false
    let revokedBlobUrl = false
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: () => {
        createdBlobUrl = true
        return 'blob:excel'
      },
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: () => {
        revokedBlobUrl = true
      },
    })
    const { container, getByRole, getByLabelText } = render(() => (
      <WorkbookView store={store} />
    ))

    const importInput = getByLabelText('Import Excel file') as HTMLInputElement
    const filePayload = xlsxBytes instanceof Uint8Array ? new Uint8Array(xlsxBytes) : xlsxBytes
    const file = new File([filePayload], 'demo.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: async () => filePayload instanceof Uint8Array
        ? filePayload.buffer.slice(filePayload.byteOffset, filePayload.byteOffset + filePayload.byteLength)
        : filePayload,
    })
    fireEvent.change(importInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(container.querySelector('.cell-display')?.textContent).toBe('42')
      expect(store.getInput('B1')).toBe('=A1*2')
    })

    fireEvent.click(getByRole('button', { name: 'Export Excel' }))
    await waitFor(() => {
      expect(createdBlobUrl).toBe(true)
      expect(revokedBlobUrl).toBe(true)
    })

    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: originalCreateObjectURL,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: originalRevokeObjectURL,
    })
  })
})
