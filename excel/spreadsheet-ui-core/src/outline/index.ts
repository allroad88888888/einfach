import { atom, type Atom, type Getter, type Setter } from '@einfach/core'
import type { BackendStructuralShift } from '../backend/types'
import {
  nextHistoryTransactionId,
  pushHistoryAtom,
  registerHistoryLocalReplayApplier,
} from '../history'
import { selectionRegionsAtom, selectionSnapshotAtom } from '../selection'
import {
  applyViewportHiddenReplaySnapshot,
  getHiddenColumnsForSheet,
  getHiddenRowsForSheet,
  viewportHiddenAtom,
  type ViewportHiddenReplaySnapshot,
} from '../viewport/hidden'
import { remapRangeAfterStructuralShift } from '../viewport/structural-remap'
import type {
  CollapseOutlineToLevelInput,
  OutlineAxis,
  OutlineAxisRangeInput,
  OutlineCommandOutcome,
  OutlineGroup,
  OutlineGroupWithLevel,
  OutlineSelectionCommandInput,
  OutlineState,
  ToggleOutlineGroupCollapsedInput,
} from './types'

export * from './types'

// Outline (grouping / collapse) is UI-core canonical (#07, CANONICAL_OWNERSHIP
// §7-2): group metadata never participates in evaluation, so the per-sheet
// group lists below are the source of truth. Collapse visibility writes the
// hidden rows/columns canonical sets — collapsing hides the newly covered
// indices, expanding unhides them — so the grid needs no second visibility
// source.
//
// Outline shares that STATE with viewport/hidden but owns its own history
// path: the `OUTLINE_REPLAY_KEY` applier at the bottom of this file replays
// both the group list and the hidden slice itself, calling the hidden
// module's exported `applyViewportHiddenReplaySnapshot` write primitive.
// It deliberately does NOT reach into the applier registry for
// `VIEWPORT_HIDDEN_REPLAY_KEY`. That lookup is nullable and its result was
// ignored, so once the hidden canonical set sinks into the engine and that
// registration goes away, collapse undo would have become a SILENT no-op —
// a failure no hide/unhide or filter test can observe, because none of them
// exercise outline. A static import instead makes that removal a compile
// error here. See test/outline.test.ts "sink-down rehearsal".
//
// TODO(outline persistence): no backend persistence port is defined yet. When
// a host wants durable outlines, add optional `readOutlineProjection` /
// `setOutlineGroups` ports next to the hidden persistence hook and hydrate
// once per sheet, exactly like `hydrateViewportHiddenAtom`.

/** Excel-aligned nesting depth cap (outline levels 1..8). */
export const OUTLINE_MAX_DEPTH = 8

/** Bounded metadata: at most this many groups per sheet per axis. */
export const OUTLINE_MAX_GROUPS_PER_SHEET_AXIS = 200

/** History local-replay applier key for outline metadata entries. */
export const OUTLINE_REPLAY_KEY = 'outline'

/** Session-local revision label for local-replay outline history entries. */
const OUTLINE_LOCAL_REVISION = 'local'

export const DEFAULT_OUTLINE_STATE: OutlineState = {
  rowsBySheet: {},
  colsBySheet: {},
}

/** Snapshot shape carried by outline local-replay and structural side payloads. */
export interface OutlineReplaySnapshot {
  readonly rows?: readonly OutlineGroup[]
  readonly cols?: readonly OutlineGroup[]
  /**
   * Present only when the recorded transition also moved the hidden
   * canonical sets (collapse / expand). Replayed by the outline applier
   * itself, so one user gesture stays one history entry.
   */
  readonly hidden?: ViewportHiddenReplaySnapshot
}

function groupContains(
  outer: OutlineGroup,
  outerIndex: number,
  inner: OutlineGroup,
  innerIndex: number,
): boolean {
  if (outer.start === inner.start && outer.end === inner.end) return outerIndex < innerIndex
  return outer.start <= inner.start && inner.end <= outer.end
}

function overlapsWithoutNesting(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  if (aEnd < bStart || bEnd < aStart) return false
  const aContainsB = aStart <= bStart && bEnd <= aEnd
  const bContainsA = bStart <= aStart && aEnd <= bEnd
  return !aContainsB && !bContainsA
}

function sortGroups(groups: readonly OutlineGroup[]): OutlineGroup[] {
  // Outer-before-inner for nested ranges; identical ranges keep insertion
  // order (stable sort), which is the outer/inner tie-break for duplicates.
  return [...groups].sort((left, right) => left.start - right.start || right.end - left.end)
}

/** Derives 1-based nesting levels from containment. Identical ranges nest by list order. */
export function computeOutlineLevels(
  groups: readonly OutlineGroup[],
): readonly OutlineGroupWithLevel[] {
  return groups.map((group, index) => ({
    ...group,
    level:
      1 +
      groups.filter(
        (other, otherIndex) =>
          otherIndex !== index && groupContains(other, otherIndex, group, index),
      ).length,
  }))
}

export function getOutlineGroupsForSheet(
  state: OutlineState,
  sheetId: string,
  axis: OutlineAxis,
): readonly OutlineGroup[] {
  const bySheet = axis === 'row' ? state.rowsBySheet : state.colsBySheet
  return bySheet[sheetId] ?? []
}

export function getOutlineLeveledGroupsForSheet(
  state: OutlineState,
  sheetId: string,
  axis: OutlineAxis,
): readonly OutlineGroupWithLevel[] {
  return computeOutlineLevels(getOutlineGroupsForSheet(state, sheetId, axis))
}

export function getOutlineMaxLevelForSheet(
  state: OutlineState,
  sheetId: string,
  axis: OutlineAxis,
): number {
  return getOutlineLeveledGroupsForSheet(state, sheetId, axis).reduce(
    (max, group) => Math.max(max, group.level),
    0,
  )
}

/** Union of the index ranges covered by collapsed groups. Sorted ascending. */
export function computeCollapsedOutlineIndices(groups: readonly OutlineGroup[]): number[] {
  const indices = new Set<number>()
  for (const group of groups) {
    if (!group.collapsed) continue
    for (let index = group.start; index <= group.end; index += 1) indices.add(index)
  }
  return [...indices].sort((left, right) => left - right)
}

const outlineBackingAtom = atom<OutlineState>(DEFAULT_OUTLINE_STATE)
outlineBackingAtom.debugLabel = 'spreadsheet.outline.stateBacking'

/** Read-only projection of the UI-core canonical outline metadata. Mutate via commands. */
export const outlineAtom: Atom<OutlineState> = atom((get) => get(outlineBackingAtom))
outlineAtom.debugLabel = 'spreadsheet.outline.state'

function writeSheetOutline(
  set: Setter,
  state: OutlineState,
  sheetId: string,
  axis: OutlineAxis,
  groups: readonly OutlineGroup[],
) {
  const frozen = Object.freeze(groups.map((group) => Object.freeze({ ...group })))
  set(outlineBackingAtom, {
    rowsBySheet:
      axis === 'row' ? { ...state.rowsBySheet, [sheetId]: frozen } : state.rowsBySheet,
    colsBySheet:
      axis === 'column' ? { ...state.colsBySheet, [sheetId]: frozen } : state.colsBySheet,
  })
}

function sameGroups(left: readonly OutlineGroup[], right: readonly OutlineGroup[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (group, index) =>
        group.start === right[index].start &&
        group.end === right[index].end &&
        group.collapsed === right[index].collapsed,
    )
  )
}

function sameIndices(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isValidAxis(value: unknown): value is OutlineAxis {
  return value === 'row' || value === 'column'
}

function isValidRangeInput(input: OutlineAxisRangeInput | undefined | null): boolean {
  return (
    typeof input?.sheetId === 'string' &&
    input.sheetId.length > 0 &&
    isValidAxis(input.axis) &&
    Number.isSafeInteger(input.start) &&
    Number.isSafeInteger(input.end) &&
    input.start >= 0 &&
    input.end >= input.start
  )
}

interface OutlineHiddenTransition {
  readonly before: readonly number[]
  readonly after: readonly number[]
}

function getHiddenForAxis(get: Getter, sheetId: string, axis: OutlineAxis): readonly number[] {
  const hidden = get(viewportHiddenAtom)
  return axis === 'row'
    ? getHiddenRowsForSheet(hidden, sheetId)
    : getHiddenColumnsForSheet(hidden, sheetId)
}

/**
 * Collapse/expand visibility delta: hide indices newly covered by a
 * collapsed group, unhide indices no collapsed group covers any more.
 * Manually hidden indices outside outline control are preserved.
 */
function computeOutlineHiddenTransition(
  get: Getter,
  sheetId: string,
  axis: OutlineAxis,
  groupsBefore: readonly OutlineGroup[],
  groupsAfter: readonly OutlineGroup[],
): OutlineHiddenTransition | null {
  const unionBefore = new Set(computeCollapsedOutlineIndices(groupsBefore))
  const unionAfter = new Set(computeCollapsedOutlineIndices(groupsAfter))
  const current = getHiddenForAxis(get, sheetId, axis)
  const next = new Set(current)
  for (const index of unionBefore) {
    if (!unionAfter.has(index)) next.delete(index)
  }
  for (const index of unionAfter) {
    if (!unionBefore.has(index)) next.add(index)
  }
  const after = [...next].sort((left, right) => left - right)
  if (sameIndices(current, after)) return null
  return { before: [...current], after }
}

function hiddenSnapshotForAxis(
  axis: OutlineAxis,
  indices: readonly number[],
): ViewportHiddenReplaySnapshot {
  return axis === 'row'
    ? Object.freeze({ rows: Object.freeze([...indices]) })
    : Object.freeze({ cols: Object.freeze([...indices]) })
}

/**
 * Applies a collapse/expand visibility transition. Outline owns this call:
 * it writes the hidden canonical set through the hidden module's exported
 * write primitive rather than through that module's registered history
 * applier, so the two features share STATE but not a history code path.
 * The command and its replay below both funnel through here, so the
 * optional persistence mirror fires identically in either direction.
 */
function applyOutlineHiddenTransition(
  get: Getter,
  set: Setter,
  sheetId: string,
  axis: OutlineAxis,
  transition: OutlineHiddenTransition,
  source: unknown,
): void {
  applyViewportHiddenReplaySnapshot(
    get,
    set,
    sheetId,
    hiddenSnapshotForAxis(axis, transition.after),
    source,
  )
}

function outlineSnapshot(
  axis: OutlineAxis,
  groups: readonly OutlineGroup[],
  hidden?: readonly number[],
): OutlineReplaySnapshot {
  return Object.freeze({
    ...(axis === 'row'
      ? { rows: Object.freeze(groups.map((group) => Object.freeze({ ...group }))) }
      : { cols: Object.freeze(groups.map((group) => Object.freeze({ ...group }))) }),
    ...(hidden !== undefined ? { hidden: hiddenSnapshotForAxis(axis, hidden) } : {}),
  })
}

function pushOutlineHistoryEntry(
  set: Setter,
  sheetId: string,
  before: OutlineReplaySnapshot,
  after: OutlineReplaySnapshot,
): void {
  set(pushHistoryAtom, {
    transactionId: nextHistoryTransactionId('outline'),
    kind: 'outline',
    sheetId,
    projectionRevision: OUTLINE_LOCAL_REVISION,
    localReplay: {
      applyKey: OUTLINE_REPLAY_KEY,
      sheetId,
      before,
      after,
    },
  })
}

function commitOutlineTransition(
  get: Getter,
  set: Setter,
  sheetId: string,
  axis: OutlineAxis,
  groupsBefore: readonly OutlineGroup[],
  groupsAfter: readonly OutlineGroup[],
  withHiddenSync: boolean,
  source: unknown,
): OutlineCommandOutcome {
  const transition = withHiddenSync
    ? computeOutlineHiddenTransition(get, sheetId, axis, groupsBefore, groupsAfter)
    : null
  if (sameGroups(groupsBefore, groupsAfter) && transition === null) return 'unchanged'

  writeSheetOutline(set, get(outlineBackingAtom), sheetId, axis, groupsAfter)
  if (transition !== null) {
    applyOutlineHiddenTransition(get, set, sheetId, axis, transition, source)
  }
  pushOutlineHistoryEntry(
    set,
    sheetId,
    outlineSnapshot(axis, groupsBefore, transition?.before),
    outlineSnapshot(axis, groupsAfter, transition?.after),
  )
  return 'committed'
}

function runAddOutlineGroup(
  get: Getter,
  set: Setter,
  input: OutlineAxisRangeInput & { source?: unknown },
): OutlineCommandOutcome {
  if (!isValidRangeInput(input)) return 'invalid'
  const { sheetId, axis, start, end } = input
  const current = getOutlineGroupsForSheet(get(outlineBackingAtom), sheetId, axis)
  if (current.length >= OUTLINE_MAX_GROUPS_PER_SHEET_AXIS) return 'invalid'
  if (current.some((group) => overlapsWithoutNesting(group.start, group.end, start, end))) {
    return 'invalid'
  }
  const next = sortGroups([...current, { start, end, collapsed: false }])
  if (computeOutlineLevels(next).some((group) => group.level > OUTLINE_MAX_DEPTH)) {
    return 'invalid'
  }
  return commitOutlineTransition(get, set, sheetId, axis, current, next, false, input.source)
}

function runUngroupOutlineRange(
  get: Getter,
  set: Setter,
  input: OutlineAxisRangeInput & { source?: unknown },
): OutlineCommandOutcome {
  if (!isValidRangeInput(input)) return 'invalid'
  const { sheetId, axis, start, end } = input
  const current = getOutlineGroupsForSheet(get(outlineBackingAtom), sheetId, axis)
  const candidateIndices = current
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => group.start >= start && group.end <= end)
  if (candidateIndices.length === 0) return 'unchanged'
  // One level per gesture (Excel ungroup): only the innermost candidates —
  // those containing no other candidate — are removed; repeating the
  // gesture peels the next level.
  const removed = new Set(
    candidateIndices
      .filter(
        ({ group, index }) =>
          !candidateIndices.some(
            ({ group: other, index: otherIndex }) =>
              otherIndex !== index && groupContains(group, index, other, otherIndex),
          ),
      )
      .map(({ index }) => index),
  )
  // Excel semantics: ungrouping a collapsed group leaves its rows/columns
  // hidden — they become plain manually-hidden indices. No hidden sync here.
  const next = current.filter((_, index) => !removed.has(index))
  return commitOutlineTransition(get, set, sheetId, axis, current, next, false, input.source)
}

/** Command: add one grouping level over an explicit axis range. */
export const addOutlineGroupAtom = atom(
  null,
  (get, set, input: OutlineAxisRangeInput & { source?: unknown }): OutlineCommandOutcome =>
    runAddOutlineGroup(get, set, input),
)
addOutlineGroupAtom.debugLabel = 'spreadsheet.outline.addGroup'

/** Command: remove the innermost grouping level(s) fully inside an explicit axis range. */
export const ungroupOutlineRangeAtom = atom(
  null,
  (get, set, input: OutlineAxisRangeInput & { source?: unknown }): OutlineCommandOutcome =>
    runUngroupOutlineRange(get, set, input),
)
ungroupOutlineRangeAtom.debugLabel = 'spreadsheet.outline.ungroupRange'

/**
 * Resolves the current single-region selection to an axis span for the
 * group/ungroup selection commands, or null when the selection cannot
 * host the command (no sheet, multi-region).
 */
export function resolveOutlineSelectionRange(
  get: Getter,
  axis: OutlineAxis,
): { sheetId: string; start: number; end: number } | null {
  if (!isValidAxis(axis)) return null
  const regions = get(selectionRegionsAtom)
  const snapshot = get(selectionSnapshotAtom)
  const sheetId = snapshot.selection.sheetId
  if (regions.length !== 1 || !sheetId || regions[0]?.sheetId !== sheetId) return null
  const start = axis === 'row' ? snapshot.range.rowStart : snapshot.range.colStart
  const end = axis === 'row' ? snapshot.range.rowEnd : snapshot.range.colEnd
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return null
  }
  return { sheetId, start, end }
}

/** Command: group the selected rows/columns (adds one nesting level). */
export const groupSelectionAtom = atom(
  null,
  (get, set, input: OutlineSelectionCommandInput): OutlineCommandOutcome => {
    const resolved = resolveOutlineSelectionRange(get, input?.axis)
    if (resolved === null) return 'invalid'
    return runAddOutlineGroup(get, set, {
      sheetId: resolved.sheetId,
      axis: input.axis,
      start: resolved.start,
      end: resolved.end,
      source: input.source,
    })
  },
)
groupSelectionAtom.debugLabel = 'spreadsheet.outline.groupSelection'

/** Command: ungroup the selected rows/columns (removes the innermost level). */
export const ungroupSelectionAtom = atom(
  null,
  (get, set, input: OutlineSelectionCommandInput): OutlineCommandOutcome => {
    const resolved = resolveOutlineSelectionRange(get, input?.axis)
    if (resolved === null) return 'invalid'
    return runUngroupOutlineRange(get, set, {
      sheetId: resolved.sheetId,
      axis: input.axis,
      start: resolved.start,
      end: resolved.end,
      source: input.source,
    })
  },
)
ungroupSelectionAtom.debugLabel = 'spreadsheet.outline.ungroupSelection'

/** Command: toggle one group's collapsed flag and sync the hidden canonical set. */
export const toggleOutlineGroupCollapsedAtom = atom(
  null,
  (get, set, input: ToggleOutlineGroupCollapsedInput): OutlineCommandOutcome => {
    if (!isValidRangeInput(input)) return 'invalid'
    const { sheetId, axis, start, end } = input
    const current = getOutlineGroupsForSheet(get(outlineBackingAtom), sheetId, axis)
    const leveled = computeOutlineLevels(current)
    const matchIndex = leveled.findIndex(
      (group) =>
        group.start === start &&
        group.end === end &&
        (input.level === undefined || group.level === input.level),
    )
    if (matchIndex === -1) return 'invalid'
    const next = current.map((group, index) =>
      index === matchIndex ? { ...group, collapsed: !group.collapsed } : group,
    )
    return commitOutlineTransition(get, set, sheetId, axis, current, next, true, input.source)
  },
)
toggleOutlineGroupCollapsedAtom.debugLabel = 'spreadsheet.outline.toggleGroupCollapsed'

/**
 * Command: Excel outline level buttons. Collapses every group at derived
 * level >= `level`, expands shallower groups; `maxLevel + 1` expands all.
 */
export const collapseOutlineToLevelAtom = atom(
  null,
  (get, set, input: CollapseOutlineToLevelInput): OutlineCommandOutcome => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    if (
      !sheetId ||
      !isValidAxis(input?.axis) ||
      !Number.isSafeInteger(input.level) ||
      input.level < 1 ||
      input.level > OUTLINE_MAX_DEPTH + 1
    ) {
      return 'invalid'
    }
    const current = getOutlineGroupsForSheet(get(outlineBackingAtom), sheetId, input.axis)
    if (current.length === 0) return 'unchanged'
    const leveled = computeOutlineLevels(current)
    const next = current.map((group, index) => ({
      ...group,
      collapsed: leveled[index].level >= input.level,
    }))
    return commitOutlineTransition(
      get,
      set,
      sheetId,
      input.axis,
      current,
      next,
      true,
      input.source,
    )
  },
)
collapseOutlineToLevelAtom.debugLabel = 'spreadsheet.outline.collapseToLevel'

export interface ApplyOutlineStructuralShiftInput {
  readonly sheetId: string
  readonly shift: BackendStructuralShift
}

/**
 * Command: consume a `BackendMutationResult.structuralShift` so outline
 * intervals move with inserted/deleted rows/columns. Groups whose whole
 * extent is deleted drop out. Part of the enclosing structural operation —
 * records no history entry of its own (the operation snapshots outline
 * state into its `localSidePayloads`). Returns true when a list changed.
 */
export const applyOutlineStructuralShiftAtom = atom(
  null,
  (get, set, input: ApplyOutlineStructuralShiftInput): boolean => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    const shift = input?.shift
    if (
      !sheetId ||
      typeof shift !== 'object' ||
      shift === null ||
      (shift.axis !== 'row' && shift.axis !== 'column') ||
      (shift.kind !== 'insert' && shift.kind !== 'delete')
    ) {
      return false
    }
    const axis: OutlineAxis = shift.axis
    const state = get(outlineBackingAtom)
    const current = getOutlineGroupsForSheet(state, sheetId, axis)
    if (current.length === 0) return false
    const remapped: OutlineGroup[] = []
    for (const group of current) {
      const range =
        axis === 'row'
          ? { rowStart: group.start, rowEnd: group.end, colStart: 0, colEnd: 0 }
          : { rowStart: 0, rowEnd: 0, colStart: group.start, colEnd: group.end }
      const next = remapRangeAfterStructuralShift(range, shift)
      if (next === null) continue
      remapped.push({
        start: axis === 'row' ? next.rowStart : next.colStart,
        end: axis === 'row' ? next.rowEnd : next.colEnd,
        collapsed: group.collapsed,
      })
    }
    const sorted = sortGroups(remapped)
    if (sameGroups(current, sorted)) return false
    writeSheetOutline(set, state, sheetId, axis, sorted)
    return true
  },
)
applyOutlineStructuralShiftAtom.debugLabel = 'spreadsheet.outline.applyStructuralShift'

function isGroupArray(value: unknown): value is readonly OutlineGroup[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        Number.isSafeInteger((entry as OutlineGroup).start) &&
        Number.isSafeInteger((entry as OutlineGroup).end) &&
        (entry as OutlineGroup).start >= 0 &&
        (entry as OutlineGroup).end >= (entry as OutlineGroup).start &&
        typeof (entry as OutlineGroup).collapsed === 'boolean',
    )
  )
}

function snapshotOutlineReplayTarget(value: unknown): OutlineReplaySnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const { rows, cols } = value as { rows?: unknown; cols?: unknown }
  if (rows === undefined && cols === undefined) return null
  if (rows !== undefined && !isGroupArray(rows)) return null
  if (cols !== undefined && !isGroupArray(cols)) return null
  return {
    ...(rows !== undefined ? { rows } : {}),
    ...(cols !== undefined ? { cols } : {}),
  }
}

function replayHiddenPayload(value: unknown): ViewportHiddenReplaySnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const { hidden } = value as { hidden?: unknown }
  if (typeof hidden !== 'object' || hidden === null) return null
  return hidden as ViewportHiddenReplaySnapshot
}

registerHistoryLocalReplayApplier(
  OUTLINE_REPLAY_KEY,
  (get, set, payload, direction, source) => {
    const sheetId = typeof payload.sheetId === 'string' ? payload.sheetId : ''
    if (!sheetId) return false
    const target = snapshotOutlineReplayTarget(
      direction === 'undo' ? payload.before : payload.after,
    )
    if (target === null) return false

    if (target.rows !== undefined) {
      writeSheetOutline(set, get(outlineBackingAtom), sheetId, 'row', target.rows)
    }
    if (target.cols !== undefined) {
      writeSheetOutline(set, get(outlineBackingAtom), sheetId, 'column', target.cols)
    }

    // Collapse/expand entries carry the exact hidden transition; outline
    // writes it itself so both facts replay atomically within this single
    // history entry. Both sides must be present — a half-recorded
    // transition is not replayable in either direction.
    const hiddenBefore = replayHiddenPayload(payload.before)
    const hiddenAfter = replayHiddenPayload(payload.after)
    if (hiddenBefore !== null && hiddenAfter !== null) {
      applyViewportHiddenReplaySnapshot(
        get,
        set,
        sheetId,
        direction === 'undo' ? hiddenBefore : hiddenAfter,
        source,
      )
    }
    return true
  },
)
