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
    jest.fn<(name: string, source: string) => Promise<void>>(
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
    expect(registerSpy.mock.calls[0]).toEqual(['MYTAX', 'return args[0] * 0.2'])
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
    expect(registerSpy.mock.calls[1]).toEqual(['GREET', "return 'hello'"])
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
      expect(registerSpy).toHaveBeenCalledWith('PREMOUNT', 'return 1')
    })
  })
})
