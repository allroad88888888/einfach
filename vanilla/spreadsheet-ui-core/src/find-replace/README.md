# find-replace

Owns find/replace query state, cursor navigation, and backend search/replace contracts.

## State Decision Template

- Source atoms:
  - `findReplaceQueryAtom`: active query and options; null when dialog is closed.
  - `findReplaceCursorAtom`: status, currentIndex, totalCount, and bounded pageMatches.
  - `findReplaceOpenAtom`: whether the find-replace dialog is open.
- Derived atoms: none; current match coord read from `pageMatches[currentIndex]` by the host adapter.
- Commands:
  - `openFindReplaceAtom`
  - `closeFindReplaceAtom`
  - `commitFindReplaceQueryAtom`
  - `setFindMatchesAtom`
  - `advanceFindCursorAtom`
  - `setFindReplaceErrorAtom`
- Scale bound: `MAX_FIND_PAGE = 500` coords in `pageMatches` at any time.
- Backend reads: paged `searchRange` / `replaceMatches` via optional backend methods.
- Per-cell atom risk: do not store the full match list; backend owns the index.
- Tests: `test/find-replace.test.ts`.
