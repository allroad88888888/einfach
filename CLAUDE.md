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
vanilla/core/     → @einfach/core         # Core atom engine (framework-agnostic)
vanilla/utils/    → @einfach/utils         # Utility functions (easyGet/Set, memoize, LRU cache)
react/react/      → @einfach/react         # React hooks (useAtomValue, useSetAtom, useAtom)
react/form/       → @einfach/react-form    # React form handling with validation
react/utils/      → @einfach/react-utils   # React utility hooks
solid/solid/      → @einfach/solid         # Solid.js integration
solid/form/       → @einfach/solid-form    # Solid.js form handling
```

## Architecture

### Core Concepts

**Atoms** (`vanilla/core/src/atom.ts`): Fundamental state units. Two types:
- Primitive atoms: `atom(initialValue)` — writable state
- Derived atoms: `atom(get => get(otherAtom) * 2)` — computed from other atoms

**Store** (`vanilla/core/src/store.ts`): Manages atom state with automatic dependency tracking via WeakMaps (`atomStateMap`, `backDependenciesMap`, `dependenciesMap`). Key API: `getter(atom)`, `setter(atom, ...args)`, `sub(atom, listener)`.

**Framework bindings** are thin layers over the core. React uses Context for store management; Solid.js uses its reactive primitives.

**Form system** (`react/form/src/core/`, `solid/form/src/core/`): Backs form state (values, errors, validation rules) with atoms via `useForm()`.

### Build Pipeline

- TypeScript composite project with `tsc -build` for declarations
- Rollup bundles to `cjs/` (.cjs), `esm/` (.mjs), and `dist/`
- SWC transforms React/Vanilla; Babel transforms Solid.js (for JSX)
- All packages have `sideEffects: false` for tree-shaking

### Testing

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
