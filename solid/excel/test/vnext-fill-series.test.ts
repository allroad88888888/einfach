import { describe, expect, it } from '@jest/globals'
import {
  createRangeProjectionRequest,
  detectFillSeries,
  type CellRange,
  type FillSeriesRequest,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter'

const SHEET_ID = 'sheet-1'
let nextRequestId = 100

async function readRange(backend: SpreadsheetBackend, range: CellRange) {
  return backend.readRangeProjection(
    createRangeProjectionRequest({
      sheetId: SHEET_ID,
      requestId: nextRequestId++,
      reason: 'test',
      range,
    }),
  )
}

function numericCell(row: number, col: number, value: number, extra = {}) {
  return {
    row,
    col,
    displayValue: String(value),
    valueKind: 'number' as const,
    numericValue: value,
    ...extra,
  }
}

function request(
  input: Omit<FillSeriesRequest, 'kind' | 'sheetId' | 'requestId'>,
): FillSeriesRequest {
  return {
    kind: 'fill-series',
    sheetId: SHEET_ID,
    requestId: nextRequestId++,
    ...input,
  }
}

describe('static backend numeric fill series', () => {
  it.each([
    {
      direction: 'down' as const,
      cells: [numericCell(0, 0, 1), numericCell(1, 0, 3)],
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 0 },
      writeRange: { rowStart: 2, rowEnd: 4, colStart: 0, colEnd: 0 },
      expected: ['1', '3', '5', '7', '9'],
    },
    {
      direction: 'up' as const,
      cells: [numericCell(2, 0, 5), numericCell(3, 0, 7)],
      sourceRange: { rowStart: 2, rowEnd: 3, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
      writeRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      expected: ['1', '3', '5', '7'],
    },
    {
      direction: 'right' as const,
      cells: [numericCell(0, 0, 1), numericCell(0, 1, 3)],
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      targetRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 4 },
      writeRange: { rowStart: 0, rowEnd: 0, colStart: 2, colEnd: 4 },
      expected: ['1', '3', '5', '7', '9'],
    },
    {
      direction: 'left' as const,
      cells: [numericCell(0, 2, 5), numericCell(0, 3, 7)],
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 2, colEnd: 3 },
      targetRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 3 },
      writeRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
      expected: ['1', '3', '5', '7'],
    },
  ])(
    'generates an ordered $direction series and acknowledges only its write range',
    async ({ direction, cells, sourceRange, targetRange, writeRange, expected }) => {
      const backend = createStaticSpreadsheetBackend({ revision: 1, cells })
      const mutationRequest = request({
        sourceRange,
        targetRange,
        direction,
        series: 'integer-step',
        step: 2,
        revision: 1,
      })

      await expect(backend.fillSeries!(mutationRequest)).resolves.toEqual({
        sheetId: SHEET_ID,
        requestId: mutationRequest.requestId,
        revision: 2,
        affectedRange: writeRange,
      })

      const projection = await readRange(backend, targetRange)
      expect(projection.cells.map((cell) => cell.displayValue)).toEqual(expected)
    },
  )

  it('preserves the raw finite canonical result of decimal arithmetic', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 3,
      cells: [numericCell(0, 0, 0.1), numericCell(1, 0, 0.2)],
    })
    await backend.fillSeries!(
      request({
        sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: 'decimal-step',
        step: 0.1,
        revision: 3,
      }),
    )

    const projection = await readRange(backend, {
      rowStart: 0,
      rowEnd: 3,
      colStart: 0,
      colEnd: 0,
    })
    const expected = [0.1, 0.2, 0.2 + 0.1, 0.2 + 0.1 * 2]
    expect(projection.cells.map((cell) => cell.numericValue)).toEqual(expected)
    expect(projection.cells.map((cell) => cell.displayValue)).toEqual(expected.map(String))
  })

  it.each([
    {
      label: 'a sub-epsilon delta near one',
      first: 1,
      second: 1 + 1e-15,
      expectedNext: (1 + 1e-15) + ((1 + 1e-15) - 1),
    },
    {
      label: 'a unit delta near 10^15',
      first: 999_999_999_999_999,
      second: 1_000_000_000_000_000,
      expectedNext: 1_000_000_000_000_001,
    },
  ])('does not collapse canonical precision for $label', async ({ first, second, expectedNext }) => {
    const step = second - first
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [numericCell(0, 0, first), numericCell(1, 0, second)],
    })
    await backend.fillSeries!(
      request({
        sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: Math.abs(step) < 1e-10 ? 'decimal-step' : 'integer-step',
        step,
        revision: 1,
      }),
    )

    const projection = await readRange(backend, {
      rowStart: 0,
      rowEnd: 2,
      colStart: 0,
      colEnd: 0,
    })
    expect(projection.cells[2]?.numericValue).toBe(expectedNext)
    expect(projection.cells[2]?.displayValue).toBe(String(expectedNext))
  })

  it('fills a decimal series to the right', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [numericCell(0, 0, 1.5), numericCell(0, 1, 2.25)],
    })
    await backend.fillSeries!(
      request({
        sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
        targetRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 4 },
        direction: 'right',
        series: 'decimal-step',
        step: 0.75,
        revision: 1,
      }),
    )

    const projection = await readRange(backend, {
      rowStart: 0,
      rowEnd: 0,
      colStart: 0,
      colEnd: 4,
    })
    expect(projection.cells.map((cell) => cell.displayValue)).toEqual([
      '1.5',
      '2.25',
      '3',
      '3.75',
      '4.5',
    ])
  })

  it('supports negative and strictly non-zero tiny steps', async () => {
    const negativeBackend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [numericCell(0, 0, 5), numericCell(1, 0, 3)],
    })
    await negativeBackend.fillSeries!(
      request({
        sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: 'integer-step',
        step: -2,
        revision: 1,
      }),
    )
    expect(
      (
        await readRange(negativeBackend, {
          rowStart: 0,
          rowEnd: 3,
          colStart: 0,
          colEnd: 0,
        })
      ).cells.map((cell) => cell.displayValue),
    ).toEqual(['5', '3', '1', '-1'])

    const tinyBackend = createStaticSpreadsheetBackend({
      revision: 4,
      cells: [numericCell(0, 0, 0), numericCell(1, 0, 1e-12)],
    })
    const tinyRequest = request({
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
      direction: 'down',
      series: 'decimal-step',
      step: 1e-12,
      revision: 4,
    })
    await expect(tinyBackend.fillSeries!(tinyRequest)).resolves.toMatchObject({
      requestId: tinyRequest.requestId,
      revision: 5,
    })
    expect(
      (
        await readRange(tinyBackend, {
          rowStart: 0,
          rowEnd: 2,
          colStart: 0,
          colEnd: 0,
        })
      ).cells.map((cell) => cell.numericValue),
    ).toEqual([0, 1e-12, 2e-12])
  })

  it.each([
    [1.00000000001, 2.00000000001, 1, 3.00000000001],
    [-1.00000000001, -2.00000000001, -1, -3.00000000001],
  ])(
    'accepts detector-classified near-integer sources (%s, %s)',
    async (first, second, expectedStep, expectedNext) => {
      const sourceCells = [numericCell(0, 0, first), numericCell(1, 0, second)]
      const detected = detectFillSeries(sourceCells, {
        weekdayNames: [],
        monthNames: [],
        customLists: {},
      })
      expect(detected).toEqual({ kind: 'integer-step', step: expectedStep })
      if (detected.kind !== 'integer-step') throw new Error('expected numeric detector result')

      const backend = createStaticSpreadsheetBackend({ revision: 1, cells: sourceCells })
      await backend.fillSeries!(
        request({
          sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
          targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
          direction: 'down',
          series: detected.kind,
          step: detected.step,
          revision: 1,
        }),
      )
      const projection = await readRange(backend, {
        rowStart: 0,
        rowEnd: 2,
        colStart: 0,
        colEnd: 0,
      })
      expect(projection.cells[2]?.numericValue).toBe(expectedNext)
    },
  )

  it('copies the effective source format pattern in one undoable transaction', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 5,
      cells: [
        numericCell(0, 0, 1, { format: { bold: true } }),
        numericCell(1, 0, 2, { format: { italic: true } }),
        numericCell(2, 0, 99, { format: { underline: true } }),
      ],
    })
    await backend.setFreezeConfig!({
      kind: 'set-freeze-config',
      sheetId: SHEET_ID,
      freeze: { rows: 2, cols: 0 },
      revision: 5,
    })
    const mutation = request({
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 0 },
      direction: 'down',
      series: 'integer-step',
      step: 1,
      revision: 6,
    })
    await expect(backend.fillSeries!(mutation)).resolves.toMatchObject({ revision: 7 })

    const filled = await readRange(backend, {
      rowStart: 0,
      rowEnd: 5,
      colStart: 0,
      colEnd: 0,
    })
    expect(filled.cells.map((cell) => cell.format)).toEqual([
      { bold: true },
      { italic: true },
      { bold: true },
      { italic: true },
      { bold: true },
      { italic: true },
    ])

    const undo = await backend.undoTransaction!({
      kind: 'undo-transaction',
      transactionId: 'series',
    })
    expect(undo.revision).toBe(8)
    const undone = await readRange(backend, {
      rowStart: 0,
      rowEnd: 5,
      colStart: 0,
      colEnd: 0,
    })
    expect(undone.revision).toBe(8)
    expect(undone.cells.map((cell) => cell.displayValue)).toEqual(['1', '2', '99'])
    expect(undone.cells[2]?.format).toEqual({ underline: true })
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: SHEET_ID }),
    ).resolves.toMatchObject({ freeze: { rows: 2, cols: 0 } })

    const redo = await backend.redoTransaction!({
      kind: 'redo-transaction',
      transactionId: 'series',
    })
    expect(redo.revision).toBe(9)
    const redone = await readRange(backend, {
      rowStart: 0,
      rowEnd: 5,
      colStart: 0,
      colEnd: 0,
    })
    expect(redone.revision).toBe(9)
    expect(redone.cells.map((cell) => cell.displayValue)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ])
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: SHEET_ID }),
    ).resolves.toMatchObject({ freeze: { rows: 2, cols: 0 } })
  })

  it('rejects stale and invalid requests before history, while a no-write request preserves redo', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 10, matrix: [[1], [2]] })
    const sourceRange = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 }
    await backend.fillSeries!(
      request({
        sourceRange,
        targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: 'integer-step',
        step: 1,
        revision: 10,
      }),
    )
    await backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'series' })

    await expect(
      backend.fillSeries!(
        request({
          sourceRange,
          targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
          direction: 'down',
          series: 'integer-step',
          step: 1,
          revision: 999,
        }),
      ),
    ).rejects.toThrow('stale revision')
    await expect(
      backend.fillSeries!(
        request({
          sourceRange,
          targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
          direction: 'down',
          series: 'date-day',
          step: 1,
          revision: 12,
        }),
      ),
    ).rejects.toThrow('only accepts numeric step series')

    const noopRequest = request({
      sourceRange,
      targetRange: sourceRange,
      direction: 'down',
      series: 'integer-step',
      step: 1,
      revision: 12,
    })
    await expect(backend.fillSeries!(noopRequest)).resolves.toEqual({
      sheetId: SHEET_ID,
      requestId: noopRequest.requestId,
      revision: 12,
    })
    expect((await readRange(backend, sourceRange)).cells.map((cell) => cell.displayValue)).toEqual([
      '1',
      '2',
    ])

    await backend.redoTransaction!({ kind: 'redo-transaction', transactionId: 'series' })
    const redone = await readRange(backend, {
      rowStart: 0,
      rowEnd: 3,
      colStart: 0,
      colEnd: 0,
    })
    expect(redone.cells.map((cell) => cell.displayValue)).toEqual(['1', '2', '3', '4'])
  })

  it('fails a non-finite generation plan before any partial write or history entry', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [numericCell(0, 0, 0), numericCell(1, 0, Number.MAX_VALUE)],
    })
    await expect(
      backend.fillSeries!(
        request({
          sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
          targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
          direction: 'down',
          series: 'integer-step',
          step: Number.MAX_VALUE,
          revision: 1,
        }),
      ),
    ).rejects.toThrow('non-finite value')

    const projection = await readRange(backend, {
      rowStart: 0,
      rowEnd: 2,
      colStart: 0,
      colEnd: 0,
    })
    expect(projection.cells.map((cell) => cell.displayValue)).toEqual([
      '0',
      String(Number.MAX_VALUE),
    ])
    await expect(
      backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'series' }),
    ).rejects.toThrow('nothing to undo')
  })

  it('rejects missing sources and step mismatches without mutation', async () => {
    const missingBackend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [numericCell(0, 0, 1)],
    })
    await expect(
      missingBackend.fillSeries!(
        request({
          sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
          targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
          direction: 'down',
          series: 'integer-step',
          step: 1,
          revision: 1,
        }),
      ),
    ).rejects.toThrow('canonical non-formula numbers')

    const mismatchBackend = createStaticSpreadsheetBackend({ revision: 1, matrix: [[1], [3]] })
    await expect(
      mismatchBackend.fillSeries!(
        request({
          sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
          targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
          direction: 'down',
          series: 'integer-step',
          step: 1,
          revision: 1,
        }),
      ),
    ).rejects.toThrow('source values do not match')

    for (const backend of [missingBackend, mismatchBackend]) {
      await expect(
        backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'series' }),
      ).rejects.toThrow('nothing to undo')
    }
  })

  it('runtime-validates request kind and direction before any side effect', async () => {
    const backend = createStaticSpreadsheetBackend({ revision: 1, matrix: [[1], [2]] })
    const valid = request({
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
      direction: 'down',
      series: 'integer-step',
      step: 1,
      revision: 1,
    })

    await expect(
      backend.fillSeries!({ ...valid, kind: 'fill-range' } as unknown as FillSeriesRequest),
    ).rejects.toThrow('request kind must be fill-series')
    await expect(
      backend.fillSeries!({ ...valid, direction: 'diagonal' } as unknown as FillSeriesRequest),
    ).rejects.toThrow('direction must be up, down, left, or right')

    expect(
      (
        await readRange(backend, {
          rowStart: 0,
          rowEnd: 2,
          colStart: 0,
          colEnd: 0,
        })
      ).cells.map((cell) => cell.displayValue),
    ).toEqual(['1', '2'])
    await expect(
      backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'series' }),
    ).rejects.toThrow('nothing to undo')
  })

  it('rejects formula sources and opaque revisions before mutation', async () => {
    const formulaBackend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [
        numericCell(0, 0, 1, { formula: '=1' }),
        numericCell(1, 0, 2, { formula: '=2' }),
      ],
    })
    await expect(
      formulaBackend.fillSeries!(
        request({
          sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
          targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
          direction: 'down',
          series: 'integer-step',
          step: 1,
          revision: 1,
        }),
      ),
    ).rejects.toThrow('canonical non-formula numbers')

    const opaqueBackend = createStaticSpreadsheetBackend({ revision: 'opaque', matrix: [[1], [2]] })
    await expect(
      opaqueBackend.fillSeries!(
        request({
          sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
          targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
          direction: 'down',
          series: 'integer-step',
          step: 1,
          revision: 'opaque',
        }),
      ),
    ).rejects.toThrow('cannot advance projection revision')
    await expect(
      opaqueBackend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'series' }),
    ).rejects.toThrow('nothing to undo')
  })
})
