/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  ReadSheetProtectionRequest,
  ReadSheetProtectionResult,
  SetRangeLockRequest,
  SetRangeLockResult,
  SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import {
  openProtectionUnlockAtom,
  protectionUnlockMutationBlockedAtom,
  protectionUnlockPasswordAtom,
  protectionUnlockStateAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetProtectionUnlockDialog } from '../src-vnext/protection'

afterEach(cleanup)

const sampleTarget = {
  sheetId: 'sheet-1',
  range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
}

function createBaseBackend(): SpreadsheetBackend {
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

function createUnlockBackend(
  setRangeLock?: (request: SetRangeLockRequest) => Promise<SetRangeLockResult>,
  readSheetProtection?: (request: ReadSheetProtectionRequest) => Promise<ReadSheetProtectionResult>,
): SpreadsheetBackend {
  return { ...createBaseBackend(), setRangeLock, readSheetProtection }
}

function acknowledged(request: SetRangeLockRequest, revision = 1): SetRangeLockResult {
  if (!Number.isSafeInteger(request.requestId)) throw new Error('missing requestId')
  return {
    kind: 'set-range-lock',
    requestId: request.requestId!,
    sheetId: request.sheetId,
    affectedRange: { ...request.range },
    outcome: 'acknowledged',
    revision,
  }
}

function canonical(
  request: ReadSheetProtectionRequest,
  unlocked: boolean,
  revision = 1,
): ReadSheetProtectionResult {
  return {
    kind: 'read-sheet-protection',
    requestId: request.requestId,
    sheetId: request.sheetId,
    revision,
    protection: {
      mode: 'protected',
      unlockedRanges: unlocked ? [{ ...sampleTarget.range }] : [],
    },
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('SpreadsheetProtectionUnlockDialog', () => {
  it('renders only while the Core unlock state is open', () => {
    const store = createStore()
    const backend = createBaseBackend()
    const view = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    expect(view.queryByTestId('protection-unlock-dialog')).toBeNull()
    store.setter(openProtectionUnlockAtom, sampleTarget)
    expect(view.getByTestId('protection-unlock-dialog')).toBeTruthy()
    expect(view.getByTestId('protection-unlock-target').textContent).toContain('sheet-1')
  })

  it('writes the password to Core state and Cancel closes the dialog', () => {
    const store = createStore()
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider backend={createBaseBackend()} store={store}>
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.input(view.getByTestId('protection-unlock-password'), {
      target: { value: 'workbook-password' },
    })
    expect(store.getter(protectionUnlockPasswordAtom)).toBe('workbook-password')
    fireEvent.click(view.getByTestId('protection-unlock-cancel'))
    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(view.queryByTestId('protection-unlock-dialog')).toBeNull()
  })

  it('preflights both mutation and canonical-read ports before verification', async () => {
    const store = createStore()
    const setRangeLock = jest.fn(async (request: SetRangeLockRequest) => acknowledged(request))
    const verify = jest.fn(async () => ({ ok: true }))
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider backend={createUnlockBackend(setRangeLock)} store={store}>
        <SpreadsheetProtectionUnlockDialog verifySheetProtection={verify} />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))
    await waitFor(() =>
      expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
        phase: 'editing',
        error: 'Protection editing and status refresh are unavailable.',
      }),
    )
    expect(verify).not.toHaveBeenCalled()
    expect(setRangeLock).not.toHaveBeenCalled()
  })

  it('treats password verification as optional and closes only after canonical readback', async () => {
    const store = createStore()
    const setRangeLock = jest.fn(async (request: SetRangeLockRequest) => acknowledged(request))
    const readSheetProtection = jest.fn(async (request: ReadSheetProtectionRequest) =>
      canonical(request, true),
    )
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider
        backend={createUnlockBackend(setRangeLock, readSheetProtection)}
        store={store}
      >
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))

    await waitFor(() => expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed'))
    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(setRangeLock.mock.calls[0]![0]).toMatchObject({
      kind: 'set-range-lock',
      sheetId: 'sheet-1',
      range: sampleTarget.range,
      locked: false,
    })
    expect(readSheetProtection).toHaveBeenCalledTimes(1)
    expect(readSheetProtection.mock.calls[0]![0].requestId).toBe(
      setRangeLock.mock.calls[0]![0].requestId,
    )
  })

  it('returns to Editing when password verification rejects the attempt', async () => {
    const store = createStore()
    const setRangeLock = jest.fn(async (request: SetRangeLockRequest) => acknowledged(request))
    const readSheetProtection = jest.fn(async (request: ReadSheetProtectionRequest) =>
      canonical(request, true),
    )
    const verify = jest.fn(async () => ({ ok: false, message: 'Incorrect workbook password.' }))
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider
        backend={createUnlockBackend(setRangeLock, readSheetProtection)}
        store={store}
      >
        <SpreadsheetProtectionUnlockDialog verifySheetProtection={verify} />
      </SpreadsheetUiProvider>
    ))

    fireEvent.input(view.getByTestId('protection-unlock-password'), {
      target: { value: 'incorrect' },
    })
    fireEvent.click(view.getByTestId('protection-unlock-confirm'))

    await waitFor(() =>
      expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
        phase: 'editing',
        error: 'Incorrect workbook password.',
      }),
    )
    expect(setRangeLock).not.toHaveBeenCalled()
    expect(readSheetProtection).not.toHaveBeenCalled()
    expect(store.getter(protectionUnlockPasswordAtom)).toBe('incorrect')
  })

  it('returns to Editing when the adapter confirms the change was not applied', async () => {
    const store = createStore()
    const setRangeLock = jest.fn(
      async (request: SetRangeLockRequest): Promise<SetRangeLockResult> => ({
        kind: 'set-range-lock',
        requestId: request.requestId!,
        sheetId: request.sheetId,
        affectedRange: { ...request.range },
        outcome: 'confirmed-not-applied',
        code: 'PERMISSION_DENIED',
        message: 'The sheet is protected.',
      }),
    )
    const readSheetProtection = jest.fn(async (request: ReadSheetProtectionRequest) =>
      canonical(request, false),
    )
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider
        backend={createUnlockBackend(setRangeLock, readSheetProtection)}
        store={store}
      >
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))
    await waitFor(() =>
      expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
        phase: 'editing',
        error: 'The sheet is protected.',
      }),
    )
    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(readSheetProtection).not.toHaveBeenCalled()
  })

  it('keeps Editing when canonical readback says the range is still locked', async () => {
    const store = createStore()
    const setRangeLock = jest.fn(async (request: SetRangeLockRequest) => acknowledged(request))
    const readSheetProtection = jest.fn(async (request: ReadSheetProtectionRequest) =>
      canonical(request, false),
    )
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider
        backend={createUnlockBackend(setRangeLock, readSheetProtection)}
        store={store}
      >
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))
    await waitFor(() =>
      expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
        phase: 'editing',
        error: 'The range is still locked. Try again.',
      }),
    )
    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(readSheetProtection).toHaveBeenCalledTimes(1)
  })

  it('uses read-only refresh after an unknown mutation outcome and never resends it', async () => {
    const store = createStore()
    const setRangeLock = jest.fn(async (): Promise<SetRangeLockResult> => {
      throw new Error('worker disconnected')
    })
    const readSheetProtection = jest.fn(async (request: ReadSheetProtectionRequest) =>
      canonical(request, true),
    )
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider
        backend={createUnlockBackend(setRangeLock, readSheetProtection)}
        store={store}
      >
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))
    await waitFor(() =>
      expect(store.getter(protectionUnlockStateAtom).phase).toBe('recovery-required'),
    )
    expect(view.queryByTestId('protection-unlock-confirm')).toBeNull()
    fireEvent.click(view.getByTestId('protection-unlock-refresh'))

    await waitFor(() => expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed'))
    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(readSheetProtection).toHaveBeenCalledTimes(1)
  })

  it('keeps dispatched sheet A recovery authoritative across close and attempted reopen on B', async () => {
    const store = createStore()
    const deferredMutation = createDeferred<SetRangeLockResult>()
    const setRangeLock = jest.fn((request: SetRangeLockRequest) => deferredMutation.promise)
    const readSheetProtection = jest.fn(async (request: ReadSheetProtectionRequest) =>
      canonical(request, true),
    )
    const sheetBTarget = {
      sheetId: 'sheet-2',
      range: { rowStart: 8, rowEnd: 9, colStart: 4, colEnd: 5 },
    }
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider
        backend={createUnlockBackend(setRangeLock, readSheetProtection)}
        store={store}
      >
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))
    await waitFor(() => {
      expect(setRangeLock).toHaveBeenCalledTimes(1)
      expect(store.getter(protectionUnlockStateAtom).phase).toBe('mutation-pending')
    })
    const dispatchedRequest = setRangeLock.mock.calls[0]![0]

    fireEvent.click(view.getByTestId('protection-unlock-cancel'))
    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(store.getter(protectionUnlockMutationBlockedAtom)).toBe(true)
    store.setter(openProtectionUnlockAtom, sheetBTarget)

    await waitFor(() => {
      expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
        phase: 'recovery-required',
        target: sampleTarget,
        recoveryRequired: true,
      })
      expect(view.getByTestId('protection-unlock-target').textContent).toContain('sheet-1')
    })

    deferredMutation.resolve(acknowledged(dispatchedRequest))
    await deferredMutation.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'recovery-required',
      target: sampleTarget,
      recoveryRequired: true,
    })
    expect(store.getter(protectionUnlockMutationBlockedAtom)).toBe(true)
    expect(readSheetProtection).not.toHaveBeenCalled()
    expect(view.getByTestId('protection-unlock-target').textContent).toContain('sheet-1')

    fireEvent.click(view.getByTestId('protection-unlock-refresh'))
    await waitFor(() => expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed'))
    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(readSheetProtection).toHaveBeenCalledTimes(1)
    expect(readSheetProtection.mock.calls[0]![0]).toMatchObject({
      sheetId: 'sheet-1',
      requestId: dispatchedRequest.requestId,
    })

    store.setter(openProtectionUnlockAtom, sheetBTarget)
    await waitFor(() => {
      expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
        phase: 'editing',
        target: sheetBTarget,
        recoveryRequired: false,
      })
      expect(view.getByTestId('protection-unlock-target').textContent).toContain('sheet-2')
    })
  })

  it('uses read-only refresh after ACK readback fails and preserves request identity', async () => {
    const store = createStore()
    const setRangeLock = jest.fn(async (request: SetRangeLockRequest) => acknowledged(request))
    let reads = 0
    const readSheetProtection = jest.fn(async (request: ReadSheetProtectionRequest) => {
      reads += 1
      if (reads === 1) throw new Error('readback unavailable')
      return canonical(request, true)
    })
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider
        backend={createUnlockBackend(setRangeLock, readSheetProtection)}
        store={store}
      >
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))
    await waitFor(() =>
      expect(store.getter(protectionUnlockStateAtom).phase).toBe('recovery-required'),
    )
    const firstRequestId = readSheetProtection.mock.calls[0]![0].requestId
    fireEvent.click(view.getByTestId('protection-unlock-refresh'))

    await waitFor(() => expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed'))
    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(readSheetProtection).toHaveBeenCalledTimes(2)
    expect(readSheetProtection.mock.calls[1]![0].requestId).toBe(firstRequestId)
  })

  it('requires read-only recovery when canonical revision differs from the mutation ACK', async () => {
    const store = createStore()
    const setRangeLock = jest.fn(async (request: SetRangeLockRequest) => acknowledged(request, 7))
    let reads = 0
    const readSheetProtection = jest.fn(async (request: ReadSheetProtectionRequest) => {
      reads += 1
      return canonical(request, true, reads === 1 ? 8 : 7)
    })
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider
        backend={createUnlockBackend(setRangeLock, readSheetProtection)}
        store={store}
      >
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))
    await waitFor(() =>
      expect(store.getter(protectionUnlockStateAtom).phase).toBe('recovery-required'),
    )
    fireEvent.click(view.getByTestId('protection-unlock-refresh'))

    await waitFor(() => expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed'))
    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(readSheetProtection).toHaveBeenCalledTimes(2)
    expect(readSheetProtection.mock.calls[1]![0].requestId).toBe(
      readSheetProtection.mock.calls[0]![0].requestId,
    )
  })

  it('requires recovery for a response with the wrong request identity', async () => {
    const store = createStore()
    const setRangeLock = jest.fn(
      async (request: SetRangeLockRequest): Promise<SetRangeLockResult> => ({
        ...acknowledged(request),
        requestId: request.requestId! + 1,
      }),
    )
    const readSheetProtection = jest.fn(async (request: ReadSheetProtectionRequest) =>
      canonical(request, true),
    )
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider
        backend={createUnlockBackend(setRangeLock, readSheetProtection)}
        store={store}
      >
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))
    await waitFor(() =>
      expect(store.getter(protectionUnlockStateAtom).phase).toBe('recovery-required'),
    )
    expect(setRangeLock).toHaveBeenCalledTimes(1)
    expect(readSheetProtection).not.toHaveBeenCalled()
  })
})
