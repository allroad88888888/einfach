import { atom } from '@einfach/core'
import type { NamedRange, NameManagerEditorState, NamedRangeListResult } from './types'

export * from './types'

export const NAMED_RANGE_CACHE_MAX = 500

export const nameRegistryCacheAtom = atom<NamedRange[]>([])
nameRegistryCacheAtom.debugLabel = 'spreadsheet.namedRanges.cache'

export const nameManagerEditorAtom = atom<NameManagerEditorState>({ status: 'closed' })
nameManagerEditorAtom.debugLabel = 'spreadsheet.namedRanges.editor'

/**
 * The kind selector of the Name Manager dialog. Atom-backed (not a Solid
 * `createSignal` local) because the dialog runs inside the `@einfach/solid`
 * Provider and 1.9.12 leaks remount the consumer body — see
 * `solid/solid/test/provider-remount.test.tsx` and the project memory note
 * `project_solid_provider_remount.md`. Per-instance dialog state that must
 * survive atom mutations lives here instead of in the component body.
 */
export type NameManagerKind = 'range' | 'value' | 'lambda'

export const nameManagerKindDraftAtom = atom<NameManagerKind>('range')
nameManagerKindDraftAtom.debugLabel = 'spreadsheet.namedRanges.kindDraft'

/**
 * Comma-separated LAMBDA parameter names. Only meaningful when
 * `nameManagerKindDraftAtom === 'lambda'`. Reset to '' on dialog open
 * edge by the dialog component.
 */
export const nameManagerParamsDraftAtom = atom<string>('')
nameManagerParamsDraftAtom.debugLabel = 'spreadsheet.namedRanges.paramsDraft'

/**
 * Free-text refersTo / lambda body draft. Atom-backed for the same Solid
 * Provider remount reason as `nameManagerKindDraftAtom`.
 */
export const nameManagerRefersToDraftAtom = atom<string>('')
nameManagerRefersToDraftAtom.debugLabel = 'spreadsheet.namedRanges.refersToDraft'

/** Name input draft. */
export const nameManagerNameDraftAtom = atom<string>('')
nameManagerNameDraftAtom.debugLabel = 'spreadsheet.namedRanges.nameDraft'

/** Scope selector draft. */
export const nameManagerScopeDraftAtom = atom<string>('workbook')
nameManagerScopeDraftAtom.debugLabel = 'spreadsheet.namedRanges.scopeDraft'

export const setNameRegistryAtom = atom(
  (get) => get(nameRegistryCacheAtom),
  (_get, set, result: NamedRangeListResult) => {
    const names = result.names.length > NAMED_RANGE_CACHE_MAX
      ? result.names.slice(result.names.length - NAMED_RANGE_CACHE_MAX)
      : result.names
    set(nameRegistryCacheAtom, names)
  },
)
setNameRegistryAtom.debugLabel = 'spreadsheet.namedRanges.setRegistry'

export const openNameManagerAtom = atom(
  (get) => get(nameManagerEditorAtom),
  (_get, set, state: NameManagerEditorState) => {
    set(nameManagerEditorAtom, state)
  },
)
openNameManagerAtom.debugLabel = 'spreadsheet.namedRanges.open'

export const closeNameManagerAtom = atom(
  (get) => get(nameManagerEditorAtom),
  (_get, set) => {
    set(nameManagerEditorAtom, { status: 'closed' })
  },
)
closeNameManagerAtom.debugLabel = 'spreadsheet.namedRanges.close'
