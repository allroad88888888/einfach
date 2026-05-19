/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  BackendMutationResult,
  SetRangeLockRequest,
  SpreadsheetBackend,
} from '@einfach/spreadsheet-ui-core'
import {
  closeProtectionUnlockAtom,
  openProtectionUnlockAtom,
  protectionUnlockStateAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetProtectionUnlockDialog } from '../src-vnext/protection'

afterEach(cleanup)

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
  unlockSpy: (req: SetRangeLockRequest) => Promise<BackendMutationResult>,
): SpreadsheetBackend {
  return {
    ...createBaseBackend(),
    setRangeLock: unlockSpy,
  }
}

const sampleTarget = {
  sheetId: 'sheet-1',
  range: { rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 2 },
}

describe('SpreadsheetProtectionUnlockDialog', () => {
  it('does not render when unlock state is closed', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    expect(queryByTestId('protection-unlock-dialog')).toBeNull()
  })

  it('renders dialog when openProtectionUnlockAtom is dispatched', async () => {
    const store = createStore()
    const backend = createBaseBackend()
    store.setter(openProtectionUnlockAtom, sampleTarget)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    await waitFor(() => expect(getByTestId('protection-unlock-dialog')).toBeTruthy())
    expect(getByTestId('protection-unlock-password')).toBeTruthy()
    expect(getByTestId('protection-unlock-confirm')).toBeTruthy()
    expect(getByTestId('protection-unlock-cancel')).toBeTruthy()
    expect(getByTestId('protection-unlock-target').textContent).toContain('sheet-1')
  })

  it('Cancel closes the dialog and clears state', () => {
    const store = createStore()
    const backend = createBaseBackend()
    store.setter(openProtectionUnlockAtom, sampleTarget)

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(protectionUnlockStateAtom).isOpen).toBe(true)
    fireEvent.click(getByTestId('protection-unlock-cancel'))
    expect(store.getter(protectionUnlockStateAtom).isOpen).toBe(false)
    expect(queryByTestId('protection-unlock-dialog')).toBeNull()
  })

  it('calls backend.setRangeLock with the target range on Unlock click', async () => {
    const store = createStore()
    const calls: SetRangeLockRequest[] = []
    const unlockSpy = jest.fn(async (req: SetRangeLockRequest): Promise<BackendMutationResult> => {
      calls.push(req)
      return { sheetId: req.sheetId }
    })
    const backend = createUnlockBackend(unlockSpy)
    store.setter(openProtectionUnlockAtom, sampleTarget)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.input(getByTestId('protection-unlock-password'), { target: { value: 'secret' } })
    fireEvent.click(getByTestId('protection-unlock-confirm'))

    await waitFor(() => expect(unlockSpy).toHaveBeenCalledTimes(1))
    expect(calls[0]!.sheetId).toBe('sheet-1')
    expect(calls[0]!.range).toEqual(sampleTarget.range)
    expect(calls[0]!.locked).toBe(false)
  })

  it('invokes verifySheetProtection and blocks backend on rejection', async () => {
    const store = createStore()
    const unlockSpy = jest.fn(async (req: SetRangeLockRequest): Promise<BackendMutationResult> => ({
      sheetId: req.sheetId,
    }))
    const backend = createUnlockBackend(unlockSpy)
    store.setter(openProtectionUnlockAtom, sampleTarget)

    const verify = jest.fn(async () => ({ ok: false, message: 'wrong password' }))

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetProtectionUnlockDialog verifySheetProtection={verify} />
      </SpreadsheetUiProvider>
    ))

    fireEvent.input(getByTestId('protection-unlock-password'), { target: { value: 'nope' } })
    fireEvent.click(getByTestId('protection-unlock-confirm'))

    await waitFor(() => {
      const err = getByTestId('protection-unlock-error')
      expect(err.textContent).toBe('wrong password')
    })
    expect(unlockSpy).not.toHaveBeenCalled()
    expect(store.getter(protectionUnlockStateAtom).isOpen).toBe(true)
  })

  it('proceeds when verifySheetProtection resolves ok', async () => {
    const store = createStore()
    const unlockSpy = jest.fn(async (req: SetRangeLockRequest): Promise<BackendMutationResult> => ({
      sheetId: req.sheetId,
    }))
    const backend = createUnlockBackend(unlockSpy)
    store.setter(openProtectionUnlockAtom, sampleTarget)

    const verify = jest.fn(async () => ({ ok: true }))

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetProtectionUnlockDialog verifySheetProtection={verify} />
      </SpreadsheetUiProvider>
    ))

    fireEvent.input(getByTestId('protection-unlock-password'), { target: { value: 'right' } })
    fireEvent.click(getByTestId('protection-unlock-confirm'))

    await waitFor(() => expect(unlockSpy).toHaveBeenCalledTimes(1))
    expect(verify).toHaveBeenCalledWith({
      sheetId: 'sheet-1',
      range: sampleTarget.range,
      password: 'right',
    })
    expect(store.getter(protectionUnlockStateAtom).isOpen).toBe(false)
  })

  it('surfaces backend error via protection-unlock-error', async () => {
    const store = createStore()
    const unlockSpy = jest.fn(async (_req: SetRangeLockRequest): Promise<BackendMutationResult> => {
      throw new Error('lock failed')
    })
    const backend = createUnlockBackend(unlockSpy)
    store.setter(openProtectionUnlockAtom, sampleTarget)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(getByTestId('protection-unlock-confirm'))

    await waitFor(() => {
      expect(getByTestId('protection-unlock-error').textContent).toBe('lock failed')
    })
    expect(store.getter(protectionUnlockStateAtom).isOpen).toBe(true)
  })

  it('submits on Enter key in the password input', async () => {
    const store = createStore()
    const unlockSpy = jest.fn(async (req: SetRangeLockRequest): Promise<BackendMutationResult> => ({
      sheetId: req.sheetId,
    }))
    const backend = createUnlockBackend(unlockSpy)
    store.setter(openProtectionUnlockAtom, sampleTarget)

    const { getByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    const pwd = getByTestId('protection-unlock-password') as HTMLInputElement
    fireEvent.input(pwd, { target: { value: 'enterme' } })
    fireEvent.keyDown(pwd, { key: 'Enter' })

    await waitFor(() => expect(unlockSpy).toHaveBeenCalledTimes(1))
  })

  it('resets the password field when the dialog reopens after a cancel', async () => {
    const store = createStore()
    const backend = createBaseBackend()
    store.setter(openProtectionUnlockAtom, sampleTarget)

    const { getByTestId, queryByTestId } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetProtectionUnlockDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.input(getByTestId('protection-unlock-password'), { target: { value: 'first' } })
    expect((getByTestId('protection-unlock-password') as HTMLInputElement).value).toBe('first')

    store.setter(closeProtectionUnlockAtom)
    await waitFor(() => expect(queryByTestId('protection-unlock-dialog')).toBeNull())

    store.setter(openProtectionUnlockAtom, sampleTarget)
    await waitFor(() => expect(queryByTestId('protection-unlock-dialog')).not.toBeNull())
    expect((getByTestId('protection-unlock-password') as HTMLInputElement).value).toBe('')
  })
})
