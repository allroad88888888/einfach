# protection

Sheet protection and locked-cell state for the spreadsheet UI core.

**UI-core canonical** (CANONICAL_OWNERSHIP flip step 4, #40). Enforcement always lived on the
UI side — the W2 mutation gateway (`editing/mutation-gateway.ts`) gates every content mutation
through `isRangeFullyUnlocked` — and this module now also owns the protection configuration.
The backend `setSheetProtection` / `setRangeLock` / `readSheetProtection` ports are an optional
persistence hook (fire-and-forget mirror + one-shot hydration seed), not an authority. Backends
that expose none of them keep the full feature.

## State Decision Template

- Source atoms:
  - `sheetProtectionAtom`: read-only map of sheetId → `SheetProtectionState` (mode + bounded
    unlocked ranges); backing atom is module-private, mutate via commands.
  - `sheetProtectionDiagnosticAtom`: last persistence-hook failure (`persist-failed` /
    `hydrate-failed`); local state is never rolled back.
  - `protectionUnlockStateAtom` (+ `protectionUnlockPasswordAtom` / `protectionUnlockPhaseAtom` /
    `protectionUnlockOpenAtom`): unlock dialog session. Phases are `closed | editing | verifying`.
- Derived atoms:
  - `activeCellLockedAtom`: true when the active cell is locked in a protected sheet.
  - `selectionLockedAtom`: 'open' | 'locked' | 'partial' for the current selection range.
- Commands (synchronous local commit, `'committed' | 'unchanged' | 'invalid'`):
  - `setSheetProtectionAtom` / `clearSheetProtectionAtom`: replace / remove a sheet entry.
  - `protectSheetAtom` / `unprotectSheetAtom`: toggle the mode, preserving unlocked ranges.
  - `addUnlockedRangeAtom` / `removeUnlockedRangeAtom`: grow / shrink the allow-edit ranges.
  - `openProtectionUnlockAtom` / `setProtectionUnlockPasswordAtom` / `submitProtectionUnlockAtom`
    / `closeProtectionUnlockAtom`: unlock dialog session.
  - `hydrateSheetProtectionAtom`: one-shot seed from `readSheetProtection` when the host backend
    implements it; never overwrites a sheet a local command already owns.
- Scale bound: `unlockedRanges` capped at `MAX_UNLOCKED_RANGES` (256) per sheet; no per-cell atoms.
- Persistence hook: commands accept an optional `source` (`SheetProtectionPersistencePort`).
  When present, commits mirror fire-and-forget (`setRangeLock` preferred for range deltas,
  `setSheetProtection` for full-state writes); a failure records a diagnostic only.
- Tests: `test/protection.test.ts`.

## Undo history — deliberate exclusion

Protection changes (protect/unprotect, add/remove unlocked range, dialog unlock) do **not**
create history entries. This matches Excel, where protection operations are not undoable, and
avoids a footgun: an undo that silently re-locks (or a redo that unlocks) cells would change the
enforcement state behind the user's back while they edit. Undo/redo of content edits never
touches protection state.

## Password semantics

UI-core never stores or hashes a protection password. The unlock dialog keeps the typed password
transiently in the session machine (cleared on every open/close) and passes it to the OPTIONAL
host `verifySheetProtection` callback; a rejection or timeout keeps the dialog editing with an
error. When no verifier is supplied, the unlock commits without a password check. A verification
that settles after the dialog closed or reopened for another target is discarded (session-id
guard) — it can never commit against a stale target.
