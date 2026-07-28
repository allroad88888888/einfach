/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render } from '@solidjs/testing-library'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import {
  pageSetupDialogOpenAtom,
  printPreviewOpenAtom,
  setPrintConfigAtom,
  setWorkspaceActiveSheetAtom,
  togglePrintPreviewAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetPrintPreviewOverlay } from '../src-vnext/print'

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

describe('vNext SpreadsheetPrintPreviewOverlay', () => {
  it('does not render when printPreviewOpenAtom is false', () => {
    const store = createStore()
    const backend = createFakeBackend()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPrintPreviewOverlay />
      </SpreadsheetUiProvider>
    ))

    expect(container.querySelector('[data-testid="print-preview-overlay"]')).toBeNull()
  })

  it('renders when printPreviewOpenAtom is true', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(togglePrintPreviewAtom)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPrintPreviewOverlay />
      </SpreadsheetUiProvider>
    ))

    expect(container.querySelector('[data-testid="print-preview-overlay"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="print-orientation-text"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="print-scale-text"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="print-page-breaks-count"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="print-close-button"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="print-page-setup-button"]')).not.toBeNull()
  })

  it('shows orientation from printConfigStateAtom for active sheet', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(setPrintConfigAtom, {
      sheetId: 'sheet-1',
      config: {
        orientation: 'landscape',
        scale: { kind: 'percent', percent: 75 },
        manualPageBreaks: [],
      },
    })
    store.setter(togglePrintPreviewAtom)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPrintPreviewOverlay />
      </SpreadsheetUiProvider>
    ))

    const orientationEl = container.querySelector('[data-testid="print-orientation-text"]')
    expect(orientationEl?.textContent).toBe('landscape')
    const scaleEl = container.querySelector('[data-testid="print-scale-text"]')
    expect(scaleEl?.textContent).toBe('75%')
  })

  it('shows manual page breaks count', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
    store.setter(setPrintConfigAtom, {
      sheetId: 'sheet-1',
      config: {
        orientation: 'portrait',
        scale: { kind: 'percent', percent: 100 },
        manualPageBreaks: [
          { axis: 'row', index: 10 },
          { axis: 'column', index: 5 },
        ],
      },
    })
    store.setter(togglePrintPreviewAtom)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPrintPreviewOverlay />
      </SpreadsheetUiProvider>
    ))

    const el = container.querySelector('[data-testid="print-page-breaks-count"]')
    expect(el?.textContent).toBe('2')
  })

  it('close button toggles printPreviewOpenAtom off', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(togglePrintPreviewAtom)
    expect(store.getter(printPreviewOpenAtom)).toBe(true)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPrintPreviewOverlay />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(container.querySelector('[data-testid="print-close-button"]') as HTMLElement)

    expect(store.getter(printPreviewOpenAtom)).toBe(false)
    expect(container.querySelector('[data-testid="print-preview-overlay"]')).toBeNull()
  })

  it('page setup button toggles pageSetupDialogOpenAtom', () => {
    const store = createStore()
    const backend = createFakeBackend()

    store.setter(togglePrintPreviewAtom)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetPrintPreviewOverlay />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(pageSetupDialogOpenAtom)).toBe(false)
    fireEvent.click(container.querySelector('[data-testid="print-page-setup-button"]') as HTMLElement)
    expect(store.getter(pageSetupDialogOpenAtom)).toBe(true)
  })
})
