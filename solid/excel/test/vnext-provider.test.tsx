/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { atom, createStore } from '@einfach/core'
import { useAtomValue, useSetAtom } from '@einfach/solid'
import { render, cleanup, waitFor } from '@solidjs/testing-library'
import { createEffect, createSignal, type Setter } from 'solid-js'
import {
  fillSeriesLocaleAtom,
  namedRangeCapabilitiesAtom,
  namedRangeRegistryStateAtom,
  type NamedRangeBackendCapabilities,
} from '@einfach/spreadsheet-ui-core'
import { setLocale } from '../src/i18n'
import {
  createStaticNamedRangeCapabilityPort,
  createStaticSpreadsheetBackend,
} from '../src-vnext/adapter'
import {
  SpreadsheetUiProvider,
  useSpreadsheetBackend,
  useSpreadsheetUiCore,
  useSpreadsheetUiCoreContext,
} from '../src-vnext/provider'

afterEach(() => {
  cleanup()
  setLocale('zh')
})

const NAMED_RANGE_CAPABILITIES: NamedRangeBackendCapabilities = Object.freeze({
  runtime: 'static-session',
  scopes: Object.freeze(['workbook', 'sheet'] as const),
  bindings: Object.freeze({ range: true, constant: true, lambda: false }),
  delete: true,
  rangeSemantics: 'stored-definition',
  listAuthority: 'static-session-registry',
  definitionReadback: 'full',
  namesWitness: true,
  mutationAck: 'session-registry-accepted',
  durability: 'session-local',
})

function unusedBackend() {
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

describe('vNext SpreadsheetUiProvider', () => {
  it('seeds localized fill-series facts before children read them and tracks language switches', async () => {
    setLocale('zh')
    const store = createStore()
    const firstChildLocales: Array<string | undefined> = []

    function Probe() {
      const locale = useAtomValue(fillSeriesLocaleAtom)
      firstChildLocales.push(locale().locale)
      return <div data-testid="fill-locale">{locale().locale}</div>
    }

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider
        backend={unusedBackend()}
        customFillSeriesLists={{ priority: ['低', '中', '高'] }}
        store={store}
      >
        <Probe />
      </SpreadsheetUiProvider>
    ))

    expect(firstChildLocales[0]).toBe('zh')
    expect(getByTestId('fill-locale').textContent).toBe('zh')
    const initial = store.getter(fillSeriesLocaleAtom)
    expect(initial).toMatchObject({
      locale: 'zh',
      weekdayNames: ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'],
      customLists: { priority: ['低', '中', '高'] },
    })
    expect(initial.monthNames).toHaveLength(12)
    expect(Object.isFrozen(initial)).toBe(true)
    expect(Object.isFrozen(initial.customLists?.priority)).toBe(true)

    setLocale('en')
    await waitFor(() => {
      expect(getByTestId('fill-locale').textContent).toBe('en')
      expect(store.getter(fillSeriesLocaleAtom)).toMatchObject({
        locale: 'en',
        weekdayNames: [
          'Monday',
          'Tuesday',
          'Wednesday',
          'Thursday',
          'Friday',
          'Saturday',
          'Sunday',
        ],
        customLists: { priority: ['低', '中', '高'] },
      })
    })
    expect(store.getter(fillSeriesLocaleAtom).monthNames).toHaveLength(12)
  })

  it('keeps custom fill-series lists isolated between provider stores', () => {
    setLocale('zh')
    const firstStore = createStore()
    const secondStore = createStore()

    render(() => (
      <>
        <SpreadsheetUiProvider
          backend={unusedBackend()}
          customFillSeriesLists={{ priority: ['低', '中', '高'] }}
          store={firstStore}
        >
          <div />
        </SpreadsheetUiProvider>
        <SpreadsheetUiProvider
          backend={unusedBackend()}
          customFillSeriesLists={{ temperature: ['冷', '温', '热'] }}
          store={secondStore}
        >
          <div />
        </SpreadsheetUiProvider>
      </>
    ))

    const first = firstStore.getter(fillSeriesLocaleAtom)
    const second = secondStore.getter(fillSeriesLocaleAtom)
    expect(first.customLists).toEqual({ priority: ['低', '中', '高'] })
    expect(second.customLists).toEqual({ temperature: ['冷', '温', '热'] })
    expect(first.customLists).not.toBe(second.customLists)
    expect(first.locale).toBe('zh')
    expect(second.locale).toBe('zh')
  })

  it('clears removed lists and lets invalid lists fail closed without blocking locale updates', async () => {
    setLocale('zh')
    const store = createStore()
    let setCustomLists!: Setter<Readonly<Record<string, readonly string[]>> | undefined>

    render(() => {
      const [customLists, setLists] = createSignal<
        Readonly<Record<string, readonly string[]>> | undefined
      >({
        priority: ['低', '中', '高'],
      })
      setCustomLists = setLists

      return (
        <SpreadsheetUiProvider
          backend={unusedBackend()}
          customFillSeriesLists={customLists()}
          store={store}
        >
          <div />
        </SpreadsheetUiProvider>
      )
    })

    expect(store.getter(fillSeriesLocaleAtom).customLists).toEqual({
      priority: ['低', '中', '高'],
    })

    setCustomLists(undefined)
    await waitFor(() => {
      expect(store.getter(fillSeriesLocaleAtom).customLists).toEqual({})
    })

    setCustomLists({ priority: ['low', 'LOW'] })
    setLocale('en')
    await waitFor(() => {
      expect(store.getter(fillSeriesLocaleAtom)).toMatchObject({
        locale: 'en',
        weekdayNames: [
          'Monday',
          'Tuesday',
          'Wednesday',
          'Thursday',
          'Friday',
          'Saturday',
          'Sunday',
        ],
        customLists: {},
      })
    })
  })

  it('creates an independent store per provider instance', async () => {
    const sharedAtom = atom(0)
    const seenStores: Array<ReturnType<typeof createStore>> = []

    function Probe(props: { value: number; testId: string }) {
      const core = useSpreadsheetUiCore()
      const setValue = useSetAtom(sharedAtom)
      const value = useAtomValue(sharedAtom)

      createEffect(() => {
        seenStores.push(core.store)
      })

      createEffect(() => {
        setValue(props.value)
      })

      return <div data-testid={props.testId}>{value()}</div>
    }

    const backend = {
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

    const { getByTestId } = render(() => (
      <>
        <SpreadsheetUiProvider backend={backend}>
          <Probe value={1} testId="first" />
        </SpreadsheetUiProvider>
        <SpreadsheetUiProvider backend={backend}>
          <Probe value={2} testId="second" />
        </SpreadsheetUiProvider>
      </>
    ))

    return waitFor(() => {
      expect(getByTestId('first').textContent).toBe('1')
      expect(getByTestId('second').textContent).toBe('2')
    })
    expect(seenStores).toHaveLength(2)
    expect(seenStores[0]).not.toBe(seenStores[1])
  })

  it('useSpreadsheetUiCoreContext returns { store, backend } without throwing', () => {
    const backend = {
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

    let capturedCore: ReturnType<typeof useSpreadsheetUiCoreContext> | undefined

    function Probe() {
      capturedCore = useSpreadsheetUiCoreContext()
      return <div data-testid="core">{capturedCore ? 'ok' : 'missing'}</div>
    }

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend}>
        <Probe />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('core').textContent).toBe('ok')
    expect(capturedCore).toBeDefined()
    expect(capturedCore!.backend).toBe(backend)
    expect(capturedCore!.store).toBeDefined()
  })

  it('exposes the backend through useSpreadsheetBackend', () => {
    const backend = {
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

    function Probe() {
      const resolvedBackend = useSpreadsheetBackend()
      return <div data-testid="backend">{resolvedBackend === backend ? 'yes' : 'no'}</div>
    }

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend}>
        <Probe />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('backend').textContent).toBe('yes')
  })

  it('loads named-range capabilities only through the explicit capability port', async () => {
    const store = createStore()
    const hiddenBackendReader = jest.fn(async () => NAMED_RANGE_CAPABILITIES)
    const injectedReader = jest.fn(async () => NAMED_RANGE_CAPABILITIES)
    const listNamedRanges = jest.fn(async (request: { requestId?: number }) => ({
      requestId: request.requestId,
      revision: 1,
      names: [],
    }))
    const backend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      listNamedRanges,
      // Deliberately present as an undeclared extra property. The provider
      // must never discover or call it through SpreadsheetBackend.
      readNamedRangeCapabilities: hiddenBackendReader,
    }

    render(() => (
      <SpreadsheetUiProvider
        backend={backend}
        namedRangeCapabilityPort={{ readNamedRangeCapabilities: injectedReader }}
        store={store}
      >
        <div />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(store.getter(namedRangeCapabilitiesAtom).status).toBe('ready')
      expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready')
    })
    expect(injectedReader).toHaveBeenCalledTimes(1)
    expect(hiddenBackendReader).not.toHaveBeenCalled()
    expect(listNamedRanges).toHaveBeenCalledTimes(1)
  })

  it('wires the concrete static capability port into the provider', async () => {
    const store = createStore()
    const backend = createStaticSpreadsheetBackend({
      revision: 1,
      sheets: [{ id: 'sheet-1', name: 'Sheet1' }],
      matrix: [['ready']],
    })

    render(() => (
      <SpreadsheetUiProvider
        backend={backend}
        namedRangeCapabilityPort={createStaticNamedRangeCapabilityPort()}
        store={store}
      >
        <div />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(store.getter(namedRangeCapabilitiesAtom).status).toBe('ready')
      expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready')
    })
    expect(store.getter(namedRangeCapabilitiesAtom).capabilities?.runtime).toBe('static-session')
    expect(store.getter(namedRangeRegistryStateAtom).names).toEqual([])
  })

  it('does not discover a capability reader hidden on the backend', async () => {
    const store = createStore()
    const hiddenBackendReader = jest.fn(async () => NAMED_RANGE_CAPABILITIES)
    const listNamedRanges = jest.fn(async (request: { requestId?: number }) => ({
      requestId: request.requestId,
      names: [],
    }))
    const backend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      listNamedRanges,
      readNamedRangeCapabilities: hiddenBackendReader,
    }

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => {
      expect(store.getter(namedRangeCapabilitiesAtom).status).toBe('unavailable')
    })
    expect(store.getter(namedRangeRegistryStateAtom).status).toBe('idle')
    expect(hiddenBackendReader).not.toHaveBeenCalled()
    expect(listNamedRanges).not.toHaveBeenCalled()
  })

  it('detaches the registry refresh listener when the provider unmounts', async () => {
    const store = createStore()
    let resolveCapabilities!: (value: NamedRangeBackendCapabilities) => void
    const pendingCapabilities = new Promise<NamedRangeBackendCapabilities>((resolve) => {
      resolveCapabilities = resolve
    })
    const injectedReader = jest.fn(() => pendingCapabilities)
    const listNamedRanges = jest.fn(async (request: { requestId?: number }) => ({
      requestId: request.requestId,
      names: [],
    }))
    const backend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      listNamedRanges,
    }

    const view = render(() => (
      <SpreadsheetUiProvider
        backend={backend}
        namedRangeCapabilityPort={{ readNamedRangeCapabilities: injectedReader }}
        store={store}
      >
        <div />
      </SpreadsheetUiProvider>
    ))
    await waitFor(() => expect(injectedReader).toHaveBeenCalledTimes(1))
    expect(store.getter(namedRangeCapabilitiesAtom).status).toBe('loading')

    view.unmount()
    resolveCapabilities(NAMED_RANGE_CAPABILITIES)
    await waitFor(() => expect(store.getter(namedRangeCapabilitiesAtom).status).toBe('ready'))
    expect(store.getter(namedRangeRegistryStateAtom).status).toBe('idle')
    expect(listNamedRanges).not.toHaveBeenCalled()
  })

  it('lets only the current capability request refresh a shared store', async () => {
    const store = createStore()
    let resolveStaleCapabilities!: (value: NamedRangeBackendCapabilities) => void
    let resolveCurrentCapabilities!: (value: NamedRangeBackendCapabilities) => void
    const staleCapabilities = new Promise<NamedRangeBackendCapabilities>((resolve) => {
      resolveStaleCapabilities = resolve
    })
    const currentCapabilities = new Promise<NamedRangeBackendCapabilities>((resolve) => {
      resolveCurrentCapabilities = resolve
    })
    const staleReader = jest.fn(() => staleCapabilities)
    const currentReader = jest.fn(() => currentCapabilities)
    const staleListNamedRanges = jest.fn(async (request: { requestId?: number }) => ({
      requestId: request.requestId,
      names: [],
    }))
    const currentListNamedRanges = jest.fn(async (request: { requestId?: number }) => ({
      requestId: request.requestId,
      names: [],
    }))
    const staleBackend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      listNamedRanges: staleListNamedRanges,
    }
    const currentBackend = {
      async readVisibleProjection() {
        throw new Error('not used')
      },
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      listNamedRanges: currentListNamedRanges,
    }

    render(() => (
      <>
        <SpreadsheetUiProvider
          backend={staleBackend}
          namedRangeCapabilityPort={{ readNamedRangeCapabilities: staleReader }}
          store={store}
        >
          <div />
        </SpreadsheetUiProvider>
        <SpreadsheetUiProvider
          backend={currentBackend}
          namedRangeCapabilityPort={{ readNamedRangeCapabilities: currentReader }}
          store={store}
        >
          <div />
        </SpreadsheetUiProvider>
      </>
    ))

    await waitFor(() => {
      expect(staleReader).toHaveBeenCalledTimes(1)
      expect(currentReader).toHaveBeenCalledTimes(1)
    })
    resolveStaleCapabilities(NAMED_RANGE_CAPABILITIES)
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getter(namedRangeCapabilitiesAtom).status).toBe('loading')
    expect(staleListNamedRanges).not.toHaveBeenCalled()
    expect(currentListNamedRanges).not.toHaveBeenCalled()

    resolveCurrentCapabilities(NAMED_RANGE_CAPABILITIES)
    await waitFor(() => {
      expect(store.getter(namedRangeCapabilitiesAtom).status).toBe('ready')
      expect(store.getter(namedRangeRegistryStateAtom).status).toBe('ready')
    })
    expect(staleListNamedRanges).not.toHaveBeenCalled()
    expect(currentListNamedRanges).toHaveBeenCalledTimes(1)
  })
})
