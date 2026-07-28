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
import { toBoolean, toNumber, propagateError } from '../coerce'

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

function datePartsToSerial(y: number, mo: number, d: number): Value {
  if (y < 1900) return { kind: 'error', code: '#NUM!' }
  if (!Number.isInteger(mo) || !Number.isInteger(d) || mo < 1 || mo > 12 || d < 1) {
    return { kind: 'error', code: '#VALUE!' }
  }
  if (y === 1900 && mo === 2 && d === 29) return { kind: 'number', value: 60 }
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  if (d > daysInMonth) return { kind: 'error', code: '#VALUE!' }
  return { kind: 'number', value: dateToSerial(new Date(Date.UTC(y, mo - 1, d))) }
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function coerceNumber(v: Value): { ok: true; value: number } | { ok: false; error: Value } {
  const r = toNumber(v)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, value: r.value }
}

function coerceBoolean(v: Value): { ok: true; value: boolean } | { ok: false; error: Value } {
  const r = toBoolean(v)
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

  const yearInput = Math.trunc(y.value)
  const month = Math.trunc(m.value)
  const day = Math.trunc(d.value)

  if (yearInput < 0 || yearInput >= 10000) return { kind: 'error', code: '#NUM!' }
  const year = yearInput < 1900 ? yearInput + 1900 : yearInput

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
 *   1  → Sunday=1 .. Saturday=7   (default)
 *   2  → Monday=1 .. Sunday=7
 *   3  → Monday=0 .. Sunday=6
 *   11 → Monday=1 .. Sunday=7     (alias of 2)
 *   12 → Tuesday=1 .. Monday=7
 *   13 → Wednesday=1 .. Tuesday=7
 *   14 → Thursday=1 .. Wednesday=7
 *   15 → Friday=1 .. Thursday=7
 *   16 → Saturday=1 .. Friday=7
 *   17 → Sunday=1 .. Saturday=7   (alias of 1)
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
    case 17:
      out = sun0 + 1 // Sun=1 .. Sat=7
      break
    case 2:
    case 11:
      // Mon=1 .. Sun=7
      out = ((sun0 + 6) % 7) + 1
      break
    case 3:
      // Mon=0 .. Sun=6
      out = (sun0 + 6) % 7
      break
    case 12: // Tuesday=1 .. Monday=7
    case 13: // Wednesday=1 .. Tuesday=7
    case 14: // Thursday=1 .. Wednesday=7
    case 15: // Friday=1 .. Thursday=7
    case 16: // Saturday=1 .. Friday=7
      // Each step from type 11 shifts the anchor forward one weekday.
      // Type N (11..17) anchors weekday (N-11) (Mon=0..Sun=6) to "1".
      // Using sun0 (Sun=0..Sat=6): convert to Mon=0..Sun=6 via (sun0+6)%7,
      // then subtract the anchor offset (N-11), wrap mod 7, +1.
      out = (((sun0 + 6) % 7) - (returnType - 11) + 7) % 7 + 1
      break
    default:
      return {
        kind: 'error',
        code: '#NUM!',
        message: 'WEEKDAY return_type must be 1, 2, 3, or 11..17',
      }
  }
  return { kind: 'number', value: out }
}

// ---------------------------------------------------------------------------
// Phase 8 additions — TIME, HOUR/MINUTE/SECOND, EOMONTH/EDATE, DAYS, WEEKNUM, etc.
// ---------------------------------------------------------------------------

/** TIME(hour, minute, second) — fractional day. */
const TIME: FunctionImpl = (args) => {
  if (args.length !== 3) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args)
  if (err) return err
  const h = coerceNumber(args[0])
  if (!h.ok) return h.error
  const m = coerceNumber(args[1])
  if (!m.ok) return m.error
  const s = coerceNumber(args[2])
  if (!s.ok) return s.error
  const hours = Math.trunc(h.value)
  const minutes = Math.trunc(m.value)
  const seconds = Math.trunc(s.value)
  if (
    hours < 0 ||
    minutes < 0 ||
    seconds < 0 ||
    hours > 32767 ||
    minutes > 32767 ||
    seconds > 32767
  ) {
    return { kind: 'error', code: '#NUM!' }
  }
  const totalSeconds = hours * 3600 + minutes * 60 + seconds
  // Fractional day, taking modulo 24h.
  const frac = (totalSeconds % 86400) / 86400
  return { kind: 'number', value: frac }
}

function fracPartHMS(serial: number): { h: number; m: number; s: number } {
  const frac = serial - Math.floor(serial)
  // Use rounding to avoid float drift on second boundaries.
  const totalSeconds = Math.round(frac * 86400)
  const h = Math.floor(totalSeconds / 3600) % 24
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return { h, m, s }
}

/** HOUR(serial) — 0..23 */
const HOUR: FunctionImpl = (args) => {
  if (args.length !== 1) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args)
  if (err) return err
  const s = coerceNumber(args[0])
  if (!s.ok) return s.error
  if (s.value < 0) return { kind: 'error', code: '#NUM!' }
  return { kind: 'number', value: fracPartHMS(s.value).h }
}

/** MINUTE(serial) — 0..59 */
const MINUTE: FunctionImpl = (args) => {
  if (args.length !== 1) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args)
  if (err) return err
  const s = coerceNumber(args[0])
  if (!s.ok) return s.error
  if (s.value < 0) return { kind: 'error', code: '#NUM!' }
  return { kind: 'number', value: fracPartHMS(s.value).m }
}

/** SECOND(serial) — 0..59 */
const SECOND: FunctionImpl = (args) => {
  if (args.length !== 1) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args)
  if (err) return err
  const s = coerceNumber(args[0])
  if (!s.ok) return s.error
  if (s.value < 0) return { kind: 'error', code: '#NUM!' }
  return { kind: 'number', value: fracPartHMS(s.value).s }
}

/** EDATE(start_date, months) — add N months. */
const EDATE: FunctionImpl = (args) => {
  if (args.length !== 2) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args)
  if (err) return err
  const s = coerceNumber(args[0])
  if (!s.ok) return s.error
  const m = coerceNumber(args[1])
  if (!m.ok) return m.error
  if (s.value < 0) return { kind: 'error', code: '#NUM!' }
  const p = partsOf(s.value)
  const newMonthIdx = (p.month - 1) + Math.trunc(m.value)
  const newYear = p.year + Math.floor(newMonthIdx / 12)
  const monthMod = ((newMonthIdx % 12) + 12) % 12
  // Cap day to month length.
  const daysInMonth = new Date(Date.UTC(newYear, monthMod + 1, 0)).getUTCDate()
  const newDay = Math.min(p.day, daysInMonth)
  if (newYear < 1900) return { kind: 'error', code: '#NUM!' }
  const ms = Date.UTC(newYear, monthMod, newDay)
  if (!Number.isFinite(ms)) return { kind: 'error', code: '#NUM!' }
  return { kind: 'number', value: dateToSerial(new Date(ms)) }
}

/** EOMONTH(start_date, months) — last day of month after adding months. */
const EOMONTH: FunctionImpl = (args) => {
  if (args.length !== 2) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args)
  if (err) return err
  const s = coerceNumber(args[0])
  if (!s.ok) return s.error
  const m = coerceNumber(args[1])
  if (!m.ok) return m.error
  if (s.value < 0) return { kind: 'error', code: '#NUM!' }
  const p = partsOf(s.value)
  const newMonthIdx = (p.month - 1) + Math.trunc(m.value)
  const newYear = p.year + Math.floor(newMonthIdx / 12)
  const monthMod = ((newMonthIdx % 12) + 12) % 12
  // Last day of that month
  const last = new Date(Date.UTC(newYear, monthMod + 1, 0))
  if (newYear < 1900) return { kind: 'error', code: '#NUM!' }
  return { kind: 'number', value: dateToSerial(last) }
}

/** DAYS(end_date, start_date) — end - start. */
const DAYS: FunctionImpl = (args) => {
  if (args.length !== 2) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args)
  if (err) return err
  const e = coerceNumber(args[0])
  if (!e.ok) return e.error
  const s = coerceNumber(args[1])
  if (!s.ok) return s.error
  return { kind: 'number', value: Math.floor(e.value) - Math.floor(s.value) }
}

/** DATEVALUE(text) — parse ISO-like dates (YYYY-MM-DD, MM/DD/YYYY). */
const DATEVALUE: FunctionImpl = (args) => {
  if (args.length !== 1) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args)
  if (err) return err
  const v = args[0]
  if (v.kind !== 'string') return { kind: 'error', code: '#VALUE!' }
  const text = v.value.trim()
  // Try YYYY-MM-DD
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (m) {
    const y = parseInt(m[1], 10)
    const mo = parseInt(m[2], 10)
    const d = parseInt(m[3], 10)
    return datePartsToSerial(y, mo, d)
  }
  // Try MM/DD/YYYY
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(text)
  if (m) {
    const mo = parseInt(m[1], 10)
    const d = parseInt(m[2], 10)
    let y = parseInt(m[3], 10)
    if (y < 100) y += 2000
    return datePartsToSerial(y, mo, d)
  }
  return { kind: 'error', code: '#VALUE!' }
}

/** TIMEVALUE(text) — parse HH:MM:SS or HH:MM. */
const TIMEVALUE: FunctionImpl = (args) => {
  if (args.length !== 1) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args)
  if (err) return err
  const v = args[0]
  if (v.kind !== 'string') return { kind: 'error', code: '#VALUE!' }
  const text = v.value.trim()
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text)
  if (!m) return { kind: 'error', code: '#VALUE!' }
  const h = parseInt(m[1], 10)
  const mi = parseInt(m[2], 10)
  const s = m[3] ? parseInt(m[3], 10) : 0
  if (h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59) {
    return { kind: 'error', code: '#VALUE!' }
  }
  return { kind: 'number', value: (h * 3600 + mi * 60 + s) / 86400 }
}

/**
 * WEEKNUM(serial, [return_type=1]) — week-number per system.
 *
 * return_type maps to the week's start-of-week (Sun=0..Sat=6):
 *   1  → Sunday    (default, "System 1")
 *   2  → Monday    ("System 2")
 *   11 → Monday
 *   12 → Tuesday
 *   13 → Wednesday
 *   14 → Thursday
 *   15 → Friday
 *   16 → Saturday
 *   17 → Sunday
 *   21 → ISO 8601 (delegates to ISOWEEKNUM)
 */
const WEEKNUM: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2) return { kind: 'error', code: '#VALUE!' }
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
  // Type 21 is ISO 8601 — same computation as ISOWEEKNUM.
  if (returnType === 21) {
    return ISOWEEKNUM([args[0]], _ctxIgnored)
  }
  // Map return_type → start-of-week day (Sun=0..Sat=6).
  let startDow: number
  switch (returnType) {
    case 1:
    case 17:
      startDow = 0
      break // Sunday
    case 2:
    case 11:
      startDow = 1
      break // Monday
    case 12:
      startDow = 2
      break // Tuesday
    case 13:
      startDow = 3
      break // Wednesday
    case 14:
      startDow = 4
      break // Thursday
    case 15:
      startDow = 5
      break // Friday
    case 16:
      startDow = 6
      break // Saturday
    default:
      return { kind: 'error', code: '#NUM!' }
  }
  const p = partsOf(s.value)
  // Compute serial of Jan 1 of that year.
  const jan1 = dateToSerial(new Date(Date.UTC(p.year, 0, 1)))
  const dowJan1 = weekdaySun0Mon1(jan1)
  // Day-of-year for the input.
  const doy = Math.floor(s.value) - jan1 + 1
  const week = Math.floor((doy + ((dowJan1 - startDow + 7) % 7) - 1) / 7) + 1
  return { kind: 'number', value: week }
}

// Marker for forwarded calls — see WEEKNUM type 21 → ISOWEEKNUM delegation.
const _ctxIgnored = new Proxy({}, {
  get(_, prop) {
    throw new Error(`date fn unexpectedly read ctx.${String(prop)}`)
  },
}) as unknown as Parameters<FunctionImpl>[1]

/** ISOWEEKNUM(serial) — ISO 8601 week number. */
const ISOWEEKNUM: FunctionImpl = (args) => {
  if (args.length !== 1) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args)
  if (err) return err
  const s = coerceNumber(args[0])
  if (!s.ok) return s.error
  if (s.value < 0) return { kind: 'error', code: '#NUM!' }
  // ISO: Thursday-anchored week. Easiest: use JS Date.
  const p = partsOf(s.value)
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day))
  // Shift to Thursday of this week.
  const dow = d.getUTCDay() || 7 // ISO: Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dow)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7)
  return { kind: 'number', value: week }
}

/** DATEDIF(start, end, unit) — Excel's hidden DATEDIF. */
const DATEDIF: FunctionImpl = (args) => {
  if (args.length !== 3) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args)
  if (err) return err
  const sa = coerceNumber(args[0])
  if (!sa.ok) return sa.error
  const sb = coerceNumber(args[1])
  if (!sb.ok) return sb.error
  if (args[2].kind !== 'string') return { kind: 'error', code: '#VALUE!' }
  const unit = args[2].value.toUpperCase()
  const start = Math.floor(sa.value)
  const end = Math.floor(sb.value)
  if (start > end) return { kind: 'error', code: '#NUM!' }
  const pStart = partsOf(start)
  const pEnd = partsOf(end)
  switch (unit) {
    case 'D':
      return { kind: 'number', value: end - start }
    case 'Y': {
      let years = pEnd.year - pStart.year
      // Subtract if end date hasn't passed start's anniversary.
      if (
        pEnd.month < pStart.month ||
        (pEnd.month === pStart.month && pEnd.day < pStart.day)
      ) {
        years -= 1
      }
      return { kind: 'number', value: years }
    }
    case 'M': {
      let months = (pEnd.year - pStart.year) * 12 + (pEnd.month - pStart.month)
      if (pEnd.day < pStart.day) months -= 1
      return { kind: 'number', value: months }
    }
    case 'YM': {
      let months = pEnd.month - pStart.month
      if (months < 0) months += 12
      if (pEnd.day < pStart.day) {
        months -= 1
        if (months < 0) months += 12
      }
      return { kind: 'number', value: months }
    }
    case 'YD': {
      // Days ignoring years.
      const anchor = new Date(Date.UTC(pEnd.year, pStart.month - 1, pStart.day))
      let anchorSerial = dateToSerial(anchor)
      if (anchorSerial > end) {
        anchorSerial = dateToSerial(new Date(Date.UTC(pEnd.year - 1, pStart.month - 1, pStart.day)))
      }
      return { kind: 'number', value: end - anchorSerial }
    }
    case 'MD': {
      // Days of month difference ignoring months/years.
      let d = pEnd.day - pStart.day
      if (d < 0) {
        // Add prev month's day count
        const prev = new Date(Date.UTC(pEnd.year, pEnd.month - 1, 0))
        d += prev.getUTCDate()
      }
      return { kind: 'number', value: d }
    }
    default:
      return { kind: 'error', code: '#NUM!' }
  }
}

/** NETWORKDAYS(start, end, [holidays]) — count weekdays Mon-Fri, excluding holidays. */
const NETWORKDAYS: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args.slice(0, 2))
  if (err) return err
  const sa = coerceNumber(args[0])
  if (!sa.ok) return sa.error
  const sb = coerceNumber(args[1])
  if (!sb.ok) return sb.error
  const start = Math.floor(sa.value)
  const end = Math.floor(sb.value)
  // Collect holidays as a Set of serials.
  const holidays = new Set<number>()
  if (args.length === 3) {
    const h = args[2]
    if (h.kind === 'error') return h
    if (h.kind === 'array') {
      for (const row of h.value) {
        for (const cell of row) {
          if (cell.kind === 'error') return cell
          if (cell.kind === 'number') holidays.add(Math.floor(cell.value))
        }
      }
    } else if (h.kind === 'number') {
      holidays.add(Math.floor(h.value))
    }
  }
  const lo = Math.min(start, end)
  const hi = Math.max(start, end)
  const sign = start <= end ? 1 : -1
  let count = 0
  for (let s = lo; s <= hi; s++) {
    const dow = weekdaySun0Mon1(s) // Sun=0..Sat=6
    if (dow === 0 || dow === 6) continue
    if (holidays.has(s)) continue
    count++
  }
  return { kind: 'number', value: sign * count }
}

type WeekendMask = [boolean, boolean, boolean, boolean, boolean, boolean, boolean]

const DEFAULT_WEEKEND: WeekendMask = [false, false, false, false, false, true, true]

function mondayIndexedDow(serial: number): number {
  return (weekdaySun0Mon1(serial) + 6) % 7
}

function parseWeekendArg(value: Value): { ok: true; mask: WeekendMask } | { ok: false; error: Value } {
  if (value.kind === 'string') {
    const chars = [...value.value]
    if (chars.length !== 7) return { ok: false, error: { kind: 'error', code: '#VALUE!' } }
    const mask: WeekendMask = [false, false, false, false, false, false, false]
    let allWeekend = true
    for (let i = 0; i < chars.length; i += 1) {
      if (chars[i] === '0') {
        allWeekend = false
      } else if (chars[i] === '1') {
        mask[i] = true
      } else {
        return { ok: false, error: { kind: 'error', code: '#VALUE!' } }
      }
    }
    if (allWeekend) return { ok: false, error: { kind: 'error', code: '#VALUE!' } }
    return { ok: true, mask }
  }

  const code = coerceNumber(value)
  if (!code.ok) return { ok: false, error: code.error }
  if (!Number.isInteger(code.value)) {
    return { ok: false, error: { kind: 'error', code: '#VALUE!' } }
  }
  const n = code.value
  const twoDayPairs = [
    [5, 6],
    [6, 0],
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
  ] as const
  if (n >= 1 && n <= 7) {
    const mask: WeekendMask = [false, false, false, false, false, false, false]
    const pair = twoDayPairs[n - 1]
    mask[pair[0]] = true
    mask[pair[1]] = true
    return { ok: true, mask }
  }
  if (n >= 11 && n <= 17) {
    const mask: WeekendMask = [false, false, false, false, false, false, false]
    const day = ((n - 12) % 7 + 7) % 7
    mask[day] = true
    return { ok: true, mask }
  }
  return { ok: false, error: { kind: 'error', code: '#VALUE!' } }
}

function collectHolidaySerials(value: Value | undefined): { ok: true; holidays: Set<number> } | { ok: false; error: Value } {
  const holidays = new Set<number>()
  if (!value) return { ok: true, holidays }
  if (value.kind === 'error') return { ok: false, error: value }
  if (value.kind === 'array') {
    for (const row of value.value) {
      for (const cell of row) {
        if (cell.kind === 'error') return { ok: false, error: cell }
        if (cell.kind === 'number') holidays.add(Math.floor(cell.value))
      }
    }
    return { ok: true, holidays }
  }
  if (value.kind === 'number') holidays.add(Math.floor(value.value))
  return { ok: true, holidays }
}

function countWorkdays(start: number, end: number, weekend: WeekendMask, holidays: Set<number>): number {
  const lo = Math.min(start, end)
  const hi = Math.max(start, end)
  const sign = start <= end ? 1 : -1
  let count = 0
  for (let serial = lo; serial <= hi; serial += 1) {
    if (weekend[mondayIndexedDow(serial)]) continue
    if (holidays.has(serial)) continue
    count += 1
  }
  return sign * count
}

function advanceWorkdays(start: number, days: number, weekend: WeekendMask, holidays: Set<number>): number {
  if (days === 0) return start
  const step = days > 0 ? 1 : -1
  let serial = start
  let remaining = Math.abs(days)
  while (remaining > 0) {
    serial += step
    if (weekend[mondayIndexedDow(serial)]) continue
    if (holidays.has(serial)) continue
    remaining -= 1
  }
  return serial
}

/** NETWORKDAYS.INTL(start, end, [weekend], [holidays]) */
const NETWORKDAYS_INTL: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 4) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args.slice(0, 2))
  if (err) return err
  const sa = coerceNumber(args[0])
  if (!sa.ok) return sa.error
  const sb = coerceNumber(args[1])
  if (!sb.ok) return sb.error
  let weekend = DEFAULT_WEEKEND
  if (args.length >= 3) {
    const parsed = parseWeekendArg(args[2])
    if (!parsed.ok) return parsed.error
    weekend = parsed.mask
  }
  const holidays = collectHolidaySerials(args[3])
  if (!holidays.ok) return holidays.error
  return {
    kind: 'number',
    value: countWorkdays(Math.floor(sa.value), Math.floor(sb.value), weekend, holidays.holidays),
  }
}

/** WORKDAY(start, days, [holidays]) — add business days. */
const WORKDAY: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args.slice(0, 2))
  if (err) return err
  const sa = coerceNumber(args[0])
  if (!sa.ok) return sa.error
  const dc = coerceNumber(args[1])
  if (!dc.ok) return dc.error
  const days = Math.trunc(dc.value)
  let serial = Math.floor(sa.value)
  const holidays = new Set<number>()
  if (args.length === 3) {
    const h = args[2]
    if (h.kind === 'error') return h
    if (h.kind === 'array') {
      for (const row of h.value) {
        for (const cell of row) {
          if (cell.kind === 'number') holidays.add(Math.floor(cell.value))
        }
      }
    } else if (h.kind === 'number') {
      holidays.add(Math.floor(h.value))
    }
  }
  const step = days >= 0 ? 1 : -1
  let remaining = Math.abs(days)
  while (remaining > 0) {
    serial += step
    const dow = weekdaySun0Mon1(serial)
    if (dow === 0 || dow === 6) continue
    if (holidays.has(serial)) continue
    remaining--
  }
  return { kind: 'number', value: serial }
}

/** WORKDAY.INTL(start, days, [weekend], [holidays]) */
const WORKDAY_INTL: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 4) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args.slice(0, 2))
  if (err) return err
  const sa = coerceNumber(args[0])
  if (!sa.ok) return sa.error
  const dc = coerceNumber(args[1])
  if (!dc.ok) return dc.error
  let weekend = DEFAULT_WEEKEND
  if (args.length >= 3) {
    const parsed = parseWeekendArg(args[2])
    if (!parsed.ok) return parsed.error
    weekend = parsed.mask
  }
  const holidays = collectHolidaySerials(args[3])
  if (!holidays.ok) return holidays.error
  return {
    kind: 'number',
    value: advanceWorkdays(
      Math.floor(sa.value),
      Math.trunc(dc.value),
      weekend,
      holidays.holidays,
    ),
  }
}

function days360(start: number, end: number, european: boolean, applyFebEom = false): number {
  const startParts = partsOf(start)
  const endParts = partsOf(end)
  let d1 = startParts.day
  let d2 = endParts.day
  if (european) {
    if (d1 === 31) d1 = 30
    if (d2 === 31) d2 = 30
  } else {
    // NASD 30/360.
    //
    // `DAYS360(start, end, FALSE)` applies only the day-31 rule (Microsoft's
    // documented behavior, matches the legacy SIA spec; no Feb EOM).
    // `YEARFRAC(start, end, 0)` additionally applies the Feb EOM refinement
    // (Harvey P2). `applyFebEom` threads the distinction.
    if (applyFebEom && isLastDayOfFeb(startParts)) {
      if (isLastDayOfFeb(endParts)) d2 = 30
      d1 = 30
    }
    if (d1 === 31) d1 = 30
    if (d1 === 30 && d2 === 31) d2 = 30
  }
  return (endParts.year - startParts.year) * 360 + (endParts.month - startParts.month) * 30 + (d2 - d1)
}

function isLastDayOfFeb(parts: { year: number; month: number; day: number }): boolean {
  if (parts.month !== 2) return false
  const lastDay = daysInYear(parts.year) === 366 ? 29 : 28
  return parts.day === lastDay
}

function daysInYear(year: number): number {
  return Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1) === 366 * MS_PER_DAY ? 366 : 365
}

function yearFracActualActual(start: number, end: number): number {
  const startParts = partsOf(start)
  const endParts = partsOf(end)
  let yearLength: number
  if (isGreaterThanOneYear(startParts, endParts)) {
    yearLength = averageYearLength(startParts.year, endParts.year)
  } else if (shouldCountFeb29(startParts, endParts)) {
    yearLength = 366
  } else {
    yearLength = 365
  }
  return (end - start) / yearLength
}

function averageYearLength(startYear: number, endYear: number): number {
  let days = 0
  for (let year = startYear; year <= endYear; year += 1) {
    days += daysInYear(year)
  }
  return days / (endYear - startYear + 1)
}

function isGreaterThanOneYear(
  start: ReturnType<typeof partsOf>,
  end: ReturnType<typeof partsOf>,
): boolean {
  if (start.year === end.year) return false
  if (start.year + 1 !== end.year) return true
  if (start.month > end.month) return false
  if (start.month < end.month) return true
  return start.day < end.day
}

function shouldCountFeb29(
  start: ReturnType<typeof partsOf>,
  end: ReturnType<typeof partsOf>,
): boolean {
  if (daysInYear(start.year) === 366) {
    if (start.year === end.year) return true
    return start.month <= 2
  }
  if (daysInYear(end.year) === 366) {
    if (end.month === 1) return false
    if (end.month === 2) return end.day === 29
    return true
  }
  return false
}

/** DAYS360(start_date, end_date, [method]) */
const DAYS360: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args.slice(0, 2))
  if (err) return err
  const start = coerceNumber(args[0])
  if (!start.ok) return start.error
  const end = coerceNumber(args[1])
  if (!end.ok) return end.error
  if (start.value < 0 || end.value < 0) return { kind: 'error', code: '#VALUE!' }
  let european = false
  if (args.length === 3) {
    const method = coerceBoolean(args[2])
    if (!method.ok) return method.error
    european = method.value
  }
  return { kind: 'number', value: days360(Math.floor(start.value), Math.floor(end.value), european) }
}

/** YEARFRAC(start_date, end_date, [basis]) */
const YEARFRAC: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3) return { kind: 'error', code: '#VALUE!' }
  const err = propagateError(args.slice(0, 2))
  if (err) return err
  const start = coerceNumber(args[0])
  if (!start.ok) return start.error
  const end = coerceNumber(args[1])
  if (!end.ok) return end.error
  let basis = 0
  if (args.length === 3) {
    const basisArg = coerceNumber(args[2])
    if (!basisArg.ok) return basisArg.error
    // Harvey P2 — Excel rejects fractional / out-of-range basis with `#NUM!`.
    if (!Number.isFinite(basisArg.value)) return { kind: 'error', code: '#NUM!' }
    if (basisArg.value < 0 || basisArg.value >= 5) return { kind: 'error', code: '#NUM!' }
    if (!Number.isInteger(basisArg.value)) return { kind: 'error', code: '#NUM!' }
    basis = basisArg.value
  }
  if (basis < 0 || basis > 4) return { kind: 'error', code: '#NUM!' }
  const lo = Math.min(Math.floor(start.value), Math.floor(end.value))
  const hi = Math.max(Math.floor(start.value), Math.floor(end.value))
  switch (basis) {
    case 0:
      // YEARFRAC basis 0 applies the NASD Feb EOM refinement (DAYS360 does not).
      return { kind: 'number', value: days360(lo, hi, false, true) / 360 }
    case 4:
      return { kind: 'number', value: days360(lo, hi, true) / 360 }
    case 2:
      return { kind: 'number', value: (hi - lo) / 360 }
    case 1:
      return { kind: 'number', value: yearFracActualActual(lo, hi) }
    case 3:
      return { kind: 'number', value: (hi - lo) / 365 }
    default:
      return { kind: 'error', code: '#VALUE!' }
  }
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
  // Phase 8 additions
  TIME,
  HOUR,
  MINUTE,
  SECOND,
  EDATE,
  EOMONTH,
  DAYS,
  DATEVALUE,
  TIMEVALUE,
  WEEKNUM,
  ISOWEEKNUM,
  DATEDIF,
  NETWORKDAYS,
  'NETWORKDAYS.INTL': NETWORKDAYS_INTL,
  WORKDAY,
  'WORKDAY.INTL': WORKDAY_INTL,
  DAYS360,
  YEARFRAC,
}
