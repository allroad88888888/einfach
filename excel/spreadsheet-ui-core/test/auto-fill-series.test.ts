import { createStore, type Atom } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  BUILTIN_FILL_SERIES_MONTH_NAMES,
  BUILTIN_FILL_SERIES_WEEKDAY_NAMES,
  canonicalizeFillSeriesLocale,
  detectFillSeries,
  fillSeriesLocaleAtom,
  foldFillSeriesText,
  normalizeFillSeriesListWitness,
  setFillSeriesLocaleAtom,
} from '../src/auto-fill'
import type { FillSeriesLocaleOptions } from '../src/auto-fill'
import type { PointerFillHandleSession } from '../src/pointer/types'

function cell(displayValue: string) {
  return { row: 0, col: 0, displayValue }
}

function numericCell(numericValue: number, displayValue = String(numericValue)) {
  return {
    row: 0,
    col: 0,
    displayValue,
    valueKind: 'number' as const,
    numericValue,
  }
}

function dateCell(numericValue: number, displayValue = String(numericValue)) {
  return {
    ...numericCell(numericValue, displayValue),
    format: {
      numberFormat: {
        kind: 'date' as const,
        pattern: 'yyyy-mm-dd',
      },
    },
  }
}

const noLocale: FillSeriesLocaleOptions = {
  locale: 'en',
  weekdayNames: [],
  monthNames: [],
  customLists: {},
}

const weekdayLocale: FillSeriesLocaleOptions = {
  locale: 'en',
  weekdayNames: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  monthNames: [],
  customLists: {},
}

const monthLocale: FillSeriesLocaleOptions = {
  locale: 'en',
  weekdayNames: [],
  monthNames: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  customLists: {},
}

describe('foldFillSeriesText ECMA-402 compatibility', () => {
  test.each(['en', 'zh'])('%s applies the context-sensitive Greek final sigma rule', (locale) => {
    expect([
      foldFillSeriesText('ΟΣ', locale),
      foldFillSeriesText('ΟΣΑ', locale),
      foldFillSeriesText("A'Σ", locale),
    ]).toEqual(['ος', 'οσα', "a'ς"])
  })

  test.each(['tr', 'az'])('%s applies Turkic combining-dot rules in canonical order', (locale) => {
    expect([
      foldFillSeriesText('I\u0307', locale),
      foldFillSeriesText('I\u0323\u0307', locale),
      foldFillSeriesText('I\u0301\u0307', locale),
    ]).toEqual(['i', 'i\u0323', '\u0131\u0301\u0307'])
  })
})

describe('fill-series locale parity with the Rust execution boundary', () => {
  test.each([
    ['en', 'en'],
    ['en-us', 'en-US'],
    ['en-419', 'en-419'],
    ['zh-Hans-CN', 'zh-Hans-CN'],
    ['tr-tr', 'tr-TR'],
    ['az-Latn-AZ', 'az-Latn-AZ'],
  ])('canonicalizes supported locale %s to %s', (input, expected) => {
    expect(canonicalizeFillSeriesLocale(input)).toBe(expected)
  })

  test.each([
    'fr',
    'fr-FR',
    'en-u-co-search',
    'en-US-u-va-posix',
    'zh-Hans-CN-x-private',
    'tr-Latn-TR-extra',
  ])('rejects locale outside the Rust allowlist/shape: %s', (locale) => {
    expect(canonicalizeFillSeriesLocale(locale)).toBeNull()
  })

  test('requires already-canonical locale spelling at the wire witness boundary', () => {
    const witness = {
      listName: 'letters',
      values: ['I', 'İ'],
    }
    expect(normalizeFillSeriesListWitness({ ...witness, locale: 'tr-tr' })).toBeNull()
    expect(normalizeFillSeriesListWitness({ ...witness, locale: 'tr-TR' })).toMatchObject({
      locale: 'tr-TR',
    })
  })
})

describe('detectFillSeries', () => {
  test('[1, 2, 3] → integer-step step 1', () => {
    expect(detectFillSeries([numericCell(1), numericCell(2), numericCell(3)], noLocale)).toEqual({
      kind: 'integer-step',
      step: 1,
    })
  })

  test('[10, 20, 30] → integer-step step 10', () => {
    expect(detectFillSeries([numericCell(10), numericCell(20), numericCell(30)], noLocale)).toEqual(
      { kind: 'integer-step', step: 10 },
    )
  })

  test('[1.5, 3, 4.5] → decimal-step step 1.5', () => {
    expect(
      detectFillSeries([numericCell(1.5), numericCell(3), numericCell(4.5)], noLocale),
    ).toEqual({ kind: 'decimal-step', step: 1.5 })
  })

  test('near-integer canonical values use the shared integer tolerance', () => {
    expect(
      detectFillSeries([numericCell(1.00000000001), numericCell(2.00000000001)], noLocale),
    ).toEqual({ kind: 'integer-step', step: 1 })
    expect(
      detectFillSeries([numericCell(-1.00000000001), numericCell(-2.00000000001)], noLocale),
    ).toEqual({ kind: 'integer-step', step: -1 })
  })

  test('[5, 5, 5] → copy (constant, no step)', () => {
    expect(detectFillSeries([numericCell(5), numericCell(5), numericCell(5)], noLocale)).toEqual({
      kind: 'copy',
    })
  })

  test('non-uniform numeric observations use a least-squares linear trend', () => {
    expect(detectFillSeries([numericCell(1), numericCell(2), numericCell(4)], noLocale)).toEqual({
      kind: 'linear-trend',
      step: 1.5,
    })
    expect(detectFillSeries([numericCell(4), numericCell(2), numericCell(1)], noLocale)).toEqual({
      kind: 'linear-trend',
      step: -1.5,
    })
  })

  test('two numeric observations remain a uniform step series rather than a trend', () => {
    expect(detectFillSeries([numericCell(1), numericCell(4)], noLocale)).toEqual({
      kind: 'integer-step',
      step: 3,
    })
  })

  test('date-formatted canonical numbers detect day, week, and calendar-month steps', () => {
    expect(detectFillSeries([dateCell(45_292), dateCell(45_293)], noLocale)).toEqual({
      kind: 'date-day',
      step: 1,
    })
    expect(detectFillSeries([dateCell(45_292), dateCell(45_299)], noLocale)).toEqual({
      kind: 'date-week',
      step: 1,
    })
    expect(detectFillSeries([dateCell(45_322), dateCell(45_351)], noLocale)).toEqual({
      kind: 'date-month',
      step: 1,
    })
  })

  test('a single date seed advances by one calendar day', () => {
    expect(detectFillSeries([dateCell(45_292)], noLocale)).toEqual({ kind: 'date-day', step: 1 })
  })

  test('the same canonical numbers without a date format remain numeric series', () => {
    expect(detectFillSeries([numericCell(45_292), numericCell(45_299)], noLocale)).toEqual({
      kind: 'integer-step',
      step: 7,
    })
  })

  test('text with a trailing integer detects affixes, direction, and zero padding', () => {
    expect(detectFillSeries([cell('Item1')], noLocale)).toEqual({
      kind: 'text-number',
      step: 1,
      textPattern: { prefix: 'Item', suffix: '', width: 1 },
    })
    expect(detectFillSeries([cell('Item009'), cell('Item010')], noLocale)).toEqual({
      kind: 'text-number',
      step: 1,
      textPattern: { prefix: 'Item', suffix: '', width: 3 },
    })
    expect(detectFillSeries([cell('Item2-final'), cell('Item1-final')], noLocale)).toEqual({
      kind: 'text-number',
      step: -1,
      textPattern: { prefix: 'Item', suffix: '-final', width: 1 },
    })
  })

  test('[Mon, Tue] with weekday locale → weekday-name', () => {
    expect(detectFillSeries([cell('Mon'), cell('Tue')], weekdayLocale)).toEqual({
      kind: 'weekday-name',
      step: 1,
      list: {
        listName: 'builtin-weekday-short',
        values: BUILTIN_FILL_SERIES_WEEKDAY_NAMES,
        locale: 'en',
      },
    })
  })

  test('[Jan, Feb] with month locale → month-name', () => {
    expect(detectFillSeries([cell('Jan'), cell('Feb')], monthLocale)).toEqual({
      kind: 'month-name',
      step: 1,
      list: {
        listName: 'builtin-month-short',
        values: BUILTIN_FILL_SERIES_MONTH_NAMES,
        locale: 'en',
      },
    })
  })

  test('built-in weekday and month lists work without host locale injection', () => {
    expect(detectFillSeries([cell('Mon')], noLocale)).toEqual({
      kind: 'weekday-name',
      step: 1,
      list: {
        listName: 'builtin-weekday-short',
        values: BUILTIN_FILL_SERIES_WEEKDAY_NAMES,
        locale: 'en',
      },
    })
    expect(detectFillSeries([cell('March'), cell('February')], noLocale)).toMatchObject({
      kind: 'month-name',
      step: -1,
      list: { listName: 'builtin-month-long' },
    })
  })

  test('custom lists carry a backend-verifiable list witness', () => {
    const locale: FillSeriesLocaleOptions = {
      ...noLocale,
      customLists: { priority: ['low', 'medium', 'high'] },
    }
    expect(detectFillSeries([cell('medium'), cell('high')], locale)).toEqual({
      kind: 'custom-list',
      step: 1,
      custom: { listName: 'priority' },
      list: {
        listName: 'priority',
        values: ['low', 'medium', 'high'],
        locale: 'en',
      },
    })
  })

  test('uses injected Chinese weekday and month lists in both directions', () => {
    const locale: FillSeriesLocaleOptions = {
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

    expect(detectFillSeries([cell('星期六'), cell('星期日')], locale)).toMatchObject({
      kind: 'weekday-name',
      step: 1,
      list: { listName: 'locale-weekday', locale: 'zh' },
    })
    expect(detectFillSeries([cell('三月'), cell('二月')], locale)).toMatchObject({
      kind: 'month-name',
      step: -1,
      list: { listName: 'locale-month', locale: 'zh' },
    })
  })

  test('folds custom-list values with the explicit canonical locale', () => {
    const locale: FillSeriesLocaleOptions = {
      locale: 'tr',
      weekdayNames: [],
      monthNames: [],
      customLists: { turkish: ['I', 'İ'] },
    }

    expect(detectFillSeries([cell('ı'), cell('i')], locale)).toEqual({
      kind: 'custom-list',
      step: 1,
      custom: { listName: 'turkish' },
      list: {
        listName: 'turkish',
        values: ['I', 'İ'],
        locale: 'tr',
      },
    })
  })

  test('does not reinterpret injected lists when their runtime locale is invalid', () => {
    const malformed = {
      locale: 'not_a_locale',
      weekdayNames: ['first', 'second'],
      monthNames: [],
      customLists: { priority: ['low', 'high'] },
    } as FillSeriesLocaleOptions

    expect(detectFillSeries([cell('first'), cell('second')], malformed)).toEqual({ kind: 'copy' })
    expect(detectFillSeries([cell('low'), cell('high')], malformed)).toEqual({ kind: 'copy' })
    expect(detectFillSeries([cell('Mon'), cell('Tue')], malformed)).toMatchObject({
      kind: 'weekday-name',
      list: { listName: 'builtin-weekday-short', locale: 'en' },
    })
  })

  test('filters malformed and reserved custom lists at the detection boundary', () => {
    const oversized = Array.from(
      { length: 513 },
      (_, index) => `value-${String.fromCodePoint(0x1000 + index)}`,
    )
    const cases: Array<{
      customLists: Record<string, string[]>
      source: string[]
    }> = [
      { customLists: { '': ['first', 'second'] }, source: ['first', 'second'] },
      { customLists: { priority: ['first', '', 'second'] }, source: ['first', ''] },
      { customLists: { priority: ['first', 'FIRST'] }, source: ['first'] },
      { customLists: { priority: oversized }, source: oversized.slice(0, 2) },
      {
        customLists: { 'builtin-forged': ['first', 'second'] },
        source: ['first', 'second'],
      },
      {
        customLists: { 'LOCALE-forged': ['first', 'second'] },
        source: ['first', 'second'],
      },
    ]

    for (const { customLists, source } of cases) {
      expect(
        detectFillSeries(
          source.map((value) => cell(value)),
          { ...noLocale, customLists },
        ),
      ).toEqual({ kind: 'copy' })
    }
  })

  test('[apple, banana] with no matching locale → copy', () => {
    expect(detectFillSeries([cell('apple'), cell('banana')], noLocale)).toEqual({ kind: 'copy' })
  })

  test('single value → copy', () => {
    expect(detectFillSeries([cell('42')], noLocale)).toEqual({ kind: 'copy' })
  })

  test('empty source → copy', () => {
    expect(detectFillSeries([], noLocale)).toEqual({ kind: 'copy' })
  })

  test('rejects parseFloat-compatible junk without canonical numeric facts', () => {
    expect(detectFillSeries([cell('1x'), cell('2x')], noLocale)).toEqual({ kind: 'copy' })
  })

  test('rejects formula cells even when their projection displays finite numbers', () => {
    expect(
      detectFillSeries(
        [
          { ...numericCell(1), formula: '=1' },
          { ...numericCell(2), formula: '=2' },
        ],
        noLocale,
      ),
    ).toEqual({ kind: 'copy' })
  })
})

describe('setFillSeriesLocaleAtom', () => {
  test('updates locale in the store', () => {
    const store = createStore()
    expect(store.getter(fillSeriesLocaleAtom)).toEqual({
      locale: 'en',
      weekdayNames: BUILTIN_FILL_SERIES_WEEKDAY_NAMES,
      monthNames: BUILTIN_FILL_SERIES_MONTH_NAMES,
      customLists: {},
    })

    store.setter(setFillSeriesLocaleAtom, weekdayLocale)
    expect(store.getter(fillSeriesLocaleAtom)).toEqual(weekdayLocale)
  })

  test('exposes a readonly atom and rejects direct runtime writes without changing locale', () => {
    const readonlyLocaleAtom: Atom<FillSeriesLocaleOptions> = fillSeriesLocaleAtom
    const store = createStore()
    const before = store.getter(readonlyLocaleAtom)

    expect(() =>
      (store.setter as (...args: unknown[]) => unknown)(fillSeriesLocaleAtom, weekdayLocale),
    ).toThrow()
    expect(store.getter(readonlyLocaleAtom)).toBe(before)
  })

  test('copies and deeply freezes locale input at the command boundary', () => {
    const store = createStore()
    const locale: FillSeriesLocaleOptions = {
      locale: 'en-us',
      weekdayNames: ['Mon', 'Tue'],
      monthNames: ['Jan', 'Feb'],
      customLists: { priority: ['low', 'high'] },
    }

    store.setter(setFillSeriesLocaleAtom, locale)
    locale.weekdayNames!.push('caller mutation')
    locale.monthNames![0] = 'caller mutation'
    locale.customLists!.priority.push('caller mutation')
    locale.customLists!.secondary = ['caller mutation']

    const stored = store.getter(fillSeriesLocaleAtom)
    expect(stored).toEqual({
      locale: 'en-US',
      weekdayNames: ['Mon', 'Tue'],
      monthNames: ['Jan', 'Feb'],
      customLists: { priority: ['low', 'high'] },
    })
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored.weekdayNames)).toBe(true)
    expect(Object.isFrozen(stored.monthNames)).toBe(true)
    expect(Object.isFrozen(stored.customLists)).toBe(true)
    expect(Object.isFrozen(stored.customLists!.priority)).toBe(true)
  })

  test('does not expose mutable top-level or nested list backing through the getter', () => {
    const store = createStore()
    store.setter(setFillSeriesLocaleAtom, {
      locale: 'en',
      weekdayNames: ['Mon', 'Tue'],
      monthNames: [],
      customLists: { priority: ['low', 'high'] },
    })

    const exposed = store.getter(fillSeriesLocaleAtom)
    try {
      exposed.weekdayNames!.push('getter mutation')
    } catch {
      // Frozen command facts may throw in strict mode; the state must remain unchanged.
    }
    try {
      exposed.customLists!.priority[0] = 'getter mutation'
    } catch {
      // See above.
    }
    try {
      exposed.customLists!.secondary = ['getter mutation']
    } catch {
      // See above.
    }

    expect(store.getter(fillSeriesLocaleAtom)).toEqual({
      locale: 'en',
      weekdayNames: ['Mon', 'Tue'],
      monthNames: [],
      customLists: { priority: ['low', 'high'] },
    })
  })

  test('fails closed on malformed runtime input and preserves the previous state', () => {
    const store = createStore()
    store.setter(setFillSeriesLocaleAtom, weekdayLocale)
    const before = store.getter(fillSeriesLocaleAtom)
    const setRuntimeLocale = (value: unknown) =>
      (store.setter as (...args: unknown[]) => unknown)(setFillSeriesLocaleAtom, value)

    for (const invalid of [
      null,
      new Date(),
      { locale: '' },
      { locale: 'not_a_locale' },
      { locale: 'fr' },
      { locale: 'en-u-co-search' },
      { locale: ['en'] },
      { weekdayNames: 'Mon' },
      { weekdayNames: null },
      { monthNames: ['Jan', 2] },
      { customLists: [] },
      { customLists: null },
      { customLists: { priority: ['low', false] } },
      { customLists: { '': ['low', 'high'] } },
      { customLists: { priority: ['low', '', 'high'] } },
      { customLists: { priority: ['low', 'LOW'] } },
      {
        customLists: {
          priority: Array.from({ length: 513 }, (_, index) => `priority-${index}`),
        },
      },
      { customLists: { 'builtin-priority': ['low', 'high'] } },
      { customLists: { 'LOCALE-priority': ['low', 'high'] } },
    ]) {
      expect(() => setRuntimeLocale(invalid)).not.toThrow()
      expect(store.getter(fillSeriesLocaleAtom)).toBe(before)
    }
  })

  test('keeps normal command-driven locale detection working', () => {
    const store = createStore()
    store.setter(setFillSeriesLocaleAtom, weekdayLocale)

    expect(
      detectFillSeries([cell('Mon'), cell('Tue')], store.getter(fillSeriesLocaleAtom)),
    ).toMatchObject({
      kind: 'weekday-name',
      step: 1,
      list: { listName: 'builtin-weekday-short' },
    })
  })
})

describe('PointerFillHandleSession type compatibility', () => {
  test('copyOnly: true typechecks on session', () => {
    const session: PointerFillHandleSession = {
      kind: 'fill-handle',
      sheetId: 'sheet-1',
      sourceRange: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      focus: null,
      previewRange: null,
      direction: null,
      copyOnly: true,
    }
    expect(session.copyOnly).toBe(true)
  })
})
