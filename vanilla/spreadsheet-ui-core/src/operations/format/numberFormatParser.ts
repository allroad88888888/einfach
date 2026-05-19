/**
 * Excel-compatible custom number-format parser and evaluator.
 *
 * The parser accepts a custom format string (e.g. `'#,##0.00;[Red](#,##0.00)'`)
 * plus a numeric value and produces a `{ text, color }` pair. The renderer
 * applies the color when present.
 *
 * Supported tokens:
 *
 * - `0` — required digit, pad with zero
 * - `#` — optional digit
 * - `?` — optional digit, pad with space (for fraction alignment)
 * - `.` — decimal point
 * - `,` — thousands separator (locale-resolved at render time)
 * - `;` — section delimiter (positive ; negative ; zero ; text)
 * - `[Red]`, `[Blue]`, `[Green]`, `[Black]`, `[White]`, `[Cyan]`, `[Magenta]`,
 *   `[Yellow]` — color tag for the section
 * - `[>0]`, `[<0]`, `[=0]`, `[>=N]`, `[<=N]`, `[<>N]` — section condition
 * - `"literal"` — literal passthrough
 * - `\<char>` — escaped literal
 * - `m`, `mm`, `mmm`, `mmmm` — month number / padded / short name / long name
 * - `d`, `dd`, `ddd`, `dddd` — day number / padded / short name / long name
 * - `yy`, `yyyy` — two- / four-digit year
 * - `h`, `hh` — hour (24-hour by default; 12-hour when an `AM/PM` token is
 *   present in the same section)
 * - `s`, `ss` — second
 * - `AM/PM`, `am/pm`, `A/P`, `a/p` — meridian (also forces 12-hour for `h`)
 * - `%` — multiplies the value by 100 once per occurrence
 *
 * Known gaps (documented as follow-ups):
 *
 * - `*` (repeat next char) is ignored.
 * - `_` (skip width of next char) is treated as a single space.
 * - Locale tags such as `[$-409]` are stripped and ignored.
 * - `@` text placeholder in numeric sections is not supported.
 * - Fractional-second modifiers (`s.000`) collapse to plain `ss`.
 */

const COLOR_TAGS = new Map<string, string>([
  ['black', '#000000'],
  ['white', '#ffffff'],
  ['red', '#ff0000'],
  ['green', '#008000'],
  ['blue', '#0000ff'],
  ['cyan', '#00ffff'],
  ['magenta', '#ff00ff'],
  ['yellow', '#ffff00'],
])

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export interface NumberFormatLocale {
  decimalSeparator: string
  thousandsSeparator: string
  currencySymbol: string
  /** Used when nothing else picks a default. */
  tag: string
}

export const DEFAULT_LOCALE: NumberFormatLocale = {
  decimalSeparator: '.',
  thousandsSeparator: ',',
  currencySymbol: '$',
  tag: 'en-US',
}

const LOCALES: Record<string, NumberFormatLocale> = {
  'en-US': { decimalSeparator: '.', thousandsSeparator: ',', currencySymbol: '$', tag: 'en-US' },
  'en-GB': { decimalSeparator: '.', thousandsSeparator: ',', currencySymbol: '£', tag: 'en-GB' },
  'de-DE': { decimalSeparator: ',', thousandsSeparator: '.', currencySymbol: '€', tag: 'de-DE' },
  'fr-FR': { decimalSeparator: ',', thousandsSeparator: ' ', currencySymbol: '€', tag: 'fr-FR' },
  'es-ES': { decimalSeparator: ',', thousandsSeparator: '.', currencySymbol: '€', tag: 'es-ES' },
  'it-IT': { decimalSeparator: ',', thousandsSeparator: '.', currencySymbol: '€', tag: 'it-IT' },
  'ja-JP': { decimalSeparator: '.', thousandsSeparator: ',', currencySymbol: '¥', tag: 'ja-JP' },
  'zh-CN': { decimalSeparator: '.', thousandsSeparator: ',', currencySymbol: '¥', tag: 'zh-CN' },
}

export function resolveLocale(tag: string | undefined | null): NumberFormatLocale {
  if (!tag) return DEFAULT_LOCALE
  return LOCALES[tag] ?? DEFAULT_LOCALE
}

export type NumberFormatTokenKind =
  | 'literal'
  | 'digit-required'
  | 'digit-optional'
  | 'digit-space'
  | 'decimal-point'
  | 'thousands'
  | 'percent'
  | 'month'
  | 'day'
  | 'year'
  | 'hour'
  | 'minute'
  | 'second'
  | 'meridian'
  | 'date-element'

export interface NumberFormatToken {
  kind: NumberFormatTokenKind
  text: string
  /** Original repeat count for date tokens (e.g. `'mmm'` -> 3). */
  count?: number
  /** For meridian — preserves casing of the AM/PM marker. */
  ampmStyle?: 'AM/PM' | 'am/pm' | 'A/P' | 'a/p'
}

export type NumberFormatCondition =
  | { op: '>'; value: number }
  | { op: '<'; value: number }
  | { op: '='; value: number }
  | { op: '>='; value: number }
  | { op: '<='; value: number }
  | { op: '<>'; value: number }

export interface NumberFormatSection {
  tokens: NumberFormatToken[]
  color?: string
  condition?: NumberFormatCondition
  hasDateTokens: boolean
  hasTimeTokens: boolean
  hasMeridian: boolean
  /** True when the section has at least one digit placeholder. */
  hasNumericTokens: boolean
}

export interface ParsedNumberFormat {
  sections: NumberFormatSection[]
}

export interface NumberFormatResult {
  text: string
  /** Hex color from a `[Red]` style tag in the matched section, if any. */
  color?: string
}

/* ------------------------------------------------------------------------- */
/* Section split                                                              */
/* ------------------------------------------------------------------------- */

export function splitSections(pattern: string): string[] {
  const sections: string[] = []
  let buffer = ''
  let inString = false
  let inBracket = false

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]

    if (ch === '\\' && i + 1 < pattern.length) {
      buffer += ch + pattern[i + 1]
      i += 1
      continue
    }

    if (ch === '"') {
      inString = !inString
      buffer += ch
      continue
    }

    if (!inString && ch === '[') {
      inBracket = true
      buffer += ch
      continue
    }

    if (!inString && ch === ']') {
      inBracket = false
      buffer += ch
      continue
    }

    if (ch === ';' && !inString && !inBracket) {
      sections.push(buffer)
      buffer = ''
      continue
    }

    buffer += ch
  }

  sections.push(buffer)
  return sections
}

/* ------------------------------------------------------------------------- */
/* Tokenize one section                                                       */
/* ------------------------------------------------------------------------- */

function isDateChar(ch: string): boolean {
  return ch === 'm' || ch === 'M' || ch === 'd' || ch === 'D' || ch === 'y' || ch === 'Y' || ch === 'h' || ch === 'H' || ch === 's' || ch === 'S'
}

export function parseSection(input: string): NumberFormatSection {
  const tokens: NumberFormatToken[] = []
  let color: string | undefined
  let condition: NumberFormatCondition | undefined
  let hasDateTokens = false
  let hasTimeTokens = false
  let hasMeridian = false
  let hasNumericTokens = false

  let i = 0
  while (i < input.length) {
    const ch = input[i]

    // Escaped char: `\x`
    if (ch === '\\' && i + 1 < input.length) {
      tokens.push({ kind: 'literal', text: input[i + 1] })
      i += 2
      continue
    }

    // Literal string: `"abc"`
    if (ch === '"') {
      let j = i + 1
      let lit = ''
      while (j < input.length && input[j] !== '"') {
        lit += input[j]
        j += 1
      }
      tokens.push({ kind: 'literal', text: lit })
      i = j + 1
      continue
    }

    // Bracket tag: `[Red]`, `[>0]`, `[$-409]`
    if (ch === '[') {
      const end = input.indexOf(']', i)
      if (end === -1) {
        tokens.push({ kind: 'literal', text: ch })
        i += 1
        continue
      }
      const tag = input.slice(i + 1, end).trim()
      const lower = tag.toLowerCase()
      if (COLOR_TAGS.has(lower)) {
        color = COLOR_TAGS.get(lower)
      } else if (lower.startsWith('color')) {
        // [Color5] etc.  Skip; not supported.
      } else if (lower.startsWith('$')) {
        // Locale or currency override.  Strip; not supported.
      } else {
        const parsed = parseConditionTag(tag)
        if (parsed) condition = parsed
      }
      i = end + 1
      continue
    }

    // AM/PM marker
    const ampm = matchAmPm(input, i)
    if (ampm) {
      tokens.push({ kind: 'meridian', text: ampm.text, ampmStyle: ampm.style })
      hasMeridian = true
      i += ampm.length
      continue
    }

    // Digit placeholders
    if (ch === '0') {
      tokens.push({ kind: 'digit-required', text: ch })
      hasNumericTokens = true
      i += 1
      continue
    }
    if (ch === '#') {
      tokens.push({ kind: 'digit-optional', text: ch })
      hasNumericTokens = true
      i += 1
      continue
    }
    if (ch === '?') {
      tokens.push({ kind: 'digit-space', text: ch })
      hasNumericTokens = true
      i += 1
      continue
    }
    if (ch === '.') {
      tokens.push({ kind: 'decimal-point', text: ch })
      i += 1
      continue
    }
    if (ch === ',') {
      tokens.push({ kind: 'thousands', text: ch })
      i += 1
      continue
    }
    if (ch === '%') {
      tokens.push({ kind: 'percent', text: ch })
      i += 1
      continue
    }

    // Date / time runs
    if (isDateChar(ch)) {
      let j = i + 1
      while (j < input.length && input[j].toLowerCase() === ch.toLowerCase()) j += 1
      const count = j - i
      const run = input.slice(i, j)
      const lower = ch.toLowerCase()
      if (lower === 'm') {
        tokens.push({ kind: 'month', text: run, count })
        hasDateTokens = true
      } else if (lower === 'd') {
        tokens.push({ kind: 'day', text: run, count })
        hasDateTokens = true
      } else if (lower === 'y') {
        tokens.push({ kind: 'year', text: run, count })
        hasDateTokens = true
      } else if (lower === 'h') {
        tokens.push({ kind: 'hour', text: run, count })
        hasTimeTokens = true
      } else if (lower === 's') {
        tokens.push({ kind: 'second', text: run, count })
        hasTimeTokens = true
      }
      i = j
      continue
    }

    // `_x` = blank the width of x (we render as one space).
    if (ch === '_' && i + 1 < input.length) {
      tokens.push({ kind: 'literal', text: ' ' })
      i += 2
      continue
    }

    // `*x` = repeat fill char (collapses to nothing).
    if (ch === '*' && i + 1 < input.length) {
      i += 2
      continue
    }

    // Plain literal char.
    tokens.push({ kind: 'literal', text: ch })
    i += 1
  }

  disambiguateMinutes(tokens)

  return {
    tokens,
    color,
    condition,
    hasDateTokens,
    hasTimeTokens,
    hasMeridian,
    hasNumericTokens,
  }
}

function parseConditionTag(tag: string): NumberFormatCondition | undefined {
  const match = /^(>=|<=|<>|>|<|=)\s*(-?\d+(?:\.\d+)?)$/.exec(tag)
  if (!match) return undefined
  const op = match[1] as NumberFormatCondition['op']
  const value = Number(match[2])
  if (!Number.isFinite(value)) return undefined
  return { op, value } as NumberFormatCondition
}

function matchAmPm(
  input: string,
  i: number,
): { text: string; length: number; style: NumberFormatToken['ampmStyle'] } | null {
  if (input.startsWith('AM/PM', i)) return { text: 'AM/PM', length: 5, style: 'AM/PM' }
  if (input.startsWith('am/pm', i)) return { text: 'am/pm', length: 5, style: 'am/pm' }
  if (input.startsWith('A/P', i)) return { text: 'A/P', length: 3, style: 'A/P' }
  if (input.startsWith('a/p', i)) return { text: 'a/p', length: 3, style: 'a/p' }
  return null
}

/**
 * Excel rule for the lone letter `m`: if the preceding non-literal token is
 * an hour token, or the following non-literal token is a second token, the
 * `m` run is treated as minutes instead of months.
 */
function disambiguateMinutes(tokens: NumberFormatToken[]) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.kind !== 'month') continue
    let prev: NumberFormatToken | undefined
    let next: NumberFormatToken | undefined
    for (let j = i - 1; j >= 0; j -= 1) {
      if (tokens[j].kind !== 'literal') {
        prev = tokens[j]
        break
      }
    }
    for (let j = i + 1; j < tokens.length; j += 1) {
      if (tokens[j].kind !== 'literal') {
        next = tokens[j]
        break
      }
    }
    if (prev?.kind === 'hour' || next?.kind === 'second') {
      token.kind = 'minute'
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Public entry                                                               */
/* ------------------------------------------------------------------------- */

export function parseCustomFormat(pattern: string): ParsedNumberFormat {
  const rawSections = splitSections(pattern)
  return { sections: rawSections.map(parseSection) }
}

export interface FormatOptions {
  locale?: NumberFormatLocale
}

export function formatWithParsed(
  parsed: ParsedNumberFormat,
  value: unknown,
  options: FormatOptions = {},
): NumberFormatResult {
  const locale = options.locale ?? DEFAULT_LOCALE
  const numeric = coerceToNumber(value)

  if (numeric === null) {
    const textSection = pickTextSection(parsed.sections)
    if (!textSection) return { text: String(value) }
    return evaluateTextSection(textSection, String(value))
  }

  const picked = pickNumericSectionWithIndex(parsed.sections, numeric)
  if (!picked) return { text: String(numeric) }
  return evaluateNumericSection(picked.section, numeric, locale, picked.absolute)
}

function coerceToNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    if (value.trim() === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function pickTextSection(sections: NumberFormatSection[]): NumberFormatSection | undefined {
  if (sections.length >= 4) return sections[3]
  return sections[0]
}

function pickNumericSectionWithIndex(
  sections: NumberFormatSection[],
  value: number,
): { section: NumberFormatSection; absolute: boolean } | undefined {
  // Explicit condition tags take precedence.
  for (const section of sections) {
    if (section.condition && matchesCondition(section.condition, value)) {
      return { section, absolute: true }
    }
  }
  const sectionsWithoutCondition = sections.filter((s) => !s.condition)
  if (sectionsWithoutCondition.length === 0) {
    return { section: sections[0], absolute: false }
  }
  if (sectionsWithoutCondition.length === 1) {
    return { section: sectionsWithoutCondition[0], absolute: false }
  }
  if (value > 0) return { section: sectionsWithoutCondition[0], absolute: false }
  if (value < 0) {
    // Negative section already expresses sign via literal text — render abs.
    return {
      section: sectionsWithoutCondition[1] ?? sectionsWithoutCondition[0],
      absolute: sectionsWithoutCondition.length >= 2,
    }
  }
  return {
    section: sectionsWithoutCondition[2] ?? sectionsWithoutCondition[0],
    absolute: sectionsWithoutCondition.length >= 3,
  }
}

function matchesCondition(condition: NumberFormatCondition, value: number): boolean {
  switch (condition.op) {
    case '>': return value > condition.value
    case '<': return value < condition.value
    case '=': return value === condition.value
    case '>=': return value >= condition.value
    case '<=': return value <= condition.value
    case '<>': return value !== condition.value
  }
}

function evaluateTextSection(
  section: NumberFormatSection,
  text: string,
): NumberFormatResult {
  let out = ''
  let hadPlaceholder = false
  for (const token of section.tokens) {
    if (token.kind === 'literal') {
      out += token.text
      continue
    }
    if (token.kind === 'digit-required' && token.text === '@') {
      out += text
      hadPlaceholder = true
      continue
    }
    out += token.text
  }
  return hadPlaceholder
    ? section.color
      ? { text: out, color: section.color }
      : { text: out }
    : section.color
      ? { text: text, color: section.color }
      : { text }
}

/* ------------------------------------------------------------------------- */
/* Numeric section evaluation                                                 */
/* ------------------------------------------------------------------------- */

interface NumericLayout {
  intTokens: NumberFormatToken[]
  fracTokens: NumberFormatToken[]
  hasDecimal: boolean
  scaleCommas: number
  percentCount: number
  hasDigitPlaceholders: boolean
}

function analyzeNumericLayout(tokens: NumberFormatToken[]): NumericLayout {
  const decimalIndex = tokens.findIndex((t) => t.kind === 'decimal-point')
  const intTokens: NumberFormatToken[] = []
  const fracTokens: NumberFormatToken[] = []
  let percentCount = 0
  let hasDigitPlaceholders = false

  tokens.forEach((token, index) => {
    if (token.kind === 'percent') percentCount += 1
    if (token.kind === 'digit-required' || token.kind === 'digit-optional' || token.kind === 'digit-space') {
      hasDigitPlaceholders = true
    }
    if (decimalIndex === -1 || index < decimalIndex) {
      intTokens.push(token)
    } else if (index > decimalIndex) {
      fracTokens.push(token)
    }
  })

  let scaleCommas = 0
  for (let i = intTokens.length - 1; i >= 0; i -= 1) {
    const t = intTokens[i]
    if (t.kind === 'thousands') {
      scaleCommas += 1
    } else if (t.kind === 'digit-required' || t.kind === 'digit-optional' || t.kind === 'digit-space') {
      break
    }
  }

  return {
    intTokens,
    fracTokens,
    hasDecimal: decimalIndex !== -1,
    scaleCommas,
    percentCount,
    hasDigitPlaceholders,
  }
}

function evaluateNumericSection(
  section: NumberFormatSection,
  rawValue: number,
  locale: NumberFormatLocale,
  forceAbsolute: boolean = false,
): NumberFormatResult {
  if (section.hasDateTokens || section.hasTimeTokens) {
    return evaluateDateSection(section, rawValue)
  }

  const layout = analyzeNumericLayout(section.tokens)
  if (!layout.hasDigitPlaceholders) {
    let text = ''
    for (const token of section.tokens) {
      if (token.kind === 'literal') text += token.text
    }
    return section.color ? { text, color: section.color } : { text }
  }

  let working = rawValue
  if (layout.percentCount > 0) working *= 100 ** layout.percentCount
  if (layout.scaleCommas > 0) working /= 1000 ** layout.scaleCommas

  const hasParens = sectionHasLiteralParens(section)
  const useAbs = hasParens || forceAbsolute
  const absWorking = useAbs ? Math.abs(working) : working

  const fractionDigits = countDigitPlaceholders(layout.fracTokens)
  const rounded = roundHalfAwayFromZero(absWorking, fractionDigits)
  const sign = rounded < 0 ? '-' : ''
  const magnitude = Math.abs(rounded)

  let intStr: string
  let fracStr: string
  if (fractionDigits > 0) {
    const fixed = magnitude.toFixed(fractionDigits)
    const dot = fixed.indexOf('.')
    intStr = dot === -1 ? fixed : fixed.slice(0, dot)
    fracStr = dot === -1 ? '' : fixed.slice(dot + 1)
  } else {
    intStr = String(Math.round(magnitude))
    fracStr = ''
  }

  const hasThousandsGrouping = layout.intTokens.some((t) => t.kind === 'thousands')
  const intRendered = renderIntegerSide(layout.intTokens, intStr, locale, hasThousandsGrouping)
  const fracRendered = layout.hasDecimal ? renderFractionSide(layout.fracTokens, fracStr) : ''

  let body = intRendered
  if (layout.hasDecimal) {
    body += locale.decimalSeparator + fracRendered
  }

  let out = ''
  let emittedBody = false
  for (const token of section.tokens) {
    if (
      token.kind === 'digit-required' ||
      token.kind === 'digit-optional' ||
      token.kind === 'digit-space' ||
      token.kind === 'thousands' ||
      token.kind === 'decimal-point'
    ) {
      if (!emittedBody) {
        out += sign + body
        emittedBody = true
      }
      continue
    }
    if (token.kind === 'percent') {
      out += '%'
      continue
    }
    if (token.kind === 'literal') {
      out += token.text
      continue
    }
    out += token.text
  }
  if (!emittedBody) {
    out = sign + body + out
  }

  return section.color ? { text: out, color: section.color } : { text: out }
}

function sectionHasLiteralParens(section: NumberFormatSection): boolean {
  let open = false
  for (const token of section.tokens) {
    if (token.kind !== 'literal') continue
    if (token.text.includes('(')) open = true
    if (open && token.text.includes(')')) return true
  }
  return false
}

function countDigitPlaceholders(tokens: NumberFormatToken[]): number {
  let count = 0
  for (const token of tokens) {
    if (
      token.kind === 'digit-required' ||
      token.kind === 'digit-optional' ||
      token.kind === 'digit-space'
    ) {
      count += 1
    }
  }
  return count
}

function roundHalfAwayFromZero(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.sign(value) * Math.round(Math.abs(value) * factor) / factor
}

function renderIntegerSide(
  tokens: NumberFormatToken[],
  intStr: string,
  locale: NumberFormatLocale,
  groupThousands: boolean,
): string {
  const digitTokens = tokens.filter(
    (t) =>
      t.kind === 'digit-required' ||
      t.kind === 'digit-optional' ||
      t.kind === 'digit-space',
  )
  const padded = intStr.padStart(digitTokens.length, ' ')
  const overflow = padded.length - digitTokens.length
  const slots: string[] = []
  if (overflow > 0) {
    slots.push(padded.slice(0, overflow + 1))
    for (let i = 1; i < digitTokens.length; i += 1) {
      slots.push(padded[overflow + i])
    }
  } else {
    for (let i = 0; i < digitTokens.length; i += 1) {
      slots.push(padded[i])
    }
  }
  for (let i = 0; i < digitTokens.length; i += 1) {
    const t = digitTokens[i]
    if (slots[i] === ' ') {
      if (t.kind === 'digit-required') slots[i] = '0'
      else if (t.kind === 'digit-space') slots[i] = ' '
      else slots[i] = ''
    }
  }

  let groupedDigits = slots.join('')
  if (groupThousands) {
    groupedDigits = applyThousandsGrouping(groupedDigits, locale.thousandsSeparator)
  }
  return groupedDigits
}

function applyThousandsGrouping(digits: string, sep: string): string {
  const trimmed = digits.replace(/^\s+/, '')
  const leading = digits.slice(0, digits.length - trimmed.length)
  if (trimmed.length <= 3) return digits
  const parts: string[] = []
  let rem = trimmed
  while (rem.length > 3) {
    parts.unshift(rem.slice(-3))
    rem = rem.slice(0, -3)
  }
  parts.unshift(rem)
  return leading + parts.join(sep)
}

function renderFractionSide(tokens: NumberFormatToken[], fracStr: string): string {
  const digitTokens = tokens.filter(
    (t) =>
      t.kind === 'digit-required' ||
      t.kind === 'digit-optional' ||
      t.kind === 'digit-space',
  )
  let out = ''
  for (let i = 0; i < digitTokens.length; i += 1) {
    const slot = digitTokens[i]
    const ch = fracStr[i] ?? ''
    if (ch === '' || ch === undefined) {
      if (slot.kind === 'digit-required') out += '0'
      else if (slot.kind === 'digit-space') out += ' '
    } else {
      out += ch
    }
  }
  return out
}

/* ------------------------------------------------------------------------- */
/* Date / time evaluation                                                     */
/* ------------------------------------------------------------------------- */

export function excelSerialToDate(serial: number): Date {
  const epoch = Date.UTC(1899, 11, 30)
  const ms = epoch + serial * 86400000
  return new Date(ms)
}

function evaluateDateSection(
  section: NumberFormatSection,
  rawValue: number,
): NumberFormatResult {
  const date = excelSerialToDate(rawValue)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  const day = date.getUTCDate()
  const weekday = date.getUTCDay()
  const totalMs = Math.round((rawValue - Math.floor(rawValue)) * 86400000)
  const totalSeconds = Math.floor(totalMs / 1000)
  const hour24 = Math.floor(totalSeconds / 3600) % 24
  const minute = Math.floor(totalSeconds / 60) % 60
  const second = totalSeconds % 60
  const use12h = section.hasMeridian
  const hour12 = ((hour24 + 11) % 12) + 1

  let out = ''
  for (const token of section.tokens) {
    switch (token.kind) {
      case 'literal':
        out += token.text
        break
      case 'year':
        out += token.count && token.count <= 2
          ? String(year % 100).padStart(2, '0')
          : String(year).padStart(4, '0')
        break
      case 'month': {
        const count = token.count ?? 1
        if (count === 1) out += String(month + 1)
        else if (count === 2) out += String(month + 1).padStart(2, '0')
        else if (count === 3) out += MONTH_SHORT[month]
        else out += MONTH_LONG[month]
        break
      }
      case 'day': {
        const count = token.count ?? 1
        if (count === 1) out += String(day)
        else if (count === 2) out += String(day).padStart(2, '0')
        else if (count === 3) out += DAY_SHORT[weekday]
        else out += DAY_LONG[weekday]
        break
      }
      case 'hour': {
        const value = use12h ? hour12 : hour24
        out += token.count && token.count >= 2 ? String(value).padStart(2, '0') : String(value)
        break
      }
      case 'minute':
        out += token.count && token.count >= 2 ? String(minute).padStart(2, '0') : String(minute)
        break
      case 'second':
        out += token.count && token.count >= 2 ? String(second).padStart(2, '0') : String(second)
        break
      case 'meridian': {
        const style = token.ampmStyle
        const isPm = hour24 >= 12
        if (style === 'AM/PM') out += isPm ? 'PM' : 'AM'
        else if (style === 'am/pm') out += isPm ? 'pm' : 'am'
        else if (style === 'A/P') out += isPm ? 'P' : 'A'
        else out += isPm ? 'p' : 'a'
        break
      }
      default:
        out += token.text
        break
    }
  }

  return section.color ? { text: out, color: section.color } : { text: out }
}

/* ------------------------------------------------------------------------- */
/* High-level helper                                                          */
/* ------------------------------------------------------------------------- */

export function formatCustomNumber(
  pattern: string,
  value: unknown,
  options: FormatOptions = {},
): NumberFormatResult {
  return formatWithParsed(parseCustomFormat(pattern), value, options)
}
