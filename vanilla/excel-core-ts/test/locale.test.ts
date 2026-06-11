/**
 * Workbook-level locale tests.
 *
 * Exercises the `setLocale` / `getLocale` infrastructure end-to-end through
 * actual formula evaluation — TEXT / DOLLAR / FIXED are routed via the
 * workbook's evaluator, not called directly, so we also verify that:
 *  - The locale is threaded into `EvalContext` for every sheet.
 *  - `setLocale` triggers a recalc (formula cells re-derive with the new
 *    separators / currency).
 *  - `setLocale` inside `withBatch` defers the recalc to the outermost
 *    exit.
 *
 * Intl-quirks pinned:
 *  - Intl ja-JP currency renders the FULL-WIDTH yen sign `￥` (U+FFE5),
 *    not the half-width `¥` (U+00A5). We pin the platform output so a
 *    Node bump that changes the symbol surfaces here loudly.
 *  - Intl `currencySign: 'accounting'` renders negatives as `($1,234.50)`
 *    for en-US but `-1.234,50 €` for de-DE — matches Excel's
 *    locale-dependent DOLLAR behaviour.
 */

import { describe, expect, test } from '@jest/globals'

import { createWorkbook } from '../src/workbook'
import type { Value } from '../src/types'

function evalCell(input: string, locale?: string): Value {
  const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
  if (locale !== undefined) wb.setLocale(locale)
  wb.setCell('s1', 0, 0, input)
  return wb.store.getter(wb.sheet('s1')!.formulaCellAtom('0:0'))
}

const str = (value: string): Value => ({ kind: 'string', value })

describe('Workbook.setLocale / getLocale', () => {
  test('default locale is en-US', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    expect(wb.getLocale()).toBe('en-US')
  })

  test('setLocale updates getLocale return value', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setLocale('de-DE')
    expect(wb.getLocale()).toBe('de-DE')
    wb.setLocale('ja-JP')
    expect(wb.getLocale()).toBe('ja-JP')
  })

  test('setLocale rejects empty / non-string values', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    expect(() => wb.setLocale('')).toThrow()
    // The signature is `string`, but `unknown` casts should still bounce.
    expect(() => wb.setLocale(undefined as unknown as string)).toThrow()
  })
})

describe('TEXT — locale-aware separators', () => {
  test('en-US uses comma thousands + dot decimal', () => {
    expect(evalCell('=TEXT(1234.5,"#,##0.00")', 'en-US')).toEqual(str('1,234.50'))
  })

  test('de-DE swaps to dot thousands + comma decimal', () => {
    expect(evalCell('=TEXT(1234.5,"#,##0.00")', 'de-DE')).toEqual(str('1.234,50'))
  })

  test('en-US "#,##0" rounds + groups with comma', () => {
    expect(evalCell('=TEXT(1234567,"#,##0")', 'en-US')).toEqual(str('1,234,567'))
  })

  test('de-DE "#,##0" rounds + groups with dot', () => {
    expect(evalCell('=TEXT(1234567,"#,##0")', 'de-DE')).toEqual(str('1.234.567'))
  })

  test('de-DE "0.00" uses comma decimal', () => {
    expect(evalCell('=TEXT(3.14,"0.00")', 'de-DE')).toEqual(str('3,14'))
  })

  test('de-DE "0.00%" uses comma decimal', () => {
    // 0.5 → 50.00%, locale separator on the decimal.
    expect(evalCell('=TEXT(0.5,"0.00%")', 'de-DE')).toEqual(str('50,00%'))
  })

  test('[$-409] locale tag in custom format is stripped silently', () => {
    // Wave-1 behaviour: we parse but don't honor the LCID — workbook
    // locale wins. Result should still format per the active locale.
    expect(evalCell('=TEXT(1234.5,"[$-409]#,##0.00")', 'de-DE')).toEqual(str('1.234,50'))
  })
})

describe('DOLLAR — locale currency', () => {
  test('en-US default 2 decimals = "$1,234.50"', () => {
    expect(evalCell('=DOLLAR(1234.5)', 'en-US')).toEqual(str('$1,234.50'))
  })

  test('en-US negative renders as accounting parentheses', () => {
    expect(evalCell('=DOLLAR(-1234.5)', 'en-US')).toEqual(str('($1,234.50)'))
  })

  test('de-DE renders EUR with locale separators', () => {
    // Intl: "1.234,50 €" — note the non-breaking space (U+00A0) between
    // the amount and the currency symbol in some ICU builds, and a
    // regular space in others. We pin the Node version's exact output.
    const result = evalCell('=DOLLAR(1234.5)', 'de-DE') as { kind: 'string'; value: string }
    expect(result.kind).toBe('string')
    // Strip whitespace differences and compare on the visible glyphs —
    // this keeps the test portable across ICU minor versions while
    // pinning the locale-correct shape.
    expect(result.value.replace(/\s+/g, ' ')).toBe('1.234,50 €')
  })

  test('ja-JP renders yen with full-width sign and 0 decimals by default', () => {
    // Intl JPY: minimum/maximum fraction digits default to 0 in our
    // implementation. The full-width yen U+FFE5 (`￥`) is the ICU symbol.
    expect(evalCell('=DOLLAR(1234.5,0)', 'ja-JP')).toEqual(str('￥1,235'))
  })
})

describe('FIXED — locale separators', () => {
  test('en-US default 2 decimals + grouping', () => {
    expect(evalCell('=FIXED(1234.5)', 'en-US')).toEqual(str('1,234.50'))
  })

  test('de-DE swaps separators', () => {
    expect(evalCell('=FIXED(1234.5)', 'de-DE')).toEqual(str('1.234,50'))
  })

  test('no_commas=TRUE drops grouping under both locales', () => {
    expect(evalCell('=FIXED(1234.5,2,TRUE)', 'en-US')).toEqual(str('1234.50'))
    expect(evalCell('=FIXED(1234.5,2,TRUE)', 'de-DE')).toEqual(str('1234,50'))
  })

  test('negative numbers carry Intl-native sign per locale', () => {
    expect(evalCell('=FIXED(-1234.5)', 'en-US')).toEqual(str('-1,234.50'))
    expect(evalCell('=FIXED(-1234.5)', 'de-DE')).toEqual(str('-1.234,50'))
  })
})

describe('setLocale recalc', () => {
  test('formula re-evaluates when locale changes', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '=TEXT(1234.5,"#,##0.00")')
    const sheet = wb.sheet('s1')!
    expect(wb.store.getter(sheet.formulaCellAtom('0:0'))).toEqual(str('1,234.50'))
    wb.setLocale('de-DE')
    expect(wb.store.getter(sheet.formulaCellAtom('0:0'))).toEqual(str('1.234,50'))
    wb.setLocale('en-US')
    expect(wb.store.getter(sheet.formulaCellAtom('0:0'))).toEqual(str('1,234.50'))
  })

  test('setLocale to same value is a no-op (no recalc churn)', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '=TEXT(1234.5,"#,##0.00")')
    const sheet = wb.sheet('s1')!
    // Prime the cache.
    wb.store.getter(sheet.formulaCellAtom('0:0'))
    const before = sheet._debug.evalCount()
    wb.setLocale('en-US')
    wb.store.getter(sheet.formulaCellAtom('0:0'))
    // No recalc fired, so the cached value is reused — eval count unchanged.
    expect(sheet._debug.evalCount()).toBe(before)
  })

  test('setLocale inside withBatch defers recalc to outermost exit', () => {
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setCell('s1', 0, 0, '=TEXT(1234.5,"#,##0.00")')
    const sheet = wb.sheet('s1')!
    // Force initial evaluation so the formula is cached + clean.
    wb.store.getter(sheet.formulaCellAtom('0:0'))

    let subUpdates = 0
    const unsub = wb.store.sub(sheet.sheetAtom, () => {
      subUpdates += 1
    })
    wb.withBatch(() => {
      wb.setLocale('de-DE')
      wb.setLocale('fr-FR')
      wb.setLocale('en-US')
      // Inside the batch, the recalc is pending — atom hasn't been
      // bumped yet for the locale changes.
      expect(subUpdates).toBe(0)
    })
    unsub()
    // Outermost exit fires a single recalc, so the sheetAtom updates once.
    expect(subUpdates).toBe(1)
    // And we ended on en-US, so the formula reads en-US-shaped.
    expect(wb.store.getter(sheet.formulaCellAtom('0:0'))).toEqual(str('1,234.50'))
  })
})

describe('FIXED — argument validation under locale', () => {
  test('FIXED(non-finite) → #VALUE!', () => {
    // The Intl path can't produce numeric output for NaN — but DOLLAR /
    // FIXED short-circuit on non-finite. Pin that the locale machinery
    // doesn't accidentally swallow the guard.
    const wb = createWorkbook([{ id: 's1', name: 'Sheet1' }])
    wb.setLocale('de-DE')
    wb.setCell('s1', 0, 0, '=FIXED(0/0)')
    const v = wb.store.getter(wb.sheet('s1')!.formulaCellAtom('0:0'))
    expect(v.kind).toBe('error')
  })
})
