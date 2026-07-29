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

本仓只有库侧。表格栈已于 2026-07-29 拆到独立仓库 `allroad88888888/einfach-excel`
（工作副本 `/Volumes/work/self/excel`），拆分口径见 `docs/REPO_SPLIT_PLAN_2026-07-28.md`。

```
core/core/          → @einfach/core          # Core atom engine (framework-agnostic)
core/utils/         → @einfach/utils         # Utility functions (easyGet/Set, memoize, LRU cache)
core/react/         → @einfach/react         # React hooks (useAtomValue, useSetAtom, useAtom)
core/react-utils/   → @einfach/react-utils   # React utility hooks
core/react-form/    → @einfach/react-form    # React form handling with validation
core/solid/         → @einfach/solid         # Solid.js integration
core/solid-form/    → @einfach/solid-form    # Solid.js form handling
```

pnpm workspace 的 glob 是 `core/*`，目录叶子名与包名对齐（`core/react-utils` ↔ `@einfach/react-utils`）。

**下游契约**：`einfach-excel` 通过 npm 消费本仓的 `@einfach/core` 与 `@einfach/solid`，只用到
`atom` / `Atom` / `AtomEntity` / `createStore` / `Getter` / `Setter` / `Store` / `WritableAtom`
这 8 个原语，以及 `Provider` / `useAtomValue` / `useSetAtom` / `useStore` 这 4 个 Solid 绑定。
改动这些导出的语义等于改动下游的地基 —— 先确认对面能跟上再发版。

## Architecture

### Core Concepts

**Atoms** (`core/core/src/atom.ts`): Fundamental state units. Two types:
- Primitive atoms: `atom(initialValue)` — writable state
- Derived atoms: `atom(get => get(otherAtom) * 2)` — computed from other atoms

**Store** (`core/core/src/store.ts`): Manages atom state with automatic dependency tracking via WeakMaps (`atomStateMap`, `backDependenciesMap`, `dependenciesMap`). Key API: `getter(atom)`, `setter(atom, ...args)`, `sub(atom, listener)`.

**Framework bindings** are thin layers over the core. React uses Context for store management; Solid.js uses its reactive primitives.

**Form system** (`core/react-form/src/core/`, `core/solid-form/src/core/`): Backs form state (values, errors, validation rules) with atoms via `useForm()`.

**Spill-derived atoms** (`excel/rust/excel-core/src/sheet.rs` § "Spill (dynamic-array) infrastructure"): when a formula evaluates to `Value::Array`, the anchor cell's atom holds the array and each non-(0,0) target gets a derived atom that reads the anchor and indexes into it. Reads, dependency tracking, and subscription propagation reuse the existing atom framework — no parallel spill index — and the WASM boundary collapses `Value::Array` to its top-left scalar for cell-projection reads. **Exception:** custom-formula callbacks (Wave 8.1) DO receive `Value::Array` as a 2-D JS array when a range arg is passed (`=MYFN(A1:A10)`), because the engine forwards array args directly to the JS callback — see `excel/rust/excel-core/src/CUSTOM_FORMULAS.md` "Marshaling".

**Custom formulas** (Wave 8.1): host-registered JS callbacks invoked as cell-level functions (`=MYTAX(B1)`). Source of truth for the engine contract is `excel/rust/excel-core/src/CUSTOM_FORMULAS.md`; the JS-side host API (registration atoms, name validation, built-in shadow list mirrored from the Rust evaluator) lives in `excel/spreadsheet-ui-core/src/custom-formulas/README.md`. The Solid provider (`excel/solid-excel/src-vnext/provider/SpreadsheetUiProvider.tsx`) diffs the registry atom and forwards add/replace/remove ops to the worker through the optional `registerCustomFormula` / `unregisterCustomFormula` backend ports. **Async (Wave 8.2)**: registrations with `isAsync: true` may `await`; the cell holds `#BUSY!` until the worker pump (`excel/solid-excel/src-vnext/adapter/async-custom-pump.ts`, shared by both worker runtimes) settles the Promise back into the engine, and results are memoized per (name, args) until the next registry change — see CUSTOM_FORMULAS.md § "Async custom formulas".

## Build Pipeline

- TypeScript composite project with `tsc -build` for declarations
- Rollup bundles to `cjs/` (.cjs), `esm/` (.mjs), and `dist/`
- SWC transforms React/Vanilla; Babel transforms Solid.js (for JSX)
- All packages have `sideEffects: false` for tree-shaking
- `excel/solid-excel` runs `npm run build:wasm` before `vite build` to refresh `excel/solid-excel/wasm-pkg/` from `excel/rust/wasm`

## Testing

- Jest with jsdom environment
- SWC for non-Solid tests, Babel for Solid tests
- `moduleNameMapper` in `jest.config.mjs` resolves `@einfach/*` to source directories
- React tests use `@testing-library/react` with `renderHook`/`act`
- Always create a fresh store per test via `createStore()`
- vnext spreadsheet suites: `npx jest excel/spreadsheet-ui-core --no-coverage` and `npx jest excel/solid-excel --no-coverage`

## Code Style

- No semicolons, single quotes, 100 char line width (Prettier)
- Strict TypeScript (`strict: true`, `isolatedModules: true`)
- No console statements (ESLint)
- Use `type` keyword for type imports
- Versioning managed with Changesets
