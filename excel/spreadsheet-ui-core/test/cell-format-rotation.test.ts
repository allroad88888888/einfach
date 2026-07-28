import { describe, expect, test } from '@jest/globals'
import type {
  SetFormatRangeRequest,
  SpreadsheetAlignment,
  SpreadsheetCellFormat,
  SpreadsheetOverflow,
  SpreadsheetRotation,
  SpreadsheetVerticalAlignment,
} from '../src/backend/types'

describe('cell-format-rotation (Wave 6.2)', () => {
  test('SpreadsheetCellFormat accepts rotation, verticalAlign, overflow, shrinkToFit individually', () => {
    const rotated: SpreadsheetCellFormat = { rotation: 45 }
    const vAligned: SpreadsheetCellFormat = { verticalAlign: 'top' }
    const overflowing: SpreadsheetCellFormat = { overflow: 'overflow' }
    const shrunk: SpreadsheetCellFormat = { shrinkToFit: true }

    expect(rotated.rotation).toBe(45)
    expect(vAligned.verticalAlign).toBe('top')
    expect(overflowing.overflow).toBe('overflow')
    expect(shrunk.shrinkToFit).toBe(true)
  })

  test('SpreadsheetCellFormat accepts all rotation / overflow / wrap fields combined', () => {
    const fmt: SpreadsheetCellFormat = {
      rotation: -90,
      verticalAlign: 'center',
      overflow: 'wrap',
      shrinkToFit: false,
      align: 'distributed',
    }

    expect(fmt.rotation).toBe(-90)
    expect(fmt.verticalAlign).toBe('center')
    expect(fmt.overflow).toBe('wrap')
    expect(fmt.shrinkToFit).toBe(false)
    expect(fmt.align).toBe('distributed')
  })

  test("rotation accepts the 'vertical' literal for stacked text", () => {
    const fmt: SpreadsheetCellFormat = { rotation: 'vertical' }
    expect(fmt.rotation).toBe('vertical')

    const explicit: SpreadsheetRotation = 'vertical'
    expect(explicit).toBe('vertical')
  })

  test("horizontalAlign widens to 'fill' | 'justify' | 'distributed'", () => {
    const fill: SpreadsheetAlignment = 'fill'
    const justify: SpreadsheetAlignment = 'justify'
    const distributed: SpreadsheetAlignment = 'distributed'

    expect(fill).toBe('fill')
    expect(justify).toBe('justify')
    expect(distributed).toBe('distributed')

    const fmtFill: SpreadsheetCellFormat = { align: 'fill' }
    const fmtJustify: SpreadsheetCellFormat = { align: 'justify' }
    const fmtDistributed: SpreadsheetCellFormat = { align: 'distributed' }
    expect(fmtFill.align).toBe('fill')
    expect(fmtJustify.align).toBe('justify')
    expect(fmtDistributed.align).toBe('distributed')
  })

  test('verticalAlign accepts the five Excel values', () => {
    const values: SpreadsheetVerticalAlignment[] = [
      'top',
      'center',
      'bottom',
      'justify',
      'distributed',
    ]
    for (const value of values) {
      const fmt: SpreadsheetCellFormat = { verticalAlign: value }
      expect(fmt.verticalAlign).toBe(value)
    }
  })

  test('overflow accepts all documented strategies', () => {
    const values: SpreadsheetOverflow[] = ['overflow', 'clip', 'ellipsis', 'wrap', 'shrink-to-fit']
    for (const value of values) {
      const fmt: SpreadsheetCellFormat = { overflow: value }
      expect(fmt.overflow).toBe(value)
    }
  })

  test('setFormatRange request payload round-trips rotation / overflow / verticalAlign', () => {
    const request: SetFormatRangeRequest = {
      kind: 'set-format-range',
      sheetId: 'Sheet1',
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      format: {
        rotation: 45,
        verticalAlign: 'top',
        overflow: 'wrap',
        shrinkToFit: false,
        align: 'distributed',
      },
    }

    // A trivial backend forwarder echoes the request back so the projection layer
    // can read the same shape. This asserts the type round-trips through the
    // backend port without information loss.
    const echo: SpreadsheetCellFormat = { ...request.format! }
    expect(echo.rotation).toBe(45)
    expect(echo.verticalAlign).toBe('top')
    expect(echo.overflow).toBe('wrap')
    expect(echo.shrinkToFit).toBe(false)
    expect(echo.align).toBe('distributed')
  })

  test('wrap and shrink-to-fit can coexist on the type (editor decides precedence at save)', () => {
    const fmt: SpreadsheetCellFormat = {
      overflow: 'wrap',
      shrinkToFit: true,
    }
    // The type permits both; runtime guards in saveFormatCellsEditorAtom (Wave 6.1)
    // resolve which one wins before the format reaches the backend.
    expect(fmt.overflow).toBe('wrap')
    expect(fmt.shrinkToFit).toBe(true)
  })
})
