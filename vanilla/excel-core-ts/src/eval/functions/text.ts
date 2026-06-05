/**
 * Wave C / C4 — Text functions.
 *
 * Functions: CONCATENATE, CONCAT, LEFT, RIGHT, MID, LEN, LOWER, UPPER, TRIM,
 *            TEXT, VALUE
 *
 * Discipline:
 *  - Pure: do not mutate `args`, `ctx`, or any captured state.
 *  - Total: every input returns a `Value`. Never throws.
 *  - Error short-circuit via `propagateError` (Excel "first-error-wins").
 *
 * Unicode discipline (LEFT/RIGHT/MID/LEN):
 *  - `String.prototype.length` counts UTF-16 *code units*, which mangles
 *    code-point counts for non-BMP characters (emoji, supplementary planes
 *    where each glyph = 2 code units = 1 codepoint).
 *  - Excel itself counts UTF-16 code units historically — but einfach-ts
 *    elects user-correct semantics: split via `Array.from(text)` so emoji
 *    count as 1 character. Tests pin this behavior.
 */

import { propagateError, toBoolean, toNumber, toString as valueToString } from '../coerce'
import type { FunctionImpl, Value } from '../../types'

// =============================================================================
// Helpers
// =============================================================================

const ERR_VALUE: Value = { kind: 'error', code: '#VALUE!' }
const ERR_NA: Value = { kind: 'error', code: '#N/A' }

/** Convenience: build an error Value with code + optional message. */
function errValue(code: '#VALUE!' | '#NAME?' | '#NUM!' | '#N/A', message?: string): Value {
  return message ? { kind: 'error', code, message } : { kind: 'error', code }
}

/**
 * Code-point split (Unicode-safe). For LEFT/RIGHT/MID/LEN the contract is
 * "1 user-visible character" — not "1 UTF-16 code unit". `Array.from`
 * iterates by code points (because `String.prototype[Symbol.iterator]`
 * yields code points), so a 4-byte emoji counts as 1.
 *
 * NB: this is not full Unicode grapheme-cluster segmentation — a flag emoji
 * (regional-indicator pair) still counts as 2. Grapheme clusters would need
 * `Intl.Segmenter`, which we defer until a real complaint shows up.
 */
function codepoints(s: string): string[] {
  return Array.from(s)
}

/** Byte width under the DBCS discipline used by Excel's deprecated *B text fns. */
function dbcsByteWidth(ch: string): number {
  const cp = ch.codePointAt(0)
  if (cp === undefined) return 0
  // ASCII and half-width Katakana/punctuation are single-byte in Japanese DBCS.
  if (cp <= 0x7f || (cp >= 0xff61 && cp <= 0xff9f)) return 1
  return 2
}

function dbcsByteLength(s: string): number {
  let len = 0
  for (const ch of codepoints(s)) len += dbcsByteWidth(ch)
  return len
}

function sliceDbcsBytes(s: string, startByte: number, byteCount: number): string {
  if (byteCount <= 0) return ''
  const start = Math.max(0, startByte - 1)
  const end = start + byteCount
  let cursor = 0
  let out = ''
  for (const ch of codepoints(s)) {
    const next = cursor + dbcsByteWidth(ch)
    if (cursor >= start && next <= end) out += ch
    cursor = next
    if (cursor >= end) break
  }
  return out
}

function leftDbcsBytes(s: string, byteCount: number): string {
  return sliceDbcsBytes(s, 1, byteCount)
}

function rightDbcsBytes(s: string, byteCount: number): string {
  if (byteCount <= 0) return ''
  const total = dbcsByteLength(s)
  return sliceDbcsBytes(s, Math.max(1, total - byteCount + 1), byteCount)
}

function codeUnitOffsetForDbcsByteStart(s: string, startByte: number): number {
  const target = Math.max(0, startByte - 1)
  let byteCursor = 0
  let codeUnitCursor = 0
  for (const ch of codepoints(s)) {
    const width = dbcsByteWidth(ch)
    if (byteCursor >= target) return codeUnitCursor
    if (byteCursor < target && target < byteCursor + width) return codeUnitCursor + ch.length
    byteCursor += width
    codeUnitCursor += ch.length
  }
  return s.length
}

function dbcsBytePositionFromCodeUnitOffset(s: string, offset: number): number {
  let byteCursor = 0
  let codeUnitCursor = 0
  for (const ch of codepoints(s)) {
    if (codeUnitCursor >= offset) return byteCursor + 1
    byteCursor += dbcsByteWidth(ch)
    codeUnitCursor += ch.length
  }
  return byteCursor + 1
}

function splitDbcsAtByteBoundary(s: string, byteOffset: number): [string, string] {
  if (byteOffset <= 0) return ['', s]
  let cursor = 0
  let before = ''
  for (const ch of codepoints(s)) {
    const next = cursor + dbcsByteWidth(ch)
    if (next <= byteOffset) {
      before += ch
      cursor = next
      continue
    }
    return [before, s.slice(before.length)]
  }
  return [s, '']
}

function replaceDbcsBytes(s: string, startByte: number, byteCount: number, replacement: string): string {
  const start = Math.max(0, startByte - 1)
  const total = dbcsByteLength(s)
  if (start >= total) return s + replacement
  if (byteCount === 0) {
    const [before, after] = splitDbcsAtByteBoundary(s, start)
    return before + replacement + after
  }
  const end = start + byteCount
  let cursor = 0
  let before = ''
  let after = ''
  for (const ch of codepoints(s)) {
    const next = cursor + dbcsByteWidth(ch)
    if (next <= start) before += ch
    else if (cursor >= end) after += ch
    cursor = next
  }
  return before + replacement + after
}

/**
 * Coerce a Value to a string for text-function input. Booleans become
 * "TRUE"/"FALSE", numbers stringify, blank → "". Errors propagate.
 *
 * This is `coerce.toString` reused — kept as a helper here to make the
 * call sites self-documenting (the text-fn input contract is exactly
 * the same as `valueToString`).
 */
function coerceText(v: Value): { ok: true; value: string } | { ok: false; error: Value } {
  const r = valueToString(v)
  if (r.ok) return { ok: true, value: r.value }
  return { ok: false, error: r.error }
}

/**
 * Flatten array `Value` recursively into a stream of scalar `Value`s. Used
 * by CONCAT (which, unlike CONCATENATE, takes array args and joins their
 * elements in row-major order).
 */
function* flattenForConcat(v: Value): Generator<Value> {
  if (v.kind === 'array') {
    for (const row of v.value) {
      for (const cell of row) {
        yield* flattenForConcat(cell)
      }
    }
    return
  }
  yield v
}

function findNestedError(v: Value): (Value & { kind: 'error' }) | undefined {
  if (v.kind === 'error') return v
  if (v.kind !== 'array') return undefined
  for (const row of v.value) {
    for (const cell of row) {
      const err = findNestedError(cell)
      if (err) return err
    }
  }
  return undefined
}

function collectTextDelimiters(
  v: Value,
  includeEmpty = false,
): { ok: true; value: string[] } | { ok: false; error: Value } {
  const out: string[] = []
  for (const scalar of flattenForConcat(v)) {
    if (scalar.kind === 'error') return { ok: false, error: scalar }
    if (scalar.kind === 'blank') {
      if (includeEmpty) out.push('')
      continue
    }
    const r = coerceText(scalar)
    if (!r.ok) return r
    if (r.value !== '' || includeEmpty) out.push(r.value)
  }
  return { ok: true, value: out }
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false
  }
  return true
}

interface TextDelimiterMatch {
  readonly start: number
  readonly end: number
}

function findFirstTextDelimiter(
  text: string,
  delims: readonly string[],
  start: number,
  matchMode: number,
): TextDelimiterMatch | null {
  if (delims.length === 0 || start > text.length) return null
  const caseInsensitive = matchMode === 1
  const hayLower = caseInsensitive && isAscii(text) ? text.toLowerCase() : text
  let best: TextDelimiterMatch | null = null

  for (const delim of delims) {
    if (delim === '') continue
    const asciiInsensitive = caseInsensitive && isAscii(text) && isAscii(delim)
    const hay = asciiInsensitive ? hayLower : text
    const needle = asciiInsensitive ? delim.toLowerCase() : delim
    const pos = hay.indexOf(needle, start)
    if (pos < 0) continue
    if (best === null || pos < best.start) {
      best = { start: pos, end: pos + needle.length }
    }
  }

  return best
}

function textsplitOneAxis(
  text: string,
  delims: readonly string[],
  ignoreEmpty: boolean,
  matchMode: number,
): string[] {
  if (delims.length === 0) return [text]
  const out: string[] = []
  let pos = 0
  while (pos <= text.length) {
    const match = findFirstTextDelimiter(text, delims, pos, matchMode)
    if (match) {
      const frag = text.slice(pos, match.start)
      if (!(ignoreEmpty && frag === '')) out.push(frag)
      pos = match.end
      if (pos > text.length) break
      continue
    }
    const frag = text.slice(pos)
    if (!(ignoreEmpty && frag === '')) out.push(frag)
    break
  }
  if (out.length === 0 && !ignoreEmpty) out.push('')
  return out
}

function readInteger(v: Value): { ok: true; value: number } | { ok: false; error: Value } {
  const r = toNumber(v)
  if (!r.ok) return r
  if (!Number.isFinite(r.value)) return { ok: false, error: ERR_VALUE }
  return { ok: true, value: Math.trunc(r.value) }
}

function readBoolean(v: Value): { ok: true; value: boolean } | { ok: false; error: Value } {
  const r = toBoolean(v)
  if (!r.ok) return r
  return { ok: true, value: r.value }
}

function insertCommas(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function formatThousandsFixed(value: number, decimals: number, useCommas: boolean): string {
  const abs = Math.abs(value)
  if (decimals < 0) {
    const factor = 10 ** -decimals
    const rounded = Math.round(abs / factor) * factor
    const whole = String(Math.trunc(rounded))
    return useCommas ? insertCommas(whole) : whole
  }
  const fixedDecimals = Math.min(decimals, 15)
  const formatted = abs.toFixed(fixedDecimals)
  const [whole = '0', frac] = formatted.split('.')
  const wholeOut = useCommas ? insertCommas(whole) : whole
  return frac !== undefined && frac !== '' ? `${wholeOut}.${frac}` : wholeOut
}

function quoteStrictText(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

function renderValueToText(v: Value, strict: boolean): string {
  switch (v.kind) {
    case 'blank':
      return ''
    case 'string':
      return strict ? quoteStrictText(v.value) : v.value
    case 'number':
      return String(v.value)
    case 'boolean':
      return v.value ? 'TRUE' : 'FALSE'
    case 'error':
      return v.code
    case 'array':
      return formatGridToText(v.value, strict)
  }
}

function formatGridToText(rows: readonly Value[][], strict: boolean): string {
  const inner = rows
    .map((row) => row.map((cell) => renderValueToText(cell, strict)).join(','))
    .join(';')
  return strict ? `{${inner}}` : inner
}

function readStrictFormat(args: Value[]): { ok: true; value: boolean } | { ok: false; error: Value } {
  if (args.length < 2) return { ok: true, value: false }
  const r = readInteger(args[1])
  if (!r.ok) return r
  return { ok: true, value: r.value === 1 }
}

function utf8Bytes(s: string): number[] {
  const out: number[] = []
  for (const ch of codepoints(s)) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    if (cp <= 0x7f) {
      out.push(cp)
    } else if (cp <= 0x7ff) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    } else if (cp <= 0xffff) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      )
    }
  }
  return out
}

function isUrlUnreservedByte(b: number): boolean {
  return (
    (b >= 0x30 && b <= 0x39) ||
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a) ||
    b === 0x2d ||
    b === 0x5f ||
    b === 0x2e ||
    b === 0x7e
  )
}

function percentEncodeUrlText(s: string): string {
  let out = ''
  for (const b of utf8Bytes(s)) {
    if (isUrlUnreservedByte(b)) {
      out += String.fromCharCode(b)
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

function buildPairMap(left: readonly string[], right: readonly string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (let i = 0; i < left.length && i < right.length; i++) {
    const l = left[i]
    const r = right[i]
    if (l !== undefined && r !== undefined) map.set(l, r)
  }
  return map
}

const HALF_KANA = [
  '｡', '｢', '｣', '､', '･', 'ｦ', 'ｧ', 'ｨ', 'ｩ', 'ｪ', 'ｫ', 'ｬ', 'ｭ', 'ｮ', 'ｯ', 'ｰ',
  'ｱ', 'ｲ', 'ｳ', 'ｴ', 'ｵ', 'ｶ', 'ｷ', 'ｸ', 'ｹ', 'ｺ', 'ｻ', 'ｼ', 'ｽ', 'ｾ', 'ｿ', 'ﾀ',
  'ﾁ', 'ﾂ', 'ﾃ', 'ﾄ', 'ﾅ', 'ﾆ', 'ﾇ', 'ﾈ', 'ﾉ', 'ﾊ', 'ﾋ', 'ﾌ', 'ﾍ', 'ﾎ', 'ﾏ', 'ﾐ',
  'ﾑ', 'ﾒ', 'ﾓ', 'ﾔ', 'ﾕ', 'ﾖ', 'ﾗ', 'ﾘ', 'ﾙ', 'ﾚ', 'ﾛ', 'ﾜ', 'ﾝ', 'ﾞ', 'ﾟ',
] as const

const FULL_KANA = [
  '。', '「', '」', '、', '・', 'ヲ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ャ', 'ュ', 'ョ', 'ッ',
  'ー', 'ア', 'イ', 'ウ', 'エ', 'オ', 'カ', 'キ', 'ク', 'ケ', 'コ', 'サ', 'シ', 'ス',
  'セ', 'ソ', 'タ', 'チ', 'ツ', 'テ', 'ト', 'ナ', 'ニ', 'ヌ', 'ネ', 'ノ', 'ハ', 'ヒ',
  'フ', 'ヘ', 'ホ', 'マ', 'ミ', 'ム', 'メ', 'モ', 'ヤ', 'ユ', 'ヨ', 'ラ', 'リ', 'ル',
  'レ', 'ロ', 'ワ', 'ン', '゛', '゜',
] as const

const VOICED_HALF = [
  'ｳ', 'ｶ', 'ｷ', 'ｸ', 'ｹ', 'ｺ', 'ｻ', 'ｼ', 'ｽ', 'ｾ', 'ｿ', 'ﾀ', 'ﾁ', 'ﾂ', 'ﾃ', 'ﾄ',
  'ﾊ', 'ﾋ', 'ﾌ', 'ﾍ', 'ﾎ',
] as const

const VOICED_FULL = [
  'ヴ', 'ガ', 'ギ', 'グ', 'ゲ', 'ゴ', 'ザ', 'ジ', 'ズ', 'ゼ', 'ゾ', 'ダ', 'ヂ', 'ヅ',
  'デ', 'ド', 'バ', 'ビ', 'ブ', 'ベ', 'ボ',
] as const

const SEMI_VOICED_HALF = ['ﾊ', 'ﾋ', 'ﾌ', 'ﾍ', 'ﾎ'] as const
const SEMI_VOICED_FULL = ['パ', 'ピ', 'プ', 'ペ', 'ポ'] as const

const FULL_TO_HALF_KANA = (() => {
  const map = buildPairMap(FULL_KANA, HALF_KANA)
  const voiced = buildPairMap(VOICED_FULL, VOICED_HALF)
  for (const [full, half] of voiced) map.set(full, `${half}ﾞ`)
  const semi = buildPairMap(SEMI_VOICED_FULL, SEMI_VOICED_HALF)
  for (const [full, half] of semi) map.set(full, `${half}ﾟ`)
  return map
})()

const HALF_TO_FULL_KANA = buildPairMap(HALF_KANA, FULL_KANA)
const VOICED_HALF_TO_FULL = buildPairMap(VOICED_HALF, VOICED_FULL)
const SEMI_VOICED_HALF_TO_FULL = buildPairMap(SEMI_VOICED_HALF, SEMI_VOICED_FULL)

function ascConvert(s: string): string {
  let out = ''
  for (const ch of codepoints(s)) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    if (cp >= 0xff01 && cp <= 0xff5e) {
      out += String.fromCodePoint(cp - 0xfee0)
      continue
    }
    if (cp === 0x3000) {
      out += ' '
      continue
    }
    if (cp === 0xffe5) {
      out += '\\'
      continue
    }
    out += FULL_TO_HALF_KANA.get(ch) ?? ch
  }
  return out
}

function jisConvert(s: string): string {
  const chars = codepoints(s)
  let out = ''
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]
    if (ch === undefined) break
    const cp = ch.codePointAt(0)
    if (cp === undefined) {
      i++
      continue
    }
    if (cp >= 0x21 && cp <= 0x7e) {
      out += String.fromCodePoint(cp + 0xfee0)
      i++
      continue
    }
    if (cp === 0x20) {
      out += '\u3000'
      i++
      continue
    }
    if (cp >= 0xff61 && cp <= 0xff9f) {
      const next = chars[i + 1]
      if (next === 'ﾞ') {
        const voiced = VOICED_HALF_TO_FULL.get(ch)
        if (voiced !== undefined) {
          out += voiced
          i += 2
          continue
        }
      }
      if (next === 'ﾟ') {
        const semi = SEMI_VOICED_HALF_TO_FULL.get(ch)
        if (semi !== undefined) {
          out += semi
          i += 2
          continue
        }
      }
      out += HALF_TO_FULL_KANA.get(ch) ?? ch
      i++
      continue
    }
    out += ch
    i++
  }
  return out
}

function formatImageNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n)
  return String(n)
}

function formatImagePayload(
  source: string,
  alt: string | undefined,
  sizing: number,
  height: number | undefined,
  width: number | undefined,
): string {
  let out = `<IMAGE: ${source}`
  if (alt !== undefined) {
    out += ' alt="'
    for (const ch of codepoints(alt)) {
      if (ch === '\\') out += '\\\\'
      else if (ch === '"') out += '\\"'
      else out += ch
    }
    out += '"'
  }
  if (sizing !== 0) out += ` sizing=${sizing}`
  if (height !== undefined && width !== undefined) {
    out += ` height=${formatImageNumber(height)} width=${formatImageNumber(width)}`
  }
  return `${out}>`
}

// =============================================================================
// CONCATENATE / CONCAT
// =============================================================================

/**
 * CONCATENATE(text1, text2, ...) — concatenate string representations of
 * every arg in order. At least one argument required. Errors propagate
 * (first error wins). Arrays are coerced top-left scalar (Excel behavior
 * for the *legacy* function).
 */
const CONCATENATE: FunctionImpl = (args) => {
  if (args.length === 0) return errValue('#VALUE!', 'CONCATENATE requires at least one argument')
  const err = propagateError(args)
  if (err) return err
  let out = ''
  for (const a of args) {
    const r = coerceText(a)
    if (!r.ok) return r.error
    out += r.value
  }
  return { kind: 'string', value: out }
}

/**
 * CONCAT(text1, text2, ...) — like CONCATENATE but **flattens arrays**.
 * `CONCAT(A1:A3)` glues the three cells in row-major order. Post-2019
 * Excel addition.
 */
const CONCAT: FunctionImpl = (args) => {
  if (args.length === 0) return errValue('#VALUE!', 'CONCAT requires at least one argument')
  const err = propagateError(args)
  if (err) return err
  let out = ''
  for (const a of args) {
    for (const scalar of flattenForConcat(a)) {
      if (scalar.kind === 'error') return scalar
      const r = coerceText(scalar)
      if (!r.ok) return r.error
      out += r.value
    }
  }
  return { kind: 'string', value: out }
}

// =============================================================================
// LEFT / RIGHT / MID
// =============================================================================

/**
 * LEFT(text, [num_chars=1]) — first N code points. `num_chars > length`
 * yields the whole string. `num_chars < 0` → `#VALUE!`. Fractional
 * num_chars is truncated toward zero (Excel semantics).
 */
const LEFT: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2)
    return errValue('#VALUE!', 'LEFT takes 1 or 2 arguments')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  let n = 1
  if (args.length === 2) {
    const nr = toNumber(args[1])
    if (!nr.ok) return nr.error
    n = Math.trunc(nr.value)
    if (n < 0) return ERR_VALUE
  }
  const chars = codepoints(ts.value)
  return { kind: 'string', value: chars.slice(0, n).join('') }
}

/**
 * RIGHT(text, [num_chars=1]) — last N code points. Same edge rules as LEFT.
 */
const RIGHT: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2)
    return errValue('#VALUE!', 'RIGHT takes 1 or 2 arguments')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  let n = 1
  if (args.length === 2) {
    const nr = toNumber(args[1])
    if (!nr.ok) return nr.error
    n = Math.trunc(nr.value)
    if (n < 0) return ERR_VALUE
  }
  const chars = codepoints(ts.value)
  if (n === 0) return { kind: 'string', value: '' }
  return { kind: 'string', value: chars.slice(chars.length - n).join('') }
}

/**
 * MID(text, start, num_chars) — substring with 1-based `start`.
 *  - `start < 1`                  → `#VALUE!`
 *  - `num_chars < 0`              → `#VALUE!`
 *  - `start > length`             → "" (empty string, not error — Excel)
 *  - `start + num_chars > length` → truncated to end
 */
const MID: FunctionImpl = (args) => {
  if (args.length !== 3) return errValue('#VALUE!', 'MID takes exactly 3 arguments')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  const sr = toNumber(args[1])
  if (!sr.ok) return sr.error
  const nr = toNumber(args[2])
  if (!nr.ok) return nr.error
  const start = Math.trunc(sr.value)
  const num = Math.trunc(nr.value)
  if (start < 1) return ERR_VALUE
  if (num < 0) return ERR_VALUE
  const chars = codepoints(ts.value)
  if (start > chars.length) return { kind: 'string', value: '' }
  // Convert 1-based start to 0-based slice index.
  return { kind: 'string', value: chars.slice(start - 1, start - 1 + num).join('') }
}

// =============================================================================
// LEFTB / RIGHTB / MIDB / LENB
// =============================================================================

/**
 * LEFTB(text, [num_bytes=1]) — first N DBCS bytes. ASCII counts as 1 byte;
 * Japanese/full-width characters count as 2 bytes. Partial double-byte chars
 * at the boundary are not returned.
 */
const LEFTB: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2)
    return errValue('#VALUE!', 'LEFTB takes 1 or 2 arguments')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  let n = 1
  if (args.length === 2) {
    const nr = toNumber(args[1])
    if (!nr.ok) return nr.error
    n = Math.trunc(nr.value)
    if (n < 0) return ERR_VALUE
  }
  return { kind: 'string', value: leftDbcsBytes(ts.value, n) }
}

/** RIGHTB(text, [num_bytes=1]) — last N DBCS bytes. */
const RIGHTB: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2)
    return errValue('#VALUE!', 'RIGHTB takes 1 or 2 arguments')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  let n = 1
  if (args.length === 2) {
    const nr = toNumber(args[1])
    if (!nr.ok) return nr.error
    n = Math.trunc(nr.value)
    if (n < 0) return ERR_VALUE
  }
  return { kind: 'string', value: rightDbcsBytes(ts.value, n) }
}

/** MIDB(text, start_num, num_bytes) — substring by 1-based DBCS byte offsets. */
const MIDB: FunctionImpl = (args) => {
  if (args.length !== 3) return errValue('#VALUE!', 'MIDB takes exactly 3 arguments')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  const sr = toNumber(args[1])
  if (!sr.ok) return sr.error
  const nr = toNumber(args[2])
  if (!nr.ok) return nr.error
  const start = Math.trunc(sr.value)
  const num = Math.trunc(nr.value)
  if (start < 1) return ERR_VALUE
  if (num < 0) return ERR_VALUE
  if (start > dbcsByteLength(ts.value)) return { kind: 'string', value: '' }
  return { kind: 'string', value: sliceDbcsBytes(ts.value, start, num) }
}

/** LENB(text) — DBCS byte count. */
const LENB: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'LENB takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  return { kind: 'number', value: dbcsByteLength(ts.value) }
}

// =============================================================================
// LEN / LOWER / UPPER / TRIM
// =============================================================================

/**
 * LEN(text) — code-point count. See module header for the
 * `Array.from(text).length` vs `text.length` choice.
 */
const LEN: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'LEN takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  return { kind: 'number', value: codepoints(ts.value).length }
}

/** LOWER(text) — locale-independent lowercasing. */
const LOWER: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'LOWER takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  return { kind: 'string', value: ts.value.toLowerCase() }
}

/** UPPER(text) — locale-independent uppercasing. */
const UPPER: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'UPPER takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  return { kind: 'string', value: ts.value.toUpperCase() }
}

/**
 * TRIM(text) — Excel's TRIM, NOT JS `.trim()`:
 *  1. Strip leading U+0020 spaces.
 *  2. Strip trailing U+0020 spaces.
 *  3. Collapse interior runs of U+0020 spaces to a single space.
 *
 * Excel specifically trims ASCII spaces (U+0020) — non-breaking space
 * (U+00A0) is *not* trimmed by classic Excel TRIM. We mirror that strict
 * behavior: tabs and newlines are not treated as TRIM spaces either.
 */
const TRIM: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'TRIM takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  const collapsed = ts.value.replace(/ +/g, ' ').replace(/^ +| +$/g, '')
  return { kind: 'string', value: collapsed }
}

// =============================================================================
// TEXT
// =============================================================================

/**
 * Supported format codes:
 *   "0"         integer with no thousands separator
 *   "000"       zero-padded integer width
 *   "0.00"      fixed 2 decimals
 *   "#,##0"     integer with thousands separator
 *   "#,##0.00"  thousands + 2 decimals
 *   "0%"        integer percent (multiplies by 100, appends %)
 *   "0.00%"     2-decimal percent
 *   "$#,##0.00" USD currency
 *   "yyyy-mm-dd", month/day names, time, elapsed time, and fractional seconds
 *   positive;negative numeric sections such as "#,##0;(#,##0)"
 *   "0.00E+00" scientific notation
 *   "# ?/?"     simple fraction notation
 *   quoted literal suffix/prefix, bracket color/currency tags, and trailing
 *   comma thousand scaling
 *
 * Out of scope:
 *   - Locale semantics, rendered colors, and full custom formats.
 */
function formatTextNumber(n: number, format: string): string | undefined {
  if (format.length === 0) return undefined

  const sections = splitTextNumberSections(format)
  if (!sections) return undefined
  if (sections.length > 1) {
    const parsed = sections.map(extractTextNumberSectionCondition)
    const conditioned = parsed.find(
      (section) => section.condition && matchesTextNumberCondition(section.condition, n),
    )
    if (conditioned) return formatSelectedTextNumberSection(n, conditioned.body)

    const unconditioned = parsed.filter((section) => !section.condition)
    if (unconditioned.length === 0) return undefined
    const section = n < 0
      ? unconditioned[1] ?? unconditioned[0]
      : n === 0 && unconditioned[2]
        ? unconditioned[2]
        : unconditioned[0]
    return formatSelectedTextNumberSection(n < 0 ? Math.abs(n) : n, section.body)
  }

  return formatTextNumberSection(n, format)
}

function formatSelectedTextNumberSection(n: number, format: string): string | undefined {
  return format === '' ? '' : formatTextNumberSection(n, format)
}

function formatTextTextValue(text: string, format: string): string | undefined {
  const sections = splitTextNumberSections(format)
  if (!sections) return undefined
  const section = sections.length === 4
    ? sections[3]
    : sections.length === 1
      ? sections[0]
      : undefined
  if (section === undefined) return undefined
  if (section === '') return sections.length === 4 ? '' : undefined

  const rendered = renderTextTextSection(text, section)
  if (!rendered) return undefined
  if (sections.length === 1 && !rendered.hasPlaceholder) return undefined
  return rendered.value
}

function renderTextTextSection(
  text: string,
  format: string,
): { readonly value: string; readonly hasPlaceholder: boolean } | undefined {
  const stripped = stripTextNumberBracketTags(format)
  if (stripped !== format) return renderTextTextSection(text, stripped)

  let out = ''
  let hasPlaceholder = false
  let hasExplicitLiteral = false
  let i = 0
  while (i < format.length) {
    const ch = format[i]

    if (ch === '"') {
      i += 1
      let closed = false
      hasExplicitLiteral = true
      while (i < format.length) {
        const next = format[i]
        if (next === '"') {
          if (format[i + 1] === '"') {
            out += '"'
            i += 2
            continue
          }
          closed = true
          i += 1
          break
        }
        out += next
        i += 1
      }
      if (!closed) return undefined
      continue
    }

    if (ch === '\\') {
      const literal = format[i + 1]
      if (literal === undefined) return undefined
      out += literal
      hasExplicitLiteral = true
      i += 2
      continue
    }

    if (ch === '_' && format[i + 1] !== undefined) {
      out += ' '
      hasExplicitLiteral = true
      i += 2
      continue
    }

    if (ch === '*' && format[i + 1] !== undefined) {
      hasExplicitLiteral = true
      i += 2
      continue
    }

    if (ch === '@') {
      out += text
      hasPlaceholder = true
      i += 1
      continue
    }

    out += ch
    i += 1
  }

  if (!hasPlaceholder && !hasExplicitLiteral) return undefined
  return { value: out, hasPlaceholder }
}

function splitTextNumberSections(format: string): string[] | undefined {
  const sections: string[] = []
  let buffer = ''
  let inString = false
  let inBracket = false

  for (let i = 0; i < format.length; i += 1) {
    const ch = format[i]

    if (ch === '\\' && i + 1 < format.length) {
      buffer += ch + format[i + 1]
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

  if (inString || inBracket) return undefined
  sections.push(buffer)
  return sections
}

interface TextNumberCondition {
  readonly op: '>' | '<' | '=' | '>=' | '<=' | '<>'
  readonly value: number
}

function extractTextNumberSectionCondition(section: string): {
  readonly body: string
  readonly condition?: TextNumberCondition
} {
  let prefix = ''
  let index = 0
  let condition: TextNumberCondition | undefined

  while (section[index] === '[') {
    const end = section.indexOf(']', index + 1)
    if (end < 0) break
    const tag = section.slice(index + 1, end).trim()
    const parsed = parseTextNumberConditionTag(tag)
    if (parsed) {
      condition = parsed
    } else {
      prefix += section.slice(index, end + 1)
    }
    index = end + 1
  }

  return { body: prefix + section.slice(index), condition }
}

function parseTextNumberConditionTag(tag: string): TextNumberCondition | undefined {
  const match = /^(>=|<=|<>|>|<|=)\s*(-?\d+(?:\.\d+)?)$/.exec(tag)
  if (!match) return undefined
  const value = Number(match[2])
  if (!Number.isFinite(value)) return undefined
  return { op: match[1] as TextNumberCondition['op'], value }
}

function matchesTextNumberCondition(condition: TextNumberCondition, value: number): boolean {
  switch (condition.op) {
    case '>':
      return value > condition.value
    case '<':
      return value < condition.value
    case '=':
      return value === condition.value
    case '>=':
      return value >= condition.value
    case '<=':
      return value <= condition.value
    case '<>':
      return value !== condition.value
  }
}

function formatTextNumberSection(n: number, format: string): string | undefined {
  const stripped = stripTextNumberBracketTags(format)
  if (stripped !== format) return formatTextNumberSection(n, stripped)

  const date = formatDateSerial(n, format)
  if (date !== undefined) return date

  if (format.startsWith('(') && format.endsWith(')')) {
    const inner = formatTextNumberSection(n, format.slice(1, -1))
    return inner === undefined ? undefined : `(${inner})`
  }

  const scientific = formatTextScientific(n, format)
  if (scientific !== undefined) return scientific

  const fraction = formatTextFraction(n, format)
  if (fraction !== undefined) return fraction

  switch (format) {
    case '0':
      return roundHalfAwayFromZero(n).toString()
    case '0.00':
      return n.toFixed(2)
    case '#,##0':
      return formatThousands(roundHalfAwayFromZero(n), 0)
    case '#,##0.00':
      return formatThousands(n, 2)
    case '0%':
      return `${roundHalfAwayFromZero(n * 100)}%`
    case '0.00%':
      return `${(n * 100).toFixed(2)}%`
    case '$#,##0.00':
      return `$${formatThousands(n, 2)}`
    default:
      break
  }

  if (/^0+$/.test(format)) {
    const rounded = roundHalfAwayFromZero(n)
    const sign = rounded < 0 ? '-' : ''
    return `${sign}${Math.abs(rounded).toString().padStart(format.length, '0')}`
  }

  const fixed = format.match(/^(0+)\.(0+)$/)
  if (fixed) {
    return n.toFixed(fixed[2].length)
  }

  const custom = formatTextCustomNumber(n, format)
  if (custom !== undefined) return custom

  const literal = formatTextLiteralOnly(format)
  if (literal !== undefined) return literal

  return undefined
}

const TEXT_NUMBER_COLOR_TAGS = new Set([
  'black',
  'white',
  'red',
  'green',
  'blue',
  'cyan',
  'magenta',
  'yellow',
])

function stripTextNumberBracketTags(format: string): string {
  let out = ''
  let changed = false
  let i = 0
  while (i < format.length) {
    const ch = format[i]

    if (ch === '"') {
      out += ch
      i += 1
      while (i < format.length) {
        const next = format[i]
        out += next
        if (next === '"') {
          if (format[i + 1] === '"') {
            out += format[i + 1]
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }

    if (ch === '\\') {
      out += ch
      if (format[i + 1] !== undefined) {
        out += format[i + 1]
        i += 2
      } else {
        i += 1
      }
      continue
    }

    if (ch === '[') {
      const end = format.indexOf(']', i + 1)
      if (end >= 0) {
        const replacement = replacementForTextNumberBracketTag(format.slice(i + 1, end))
        if (replacement !== undefined) {
          out += replacement
          changed = true
          i = end + 1
          continue
        }
        out += format.slice(i, end + 1)
        i = end + 1
        continue
      }
    }

    out += ch
    i += 1
  }
  return changed ? out : format
}

function replacementForTextNumberBracketTag(tag: string): string | undefined {
  const trimmed = tag.trim()
  const lower = trimmed.toLowerCase()
  if (TEXT_NUMBER_COLOR_TAGS.has(lower) || /^color\d+$/.test(lower)) return ''
  if (!trimmed.startsWith('$')) return undefined
  const currencyAndLocale = trimmed.slice(1)
  const localeStart = currencyAndLocale.indexOf('-')
  return localeStart >= 0 ? currencyAndLocale.slice(0, localeStart) : currencyAndLocale
}

function roundHalfAwayFromZero(n: number): number {
  return n < 0 ? -Math.round(Math.abs(n)) : Math.round(n)
}

function formatTextScientific(n: number, format: string): string | undefined {
  const match = /^(0)(?:\.(0+))?([Ee])\+(0+)$/.exec(format)
  if (!match) return undefined
  if (!Number.isFinite(n)) return undefined
  const decimals = match[2]?.length ?? 0
  const exponentChar = match[3]
  const exponentWidth = match[4].length
  const exponential = n.toExponential(decimals)
  const parts = /^(-?)(\d+(?:\.\d+)?)e([+-])(\d+)$/.exec(exponential)
  if (!parts) return undefined
  const [, sign, mantissa, exponentSign, exponentDigits] = parts
  const exponent = exponentDigits.padStart(exponentWidth, '0')
  return `${sign}${mantissa}${exponentChar}${exponentSign}${exponent}`
}

function formatTextFraction(n: number, format: string): string | undefined {
  const match = /^# (\?+)\/(\?+)$/.exec(format)
  if (!match) return undefined
  if (!Number.isFinite(n)) return undefined
  const numeratorWidth = match[1].length
  const denominatorWidth = match[2].length
  if (numeratorWidth !== denominatorWidth) return undefined

  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  let whole = Math.floor(abs)
  const frac = abs - whole
  if (frac === 0) return `${sign}${whole}`

  const maxDenominator = 10 ** denominatorWidth - 1
  const approx = approximateFraction(frac, maxDenominator)
  if (approx.numerator === 0) return `${sign}${whole}`
  if (approx.numerator === approx.denominator) {
    whole += 1
    return `${sign}${whole}`
  }

  const numerator = approx.numerator.toString().padStart(numeratorWidth, ' ')
  const denominator = approx.denominator.toString().padStart(denominatorWidth, ' ')
  if (whole === 0) return `${sign} ${numerator}/${denominator}`
  return `${sign}${whole} ${numerator}/${denominator}`
}

type TextNumberFormatToken =
  | { readonly kind: 'pattern'; readonly value: string }
  | { readonly kind: 'literal'; readonly value: string }

function tokenizeTextNumberFormat(format: string): TextNumberFormatToken[] | undefined {
  const tokens: TextNumberFormatToken[] = []
  let i = 0
  while (i < format.length) {
    const ch = format[i]
    if (ch === '"') {
      let literal = ''
      i += 1
      let closed = false
      while (i < format.length) {
        const next = format[i]
        if (next === '"') {
          if (format[i + 1] === '"') {
            literal += '"'
            i += 2
            continue
          }
          closed = true
          i += 1
          break
        }
        literal += next
        i += 1
      }
      if (!closed) return undefined
      if (literal !== '') tokens.push({ kind: 'literal', value: literal })
      continue
    }

    if (ch === '\\') {
      const literal = format[i + 1]
      if (literal === undefined) return undefined
      tokens.push({ kind: 'literal', value: literal })
      i += 2
      continue
    }

    if (ch === '_' && format[i + 1] !== undefined) {
      tokens.push({ kind: 'literal', value: ' ' })
      i += 2
      continue
    }

    if (ch === '*' && format[i + 1] !== undefined) {
      i += 2
      continue
    }

    if ('0#.,%'.includes(ch)) tokens.push({ kind: 'pattern', value: ch })
    else tokens.push({ kind: 'literal', value: ch })
    i += 1
  }
  return tokens
}

function formatTextCustomNumber(n: number, format: string): string | undefined {
  if (!Number.isFinite(n)) return undefined
  const tokens = tokenizeTextNumberFormat(format)
  if (!tokens) return undefined

  const firstPattern = tokens.findIndex((token) => token.kind === 'pattern')
  if (firstPattern < 0) return undefined

  let lastPattern = -1
  for (let i = tokens.length - 1; i >= firstPattern; i -= 1) {
    if (tokens[i].kind === 'pattern') {
      lastPattern = i
      break
    }
  }
  if (lastPattern < 0) return undefined

  const patternTokens = tokens.slice(firstPattern, lastPattern + 1)
  if (patternTokens.some((token) => token.kind !== 'pattern')) {
    return formatTextCustomIntegerMask(n, tokens, firstPattern, lastPattern)
  }
  const pattern = patternTokens.map((token) => token.value).join('')
  if (!/[0#]/.test(pattern)) return undefined

  const prefix = tokens.slice(0, firstPattern).map((token) => token.value).join('')
  const suffix = tokens.slice(lastPattern + 1).map((token) => token.value).join('')
  const body = formatTextCustomNumberPattern(n, pattern)
  if (body !== undefined) return `${prefix}${body}${suffix}`

  return formatTextCustomIntegerMask(n, tokens, firstPattern, lastPattern)
}

function formatTextCustomNumberPattern(n: number, pattern: string): string | undefined {
  const percentCount = (pattern.match(/%/g) ?? []).length
  const numericPattern = pattern.replace(/%/g, '')
  if ((numericPattern.match(/\./g) ?? []).length > 1) return undefined

  const dot = numericPattern.indexOf('.')
  let intPattern = dot >= 0 ? numericPattern.slice(0, dot) : numericPattern
  const fracPattern = dot >= 0 ? numericPattern.slice(dot + 1) : ''

  let scaleCommas = 0
  while (intPattern.endsWith(',')) {
    scaleCommas += 1
    intPattern = intPattern.slice(0, -1)
  }

  const validIntegerPattern = /^[0#,]+$/.test(intPattern)
  const validFractionPattern = fracPattern === '' || /^[0#]+$/.test(fracPattern)
  if (!validIntegerPattern || !validFractionPattern) {
    return undefined
  }

  const intDigits = intPattern.replace(/,/g, '')
  if (!/[0#]/.test(intDigits)) return undefined

  const requiredIntDigits = codepoints(intDigits).filter((ch) => ch === '0').length
  const minIntDigits = requiredIntDigits
  const requiredFracDigits = codepoints(fracPattern).filter((ch) => ch === '0').length
  const maxFracDigits = fracPattern.length
  const useCommas = intPattern.includes(',')
  const scaled = (n * 100 ** percentCount) / 1000 ** scaleCommas
  const negative = scaled < 0
  const abs = Math.abs(scaled)
  const rounded = maxFracDigits > 0 ? abs.toFixed(maxFracDigits) : Math.round(abs).toString()
  let [whole, frac = ''] = rounded.split('.')
  whole = whole.padStart(minIntDigits, '0')
  if (requiredIntDigits === 0 && Number(whole) === 0) whole = ''
  if (useCommas) whole = insertCommas(whole)

  if (maxFracDigits > 0) {
    while (frac.length > requiredFracDigits && frac.endsWith('0')) frac = frac.slice(0, -1)
  }

  const decimal = frac !== '' ? `.${frac}` : ''
  return `${negative ? '-' : ''}${whole}${decimal}${'%'.repeat(percentCount)}`
}

function formatTextCustomIntegerMask(
  n: number,
  tokens: readonly TextNumberFormatToken[],
  firstPattern: number,
  lastPattern: number,
): string | undefined {
  if (!Number.isFinite(n)) return undefined
  let placeholderCount = 0
  for (let i = firstPattern; i <= lastPattern; i += 1) {
    const token = tokens[i]
    if (token.kind === 'pattern') {
      if (token.value !== '0' && token.value !== '#') return undefined
      placeholderCount += 1
      continue
    }
    if (!/^[ ()-]*$/.test(token.value)) return undefined
  }
  if (placeholderCount === 0) return undefined

  let remaining = Math.round(Math.abs(n)).toString()
  const parts = tokens.map((token) => token.value)
  let firstSlot = -1
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i]
    if (token.kind !== 'pattern') continue
    firstSlot = i
    const digit = remaining.length > 0 ? remaining.slice(-1) : ''
    remaining = remaining.slice(0, -1)
    if (digit !== '') {
      parts[i] = digit
    } else {
      parts[i] = token.value === '0' ? '0' : ''
    }
  }

  if (remaining !== '' && firstSlot >= 0) parts[firstSlot] = remaining + parts[firstSlot]
  return `${n < 0 ? '-' : ''}${parts.join('')}`
}

function formatTextLiteralOnly(format: string): string | undefined {
  let out = ''
  let hasExplicitLiteral = false
  let i = 0
  while (i < format.length) {
    const ch = format[i]

    if (ch === '"') {
      i += 1
      let closed = false
      hasExplicitLiteral = true
      while (i < format.length) {
        const next = format[i]
        if (next === '"') {
          if (format[i + 1] === '"') {
            out += '"'
            i += 2
            continue
          }
          closed = true
          i += 1
          break
        }
        out += next
        i += 1
      }
      if (!closed) return undefined
      continue
    }

    if (ch === '\\') {
      const literal = format[i + 1]
      if (literal === undefined) return undefined
      out += literal
      hasExplicitLiteral = true
      i += 2
      continue
    }

    if (ch === '_' && format[i + 1] !== undefined) {
      out += ' '
      hasExplicitLiteral = true
      i += 2
      continue
    }

    if (ch === '*' && format[i + 1] !== undefined) {
      hasExplicitLiteral = true
      i += 2
      continue
    }

    if ('0#?'.includes(ch) || /^[A-Za-z]$/.test(ch)) return undefined
    out += ch
    i += 1
  }

  return hasExplicitLiteral ? out : undefined
}

function approximateFraction(value: number, maxDenominator: number): {
  readonly numerator: number
  readonly denominator: number
} {
  let bestNumerator = 0
  let bestDenominator = 1
  let bestError = Math.abs(value)
  for (let denominator = 1; denominator <= maxDenominator; denominator += 1) {
    const numerator = Math.round(value * denominator)
    const error = Math.abs(value - numerator / denominator)
    if (error < bestError - 1e-12) {
      bestError = error
      bestNumerator = numerator
      bestDenominator = denominator
    }
  }
  return { numerator: bestNumerator, denominator: bestDenominator }
}

const TEXT_DATE_ANCHOR_UTC_MS = Date.UTC(1899, 11, 31)
const TEXT_MS_PER_DAY = 86_400_000

function formatDateSerial(serial: number, format: string): string | undefined {
  const parsed = parseTextDateTimeFormat(format)
  if (!parsed) return undefined
  return renderTextDateTime(serial, parsed)
}

function excelDateParts(serial: number):
  | {
    readonly year: number
    readonly month: number
    readonly day: number
    readonly weekday: number
  }
  | undefined {
  if (!Number.isFinite(serial)) return undefined
  const whole = Math.floor(serial)
  if (whole < 0) return undefined
  if (whole === 60) return { year: 1900, month: 2, day: 29, weekday: 3 }
  const days = whole > 60 ? whole - 1 : whole
  const date = new Date(TEXT_DATE_ANCHOR_UTC_MS + days * TEXT_MS_PER_DAY)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  }
}

const TEXT_MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]
const TEXT_MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const TEXT_DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const TEXT_DAY_LONG = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]

type TextDateTimeToken =
  | { readonly kind: 'literal'; readonly value: string }
  | {
    readonly kind: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'
    readonly count: number
  }
  | {
    readonly kind: 'elapsed-hour' | 'elapsed-minute' | 'elapsed-second'
    readonly count: number
  }
  | { readonly kind: 'fractional-second'; readonly count: number }
  | { readonly kind: 'elapsed-fractional-second'; readonly count: number }
  | { readonly kind: 'meridian'; readonly style: 'AM/PM' | 'am/pm' | 'A/P' | 'a/p' }

interface TextDateTimeFormat {
  readonly tokens: TextDateTimeToken[]
  readonly hasDate: boolean
  readonly hasTime: boolean
  readonly hasMeridian: boolean
  readonly fractionalSecondDigits: number
}

function parseTextDateTimeFormat(format: string): TextDateTimeFormat | undefined {
  const tokens: TextDateTimeToken[] = []
  let hasDate = false
  let hasTime = false
  let hasElapsed = false
  let hasMeridian = false
  let fractionalSecondDigits = 0

  let i = 0
  while (i < format.length) {
    const ch = format[i]

    if (ch === '"') {
      let literal = ''
      i += 1
      let closed = false
      while (i < format.length) {
        const next = format[i]
        if (next === '"') {
          if (format[i + 1] === '"') {
            literal += '"'
            i += 2
            continue
          }
          closed = true
          i += 1
          break
        }
        literal += next
        i += 1
      }
      if (!closed) return undefined
      if (literal !== '') tokens.push({ kind: 'literal', value: literal })
      continue
    }

    if (ch === '\\') {
      const literal = format[i + 1]
      if (literal === undefined) return undefined
      tokens.push({ kind: 'literal', value: literal })
      i += 2
      continue
    }

    if (ch === '_' && format[i + 1] !== undefined) {
      tokens.push({ kind: 'literal', value: ' ' })
      i += 2
      continue
    }

    if (ch === '*' && format[i + 1] !== undefined) {
      i += 2
      continue
    }

    const elapsed = matchTextElapsedToken(format, i)
    if (elapsed) {
      tokens.push(elapsed.token)
      hasElapsed = true
      hasTime = true
      i += elapsed.length
      if (elapsed.token.kind === 'elapsed-second') {
        const fraction = matchTextFractionalSecond(format, i)
        if (fraction) {
          tokens.push({ kind: 'literal', value: '.' })
          tokens.push({ kind: 'elapsed-fractional-second', count: fraction.count })
          fractionalSecondDigits = Math.max(fractionalSecondDigits, fraction.count)
          i += fraction.length
        }
      }
      continue
    }

    const meridian = matchTextMeridianToken(format, i)
    if (meridian) {
      tokens.push({ kind: 'meridian', style: meridian.style })
      hasMeridian = true
      hasTime = true
      i += meridian.length
      continue
    }

    const lower = ch.toLowerCase()
    if (lower === 'y' || lower === 'm' || lower === 'd' || lower === 'h' || lower === 's') {
      let j = i + 1
      while (j < format.length && format[j].toLowerCase() === lower) j += 1
      const count = j - i
      if (lower === 'y') {
        tokens.push({ kind: 'year', count })
        hasDate = true
      } else if (lower === 'm') {
        tokens.push({ kind: 'month', count })
        hasDate = true
      } else if (lower === 'd') {
        tokens.push({ kind: 'day', count })
        hasDate = true
      } else if (lower === 'h') {
        tokens.push({ kind: 'hour', count })
        hasTime = true
      } else {
        tokens.push({ kind: 'second', count })
        hasTime = true
        const fraction = matchTextFractionalSecond(format, j)
        if (fraction) {
          tokens.push({ kind: 'literal', value: '.' })
          tokens.push({ kind: 'fractional-second', count: fraction.count })
          fractionalSecondDigits = Math.max(fractionalSecondDigits, fraction.count)
          j += fraction.length
        }
      }
      i = j
      continue
    }

    if (/^[A-Za-z]$/.test(ch)) return undefined
    tokens.push({ kind: 'literal', value: ch })
    i += 1
  }

  disambiguateTextDateTimeMinutes(tokens)

  const meaningful = hasDate || hasTime || hasElapsed || hasMeridian
  if (!meaningful) return undefined
  return { tokens, hasDate, hasTime, hasMeridian, fractionalSecondDigits }
}

function matchTextElapsedToken(
  format: string,
  index: number,
): { readonly token: TextDateTimeToken; readonly length: number } | undefined {
  if (format[index] !== '[') return undefined
  const end = format.indexOf(']', index + 1)
  if (end < 0) return undefined
  const raw = format.slice(index + 1, end)
  const lower = raw.toLowerCase()
  if (!/^(h+|m+|s+)$/.test(lower)) return undefined
  const count = raw.length
  const unit = lower[0]
  if (unit === 'h') {
    return { token: { kind: 'elapsed-hour', count }, length: end - index + 1 }
  }
  if (unit === 'm') {
    return { token: { kind: 'elapsed-minute', count }, length: end - index + 1 }
  }
  return { token: { kind: 'elapsed-second', count }, length: end - index + 1 }
}

function matchTextMeridianToken(
  format: string,
  index: number,
):
  | { readonly style: 'AM/PM' | 'am/pm' | 'A/P' | 'a/p'; readonly length: number }
  | undefined {
  if (format.startsWith('AM/PM', index)) return { style: 'AM/PM', length: 5 }
  if (format.startsWith('am/pm', index)) return { style: 'am/pm', length: 5 }
  if (format.startsWith('A/P', index)) return { style: 'A/P', length: 3 }
  if (format.startsWith('a/p', index)) return { style: 'a/p', length: 3 }
  return undefined
}

function matchTextFractionalSecond(
  format: string,
  index: number,
): { readonly count: number; readonly length: number } | undefined {
  if (format[index] !== '.') return undefined
  let end = index + 1
  while (format[end] === '0') end += 1
  const count = end - index - 1
  return count > 0 ? { count, length: count + 1 } : undefined
}

function disambiguateTextDateTimeMinutes(tokens: TextDateTimeToken[]) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.kind !== 'month') continue
    const previous = nearestNonLiteralTextDateTimeToken(tokens, i, -1)
    const next = nearestNonLiteralTextDateTimeToken(tokens, i, 1)
    if (
      previous?.kind === 'hour' ||
      previous?.kind === 'elapsed-hour' ||
      next?.kind === 'second' ||
      next?.kind === 'elapsed-second'
    ) {
      tokens[i] = { kind: 'minute', count: token.count }
    }
  }
}

function nearestNonLiteralTextDateTimeToken(
  tokens: readonly TextDateTimeToken[],
  start: number,
  direction: -1 | 1,
): TextDateTimeToken | undefined {
  for (let i = start + direction; i >= 0 && i < tokens.length; i += direction) {
    if (tokens[i].kind !== 'literal') return tokens[i]
  }
  return undefined
}

function renderTextDateTime(serial: number, format: TextDateTimeFormat): string | undefined {
  if (!Number.isFinite(serial) || serial < 0) return undefined
  const scale = 10 ** Math.min(format.fractionalSecondDigits, 6)
  const totalUnits = Math.round(serial * 86_400 * scale)
  const unitsPerDay = 86_400 * scale
  const dayUnits = totalUnits % unitsPerDay
  const dayCarry = Math.floor(totalUnits / unitsPerDay) - Math.floor(serial)
  const dateParts = excelDateParts(Math.floor(serial) + (format.hasTime ? dayCarry : 0))
  if (!dateParts && format.hasDate) return undefined

  const totalSecondsInDay = Math.floor(dayUnits / scale)
  const fractionalSecond = dayUnits % scale
  const elapsedFractionalSecond = totalUnits % scale
  const hour24 = Math.floor(totalSecondsInDay / 3600) % 24
  const minute = Math.floor(totalSecondsInDay / 60) % 60
  const second = totalSecondsInDay % 60
  const hour12 = ((hour24 + 11) % 12) + 1

  let out = ''
  for (const token of format.tokens) {
    switch (token.kind) {
      case 'literal':
        out += token.value
        break
      case 'year':
        out += token.count <= 2
          ? String(dateParts!.year % 100).padStart(2, '0')
          : String(dateParts!.year).padStart(4, '0')
        break
      case 'month':
        out += renderTextDateMonth(dateParts!.month, token.count)
        break
      case 'day':
        out += renderTextDateDay(dateParts!.day, dateParts!.weekday, token.count)
        break
      case 'hour': {
        const value = format.hasMeridian ? hour12 : hour24
        out += token.count >= 2 ? String(value).padStart(2, '0') : String(value)
        break
      }
      case 'minute':
        out += token.count >= 2 ? String(minute).padStart(2, '0') : String(minute)
        break
      case 'second':
        out += token.count >= 2 ? String(second).padStart(2, '0') : String(second)
        break
      case 'fractional-second':
        out += String(fractionalSecond).padStart(token.count, '0')
        break
      case 'elapsed-fractional-second':
        out += String(elapsedFractionalSecond).padStart(token.count, '0')
        break
      case 'elapsed-hour':
        out += padTextElapsed(Math.floor(totalUnits / (3600 * scale)), token.count)
        break
      case 'elapsed-minute':
        out += padTextElapsed(Math.floor(totalUnits / (60 * scale)), token.count)
        break
      case 'elapsed-second':
        out += padTextElapsed(Math.floor(totalUnits / scale), token.count)
        break
      case 'meridian': {
        const isPm = hour24 >= 12
        if (token.style === 'AM/PM') out += isPm ? 'PM' : 'AM'
        else if (token.style === 'am/pm') out += isPm ? 'pm' : 'am'
        else if (token.style === 'A/P') out += isPm ? 'P' : 'A'
        else out += isPm ? 'p' : 'a'
        break
      }
    }
  }
  return out
}

function renderTextDateMonth(month: number, count: number): string {
  if (count === 1) return String(month)
  if (count === 2) return String(month).padStart(2, '0')
  if (count === 3) return TEXT_MONTH_SHORT[month - 1] ?? ''
  return TEXT_MONTH_LONG[month - 1] ?? ''
}

function renderTextDateDay(day: number, weekday: number, count: number): string {
  if (count === 1) return String(day)
  if (count === 2) return String(day).padStart(2, '0')
  if (count === 3) return TEXT_DAY_SHORT[weekday] ?? ''
  return TEXT_DAY_LONG[weekday] ?? ''
}

function padTextElapsed(value: number, count: number): string {
  return count >= 2 ? String(value).padStart(2, '0') : String(value)
}

/** Format a number with thousands separators and a fixed decimal count. */
function formatThousands(n: number, decimals: number): string {
  const negative = n < 0
  const abs = Math.abs(n)
  // Round to the requested number of decimals first so we don't carry
  // float noise into the integer portion.
  const rounded = decimals > 0
    ? abs.toFixed(decimals)
    : Math.round(abs).toString()
  const [intPart, decPart] = rounded.split('.')
  // Insert commas every 3 digits from the right.
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = decPart !== undefined ? `${withCommas}.${decPart}` : withCommas
  return negative ? `-${body}` : body
}

/**
 * TEXT(value, format_code) — format a number per Excel format string.
 * Text values pass through unless the format has an explicit `@` text section.
 */
const TEXT: FunctionImpl = (args) => {
  if (args.length !== 2) return errValue('#VALUE!', 'TEXT takes exactly 2 arguments')
  const err = propagateError(args)
  if (err) return err
  const fmtR = coerceText(args[1])
  if (!fmtR.ok) return fmtR.error
  const fmt = fmtR.value
  const v = args[0]
  if (v.kind === 'string') {
    return { kind: 'string', value: formatTextTextValue(v.value, fmt) ?? v.value }
  }
  if (v.kind === 'blank') return { kind: 'string', value: '' }
  if (v.kind === 'boolean') return { kind: 'string', value: v.value ? 'TRUE' : 'FALSE' }
  // For arrays, format the top-left scalar (Wave E will broadcast).
  if (v.kind === 'array') {
    const row = v.value[0]
    if (!row || row.length === 0) return ERR_VALUE
    const inner = row[0]
    if (inner.kind === 'error') return inner
    if (inner.kind === 'string') {
      return { kind: 'string', value: formatTextTextValue(inner.value, fmt) ?? inner.value }
    }
    if (inner.kind === 'blank') return { kind: 'string', value: '' }
    if (inner.kind === 'boolean') return { kind: 'string', value: inner.value ? 'TRUE' : 'FALSE' }
    if (inner.kind === 'number') {
      const formatted = formatTextNumber(inner.value, fmt)
      return formatted === undefined ? ERR_VALUE : { kind: 'string', value: formatted }
    }
    return ERR_VALUE
  }
  if (v.kind !== 'number') return ERR_VALUE
  const formatted = formatTextNumber(v.value, fmt)
  return formatted === undefined ? ERR_VALUE : { kind: 'string', value: formatted }
}

// =============================================================================
// VALUE
// =============================================================================

/**
 * VALUE(text) — parse a string as a number.
 *
 * Excel accepts:
 *   - Leading currency `$`            ("$1,234.5" → 1234.5)
 *   - Thousands separator `,`         ("1,234"    → 1234)
 *   - Trailing percent `%`            ("50%"      → 0.5)
 *   - Leading sign `+` / `-`          ("-1,000"   → -1000)
 *   - Surrounding whitespace          (" 42 "     → 42)
 *
 * Anything that doesn't fit the (sign? currency? digits[.digits]? percent?)
 * shape → `#VALUE!`. Booleans coerce (TRUE → 1, FALSE → 0). Numbers pass
 * through.
 */
const VALUE: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'VALUE takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const v = args[0]
  switch (v.kind) {
    case 'number':
      return v
    case 'boolean':
      return { kind: 'number', value: v.value ? 1 : 0 }
    case 'blank':
      return { kind: 'number', value: 0 }
    case 'array': {
      const row = v.value[0]
      if (!row || row.length === 0) return ERR_VALUE
      // Top-left scalar — same logic, inline to avoid bogus ctx.
      const inner = row[0]
      if (inner.kind === 'string') return parseValueString(inner.value)
      if (inner.kind === 'number') return inner
      if (inner.kind === 'boolean') return { kind: 'number', value: inner.value ? 1 : 0 }
      if (inner.kind === 'blank') return { kind: 'number', value: 0 }
      if (inner.kind === 'error') return inner
      return ERR_VALUE
    }
    case 'error':
      return v
    case 'string':
      return parseValueString(v.value)
  }
}

/**
 * Parse the string-half of VALUE. Returns a Value (number or error).
 * Extracted so the array-fallback branch can reuse it without faking a
 * FunctionImpl call signature.
 */
function parseValueString(raw: string): Value {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ERR_VALUE
  // Allow leading `$`, strip thousands `,`, allow trailing `%`.
  let s = trimmed
  // Pull off leading sign for later re-application.
  let sign = 1
  if (s.startsWith('-')) {
    sign = -1
    s = s.slice(1).trimStart()
  } else if (s.startsWith('+')) {
    s = s.slice(1).trimStart()
  }
  if (s.startsWith('$')) s = s.slice(1).trimStart()
  // Trailing percent.
  let percent = false
  if (s.endsWith('%')) {
    percent = true
    s = s.slice(0, -1).trimEnd()
  }
  // Strip thousands separators only if they fit the comma-every-3
  // pattern. Excel is strict: "1,2,3" is not a number. We do a light
  // sanity check before removing them.
  if (s.includes(',')) {
    // Reject leading, trailing, or adjacent-to-decimal-point commas.
    if (/(^,|,,|,\.|,$)/.test(s)) return ERR_VALUE
    s = s.replace(/,/g, '')
  }
  // Now `s` should be a JS-parseable number.
  if (s.length === 0) return ERR_VALUE
  const n = Number(s)
  if (!Number.isFinite(n)) return ERR_VALUE
  const final = sign * (percent ? n / 100 : n)
  return { kind: 'number', value: final }
}

// =============================================================================
// SEARCH / FIND  (Wave F / F1)
// =============================================================================

/**
 * Shared substring-search core for SEARCH and FIND. Returns 1-based
 * position (Excel convention) or `null` if not found. `start` is
 * 1-based; `start < 1` or `start > length` → `null` (caller surfaces
 * `#VALUE!`).
 *
 * Note on Unicode: we operate on the same code-point split that
 * LEFT/RIGHT/MID use, so "1-based position" lines up with the LEN we
 * report. SEARCH/FIND in Excel use UTF-16 code units historically; we
 * diverge intentionally for consistency with the rest of this module.
 *
 * `caseInsensitive=true` for SEARCH, `false` for FIND.
 *
 * SEARCH also honors wildcards (`*`, `?`, `~` escape). FIND does NOT.
 */
function searchCore(
  needle: string,
  haystack: string,
  start: number,
  caseInsensitive: boolean,
  wildcards: boolean,
): number | null {
  const hay = codepoints(haystack)
  if (start < 1 || start > hay.length + 1) return null

  // SEARCH("", x) returns `start` (1-based) — matches Excel.
  if (needle.length === 0) return start

  const offset = hay.slice(0, start - 1).join('').length
  const found = searchCoreMatchIndex(needle, haystack, offset, caseInsensitive, wildcards)
  if (found === null) return null
  return codepoints(haystack.slice(0, found)).length + 1
}

function searchCoreMatchIndex(
  needle: string,
  haystack: string,
  offset: number,
  caseInsensitive: boolean,
  wildcards: boolean,
): number | null {
  if (needle.length === 0) return offset

  if (wildcards && /[*?]/.test(needle)) {
    // Build a regex from the wildcard pattern. `~` escapes the next
    // metachar (`~*` literal asterisk, `~?` literal question mark, `~~`
    // literal tilde).
    let pattern = ''
    let i = 0
    while (i < needle.length) {
      const ch = needle[i]
      if (ch === '~' && i + 1 < needle.length) {
        const next = needle[i + 1]
        if (next === '*' || next === '?' || next === '~') {
          pattern += escapeRegExp(next)
          i += 2
          continue
        }
      }
      if (ch === '*') {
        pattern += '.*'
        i += 1
      } else if (ch === '?') {
        pattern += '.'
        i += 1
      } else {
        pattern += escapeRegExp(ch)
        i += 1
      }
    }
    const flags = caseInsensitive ? 'i' : ''
    const re = new RegExp(pattern, flags)
    const slice = haystack.slice(offset)
    const m = slice.match(re)
    if (!m || m.index === undefined) return null
    return offset + m.index
  }

  const hayCmp = caseInsensitive ? haystack.toLowerCase() : haystack
  const needCmp = caseInsensitive ? needle.toLowerCase() : needle
  const found = hayCmp.indexOf(needCmp, offset)
  if (found < 0) return null
  return found
}

function searchByteCore(
  needle: string,
  haystack: string,
  start: number,
  caseInsensitive: boolean,
  wildcards: boolean,
): number | null {
  const total = dbcsByteLength(haystack)
  if (start < 1) return null
  if (total === 0) {
    if (needle.length === 0 && start === 1) return 1
    return null
  }
  if (start > total) return null
  if (needle.length === 0) return start
  const offset = codeUnitOffsetForDbcsByteStart(haystack, start)
  const found = searchCoreMatchIndex(needle, haystack, offset, caseInsensitive, wildcards)
  if (found === null) return null
  return dbcsBytePositionFromCodeUnitOffset(haystack, found)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * SEARCH(find_text, within_text, [start=1]) — case-INsensitive
 * substring search with wildcard support (`*`, `?`, `~` escape).
 * Returns the 1-based position or `#VALUE!` if not found / bad start.
 */
const SEARCH: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3)
    return errValue('#VALUE!', 'SEARCH takes 2 or 3 arguments')
  const err = propagateError(args)
  if (err) return err
  const findR = coerceText(args[0])
  if (!findR.ok) return findR.error
  const withinR = coerceText(args[1])
  if (!withinR.ok) return withinR.error
  let start = 1
  if (args.length === 3) {
    const s = toNumber(args[2])
    if (!s.ok) return s.error
    start = Math.trunc(s.value)
  }
  if (start < 1) return errValue('#VALUE!', 'SEARCH start_num must be >= 1')
  const pos = searchCore(findR.value, withinR.value, start, true, true)
  if (pos === null) return errValue('#VALUE!', 'SEARCH text not found')
  return { kind: 'number', value: pos }
}

/**
 * FIND(find_text, within_text, [start=1]) — case-SENSITIVE substring
 * search. Wildcards are treated literally (Excel discipline).
 */
const FIND: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3)
    return errValue('#VALUE!', 'FIND takes 2 or 3 arguments')
  const err = propagateError(args)
  if (err) return err
  const findR = coerceText(args[0])
  if (!findR.ok) return findR.error
  const withinR = coerceText(args[1])
  if (!withinR.ok) return withinR.error
  let start = 1
  if (args.length === 3) {
    const s = toNumber(args[2])
    if (!s.ok) return s.error
    start = Math.trunc(s.value)
  }
  if (start < 1) return errValue('#VALUE!', 'FIND start_num must be >= 1')
  const pos = searchCore(findR.value, withinR.value, start, false, false)
  if (pos === null) return errValue('#VALUE!', 'FIND text not found')
  return { kind: 'number', value: pos }
}

/**
 * SEARCHB(find_text, within_text, [start=1]) — SEARCH with byte positions.
 * Case-insensitive and wildcard-aware; returns DBCS byte position.
 */
const SEARCHB: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3)
    return errValue('#VALUE!', 'SEARCHB takes 2 or 3 arguments')
  const err = propagateError(args)
  if (err) return err
  const findR = coerceText(args[0])
  if (!findR.ok) return findR.error
  const withinR = coerceText(args[1])
  if (!withinR.ok) return withinR.error
  let start = 1
  if (args.length === 3) {
    const s = toNumber(args[2])
    if (!s.ok) return s.error
    start = Math.trunc(s.value)
  }
  if (start < 1) return errValue('#VALUE!', 'SEARCHB start_num must be >= 1')
  const pos = searchByteCore(findR.value, withinR.value, start, true, true)
  if (pos === null) return errValue('#VALUE!', 'SEARCHB text not found')
  return { kind: 'number', value: pos }
}

/**
 * FINDB(find_text, within_text, [start=1]) — FIND with byte positions.
 * Case-sensitive and wildcard-literal; returns DBCS byte position.
 */
const FINDB: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3)
    return errValue('#VALUE!', 'FINDB takes 2 or 3 arguments')
  const err = propagateError(args)
  if (err) return err
  const findR = coerceText(args[0])
  if (!findR.ok) return findR.error
  const withinR = coerceText(args[1])
  if (!withinR.ok) return withinR.error
  let start = 1
  if (args.length === 3) {
    const s = toNumber(args[2])
    if (!s.ok) return s.error
    start = Math.trunc(s.value)
  }
  if (start < 1) return errValue('#VALUE!', 'FINDB start_num must be >= 1')
  const pos = searchByteCore(findR.value, withinR.value, start, false, false)
  if (pos === null) return errValue('#VALUE!', 'FINDB text not found')
  return { kind: 'number', value: pos }
}

// =============================================================================
// Registry
// =============================================================================

// =============================================================================
// Phase 8 additions
// =============================================================================

/** REPLACE(text, start, num_chars, new_text) — replace a substring by position. */
const REPLACE: FunctionImpl = (args) => {
  if (args.length !== 4) return errValue('#VALUE!', 'REPLACE requires 4 arguments')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  const sr = toNumber(args[1])
  if (!sr.ok) return sr.error
  const nr = toNumber(args[2])
  if (!nr.ok) return nr.error
  const newR = coerceText(args[3])
  if (!newR.ok) return newR.error
  const start = Math.trunc(sr.value)
  const num = Math.trunc(nr.value)
  if (start < 1 || num < 0) return ERR_VALUE
  const chars = codepoints(ts.value)
  const before = chars.slice(0, start - 1).join('')
  const after = chars.slice(start - 1 + num).join('')
  return { kind: 'string', value: before + newR.value + after }
}

/** REPLACEB(text, start, num_bytes, new_text) — byte-position variant of REPLACE. */
const REPLACEB: FunctionImpl = (args) => {
  if (args.length !== 4) return errValue('#VALUE!', 'REPLACEB requires 4 arguments')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  const sr = toNumber(args[1])
  if (!sr.ok) return sr.error
  const nr = toNumber(args[2])
  if (!nr.ok) return nr.error
  const newR = coerceText(args[3])
  if (!newR.ok) return newR.error
  const start = Math.trunc(sr.value)
  const num = Math.trunc(nr.value)
  if (start < 1 || num < 0) return ERR_VALUE
  return { kind: 'string', value: replaceDbcsBytes(ts.value, start, num, newR.value) }
}

/**
 * SUBSTITUTE(text, old, new, [instance]) — replace all (or nth) instances
 * of `old` within `text`. Case-sensitive (unlike SEARCH).
 */
const SUBSTITUTE: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 4)
    return errValue('#VALUE!', 'SUBSTITUTE requires 3 or 4 arguments')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  const oldR = coerceText(args[1])
  if (!oldR.ok) return oldR.error
  const newR = coerceText(args[2])
  if (!newR.ok) return newR.error
  let instance = -1 // -1 means all
  if (args.length === 4) {
    const ic = toNumber(args[3])
    if (!ic.ok) return ic.error
    instance = Math.trunc(ic.value)
    if (instance < 1) return ERR_VALUE
  }
  if (oldR.value.length === 0) return { kind: 'string', value: ts.value }
  if (instance === -1) {
    // Replace all — use split/join, no regex needed.
    return { kind: 'string', value: ts.value.split(oldR.value).join(newR.value) }
  }
  let count = 0
  let idx = 0
  let out = ''
  const old = oldR.value
  while (idx < ts.value.length) {
    const found = ts.value.indexOf(old, idx)
    if (found < 0) {
      out += ts.value.slice(idx)
      break
    }
    count++
    if (count === instance) {
      out += ts.value.slice(idx, found) + newR.value + ts.value.slice(found + old.length)
      return { kind: 'string', value: out }
    }
    out += ts.value.slice(idx, found + old.length)
    idx = found + old.length
  }
  return { kind: 'string', value: out }
}

/** REPT(text, n) — repeat text n times. */
const REPT: FunctionImpl = (args) => {
  if (args.length !== 2) return errValue('#VALUE!', 'REPT requires 2 arguments')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  const nr = toNumber(args[1])
  if (!nr.ok) return nr.error
  const n = Math.trunc(nr.value)
  if (n < 0) return ERR_VALUE
  if (n === 0) return { kind: 'string', value: '' }
  // Excel caps REPT output at ~32K chars.
  if (n * ts.value.length > 32_767) return errValue('#VALUE!', 'REPT result too large')
  return { kind: 'string', value: ts.value.repeat(n) }
}

/** CHAR(n) — 1..255 code unit → char. */
const CHAR: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'CHAR requires 1 argument')
  const err = propagateError(args)
  if (err) return err
  const nr = toNumber(args[0])
  if (!nr.ok) return nr.error
  const n = Math.trunc(nr.value)
  if (n < 1 || n > 255) return ERR_VALUE
  return { kind: 'string', value: String.fromCharCode(n) }
}

/** CODE(text) — first 1..255 code unit as number. */
const CODE: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'CODE requires 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  if (ts.value.length === 0) return ERR_VALUE
  const code = ts.value.charCodeAt(0)
  if (code < 1 || code > 255) return ERR_VALUE
  return { kind: 'number', value: code }
}

/** EXACT(a, b) — strict case-sensitive equality. */
const EXACT: FunctionImpl = (args) => {
  if (args.length !== 2) return errValue('#VALUE!', 'EXACT requires 2 arguments')
  const err = propagateError(args)
  if (err) return err
  const a = coerceText(args[0])
  if (!a.ok) return a.error
  const b = coerceText(args[1])
  if (!b.ok) return b.error
  return { kind: 'boolean', value: a.value === b.value }
}

/** PROPER(text) — Title Case. */
const PROPER: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'PROPER requires 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  // Capitalize after every non-letter boundary.
  let out = ''
  let upper = true
  for (const ch of ts.value) {
    if (/\p{L}/u.test(ch)) {
      out += upper ? ch.toUpperCase() : ch.toLowerCase()
      upper = false
    } else {
      out += ch
      upper = true
    }
  }
  return { kind: 'string', value: out }
}

/** T(value) — passthrough for strings, "" for everything else. */
const T: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'T requires 1 argument')
  const v = args[0]
  // Errors propagate.
  if (v.kind === 'error') return v
  if (v.kind === 'string') return v
  return { kind: 'string', value: '' }
}

/** CLEAN(text) — strip non-printable ASCII (0..31). */
const CLEAN: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'CLEAN requires 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  // Strip ASCII control chars 0-31 (and DEL 127).
  return { kind: 'string', value: ts.value.replace(/[\x00-\x1F\x7F]/g, '') }
}

/**
 * TEXTJOIN(delimiter, ignore_empty, ...args) — concatenate with delimiter.
 * `ignore_empty=TRUE` skips blank cells and empty strings.
 */
const TEXTJOIN: FunctionImpl = (args) => {
  if (args.length < 3) return errValue('#VALUE!', 'TEXTJOIN requires 3+ arguments')
  // Errors in args propagate.
  const err = propagateError(args)
  if (err) return err
  const delR = coerceText(args[0])
  if (!delR.ok) return delR.error
  const ig = args[1]
  let ignoreEmpty = true
  if (ig.kind === 'boolean') ignoreEmpty = ig.value
  else if (ig.kind === 'number') ignoreEmpty = ig.value !== 0
  else if (ig.kind === 'blank') ignoreEmpty = false
  // Collect strings.
  const parts: string[] = []
  for (let i = 2; i < args.length; i++) {
    const a = args[i]
    if (a.kind === 'array') {
      for (const row of a.value) {
        for (const cell of row) {
          if (cell.kind === 'error') return cell
          if (cell.kind === 'blank') {
            if (!ignoreEmpty) parts.push('')
            continue
          }
          const s = coerceText(cell)
          if (!s.ok) return s.error
          if (ignoreEmpty && s.value === '') continue
          parts.push(s.value)
        }
      }
    } else {
      if (a.kind === 'blank') {
        if (!ignoreEmpty) parts.push('')
        continue
      }
      const s = coerceText(a)
      if (!s.ok) return s.error
      if (ignoreEmpty && s.value === '') continue
      parts.push(s.value)
    }
  }
  const joined = parts.join(delR.value)
  if (Array.from(joined).length > 32767) return errValue('#VALUE!')
  return { kind: 'string', value: joined }
}

// =============================================================================
// TEXTSPLIT / TEXTBEFORE / TEXTAFTER
// =============================================================================

const TEXTSPLIT: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 6)
    return errValue('#VALUE!', 'TEXTSPLIT takes 2 to 6 arguments')
  const err = propagateError(args)
  if (err) return err

  const textR = coerceText(args[0])
  if (!textR.ok) return textR.error
  const colR = collectTextDelimiters(args[1])
  if (!colR.ok) return colR.error
  let rowDelims: string[] = []
  if (args.length >= 3) {
    const rowR = collectTextDelimiters(args[2])
    if (!rowR.ok) return rowR.error
    rowDelims = rowR.value
  }

  let ignoreEmpty = false
  if (args.length >= 4) {
    const r = readBoolean(args[3])
    if (!r.ok) return r.error
    ignoreEmpty = r.value
  }

  let matchMode = 0
  if (args.length >= 5) {
    const r = readInteger(args[4])
    if (!r.ok) return r.error
    matchMode = r.value
  }
  if (matchMode !== 0 && matchMode !== 1) return ERR_VALUE

  const pad = args.length === 6 ? args[5] : ERR_NA
  if (textR.value === '') return { kind: 'array', value: [[{ kind: 'string', value: '' }]] }

  if (rowDelims.length === 0) {
    const fragments = textsplitOneAxis(textR.value, colR.value, ignoreEmpty, matchMode)
    const row: Value[] = (fragments.length === 0 ? [''] : fragments).map((value) => ({
      kind: 'string',
      value,
    }))
    return { kind: 'array', value: [row] }
  }

  const rowTexts = textsplitOneAxis(textR.value, rowDelims, ignoreEmpty, matchMode)
  const rows = (rowTexts.length === 0 ? [''] : rowTexts).map((row) =>
    textsplitOneAxis(row, colR.value, ignoreEmpty, matchMode),
  )
  const maxCols = Math.max(1, ...rows.map((row) => row.length))
  const out = rows.map((row) => {
    const cells: Value[] = []
    for (let i = 0; i < maxCols; i++) {
      cells.push(i < row.length ? { kind: 'string', value: row[i] ?? '' } : pad)
    }
    return cells
  })
  return { kind: 'array', value: out }
}

function textBeforeAfter(args: Value[], before: boolean): Value {
  if (args.length < 2 || args.length > 6)
    return errValue('#VALUE!', `${before ? 'TEXTBEFORE' : 'TEXTAFTER'} takes 2 to 6 arguments`)
  const err = propagateError(args)
  if (err) return err

  const textR = coerceText(args[0])
  if (!textR.ok) return textR.error
  const delimR = collectTextDelimiters(args[1], true)
  if (!delimR.ok) return delimR.error

  let instance = 1
  if (args.length >= 3) {
    const r = readInteger(args[2])
    if (!r.ok) return r.error
    instance = r.value
  }
  if (instance === 0) return ERR_VALUE

  let matchMode = 0
  if (args.length >= 4) {
    const r = readInteger(args[3])
    if (!r.ok) return r.error
    matchMode = r.value
  }
  if (matchMode !== 0 && matchMode !== 1) return ERR_VALUE

  let matchEnd = 0
  if (args.length >= 5) {
    const r = readInteger(args[4])
    if (!r.ok) return r.error
    matchEnd = r.value
  }
  if (matchEnd !== 0 && matchEnd !== 1) return ERR_VALUE

  const notFound = args.length === 6 ? args[5] : ERR_NA
  if (delimR.value.length === 0) return notFound

  const text = textR.value
  if (delimR.value.includes('')) {
    if (instance > 0) {
      if (instance !== 1) return notFound
      return { kind: 'string', value: before ? '' : text }
    }
    if (instance !== -1) return notFound
    return { kind: 'string', value: before ? text : '' }
  }

  const matches: TextDelimiterMatch[] = []
  let pos = 0
  while (pos <= text.length) {
    const match = findFirstTextDelimiter(text, delimR.value, pos, matchMode)
    if (!match) break
    matches.push(match)
    pos = match.end > match.start ? match.end : match.start + 1
  }
  if (matchEnd === 1) matches.push({ start: text.length, end: text.length })

  const index = instance > 0 ? instance - 1 : matches.length + instance
  const match = matches[index]
  if (match === undefined) return notFound
  return { kind: 'string', value: before ? text.slice(0, match.start) : text.slice(match.end) }
}

const TEXTBEFORE: FunctionImpl = (args) => textBeforeAfter(args, true)
const TEXTAFTER: FunctionImpl = (args) => textBeforeAfter(args, false)

// =============================================================================
// REGEXTEST / REGEXEXTRACT / REGEXREPLACE
// =============================================================================

function readRegexCase(args: Value[], index: number): { ok: true; value: boolean } | { ok: false; error: Value } {
  if (args.length <= index) return { ok: true, value: false }
  const r = readInteger(args[index])
  if (!r.ok) return r
  return { ok: true, value: r.value !== 0 }
}

function compileRegex(pattern: string, flags: string): RegExp | Value {
  try {
    return new RegExp(pattern, flags)
  } catch {
    return ERR_VALUE
  }
}

function collectRegexMatches(re: RegExp, text: string): RegExpExecArray[] {
  const matches: RegExpExecArray[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    matches.push(match)
    if (match[0] === '') re.lastIndex++
  }
  return matches
}

function expandRegexReplacement(
  replacement: string,
  match: RegExpExecArray,
  fullText: string,
): string {
  const end = match.index + match[0].length
  return replacement.replace(/\$(\$|&|`|'|\d{1,2})/g, (token, marker: string) => {
    if (marker === '$') return '$'
    if (marker === '&') return match[0]
    if (marker === '`') return fullText.slice(0, match.index)
    if (marker === "'") return fullText.slice(end)
    const index = Number(marker)
    if (!Number.isInteger(index) || index < 1 || index >= match.length) return token
    return match[index] ?? ''
  })
}

const REGEXTEST: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 3)
    return errValue('#VALUE!', 'REGEXTEST takes 2 or 3 arguments')
  const err = propagateError(args)
  if (err) return err
  const textR = coerceText(args[0])
  if (!textR.ok) return textR.error
  const patR = coerceText(args[1])
  if (!patR.ok) return patR.error
  const caseR = readRegexCase(args, 2)
  if (!caseR.ok) return caseR.error
  const re = compileRegex(patR.value, caseR.value ? 'i' : '')
  if (!(re instanceof RegExp)) return re
  return { kind: 'boolean', value: re.test(textR.value) }
}

const REGEXEXTRACT: FunctionImpl = (args) => {
  if (args.length < 2 || args.length > 4)
    return errValue('#VALUE!', 'REGEXEXTRACT takes 2 to 4 arguments')
  const err = propagateError(args)
  if (err) return err
  const textR = coerceText(args[0])
  if (!textR.ok) return textR.error
  const patR = coerceText(args[1])
  if (!patR.ok) return patR.error

  let mode = 0
  if (args.length >= 3) {
    const r = readInteger(args[2])
    if (!r.ok) return r.error
    mode = r.value
  }
  const caseR = readRegexCase(args, 3)
  if (!caseR.ok) return caseR.error
  const re = compileRegex(patR.value, caseR.value ? 'gi' : 'g')
  if (!(re instanceof RegExp)) return re

  if (mode === 0) {
    const match = re.exec(textR.value)
    return match ? { kind: 'string', value: match[0] } : ERR_NA
  }
  if (mode === 1) {
    const matches = collectRegexMatches(re, textR.value)
      .map((match) => [{ kind: 'string' as const, value: match[0] }])
    return matches.length === 0 ? ERR_NA : { kind: 'array', value: matches }
  }
  if (mode === 2) {
    const match = re.exec(textR.value)
    if (!match || match.length <= 1) return ERR_NA
    return {
      kind: 'array',
      value: [match.slice(1).map((part) => ({ kind: 'string', value: part ?? '' }))],
    }
  }
  return ERR_VALUE
}

const REGEXREPLACE: FunctionImpl = (args) => {
  if (args.length < 3 || args.length > 5)
    return errValue('#VALUE!', 'REGEXREPLACE takes 3 to 5 arguments')
  const err = propagateError(args)
  if (err) return err
  const textR = coerceText(args[0])
  if (!textR.ok) return textR.error
  const patR = coerceText(args[1])
  if (!patR.ok) return patR.error
  const repR = coerceText(args[2])
  if (!repR.ok) return repR.error

  let occurrence = 0
  if (args.length >= 4) {
    const r = readInteger(args[3])
    if (!r.ok) return r.error
    occurrence = r.value
  }
  const caseR = readRegexCase(args, 4)
  if (!caseR.ok) return caseR.error
  const re = compileRegex(patR.value, caseR.value ? 'gi' : 'g')
  if (!(re instanceof RegExp)) return re

  if (occurrence === 0) {
    return { kind: 'string', value: textR.value.replace(re, repR.value) }
  }

  const matches = collectRegexMatches(re, textR.value)
  const matchIndex = occurrence > 0 ? occurrence - 1 : matches.length + occurrence
  const match = matches[matchIndex]
  if (match) {
    const start = match.index
    const end = start + match[0].length
    return {
      kind: 'string',
      value:
        textR.value.slice(0, start) +
        expandRegexReplacement(repR.value, match, textR.value) +
        textR.value.slice(end),
    }
  }
  return { kind: 'string', value: textR.value }
}

// =============================================================================
// NUMBERVALUE / DOLLAR / FIXED / ROMAN / ARABIC
// =============================================================================

const NUMBERVALUE: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 3)
    return errValue('#VALUE!', 'NUMBERVALUE takes 1 to 3 arguments')
  const err = propagateError(args)
  if (err) return err
  const textR = coerceText(args[0])
  if (!textR.ok) return textR.error

  let decimalSep = '.'
  if (args.length >= 2) {
    const r = coerceText(args[1])
    if (!r.ok) return r.error
    decimalSep = codepoints(r.value)[0] ?? '.'
  }
  let groupSep = ','
  if (args.length === 3) {
    const r = coerceText(args[2])
    if (!r.ok) return r.error
    groupSep = codepoints(r.value)[0] ?? ','
  }
  if (decimalSep === groupSep) return ERR_VALUE

  const trimmed = textR.value.trim()
  if (trimmed === '') return { kind: 'number', value: 0 }
  let normalized = ''
  for (const ch of codepoints(trimmed)) {
    if (ch === groupSep || /\s/u.test(ch)) continue
    normalized += ch === decimalSep ? '.' : ch
  }

  let percentCount = 0
  while (normalized.endsWith('%')) {
    normalized = normalized.slice(0, -1)
    percentCount++
  }
  if (normalized === '') return ERR_VALUE
  const n = Number(normalized)
  if (!Number.isFinite(n)) return ERR_VALUE
  return { kind: 'number', value: n / 100 ** percentCount }
}

const DOLLAR: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2)
    return errValue('#VALUE!', 'DOLLAR takes 1 or 2 arguments')
  const err = propagateError(args)
  if (err) return err
  const nR = toNumber(args[0])
  if (!nR.ok) return nR.error
  if (!Number.isFinite(nR.value)) return ERR_VALUE
  let decimals = 2
  if (args.length === 2) {
    const r = readInteger(args[1])
    if (!r.ok) return r.error
    decimals = r.value
  }
  const body = formatThousandsFixed(nR.value, decimals, true)
  return { kind: 'string', value: nR.value < 0 ? `($${body})` : `$${body}` }
}

const FIXED: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 3)
    return errValue('#VALUE!', 'FIXED takes 1 to 3 arguments')
  const err = propagateError(args)
  if (err) return err
  const nR = toNumber(args[0])
  if (!nR.ok) return nR.error
  if (!Number.isFinite(nR.value)) return ERR_VALUE
  let decimals = 2
  if (args.length >= 2) {
    const r = readInteger(args[1])
    if (!r.ok) return r.error
    decimals = r.value
  }
  let noCommas = false
  if (args.length === 3) {
    const r = readBoolean(args[2])
    if (!r.ok) return r.error
    noCommas = r.value
  }
  const body = formatThousandsFixed(nR.value, decimals, !noCommas)
  return { kind: 'string', value: nR.value < 0 ? `-${body}` : body }
}

const ROMAN_TABLE = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
] as const

const ROMAN_FORM_TABLES = [
  ROMAN_TABLE,
  [
    [1000, 'M'], [950, 'LM'], [900, 'CM'], [500, 'D'], [450, 'LD'], [400, 'CD'],
    [100, 'C'], [95, 'VC'], [90, 'XC'], [50, 'L'], [45, 'VL'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ],
  [
    [1000, 'M'], [990, 'XM'], [950, 'LM'], [900, 'CM'], [500, 'D'], [490, 'XD'],
    [450, 'LD'], [400, 'CD'], [100, 'C'], [99, 'IC'], [95, 'VC'], [90, 'XC'],
    [50, 'L'], [49, 'IL'], [45, 'VL'], [40, 'XL'], [10, 'X'], [9, 'IX'],
    [5, 'V'], [4, 'IV'], [1, 'I'],
  ],
  [
    [1000, 'M'], [995, 'VM'], [990, 'XM'], [950, 'LM'], [900, 'CM'], [500, 'D'],
    [495, 'VD'], [490, 'XD'], [450, 'LD'], [400, 'CD'], [100, 'C'], [99, 'IC'],
    [95, 'VC'], [90, 'XC'], [50, 'L'], [49, 'IL'], [45, 'VL'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ],
  [
    [1000, 'M'], [999, 'IM'], [995, 'VM'], [990, 'XM'], [950, 'LM'], [900, 'CM'],
    [500, 'D'], [499, 'ID'], [495, 'VD'], [490, 'XD'], [450, 'LD'], [400, 'CD'],
    [100, 'C'], [99, 'IC'], [95, 'VC'], [90, 'XC'], [50, 'L'], [49, 'IL'],
    [45, 'VL'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ],
] as const

const ROMAN: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2)
    return errValue('#VALUE!', 'ROMAN takes 1 or 2 arguments')
  const err = propagateError(args)
  if (err) return err
  const nR = readInteger(args[0])
  if (!nR.ok) return nR.error
  // Excel: ROMAN(0) returns an empty string; out-of-range values are #VALUE!.
  if (nR.value === 0) return { kind: 'string', value: '' }
  if (nR.value < 1 || nR.value > 3999) return ERR_VALUE
  let form = 0
  if (args.length === 2) {
    if (args[1].kind === 'boolean') {
      form = args[1].value ? 0 : 4
    } else {
      const formR = readInteger(args[1])
      if (!formR.ok) return formR.error
      form = formR.value
    }
    if (form < 0 || form > 4) return ERR_VALUE
  }
  let remaining = nR.value
  let out = ''
  for (const [value, symbol] of ROMAN_FORM_TABLES[form]) {
    while (remaining >= value) {
      out += symbol
      remaining -= value
    }
  }
  return { kind: 'string', value: out }
}

const ARABIC: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'ARABIC takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  if (args[0].kind !== 'string' && args[0].kind !== 'blank') return ERR_VALUE
  const raw = (args[0].kind === 'string' ? args[0].value : '').trim().toUpperCase()
  if (raw === '') return { kind: 'number', value: 0 }
  // Excel ARABIC accepts a leading minus sign for negative numerals
  // (e.g. ARABIC("-MMXXIV") → -2024).
  const negative = raw[0] === '-'
  const s = negative ? raw.slice(1) : raw
  if (s === '') return ERR_VALUE
  let total = 0
  let prev = 0
  for (let i = s.length - 1; i >= 0; i--) {
    const ch = s[i]
    const value =
      ch === 'I' ? 1 :
      ch === 'V' ? 5 :
      ch === 'X' ? 10 :
      ch === 'L' ? 50 :
      ch === 'C' ? 100 :
      ch === 'D' ? 500 :
      ch === 'M' ? 1000 :
      0
    if (value === 0) return ERR_VALUE
    total += value < prev ? -value : value
    prev = value
  }
  return { kind: 'number', value: negative ? -total : total }
}

// =============================================================================
// ARRAYTOTEXT / VALUETOTEXT / ENCODEURL / ASC / JIS / DBCS / HYPERLINK / IMAGE
// =============================================================================

const VALUETOTEXT: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2)
    return errValue('#VALUE!', 'VALUETOTEXT takes 1 or 2 arguments')
  const err = findNestedError(args[0]) ?? (args.length === 2 ? propagateError([args[1]]) : undefined)
  if (err) return err
  const formatR = readStrictFormat(args)
  if (!formatR.ok) return formatR.error
  return { kind: 'string', value: renderValueToText(args[0], formatR.value) }
}

const ARRAYTOTEXT: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2)
    return errValue('#VALUE!', 'ARRAYTOTEXT takes 1 or 2 arguments')
  const err = findNestedError(args[0]) ?? (args.length === 2 ? propagateError([args[1]]) : undefined)
  if (err) return err
  const formatR = readStrictFormat(args)
  if (!formatR.ok) return formatR.error
  if (args[0].kind === 'array') {
    return { kind: 'string', value: formatGridToText(args[0].value, formatR.value) }
  }
  const body = renderValueToText(args[0], formatR.value)
  return { kind: 'string', value: formatR.value ? `{${body}}` : body }
}

const ENCODEURL: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'ENCODEURL takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const textR = coerceText(args[0])
  if (!textR.ok) return textR.error
  return { kind: 'string', value: percentEncodeUrlText(textR.value) }
}

const ASC: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'ASC takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const textR = coerceText(args[0])
  if (!textR.ok) return textR.error
  return { kind: 'string', value: ascConvert(textR.value) }
}

const JIS: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'JIS takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const textR = coerceText(args[0])
  if (!textR.ok) return textR.error
  return { kind: 'string', value: jisConvert(textR.value) }
}

const DBCS: FunctionImpl = JIS

const HYPERLINK: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 2)
    return errValue('#VALUE!', 'HYPERLINK takes 1 or 2 arguments')
  const err = propagateError(args)
  if (err) return err
  const linkR = coerceText(args[0])
  if (!linkR.ok) return linkR.error
  if (args.length === 1) return { kind: 'string', value: linkR.value }
  const friendlyR = coerceText(args[1])
  if (!friendlyR.ok) return friendlyR.error
  return { kind: 'string', value: friendlyR.value }
}

const IMAGE: FunctionImpl = (args) => {
  if (args.length < 1 || args.length > 5)
    return errValue('#VALUE!', 'IMAGE takes 1 to 5 arguments')
  const err = propagateError(args)
  if (err) return err
  const sourceR = coerceText(args[0])
  if (!sourceR.ok) return sourceR.error
  if (sourceR.value === '') return ERR_VALUE

  let alt: string | undefined
  if (args.length >= 2 && args[1].kind !== 'blank') {
    const altR = coerceText(args[1])
    if (!altR.ok) return altR.error
    alt = altR.value
  }

  let sizing = 0
  if (args.length >= 3 && args[2].kind !== 'blank') {
    const sizingR = toNumber(args[2])
    if (!sizingR.ok) return sizingR.error
    if (!Number.isFinite(sizingR.value) || Math.trunc(sizingR.value) !== sizingR.value)
      return ERR_VALUE
    sizing = sizingR.value
    if (sizing < 0 || sizing > 3) return ERR_VALUE
  }

  let height: number | undefined
  let width: number | undefined
  if (sizing === 3) {
    if (args.length !== 5) return ERR_VALUE
    const heightR = toNumber(args[3])
    if (!heightR.ok) return heightR.error
    const widthR = toNumber(args[4])
    if (!widthR.ok) return widthR.error
    if (heightR.value <= 0 || widthR.value <= 0) return ERR_VALUE
    height = heightR.value
    width = widthR.value
  } else {
    if (args.length >= 4 && args[3].kind !== 'blank') return ERR_VALUE
    if (args.length === 5 && args[4].kind !== 'blank') return ERR_VALUE
  }

  return { kind: 'string', value: formatImagePayload(sourceR.value, alt, sizing, height, width) }
}

/**
 * TRANSLATE(text, find, replace) — Google Sheets / Excel TRANSLATE.
 *
 * Each codepoint in `find` is mapped to the codepoint at the same index in
 * `replace`. If `find` is longer than `replace`, the trailing codepoints in
 * `find` have no mapping and are deleted from the output. Codepoints in
 * `text` that do not appear in `find` are kept verbatim.
 *
 * Codepoint discipline matches LEFT/RIGHT/MID: `Array.from(s)` so a 4-byte
 * emoji counts as one character.
 */
const TRANSLATE: FunctionImpl = (args) => {
  if (args.length !== 3) return errValue('#VALUE!', 'TRANSLATE takes exactly 3 arguments')
  const err = propagateError(args)
  if (err) return err
  const textR = coerceText(args[0])
  if (!textR.ok) return textR.error
  const findR = coerceText(args[1])
  if (!findR.ok) return findR.error
  const replR = coerceText(args[2])
  if (!replR.ok) return replR.error
  const findCps = codepoints(findR.value)
  const replCps = codepoints(replR.value)
  // Build map: first occurrence in `find` wins (Excel's behavior).
  const map = new Map<string, string | undefined>()
  for (let i = 0; i < findCps.length; i++) {
    const key = findCps[i]
    if (map.has(key)) continue
    map.set(key, i < replCps.length ? replCps[i] : undefined)
  }
  let out = ''
  for (const ch of codepoints(textR.value)) {
    if (map.has(ch)) {
      const mapped = map.get(ch)
      if (mapped !== undefined) out += mapped
      // else: deleted (find char with no replacement counterpart)
    } else {
      out += ch
    }
  }
  return { kind: 'string', value: out }
}

/**
 * PHONETIC(reference) — Excel extracts furigana ruby text annotations from
 * the source cell. einfach does not model per-cell furigana metadata, so we
 * degrade to a passthrough that mirrors Excel's behavior for cells with no
 * ruby annotations: return the raw TEXT content unchanged.
 *
 * If the arg is a range, Excel uses the first cell — `coerceText` already
 * does that (top-left of array). Blank → "". Errors propagate.
 */
const PHONETIC: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'PHONETIC takes exactly 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  return { kind: 'string', value: ts.value }
}

/** UNICODE(text) — first Unicode code point as number. */
const UNICODE: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'UNICODE requires 1 argument')
  const err = propagateError(args)
  if (err) return err
  const ts = coerceText(args[0])
  if (!ts.ok) return ts.error
  if (ts.value.length === 0) return ERR_VALUE
  const cp = ts.value.codePointAt(0)
  if (cp === undefined || isSurrogateCodePoint(cp)) return ERR_VALUE
  return { kind: 'number', value: cp }
}

/** UNICHAR(n) — Unicode code point → char. */
const UNICHAR: FunctionImpl = (args) => {
  if (args.length !== 1) return errValue('#VALUE!', 'UNICHAR requires 1 argument')
  const err = propagateError(args)
  if (err) return err
  const nr = toNumber(args[0])
  if (!nr.ok) return nr.error
  const n = Math.trunc(nr.value)
  if (n < 1 || n > 0x10ffff || isSurrogateCodePoint(n)) return ERR_VALUE
  return { kind: 'string', value: String.fromCodePoint(n) }
}

function isSurrogateCodePoint(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff
}

/**
 * Wave C contract: each function file exports a `FUNCTIONS` record. The
 * evaluator's central index merges these into one dispatch Map.
 *
 * Names are uppercased — case-insensitive matching is the dispatcher's job,
 * but we keep them upper here to make the source readable as a manifest.
 */
export const FUNCTIONS: Record<string, FunctionImpl> = {
  CONCATENATE,
  CONCAT,
  LEFT,
  RIGHT,
  MID,
  LEN,
  LEFTB,
  RIGHTB,
  MIDB,
  LENB,
  LOWER,
  UPPER,
  TRIM,
  TEXT,
  VALUE,
  // Wave F / F1 additions
  SEARCH,
  FIND,
  SEARCHB,
  FINDB,
  // Phase 8 additions
  REPLACE,
  REPLACEB,
  SUBSTITUTE,
  REPT,
  CHAR,
  CODE,
  EXACT,
  PROPER,
  T,
  CLEAN,
  TEXTJOIN,
  TEXTSPLIT,
  TEXTBEFORE,
  TEXTAFTER,
  REGEXTEST,
  REGEXEXTRACT,
  REGEXREPLACE,
  NUMBERVALUE,
  DOLLAR,
  FIXED,
  ROMAN,
  ARABIC,
  VALUETOTEXT,
  ARRAYTOTEXT,
  ENCODEURL,
  ASC,
  JIS,
  DBCS,
  HYPERLINK,
  IMAGE,
  TRANSLATE,
  PHONETIC,
  UNICODE,
  UNICHAR,
}
