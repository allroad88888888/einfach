/**
 * Excel formula tokenizer.
 *
 * Converts a raw formula string (with or without leading `=`) into a flat
 * stream of `Token`s. The Pratt parser in `./parser.ts` consumes this stream
 * top-to-bottom, so the tokenizer must record everything the parser needs
 * to shape the tree:
 *   - operator lexemes (so the parser can dispatch by character)
 *   - whole A1 / range / cross-sheet refs as **single tokens** so the
 *     parser does not have to disambiguate `A1` (ref) from `A` (name) +
 *     `1` (number).
 *   - quoted strings, error literals (`#REF!`), and inline array braces.
 *
 * Discipline:
 *   - Only imports come from `../types` (for `ErrorCode` / `ERROR_CODES`).
 *   - Never throws — emits a `Token{kind:'error'}` for unrecognized chars
 *     so the parser can surface a `#VALUE!` envelope cleanly.
 *   - Position is tracked as a 0-based character offset; useful for any
 *     future diagnostic that wants column info.
 */

import { ERROR_CODES, type ErrorCode } from '../types'

export type Token =
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'string'; value: string; pos: number }
  | { kind: 'boolean'; value: boolean; pos: number }
  | { kind: 'error-literal'; code: ErrorCode; pos: number }
  | { kind: 'ref'; a1: string; absCol: boolean; absRow: boolean; pos: number }
  | { kind: 'range-part'; a1: string; absCol: boolean; absRow: boolean; pos: number }
  | { kind: 'whole-col'; col: string; absCol: boolean; pos: number }
  | { kind: 'whole-row'; row: number; absRow: boolean; pos: number }
  | { kind: 'sheet-prefix'; name: string; pos: number }
  | { kind: 'name'; value: string; pos: number }
  | { kind: 'op'; value: OpLexeme; pos: number }
  | { kind: 'lparen'; pos: number }
  | { kind: 'rparen'; pos: number }
  | { kind: 'lbrace'; pos: number }
  | { kind: 'rbrace'; pos: number }
  | { kind: 'comma'; pos: number }
  | { kind: 'semicolon'; pos: number }
  | { kind: 'colon'; pos: number }
  | { kind: 'percent'; pos: number }
  | { kind: 'bang'; pos: number }
  | { kind: 'eof'; pos: number }
  | { kind: 'tokenizer-error'; message: string; pos: number }

export type OpLexeme =
  | '+'
  | '-'
  | '*'
  | '/'
  | '^'
  | '&'
  | '='
  | '<>'
  | '<'
  | '<='
  | '>'
  | '>='

const ERROR_CODE_SET = new Set<string>(ERROR_CODES)

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isLetter(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
}

function isIdentStart(ch: string): boolean {
  return isLetter(ch) || ch === '_'
}

function isIdentPart(ch: string): boolean {
  // Excel allows `.` and `?` and digits inside function / name identifiers
  // (`BETA.DIST`, `CONFIDENCE.T`, `SUM`, `MY_RANGE_1`).
  return isLetter(ch) || isDigit(ch) || ch === '_' || ch === '.' || ch === '?'
}

/**
 * Match a column letters prefix at `src[i]`. Returns the matched string
 * (e.g. `"A"`, `"AA"`, `"XFD"`) and the new index, or `null` if no column
 * letters are present. Excel maxes at `XFD` (column 16383); we let the
 * tokenizer over-accept and validate later.
 */
function matchColumn(src: string, i: number): { col: string; next: number } | null {
  let j = i
  while (j < src.length && isLetter(src[j])) {
    j += 1
  }
  if (j === i) return null
  // Cap at the realistic Excel max (3 letters). Anything longer is a
  // generic identifier, not a column.
  if (j - i > 3) return null
  return { col: src.slice(i, j).toUpperCase(), next: j }
}

function matchRowDigits(src: string, i: number): { row: number; next: number } | null {
  let j = i
  while (j < src.length && isDigit(src[j])) {
    j += 1
  }
  if (j === i) return null
  // Excel max row is 1048576. Over-accept and validate later.
  const n = Number(src.slice(i, j))
  if (!Number.isFinite(n) || n < 1) return null
  return { row: n, next: j }
}

/**
 * Try to read an A1-style reference (`A1`, `$A1`, `A$1`, `$A$1`) starting at
 * `i`. Returns `{ a1, absCol, absRow, next }` or `null`. The matched run
 * MUST be followed by a non-identifier character to avoid eating into
 * names like `A1_FOO`.
 */
function tryReadRef(
  src: string,
  i: number,
): { a1: string; absCol: boolean; absRow: boolean; next: number } | null {
  let j = i
  let absCol = false
  let absRow = false
  if (src[j] === '$') {
    absCol = true
    j += 1
  }
  const colMatch = matchColumn(src, j)
  if (!colMatch) return null
  j = colMatch.next
  if (src[j] === '$') {
    absRow = true
    j += 1
  }
  const rowMatch = matchRowDigits(src, j)
  if (!rowMatch) return null
  j = rowMatch.next
  // Disambiguate `A1FOO` — that's a name, not a ref.
  if (j < src.length && isIdentPart(src[j])) return null
  const a1 = `${colMatch.col}${rowMatch.row}`
  return { a1, absCol, absRow, next: j }
}

/**
 * Try to read a whole-column ref (`A`, `$A`, `AA`) starting at `i`. The
 * caller should already know we're at the start of a `<col>:<col>` pair;
 * this only matches the column letters with optional leading `$`.
 */
function tryReadWholeColumn(
  src: string,
  i: number,
): { col: string; absCol: boolean; next: number } | null {
  let j = i
  let absCol = false
  if (src[j] === '$') {
    absCol = true
    j += 1
  }
  const colMatch = matchColumn(src, j)
  if (!colMatch) return null
  j = colMatch.next
  if (j < src.length && (isIdentPart(src[j]) || src[j] === '$')) return null
  return { col: colMatch.col, absCol, next: j }
}

function tryReadWholeRow(
  src: string,
  i: number,
): { row: number; absRow: boolean; next: number } | null {
  let j = i
  let absRow = false
  if (src[j] === '$') {
    absRow = true
    j += 1
  }
  const rowMatch = matchRowDigits(src, j)
  if (!rowMatch) return null
  j = rowMatch.next
  if (j < src.length && isIdentPart(src[j])) return null
  return { row: rowMatch.row, absRow, next: j }
}

/**
 * Read a quoted sheet name `'Sheet With Spaces'`. The opening quote at
 * `src[i]` is `'`. Returns the unquoted name (with `''` → `'`) and the
 * new index, or null on unterminated.
 */
function readQuotedSheetName(src: string, i: number): { name: string; next: number } | null {
  // src[i] === '\''
  let j = i + 1
  let out = ''
  while (j < src.length) {
    const ch = src[j]
    if (ch === "'") {
      if (src[j + 1] === "'") {
        out += "'"
        j += 2
        continue
      }
      return { name: out, next: j + 1 }
    }
    out += ch
    j += 1
  }
  return null
}

/**
 * Read a double-quoted string literal starting at `src[i]` (which is `"`).
 * Excel doubles `""` to escape a quote.
 */
function readString(src: string, i: number): { value: string; next: number } | null {
  let j = i + 1
  let out = ''
  while (j < src.length) {
    const ch = src[j]
    if (ch === '"') {
      if (src[j + 1] === '"') {
        out += '"'
        j += 2
        continue
      }
      return { value: out, next: j + 1 }
    }
    out += ch
    j += 1
  }
  return null
}

/**
 * Read a number literal. Supports `123`, `1.5`, `.5`, `1e10`, `1.5E-3`.
 * Excel does NOT accept hex / octal / underscores in numeric literals.
 */
function readNumber(src: string, i: number): { value: number; next: number } | null {
  let j = i
  let seenDigit = false
  while (j < src.length && isDigit(src[j])) {
    j += 1
    seenDigit = true
  }
  if (src[j] === '.') {
    j += 1
    while (j < src.length && isDigit(src[j])) {
      j += 1
      seenDigit = true
    }
  }
  if (!seenDigit) return null
  if (src[j] === 'e' || src[j] === 'E') {
    let k = j + 1
    if (src[k] === '+' || src[k] === '-') k += 1
    let expDigits = false
    while (k < src.length && isDigit(src[k])) {
      k += 1
      expDigits = true
    }
    if (expDigits) j = k
  }
  const value = Number(src.slice(i, j))
  if (!Number.isFinite(value)) return null
  return { value, next: j }
}

/**
 * Read an error literal `#REF!`, `#N/A`, `#DIV/0!`, etc. Match greedily
 * against the canonical list in `ERROR_CODES`.
 */
function readError(src: string, i: number): { code: ErrorCode; next: number } | null {
  // Greedy match against the longest entry from ERROR_CODES whose chars
  // align case-insensitively with src[i..].
  let best: { code: ErrorCode; next: number } | null = null
  for (const code of ERROR_CODES) {
    if (src.length - i < code.length) continue
    const slice = src.slice(i, i + code.length)
    if (slice.toUpperCase() === code.toUpperCase()) {
      if (best === null || code.length > best.code.length) {
        best = { code, next: i + code.length }
      }
    }
  }
  if (best) return best
  // Allow lower-case `#n/a` too — handled by the toUpperCase compare above,
  // but ERROR_CODE_SET lookup is the canonical post-check.
  if (!ERROR_CODE_SET.size) return null
  return null
}

/**
 * Tokenize a formula body (after leading `=` is stripped). Always returns
 * a stream terminated by `{kind:'eof'}`. On unrecognized characters,
 * emits `{kind:'tokenizer-error'}` so the parser can surface `#VALUE!`.
 */
export function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  const n = src.length

  while (i < n) {
    const ch = src[i]

    // skip whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }

    const pos = i

    // ---------- single-char delims ----------
    if (ch === '(') {
      out.push({ kind: 'lparen', pos })
      i += 1
      continue
    }
    if (ch === ')') {
      out.push({ kind: 'rparen', pos })
      i += 1
      continue
    }
    if (ch === '{') {
      out.push({ kind: 'lbrace', pos })
      i += 1
      continue
    }
    if (ch === '}') {
      out.push({ kind: 'rbrace', pos })
      i += 1
      continue
    }
    if (ch === ',') {
      out.push({ kind: 'comma', pos })
      i += 1
      continue
    }
    if (ch === ';') {
      out.push({ kind: 'semicolon', pos })
      i += 1
      continue
    }
    if (ch === ':') {
      out.push({ kind: 'colon', pos })
      i += 1
      continue
    }
    if (ch === '%') {
      out.push({ kind: 'percent', pos })
      i += 1
      continue
    }
    if (ch === '!') {
      out.push({ kind: 'bang', pos })
      i += 1
      continue
    }

    // ---------- operators ----------
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '^' || ch === '&' || ch === '=') {
      out.push({ kind: 'op', value: ch as OpLexeme, pos })
      i += 1
      continue
    }
    if (ch === '<') {
      if (src[i + 1] === '>') {
        out.push({ kind: 'op', value: '<>', pos })
        i += 2
        continue
      }
      if (src[i + 1] === '=') {
        out.push({ kind: 'op', value: '<=', pos })
        i += 2
        continue
      }
      out.push({ kind: 'op', value: '<', pos })
      i += 1
      continue
    }
    if (ch === '>') {
      if (src[i + 1] === '=') {
        out.push({ kind: 'op', value: '>=', pos })
        i += 2
        continue
      }
      out.push({ kind: 'op', value: '>', pos })
      i += 1
      continue
    }

    // ---------- strings ----------
    if (ch === '"') {
      const r = readString(src, i)
      if (!r) {
        out.push({ kind: 'tokenizer-error', message: 'unterminated string', pos })
        return out
      }
      out.push({ kind: 'string', value: r.value, pos })
      i = r.next
      continue
    }

    // ---------- quoted sheet name `'Sheet'!...` ----------
    if (ch === "'") {
      const r = readQuotedSheetName(src, i)
      if (!r) {
        out.push({ kind: 'tokenizer-error', message: 'unterminated quoted name', pos })
        return out
      }
      // The next char MUST be `!` for this to be a sheet prefix. If not,
      // treat the quoted name as a generic name token (rare in Excel but
      // keeps the tokenizer total).
      if (src[r.next] === '!') {
        out.push({ kind: 'sheet-prefix', name: r.name, pos })
        out.push({ kind: 'bang', pos: r.next })
        i = r.next + 1
        continue
      }
      out.push({ kind: 'name', value: r.name, pos })
      i = r.next
      continue
    }

    // ---------- numbers (must come before refs to avoid `1:1` ambiguity) ----------
    // But we have to also support `1:1` whole-row, so peek both ways:
    //   - if the digits run is immediately followed by `:` AND another
    //     row digit run, it's `<row>:<row>`.
    if (isDigit(ch)) {
      // Look ahead for whole-row pattern `<digits>:<digits>` with NO letter prefix.
      const rowProbe = tryReadWholeRow(src, i)
      if (rowProbe && src[rowProbe.next] === ':') {
        const endRow = tryReadWholeRow(src, rowProbe.next + 1)
        if (endRow) {
          out.push({ kind: 'whole-row', row: rowProbe.row, absRow: rowProbe.absRow, pos })
          out.push({ kind: 'colon', pos: rowProbe.next })
          out.push({
            kind: 'whole-row',
            row: endRow.row,
            absRow: endRow.absRow,
            pos: rowProbe.next + 1,
          })
          i = endRow.next
          continue
        }
      }
      const num = readNumber(src, i)
      if (num) {
        out.push({ kind: 'number', value: num.value, pos })
        i = num.next
        continue
      }
    }

    // ---------- error literals (start with `#`) ----------
    if (ch === '#') {
      const err = readError(src, i)
      if (err) {
        out.push({ kind: 'error-literal', code: err.code, pos })
        i = err.next
        continue
      }
      out.push({ kind: 'tokenizer-error', message: `unknown error literal at ${i}`, pos })
      return out
    }

    // ---------- refs / ranges / whole-col / names / booleans ----------
    if (ch === '$' || isLetter(ch) || ch === '_') {
      // Try ref first: `$A$1`, `A1`.
      const ref = tryReadRef(src, i)
      if (ref) {
        // Disambiguate `A1:B10` vs `A1:foo` — we still emit a ref here and
        // let the parser fold `<ref> : <ref>` into a range.
        out.push({
          kind: 'ref',
          a1: ref.a1,
          absCol: ref.absCol,
          absRow: ref.absRow,
          pos,
        })
        i = ref.next
        continue
      }
      // Whole-column probe: `A:A`, `$A:$B`.
      const wcol = tryReadWholeColumn(src, i)
      if (wcol && src[wcol.next] === ':') {
        const endCol = tryReadWholeColumn(src, wcol.next + 1)
        if (endCol) {
          out.push({ kind: 'whole-col', col: wcol.col, absCol: wcol.absCol, pos })
          out.push({ kind: 'colon', pos: wcol.next })
          out.push({
            kind: 'whole-col',
            col: endCol.col,
            absCol: endCol.absCol,
            pos: wcol.next + 1,
          })
          i = endCol.next
          continue
        }
      }
      // Identifier / boolean / sheet-prefix.
      if (isIdentStart(ch)) {
        let j = i
        while (j < n && isIdentPart(src[j])) j += 1
        const id = src.slice(i, j)
        const upper = id.toUpperCase()
        // Sheet prefix? `Sheet2!A1` — peek for `!`.
        if (src[j] === '!') {
          out.push({ kind: 'sheet-prefix', name: id, pos })
          out.push({ kind: 'bang', pos: j })
          i = j + 1
          continue
        }
        if (upper === 'TRUE') {
          out.push({ kind: 'boolean', value: true, pos })
          i = j
          continue
        }
        if (upper === 'FALSE') {
          out.push({ kind: 'boolean', value: false, pos })
          i = j
          continue
        }
        out.push({ kind: 'name', value: id, pos })
        i = j
        continue
      }
      // Lone `$` with nothing after — bail.
      out.push({ kind: 'tokenizer-error', message: `unexpected '$' at ${i}`, pos })
      return out
    }

    // Number that started with `.` (e.g. `.5`).
    if (ch === '.') {
      const num = readNumber(src, i)
      if (num) {
        out.push({ kind: 'number', value: num.value, pos })
        i = num.next
        continue
      }
    }

    out.push({
      kind: 'tokenizer-error',
      message: `unexpected character '${ch}' at ${i}`,
      pos,
    })
    return out
  }

  out.push({ kind: 'eof', pos: i })
  return out
}
