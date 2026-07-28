import { describe, expect, it } from '@jest/globals'
import {
  BUILTIN_FILL_SERIES_WEEKDAY_NAMES,
  createRangeProjectionRequest,
  detectFillSeries,
  type CellRange,
  type FillSeriesRequest,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import { createStaticSpreadsheetBackend } from '../src-vnext/adapter'

const SHEET_ID = 'sheet-1'
let nextRequestId = 100

async function readRange(
  backend: SpreadsheetBackend,
  range: CellRange,
  sheetId = SHEET_ID,
) {
  return backend.readRangeProjection(
    createRangeProjectionRequest({
      sheetId,
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

function stringCell(row: number, col: number, value: string, extra = {}) {
  return {
    row,
    col,
    displayValue: value,
    valueKind: 'string' as const,
    ...extra,
  }
}

function dateCell(row: number, col: number, value: number) {
  return numericCell(row, col, value, {
    format: {
      numberFormat: {
        kind: 'date' as const,
        pattern: 'yyyy-mm-dd',
      },
    },
  })
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

describe('static backend fill series', () => {
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
        applied: true,
        historyTransactionCount: 1,
        historyDisposition: 'undoable',
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
      expectedNext: 1 + 1e-15 + (1 + 1e-15 - 1),
    },
    {
      label: 'a unit delta near 10^15',
      first: 999_999_999_999_999,
      second: 1_000_000_000_000_000,
      expectedNext: 1_000_000_000_000_001,
    },
  ])(
    'does not collapse canonical precision for $label',
    async ({ first, second, expectedNext }) => {
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
    },
  )

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
        locale: 'en',
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

  it('extends non-uniform observations with their least-squares linear trend', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [numericCell(0, 0, 1), numericCell(1, 0, 2), numericCell(2, 0, 4)],
    })
    await backend.fillSeries!(
      request({
        sourceRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: 'linear-trend',
        step: 1.5,
        revision: 1,
      }),
    )

    const projection = await readRange(backend, {
      rowStart: 0,
      rowEnd: 4,
      colStart: 0,
      colEnd: 0,
    })
    expect(projection.cells.slice(0, 3).map((cell) => cell.numericValue)).toEqual([1, 2, 4])
    expect(projection.cells[3]?.numericValue).toBeCloseTo(16 / 3)
    expect(projection.cells[4]?.numericValue).toBeCloseTo(41 / 6)
  })

  it('advances calendar months across leap-year month ends', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [dateCell(0, 0, 45_322), dateCell(1, 0, 45_351)],
    })
    await backend.fillSeries!(
      request({
        sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: 'date-month',
        step: 1,
        revision: 1,
      }),
    )

    const projection = await readRange(backend, {
      rowStart: 0,
      rowEnd: 3,
      colStart: 0,
      colEnd: 0,
    })
    expect(projection.cells.map((cell) => cell.numericValue)).toEqual([
      45_322, 45_351, 45_382, 45_412,
    ])
  })

  it('advances a single date seed by calendar days', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [dateCell(0, 0, 45_292)],
    })
    await backend.fillSeries!(
      request({
        sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: 'date-day',
        step: 1,
        revision: 1,
      }),
    )

    const projection = await readRange(backend, {
      rowStart: 0,
      rowEnd: 2,
      colStart: 0,
      colEnd: 0,
    })
    expect(projection.cells.map((cell) => cell.numericValue)).toEqual([45_292, 45_293, 45_294])
  })

  it('advances a date-day series on unformatted serials (Excel parity: format is display-only)', async () => {
    // Excel dates are plain serial numbers: fill arithmetic runs on the
    // serial regardless of number format. A date-kind series must not be
    // gated on the source cell having an effective date format — only the
    // value-type requirement (canonical, non-formula numbers) applies.
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [numericCell(0, 0, 45_292)],
    })
    const mutationRequest = request({
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
      direction: 'down',
      series: 'date-day',
      step: 1,
      revision: 1,
    })
    await expect(backend.fillSeries!(mutationRequest)).resolves.toMatchObject({
      revision: 2,
      applied: true,
    })

    const projection = await readRange(backend, {
      rowStart: 0,
      rowEnd: 2,
      colStart: 0,
      colEnd: 0,
    })
    expect(projection.cells.map((cell) => cell.numericValue)).toEqual([45_292, 45_293, 45_294])
    // Format propagation is unchanged by this fix: the written cells copy
    // the source's (unformatted) effective format, not a date format.
    expect(projection.cells.map((cell) => cell.format)).toEqual([undefined, undefined, undefined])
  })

  it('extends single-cell text-number seeds with padding in both directions', async () => {
    const down = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [stringCell(0, 0, 'Item009')],
    })
    await down.fillSeries!(
      request({
        sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: 'text-number',
        step: 1,
        textPattern: { prefix: 'Item', suffix: '', width: 3 },
        revision: 1,
      }),
    )
    expect(
      (
        await readRange(down, {
          rowStart: 0,
          rowEnd: 3,
          colStart: 0,
          colEnd: 0,
        })
      ).cells.map((cell) => cell.displayValue),
    ).toEqual(['Item009', 'Item010', 'Item011', 'Item012'])

    const up = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [stringCell(2, 0, 'Item2')],
    })
    await up.fillSeries!(
      request({
        sourceRange: { rowStart: 2, rowEnd: 2, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
        direction: 'up',
        series: 'text-number',
        step: 1,
        textPattern: { prefix: 'Item', suffix: '', width: 1 },
        revision: 1,
      }),
    )
    expect(
      (
        await readRange(up, {
          rowStart: 0,
          rowEnd: 2,
          colStart: 0,
          colEnd: 0,
        })
      ).cells.map((cell) => cell.displayValue),
    ).toEqual(['Item0', 'Item1', 'Item2'])
  })

  it('executes detected Chinese weekday and month lists forward, backward, and across cycles', async () => {
    const locale = {
      locale: 'zh',
      weekdayNames: ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'],
      monthNames: [
        '一月',
        '二月',
        '三月',
        '四月',
        '五月',
        '六月',
        '七月',
        '八月',
        '九月',
        '十月',
        '十一月',
        '十二月',
      ],
      customLists: {},
    }
    const weekdayCells = [stringCell(0, 0, '星期六'), stringCell(1, 0, '星期日')]
    const weekday = detectFillSeries(weekdayCells, locale)
    expect(weekday).toMatchObject({
      kind: 'weekday-name',
      step: 1,
      list: { listName: 'locale-weekday', locale: 'zh' },
    })
    if (weekday.kind !== 'weekday-name' || !weekday.list) {
      throw new Error('expected a localized weekday witness')
    }

    const weekdayBackend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: weekdayCells,
    })
    await weekdayBackend.fillSeries!(
      request({
        sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: weekday.kind,
        step: weekday.step,
        list: weekday.list,
        revision: 1,
      }),
    )
    expect(
      (
        await readRange(weekdayBackend, {
          rowStart: 0,
          rowEnd: 4,
          colStart: 0,
          colEnd: 0,
        })
      ).cells.map((cell) => cell.displayValue),
    ).toEqual(['星期六', '星期日', '星期一', '星期二', '星期三'])

    const monthCells = [stringCell(0, 0, '三月'), stringCell(1, 0, '二月')]
    const month = detectFillSeries(monthCells, locale)
    expect(month).toMatchObject({
      kind: 'month-name',
      step: -1,
      list: { listName: 'locale-month', locale: 'zh' },
    })
    if (month.kind !== 'month-name' || !month.list) {
      throw new Error('expected a localized month witness')
    }

    const monthBackend = createStaticSpreadsheetBackend({ revision: 1, cells: monthCells })
    await monthBackend.fillSeries!(
      request({
        sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 4, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: month.kind,
        step: month.step,
        list: month.list,
        revision: 1,
      }),
    )
    expect(
      (
        await readRange(monthBackend, {
          rowStart: 0,
          rowEnd: 4,
          colStart: 0,
          colEnd: 0,
        })
      ).cells.map((cell) => cell.displayValue),
    ).toEqual(['三月', '二月', '一月', '十二月', '十一月'])
  })

  it('uses the detector locale witness when executing Turkish custom-list folding', async () => {
    const sourceCells = [stringCell(0, 0, 'ı'), stringCell(1, 0, 'i')]
    const detected = detectFillSeries(sourceCells, {
      locale: 'tr',
      weekdayNames: [],
      monthNames: [],
      customLists: { turkish: ['I', 'İ', 'K'] },
    })
    expect(detected).toMatchObject({
      kind: 'custom-list',
      step: 1,
      list: { listName: 'turkish', locale: 'tr' },
    })
    if (detected.kind !== 'custom-list' || !detected.list) {
      throw new Error('expected a Turkish custom-list witness')
    }

    const backend = createStaticSpreadsheetBackend({ revision: 1, cells: sourceCells })
    await backend.fillSeries!(
      request({
        sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: detected.kind,
        step: detected.step,
        list: detected.list,
        revision: 1,
      }),
    )
    expect(
      (
        await readRange(backend, {
          rowStart: 0,
          rowEnd: 3,
          colStart: 0,
          colEnd: 0,
        })
      ).cells.map((cell) => cell.displayValue),
    ).toEqual(['ı', 'i', 'K', 'I'])
  })

  it('rejects missing, rewritten, and list-tampered locale witnesses before mutation', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [stringCell(0, 0, 'ı'), stringCell(1, 0, 'i')],
    })
    const witnesses: FillSeriesRequest['list'][] = [
      { listName: 'turkish', values: ['I', 'İ', 'K'] },
      { listName: 'turkish', values: ['I', 'İ', 'K'], locale: 'TR' },
      { listName: 'turkish', values: ['I', 'İ', 'K'], locale: 'en' },
      { listName: 'turkish', values: ['I', 'K', 'İ'], locale: 'tr' },
    ]

    for (const list of witnesses) {
      await expect(
        backend.fillSeries!(
          request({
            sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
            targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
            direction: 'down',
            series: 'custom-list',
            step: 1,
            list,
            revision: 1,
          }),
        ),
      ).rejects.toThrow()
    }

    const projection = await readRange(backend, {
      rowStart: 0,
      rowEnd: 2,
      colStart: 0,
      colEnd: 0,
    })
    expect(projection.revision).toBe(1)
    expect(projection.cells.map((cell) => cell.displayValue)).toEqual(['ı', 'i'])
    await expect(
      backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'locale-tamper' }),
    ).rejects.toThrow('nothing to undo')
  })

  it('cycles the canonical built-in weekday list forward and backward', async () => {
    const down = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [stringCell(0, 0, 'Mon')],
    })
    await down.fillSeries!(
      request({
        sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: 'weekday-name',
        step: 1,
        list: {
          listName: 'builtin-weekday-short',
          values: BUILTIN_FILL_SERIES_WEEKDAY_NAMES,
          locale: 'en',
        },
        revision: 1,
      }),
    )
    expect(
      (
        await readRange(down, {
          rowStart: 0,
          rowEnd: 3,
          colStart: 0,
          colEnd: 0,
        })
      ).cells.map((cell) => cell.displayValue),
    ).toEqual(['Mon', 'Tue', 'Wed', 'Thu'])

    const up = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [stringCell(2, 0, 'Mon')],
    })
    await up.fillSeries!(
      request({
        sourceRange: { rowStart: 2, rowEnd: 2, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
        direction: 'up',
        series: 'weekday-name',
        step: 1,
        list: {
          listName: 'builtin-weekday-short',
          values: BUILTIN_FILL_SERIES_WEEKDAY_NAMES,
          locale: 'en',
        },
        revision: 1,
      }),
    )
    expect(
      (
        await readRange(up, {
          rowStart: 0,
          rowEnd: 2,
          colStart: 0,
          colEnd: 0,
        })
      ).cells.map((cell) => cell.displayValue),
    ).toEqual(['Sat', 'Sun', 'Mon'])
  })

  it('rejects tampered pattern and built-in list witnesses before mutation', async () => {
    const textBackend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [stringCell(0, 0, 'Item1')],
    })
    await expect(
      textBackend.fillSeries!(
        request({
          sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
          targetRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
          direction: 'down',
          series: 'text-number',
          step: 1,
          textPattern: { prefix: 'Other', suffix: '', width: 1 },
          revision: 1,
        }),
      ),
    ).rejects.toThrow('pattern witness')

    const listBackend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [stringCell(0, 0, 'Mon')],
    })
    await expect(
      listBackend.fillSeries!(
        request({
          sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
          targetRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
          direction: 'down',
          series: 'weekday-name',
          step: 1,
          list: {
            listName: 'builtin-weekday-short',
            values: ['Mon', 'Hacked'],
            locale: 'en',
          },
          revision: 1,
        }),
      ),
    ).rejects.toThrow('canonical list')
    await expect(
      listBackend.fillSeries!(
        request({
          sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
          targetRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
          direction: 'down',
          series: 'weekday-name',
          step: 1,
          list: {
            listName: 'builtin-weekday-short',
            values: BUILTIN_FILL_SERIES_WEEKDAY_NAMES,
            locale: 'tr',
          },
          revision: 1,
        }),
      ),
    ).rejects.toThrow('canonical list')

    for (const backend of [textBackend, listBackend]) {
      await expect(
        backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'series' }),
      ).rejects.toThrow('nothing to undo')
    }
  })

  it.each(['builtin-forged', 'locale-forged', 'BUILTIN-forged', 'LOCALE-forged'])(
    'rejects a custom list that claims the reserved %s namespace',
    async (listName) => {
      const backend = createStaticSpreadsheetBackend({
        revision: 1,
        cells: [stringCell(0, 0, 'first')],
      })

      await expect(
        backend.fillSeries!(
          request({
            sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
            targetRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
            direction: 'down',
            series: 'custom-list',
            step: 1,
            list: { listName, values: ['first', 'second'], locale: 'en' },
            revision: 1,
          }),
        ),
      ).rejects.toThrow('reserved list name')

      await expect(
        backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'series' }),
      ).rejects.toThrow('nothing to undo')
    },
  )

  it('masks a target range-format when fillRange copies the default source format', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [['source'], ['old target'], ['outside']],
    })
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: SHEET_ID,
      range: { rowStart: 1, rowEnd: 2, colStart: 0, colEnd: 0 },
      format: { bold: true },
    })

    await expect(
      backend.fillRange!({
        kind: 'fill-range',
        sheetId: SHEET_ID,
        requestId: nextRequestId++,
        sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
        direction: 'down',
        revision: 2,
      }),
    ).resolves.toMatchObject({
      revision: 3,
      affectedRange: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      applied: true,
      historyTransactionCount: 1,
      historyDisposition: 'undoable',
    })

    const filled = await readRange(backend, {
      rowStart: 0,
      rowEnd: 2,
      colStart: 0,
      colEnd: 0,
    })
    expect(filled.cells.map((cell) => ({ value: cell.displayValue, format: cell.format }))).toEqual(
      [
        { value: 'source', format: undefined },
        { value: 'source', format: undefined },
        { value: 'outside', format: { bold: true } },
      ],
    )

    await backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'fill-range' })
    const undone = await readRange(backend, {
      rowStart: 0,
      rowEnd: 2,
      colStart: 0,
      colEnd: 0,
    })
    expect(undone.cells.map((cell) => ({ value: cell.displayValue, format: cell.format }))).toEqual(
      [
        { value: 'source', format: undefined },
        { value: 'old target', format: { bold: true } },
        { value: 'outside', format: { bold: true } },
      ],
    )

    await backend.redoTransaction!({ kind: 'redo-transaction', transactionId: 'fill-range' })
    const redone = await readRange(backend, {
      rowStart: 0,
      rowEnd: 2,
      colStart: 0,
      colEnd: 0,
    })
    expect(redone.cells.map((cell) => ({ value: cell.displayValue, format: cell.format }))).toEqual(
      [
        { value: 'source', format: undefined },
        { value: 'source', format: undefined },
        { value: 'outside', format: { bold: true } },
      ],
    )
  })

  it('shifts formula refs during fillRange without rewriting functions or exponents', async () => {
    const sourceFormula = '=LOG10(A1)+1E10+SUM(C1:D2)+Sheet1!A1+$A$1'
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [
        stringCell(0, 1, sourceFormula, {
          formula: sourceFormula,
        }),
      ],
    })

    await backend.fillRange!({
      kind: 'fill-range',
      sheetId: SHEET_ID,
      requestId: nextRequestId++,
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 1, colEnd: 1 },
      targetRange: { rowStart: 0, rowEnd: 1, colStart: 1, colEnd: 1 },
      direction: 'down',
      revision: 1,
    })

    const filled = await readRange(backend, {
      rowStart: 0,
      rowEnd: 1,
      colStart: 1,
      colEnd: 1,
    })
    expect(filled.cells.map((cell) => cell.formula)).toEqual([
      sourceFormula,
      '=LOG10(A2)+1E10+SUM(C2:D3)+Sheet1!A2+$A$1',
    ])
  })

  it('shifts fillRange formula refs without rewriting quoted sheets or Unicode names', async () => {
    const sourceFormula = "='A1'' Data'!B2+成本A1+A1"
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: [
        { id: SHEET_ID, name: 'Sheet1' },
        { id: 'quoted-data', name: "A1' Data" },
      ],
      cells: [
        stringCell(0, 1, sourceFormula, {
          formula: sourceFormula,
        }),
      ],
    })

    await backend.fillRange!({
      kind: 'fill-range',
      sheetId: SHEET_ID,
      requestId: nextRequestId++,
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 1, colEnd: 1 },
      targetRange: { rowStart: 0, rowEnd: 1, colStart: 1, colEnd: 1 },
      direction: 'down',
      revision: 1,
    })

    const filled = await readRange(backend, {
      rowStart: 0,
      rowEnd: 1,
      colStart: 1,
      colEnd: 1,
    })
    expect(filled.cells.map((cell) => cell.formula)).toEqual([
      sourceFormula,
      "='A1'' Data'!B3+成本A1+A2",
    ])
  })

  it('lets a self-referencing fillRange formula land and read as #CYCLE!', async () => {
    // Was: rejected outright with 'auto-fill formulas would create a
    // dependency cycle'. Now the fill always lands, exactly as if the
    // formula had been typed in by hand — `setCellInput` never rejects a
    // self-referencing formula either, it just stores the text and lets
    // `evaluateFormula`'s runtime cycle guard resolve it lazily to #CYCLE!.
    const sourceFormula = '=$A$1'
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [
        numericCell(0, 0, 7, { format: { bold: true } }),
        stringCell(0, 1, sourceFormula, {
          formula: sourceFormula,
          format: { italic: true },
        }),
      ],
    })
    const range = { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 }

    const mutationRequest = {
      kind: 'fill-range' as const,
      sheetId: SHEET_ID,
      requestId: nextRequestId++,
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 1, colEnd: 1 },
      targetRange: range,
      direction: 'left' as const,
      revision: 1,
    }
    await expect(backend.fillRange!(mutationRequest)).resolves.toMatchObject({
      revision: 2,
      affectedRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      applied: true,
      historyTransactionCount: 1,
      historyDisposition: 'undoable',
    })

    const after = await readRange(backend, range)
    const a1 = after.cells.find((cell) => cell.row === 0 && cell.col === 0)
    const b1 = after.cells.find((cell) => cell.row === 0 && cell.col === 1)
    // The self-referencing copy lands with its shifted formula text intact;
    // reading it back resolves to #CYCLE! instead of a value.
    expect(a1?.formula).toBe('=$A$1')
    expect(a1?.displayValue).toBe('#CYCLE!')
    // Fill-copy format propagation is unaffected by the cycle: A1 still
    // takes on B1's effective format like any other copy target.
    expect(a1?.format).toEqual({ italic: true })
    // B1's own formula is untouched, but it now reads A1 — which resolves
    // to the cycle error — so the error propagates through normal
    // evaluation, not through any cycle of B1's own.
    expect(b1?.formula).toBe(sourceFormula)
    expect(b1?.displayValue).toBe('#CYCLE!')

    await backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'cyclic-fill-range' })
    const undone = await readRange(backend, range)
    const undoneA1 = undone.cells.find((cell) => cell.row === 0 && cell.col === 0)
    expect(undoneA1?.displayValue).toBe('7')
    expect(undoneA1?.format).toEqual({ bold: true })
  })

  it('allows an acyclic cross-sheet reference when a sheet id collides with the qualifier name', async () => {
    const dataNameSheetId = 'main'
    const collidingSheetId = 'Data'
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: [
        { id: dataNameSheetId, name: 'Data' },
        { id: collidingSheetId, name: 'Inputs' },
      ],
      cells: [numericCell(0, 0, 41)],
    })
    await backend.setCellInput({
      kind: 'set-cell-input',
      sheetId: collidingSheetId,
      row: 0,
      col: 1,
      input: '=Data!$A$1',
    })

    await expect(
      backend.fillRange!({
        kind: 'fill-range',
        sheetId: collidingSheetId,
        requestId: nextRequestId++,
        sourceRange: { rowStart: 0, rowEnd: 0, colStart: 1, colEnd: 1 },
        targetRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
        direction: 'left',
        revision: 2,
      }),
    ).resolves.toMatchObject({
      revision: 3,
      affectedRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      applied: true,
    })

    const filled = await readRange(
      backend,
      { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      collidingSheetId,
    )
    expect(filled.cells[0]?.formula).toBe('=Data!$A$1')
  })

  it('lets a batch-only fillRange cycle land, reading as #CYCLE! on both cells', async () => {
    // Was: rejected outright as 'auto-fill formulas would create a
    // dependency cycle'. Neither A1 nor A2 is self-referential on its own —
    // the mutual cycle only exists once BOTH copies are live, exactly like
    // typing the two formulas in one at a time against a workbook that has
    // not yet seen the sibling write — so the fill still lands, and reading
    // either cell back resolves to #CYCLE!.
    const backend = createStaticSpreadsheetBackend({
      revision: 4,
      cells: [
        numericCell(0, 0, 10, { format: { bold: true } }),
        numericCell(1, 0, 20, { format: { italic: true } }),
        stringCell(0, 1, '=$A$2', { formula: '=$A$2' }),
        stringCell(1, 1, '=$A$1', { formula: '=$A$1' }),
      ],
    })
    const range = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }

    const mutationRequest = {
      kind: 'fill-range' as const,
      sheetId: SHEET_ID,
      requestId: nextRequestId++,
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 1, colEnd: 1 },
      targetRange: range,
      direction: 'left' as const,
      revision: 4,
    }
    await expect(backend.fillRange!(mutationRequest)).resolves.toMatchObject({
      revision: 5,
      affectedRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      applied: true,
      historyTransactionCount: 1,
      historyDisposition: 'undoable',
    })

    const after = await readRange(backend, range)
    const a1 = after.cells.find((cell) => cell.row === 0 && cell.col === 0)
    const a2 = after.cells.find((cell) => cell.row === 1 && cell.col === 0)
    expect(a1?.formula).toBe('=$A$2')
    expect(a2?.formula).toBe('=$A$1')
    expect(a1?.displayValue).toBe('#CYCLE!')
    expect(a2?.displayValue).toBe('#CYCLE!')
    // Format propagation still runs: A2's pre-fill italic format is
    // replaced by B2's (default) effective format like any other copy
    // target — the cycle does not short-circuit it.
    expect(a2?.format).toBeUndefined()
  })

  it('allows a fillRange formula to depend on an existing cycle that cannot reach the target', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 6,
      cells: [
        stringCell(0, 0, '=B1', { formula: '=B1' }),
        stringCell(0, 1, '=A1', { formula: '=A1' }),
        stringCell(0, 3, '=$A$1', { formula: '=$A$1' }),
      ],
    })

    await expect(
      backend.fillRange!({
        kind: 'fill-range',
        sheetId: SHEET_ID,
        requestId: nextRequestId++,
        sourceRange: { rowStart: 0, rowEnd: 0, colStart: 3, colEnd: 3 },
        targetRange: { rowStart: 0, rowEnd: 0, colStart: 3, colEnd: 4 },
        direction: 'right',
        revision: 6,
      }),
    ).resolves.toMatchObject({
      revision: 7,
      affectedRange: { rowStart: 0, rowEnd: 0, colStart: 4, colEnd: 4 },
      applied: true,
    })

    const filled = await readRange(backend, {
      rowStart: 0,
      rowEnd: 0,
      colStart: 4,
      colEnd: 4,
    })
    expect(filled.cells[0]?.formula).toBe('=$A$1')
  })

  it('rejects a stale fillRange witness without changing values, formats, revision, or history', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 9,
      cells: [
        stringCell(0, 0, 'source', { format: { bold: true } }),
        stringCell(1, 0, 'target', { format: { italic: true } }),
      ],
    })
    const range = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 }
    const before = await readRange(backend, range)

    await expect(
      backend.fillRange!({
        kind: 'fill-range',
        sheetId: SHEET_ID,
        requestId: nextRequestId++,
        sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        targetRange: range,
        direction: 'down',
        revision: 8,
      }),
    ).rejects.toThrow('fill range revision conflict: expected 8, current 9')

    const after = await readRange(backend, range)
    expect(after.revision).toBe(9)
    expect(after.cells).toEqual(before.cells)
    await expect(
      backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'stale-fill-range' }),
    ).rejects.toThrow('nothing to undo')
  })

  it('preflights an unadvanceable fillRange revision before changing workbook facts or history', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 'opaque',
      cells: [
        stringCell(0, 0, 'source', { format: { bold: true } }),
        stringCell(1, 0, 'target', { format: { italic: true } }),
      ],
    })
    const range = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 }
    const before = await readRange(backend, range)

    await expect(
      backend.fillRange!({
        kind: 'fill-range',
        sheetId: SHEET_ID,
        requestId: nextRequestId++,
        sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
        targetRange: range,
        direction: 'down',
        revision: 'opaque',
      }),
    ).rejects.toThrow('cannot advance projection revision opaque')

    const after = await readRange(backend, range)
    expect(after.revision).toBe('opaque')
    expect(after.cells).toEqual(before.cells)
    await expect(
      backend.undoTransaction!({
        kind: 'undo-transaction',
        transactionId: 'unadvanceable-fill-range',
      }),
    ).rejects.toThrow('nothing to undo')
  })

  it('rejects a fillRange target over the auto-fill cell budget without mutation', async () => {
    // Two full columns (2 * MAX_AUTO_FILL_CELLS) — well over the
    // one-full-Excel-column budget. Mirrors the same cap the Rust engine
    // and worker adapter enforce, so the static backend fails fast too.
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [stringCell(0, 0, 'source'), stringCell(0, 1, 'source2')],
    })

    await expect(
      backend.fillRange!({
        kind: 'fill-range',
        sheetId: SHEET_ID,
        requestId: nextRequestId++,
        sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 1 },
        targetRange: { rowStart: 0, rowEnd: 1_048_575, colStart: 0, colEnd: 1 },
        direction: 'down',
        revision: 1,
      }),
    ).rejects.toThrow(/cells but the engine cap is 1048576/)

    expect((await backend.listSheets!()).revision).toBe(1)
  })

  it('masks and restores a target range-format for fillSeries default-format writes', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [[1], [2], [99], [100]],
    })
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: SHEET_ID,
      range: { rowStart: 2, rowEnd: 3, colStart: 0, colEnd: 0 },
      format: { bold: true },
    })

    await backend.fillSeries!(
      request({
        sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
        targetRange: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 0 },
        direction: 'down',
        series: 'integer-step',
        step: 1,
        revision: 2,
      }),
    )
    const filled = await readRange(backend, {
      rowStart: 2,
      rowEnd: 3,
      colStart: 0,
      colEnd: 0,
    })
    expect(filled.cells.map((cell) => ({ value: cell.displayValue, format: cell.format }))).toEqual(
      [
        { value: '3', format: undefined },
        { value: '100', format: { bold: true } },
      ],
    )

    await backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'fill-series' })
    const undone = await readRange(backend, {
      rowStart: 2,
      rowEnd: 3,
      colStart: 0,
      colEnd: 0,
    })
    expect(undone.cells.map((cell) => ({ value: cell.displayValue, format: cell.format }))).toEqual(
      [
        { value: '99', format: { bold: true } },
        { value: '100', format: { bold: true } },
      ],
    )

    await backend.redoTransaction!({ kind: 'redo-transaction', transactionId: 'fill-series' })
    const redone = await readRange(backend, {
      rowStart: 2,
      rowEnd: 3,
      colStart: 0,
      colEnd: 0,
    })
    expect(redone.cells.map((cell) => ({ value: cell.displayValue, format: cell.format }))).toEqual(
      [
        { value: '3', format: undefined },
        { value: '100', format: { bold: true } },
      ],
    )
  })

  it('repeats effective source formats supplied by range-format layers', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      matrix: [['A'], ['B'], ['old 2'], ['old 3'], ['old 4'], ['old 5'], ['outside']],
    })
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: SHEET_ID,
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      format: { bold: true },
    })
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: SHEET_ID,
      range: { rowStart: 1, rowEnd: 1, colStart: 0, colEnd: 0 },
      format: { italic: true },
    })
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: SHEET_ID,
      range: { rowStart: 2, rowEnd: 6, colStart: 0, colEnd: 0 },
      format: { underline: true },
    })

    await backend.fillRange!({
      kind: 'fill-range',
      sheetId: SHEET_ID,
      requestId: nextRequestId++,
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 0 },
      direction: 'down',
    })

    const filled = await readRange(backend, {
      rowStart: 0,
      rowEnd: 6,
      colStart: 0,
      colEnd: 0,
    })
    expect(filled.cells.map((cell) => ({ value: cell.displayValue, format: cell.format }))).toEqual(
      [
        { value: 'A', format: { bold: true } },
        { value: 'B', format: { italic: true } },
        { value: 'A', format: { bold: true } },
        { value: 'B', format: { italic: true } },
        { value: 'A', format: { bold: true } },
        { value: 'B', format: { italic: true } },
        { value: 'outside', format: { underline: true } },
      ],
    )
  })

  it('clears targets for blank source cells and restores their values and formats on undo', async () => {
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      cells: [
        stringCell(2, 0, 'old 2'),
        stringCell(3, 0, 'old 3'),
        stringCell(4, 0, 'old 4'),
        stringCell(5, 0, 'old 5'),
      ],
    })
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: SHEET_ID,
      range: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      format: { bold: true },
    })
    await backend.setFormatRange!({
      kind: 'set-format-range',
      sheetId: SHEET_ID,
      range: { rowStart: 2, rowEnd: 5, colStart: 0, colEnd: 0 },
      format: { italic: true },
    })

    await backend.fillRange!({
      kind: 'fill-range',
      sheetId: SHEET_ID,
      requestId: nextRequestId++,
      sourceRange: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 },
      targetRange: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 0 },
      direction: 'down',
    })

    const snapshotTargets = async () => {
      const projection = await readRange(backend, {
        rowStart: 2,
        rowEnd: 5,
        colStart: 0,
        colEnd: 0,
      })
      return [2, 3, 4, 5].map((row) => {
        const cell = projection.cells.find(
          (candidate) => candidate.row === row && candidate.col === 0,
        )
        return {
          value: cell?.displayValue ?? '',
          format: cell?.format,
        }
      })
    }

    await expect(snapshotTargets()).resolves.toEqual([
      { value: '', format: { bold: true } },
      { value: '', format: undefined },
      { value: '', format: { bold: true } },
      { value: '', format: undefined },
    ])

    await backend.undoTransaction!({ kind: 'undo-transaction', transactionId: 'fill-range' })
    await expect(snapshotTargets()).resolves.toEqual([
      { value: 'old 2', format: { italic: true } },
      { value: 'old 3', format: { italic: true } },
      { value: 'old 4', format: { italic: true } },
      { value: 'old 5', format: { italic: true } },
    ])

    await backend.redoTransaction!({ kind: 'redo-transaction', transactionId: 'fill-range' })
    await expect(snapshotTargets()).resolves.toEqual([
      { value: '', format: { bold: true } },
      { value: '', format: undefined },
      { value: '', format: { bold: true } },
      { value: '', format: undefined },
    ])
  })

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
    expect(redone.cells.map((cell) => cell.displayValue)).toEqual(['1', '2', '3', '4', '5', '6'])
    await expect(
      backend.readFreezeConfig!({ kind: 'read-freeze-config', sheetId: SHEET_ID }),
    ).resolves.toMatchObject({ freeze: { rows: 2, cols: 0 } })
  })

  it('rejects a stale request before history, while a no-write request preserves redo', async () => {
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
      applied: false,
      historyTransactionCount: 0,
      historyDisposition: 'none',
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
      cells: [numericCell(0, 0, 1, { formula: '=1' }), numericCell(1, 0, 2, { formula: '=2' })],
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
