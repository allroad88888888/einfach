# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Einfach ("simple" in German) is a lightweight, Jotai-inspired atom-based state management library. It provides a framework-agnostic core with bindings for React and Solid.js, plus form handling utilities.

## Commands

```bash
# Build (clean types, compile TS, bundle with Rollup)
npm run build

# Run all tests with coverage
npm test

# Run a single test file
npx jest path/to/test.test.ts

# Lint and auto-fix
npm run eslint
```

## Monorepo Structure (pnpm workspaces)

```
vanilla/core/                  → @einfach/core              # Core atom engine (framework-agnostic)
vanilla/utils/                 → @einfach/utils             # Utility functions (easyGet/Set, memoize, LRU cache)
vanilla/spreadsheet-ui-core/   → @einfach/spreadsheet-ui-core  # Framework-agnostic spreadsheet UI atoms + types (vnext)
react/react/                   → @einfach/react             # React hooks (useAtomValue, useSetAtom, useAtom)
react/form/                    → @einfach/react-form        # React form handling with validation
react/utils/                   → @einfach/react-utils       # React utility hooks
solid/solid/                   → @einfach/solid             # Solid.js integration
solid/form/                    → @einfach/solid-form        # Solid.js form handling
solid/excel/                   → @einfach/solid-excel       # Solid.js spreadsheet surface (legacy + vnext)
rust/excel-core/               → einfach-excel-core         # Rust formula / workbook engine
rust/wasm/                     → einfach-wasm               # WASM bindings exposed to solid/excel
```

## Architecture

### Core Concepts

**Atoms** (`vanilla/core/src/atom.ts`): Fundamental state units. Two types:
- Primitive atoms: `atom(initialValue)` — writable state
- Derived atoms: `atom(get => get(otherAtom) * 2)` — computed from other atoms

**Store** (`vanilla/core/src/store.ts`): Manages atom state with automatic dependency tracking via WeakMaps (`atomStateMap`, `backDependenciesMap`, `dependenciesMap`). Key API: `getter(atom)`, `setter(atom, ...args)`, `sub(atom, listener)`.

**Framework bindings** are thin layers over the core. React uses Context for store management; Solid.js uses its reactive primitives.

**Form system** (`react/form/src/core/`, `solid/form/src/core/`): Backs form state (values, errors, validation rules) with atoms via `useForm()`.

**Spill-derived atoms** (`rust/excel-core/src/sheet.rs` § "Spill (dynamic-array) infrastructure"): when a formula evaluates to `Value::Array`, the anchor cell's atom holds the array and each non-(0,0) target gets a derived atom that reads the anchor and indexes into it. Reads, dependency tracking, and subscription propagation reuse the existing atom framework — no parallel spill index — and the WASM boundary collapses `Value::Array` to its top-left scalar for cell-projection reads. **Exception:** custom-formula callbacks (Wave 8.1) DO receive `Value::Array` as a 2-D JS array when a range arg is passed (`=MYFN(A1:A10)`), because the engine forwards array args directly to the JS callback — see `rust/excel-core/src/CUSTOM_FORMULAS.md` "Marshaling".

**Custom formulas** (Wave 8.1): host-registered JS callbacks invoked as cell-level functions (`=MYTAX(B1)`). Source of truth for the engine contract is `rust/excel-core/src/CUSTOM_FORMULAS.md`; the JS-side host API (registration atoms, name validation, built-in shadow list mirrored from the Rust evaluator) lives in `vanilla/spreadsheet-ui-core/src/custom-formulas/README.md`. The Solid provider (`solid/excel/src-vnext/provider/SpreadsheetUiProvider.tsx`) diffs the registry atom and forwards add/replace/remove ops to the worker through the optional `registerCustomFormula` / `unregisterCustomFormula` backend ports. **Async (Wave 8.2)**: registrations with `isAsync: true` may `await`; the cell holds `#BUSY!` until the worker pump (`solid/excel/src-vnext/adapter/async-custom-pump.ts`, shared by both worker runtimes) settles the Promise back into the engine, and results are memoized per (name, args) until the next registry change — see CUSTOM_FORMULAS.md § "Async custom formulas".

## Architecture: vnext (spreadsheet stack)

The `vnext` arc layers a spreadsheet on top of the existing atom core. It is the active surface for new feature work; the legacy `solid/excel/src/` shell is kept only for parity tests.

### Three-tier layering

```
vanilla/spreadsheet-ui-core   (atoms, types, projection contracts — no DOM, no worker, no WASM)
        ↑
solid/excel/src-vnext         (Solid components, Provider, adapters)
        ↑
rust/excel-core + rust/wasm   (formula engine, workbook state) — reached via a worker
```

Rules: `spreadsheet-ui-core` must not import Solid, React, DOM APIs, worker glue, or WASM glue. Workbook facts (cell values, formulas, dependency graph) live behind the backend port, not in UI atoms.

See `vanilla/spreadsheet-ui-core/docs/ROADMAP.md` for the four-wave feature breakdown and `vanilla/spreadsheet-ui-core/docs/AGENT_COLLABORATION.md` for the multi-agent kanban.

### Backend port (`SpreadsheetBackend`)

The contract between UI core and any data source lives in `vanilla/spreadsheet-ui-core/src/backend/types.ts`. Two methods are required (`readVisibleProjection`, `readRangeProjection`, `setCellInput`); 45+ feature methods are optional. UI core hides a toolbar item, menu entry, or keyboard intent when the host backend omits the relevant port — features degrade without UI core knowing the difference between "host does not implement it" and "feature does not exist".

Two reference implementations ship under `solid/excel/src-vnext/adapter/`:

- `static-backend.ts` — in-memory implementation used by smoke tests and the static demo.
- `worker-workbook-backend.ts` — RPC to a Web Worker that owns the WASM `Workbook` from `rust/wasm`.

### Atom conventions

- Every atom in `spreadsheet-ui-core` sets `debugLabel = 'spreadsheet.<feature>.<name>'` (e.g. `'spreadsheet.findReplace.cursor'`).
- Atoms classify as **source**, **derived**, or **command** in each feature's `README.md`. No per-cell, per-row, or per-column atom families — large tables must be served by the visible-window projection or a bounded cache.
- Bounded caches declare their cap (history 100, named-ranges 500, presence cursors 32, find matches 500, unlocked ranges 256).
- Mutation requests carry optional `requestId` / `revision` / `cancelToken` so workers can ignore stale work.

### Provider and dialog component pattern

`solid/excel/src-vnext/provider/SpreadsheetUiProvider.tsx` calls `createSpreadsheetUi`, then wraps children in both `@einfach/solid`'s `Provider` (for `useAtomValue` plumbing) and `SpreadsheetUiContext.Provider` (so `useSpreadsheetBackend` and `useSpreadsheetUiStore` resolve).

Every modal under `solid/excel/src-vnext/*/Spreadsheet*Dialog.tsx` follows the same shape:

1. Read an open-atom via `useAtomValue` and a close-setter (e.g. `closeFindReplaceAtom`).
2. Hold per-instance form state in `createSignal` locals.
3. Reset signals inside a `createEffect<boolean>` that watches the open-atom and detects a `false → true` edge.

`SpreadsheetFindReplaceDialog.tsx` is the canonical example; the conditional-formatting, data-validation, name-manager, protection-unlock, and comment-thread dialogs all mirror it.

### Resolved: solid-js single-instance requirement (was "1.9.12 Provider interaction")

Root cause (investigated 2026-06-13): the consumer-body re-execution under `Provider` was never a solid-js version bug — it was **two physical copies of solid-js in one process** (historically `solid/solid` → 1.9.5, `solid/excel` → 1.9.12). Copy A's `createProvider` wraps children in copy A's `children()` memo; the consumer instantiated by copy B can't untrack copy A's module-scoped `Listener`, so the children memo subscribes to consumer signals and re-runs on every atom mutation. Either version alone is fine; the split is the bug.

Fixed by `2b7d65e`: root `pnpm.overrides` pins `solid-js: 1.9.12` — the lockfile must only ever contain ONE `solid-js@` resolution. Contract tests: `solid/solid/test/provider-remount.test.tsx` + `solid/excel/test/provider-remount-1912.test.tsx` (consumer body runs once per mount). If either fails or a second solid-js resolution appears in `pnpm-lock.yaml`, fix the dependency graph — do not work around it in components. Keeping per-instance dialog state in atoms is now a convention, not a requirement.

## Build Pipeline

- TypeScript composite project with `tsc -build` for declarations
- Rollup bundles to `cjs/` (.cjs), `esm/` (.mjs), and `dist/`
- SWC transforms React/Vanilla; Babel transforms Solid.js (for JSX)
- All packages have `sideEffects: false` for tree-shaking
- `solid/excel` runs `npm run build:wasm` before `vite build` to refresh `solid/excel/wasm-pkg/` from `rust/wasm`

## Testing

- Jest with jsdom environment
- SWC for non-Solid tests, Babel for Solid tests
- `moduleNameMapper` in `jest.config.mjs` resolves `@einfach/*` to source directories
- React tests use `@testing-library/react` with `renderHook`/`act`
- Always create a fresh store per test via `createStore()`
- vnext spreadsheet suites: `npx jest vanilla/spreadsheet-ui-core --no-coverage` and `npx jest solid/excel --no-coverage`

## Code Style

- No semicolons, single quotes, 100 char line width (Prettier)
- Strict TypeScript (`strict: true`, `isolatedModules: true`)
- No console statements (ESLint)
- Use `type` keyword for type imports
- Versioning managed with Changesets
