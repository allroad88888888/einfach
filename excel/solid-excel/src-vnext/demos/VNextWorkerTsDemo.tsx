import { createEffect, onCleanup, onMount, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  selectCellAtom,
  selectionAtom,
  setWorkspaceActiveSheetAtom,
  workspaceSessionAtom,
  type ViewportMetrics,
} from '@einfach/spreadsheet-ui-core'
import {
  defaultExcelCoreTsWorkerFactory,
} from '../adapter/worker-factory'
import {
  createWorkerNamedRangeCapabilityPort,
  createWorkerWorkbookSpreadsheetBackend,
  type WorkerWorkbookBackendSheet,
  type WorkerWorkbookSpreadsheetBackendOptions,
} from '../adapter'
import { SpreadsheetCommentThread } from '../comments'
import { SpreadsheetConditionalFormatDialog } from '../conditional-formatting'
import { SpreadsheetContextMenu } from '../context-menu'
import { SpreadsheetDataValidationDialog } from '../data-validation'
import { SpreadsheetFilterDropdown } from '../filter-sort'
import { SpreadsheetFindReplaceDialog } from '../find-replace'
import { SpreadsheetFormatPainter } from '../format-painter'
import { SpreadsheetFormulaAutocomplete } from '../formula-autocomplete'
import { SpreadsheetFormulaBar } from '../formula-bar'
import { SpreadsheetGoToDialog } from '../go-to'
import { SpreadsheetGrid } from '../grid'
import { SpreadsheetHistoryTimeline } from '../history'
import { SpreadsheetMenuBar } from '../menu-bar'
import { SpreadsheetNameManagerDialog } from '../named-ranges'
import { SpreadsheetPasteSpecialDialog } from '../paste-special'
import { SpreadsheetPresenceOverlay } from '../presence'
import { SpreadsheetPrintPreviewOverlay } from '../print'
import { SpreadsheetProtectionUnlockDialog } from '../protection'
import { SpreadsheetRemoveDuplicatesDialog } from '../remove-duplicates'
import { SpreadsheetSheetTabs } from '../sheet-tabs'
import { SpreadsheetStatusBar } from '../status-bar'
import { SpreadsheetTextToColumnsDialog } from '../text-to-columns'
import { SpreadsheetToolbar } from '../toolbar'
import { acceptFormulaSuggestion, SpreadsheetUiProvider, useSpreadsheetUiStore } from '../provider'

/**
 * Wave D demo — same vnext UI surface as `VNextWorkerDemo` but backed by
 * the TypeScript core (`@einfach/excel-core-ts`) running inside a dedicated
 * worker bundle. The wire protocol is identical to the WASM worker, so
 * `createWorkerWorkbookSpreadsheetBackend` drives both — only the
 * `workerFactory` argument differs.
 *
 * Activates from `<App>` when the URL carries `?backend=ts`. The default
 * stays on the WASM demo so the rest of the e2e suite is untouched
 * during the cutover window.
 */

const viewport: ViewportMetrics = {
  scrollTop: 0,
  scrollLeft: 0,
  viewportHeight: 144,
  viewportWidth: 480,
  rowHeight: 24,
  colWidth: 96,
  rowCount: 20,
  colCount: 10,
  overscanRows: 0,
  overscanCols: 0,
}

const sheets = [
  { id: 'sheet-1', name: 'Sheet1' },
  { id: 'sheet-2', name: 'Sheet2' },
  { id: 'sheet-3', name: 'Sheet3' },
]

const namedRangeCapabilityPort = createWorkerNamedRangeCapabilityPort('worker-ts')

type WorkerWorkbookClient = Parameters<
  NonNullable<WorkerWorkbookSpreadsheetBackendOptions['afterInit']>
>[0]

async function seedTsWorkbook(
  client: WorkerWorkbookClient,
  initializedSheets: WorkerWorkbookBackendSheet[],
) {
  const sheet1 = initializedSheets[0].idx
  const sheet2 = initializedSheets[1].idx
  const sheet3 = initializedSheets[2].idx

  // Seed a small sales-like sheet so the demo visibly exercises a
  // formula round-trip through the TS evaluator. =SUM(B2:B4) → 60
  // proves the registry + sheetAtom invalidation + projection refresh
  // chain are all live.
  await client.setCell(sheet1, 'A1', { type: 'text', value: 'Region' })
  await client.setCell(sheet1, 'B1', { type: 'text', value: 'Sales' })
  await client.setCell(sheet1, 'A2', { type: 'text', value: 'North' })
  await client.setCell(sheet1, 'B2', { type: 'number', value: 10 })
  await client.setCell(sheet1, 'A3', { type: 'text', value: 'South' })
  await client.setCell(sheet1, 'B3', { type: 'number', value: 20 })
  await client.setCell(sheet1, 'A4', { type: 'text', value: 'East' })
  await client.setCell(sheet1, 'B4', { type: 'number', value: 30 })
  await client.setCell(sheet1, 'A5', { type: 'text', value: 'Total' })
  await client.setFormulaDetailed(sheet1, 'B5', '=SUM(B2:B4)')
  // Exercise a text + math combo so logical/text track coverage is live.
  await client.setFormulaDetailed(sheet1, 'C2', '=UPPER(A2)')
  await client.setFormulaDetailed(sheet1, 'D2', '=IF(B2>15, "high", "low")')

  await client.setCell(sheet2, 'A1', { type: 'text', value: 'Sheet2' })
  await client.setCell(sheet3, 'A1', { type: 'text', value: 'Sheet3' })
}

function VNextWorkerTsWorkbook() {
  const store = useSpreadsheetUiStore()
  const workspace = useAtomValue(workspaceSessionAtom)
  const activeSheetId = () => workspace().activeSheetId ?? sheets[0].id

  onMount(() => {
    const sid = store.getter(workspaceSessionAtom).activeSheetId ?? sheets[0].id
    if (!store.getter(workspaceSessionAtom).activeSheetId) {
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: sheets[0].id })
    }
    if (!store.getter(selectionAtom).sheetId) {
      store.setter(selectCellAtom, { sheetId: sid, coord: { row: 0, col: 0 } })
    }
  })

  // createEffect kept here in case a future probe wants to verify the
  // active-sheet round-trip — same shape as the WASM demo so the visual
  // diff in DevTools is minimal.
  createEffect(() => {
    void activeSheetId()
  })

  return (
    <>
      <SpreadsheetMenuBar data-testid="vnext-worker-ts-menu-bar" />
      <SpreadsheetToolbar data-testid="vnext-worker-ts-toolbar" />
      <SpreadsheetFormulaBar data-testid="vnext-worker-ts-formula-bar" />
      <Show keyed when={activeSheetId()}>
        {(sheetId) => (
          <SpreadsheetGrid
            sheetId={sheetId}
            viewport={viewport}
            data-testid="vnext-worker-ts-grid"
          />
        )}
      </Show>
      <SpreadsheetSheetTabs sheets={sheets} data-testid="vnext-worker-ts-sheet-tabs" />
      <SpreadsheetStatusBar data-testid="vnext-worker-ts-status-bar" />
      <SpreadsheetContextMenu data-testid="vnext-worker-ts-context-menu" />
      <SpreadsheetFormatPainter data-testid="vnext-worker-ts-format-painter" />
      <SpreadsheetFindReplaceDialog data-testid="vnext-worker-ts-find-replace" />
      <SpreadsheetGoToDialog data-testid="vnext-worker-ts-go-to" />
      <SpreadsheetTextToColumnsDialog data-testid="vnext-worker-ts-text-to-columns" />
      <SpreadsheetRemoveDuplicatesDialog data-testid="vnext-worker-ts-remove-duplicates" />
      <SpreadsheetFilterDropdown data-testid="vnext-worker-ts-filter-dropdown" />
      <SpreadsheetConditionalFormatDialog data-testid="vnext-worker-ts-conditional-format" />
      <SpreadsheetDataValidationDialog data-testid="vnext-worker-ts-data-validation" />
      <SpreadsheetNameManagerDialog data-testid="vnext-worker-ts-name-manager" />
      <SpreadsheetPasteSpecialDialog data-testid="vnext-worker-ts-paste-special" />
      <SpreadsheetCommentThread data-testid="vnext-worker-ts-comment-thread" />
      <SpreadsheetPrintPreviewOverlay data-testid="vnext-worker-ts-print-preview" />
      <SpreadsheetProtectionUnlockDialog data-testid="vnext-worker-ts-protection-unlock" />
      <SpreadsheetHistoryTimeline data-testid="vnext-worker-ts-history-timeline" />
      <SpreadsheetPresenceOverlay data-testid="vnext-worker-ts-presence" />
      <SpreadsheetFormulaAutocomplete
        data-testid="vnext-worker-ts-formula-autocomplete"
        onAccept={(suggestion) => {
          const { caret } = acceptFormulaSuggestion(store, suggestion)
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

export function VNextWorkerTsDemo() {
  const backend = createWorkerWorkbookSpreadsheetBackend({
    workerFactory: defaultExcelCoreTsWorkerFactory,
    sheets,
    removeRowsExactCapability: false,
    afterInit: seedTsWorkbook,
  })

  onCleanup(() => {
    backend.dispose()
  })

  return (
    <div class="demo-page vnext-demo">
      <div class="demo-header">
        <h3>vNext Worker Spreadsheet — TS core</h3>
        <p class="demo-desc" data-testid="vnext-worker-ts-banner">
          vNext UI backed by <code>@einfach/excel-core-ts</code> (the TypeScript port of
          the Rust formula engine) running inside a dedicated worker. Toggle via{' '}
          <code>?backend=ts</code> in the URL.
        </p>
        <p class="demo-desc">
          Try <code>=SUM(B2:B4)</code>, <code>=IF(B2&gt;15,"high","low")</code>,{' '}
          <code>=UPPER(A2)</code> — all dispatch through the TS function registry.
        </p>
      </div>

      <SpreadsheetUiProvider backend={backend} namedRangeCapabilityPort={namedRangeCapabilityPort}>
        <VNextWorkerTsWorkbook />
      </SpreadsheetUiProvider>
    </div>
  )
}
