import { atom, type Atom, type Getter, type Setter } from '@einfach/core'
import type {
  BackendMutationResult,
  OutlineProjectionResult,
  OutlinePersistenceGroup,
  ReadOutlineProjectionRequest,
  SetOutlineGroupsRequest,
} from '../backend/types'
import type { OutlineAxis, OutlineGroup } from './types'
import { outlineBackingAtom } from './index'

// --- Outline persistence port -------------------------------------------------

/**
 * Optional persistence hook for outline (grouping/collapse) metadata.
 * Absence of either method never degrades the feature — the local atom
 * keeps working; groups just don't survive a reload.
 */
export interface OutlinePersistencePort {
  readOutlineProjection?: (
    request: ReadOutlineProjectionRequest,
  ) => Promise<OutlineProjectionResult>
  setOutlineGroups?: (request: SetOutlineGroupsRequest) => Promise<BackendMutationResult>
}

// --- hydration input / outcome types ------------------------------------------

export interface HydrateOutlineInput {
  readonly sheetId: string
  readonly source: OutlinePersistencePort
}

export type HydrateOutlineOutcome = 'hydrated' | 'skipped' | 'unsupported' | 'error'

// --- diagnostic (same pattern as freeze / viewport-hidden) --------------------

export interface OutlinePersistenceDiagnostic {
  readonly kind: 'persist-failed' | 'hydrate-failed'
  readonly sheetId: string
  readonly message: string
}

const outlineDiagnosticBackingAtom = atom<OutlinePersistenceDiagnostic | null>(null)
outlineDiagnosticBackingAtom.debugLabel = 'spreadsheet.outline.diagnosticBacking'

/** Read-only projection of the last persistence-hook failure. */
export const outlineDiagnosticAtom: Atom<OutlinePersistenceDiagnostic | null> = atom((get) =>
  get(outlineDiagnosticBackingAtom),
)
outlineDiagnosticAtom.debugLabel = 'spreadsheet.outline.diagnostic'

// --- seeded-sheet guard -------------------------------------------------------

/**
 * Sheets that are locally owned: either seeded once from the persistence
 * hook or written by a local command. A late hydration result must never
 * clobber a locally owned sheet.
 */
const outlineSeededSheetsAtom = atom<ReadonlySet<string>>(new Set<string>())
outlineSeededSheetsAtom.debugLabel = 'spreadsheet.outline.seededSheets'

export function markOutlineSeeded(get: Getter, set: Setter, sheetId: string): void {
  const seeded = get(outlineSeededSheetsAtom)
  if (seeded.has(sheetId)) return
  const next = new Set(seeded)
  next.add(sheetId)
  set(outlineSeededSheetsAtom, next)
}

// --- helpers ------------------------------------------------------------------

function outlineErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown transport failure.'
}

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

function wireGroupToInternal(wire: OutlinePersistenceGroup): OutlineGroup {
  return { start: wire.start, end: wire.end, collapsed: wire.collapsed }
}

function writeSheetOutlineFromPersistence(
  get: Getter,
  set: Setter,
  sheetId: string,
  axis: OutlineAxis,
  groups: readonly OutlineGroup[],
): void {
  const state = get(outlineBackingAtom)
  const frozen = Object.freeze(groups.map((g) => Object.freeze({ ...g })))
  set(outlineBackingAtom, {
    rowsBySheet: axis === 'row' ? { ...state.rowsBySheet, [sheetId]: frozen } : state.rowsBySheet,
    colsBySheet:
      axis === 'column' ? { ...state.colsBySheet, [sheetId]: frozen } : state.colsBySheet,
  })
}

// --- persistence mirror (fire-and-forget) -------------------------------------

export function persistOutlineGroups(
  get: Getter,
  set: Setter,
  source: unknown,
  sheetId: string,
  axis: OutlineAxis,
  groups: readonly OutlineGroup[],
): void {
  if (typeof source !== 'object' || source === null) return
  const port = source as OutlinePersistencePort
  const persist = port.setOutlineGroups
  if (typeof persist !== 'function') return
  const recordFailure = (error: unknown) => {
    set(outlineDiagnosticBackingAtom, {
      kind: 'persist-failed',
      sheetId,
      message: outlineErrorMessage(error),
    })
  }
  const wireGroups: OutlinePersistenceGroup[] = groups.map((g) => ({
    start: g.start,
    end: g.end,
    collapsed: g.collapsed,
  }))
  try {
    void persist
      .call(source, {
        kind: 'set-outline-groups',
        sheetId,
        axis,
        groups: wireGroups,
      } satisfies SetOutlineGroupsRequest)
      .catch(recordFailure)
  } catch (error) {
    recordFailure(error)
  }
}

// --- hydration atom -----------------------------------------------------------

export const hydrateOutlineAtom = atom(
  null,
  async (get, set, input: HydrateOutlineInput): Promise<HydrateOutlineOutcome> => {
    const sheetId = typeof input?.sheetId === 'string' ? input.sheetId : ''
    if (!sheetId) return 'error'
    const read = input.source?.readOutlineProjection
    if (typeof read !== 'function') return 'unsupported'
    if (get(outlineSeededSheetsAtom).has(sheetId)) return 'skipped'

    let result: unknown
    try {
      result = await read.call(input.source, {
        kind: 'read-outline',
        sheetId,
      } satisfies ReadOutlineProjectionRequest)
    } catch (error) {
      if (get(outlineSeededSheetsAtom).has(sheetId)) return 'skipped'
      set(outlineDiagnosticBackingAtom, {
        kind: 'hydrate-failed',
        sheetId,
        message: outlineErrorMessage(error),
      })
      return 'error'
    }
    if (get(outlineSeededSheetsAtom).has(sheetId)) return 'skipped'

    const payload = result as Partial<OutlineProjectionResult> | null | undefined
    if (typeof payload !== 'object' || payload === null || payload.sheetId !== sheetId) {
      set(outlineDiagnosticBackingAtom, {
        kind: 'hydrate-failed',
        sheetId,
        message: 'Persistence hook returned a mismatched outline payload.',
      })
      return 'error'
    }

    const rowsAbsent = payload.rowGroups === undefined
    const colsAbsent = payload.colGroups === undefined
    if (rowsAbsent && colsAbsent) return 'unsupported'

    const rowGroups: readonly OutlineGroup[] | null =
      payload.rowGroups === undefined ? null : wireGroupsFromPayload(payload.rowGroups)
    const colGroups: readonly OutlineGroup[] | null =
      payload.colGroups === undefined ? null : wireGroupsFromPayload(payload.colGroups)

    if (
      (payload.rowGroups !== undefined && rowGroups === null) ||
      (payload.colGroups !== undefined && colGroups === null)
    ) {
      set(outlineDiagnosticBackingAtom, {
        kind: 'hydrate-failed',
        sheetId,
        message: 'Persistence hook returned invalid outline group payloads.',
      })
      return 'error'
    }

    markOutlineSeeded(get, set, sheetId)
    if (rowGroups !== null) {
      writeSheetOutlineFromPersistence(get, set, sheetId, 'row', rowGroups)
    }
    if (colGroups !== null) {
      writeSheetOutlineFromPersistence(get, set, sheetId, 'column', colGroups)
    }
    return 'hydrated'
  },
)
hydrateOutlineAtom.debugLabel = 'spreadsheet.outline.hydrate'

function wireGroupsFromPayload(raw: unknown): readonly OutlineGroup[] | null {
  if (!isGroupArray(raw)) return null
  return (raw as readonly OutlinePersistenceGroup[]).map(wireGroupToInternal)
}
