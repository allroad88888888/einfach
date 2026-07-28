# find-replace

Owns find/replace query state, cursor navigation, and backend search/replace contracts.

## State Decision Template

- Source atoms:
  - `findReplaceQueryAtom`: active query and options; null when dialog is closed.
  - `findReplaceCursorAtom`: status, currentIndex, totalCount, and bounded pageMatches.
  - `findReplaceOpenAtom`: whether the find-replace dialog is open.
  - `replaceAllCappedAtom`: non-null `{ replacedCount, totalCount }` when the last
    replace-all hit the `MAX_FIND_PAGE` cap (audit D-12) — the dialog surfaces
    "replaced first N of M; run again for the rest" instead of silently leaving
    matches 501..M untouched. Cleared on commit (new search) and close.
- Derived atoms: none; current match coord read from `pageMatches[currentIndex]` by the host adapter.
- Commands:
  - `openFindReplaceAtom`
  - `closeFindReplaceAtom`
  - `commitFindReplaceQueryAtom`
  - `setFindMatchesAtom`
  - `advanceFindCursorAtom`
  - `setFindReplaceErrorAtom`
  - `markReplaceAllCappedAtom` (host calls it AFTER the post-replace re-search,
    so the commit-time clear does not erase the notice)
- Scale bound: `MAX_FIND_PAGE = 500` coords in `pageMatches` at any time. The cap
  is intentional (bounded find cache); replace-all over a larger result set is
  page-at-a-time BY DESIGN — the capped notice is the contract for the remainder.
- Backend reads: paged `searchRange` / `replaceMatches` via optional backend methods.
- Per-cell atom risk: do not store the full match list; backend owns the index.
- Tests: `test/find-replace.test.ts`.
