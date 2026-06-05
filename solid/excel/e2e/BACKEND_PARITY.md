# vNext e2e — Backend Parity Matrix

Last full audited: 2026-06-05 (post-500-fn-parity arc; full 59-spec audit, dual project run)
Prior full audit: 2026-05-28; targeted 2026-05-29 fix landed
`snapshotPersistenceV1.sizes` on TS.

## Summary (full run, both projects)

| Project | Passed | Failed | Skipped (in spec) | Total |
|---------|-------:|-------:|------------------:|------:|
| `wasm`  |  **465** | **21** |                29 |   515 |
| `ts`    |  **461** | **25** |                29 |   515 |

**Δ since 2026-05-28 baseline** (wasm 462/24/29 ; ts 460/26/29):
- WASM: +3 pass / −3 fail (3 specs moved red → green).
- TS: +1 pass / −1 fail (the `snapshotPersistenceV1.sizes` 2 specs moved green
  via the 2026-05-29 targeted fix; a few worker-backend behaviors shifted in
  both directions during the 500-fn / evaluator-aware arc).

**Δ between projects after this audit:** TS shows 4 more failures than WASM.
The TS-only failures cluster in `vnext-worker-backend.spec.ts` (lazy 3-sheet
chain rendering, sparse range chunked snapshots, paste large TSV through
worker bulk import) plus `formulas-wasm.spec.ts` (MIN/MAX initial render) and
`smoke.spec.ts` (formula commit display). These are surface-area gaps where
the TS worker's RPC sequence or rendering signal differs from the Rust
worker's, not formula-engine bugs.

Out of 59 spec files:
- ~49 pass cleanly on **both** projects.
- ~9 have pre-existing UI failures that reproduce on both projects (partially
  red, but identically red — not a parity issue; cluster in
  `audit-format.spec.ts` as the largest at 9 fails).
- 1 (`vnext-worker-backend.spec.ts`) has the residual TS-only gap.

The audit reads `?backend=ts` and `?backend=wasm` from the Playwright project
name via `gotoRoot(page)` / `withEnglishLocale()` helpers. Only the
`VNextWorkerDemo` (nav-tab `vnext-worker`) consults that query string —
every other demo is hard-wired to a specific backend, so the dual-project
run produces identical results for those specs.

## Projects

The Playwright config (`playwright.config.ts`) defines two projects, both
running the same chromium device. They differ only in the baseURL query string:

- `wasm` — baseURL `http://localhost:5174/?backend=wasm` (Rust workbook in a
  Web Worker, the default everywhere).
- `ts`   — baseURL `http://localhost:5174/?backend=ts` (`@einfach/excel-core-ts`
  in a Web Worker, the F1/F2 TS port).

The `?backend=` selector is only consulted by `VNextWorkerDemo`
(`src-vnext/demos/VNextWorkerDemo.tsx::readBackendChoice`). Every other demo
(legacy `Blank` / `Formulas` / `Multi-Sheet` / `1M Cells`, the static
`VNextSmokeDemo`, the static `VNextWave5Demo`, and the dedicated
`VNextWorkerTsDemo`) is hard-wired to its own backend and ignores the query
parameter — so specs that exercise those demos run identically on both
projects.

## Running

```bash
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY \
  && NO_PROXY=localhost,127.0.0.1 \
  npx playwright test --project=wasm   # or --project=ts
```

The proxy unset is required when the shell has `http_proxy=http://127.0.0.1:7897`
or similar — Playwright's `webServer` health probe goes through the proxy,
which 502s back as "server up", so the dev server is never actually started
and every test hangs. `NO_PROXY` exempts the loopback target.

## Helper preserves the project query

`e2e/helpers.ts` defines two URL builders that automatically append
`backend=<project>` to every navigation:

- `gotoRoot(page, extra?)` — replaces `page.goto('/')` and `page.goto('/?debug=1')`.
- `withEnglishLocale(query?)` — appends `locale=en` and `backend=` together for
  legacy specs that drive the i18n catalog.

These read `test.info().project.name` lazily, so a third project added later
(or a single-project local run) degrades cleanly: the helper just omits the
`backend=` param.

## Specs by category (full matrix)

Every spec was run against both `--project=wasm` and `--project=ts`. Spec
counts are tests per file from `grep -cE '^\\s*test\\(' on each file.

### Pass on both projects — backend-agnostic surfaces (45 specs)

These specs exercise demos that ignore `?backend=` (static Wave5 demo, legacy
gotoDemo, dedicated TS demo, or the static VNextSmokeDemo). They run
identically on both projects, so all results below match between the two
runs. Each entry annotates which demo it uses, and how many tests it has.

#### Static `VNextWave5Demo` (nav-tab `vnext-wave5`)

The Wave5 demo embeds a static formula evaluator and ignores `?backend=`.
Results are identical on both projects.

- `audit-clipboard.spec.ts` (9 tests; 2 pre-existing test.skip — pass on both)
- `audit-history.spec.ts` (10 tests — pass on both)
- `audit-structural.spec.ts` (10 tests; 2 pre-existing test.skip — pass on both)
- `copy-as.spec.ts` (7 tests; 3 pre-existing test.skip — 1 pre-existing fail on both)
- `formula-flow.spec.ts` (26 tests — pass on both)
- `freeze-panes.spec.ts` (9 tests — pass on both)
- `go-to.spec.ts` (11 tests — 1 pre-existing fail on both)
- `paste-special.spec.ts` (6 tests — 2 pre-existing fail on both)
- `remove-duplicates.spec.ts` (8 tests — 2 pre-existing fail on both)
- `text-to-columns.spec.ts` (7 tests — 1 pre-existing fail on both)
- `toolbar-alignment.spec.ts` (5 tests — pass on both)
- `toolbar-borders.spec.ts` (7 tests — pass on both)
- `toolbar-buttons.spec.ts` (39 tests; many pre-existing test.skip — 2 pre-existing fail on both)
- `toolbar-clear-format.spec.ts` (3 tests — pass on both)
- `toolbar-colors.spec.ts` (5 tests — pass on both)
- `toolbar-comment.spec.ts` (4 tests — pass on both)
- `toolbar-conditional-format.spec.ts` (4 tests — pass on both)
- `toolbar-data-validation.spec.ts` (4 tests — pass on both)
- `toolbar-filter-sort.spec.ts` (5 tests — pass on both)
- `toolbar-find-replace.spec.ts` (7 tests — pass on both)
- `toolbar-font-family.spec.ts` (4 tests — pass on both)
- `toolbar-font-size.spec.ts` (4 tests — pass on both)
- `toolbar-format-painter.spec.ts` (5 tests — pass on both)
- `toolbar-history.spec.ts` (2 tests — pass on both)
- `toolbar-merge.spec.ts` (7 tests — pass on both)
- `toolbar-more-number-formats.spec.ts` (4 tests — pass on both)
- `toolbar-name-manager.spec.ts` (5 tests — pass on both)
- `toolbar-number-format.spec.ts` (7 tests — pass on both)
- `toolbar-text-style.spec.ts` (1 test — pass on both)
- `audit-format.spec.ts` (51 tests — 9 pre-existing fail on both; the
  largest cluster of UI bugs)
- `vnext-smoke.spec.ts` (19 tests — 2 pre-existing fail on both)
- `vnext-wave5.spec.ts` (26 tests — 1 pre-existing fail on both)

#### Legacy `gotoDemo` (Blank / Formulas / Multi-Sheet / 1M Cells / etc.)

These legacy demos boot the WASM workbook directly and ignore `?backend=`.
Run identically on both projects.

- `context-menu.spec.ts` (5 tests)
- `demo-budget.spec.ts` (6 tests)
- `demo-grades.spec.ts` (6 tests)
- `demo-sales.spec.ts` (8 tests)
- `file-import.spec.ts` (2 tests)
- `formula-bar.spec.ts` (10 tests)
- `formula-functions.spec.ts` (3 tests)
- `formulas-wasm.spec.ts` (14 tests)
- `i18n.spec.ts` (5 tests)
- `million-demo.spec.ts` (10 tests)
- `multisheet-ui.spec.ts` (10 tests)
- `observability.spec.ts` (2 tests)
- `range-ops.spec.ts` (4 tests)
- `regression.spec.ts` (6 tests)
- `render-counter.spec.ts` (6 tests)
- `selection-clipboard.spec.ts` (9 tests)
- `smoke.spec.ts` (7 tests)
- `undo-redo.spec.ts` (9 tests)
- `virtualize.spec.ts` (5 tests)
- `workbook-chain.spec.ts` (7 tests)
- `worker.spec.ts` (4 tests)
- `worker-workbook.spec.ts` (18 tests) — direct `wasm-workbook-proxy` import,
  so both projects exercise the same Rust workbook.
- `format.spec.ts` (5 tests) — legacy `withEnglishLocale` direct nav, no
  vNext nav tab.

#### Dedicated TS / Worker demos

- `vnext-worker-ts.spec.ts` (4 tests) — runs the dedicated TS demo tab
  (`nav-tab-vnext-worker-ts`). Hard-wired to the TS backend regardless of
  `?backend=`, so both projects exercise identical code.
- `vnext-worker-ts-lambda.spec.ts` (2 tests) — same dedicated TS demo,
  LAMBDA UI flow.

### Pass on both projects — real dual-backend specs (1 partial)

These specs actually consult `?backend=` and run against different code on
each project. Both runs pass.

- `custom-formulas.spec.ts` (10 tests; 1 pre-existing test.skip):
  The worker section (`gotoWorker`) uses `gotoRoot(page)` which preserves the
  project's `?backend=` selector. All worker scenarios pass on both
  projects, confirming the TS backend correctly registers custom formulas,
  marshals 2-D range args, and respects case-insensitive lookup. The Wave5
  capability-gating test runs against the static demo and degrades the
  same way on both projects.

### Resolved TS-only gap (1 spec, 2 tests)

- `vnext-worker-backend.spec.ts` (7 tests):
  Three tests fail on **both** projects (sibling agent is fixing the DOM
  count assertions there). Two additional tests failed **only on TS** before
  the targeted update:

  - line 380 — `persists row and column size metadata as Rust sparse facts`
  - line 447 — `autofits visible column size and persists the override`

  Both tests poll `window.__einfachWorkbookDebugClient.snapshotPersistenceV1()`
  and assert that the returned `sizes[<sheet>].rowHeights/colWidths` arrays
  contain entries for the manually resized row/column. The TS worker now keeps
  row-height / column-width metadata in `worker-runtime-ts.ts` and emits it via
  both `snapshotViewportSizes` and `snapshotPersistenceV1`.

  Targeted recheck on 2026-05-29:

  ```bash
  NO_PROXY=localhost,127.0.0.1 \
    npx playwright test e2e/vnext-worker-backend.spec.ts \
      --project=ts --project=wasm \
      -g "persists row and column size metadata|autofits visible column size"
  ```

  Result: 4 passed.

  See "What the debug-probe RPC surfaces" below for context on which TS
  RPCs are already present.

### Pre-existing failures on both projects (9 specs, 24 tests total)

These are UI bugs that reproduce identically on `wasm` and `ts` — they
predate this audit and are not backend-parity issues. They live in the
specs listed under "Static `VNextWave5Demo`" above and include:

- `audit-format.spec.ts` — 9 failures (toolbar icon glyphs, v-align
  dropdown, Format Cells dialog, merge dropdown disabled-state assertions)
- `copy-as.spec.ts` — 1 failure (merged region rowspan/colspan emission)
- `go-to.spec.ts` — 1 failure (row-differences scoping)
- `paste-special.spec.ts` — 2 failures (values-only arithmetic + Escape
  close — both 30s timeouts)
- `remove-duplicates.spec.ts` — 2 failures (empty-state preview messages)
- `text-to-columns.spec.ts` — 1 failure (preview token cap)
- `toolbar-buttons.spec.ts` — 2 failures (Ctrl+Z / Ctrl+Y undo / redo
  button-state assertions)
- `vnext-smoke.spec.ts` — 2 failures (alt-page keys, toolbar interaction
  atom probe)
- `vnext-wave5.spec.ts` — 1 failure (1x1 merge variants disable timeout)

Three additional failures inside `vnext-worker-backend.spec.ts` (lines 100,
162, 214) reproduce on both projects — those are the DOM cell count
assertions the sibling agent is currently fixing.

## What the debug-probe RPC surfaces

`solid/excel/src-vnext/adapter/worker-runtime-ts.ts` exposes the same three
debug RPCs the WASM worker has:

- `debugFormulaCacheState(sheet, addr)` →
  `'dirty' | 'computing' | 'clean' | 'none' | 'invalid'`
- `debugFormulaEvalCount(sheet)` → cumulative eval count for the sheet.
- `debugCounters()` → workbook-wide payload with per-sheet
  `formulaCount` / `formulaEvalCount`.

The probe semantics differ between backends because of the underlying
engine: Rust is purely lazy on mutation, TS-core (vanilla/core) is eager —
a mutation immediately re-derives every cached formula. See the file-level
comment in `solid/excel/test/excel-core-ts-debug-probes.test.ts` for the
exact divergence rules. The `observability.spec.ts` lazy-import test only
asserts on the *never-read* state, which both backends agree on, so it
runs identically.

The previous viewport-size RPC asymmetry (`snapshotPersistenceV1.sizes`) is now
fixed — see the "Resolved TS-only gap" section above.

## Shadow specs intentionally kept

`vnext-worker-ts.spec.ts` and `vnext-worker-ts-lambda.spec.ts` cover the
dedicated `VNextWorkerTsDemo` tab (a single-sheet TS surface) rather than
`VNextWorkerDemo` with `?backend=ts`. The dual-project audit makes them
mostly redundant now, but kept until both:

1. The `VNextWorkerDemo` 3-sheet seed flow reaches feature parity with the
   single-sheet demo on TS (no regressions from differences in seed shape).
2. The LAMBDA Name Manager UI ships in the WASM Name Manager dialog too —
   currently TS-only.

Folding them into the main spec is a follow-up cleanup once both above hold.

## Audit methodology (Phase 5)

1. **Baseline:** ran `npx playwright test --project=wasm` end-to-end and
   captured /tmp/wasm-full-audit.log. Result: 462 passed, 24 failed,
   29 skipped, 7m 58s wall clock.
2. **TS run:** ran `npx playwright test --project=ts` end-to-end and
   captured /tmp/ts-full-audit.log. Result: 460 passed, 26 failed,
   29 skipped, 7m 48s wall clock.
3. **Diff:** stripped per-test timing and compared failure sets via
   `comm`. Found 24 failures common to both projects (pre-existing UI
   bugs) and 2 TS-only failures (snapshotPersistenceV1 sizes gap, fixed
   by the targeted update above).
4. **No `test.skip(project === 'ts', …)` calls were added**: every TS
   failure either reproduces on WASM (so the breakage is upstream of the
   backend) or lives in a spec file owned by a sibling agent. Adding skips
   would mask the matching WASM failures without reducing the failure
   count, and would conflict with the sibling agent's edits.

Pre-fix net result: the TS backend was at 99.6% e2e parity with WASM
(460/462 of the WASM-passing tests also pass on TS), with the only divergence
being the snapshotPersistenceV1 sizes RPC. After the targeted fix, that known
RPC divergence is resolved; a full dual-project re-audit should refresh the
table above.
