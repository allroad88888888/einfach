/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  SetRangeLockRequest,
  SpreadsheetBackend,
  VerifySheetProtectionPort,
} from '@einfach/spreadsheet-ui-core'
import {
  isRangeFullyUnlocked,
  openProtectionUnlockAtom,
  protectionUnlockPasswordAtom,
  protectionUnlockStateAtom,
  setSheetProtectionAtom,
  sheetProtectionAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetProtectionUnlockDialog } from '../src-vnext/protection'

afterEach(cleanup)

// Protection is UI-core canonical (#40): the dialog commits the unlock
// locally and synchronously. The backend `setRangeLock` port, when
// present, only receives a fire-and-forget mirror — the worker backends
// implement no protection port at all and the flow must still work.

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

function protectSampleSheet(store: ReturnType<typeof createStore>) {
  store.setter(setSheetProtectionAtom, {
    sheetId: sampleTarget.sheetId,
    state: { mode: 'protected', unlockedRanges: [] },
  })
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

  it('commits the unlock locally on a backend without any protection port', () => {
    const store = createStore()
    protectSampleSheet(store)
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider backend={createBaseBackend()} store={store}>
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))

    // Local canonical commit is synchronous — no transport round-trip.
    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(
      isRangeFullyUnlocked(
        store.getter(sheetProtectionAtom),
        sampleTarget.sheetId,
        sampleTarget.range,
      ),
    ).toBe(true)
  })

  it('mirrors the committed unlock through setRangeLock fire-and-forget when present', async () => {
    const store = createStore()
    protectSampleSheet(store)
    const rangeLockRequests: SetRangeLockRequest[] = []
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async setRangeLock(request) {
        rangeLockRequests.push(request)
        return { sheetId: request.sheetId, revision: 1 }
      },
    }
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))

    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    await waitFor(() => expect(rangeLockRequests).toHaveLength(1))
    expect(rangeLockRequests[0]).toMatchObject({
      kind: 'set-range-lock',
      sheetId: 'sheet-1',
      range: sampleTarget.range,
      locked: false,
    })
  })

  it('a mirror failure never rolls back the local unlock', async () => {
    const store = createStore()
    protectSampleSheet(store)
    const backend: SpreadsheetBackend = {
      ...createBaseBackend(),
      async setRangeLock() {
        throw new Error('worker disconnected')
      },
    }
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))
    await Promise.resolve()

    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
    expect(
      isRangeFullyUnlocked(
        store.getter(sheetProtectionAtom),
        sampleTarget.sheetId,
        sampleTarget.range,
      ),
    ).toBe(true)
  })

  it('passes the typed password to the host verifier and commits on success', async () => {
    const store = createStore()
    protectSampleSheet(store)
    const verify = jest.fn<VerifySheetProtectionPort>(async () => ({ ok: true }))
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider backend={createBaseBackend()} store={store}>
        <SpreadsheetProtectionUnlockDialog verifySheetProtection={verify} />
      </SpreadsheetUiProvider>
    ))

    fireEvent.input(view.getByTestId('protection-unlock-password'), {
      target: { value: 'workbook-password' },
    })
    fireEvent.click(view.getByTestId('protection-unlock-confirm'))

    await waitFor(() => expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed'))
    expect(verify).toHaveBeenCalledWith({
      sheetId: 'sheet-1',
      range: sampleTarget.range,
      password: 'workbook-password',
    })
    expect(
      isRangeFullyUnlocked(
        store.getter(sheetProtectionAtom),
        sampleTarget.sheetId,
        sampleTarget.range,
      ),
    ).toBe(true)
  })

  it('returns to Editing when password verification rejects the attempt', async () => {
    const store = createStore()
    protectSampleSheet(store)
    const verify = jest.fn<VerifySheetProtectionPort>(async () => ({
      ok: false,
      message: 'Incorrect workbook password.',
    }))
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider backend={createBaseBackend()} store={store}>
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
    expect(view.getByTestId('protection-unlock-error').textContent).toBe(
      'Incorrect workbook password.',
    )
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toEqual([])
    expect(store.getter(protectionUnlockPasswordAtom)).toBe('incorrect')
  })

  it('disables the form while verifying and re-enables it after a failure', async () => {
    const store = createStore()
    protectSampleSheet(store)
    const verification = createDeferred<{ ok: boolean; message?: string }>()
    const verify = jest.fn<VerifySheetProtectionPort>(() => verification.promise)
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider backend={createBaseBackend()} store={store}>
        <SpreadsheetProtectionUnlockDialog verifySheetProtection={verify} />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))
    await waitFor(() => {
      expect(
        (view.getByTestId('protection-unlock-confirm') as HTMLButtonElement).disabled,
      ).toBe(true)
      expect(
        (view.getByTestId('protection-unlock-password') as HTMLInputElement).disabled,
      ).toBe(true)
    })
    // Single flight: a second click while verifying is ignored.
    fireEvent.click(view.getByTestId('protection-unlock-confirm'))
    expect(verify).toHaveBeenCalledTimes(1)

    verification.resolve({ ok: false, message: 'Nope.' })
    await waitFor(() =>
      expect(
        (view.getByTestId('protection-unlock-confirm') as HTMLButtonElement).disabled,
      ).toBe(false),
    )
    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'Nope.',
    })
  })

  it('discards a verification that settles after the dialog closed', async () => {
    const store = createStore()
    protectSampleSheet(store)
    const verification = createDeferred<{ ok: boolean }>()
    const verify = jest.fn<VerifySheetProtectionPort>(() => verification.promise)
    store.setter(openProtectionUnlockAtom, sampleTarget)
    const view = render(() => (
      <SpreadsheetUiProvider backend={createBaseBackend()} store={store}>
        <SpreadsheetProtectionUnlockDialog verifySheetProtection={verify} />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))
    fireEvent.click(view.getByTestId('protection-unlock-cancel'))
    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')

    verification.resolve({ ok: true })
    await Promise.resolve()
    await Promise.resolve()

    // The stale verification can never commit against the closed session.
    expect(store.getter(sheetProtectionAtom)['sheet-1'].unlockedRanges).toEqual([])
    expect(store.getter(protectionUnlockStateAtom).phase).toBe('closed')
  })

  it('shows a retryable editing error when the target lacks a range', () => {
    const store = createStore()
    protectSampleSheet(store)
    store.setter(openProtectionUnlockAtom, { sheetId: 'sheet-1' })
    const view = render(() => (
      <SpreadsheetUiProvider backend={createBaseBackend()} store={store}>
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(view.getByTestId('protection-unlock-confirm'))

    expect(store.getter(protectionUnlockStateAtom)).toMatchObject({
      phase: 'editing',
      error: 'Select a range to unlock.',
    })
    expect(view.getByTestId('protection-unlock-error').textContent).toBe(
      'Select a range to unlock.',
    )
  })
})
