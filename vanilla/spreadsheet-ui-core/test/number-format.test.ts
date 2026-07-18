import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import type { SpreadsheetCellFormat, SpreadsheetNumberFormat } from '../src/backend/types'
import {
  DEFAULT_LOCALE,
  excelSerialToDate,
  formatCustomNumber,
  formatNumberValue,
  parseCustomFormat,
  parseSection,
  resolveLocale,
  splitSections,
} from '../src/operations/format'
import {
  DEFAULT_WORKBOOK_LOCALE,
  setWorkbookLocaleAtom,
  workbookLocaleAtom,
} from '../src/workspace'
import {
  closeNumberFormatDialogAtom,
  numberFormatDialogAtom,
  numberFormatDialogSaveBlockedAtom,
  numberFormatDialogSaveLedgerAtom,
  openNumberFormatDialogAtom,
  patchNumberFormatDialogAtom,
  runNumberFormatDialogSaveAtom,
  type RunFormatCellsSaveInput,
} from '../src/format-cells'

const DIALOG_RANGE = { rowStart: 1, rowEnd: 1, colStart: 2, colEnd: 2 }

function numberDialogPorts(
  overrides: Partial<RunFormatCellsSaveInput> = {},
): RunFormatCellsSaveInput {
  return {
    resolveSourceRanges: (_sheetId, range) => [range],
    setFormatRange: (request) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    }),
    refreshProjection: () => undefined,
    ...overrides,
  }
}

function numberDialogDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('SpreadsheetNumberFormat type widening', () => {
  test('accepts all 12 Excel categories', () => {
    const samples: SpreadsheetNumberFormat[] = [
      { kind: 'general' },
      { kind: 'number', digits: 2, thousands: true, negative: 'red' },
      { kind: 'decimal', digits: 2, thousands: false }, // deprecated alias
      { kind: 'currency', symbol: '$', digits: 2, negative: 'red-parens' },
      { kind: 'accounting', symbol: '$', digits: 2 },
      { kind: 'date', pattern: 'yyyy-mm-dd' },
      { kind: 'time', pattern: 'h:mm:ss' },
      { kind: 'percent', digits: 0 },
      { kind: 'percentage', digits: 2, negative: 'parens' },
      { kind: 'fraction', denominator: 'two-digit' },
      { kind: 'scientific', digits: 3 },
      { kind: 'text' },
      { kind: 'special', preset: 'zip-code', locale: 'en-US' },
      { kind: 'custom', pattern: '#,##0.00' },
    ]
    expect(samples.length).toBe(14)
    for (const sample of samples) {
      const wrapper: SpreadsheetCellFormat = { numberFormat: sample }
      expect(wrapper.numberFormat).toBe(sample)
    }
  })

  test('SpreadsheetCellFormat carries optional locale field', () => {
    const fmt: SpreadsheetCellFormat = { locale: 'de-DE' }
    expect(fmt.locale).toBe('de-DE')
  })
})

describe('workbookLocaleAtom', () => {
  test('defaults to en-US', () => {
    const store = createStore()
    expect(store.getter(workbookLocaleAtom)).toBe(DEFAULT_WORKBOOK_LOCALE)
    expect(DEFAULT_WORKBOOK_LOCALE).toBe('en-US')
  })

  test('setWorkbookLocaleAtom updates the value and ignores empty input', () => {
    const store = createStore()
    store.setter(setWorkbookLocaleAtom, 'de-DE')
    expect(store.getter(workbookLocaleAtom)).toBe('de-DE')
    store.setter(setWorkbookLocaleAtom, '')
    expect(store.getter(workbookLocaleAtom)).toBe(DEFAULT_WORKBOOK_LOCALE)
  })

  test('atom debug label matches spec', () => {
    expect(workbookLocaleAtom.debugLabel).toBe('spreadsheet.workspace.locale')
  })
})

describe('splitSections', () => {
  test('splits on bare semicolons', () => {
    expect(splitSections('#,##0;-#,##0;0;@')).toEqual(['#,##0', '-#,##0', '0', '@'])
  })

  test('ignores semicolons inside double-quoted literals', () => {
    expect(splitSections('"a;b";c')).toEqual(['"a;b"', 'c'])
  })

  test('ignores semicolons inside bracket tags', () => {
    expect(splitSections('[>=10];0')).toEqual(['[>=10]', '0'])
  })

  test('honours backslash escapes', () => {
    expect(splitSections('\\;a;b')).toEqual(['\\;a', 'b'])
  })
})

describe('parseSection token parsing', () => {
  test('parses digit placeholders', () => {
    const section = parseSection('0.00')
    const kinds = section.tokens.map((t) => t.kind)
    expect(kinds).toEqual(['digit-required', 'decimal-point', 'digit-required', 'digit-required'])
    expect(section.hasNumericTokens).toBe(true)
  })

  test('parses thousands, optional digits, and space-pad digits', () => {
    const section = parseSection('#,##0 ?/?')
    expect(section.tokens.some((t) => t.kind === 'thousands')).toBe(true)
    expect(section.tokens.some((t) => t.kind === 'digit-optional')).toBe(true)
    expect(section.tokens.some((t) => t.kind === 'digit-space')).toBe(true)
  })

  test('parses color tags', () => {
    const section = parseSection('[Red]0.00')
    expect(section.color).toBe('#ff0000')
  })

  test('strips currency and locale bracket tags without literal tokens', () => {
    const section = parseSection('[$¥-411]#,##0.00')
    expect(section.tokens.map((t) => t.kind)).toEqual([
      'digit-optional',
      'thousands',
      'digit-optional',
      'digit-optional',
      'digit-required',
      'decimal-point',
      'digit-required',
      'digit-required',
    ])
    expect(section.tokens.some((t) => t.kind === 'literal')).toBe(false)
  })

  test('parses condition tags', () => {
    const section = parseSection('[>0]0.00')
    expect(section.condition).toEqual({ op: '>', value: 0 })
    const ge = parseSection('[>=100]#,##0')
    expect(ge.condition).toEqual({ op: '>=', value: 100 })
  })

  test('parses literal strings and escaped characters', () => {
    const section = parseSection('"USD "0.00\\!')
    const literalText = section.tokens.filter((t) => t.kind === 'literal').map((t) => t.text)
    expect(literalText).toContain('USD ')
    expect(literalText).toContain('!')
  })

  test('parses text placeholder tokens', () => {
    const section = parseSection('"SKU-"@')
    expect(section.tokens.map((t) => t.kind)).toEqual(['literal', 'text-placeholder'])
  })

  test('detects date and time tokens', () => {
    const dateSection = parseSection('yyyy-mm-dd')
    expect(dateSection.hasDateTokens).toBe(true)
    const timeSection = parseSection('h:mm:ss AM/PM')
    expect(timeSection.hasTimeTokens).toBe(true)
    expect(timeSection.hasMeridian).toBe(true)
  })

  test('detects localized Chinese meridian tokens', () => {
    const section = parseSection('上午/下午 h:mm')
    expect(section.hasTimeTokens).toBe(true)
    expect(section.hasMeridian).toBe(true)
  })

  test('disambiguates `m` to minutes when adjacent to hour or second tokens', () => {
    const section = parseSection('h:mm:ss')
    const minuteToken = section.tokens.find((t) => t.kind === 'minute')
    expect(minuteToken).toBeDefined()
  })
})

describe('formatNumberValue — kinds', () => {
  test('general renders number as-is', () => {
    expect(formatNumberValue({ kind: 'general' }, 1234.5).text).toBe('1234.5')
  })

  test('number kind: 2 digits, thousands, negative=minus', () => {
    expect(
      formatNumberValue(
        { kind: 'number', digits: 2, thousands: true, negative: 'minus' },
        1234567.891,
      ).text,
    ).toBe('1,234,567.89')
  })

  test('decimal kind alias formats identical to number kind', () => {
    expect(formatNumberValue({ kind: 'decimal', digits: 1, thousands: true }, 1000).text).toBe(
      '1,000.0',
    )
  })

  test('number negative=red captures red color', () => {
    const result = formatNumberValue({ kind: 'number', digits: 2, negative: 'red' }, -42.5)
    expect(result.color).toBe('#ff0000')
  })

  test('number negative=parens wraps absolute value in parentheses', () => {
    const result = formatNumberValue({ kind: 'number', digits: 0, negative: 'parens' }, -100)
    expect(result.text).toBe('(100)')
  })

  test('number negative=red-parens combines both', () => {
    const result = formatNumberValue({ kind: 'number', digits: 0, negative: 'red-parens' }, -100)
    expect(result.text).toBe('(100)')
    expect(result.color).toBe('#ff0000')
  })

  test('currency renders with symbol and thousands', () => {
    expect(formatNumberValue({ kind: 'currency', symbol: '$', digits: 2 }, 1234.5).text).toBe(
      '$1,234.50',
    )
  })

  test('currency honours custom symbol and decimal digits', () => {
    expect(formatNumberValue({ kind: 'currency', symbol: '¥', digits: 0 }, 1234.56).text).toBe(
      '¥1,235',
    )
    expect(formatNumberValue({ kind: 'currency', symbol: '€', digits: 3 }, 12).text).toBe('€12.000')
  })

  test('accounting uses parens for negatives and dash for zero', () => {
    expect(formatNumberValue({ kind: 'accounting', symbol: '$', digits: 2 }, 0).text).toContain('-')
    const neg = formatNumberValue({ kind: 'accounting', symbol: '$', digits: 2 }, -1234)
    expect(neg.text).toContain('(')
    expect(neg.text).toContain(')')
  })

  test('percent multiplies by 100', () => {
    expect(formatNumberValue({ kind: 'percent', digits: 1 }, 0.125).text).toBe('12.5%')
  })

  test('percentage is an alias for percent', () => {
    expect(formatNumberValue({ kind: 'percentage', digits: 0 }, 0.5).text).toBe('50%')
  })

  test('scientific renders mantissa and exponent', () => {
    expect(formatNumberValue({ kind: 'scientific', digits: 2 }, 12345).text).toBe('1.23E+04')
  })

  test('text passes value through verbatim', () => {
    expect(formatNumberValue({ kind: 'text' }, '01234').text).toBe('01234')
  })

  test('fraction one-digit produces small denominator output', () => {
    expect(formatNumberValue({ kind: 'fraction', denominator: 'one-digit' }, 0.5).text).toBe('1/2')
    expect(formatNumberValue({ kind: 'fraction', denominator: 'one-digit' }, 2.25).text).toBe(
      '2 1/4',
    )
  })

  test('fraction with fixed denominator forces it', () => {
    expect(formatNumberValue({ kind: 'fraction', denominator: 8 }, 0.125).text).toBe('1/8')
  })

  test('date kind formats using default pattern', () => {
    // Excel serial 44197 = 2021-01-01
    const result = formatNumberValue({ kind: 'date', pattern: 'yyyy-mm-dd' }, 44197)
    expect(result.text).toBe('2021-01-01')
  })

  test('date kind handles short / long month names', () => {
    const result = formatNumberValue({ kind: 'date', pattern: 'd-mmm-yyyy' }, 44197)
    expect(result.text).toBe('1-Jan-2021')
    const longMonth = formatNumberValue({ kind: 'date', pattern: 'mmmm d, yyyy' }, 44197)
    expect(longMonth.text).toBe('January 1, 2021')
  })

  test('date kind handles custom menu date patterns', () => {
    expect(formatNumberValue({ kind: 'date', pattern: 'yyyy/MM/dd' }, 44197).text).toBe(
      '2021/01/01',
    )
    expect(formatNumberValue({ kind: 'date', pattern: 'MM-dd' }, 44197).text).toBe('01-01')
    expect(formatNumberValue({ kind: 'date', pattern: 'M-d' }, 44197).text).toBe('1-1')
    expect(formatNumberValue({ kind: 'date', pattern: 'M"月"d"日"' }, 44197).text).toBe('1月1日')
  })

  test('time pattern with AM/PM uses 12-hour clock', () => {
    // 0.75 = 18:00:00 -> 6:00:00 PM
    const result = formatNumberValue({ kind: 'time', pattern: 'h:mm AM/PM' }, 0.75)
    expect(result.text).toBe('6:00 PM')
  })

  test('time pattern in 24-hour with padded hours', () => {
    const result = formatNumberValue({ kind: 'time', pattern: 'hh:mm:ss' }, 0.5)
    expect(result.text).toBe('12:00:00')
  })

  test('time pattern handles localized Chinese meridian', () => {
    expect(formatNumberValue({ kind: 'time', pattern: '上午/下午 h:mm' }, 0.25).text).toBe(
      '上午 6:00',
    )
    expect(formatNumberValue({ kind: 'time', pattern: '上午/下午 h:mm' }, 0.75).text).toBe(
      '下午 6:00',
    )
  })

  test('special preset zip-code pads to 5 digits', () => {
    expect(formatNumberValue({ kind: 'special', preset: 'zip-code' }, 1234).text).toBe('01234')
  })

  test('special preset phone-us', () => {
    expect(formatNumberValue({ kind: 'special', preset: 'phone-us' }, 4155551234).text).toBe(
      '(415) 555-1234',
    )
  })

  test('custom pattern with section split for negatives', () => {
    const result = formatNumberValue(
      { kind: 'custom', pattern: '#,##0.00;[Red](#,##0.00)' },
      -1234.5,
    )
    expect(result.text).toBe('(1,234.50)')
    expect(result.color).toBe('#ff0000')
  })

  test('custom pattern with zero section', () => {
    const pattern = '#,##0;-#,##0;"--"'
    expect(formatCustomNumber(pattern, 0).text).toBe('--')
    expect(formatCustomNumber(pattern, 100).text).toBe('100')
    expect(formatCustomNumber(pattern, -100).text).toBe('-100')
  })

  test('custom pattern with condition tag overrides default sign pick', () => {
    const pattern = '[>100]"large";[<=100]"small"'
    expect(formatCustomNumber(pattern, 50).text).toBe('small')
    expect(formatCustomNumber(pattern, 500).text).toBe('large')
  })

  test('custom pattern with literal currency string and grouping', () => {
    expect(formatCustomNumber('"€"#,##0.00', 1234.5).text).toBe('€1,234.50')
  })

  test('custom pattern strips bracket currency tags while keeping number format', () => {
    expect(formatCustomNumber('[$¥-411]#,##0.00', 1234.5).text).toBe('1,234.50')
    expect(formatCustomNumber('[$$-409]#,##0.00', 1234.5).text).toBe('1,234.50')

    const colored = formatCustomNumber('[Red][$¥-411]#,##0.00', 1234.5)
    expect(colored.text).toBe('1,234.50')
    expect(colored.color).toBe('#ff0000')
  })

  test('custom pattern with text section placeholder', () => {
    expect(formatCustomNumber('0;[Red](0);"-";"SKU-"@', 'A12').text).toBe('SKU-A12')
  })

  test('custom pattern with quoted literal suffix', () => {
    expect(formatCustomNumber('0.0" kg"', 12.34).text).toBe('12.3 kg')
  })

  test('custom pattern with trailing comma scaling', () => {
    expect(formatCustomNumber('#,##0,', 1234567).text).toBe('1,235')
  })

  test('custom menu number patterns render digits, grouping, parens, and colors', () => {
    expect(formatNumberValue({ kind: 'custom', pattern: '0' }, 12.6).text).toBe('13')
    expect(formatNumberValue({ kind: 'custom', pattern: '0.00' }, 12).text).toBe('12.00')
    expect(formatNumberValue({ kind: 'custom', pattern: '#,##0' }, 1234.4).text).toBe('1,234')
    expect(formatNumberValue({ kind: 'custom', pattern: '#,##0.00' }, 1234.5).text).toBe('1,234.50')

    const negative = formatNumberValue({ kind: 'custom', pattern: '#,##0_);(#,##0)' }, -1234)
    expect(negative.text).toBe('(1,234)')

    const red = formatNumberValue({ kind: 'custom', pattern: '[Red]#,##0' }, 1234)
    expect(red.text).toBe('1,234')
    expect(red.color).toBe('#ff0000')
  })
})

describe('formatNumberValue — locale handling', () => {
  test('default locale en-US uses comma thousands and dot decimal', () => {
    expect(
      formatNumberValue({ kind: 'number', digits: 2, thousands: true }, 1234.56, {
        locale: 'en-US',
      }).text,
    ).toBe('1,234.56')
  })

  test('de-DE swaps thousands and decimal separators', () => {
    expect(
      formatNumberValue({ kind: 'number', digits: 2, thousands: true }, 1234.56, {
        locale: 'de-DE',
      }).text,
    ).toBe('1.234,56')
  })

  test('fr-FR uses space thousands separator', () => {
    expect(
      formatNumberValue({ kind: 'number', digits: 2, thousands: true }, 1234.56, {
        locale: 'fr-FR',
      }).text,
    ).toBe('1 234,56')
  })

  test('resolveLocale falls back to DEFAULT_LOCALE for unknown tags', () => {
    expect(resolveLocale('zz-ZZ')).toBe(DEFAULT_LOCALE)
  })
})

describe('parser internals', () => {
  test('parseCustomFormat returns one section per `;` delimiter', () => {
    expect(parseCustomFormat('a;b;c;d').sections).toHaveLength(4)
  })

  test('excelSerialToDate maps 44197 to 2021-01-01 UTC', () => {
    expect(excelSerialToDate(44197).getUTCFullYear()).toBe(2021)
    expect(excelSerialToDate(44197).getUTCMonth()).toBe(0)
    expect(excelSerialToDate(44197).getUTCDate()).toBe(1)
  })
})

describe('lightweight number-format dialog Core save lifecycle', () => {
  test('publishes pending before the write, preserves the selected draft, refreshes, and closes on a strict local acknowledgement', async () => {
    const store = createStore()
    const calls: string[] = []
    store.setter(openNumberFormatDialogAtom, {
      kind: 'currency',
      sheetId: 'sheet-1',
      range: DIALOG_RANGE,
    })
    store.setter(patchNumberFormatDialogAtom, { selectedId: 'usd', digits: 3 })

    await expect(
      store.setter(
        runNumberFormatDialogSaveAtom,
        numberDialogPorts({
          setFormatRange: (request) => {
            const state = store.getter(numberFormatDialogAtom)
            expect(state.status).toBe('open')
            if (state.status !== 'open') throw new Error('unreachable')
            expect(state).toMatchObject({ phase: 'pending-published', pending: true })
            expect(request.format).toMatchObject({
              numberFormat: { kind: 'currency', symbol: '$', digits: 3 },
            })
            calls.push('set')
            return {
              sheetId: request.sheetId,
              requestId: request.requestId,
              affectedRange: request.range,
            }
          },
          refreshProjection: () => calls.push('refresh'),
        }),
      ),
    ).resolves.toBe('local-acknowledged')

    expect(calls).toEqual(['set', 'refresh'])
    expect(store.getter(numberFormatDialogAtom)).toEqual({ status: 'closed' })
    expect(store.getter(numberFormatDialogSaveLedgerAtom)).toMatchObject([
      { dialog: 'number-format', status: 'local-acknowledged' },
    ])
  })

  test.each([
    ['missing ports', undefined],
    [
      'resolver throw',
      numberDialogPorts({
        resolveSourceRanges: () => {
          throw new Error('source mapping unavailable')
        },
      }),
    ],
    ['empty source ranges', numberDialogPorts({ resolveSourceRanges: () => [] })],
    [
      'invalid source ranges',
      numberDialogPorts({
        resolveSourceRanges: () => [{ rowStart: 2, rowEnd: 1, colStart: 0, colEnd: 0 }],
      }),
    ],
    [
      'resolver timeout',
      numberDialogPorts({
        resolveSourceRanges: () => new Promise<never>(() => undefined),
        timeoutMs: 1,
      }),
    ],
  ])(
    'keeps %s before the write boundary retryable with no outcome-unknown evidence',
    async (_label, ports) => {
      const store = createStore()
      store.setter(openNumberFormatDialogAtom, {
        kind: 'number',
        sheetId: 'sheet-1',
        range: DIALOG_RANGE,
      })

      await expect(store.setter(runNumberFormatDialogSaveAtom, ports)).resolves.toBe('error-open')
      const state = store.getter(numberFormatDialogAtom)
      expect(state.status).toBe('open')
      if (state.status !== 'open') throw new Error('unreachable')
      expect(state).toMatchObject({ phase: 'error-open', pending: false, requestId: null })
      expect(store.getter(numberFormatDialogSaveLedgerAtom)).toEqual([])
      expect(store.getter(numberFormatDialogSaveBlockedAtom)).toBe(false)

      await expect(store.setter(runNumberFormatDialogSaveAtom, numberDialogPorts())).resolves.toBe(
        'local-acknowledged',
      )
    },
  )

  test.each([
    [
      'provider throw',
      numberDialogPorts({
        setFormatRange: () => {
          throw new Error('write may have happened')
        },
      }),
    ],
    [
      'provider rejection',
      numberDialogPorts({
        setFormatRange: () => Promise.reject(new Error('write rejected')),
      }),
    ],
    [
      'provider timeout',
      numberDialogPorts({
        setFormatRange: () => new Promise<never>(() => undefined),
        timeoutMs: 1,
      }),
    ],
    [
      'ack mismatch',
      numberDialogPorts({
        setFormatRange: (request) => ({
          sheetId: `${request.sheetId}-wrong`,
          requestId: request.requestId,
          affectedRange: request.range,
        }),
      }),
    ],
    [
      'refresh failure',
      numberDialogPorts({
        refreshProjection: () => Promise.reject(new Error('projection refresh failed')),
      }),
    ],
  ])('keeps the dialog and blocks retry after the write boundary on %s', async (_label, ports) => {
    const store = createStore()
    store.setter(openNumberFormatDialogAtom, {
      kind: 'dateTime',
      sheetId: 'sheet-1',
      range: DIALOG_RANGE,
    })

    await expect(store.setter(runNumberFormatDialogSaveAtom, ports)).resolves.toBe(
      'outcome-unknown',
    )
    const state = store.getter(numberFormatDialogAtom)
    expect(state.status).toBe('open')
    if (state.status !== 'open') throw new Error('unreachable')
    expect(state).toMatchObject({ phase: 'outcome-unknown-blocked', pending: false })
    expect(store.getter(numberFormatDialogSaveLedgerAtom)).toMatchObject([
      { status: 'outcome-unknown' },
    ])
    expect(store.getter(numberFormatDialogSaveBlockedAtom)).toBe(true)
  })

  test('double save is blocked and a late old-session settlement cannot close a reopen', async () => {
    const store = createStore()
    const pending = numberDialogDeferred<unknown>()
    let acknowledgement: unknown
    store.setter(openNumberFormatDialogAtom, {
      kind: 'number',
      sheetId: 'sheet-old',
      range: DIALOG_RANGE,
    })
    const ports = numberDialogPorts({
      setFormatRange: (request) => {
        acknowledgement = {
          sheetId: request.sheetId,
          requestId: request.requestId,
          affectedRange: request.range,
        }
        return pending.promise
      },
    })
    const first = store.setter(runNumberFormatDialogSaveAtom, ports)
    await Promise.resolve()
    await Promise.resolve()
    await expect(store.setter(runNumberFormatDialogSaveAtom, ports)).resolves.toBe('blocked')

    store.setter(closeNumberFormatDialogAtom)
    store.setter(openNumberFormatDialogAtom, {
      kind: 'currency',
      sheetId: 'sheet-new',
      range: { rowStart: 9, rowEnd: 9, colStart: 9, colEnd: 9 },
    })
    pending.resolve(acknowledgement)
    await expect(first).resolves.toBe('outcome-unknown')

    const reopened = store.getter(numberFormatDialogAtom)
    expect(reopened.status).toBe('open')
    if (reopened.status !== 'open') throw new Error('unreachable')
    expect(reopened).toMatchObject({
      kind: 'currency',
      sheetId: 'sheet-new',
      phase: 'editing',
      pending: false,
    })
  })
})
