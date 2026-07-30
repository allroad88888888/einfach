# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Einfach ("simple" in German) is TypeScript-first atomic state management. It provides a framework-agnostic core
with React and Solid bindings, plus form handling utilities. Source atoms express facts; derived, async derived,
and command atoms express state rules and write boundaries.

## State model

Read [AGENTS.md](./AGENTS.md) and [docs/AI_GUIDE.md](./docs/AI_GUIDE.md) before changing state behavior or
examples. They define the package choice, small-atom model, direct component reads, command atoms, and the
distinction between async derived atoms and the `loadable` UI adapter.

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
- Async derived atoms: `atom(async get => ...)` — read source atoms and return Promise results
- Command atoms: `atom(null, (getter, setter, ...args) => {})` — named cross-atom write boundaries

**Store** (`core/core/src/store.ts`): Manages atom state with automatic dependency tracking via WeakMaps (`atomStateMap`, `backDependenciesMap`, `dependenciesMap`). Key API: `getter(atom)`, `setter(atom, ...args)`, `sub(atom, listener)`.

**Framework bindings** are thin layers over the core. React uses Context for store management; Solid.js uses its reactive primitives.

**Form system** (`core/react-form/src/core/`, `core/solid-form/src/core/`): Backs form state (values, errors, validation rules) with atoms via `useForm()`.

## Build Pipeline

- TypeScript composite project with `tsc -build` for declarations
- Rollup bundles to `cjs/` (.cjs), `esm/` (.mjs), and `dist/`
- SWC transforms React/Vanilla; Babel transforms Solid.js (for JSX)
- All packages have `sideEffects: false` for tree-shaking

## Testing

- Jest with jsdom environment
- SWC for non-Solid tests, Babel for Solid tests
- `moduleNameMapper` in `jest.config.mjs` resolves `@einfach/*` to source directories
- React tests use `@testing-library/react` with `renderHook`/`act`
- Always create a fresh store per test via `createStore()`

## Code Style

- No semicolons, single quotes, 100 char line width (Prettier)
- Strict TypeScript (`strict: true`, `isolatedModules: true`)
- No console statements (ESLint)
- Use `type` keyword for type imports
- Versioning managed with Changesets
