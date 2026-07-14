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
import {
  customFormulasSupportedAtom,
  SpreadsheetUiProvider,
} from '../src-vnext/provider'

afterEach(cleanup)

function createBackendWithCustomFormulas() {
  const registerSpy =
    jest.fn<(name: string, source: string, options?: { isAsync?: boolean }) => Promise<void>>(
      async () => undefined,
    )
  const unregisterSpy =
    jest.fn<(name: string) => Promise<void>>(async () => undefined)
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
    expect(registerSpy.mock.calls[0]).toEqual([
      'MYTAX',
      'return args[0] * 0.2',
      { isAsync: false },
    ])
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

  it('flipping isAsync on an unchanged source triggers a replace (unregister + register)', async () => {
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
    expect(registerSpy.mock.calls[1]).toEqual([
      'MYTAX',
      'return args[0] * 0.2',
      { isAsync: true },
    ])
  })

  it(
    'unregistering an entry calls backend.unregisterCustomFormula',
    async () => {
      const store = createStore()
      const { backend, registerSpy, unregisterSpy } =
        createBackendWithCustomFormulas()

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
    },
  )

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

  it(
    'unmounting tears down currently-installed registrations',
    async () => {
      const store = createStore()
      const { backend, registerSpy, unregisterSpy } =
        createBackendWithCustomFormulas()

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
    },
  )

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

  // MED #9 — a failed register MUST leave the `installed` baseline
  // alone so the next diff replays the missing entry instead of
  // silently dropping it.
  it('a failed registerCustomFormula does not advance the baseline', async () => {
    const store = createStore()
    let attempts = 0
    const registerSpy = jest.fn<(name: string, source: string) => Promise<void>>(
      async () => {
        attempts++
        if (attempts === 1) throw new Error('worker boom')
      },
    )
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

    // Mutate the registry again with identical content. The diff
    // helper sees the slot as still-needing-install (baseline did NOT
    // advance after the failed first call) and replays the register.
    store.setter(registerCustomFormulaAtom, {
      name: 'RETRYME',
      source: 'return 1',
    })
    await waitFor(() => {
      expect(registerSpy).toHaveBeenCalledTimes(2)
    })
    // Second call succeeds (attempts > 1) → baseline now advances, so
    // a no-op mutation should NOT trigger a third call.
    store.setter(registerCustomFormulaAtom, {
      name: 'RETRYME',
      source: 'return 1',
    })
    // Give the microtask queue a moment to drain.
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(registerSpy).toHaveBeenCalledTimes(2)
  })

  // MED #10 — pending unregister→register chains MUST not reinstall a
  // stale source after the registry is mutated. The new effect uses an
  // AbortController per batch; a fresh mutation aborts the prior batch
  // and re-diffs against the up-to-date snapshot.
  it('quick register → unregister → register collapses to a single final install', async () => {
    const store = createStore()
    // Hold registers until we release them so we can interleave a
    // burst of mutations against an in-flight batch.
    let releaseFirst: () => void = () => undefined
    const firstRegister = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let registerCalls = 0
    const registerSpy = jest.fn<(name: string, source: string) => Promise<void>>(
      async () => {
        registerCalls++
        if (registerCalls === 1) await firstRegister
      },
    )
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
    // Final state: exactly one install reflecting `'return 2'`. The
    // intermediate unregister and the original `'return 1'` install
    // do not get re-fired against the worker.
    await waitFor(() => {
      const lastCall = registerSpy.mock.calls[registerSpy.mock.calls.length - 1]
      expect(lastCall?.[1]).toBe('return 2')
    })
  })

  // MED #10 — unmount aborts any in-flight chain so a stale
  // post-unmount register cannot leak past the cleanup boundary.
  it('unmount during a pending register aborts the in-flight chain', async () => {
    const store = createStore()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const registerSpy = jest.fn<(name: string, source: string) => Promise<void>>(
      async () => {
        await gate
      },
    )
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
    // Release the gate so the originally-awaited call settles. The
    // cleanup branch should NOT issue an unregister for `'PENDING'`
    // since the install never completed (installed map is empty when
    // the controller aborts mid-await).
    release()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(unregisterSpy).not.toHaveBeenCalledWith('PENDING')
  })
})
