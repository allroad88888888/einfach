import { Show, createResource, onCleanup } from 'solid-js'
import { Table } from '../Table'
import { SheetTabs } from '../SheetTabs'
import { useT } from '../i18n'
import {
  type ImportCellWire,
  type WorkerWorkbookClient as ProxyWorkerClient,
} from '../wasm-workbook-proxy'
import { createWorkerWorkbookStore, type WasmWorkbookStore } from '../wasm-workbook-store'
import { defaultWorkbookWorkerFactory } from '../wasm-workbook-worker-factory'

/**
 * Demo 6: Multi-sheet workbook with a tab bar.
 *
 * Backed by `createWorkerWorkbookStore()` so add/rename/delete and
 * all sheet lookups run through the worker-owned workbook. This keeps
 * formula evaluation (including cross-sheet references) on the Rust/WASM
 * path and avoids JS mock evaluator limitations.
 */
declare global {
  interface Window {
    __einfachBackend?: string
    __einfachWorkbookDebugClient?: ProxyWorkerClient
    __einfachDebug?: {
      backend: 'worker-workbook'
      store: {
        sheets: () => Array<{ idx: number; name: string }>
        activeIdx: () => number
      }
      client: ProxyWorkerClient
      counters: () => Promise<unknown> | unknown
    }
  }
}

type MultiSheetResource = {
  workbook: WasmWorkbookStore
  client: ProxyWorkerClient
}

const IMPORT_CHUNK_SIZE = 128

function exposeDebugState(workbook: WasmWorkbookStore, client: ProxyWorkerClient) {
  if (typeof window === 'undefined') return
  const debug = new URLSearchParams(window.location.search).get('debug')
  if (debug !== '1' && debug !== 'render') return

  window.__einfachBackend = 'worker-workbook'
  window.__einfachWorkbookDebugClient = client
  window.__einfachDebug = {
    backend: 'worker-workbook',
    store: {
      sheets: workbook.sheets,
      activeIdx: workbook.activeIdx,
    },
    client,
    counters: () => client.debugCounters?.(),
  }
}

async function seedWorkbook(client: ProxyWorkerClient) {
  const sessionId = await client.beginImport()
  const cells: ImportCellWire[] = []

  const flush = async () => {
    if (cells.length === 0) return
    await client.importChunk(sessionId, cells.splice(0))
  }

  const pushCell = async (cell: ImportCellWire) => {
    cells.push(cell)
    if (cells.length >= IMPORT_CHUNK_SIZE) {
      await flush()
    }
  }

  try {
    const sheet1 = 0
    const sheet2 = 1
    const sheet3 = 2

    // Sheet1 — base summary with a cross-sheet total formula.
    await pushCell({ sheet: sheet1, row: 0, col: 0, kind: 'text', value: 'Quarter' })
    await pushCell({ sheet: sheet1, row: 0, col: 1, kind: 'text', value: 'Revenue' })
    await pushCell({ sheet: sheet1, row: 0, col: 2, kind: 'text', value: 'Profit' })
    await pushCell({ sheet: sheet1, row: 1, col: 0, kind: 'text', value: 'Q1' })
    await pushCell({ sheet: sheet1, row: 1, col: 1, kind: 'number', value: 12000 })
    await pushCell({ sheet: sheet1, row: 1, col: 2, kind: 'number', value: 3200 })
    await pushCell({ sheet: sheet1, row: 2, col: 0, kind: 'text', value: 'Q2' })
    await pushCell({ sheet: sheet1, row: 2, col: 1, kind: 'number', value: 14500 })
    await pushCell({ sheet: sheet1, row: 2, col: 2, kind: 'number', value: 4100 })
    await pushCell({ sheet: sheet1, row: 3, col: 0, kind: 'text', value: 'Q3' })
    await pushCell({ sheet: sheet1, row: 3, col: 1, kind: 'number', value: 11800 })
    await pushCell({ sheet: sheet1, row: 3, col: 2, kind: 'number', value: 2900 })
    await pushCell({ sheet: sheet1, row: 4, col: 0, kind: 'text', value: 'Total' })
    await pushCell({ sheet: sheet1, row: 4, col: 1, kind: 'formula', value: '=Expenses!B5' })
    await pushCell({ sheet: sheet1, row: 4, col: 2, kind: 'formula', value: '=C2+C3+C4' })

    // Sheet2 — Expenses.
    await pushCell({ sheet: sheet2, row: 0, col: 0, kind: 'text', value: 'Category' })
    await pushCell({ sheet: sheet2, row: 0, col: 1, kind: 'text', value: 'Amount' })
    await pushCell({ sheet: sheet2, row: 1, col: 0, kind: 'text', value: 'Rent' })
    await pushCell({ sheet: sheet2, row: 1, col: 1, kind: 'number', value: 2500 })
    await pushCell({ sheet: sheet2, row: 2, col: 0, kind: 'text', value: 'Salaries' })
    await pushCell({ sheet: sheet2, row: 2, col: 1, kind: 'number', value: 8000 })
    await pushCell({ sheet: sheet2, row: 3, col: 0, kind: 'text', value: 'Marketing' })
    await pushCell({ sheet: sheet2, row: 3, col: 1, kind: 'number', value: 1200 })
    await pushCell({ sheet: sheet2, row: 4, col: 0, kind: 'text', value: 'Total' })
    await pushCell({ sheet: sheet2, row: 4, col: 1, kind: 'formula', value: '=B2+B3+B4' })
    await pushCell({ sheet: sheet2, row: 4, col: 2, kind: 'formula', value: '=Notes!B1+1' })

    // Sheet3 — Notes / scratch.
    await pushCell({
      sheet: sheet3,
      row: 0,
      col: 0,
      kind: 'text',
      value: 'Try editing each sheet — switching tabs preserves state.',
    })
    await pushCell({ sheet: sheet3, row: 0, col: 1, kind: 'number', value: 40 })
    await pushCell({
      sheet: sheet3,
      row: 1,
      col: 0,
      kind: 'text',
      value: 'Right-click a tab to rename or delete it.',
    })
    await pushCell({
      sheet: sheet3,
      row: 2,
      col: 0,
      kind: 'text',
      value: 'Click + to add a new sheet.',
    })
    await pushCell({
      sheet: sheet3,
      row: 3,
      col: 0,
      kind: 'text',
      value: 'Cross-sheet formulas work here, e.g. =Expenses!B5.',
    })

    await flush()
    await client.commitImport(sessionId)
  } catch (error) {
    await client.cancelImport(sessionId).catch(() => false)
    throw error
  }
}

export function MultiSheet() {
  const t = useT()
  const [resource] = createResource<MultiSheetResource>(async () => {
    let initClient: ProxyWorkerClient | undefined
    const workbook = await createWorkerWorkbookStore({
      workerFactory: defaultWorkbookWorkerFactory,
      sheets: ['Sheet1', 'Expenses', 'Notes'],
      afterInit: async (client) => {
        initClient = client
        await seedWorkbook(client)
      },
    })

    if (!initClient) {
      throw new Error('MultiSheet initialization missing worker client')
    }

    exposeDebugState(workbook, initClient)
    return { workbook, client: initClient }
  })

  onCleanup(() => {
    const loaded = resource()
    if (!loaded) return
    loaded.workbook.dispose()
    if (window.__einfachWorkbookDebugClient === loaded.client) {
      delete window.__einfachWorkbookDebugClient
    }
    if (window.__einfachDebug?.client === loaded.client) {
      delete window.__einfachDebug
    }
    if (window.__einfachBackend === 'worker-workbook') {
      delete window.__einfachBackend
    }
  })

  return (
    <Show
      when={resource()}
      fallback={
        <div class="demo-page">
          <p>Loading worker workbook…</p>
        </div>
      }
    >
      {(loaded) => {
        const { workbook } = loaded()
        const tableKey = () =>
          `${workbook.activeIdx()}|${workbook
            .sheets()
            .map((sheet) => `${sheet.idx}:${sheet.name}`)
            .join('|')}`
        return (
          <div class="demo-page">
            <div class="demo-header">
              <h3>{t('demo.multi.title')}</h3>
              <p class="demo-desc">
                {t('demo.multi.desc.beforePlus')} <code>+</code> {t('demo.multi.desc.afterPlus')}
              </p>
            </div>
            {/*
            Re-mount Table when the active sheet changes. Two reasons we
            prefer keyed re-mount over a live prop swap here:
              1. Cell components hold local edit state (editing / editValue
                 signals). Swapping the store under them would leak edit
                 state across sheets — the user would see "currently typing
                 into A1 of Sheet1" when they hit the Expenses tab.
              2. Each SheetStore has its own per-cell signal handles; a
                 clean re-mount lets old Cell computations dispose and new
                 ones subscribe to the active sheet's signals fresh, which
                 is the simplest correctness story.
            The previous SheetStore stays alive (the workbook holds it), so
            switching back is cheap — just a fresh Table component tree.
          */}
            {/*
            keyed on active sheet plus sheet metadata. Worker-backed structure
            mutations rebuild all SheetStore instances, so active-idx alone is
            not enough when deleting a non-active sheet.
          */}
            <Show when={tableKey()} keyed>
              {(_key) => <Table store={workbook.activeStore()} rows={20} cols={10} formulaBar />}
            </Show>
            <SheetTabs workbook={workbook} />
          </div>
        )
      }}
    </Show>
  )
}
