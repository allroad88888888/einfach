/** @jsxImportSource solid-js */

/**
 * Matrix test for the shared Esc + header X close affordance on every
 * vnext dialog. One assertion per dialog × {Esc keydown, click X button}.
 *
 * Each row provides:
 *   - the open atom + payload used to bring the dialog up
 *   - the readback atom that reports "open" so we can assert the close
 *   - the render thunk that mounts the dialog under the provider
 *
 * Print preview re-uses `togglePrintPreviewAtom` for both open and close —
 * Esc/X both invoke the same toggle setter, which flips it back to closed.
 */

import { afterEach, describe, expect, it } from '@jest/globals'
import { createStore } from '@einfach/core'
import { cleanup, fireEvent, render, waitFor } from '@solidjs/testing-library'
import type { JSX } from 'solid-js'
import type { SpreadsheetBackend } from '@einfach/spreadsheet-ui-core'
import {
  commentSessionAtom,
  conditionalFormatEditorAtom,
  filterDropdownAtom,
  findReplaceOpenAtom,
  formatCellsEditorAtom,
  nameManagerEditorAtom,
  openCommentSessionAtom,
  openConditionalFormatEditorAtom,
  openFilterDropdownAtom,
  openFindReplaceAtom,
  openFormatCellsAtom,
  openNameManagerAtom,
  openProtectionUnlockAtom,
  openValidationRuleEditorAtom,
  printPreviewOpenAtom,
  protectionUnlockStateAtom,
  togglePrintPreviewAtom,
  validationRuleEditorAtom,
} from '@einfach/spreadsheet-ui-core'
import { SpreadsheetUiProvider } from '../src-vnext/provider'
import { SpreadsheetCommentThread } from '../src-vnext/comments'
import { SpreadsheetConditionalFormatDialog } from '../src-vnext/conditional-formatting'
import { SpreadsheetDataValidationDialog } from '../src-vnext/data-validation'
import { SpreadsheetFilterDropdown } from '../src-vnext/filter-sort'
import { SpreadsheetFindReplaceDialog } from '../src-vnext/find-replace'
import { SpreadsheetFormatCellsDialog } from '../src-vnext/format-cells'
import { SpreadsheetNameManagerDialog } from '../src-vnext/named-ranges'
import { SpreadsheetPrintPreviewOverlay } from '../src-vnext/print'
import { SpreadsheetProtectionUnlockDialog } from '../src-vnext/protection'

afterEach(cleanup)

function createFakeBackend(): SpreadsheetBackend {
  return {
    async readVisibleProjection(req) {
      return {
        kind: 'visible-window',
        sheetId: req.sheetId,
        requestId: req.requestId,
        window: req.window,
        cells: [],
      }
    },
    async readRangeProjection(req) {
      return {
        kind: 'range',
        sheetId: req.sheetId,
        requestId: req.requestId,
        range: req.range,
        cells: [],
      }
    },
    async setCellInput(req) {
      return { sheetId: req.sheetId, requestId: req.requestId }
    },
  }
}

interface DialogCase {
  name: string
  testid: string
  open: (store: ReturnType<typeof createStore>) => void
  isOpen: (store: ReturnType<typeof createStore>) => boolean
  render: () => JSX.Element
}

const cfRange = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }
const validationRange = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }
const formatRange = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 }

const cases: readonly DialogCase[] = [
  {
    name: 'find-replace',
    testid: 'find-replace-dialog',
    open: (store) => store.setter(openFindReplaceAtom),
    isOpen: (store) => store.getter(findReplaceOpenAtom) === true,
    render: () => <SpreadsheetFindReplaceDialog />,
  },
  {
    name: 'filter-dropdown',
    testid: 'filter-dropdown',
    open: (store) => store.setter(openFilterDropdownAtom, { sheetId: 'sheet-1', colIndex: 0 }),
    isOpen: (store) => store.getter(filterDropdownAtom).status === 'open',
    render: () => <SpreadsheetFilterDropdown />,
  },
  {
    name: 'conditional-format',
    testid: 'conditional-format-dialog',
    open: (store) =>
      store.setter(openConditionalFormatEditorAtom, {
        id: 'rule-1',
        priority: 1,
        scope: { range: cfRange },
        rule: { kind: 'cell-value', operator: 'eq', value: '', format: {} },
      }),
    isOpen: (store) => store.getter(conditionalFormatEditorAtom).open === true,
    render: () => <SpreadsheetConditionalFormatDialog />,
  },
  {
    name: 'data-validation',
    testid: 'validation-dialog',
    open: (store) => store.setter(openValidationRuleEditorAtom, { range: validationRange }),
    isOpen: (store) => store.getter(validationRuleEditorAtom).status === 'editing',
    render: () => <SpreadsheetDataValidationDialog sheetId="sheet-1" />,
  },
  {
    name: 'name-manager',
    testid: 'name-manager-dialog',
    open: (store) => store.setter(openNameManagerAtom, { status: 'editing-new' }),
    isOpen: (store) => store.getter(nameManagerEditorAtom).status !== 'closed',
    render: () => <SpreadsheetNameManagerDialog />,
  },
  {
    name: 'comment-thread',
    testid: 'comment-thread',
    open: (store) =>
      store.setter(openCommentSessionAtom, {
        sheetId: 'sheet-1',
        cell: { row: 0, col: 0 },
      }),
    isOpen: (store) => store.getter(commentSessionAtom) !== null,
    render: () => <SpreadsheetCommentThread />,
  },
  {
    name: 'print-preview',
    testid: 'print-preview-overlay',
    open: (store) => store.setter(togglePrintPreviewAtom),
    isOpen: (store) => store.getter(printPreviewOpenAtom) === true,
    render: () => <SpreadsheetPrintPreviewOverlay />,
  },
  {
    name: 'protection-unlock',
    testid: 'protection-unlock-dialog',
    open: (store) =>
      store.setter(openProtectionUnlockAtom, {
        sheetId: 'sheet-1',
        range: { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 },
      }),
    isOpen: (store) => store.getter(protectionUnlockStateAtom).isOpen === true,
    render: () => <SpreadsheetProtectionUnlockDialog />,
  },
  {
    name: 'format-cells',
    testid: 'format-cells-dialog',
    open: (store) =>
      store.setter(openFormatCellsAtom, {
        sheetId: 'sheet-1',
        range: formatRange,
        initialFormat: {},
      }),
    isOpen: (store) => store.getter(formatCellsEditorAtom).status === 'open',
    render: () => <SpreadsheetFormatCellsDialog />,
  },
]

describe('vNext dialog Esc + X close affordance', () => {
  describe.each(cases)('$name', (testCase) => {
    it('Esc closes the dialog', async () => {
      const store = createStore()
      const backend = createFakeBackend()
      testCase.open(store)

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          {testCase.render()}
        </SpreadsheetUiProvider>
      ))

      await waitFor(() =>
        expect(container.querySelector(`[data-testid="${testCase.testid}"]`)).not.toBeNull(),
      )

      fireEvent.keyDown(document, { key: 'Escape' })

      await waitFor(() => expect(testCase.isOpen(store)).toBe(false))
    })

    it('clicking the header X closes the dialog', async () => {
      const store = createStore()
      const backend = createFakeBackend()
      testCase.open(store)

      const { container } = render(() => (
        <SpreadsheetUiProvider backend={backend} store={store}>
          {testCase.render()}
        </SpreadsheetUiProvider>
      ))

      const dialogEl = await waitFor(() => {
        const el = container.querySelector(`[data-testid="${testCase.testid}"]`)
        if (!el) throw new Error('dialog not rendered')
        return el
      })

      const closeX = dialogEl.querySelector('[data-testid="dialog-close-x"]') as HTMLButtonElement | null
      expect(closeX).not.toBeNull()
      fireEvent.click(closeX!)

      await waitFor(() => expect(testCase.isOpen(store)).toBe(false))
    })
  })
})
