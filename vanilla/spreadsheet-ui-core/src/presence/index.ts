import { atom } from '@einfach/core'
import type { PresenceState, PresenceUpdate, RemoteCursor, RemoteEditEvent } from './types'

export * from './types'

export const MAX_PARTICIPANTS = 32

const DEFAULT_PRESENCE_STATE: PresenceState = {
  participants: [],
  cursors: {},
}

function applyPresenceUpdate(state: PresenceState, update: PresenceUpdate): PresenceState {
  if (update.kind === 'join') {
    const existing = state.participants.find((p) => p.id === update.participant.id)
    if (existing) {
      return {
        ...state,
        participants: state.participants.map((p) =>
          p.id === update.participant.id ? update.participant : p,
        ),
      }
    }

    let participants = [...state.participants, update.participant]

    if (participants.length > MAX_PARTICIPANTS) {
      let oldestIdx = 0
      for (let i = 1; i < participants.length; i += 1) {
        if (participants[i].lastSeenAt < participants[oldestIdx].lastSeenAt) {
          oldestIdx = i
        }
      }
      const evictedId = participants[oldestIdx].id
      participants = participants.filter((_, i) => i !== oldestIdx)
      const cursors = { ...state.cursors }
      delete cursors[evictedId]
      return { participants, cursors }
    }

    return { ...state, participants }
  }

  if (update.kind === 'leave') {
    const participants = state.participants.filter((p) => p.id !== update.participantId)
    const cursors = { ...state.cursors }
    delete cursors[update.participantId]
    return { participants, cursors }
  }

  if (update.kind === 'cursor') {
    const cursor: RemoteCursor = {
      participantId: update.participantId,
      sheetId: update.sheetId,
      selection: update.selection,
    }
    const cursors = { ...state.cursors, [update.participantId]: cursor }
    const participants = state.participants.map((p) =>
      p.id === update.participantId ? { ...p, lastSeenAt: Math.max(p.lastSeenAt, Date.now()) } : p,
    )
    return { participants, cursors }
  }

  if (update.kind === 'heartbeat') {
    const participants = state.participants.map((p) =>
      p.id === update.participantId ? { ...p, lastSeenAt: update.at } : p,
    )
    return { ...state, participants }
  }

  return state
}

function deriveRemoteCursors(state: PresenceState): RemoteCursor[] {
  const participantLastSeen: Record<string, number> = {}
  for (const p of state.participants) {
    participantLastSeen[p.id] = p.lastSeenAt
  }

  return Object.values(state.cursors).sort((a, b) => {
    const aTs = participantLastSeen[a.participantId] ?? 0
    const bTs = participantLastSeen[b.participantId] ?? 0
    return bTs - aTs
  })
}

export const presenceStateAtom = atom<PresenceState>(DEFAULT_PRESENCE_STATE)
presenceStateAtom.debugLabel = 'spreadsheet.presence.state'

export const remoteCursorsAtom = atom<RemoteCursor[]>((get) =>
  deriveRemoteCursors(get(presenceStateAtom)),
)
remoteCursorsAtom.debugLabel = 'spreadsheet.presence.remoteCursors'

export const applyPresenceUpdateAtom = atom(
  null,
  (get, set, update: PresenceUpdate): void => {
    set(presenceStateAtom, applyPresenceUpdate(get(presenceStateAtom), update))
  },
)
applyPresenceUpdateAtom.debugLabel = 'spreadsheet.presence.applyUpdate'

export const clearPresenceAtom = atom(null, (_get, set): void => {
  set(presenceStateAtom, DEFAULT_PRESENCE_STATE)
  set(lastRemoteEditEventAtom, null)
})
clearPresenceAtom.debugLabel = 'spreadsheet.presence.clear'

export const lastRemoteEditEventAtom = atom<RemoteEditEvent | null>(null)
lastRemoteEditEventAtom.debugLabel = 'spreadsheet.presence.lastRemoteEdit'

export const applyRemoteEditEventAtom = atom(
  null,
  (_get, set, event: RemoteEditEvent): void => {
    set(lastRemoteEditEventAtom, event)
  },
)
applyRemoteEditEventAtom.debugLabel = 'spreadsheet.presence.applyRemoteEdit'
