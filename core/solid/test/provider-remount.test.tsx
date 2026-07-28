/** @jsxImportSource solid-js */

import { describe, it, expect, afterEach } from '@jest/globals'
import { render, cleanup } from '@solidjs/testing-library'
import { atom, createStore } from '@einfach/core'
import { createEffect } from 'solid-js'
import { useAtomValue } from '../src/useAtomValue'
import { Provider } from '../src/Provider'

afterEach(cleanup)

describe('Provider remount bug', () => {
  it('does not re-execute the consumer body when atom changes (with Provider)', () => {
    const a = atom(0)
    const incr = atom(null, (get, set) => set(a, get(a) + 1))
    const store = createStore()

    let bodyRun = 0
    function Probe() {
      bodyRun += 1
      const v = useAtomValue(a)
      return <div data-testid="v">{v()}</div>
    }

    render(() => (
      <Provider store={store}>
        <Probe />
      </Provider>
    ))

    store.setter(incr)
    store.setter(incr)
    store.setter(incr)

    expect(bodyRun).toBe(1)
  })

  it('does not re-execute the consumer body when atom changes (without Provider)', () => {
    const a = atom(0)
    const incr = atom(null, (get, set) => set(a, get(a) + 1))
    const store = createStore()

    let bodyRun = 0
    function Probe() {
      bodyRun += 1
      const v = useAtomValue(a, { store })
      return <div data-testid="v">{v()}</div>
    }

    const { getByTestId } = render(() => <Probe />)

    expect(getByTestId('v').textContent).toBe('0')
    expect(bodyRun).toBe(1)

    store.setter(incr)
    store.setter(incr)
    store.setter(incr)

    expect(getByTestId('v').textContent).toBe('3')
    expect(bodyRun).toBe(1)
  })

  it('does not re-execute when there is a parent Provider boundary', () => {
    const a = atom(0)
    const store = createStore()

    let bodyRun = 0
    function Probe() {
      bodyRun += 1
      const v = useAtomValue(a)
      return <div data-testid="v">{v()}</div>
    }

    function Outer(props: { children: any }) {
      return <div>{props.children}</div>
    }

    const { getByTestId } = render(() => (
      <Provider store={store}>
        <Outer>
          <Probe />
        </Outer>
      </Provider>
    ))

    expect(getByTestId('v').textContent).toBe('0')
    expect(bodyRun).toBe(1)

    store.setter(a, 1)
    store.setter(a, 2)
    store.setter(a, 3)

    expect(getByTestId('v').textContent).toBe('3')
    expect(bodyRun).toBe(1)
  })

  it('direct setter on atom (no incr) with Provider', () => {
    const a = atom(0)
    const store = createStore()

    let bodyRun = 0
    function Probe() {
      bodyRun += 1
      const v = useAtomValue(a)
      return <div data-testid="v">{v()}</div>
    }

    const { getByTestId } = render(() => (
      <Provider store={store}>
        <Probe />
      </Provider>
    ))

    expect(getByTestId('v').textContent).toBe('0')
    expect(bodyRun).toBe(1)

    store.setter(a, 1)
    store.setter(a, 2)
    store.setter(a, 3)

    expect(getByTestId('v').textContent).toBe('3')
    expect(bodyRun).toBe(1)
  })

  it('with nested Provider, body should run once', () => {
    const a = atom(0)
    const store = createStore()

    let bodyRun = 0
    function Probe() {
      bodyRun += 1
      const v = useAtomValue(a)
      return <div data-testid="v">{v()}</div>
    }

    render(() => (
      <Provider store={store}>
        <Provider store={store}>
          <Probe />
        </Provider>
      </Provider>
    ))

    store.setter(a, 1)
    store.setter(a, 2)
    store.setter(a, 3)

    expect(bodyRun).toBe(1)
  })

  it('with createEffect reading value, body still runs once', () => {
    const a = atom(0)
    const store = createStore()

    let bodyRun = 0
    let effectRun = 0
    function Probe() {
      bodyRun += 1
      const v = useAtomValue(a)
      createEffect(() => {
        v()
        effectRun += 1
      })
      return <div data-testid="v">{v()}</div>
    }

    render(() => (
      <Provider store={store}>
        <Probe />
      </Provider>
    ))

    store.setter(a, 1)
    store.setter(a, 2)
    store.setter(a, 3)

    expect(bodyRun).toBe(1)
    expect(effectRun).toBeGreaterThan(1)
  })

  it('Provider should still let useAtomValue read the custom store (regression)', () => {
    const store = createStore()
    const countAtom = atom(42)
    store.setter(countAtom, 100)

    function Probe() {
      const v = useAtomValue(countAtom)
      return <div data-testid="v">{v()}</div>
    }

    const { getByTestId } = render(() => (
      <Provider store={store}>
        <Probe />
      </Provider>
    ))

    expect(getByTestId('v').textContent).toBe('100')
  })
})
