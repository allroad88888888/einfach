import { atom } from '@einfach/core'
import type { RemotePendingDescriptor, RemoteStatus } from './types'

export * from './types'

/** Hard cap on concurrent in-flight =REMOTE calls tracked by UI core. */
export const MAX_REMOTE_PENDING = 256

// ── Internal state ──────────────────────────────────────────────────────────

interface RemoteFormulaState {
  readonly pending: ReadonlyMap<number, RemotePendingDescriptor>
  readonly lastError: string | null
}

function createInitialRemoteState(): RemoteFormulaState {
  return Object.freeze({
    pending: new Map<number, RemotePendingDescriptor>(),
    lastError: null,
  })
}

const _remoteFormulaStateAtom = atom<RemoteFormulaState>(createInitialRemoteState())
_remoteFormulaStateAtom.debugLabel = 'spreadsheet.remoteFormula.internal.state'

// ── Public derived atoms ────────────────────────────────────────────────────

export const remoteFormulaPendingAtom = atom(
  (get): ReadonlyMap<number, RemotePendingDescriptor> =>
    get(_remoteFormulaStateAtom).pending,
)
remoteFormulaPendingAtom.debugLabel = 'spreadsheet.remoteFormula.pending'

export const remoteFormulaStatusAtom = atom((get): RemoteStatus => {
  const state = get(_remoteFormulaStateAtom)
  if (state.pending.size > 0) return 'busy'
  if (state.lastError !== null) return 'error'
  return 'idle'
})
remoteFormulaStatusAtom.debugLabel = 'spreadsheet.remoteFormula.status'

// ── Configuration ───────────────────────────────────────────────────────────

export const remoteFormulaTimeoutMsAtom = atom<number>(30_000)
remoteFormulaTimeoutMsAtom.debugLabel = 'spreadsheet.remoteFormula.timeoutMs'

// ── Command atoms ───────────────────────────────────────────────────────────

export const addRemoteCallAtom = atom(
  null,
  (get, set, descriptor: RemotePendingDescriptor): void => {
    const current = get(_remoteFormulaStateAtom)
    const next = new Map(current.pending)
    if (next.size >= MAX_REMOTE_PENDING && !next.has(descriptor.id)) return
    next.set(descriptor.id, Object.freeze({ ...descriptor }))
    set(_remoteFormulaStateAtom, { ...current, pending: next, lastError: null })
  },
)
addRemoteCallAtom.debugLabel = 'spreadsheet.remoteFormula.addCall'

export const resolveRemoteCallAtom = atom(null, (get, set, callId: number): void => {
  const current = get(_remoteFormulaStateAtom)
  if (!current.pending.has(callId)) return
  const next = new Map(current.pending)
  next.delete(callId)
  set(_remoteFormulaStateAtom, { ...current, pending: next })
})
resolveRemoteCallAtom.debugLabel = 'spreadsheet.remoteFormula.resolveCall'

export const rejectRemoteCallAtom = atom(
  null,
  (get, set, callId: number, errorMessage: string): void => {
    const current = get(_remoteFormulaStateAtom)
    const next = new Map(current.pending)
    next.delete(callId)
    set(_remoteFormulaStateAtom, { ...current, pending: next, lastError: errorMessage })
  },
)
rejectRemoteCallAtom.debugLabel = 'spreadsheet.remoteFormula.rejectCall'

export const clearRemoteErrorAtom = atom(null, (get, set): void => {
  const current = get(_remoteFormulaStateAtom)
  if (current.lastError === null) return
  set(_remoteFormulaStateAtom, { ...current, lastError: null })
})
clearRemoteErrorAtom.debugLabel = 'spreadsheet.remoteFormula.clearError'

export const refreshAllRemoteFormulasAtom = atom(null, (_get, set): void => {
  set(_remoteFormulaStateAtom, createInitialRemoteState())
})
refreshAllRemoteFormulasAtom.debugLabel = 'spreadsheet.remoteFormula.refreshAll'
