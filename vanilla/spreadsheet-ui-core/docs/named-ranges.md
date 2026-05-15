# Named Ranges

## Goal

Workbook and sheet-scoped names that resolve to ranges or constants. Users type
a name in formulas (`=SUM(Revenue)`) and the backend resolves it. The UI core
exposes name-registry state for the name-manager dialog and provides
autocomplete hints to the formula-bar and cell editor. The backend owns the
authoritative name table; the UI core holds only a bounded cache.

## Scope

- Name CRUD: create, read, update (refers-to and scope), delete.
- Scope variants: workbook-level or pinned to a specific sheet by `sheetId`.
- Refers-to: an A1 range address (`Sheet1!A1:B10`) or a scalar constant
  (`42`, `'hello'`).
- Name-registry preview UI: a name-manager dialog listing the cached entries,
  with inline edit and delete commands.

**Out of scope**

- Dynamic named-range formulas (e.g. `=OFFSET(A1,0,0,COUNTA(A:A),1)`) —
  deferred; backend may support them but UI core will not model them.
- Excel "Table" structured references (`Table1[Column]`).

## State (UI core)

The name registry is a workbook fact owned by the backend. UI core stores only
a bounded list for the name-manager dialog and autocomplete hints.

```ts
// bounded list fetched on dialog open or on autocomplete trigger
export const nameRegistryCacheAtom = atom<NamedRange[]>([])
nameRegistryCacheAtom.debugLabel = 'spreadsheet.namedRanges.cache'

// editor state for the name-manager dialog: null when closed
export const nameManagerEditorAtom = atom<NameManagerEditorState | null>(null)
nameManagerEditorAtom.debugLabel = 'spreadsheet.namedRanges.editor'
```

Scale bound: cache total < 500 names (autocomplete only). The cache is never
persisted and is refetched on demand. No per-name atoms; the list is replaced
wholesale.

## Types

```ts
export type NamedRangeScope = 'workbook' | { sheetId: string }

export type NamedRangeRefersTo =
  | { kind: 'range'; sheetId: string; address: string }   // e.g. 'A1:B10'
  | { kind: 'constant'; value: string }                   // e.g. '42' or '"text"'

export interface NamedRange {
  name: string
  scope: NamedRangeScope
  refersTo: NamedRangeRefersTo
}

// CRUD request shapes — all optional on SpreadsheetBackend
export interface ListNamedRangesRequest {
  kind: 'list-named-ranges'
  requestId?: number
  revision?: ProjectionRevision
}

export interface ListNamedRangesResult {
  requestId?: number
  revision?: ProjectionRevision
  names: NamedRange[]
  truncated?: boolean   // true when > scale bound; dialog must warn
}

export interface SetNamedRangeRequest {
  kind: 'set-named-range'
  name: string
  scope: NamedRangeScope
  refersTo: NamedRangeRefersTo
  requestId?: number
  revision?: ProjectionRevision
}

export interface DeleteNamedRangeRequest {
  kind: 'delete-named-range'
  name: string
  scope: NamedRangeScope
  requestId?: number
  revision?: ProjectionRevision
}

export interface NameManagerEditorState {
  status: 'viewing' | 'editing' | 'creating' | 'error'
  draft: NamedRange | null
  error: string | null
}
```

## Backend port

Three optional methods added to `SpreadsheetBackend`:

```ts
listNamedRanges?(request: ListNamedRangesRequest): Promise<ListNamedRangesResult>
setNamedRange?(request: SetNamedRangeRequest): Promise<BackendMutationResult>
deleteNamedRange?(request: DeleteNamedRangeRequest): Promise<BackendMutationResult>
```

All three are optional; adapters that do not implement them cause the UI to hide
the name-manager menu item and skip autocomplete injection.

Names participate in formula parsing entirely inside the backend. The UI core
never resolves a name to a range; it only ferries the raw formula string to the
backend via `setCellInput`.

### `shiftFormulaRefs` must leave name tokens intact

`src/clipboard/index.ts` — `mapFormulaRefs` — currently matches the pattern
`(?:([A-Za-z_][A-Za-z0-9_]*)!)?([A-Za-z]+)(\d+)`. A token such as `Revenue`
matches `letters` group `Revenue` with an empty `digits` group, so
`parseFormulaRefCoord` returns `null` and the token is left unchanged. This
behaviour is **coincidentally correct** today but is not explicitly tested.

The required code change is defensive: before rewriting `letters + digits`
tokens, confirm `digits` is non-empty. Add a guard:

```ts
// inside refPattern replace callback — before parseFormulaRefCoord
if (!digits || digits.length === 0) return full  // name token, leave intact
```

This makes the no-rewrite contract explicit rather than accidental, and keeps
`shiftFormulaRefs` safe when backends emit named references in TSV formula
cells.

## Integration points

- **Formula-bar** (`src/formula-bar/`): when the draft starts with `=` and the
  cursor follows a word boundary, dispatch a name-registry lookup against
  `nameRegistryCacheAtom`. Return a sorted prefix-match list as
  `FormulaBarDiagnostic`-adjacent autocomplete hints. No new atom is required
  in the first iteration; the dialog can supply hints via a derived atom over
  `nameRegistryCacheAtom`.

- **Clipboard** (`src/clipboard/index.ts`): `shiftFormulaRefs` must skip name
  tokens — the defensive guard described above is the required change. Audit
  `test/clipboard.test.ts` for cases where a formula references a name.

- **Editing** (`src/editing/`): cell editor triggers the same prefix-match
  autocomplete as the formula-bar when the input contains `=` and an
  incomplete word token.

- **Menu** (`src/menu/`): add a `'named-ranges.open-manager'` menu intent so
  host adapters can wire the Name Manager dialog command. The intent carries no
  payload; the framework layer opens the dialog via `nameManagerEditorAtom`.

- **Workspace** (`src/workspace/`): the workspace revision metadata can include
  an optional `nameRegistryVersion` field. When this version bumps the cache
  should be invalidated and re-fetched.

## Risks & open questions

- **Name vs cell-range disambiguation**: a token like `AB12` is both a valid
  cell address and a potential name. `shiftFormulaRefs` must not rewrite tokens
  that are registered names. The simplest safe policy is to always pass the raw
  formula string to the backend and let the backend parse it with full name
  context. Confirm that this is the intended contract.

- **Scope resolution order**: sheet-scoped names shadow workbook-scoped names
  with the same string. The UI autocomplete list must reflect this ordering.
  Whether the cache is pre-resolved or whether the UI shows both and marks the
  inactive one is an open decision.

- **Rename cascades**: renaming a name requires finding every cell formula that
  references the old name and rewriting it. This is a backend-side operation;
  the UI core only fires `setNamedRange` and expects the backend to cascade.
  Confirm that the backend mutation result carries a revision bump so the
  visible projection refreshes.

- **Undo of name changes**: CRUD operations on the name registry go through
  `setNamedRange` / `deleteNamedRange`, which are fire-and-forget mutations with
  no undo record in the UI core. If undo support is required, the host adapter
  must record the inverse operation; UI core has no undo stack for name changes.

- **Autocomplete latency**: `nameRegistryCacheAtom` is loaded once on dialog
  open or on first `=` keypress. Stale cache between edits is acceptable for
  autocomplete but may show deleted names. A lightweight cache-bust on
  `nameRegistryVersion` change (workspace integration point above) is the
  recommended mitigation.

- **Invalid name characters**: Excel forbids spaces, most punctuation, and
  names that look like cell references (`A1`, `R1C1`). Validation belongs in
  the backend; the UI core should surface the `BackendMutationResult` error
  string in `NameManagerEditorState.error` without re-implementing the rules.

## Test surface

Primary: `test/named-ranges.test.ts`

Focus areas:

1. **Tokenizer guard** — `shiftFormulaRefs` leaves bare name tokens (`Revenue`,
   `TaxRate`) untouched; does not rewrite tokens like `AB12` that are both a
   valid address and a potential name (document the ambiguity as a known gap).
2. **Cache atom** — `nameRegistryCacheAtom` replaces the list wholesale; no
   stale entries after a fresh `listNamedRanges` response.
3. **Editor state transitions** — `nameManagerEditorAtom` cycles through
   `viewing → editing → viewing` on a successful `setNamedRange` round-trip.
4. **Truncation warning** — when `ListNamedRangesResult.truncated` is true the
   editor state reflects it so the dialog can warn the user.
5. **Backend absent** — when `listNamedRanges` is undefined the cache stays
   empty and no error is thrown.

Supporting: extend `test/clipboard.test.ts` with at least one formula
containing a bare name token to lock in the no-rewrite behaviour.
