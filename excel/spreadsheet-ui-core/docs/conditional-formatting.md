# conditional-formatting

Conditional formatting feature plan for `@einfach/spreadsheet-ui-core`.

---

## Goal

Rules (cell-value comparison, formula, data-bar, color-scale, top/bottom N)
evaluate against cell values within a declared range and produce a
`SpreadsheetCellFormat` override per matching cell. That override is layered on
top of the static cell format already present in `DisplayCell.format`. The
backend owns rule storage and evaluation; the UI core owns the rule editor UI
state (which rule is open, the in-progress draft) and the command intents that
drive CRUD operations on the backend.

---

## Scope

- Declare `ConditionalFormatRule` type variants and `ConditionalFormatScope`.
- Declare `SetConditionalFormatRuleRequest` and
  `RemoveConditionalFormatRuleRequest` backend port methods (both optional).
- Declare `conditionalFormatEditorAtom` for rule editor open/draft state.
- Declare `conditionalFormatRulesAtom` for the bounded list of rules returned
  by the backend for the active sheet (visible-window scope only).
- Define rule priority order: lower index wins (first rule in list takes
  precedence; backend enforces this on evaluation).
- Extend `DisplayCell` with an optional `conditionalFormat` overlay field.
- Specify toolbar entry point (`conditional-formatting` menu intent).
- Cover CRUD intents: create rule, update rule, remove rule, reorder rules.

**Out of scope**

- Icon sets (deferred — needs separate renderer contract).
- Cross-sheet rule sources (rules always scoped to the sheet they are defined on).
- Rule-level undo entries (undo is handled by the general history feature).
- Rendering data-bar or color-scale gradients inside the UI core (host renderer
  responsibility once `conditionalFormat` is provided).

---

## State (UI core)

### Source atoms

**`conditionalFormatEditorAtom`** — `atom<ConditionalFormatEditorState>`

Tracks which rule is open in the editor panel and the current draft. Holds only
the in-progress descriptor, not the full rule list.

```ts
conditionalFormatEditorAtom.debugLabel = 'spreadsheet.conditionalFormat.editor'
```

**`conditionalFormatRulesAtom`** — `atom<ConditionalFormatRulesState>`

Bounded list of rules for the active sheet, fetched via backend projection.
Must not grow unbounded — backend returns only the rules whose scope overlaps
the current visible window.

```ts
conditionalFormatRulesAtom.debugLabel = 'spreadsheet.conditionalFormat.rules'
```

### Derived atoms

None in the first wave. Rule evaluation result is backend-owned; the UI core
reads the merged `DisplayCell.conditionalFormat` from each projection response.

### Command atoms

**`setConditionalFormatRuleAtom`** — `atom(null, (get, set, req: SetConditionalFormatRuleRequest) => void)`

Sends a create-or-update request to the backend. On success the host adapter
refreshes the visible-window projection, which re-delivers `conditionalFormat`
per cell.

```ts
setConditionalFormatRuleAtom.debugLabel = 'spreadsheet.conditionalFormat.setRule'
```

**`removeConditionalFormatRuleAtom`** — `atom(null, (get, set, req: RemoveConditionalFormatRuleRequest) => void)`

Sends a remove request. Backend removes the rule and the next projection
response omits the overlay for previously matched cells.

```ts
removeConditionalFormatRuleAtom.debugLabel = 'spreadsheet.conditionalFormat.removeRule'
```

**`openConditionalFormatEditorAtom`** — `atom(null, (get, set, rule: ConditionalFormatRule | null) => void)`

Opens the editor panel with an existing rule or a blank draft. Sets
`conditionalFormatEditorAtom.open = true` and populates `draft`.

```ts
openConditionalFormatEditorAtom.debugLabel = 'spreadsheet.conditionalFormat.openEditor'
```

**`closeConditionalFormatEditorAtom`** — `atom(null, (get, set) => void)`

Discards any unsaved draft and closes the editor panel.

```ts
closeConditionalFormatEditorAtom.debugLabel = 'spreadsheet.conditionalFormat.closeEditor'
```

### Scale bound

- Rule list is bounded to the active sheet's visible-window overlap; do not
  store all rules for a workbook with thousands of sheets.
- Draft state is a single descriptor — no per-cell atoms.
- `conditionalFormat` overlay is delivered per cell inside `DisplayCell[]`,
  which is already window-bounded by the existing projection contract.

---

## Types

```ts
export type ConditionalFormatRuleId = string

export type ConditionalFormatRuleKind =
  | 'cell-value'
  | 'formula'
  | 'data-bar'
  | 'color-scale'
  | 'top-bottom'

export interface ConditionalFormatScope {
  range: CellRange
}

export interface CellValueRule {
  kind: 'cell-value'
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'not-between'
  value: string
  value2?: string
  format: SpreadsheetCellFormat
}

export interface FormulaRule {
  kind: 'formula'
  formula: string
  format: SpreadsheetCellFormat
}

export interface DataBarRule {
  kind: 'data-bar'
  minColor?: string
  maxColor?: string
}

export interface ColorScaleRule {
  kind: 'color-scale'
  minColor: string
  midColor?: string
  maxColor: string
}

export interface TopBottomRule {
  kind: 'top-bottom'
  direction: 'top' | 'bottom'
  count: number
  percent?: boolean
  format: SpreadsheetCellFormat
}

export type ConditionalFormatRule =
  | CellValueRule
  | FormulaRule
  | DataBarRule
  | ColorScaleRule
  | TopBottomRule

export interface ConditionalFormatRuleEntry {
  id: ConditionalFormatRuleId
  scope: ConditionalFormatScope
  priority: number
  rule: ConditionalFormatRule
}

export interface SetConditionalFormatRuleRequest extends SheetRef {
  kind: 'set-conditional-format-rule'
  ruleId?: ConditionalFormatRuleId
  scope: ConditionalFormatScope
  priority?: number
  rule: ConditionalFormatRule
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface RemoveConditionalFormatRuleRequest extends SheetRef {
  kind: 'remove-conditional-format-rule'
  ruleId: ConditionalFormatRuleId
  requestId?: ProjectionRequestId
  revision?: ProjectionRevision
}

export interface ConditionalFormatRulesState {
  sheetId: string | null
  rules: readonly ConditionalFormatRuleEntry[]
}

export interface ConditionalFormatEditorState {
  open: boolean
  ruleId: ConditionalFormatRuleId | null
  draft: ConditionalFormatRuleEntry | null
}
```

`DisplayCell` gains one optional field:

```ts
// in DisplayCell (backend/types.ts)
conditionalFormat?: SpreadsheetCellFormat
```

`DisplayCell.format` remains the static cell format from workbook data.
`DisplayCell.conditionalFormat` is the already-evaluated overlay returned by
the backend projection. The host renderer layers them: static format first,
conditional format on top (conditional wins where both define the same property).
The UI core does not merge them — that is backend or renderer responsibility.

---

## Backend port

Two optional methods added to `SpreadsheetBackend`:

```ts
setConditionalFormatRule?(
  request: SetConditionalFormatRuleRequest,
): Promise<BackendMutationResult>

removeConditionalFormatRule?(
  request: RemoveConditionalFormatRuleRequest,
): Promise<BackendMutationResult>
```

Both are **optional**. A backend that does not implement them causes the UI
core to treat conditional formatting as unavailable (toolbar entry is disabled,
editor cannot open).

The backend evaluates all rules against cell values during projection and
populates `DisplayCell.conditionalFormat` per matching cell. Rules are evaluated
in ascending `priority` order; the first matching rule for a given cell wins
(stop-on-match semantics). The backend may support continue-on-match as a future
extension but that is not required in the first wave.

Formula rules (`kind: 'formula'`) require the backend formula engine to evaluate
the formula for each cell in the scope — the UI core never evaluates formulas.

---

## Integration points

**Toolbar** — adds a `'conditional-formatting'` entry to `ToolbarSurfaceId` (or
a dedicated menu intent). Opens the rule editor via
`openConditionalFormatEditorAtom`. Toolbar availability follows the same
`selectionKind` + `sheetId` guards as existing format commands.

**Projection** — `DisplayCell.conditionalFormat` is populated by the backend
on every `readVisibleProjection` response for cells where at least one rule
matches. The host renderer reads this field alongside `format`; no new
projection request type is needed.

**Formula-bar** — no impact. Conditional formatting does not affect the formula
displayed for a cell.

**Clipboard** — conditional format rules are **not** copied by default. A copy
operation clones cell values and static formats (`format`); rules remain attached
to their original scope. This avoids rule proliferation from paste. A future
"paste special" option may copy rules explicitly.

**Operations** — when rows or columns are inserted or deleted, the backend must
shift rule scopes accordingly (same contract as static format range tracking).
The UI core emits only `insertRows` / `deleteRows` / `insertColumns` /
`deleteColumns` requests as today; backend scope adjustment is an adapter
responsibility.

**Sheet-tabs** — when the active sheet changes, `conditionalFormatRulesAtom`
is reset to an empty list; the next projection response for the new sheet
populates it.

---

## Risks & open questions

- **Rule evaluation cost on large ranges.** Color-scale and top/bottom rules
  require scanning the full scope to compute min/max before assigning per-cell
  overlays. On a 10 000-row scope this runs every projection tick. Backends
  should cache rule evaluation results and invalidate only on cell mutation or
  rule change, not on every visible-window scroll.

- **Ordering with cell edits and revisions.** A cell edit increments the
  backend revision. If the rule evaluation result is cached at the previous
  revision, the next projection must re-evaluate rules whose scope overlaps the
  edited cell. Define whether `BackendMutationResult.affectedRange` is sufficient
  for scoped invalidation, or whether the backend always re-evaluates all rules.

- **Formula rules need backend evaluation.** `kind: 'formula'` rules cannot be
  evaluated in the UI core. The backend must support formula evaluation in its
  rule engine; backends without a formula engine should reject
  `setConditionalFormatRule` with a formula rule by returning an error result.

- **Layering vs pre-computing.** Two choices: (a) backend pre-merges
  `format` and `conditionalFormat` into a single resolved format; (b) backend
  returns both fields and the renderer layers. Recommendation is (b): keep fields
  separate so the host renderer can distinguish static vs conditional styling
  (useful for rule editor preview). Pre-merging removes that distinction.

- **Undo of rule changes.** Rule CRUD produces `BackendMutationResult` like any
  mutation. If the history feature is wired, a `format.conditional.set` entry
  kind can be added to `HistoryEntryKind`. Define whether undo of a rule change
  restores the old rule or simply removes it — recommend full restore so the
  editor can reflect the undone state.

- **Rule scope drift after structural edits.** Insert/delete operations shift
  cell addresses. If the backend does not adjust rule scopes atomically with the
  mutation, rules may evaluate against wrong ranges until the next explicit rule
  update. Backends must guarantee scope adjustment within the same mutation
  transaction.

---

## Test surface

All tests live in `test/conditional-formatting.test.ts`.

- `conditionalFormatEditorAtom` starts closed with `null` draft.
- `openConditionalFormatEditorAtom(null)` opens editor with blank draft.
- `openConditionalFormatEditorAtom(existingRule)` populates draft from entry.
- `closeConditionalFormatEditorAtom` resets `open` to `false` and clears draft.
- `setConditionalFormatRuleAtom` calls backend `setConditionalFormatRule` with
  correct `SheetRef`, `scope`, and `rule`; verifies backend receives the request.
- `removeConditionalFormatRuleAtom` calls backend `removeConditionalFormatRule`
  with matching `ruleId`.
- Backend returning `undefined` for `setConditionalFormatRule` leaves toolbar
  entry disabled (feature-unavailable path).
- `conditionalFormatRulesAtom` resets when active sheet changes.
- `DisplayCell.conditionalFormat` survives a round-trip through the projection
  response parser without mutation.
- Layering test: verify that when both `format` and `conditionalFormat` define
  `bgColor`, the renderer helper returns the `conditionalFormat` value.
