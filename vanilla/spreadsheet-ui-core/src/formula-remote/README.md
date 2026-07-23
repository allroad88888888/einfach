# formula-remote

Owns the UI-core remote-formula tracking layer (Wave 8.1).
`=REMOTE("https://api.example.com/data", A1, B1)` produces `#BUSY!`
while the request is in flight; the engine's async flow mirrors the
Wave 8.2 async custom-formula machinery (`#BUSY!` + per-call memo
atom + drain/resolve).

This module tracks **in-flight call descriptors** so hosts can render
per-cell loading indicators, a global "fetching…" spinner, and transient
error banners — without coupling to the worker protocol or WASM bridge.

**Authoritative engine contract:** `rust/excel-core/docs/REMOTE_FORMULAS_DESIGN.md`.

## State Decision Template

- Source atoms:
  - Private `_remoteFormulaStateAtom` — single aggregate per `@einfach/core` store.
- Derived atoms:
  - `remoteFormulaPendingAtom` — `ReadonlyMap<number, RemotePendingDescriptor>`, in-flight calls.
  - `remoteFormulaStatusAtom` — `'idle' | 'busy' | 'error'`, aggregate status.
- Configuration:
  - `remoteFormulaTimeoutMsAtom` — timeout in ms, default 30_000, clamped [1_000, 300_000].
- Commands:
  - `addRemoteCallAtom(descriptor)` — host drains worker and registers the call.
  - `resolveRemoteCallAtom(callId)` — host removes after `fulfillRemote()`.
  - `rejectRemoteCallAtom(callId, message)` — host records failure + error message.
  - `clearRemoteErrorAtom` — acknowledge last error, return to idle.
  - `refreshAllRemoteFormulasAtom` — wipe all pending state (host must separately `invalidateRemoteCache()` on engine).
- Constants: `MAX_REMOTE_PENDING = 256` — bounded per store.
- Backend reads: none (all state originates from worker drain).
- Per-cell atom risk: none (one bounded Map per store).

## Scale & Performance

- One `ReadonlyMap` per store; no per-cell atom families.
- Pending map bounded at 256 — beyond cap, new descriptors silently dropped from UI tracking.
- No timers or intervals in this module; timeout lives in host adapter.

## Backend Degradation

When backend lacks remote-formula ports: `=REMOTE(…)` → `#NAME?`.
All UI core atoms stay at initial values (`'idle'`, empty map).
