import { atom, type Atom, type Setter } from '@einfach/core'
import {
  appendDiagnosticsAtom,
  createSpreadsheetDiagnostic,
  type SpreadsheetDiagnostic,
} from '../diagnostics'
import { isRangeFullyUnlocked, sheetProtectionAtom } from '../protection'
import type { CellCoord, CellRange } from '../shared'

/**
 * Unified content-mutation gateway.
 *
 * Every content mutation (set-cell-input, clear-range, fill-range,
 * fill-series, paste-range, import-cell-chunks) and every format write
 * (set-format-range) resolves through this module before any transport is
 * launched:
 *
 * 1. Target validity. Coordinates must be safe non-negative integers and
 *    ranges must be non-inverted, else `invalid-target`.
 * 2. Protection gate. If the sheet is protected and the target is not
 *    fully covered by unlocked ranges, the mutation is blocked before
 *    transport (fail-closed). This applies to `set-format-range` too —
 *    Excel semantics: locked cells on a protected sheet cannot be
 *    reformatted. `protectionGate: false` skips step 2 (e.g. reading a
 *    fill source, format-only clears).
 *
 * Mutation targets are SOURCE coordinates on arrival. Filtering hides rows
 * rather than compacting them (#27 S5), so display row IS source row and
 * there is no second coordinate system to translate between. The gateway's
 * whole display→source remap half — the per-cell source-row echo, the
 * run-splitting range mapper, the unmappable-row block reason and the
 * identity-mapping fail-closed door — was retired with the compaction it
 * existed to undo (#27 S6). `ranges` is therefore always the single input
 * range; it stays a list only so callers that already loop stay unchanged.
 */

export type ContentMutationKind =
  | 'set-cell-input'
  | 'clear-range'
  | 'fill-range'
  | 'fill-series'
  | 'paste-range'
  | 'import-cell-chunks'
  | 'set-format-range'

export interface ResolveContentMutationCellInput {
  readonly kind: ContentMutationKind
  readonly sheetId: string
  /** Target cell. */
  readonly cell: Readonly<CellCoord>
  readonly range?: undefined
  /** Defaults to true. Pass false for read-side or gate-exempt resolution. */
  readonly protectionGate?: boolean
}

export interface ResolveContentMutationRangeInput {
  readonly kind: ContentMutationKind
  readonly sheetId: string
  /** Target range. */
  readonly range: Readonly<CellRange>
  readonly cell?: undefined
  /** Defaults to true. Pass false for read-side or gate-exempt resolution. */
  readonly protectionGate?: boolean
}

export type ResolveContentMutationInput =
  | ResolveContentMutationCellInput
  | ResolveContentMutationRangeInput

export type ContentMutationBlockReason = 'locked' | 'invalid-target'

export interface AllowedContentMutation {
  readonly status: 'allowed'
  readonly kind: ContentMutationKind
  readonly sheetId: string
  /** Target cell; present only for cell-target inputs. */
  readonly cell?: Readonly<CellCoord>
  /**
   * Target ranges; present only for range-target inputs. Always exactly
   * one entry (display row IS source row), kept as a list so callers that
   * already loop stay unchanged.
   */
  readonly ranges?: readonly Readonly<CellRange>[]
}

export interface BlockedContentMutation {
  readonly status: 'blocked'
  readonly kind: ContentMutationKind
  readonly sheetId: string
  readonly reason: ContentMutationBlockReason
  readonly diagnostic: SpreadsheetDiagnostic
}

export type ContentMutationResolution = AllowedContentMutation | BlockedContentMutation

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

const BLOCK_MESSAGES: Record<ContentMutationBlockReason, string> = {
  locked: 'The target cells are locked on a protected sheet.',
  'invalid-target': 'The mutation target coordinates are invalid.',
}

const BLOCK_CODES: Record<ContentMutationBlockReason, string> = {
  locked: 'MUTATION_BLOCKED_LOCKED',
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
 * validated target (allowed) or a structured blocked result. A blocked
 * resolution records itself on `contentMutationLastBlockAtom` and appends
 * a diagnostic; the caller MUST NOT launch any transport for it.
 */
export const resolveContentMutationAtom = atom(
  null,
  (get, set, input: ResolveContentMutationInput): ContentMutationResolution => {
    const enforceProtection = input.protectionGate !== false

    let sourceCell: Readonly<CellCoord> | undefined
    let sourceRanges: readonly Readonly<CellRange>[] | undefined

    if (input.cell !== undefined) {
      if (!isValidCell(input.cell)) {
        return publishBlock(set, createBlockedResolution(input, 'invalid-target'))
      }
      sourceCell = Object.freeze({ row: input.cell.row, col: input.cell.col })
    } else if (input.range !== undefined) {
      if (!isValidRange(input.range)) {
        return publishBlock(set, createBlockedResolution(input, 'invalid-target'))
      }
      sourceRanges = Object.freeze([Object.freeze({ ...input.range })])
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
    })
  },
)
resolveContentMutationAtom.debugLabel = 'spreadsheet.mutationGateway.resolve'

function publishBlock(set: Setter, blocked: BlockedContentMutation): BlockedContentMutation {
  set(contentMutationLastBlockBackingAtom, blocked)
  set(appendDiagnosticsAtom, blocked.diagnostic)
  return blocked
}
