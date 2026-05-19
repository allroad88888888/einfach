import { atom } from '@einfach/core'
import type {
  FormatCellsDraft,
  FormatCellsEditorState,
  FormatCellsTabId,
  OpenFormatCellsInput,
} from './types'

export * from './types'

/** Deep clone a draft so mutations to the editor don't bleed into the seed. */
function cloneDraft(seed: FormatCellsDraft | undefined | null): FormatCellsDraft {
  if (!seed) return {}
  // JSON clone is sufficient: SpreadsheetCellFormat is a plain JSON shape
  // (numbers, strings, booleans, nested plain objects). No functions, no
  // class instances, no cyclic refs. Cheaper than structuredClone for the
  // hot path of every open + every patch.
  return JSON.parse(JSON.stringify(seed)) as FormatCellsDraft
}

// --- Source atoms ---

export const formatCellsEditorAtom = atom<FormatCellsEditorState>({ status: 'closed' })
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

export const openFormatCellsAtom = atom(
  null,
  (_get, set, input: OpenFormatCellsInput) => {
    const draft = cloneDraft(input.initialFormat as FormatCellsDraft | null | undefined)
    set(formatCellsEditorAtom, {
      status: 'open',
      sheetId: input.sheetId,
      range: input.range,
      activeTab: input.initialTab ?? 'number',
      draft,
      dirty: false,
    })
  },
)
openFormatCellsAtom.debugLabel = 'spreadsheet.formatCells.open'

export const closeFormatCellsAtom = atom(null, (_get, set) => {
  set(formatCellsEditorAtom, { status: 'closed' })
})
closeFormatCellsAtom.debugLabel = 'spreadsheet.formatCells.close'

/**
 * Switch the active tab without touching the draft. Switching is a no-op when
 * the dialog is closed; that path is unreachable from the dialog UI but the
 * guard keeps the atom safe for keyboard shortcuts dispatched from outside.
 */
export const setFormatCellsActiveTabAtom = atom(
  null,
  (get, set, tab: FormatCellsTabId) => {
    const state = get(formatCellsEditorAtom)
    if (state.status !== 'open') return
    if (state.activeTab === tab) return
    set(formatCellsEditorAtom, { ...state, activeTab: tab })
  },
)
setFormatCellsActiveTabAtom.debugLabel = 'spreadsheet.formatCells.setActiveTab'

/**
 * Shallow-merge a partial draft into the open editor's draft. The dialog
 * passes user edits through this single command so the dirty flag and the
 * draft stay in lockstep.
 */
export const patchFormatCellsDraftAtom = atom(
  null,
  (get, set, patch: Partial<FormatCellsDraft>) => {
    const state = get(formatCellsEditorAtom)
    if (state.status !== 'open') return
    set(formatCellsEditorAtom, {
      ...state,
      draft: { ...state.draft, ...patch },
      dirty: true,
    })
  },
)
patchFormatCellsDraftAtom.debugLabel = 'spreadsheet.formatCells.patchDraft'

/**
 * Read-only snapshot of the save payload. The Solid host calls
 * `backend.setFormatRange` directly with this payload, then dispatches
 * `closeFormatCellsAtom`. We keep the save side-effect in the host (where the
 * backend port lives) rather than in the atom; this mirrors the
 * SpreadsheetNameManagerDialog + SpreadsheetConditionalFormatDialog pattern
 * and keeps the UI core free of backend imports.
 */
export const formatCellsSavePayloadAtom = atom((get) => {
  const state = get(formatCellsEditorAtom)
  if (state.status !== 'open') return null
  return {
    sheetId: state.sheetId,
    range: state.range,
    format: state.draft,
  }
})
formatCellsSavePayloadAtom.debugLabel = 'spreadsheet.formatCells.savePayload'

/**
 * Marker command — the dialog host calls `backend.setFormatRange` and then
 * dispatches this atom to close the editor in one step. Kept separate from
 * `closeFormatCellsAtom` so test assertions can distinguish a Save-close from
 * a Cancel-close even though the resulting state is identical.
 */
export const saveFormatCellsAtom = atom(null, (_get, set) => {
  set(formatCellsEditorAtom, { status: 'closed' })
})
saveFormatCellsAtom.debugLabel = 'spreadsheet.formatCells.save'
