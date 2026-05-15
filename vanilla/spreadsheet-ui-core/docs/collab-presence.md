# collab-presence

Collaboration presence: remote cursors and edit awareness in `@einfach/spreadsheet-ui-core`.

---

## Goal

Show each remote participant's active cell and selection as they move, surface
remote edits as they arrive (attributed to a participant), and expose the
originating user on diagnostics so errors can be traced to a specific peer.

---

## Scope

- Bounded participant list (cap N, recommended 32).
- Per-participant remote cursor: sheet, selection subset, last-seen timestamp.
- Edit attribution: link incoming `BackendMutationResult` revisions to a participant.
- Local cursor publication: push local `SelectionState` changes to the backend port.
- Conflict hint: warn when the local cell being edited is concurrently targeted by a remote participant.

**Out of scope**

- CRDT / OT internals — those live entirely in the backend.
- Voice, video, or any media channel.
- @-mentions and notifications.
- Full activity feed or audit log.
- Presence avatars or rich user profiles (host UI concern).

---

## State (UI core)

```ts
// bounded list; capped at MAX_PRESENCE_PARTICIPANTS entries (trim oldest lastSeenAt on overflow)
export const presenceStateAtom = atom<PresenceState>(DEFAULT_PRESENCE_STATE)
presenceStateAtom.debugLabel = 'spreadsheet.presence.state'

// derived: one RemoteCursor per participant that has an active selection
export const remoteCursorsAtom = atom<RemoteCursor[]>(
  (get) => deriveRemoteCursors(get(presenceStateAtom)),
)
remoteCursorsAtom.debugLabel = 'spreadsheet.presence.remoteCursors'

// write-only command atom: host adapter calls this when a PresenceUpdate arrives
export const applyPresenceUpdateAtom = atom(
  null,
  (get, set, update: PresenceUpdate): void => {
    set(presenceStateAtom, applyPresenceUpdate(get(presenceStateAtom), update))
  },
)
applyPresenceUpdateAtom.debugLabel = 'spreadsheet.presence.applyUpdate'

// write-only command atom: host adapter calls this when a RemoteEditEvent arrives
export const applyRemoteEditAtom = atom(
  null,
  (get, set, event: RemoteEditEvent): void => {
    set(presenceStateAtom, applyRemoteEdit(get(presenceStateAtom), event))
  },
)
applyRemoteEditAtom.debugLabel = 'spreadsheet.presence.applyRemoteEdit'
```

`PresenceState` stores only display-needed slices: the participant roster and
the latest cursor per participant. It does NOT store workbook facts, formula
cache, or any unbounded per-cell data.

---

## Types

```ts
/** A remote collaborator visible to the local user. */
export interface Participant {
  id: string
  displayName: string
  /** CSS-compatible color token; host UI assigns, UI core stores verbatim. */
  colorHint: string
  lastSeenAt: number // ms since epoch (Date.now())
}

/** The subset of SelectionState relevant for remote rendering. */
export type RemoteCursorSelection =
  | { kind: 'cell'; anchor: CellCoord; focus: CellCoord }
  | { kind: 'range'; anchor: CellCoord; focus: CellCoord }
  | { kind: 'row'; rowAnchor: number; rowFocus: number }
  | { kind: 'column'; colAnchor: number; colFocus: number }
  | { kind: 'all' }

/** One remote cursor, derived from presence state. */
export interface RemoteCursor {
  participantId: string
  sheetId: string
  selection: RemoteCursorSelection
}

/** Push payload from the backend transport; host adapter maps to this shape. */
export interface PresenceUpdate {
  participant: Participant
  sheetId: string | null
  selection: RemoteCursorSelection | null
}

/** Attribution record carried alongside a remote revision. */
export interface RemoteEditEvent {
  participantId: string
  /** Matches ProjectionRevision from backend/types.ts. */
  revision: number | string
  sheetId: string
  affectedRange?: CellRange
}

export interface PresenceState {
  participants: Participant[]
  /** Map from participantId to their current cursor; absent if no active sheet. */
  cursors: Record<string, RemoteCursor>
  /** Most recent RemoteEditEvent received, for diagnostics attribution. */
  lastRemoteEdit: RemoteEditEvent | null
}

export const MAX_PRESENCE_PARTICIPANTS = 32

export const DEFAULT_PRESENCE_STATE: PresenceState = {
  participants: [],
  cursors: {},
  lastRemoteEdit: null,
}
```

---

## Backend port

Two optional methods are added to `SpreadsheetBackend`:

```ts
export interface SpreadsheetBackend {
  // ...existing methods...

  /**
   * Subscribe to presence updates from the backend transport.
   * Returns an unsubscribe function.
   * UI core does NOT open sockets; the host adapter wires transport and calls
   * applyPresenceUpdateAtom when updates arrive.
   */
  subscribePresence?(handler: (update: PresenceUpdate) => void): () => void

  /**
   * Publish the local user's current cursor to the backend transport.
   * Called by the host adapter after it reads selectionAtom changes.
   * Fire-and-forget; no return value.
   */
  publishLocalPresence?(payload: PresenceUpdate): void
}
```

**Push vs poll**: prefer push (`subscribePresence`). If the backend only
supports polling, the host adapter implements the poll loop and still calls
`applyPresenceUpdateAtom` on each tick — the UI core remains unaware of the
transport mechanism.

**No sockets in UI core**: this package must not import WebSocket, EventSource,
or any transport primitive. All transport is owned by the host adapter.

---

## Integration points

**Selection** — when `selectionAtom` changes, the host adapter (not the UI
core) reads the new `SelectionState`, maps it to `PresenceUpdate`, and calls
`publishLocalPresence`. Remote cursors are stored in `remoteCursorsAtom` and
rendered in a separate overlay channel. They MUST NOT mutate `selectionAtom`;
the two channels are read-only to each other.

**Workspace** — when a `RemoteEditEvent` arrives via `applyRemoteEditAtom`, the
host adapter should also advance `viewportRevision` (via
`advanceWorkspaceViewportAtom`) so the projection pipeline re-requests visible
cells incorporating the new revision. Attribution info from
`presenceStateAtom.lastRemoteEdit` is available for UI labeling.

**Viewport** — scroll-to-remote-cursor is an optional host-level command. The
UI core exposes no built-in scroll-to-participant atom; the host reads
`remoteCursorsAtom` and issues a `scrollToCellAtom`-equivalent command at its
discretion.

**Diagnostics** — presence transport errors (subscription failure, publish
timeout) should be routed through the existing diagnostics channel, tagged with
the participant id as the source when available.

**Editing** — when `editingStateAtom` has an active draft cell, the host
adapter may derive a warning if any `RemoteCursor` in `remoteCursorsAtom`
targets the same `sheetId` + cell coordinate. The UI core surfaces this as a
read of `remoteCursorsAtom`; the warning presentation is host-side.

---

## Risks & open questions

- **Cap N participants**: 32 is the recommended cap. Overflow evicts the
  participant with the oldest `lastSeenAt`. Higher caps increase derived atom
  recalculation cost on every cursor move from any peer.
- **Color collision**: `colorHint` is assigned by the host or server; the UI
  core stores it verbatim and cannot guarantee uniqueness. Host should assign
  from a palette and resolve conflicts before publishing.
- **Churn on selection moves**: rapid cursor movement from N participants causes
  N `applyPresenceUpdateAtom` writes per move event. Consider debouncing
  publish on the local side and throttling incoming updates in the host adapter
  before writing to the atom.
- **Ordering of presence vs revision events**: a `RemoteEditEvent` may arrive
  before the corresponding `PresenceUpdate` registers the participant. The atom
  update must not throw on unknown `participantId`; store the event and
  reconcile when the participant record arrives.
- **Transport disconnect fallback**: if `subscribePresence` drops, the host
  adapter should clear stale cursors by dispatching `PresenceUpdate` with
  `selection: null` for each known participant, or reset `presenceStateAtom` to
  `DEFAULT_PRESENCE_STATE`.
- **Privacy of cursor publication**: `publishLocalPresence` sends the local
  user's selection to the server. Host adapters must obtain user consent before
  enabling this; the backend port is optional so hosts can omit it entirely.

---

## Test surface

`test/presence.test.ts`

- `applyPresenceUpdate` pure helper: add participant, update cursor, trim on
  overflow beyond `MAX_PRESENCE_PARTICIPANTS`.
- `applyRemoteEdit` pure helper: stores `lastRemoteEdit`, unknown participant
  does not throw.
- `deriveRemoteCursors` pure helper: maps participant roster + cursor map to
  `RemoteCursor[]`, excludes participants with `null` sheet or selection.
- `presenceStateAtom` atom: write via `applyPresenceUpdateAtom`, read back
  updated roster.
- `remoteCursorsAtom` atom: derived value re-evaluates after presence update.
- Overflow eviction: inserting 33 participants drops the one with oldest
  `lastSeenAt`.
- Unknown-participant edit event: `applyRemoteEditAtom` stores event without
  crashing.

## State Decision Template

- Source atoms: `presenceStateAtom`.
- Derived atoms: `remoteCursorsAtom`.
- Commands: `applyPresenceUpdateAtom`, `applyRemoteEditAtom`.
- Scale bound: capped at `MAX_PRESENCE_PARTICIPANTS`; no per-cell atoms.
- Backend reads: `subscribePresence` / `publishLocalPresence` (both optional).
- Per-cell/per-row/per-col atom risk: none; cursor stored as selection subset,
  not expanded to cell grid.
- Tests: `test/presence.test.ts`.
