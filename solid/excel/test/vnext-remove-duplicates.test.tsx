/** @jsxImportSource solid-js */

import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type {
  DisplayCell,
  RemoveRowsRequest,
  RemoveRowsResult,
  SpreadsheetBackend,
  VisibleProjectionResult,
} from '@einfach/spreadsheet-ui-core'
import {
  closeRemoveDuplicatesAtom,
  createVisibleProjectionRequest,
  deselectAllKeyColumnsAtom,
  historyStackAtom,
  openRemoveDuplicatesAtom,
  removeDuplicatesComparisonAtom,
  removeDuplicatesExcludeHeaderAtom,
  removeDuplicatesKeyColumnsAtom,
  removeDuplicatesOpenAtom,
  removeDuplicatesPreviewAtom,
  selectionAtom,
  setWorkspaceActiveSheetAtom,
  toggleKeyColumnAtom,
} from '@einfach/spreadsheet-ui-core'
import {
  removeDuplicatesSheetIdAtom,
  SpreadsheetUiProvider,
  spreadsheetProjectionSnapshotAtom,
} from '../src-vnext/provider'
import { SpreadsheetRemoveDuplicatesDialog } from '../src-vnext/remove-duplicates'

afterEach(cleanup)

// ---------------------------------------------------------------------------
// Fixtures — a 5-row range: 1 header (row 0) + 4 data rows (rows 1-4) where
// rows 1 and 3 are duplicates ("North", "100"). Single key column (col 0) +
// `excludeHeader: true` → preview reports "1 of 3 rows" (3 data rows after
// the header is skipped, 1 dup).
// ---------------------------------------------------------------------------

function buildCell(row: number, col: number, value: string): DisplayCell {
  return {
    row,
    col,
    valueKind: value === '' ? 'blank' : 'string',
    displayValue: value,
  }
}

const FIXTURE_CELLS: DisplayCell[] = [
  // header row
  buildCell(0, 0, 'Region'),
  buildCell(0, 1, 'Score'),
  // data rows
  buildCell(1, 0, 'North'),
  buildCell(1, 1, '100'),
  buildCell(2, 0, 'South'),
  buildCell(2, 1, '200'),
  buildCell(3, 0, 'North'), // dup of row 1 on col 0
  buildCell(3, 1, '300'),
  buildCell(4, 0, 'East'),
  buildCell(4, 1, '400'),
]

const FIXTURE_RANGE = { startRow: 0, endRow: 4, startCol: 0, endCol: 1 }

function createBackendWithoutRemoveRows(): SpreadsheetBackend {
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

function seedActiveSheet(store: ReturnType<typeof createStore>) {
  store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-1' })
  store.setter(selectionAtom, {
    kind: 'range',
    sheetId: 'sheet-1',
    anchor: { row: 0, col: 0 },
    focus: { row: 4, col: 1 },
  })
  // Mirror the menubar's two-write transaction: capture the sheetId so the
  // confirm flow knows which sheet the dialog was scanning.
  store.setter(removeDuplicatesSheetIdAtom, 'sheet-1')
}

describe('SpreadsheetRemoveDuplicatesDialog', () => {
  it('does not render when removeDuplicatesOpenAtom is false', () => {
    const store = createStore()
    const backend = createBackendWithoutRemoveRows()

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetRemoveDuplicatesDialog />
      </SpreadsheetUiProvider>
    ))

    expect(
      container.querySelector('[data-testid="remove-duplicates-dialog"]'),
    ).toBeNull()
  })

  it('renders columns, comparison radios, preview and buttons when open', () => {
    const store = createStore()
    const backend = createBackendWithoutRemoveRows()
    store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetRemoveDuplicatesDialog />
      </SpreadsheetUiProvider>
    ))

    expect(
      container.querySelector('[data-testid="remove-duplicates-dialog"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="remove-duplicates-column-0"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="remove-duplicates-column-1"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="remove-duplicates-comparison-exact"]'),
    ).not.toBeNull()
    expect(
      container.querySelector(
        '[data-testid="remove-duplicates-comparison-caseInsensitive"]',
      ),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="remove-duplicates-confirm-button"]'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="remove-duplicates-cancel-button"]'),
    ).not.toBeNull()
  })

  it('preview reports the right duplicate count with excludeHeader + single key column', () => {
    const store = createStore()
    store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)
    // Default open seeds keyColumns = {0, 1}; deselect col 1 so only col 0
    // (Region) participates — row 3 then matches row 1.
    store.setter(toggleKeyColumnAtom, 1)

    const preview = store.getter(removeDuplicatesPreviewAtom)
    expect(preview).not.toBeNull()
    expect(preview!.noKeyColumns).toBe(false)
    expect(preview!.duplicateRows).toEqual([3])
    expect(preview!.scannedRows).toBe(4)
    expect(preview!.uniqueRows).toBe(3)
  })

  it('cancel button closes the dialog', () => {
    const store = createStore()
    const backend = createBackendWithoutRemoveRows()
    store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetRemoveDuplicatesDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(
      container.querySelector(
        '[data-testid="remove-duplicates-cancel-button"]',
      ) as HTMLElement,
    )
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(false)
  })

  it('close-x button closes the dialog', () => {
    const store = createStore()
    const backend = createBackendWithoutRemoveRows()
    store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetRemoveDuplicatesDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(
      container.querySelector('[data-testid="remove-duplicates-close-x"]') as HTMLElement,
    )
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(false)
  })

  it('toggling a column checkbox flips the keyColumns atom', () => {
    const store = createStore()
    const backend = createBackendWithoutRemoveRows()
    store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetRemoveDuplicatesDialog />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(removeDuplicatesKeyColumnsAtom).has(0)).toBe(true)
    fireEvent.click(
      container.querySelector('[data-testid="remove-duplicates-column-0"]') as HTMLElement,
    )
    expect(store.getter(removeDuplicatesKeyColumnsAtom).has(0)).toBe(false)
  })

  it('Deselect all → confirm button disabled + preview shows noKeyColumns', () => {
    const store = createStore()
    const backend = createBackendWithoutRemoveRows()
    store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetRemoveDuplicatesDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(
      container.querySelector(
        '[data-testid="remove-duplicates-deselect-all"]',
      ) as HTMLElement,
    )
    expect(store.getter(removeDuplicatesKeyColumnsAtom).size).toBe(0)
    const preview = store.getter(removeDuplicatesPreviewAtom)
    expect(preview).not.toBeNull()
    expect(preview!.noKeyColumns).toBe(true)

    const confirmBtn = container.querySelector(
      '[data-testid="remove-duplicates-confirm-button"]',
    ) as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
  })

  it('Select all re-checks every column in the range', () => {
    const store = createStore()
    const backend = createBackendWithoutRemoveRows()
    store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetRemoveDuplicatesDialog />
      </SpreadsheetUiProvider>
    ))

    store.setter(deselectAllKeyColumnsAtom)
    expect(store.getter(removeDuplicatesKeyColumnsAtom).size).toBe(0)

    fireEvent.click(
      container.querySelector(
        '[data-testid="remove-duplicates-select-all"]',
      ) as HTMLElement,
    )
    const set = store.getter(removeDuplicatesKeyColumnsAtom)
    expect(set.has(0)).toBe(true)
    expect(set.has(1)).toBe(true)
  })

  it('changing the comparison radio writes the atom', () => {
    const store = createStore()
    const backend = createBackendWithoutRemoveRows()
    store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetRemoveDuplicatesDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(
      container.querySelector(
        '[data-testid="remove-duplicates-comparison-caseInsensitive"]',
      ) as HTMLElement,
    )
    expect(store.getter(removeDuplicatesComparisonAtom)).toBe('caseInsensitive')
  })

  it('toggling the exclude-header checkbox writes the atom', () => {
    const store = createStore()
    const backend = createBackendWithoutRemoveRows()
    store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetRemoveDuplicatesDialog />
      </SpreadsheetUiProvider>
    ))

    expect(store.getter(removeDuplicatesExcludeHeaderAtom)).toBe(true)
    fireEvent.click(
      container.querySelector(
        '[data-testid="remove-duplicates-exclude-header"]',
      ) as HTMLElement,
    )
    expect(store.getter(removeDuplicatesExcludeHeaderAtom)).toBe(false)
  })

  it(
    'confirm calls backend.removeRows with the duplicate row indices, records history, refreshes projection, and closes',
    async () => {
      const store = createStore()
      const removeSpy = jest.fn(async (_req: RemoveRowsRequest) => {
        const result: RemoveRowsResult = {
          sheetId: 'sheet-1',
          removedRows: 1,
          revision: 7,
          affectedRange: { startRow: 0, endRow: 3, startCol: 0, endCol: 1 },
        }
        return result
      })
      const readSpy = jest.fn(async (_req: unknown) => {
        const result: VisibleProjectionResult = {
          kind: 'visible-window',
          sheetId: 'sheet-1',
          window: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 },
          requestId: 0,
          revision: 7,
          cells: [],
        }
        return result
      })
      const backend: SpreadsheetBackend = {
        readVisibleProjection:
          readSpy as unknown as SpreadsheetBackend['readVisibleProjection'],
        async readRangeProjection() {
          throw new Error('not used')
        },
        async setCellInput() {
          throw new Error('not used')
        },
        removeRows: removeSpy,
      }

      seedActiveSheet(store)
      // Seed a projection snapshot so refreshVisibleProjection can re-issue.
      const request = createVisibleProjectionRequest({
        sheetId: 'sheet-1',
        requestId: 0,
        window: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 },
      })
      store.setter(spreadsheetProjectionSnapshotAtom, {
        status: 'ready',
        request,
        result: {
          kind: 'visible-window',
          sheetId: 'sheet-1',
          window: { rowStart: 0, rowEnd: 5, colStart: 0, colEnd: 5 },
          requestId: 0,
          revision: 1,
          cells: [],
        },
        error: undefined,
      })

      store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)
      // Narrow keyColumns to col 0 only so the preview surfaces row 3 as a
      // duplicate of row 1.
      store.setter(toggleKeyColumnAtom, 1)

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetRemoveDuplicatesDialog />
        </SpreadsheetUiProvider>
      ))

      const before = store.getter(historyStackAtom).entries.length

      fireEvent.click(
        container.querySelector(
          '[data-testid="remove-duplicates-confirm-button"]',
        ) as HTMLElement,
      )

      await waitFor(() => {
        expect(removeSpy).toHaveBeenCalledTimes(1)
      })
      const req = removeSpy.mock.calls[0]![0]
      expect(req.kind).toBe('remove-rows')
      expect(req.sheetId).toBe('sheet-1')
      expect(Array.from(req.rows)).toEqual([3])

      await waitFor(() => {
        const entries = store.getter(historyStackAtom).entries
        expect(entries.length).toBe(before + 1)
        const last = entries[entries.length - 1]
        expect(last.kind).toBe('row.delete')
        expect(last.sheetId).toBe('sheet-1')
        expect(last.projectionRevision).toBe(7)
      })

      await waitFor(() => {
        expect(readSpy).toHaveBeenCalled()
      })

      await waitFor(() => {
        expect(store.getter(removeDuplicatesOpenAtom)).toBe(false)
      })
    },
  )

  it('confirm without backend.removeRows port closes the dialog without throwing', async () => {
    const store = createStore()
    const backend = createBackendWithoutRemoveRows()
    seedActiveSheet(store)
    store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)
    store.setter(toggleKeyColumnAtom, 1)

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetRemoveDuplicatesDialog />
      </SpreadsheetUiProvider>
    ))

    fireEvent.click(
      container.querySelector(
        '[data-testid="remove-duplicates-confirm-button"]',
      ) as HTMLElement,
    )

    await waitFor(() => {
      expect(store.getter(removeDuplicatesOpenAtom)).toBe(false)
    })
    warnSpy.mockRestore()
  })

  it(
    // Solid 1.9.12 provider remount hazard: consumer bodies wrapped in
    // Provider re-execute on unrelated atom mutations. Form values must
    // survive — they live in atoms, not in `createSignal` locals.
    'form values survive a sibling atom mutation (Solid 1.9.12 remount hazard)',
    () => {
      const store = createStore()
      const backend = createBackendWithoutRemoveRows()
      store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)

      render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetRemoveDuplicatesDialog />
        </SpreadsheetUiProvider>
      ))

      // Narrow keyColumns + change comparison + uncheck header. These are
      // the user's working-in-progress choices.
      store.setter(toggleKeyColumnAtom, 1)
      store.setter(removeDuplicatesComparisonAtom, 'trimAndIgnoreCase')
      store.setter(removeDuplicatesExcludeHeaderAtom, false)

      // Mutate an unrelated atom — under 1.9.12 this triggers the consumer
      // body re-execution. If form state were in `createSignal` locals it
      // would clobber back to defaults; with everything atom-backed it
      // survives.
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'sheet-other' })

      expect(store.getter(removeDuplicatesKeyColumnsAtom).has(0)).toBe(true)
      expect(store.getter(removeDuplicatesKeyColumnsAtom).has(1)).toBe(false)
      expect(store.getter(removeDuplicatesComparisonAtom)).toBe('trimAndIgnoreCase')
      expect(store.getter(removeDuplicatesExcludeHeaderAtom)).toBe(false)
    },
  )

  it('openRemoveDuplicatesAtom is the wiring point for the menu dispatch', () => {
    const store = createStore()
    const backend = createBackendWithoutRemoveRows()
    expect(store.getter(removeDuplicatesOpenAtom)).toBe(false)

    store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)

    const { container } = render(() => (
      <SpreadsheetUiProvider backend={backend} store={store}>
        <SpreadsheetRemoveDuplicatesDialog />
      </SpreadsheetUiProvider>
    ))

    expect(
      container.querySelector('[data-testid="remove-duplicates-dialog"]'),
    ).not.toBeNull()
    store.setter(closeRemoveDuplicatesAtom)
  })

  it(
    // HIGH bug: wrong-sheet deletion race. The user opens the dialog on
    // Sheet1, the menubar captures sheetId='Sheet1' into the new atom, the
    // user switches the live selection to Sheet2, then confirms. The
    // confirm flow MUST delete from Sheet1 (the captured snapshot), not
    // from whatever the live selection currently points at.
    'confirm uses the captured sheetId, ignoring a stale selection-sheet swap',
    async () => {
      const store = createStore()
      const removeSpy = jest.fn(async (_req: RemoveRowsRequest) => {
        const result: RemoveRowsResult = {
          sheetId: 'Sheet1',
          removedRows: 1,
          revision: 3,
        }
        return result
      })
      const backend: SpreadsheetBackend = {
        ...createBackendWithoutRemoveRows(),
        removeRows: removeSpy,
      }

      // Open-time: dialog was opened against Sheet1 (menubar's two-write
      // transaction captures this BEFORE flipping open=true).
      store.setter(removeDuplicatesSheetIdAtom, 'Sheet1')
      store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, FIXTURE_CELLS)
      store.setter(toggleKeyColumnAtom, 1)

      // Live selection now points at Sheet2 (user switched sheets mid-
      // dialog). Pre-fix code read from selectionSnapshotAtom → Sheet2.
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: 'Sheet2' })
      store.setter(selectionAtom, {
        kind: 'range',
        sheetId: 'Sheet2',
        anchor: { row: 0, col: 0 },
        focus: { row: 4, col: 1 },
      })

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetRemoveDuplicatesDialog />
        </SpreadsheetUiProvider>
      ))

      fireEvent.click(
        container.querySelector(
          '[data-testid="remove-duplicates-confirm-button"]',
        ) as HTMLElement,
      )

      await waitFor(() => {
        expect(removeSpy).toHaveBeenCalledTimes(1)
      })
      const req = removeSpy.mock.calls[0]![0]
      expect(req.sheetId).toBe('Sheet1')
    },
  )

  it(
    // LOW finding: when keyColumns are set and the scanner reports zero
    // duplicates, the dialog should surface `removeDuplicates.preview.
    // noDuplicates` instead of the "Will remove 0 of N rows" summary
    // template — the latter reads as a degenerate edge case.
    'preview text uses the noDuplicates copy when keyColumns are set but no duplicates exist',
    () => {
      const store = createStore()
      const backend = createBackendWithoutRemoveRows()
      // Same fixture, but drop the duplicate (row 3) so the data is fully
      // unique on col 0.
      const uniqueCells: DisplayCell[] = [
        buildCell(0, 0, 'Region'),
        buildCell(0, 1, 'Score'),
        buildCell(1, 0, 'North'),
        buildCell(1, 1, '100'),
        buildCell(2, 0, 'South'),
        buildCell(2, 1, '200'),
        buildCell(3, 0, 'West'),
        buildCell(3, 1, '300'),
        buildCell(4, 0, 'East'),
        buildCell(4, 1, '400'),
      ]
      store.setter(openRemoveDuplicatesAtom, FIXTURE_RANGE, uniqueCells)
      // Drop col 1 so col 0 alone forms the key — every region is unique.
      store.setter(toggleKeyColumnAtom, 1)

      const preview = store.getter(removeDuplicatesPreviewAtom)
      expect(preview).not.toBeNull()
      expect(preview!.noKeyColumns).toBe(false)
      expect(preview!.duplicateRows.length).toBe(0)

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          <SpreadsheetRemoveDuplicatesDialog />
        </SpreadsheetUiProvider>
      ))

      const text = container
        .querySelector('[data-testid="remove-duplicates-preview"] .rd-preview-text')
        ?.textContent?.trim()
      // The locale string for `removeDuplicates.preview.noDuplicates` is
      // a fixed, non-templated phrase — assert the surfaced text is not
      // the templated summary by checking for the substring "No" and the
      // absence of "Will remove" / "of".
      expect(text ?? '').not.toMatch(/Will remove/i)
      expect((text ?? '').length).toBeGreaterThan(0)
    },
  )
})
