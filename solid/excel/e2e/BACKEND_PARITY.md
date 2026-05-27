# vNext e2e — Backend Parity Matrix

Last audited: 2026-05-27 (Phase 4 — revised after vite alias for `@einfach/excel-core-ts`)

## Projects

The Playwright config (`playwright.config.ts`) defines two projects, both running
the same chromium device. They differ only in the baseURL query string:

- `wasm` — baseURL `http://localhost:5174/?backend=wasm` (Rust workbook in a
  Web Worker, the default everywhere)
- `ts`   — baseURL `http://localhost:5174/?backend=ts` (`@einfach/excel-core-ts`
  in a Web Worker, the F1/F2 TS port)

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

Phase 3b updated `gotoVNextWorkerDemo` in `vnext-worker-backend.spec.ts` and
`gotoWorker` / `gotoWave5` in `custom-formulas.spec.ts` to call `gotoRoot`.
Other vNext specs (`vnext-worker-ts.spec.ts`, `vnext-worker-ts-lambda.spec.ts`,
`vnext-smoke.spec.ts`) bind to dedicated demo tabs that don't read
`?backend=`, so they're left untouched.

## Specs by status

### Pass on both projects (probe-using or projection-using vNext suite)

- `observability.spec.ts` — uses the legacy 1M Cells demo + a direct
  `wasm-workbook-proxy` import, so both projects exercise the same WASM
  workbook. The TS `debugFormulaEvalCount` / `debugFormulaCacheState`
  surfaces ride here via the worker debug client.
- `multisheet-ui.spec.ts` — Multi-Sheet legacy demo (WASM under both
  projects).
- `file-import.spec.ts` — 1M Cells legacy demo (WASM under both projects).
- `vnext-worker-ts.spec.ts` — dedicated TS demo tab (`nav-tab-vnext-worker-ts`).
  Runs the same way on both projects because the demo ignores `?backend=`.
- `vnext-worker-ts-lambda.spec.ts` — same dedicated TS demo, LAMBDA UI flow.

### Skip on `ts` (with reason)

Phase 4 found Phase 3b's TS-only diagnosis was wrong. The failures Phase 3b
attributed to a TS-specific multi-sheet projection gap were actually a vite
bundle resolution issue: `@einfach/excel-core-ts` resolved to a stale `esm/`
build without the Phase 1 debug RPCs, crashing the worker on `?backend=ts`.
Phase 4 added a vite alias to source (`solid/excel/vite.config.ts`) so the
ts-tab demo bundles fresh excel-core-ts code. With the alias in place, the
`vnext-worker-backend.spec.ts` and `custom-formulas.spec.ts` describes that
Phase 3b skipped on ts now fail identically on both projects — the residual
failures are the pre-existing demo regressions catalogued below, not a
backend-parity gap. Phase 4 removed both skip blocks.

No TS-only skips remain.

### Skip on `wasm` (with reason)

None as of Phase 3b. The WASM backend is the production default; any
feature it doesn't cover is an upstream Rust gap that gets fixed there
rather than skipped at the e2e layer.

### Known broken on both projects (pre-existing, not in scope for Phase 3b)

These specs failed before Phase 3b landed. They fail identically on both
projects, so the breakage is in shared UI / status-bar code, not in either
worker:

- `vnext-worker-backend.spec.ts` (7 of 8 tests on wasm) — `getByTestId('status-visible-cells').toHaveText('30 cells')` receives `"60 cells"`. The status bar `formatVisibleWindow` reports the full sheet's visible range, but the test expects a smaller pre-status-bar-refactor count. Fix is upstream of the engine.
- `vnext-smoke.spec.ts` (12 of ~26 tests on both backends) — same root cause:
  status-bar `30 cells` assertion vs actual `60 cells`. The static
  `VNextSmokeDemo` doesn't even use a worker, so neither `?backend=`
  selector changes the outcome.

These are noted here for completeness; Phase 3b does not introduce new
failures, and the dual-project audit doesn't make them worse.

## What the debug-probe RPC surfaces

`solid/excel/src-vnext/adapter/worker-runtime-ts.ts` now exposes the same
three debug RPCs the WASM worker has:

- `debugFormulaCacheState(sheet, addr)` →
  `'dirty' | 'computing' | 'clean' | 'none' | 'invalid'`
- `debugFormulaEvalCount(sheet)` → cumulative eval count for the sheet.
- `debugCounters()` → workbook-wide payload with per-sheet
  `formulaCount` / `formulaEvalCount` (Phase 3b replaced the zero-stub
  with real numbers via the new `Workbook.debugFormulaCount` accessor).

The probe semantics differ between backends because of the underlying
engine: Rust is purely lazy on mutation, TS-core (vanilla/core) is eager —
a mutation immediately re-derives every cached formula. See the file-level
comment in `solid/excel/test/excel-core-ts-debug-probes.test.ts` for the
exact divergence rules. The `observability.spec.ts` lazy-import test only
asserts on the *never-read* state, which both backends agree on, so it
runs identically.

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
