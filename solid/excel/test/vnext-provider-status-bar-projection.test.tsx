/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore, type Store } from '@einfach/core'
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import {
  selectCellAtom,
  selectionAggregatesAtom,
  statusBarProjectionCellsAtom,
  type SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { seedReadyVisibleProjection } from './projection-test-fixture'

afterEach(cleanup)

function createFakeBackend(): SpreadsheetBackend {
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

function seedNumericProjection(store: Store, value: number): void {
  seedReadyVisibleProjection(store, {
    status: 'ready',
    result: {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      window: { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 },
      requestId: 0,
      cells: [
        {
          row: 0,
          col: 0,
          displayValue: String(value),
          valueKind: 'number',
          numericValue: value,
        },
      ],
    },
  })
}

function prepareStore(value: number): Store {
  const store = createStore()
  store.setter(selectCellAtom, {
    sheetId: 'sheet-1',
    coord: { row: 0, col: 0 },
  })
  seedNumericProjection(store, value)
  return store
}

describe('vNext Provider status-bar projection bridge', () => {
  it('synchronizes initial and later canonical results without a mounted status bar', async () => {
    const store = prepareStore(10)

    render(() => (
      <SpreadsheetUiProvider backend={createFakeBackend()} store={store}>
        <div data-testid="provider-child" />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(store.getter(selectionAggregatesAtom).sum).toBe(10))
    expect(store.getter(statusBarProjectionCellsAtom)).toHaveLength(1)

    seedNumericProjection(store, 25)

    await waitFor(() => expect(store.getter(selectionAggregatesAtom).sum).toBe(25))
    expect(store.getter(statusBarProjectionCellsAtom)[0]?.displayValue).toBe('25')
  })

  it('clears on Provider unmount and ignores later projection changes', async () => {
    const store = prepareStore(10)
    const rendered = render(() => (
      <SpreadsheetUiProvider backend={createFakeBackend()} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(store.getter(selectionAggregatesAtom).sum).toBe(10))
    rendered.unmount()

    expect(store.getter(statusBarProjectionCellsAtom)).toHaveLength(0)
    expect(store.getter(selectionAggregatesAtom).sum).toBe(0)

    seedNumericProjection(store, 99)

    expect(store.getter(statusBarProjectionCellsAtom)).toHaveLength(0)
    expect(store.getter(selectionAggregatesAtom).sum).toBe(0)
  })

  it('prevents an older shared-store Provider from clearing the current lifecycle', async () => {
    const store = prepareStore(10)
    const first = render(() => (
      <SpreadsheetUiProvider backend={createFakeBackend()} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))
    const second = render(() => (
      <SpreadsheetUiProvider backend={createFakeBackend()} store={store}>
        <div />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(store.getter(selectionAggregatesAtom).sum).toBe(10))
    first.unmount()
    expect(store.getter(selectionAggregatesAtom).sum).toBe(10)

    seedNumericProjection(store, 40)
    await waitFor(() => expect(store.getter(selectionAggregatesAtom).sum).toBe(40))

    second.unmount()
    expect(store.getter(statusBarProjectionCellsAtom)).toHaveLength(0)
    expect(store.getter(selectionAggregatesAtom).sum).toBe(0)
  })
})
