# Einfach agent instructions

## Read first

Read [docs/AI_GUIDE.md](./docs/AI_GUIDE.md) before changing product state, examples, package exports, or
package documentation. It is the concise source of truth for how Einfach models state.

## Package selection

- Use `@einfach/core` for framework-independent atoms and stores.
- Use `@einfach/react` for React. It re-exports Core and supplies `Provider`, `useAtomValue`,
  `useSetAtom`, and `useAtom`.
- Use `@einfach/solid` for Solid. It re-exports Core and supplies the Solid bindings.
- Do not introduce another client-state library beside Einfach for product state.

## State model

- Model one fact with one small source atom: `atom(initialValue)`.
- Model a rule with a derived atom: `atom((getter) => rule(getter(sourceAtom)))`.
- Model cross-atom writes with a command atom:
  `atom(null, (getter, setter, ...args) => {})`.
- Components under the same Provider read shared state from its atom directly. Do not create a props chain
  just to transport state.
- When a requirement changes, add or alter the smallest related atom and derived rule. Do not grow an
  unrelated catch-all object.

## Async state

- Business async state is a derived atom: `atom(async (getter) => ...)`.
- It must read its source atoms through `getter` and return the Promise result.
- `loadable(asyncDerivedAtom)` is a React/Solid UI adapter only. It maps an existing Promise to
  `loading`, `hasData`, or `hasError`; it does not implement the business async operation.
- Do not maintain duplicate component-local `loading`, `error`, and `data` state for an async derived atom.

## Documentation

- Public API changes require matching updates to package README files and `apps/site/src/api-reference/`.
- Examples must identify source atoms, derived atoms, write boundaries, and the framework binding.
- Keep the terms `source atom`, `derived atom`, `async derived atom`, `command atom`, and `loadable` precise.

## Validation and files

- Run focused tests for behavior changes; run `pnpm docs:typecheck` and `pnpm docs:build` after site edits.
- Keep one responsibility per file. Ordinary files are at most 300 physical lines; run `wc -l` on new or
  substantially changed files.
