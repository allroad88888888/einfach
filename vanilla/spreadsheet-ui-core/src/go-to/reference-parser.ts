import { parseA1Cell, parseA1Range, findNamedRange } from '../name-box'
import type { NamedRange } from '../named-ranges'
import type { CellCoord, CellRange } from '../shared'
import type {
  GoToParseContext,
  GoToParseReason,
  GoToParseResult,
  GoToTarget,
} from './types'

// Single-cell R1C1 token: `R3C5`, `RC`, `R[-2]C[1]`, `R3C[2]`, etc.
// Capture groups:
//   1: '['        — absent = absolute or bare R
//   2: digits     — absent for `R` / `R[]`
//   1/2 together describe the row coordinate
//   3: '['        — column counterpart
//   4: digits
//
// Each axis falls into one of four buckets:
//   - `Rn`        absolute row n (1-based)        → token = `n`,  rel=false
//   - `R[n]`      relative row offset n           → token = `n`,  rel=true
//   - `R[-n]`     relative row offset -n          → token = `-n`, rel=true
//   - `R`         relative row, offset 0          → token = `0`,  rel=true
const R1C1_AXIS = String.raw`(?:\[(-?\d+)\]|(\d+)|)`
const R1C1_CELL_PATTERN = new RegExp(`^R${R1C1_AXIS}C${R1C1_AXIS}$`, 'i')

/**
 * Pure parser for Go To text input. Accepts:
 *
 *   - A1 cell:      `B12`
 *   - A1 range:     `B12:D18`
 *   - R1C1 cell:    `R12C3` (absolute), `RC[1]`, `R[-2]C` (relative)
 *   - R1C1 range:   `R12C3:R18C5`, `R[-1]C:R[1]C[2]`
 *   - sheet-qual:   `Sheet2!B12`, `'My Sheet'!B12:C18`
 *   - named range:  `MyRange` (looked up in context.registry)
 *
 * Returns a discriminated-union result so callers can branch on `ok`
 * without throwing. Sheet-qualified references override
 * `context.activeSheetId`; bare references inherit the active sheet.
 *
 * Relative R1C1 (`R[n]C[n]` / `RC` / `R[n]C`) is resolved against
 * `context.activeCell` (defaults to A1). Out-of-bounds offsets (negative
 * resolved coords) fail with `invalid-address`.
 */
export function parseGoToReference(
  input: string,
  context: GoToParseContext,
): GoToParseResult {
  const raw = input.trim()
  if (raw.length === 0) {
    return { ok: false, reason: 'empty' }
  }

  const { sheetPrefix, body, sheetParseFailed } = splitSheetPrefix(raw)
  if (sheetParseFailed) {
    return { ok: false, reason: 'invalid-address' }
  }

  // Resolve sheet — bare = active sheet, prefix = lookup by name.
  let sheetId = context.activeSheetId
  if (sheetPrefix !== null) {
    const found = context.sheets.find(
      (s) => s.name.toLowerCase() === sheetPrefix.toLowerCase(),
    )
    if (!found) {
      return { ok: false, reason: 'invalid-address' }
    }
    sheetId = found.id
  }

  // Try A1 cell / A1 range / R1C1 forms.
  const cell = parseA1Cell(body)
  if (cell) {
    return ok({ sheetId, coord: cell })
  }
  const range = parseA1Range(body)
  if (range) {
    return ok({ sheetId, range })
  }
  const r1c1 = parseR1C1(body, context.activeCell)
  if (r1c1) {
    return ok({ sheetId, ...r1c1 })
  }

  // Named-range lookup (only when no sheet prefix was supplied — Excel
  // ignores `Sheet1!MyRange` because names carry their own scope).
  if (sheetPrefix === null) {
    const named = findNamedRange(context.registry as readonly NamedRange[], raw)
    if (named && named.refersTo.kind === 'range') {
      const resolvedRange = parseA1Range(named.refersTo.address)
      if (resolvedRange) {
        return ok({ sheetId: named.refersTo.sheetId, range: resolvedRange })
      }
      const resolvedCell = parseA1Cell(named.refersTo.address)
      if (resolvedCell) {
        return ok({ sheetId: named.refersTo.sheetId, coord: resolvedCell })
      }
      return { ok: false, reason: 'invalid-address' }
    }
    // Looks like a bare identifier that is not a registered name.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
      return { ok: false, reason: 'unknown-name' }
    }
  }

  return { ok: false, reason: 'invalid-address' }
}

function ok(target: GoToTarget): GoToParseResult {
  return { ok: true, target }
}

function splitSheetPrefix(input: string): {
  sheetPrefix: string | null
  body: string
  sheetParseFailed: boolean
} {
  // Quoted sheet name: 'My Sheet'!A1
  if (input.startsWith("'")) {
    const close = input.indexOf("'!", 1)
    if (close < 0) {
      return { sheetPrefix: null, body: input, sheetParseFailed: true }
    }
    const name = input.slice(1, close).replace(/''/g, "'")
    const body = input.slice(close + 2).trim()
    if (body.length === 0) {
      return { sheetPrefix: null, body: input, sheetParseFailed: true }
    }
    return { sheetPrefix: name, body, sheetParseFailed: false }
  }

  const bangIdx = input.indexOf('!')
  if (bangIdx < 0) {
    return { sheetPrefix: null, body: input, sheetParseFailed: false }
  }
  const name = input.slice(0, bangIdx).trim()
  const body = input.slice(bangIdx + 1).trim()
  if (name.length === 0 || body.length === 0) {
    return { sheetPrefix: null, body: input, sheetParseFailed: true }
  }
  return { sheetPrefix: name, body, sheetParseFailed: false }
}

function parseR1C1(
  input: string,
  activeCell?: CellCoord,
): { coord?: CellCoord; range?: CellRange } | null {
  const trimmed = input.trim()
  // Single-cell form.
  const single = R1C1_CELL_PATTERN.exec(trimmed)
  if (single) {
    return resolveR1C1Cell(single, activeCell)
  }
  // Range form: split on the *unquoted* colon and parse each side.
  const colonIdx = trimmed.indexOf(':')
  if (colonIdx < 0) return null
  const lhsMatch = R1C1_CELL_PATTERN.exec(trimmed.slice(0, colonIdx).trim())
  const rhsMatch = R1C1_CELL_PATTERN.exec(trimmed.slice(colonIdx + 1).trim())
  if (!lhsMatch || !rhsMatch) return null
  const lhs = resolveR1C1Cell(lhsMatch, activeCell)
  const rhs = resolveR1C1Cell(rhsMatch, activeCell)
  if (!lhs?.coord || !rhs?.coord) return null
  return {
    range: {
      rowStart: Math.min(lhs.coord.row, rhs.coord.row),
      rowEnd: Math.max(lhs.coord.row, rhs.coord.row),
      colStart: Math.min(lhs.coord.col, rhs.coord.col),
      colEnd: Math.max(lhs.coord.col, rhs.coord.col),
    },
  }
}

// Resolve a single-cell R1C1 match into a 0-based CellCoord. Returns null on
// out-of-bounds (negative resolved coords).
function resolveR1C1Cell(
  match: RegExpExecArray,
  activeCell?: CellCoord,
): { coord: CellCoord } | null {
  // Group indexes: [1]=row [, [2]=row digits, [3]=col [, [4]=col digits.
  const anchor = activeCell ?? { row: 0, col: 0 }
  const row = resolveR1C1Axis(match[1], match[2], anchor.row)
  const col = resolveR1C1Axis(match[3], match[4], anchor.col)
  if (row === null || col === null) return null
  return { coord: { row, col } }
}

// `bracket` is the relative offset string from `[...]` (may be negative).
// `abs` is the absolute 1-based digits.
// Exactly one of (bracket, abs) is defined, or both undefined (bare R / C).
function resolveR1C1Axis(
  bracket: string | undefined,
  abs: string | undefined,
  anchorIdx: number,
): number | null {
  if (abs !== undefined) {
    const n = Number(abs)
    if (!Number.isInteger(n) || n < 1) return null
    return n - 1
  }
  if (bracket !== undefined) {
    const n = Number(bracket)
    if (!Number.isInteger(n)) return null
    const resolved = anchorIdx + n
    if (resolved < 0) return null
    return resolved
  }
  // Bare `R` or `C` — relative with zero offset (Excel: same row/col).
  return anchorIdx
}

export type { GoToParseReason }
