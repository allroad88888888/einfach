/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore, type Store } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  DisplayCell,
  RangeProjectionRequest,
  RangeProjectionResult,
  RemoveDuplicatesControllerPort,
  RemoveRowsExactRequest,
  RemoveRowsExactResult,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  createVisibleProjectionRequest,
  dispatchRemoveDuplicatesIntentAtom,
  historyStackAtom,
  openRemoveDuplicatesAtom,
  openRemoveDuplicatesFromSelectionAtom,
  removeDuplicatesComparisonAtom,
  removeDuplicatesExcludeHeaderAtom,
  removeDuplicatesKeyColumnsAtom,
  removeDuplicatesLifecycleAtom,
  removeDuplicatesOpenAtom,
  removeDuplicatesPreviewAtom,
  removeDuplicatesSessionAtom,
  selectionAtom,
  setWorkspaceActiveSheetAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetRemoveDuplicatesDialog } from '../src-vnext/remove-duplicates'
import { seedReadyVisibleProjection } from './projection-test-fixture'

afterEach(cleanup)

const SHEET_ID = 'sheet-1'
const SELECTION_RANGE = Object.freeze({
  rowStart: 0,
  rowEnd: 4,
  colStart: 0,
  colEnd: 1,
})
const DIALOG_RANGE = Object.freeze({
  startRow: 0,
  endRow: 4,
  startCol: 0,
  endCol: 1,
})

function cell(row: number, col: number, displayValue: string): DisplayCell {
  return {
    row,
    col,
    displayValue,
    valueKind: displayValue.length === 0 ? 'blank' : 'string',
  }
}

const CELLS: readonly DisplayCell[] = Object.freeze([
  cell(0, 0, 'Region'),
  cell(0, 1, 'Score'),
  cell(1, 0, 'North'),
  cell(1, 1, '100'),
  cell(2, 0, 'South'),
  cell(2, 1, '200'),
  cell(3, 0, 'North'),
  cell(3, 1, '300'),
  cell(4, 0, 'East'),
  cell(4, 1, '400'),
])

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function rangeAcknowledgement(
  request: RangeProjectionRequest,
  revision: number | string = 1,
): RangeProjectionResult {
  return {
    kind: 'range',
    requestId: request.requestId,
    sheetId: request.sheetId,
    range: request.range,
    revision,
    cells: Array.from(CELLS),
  }
}

function visibleAcknowledgement(
  request: VisibleProjectionRequest,
  revision: number | string = 3,
): VisibleProjectionResult {
  return {
    kind: 'visible-window',
    requestId: request.requestId,
    sheetId: request.sheetId,
    window: request.window,
    revision,
    cells: Array.from(CELLS),
  }
}

function mutationAcknowledgement(
  request: RemoveRowsExactRequest,
  revision = 2,
): RemoveRowsExactResult {
  return {
    requestId: request.requestId,
    sheetId: request.sheetId,
    targetRange: request.targetRange,
    removedRowIndices: Array.from(request.rows),
    removedRows: request.rows.length,
    affectedRange:
      request.rows.length === 0
        ? null
        : {
            startRow: request.rows[0],
            endRow: request.targetRange.rowEnd,
            startCol: request.targetRange.colStart,
            endCol: request.targetRange.colEnd,
          },
    revision,
  }
}

interface BackendOverrides {
  readonly readVisibleProjection?: SpreadsheetBackend['readVisibleProjection']
  readonly readRangeProjection?: SpreadsheetBackend['readRangeProjection']
  readonly removeRowsExact?: NonNullable<RemoveDuplicatesControllerPort['removeRowsExact']>
}

type RemoveDuplicatesBackend = SpreadsheetBackend & RemoveDuplicatesControllerPort

function createBackend(overrides: BackendOverrides = {}): RemoveDuplicatesBackend {
  return {
    readVisibleProjection:
      overrides.readVisibleProjection ?? (async (request) => visibleAcknowledgement(request)),
    readRangeProjection:
      overrides.readRangeProjection ?? (async (request) => rangeAcknowledgement(request)),
    async setCellInput() {
      throw new Error('not used')
    },
    removeRowsExact:
      overrides.removeRowsExact ?? (async (request) => mutationAcknowledgement(request)),
  }
}

function seedWorkbookContext(store: Store): void {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: SHEET_ID })
  store.setter(selectionAtom, {
    kind: 'range',
    sheetId: SHEET_ID,
    anchor: { row: SELECTION_RANGE.rowStart, col: SELECTION_RANGE.colStart },
    focus: { row: SELECTION_RANGE.rowEnd, col: SELECTION_RANGE.colEnd },
  })
  const request = createVisibleProjectionRequest({
    sheetId: SHEET_ID,
    window: SELECTION_RANGE,
    requestId: 0,
    reason: 'test',
  })
  seedReadyVisibleProjection(store, {
    status: 'ready',
    request,
    result: visibleAcknowledgement(request, 1),
    error: undefined,
  })
}

async function hydrate(store: Store, backend: SpreadsheetBackend): Promise<number> {
  seedWorkbookContext(store)
  await expect(
    store.setter(openRemoveDuplicatesFromSelectionAtom, {
      source: backend,
      sheetId: SHEET_ID,
    }),
  ).resolves.toBe('editing')
  store.setter(dispatchRemoveDuplicatesIntentAtom, {
    kind: 'toggle-key-column',
    column: 1,
  })
  expect(store.getter(removeDuplicatesPreviewAtom)?.duplicateRows).toEqual([3])
  return store.getter(removeDuplicatesSessionAtom)!.sessionId
}

function renderDialog(store: Store, backend: SpreadsheetBackend) {
  return render(() => (
    <SpreadsheetUiProvider backend={backend} store={store}>
      <SpreadsheetRemoveDuplicatesDialog />
    </SpreadsheetUiProvider>
  ))
}

describe('SpreadsheetRemoveDuplicatesDialog Core lifecycle binding', () => {
  it('does not render while Core is closed', () => {
    const store = createStore()
    const { queryByTestId } = renderDialog(store, createBackend())
    expect(queryByTestId('remove-duplicates-dialog')).toBeNull()
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('closed')
  })

  it('renders immutable Core projections and dispatches typed form intents', async () => {
    const store = createStore()
    const backend = createBackend()
    await hydrate(store, backend)
    const { getByTestId } = renderDialog(store, backend)

    expect(getByTestId('remove-duplicates-dialog').getAttribute('data-status')).toBe('editing')
    expect((getByTestId('remove-duplicates-column-0') as HTMLInputElement).checked).toBe(true)
    expect((getByTestId('remove-duplicates-column-1') as HTMLInputElement).checked).toBe(false)

    fireEvent.click(getByTestId('remove-duplicates-column-1'))
    expect(Array.from(store.getter(removeDuplicatesKeyColumnsAtom))).toEqual([0, 1])
    fireEvent.click(getByTestId('remove-duplicates-comparison-trimAndIgnoreCase'))
    expect(store.getter(removeDuplicatesComparisonAtom)).toBe('trimAndIgnoreCase')
    fireEvent.click(getByTestId('remove-duplicates-exclude-header'))
    expect(store.getter(removeDuplicatesExcludeHeaderAtom)).toBe(false)
  })

  it('cancel and Escape close only an editable session', async () => {
    const store = createStore()
    const backend = createBackend()
    await hydrate(store, backend)
    const view = renderDialog(store, backend)

    fireEvent.click(view.getByTestId('remove-duplicates-cancel-button'))
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(false)

    await hydrate(store, backend)
    await waitFor(() => expect(view.getByTestId('remove-duplicates-dialog')).toBeTruthy())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(false)
  })

  it('commits exact rows once, records history once, refreshes, and closes', async () => {
    const store = createStore()
    const mutationRequests: RemoveRowsExactRequest[] = []
    const refreshRequests: VisibleProjectionRequest[] = []
    const backend = createBackend({
      async removeRowsExact(request) {
        mutationRequests.push(request)
        return mutationAcknowledgement(request)
      },
      async readVisibleProjection(request) {
        refreshRequests.push(request)
        return visibleAcknowledgement(request)
      },
    })
    await hydrate(store, backend)
    const { getByTestId, queryByTestId } = renderDialog(store, backend)

    fireEvent.click(getByTestId('remove-duplicates-confirm-button'))
    await waitFor(() => expect(queryByTestId('remove-duplicates-dialog')).toBeNull())

    expect(mutationRequests).toHaveLength(1)
    expect(mutationRequests[0]).toMatchObject({
      kind: 'remove-rows',
      sheetId: SHEET_ID,
      targetRange: SELECTION_RANGE,
      rows: [3],
      revision: 1,
    })
    expect(refreshRequests).toHaveLength(1)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('closed')
  })

  it('renders mutation-pending as busy and makes same-tick double confirm single-flight', async () => {
    const store = createStore()
    const mutation = deferred<RemoveRowsExactResult>()
    let mutationRequest: RemoveRowsExactRequest | undefined
    let mutationCalls = 0
    const backend = createBackend({
      removeRowsExact(request) {
        mutationCalls += 1
        mutationRequest = request
        return mutation.promise
      },
    })
    await hydrate(store, backend)
    const { getByTestId, queryByTestId } = renderDialog(store, backend)
    const confirm = getByTestId('remove-duplicates-confirm-button')

    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('mutation-pending')
    await waitFor(() => {
      expect(getByTestId('remove-duplicates-dialog').getAttribute('aria-busy')).toBe('true')
      expect((getByTestId('remove-duplicates-cancel-button') as HTMLButtonElement).disabled).toBe(
        true,
      )
    })
    await waitFor(() => expect(mutationCalls).toBe(1))
    mutation.resolve(mutationAcknowledgement(mutationRequest!))
    await waitFor(() => expect(queryByTestId('remove-duplicates-dialog')).toBeNull())
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })

  it('shows outcome-unknown and blocks close when the adapter echoes the pre-mutation revision', async () => {
    const store = createStore()
    let mutationCalls = 0
    const backend = createBackend({
      async removeRowsExact(request) {
        mutationCalls += 1
        return mutationAcknowledgement(request, request.revision as number)
      },
    })
    await hydrate(store, backend)
    const { getByTestId } = renderDialog(store, backend)

    fireEvent.click(getByTestId('remove-duplicates-confirm-button'))
    await waitFor(() =>
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('outcome-unknown'),
    )

    expect(getByTestId('remove-duplicates-error').textContent).toContain(
      'backend did not return a matching acknowledgement',
    )
    expect((getByTestId('remove-duplicates-close-x') as HTMLButtonElement).disabled).toBe(true)
    expect((getByTestId('remove-duplicates-confirm-button') as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(store.getter(historyStackAtom).entries).toHaveLength(0)
    expect(mutationCalls).toBe(1)
  })

  it('retries only refresh after refresh-failed and never duplicates mutation/history', async () => {
    const store = createStore()
    let mutationCalls = 0
    let refreshCalls = 0
    const backend = createBackend({
      async removeRowsExact(request) {
        mutationCalls += 1
        return mutationAcknowledgement(request)
      },
      async readVisibleProjection(request) {
        refreshCalls += 1
        if (refreshCalls === 1) throw new Error('projection offline')
        return visibleAcknowledgement(request)
      },
    })
    await hydrate(store, backend)
    const { getByTestId, queryByTestId } = renderDialog(store, backend)

    fireEvent.click(getByTestId('remove-duplicates-confirm-button'))
    await waitFor(() =>
      expect(store.getter(removeDuplicatesLifecycleAtom).status).toBe('refresh-failed'),
    )
    expect(getByTestId('remove-duplicates-error').textContent).toContain('projection offline')
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
    expect((getByTestId('remove-duplicates-confirm-button') as HTMLButtonElement).disabled).toBe(
      false,
    )

    fireEvent.click(getByTestId('remove-duplicates-confirm-button'))
    await waitFor(() => expect(queryByTestId('remove-duplicates-dialog')).toBeNull())
    expect(mutationCalls).toBe(1)
    expect(refreshCalls).toBe(2)
    expect(store.getter(historyStackAtom).entries).toHaveLength(1)
  })

  it('keeps the legacy open path visible but non-committable until the default entry is migrated', async () => {
    const store = createStore()
    const backend = createBackend()
    store.setter(openRemoveDuplicatesAtom, DIALOG_RANGE, CELLS)
    const { getByTestId } = renderDialog(store, backend)

    await waitFor(() => expect(getByTestId('remove-duplicates-dialog')).toBeTruthy())
    expect(store.getter(removeDuplicatesSessionAtom)).toBeNull()
    expect((getByTestId('remove-duplicates-confirm-button') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
