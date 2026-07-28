/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  BackendMutationResult,
  SetFormatRangeRequest,
  SpreadsheetBackend,
  VisibleProjectionRequest,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  applyFormatPainterAtom,
  armFormatPainterAtom,
  armFormatPainterStickyAtom,
  diagnosticsAtom,
  exitFormatPainterAtom,
  formatPainterClipboardAtom,
  formatPainterControllerAtom,
  formatPainterPendingAtom,
  formatPainterStateAtom,
  selectCellAtom,
  setSelectionAtom,
  setSheetProtectionAtom,
  setWorkspaceActiveSheetAtom,
  type CapturedFormat,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetToolbar } from '../src-vnext/toolbar'
import { SpreadsheetFormatPainter } from '../src-vnext/format-painter'
import { seedReadyVisibleProjection } from './projection-test-fixture'

afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function richFormat(): CapturedFormat['format'] {
  return {
    bold: true,
    italic: true,
    underline: true,
    align: 'center',
    fontSize: 16,
    fgColor: '#112233',
    bgColor: '#ffeecc',
    wrap: true,
    numberFormat: { kind: 'currency', symbol: '$', digits: 2 },
    borders: {
      top: { style: 'thin', color: '#000000' },
      bottom: { style: 'medium' },
      left: { style: 'thin' },
      right: { style: 'thin' },
    },
  }
}

function makeProjectionResult(sheetId: string): VisibleProjectionResult {
  return {
    kind: 'visible-window',
    sheetId,
    requestId: 1,
    window: { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 },
    cells: [
      { row: 0, col: 0, displayValue: 'A1', valueKind: 'string', format: richFormat() },
      { row: 1, col: 0, displayValue: 'A2', valueKind: 'string', format: {} },
      { row: 2, col: 2, displayValue: 'C3', valueKind: 'string', format: {} },
    ],
  }
}

function makeProjectionResultForRequest(
  request: VisibleProjectionRequest,
): VisibleProjectionResult {
  return {
    kind: 'visible-window',
    sheetId: request.sheetId,
    requestId: request.requestId,
    revision: request.revision,
    window: { ...request.window },
    cells: [
      { row: 0, col: 0, displayValue: 'A1', valueKind: 'string', format: richFormat() },
      { row: 1, col: 0, displayValue: 'A2', valueKind: 'string', format: richFormat() },
      { row: 2, col: 2, displayValue: 'C3', valueKind: 'string', format: richFormat() },
    ],
  }
}

function createRecordingBackend() {
  const setFormatRangeCalls: SetFormatRangeRequest[] = []
  const readVisibleProjectionCalls: VisibleProjectionRequest[] = []
  const backend: SpreadsheetBackend = {
    async readVisibleProjection(request) {
      readVisibleProjectionCalls.push(request)
      return makeProjectionResultForRequest(request)
    },
    async readRangeProjection() {
      throw new Error('not used')
    },
    async setCellInput() {
      throw new Error('not used')
    },
    async setFormatRange(request) {
      setFormatRangeCalls.push(request)
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        revision: 2,
        affectedRange: { ...request.range },
      }
    },
  }
  return { backend, setFormatRangeCalls, readVisibleProjectionCalls }
}

function primeStoreWithProjection(store: ReturnType<typeof createStore>) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 0, col: 0 } })
  seedReadyVisibleProjection(store, {
    status: 'ready',
    request: {
      kind: 'visible-window',
      sheetId: 'sheet-1',
      requestId: 1,
      reason: 'test',
      window: { rowStart: 0, rowEnd: 9, colStart: 0, colEnd: 9 },
    },
    result: makeProjectionResult('sheet-1'),
    error: undefined,
  })
}

describe('SpreadsheetFormatPainter atoms (integration)', () => {
  it('applyFormatPainterAtom on a range applies to the full target range, not just first cell', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()
    primeStoreWithProjection(store)

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    store.setter(armFormatPainterAtom, { format: richFormat() })

    store.setter(setSelectionAtom, {
      kind: 'range',
      sheetId: 'sheet-1',
      anchor: { row: 1, col: 1 },
      focus: { row: 4, col: 3 },
    })

    await waitFor(() => {
      expect(setFormatRangeCalls.length).toBeGreaterThanOrEqual(1)
    })
    const call = setFormatRangeCalls[setFormatRangeCalls.length - 1]!
    expect(call.kind).toBe('set-format-range')
    expect(call.sheetId).toBe('sheet-1')
    expect(call.range).toEqual({ rowStart: 1, rowEnd: 4, colStart: 1, colEnd: 3 })
    expect(call.format).toEqual(richFormat())
  })

  it('blocks painting onto a locked target on a protected sheet with zero transport', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls, readVisibleProjectionCalls } = createRecordingBackend()
    primeStoreWithProjection(store)
    // Only the painter source cell is unlocked; the paste target stays locked.
    store.setter(setSheetProtectionAtom, {
      sheetId: 'sheet-1',
      state: {
        mode: 'protected',
        unlockedRanges: [{ rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 }],
      },
    })

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    store.setter(armFormatPainterAtom, { format: richFormat() })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 0 } })

    // The mutation gateway blocks the format write (Excel semantics: locked
    // cells on a protected sheet cannot be reformatted) before any transport.
    await waitFor(() =>
      expect(
        store.getter(diagnosticsAtom).items.some((item) => item.code === 'MUTATION_BLOCKED_LOCKED'),
      ).toBe(true),
    )
    expect(setFormatRangeCalls).toHaveLength(0)
    expect(readVisibleProjectionCalls).toHaveLength(0)
    expect(store.getter(formatPainterControllerAtom).error?.code).toBe(
      'FORMAT_PAINTER_NON_CONTIGUOUS_TARGET',
    )
  })
})

describe('SpreadsheetFormatPainter thin-host contract', () => {
  it('captures capability getters once and preserves each original backend receiver', async () => {
    const store = createStore()
    const mutationCalls: SetFormatRangeRequest[] = []
    const refreshCalls: VisibleProjectionRequest[] = []
    const mutationReceivers: unknown[] = []
    const refreshReceivers: unknown[] = []
    let mutationCapabilityReads = 0
    let refreshCapabilityReads = 0
    const backend = {
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
    } as unknown as SpreadsheetBackend

    Object.defineProperties(backend, {
      setFormatRange: {
        configurable: true,
        enumerable: true,
        get() {
          mutationCapabilityReads += 1
          return async function (
            this: unknown,
            request: SetFormatRangeRequest,
          ): Promise<BackendMutationResult> {
            mutationReceivers.push(this)
            mutationCalls.push(request)
            return {
              sheetId: request.sheetId,
              requestId: request.requestId,
              affectedRange: { ...request.range },
            }
          }
        },
      },
      readVisibleProjection: {
        configurable: true,
        enumerable: true,
        get() {
          refreshCapabilityReads += 1
          return async function (
            this: unknown,
            request: VisibleProjectionRequest,
          ): Promise<VisibleProjectionResult> {
            refreshReceivers.push(this)
            refreshCalls.push(request)
            return makeProjectionResultForRequest(request)
          }
        },
      },
    })
    primeStoreWithProjection(store)

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    expect(mutationCapabilityReads).toBe(1)
    expect(refreshCapabilityReads).toBe(1)

    store.setter(armFormatPainterAtom, { format: richFormat() })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 0 } })

    await waitFor(() => {
      expect(mutationCalls).toHaveLength(1)
      expect(refreshCalls).toHaveLength(1)
      expect(store.getter(formatPainterPendingAtom)).toBe(false)
    })
    expect(mutationCapabilityReads).toBe(1)
    expect(refreshCapabilityReads).toBe(1)
    expect(mutationReceivers).toEqual([backend])
    expect(refreshReceivers).toEqual([backend])
    expect(mutationCalls[0]!.requestId).toBe(1)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
  })

  it('fails closed before mutation when refresh capability is absent', async () => {
    const store = createStore()
    const setFormatRange = jest.fn(async (request: SetFormatRangeRequest) => ({
      sheetId: request.sheetId,
      requestId: request.requestId,
      affectedRange: request.range,
    }))
    const backend = {
      async readRangeProjection() {
        throw new Error('not used')
      },
      async setCellInput() {
        throw new Error('not used')
      },
      setFormatRange,
    } as unknown as SpreadsheetBackend
    primeStoreWithProjection(store)

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    store.setter(armFormatPainterAtom, { format: richFormat() })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 0 } })

    await waitFor(() => {
      expect(store.getter(formatPainterControllerAtom).error?.code).toBe(
        'FORMAT_PAINTER_PORT_UNAVAILABLE',
      )
    })
    expect(setFormatRange).not.toHaveBeenCalled()
    expect(store.getter(formatPainterStateAtom)).toBe('armed')
    expect(store.getter(formatPainterClipboardAtom)).not.toBeNull()
    expect(store.getter(formatPainterPendingAtom)).toBe(false)
  })

  it('retries the latest sticky selection after the prior ticket fully settles', async () => {
    const store = createStore()
    const firstMutation = deferred<BackendMutationResult>()
    const { backend, setFormatRangeCalls, readVisibleProjectionCalls } = createRecordingBackend()
    backend.setFormatRange = async (request) => {
      setFormatRangeCalls.push(request)
      if (setFormatRangeCalls.length === 1) return firstMutation.promise
      return {
        sheetId: request.sheetId,
        requestId: request.requestId,
        affectedRange: { ...request.range },
      }
    }
    primeStoreWithProjection(store)

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    store.setter(armFormatPainterStickyAtom, { format: richFormat() })
    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 0 } })
    await waitFor(() => {
      expect(setFormatRangeCalls).toHaveLength(1)
      expect(store.getter(formatPainterPendingAtom)).toBe(true)
    })

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 2, col: 2 } })
    await Promise.resolve()
    expect(setFormatRangeCalls).toHaveLength(1)

    const firstRequest = setFormatRangeCalls[0]!
    firstMutation.resolve({
      sheetId: firstRequest.sheetId,
      requestId: firstRequest.requestId,
      affectedRange: { ...firstRequest.range },
    })

    await waitFor(() => {
      expect(setFormatRangeCalls).toHaveLength(2)
      expect(readVisibleProjectionCalls).toHaveLength(2)
      expect(store.getter(formatPainterPendingAtom)).toBe(false)
    })
    expect(setFormatRangeCalls.map((request) => request.requestId)).toEqual([1, 2])
    expect(setFormatRangeCalls[1]!.range).toEqual({
      rowStart: 2,
      rowEnd: 2,
      colStart: 2,
      colEnd: 2,
    })
    expect(store.getter(formatPainterStateAtom)).toBe('sticky')
  })
})

describe('SpreadsheetToolbar format painter button', () => {
  it('renders a format-painter button with aria-pressed reflecting state', () => {
    const store = createStore()
    const { backend } = createRecordingBackend()
    primeStoreWithProjection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    const btn = container.querySelector(
      '[data-testid="toolbar-btn-format-painter"]',
    ) as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.getAttribute('aria-pressed')).toBe('false')

    store.setter(armFormatPainterAtom, { format: richFormat() })
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.dataset.formatPainterState).toBe('armed')
  })

  it('single click arms the painter with the active cell format after the dblclick window', () => {
    jest.useFakeTimers()
    const store = createStore()
    const { backend } = createRecordingBackend()
    primeStoreWithProjection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    const btn = container.querySelector(
      '[data-testid="toolbar-btn-format-painter"]',
    ) as HTMLButtonElement

    fireEvent.click(btn)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')

    jest.advanceTimersByTime(250)

    expect(store.getter(formatPainterStateAtom)).toBe('armed')
    const clip = store.getter(formatPainterClipboardAtom)
    expect(clip).not.toBeNull()
    expect(clip!.format.bold).toBe(true)
    expect(clip!.format.numberFormat).toEqual({ kind: 'currency', symbol: '$', digits: 2 })
    expect(clip!.format.borders?.top?.style).toBe('thin')
    expect(clip!.format.bgColor).toBe('#ffeecc')

    jest.useRealTimers()
  })

  it('double click puts the painter in sticky mode', () => {
    const store = createStore()
    const { backend } = createRecordingBackend()
    primeStoreWithProjection(store)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    const btn = container.querySelector(
      '[data-testid="toolbar-btn-format-painter"]',
    ) as HTMLButtonElement
    fireEvent.dblClick(btn)

    expect(store.getter(formatPainterStateAtom)).toBe('sticky')
    expect(store.getter(formatPainterClipboardAtom)).not.toBeNull()
  })

  it('clicking the button while sticky toggles painter off to idle', () => {
    const store = createStore()
    const { backend } = createRecordingBackend()
    primeStoreWithProjection(store)
    store.setter(armFormatPainterStickyAtom, { format: richFormat() })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    const btn = container.querySelector(
      '[data-testid="toolbar-btn-format-painter"]',
    ) as HTMLButtonElement
    fireEvent.click(btn)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
  })

  it('separates the mutation receipt boundary from the refresh terminal', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls, readVisibleProjectionCalls } = createRecordingBackend()
    const refresh = deferred<VisibleProjectionResult>()
    backend.readVisibleProjection = async (request) => {
      readVisibleProjectionCalls.push(request)
      return refresh.promise
    }
    primeStoreWithProjection(store)

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    store.setter(armFormatPainterAtom, { format: richFormat() })
    expect(store.getter(formatPainterStateAtom)).toBe('armed')

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 2, col: 2 } })

    await waitFor(() => {
      expect(setFormatRangeCalls).toHaveLength(1)
    })
    // First boundary: the mutation port has been invoked exactly once.
    expect(setFormatRangeCalls[0]!.range).toEqual({
      rowStart: 2,
      rowEnd: 2,
      colStart: 2,
      colEnd: 2,
    })
    expect(setFormatRangeCalls[0]!.format).toEqual(richFormat())

    await waitFor(() => {
      expect(readVisibleProjectionCalls).toHaveLength(1)
      expect(store.getter(formatPainterControllerAtom).phase).toBe('local-acknowledged')
      expect(store.getter(formatPainterPendingAtom)).toBe(true)
    })

    // Second boundary: only a settled refresh clears the immutable ticket.
    refresh.resolve(makeProjectionResultForRequest(readVisibleProjectionCalls[0]!))
    await waitFor(() => {
      expect(store.getter(formatPainterPendingAtom)).toBe(false)
      expect(store.getter(formatPainterStateAtom)).toBe('idle')
    })
  })

  it('in sticky mode, two consecutive cell selections both apply and state stays sticky', async () => {
    const store = createStore()
    const { backend, setFormatRangeCalls } = createRecordingBackend()
    primeStoreWithProjection(store)

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetToolbar />
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    store.setter(armFormatPainterStickyAtom, { format: richFormat() })

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 1, col: 0 } })
    await waitFor(() => {
      expect(setFormatRangeCalls).toHaveLength(1)
    })
    expect(store.getter(formatPainterStateAtom)).toBe('sticky')

    store.setter(selectCellAtom, { sheetId: 'sheet-1', coord: { row: 2, col: 2 } })
    await waitFor(() => {
      expect(setFormatRangeCalls).toHaveLength(2)
    })
    expect(store.getter(formatPainterStateAtom)).toBe('sticky')
    expect(setFormatRangeCalls[1]!.range).toEqual({
      rowStart: 2,
      rowEnd: 2,
      colStart: 2,
      colEnd: 2,
    })
  })

  it('pressing Escape exits the painter to idle', () => {
    const store = createStore()
    const { backend } = createRecordingBackend()
    primeStoreWithProjection(store)
    store.setter(armFormatPainterAtom, { format: richFormat() })

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(formatPainterStateAtom)).toBe('armed')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    expect(store.getter(formatPainterClipboardAtom)).toBeNull()
  })

  it('applyFormatPainterAtom resolves blocked when the painter is idle', async () => {
    const store = createStore()
    await expect(store.setter(applyFormatPainterAtom)).resolves.toBe('blocked')
  })

  it('exitFormatPainterAtom while sticky also clears clipboard', () => {
    const store = createStore()
    store.setter(armFormatPainterStickyAtom, { format: richFormat() })
    store.setter(exitFormatPainterAtom)
    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    expect(store.getter(formatPainterClipboardAtom)).toBeNull()
  })

  it('switching the active sheet while armed clears the painter to idle', () => {
    const store = createStore()
    const { backend } = createRecordingBackend()
    primeStoreWithProjection(store)

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    store.setter(armFormatPainterAtom, { format: richFormat() })
    expect(store.getter(formatPainterStateAtom)).toBe('armed')

    // The user switches tabs. Painter must not carry over: the captured
    // source format is no longer visible, and the next cell click on the
    // new sheet would silently overwrite formatting with stale data.
    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })

    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    expect(store.getter(formatPainterClipboardAtom)).toBeNull()
  })

  it('switching the active sheet while sticky also clears the painter', () => {
    const store = createStore()
    const { backend } = createRecordingBackend()
    primeStoreWithProjection(store)

    render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetFormatPainter />
      </SpreadsheetUiProvider>
    ))

    store.setter(armFormatPainterStickyAtom, { format: richFormat() })
    expect(store.getter(formatPainterStateAtom)).toBe('sticky')

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-2' })

    expect(store.getter(formatPainterStateAtom)).toBe('idle')
    expect(store.getter(formatPainterClipboardAtom)).toBeNull()
  })

  it('mirrors painter state onto .spreadsheet-grid via data-format-painter-active', () => {
    const store = createStore()
    const { backend } = createRecordingBackend()
    primeStoreWithProjection(store)

    // Inject a fake grid root so the painter has something to mark.
    const grid = document.createElement('div')
    grid.className = 'spreadsheet-grid'
    document.body.appendChild(grid)

    try {
      render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetFormatPainter />
        </SpreadsheetUiProvider>
      ))

      expect(grid.hasAttribute('data-format-painter-active')).toBe(false)

      store.setter(armFormatPainterAtom, { format: richFormat() })
      expect(grid.getAttribute('data-format-painter-active')).toBe('armed')

      store.setter(exitFormatPainterAtom)
      expect(grid.hasAttribute('data-format-painter-active')).toBe(false)

      store.setter(armFormatPainterStickyAtom, { format: richFormat() })
      expect(grid.getAttribute('data-format-painter-active')).toBe('sticky')
    } finally {
      grid.remove()
    }
  })
})
