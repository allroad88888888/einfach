import { describe, expect, it, jest } from '@jest/globals'
import { mergeImportStatsIssues, normalizeImportCells } from '../src/wasm-workbook-worker'
import type { ImportCellWire } from '../src/wasm-workbook-proxy'

jest.mock('../wasm-pkg/einfach_wasm.js', () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
  WasmWorkbook: jest.fn(),
}))

describe('wasm-workbook-worker import normalization', () => {
  it('filters invalid import cells into issues', () => {
    const chunk = normalizeImportCells([
      { sheet: 0, row: 0, col: 0, kind: 'number', value: 1 },
      { sheet: 0, row: -1, col: 0, kind: 'text', value: 'bad row' },
      { sheet: 0, row: 1, col: 0, kind: 'number', value: Number.NaN },
      { sheet: 0, row: 2, col: 0, kind: 'unknown', value: 'bad kind' } as unknown as ImportCellWire,
      { sheet: 0, row: 3, col: 0, kind: 'null' },
    ])

    expect(chunk.cells).toEqual([
      { sheet: 0, row: 0, col: 0, kind: 'number', value: 1 },
      { sheet: 0, row: 3, col: 0, kind: 'null' },
    ])
    expect(chunk.issues).toEqual([
      {
        sheet: 0,
        row: -1,
        col: 0,
        kind: 'text',
        code: 'INVALID_IMPORT_CELL_COORDINATES',
        message: 'invalid import cell coordinates',
      },
      {
        sheet: 0,
        row: 1,
        col: 0,
        kind: 'number',
        code: 'INVALID_IMPORT_CELL_VALUE',
        message: 'invalid import cell value',
      },
      {
        sheet: 0,
        row: 2,
        col: 0,
        kind: 'unknown',
        code: 'INVALID_IMPORT_CELL_KIND',
        message: 'invalid import cell kind',
      },
    ])
  })

  it('merges chunk normalization issues into commit import stats', () => {
    expect(
      mergeImportStatsIssues(
        {
          accepted: 1,
          formulas: 0,
          rejectedFormulas: 0,
          cleared: 0,
          errors: 0,
          issues: [{ code: 'RUST_IMPORT_WARNING', message: 'warning from wasm' }],
        },
        [
          {
            sheet: 0,
            row: -1,
            col: 0,
            kind: 'number',
            code: 'INVALID_IMPORT_CELL_COORDINATES',
            message: 'invalid import cell coordinates',
          },
        ],
      ),
    ).toEqual({
      accepted: 1,
      formulas: 0,
      rejectedFormulas: 0,
      cleared: 0,
      errors: 1,
      issues: [
        { code: 'RUST_IMPORT_WARNING', message: 'warning from wasm' },
        {
          sheet: 0,
          row: -1,
          col: 0,
          kind: 'number',
          code: 'INVALID_IMPORT_CELL_COORDINATES',
          message: 'invalid import cell coordinates',
        },
      ],
    })
  })
})
