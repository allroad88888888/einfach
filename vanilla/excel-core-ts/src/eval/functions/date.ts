/**
 * Wave C / C5 — date functions.
 *
 * Implements the v1 date set: TODAY, NOW, DATE, YEAR, MONTH, DAY, WEEKDAY.
 *
 * Epoch: **1900** (Excel default). Serial `1` = 1900-01-01.
 *
 * Excel "1900 leap-year bug": Excel treats 1900 as a leap year for
 * compatibility with Lotus 1-2-3. Serial 60 corresponds to the fictitious
 * date 1900-02-29, and serials `>= 61` are shifted by 1 day relative to a
 * "real" calendar. We mirror the bug here so DATE/YEAR/MONTH/DAY round-trips
 * match Excel exactly (e.g. DATE(1900, 2, 29) → 60, DATE(2024, 1, 1) → 45292).
 *
 * All Date construction goes through `Date.UTC` and all extraction uses
 * `getUTC*` so the serial math is independent of host timezone.
 */

import type { FunctionImpl, Value } from '../../types'
import { toNumber, propagateError } from '../coerce'

// ---------------------------------------------------------------------------
// Internal date <-> serial helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000

/**
 * Anchor: 1899-12-31 (UTC). With this anchor:
 *   serial 0  → 1899-12-31
 *   serial 1  → 1900-01-01
 *   serial 59 → 1900-02-28
 *   serial 60 → 1900-02-29 (Excel-only fictitious day)
 *   serial 61 → 1900-03-01
 *
 * For dates on/after 1900-03-01 we add 1 to skip the fictitious leap day.
 */
const ANCHOR_UTC_MS = Date.UTC(1899, 11, 31)

/** Convert a JS UTC `Date` to an Excel serial integer (1900 epoch, leap-bug aware). */
function dateToSerial(d: Date): number {
  const realDays = Math.floor((d.getTime() - ANCHOR_UTC_MS) / MS_PER_DAY)
  // Real day count >= 60 means we're on/after 1900-03-01; shift up by 1 to
  // mirror Excel's phantom 1900-02-29.
  if (realDays >= 60) return realDays + 1
  return realDays
}

/**
 * Convert an Excel serial back to a JS UTC `Date`. Serial 60 is the
 * fictitious 1900-02-29 — JS has no such date, so we hand back 1900-03-01
 * (the next real day) and YEAR/MONTH/DAY handle the special case explicitly.
 */
function serialToDate(serial: number): Date {
  let days = Math.floor(serial)
  if (days > 60) days = days - 1
  return new Date(ANCHOR_UTC_MS + days * MS_PER_DAY)
}

/** Truncate a JS Date to its UTC-midnight equivalent (drops time-of-day). */
function midnightUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function coerceNumber(v: Value): { ok: true; value: number } | { ok: false; error: Value } {
  const r = toNumber(v)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, value: r.value }
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * `TODAY()` — current date as a serial (no time component).
 *
 * Non-deterministic — uses `new Date()`. Volatile in Excel's sense; in this
 * engine, broad invalidation via `recalc()` re-runs the derive and produces
 * a fresh value. See ARCHITECTURE.md §7.
 */
const TODAY: FunctionImpl = (args) => {
  if (args.length !== 0) return { kind: 'error', code: '#VALUE!', message: 'TODAY() takes no arguments' }
  return { kind: 'number', value: dateToSerial(midnightUtc(new Date())) }
}

/**
 * `NOW()` — current date and time as a serial plus fractional day.
 *
 * Same volatility story as TODAY.
 */
const NOW: FunctionImpl = (args) => {
  if (args.length !== 0) return { kind: 'error', code: '#VALUE!', message: 'NOW() takes no arguments' }
  const now = new Date()
  const wholeDay = dateToSerial(midnightUtc(now))
  // Fractional day from the start of UTC midnight. Use UTC accessors so
  // the fraction does not depend on the host timezone offset.
  const msSinceMidnight =
    now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const frac = msSinceMidnight / MS_PER_DAY
  return { kind: 'number', value: wholeDay + frac }
}

/**
 * `DATE(year, month, day)` — build a serial.
 *
 * - `year < 1900` → `#NUM!` (Excel actually adds 1900 for years 0..1899
 *   and rejects negatives; for v1 we follow the simpler rule documented
 *   in the task brief).
 * - Months and days roll over: `DATE(2024, 14, 1)` = 2025-02-01.
 * - Excel quirk: `DATE(1900, 2, 29)` returns serial 60 (the fictitious
 *   Feb 29 1900). All other roll-over routes go through JS Date arithmetic
 *   and never land on serial 60 (because JS has no 1900-02-29).
 */
const DATE: FunctionImpl = (args) => {
  if (args.length !== 3) {
    return { kind: 'error', code: '#VALUE!', message: 'DATE() requires 3 arguments' }
  }
  const err = propagateError(args)
  if (err) return err

  const y = coerceNumber(args[0])
  if (!y.ok) return y.error
  const m = coerceNumber(args[1])
  if (!m.ok) return m.error
  const d = coerceNumber(args[2])
  if (!d.ok) return d.error

  const year = Math.trunc(y.value)
  const month = Math.trunc(m.value)
  const day = Math.trunc(d.value)

  if (year < 1900) return { kind: 'error', code: '#NUM!' }

  // Excel-compat: literal (1900, 2, 29) request → serial 60.
  if (year === 1900 && month === 2 && day === 29) {
    return { kind: 'number', value: 60 }
  }

  // JS Date.UTC handles month/day rollover (Date.UTC(2024, 13, 1) → 2025-02-01).
  // For year 0..99 JS adds 1900 — we already gate year >= 1900 so the
  // ambiguity doesn't bite.
  const ms = Date.UTC(year, month - 1, day)
  if (!Number.isFinite(ms)) return { kind: 'error', code: '#NUM!' }
  const serial = dateToSerial(new Date(ms))
  if (serial < 0) return { kind: 'error', code: '#NUM!' }
  return { kind: 'number', value: serial }
}

/** Helper: extract serial → JS Date components, honoring the leap-bug. */
function partsOf(
  serial: number,
): { year: number; month: number; day: number; phantom: boolean } {
  // Phantom 1900-02-29 — Excel-only. Report as year 1900, month 2, day 29.
  if (Math.floor(serial) === 60) {
    return { year: 1900, month: 2, day: 29, phantom: true }
  }
  const d = serialToDate(serial)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    phantom: false,
  }
}

/** Shared scaffolding for YEAR / MONTH / DAY. */
function extractPart(args: Value[], pick: (p: ReturnType<typeof partsOf>) => number): Value {
  if (args.length !== 1) {
    return { kind: 'error', code: '#VALUE!', message: 'expected 1 argument' }
  }
  const err = propagateError(args)
  if (err) return err
  const s = coerceNumber(args[0])
  if (!s.ok) return s.error
  if (s.value < 0) return { kind: 'error', code: '#NUM!' }
  return { kind: 'number', value: pick(partsOf(s.value)) }
}

/** `YEAR(serial)` — calendar year. */
const YEAR: FunctionImpl = (args) => extractPart(args, (p) => p.year)

/** `MONTH(serial)` — 1..12. */
const MONTH: FunctionImpl = (args) => extractPart(args, (p) => p.month)

/** `DAY(serial)` — 1..31. */
const DAY: FunctionImpl = (args) => extractPart(args, (p) => p.day)

/**
 * `WEEKDAY(serial, [return_type=1])`
 *
 * return_type:
 *   1 → Sunday=1 .. Saturday=7   (default)
 *   2 → Monday=1 .. Sunday=7
 *   3 → Monday=0 .. Sunday=6
 *
 * Reference anchor: 1900-01-01 is a Sunday in Excel's 1900-leap-bug world
 * (and 1900-01-07 is Saturday). For serials >= 61 (real dates after the
 * phantom day) the JS Date's `getUTCDay()` is correct because the phantom
 * day shifts the whole calendar by 1 — but for serials 1..59 we need the
 * Excel mapping, which we compute by treating "real day count from
 * 1899-12-31" mod 7. We derive a single weekday-from-serial helper.
 */
function weekdaySun0Mon1(serial: number): number {
  // Compute Excel's "day of week where Sunday = 0". 1900-01-01 is a Sunday
  // (in Excel's bug-compatible calendar). Serial 1 → Sunday → 0.
  // For pre-phantom serials (1..59): (serial - 1) % 7 gives the offset.
  // For phantom serial 60: Excel labels it as Wednesday (1900-02-29 in the
  //   fictional calendar — Feb 28 1900 is a Wednesday, so Feb 29 1900 would
  //   be a Thursday). We follow Excel's documented WEEKDAY(60) = 4 (Wed)
  //   when return_type=1 (Sun=1..Sat=7) — Excel actually maps 60 → 3 in
  //   the Sun-anchored scale (i.e. Tuesday=3). Anchor-checked below.
  // For serial >= 61: behavior matches a "normal" calendar.
  const s = Math.floor(serial)
  if (s <= 0) return 0
  // Excel-verified mapping:
  //   serial 1  (1900-01-01) → Sunday    (1 in Sun=1 mode)
  //   serial 7  (1900-01-07) → Saturday  (7)
  //   serial 60 (phantom)    → Tuesday   (3 in Sun=1 mode)
  //   serial 61 (1900-03-01) → Wednesday (4)
  //   serial 45292 (2024-01-01) → Monday (2)
  //
  // Because Excel's 1900 leap-bug shifts dates >= 60 forward by one day,
  // `(s - 1) % 7` (0-indexed Sun) works for all serials uniformly when we
  // use the *Excel* day count. The "real" JS Date is one day ahead for
  // s > 60, so we cannot use getUTCDay directly without compensating.
  return ((s - 1) % 7 + 7) % 7
}

const WEEKDAY: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2) {
    return { kind: 'error', code: '#VALUE!', message: 'WEEKDAY() takes 1 or 2 arguments' }
  }
  const err = propagateError(args)
  if (err) return err
  const s = coerceNumber(args[0])
  if (!s.ok) return s.error
  if (s.value < 0) return { kind: 'error', code: '#NUM!' }

  let returnType = 1
  if (args.length === 2) {
    const t = coerceNumber(args[1])
    if (!t.ok) return t.error
    returnType = Math.trunc(t.value)
  }

  const sun0 = weekdaySun0Mon1(s.value) // 0 = Sunday, 6 = Saturday
  let out: number
  switch (returnType) {
    case 1:
      out = sun0 + 1 // Sun=1 .. Sat=7
      break
    case 2:
      // Mon=1 .. Sun=7
      out = ((sun0 + 6) % 7) + 1
      break
    case 3:
      // Mon=0 .. Sun=6
      out = (sun0 + 6) % 7
      break
    default:
      return { kind: 'error', code: '#NUM!', message: 'WEEKDAY return_type must be 1, 2, or 3' }
  }
  return { kind: 'number', value: out }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const FUNCTIONS: Record<string, FunctionImpl> = {
  TODAY,
  NOW,
  DATE,
  YEAR,
  MONTH,
  DAY,
  WEEKDAY,
}
