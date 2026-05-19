# Wave 8 — Formula extension + Range export

## Purpose

Lift the Rust formula engine and `@einfach/spreadsheet-ui-core` to Luckysheet
parity on two axes:

1. **Formula extensibility** — `REMOTE("https://api…", args…)` resolves via a
   host async callback; `registerFormula("MYFN", fn)` registers sync/async user
   functions. The engine routes both through a single *pending* return path.
2. **Visual export** — save or copy a selection as PNG / HTML / Markdown.

The wave also closes the dynamic-array / spill gap (`FILTER`, `SORT`,
`UNIQUE`, `SEQUENCE`, `RANDARRAY`, implicit intersection). Inherited
constraints unchanged: data stays in the worker, UI core holds only bounded
atom state, large payloads cross chunked RPCs, unobserved formulas remain
lazy.

## Sub-feature inventory

| Sub-feature | Engine | WASM | Worker | Adapter | UI core |
|---|---|---|---|---|---|
| 8.1 Remote formulas | `Value::Pending` + reactor | pending drain / fulfill | `drain-pending`, `fulfill-pending` | `registerRemoteResolver` | `remoteFormulaPendingAtom` |
| 8.2 Custom formulas | host-call fallback in `eval_func` | name registry bridge | `evaluate-custom-formula` | `registerCustomFormula` | `customFormulaRegistryAtom` |
| 8.3 Array / spill | `Value::Array`, spill writer | array marshalling | spill-aware mutation result | spill diagnostics | `spillStateAtom` |
| 8.4 Range screenshot | none | none | optional `export-range-png` | `exportRangeAsImage` | `rangeImageExportAtom` |
| 8.5 Copy as HTML / PNG / MD | none | none | HTML / Markdown encoders | extends copy intent | `clipboardWritableFormatsAtom` |

---

## 8.1 Remote formulas

### Engine: pending value type + reactor pattern

`Value` (in `rust/core/src/atom.rs`) gains `Pending(PendingId)`. `PendingId`
is a `u64` minted by `Workbook::next_pending_id()` and stored in
`pending_requests: HashMap<PendingId, PendingRequest { kind: Remote | Custom,
name, args }>` on the workbook.

`eval_func` (in `rust/excel-core/src/eval.rs`) gets a `"REMOTE"` arm that
evaluates args, calls `provider.register_pending(req) -> PendingId`, and
returns `Value::Pending(id)`. `EvalProvider` is extended accordingly.

`FormulaCache` (in `rust/excel-core/src/sheet.rs`) grows a
`Pending(PendingId)` state alongside `Dirty | Computing | Clean(Value)`.
When eval yields `Value::Pending(id)` the cache flips to `Pending(id)` and
the engine emits a `pending-registered` notification. When the host calls
`Workbook::fulfill_pending(id, value)` the engine flips affected cells to
`Dirty`, runs normal back-dep invalidation, and emits `pending-resolved`
with affected coords.

Fulfillment is the only mutation that originates outside Rust without a user
edit; it MUST flow through the same revision pipeline as a cell write so the
projection layer revs.

### WASM bridge changes

`rust/wasm/src/lib.rs` adds:

- `Workbook.takePendingRequests()` — drains newly registered pendings as
  `{ id, kind: 'remote' | 'custom', name, args: ValueWire[] }`.
- `Workbook.fulfillPending(id, value)` — host posts the resolved value;
  returns recomputed cells (subject to lazy eval — only observed cells run).
- `Workbook.rejectPending(id, errorKind, message?)` — surfaces `#REMOTE!`,
  `#NAME?`, `#VALUE!`, or timeout.

`ValueWire` is extended with `{ kind: 'pending', id }` so projection display
cells can carry pending sentinels.

### Worker protocol additions

`solid/excel/src-vnext/adapter/worker-protocol.ts` adds three request kinds:
`drain-pending` (returns `pending: PendingFormulaWire[]`),
`fulfill-pending { id, value }`, and
`reject-pending { id, error: 'remote-error' | 'remote-timeout' | 'name' |
'value', message? }`. The worker forwards engine `pending-resolved`
notifications to the main thread as projection invalidations for the
affected coords.

### Adapter: REMOTE() recognition + host callback registration

```ts
backend.registerRemoteResolver(
  resolver: (req: { url: string; args: unknown[]; pendingId: number }) =>
    Promise<ValueWire>,
)
```

The adapter drains pendings on each projection revision tick (or via a push
channel — see Risks). For each `kind: 'remote'`, it invokes the resolver and
calls `fulfillPending` / `rejectPending`. If no resolver is registered, the
adapter auto-rejects with `#NAME?` after one tick.

### Atom changes

`vanilla/spreadsheet-ui-core/src/formula-remote/atoms.ts`:

- `remoteFormulaPendingAtom: atom<Map<PendingId, RemotePendingDescriptor>>`,
  bounded by `MAX_REMOTE_PENDING = 256`; excess auto-rejects.
- `remoteFormulaStatusAtom: atom<'idle' | 'streaming' | 'error'>`.
- `registerRemoteResolverAtom` (write-only) — flags resolver presence; the
  resolver function lives in adapter scope, not in atom state.
- `resolveRemoteFormulaAtom(id, value)` (write-only).

`RemotePendingDescriptor` is minimal coord context: `{ id, sheetId, addr,
urlPreview, startedAt }`. Args, full URL, and response body stay outside the
UI core.

### Test plan

`test/formula-remote.test.ts`:

- Initial atom empty; first pending advances status to `'streaming'`.
- Resolving the last pending returns to `'idle'`.
- Beyond `MAX_REMOTE_PENDING`, new entries auto-reject.
- Engine: `=REMOTE("…")` + `fulfill_pending(id, Number(42))` makes the cell
  read `42` and dirties downstream formulas.
- Engine: `A1 = REMOTE(…)`, `A2 = A1 + 1` — `A2` returns `Pending(id_a1)`
  until A1 resolves (no spurious cycle error).
- Reject path propagates `#REMOTE!` to cell and downstream.

### Risks

- **Cycle × pending.** A `Pending` read inside a `Computing` ancestor
  propagates `Pending`, not `#CYCLE!`; the cycle guard only fires on
  re-entry to the same address.
- **Timeouts** live in the adapter (engine has no clock). Default 30 s.
- **`#REMOTE!`** is a new `ValueError::Remote`; update all `Display` paths.
- **Pending storm.** Volatile + REMOTE could re-issue a new id per
  recompute. Hash `(name, args)` and reuse the id when in flight.
- **Persistence.** Pending state is RAM-only; reloads re-issue requests.

---

## 8.2 Custom formulas

### Engine: function-name lookup with host fallback

Today `eval_func` ends with `_ => Value::Error(ValueError::InvalidName)`
(eval.rs:1297). Wave 8 replaces it with a call to
`provider.host_call(name, args) -> Option<Value>`, falling back to
`InvalidName` when `None`. The default impl returns `None` (preserves
single-sheet shims). `WorkbookEvalProvider` checks a
`host_formulas: HashSet<String>` registry; on match it evaluates args,
registers `PendingRequest { kind: Custom, name, args }`, and returns
`Value::Pending(id)`.

Sync-mode custom functions take a faster path: when the host pre-declares a
handler as sync, the worker invokes it inline (worker-only — main thread
can't block on sync JS). Sync handlers must not call back into the workbook
(no mutations, no `get_cell`).

### WASM bridge: callback registration

```ts
workbook.registerCustomFormulaName(name: string, asyncMode: boolean)
workbook.unregisterCustomFormulaName(name: string)
```

The bridge owns only the name set + async flag. Handlers stay on the JS
side. Sync mode is worker-only.

### Worker protocol: evaluateCustomFormula RPC

Worker adds `evaluate-custom-formula { name, args: ValueWire[], pendingId }`
and the matching result with `{ pendingId, value: ValueWire }`. Async
handlers route through the standard pending channel: worker posts the
request, main thread runs the handler (sync or Promise), result posts back
via `fulfill-pending`.

### Atom: customFormulaRegistryAtom

`src/formula-custom/atoms.ts` exports
`customFormulaRegistryAtom: atom<Record<string, CustomFormulaDescriptor>>({})`
where `CustomFormulaDescriptor = { name; mode: 'sync' | 'async'; description? }`.
Metadata only — handlers live in adapter scope keyed by name. Drives
formula-bar autocomplete and a help surface. Commands:
`registerCustomFormulaAtom`, `unregisterCustomFormulaAtom`. Adapter mirrors
changes to the worker via `registerCustomFormulaName`.

### Sync vs async return values

A handler may return `value | Promise<value>`. Sync-registered handler with
non-thenable return → `fulfill-pending` immediately (still through the
pending channel; engine path stays unified). Async return → normal pending
flow. Sync-registered handler returning a Promise → diagnostic, treat as
async.

### Test plan

`test/formula-custom.test.ts`:

- Initial registry empty; register / replace / unregister behave correctly.
- Engine: with `MYFN` registered, `=MYFN(1,2)` produces `Value::Pending`
  rather than `#NAME?`. Without registration, still `#NAME?` (no regression).
- Sync handler returning `42` → cell reads `42`.
- Async handler returning `Promise.resolve(42)` → cell `#LOADING!` → `42`.
- Handler throws or rejects → cell `#VALUE!`.

### Risks

- **No sandbox.** Handlers run in the host realm with full DOM / network
  access. Trusted-code-only in Wave 8.
- **Purity.** Handlers reading `Date.now()` re-run only when inputs change.
  Descriptor MAY grow `volatile: true`, mirroring `NOW()` / `TODAY()`.
- **Recursion.** Handlers receive *resolved* arg values; reading further
  cells from a handler is unsupported in Wave 8.
- **Name collisions** with built-ins → registration rejected with diagnostic;
  built-ins always win.

---

## 8.3 Array / matrix enhancements

### Spill detection

Engine adds `Value::Array(Vec<Vec<Value>>)` for in-cell array results.
`Sheet::spill_array(anchor, array)`:

1. Compute the target rectangle from `array` dimensions.
2. For each non-anchor target, check that it is empty, not part of a merged
   range, and not a spill cell of another anchor.
3. Any collision → anchor reads `#SPILL!` (`ValueError::Spill`), no writes.
4. Otherwise, mark each spill cell with `SpillRecord { anchor, offset }`;
   reading a spill cell returns `array[offset.row][offset.col]`.

### Dynamic array functions (FILTER / SORT / UNIQUE / SEQUENCE / RANDARRAY)

New `eval_func` arms; each returns `Value::Array`. Output size is bounded by
`MAX_DYNAMIC_ARRAY_CELLS = 100_000` (beyond → `Value::Error(Overflow)`).
Inputs use the existing `for_each_arg_value` streaming. `SORT` and `UNIQUE`
buffer locally (algorithmic requirement).

### Implicit intersection (`@`)

Parser adds `Expr::Implicit(Box<Expr>)`. Eval: if the inner expression is
`Value::Array`, return the top-left cell; otherwise return unchanged. Lets
legacy formulas survive when an arg now returns an array.

### Engine impact (the largest piece of the wave)

- New `Value::Array` ripples across every `match v` in `eval.rs`,
  `workbook.rs`, and the WASM bridge. First pass: stub-route `Array` to
  `#VALUE!` everywhere not yet updated.
- `Sheet::commit_formula_result` must also write into
  `spill_cells: HashMap<CellAddress, SpillRecord>` and invalidate adjacent
  cells on shrink.
- Inserting / deleting rows or columns through a spill region collapses the
  spill (anchor becomes `#SPILL!`) — same hook surface as merge handling.

### Test plan

`test/formula-array.test.ts` and Rust unit tests:

- `=SEQUENCE(3,2)` spills to a 3×2 region.
- `=FILTER(A1:A10, B1:B10>5)` returns matching rows.
- `=SORT`, `=UNIQUE`, `=RANDARRAY` (deterministic seed in tests).
- Spill collision before eval → `#SPILL!`; user writes into spill after
  eval → spill collapses.
- Insert row inside spill region collapses it.
- `=@SEQUENCE(3,1)` returns first element.
- `=SEQUENCE(1_000_000)` returns `#NUM!`.

### Risks

- **Compatibility.** Spill only when the formula text is the cell's whole
  body AND result is `Array` (matches Excel semantics; legacy
  `=A1:A10*B1:B10` keeps `#VALUE!` outside that context).
- **Storage.** `spill_cells` cost is linear in spilled cell count; spill
  cells live in back-deps so upstream writes invalidate the anchor.
- **Undo.** Must restore anchor *and* every spill cell — the undo journaller
  enumerates spill cells before clearing the anchor.

---

## 8.4 Range screenshot

### Canvas-first path (assuming Wave 5 canvas overlay landed)

1. Look up the sheet's canvas renderer via the host adapter.
2. Render the target `CellRange` into an `OffscreenCanvas` at full logical
   resolution (no viewport clipping).
3. Walk row heights × column widths to size the bitmap, then draw displayed
   cells (text, fill, borders, CF layers, merged-cell overlays).
4. Return a `Blob` (PNG) or data URL.

### DOM fallback path

For DOM-only hosts: wrap `html2canvas` / `dom-to-image-more`. Scroll the
range into view (or tile-render off-screen for oversized ranges) and
snapshot the DOM subtree. Best-effort only — CF, custom paint, and overlays
beyond the cell flow may render incorrectly. Result advertises
`quality: 'canvas' | 'dom'`.

### Backend method signature

Optional method on `SpreadsheetBackend`:
`exportRangeAsImage?(request) -> Promise<result>`. Request shape extends
`SheetRef` with `kind: 'export-range-as-image'`, `range: CellRange`,
`format: 'png' | 'jpeg' | 'webp'`, `scale?` (1 = CSS px, 2 = retina),
`background?: 'sheet' | 'white' | 'transparent'`, and the usual
`requestId` / `revision`. Result returns `blob: Blob`, `width`, `height`,
and `quality: 'canvas' | 'dom'`. When absent the UI core disables export
commands.

### UI integration

- **Toolbar** — new "Screenshot Range" button gated on backend support.
- **Context menu** — "Save as image…" on a selected range (reuses
  `menu/types.ts`).
- **Atom** — `rangeImageExportAtom: atom<'idle' | 'rendering' | 'ready' |
  'error'>`; on `ready` carries a Blob URL with a host-managed
  `URL.revokeObjectURL` deadline.

### Test plan

`test/range-image-export.test.ts`:

- Initial `'idle'`; trigger → `'rendering'` → `'ready'`.
- Backend rejection → `'error'`.
- UI core never touches `URL.createObjectURL` itself (no DOM).
- Backend absent → export commands are no-ops.

E2E in `solid/excel`: export `A1:D10` on a deterministic seed; assert blob
length > 0 and dimensions match
`(sum-of-col-widths × sum-of-row-heights × scale)`. Pixel-perfect parity
with Excel is **not** a goal.

### Risks

- **Font / image / CF parity.** Canvas vs DOM paths diverge on CF gradients,
  custom number formats, ligatured fonts. Document; do not promise parity.
- **Large ranges.** `MAX_EXPORT_PIXELS = 100_000_000` cap; beyond → reject
  `'too-large'`.
- **Off-DOM ranges.** Rendering outside the viewport requires off-screen
  render or canvas path; document the requirement per `quality`.
- **Privacy.** Confirm range before producing the image.

---

## 8.5 Copy as HTML / image / markdown

### Clipboard write contract

`src/clipboard/atoms.ts` adds
`ClipboardFormat = 'tsv' | 'html' | 'png' | 'markdown'`,
`clipboardWritableFormatsAtom` (default `['tsv', 'html']`),
`clipboardLastCopyFormatAtom`, and write-only
`copyAsFormatAtom(format)`. `'png'` appears only when `exportRangeAsImage`
is implemented; `'markdown'` only when `exportRangeMarkdown` (new optional)
is. The list is the single source of truth for the right-click menu and
keyboard accelerator behaviour.

`copyAsFormatAtom` dispatches a `ClipboardWriteIntent { format, range,
requestId }` for the host adapter, which:

- `tsv` / `html` → `exportRangeTsv` (existing) or `exportRangeHtml` (new);
  `navigator.clipboard.write([new ClipboardItem({ … })])` carrying both
  `text/plain` and `text/html` when feasible (Ctrl+C default behaviour
  unchanged).
- `png` → `exportRangeAsImage`, then `clipboard.write` with `image/png`.
- `markdown` → `exportRangeMarkdown`, written as `text/plain`.

### Right-click menu integration

`menu/types.ts` gains `'clipboard.copyAs.html'`, `'clipboard.copyAs.png'`,
`'clipboard.copyAs.markdown'`. Visibility follows
`clipboardWritableFormatsAtom`. Default Ctrl+C continues to write tsv + html
together when both are available (matches Google Sheets / Excel desktop).

### Test plan

`test/clipboard-formats.test.ts`:

- Default `clipboardWritableFormatsAtom` = `['tsv', 'html']`.
- Backend advertises `exportRangeAsImage` → `'png'` appears.
- `copyAsFormatAtom('markdown')` with no backend → no-op + diagnostic.
- `copyAsFormatAtom('png')` emits intent with `format: 'png'`.
- Menu visibility follows the writable formats atom.

### Risks

- **Clipboard API permissions.** Browsers gate `clipboard.write` on user
  gesture; some Safari versions reject `image/png` `ClipboardItem` from
  `Blob` — fall back to download.
- **HTML format.** Excel / Sheets paste needs both `text/html` and a
  companion `text/plain`; UI core just declares intent.
- **Markdown dialects.** GFM tables can't carry merged cells or multi-line
  values; encoder collapses newlines and documents the loss.
- **Large selection.** Reuse `MAX_EXPORT_PIXELS` for PNG copy.

---

## File impact estimate

Rust engine (~1460 LOC): `rust/core/src/atom.rs` (~80, new `Value`
variants + `ValueError::Remote`, `ValueError::Spill`),
`rust/excel-core/src/eval.rs` (~600, `REMOTE`, dynamic-array funcs,
host-call fallback, array propagation), `rust/excel-core/src/formula.rs`
(~80, `Expr::Implicit`), `rust/excel-core/src/sheet.rs` (~250, spill
writer, pending cache), `rust/excel-core/src/workbook.rs` (~200, pending +
host registries), `rust/wasm/src/lib.rs` (~250, drain / fulfill / reject,
array wire).

Adapter (~370 LOC): `worker-protocol.ts` (~120), `worker-workbook-backend.ts`
(~250).

UI core (~670 LOC): new `formula-remote/`, `formula-custom/`,
`array-spill/`, `range-image/` modules + `clipboard/atoms.ts` extensions.

Tests: ~1500 LOC across Rust unit tests, Jest, and E2E.

Total estimate: ~4000 LOC engine + bridge, ~1000 LOC UI core, ~1500 LOC
tests.

## Test impact

- Rust: new `mod pending_tests` and `mod spill_tests` alongside existing
  `mod tests` in `eval.rs` and `sheet.rs`.
- UI core: one Jest file per new module under `test/`.
- E2E (`solid/excel/e2e/`): `formula-remote.spec.ts`, `formula-custom.spec.ts`,
  `array-spill.spec.ts`, `range-image-export.spec.ts`.

## Risks and unknowns

- **Engine-impact magnitude.** `Value::Pending` + `Value::Array` ripple
  across every `match v`. Land the enum variants first with stub arms
  (`Pending` / `Array` → `#VALUE!` where not yet handled) so the rest of
  the wave can iterate without leaving the engine half-built.
- **Lazy-eval interaction.** A fulfilled pending marks only itself dirty;
  downstream cells stay lazy until observed (matches Wave 6 guarantee).
- **Cycle × pending × array** is a three-axis interaction; reserve a
  half-wave for adversarial test generation.
- **Browser compatibility.** Clipboard `image/png` write and
  `OffscreenCanvas` rendering have Safari quirks; decide download vs
  diagnostic fallback.
- **Schedule.** Heaviest engine-side wave since the lazy-eval rewrite —
  comparable to Wave 4's workbook split. No concurrent engine work.

## Out of scope

- `.xlsx`, `.ods`, and PDF export beyond print preview — separate
  file-format arc.
- Server-side persistence of pending state across reloads.
- Sandbox / capability model for custom formulas — Wave 8 trusts the host's
  JS realm.
- Animation / volatility heuristics for `RANDARRAY` and `NOW()` beyond the
  existing volatile-formula path.
