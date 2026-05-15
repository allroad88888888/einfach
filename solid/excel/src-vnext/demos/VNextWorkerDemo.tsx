import { onCleanup, onMount, Show } from 'solid-js'
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
import { SpreadsheetContextMenu } from '../context-menu'
import { SpreadsheetFormulaBar } from '../formula-bar'
import { SpreadsheetGrid } from '../grid'
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

async function seedWorkerWorkbook(
  client: WorkerWorkbookClient,
  initializedSheets: WorkerWorkbookBackendSheet[],
) {
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

  await client.setCell(sheet3, 'A1', { type: 'text', value: 'Sheet3' })
  await client.setCell(sheet3, 'A2', { type: 'text', value: 'cell3' })
  await client.setCell(sheet3, 'B2', { type: 'text', value: 'depends on Sheet1!B4' })
  await client.setFormulaDetailed(sheet3, 'C2', '=Sheet1!B4+1')
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
          <SpreadsheetGrid
            sheetId={sheetId}
            viewport={viewport}
            data-testid="vnext-worker-grid"
          />
        )}
      </Show>
      <SpreadsheetSheetTabs sheets={sheets} data-testid="vnext-worker-sheet-tabs" />
      <SpreadsheetStatusBar data-testid="vnext-worker-status-bar" />
      <SpreadsheetContextMenu data-testid="vnext-worker-context-menu" />
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
