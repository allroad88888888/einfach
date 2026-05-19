/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, render, waitFor } from '@solidjs/testing-library'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import { applyPresenceUpdateAtom, presenceStateAtom } from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetPresenceOverlay } from '../src-vnext/presence'

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

function joinParticipant(
  store: ReturnType<typeof createStore>,
  id: string,
  displayName: string,
  colorHint?: string,
  lastSeenAt = 1_000,
) {
  store.setter(applyPresenceUpdateAtom, {
    kind: 'join',
    participant: { id, displayName, colorHint, lastSeenAt },
  })
}

function setCursor(
  store: ReturnType<typeof createStore>,
  id: string,
  sheetId: string,
  row: number,
  col: number,
) {
  store.setter(applyPresenceUpdateAtom, {
    kind: 'cursor',
    participantId: id,
    sheetId,
    selection: { kind: 'cell', sheetId, anchor: { row, col }, focus: { row, col } },
  })
}

describe('SpreadsheetPresenceOverlay', () => {
  it('renders overlay container with no cursors when presence is empty', () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { getByTestId, container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPresenceOverlay />
      </SpreadsheetUiProvider>
    ))

    expect(getByTestId('presence-overlay')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid^="presence-cursor-"]').length).toBe(0)
  })

  it('renders a cursor marker per remote participant with active selection', () => {
    const store = createStore()
    const backend = createBaseBackend()

    joinParticipant(store, 'alice', 'Alice', '#ff0000', 1_000)
    joinParticipant(store, 'bob', 'Bob', '#00ff00', 2_000)
    setCursor(store, 'alice', 'sheet-1', 3, 4)
    setCursor(store, 'bob', 'sheet-1', 5, 6)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPresenceOverlay />
      </SpreadsheetUiProvider>
    ))

    expect(container.querySelector('[data-testid="presence-cursor-alice"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="presence-cursor-bob"]')).toBeTruthy()
  })

  it('attaches participant displayName and colorHint to the marker', () => {
    const store = createStore()
    const backend = createBaseBackend()

    joinParticipant(store, 'alice', 'Alice A', '#abcdef', 1_234)
    setCursor(store, 'alice', 'sheet-1', 0, 0)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPresenceOverlay />
      </SpreadsheetUiProvider>
    ))

    const label = container.querySelector(
      '[data-testid="presence-label-alice"]',
    ) as HTMLElement | null
    expect(label).not.toBeNull()
    expect(label!.textContent).toBe('Alice A')
    // setCursor bumps lastSeenAt to Date.now(); ensure the attribute is a positive number.
    expect(Number(label!.getAttribute('data-last-seen-at'))).toBeGreaterThan(0)
    // jsdom serializes hex colors to rgb()
    expect(label!.getAttribute('style') ?? '').toContain('rgb(171, 205, 239)')
  })

  it('filters cursors by activeSheetId when prop is provided', () => {
    const store = createStore()
    const backend = createBaseBackend()

    joinParticipant(store, 'alice', 'Alice', undefined, 1_000)
    joinParticipant(store, 'bob', 'Bob', undefined, 2_000)
    setCursor(store, 'alice', 'sheet-1', 0, 0)
    setCursor(store, 'bob', 'sheet-2', 0, 0)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPresenceOverlay activeSheetId="sheet-1" />
      </SpreadsheetUiProvider>
    ))

    expect(container.querySelector('[data-testid="presence-cursor-alice"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="presence-cursor-bob"]')).toBeNull()
  })

  it('reacts to applyPresenceUpdateAtom dispatches at runtime', async () => {
    const store = createStore()
    const backend = createBaseBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPresenceOverlay />
      </SpreadsheetUiProvider>
    ))

    expect(container.querySelector('[data-testid="presence-cursor-alice"]')).toBeNull()

    joinParticipant(store, 'alice', 'Alice', undefined, 1_000)
    setCursor(store, 'alice', 'sheet-1', 1, 2)

    await waitFor(() => {
      expect(container.querySelector('[data-testid="presence-cursor-alice"]')).toBeTruthy()
    })
  })

  it('uses resolveCellPosition to compute geometry when supplied', () => {
    const store = createStore()
    const backend = createBaseBackend()
    joinParticipant(store, 'alice', 'Alice', '#000000', 1_000)
    store.setter(applyPresenceUpdateAtom, {
      kind: 'cursor',
      participantId: 'alice',
      sheetId: 'sheet-1',
      selection: {
        kind: 'range',
        sheetId: 'sheet-1',
        anchor: { row: 1, col: 2 },
        focus: { row: 2, col: 3 },
      },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPresenceOverlay
          resolveCellPosition={(_sheet, row, col) => ({
            left: col * 100,
            top: row * 30,
            width: 100,
            height: 30,
          })}
        />
      </SpreadsheetUiProvider>
    ))

    const marker = container.querySelector(
      '[data-testid="presence-cursor-alice"]',
    ) as HTMLElement | null
    expect(marker).not.toBeNull()
    const style = marker!.getAttribute('style') ?? ''
    expect(style).toContain('left: 200px')
    expect(style).toContain('top: 30px')
    expect(style).toContain('width: 200px')
    expect(style).toContain('height: 60px')
  })

  it('removes the cursor marker when the participant leaves', async () => {
    const store = createStore()
    const backend = createBaseBackend()
    joinParticipant(store, 'alice', 'Alice', undefined, 1_000)
    setCursor(store, 'alice', 'sheet-1', 0, 0)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPresenceOverlay />
      </SpreadsheetUiProvider>
    ))

    expect(container.querySelector('[data-testid="presence-cursor-alice"]')).toBeTruthy()

    store.setter(applyPresenceUpdateAtom, { kind: 'leave', participantId: 'alice' })

    await waitFor(() => {
      expect(container.querySelector('[data-testid="presence-cursor-alice"]')).toBeNull()
    })
    // sanity: presence state cleared the cursor too
    const state = store.getter(presenceStateAtom)
    expect(state.cursors['alice']).toBeUndefined()
  })

  it('sets selection-kind data attribute for downstream styling', () => {
    const store = createStore()
    const backend = createBaseBackend()
    joinParticipant(store, 'alice', 'Alice', undefined, 1_000)
    store.setter(applyPresenceUpdateAtom, {
      kind: 'cursor',
      participantId: 'alice',
      sheetId: 'sheet-1',
      selection: { kind: 'row', sheetId: 'sheet-1', rowAnchor: 2, rowFocus: 4 },
    })

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPresenceOverlay />
      </SpreadsheetUiProvider>
    ))

    const marker = container.querySelector(
      '[data-testid="presence-cursor-alice"]',
    ) as HTMLElement | null
    expect(marker?.getAttribute('data-selection-kind')).toBe('row')
  })

  it('reflects participant color and cursor position updates on the existing marker', async () => {
    const store = createStore()
    const backend = createBaseBackend()
    joinParticipant(store, 'alice', 'Alice', '#ff0000', 1_000)
    setCursor(store, 'alice', 'sheet-1', 0, 0)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPresenceOverlay
          resolveCellPosition={(_sheet, row, col) => ({
            left: col * 100,
            top: row * 30,
            width: 100,
            height: 30,
          })}
        />
      </SpreadsheetUiProvider>
    ))

    const initial = container.querySelector(
      '[data-testid="presence-cursor-alice"]',
    ) as HTMLElement | null
    expect(initial).not.toBeNull()
    expect(initial!.getAttribute('style') ?? '').toContain('#ff0000')

    // Update participant color via re-join with the same id.
    joinParticipant(store, 'alice', 'Alice', '#0000ff', 2_000)
    await waitFor(() => {
      const marker = container.querySelector(
        '[data-testid="presence-cursor-alice"]',
      ) as HTMLElement | null
      expect(marker?.getAttribute('style') ?? '').toContain('#0000ff')
    })

    // Move the cursor; the rendered position should follow.
    setCursor(store, 'alice', 'sheet-1', 4, 7)
    await waitFor(() => {
      const marker = container.querySelector(
        '[data-testid="presence-cursor-alice"]',
      ) as HTMLElement | null
      const style = marker?.getAttribute('style') ?? ''
      expect(style).toContain('left: 700px')
      expect(style).toContain('top: 120px')
    })
  })
})
