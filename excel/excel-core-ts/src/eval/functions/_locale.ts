/**
 * Locale helpers shared by TEXT / DOLLAR / FIXED.
 *
 * The workbook owns a single BCP-47 locale tag (`'en-US'`, `'de-DE'`, ...).
 * Functions read it from `EvalContext.locale`; this file translates the
 * tag into the concrete separators / currency symbol they need.
 *
 * Hard rules:
 *  - Use only `Intl.*`. No bundled locale data.
 *  - On any Intl failure (unsupported locale, host-restricted ICU), fall
 *    back to the en-US shape. We never throw out of these helpers.
 */

import type { Value } from '../../types'

export interface NumberFormatParts {
  /** Group / thousands separator (e.g. `,` for en-US, `.` for de-DE). */
  readonly thousand: string
  /** Decimal separator (e.g. `.` for en-US, `,` for de-DE). */
  readonly decimal: string
  /** Currency symbol as Intl renders it (e.g. `$`, `€`, `￥`). */
  readonly currency: string
  /** ISO 4217 currency code used to drive Intl currency formatting. */
  readonly currencyCode: string
}

const EN_US_FALLBACK: NumberFormatParts = {
  thousand: ',',
  decimal: '.',
  currency: '$',
  currencyCode: 'USD',
}

/**
 * Minimal locale → ISO 4217 currency map. Excel always has a single
 * "active currency" per locale; we mirror that with a small lookup of the
 * common locales the host can reach via `setLocale`. Anything not listed
 * falls back to USD — `getNumberFormatParts` still asks Intl to extract
 * the actual symbol so the answer matches the host platform's
 * localization.
 *
 * Match order: exact tag wins (`en-GB`), then bare language (`en`),
 * then USD fallback. Tag matching is case-insensitive for the region
 * subtag because BCP-47 is case-insensitive in practice.
 */
const LOCALE_CURRENCY: ReadonlyArray<readonly [string, string]> = [
  ['en-US', 'USD'],
  ['en-CA', 'CAD'],
  ['en-GB', 'GBP'],
  ['en-AU', 'AUD'],
  ['de-DE', 'EUR'],
  ['de-AT', 'EUR'],
  ['fr-FR', 'EUR'],
  ['it-IT', 'EUR'],
  ['es-ES', 'EUR'],
  ['nl-NL', 'EUR'],
  ['pt-PT', 'EUR'],
  ['pt-BR', 'BRL'],
  ['ja-JP', 'JPY'],
  ['ko-KR', 'KRW'],
  ['zh-CN', 'CNY'],
  ['zh-TW', 'TWD'],
  ['zh-HK', 'HKD'],
  ['ru-RU', 'RUB'],
  ['hi-IN', 'INR'],
  ['ar-SA', 'SAR'],
  ['tr-TR', 'TRY'],
  ['pl-PL', 'PLN'],
  ['sv-SE', 'SEK'],
  ['da-DK', 'DKK'],
  ['nb-NO', 'NOK'],
  ['no-NO', 'NOK'],
  ['fi-FI', 'EUR'],
  ['cs-CZ', 'CZK'],
  ['hu-HU', 'HUF'],
  ['th-TH', 'THB'],
  ['vi-VN', 'VND'],
  ['id-ID', 'IDR'],
  ['ms-MY', 'MYR'],
]

const LANG_CURRENCY: ReadonlyArray<readonly [string, string]> = [
  ['en', 'USD'],
  ['de', 'EUR'],
  ['fr', 'EUR'],
  ['it', 'EUR'],
  ['es', 'EUR'],
  ['nl', 'EUR'],
  ['ja', 'JPY'],
  ['ko', 'KRW'],
  ['zh', 'CNY'],
  ['ru', 'RUB'],
  ['hi', 'INR'],
  ['pt', 'EUR'],
]

/**
 * Pick the ISO 4217 currency code Excel would use for this locale. Falls
 * back to USD when the locale isn't in either the exact-tag or bare-lang
 * lookup. We do NOT consult `Intl` for this — `Intl.NumberFormat` with
 * `style:'currency'` requires the caller to pick the code; the symbol it
 * renders is a function of that pick, not of the locale alone.
 */
function currencyCodeFor(locale: string): string {
  const trimmed = locale.trim()
  if (trimmed === '') return 'USD'
  // Case-insensitive exact-tag lookup.
  const lower = trimmed.toLowerCase()
  for (const [tag, code] of LOCALE_CURRENCY) {
    if (tag.toLowerCase() === lower) return code
  }
  // Bare language (first subtag) fallback.
  const lang = lower.split(/[-_]/)[0]
  if (lang) {
    for (const [l, code] of LANG_CURRENCY) {
      if (l === lang) return code
    }
  }
  return 'USD'
}

/**
 * Extract the separators + currency symbol an active locale uses. Built
 * on `Intl.NumberFormat.formatToParts` so we don't ship our own table.
 *
 * Resolution:
 *  1. `Intl.NumberFormat(locale)` with `1234.5` → take `group` + `decimal` parts.
 *  2. `Intl.NumberFormat(locale, {style:'currency', currency: ...})` with
 *     `1` → take the `currency` part.
 *  3. Any throw → en-US fallback.
 */
export function getNumberFormatParts(locale: string | undefined): NumberFormatParts {
  if (!locale) return EN_US_FALLBACK
  const currencyCode = currencyCodeFor(locale)
  try {
    const numFmt = new Intl.NumberFormat(locale)
    const numParts = numFmt.formatToParts(1234.5)
    let thousand = EN_US_FALLBACK.thousand
    let decimal = EN_US_FALLBACK.decimal
    for (const p of numParts) {
      if (p.type === 'group') thousand = p.value
      else if (p.type === 'decimal') decimal = p.value
    }

    let currency = EN_US_FALLBACK.currency
    try {
      const curFmt = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currencyCode,
        currencyDisplay: 'symbol',
      })
      const curParts = curFmt.formatToParts(1)
      for (const p of curParts) {
        if (p.type === 'currency') {
          currency = p.value
          break
        }
      }
    } catch {
      // Currency-style call failed (e.g. locale unsupported under the
      // {currency:...} option set). Keep the separators from step 1 and
      // fall back to the USD symbol — matches Excel's "if I don't know
      // your currency, show $" behaviour.
      currency = EN_US_FALLBACK.currency
    }
    return { thousand, decimal, currency, currencyCode }
  } catch {
    return EN_US_FALLBACK
  }
}

/**
 * Format a number through `Intl.NumberFormat` with explicit decimal
 * width + grouping toggle. Falls back to a manual en-US render on Intl
 * failure so DOLLAR / FIXED never throw out of cell evaluation.
 *
 * Note: callers that need the raw separators (TEXT's pattern engine)
 * should use `getNumberFormatParts` and assemble the output themselves —
 * this helper only covers the "decimal-fixed, optional grouping" case
 * that DOLLAR and FIXED need.
 */
export function formatNumber(
  value: number,
  locale: string | undefined,
  options: {
    readonly decimals: number
    readonly useGrouping: boolean
  },
): string {
  const decimals = Math.max(0, options.decimals | 0)
  try {
    return new Intl.NumberFormat(locale ?? 'en-US', {
      useGrouping: options.useGrouping,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value)
  } catch {
    // Manual en-US fallback — same shape as `formatThousandsFixed` in
    // text.ts but inlined to avoid the circular import.
    const abs = Math.abs(value).toFixed(decimals)
    const [whole, frac] = abs.split('.')
    const grouped = options.useGrouping ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole
    const body = frac !== undefined ? `${grouped}.${frac}` : grouped
    return value < 0 ? `-${body}` : body
  }
}

/**
 * Format a number as currency through `Intl.NumberFormat({style:'currency'})`
 * with `currencySign: 'accounting'`. That option drives the locale-aware
 * negative shape Excel's DOLLAR documents: en-US renders `($1,234.50)`,
 * de-DE renders `-1.234,50 €`, ja-JP renders `(￥1,235)`. Matches Excel's
 * "DOLLAR uses the platform's accounting convention" semantics.
 *
 * Falls back to a manual `$...` render with parentheses-on-negative on
 * Intl failure (en-US accounting shape).
 */
export function formatCurrency(
  value: number,
  locale: string | undefined,
  decimals: number,
): string {
  const safeDecimals = Math.max(0, decimals | 0)
  const code = currencyCodeFor(locale ?? 'en-US')
  try {
    return new Intl.NumberFormat(locale ?? 'en-US', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'symbol',
      currencySign: 'accounting',
      minimumFractionDigits: safeDecimals,
      maximumFractionDigits: safeDecimals,
    }).format(value)
  } catch {
    const abs = Math.abs(value).toFixed(safeDecimals)
    const [whole, frac] = abs.split('.')
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    const body = frac !== undefined ? `${grouped}.${frac}` : grouped
    return value < 0 ? `($${body})` : `$${body}`
  }
}

// Re-export the Value type purely so `text.ts` can import this file's
// helpers without re-importing from `../../types` for the assert below.
export type { Value }
