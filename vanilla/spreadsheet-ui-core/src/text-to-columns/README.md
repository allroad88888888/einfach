# text-to-columns

Owns the 3-step Text to Columns wizard. Splits a single-column selection
into multiple columns by delimiter or fixed-width slice positions, then
emits a single `importCellChunks` plan so undo collapses into one entry.

## State Decision Template

- **Source atoms:**
  - `textToColumnsOpenAtom` — boolean, dialog visibility.
  - `textToColumnsWizardAtom` — discriminated union over step
    (`step-1` | `step-2-delimited` | `step-2-fixed` | `step-3`).
  - `textToColumnsSourceAtom` — the source rows (text + sourceRow index).
    Backed by an atom so the Solid 1.9.12 Provider remount hazard does
    not strand it.
  - `textToColumnsAnchorAtom` / `textToColumnsSheetIdAtom` — sheet + top
    coordinate of the source column.
- **Derived atoms:**
  - `textToColumnsPreviewAtom` — first `TEXT_TO_COLUMNS_PREVIEW_CAP` (100)
    source rows tokenized under the current wizard config. Bounded cache
    cap: **100 rows × 500 total cells** (`TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP`).
    A row that exceeds the remaining budget gets a trailing
    `TEXT_TO_COLUMNS_PREVIEW_TRUNCATION_MARK` (`'…'`); the marker
    counts against the cap so a truncated row emits at most
    `TEXT_TO_COLUMNS_PREVIEW_TOKEN_CAP` cells (marker included). Rows
    past the budget emit an empty `tokens` list (so row anchoring is
    preserved).
- **Commands:**
  - `openTextToColumnsAtom({ sheetId, anchor, rows })`
  - `closeTextToColumnsAtom`
  - `confirmTextToColumnsAtom` — returns a `TextToColumnsCommitPlan` (or
    `null` if not on step-3 / no source). The host adapter forwards the
    plan through `backend.importCellChunks`.

## Wizard state machine

- **Step 1** picks `mode: 'delimited' | 'fixed'`.
- **Step 2 (delimited)** picks delimiter set, `otherChar`,
  `treatConsecutiveAsOne`, `textQualifier`.
- **Step 2 (fixed)** picks `breakpoints: readonly number[]` (character
  offsets from the start of the source string).
- **Step 3** picks per-output-column
  `format: 'general' | 'text' | 'date' | 'skip'`.

Skip-marked columns drop entirely from the import plan. `text` columns
pass `preserveAsText: true` on the import chunk so the backend inserts
the value as a literal string (no numeric inference, no formula parsing).

## Date format limitation

`format: 'date'` is currently routed identically to `'general'` — UI
core stays locale-free, so date parsing is deferred to the backend's
existing input pipeline. The Step 3 select disables the Date option and
surfaces a tooltip ("Date format is not yet supported — values would be
imported as General") so users see the limitation up front. A future
host-supplied `parseDate(input)` port can layer locale-aware parsing on
top without changing this module's atoms.

## Capability gating

The Data menu entry sets `isAvailable: 'capability'` /
`capabilityKey: 'textToColumns'`. The host resolves the key to
`backend.importCellChunks != null`; when the backend omits the port the
menu entry is hidden entirely (matching the Paste Special pattern).

## Backend port

Reuses `importCellChunks`; the source column is overwritten as part of
the same transaction so undo restores the original full text in one
step. No new backend method.

## Mutation gateway gate

`runTextToColumnsFinishAtom` resolves the commit target through
`resolveContentMutationAtom` (`kind: 'import-cell-chunks'`,
`requireIdentityMapping: true`) before allocating a request id. A
protection block or an active display→source row remap fails closed:
lifecycle goes `blocked`, the gateway's structured diagnostic
(`MUTATION_BLOCKED_LOCKED` / `MUTATION_UNMAPPED_ROW`) is recorded, its
message becomes `textToColumnsErrorAtom`, and zero transport is
launched. Identity mapping is required because the frozen commit plan
carries source rows captured under an identity mapping and the single
`importCellChunks` request cannot express a permuted remap.

## Scale

- Preview cap holds at 100 rows even when the source range is 100k tall.
- Full split is deferred to commit; nothing per-cell or per-row is cached
  in atoms.

## Tests

`test/text-to-columns.test.ts`:
- Step-1 default `'delimited'` survives advance.
- `comma + space` with `treatConsecutiveAsOne` collapses runs.
- Text qualifier `"` strips outer quotes and unescapes doubled quotes.
- Fixed-width breakpoints past row length emit empty strings.
- `format: 'skip'` drops a column from the emit plan.
- `format: 'text'` sets `preserveAsText: true` on the emitted chunk.
- Commit returns `null` when wizard is not on step-3.
- Preview cap holds at 100 rows on a 100k source.
