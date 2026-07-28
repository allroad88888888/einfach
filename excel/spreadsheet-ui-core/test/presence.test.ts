import { describe, expect, test } from '@jest/globals'
import { createStore } from '@einfach/core'
import {
  MAX_PARTICIPANTS,
  applyPresenceUpdateAtom,
  applyRemoteEditEventAtom,
  clearPresenceAtom,
  lastRemoteEditEventAtom,
  presenceStateAtom,
  remoteCursorsAtom,
  type Participant,
  type RemoteEditEvent,
} from '../src/presence'
import { selectionAtom } from '../src/selection'

function makeParticipant(id: string, lastSeenAt = 1000): Participant {
  return { id, displayName: `User ${id}`, lastSeenAt }
}

type AtomHasPublicWrite<Entity> = Entity extends { write: unknown } ? true : false

const PRESENCE_PUBLIC_STATE_IS_READ_ONLY: readonly [
  AtomHasPublicWrite<typeof presenceStateAtom>,
  AtomHasPublicWrite<typeof lastRemoteEditEventAtom>,
] = [false, false]

const PRESENCE_COMMANDS_ARE_WRITABLE: readonly [
  AtomHasPublicWrite<typeof applyPresenceUpdateAtom>,
  AtomHasPublicWrite<typeof applyRemoteEditEventAtom>,
  AtomHasPublicWrite<typeof clearPresenceAtom>,
] = [true, true, true]

describe('presence', () => {
  test('rejects reflected writes to public state without changing references', () => {
    expect(
      [presenceStateAtom, lastRemoteEditEventAtom].map((stateAtom) => 'write' in stateAtom),
    ).toEqual(PRESENCE_PUBLIC_STATE_IS_READ_ONLY)
    expect(
      [applyPresenceUpdateAtom, applyRemoteEditEventAtom, clearPresenceAtom].map(
        (commandAtom) => 'write' in commandAtom,
      ),
    ).toEqual(PRESENCE_COMMANDS_ARE_WRITABLE)

    const store = createStore()
    store.setter(applyPresenceUpdateAtom, {
      kind: 'join',
      participant: makeParticipant('p1'),
    })
    const remoteEditEvent: RemoteEditEvent = { participantId: 'p1', revision: 7 }
    store.setter(applyRemoteEditEventAtom, remoteEditEvent)

    const presenceBefore = store.getter(presenceStateAtom)
    const remoteEditBefore = store.getter(lastRemoteEditEventAtom)
    if (remoteEditBefore === null) throw new Error('expected remote edit event')

    expect(store.getter(presenceStateAtom)).toBe(presenceBefore)
    expect(store.getter(lastRemoteEditEventAtom)).toBe(remoteEditBefore)

    expect(() =>
      Reflect.apply(store.setter, store, [
        presenceStateAtom,
        { participants: [], cursors: {} },
      ]),
    ).toThrow()
    expect(() =>
      Reflect.apply(store.setter, store, [
        lastRemoteEditEventAtom,
        { ...remoteEditBefore, revision: 8 },
      ]),
    ).toThrow()

    expect(store.getter(presenceStateAtom)).toBe(presenceBefore)
    expect(store.getter(lastRemoteEditEventAtom)).toBe(remoteEditBefore)
    expect(presenceStateAtom.debugLabel).toBe('spreadsheet.presence.state')
    expect(lastRemoteEditEventAtom.debugLabel).toBe('spreadsheet.presence.lastRemoteEdit')
  })

  test('routes empty -> join -> cursor -> heartbeat -> leave and remote null -> event -> clear', () => {
    const store = createStore()
    expect(store.getter(presenceStateAtom)).toEqual({ participants: [], cursors: {} })
    expect(store.getter(lastRemoteEditEventAtom)).toBeNull()

    store.setter(applyPresenceUpdateAtom, {
      kind: 'join',
      participant: makeParticipant('p1', 100),
    })
    expect(store.getter(presenceStateAtom).participants).toEqual([
      makeParticipant('p1', 100),
    ])

    const selection = {
      kind: 'cell' as const,
      sheetId: 'sheet-1',
      anchor: { row: 2, col: 3 },
      focus: { row: 2, col: 3 },
    }
    store.setter(applyPresenceUpdateAtom, {
      kind: 'cursor',
      participantId: 'p1',
      sheetId: 'sheet-1',
      selection,
    })
    const cursorState = store.getter(presenceStateAtom)
    expect(cursorState.cursors['p1']).toEqual({
      participantId: 'p1',
      sheetId: 'sheet-1',
      selection,
    })
    expect(cursorState.participants[0].lastSeenAt).toBeGreaterThanOrEqual(100)

    store.setter(applyPresenceUpdateAtom, {
      kind: 'heartbeat',
      participantId: 'p1',
      at: 300,
    })
    expect(store.getter(presenceStateAtom).participants[0].lastSeenAt).toBe(300)

    const remoteEditEvent: RemoteEditEvent = { participantId: 'p1', revision: 9 }
    store.setter(applyRemoteEditEventAtom, remoteEditEvent)
    expect(store.getter(lastRemoteEditEventAtom)).toBe(remoteEditEvent)

    store.setter(applyPresenceUpdateAtom, { kind: 'leave', participantId: 'p1' })
    expect(store.getter(presenceStateAtom)).toEqual({ participants: [], cursors: {} })
    expect(store.getter(lastRemoteEditEventAtom)).toBe(remoteEditEvent)

    store.setter(clearPresenceAtom)
    expect(store.getter(presenceStateAtom)).toEqual({ participants: [], cursors: {} })
    expect(store.getter(lastRemoteEditEventAtom)).toBeNull()
  })

  test('initial state has empty participants and cursors', () => {
    const store = createStore()
    const state = store.getter(presenceStateAtom)
    expect(state.participants).toEqual([])
    expect(state.cursors).toEqual({})
  })

  test('join adds a participant', () => {
    const store = createStore()
    const p = makeParticipant('p1')
    store.setter(applyPresenceUpdateAtom, { kind: 'join', participant: p })
    const state = store.getter(presenceStateAtom)
    expect(state.participants).toHaveLength(1)
    expect(state.participants[0].id).toBe('p1')
  })

  test('joining 33 participants evicts the oldest by lastSeenAt; final length is 32', () => {
    const store = createStore()

    for (let i = 1; i <= MAX_PARTICIPANTS; i += 1) {
      store.setter(applyPresenceUpdateAtom, {
        kind: 'join',
        participant: makeParticipant(`p${i}`, i * 100),
      })
    }

    // oldest is p1 (lastSeenAt=100)
    expect(store.getter(presenceStateAtom).participants).toHaveLength(MAX_PARTICIPANTS)

    // join one more — should evict p1
    store.setter(applyPresenceUpdateAtom, {
      kind: 'join',
      participant: makeParticipant('p33', 9999),
    })

    const state = store.getter(presenceStateAtom)
    expect(state.participants).toHaveLength(MAX_PARTICIPANTS)
    expect(state.participants.find((p) => p.id === 'p1')).toBeUndefined()
    expect(state.participants.find((p) => p.id === 'p33')).toBeDefined()
  })

  test('cursor update records cursor entry keyed by participantId and bumps lastSeenAt', () => {
    const store = createStore()
    store.setter(applyPresenceUpdateAtom, { kind: 'join', participant: makeParticipant('p1', 500) })

    const selection = { kind: 'cell' as const, sheetId: 'sheet-1', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }
    store.setter(applyPresenceUpdateAtom, {
      kind: 'cursor',
      participantId: 'p1',
      sheetId: 'sheet-1',
      selection,
    })

    const state = store.getter(presenceStateAtom)
    expect(state.cursors['p1']).toBeDefined()
    expect(state.cursors['p1'].sheetId).toBe('sheet-1')
    expect(state.cursors['p1'].selection).toEqual(selection)

    // lastSeenAt should have been bumped (>= 500)
    const participant = state.participants.find((x) => x.id === 'p1')
    expect(participant!.lastSeenAt).toBeGreaterThanOrEqual(500)
  })

  test('leave removes participant and cursor entry', () => {
    const store = createStore()
    store.setter(applyPresenceUpdateAtom, { kind: 'join', participant: makeParticipant('p1') })
    const selection = { kind: 'cell' as const, sheetId: 'sheet-1', anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } }
    store.setter(applyPresenceUpdateAtom, { kind: 'cursor', participantId: 'p1', sheetId: 'sheet-1', selection })

    store.setter(applyPresenceUpdateAtom, { kind: 'leave', participantId: 'p1' })

    const state = store.getter(presenceStateAtom)
    expect(state.participants).toHaveLength(0)
    expect(state.cursors['p1']).toBeUndefined()
  })

  test('heartbeat updates lastSeenAt only', () => {
    const store = createStore()
    store.setter(applyPresenceUpdateAtom, { kind: 'join', participant: makeParticipant('p1', 100) })
    store.setter(applyPresenceUpdateAtom, { kind: 'heartbeat', participantId: 'p1', at: 9999 })

    const state = store.getter(presenceStateAtom)
    const participant = state.participants.find((x) => x.id === 'p1')
    expect(participant!.lastSeenAt).toBe(9999)
    expect(Object.keys(state.cursors)).toHaveLength(0)
  })

  test('remoteCursorsAtom returns cursors sorted by participant lastSeenAt desc', () => {
    const store = createStore()

    store.setter(applyPresenceUpdateAtom, { kind: 'join', participant: makeParticipant('p1', 100) })
    store.setter(applyPresenceUpdateAtom, { kind: 'join', participant: makeParticipant('p2', 200) })
    store.setter(applyPresenceUpdateAtom, { kind: 'join', participant: makeParticipant('p3', 150) })

    const sel = (sheetId: string) => ({ kind: 'cell' as const, sheetId, anchor: { row: 0, col: 0 }, focus: { row: 0, col: 0 } })

    store.setter(applyPresenceUpdateAtom, { kind: 'cursor', participantId: 'p1', sheetId: 's', selection: sel('s') })
    store.setter(applyPresenceUpdateAtom, { kind: 'cursor', participantId: 'p2', sheetId: 's', selection: sel('s') })
    store.setter(applyPresenceUpdateAtom, { kind: 'cursor', participantId: 'p3', sheetId: 's', selection: sel('s') })

    // reset lastSeenAt to controlled values via heartbeat
    store.setter(applyPresenceUpdateAtom, { kind: 'heartbeat', participantId: 'p1', at: 100 })
    store.setter(applyPresenceUpdateAtom, { kind: 'heartbeat', participantId: 'p2', at: 200 })
    store.setter(applyPresenceUpdateAtom, { kind: 'heartbeat', participantId: 'p3', at: 150 })

    const cursors = store.getter(remoteCursorsAtom)
    expect(cursors.map((c) => c.participantId)).toEqual(['p2', 'p3', 'p1'])
  })

  test('applyRemoteEditEventAtom updates lastRemoteEditEventAtom', () => {
    const store = createStore()
    const event: RemoteEditEvent = { participantId: 'p1', revision: 7 }
    store.setter(applyRemoteEditEventAtom, event)
    expect(store.getter(lastRemoteEditEventAtom)).toEqual(event)
  })

  test('clearPresenceAtom resets to empty', () => {
    const store = createStore()
    store.setter(applyPresenceUpdateAtom, { kind: 'join', participant: makeParticipant('p1') })
    store.setter(applyRemoteEditEventAtom, { participantId: 'p1', revision: 1 })

    store.setter(clearPresenceAtom)

    const state = store.getter(presenceStateAtom)
    expect(state.participants).toHaveLength(0)
    expect(state.cursors).toEqual({})
    expect(store.getter(lastRemoteEditEventAtom)).toBeNull()
  })

  test('remoteCursorsAtom reading does NOT mutate selectionAtom — local selection unaffected', () => {
    const store = createStore()
    const localSel = { kind: 'cell' as const, sheetId: 'sheet-local', anchor: { row: 2, col: 3 }, focus: { row: 2, col: 3 } }
    store.setter(selectionAtom, localSel)

    store.setter(applyPresenceUpdateAtom, { kind: 'join', participant: makeParticipant('p1') })
    const remoteSel = { kind: 'cell' as const, sheetId: 'sheet-remote', anchor: { row: 5, col: 5 }, focus: { row: 5, col: 5 } }
    store.setter(applyPresenceUpdateAtom, { kind: 'cursor', participantId: 'p1', sheetId: 'sheet-remote', selection: remoteSel })

    // reading remoteCursorsAtom should not affect selectionAtom
    store.getter(remoteCursorsAtom)
    expect(store.getter(selectionAtom)).toEqual(localSel)
  })
})
