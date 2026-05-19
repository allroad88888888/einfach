import { useAtomValue } from '@einfach/solid'
import { onMount, Show } from 'solid-js'
import {
  setWorkspaceActiveSheetAtom,
  workspaceSessionAtom,
} from '@einfach/spreadsheet-ui-core'
import { createStaticSpreadsheetBackend } from '../adapter'
import { SpreadsheetCommentThread } from '../comments'
import { SpreadsheetConditionalFormatDialog } from '../conditional-formatting'
import { SpreadsheetContextMenu } from '../context-menu'
import { SpreadsheetDataValidationDialog } from '../data-validation'
import { SpreadsheetFilterDropdown } from '../filter-sort'
import { SpreadsheetFindReplaceDialog } from '../find-replace'
import { SpreadsheetFormatPainter } from '../format-painter'
import { SpreadsheetFormulaBar } from '../formula-bar'
import { SpreadsheetGrid } from '../grid'
import { SpreadsheetHistoryTimeline } from '../history'
import { SpreadsheetMenuBar } from '../menu-bar'
import { SpreadsheetNameManagerDialog } from '../named-ranges'
import { SpreadsheetPresenceOverlay } from '../presence'
import { SpreadsheetPrintPreviewOverlay } from '../print'
import { SpreadsheetProtectionUnlockDialog } from '../protection'
import { SpreadsheetSheetTabs } from '../sheet-tabs'
import { SpreadsheetStatusBar } from '../status-bar'
import { SpreadsheetToolbar } from '../toolbar'
import { SpreadsheetUiProvider, useSpreadsheetUiStore } from '../provider'

const sheets = [
  { id: 'sheet-1', name: 'Sheet1' },
  { id: 'sheet-2', name: 'Sheet2' },
  { id: 'sheet-3', name: 'Sheet3' },
]

const backend = createStaticSpreadsheetBackend({
  revision: 1,
  sheets,
  matrix: [
    ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'],
    ['North', 12, 18, 30, 'ready'],
    ['South', 8, 16, 24, 'ready'],
    ['East', 20, 10, 30, 'review'],
    ['West', 14, 11, 25, 'review'],
    ['Total', 54, 55, 109, 'visible'],
  ],
  cells: [
    {
      row: 3,
      col: 4,
      displayValue: 'review',
      valueKind: 'string',
      conditionalFormat: {
        bgColor: '#fde68a',
        fgColor: '#7f1d1d',
        bold: true,
      },
      validation: {
        code: 'validation.list_mismatch',
        severity: 'error',
        message: 'Expected ready or visible',
      },
    },
    {
      row: 4,
      col: 4,
      displayValue: 'Docs',
      valueKind: 'string',
      richValue: {
        kind: 'hyperlink',
        url: 'https://example.com/spreadsheet-docs',
        label: 'Docs',
      },
    },
    {
      row: 5,
      col: 3,
      displayValue: 'Total 109',
      valueKind: 'string',
      richValue: {
        kind: 'rich-text',
        runs: [
          { text: 'Total ', format: { bold: true } },
          { text: '109', format: { color: '#0f766e' } },
        ],
      },
    },
    {
      row: 19,
      col: 9,
      displayValue: 'Hidden offscreen',
      valueKind: 'string',
    },
  ],
})

const viewport = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 144,
  viewportWidth: 480,
  rowHeight: 24,
  colWidth: 96,
  rowCount: 200,
  colCount: 100,
  overscanRows: 0,
  overscanCols: 0,
}

function VNextSmokeWorkbook() {
  const store = useSpreadsheetUiStore()
  const workspace = useAtomValue(workspaceSessionAtom)
  const activeSheetId = () => workspace().activeSheetId ?? sheets[0].id

  onMount(() => {
    if (!store.getter(workspaceSessionAtom).activeSheetId) {
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: sheets[0].id })
    }
  })

  return (
    <>
      <SpreadsheetMenuBar data-testid="vnext-menu-bar" />
      <SpreadsheetToolbar data-testid="vnext-toolbar" />
      <SpreadsheetFormulaBar data-testid="vnext-formula-bar" />
      <Show keyed when={activeSheetId()}>
        {(sheetId) => (
          <SpreadsheetGrid sheetId={sheetId} viewport={viewport} data-testid="vnext-grid" />
        )}
      </Show>
      <SpreadsheetSheetTabs sheets={sheets} data-testid="vnext-sheet-tabs" />
      <SpreadsheetStatusBar data-testid="vnext-status-bar" />
      <SpreadsheetContextMenu data-testid="vnext-context-menu" />
      <SpreadsheetFormatPainter data-testid="vnext-format-painter" />
      <SpreadsheetFindReplaceDialog data-testid="vnext-find-replace" />
      <SpreadsheetFilterDropdown data-testid="vnext-filter-dropdown" />
      <SpreadsheetConditionalFormatDialog data-testid="vnext-conditional-format" />
      <SpreadsheetDataValidationDialog data-testid="vnext-data-validation" />
      <SpreadsheetNameManagerDialog data-testid="vnext-name-manager" />
      <SpreadsheetCommentThread data-testid="vnext-comment-thread" />
      <SpreadsheetPrintPreviewOverlay data-testid="vnext-print-preview" />
      <SpreadsheetProtectionUnlockDialog data-testid="vnext-protection-unlock" />
      <SpreadsheetHistoryTimeline data-testid="vnext-history-timeline" />
      <SpreadsheetPresenceOverlay data-testid="vnext-presence" />
    </>
  )
}

export function VNextSmokeDemo() {
  return (
    <div class="demo-page vnext-demo">
      <div class="demo-header">
        <h3>vNext Spreadsheet</h3>
        <p class="demo-desc">
          Framework-agnostic core drives the visible grid, selection, editing, and backend
          projection contract.
        </p>
      </div>

      <SpreadsheetUiProvider backend={backend}>
        <VNextSmokeWorkbook />
      </SpreadsheetUiProvider>
    </div>
  )
}
