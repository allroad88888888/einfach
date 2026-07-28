import type { CellRange } from '../shared'
import type { SelectionState } from '../selection/types'

export const MAX_PARTICIPANTS = 32

export interface Participant {
  id: string
  displayName: string
  colorHint?: string
  lastSeenAt: number
}

export interface RemoteCursor {
  participantId: string
  sheetId: string
  selection: SelectionState
}

export interface PresenceState {
  participants: Participant[]
  cursors: Record<string, RemoteCursor>
}

export type PresenceUpdate =
  | { kind: 'join'; participant: Participant }
  | { kind: 'leave'; participantId: string }
  | { kind: 'cursor'; participantId: string; sheetId: string; selection: SelectionState }
  | { kind: 'heartbeat'; participantId: string; at: number }

export interface LocalPresencePayload {
  sheetId: string
  selection: SelectionState
}

export interface RemoteEditEvent {
  participantId: string
  revision: number | string
  affectedRange?: CellRange
  transactionId?: string
}
