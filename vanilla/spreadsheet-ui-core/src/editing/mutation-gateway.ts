import { atom, type Atom, type Setter } from '@einfach/core'
import type { VisibleProjectionResult } from '../backend/types'
import {
  appendDiagnosticsAtom,
  createSpreadsheetDiagnostic,
  type SpreadsheetDiagnostic,
} from '../diagnostics'
import { projectionSnapshotAtom, type ProjectionResult } from '../projection'
import { isRangeFullyUnlocked, sheetProtectionAtom } from '../protection'
import type { CellCoord, CellRange } from '../shared'

/**
 * Unified content-mutation gateway.
 *
 * Every content mutation (set-cell-input, clear-range, fill-range,
 * fill-series, paste-range, import-cell-chunks) resolves through this
 * module before any transport is launched:
 *
 * 1. Display→source row remap. When filter/sort is active the visible
 *    projection carries `DisplayCell.originalRow`; mutation targets arrive
 *    in display coordinates and must be remapped to source rows. Without
 *    an active remap the resolution is the identity. A display row that
 *    cannot be mapped (outside the projected window, or no originalRow
 *    fact) fails closed — the mutation is blocked, never guessed.
 * 2. Protection gate. After remap, if the sheet is protected and the
 *    source-coordinate target is not fully covered by unlocked ranges,
 *    the mutation is blocked before transport (fail-closed).
 *
 * Format-only mutations are out of scope; callers of format paths keep
 * their existing behavior (`protectionGate: false` skips step 2 while
 * still applying the row remap).
 */

export type ContentMutationKind =
  | 'set-cell-input'
  | 'clear-range'
  | 'fill-range'
  | 'fill-series'
  | 'paste-range'
  | 'import-cell-chunks'

export interface ResolveContentMutationCellInput {
  readonly kind: ContentMutationKind
  readonly sheetId: string
  /** Display-coordinate target cell. */
  readonly cell: Readonly<CellCoord>
  readonly range?: undefined
  /** Defaults to true. Pass false for read-side or format-only resolution. */
  readonly protectionGate?: boolean
}

export interface ResolveContentMutationRangeInput {
  readonly kind: ContentMutationKind
  readonly sheetId: string
  /** Display-coordinate target range. */
  readonly range: Readonly<CellRange>
  readonly cell?: undefined
  /** Defaults to true. Pass false for read-side or format-only resolution. */
  readonly protectionGate?: boolean
}

export type ResolveContentMutationInput =
  | ResolveContentMutationCellInput
  | ResolveContentMutationRangeInput

export type ContentMutationBlockReason = 'locked' | 'unmapped-row' | 'invalid-target'

export interface AllowedContentMutation {
  readonly status: 'allowed'
  readonly kind: ContentMutationKind
  readonly sheetId: string
  /** Source-coordinate cell; present only for cell-target inputs. */
  readonly cell?: Readonly<CellCoord>
  /**
   * Source-coordinate ranges; present only for range-target inputs. A
   * remapped display range splits into one range per contiguous source
   * row run, so callers must issue one transport per entry.
   */
  readonly ranges?: readonly Readonly<CellRange>[]
  /** True when the display→source remap moved at least one row. */
  readonly remapped: boolean
}

export interface BlockedContentMutation {
  readonly status: 'blocked'
  readonly kind: ContentMutationKind
  readonly sheetId: string
  readonly reason: ContentMutationBlockReason
  readonly diagnostic: SpreadsheetDiagnostic
}

export type ContentMutationResolution = AllowedContentMutation | BlockedContentMutation

export type DisplayCellMapping =
  | { readonly ok: true; readonly cell: Readonly<CellCoord>; readonly remapped: boolean }
  | { readonly ok: false; readonly reason: 'unmapped-row' | 'invalid-target' }

export type DisplayRangeMapping =
  | {
      readonly ok: true
      readonly ranges: readonly Readonly<CellRange>[]
      readonly remapped: boolean
    }
  | { readonly ok: false; readonly reason: 'unmapped-row' | 'invalid-target' }

function isSafeCoordValue(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function isValidCell(cell: Readonly<CellCoord>): boolean {
  return isSafeCoordValue(cell.row) && isSafeCoordValue(cell.col)
}

function isValidRange(range: Readonly<CellRange>): boolean {
  return (
    isSafeCoordValue(range.rowStart) &&
    isSafeCoordValue(range.colStart) &&
    Number.isSafeInteger(range.rowEnd) &&
    Number.isSafeInteger(range.colEnd) &&
    range.rowEnd >= range.rowStart &&
    range.colEnd >= range.colStart
  )
}

/**
 * The visible projection result for `sheetId` when it carries an active
 * display→source row remap (`originalRow` facts); null when mutations may
 * pass through untouched.
 */
export function getActiveRowRemapProjection(
  result: ProjectionResult | undefined,
  sheetId: string,
): VisibleProjectionResult | null {
  if (result === undefined || result.kind !== 'visible-window' || result.sheetId !== sheetId) {
    return null
  }
  return result.cells.some((cell) => typeof cell.originalRow === 'number') ? result : null
}

/**
 * Source row for one display row inside an active remap projection.
 * Null when the row is outside the window or has no `originalRow` fact.
 */
export function mapDisplayRowToSourceRow(
  visible: VisibleProjectionResult,
  row: number,
): number | null {
  const windowRange = visible.window
  if (row < windowRange.rowStart || row > windowRange.rowEnd) return null
  for (const cell of visible.cells) {
    if (cell.row === row && typeof cell.originalRow === 'number') {
      return isSafeCoordValue(cell.originalRow) ? cell.originalRow : null
    }
  }
  return null
}

/** Display→source remap for a single cell. Identity when no remap is active. */
export function mapDisplayCellToSource(
  result: ProjectionResult | undefined,
  sheetId: string,
  cell: Readonly<CellCoord>,
): DisplayCellMapping {
  if (!isValidCell(cell)) {
    return { ok: false, reason: 'invalid-target' }
  }
  const visible = getActiveRowRemapProjection(result, sheetId)
  if (visible === null) {
    return { ok: true, cell: { row: cell.row, col: cell.col }, remapped: false }
  }
  const sourceRow = mapDisplayRowToSourceRow(visible, cell.row)
  if (sourceRow === null) {
    return { ok: false, reason: 'unmapped-row' }
  }
  return {
    ok: true,
    cell: { row: sourceRow, col: cell.col },
    remapped: sourceRow !== cell.row,
  }
}

/**
 * Display→source remap for a range. Identity when no remap is active.
 * With an active remap every display row must resolve; contiguous source
 * rows collapse into one range, permuted rows split per run.
 */
export function mapDisplayRangeToSourceRanges(
  result: ProjectionResult | undefined,
  sheetId: string,
  range: Readonly<CellRange>,
): DisplayRangeMapping {
  if (!isValidRange(range)) {
    return { ok: false, reason: 'invalid-target' }
  }
  const visible = getActiveRowRemapProjection(result, sheetId)
  if (visible === null) {
    return { ok: true, ranges: [{ ...range }], remapped: false }
  }

  const ranges: CellRange[] = []
  let remapped = false
  for (let row = range.rowStart; row <= range.rowEnd; row += 1) {
    const sourceRow = mapDisplayRowToSourceRow(visible, row)
    if (sourceRow === null) {
      return { ok: false, reason: 'unmapped-row' }
    }
    remapped ||= sourceRow !== row
    const previous = ranges[ranges.length - 1]
    if (previous !== undefined && previous.rowEnd + 1 === sourceRow) {
      previous.rowEnd = sourceRow
    } else {
      ranges.push({
        rowStart: sourceRow,
        rowEnd: sourceRow,
        colStart: range.colStart,
        colEnd: range.colEnd,
      })
    }
  }

  if (!remapped) {
    return { ok: true, ranges: [{ ...range }], remapped: false }
  }
  return { ok: true, ranges, remapped: true }
}

const BLOCK_MESSAGES: Record<ContentMutationBlockReason, string> = {
  locked: 'The target cells are locked on a protected sheet.',
  'unmapped-row': 'The target rows cannot be mapped to source rows while filter or sort is active.',
  'invalid-target': 'The mutation target coordinates are invalid.',
}

const BLOCK_CODES: Record<ContentMutationBlockReason, string> = {
  locked: 'MUTATION_BLOCKED_LOCKED',
  'unmapped-row': 'MUTATION_UNMAPPED_ROW',
  'invalid-target': 'MUTATION_INVALID_TARGET',
}

function createBlockedResolution(
  input: ResolveContentMutationInput,
  reason: ContentMutationBlockReason,
): BlockedContentMutation {
  const diagnostic = createSpreadsheetDiagnostic({
    severity: reason === 'invalid-target' ? 'error' : 'warning',
    source: 'operations',
    code: BLOCK_CODES[reason],
    message: BLOCK_MESSAGES[reason],
    sheetId: input.sheetId,
    id: `operations:${BLOCK_CODES[reason]}:${input.kind}:${input.sheetId}`,
    ...(input.cell !== undefined ? { cell: { row: input.cell.row, col: input.cell.col } } : {}),
    ...(input.range !== undefined ? { range: { ...input.range } } : {}),
  })
  return Object.freeze({
    status: 'blocked',
    kind: input.kind,
    sheetId: input.sheetId,
    reason,
    diagnostic,
  })
}

// Source atom (module-private backing) for the latest blocked resolution.
const contentMutationLastBlockBackingAtom = atom<BlockedContentMutation | null>(null)
contentMutationLastBlockBackingAtom.debugLabel = 'spreadsheet.mutationGateway.lastBlockBacking'

/** Derived read-only view: latest blocked content mutation, null when none. */
export const contentMutationLastBlockAtom: Atom<BlockedContentMutation | null> = atom((get) =>
  get(contentMutationLastBlockBackingAtom),
)
contentMutationLastBlockAtom.debugLabel = 'spreadsheet.mutationGateway.lastBlock'

/** Command: clear the recorded block (e.g. after the UI showed a hint). */
export const clearContentMutationBlockAtom = atom(null, (_get, set): void => {
  set(contentMutationLastBlockBackingAtom, null)
})
clearContentMutationBlockAtom.debugLabel = 'spreadsheet.mutationGateway.clearBlock'

/**
 * Command: resolve one content-mutation intent. Returns either the
 * source-coordinate target (allowed) or a structured blocked result. A
 * blocked resolution records itself on `contentMutationLastBlockAtom` and
 * appends a diagnostic; the caller MUST NOT launch any transport for it.
 */
export const resolveContentMutationAtom = atom(
  null,
  (get, set, input: ResolveContentMutationInput): ContentMutationResolution => {
    const result = get(projectionSnapshotAtom).result
    const enforceProtection = input.protectionGate !== false

    let sourceCell: Readonly<CellCoord> | undefined
    let sourceRanges: readonly Readonly<CellRange>[] | undefined
    let remapped = false

    if (input.cell !== undefined) {
      const mapping = mapDisplayCellToSource(result, input.sheetId, input.cell)
      if (!mapping.ok) {
        return publishBlock(set, createBlockedResolution(input, mapping.reason))
      }
      sourceCell = Object.freeze({ ...mapping.cell })
      remapped = mapping.remapped
    } else if (input.range !== undefined) {
      const mapping = mapDisplayRangeToSourceRanges(result, input.sheetId, input.range)
      if (!mapping.ok) {
        return publishBlock(set, createBlockedResolution(input, mapping.reason))
      }
      sourceRanges = Object.freeze(mapping.ranges.map((range) => Object.freeze({ ...range })))
      remapped = mapping.remapped
    } else {
      return publishBlock(set, createBlockedResolution(input, 'invalid-target'))
    }

    if (enforceProtection) {
      const protection = get(sheetProtectionAtom)
      const gateRanges: readonly Readonly<CellRange>[] =
        sourceRanges ??
        (sourceCell !== undefined
          ? [
              {
                rowStart: sourceCell.row,
                rowEnd: sourceCell.row,
                colStart: sourceCell.col,
                colEnd: sourceCell.col,
              },
            ]
          : [])
      const unlocked = gateRanges.every((range) =>
        isRangeFullyUnlocked(protection, input.sheetId, range),
      )
      if (!unlocked) {
        return publishBlock(set, createBlockedResolution(input, 'locked'))
      }
    }

    return Object.freeze({
      status: 'allowed',
      kind: input.kind,
      sheetId: input.sheetId,
      ...(sourceCell !== undefined ? { cell: sourceCell } : {}),
      ...(sourceRanges !== undefined ? { ranges: sourceRanges } : {}),
      remapped,
    })
  },
)
resolveContentMutationAtom.debugLabel = 'spreadsheet.mutationGateway.resolve'

function publishBlock(set: Setter, blocked: BlockedContentMutation): BlockedContentMutation {
  set(contentMutationLastBlockBackingAtom, blocked)
  set(appendDiagnosticsAtom, blocked.diagnostic)
  return blocked
}
