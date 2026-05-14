# Solid Excel E2E Test Plan

> Scope: browser-level Playwright coverage for `solid/excel`.
> This plan folds in two parallel read-only reviews: one focused on current
> Playwright infrastructure, one focused on feature-to-e2e coverage mapping.

## Current Status (2026-05-14, post-Wave 6.5 virtualized UX hardening)

**23 spec files / 162 active Playwright tests / 0 skipped**. Wave 6.5 targeted gates are
locally green. Status of each
plan section:

| Section | Status | Spec / Notes |
|---|---|---|
| P0.0.1 cache state badge | ✅ | `DemoCrossSheetChain.tsx:43` `data-cache-state="Sheet2!C5"` |
| P0.0.2 lazy console probe | ✅ | `wasm-workbook-store.ts:106` `[lazy-demo] computed Sheet2!C5` |
| P0.1 build:wasm in webServer | ✅ | `playwright.config.ts:41` |
| P0.2 CI wiring | ✅ | `.github/workflows/e2e.yml` advisory mode. Workflow runs build:wasm + playwright + uploads report on failure |
| P0.3 fix double commit | ✅ | `Cell.tsx::commitEdit` + `FormulaBar.tsx::commit` guards |
| P0 Workbook Chain spec | ✅ | `workbook-chain.spec.ts` (7 tests) |
| P0 Existing Blank flows | ✅ | `smoke.spec.ts` retained, helpers extracted |
| P0 Clipboard | ✅ | `selection-clipboard.spec.ts` (9 tests including cross-sheet name preservation) |
| P1 WASM Formula Showcase | ✅ | `formulas-wasm.spec.ts` (14 tests, all passing — Discovered #B fixed) |
| P1 FormulaBar | ✅ | `formula-bar.spec.ts` (10 tests, includes worker-backed formula diagnostics) |
| P1 Formula Functions | ✅ | `formula-functions.spec.ts` (4 tests for `TEXT`, `TODAY`, `NOW`) |
| P1 MultiSheet UI | ✅ | `multisheet-ui.spec.ts` (10 tests). Worker-backed MultiSheet covers seed, tab structure ops, cross-sheet formula result, and lazy debug probe |
| P1 Virtualized UX | ✅ | `context-menu.spec.ts` (5) preserves range on right-click Clear; `million-demo.spec.ts` (10) covers 1M toolbar range-native format and keyboard navigation across the virtual viewport |
| P1 Other Demo Smoke (Budget/Grades/Sales) | ✅ | `demo-budget.spec.ts` (6) + `demo-grades.spec.ts` (6) + `demo-sales.spec.ts` (8) — option A (WASM migration) landed |
| P1 Render Counter | ✅ | `render-counter.spec.ts` (6 strict-delta tests). MutationObserver workaround removed after Discovered #A fix |
| Regression Spec | ✅ | `regression.spec.ts` (7 tests, all passing — Discovered #E.1 + #E.2 both landed) |
| P2 Row/Col structural | □ | Correctly deferred (no UI entry) |
| P2 Performance / lazy viewport | □ | Correctly deferred |

Counts: 23 spec files. 162 active Playwright tests
+ 0 `.skip`. Wave 6.5 targeted local runs use
`NO_PROXY=localhost,127.0.0.1 npm run e2e -- e2e/context-menu.spec.ts` and
`NO_PROXY=localhost,127.0.0.1 npm run e2e -- e2e/million-demo.spec.ts`
(proxy caveat per Discovered #D).

Wave 2 / 3 新增覆盖已纳入本计划（本轮核对）：

- **chunked export**：`worker-workbook.spec.ts` 与 `million-demo.spec.ts` 均覆盖
  `copySelectionTextAsync()` 的 `export_range_tsv_chunks` 路径；
- **bounded import**：`worker-workbook.spec.ts` 覆盖 import chunk 上限、cancel 与
  `IMPORT_CHUNK_TOO_LARGE`；
- **persistence lazy restore**：`worker-workbook.spec.ts` 覆盖
  `snapshotPersistenceV1()` / `restorePersistenceV1()` 后不预热公式，未读时 `eval` 保持 0；
- **observability guardrails**：`observability.spec.ts` 覆盖 1M demo DOM viewport 数量和
  worker `debugCounters()` 的未读公式 eval 计数；
- **file import/backpressure**：`file-import.spec.ts` 覆盖 1M demo CSV/TSV 文件导入、
  视口外公式 lazy read，以及取消导入后 `importSessionCount = 0`；
- **formula diagnostics/functions**：`formula-bar.spec.ts` 覆盖 worker-backed
  `INVALID_FORMULA` / `FORMULA_CYCLE` 诊断展示与清理；`formula-functions.spec.ts`
  覆盖 `TEXT()`、`TODAY()`、`NOW()` 的真实 WASM UI 路径；
- **virtualized UX hardening**：`context-menu.spec.ts` 覆盖右键命中已选 range 时不折叠
  选区，`million-demo.spec.ts` 覆盖 1M demo 真实 toolbar Bold 走 range-native
  `set_format_range`，以及真实键盘跨虚拟视口后 selection/focus 不丢；
- **MCP gate**：Wave 2/3 MCP 记录已落地（导入/取消、range copy、持久化还原）并作为
  本波门禁对齐内容；Wave 4 MCP 记录已补充 DOM/subscription/eval counters；Wave 5 MCP
  记录覆盖文件导入、取消和 console 0 warning/error；Wave 6 追加验证公式诊断、
  `TEXT/TODAY/NOW` 和 console 0 warning/error；Wave 6.5 追加验证 1M toolbar
  range-native 格式化、虚拟视口键盘导航和 range 内右键 Clear。

## Discovered During Implementation

Real issues surfaced during agent work that the original plan didn't
anticipate. Each is actionable with a known fix or follow-up.

### A. Render-counter probe doesn't tick on dependency-driven updates ✅ FIXED

`Cell.tsx::renderCountAttr` now reads `cellValue()` before returning,
so Solid's fine-grained reactivity hooks the accessor into the per-cell
tick signal. The probe ticks once per display update + once per
`<Show>` fallback remount (entering/leaving edit mode).

`render-counter.spec.ts` simplified to single-channel: 50 lines of
`MutationObserver` `addInitScript` removed, all 6 scenarios now use
`helpers.ts::renderCount(page, addr)` directly. All strict
`expect(...).toBe(N)` assertions still hold.

### B. Single-sheet WasmSheet doesn't propagate dependents on source writes ✅ FIXED

**Root cause turned out to be at the JS↔Rust boundary, not the lazy
formula machinery itself**. `JsCallbackListener::on_change` was calling
`self.callback.call0(...)` synchronously inside the `&mut WasmSheet`
borrow. Solid signal bumps fired, but downstream reactive reads via
`get_display` either hit wasm-bindgen's borrow protection or read stale
values before the borrow released — looked exactly like "dep tracking
missing" from the e2e side.

**Fix** (`rust/wasm/src/lib.rs`): defer the JS callback to a microtask
on `wasm32` targets:

```rust
queueMicrotask(callback)   // primary
  → setTimeout(callback, 0) // fallback
  → callback()              // sync fallback (last resort)
```

`Closure::once_into_js` wraps the callback (FnOnce semantics, GC-friendly).
Native target keeps the synchronous path so `cargo test` semantics are
unchanged.

**Validation**:
- `formulas-wasm.spec.ts` chain propagation tests un-skipped, all 14
  scenarios green locally (`F8 7 → G8 14 → H8 28 → I8 84`,
  `A3 10 → C3 100 / D3 300 / E3 -200 / F3 220`).
- Full e2e suite at landing time of the fix: 75 passed + 2 skipped. After
  subsequent batches: 98 passed + 0 skipped（历史快照）。当前统计见文档头部和下文
  Done Criteria。

**Caveat — resolved**: the WASM-side microtask defer is now pinned by
`rust/wasm/tests/web.rs` (5 `#[wasm_bindgen_test]`, see TODO 2.3 ✅).
`wasm-pack test --headless --chrome rust/wasm` exercises the
`queueMicrotask` defer path AND the panic-inject knob (C.10) end-to-end
in a real browser; `wasm-pack test --node rust/wasm` is the fallback
when no chromedriver is available locally.

### C. MultiSheet UI dialog flow differs from plan

The plan assumed `+` opens a `prompt` for the new sheet name. Reality:
`+` auto-picks the next default name via `pickDefaultName()` (no
prompt). Rename / delete go through `SheetTabs.onContextMenu` as a
chained native prompt sequence (action verb prompt → either rename
prompt or delete confirm). Trying to delete the last sheet surfaces a
`window.alert`.

Agent β handled this with an inline `queueDialogs(page, [...])` helper.

**Follow-up**: lift `queueDialogs` into `helpers.ts` so future specs
don't reinvent it.

### D. Local proxy interferes with Playwright webServer

If your shell has `http_proxy=http://127.0.0.1:7897` (or similar),
Playwright's webServer health-check probe gets a 502 from the proxy
intercepting localhost — it skips its own server start and the entire
suite fails confusingly.

**Workaround**: `unset http_proxy https_proxy all_proxy` or set
`NO_PROXY=localhost,127.0.0.1` before `npm run e2e`. Add to
`solid/excel/README.md` if not already there. CI is unaffected.

### E. Skipped regression entries — both now active ✅

- ✅ **subscribe-then-set_formula fires once** — landed via
  `SheetStore.subscriberFireCount(addr)` debug accessor + `DemoBlank`
  conditional `window.__einfachStore` exposure on `?debug=1`.
  `regression.spec.ts` queries fire counts through `page.evaluate`.
  Counter goes 0 → 0 (unrelated A1 write) → 1 (set_formula on the
  previously-empty subscribed B1). Strict equality.
- ✅ **JsCallbackListener panic** — landed via
  `WasmSheet::__debugPanicNextCallback` one-shot flag + `DemoFormulas`
  exposing its WASM-backed store on `window.__einfachStore` in `?debug=1`.
  The arming method sets a thread-local `PANIC_NEXT_CALLBACK` cell;
  `JsCallbackListener::on_change`'s queueMicrotask closure checks +
  consumes it, panicking inside the microtask if armed.
  `regression.spec.ts` arms the flag, mutates a dependency cell,
  asserts the panic message lands on `console.error` AND a subsequent
  set/get on the same WasmSheet still works (the wasm instance survives).

## Goals

- Protect the real user flows that unit tests cannot cover: focus, keyboard,
  clipboard, sheet tabs, WASM loading, formula bar editing, and cross-sheet UI.
- Keep formula/function correctness mostly in Rust/Jest unit tests; e2e should
  cover representative user paths and integration boundaries.
- Split JS mock demos and WASM-backed demos clearly. Do not treat JS mock gaps
  as Rust engine regressions.
- Make lazy formula behavior observable without accidentally forcing reads.

## Current Coverage

23 spec files, 162 active Playwright tests + 0 `.skip`. Landed across the
Wave 6 product hardening batches plus Wave 6.5 virtualized UX hardening.

| Spec file | Tests | Backend |
|---|---|---|
| `smoke.spec.ts` | 7 | JS mock |
| `workbook-chain.spec.ts` | 7 | WASM workbook (`3-Sheet Chain` demo) |
| `formulas-wasm.spec.ts` | 14 | WASM single sheet (`Formulas` demo) |
| `formula-bar.spec.ts` | 10 | mixed |
| `formula-functions.spec.ts` | 4 | WASM single sheet (`Formulas` demo) |
| `context-menu.spec.ts` | 5 | JS mock |
| `format.spec.ts` | 5 | JS mock |
| `i18n.spec.ts` | 5 | mixed |
| `selection-clipboard.spec.ts` | 9 | JS mock (`Blank`) |
| `multisheet-ui.spec.ts` | 10 | worker workbook (`Multi-Sheet` demo) |
| `million-demo.spec.ts` | 10 | worker workbook + 2D virtualized table |
| `range-ops.spec.ts` | 4 | JS mock |
| `undo-redo.spec.ts` | 9 | JS mock |
| `virtualize.spec.ts` | 5 | JS mock + virtualization |
| `render-counter.spec.ts` | 6 | JS mock + `?debug=1` |
| `regression.spec.ts` | 7 | mixed |
| `worker.spec.ts` | 4 | worker-backed sheet |
| `worker-workbook.spec.ts` | 18 | worker workbook RPC |
| `observability.spec.ts` | 2 | mixed |
| `file-import.spec.ts` | 2 | worker workbook + 1M import UI |
| `demo-budget.spec.ts` | 6 | WASM |
| `demo-grades.spec.ts` | 6 | WASM |
| `demo-sales.spec.ts` | 8 | WASM |

Current 1M coverage includes large clear/format/copy range-native paths. The
large format spec now clicks the real toolbar Bold button on a 1M selection and
asserts the worker-backed store uses `set_format_range` without materializing
`selectionAddrs`. The keyboard spec moves from A1 across the initial virtual
viewport with native arrow keys and asserts the target cell remains selected
while DOM cells stay bounded. The large copy spec asserts
`copySelectionTextAsync()` uses
`export_range_tsv_chunks` when the worker-backed sheet exposes it, and that the
legacy one-shot `export_range_tsv` fallback is not called in that path.
`worker-workbook.spec.ts` also checks chunked TSV export preserves formula
source and does not evaluate lazy formulas.

Playwright setup:

- `solid/excel/playwright.config.ts`
- Chromium only, one worker, port `5174`
- Trace on first retry; failure screenshots
- webServer prepends `npm run build:wasm` (handles clean checkouts)
- `npm run e2e -w @einfach/solid-excel`

## Remaining Gaps

These are now-known-not-yet-done items (everything in the plan body is
either ✅ or has a Discovered # entry above):

- **CI wiring (P0.2)**. No `.github/workflows/` runs e2e on push.
- ~~Other Demo Smoke (Budget / Grades / Sales Dashboard)~~ ✅ Resolved
  via option A: all three demos migrated to `createWasmSheet`. Seed
  formulas (SUM / AVG / MAX / MIN / COUNT / growth-rate) now render real
  numbers on first paint. Per-demo smoke tests still TODO but no longer
  blocked by an architecture decision.
- **Render-counter probe needs the 1-line source fix** (Discovered #A) so
  the spec can use the official helper instead of MutationObserver.
- **2 regression entries** (subscribe-once + panic) await source-side
  debug shims (Discovered #E).

## Test Principles

1. Prefer one e2e per user workflow, not one e2e per internal method.
2. Keep selectors stable. Existing cells use `td.cell[data-cell-addr="A1"]`.
3. Shared helper functions should live in `solid/excel/e2e/helpers.ts`.
4. Tests that need real formulas should use WASM-backed demos.
5. Tests that validate workbook UI but not formula engine can use JS mock demos.
6. Lazy cache assertions must read cache state before reading the formula cell.
7. Clipboard tests must explicitly grant clipboard permissions.

## Actual File Layout

```text
solid/excel/e2e/
  helpers.ts                   # cell/cellDisplay/cellInput/gotoDemo/selectSheet/
                               # typeIntoCell/selectCell/expectDisplay/renderCount/
                               # grantClipboard/acceptDialog/guardConsoleErrors/
                               # expectNoConsoleErrors
  smoke.spec.ts                # 7 baseline scenarios on Blank
  workbook-chain.spec.ts       # WASM workbook + lazy-not-read
  formulas-wasm.spec.ts        # WASM single-sheet function showcase
  formula-bar.spec.ts          # FormulaBar source display + edit + parse error
  selection-clipboard.spec.ts  # Shift+Arrow range + Ctrl+C/V/X
  multisheet-ui.spec.ts        # tab switch / + / contextMenu rename+delete
  range-ops.spec.ts            # Delete/Backspace clears range as one undo step
  undo-redo.spec.ts            # float precision + formula source + grouping
  render-counter.spec.ts       # precise subscription proofs (?debug=1)
  regression.spec.ts           # known-fixed bugs pinned in browser
  file-import.spec.ts          # CSV/TSV file import + cancel + lazy formula
```

Diff vs original "Proposed File Layout": added `range-ops`, `undo-redo`,
`render-counter`, `regression` (4 spec files surfaced during coverage
mapping that the original plan didn't enumerate).

## Helper API

Implemented in `solid/excel/e2e/helpers.ts`. Exports:

| Helper | Purpose |
|---|---|
| `cell(page, addr)` | `<td class="cell" data-cell-addr=…>` locator |
| `cellDisplay(page, addr)` | `.cell-display` span inside cell |
| `cellInput(page, addr)` | `.cell-input` (only present in edit mode) |
| `gotoDemo(page, name, query?)` | Open a demo by exact button name; `query` for `?debug=1` |
| `selectSheet(page, name)` | Click a sheet tab in workbook demos |
| `typeIntoCell(page, addr, value)` | Double-click → fill → Enter → wait for unmount |
| `selectCell(page, addr)` | Click + wait for `cell-selected` class |
| `expectDisplay(page, addr, expected)` | Assert `cell-display` text |
| `renderCount(page, addr)` | Read `data-render-count` attr (needs `?debug=1`) |
| `grantClipboard(context)` | Grant `clipboard-read` + `clipboard-write` |
| `acceptDialog(page, text?)` | One-shot dialog handler (text=null dismisses) |
| `guardConsoleErrors(page, extraAllow?)` | Install console.error listener; allowlist `^[vite]` / `^[lazy-demo] ` / React-DevTools nag by default |
| `expectNoConsoleErrors(page)` | Assert no unallowed errors leaked through |

**Helper gap noted in Discovered #C**: `queueDialogs(page, [...])` is
inlined in `multisheet-ui.spec.ts` for the contextMenu chained-prompt
flow. Lift to helpers.ts when a second spec needs it.

## P0.0: Demo Observability Prerequisites

Two assertions in `workbook-chain.spec.ts` reference signals that don't exist
yet in `DemoCrossSheetChain`. Add the surfaces first so the spec is actually
runnable.

### P0.0.1 Cache State Badge

`DemoCrossSheetChain` doesn't render `debug_formula_cache_state` anywhere.
Add a small `data-cache-state` badge per probed cell so e2e can assert the
text without scraping internals.

```tsx
<span data-cache-state={`${sheet}!${addr}`} class="cache-badge">
  {workbookStore.debugCacheState(sheetIdx, addr)}
</span>
```

Acceptance:

- Each probed lazy cell renders one cache badge with text `"dirty"`,
  `"clean"`, `"computing"`, or `"missing"`.
- e2e asserts via `page.locator('[data-cache-state="Sheet2!C5"]').textContent()`.

### P0.0.2 Lazy Compute Console Probe

`DemoCrossSheetChain` doesn't emit any console signal when a formula
actually computes. Add a one-line `console.info` from the workbook store's
`getDisplay` (or eval) path keyed by `[lazy-demo] computed sheet!addr` so
the lazy-not-read assertion in `workbook-chain.spec.ts` has something to
listen for.

Acceptance:

- Reading a clean cell does NOT emit the message (cache hit path).
- Reading a dirty cell emits exactly one `[lazy-demo] computed Sheet2!C5`
  message.
- Production demos that aren't `DemoCrossSheetChain` don't emit it
  (gate on a demo-local debug flag).

## P0: E2E Infrastructure

### P0.1 Build WASM Before E2E

Change `solid/excel/playwright.config.ts` web server command to ensure WASM is
available on clean machines.

Candidate command:

```bash
npm run build:wasm && npm run dev -- --port 5174 --strictPort
```

Acceptance:

- `npm run e2e -w @einfach/solid-excel` works from a clean checkout after
  dependencies are installed.
- WASM-backed demos do not hang on loading because `wasm-pkg` is missing.

### P0.2 CI Wiring (Historical / Deferred)

Historical candidate workflow only. Current user rule forbids editing
`.github/workflows/*` and forbids push/PR until the overall arc is explicitly
released, so CI wiring is **not** the active next step. Keep local Playwright
CLI + MCP records as the blocking gate for this branch.

```yaml
# .github/workflows/e2e.yml
name: e2e
on: [push, pull_request]
jobs:
  playwright:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'pnpm' }
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: wasm32-unknown-unknown }
      - run: cargo install wasm-pack --version 0.13.1
      - run: pnpm install --frozen-lockfile
      - run: npm run build:wasm -w @einfach/solid-excel
      - run: npx playwright install --with-deps chromium
      - run: npm run e2e -w @einfach/solid-excel
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-report
          path: solid/excel/playwright-report/
          retention-days: 14
```

Acceptance:

- Push triggers the workflow; failure uploads
  `playwright-report/` and `test-results/` (traces + screenshots).
- E2E can run independently from unit tests (separate job).
- See "CI Gate Policy" below for advisory-vs-blocking timing.

### P0.3 Fix Double Commit Before Expanding Undo Tests

Known issue: `Cell.commitEdit` runs once from Enter and once from blur.

Acceptance:

- Existing undo/redo e2e no longer needs double shortcut presses.
- A regression test verifies one edit creates one undo entry from the user's
  perspective.

## Cross-Cutting Policies (apply to every spec)

### Console Error Policy

Every spec installs a default `page.on('console', ...)` listener that fails
the test on `console.error`. Allowlist (regex match against `msg.text()`):

- `^\[vite\]` — HMR / connection chatter
- `^\[lazy-demo\] ` — DemoCrossSheetChain probe
- `Download the React DevTools` — third-party noise (irrelevant here, listed
  as the canonical example of why we have an allowlist at all)

Encapsulate in `helpers.ts::guardConsoleErrors(page)` so each spec opts in
with one line.

### CI Gate Policy

Historical policy when workflow edits are allowed. It is not active under the
current no-CI-edit rule.

- CI may run e2e on every push and upload traces + screenshots.
- CI can start advisory, then become PR-blocking after stable green runs.
- Until the user explicitly allows `.github/workflows/*` edits, do not change
  workflow files.

Locally `npm run e2e` is always blocking — flake should surface to the
author before push.

### Regression Spec Scope

`regression.spec.ts` covers bugs that have a known fix in the tree but no
browser-level guard. Initial entries:

1. `Cell.commitEdit` Enter+blur double-fire (TODO 1.2.1) — one keystroke,
   one undo entry.
2. Subscribing to an empty cell, then `set_formula` on it, fires the
   subscriber exactly once.
3. `Workbook::get_cell` cross-sheet refresh does not fire subscribers
   (proves read-vs-notify separation lands in browser too).
4. TODAY/NOW return browser-local time, not UTC drift.
5. JsCallbackListener panic propagates to console without taking down the
   wasm instance.

## P0: Workbook Chain And Lazy Formula

Create `solid/excel/e2e/workbook-chain.spec.ts`.

Scenarios:

1. Initial chain evaluates through three sheets.
   - Open `3-Sheet Chain`.
   - On `Sheet1`, assert `C2 = 13`.
   - Switch to `Sheet2`, assert `C2 = 12`.
   - Switch to `Sheet3`, assert `C2 = 11`.

2. Cross-sheet source update propagates.
   - On `Sheet1`, change `B4` from `10` to `20`.
   - Assert `Sheet1!C2 = 23`.
   - Switch to `Sheet2`, assert `C2 = 22`.
   - Switch to `Sheet3`, assert `C2 = 21`.

3. Independent lazy cell is not computed on Sheet1.
   - Listen for console message `[lazy-demo] computed Sheet2!C5`.
   - Open `3-Sheet Chain` and stay on `Sheet1`.
   - Assert cache text shows `dirty`.
   - Assert no lazy-demo console message was emitted.
   - Switch to `Sheet2`.
   - Assert `C5 = 105`.
   - Assert lazy-demo console message appears once.
   - Assert cache text shows `clean`.

Risks:

- Reading `Sheet2!C5` in the assertion itself computes it. Always assert the
  cache text before switching to Sheet2.
- The demo currently uses a coarse fanout in `wasm-workbook-store.ts`; e2e
  should not assume workbook-wide precise subscriptions yet.

## P0: Existing Blank User Flows

Keep `smoke.spec.ts`, but refactor helpers into `helpers.ts`.

Add or tighten scenarios:

- number edit, text edit, formula edit
- Enter commit
- Escape cancel
- blur commit
- Arrow / Tab / Shift+Tab selection clamp at edges
- Shift+Arrow and Shift+Click range selection
- Delete / Backspace clears selection range and undo restores it

Acceptance:

- Existing smoke stays fast and JS-mock only.
- Undo/redo no longer uses double key presses after double-commit fix.

## P0: Clipboard

Create `solid/excel/e2e/selection-clipboard.spec.ts`.

Required Playwright setup:

```ts
await context.grantPermissions(['clipboard-read', 'clipboard-write'])
```

Scenarios:

- Copy `A1:B2`, paste to `D5`, assert a 2x2 block appears.
- Copy formula `B1 = =A1*2`, paste to `D5`, assert formula source shifts to
  `=C5*2` and displayed value follows.
- Paste external TSV without the `# einfach-clipboard-origin` marker and assert
  formulas paste literally.
- Cut a range, assert source clears, paste target works, undo restores.

Risks:

- `navigator.clipboard` failures are swallowed in UI code. Without permission,
  tests can pass interactions but fail assertions later in a confusing way.

## P1: WASM Formula Showcase

Create `solid/excel/e2e/formulas-wasm.spec.ts`.

Scenarios:

- Open `Formulas`, wait for WASM loading to finish.
- Assert representative cells:
  - arithmetic: `C3 = 13`
  - division by zero: `E4 = #DIV/0!` and has error styling
  - functions: SUM / AVERAGE / COUNT / MIN / MAX outputs
  - IF examples: `B16`, `B17`
  - chain: `G8 -> H8 -> I8`
- Change `F8`, assert `G8`, `H8`, `I8` update.
- Double-click a formula cell and assert the edit input contains formula source,
  not computed display value.

Acceptance:

- This is representative integration coverage only; exhaustive function
  correctness remains in Rust/Jest tests.

## P1: FormulaBar

Create `solid/excel/e2e/formula-bar.spec.ts`.

Scenarios:

- Selecting a formula cell shows source formula in FormulaBar.
- Editing a formula in FormulaBar updates the cell result.
- Selecting a normal value cell shows its plain value.
- Parse error from FormulaBar does not crash the page and surfaces as an error
  cell.
- Switching sheets does not leak the old sheet's selected formula/source into
  the new sheet.

Risk:

- FormulaBar and Table share `store.selection`; sheet remounting can expose stale
  selection bugs.

## P1: MultiSheet JS Workbook UI ✅ (with corrections)

Implemented in `solid/excel/e2e/multisheet-ui.spec.ts`. Original plan
assumed `+` triggers a `prompt`; **reality** (per agent β):

- `+` button is `getByRole('button', { name: 'Add sheet' })`. It auto-picks
  the next default name via `pickDefaultName()`. NO prompt fires.
- Rename / delete are reached via `onContextMenu` on a sheet tab. The menu
  fires a chained sequence of native dialogs: action verb prompt → either
  rename prompt OR delete confirm.
- Trying to delete the last remaining sheet triggers `window.alert`.

Inline `queueDialogs(page, [...])` helper in the spec handles the chained
sequence. **Lift to `helpers.ts`** when a second spec needs it (Discovered #C).

Scenarios actually covered:

- Switch Sheet1 / Expenses / Notes, assert each sheet's seed content.
- Edit Sheet1!A1, switch to Expenses, edit A1, switch back. Independence
  preserved.
- Click `+`, assert "Sheet4" tab appears and is active.
- ContextMenu rename: chained prompts handled by queueDialogs.
- ContextMenu delete (non-last sheet): chained confirm handled.
- Delete-last-sheet rejection: alert dialog accepted; sheet count stays ≥ 1.

Explicit non-goal (unchanged):

- No cross-sheet formula evaluation here — JS mock can't do it. Covered
  by `3-Sheet Chain` workbook-chain spec.

## P1: Other Demo Smoke

Create one small demo smoke file or fold into `smoke.spec.ts`:

- `Budget`
- `Grades`
- `Sales Dashboard`

For each:

- tab loads
- expected header/seed data appears
- one representative edit changes one visible result, if the JS mock supports
  the involved formula

Risk:

- These demos still use `createJSSheet()`. The JS mock does not fully match the
  Rust evaluator. If e2e exposes `#ERROR!` for seeded formulas, decide whether
  to move that demo to WASM or lower the assertion.

## P2: Row/Column Structural Editing

Do not add browser e2e yet unless a real UI entry exists.

When UI lands, add scenarios:

- insert row moves data and retargets formulas
- delete row removes data and turns deleted references into `#REF!`
- insert col / delete col, including multi-letter columns
- structural edits are not assumed undoable until that feature exists

Current coverage should remain in Rust/Jest unit tests.

## P1: Render Counter / Precise Subscriptions

Address-level subscriptions are the architectural headline of this layer.
Verify in browser, not just in jest.

Setup: expose `Cell` render count behind a debug flag — Cell wraps its
display in a `<span data-render-count={count()}>`. A `?debug=1` query
param turns the data attribute on.

Create `solid/excel/e2e/render-counter.spec.ts`.

Scenarios:

- Open `Blank?debug=1`. Set A1=1. Note B1's render count. Set A1=2 (no
  formula reads A1). B1's render count must NOT increase.
- Set B1 = =A1*2. Note B1's render count. Set A1=3. B1 renders exactly
  once more (not N times).
- Set B1 = =A1+A2+A3. Set A1, A2, A3 in a single beginEdit/endEdit. B1
  renders exactly once after endEdit (batch coalesces).

Acceptance:

- Each scenario has a hard `expect(after - before).toBe(N)` assertion. No
  loose `>=`.

## P2: Performance And Viewport Lazy Checks

Optional, not default PR gate:

- seed many formulas
- open a small viewport
- assert unrelated lazy probes stay dirty
- measure console/perf timings only as advisory data

Do not make this flaky path part of the default e2e suite until thresholds are
stable.

## Suggested Execution Order

Original ordering (1–8) is now ✅ through step 7. Step 8 (CI) is the
next ticket. Forward order, post-landing:

1. ✅ Extract e2e helpers and keep existing smoke green.
2. ✅ Fix double commit and simplify undo/redo smoke.
3. ✅ Add `build:wasm` to e2e startup.
4. ✅ Add `workbook-chain.spec.ts`.
5. ✅ Add clipboard permission setup and clipboard tests.
6. ✅ Add `formulas-wasm.spec.ts`.
7. ✅ Add FormulaBar and MultiSheet specs.
8. ⏸ Wire e2e into CI — deferred by current user rule forbidding
   `.github/workflows/*` edits and push/PR. Keep local Playwright CLI + MCP as
   the active gate.
9. ✅ Close 3 outstanding gaps from Done Criteria:
   a. ✅ Fix `Cell.tsx::renderCountAttr` (Discovered #A) → MutationObserver
      workaround removed; `render-counter.spec.ts` now uses the probe
      directly across 6 strict-delta scenarios.
   b. ✅ Cross-sheet-name preservation scenario landed
      (`selection-clipboard.spec.ts`).
   c. ✅ Both source-side debug shims landed:
      - #E.1 `SheetStore.subscriberFireCount` + DemoBlank exposure
      - #E.2 `WasmSheet.__debugPanicNextCallback` + DemoFormulas exposure
      Both `.skip`s in `regression.spec.ts` flipped to active assertions.
10. ✅ "Other Demo Smoke" resolved — Budget / Grades / Sales all migrated
    to `createWasmSheet`. Demo smoke tests per-spec still TODO but
    unblocked.
11. ✅ Discovered #B fixed (microtask defer in `JsCallbackListener`).
    Chain propagation tests un-skipped, all passing.
12. ⏸ Promote e2e CI gate from advisory → PR-blocking only after the user lifts
    the no-`.github/workflows/*` rule.

## Default Commands

Local:

```bash
npm run build:wasm -w @einfach/solid-excel
npm run e2e -w @einfach/solid-excel
```

Targeted:

```bash
npx playwright test -c solid/excel/playwright.config.ts workbook-chain.spec.ts
```

CI:

```bash
npm run build
npm test
npm run build:wasm -w @einfach/solid-excel
npm run e2e -w @einfach/solid-excel
```

## Done Criteria — Live Checklist

Reality check against the plan's hard numbers:

| Criterion | Status | Notes |
|---|---|---|
| ≥ 8 spec files | ✅ | 23 actual |
| ≥ 50 Playwright tests pass locally | ✅ | 162 active, 0 skip |
| regression.spec.ts pins ≥ 5 | ✅ | 7 entries, all active after Discovered #E.1 + #E.2 both landed |
| workbook-chain ≥ 1 lazy-not-read | ✅ | Asserts cache state + console-message capture before switching to Sheet2 |
| selection-clipboard ≥ 1 cross-sheet-name preservation | ✅ | `cross-sheet ref preserves sheet name through copy/paste shift` — B2 `=Data!A1+1` → C3 → `=Data!B2+1` |
| render-counter ≥ 3 strict toBe (no `>=`) | ✅ | 6 strict-delta paths after Discovered #A fix |
| CI runs e2e with artifact upload, advisory→blocking | ⏸ | Deferred by current user rule: do not edit `.github/workflows/*` until release approval |
| Helpers expose the full API | ✅ | All 13 helpers in helpers.ts (see Helper API table) |
| No `// TODO: workaround` for fixed bugs | ✅ | grep clean across e2e/ |

**Outstanding**:

1. CI promotion remains intentionally deferred by the current no-push /
   no-`.github/workflows/*` rule.

MCP/CI 保持不改 `.github/workflows/*` 的当前用户规则，门禁以 `e2e` 文档同步和记录为主。
