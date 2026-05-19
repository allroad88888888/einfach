/**
 * Wave 6.3 — projection-layer number-format pipeline.
 *
 * `SpreadsheetNumberFormat` lives in `backend/types.ts` (re-exported here for
 * ergonomics).  This module owns the runtime: given a `SpreadsheetNumberFormat`
 * variant and a numeric value, return a `{ text, color }` pair the projection
 * can drop onto `DisplayCell.displayValue`.
 *
 * The Rust engine never sees this code — it stores raw values and the
 * projection layer formats on demand.  The JS reference backend
 * (`solid/excel/src-vnext/adapter/static-backend.ts`) wires this helper into
 * its projection path.
 */

import type {
  SpreadsheetNumberFormat,
  SpreadsheetNumberFormatNegative,
} from '../../backend/types'
import {
  DEFAULT_LOCALE,
  formatCustomNumber,
  resolveLocale,
  type NumberFormatLocale,
  type NumberFormatResult,
} from './numberFormatParser'

export type {
  SpreadsheetNumberFormat,
  SpreadsheetNumberFormatNegative,
  SpreadsheetNumberFormatFractionDenominator,
} from '../../backend/types'
export {
  parseCustomFormat,
  formatCustomNumber,
  formatWithParsed,
  splitSections,
  parseSection,
  resolveLocale,
  DEFAULT_LOCALE,
  excelSerialToDate,
  type FormatOptions,
  type NumberFormatLocale,
  type NumberFormatResult,
  type NumberFormatSection,
  type NumberFormatToken,
  type ParsedNumberFormat,
} from './numberFormatParser'

const NEGATIVE_VARIANT_COLOR: Record<SpreadsheetNumberFormatNegative, string | undefined> = {
  minus: undefined,
  red: '#ff0000',
  parens: undefined,
  'red-parens': '#ff0000',
}

export interface FormatNumberValueOptions {
  locale?: string | NumberFormatLocale
}

/**
 * Public entry point. Returns the rendered text plus an optional color
 * (already resolved to a hex string) the renderer can paint.
 */
export function formatNumberValue(
  numberFormat: SpreadsheetNumberFormat | undefined,
  value: unknown,
  options: FormatNumberValueOptions = {},
): NumberFormatResult {
  const locale =
    typeof options.locale === 'string'
      ? resolveLocale(options.locale)
      : options.locale ?? DEFAULT_LOCALE

  if (!numberFormat || numberFormat.kind === 'general') {
    return formatGeneral(value, locale)
  }
  if (numberFormat.kind === 'text') {
    return { text: stringifyForText(value) }
  }
  if (numberFormat.kind === 'custom') {
    return formatCustomNumber(numberFormat.pattern, value, { locale })
  }
  if (numberFormat.kind === 'date') {
    return formatCustomNumber(numberFormat.pattern ?? 'yyyy-mm-dd', value, { locale })
  }
  if (numberFormat.kind === 'time') {
    return formatCustomNumber(numberFormat.pattern ?? 'hh:mm:ss', value, { locale })
  }
  if (numberFormat.kind === 'special') {
    return formatSpecial(numberFormat.preset, value, locale)
  }
  if (numberFormat.kind === 'fraction') {
    return formatFraction(numberFormat.denominator, value)
  }
  if (numberFormat.kind === 'scientific') {
    return formatScientific(numberFormat.digits ?? 2, value, locale)
  }
  if (numberFormat.kind === 'accounting') {
    return formatAccounting(
      numberFormat.symbol ?? locale.currencySymbol,
      numberFormat.digits ?? 2,
      value,
      locale,
    )
  }
  // number / decimal / percent / percentage / currency
  return formatViaCustomPattern(numberFormat, value, locale)
}

function formatGeneral(value: unknown, locale: NumberFormatLocale): NumberFormatResult {
  if (value === null || value === undefined) return { text: '' }
  if (typeof value === 'string') return { text: value }
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE' }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { text: String(value) }
    return { text: stringifyGeneral(value, locale) }
  }
  return { text: String(value) }
}

function stringifyGeneral(value: number, locale: NumberFormatLocale): string {
  let raw = String(value)
  if (locale.decimalSeparator !== '.') {
    raw = raw.replace('.', locale.decimalSeparator)
  }
  return raw
}

function stringifyForText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}

function digitsBlock(digits: number, thousands: boolean): string {
  const integerPart = thousands ? '#,##0' : '0'
  if (digits <= 0) return integerPart
  return `${integerPart}.${'0'.repeat(digits)}`
}

function buildSectionedPattern(
  positive: string,
  negative: SpreadsheetNumberFormatNegative,
  base: string,
): string {
  if (negative === 'minus') return positive
  if (negative === 'red') return `${positive};[Red]-${base}`
  if (negative === 'parens') return `${positive};(${base})`
  return `${positive};[Red](${base})`
}

function formatViaCustomPattern(
  format: Extract<
    SpreadsheetNumberFormat,
    { kind: 'number' | 'decimal' | 'percent' | 'percentage' | 'currency' }
  >,
  value: unknown,
  locale: NumberFormatLocale,
): NumberFormatResult {
  const negative: SpreadsheetNumberFormatNegative = format.negative ?? 'minus'
  if (format.kind === 'number' || format.kind === 'decimal') {
    const digits = format.digits ?? 2
    const thousands = format.thousands ?? false
    const base = digitsBlock(digits, thousands)
    const pattern = buildSectionedPattern(base, negative, base)
    const result = formatCustomNumber(pattern, value, { locale })
    return applyNegativeMeta(result, value, negative)
  }
  if (format.kind === 'percent' || format.kind === 'percentage') {
    const digits = format.digits ?? 0
    const base = digitsBlock(digits, false) + '%'
    const pattern = buildSectionedPattern(base, negative, base)
    const result = formatCustomNumber(pattern, value, { locale })
    return applyNegativeMeta(result, value, negative)
  }
  // currency
  const symbol = format.symbol ?? locale.currencySymbol
  const digits = format.digits ?? 2
  const baseDigits = digitsBlock(digits, true)
  const base = `"${symbol}"${baseDigits}`
  const pattern = buildSectionedPattern(base, negative, base)
  const result = formatCustomNumber(pattern, value, { locale })
  return applyNegativeMeta(result, value, negative)
}

function applyNegativeMeta(
  result: NumberFormatResult,
  value: unknown,
  negative: SpreadsheetNumberFormatNegative,
): NumberFormatResult {
  if (typeof value !== 'number' || value >= 0) return result
  const colorOverride = NEGATIVE_VARIANT_COLOR[negative]
  if (colorOverride && !result.color) {
    return { text: result.text, color: colorOverride }
  }
  return result
}

function formatAccounting(
  symbol: string,
  digits: number,
  value: unknown,
  locale: NumberFormatLocale,
): NumberFormatResult {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return formatGeneral(value, locale)
  }
  if (value === 0) {
    return { text: `${symbol} -${' '.repeat(Math.max(0, digits))}` }
  }
  const baseDigits = digitsBlock(digits, true)
  const positive = `"${symbol}" ${baseDigits}`
  const negative = `"${symbol}" (${baseDigits})`
  const pattern = `${positive};${negative};"${symbol}" -`
  return formatCustomNumber(pattern, value, { locale })
}

function formatScientific(
  digits: number,
  value: unknown,
  locale: NumberFormatLocale,
): NumberFormatResult {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return formatGeneral(value, locale)
  }
  const exponential = value.toExponential(Math.max(0, digits))
  const match = /^(-?)(\d+(?:\.\d+)?)e([+-])(\d+)$/.exec(exponential)
  if (!match) return { text: exponential }
  const [, sign, mantissa, expSign, expDigits] = match
  const mantissaLocalized =
    locale.decimalSeparator === '.' ? mantissa : mantissa.replace('.', locale.decimalSeparator)
  const exp = expDigits.padStart(2, '0')
  return { text: `${sign}${mantissaLocalized}E${expSign}${exp}` }
}

type FractionDenominator = 'one-digit' | 'two-digit' | 'three-digit' | number | undefined

function formatFraction(
  denominator: FractionDenominator,
  value: unknown,
): NumberFormatResult {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { text: value === undefined || value === null ? '' : String(value) }
  }
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  const whole = Math.floor(abs)
  const frac = abs - whole

  if (frac === 0) return { text: `${sign}${whole}` }

  const maxDenominator = pickMaxDenominator(denominator)
  const fixed = typeof denominator === 'number' ? denominator : undefined
  const approx = fixed
    ? approximateFractionFixed(frac, fixed)
    : approximateFraction(frac, maxDenominator)

  if (approx.numerator === 0) return { text: `${sign}${whole}` }
  if (approx.numerator === approx.denominator) {
    return { text: `${sign}${whole + 1}` }
  }
  if (whole === 0) {
    return { text: `${sign}${approx.numerator}/${approx.denominator}` }
  }
  return { text: `${sign}${whole} ${approx.numerator}/${approx.denominator}` }
}

function pickMaxDenominator(denominator: FractionDenominator): number {
  if (typeof denominator === 'number') return denominator
  if (denominator === 'two-digit') return 99
  if (denominator === 'three-digit') return 999
  return 9
}

function approximateFractionFixed(value: number, denominator: number): {
  numerator: number
  denominator: number
} {
  const numerator = Math.round(value * denominator)
  return { numerator, denominator }
}

function approximateFraction(value: number, maxDenominator: number): {
  numerator: number
  denominator: number
} {
  let bestNum = 0
  let bestDen = 1
  let bestErr = Math.abs(value)
  for (let den = 1; den <= maxDenominator; den += 1) {
    const num = Math.round(value * den)
    const err = Math.abs(value - num / den)
    if (err < bestErr - 1e-12) {
      bestErr = err
      bestNum = num
      bestDen = den
    }
  }
  return { numerator: bestNum, denominator: bestDen }
}

function formatSpecial(
  preset: string,
  value: unknown,
  locale: NumberFormatLocale,
): NumberFormatResult {
  const raw = typeof value === 'number' ? String(Math.trunc(value)) : String(value ?? '')
  if (preset === 'zip-code') {
    return { text: raw.padStart(5, '0') }
  }
  if (preset === 'zip-plus-4') {
    const digits = raw.replace(/\D/g, '').padStart(9, '0')
    return { text: `${digits.slice(0, 5)}-${digits.slice(5, 9)}` }
  }
  if (preset === 'phone-us') {
    const digits = raw.replace(/\D/g, '').padStart(10, '0')
    return { text: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}` }
  }
  if (preset === 'ssn-us') {
    const digits = raw.replace(/\D/g, '').padStart(9, '0')
    return { text: `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 9)}` }
  }
  return formatGeneral(value, locale)
}

/**
 * Convenience that mirrors `formatNumberValue` but exposes a string-only
 * return for adapters that don't carry the color hint.
 */
export function formatNumberToText(
  numberFormat: SpreadsheetNumberFormat | undefined,
  value: unknown,
  options: FormatNumberValueOptions = {},
): string {
  return formatNumberValue(numberFormat, value, options).text
}
