# Solid Excel E2E Test Plan

> Scope: browser-level Playwright coverage for `solid/excel`.
> This plan folds in two parallel read-only reviews: one focused on current
> Playwright infrastructure, one focused on feature-to-e2e coverage mapping.

## Goals

- Protect the real user flows that unit tests cannot cover: focus, keyboard,
  clipboard, sheet tabs, WASM loading, formula bar editing, and cross-sheet UI.
- Keep formula/function correctness mostly in Rust/Jest unit tests; e2e should
  cover representative user paths and integration boundaries.
- Split JS mock demos and WASM-backed demos clearly. Do not treat JS mock gaps
  as Rust engine regressions.
- Make lazy formula behavior observable without accidentally forcing reads.

## Current Coverage

Existing file:

- `solid/excel/e2e/smoke.spec.ts`

Existing scenarios, all on the `Blank` demo backed by `createJSSheet()`:

- cell edit and Enter commit
- simple formula commit
- same-sheet dependency propagation
- undo / redo
- FormulaBar shows formula source for a selected formula cell
- Arrow / Tab / Shift+Tab selection movement

Current Playwright setup:

- `solid/excel/playwright.config.ts`
- Chromium only
- one worker
- Vite web server on port `5174`
- trace on first retry
- `npm run e2e` in `@einfach/solid-excel`

## Current Gaps

- CI does not run Playwright e2e.
- `build:wasm` is not part of e2e startup, so WASM demos can fail on a clean
  checkout without `solid/excel/wasm-pkg`.
- Existing smoke coverage uses JS mock only; it does not cover real WASM formula
  evaluation or `WasmWorkbook`.
- Clipboard e2e is missing, including browser permission setup.
- Range selection is not covered.
- `MultiSheet` tab UI is not covered.
- `3-Sheet Chain` lazy workbook demo is not covered.
- Row/col structural edits have backend/store support but no user-facing UI
  entry, so browser e2e should wait until a toolbar/context menu exists.
- Known bug: Enter commit plus input blur creates duplicate undo entries. Current
  e2e works around this by pressing undo/redo twice.

## Test Principles

1. Prefer one e2e per user workflow, not one e2e per internal method.
2. Keep selectors stable. Existing cells use `td.cell[data-cell-addr="A1"]`.
3. Shared helper functions should live in `solid/excel/e2e/helpers.ts`.
4. Tests that need real formulas should use WASM-backed demos.
5. Tests that validate workbook UI but not formula engine can use JS mock demos.
6. Lazy cache assertions must read cache state before reading the formula cell.
7. Clipboard tests must explicitly grant clipboard permissions.

## Proposed File Layout

```text
solid/excel/e2e/
  helpers.ts
  smoke.spec.ts
  workbook-chain.spec.ts
  formulas-wasm.spec.ts
  formula-bar.spec.ts
  selection-clipboard.spec.ts
  multisheet-ui.spec.ts
```

## Helper API

Create `solid/excel/e2e/helpers.ts`:

```ts
import { expect, type Page } from '@playwright/test'

export function cell(page: Page, addr: string) {
  return page.locator(`td.cell[data-cell-addr="${addr}"]`)
}

export function cellDisplay(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-display')
}

export function cellInput(page: Page, addr: string) {
  return cell(page, addr).locator('.cell-input')
}

export async function gotoDemo(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name }).click()
  await expect(cell(page, 'A1')).toBeVisible()
}

export async function typeIntoCell(page: Page, addr: string, value: string) {
  await cell(page, addr).dblclick()
  const input = cellInput(page, addr)
  await expect(input).toBeVisible()
  await input.fill(value)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
}

export async function selectSheet(page: Page, name: string) {
  await page.getByRole('tab', { name }).click()
  await expect(cell(page, 'A1')).toBeVisible()
}
```

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

### P0.2 CI Wiring

Add CI steps:

```bash
npm run build:wasm -w @einfach/solid-excel
npx playwright install --with-deps chromium
npm run e2e -w @einfach/solid-excel
```

Acceptance:

- CI uploads Playwright traces/screenshots on failure.
- E2E can be run independently from unit tests.

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

E2E starts as **advisory only**:

- CI runs e2e on every push. Failure uploads traces + screenshots.
- CI does NOT block PR merge on e2e failure for the first 2 weeks.
- After 2 weeks of stable runs (no flake / no infrastructure failures),
  promote to PR-blocking.

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

## P1: MultiSheet JS Workbook UI

Create `solid/excel/e2e/multisheet-ui.spec.ts`.

Scenarios:

- Open `Multi-Sheet`.
- Switch `Sheet1`, `Expenses`, `Notes` and assert each sheet's seeded content.
- Edit `Sheet1!A1`, switch to `Expenses`, edit `A1`, switch back and assert
  both sheets kept independent state.
- Click `+`, assert new sheet name and active tab.
- Use dialog handlers for native prompt/confirm:
  - rename sheet
  - duplicate name alert
  - delete current sheet
  - cannot delete last sheet

Explicit non-goal:

- Do not assert cross-sheet formula evaluation in this JS mock demo. That is
  covered by `3-Sheet Chain`.

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

1. Extract e2e helpers and keep existing smoke green.
2. Fix double commit and simplify undo/redo smoke.
3. Add `build:wasm` to e2e startup.
4. Add `workbook-chain.spec.ts`.
5. Add clipboard permission setup and clipboard tests.
6. Add `formulas-wasm.spec.ts`.
7. Add FormulaBar and MultiSheet specs.
8. Wire e2e into CI.

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

## Done Criteria

Hard numbers (so "done" is unambiguous):

- ≥ 8 spec files exist under `solid/excel/e2e/` (smoke + workbook-chain +
  formulas-wasm + formula-bar + selection-clipboard + multisheet-ui +
  render-counter + regression).
- ≥ 50 individual `test(...)` blocks pass locally on a clean checkout.
- `regression.spec.ts` pins ≥ 5 already-fixed bugs (see Regression Spec
  Scope above).
- `workbook-chain.spec.ts` includes ≥ 1 lazy-not-read assertion that
  fails if the cache is read prematurely.
- `selection-clipboard.spec.ts` includes ≥ 1 cross-sheet-name preservation
  assertion via real `navigator.clipboard`.
- `render-counter.spec.ts` has hard `expect(...).toBe(N)` (not `>=`)
  assertions on at least 3 distinct subscription paths.
- CI runs e2e with Chromium, uploads failure artifacts, advisory mode for
  the first 2 weeks then PR-blocking.
- Helpers expose `gotoDemo`, `cell`, `cellDisplay`, `cellInput`,
  `selectSheet`, `typeIntoCell`, `grantClipboard`, `acceptDialog`,
  `guardConsoleErrors`.
- No spec contains a `// TODO: workaround` comment for a fixed bug
  (regression spec entries pin the bugs, working code paths use the fix).
