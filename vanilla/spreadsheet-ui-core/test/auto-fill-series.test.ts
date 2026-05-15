import { createStore } from '@einfach/core'
import { describe, expect, test } from '@jest/globals'
import {
  detectFillSeries,
  fillSeriesLocaleAtom,
  setFillSeriesLocaleAtom,
} from '../src/auto-fill'
import type {
  FillSeriesLocaleOptions,
} from '../src/auto-fill'
import type { PointerFillHandleSession } from '../src/pointer/types'

function cell(displayValue: string) {
  return { row: 0, col: 0, displayValue }
}

const noLocale: FillSeriesLocaleOptions = {
  weekdayNames: [],
  monthNames: [],
  customLists: {},
}

const weekdayLocale: FillSeriesLocaleOptions = {
  weekdayNames: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  monthNames: [],
  customLists: {},
}

const monthLocale: FillSeriesLocaleOptions = {
  weekdayNames: [],
  monthNames: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  customLists: {},
}

describe('detectFillSeries', () => {
  test('[1, 2, 3] → integer-step step 1', () => {
    expect(detectFillSeries([cell('1'), cell('2'), cell('3')], noLocale))
      .toEqual({ kind: 'integer-step', step: 1 })
  })

  test('[10, 20, 30] → integer-step step 10', () => {
    expect(detectFillSeries([cell('10'), cell('20'), cell('30')], noLocale))
      .toEqual({ kind: 'integer-step', step: 10 })
  })

  test('[1.5, 3, 4.5] → decimal-step step 1.5', () => {
    expect(detectFillSeries([cell('1.5'), cell('3'), cell('4.5')], noLocale))
      .toEqual({ kind: 'decimal-step', step: 1.5 })
  })

  test('[5, 5, 5] → copy (constant, no step)', () => {
    expect(detectFillSeries([cell('5'), cell('5'), cell('5')], noLocale))
      .toEqual({ kind: 'copy' })
  })

  test('[Mon, Tue] with weekday locale → weekday-name', () => {
    expect(detectFillSeries([cell('Mon'), cell('Tue')], weekdayLocale))
      .toEqual({ kind: 'weekday-name' })
  })

  test('[Jan, Feb] with month locale → month-name', () => {
    expect(detectFillSeries([cell('Jan'), cell('Feb')], monthLocale))
      .toEqual({ kind: 'month-name' })
  })

  test('[apple, banana] with no matching locale → copy', () => {
    expect(detectFillSeries([cell('apple'), cell('banana')], noLocale))
      .toEqual({ kind: 'copy' })
  })

  test('single value → copy', () => {
    expect(detectFillSeries([cell('42')], noLocale))
      .toEqual({ kind: 'copy' })
  })

  test('empty source → copy', () => {
    expect(detectFillSeries([], noLocale))
      .toEqual({ kind: 'copy' })
  })
})

describe('setFillSeriesLocaleAtom', () => {
  test('updates locale in the store', () => {
    const store = createStore()
    expect(store.getter(fillSeriesLocaleAtom)).toEqual({
      weekdayNames: [],
      monthNames: [],
      customLists: {},
    })

    store.setter(setFillSeriesLocaleAtom, weekdayLocale)
    expect(store.getter(fillSeriesLocaleAtom)).toEqual(weekdayLocale)
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
