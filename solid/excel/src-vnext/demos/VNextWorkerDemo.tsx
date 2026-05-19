import { createEffect, onCleanup, onMount, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  setWorkspaceActiveSheetAtom,
  workspaceSessionAtom,
  type ViewportMetrics,
} from '@einfach/spreadsheet-ui-core'
import { defaultVNextWorkbookWorkerFactory } from '../adapter/worker-factory'
import {
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
import { SpreadsheetFormulaBar } from '../formula-bar'
import { SpreadsheetGrid } from '../grid'
import { SpreadsheetHistoryTimeline } from '../history'
import { SpreadsheetNameManagerDialog } from '../named-ranges'
import { SpreadsheetPresenceOverlay } from '../presence'
import { SpreadsheetPrintPreviewOverlay } from '../print'
import { SpreadsheetProtectionUnlockDialog } from '../protection'
import { SpreadsheetSheetTabs } from '../sheet-tabs'
import { SpreadsheetStatusBar } from '../status-bar'
import { SpreadsheetToolbar } from '../toolbar'
import { SpreadsheetUiProvider, useSpreadsheetUiStore } from '../provider'

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

type WorkerWorkbookClient = Parameters<
  NonNullable<WorkerWorkbookSpreadsheetBackendOptions['afterInit']>
>[0]

type LazyProbe = {
  client: WorkerWorkbookClient
  sheetIdx: number
  beforeState: string
  beforeEvalCount: number
  logged: boolean
}

type VNextWorkerDebugWindow = Window &
  typeof globalThis & {
    __einfachWorkbookDebugClient?: WorkerWorkbookClient
  }

let latestLazyProbe: LazyProbe | undefined

function shouldExposeDebugClient() {
  return new URLSearchParams(window.location.search).has('debug')
}

function exposeDebugClient(client: WorkerWorkbookClient) {
  if (!shouldExposeDebugClient()) return
  const debugWindow = window as VNextWorkerDebugWindow
  debugWindow.__einfachWorkbookDebugClient = client
}

function clearDebugClient() {
  const debugWindow = window as VNextWorkerDebugWindow
  delete debugWindow.__einfachWorkbookDebugClient
}

async function seedWorkerWorkbook(
  client: WorkerWorkbookClient,
  initializedSheets: WorkerWorkbookBackendSheet[],
) {
  exposeDebugClient(client)

  const sheet1 = initializedSheets[0].idx
  const sheet2 = initializedSheets[1].idx
  const sheet3 = initializedSheets[2].idx

  await client.setCell(sheet1, 'A1', { type: 'text', value: 'Sheet1' })
  await client.setCell(sheet1, 'A2', { type: 'text', value: 'cell1' })
  await client.setCell(sheet1, 'B2', { type: 'text', value: 'result' })
  await client.setCell(sheet1, 'A4', { type: 'text', value: 'cell4' })
  await client.setCell(sheet1, 'B4', { type: 'number', value: 10 })
  await client.setCell(sheet1, 'C4', { type: 'text', value: 'source' })
  await client.setFormulaDetailed(sheet1, 'C2', '=Sheet2!C2+1')

  await client.setCell(sheet2, 'A1', { type: 'text', value: 'Sheet2' })
  await client.setCell(sheet2, 'A2', { type: 'text', value: 'cell2' })
  await client.setCell(sheet2, 'B2', { type: 'text', value: 'depends on Sheet3' })
  await client.setFormulaDetailed(sheet2, 'C2', '=Sheet3!C2+1')
  await client.setCell(sheet2, 'A5', { type: 'text', value: 'lazy demo' })
  await client.setCell(sheet2, 'B5', { type: 'text', value: 'Sheet3!B4+5' })
  await client.setFormulaDetailed(sheet2, 'C5', '=Sheet3!B4+5')

  await client.setCell(sheet3, 'A1', { type: 'text', value: 'Sheet3' })
  await client.setCell(sheet3, 'A2', { type: 'text', value: 'cell3' })
  await client.setCell(sheet3, 'B2', { type: 'text', value: 'depends on Sheet1!B4' })
  await client.setCell(sheet3, 'B4', { type: 'number', value: 100 })
  await client.setFormulaDetailed(sheet3, 'C2', '=Sheet1!B4+1')

  latestLazyProbe = {
    client,
    sheetIdx: sheet2,
    beforeState: await client.debugFormulaCacheState(sheet2, 'C5'),
    beforeEvalCount: await client.debugFormulaEvalCount(sheet2),
    logged: false,
  }
}

function VNextWorkerLazyProbeLogger(props: { activeSheetId: () => string }) {
  function logWhenComputed(probe: LazyProbe, attempt = 0) {
    window.setTimeout(() => {
      void Promise.all([
        probe.client.debugFormulaCacheState(probe.sheetIdx, 'C5'),
        probe.client.debugFormulaEvalCount(probe.sheetIdx),
      ]).then(([afterState, afterEvalCount]) => {
        if (afterState !== 'clean') {
          if (attempt < 20) {
            logWhenComputed(probe, attempt + 1)
          } else {
            probe.logged = false
          }
          return
        }
        console.log(
          `[vnext-worker-lazy-demo] computed Sheet2!C5 before=${probe.beforeState} after=${afterState} beforeEval=${probe.beforeEvalCount} afterEval=${afterEvalCount}`,
        )
      })
    }, 25)
  }

  createEffect(() => {
    if (props.activeSheetId() !== 'sheet-2') return
    const probe = latestLazyProbe
    if (!probe || probe.logged) return
    probe.logged = true
    logWhenComputed(probe)
  })

  return null
}

function VNextWorkerWorkbook() {
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
      <SpreadsheetToolbar data-testid="vnext-worker-toolbar" />
      <SpreadsheetFormulaBar data-testid="vnext-worker-formula-bar" />
      <Show keyed when={activeSheetId()}>
        {(sheetId) => (
          <SpreadsheetGrid sheetId={sheetId} viewport={viewport} data-testid="vnext-worker-grid" />
        )}
      </Show>
      <VNextWorkerLazyProbeLogger activeSheetId={activeSheetId} />
      <SpreadsheetSheetTabs sheets={sheets} data-testid="vnext-worker-sheet-tabs" />
      <SpreadsheetStatusBar data-testid="vnext-worker-status-bar" />
      <SpreadsheetContextMenu data-testid="vnext-worker-context-menu" />
      <SpreadsheetFindReplaceDialog data-testid="vnext-worker-find-replace" />
      <SpreadsheetFilterDropdown data-testid="vnext-worker-filter-dropdown" />
      <SpreadsheetConditionalFormatDialog data-testid="vnext-worker-conditional-format" />
      <SpreadsheetDataValidationDialog data-testid="vnext-worker-data-validation" />
      <SpreadsheetNameManagerDialog data-testid="vnext-worker-name-manager" />
      <SpreadsheetCommentThread data-testid="vnext-worker-comment-thread" />
      <SpreadsheetPrintPreviewOverlay data-testid="vnext-worker-print-preview" />
      <SpreadsheetProtectionUnlockDialog data-testid="vnext-worker-protection-unlock" />
      <SpreadsheetHistoryTimeline data-testid="vnext-worker-history-timeline" />
      <SpreadsheetPresenceOverlay data-testid="vnext-worker-presence" />
    </>
  )
}

export function VNextWorkerDemo() {
  const backend = createWorkerWorkbookSpreadsheetBackend({
    workerFactory: defaultVNextWorkbookWorkerFactory,
    sheets,
    afterInit: seedWorkerWorkbook,
  })

  onCleanup(() => {
    backend.dispose()
    latestLazyProbe = undefined
    clearDebugClient()
  })

  return (
    <div class="demo-page vnext-demo">
      <div class="demo-header">
        <h3>vNext Worker Spreadsheet</h3>
        <p class="demo-desc">
          vNext UI backed by the Rust workbook worker through the framework-agnostic backend port.
        </p>
      </div>

      <SpreadsheetUiProvider backend={backend}>
        <VNextWorkerWorkbook />
      </SpreadsheetUiProvider>
    </div>
  )
}
