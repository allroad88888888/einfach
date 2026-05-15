# named-ranges

Bounded name-registry cache and name-manager dialog state.

## State Decision Template

- Source atoms:
  - `nameRegistryCacheAtom`: bounded list of `NamedRange` entries fetched from the backend; replaced wholesale on each load.
  - `nameManagerEditorAtom`: name-manager dialog open/close and draft state.
- Derived atoms: none; autocomplete derives over `nameRegistryCacheAtom` at the consumer level.
- Commands:
  - `setNameRegistryAtom`: replaces the cache from a `NamedRangeListResult`; truncates to `NAMED_RANGE_CACHE_MAX`.
  - `openNameManagerAtom`: transitions the editor to a given `NameManagerEditorState`.
  - `closeNameManagerAtom`: resets the editor to `{ status: 'closed' }`.
- Scale bound: `NAMED_RANGE_CACHE_MAX = 500` entries; FIFO eviction keeps the most recent 500.
- Backend reads: optional `listNamedRanges`, `setNamedRange`, `deleteNamedRange` on `SpreadsheetBackend`.
- Per-name atom risk: do not create per-name atoms; the list is a single array atom replaced wholesale.
- Tests: `test/named-ranges.test.ts`.
