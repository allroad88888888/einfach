import { createEffect, onCleanup, onMount, Show } from 'solid-js'
import { useAtomValue } from '@einfach/solid'
import {
  registerCustomFormulaAtom,
  selectCellAtom,
  selectionAtom,
  setWorkspaceActiveSheetAtom,
  unregisterCustomFormulaAtom,
  workspaceSessionAtom,
  type ViewportMetrics,
} from '@einfach/spreadsheet-ui-core'
import {
  defaultExcelCoreTsWorkerFactory,
  defaultVNextWorkbookWorkerFactory,
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
    const sid =
      store.getter(workspaceSessionAtom).activeSheetId ?? sheets[0].id
    if (!store.getter(workspaceSessionAtom).activeSheetId) {
      store.setter(setWorkspaceActiveSheetAtom, { sheetId: sheets[0].id })
    }
    // Default A1 cursor on first mount (Excel/Univer convention).
    if (!store.getter(selectionAtom).sheetId) {
      store.setter(selectCellAtom, { sheetId: sid, coord: { row: 0, col: 0 } })
    }
    const customFormulas = [
      { name: 'MYTAX', source: 'return Number(args[0]) * 0.2', paramLabels: ['amount'] },
      { name: 'GREET', source: "return 'Hello, ' + String(args[0] ?? '')", paramLabels: ['name'] },
      { name: 'CELSIUS', source: 'return (Number(args[0]) - 32) * 5 / 9', paramLabels: ['fahrenheit'] },
      // Exercises the 2-D array marshaling path: a range arg like
      // `=SUMSQ2(A1:A10)` arrives as `[[v0],[v1],...]`. `.flat()`
      // flattens to a 1-D scalar list, then sums squares. Named
      // `SUMSQ2` to avoid shadowing the engine's built-in `SUMSQ`.
      {
        name: 'SUMSQ2',
        source:
          'const xs = Array.isArray(args[0]) ? args[0].flat() : [args[0]]; return xs.reduce((s,v)=>s+Number(v)*Number(v),0)',
        paramLabels: ['range'],
      },
      // Wave 8.2 — async demo: the cell shows #BUSY! for ~800ms, then
      // settles. Same-args re-entry is memoized (no second delay) until
      // the registry changes.
      {
        name: 'SLOWTAX',
        source: 'await new Promise((r) => setTimeout(r, 800)); return Number(args[0]) * 0.2',
        isAsync: true,
        paramLabels: ['amount'],
      },
    ]
    for (const reg of customFormulas) store.setter(registerCustomFormulaAtom, reg)
    onCleanup(() => {
      for (const reg of customFormulas) store.setter(unregisterCustomFormulaAtom, reg.name)
    })
  })

  return (
    <>
      <SpreadsheetMenuBar data-testid="vnext-worker-menu-bar" />
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
      <SpreadsheetFormatPainter data-testid="vnext-worker-format-painter" />
      <SpreadsheetFindReplaceDialog data-testid="vnext-worker-find-replace" />
      <SpreadsheetGoToDialog data-testid="vnext-worker-go-to" />
      <SpreadsheetTextToColumnsDialog data-testid="vnext-worker-text-to-columns" />
      <SpreadsheetRemoveDuplicatesDialog data-testid="vnext-worker-remove-duplicates" />
      <SpreadsheetFilterDropdown data-testid="vnext-worker-filter-dropdown" />
      <SpreadsheetConditionalFormatDialog data-testid="vnext-worker-conditional-format" />
      <SpreadsheetDataValidationDialog data-testid="vnext-worker-data-validation" />
      <SpreadsheetNameManagerDialog data-testid="vnext-worker-name-manager" />
      <SpreadsheetPasteSpecialDialog data-testid="vnext-worker-paste-special" />
      <SpreadsheetCommentThread data-testid="vnext-worker-comment-thread" />
      <SpreadsheetPrintPreviewOverlay data-testid="vnext-worker-print-preview" />
      <SpreadsheetProtectionUnlockDialog data-testid="vnext-worker-protection-unlock" />
      <SpreadsheetHistoryTimeline data-testid="vnext-worker-history-timeline" />
      <SpreadsheetPresenceOverlay data-testid="vnext-worker-presence" />
      <SpreadsheetFormulaAutocomplete
        data-testid="vnext-worker-formula-autocomplete"
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

type BackendChoice = 'ts' | 'wasm'

function readBackendChoice(): BackendChoice {
  if (typeof window === 'undefined') return 'wasm'
  const choice = new URLSearchParams(window.location.search).get('backend')
  return choice === 'ts' ? 'ts' : 'wasm'
}

function pickWorkerFactory(choice: BackendChoice) {
  return choice === 'ts' ? defaultExcelCoreTsWorkerFactory : defaultVNextWorkbookWorkerFactory
}

export function VNextWorkerDemo() {
  const backendChoice = readBackendChoice()
  const namedRangeCapabilityPort = createWorkerNamedRangeCapabilityPort(
    backendChoice === 'ts' ? 'worker-ts' : 'worker-wasm',
  )
  const backendDescription =
    backendChoice === 'ts' ? 'the in-process TS core' : 'the Rust workbook worker'

  const backend = createWorkerWorkbookSpreadsheetBackend({
    workerFactory: pickWorkerFactory(backendChoice),
    sheets,
    removeRowsExactCapability: backendChoice === 'wasm' ? 'worker-engine-delete-rows' : false,
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
          vNext UI backed by {backendDescription} through the framework-agnostic backend port.
        </p>
        <p class="demo-desc" data-testid="custom-formulas-banner">
          Custom formulas registered: <code>MYTAX</code>, <code>GREET</code>, <code>CELSIUS</code>,{' '}
          <code>SUMSQ2</code>. Try <code>=MYTAX(B4)</code> or <code>=SUMSQ2(B2:B4)</code> in any
          cell.
        </p>
      </div>

      <SpreadsheetUiProvider backend={backend} namedRangeCapabilityPort={namedRangeCapabilityPort}>
        <VNextWorkerWorkbook />
      </SpreadsheetUiProvider>
    </div>
  )
}
