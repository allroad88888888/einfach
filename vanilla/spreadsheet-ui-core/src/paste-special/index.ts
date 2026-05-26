import { atom } from '@einfach/core'
import { DEFAULT_PASTE_SPECIAL_OPTIONS, type PasteSpecialOptions } from './types'

export * from './types'

/**
 * Whether the Paste Special dialog is visible. Source atom; the open/close
 * command atoms below flip this and are the only writers callers should
 * touch directly.
 */
export const pasteSpecialOpenAtom = atom<boolean>(false)
pasteSpecialOpenAtom.debugLabel = 'spreadsheet.pasteSpecial.open'

/**
 * Per-instance dialog options. Kept in an atom (rather than a Solid signal
 * inside the component body) so that Solid 1.9.12's provider re-mount
 * hazard does not drop the user's draft when an unrelated atom mutates
 * elsewhere in the tree. The setter accepts either a fresh value or a
 * partial patch.
 */
export const pasteSpecialOptionsAtom = atom<PasteSpecialOptions>({
  ...DEFAULT_PASTE_SPECIAL_OPTIONS,
})
pasteSpecialOptionsAtom.debugLabel = 'spreadsheet.pasteSpecial.options'

/** Write-only command: open the Paste Special dialog and reset options. */
export const openPasteSpecialAtom = atom(
  null,
  (_get, set) => {
    set(pasteSpecialOptionsAtom, { ...DEFAULT_PASTE_SPECIAL_OPTIONS })
    set(pasteSpecialOpenAtom, true)
  },
)
openPasteSpecialAtom.debugLabel = 'spreadsheet.pasteSpecial.openCommand'

/** Write-only command: close the dialog and clear in-progress options. */
export const closePasteSpecialAtom = atom(
  null,
  (_get, set) => {
    set(pasteSpecialOpenAtom, false)
    set(pasteSpecialOptionsAtom, { ...DEFAULT_PASTE_SPECIAL_OPTIONS })
  },
)
closePasteSpecialAtom.debugLabel = 'spreadsheet.pasteSpecial.closeCommand'

/**
 * Patch helper: shallow-merge a partial PasteSpecialOptions into the
 * current options atom. Used by the dialog form controls so a single
 * radio/checkbox change doesn't have to spread the whole object.
 */
export const patchPasteSpecialOptionsAtom = atom(
  null,
  (get, set, patch: Partial<PasteSpecialOptions>) => {
    set(pasteSpecialOptionsAtom, { ...get(pasteSpecialOptionsAtom), ...patch })
  },
)
patchPasteSpecialOptionsAtom.debugLabel = 'spreadsheet.pasteSpecial.patchOptions'

/**
 * Confirm-side command: closes the dialog and resets options. The actual
 * backend `pasteRange` dispatch is handled by the host (which has access
 * to the backend port + projection refresh helpers); this atom exists so
 * the dialog can `set(confirmPasteSpecialAtom)` and trust UI state will
 * be cleaned up regardless of whether the host backend succeeded.
 *
 * Returns a promise that resolves once the close state is committed — the
 * Promise return signature is kept for the spec's `atom<null, void, Promise<void>>`
 * shape, even though no async work happens here. Hosts that want to await
 * the actual backend dispatch should call their adapter directly first,
 * then `set(confirmPasteSpecialAtom)`.
 */
export const confirmPasteSpecialAtom = atom(
  null,
  async (_get, set): Promise<void> => {
    set(pasteSpecialOpenAtom, false)
    set(pasteSpecialOptionsAtom, { ...DEFAULT_PASTE_SPECIAL_OPTIONS })
  },
)
confirmPasteSpecialAtom.debugLabel = 'spreadsheet.pasteSpecial.confirm'
