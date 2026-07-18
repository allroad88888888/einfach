import { createStore, type Atom } from '@einfach/core'
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

function numericCell(numericValue: number, displayValue = String(numericValue)) {
  return {
    row: 0,
    col: 0,
    displayValue,
    valueKind: 'number' as const,
    numericValue,
  }
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
    expect(detectFillSeries([numericCell(1), numericCell(2), numericCell(3)], noLocale))
      .toEqual({ kind: 'integer-step', step: 1 })
  })

  test('[10, 20, 30] → integer-step step 10', () => {
    expect(detectFillSeries([numericCell(10), numericCell(20), numericCell(30)], noLocale))
      .toEqual({ kind: 'integer-step', step: 10 })
  })

  test('[1.5, 3, 4.5] → decimal-step step 1.5', () => {
    expect(detectFillSeries([numericCell(1.5), numericCell(3), numericCell(4.5)], noLocale))
      .toEqual({ kind: 'decimal-step', step: 1.5 })
  })

  test('near-integer canonical values use the shared integer tolerance', () => {
    expect(
      detectFillSeries(
        [numericCell(1.00000000001), numericCell(2.00000000001)],
        noLocale,
      ),
    ).toEqual({ kind: 'integer-step', step: 1 })
    expect(
      detectFillSeries(
        [numericCell(-1.00000000001), numericCell(-2.00000000001)],
        noLocale,
      ),
    ).toEqual({ kind: 'integer-step', step: -1 })
  })

  test('[5, 5, 5] → copy (constant, no step)', () => {
    expect(detectFillSeries([numericCell(5), numericCell(5), numericCell(5)], noLocale))
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
      weekdayNames: [],
      monthNames: [],
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
      { weekdayNames: 'Mon' },
      { weekdayNames: null },
      { monthNames: ['Jan', 2] },
      { customLists: [] },
      { customLists: null },
      { customLists: { priority: ['low', false] } },
    ]) {
      expect(() => setRuntimeLocale(invalid)).not.toThrow()
      expect(store.getter(fillSeriesLocaleAtom)).toBe(before)
    }
  })

  test('keeps normal command-driven locale detection working', () => {
    const store = createStore()
    store.setter(setFillSeriesLocaleAtom, weekdayLocale)

    expect(
      detectFillSeries(
        [cell('Mon'), cell('Tue')],
        store.getter(fillSeriesLocaleAtom),
      ),
    ).toEqual({ kind: 'weekday-name' })
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
