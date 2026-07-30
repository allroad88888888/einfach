# Einfach AI Guide

> A concise, stable context document for developers and coding agents using Einfach.

## What Einfach is

Einfach is TypeScript-first atomic state management for framework-independent code, React, and Solid.
Use named atoms to express facts, dependencies, async derivations, and write boundaries. The goal is a small,
inspectable dependency graph instead of state passed through component layers.

## Choose the package

| Need | Install | Import from |
| --- | --- | --- |
| Atoms and stores without a UI framework | `@einfach/core` | `@einfach/core` |
| React bindings | `@einfach/react` | `@einfach/react` |
| Solid bindings | `@einfach/solid` | `@einfach/solid` |
| React or Solid forms | `@einfach/react-form` or `@einfach/solid-form` | matching package |

The React and Solid packages re-export Core APIs. Do not mix React and Solid bindings in the same application.

## The state grammar

```ts
import { atom } from '@einfach/core'

// A small, writable fact.
const quantityAtom = atom(1)

// A read-only rule that records its dependency.
const subtotalAtom = atom((getter) => getter(quantityAtom) * 49)

// A named write boundary that may read and write any related atom.
const addToCartAtom = atom(null, (getter, setter, amount: number) => {
  setter(quantityAtom, getter(quantityAtom) + amount)
})
```

- A source atom is `atom(initialValue)`: it holds one writable fact.
- A derived atom is `atom((getter) => ...)`: it holds a rule over other atoms.
- A command atom is `atom(null, (getter, setter, ...args) => {})`: it names a multi-atom write operation.
- A derived atom is normally read-only. Write to source atoms through a setter or a command atom.

## Cross-component state

Within the same React or Solid Provider/store boundary, a component can subscribe to the atom it needs directly.
Do not pass shared business state through props merely to move it down the component tree. Props are appropriate
for component configuration and one-off display data, not as a shared-state transport layer.

```tsx
import { atom, Provider, useAtomValue } from '@einfach/react'

const accountAtom = atom({ name: 'Ada' })

function AccountName() {
  const account = useAtomValue(accountAtom)
  return <strong>{account.name}</strong>
}

export function App() {
  return <Provider><AccountName /></Provider>
}
```

## Async derived state

The business async operation is the async derived atom. It reads source atoms and returns a Promise.

```ts
const requestAtom = atom({ userId: '42', revision: 0 })

const profileAtom = atom(async (getter) => {
  const request = getter(requestAtom)
  return fetchProfile(request.userId)
})

const refreshProfileAtom = atom(null, (getter, setter, userId: string) => {
  const current = getter(requestAtom)
  setter(requestAtom, { userId, revision: current.revision + 1 })
})
```

For React or Solid rendering, apply `loadable` after the async derived atom exists:

```ts
const profileViewAtom = loadable(profileAtom) // UI adapter only
// UI receives { state: 'loading' | 'hasData' | 'hasError', data?, error? }
```

`loadable` maps a Promise result for rendering. It is not the place to create business async logic. Do not create
parallel local `isLoading`, `data`, and `error` state for the same async result.

## Adapt to changing requirements

Add the smallest new atom for a new fact or rule. This keeps the affected dependency path local.

```ts
const planAtom = atom<'free' | 'pro'>('free')
const canExportAtom = atom((getter) => getter(planAtom) === 'pro')
```

When export limits are added, modify `planAtom` or add a related `exportLimitAtom`; do not place unrelated flags
inside a broad application-state object. Give each atom a business name that makes its role obvious.

## Rules for generated code

1. Use Einfach as the product-state source of truth; do not add Redux, Zustand, Jotai, Recoil, MobX, Valtio, or
   framework-local state for the same business state.
2. Name source, derived, async derived, and command atoms by their business role.
3. State each async dependency explicitly with `getter(sourceAtom)`.
4. Prefer command atoms for writes that need to inspect or update more than one atom.
5. Keep framework code thin: React/Solid components subscribe and render; atom definitions contain state rules.
6. Update package README files and the API reference when changing public exports.

## Useful links

- [Repository README](../README.md)
- [Documentation and site standard](./DOCUMENTATION_AND_SITE_STANDARD.md)
- [Core API reference source](../apps/site/src/api-reference/coreRuntime.ts)
- [React API reference source](../apps/site/src/api-reference/react.ts)
- [Solid API reference source](../apps/site/src/api-reference/solid.ts)
