/** @jsxImportSource solid-js */
import { describe, expect, it } from '@jest/globals'
import { createStore, atom } from '@einfach/core'
import { render } from '@solidjs/testing-library'
import { Provider, useAtomValue } from '@einfach/solid'

/**
 * Guardrail test for the Provider remount bug.
 *
 * Before this guardrail existed, `@einfach/solid`'s Provider re-executed
 * any descendant `useAtomValue` consumer's body on every atom mutation
 * when the workspace had two physical copies of solid-js (e.g. root
 * pinned ^1.9.5 while `excel/solid-excel` pinned ^1.9.12). The two copies have
 * separate module-scoped `Listener`/`Owner` globals; reading a signal
 * created by one copy from inside a render effect of the other causes a
 * cross-version dependency leak through the Provider's internal
 * `createMemo` wrapper around `props.children`, which then re-runs the
 * consumer's component body on every atom mutation.
 *
 * The repo-level fix aligns every solid-js install to a single resolved
 * version via a `pnpm.overrides` entry in the root package.json. This
 * test exercises the exact scenario so that a future version-range bump
 * that lets two copies coexist again fails loudly here.
 */
describe('Provider remount contract (solid-js single-copy)', () => {
  it('does not re-execute the consumer body on atom mutations', () => {
    const a = atom(0)
    const i = atom(null, (get, set) => set(a, get(a) + 1))
    const store = createStore()
    let bodyRun = 0
    function Probe() {
      bodyRun += 1
      const v = useAtomValue(a)
      return <div>{v()}</div>
    }
    render(() => (
      <Provider store={store}>
        <Probe />
      </Provider>
    ))
    store.setter(i)
    store.setter(i)
    store.setter(i)
    expect(bodyRun).toBe(1)
  })
})
