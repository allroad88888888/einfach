import { atom, type Atom } from '@einfach/core'
import type { BackendStructuralShift } from '../backend/types'
import { registerHistoryLocalReplayApplier } from '../history'
import { viewportHiddenAtom } from './hidden'
import { remapIndexSetAfterStructuralShift } from './structural-remap'
import type { ViewportFilterHiddenState, ViewportHiddenState } from './types'

// Two hidden-row sets, one union view.
//
// `viewportHiddenAtom` (viewport/hidden.ts) holds MANUAL hide/unhide — a user
// command with its own history entries. `viewportFilterHiddenAtom` below holds
// FILTER-hidden rows — a derived consequence of the active filter rules, whole-
// set replaced whenever those rules change, with no history entry of its own.
//
// They stay separate because three rules cannot be expressed on a merged set:
//   1. SUBTOTAL 1-11 excludes filter-hidden rows but INCLUDES manual-hidden ones
//      (101-111 excludes both).
//   2. Copy skips filter-hidden rows but copies manual-hidden ones.
//   3. `Unhide Rows` over a filtered region must not cancel the filter.
//
// `effectiveHiddenAtom` is the union, and is ONLY for "is this row painted?"
// questions — rendering, `Go To Special → Visible cells only`, window
// expansion. Any consumer that must distinguish the origin reads the two
// source atoms instead.
//
// Slice S3 ships the shape with an always-empty filter set: the population
// path (`SetFilterSortResult.hiddenRowIndices` → `filterHiddenAtom`) lands in
// S4. Until then every derivation here degrades to exactly the manual set,
// which is why S3 is behaviour-neutral by construction.

export const DEFAULT_VIEWPORT_FILTER_HIDDEN_STATE: ViewportFilterHiddenState = {
  rowsBySheet: {},
}

/** Whole-set replacement payload for one sheet's filter-hidden rows. */
export interface SetViewportFilterHiddenRowsInput {
  readonly sheetId: string
  /** 0-based SOURCE rows the active rules filtered out. Empty clears the sheet. */
  readonly rows: readonly number[]
}

function sanitizeRows(rows: readonly number[]): number[] {
  const seen = new Set<number>()
  const result: number[] = []
  for (const value of rows) {
    if (Number.isSafeInteger(value) && value >= 0 && !seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }
  result.sort((left, right) => left - right)
  return result
}

function sameRows(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, offset) => value === right[offset])
}

const viewportFilterHiddenBackingAtom = atom<ViewportFilterHiddenState>(
  DEFAULT_VIEWPORT_FILTER_HIDDEN_STATE,
)
viewportFilterHiddenBackingAtom.debugLabel = 'spreadsheet.viewport.filterHiddenBacking'

/** Read-only projection of the filter-hidden row sets. Mutate via the commands below. */
export const viewportFilterHiddenAtom: Atom<ViewportFilterHiddenState> = atom((get) =>
  get(viewportFilterHiddenBackingAtom),
)
viewportFilterHiddenAtom.debugLabel = 'spreadsheet.viewport.filterHidden'

/**
 * Command: replace one sheet's filter-hidden row set outright. Returns true
 * when the stored set actually changed. Whole-set replace (never a delta) —
 * the filter rules are the authority and always produce a complete answer.
 */
export const setViewportFilterHiddenRowsAtom = atom(
  null,
  (get, set, input: SetViewportFilterHiddenRowsInput): boolean => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    if (!sheetId || !Array.isArray(input?.rows)) return false
    const next = sanitizeRows(input.rows)
    const state = get(viewportFilterHiddenBackingAtom)
    const current = state.rowsBySheet[sheetId] ?? []
    if (sameRows(current, next)) return false
    if (next.length === 0) {
      const rowsBySheet = { ...state.rowsBySheet }
      delete rowsBySheet[sheetId]
      set(viewportFilterHiddenBackingAtom, { rowsBySheet })
      return true
    }
    set(viewportFilterHiddenBackingAtom, {
      rowsBySheet: { ...state.rowsBySheet, [sheetId]: next },
    })
    return true
  },
)
setViewportFilterHiddenRowsAtom.debugLabel = 'spreadsheet.viewport.setFilterHiddenRows'

/** Command: drop one sheet's filter-hidden rows (filter cleared). */
export const clearViewportFilterHiddenRowsAtom = atom(
  null,
  (get, set, sheetId: string): boolean =>
    set(setViewportFilterHiddenRowsAtom, { sheetId, rows: [] }),
)
clearViewportFilterHiddenRowsAtom.debugLabel = 'spreadsheet.viewport.clearFilterHiddenRows'

/** History local-replay applier key for the filter-hidden row set. */
export const VIEWPORT_FILTER_HIDDEN_REPLAY_KEY = 'viewport.filterHidden'

/** Snapshot shape carried by filter-hidden structural side payloads. */
export interface ViewportFilterHiddenReplaySnapshot {
  readonly rows: readonly number[]
}

export interface ApplyViewportFilterHiddenStructuralShiftInput {
  readonly sheetId: string
  readonly shift: BackendStructuralShift
}

/**
 * Command: consume a `BackendMutationResult.structuralShift` so the
 * filter-hidden row set moves with inserted/deleted rows — the exact twin of
 * `applyViewportHiddenStructuralShiftAtom` (viewport/hidden.ts), and for the
 * same reason: `shift.index` / `shift.count` are stated in PRE-mutation
 * coordinates, so the stored set (also pre-mutation) is remapped by the same
 * pure helper both sets share. Rows inside a deleted band drop out.
 *
 * Why the filter set needs this at all: before the S5 flip the projection
 * recomputed filter visibility on every revision bump, so a structural edit
 * self-corrected. After the flip the set is a SNAPSHOT (design §4.3), so an
 * insert/delete during an active filter would leave every recorded index
 * pointing one band off — hiding a row the filter never judged and revealing
 * one it did.
 *
 * Rows only: the set is a row set, so a COLUMN shift displaces nothing in it
 * and is inert here. (The manual twin holds both axes and therefore branches.)
 *
 * Part of the enclosing structural operation — records no history entry of its
 * own; the caller carries the pre/post snapshots as a side payload. Returns
 * true when the stored set actually changed.
 */
export const applyViewportFilterHiddenStructuralShiftAtom = atom(
  null,
  (get, set, input: ApplyViewportFilterHiddenStructuralShiftInput): boolean => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    const shift = input?.shift
    if (
      !sheetId ||
      typeof shift !== 'object' ||
      shift === null ||
      shift.axis !== 'row' ||
      (shift.kind !== 'insert' && shift.kind !== 'delete')
    ) {
      return false
    }
    const state = get(viewportFilterHiddenBackingAtom)
    const current = state.rowsBySheet[sheetId] ?? []
    if (current.length === 0) return false
    const remapped = sanitizeRows([...remapIndexSetAfterStructuralShift(new Set(current), shift)])
    if (sameRows(current, remapped)) return false
    // Route through the whole-set command so the "empty clears the sheet"
    // invariant stays in exactly one place.
    return set(setViewportFilterHiddenRowsAtom, { sheetId, rows: remapped })
  },
)
applyViewportFilterHiddenStructuralShiftAtom.debugLabel =
  'spreadsheet.viewport.applyFilterHiddenShift'

/**
 * Local replay for the structural side payload above. Undoing a delete cannot
 * re-derive which rows the filter had hidden inside the deleted band (the
 * rules are not re-run — the set is a snapshot), so undo/redo restores the
 * exact recorded set instead, the same way the manual twin does.
 */
registerHistoryLocalReplayApplier(
  VIEWPORT_FILTER_HIDDEN_REPLAY_KEY,
  (_get, set, payload, direction) => {
    const sheetId = typeof payload.sheetId === 'string' ? payload.sheetId : ''
    if (!sheetId) return false
    const target = direction === 'undo' ? payload.before : payload.after
    if (typeof target !== 'object' || target === null) return false
    const { rows } = target as { rows?: unknown }
    if (!Array.isArray(rows) || rows.some((row) => !Number.isSafeInteger(row) || row < 0)) {
      return false
    }
    set(setViewportFilterHiddenRowsAtom, { sheetId, rows: rows as number[] })
    return true
  },
)

export function getFilterHiddenRowsForSheet(
  state: ViewportFilterHiddenState,
  sheetId: string,
): number[] {
  return state.rowsBySheet[sheetId] ?? []
}

export function isRowFilterHidden(
  state: ViewportFilterHiddenState,
  sheetId: string,
  rowIndex: number,
): boolean {
  return (state.rowsBySheet[sheetId] ?? []).includes(rowIndex)
}

/**
 * Pure union of one sheet's manual and filter hidden rows, ascending and
 * de-duplicated. Returns the manual array by reference when the filter set is
 * empty so callers keep referential stability in the (currently universal)
 * degenerate case.
 */
export function unionHiddenRowsForSheet(
  manual: ViewportHiddenState,
  filter: ViewportFilterHiddenState,
  sheetId: string,
): number[] {
  const manualRows = manual.rowsBySheet[sheetId] ?? []
  const filterRows = filter.rowsBySheet[sheetId] ?? []
  if (filterRows.length === 0) return manualRows
  if (manualRows.length === 0) return filterRows
  const merged = new Set(manualRows)
  for (const row of filterRows) merged.add(row)
  return [...merged].sort((left, right) => left - right)
}

/**
 * Derived: manual ∪ filter hidden rows, in the same shape as
 * {@link viewportHiddenAtom} so it is a drop-in swap for visibility
 * consumers. Columns pass through untouched — filtering hides rows only.
 *
 * VISIBILITY SEMANTICS ONLY. Do not read this for SUBTOTAL pushes, copy, or
 * anything else that must tell the two origins apart (see the file header).
 *
 * Returns the manual state object itself when no sheet has filter-hidden
 * rows, so downstream derivations do not re-fire while the filter set is
 * empty.
 */
export const effectiveHiddenAtom: Atom<ViewportHiddenState> = atom((get) => {
  const manual = get(viewportHiddenAtom)
  const filter = get(viewportFilterHiddenAtom)
  const filterSheetIds = Object.keys(filter.rowsBySheet)
  if (filterSheetIds.length === 0) return manual
  const rowsBySheet: Record<string, number[]> = { ...manual.rowsBySheet }
  for (const sheetId of filterSheetIds) {
    rowsBySheet[sheetId] = unionHiddenRowsForSheet(manual, filter, sheetId)
  }
  return { rowsBySheet, colsBySheet: manual.colsBySheet }
})
effectiveHiddenAtom.debugLabel = 'spreadsheet.viewport.effectiveHidden'
