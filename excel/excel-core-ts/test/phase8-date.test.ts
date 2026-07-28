/**
 * Phase 8 — date function additions tests.
 *
 * Covers TIME, HOUR, MINUTE, SECOND, EDATE, EOMONTH, DAYS, DATEVALUE,
 * TIMEVALUE, WEEKNUM, ISOWEEKNUM, DATEDIF, NETWORKDAYS, WORKDAY.
 */

import { describe, expect, test } from '@jest/globals'

import { FUNCTIONS } from '../src/eval/functions/date'
import type { EvalContext, FunctionImpl, Value } from '../src/types'

const NUM = (n: number): Value => ({ kind: 'number', value: n })
const STR = (s: string): Value => ({ kind: 'string', value: s })
const ERR = (code: '#DIV/0!' | '#N/A' | '#NUM!' | '#VALUE!'): Value => ({
  kind: 'error',
  code,
})

const ctx: EvalContext = new Proxy(
  {},
  {
    get(_, prop) {
      throw new Error(`phase8 date unexpectedly read ctx.${String(prop)}`)
    },
  },
) as unknown as EvalContext

const get = (name: string): FunctionImpl => {
  const f = FUNCTIONS[name]
  if (!f) throw new Error(`No function ${name} in registry`)
  return f
}
const call = (name: string, args: Value[]): Value => get(name)(args, ctx)

const asNumber = (v: Value): number => {
  if (v.kind !== 'number') throw new Error(`expected number, got ${JSON.stringify(v)}`)
  return v.value
}

// Some known serials (Excel-compat):
//   2024-01-01 = 45292
//   2024-12-31 = 45657
describe('TIME', () => {
  test('TIME(12, 0, 0) = 0.5 (noon)', () =>
    expect(asNumber(call('TIME', [NUM(12), NUM(0), NUM(0)]))).toBeCloseTo(0.5, 6))
  test('TIME(6, 0, 0) = 0.25', () =>
    expect(asNumber(call('TIME', [NUM(6), NUM(0), NUM(0)]))).toBeCloseTo(0.25, 6))
  test('negative or oversized components return #NUM!', () => {
    expect(call('TIME', [NUM(1), NUM(-30), NUM(0)])).toEqual(ERR('#NUM!'))
    expect(call('TIME', [NUM(0), NUM(0), NUM(32768)])).toEqual(ERR('#NUM!'))
  })
  test('wrong arity → #VALUE!', () =>
    expect(call('TIME', [NUM(1), NUM(2)])).toEqual(ERR('#VALUE!')))
})

describe('HOUR / MINUTE / SECOND', () => {
  test('HOUR(0.5) = 12', () => expect(call('HOUR', [NUM(0.5)])).toEqual(NUM(12)))
  test('MINUTE(0.5 + 30/86400) = 0; MINUTE(0.5 + 1800/86400) = 30', () =>
    expect(call('MINUTE', [NUM(0.5 + 1800 / 86400)])).toEqual(NUM(30)))
  test('SECOND of fractional', () =>
    expect(call('SECOND', [NUM(0.5 + 1 / 86400)])).toEqual(NUM(1)))
})

describe('EDATE', () => {
  test('+1 month from 2024-01-15 → 2024-02-15', () => {
    const start = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(15)]))
    const expected = asNumber(call('DATE', [NUM(2024), NUM(2), NUM(15)]))
    expect(asNumber(call('EDATE', [NUM(start), NUM(1)]))).toBe(expected)
  })
  test('-1 month from 2024-03-15 → 2024-02-15', () => {
    const start = asNumber(call('DATE', [NUM(2024), NUM(3), NUM(15)]))
    const expected = asNumber(call('DATE', [NUM(2024), NUM(2), NUM(15)]))
    expect(asNumber(call('EDATE', [NUM(start), NUM(-1)]))).toBe(expected)
  })
  test('caps day to month length (Jan 31 + 1 month → Feb 28/29)', () => {
    const start = asNumber(call('DATE', [NUM(2023), NUM(1), NUM(31)]))
    const expected = asNumber(call('DATE', [NUM(2023), NUM(2), NUM(28)]))
    expect(asNumber(call('EDATE', [NUM(start), NUM(1)]))).toBe(expected)
  })
})

describe('EOMONTH', () => {
  test('last day of current month', () => {
    const mid = asNumber(call('DATE', [NUM(2024), NUM(2), NUM(15)]))
    const expected = asNumber(call('DATE', [NUM(2024), NUM(2), NUM(29)])) // leap year
    expect(asNumber(call('EOMONTH', [NUM(mid), NUM(0)]))).toBe(expected)
  })
  test('last day of next month', () => {
    const mid = asNumber(call('DATE', [NUM(2024), NUM(2), NUM(15)]))
    const expected = asNumber(call('DATE', [NUM(2024), NUM(3), NUM(31)]))
    expect(asNumber(call('EOMONTH', [NUM(mid), NUM(1)]))).toBe(expected)
  })
  test('error propagates', () => expect(call('EOMONTH', [ERR('#N/A'), NUM(0)])).toEqual(ERR('#N/A')))
})

describe('DAYS', () => {
  test('basic difference', () => expect(call('DAYS', [NUM(100), NUM(50)])).toEqual(NUM(50)))
  test('reverse → negative', () => expect(call('DAYS', [NUM(50), NUM(100)])).toEqual(NUM(-50)))
  test('error propagates', () => expect(call('DAYS', [ERR('#N/A'), NUM(0)])).toEqual(ERR('#N/A')))
})

describe('DATEVALUE', () => {
  test('YYYY-MM-DD format', () => {
    const expected = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(15)]))
    expect(asNumber(call('DATEVALUE', [STR('2024-01-15')]))).toBe(expected)
  })
  test('MM/DD/YYYY format', () => {
    const expected = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(15)]))
    expect(asNumber(call('DATEVALUE', [STR('1/15/2024')]))).toBe(expected)
  })
  test('invalid text → #VALUE!', () =>
    expect(call('DATEVALUE', [STR('not a date')])).toEqual(ERR('#VALUE!')))
  test('invalid calendar date → #VALUE!', () => {
    expect(call('DATEVALUE', [STR('2024-02-31')])).toEqual(ERR('#VALUE!'))
    expect(call('DATEVALUE', [STR('13/15/2024')])).toEqual(ERR('#VALUE!'))
  })
  test('preserves Excel 1900 leap-year serial quirk', () => {
    expect(call('DATEVALUE', [STR('1900-02-29')])).toEqual(NUM(60))
  })
})

describe('TIMEVALUE', () => {
  test('HH:MM:SS', () =>
    expect(asNumber(call('TIMEVALUE', [STR('12:00:00')]))).toBeCloseTo(0.5, 6))
  test('HH:MM', () =>
    expect(asNumber(call('TIMEVALUE', [STR('06:00')]))).toBeCloseTo(0.25, 6))
  test('invalid → #VALUE!', () =>
    expect(call('TIMEVALUE', [STR('25:99:99')])).toEqual(ERR('#VALUE!')))
})

describe('WEEKNUM', () => {
  test('Jan 1, 2024 (Mon) is week 1', () => {
    const s = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    expect(call('WEEKNUM', [NUM(s)])).toEqual(NUM(1))
  })
  test('Jan 7, 2024 (Sun) is week 2 in default (Sunday-start) mode', () => {
    const s = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(7)]))
    expect(call('WEEKNUM', [NUM(s)])).toEqual(NUM(2))
  })
  test('error propagates', () => expect(call('WEEKNUM', [ERR('#N/A')])).toEqual(ERR('#N/A')))

  // 2024 calendar: Jan 1 = Monday. Verify each weekday-anchored mode.
  test('return_type 11 (Mon start) — alias of 2', () => {
    const jan1 = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    expect(call('WEEKNUM', [NUM(jan1), NUM(11)])).toEqual(NUM(1))
    // Jan 7 is Sun: still in week 1 with Mon-start.
    expect(call('WEEKNUM', [NUM(jan1 + 6), NUM(11)])).toEqual(NUM(1))
    // Jan 8 is Mon: starts week 2.
    expect(call('WEEKNUM', [NUM(jan1 + 7), NUM(11)])).toEqual(NUM(2))
  })

  test('return_type 12 (Tue start)', () => {
    const jan1 = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    // Jan 1 is Mon — last day of pre-Tue week. So Mon→week 1.
    expect(call('WEEKNUM', [NUM(jan1), NUM(12)])).toEqual(NUM(1))
    // Jan 2 (Tue) starts a new week.
    expect(call('WEEKNUM', [NUM(jan1 + 1), NUM(12)])).toEqual(NUM(2))
  })

  test('return_type 16 (Sat start)', () => {
    const jan1 = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    // Sat = Jan 6.
    expect(call('WEEKNUM', [NUM(jan1 + 5), NUM(16)])).toEqual(NUM(2))
  })

  test('return_type 17 (Sun start) — alias of 1', () => {
    const jan1 = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    expect(call('WEEKNUM', [NUM(jan1), NUM(17)])).toEqual(NUM(1))
    expect(call('WEEKNUM', [NUM(jan1 + 6), NUM(17)])).toEqual(NUM(2))
  })

  test('return_type 21 (ISO 8601) — delegates to ISOWEEKNUM', () => {
    const jan1 = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    expect(call('WEEKNUM', [NUM(jan1), NUM(21)])).toEqual(NUM(1))
    const dec31_2023 = asNumber(call('DATE', [NUM(2023), NUM(12), NUM(31)]))
    expect(call('WEEKNUM', [NUM(dec31_2023), NUM(21)])).toEqual(NUM(52))
  })

  test('invalid return_type → #NUM!', () => {
    const jan1 = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    expect(call('WEEKNUM', [NUM(jan1), NUM(0)])).toEqual(ERR('#NUM!'))
    expect(call('WEEKNUM', [NUM(jan1), NUM(99)])).toEqual(ERR('#NUM!'))
    expect(call('WEEKNUM', [NUM(jan1), NUM(20)])).toEqual(ERR('#NUM!'))
  })
})

describe('ISOWEEKNUM', () => {
  test('Jan 1, 2024 (Mon) is ISO week 1', () => {
    const s = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    expect(call('ISOWEEKNUM', [NUM(s)])).toEqual(NUM(1))
  })
  test('Dec 31, 2023 (Sun) is in ISO week 52 of 2023', () => {
    const s = asNumber(call('DATE', [NUM(2023), NUM(12), NUM(31)]))
    expect(call('ISOWEEKNUM', [NUM(s)])).toEqual(NUM(52))
  })
  test('error propagates', () => expect(call('ISOWEEKNUM', [ERR('#N/A')])).toEqual(ERR('#N/A')))
})

describe('DATEDIF', () => {
  test('"D" — days difference', () => {
    const a = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    const b = asNumber(call('DATE', [NUM(2024), NUM(2), NUM(1)]))
    expect(call('DATEDIF', [NUM(a), NUM(b), STR('D')])).toEqual(NUM(31))
  })
  test('"Y" — years difference', () => {
    const a = asNumber(call('DATE', [NUM(2020), NUM(6), NUM(15)]))
    const b = asNumber(call('DATE', [NUM(2024), NUM(6), NUM(15)]))
    expect(call('DATEDIF', [NUM(a), NUM(b), STR('Y')])).toEqual(NUM(4))
  })
  test('"M" — months difference', () => {
    const a = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    const b = asNumber(call('DATE', [NUM(2024), NUM(7), NUM(1)]))
    expect(call('DATEDIF', [NUM(a), NUM(b), STR('M')])).toEqual(NUM(6))
  })
  test('start > end → #NUM!', () =>
    expect(call('DATEDIF', [NUM(100), NUM(50), STR('D')])).toEqual(ERR('#NUM!')))
})

describe('NETWORKDAYS', () => {
  test('full week Mon-Fri = 5 workdays', () => {
    // Pick a known Monday-Friday range. 2024-01-01 is a Monday.
    const mon = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    const fri = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(5)]))
    expect(call('NETWORKDAYS', [NUM(mon), NUM(fri)])).toEqual(NUM(5))
  })
  test('weekend excluded', () => {
    const sat = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(6)]))
    const sun = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(7)]))
    expect(call('NETWORKDAYS', [NUM(sat), NUM(sun)])).toEqual(NUM(0))
  })
  test('with holiday list', () => {
    const mon = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    const fri = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(5)]))
    const holiday = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(3)]))
    expect(call('NETWORKDAYS', [NUM(mon), NUM(fri), { kind: 'array', value: [[NUM(holiday)]] }])).toEqual(
      NUM(4),
    )
  })
})

describe('NETWORKDAYS.INTL', () => {
  test('weekend code 11 makes only Sunday a weekend', () => {
    const sat = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(6)]))
    const sun = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(7)]))
    expect(call('NETWORKDAYS.INTL', [NUM(sat), NUM(sun), NUM(11)])).toEqual(NUM(1))
  })

  test('text weekend mask uses Monday-first 0/1 flags', () => {
    const mon = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    const fri = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(5)]))
    expect(call('NETWORKDAYS.INTL', [NUM(mon), NUM(fri), STR('1000000')])).toEqual(NUM(4))
  })

  test('invalid all-weekend mask returns #VALUE!', () => {
    const mon = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    expect(call('NETWORKDAYS.INTL', [NUM(mon), NUM(mon), STR('1111111')])).toEqual(
      ERR('#VALUE!'),
    )
  })
})

describe('WORKDAY', () => {
  test('add 5 workdays to Mon → next Mon', () => {
    const mon = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    const nextMon = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(8)]))
    expect(call('WORKDAY', [NUM(mon), NUM(5)])).toEqual(NUM(nextMon))
  })
  test('add 0 days returns next non-weekend (or same if already weekday)', () => {
    const mon = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    expect(call('WORKDAY', [NUM(mon), NUM(0)])).toEqual(NUM(mon))
  })
  test('error propagates', () => expect(call('WORKDAY', [ERR('#N/A'), NUM(1)])).toEqual(ERR('#N/A')))
})

describe('WORKDAY.INTL', () => {
  test('custom single Sunday weekend counts Saturday as a workday', () => {
    const fri = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(5)]))
    const sat = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(6)]))
    expect(call('WORKDAY.INTL', [NUM(fri), NUM(1), NUM(11)])).toEqual(NUM(sat))
  })

  test('mask and holidays both exclude days', () => {
    const mon = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(1)]))
    const wed = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(3)]))
    const thu = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(4)]))
    expect(
      call('WORKDAY.INTL', [
        NUM(mon),
        NUM(2),
        STR('0000011'),
        { kind: 'array', value: [[NUM(wed)]] },
      ]),
    ).toEqual(NUM(thu))
  })
})

describe('DAYS360', () => {
  test('US 30/360 clamps end day when start day is 31', () => {
    const start = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(31)]))
    const end = asNumber(call('DATE', [NUM(2024), NUM(2), NUM(29)]))
    expect(call('DAYS360', [NUM(start), NUM(end)])).toEqual(NUM(29))
  })

  test('European 30/360 clamps both month ends', () => {
    const start = asNumber(call('DATE', [NUM(2024), NUM(1), NUM(31)]))
    const end = asNumber(call('DATE', [NUM(2024), NUM(3), NUM(31)]))
    expect(call('DAYS360', [NUM(start), NUM(end), { kind: 'boolean', value: true }])).toEqual(
      NUM(60),
    )
  })
})

describe('YEARFRAC', () => {
  test('default basis 0 uses 30/360', () => {
    const start = asNumber(call('DATE', [NUM(2020), NUM(1), NUM(1)]))
    const end = asNumber(call('DATE', [NUM(2021), NUM(1), NUM(1)]))
    expect(call('YEARFRAC', [NUM(start), NUM(end)])).toEqual(NUM(1))
  })

  test('basis 2 and 3 use actual day denominators', () => {
    const start = asNumber(call('DATE', [NUM(2020), NUM(1), NUM(1)]))
    const end = asNumber(call('DATE', [NUM(2021), NUM(1), NUM(1)]))
    expect(asNumber(call('YEARFRAC', [NUM(start), NUM(end), NUM(2)]))).toBeCloseTo(366 / 360, 12)
    expect(asNumber(call('YEARFRAC', [NUM(start), NUM(end), NUM(3)]))).toBeCloseTo(366 / 365, 12)
  })

  test('basis 1 uses Excel-compatible actual/actual year length', () => {
    const start = asNumber(call('DATE', [NUM(2020), NUM(1), NUM(1)]))
    const end = asNumber(call('DATE', [NUM(2021), NUM(1), NUM(1)]))
    const nextDay = asNumber(call('DATE', [NUM(2021), NUM(1), NUM(2)]))
    const feb2019 = asNumber(call('DATE', [NUM(2019), NUM(2), NUM(28)]))
    const feb2020 = asNumber(call('DATE', [NUM(2020), NUM(2), NUM(28)]))
    expect(asNumber(call('YEARFRAC', [NUM(start), NUM(end), NUM(1)]))).toBeCloseTo(1, 12)
    expect(asNumber(call('YEARFRAC', [NUM(start), NUM(nextDay), NUM(1)]))).toBeCloseTo(
      367 / 365.5,
      12,
    )
    expect(asNumber(call('YEARFRAC', [NUM(feb2019), NUM(feb2020), NUM(1)]))).toBeCloseTo(1, 12)
  })

  test('invalid basis returns #NUM!', () => {
    expect(call('YEARFRAC', [NUM(1), NUM(2), NUM(99)])).toEqual(ERR('#NUM!'))
  })

  test('NASD basis 0 applies Feb EOM rule for last-Feb dates', () => {
    // Harvey P2 — Excel's NASD (basis 0) has a Feb EOM refinement:
    //   - start last-Feb AND end last-Feb → end_day = 30
    //   - start last-Feb → start_day = 30
    // Without the refinement, YEARFRAC(2020-02-29, 2021-02-28, 0) gives
    // (1*360 + 0*30 + (28-29))/360 = (360-1)/360 ≈ 0.9972 instead of 1.0.
    const feb29_2020 = asNumber(call('DATE', [NUM(2020), NUM(2), NUM(29)]))
    const feb28_2021 = asNumber(call('DATE', [NUM(2021), NUM(2), NUM(28)]))
    expect(asNumber(call('YEARFRAC', [NUM(feb29_2020), NUM(feb28_2021), NUM(0)]))).toBeCloseTo(
      1,
      12,
    )

    // Start is last-Feb (non-leap year), end is later non-Feb day-31.
    // With refinement: start_day → 30, then d1=30 & d2=31 → d2=30,
    //                  so (1*360 + 6*30 + (30-30))/360 = 540/360 = 1.5.
    const feb28_2019 = asNumber(call('DATE', [NUM(2019), NUM(2), NUM(28)]))
    const aug31_2020 = asNumber(call('DATE', [NUM(2020), NUM(8), NUM(31)]))
    expect(asNumber(call('YEARFRAC', [NUM(feb28_2019), NUM(aug31_2020), NUM(0)]))).toBeCloseTo(
      1.5,
      12,
    )
  })

  test('invalid basis (negative / out of range / fractional) returns #NUM!', () => {
    const start = asNumber(call('DATE', [NUM(2020), NUM(1), NUM(1)]))
    const end = asNumber(call('DATE', [NUM(2021), NUM(1), NUM(1)]))
    expect(call('YEARFRAC', [NUM(start), NUM(end), NUM(5)])).toEqual(ERR('#NUM!'))
    expect(call('YEARFRAC', [NUM(start), NUM(end), NUM(-1)])).toEqual(ERR('#NUM!'))
    expect(call('YEARFRAC', [NUM(start), NUM(end), NUM(1.5)])).toEqual(ERR('#NUM!'))
  })
})
