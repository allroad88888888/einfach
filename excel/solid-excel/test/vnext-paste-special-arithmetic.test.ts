import { describe, expect, it } from '@jest/globals'
import { createRangeProjectionRequest } from '@einfach/spreadsheet-ui-core'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter'

/**
 * Wave 7.3 paste-special review MEDIUM #4: arithmetic-coercion contract
 * for `backend.pasteRange` when `op != 'none'`. The static backend is
 * the reference implementation; worker backends are expected to match
 * the table documented in
 * `excel/spreadsheet-ui-core/src/paste-special/README.md`.
 */

async function readCell(
  backend: ReturnType<typeof createStaticSpreadsheetBackend>,
  row: number,
  col: number,
): Promise<{ displayValue: string; valueKind?: string }> {
  const range = { rowStart: row, rowEnd: row, colStart: col, colEnd: col }
  const result = await backend.readRangeProjection(
    createRangeProjectionRequest({
      sheetId: 'sheet-1',
      requestId: 1,
      reason: 'test',
      range,
    }),
  )
  const cell = result.cells.find((c) => c.row === row && c.col === col)
  return {
    displayValue: cell?.displayValue ?? '',
    valueKind: cell?.valueKind,
  }
}

describe('paste-special arithmetic coercion (static-backend reference)', () => {
  it('number source + number target: add writes sum', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      // source at (0,0) = 5; target at (1,0) = 10
      cells: [
        { row: 0, col: 0, displayValue: '5', valueKind: 'number' },
        { row: 1, col: 0, displayValue: '10', valueKind: 'number' },
      ],
    })

    await backend.pasteRange!({
      kind: 'paste-range',
      sheetId: 'sheet-1',
      target: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      },
      pasteKind: 'values',
      op: 'add',
      transpose: false,
      skipBlanks: false,
    })

    expect((await readCell(backend, 1, 0)).displayValue).toBe('15')
  })

  it('number source + text target: text target is treated as 0', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [
        { row: 0, col: 0, displayValue: '7', valueKind: 'number' },
        { row: 1, col: 0, displayValue: 'hello', valueKind: 'string' },
      ],
    })

    await backend.pasteRange!({
      kind: 'paste-range',
      sheetId: 'sheet-1',
      target: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      },
      pasteKind: 'values',
      op: 'add',
      transpose: false,
      skipBlanks: false,
    })

    expect((await readCell(backend, 1, 0)).displayValue).toBe('7')
  })

  it('text source + number target: skip — target preserved verbatim', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [
        { row: 0, col: 0, displayValue: 'banana', valueKind: 'string' },
        { row: 1, col: 0, displayValue: '42', valueKind: 'number' },
      ],
    })

    await backend.pasteRange!({
      kind: 'paste-range',
      sheetId: 'sheet-1',
      target: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      },
      pasteKind: 'values',
      op: 'multiply',
      transpose: false,
      skipBlanks: false,
    })

    // Target value must be unchanged. The pre-fix behaviour overwrote
    // the target with the literal 'banana'.
    expect((await readCell(backend, 1, 0)).displayValue).toBe('42')
  })

  it('text source + text target: skip — target preserved verbatim', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [
        { row: 0, col: 0, displayValue: 'apple', valueKind: 'string' },
        { row: 1, col: 0, displayValue: 'orange', valueKind: 'string' },
      ],
    })

    await backend.pasteRange!({
      kind: 'paste-range',
      sheetId: 'sheet-1',
      target: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      },
      pasteKind: 'values',
      op: 'add',
      transpose: false,
      skipBlanks: false,
    })

    expect((await readCell(backend, 1, 0)).displayValue).toBe('orange')
  })

  it('divide-by-zero: emits #DIV/0! literal', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [
        { row: 0, col: 0, displayValue: '0', valueKind: 'number' },
        { row: 1, col: 0, displayValue: '100', valueKind: 'number' },
      ],
    })

    await backend.pasteRange!({
      kind: 'paste-range',
      sheetId: 'sheet-1',
      target: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      },
      pasteKind: 'values',
      op: 'divide',
      transpose: false,
      skipBlanks: false,
    })

    expect((await readCell(backend, 1, 0)).displayValue).toBe('#DIV/0!')
  })

  it('error source: skip — target preserved verbatim (no coercion)', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [
        { row: 0, col: 0, displayValue: '#REF!', valueKind: 'error' },
        { row: 1, col: 0, displayValue: '50', valueKind: 'number' },
      ],
    })

    await backend.pasteRange!({
      kind: 'paste-range',
      sheetId: 'sheet-1',
      target: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      },
      pasteKind: 'values',
      op: 'add',
      transpose: false,
      skipBlanks: false,
    })

    expect((await readCell(backend, 1, 0)).displayValue).toBe('50')
  })

  it('error target: skip — target preserved verbatim (error pass-through)', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [
        { row: 0, col: 0, displayValue: '3', valueKind: 'number' },
        { row: 1, col: 0, displayValue: '#VALUE!', valueKind: 'error' },
      ],
    })

    await backend.pasteRange!({
      kind: 'paste-range',
      sheetId: 'sheet-1',
      target: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      },
      pasteKind: 'values',
      op: 'multiply',
      transpose: false,
      skipBlanks: false,
    })

    expect((await readCell(backend, 1, 0)).displayValue).toBe('#VALUE!')
  })

  it('op = none + text source: writes source verbatim (no coercion path)', async () => {
    // Sanity check: the skip-on-text-source rule is scoped to arithmetic
    // ops; plain "paste values" still overwrites the target.
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [
        { row: 0, col: 0, displayValue: 'kiwi', valueKind: 'string' },
        { row: 1, col: 0, displayValue: 'pear', valueKind: 'string' },
      ],
    })

    await backend.pasteRange!({
      kind: 'paste-range',
      sheetId: 'sheet-1',
      target: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      },
      pasteKind: 'values',
      op: 'none',
      transpose: false,
      skipBlanks: false,
    })

    expect((await readCell(backend, 1, 0)).displayValue).toBe('kiwi')
  })

  it('number target + blank source slot: blank slot still coerces target to 0+source path is skipped (source = null)', async () => {
    // A blank source cell carries no numeric input, so even number
    // target + blank source = skip (rather than zeroing the target).
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [
        // (0,0) is intentionally blank.
        { row: 1, col: 0, displayValue: '99', valueKind: 'number' },
      ],
    })

    await backend.pasteRange!({
      kind: 'paste-range',
      sheetId: 'sheet-1',
      target: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      source: {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      },
      pasteKind: 'values',
      op: 'add',
      transpose: false,
      skipBlanks: false,
    })

    expect((await readCell(backend, 1, 0)).displayValue).toBe('99')
  })
})
