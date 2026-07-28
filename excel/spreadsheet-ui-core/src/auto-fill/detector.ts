import { atom, type Atom } from '@einfach/core'
import type { DisplayCell } from '../backend/types'
import type {
  FillSeriesDetectionResult,
  FillSeriesKind,
  FillSeriesListWitness,
  FillSeriesLocaleOptions,
  FillSeriesTextPattern,
} from './types'

export const BUILTIN_FILL_SERIES_WEEKDAY_NAMES = Object.freeze([
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
]) as readonly string[]

export const BUILTIN_FILL_SERIES_MONTH_NAMES = Object.freeze([
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]) as readonly string[]

export const BUILTIN_FILL_SERIES_WEEKDAY_LONG_NAMES = Object.freeze([
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
]) as readonly string[]

export const BUILTIN_FILL_SERIES_MONTH_LONG_NAMES = Object.freeze([
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]) as readonly string[]

export const FILL_SERIES_LIST_MAX_ITEMS = 512
export const DEFAULT_FILL_SERIES_LOCALE = 'en'
const SUPPORTED_FILL_SERIES_LOCALE_LANGUAGES = new Set(['en', 'zh', 'tr', 'az'])

export function isReservedFillSeriesListName(listName: string): boolean {
  // These prefixes are protocol identifiers, not user-facing language.
  const normalized = listName.toLowerCase()
  return normalized.startsWith('builtin-') || normalized.startsWith('locale-')
}

export function canonicalizeFillSeriesLocale(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  try {
    const canonical = Intl.getCanonicalLocales(value)
    if (canonical.length !== 1) return null

    const [language, ...remaining] = canonical[0].split('-')
    if (!SUPPORTED_FILL_SERIES_LOCALE_LANGUAGES.has(language)) return null

    const isCanonicalScript = (part: string) => /^[A-Z][a-z]{3}$/.test(part)
    const isCanonicalRegion = (part: string) => /^(?:[A-Z]{2}|\d{3})$/.test(part)
    const hasSupportedShape =
      remaining.length === 0 ||
      (remaining.length === 1 &&
        (isCanonicalScript(remaining[0]) || isCanonicalRegion(remaining[0]))) ||
      (remaining.length === 2 && isCanonicalScript(remaining[0]) && isCanonicalRegion(remaining[1]))

    return hasSupportedShape ? canonical[0] : null
  } catch {
    return null
  }
}

/** Shared detector/backend text fold. Callers must pass a supported canonical locale. */
export function foldFillSeriesText(value: string, locale: string): string {
  return value.toLocaleLowerCase(locale)
}

export function normalizeFillSeriesListWitness(
  value: unknown,
): (FillSeriesListWitness & { readonly locale: string }) | null {
  if (
    !isLocaleRecord(value) ||
    typeof value.listName !== 'string' ||
    value.listName.trim().length === 0 ||
    typeof value.locale !== 'string' ||
    !Array.isArray(value.values) ||
    value.values.length < 2 ||
    value.values.length > FILL_SERIES_LIST_MAX_ITEMS ||
    !value.values.every((item) => typeof item === 'string' && item.trim().length > 0)
  ) {
    return null
  }

  const locale = canonicalizeFillSeriesLocale(value.locale)
  // Wire witnesses are already normalized by the locale command. Reject a
  // rewritten/non-canonical locale rather than silently changing semantics.
  if (locale === null || locale !== value.locale) return null

  const values = [...value.values] as string[]
  const normalizedValues = values.map((item) => foldFillSeriesText(item, locale))
  if (new Set(normalizedValues).size !== normalizedValues.length) {
    return null
  }

  return Object.freeze({
    listName: value.listName,
    values: Object.freeze(values),
    locale,
  })
}

export function normalizeCustomFillSeriesListWitness(
  value: unknown,
): (FillSeriesListWitness & { readonly locale: string }) | null {
  const witness = normalizeFillSeriesListWitness(value)
  return witness && !isReservedFillSeriesListName(witness.listName) ? witness : null
}

function normalizeOptionalLocaleList(
  listName: string,
  value: unknown,
  locale: string,
): string[] | null {
  if (Array.isArray(value) && value.length === 0) {
    return Object.freeze([]) as unknown as string[]
  }
  const witness = normalizeFillSeriesListWitness({ listName, values: value, locale })
  return witness ? (witness.values as string[]) : null
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
    const locale = canonicalizeFillSeriesLocale(
      value.locale === undefined ? DEFAULT_FILL_SERIES_LOCALE : value.locale,
    )
    if (locale === null) return null
    const weekdayNames = normalizeOptionalLocaleList(
      'locale-weekday',
      value.weekdayNames === undefined ? [] : value.weekdayNames,
      locale,
    )
    const monthNames = normalizeOptionalLocaleList(
      'locale-month',
      value.monthNames === undefined ? [] : value.monthNames,
      locale,
    )
    const rawCustomLists = value.customLists === undefined ? {} : value.customLists

    if (weekdayNames === null || monthNames === null || !isLocaleRecord(rawCustomLists)) {
      return null
    }

    const customLists: Record<string, string[]> = {}
    for (const [name, rawList] of Object.entries(rawCustomLists)) {
      const witness = normalizeCustomFillSeriesListWitness({
        listName: name,
        values: rawList,
        locale,
      })
      if (witness === null) return null
      Object.defineProperty(customLists, name, {
        configurable: false,
        enumerable: true,
        value: witness.values,
        writable: false,
      })
    }

    return Object.freeze({
      locale,
      weekdayNames,
      monthNames,
      customLists: Object.freeze(customLists),
    })
  } catch {
    return null
  }
}

const DEFAULT_LOCALE = normalizeFillSeriesLocale({
  locale: DEFAULT_FILL_SERIES_LOCALE,
  weekdayNames: BUILTIN_FILL_SERIES_WEEKDAY_NAMES,
  monthNames: BUILTIN_FILL_SERIES_MONTH_NAMES,
})!

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

export const FILL_SERIES_NUMBER_EPSILON = 1e-10

export function isFillSeriesInteger(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value - Math.round(value)) < FILL_SERIES_NUMBER_EPSILON
}

export interface FillSeriesLinearTrend {
  readonly slope: number
  readonly intercept: number
}

export function calculateFillSeriesLinearTrend(
  values: readonly number[],
): FillSeriesLinearTrend | null {
  if (values.length < 2 || !values.every(Number.isFinite)) {
    return null
  }

  const meanX = (values.length - 1) / 2
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length
  if (!Number.isFinite(meanY)) return null

  let numerator = 0
  let denominator = 0
  for (let index = 0; index < values.length; index += 1) {
    const centeredX = index - meanX
    numerator += centeredX * (values[index] - meanY)
    denominator += centeredX * centeredX
  }
  if (!Number.isFinite(numerator) || denominator === 0) return null

  const slope = numerator / denominator
  const intercept = meanY - slope * meanX
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null
  return { slope, intercept }
}

export interface ParsedFillSeriesTextNumber extends FillSeriesTextPattern {
  readonly value: number
}

export function parseFillSeriesTextNumber(value: string): ParsedFillSeriesTextNumber | null {
  const match = /^(.*?)(-?\d+)(\D*)$/.exec(value)
  if (!match) return null

  const prefix = match[1]
  const suffix = match[3]
  // A label must establish a textual prefix. This keeps parseFloat-compatible
  // junk such as "1x" out of the pattern pipeline while allowing Item1 and
  // Item1-final.
  if (prefix.length === 0) return null

  const numericPart = match[2]
  const parsed = Number(numericPart)
  if (!Number.isSafeInteger(parsed)) return null
  return {
    prefix,
    suffix,
    width: numericPart.startsWith('-') ? numericPart.length - 1 : numericPart.length,
    value: parsed,
  }
}

export function formatFillSeriesTextNumber(
  pattern: FillSeriesTextPattern,
  value: number,
): string | null {
  if (!Number.isSafeInteger(value) || !Number.isSafeInteger(pattern.width) || pattern.width < 0) {
    return null
  }

  const absolute = String(Math.abs(value))
  const digits = pattern.width > 0 ? absolute.padStart(pattern.width, '0') : absolute
  return `${pattern.prefix}${value < 0 ? '-' : ''}${digits}${pattern.suffix}`
}

interface ExcelDateParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly fraction: number
}

export interface FillSeriesDateAnalysis {
  readonly kind: Extract<FillSeriesKind, 'date-day' | 'date-week' | 'date-month'>
  readonly step: number
  readonly preserveEndOfMonth: boolean
}

const MILLISECONDS_PER_DAY = 86_400_000
const EXCEL_1900_EPOCH_MS = Date.UTC(1899, 11, 31)

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInExcelMonth(year: number, month: number): number {
  if (year === 1900 && month === 2) return 29
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

function excelSerialToDateParts(serial: number): ExcelDateParts | null {
  if (!Number.isFinite(serial)) return null
  const wholeDays = Math.floor(serial)
  const fraction = serial - wholeDays
  if (wholeDays === 60) {
    return { year: 1900, month: 2, day: 29, fraction }
  }

  const adjustedDays = wholeDays > 60 ? wholeDays - 1 : wholeDays
  const date = new Date(EXCEL_1900_EPOCH_MS + adjustedDays * MILLISECONDS_PER_DAY)
  if (!Number.isFinite(date.getTime())) return null
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    fraction,
  }
}

function excelDatePartsToSerial(parts: ExcelDateParts): number | null {
  if (
    !Number.isSafeInteger(parts.year) ||
    !Number.isSafeInteger(parts.month) ||
    !Number.isSafeInteger(parts.day) ||
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > daysInExcelMonth(parts.year, parts.month) ||
    !Number.isFinite(parts.fraction)
  ) {
    return null
  }
  if (parts.year === 1900 && parts.month === 2 && parts.day === 29) {
    return 60 + parts.fraction
  }

  // Date.UTC treats years 0..99 as 1900..1999, so setUTCFullYear explicitly.
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day)
  const dateMs = date.getTime()
  if (!Number.isFinite(dateMs)) return null
  let serial = (dateMs - EXCEL_1900_EPOCH_MS) / MILLISECONDS_PER_DAY
  if (parts.year > 1900 || (parts.year === 1900 && parts.month > 2)) {
    serial += 1
  }
  serial += parts.fraction
  return Number.isFinite(serial) ? serial : null
}

function addExcelCalendarMonths(
  anchorSerial: number,
  monthOffset: number,
  preserveEndOfMonth: boolean,
): number | null {
  if (!Number.isSafeInteger(monthOffset)) return null
  const anchor = excelSerialToDateParts(anchorSerial)
  if (!anchor) return null

  const absoluteMonth = anchor.year * 12 + (anchor.month - 1) + monthOffset
  if (!Number.isSafeInteger(absoluteMonth)) return null
  const year = Math.floor(absoluteMonth / 12)
  const month = (((absoluteMonth % 12) + 12) % 12) + 1
  const day = preserveEndOfMonth
    ? daysInExcelMonth(year, month)
    : Math.min(anchor.day, daysInExcelMonth(year, month))
  return excelDatePartsToSerial({ year, month, day, fraction: anchor.fraction })
}

function fillSeriesNumbersMatch(actual: number, expected: number): boolean {
  return (
    Number.isFinite(actual) &&
    Number.isFinite(expected) &&
    Math.abs(actual - expected) < FILL_SERIES_NUMBER_EPSILON
  )
}

export function analyzeFillSeriesDates(values: readonly number[]): FillSeriesDateAnalysis | null {
  if (values.length === 0 || !values.every(Number.isFinite)) return null
  if (values.length === 1) {
    return { kind: 'date-day', step: 1, preserveEndOfMonth: false }
  }

  const firstParts = excelSerialToDateParts(values[0])
  const secondParts = excelSerialToDateParts(values[1])
  if (!firstParts || !secondParts) return null
  const monthStep = (secondParts.year - firstParts.year) * 12 + secondParts.month - firstParts.month
  if (Number.isSafeInteger(monthStep) && monthStep !== 0) {
    const firstIsMonthEnd = firstParts.day === daysInExcelMonth(firstParts.year, firstParts.month)
    const candidates = firstIsMonthEnd ? [true, false] : [false]
    for (const preserveEndOfMonth of candidates) {
      const matches = values.every((value, index) => {
        const expected = addExcelCalendarMonths(values[0], monthStep * index, preserveEndOfMonth)
        return expected !== null && fillSeriesNumbersMatch(value, expected)
      })
      if (matches) {
        return {
          kind: 'date-month',
          step: monthStep,
          preserveEndOfMonth,
        }
      }
    }
  }

  const rawStep = values[1] - values[0]
  if (!isFillSeriesInteger(rawStep) || Math.abs(rawStep) < FILL_SERIES_NUMBER_EPSILON) {
    return null
  }
  const dayStep = Math.round(rawStep)
  if (!values.every((value, index) => fillSeriesNumbersMatch(value, values[0] + dayStep * index))) {
    return null
  }
  if (dayStep % 7 === 0) {
    return {
      kind: 'date-week',
      step: dayStep / 7,
      preserveEndOfMonth: false,
    }
  }
  return { kind: 'date-day', step: dayStep, preserveEndOfMonth: false }
}

export function getFillSeriesDateValue(
  anchorSerial: number,
  kind: FillSeriesDateAnalysis['kind'],
  step: number,
  sourceRelativeIndex: number,
  preserveEndOfMonth = false,
): number | null {
  if (!Number.isSafeInteger(step) || step === 0 || !Number.isSafeInteger(sourceRelativeIndex)) {
    return null
  }
  if (kind === 'date-month') {
    return addExcelCalendarMonths(anchorSerial, step * sourceRelativeIndex, preserveEndOfMonth)
  }
  const dayMultiplier = kind === 'date-week' ? 7 : 1
  const value = anchorSerial + step * sourceRelativeIndex * dayMultiplier
  return Number.isFinite(value) ? value : null
}

interface FillSeriesListCandidate {
  readonly kind: Extract<FillSeriesKind, 'weekday-name' | 'month-name' | 'custom-list'>
  readonly listName: string
  readonly values: readonly string[]
  readonly locale: string
}

function detectListStep(
  values: readonly string[],
  list: readonly string[],
  locale: string,
): number | null {
  if (values.length === 0 || list.length < 2) return null
  const normalized = list.map((value) => foldFillSeriesText(value, locale))
  if (new Set(normalized).size !== normalized.length) return null
  const indices = values.map((value) => normalized.indexOf(foldFillSeriesText(value, locale)))
  if (indices.some((index) => index < 0)) return null
  if (indices.length === 1) return 1

  const forwardDelta = (indices[1] - indices[0] + list.length) % list.length
  const step = forwardDelta === 1 ? 1 : forwardDelta === list.length - 1 ? -1 : null
  if (step === null) return null
  return indices.every(
    (index, sourceIndex) =>
      index === (((indices[0] + step * sourceIndex) % list.length) + list.length) % list.length,
  )
    ? step
    : null
}

function listCandidates(locale: FillSeriesLocaleOptions): FillSeriesListCandidate[] {
  const candidates: FillSeriesListCandidate[] = [
    {
      kind: 'weekday-name',
      listName: 'builtin-weekday-short',
      values: BUILTIN_FILL_SERIES_WEEKDAY_NAMES,
      locale: DEFAULT_FILL_SERIES_LOCALE,
    },
    {
      kind: 'weekday-name',
      listName: 'builtin-weekday-long',
      values: BUILTIN_FILL_SERIES_WEEKDAY_LONG_NAMES,
      locale: DEFAULT_FILL_SERIES_LOCALE,
    },
    {
      kind: 'month-name',
      listName: 'builtin-month-short',
      values: BUILTIN_FILL_SERIES_MONTH_NAMES,
      locale: DEFAULT_FILL_SERIES_LOCALE,
    },
    {
      kind: 'month-name',
      listName: 'builtin-month-long',
      values: BUILTIN_FILL_SERIES_MONTH_LONG_NAMES,
      locale: DEFAULT_FILL_SERIES_LOCALE,
    },
  ]
  const localeTag = canonicalizeFillSeriesLocale(
    locale.locale === undefined ? DEFAULT_FILL_SERIES_LOCALE : locale.locale,
  )
  // Built-ins have their own fixed locale witness and remain usable, but
  // malformed host locale facts must never be reinterpreted under `en`.
  if (localeTag === null) return candidates
  const localeWeekdays = normalizeFillSeriesListWitness({
    listName: 'locale-weekday',
    values: locale.weekdayNames,
    locale: localeTag,
  })
  if (localeWeekdays) {
    candidates.push({
      kind: 'weekday-name',
      listName: localeWeekdays.listName,
      values: localeWeekdays.values,
      locale: localeWeekdays.locale,
    })
  }
  const localeMonths = normalizeFillSeriesListWitness({
    listName: 'locale-month',
    values: locale.monthNames,
    locale: localeTag,
  })
  if (localeMonths) {
    candidates.push({
      kind: 'month-name',
      listName: localeMonths.listName,
      values: localeMonths.values,
      locale: localeMonths.locale,
    })
  }
  for (const [listName, values] of Object.entries(locale.customLists ?? {})) {
    const witness = normalizeCustomFillSeriesListWitness({ listName, values, locale: localeTag })
    if (!witness) continue
    candidates.push({
      kind: 'custom-list',
      listName: witness.listName,
      values: witness.values,
      locale: witness.locale,
    })
  }
  return candidates
}

export function detectFillSeries(
  source: readonly DisplayCell[],
  locale: FillSeriesLocaleOptions,
): FillSeriesDetectionResult {
  if (source.length === 0) return { kind: 'copy' }

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
    const allDateFormatted = source.every((cell) => cell.format?.numberFormat?.kind === 'date')
    if (allDateFormatted) {
      const dateSeries = analyzeFillSeriesDates(numericValues)
      if (dateSeries) {
        return { kind: dateSeries.kind, step: dateSeries.step }
      }
      return { kind: 'copy' }
    }

    if (numericValues.length <= 1) return { kind: 'copy' }
    const steps = numericValues.slice(1).map((v, i) => v - numericValues[i])
    const firstStep = steps[0]
    const allSameStep = steps.every(
      (step) => Math.abs(step - firstStep) < FILL_SERIES_NUMBER_EPSILON,
    )

    if (allSameStep && Math.abs(firstStep) >= FILL_SERIES_NUMBER_EPSILON) {
      if (isFillSeriesInteger(firstStep) && numericValues.every(isFillSeriesInteger)) {
        return { kind: 'integer-step', step: Math.round(firstStep) }
      }

      return { kind: 'decimal-step', step: firstStep }
    }

    if (numericValues.length < 3) {
      return { kind: 'copy' }
    }

    const trend = calculateFillSeriesLinearTrend(numericValues)
    if (!trend || Math.abs(trend.slope) < FILL_SERIES_NUMBER_EPSILON) {
      return { kind: 'copy' }
    }
    return { kind: 'linear-trend', step: trend.slope }
  }

  const textSource = source.every(
    (cell) =>
      cell.formula === undefined &&
      cell.valueKind !== 'number' &&
      cell.valueKind !== 'boolean' &&
      cell.valueKind !== 'error',
  )
  if (!textSource) return { kind: 'copy' }

  const parsedTextNumbers = values.map(parseFillSeriesTextNumber)
  if (parsedTextNumbers.every((value): value is ParsedFillSeriesTextNumber => value !== null)) {
    const first = parsedTextNumbers[0]
    const sameAffixes = parsedTextNumbers.every(
      (value) => value.prefix === first.prefix && value.suffix === first.suffix,
    )
    if (sameAffixes) {
      const step =
        parsedTextNumbers.length === 1 ? 1 : parsedTextNumbers[1].value - parsedTextNumbers[0].value
      const uniform =
        Number.isSafeInteger(step) &&
        step !== 0 &&
        parsedTextNumbers.every(
          (value, index) => value.value === parsedTextNumbers[0].value + step * index,
        )
      if (uniform) {
        const establishedWidth = parsedTextNumbers.every((value) => value.width === first.width)
          ? first.width
          : 0
        return {
          kind: 'text-number',
          step,
          textPattern: {
            prefix: first.prefix,
            suffix: first.suffix,
            width: establishedWidth,
          },
        }
      }
    }
  }

  for (const candidate of listCandidates(locale)) {
    const step = detectListStep(values, candidate.values, candidate.locale)
    if (step !== null) {
      return {
        kind: candidate.kind,
        step,
        list: {
          listName: candidate.listName,
          values: [...candidate.values],
          locale: candidate.locale,
        },
        ...(candidate.kind === 'custom-list' ? { custom: { listName: candidate.listName } } : {}),
      }
    }
  }

  return { kind: 'copy' }
}
