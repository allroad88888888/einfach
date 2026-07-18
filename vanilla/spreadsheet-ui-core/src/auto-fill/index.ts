import { atom, type Atom } from '@einfach/core'
import type { DisplayCell } from '../backend/types'
import type {
  FillSeriesDetectionResult,
  FillSeriesLocaleOptions,
} from './types'

export * from './types'

function freezeLocaleStringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    return null
  }

  return Object.freeze([...value]) as string[]
}

function isLocaleRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function normalizeFillSeriesLocale(value: unknown): FillSeriesLocaleOptions | null {
  try {
    if (!isLocaleRecord(value)) return null
    const weekdayNames = freezeLocaleStringList(
      value.weekdayNames === undefined ? [] : value.weekdayNames,
    )
    const monthNames = freezeLocaleStringList(
      value.monthNames === undefined ? [] : value.monthNames,
    )
    const rawCustomLists = value.customLists === undefined ? {} : value.customLists

    if (
      weekdayNames === null ||
      monthNames === null ||
      !isLocaleRecord(rawCustomLists)
    ) {
      return null
    }

    const customLists: Record<string, string[]> = {}
    for (const [name, rawList] of Object.entries(rawCustomLists)) {
      const list = freezeLocaleStringList(rawList)
      if (list === null) return null
      Object.defineProperty(customLists, name, {
        configurable: false,
        enumerable: true,
        value: list,
        writable: false,
      })
    }

    return Object.freeze({
      weekdayNames,
      monthNames,
      customLists: Object.freeze(customLists),
    })
  } catch {
    return null
  }
}

const DEFAULT_LOCALE = normalizeFillSeriesLocale({})!

const fillSeriesLocaleBackingAtom = atom<FillSeriesLocaleOptions>(DEFAULT_LOCALE)

export const fillSeriesLocaleAtom: Atom<FillSeriesLocaleOptions> = atom((get) =>
  get(fillSeriesLocaleBackingAtom),
)
fillSeriesLocaleAtom.debugLabel = 'spreadsheet.autoFill.locale'

export const setFillSeriesLocaleAtom = atom(
  (get) => get(fillSeriesLocaleAtom),
  (_get, set, locale: FillSeriesLocaleOptions) => {
    const normalized = normalizeFillSeriesLocale(locale)
    if (normalized === null) return
    set(fillSeriesLocaleBackingAtom, normalized)
  },
)
setFillSeriesLocaleAtom.debugLabel = 'spreadsheet.autoFill.setLocale'

function isConsecutiveInList(values: string[], list: string[]): boolean {
  if (list.length === 0) return false
  const indices = values.map((v) => list.findIndex((name) => name.toLowerCase() === v.toLowerCase()))
  if (indices.some((i) => i === -1)) return false
  const n = list.length
  for (let i = 1; i < indices.length; i++) {
    if ((indices[i] - indices[i - 1] + n) % n !== 1) return false
  }
  return true
}

export const FILL_SERIES_NUMBER_EPSILON = 1e-10

export function isFillSeriesInteger(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Math.abs(value - Math.round(value)) < FILL_SERIES_NUMBER_EPSILON
  )
}

export function detectFillSeries(
  source: readonly DisplayCell[],
  locale: FillSeriesLocaleOptions,
): FillSeriesDetectionResult {
  if (source.length <= 1) {
    return { kind: 'copy' }
  }

  const values = source.map((c) => c.displayValue)
  const allNumeric = source.every(
    (cell) =>
      cell.formula === undefined &&
      cell.valueKind === 'number' &&
      typeof cell.numericValue === 'number' &&
      Number.isFinite(cell.numericValue),
  )

  if (allNumeric) {
    const numericValues = source.map((cell) => cell.numericValue!)
    const steps = numericValues.slice(1).map((v, i) => v - numericValues[i])
    const firstStep = steps[0]
    const allSameStep = steps.every(
      (step) => Math.abs(step - firstStep) < FILL_SERIES_NUMBER_EPSILON,
    )

    if (!allSameStep || Math.abs(firstStep) < FILL_SERIES_NUMBER_EPSILON) {
      return { kind: 'copy' }
    }

    if (isFillSeriesInteger(firstStep) && numericValues.every(isFillSeriesInteger)) {
      return { kind: 'integer-step', step: Math.round(firstStep) }
    }

    return { kind: 'decimal-step', step: firstStep }
  }

  const weekdayNames = locale.weekdayNames ?? []
  if (weekdayNames.length > 0 && isConsecutiveInList(values, weekdayNames)) {
    return { kind: 'weekday-name' }
  }

  const monthNames = locale.monthNames ?? []
  if (monthNames.length > 0 && isConsecutiveInList(values, monthNames)) {
    return { kind: 'month-name' }
  }

  return { kind: 'copy' }
}
