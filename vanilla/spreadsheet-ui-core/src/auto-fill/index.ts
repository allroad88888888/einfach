import { atom } from '@einfach/core'
import type { DisplayCell } from '../backend/types'
import type {
  FillSeriesDetectionResult,
  FillSeriesLocaleOptions,
} from './types'

export * from './types'

const DEFAULT_LOCALE: FillSeriesLocaleOptions = {
  weekdayNames: [],
  monthNames: [],
  customLists: {},
}

export const fillSeriesLocaleAtom = atom<FillSeriesLocaleOptions>(DEFAULT_LOCALE)
fillSeriesLocaleAtom.debugLabel = 'spreadsheet.autoFill.locale'

export const setFillSeriesLocaleAtom = atom(
  (get) => get(fillSeriesLocaleAtom),
  (_get, set, locale: FillSeriesLocaleOptions) => {
    set(fillSeriesLocaleAtom, locale)
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

const EPSILON = 1e-10

function isInteger(v: number): boolean {
  return Math.abs(v - Math.round(v)) < EPSILON
}

export function detectFillSeries(
  source: readonly DisplayCell[],
  locale: FillSeriesLocaleOptions,
): FillSeriesDetectionResult {
  if (source.length <= 1) {
    return { kind: 'copy' }
  }

  const values = source.map((c) => c.displayValue)
  const numericValues = values.map((v) => parseFloat(v))
  const allNumeric = numericValues.every((v, i) => !isNaN(v) && values[i].trim() !== '')

  if (allNumeric) {
    const steps = numericValues.slice(1).map((v, i) => v - numericValues[i])
    const firstStep = steps[0]
    const allSameStep = steps.every((s) => Math.abs(s - firstStep) < EPSILON)

    if (!allSameStep || Math.abs(firstStep) < EPSILON) {
      return { kind: 'copy' }
    }

    if (isInteger(firstStep) && numericValues.every((v) => isInteger(v))) {
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
