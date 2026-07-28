/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import {
  customFormulaRegistryAtom,
  registerCustomFormulaAtom,
  unregisterCustomFormulaAtom,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import { customFormulasSupportedAtom, SpreadsheetUiProvider } from '../src-vnext/provider'

afterEach(() => {
  cleanup()
  jest.restoreAllMocks()
})

function createDeferredVoid() {
  let resolve: () => void = () => undefined
  let reject: (reason?: unknown) => void = () => undefined
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function createBackendWithCustomFormulas() {
  const registerSpy = jest.fn<
    (name: string, source: string, options?: { isAsync?: boolean }) => Promise<void>
  >(async () => undefined)
  const unregisterSpy = jest.fn<(name: string) => Promise<void>>(async () => undefined)
  const backend: SpreadsheetBackend = {
    async readVisibleProjection() {
      throw new Error('not used')
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
    registerCustomFormula: registerSpy,
    unregisterCustomFormula: unregisterSpy,
  }
  return { backend, registerSpy, unregisterSpy }
}

function createBackendWithoutCustomFormulas(): SpreadsheetBackend {
  return {
    async readVisibleProjection() {
      throw new Error('not used')
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
  }
}

describe('vnext custom formulas — host wiring', () => {
  it('registering an atom entry calls backend.registerCustomFormula with the source', async () => {
    const store = createStore()
    const { backend, registerSpy } = createBackendWithCustomFormulas()

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    store.setter(registerCustomFormulaAtom, {
      name: 'MYTAX',
      source: 'return args[0] * 0.2',
    })

    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledTimes(1)
    })
    expect(registerSpy.mock.calls[0]).toEqual(['MYTAX', 'return args[0] * 0.2', { isAsync: false }])
  })

  it('isAsync registrations pass the flag through to the backend', async () => {
    const store = createStore()
    const { backend, registerSpy } = createBackendWithCustomFormulas()

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    store.setter(registerCustomFormulaAtom, {
      name: 'SLOWTAX',
      source: 'return await fetchRate(args[0])',
      isAsync: true,
    })

    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledTimes(1)
    })
    expect(registerSpy.mock.calls[0]).toEqual([
      'SLOWTAX',
      'return await fetchRate(args[0])',
      { isAsync: true },
    ])
  })

  it('replaces when isAsync flips on an unchanged source', async () => {
    const store = createStore()
    const { backend, registerSpy, unregisterSpy } = createBackendWithCustomFormulas()

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    store.setter(registerCustomFormulaAtom, {
      name: 'MYTAX',
      source: 'return args[0] * 0.2',
    })
    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledTimes(1)
    })

    store.setter(registerCustomFormulaAtom, {
      name: 'MYTAX',
      source: 'return args[0] * 0.2',
      isAsync: true,
    })
    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledTimes(2)
    })
    expect(unregisterSpy).toHaveBeenCalledWith('MYTAX')
    expect(registerSpy.mock.calls[1]).toEqual(['MYTAX', 'return args[0] * 0.2', { isAsync: true }])
  })

  it('unregistering an entry calls backend.unregisterCustomFormula', async () => {
    const store = createStore()
    const { backend, registerSpy, unregisterSpy } = createBackendWithCustomFormulas()

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    store.setter(registerCustomFormulaAtom, {
      name: 'MYTAX',
      source: 'return args[0] * 0.2',
    })
    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledTimes(1)
    })
    store.setter(unregisterCustomFormulaAtom, 'MYTAX')
    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledWith('MYTAX')
    })
  })

  it('compensates a late register ACK after the desired entry was removed', async () => {
    const store = createStore()
    const registerGate = createDeferredVoid()
    const remote = new Set<string>()
    const registerSpy = jest.fn<(name: string) => Promise<void>>(async (name) => {
      await registerGate.promise
      remote.add(name)
    })
    const unregisterSpy = jest.fn<(name: string) => Promise<void>>(async (name) => {
      remote.delete(name)
    })
    const backend: SpreadsheetBackend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      registerCustomFormula: registerSpy,
      unregisterCustomFormula: unregisterSpy,
    }

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    store.setter(registerCustomFormulaAtom, { name: 'LATE_ADD', source: 'return 1' })
    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledTimes(1)
    })

    store.setter(unregisterCustomFormulaAtom, 'LATE_ADD')
    registerGate.resolve()

    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledWith('LATE_ADD')
      expect(remote.has('LATE_ADD')).toBe(false)
    })
  })

  it('re-registering an existing name unregisters then registers again', async () => {
    const store = createStore()
    const { backend, registerSpy, unregisterSpy } = createBackendWithCustomFormulas()

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    store.setter(registerCustomFormulaAtom, {
      name: 'GREET',
      source: "return 'hi'",
    })
    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledTimes(1)
    })

    store.setter(registerCustomFormulaAtom, {
      name: 'GREET',
      source: "return 'hello'",
    })

    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledWith('GREET')
      expect(registerSpy).toHaveBeenCalledTimes(2)
    })
    expect(registerSpy.mock.calls[1]).toEqual(['GREET', "return 'hello'", { isAsync: false }])
  })

  it('compensates a late replacement ACK after the desired entry was removed', async () => {
    const store = createStore()
    const replacementGate = createDeferredVoid()
    const remote = new Map<string, string>()
    const registerSpy = jest.fn<(name: string, source: string) => Promise<void>>(
      async (name, source) => {
        if (source === 'return 2') await replacementGate.promise
        remote.set(name, source)
      },
    )
    const unregisterSpy = jest.fn<(name: string) => Promise<void>>(async (name) => {
      remote.delete(name)
    })
    const backend: SpreadsheetBackend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      registerCustomFormula: registerSpy,
      unregisterCustomFormula: unregisterSpy,
    }

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    store.setter(registerCustomFormulaAtom, { name: 'LATE_REPLACE', source: 'return 1' })
    await waitFor(() => {
      expect(remote.get('LATE_REPLACE')).toBe('return 1')
    })

    store.setter(registerCustomFormulaAtom, { name: 'LATE_REPLACE', source: 'return 2' })
    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledTimes(1)
      expect(registerSpy).toHaveBeenCalledTimes(2)
    })

    store.setter(unregisterCustomFormulaAtom, 'LATE_REPLACE')
    replacementGate.resolve()

    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledTimes(2)
      expect(remote.has('LATE_REPLACE')).toBe(false)
    })
  })

  it('unmounting tears down currently-installed registrations', async () => {
    const store = createStore()
    const { backend, registerSpy, unregisterSpy } = createBackendWithCustomFormulas()

    const { unmount } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    store.setter(registerCustomFormulaAtom, {
      name: 'CELSIUS',
      source: 'return (args[0] - 32) * 5 / 9',
    })
    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalled()
    })

    unmount()
    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledWith('CELSIUS')
    })
  })

  it('backend without registerCustomFormula does not crash on registry writes', () => {
    const store = createStore()
    const backend = createBackendWithoutCustomFormulas()

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    expect(() => {
      store.setter(registerCustomFormulaAtom, {
        name: 'MYTAX',
        source: 'return args[0] * 0.2',
      })
    }).not.toThrow()

    expect(store.getter(customFormulaRegistryAtom).has('MYTAX')).toBe(true)
  })

  it('customFormulasSupportedAtom reflects backend capability', () => {
    const store = createStore()
    const { backend } = createBackendWithCustomFormulas()

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(customFormulasSupportedAtom)).toBe(true)
  })

  it('customFormulasSupportedAtom is false when backend omits the port', () => {
    const store = createStore()
    const backend = createBackendWithoutCustomFormulas()

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(customFormulasSupportedAtom)).toBe(false)
  })

  it('registrations seeded BEFORE mount are forwarded to the backend on mount', async () => {
    const store = createStore()
    const { backend, registerSpy } = createBackendWithCustomFormulas()

    // Seed the registry on the store BEFORE the provider mounts so the
    // initial-prime branch of the host effect runs.
    store.setter(registerCustomFormulaAtom, {
      name: 'PREMOUNT',
      source: 'return 1',
    })

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledWith('PREMOUNT', 'return 1', { isAsync: false })
    })
  })
})

describe('vnext custom formulas — reconciliation failures', () => {
  // A failed register MUST leave the `installed` ledger alone so the
  // next registry generation replays the missing entry instead of
  // silently dropping it.
  it('a failed registerCustomFormula does not advance the baseline', async () => {
    const store = createStore()
    let attempts = 0
    const registerSpy = jest.fn<(name: string, source: string) => Promise<void>>(async () => {
      attempts++
      if (attempts === 1) throw new Error('worker boom')
    })
    const unregisterSpy = jest.fn<(name: string) => Promise<void>>(async () => undefined)
    const backend: SpreadsheetBackend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      registerCustomFormula: registerSpy,
      unregisterCustomFormula: unregisterSpy,
    }

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    // First register — backend rejects.
    store.setter(registerCustomFormulaAtom, {
      name: 'RETRYME',
      source: 'return 1',
    })
    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledTimes(1)
    })

    // Mutate the registry again with identical content. The reconciler
    // sees the slot as still-needing-install (the ledger did NOT
    // advance after the failed first call) and replays the register.
    store.setter(registerCustomFormulaAtom, {
      name: 'RETRYME',
      source: 'return 1',
    })
    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledTimes(2)
    })
    // Second call succeeds (attempts > 1) → the ledger now advances, so
    // a no-op mutation should NOT trigger a third call.
    store.setter(registerCustomFormulaAtom, {
      name: 'RETRYME',
      source: 'return 1',
    })
    // Give the microtask queue a moment to drain.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(registerSpy).toHaveBeenCalledTimes(2)
  })

  // A non-cancellable old register may ACK after newer registry writes.
  // The provider records that remote install, removes it, then installs
  // only the latest desired source.
  it('quick register → unregister → register converges through compensation', async () => {
    const store = createStore()
    // Hold registers until we release them so we can interleave a
    // burst of mutations against an in-flight batch.
    let releaseFirst: () => void = () => undefined
    const firstRegister = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let registerCalls = 0
    const registerSpy = jest.fn<(name: string, source: string) => Promise<void>>(async () => {
      registerCalls++
      if (registerCalls === 1) await firstRegister
    })
    const unregisterSpy = jest.fn<(name: string) => Promise<void>>(async () => undefined)
    const backend: SpreadsheetBackend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      registerCustomFormula: registerSpy,
      unregisterCustomFormula: unregisterSpy,
    }

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    // First register — backend hangs on the in-flight promise.
    store.setter(registerCustomFormulaAtom, {
      name: 'BURST',
      source: 'return 1',
    })
    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledTimes(1)
    })
    // Mutate twice while the first register is still pending.
    store.setter(unregisterCustomFormulaAtom, 'BURST')
    store.setter(registerCustomFormulaAtom, {
      name: 'BURST',
      source: 'return 2',
    })
    // Release the held first register so the chain advances.
    releaseFirst()
    // Final state reflects `'return 2'`; the old ACK is explicitly
    // compensated instead of being treated as cancelled.
    await waitFor(() => {
      const lastCall = registerSpy.mock.calls[registerSpy.mock.calls.length - 1]
      expect(lastCall?.[1]).toBe('return 2')
      expect(unregisterSpy).toHaveBeenCalledWith('BURST')
    })
  })
})

describe('vnext custom formulas — provider isolation and lifecycle races', () => {
  it('keeps two Provider/store/backend synchronizers isolated', async () => {
    const firstStore = createStore()
    const secondStore = createStore()
    const firstGate = createDeferredVoid()
    let firstInstalled = false
    const firstRegister = jest.fn<(name: string) => Promise<void>>(async () => {
      await firstGate.promise
      firstInstalled = true
    })
    const firstUnregister = jest.fn<(name: string) => Promise<void>>(async () => undefined)
    const secondRegister = jest.fn<(name: string) => Promise<void>>(async () => undefined)
    const secondUnregister = jest.fn<(name: string) => Promise<void>>(async () => undefined)
    const firstBackend: SpreadsheetBackend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      registerCustomFormula: firstRegister,
      unregisterCustomFormula: firstUnregister,
    }
    const secondBackend: SpreadsheetBackend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      registerCustomFormula: secondRegister,
      unregisterCustomFormula: secondUnregister,
    }

    const firstView = render(() => (
      <SpreadsheetUiProvider backend={firstBackend} store={firstStore}>
        <div />
      </SpreadsheetUiProvider>
    ))
    const secondView = render(() => (
      <SpreadsheetUiProvider backend={secondBackend} store={secondStore}>
        <div />
      </SpreadsheetUiProvider>
    ))

    firstStore.setter(registerCustomFormulaAtom, { name: 'FIRST_ONLY', source: 'return 1' })
    await waitFor(() => {
      expect(firstRegister).toHaveBeenCalledTimes(1)
    })

    secondStore.setter(registerCustomFormulaAtom, { name: 'SECOND_ONLY', source: 'return 2' })
    await waitFor(() => {
      expect(secondRegister).toHaveBeenCalledWith('SECOND_ONLY', 'return 2', {
        isAsync: false,
      })
    })
    expect(firstRegister).not.toHaveBeenCalledWith(
      'SECOND_ONLY',
      expect.anything(),
      expect.anything(),
    )
    expect(secondRegister).not.toHaveBeenCalledWith(
      'FIRST_ONLY',
      expect.anything(),
      expect.anything(),
    )
    expect(firstInstalled).toBe(false)

    firstGate.resolve()
    await waitFor(() => {
      expect(firstInstalled).toBe(true)
    })
    firstView.unmount()
    secondView.unmount()
    await waitFor(() => {
      expect(firstUnregister).toHaveBeenCalledWith('FIRST_ONLY')
      expect(secondUnregister).toHaveBeenCalledWith('SECOND_ONLY')
    })
  })

  it('does not grow the remote set when stale unregister keeps failing during churn', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = createStore()
    const remote = new Set<string>()
    let rejectCleanup = true
    const registerSpy = jest.fn<(name: string) => Promise<void>>(async (name) => {
      remote.add(name)
    })
    const unregisterSpy = jest.fn<(name: string) => Promise<void>>(async (name) => {
      if (rejectCleanup) throw new Error('worker cleanup failed')
      remote.delete(name)
    })
    const backend: SpreadsheetBackend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      registerCustomFormula: registerSpy,
      unregisterCustomFormula: unregisterSpy,
    }

    const view = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    store.setter(registerCustomFormulaAtom, { name: 'STUCK_A', source: 'return 1' })
    await waitFor(() => {
      expect(remote).toEqual(new Set(['STUCK_A']))
    })

    store.setter(unregisterCustomFormulaAtom, 'STUCK_A')
    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledTimes(1)
    })
    store.setter(registerCustomFormulaAtom, { name: 'CHURN_B', source: 'return 2' })
    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledTimes(2)
    })
    store.setter(unregisterCustomFormulaAtom, 'CHURN_B')
    store.setter(registerCustomFormulaAtom, { name: 'CHURN_C', source: 'return 3' })
    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledTimes(3)
    })
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(unregisterSpy).toHaveBeenCalledTimes(3)
    expect(registerSpy).toHaveBeenCalledTimes(1)
    expect(remote).toEqual(new Set(['STUCK_A']))

    rejectCleanup = false
    view.unmount()
    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledTimes(4)
      expect(remote.size).toBe(0)
    })
  })

  it('lands a deferred stale-unregister failure on the newest generation', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = createStore()
    const firstUnregisterGate = createDeferredVoid()
    const remote = new Set<string>()
    let rejectCleanup = true
    const registerSpy = jest.fn<(name: string) => Promise<void>>(async (name) => {
      remote.add(name)
    })
    let unregisterCalls = 0
    const unregisterSpy = jest.fn<(name: string) => Promise<void>>(async (name) => {
      unregisterCalls += 1
      if (unregisterCalls === 1) await firstUnregisterGate.promise
      if (rejectCleanup) throw new Error('worker cleanup failed')
      remote.delete(name)
    })
    const backend: SpreadsheetBackend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      registerCustomFormula: registerSpy,
      unregisterCustomFormula: unregisterSpy,
    }

    const view = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    store.setter(registerCustomFormulaAtom, { name: 'STALE_A', source: 'return 1' })
    await waitFor(() => {
      expect(remote).toEqual(new Set(['STALE_A']))
    })

    store.setter(registerCustomFormulaAtom, { name: 'STALE_A', source: 'return 2' })
    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledTimes(1)
    })
    store.setter(unregisterCustomFormulaAtom, 'STALE_A')
    store.setter(registerCustomFormulaAtom, { name: 'LATEST_B', source: 'return 3' })
    firstUnregisterGate.reject(new Error('late cleanup rejection'))
    await new Promise((resolve) => setTimeout(resolve, 25))

    // The old failure is relevant to the newest desired generation, so
    // it creates the cleanup barrier there instead of retrying in a loop.
    expect(unregisterSpy).toHaveBeenCalledTimes(1)
    expect(registerSpy).toHaveBeenCalledTimes(1)
    expect(remote).toEqual(new Set(['STALE_A']))

    // A new generation grants exactly one new cleanup attempt, still
    // without installing another remote name after that cleanup fails.
    store.setter(registerCustomFormulaAtom, { name: 'LATEST_B', source: 'return 3' })
    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledTimes(2)
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(unregisterSpy).toHaveBeenCalledTimes(2)
    expect(registerSpy).toHaveBeenCalledTimes(1)
    expect(remote).toEqual(new Set(['STALE_A']))

    rejectCleanup = false
    view.unmount()
    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledTimes(3)
      expect(remote.size).toBe(0)
    })
  })

  // Backend promises are not cancellable. A register ACK arriving after
  // unmount must therefore be followed by an explicit unregister.
  it('unmount during a pending register compensates its late ACK', async () => {
    const store = createStore()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const registerSpy = jest.fn<(name: string, source: string) => Promise<void>>(async () => {
      await gate
    })
    const unregisterSpy = jest.fn<(name: string) => Promise<void>>(async () => undefined)
    const backend: SpreadsheetBackend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      registerCustomFormula: registerSpy,
      unregisterCustomFormula: unregisterSpy,
    }

    const { unmount } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    store.setter(registerCustomFormulaAtom, {
      name: 'PENDING',
      source: 'return 1',
    })
    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledTimes(1)
    })
    // Tear down while the register is still pending.
    unmount()
    // Release the gate so the non-cancellable register takes effect.
    // Cleanup must observe the ACK and remove the remote registration.
    release()
    await waitFor(() => {
      expect(unregisterSpy).toHaveBeenCalledWith('PENDING')
    })
  })
})
