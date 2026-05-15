import { atom } from '@einfach/core'
import type { NamedRange, NameManagerEditorState, NamedRangeListResult } from './types'

export * from './types'

export const NAMED_RANGE_CACHE_MAX = 500

export const nameRegistryCacheAtom = atom<NamedRange[]>([])
nameRegistryCacheAtom.debugLabel = 'spreadsheet.namedRanges.cache'

export const nameManagerEditorAtom = atom<NameManagerEditorState>({ status: 'closed' })
nameManagerEditorAtom.debugLabel = 'spreadsheet.namedRanges.editor'

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
