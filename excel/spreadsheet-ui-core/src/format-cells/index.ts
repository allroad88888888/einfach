import { atom } from '@einfach/core'
import type {
  FormatCellsDraft,
  FormatCellsEditorState,
  FormatCellsTabId,
  OpenFormatCellsInput,
  RunFormatCellsSaveInput,
} from './types'
import { createFormatCellsSaveController } from './number-format-dialog'

export * from './types'
export * from './number-format-dialog'

/** Deep clone a draft so mutations to the editor don't bleed into the seed. */
function cloneDraft(seed: FormatCellsDraft | undefined | null): FormatCellsDraft {
  if (!seed) return {}
  // JSON clone is sufficient: SpreadsheetCellFormat is a plain JSON shape
  // (numbers, strings, booleans, nested plain objects). No functions, no
  // class instances, no cyclic refs. Cheaper than structuredClone for the
  // hot path of every open + every patch.
  return JSON.parse(JSON.stringify(seed)) as FormatCellsDraft
}

function nextSessionId(current: number): number | null {
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) return null
  return current + 1
}

// --- Source atoms ---

const formatCellsEditorSourceAtom = atom<FormatCellsEditorState>({ status: 'closed' })
const formatCellsSessionSequenceAtom = atom(0)

export const formatCellsEditorAtom = atom((get) => get(formatCellsEditorSourceAtom))
formatCellsEditorAtom.debugLabel = 'spreadsheet.formatCells.editor'

/**
 * Derived: the current active tab id. Reads `formatCellsEditorAtom`; falls
 * back to `'number'` when the dialog is closed so consumers can read freely
 * without a status check.
 */
export const formatCellsActiveTabAtom = atom<FormatCellsTabId>((get) => {
  const state = get(formatCellsEditorAtom)
  return state.status === 'open' ? state.activeTab : 'number'
})
formatCellsActiveTabAtom.debugLabel = 'spreadsheet.formatCells.activeTab'

/**
 * Derived: the current draft format. Reads `formatCellsEditorAtom`; returns
 * `null` when the dialog is closed.
 */
export const formatCellsDraftAtom = atom<FormatCellsDraft | null>((get) => {
  const state = get(formatCellsEditorAtom)
  return state.status === 'open' ? state.draft : null
})
formatCellsDraftAtom.debugLabel = 'spreadsheet.formatCells.draft'

// --- Command atoms ---

export const openFormatCellsAtom = atom(null, (get, set, input: OpenFormatCellsInput) => {
  const draft = cloneDraft(input.initialFormat as FormatCellsDraft | null | undefined)
  const sessionId = nextSessionId(get(formatCellsSessionSequenceAtom))
  if (sessionId === null) return
  set(formatCellsSessionSequenceAtom, sessionId)
  set(formatCellsEditorSourceAtom, {
    status: 'open',
    sheetId: input.sheetId,
    range: { ...input.range },
    sessionId,
    phase: 'editing',
    requestId: null,
    pending: false,
    error: null,
    activeTab: input.initialTab ?? 'number',
    draft,
    dirty: false,
  })
})
openFormatCellsAtom.debugLabel = 'spreadsheet.formatCells.open'

export const closeFormatCellsAtom = atom(null, (_get, set) => {
  set(formatCellsEditorSourceAtom, { status: 'closed' })
})
closeFormatCellsAtom.debugLabel = 'spreadsheet.formatCells.close'

/**
 * Switch the active tab without touching the draft. Switching is a no-op when
 * the dialog is closed; that path is unreachable from the dialog UI but the
 * guard keeps the atom safe for keyboard shortcuts dispatched from outside.
 */
export const setFormatCellsActiveTabAtom = atom(null, (get, set, tab: FormatCellsTabId) => {
  const state = get(formatCellsEditorSourceAtom)
  if (state.status !== 'open' || state.pending || state.phase === 'outcome-unknown-blocked') return
  if (state.activeTab === tab) return
  set(formatCellsEditorSourceAtom, { ...state, activeTab: tab, phase: 'editing', error: null })
})
setFormatCellsActiveTabAtom.debugLabel = 'spreadsheet.formatCells.setActiveTab'

/**
 * Shallow-merge a partial draft into the open editor's draft. The dialog
 * passes user edits through this single command so the dirty flag and the
 * draft stay in lockstep.
 */
export const patchFormatCellsDraftAtom = atom(
  null,
  (get, set, patch: Partial<FormatCellsDraft>) => {
    const state = get(formatCellsEditorSourceAtom)
    if (state.status !== 'open' || state.pending || state.phase === 'outcome-unknown-blocked')
      return
    set(formatCellsEditorSourceAtom, {
      ...state,
      phase: 'editing',
      error: null,
      draft: { ...state.draft, ...patch },
      dirty: true,
    })
  },
)
patchFormatCellsDraftAtom.debugLabel = 'spreadsheet.formatCells.patchDraft'

/** Compatibility read model. Mutation orchestration belongs to `runFormatCellsSaveAtom`. */
export const formatCellsSavePayloadAtom = atom((get) => {
  const state = get(formatCellsEditorSourceAtom)
  if (state.status !== 'open') return null
  return {
    sheetId: state.sheetId,
    range: state.range,
    format: state.draft,
  }
})
formatCellsSavePayloadAtom.debugLabel = 'spreadsheet.formatCells.savePayload'

const formatCellsSaveController = createFormatCellsSaveController(
  'format-cells',
  formatCellsEditorSourceAtom,
  (state) => state.draft,
)

export const formatCellsSaveLedgerAtom = formatCellsSaveController.ledgerAtom
formatCellsSaveLedgerAtom.debugLabel = 'spreadsheet.formatCells.saveLedger'
export const formatCellsSaveBlockedAtom = formatCellsSaveController.blockedAtom
formatCellsSaveBlockedAtom.debugLabel = 'spreadsheet.formatCells.saveBlocked'
export const runFormatCellsSaveAtom = formatCellsSaveController.runAtom
runFormatCellsSaveAtom.debugLabel = 'spreadsheet.formatCells.runSave'

/** Compatibility command now delegates to the Core-owned guarded lifecycle. */
export const saveFormatCellsAtom = atom(null, (_get, set, input?: RunFormatCellsSaveInput) =>
  set(runFormatCellsSaveAtom, input),
)
saveFormatCellsAtom.debugLabel = 'spreadsheet.formatCells.save'
