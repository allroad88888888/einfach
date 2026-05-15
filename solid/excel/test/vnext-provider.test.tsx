/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { atom, createStore } from '@einfach/core'
import { useAtomValue, useSetAtom } from '@einfach/solid'
import { render, cleanup, waitFor } from '@solidjs/testing-library'
import { createEffect } from 'solid-js'
import {
  SpreadsheetUiProvider,
  useSpreadsheetBackend,
  useSpreadsheetUiCore,
  useSpreadsheetUiCoreContext,
} from '../src-vnext/provider'

afterEach(cleanup)

describe('vNext SpreadsheetUiProvider', () => {
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
      async readVisibleProjection() { throw new Error('not used') },
      async readRangeProjection() { throw new Error('not used') },
      async setCellInput() { throw new Error('not used') },
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
})
