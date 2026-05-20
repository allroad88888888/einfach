import { useAtomValue } from '@einfach/solid'
import { onMount, Show } from 'solid-js'
import {
  setWorkspaceActiveSheetAtom,
  viewportShowFormulaBarAtom,
  workspaceSessionAtom,
} from '@einfach/spreadsheet-ui-core'
import { createStaticSpreadsheetBackend } from '../adapter'
import { SpreadsheetCommentThread } from '../comments'
import { SpreadsheetConditionalFormatDialog } from '../conditional-formatting'
import { SpreadsheetContextMenu } from '../context-menu'
import { SpreadsheetDataValidationDialog } from '../data-validation'
import { SpreadsheetFilterDropdown } from '../filter-sort'
import { SpreadsheetFindReplaceDialog } from '../find-replace'
import { SpreadsheetFormatCellsDialog } from '../format-cells'
import { SpreadsheetFormatPainter } from '../format-painter'
import { SpreadsheetFormulaBar } from '../formula-bar'
import { SpreadsheetGrid } from '../grid'
import { SpreadsheetHistoryTimeline } from '../history'
import { SpreadsheetNameManagerDialog } from '../named-ranges'
import { SpreadsheetFormulaAutocomplete } from '../formula-autocomplete'
import { SpreadsheetPresenceOverlay } from '../presence'
import { SpreadsheetPrintPreviewOverlay } from '../print'
import { SpreadsheetProtectionUnlockDialog } from '../protection'
import { SpreadsheetSheetTabs } from '../sheet-tabs'
import { SpreadsheetStatusBar } from '../status-bar'
import { SpreadsheetToolbar } from '../toolbar'
import { acceptFormulaSuggestion, SpreadsheetUiProvider, useSpreadsheetUiStore } from '../provider'

const sheets = [
  { id: 'sheet-1', name: 'Sales' },
  { id: 'sheet-2', name: 'Forecast' },
]

const backend = createStaticSpreadsheetBackend({
  revision: 1,
  sheets,
  matrix: [
    ['Region', 'Q1', 'Q2', 'Q3', 'Q4', 'Total'],
    ['North', 120, 180, 240, 300, 840],
    ['South', 80, 160, 240, 320, 800],
    ['East', 200, 100, 50, 150, 500],
    ['West', 140, 110, 250, 175, 675],
    ['Central', 90, 130, 200, 280, 700],
    ['Mountain', 65, 95, 130, 210, 500],
    ['Pacific', 175, 220, 280, 360, 1035],
    ['Total', 870, 995, 1390, 1795, 5050],
  ],
  cells: [
    {
      row: 0,
      col: 0,
      displayValue: 'Region',
      valueKind: 'string',
      conditionalFormat: { bgColor: '#1e3a8a', fgColor: '#ffffff', bold: true },
    },
    {
      row: 0,
      col: 5,
      displayValue: 'Total',
      valueKind: 'string',
      conditionalFormat: { bgColor: '#1e3a8a', fgColor: '#ffffff', bold: true },
    },
    {
      row: 8,
      col: 0,
      displayValue: 'Total',
      valueKind: 'string',
      conditionalFormat: { bgColor: '#94a3b8', fgColor: '#0f172a', bold: true },
    },
    {
      row: 3,
      col: 4,
      displayValue: '150',
      valueKind: 'number',
      conditionalFormat: { bgColor: '#fef3c7' },
    },
    {
      row: 6,
      col: 4,
      displayValue: '210',
      valueKind: 'number',
      conditionalFormat: { bgColor: '#fef3c7' },
    },
    {
      row: 7,
      col: 5,
      displayValue: '1035',
      valueKind: 'number',
      conditionalFormat: { bgColor: '#dcfce7', bold: true },
    },
  ],
})

const viewport = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 240,
  viewportWidth: 720,
  rowHeight: 24,
  colWidth: 96,
  rowCount: 50,
  colCount: 16,
  overscanRows: 1,
  overscanCols: 1,
}

function VNextWave5Workbook() {
  const store = useSpreadsheetUiStore()
  const workspace = useAtomValue(workspaceSessionAtom)
  const showFormulaBar = useAtomValue(viewportShowFormulaBarAtom)
  const activeSheetId = () => workspace().activeSheetId ?? sheets[0].id

  onMount(() => {
    if (!store.getter(workspaceSessionAtom).activeSheetId) {
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: sheets[0].id })
    }
  })

  return (
    <>
      <SpreadsheetToolbar data-testid="wave5-toolbar" />
      <Show when={showFormulaBar()}>
        <SpreadsheetFormulaBar data-testid="wave5-formula-bar" />
      </Show>
      <div class="vnext-demo-body">
        <div class="vnext-demo-main">
          <Show keyed when={activeSheetId()}>
            {(sheetId) => (
              <SpreadsheetGrid sheetId={sheetId} viewport={viewport} data-testid="wave5-grid" />
            )}
          </Show>
          <div class="vnext-demo-bottom-row">
            <SpreadsheetSheetTabs sheets={sheets} data-testid="wave5-sheet-tabs" />
            <SpreadsheetStatusBar
              sections={['zoom']}
              data-testid="wave5-status-bar-zoom"
              class="vnext-demo-zoom-bar"
            />
          </div>
        </div>
        <aside class="vnext-demo-sidebar" data-testid="wave5-sidebar">
          <SpreadsheetStatusBar
            sections={[
              'cell-address',
              'selection',
              'projection',
              'visible-cells',
              'loaded-values',
              'last-command',
              'aggregates',
              'view-modes',
              'mode-badge',
            ]}
            orientation="vertical"
            data-testid="wave5-status-bar"
          />
          <SpreadsheetHistoryTimeline data-testid="wave5-history-timeline" />
        </aside>
      </div>
      <SpreadsheetContextMenu data-testid="wave5-context-menu" />
      <SpreadsheetFormatPainter data-testid="wave5-format-painter" />
      <SpreadsheetFormatCellsDialog data-testid="wave5-format-cells" />
      <SpreadsheetFindReplaceDialog data-testid="wave5-find-replace" />
      <SpreadsheetFilterDropdown data-testid="wave5-filter-dropdown" />
      <SpreadsheetConditionalFormatDialog data-testid="wave5-conditional-format" />
      <SpreadsheetDataValidationDialog data-testid="wave5-data-validation" />
      <SpreadsheetNameManagerDialog data-testid="wave5-name-manager" />
      <SpreadsheetCommentThread data-testid="wave5-comment-thread" />
      <SpreadsheetPrintPreviewOverlay data-testid="wave5-print-preview" />
      <SpreadsheetProtectionUnlockDialog data-testid="wave5-protection-unlock" />
      <SpreadsheetPresenceOverlay data-testid="wave5-presence" />
      <SpreadsheetFormulaAutocomplete
        data-testid="wave5-formula-autocomplete"
        onAccept={(suggestion) => {
          const { caret } = acceptFormulaSuggestion(store, suggestion)
          // Restore focus + caret on whichever input was active.
          queueMicrotask(() => {
            const el = document.activeElement
            if (
              el instanceof HTMLInputElement &&
              (el.classList.contains('cell-input') || el.classList.contains('formula-bar-input'))
            ) {
              el.focus()
              el.setSelectionRange(caret, caret)
            }
          })
        }}
      />
    </>
  )
}

export function VNextWave5Demo() {
  return (
    <div class="demo-page vnext-demo" data-testid="wave5-demo">
      <div class="demo-header">
        <h3>Wave 5 — 完整 Excel 壳 + Canvas 装饰层</h3>
        <p class="demo-desc">
          演示菜单条、名称框、状态栏聚合（选区的求和/平均/计数）、缩放滑块、格式刷以及画布
          装饰层。预置一张季度销售表，选中 B2:E8 即可看到非平凡的聚合结果。
        </p>
      </div>

      <SpreadsheetUiProvider backend={backend}>
        <VNextWave5Workbook />
      </SpreadsheetUiProvider>
    </div>
  )
}
