import { Show, createResource, createSignal, onCleanup } from 'solid-js'
import { Table } from '../Table'
import type { SheetStore } from '../sheet-store'
import { importDelimitedFileToWorkbook, type ImportProgress } from '../file-import'
import type {
  ImportCellWire,
  WorkerWorkbookClient,
  WorkbookImportStatsWire,
} from '../wasm-workbook-proxy'
import { createWorkerWorkbookStore, type WasmWorkbookStore } from '../wasm-workbook-store'
import { defaultWorkbookWorkerFactory } from '../wasm-workbook-worker-factory'
import { useT } from '../i18n'

/**
 * Phase 4 Track O — 1M-cell worker-backed demo.
 *
 * 1000 × 1000 = 1,000,000 addressable cells. The engine lives on a Web
 * Worker-owned workbook and only ~2000 cells are
 * actually seeded; the rest of the coord space stays sparse. Lazy
 * formula eval + two-dimensional viewport virtualization mean the main
 * thread never has to touch the unseeded ~99.8% of cells.
 *
 * Seed pattern (~2002 cells total):
 *   - Numeric base at A1 = 1.
 *   - 49-deep formula chain in column A: A2 = A1+1, A3 = A2+1, … A50.
 *     Reading A50 forces a lazy walk through 49 formula evaluations.
 *   - Scattered numeric cells: every 500th flat address across the
 *     full 1,000,000-cell space (≈ 2000 cells, minus ~50 chain-region
 *     collisions). The flat-address stride gives users something to
 *     find regardless of where they scroll.
 *   - Far-coord anchors `AAA500` and `ALL999` (last col, last row) so
 *     scrolling to the corners reveals content.
 *
 * Pre-Track-M the `virtualize` prop is still required to keep the DOM
 * bounded; once Track M lands the new VGridTable-based Table will
 * always virtualize and the prop becomes a no-op. Leaving it in keeps
 * this demo functional in isolation; an integrator can drop the prop
 * in a follow-up sweep.
 */

declare global {
  interface Window {
    __einfachStore?: SheetStore
    __einfachWorkbookStore?: WasmWorkbookStore
    __einfachWorkbookDebugClient?: WorkerWorkbookClient
    __einfachBackend?: string
  }
}

/**
 * Debug-only: when `?debug=1` (or `?debug=render`) the active store is
 * stashed on `window.__einfachStore` so the Track P viewport e2e can
 * probe `activeSubscriptionCount()` from the browser side. Matches the
 * pattern used by DemoBlank / DemoFormulas / DemoLarge. Off otherwise.
 */
function exposeStoreForDebug(
  store: SheetStore,
  workbook: WasmWorkbookStore,
  client: WorkerWorkbookClient,
) {
  if (typeof window === 'undefined') return
  const debug = new URLSearchParams(window.location.search).get('debug')
  if (debug !== '1' && debug !== 'render') return
  window.__einfachStore = store
  window.__einfachWorkbookStore = workbook
  window.__einfachWorkbookDebugClient = client
  window.__einfachBackend = 'worker-workbook'
}

function clearStoreForDebug(
  store: SheetStore,
  workbook: WasmWorkbookStore,
  client: WorkerWorkbookClient | undefined,
) {
  if (typeof window === 'undefined') return
  if (window.__einfachStore === store) {
    delete window.__einfachStore
  }
  if (window.__einfachWorkbookStore === workbook) {
    delete window.__einfachWorkbookStore
  }
  if (client && window.__einfachWorkbookDebugClient === client) {
    delete window.__einfachWorkbookDebugClient
  }
  if (window.__einfachBackend === 'worker-workbook') {
    delete window.__einfachBackend
  }
}

const ROWS = 1000
const COLS = 1000

type ImportUiState = ImportProgress & {
  fileName: string
  stats?: WorkbookImportStatsWire
  error?: string
}

const EMPTY_IMPORT_STATE: ImportUiState = {
  fileName: '',
  rowsRead: 0,
  cellsQueued: 0,
  cellsImported: 0,
  chunks: 0,
  status: 'running',
}

export function DemoMillion() {
  const t = useT()
  const [importState, setImportState] = createSignal<ImportUiState | null>(null)
  let importClient: WorkerWorkbookClient | undefined
  let importAbort: AbortController | undefined

  const [workbookRes] = createResource<WasmWorkbookStore>(async () => {
    const workbook = await createWorkerWorkbookStore({
      workerFactory: defaultWorkbookWorkerFactory,
      sheets: ['Sheet1'],
      afterInit: async (client) => {
        importClient = client
        await seedWorkbook(client)
      },
    })
    const store = workbook.activeStore()
    if (importClient) exposeStoreForDebug(store, workbook, importClient)
    return workbook
  })
  onCleanup(() => {
    importAbort?.abort()
    const workbook = workbookRes()
    if (!workbook) return
    const store = workbook.activeStore()
    clearStoreForDebug(store, workbook, importClient)
    workbook.dispose()
  })

  async function importFile(file: File) {
    const workbook = workbookRes()
    if (!workbook || !importClient) return

    importAbort?.abort()
    const controller = new AbortController()
    importAbort = controller
    setImportState({
      ...EMPTY_IMPORT_STATE,
      fileName: file.name,
      status: 'running',
    })

    try {
      const result = await importDelimitedFileToWorkbook(importClient, file, {
        signal: controller.signal,
        onProgress: (progress) => {
          setImportState({
            ...progress,
            fileName: file.name,
          })
        },
      })

      if (result.status === 'committed') {
        workbook.refreshVisible()
      }
      setImportState({
        fileName: file.name,
        rowsRead: result.rowsRead,
        cellsQueued: result.cellsQueued,
        cellsImported: result.cellsImported,
        chunks: result.chunks,
        status: result.status,
        stats: result.stats,
        error: result.error?.message,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      setImportState((prev) => ({
        ...(prev ?? EMPTY_IMPORT_STATE),
        fileName: file.name,
        status: 'failed',
        error,
      }))
    } finally {
      if (importAbort === controller) importAbort = undefined
    }
  }

  function handleImportInput(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    void importFile(file).finally(() => {
      input.value = ''
    })
  }

  function cancelImport() {
    importAbort?.abort()
  }

  function importStatusText(state: ImportUiState) {
    switch (state.status) {
      case 'running':
      case 'flushing':
        return t('demo.million.import.status.running')
      case 'committed':
        return t('demo.million.import.status.committed')
      case 'cancelled':
        return t('demo.million.import.status.cancelled')
      case 'failed':
        return t('demo.million.import.status.failed')
    }
  }

  function importStatsText(state: ImportUiState) {
    const accepted = state.stats?.accepted ?? state.cellsImported
    const errors = state.stats?.errors ?? 0
    return t('demo.million.import.stats')
      .replace('{rows}', String(state.rowsRead))
      .replace('{cells}', String(accepted))
      .replace('{chunks}', String(state.chunks))
      .replace('{errors}', String(errors))
  }

  const importing = () => {
    const status = importState()?.status
    return status === 'running' || status === 'flushing'
  }

  return (
    <Show
      when={workbookRes()}
      fallback={
        <div class="demo-page">
          <p>Loading worker backend…</p>
        </div>
      }
    >
      {(workbook) => (
        <div class="demo-page">
          <div class="demo-header">
            <h3>{t('demo.million.title')}</h3>
            <p class="demo-desc">{t('demo.million.desc')}</p>
          </div>
          <div class="import-toolbar">
            <label class="import-file-label">
              <span>{t('demo.million.import.choose')}</span>
              <input
                data-testid="million-import-input"
                class="import-file-input"
                type="file"
                accept=".csv,.tsv,.tab,text/csv,text/tab-separated-values"
                disabled={importing()}
                onChange={handleImportInput}
              />
            </label>
            <Show when={importing()}>
              <button
                data-testid="million-import-cancel"
                class="import-cancel-btn"
                type="button"
                onClick={cancelImport}
              >
                {t('demo.million.import.cancel')}
              </button>
            </Show>
            <Show when={importState()}>
              {(state) => (
                <>
                  <span data-testid="million-import-status" class="import-status">
                    {importStatusText(state())}
                  </span>
                  <span data-testid="million-import-stats" class="import-stats">
                    {importStatsText(state())}
                  </span>
                  <Show when={state().status === 'failed' && state().error}>
                    <span data-testid="million-import-error" class="import-error">
                      {state().error}
                    </span>
                  </Show>
                </>
              )}
            </Show>
          </div>
          <Table store={workbook().activeStore()} rows={ROWS} cols={COLS} virtualize formulaBar toolbar />
        </div>
      )}
    </Show>
  )
}

/**
 * Seed ~2000 cells scattered across the 1M coord space.
 *
 * Total cells touched (counted at write time):
 *   - 1 anchor at A1.
 *   - 49 formula chain rows (A2..A50).
 *   - ~2000 scattered numeric cells at every 500th flat address,
 *     skipping any address that lands inside the col-A chain region
 *     (col 0, rows 0..49) so we don't clobber the chain.
 *   - 2 far-corner anchors (AAA500, ALL999).
 */
async function seedWorkbook(client: WorkerWorkbookClient) {
  const session = await client.beginImport()
  const chunkSize = 500
  let chunk: ImportCellWire[] = []

  async function pushCell(cell: ImportCellWire) {
    chunk.push(cell)
    if (chunk.length < chunkSize) return
    await client.importChunk(session, chunk)
    chunk = []
  }

  async function flushChunk() {
    if (chunk.length === 0) return
    await client.importChunk(session, chunk)
    chunk = []
  }

  try {
    // 1) Numeric base + 49-deep chain in column A. Reading A50 walks 49
    //    levels; reading any cell mid-chain forces incremental lazy eval.
    await pushCell({ sheet: 0, row: 0, col: 0, kind: 'number', value: 1 })
    for (let r = 2; r <= 50; r++) {
      await pushCell({ sheet: 0, row: r - 1, col: 0, kind: 'formula', value: `=A${r - 1}+1` })
    }

    // 2) Scattered numeric cells — every 500th flat address (1,000,000 /
    //    500 ≈ 2000 cells). Flat address encoding: idx = row * COLS + col.
    //    Skip the chain region (col 0, rows 0..49) so the formulas stay
    //    intact — that's ~50 skipped, net ~1950 scattered.
    const TOTAL = ROWS * COLS
    for (let idx = 0; idx < TOTAL; idx += 500) {
      const row = Math.floor(idx / COLS)
      const col = idx % COLS
      if (col === 0 && row < 50) continue
      await pushCell({ sheet: 0, row, col, kind: 'number', value: idx })
    }

    // 3) Far-corner anchors so users see content at the deep corners.
    await pushCell({
      sheet: 0,
      row: 499,
      col: 702,
      kind: 'text',
      value: 'You scrolled to AAA500',
    })
    await pushCell({
      sheet: 0,
      row: 998,
      col: 999,
      kind: 'text',
      value: 'Bottom-right corner (col ALL, row 999)',
    })

    await flushChunk()
    await client.commitImport(session)
  } catch (err) {
    await client.cancelImport(session).catch(() => false)
    throw err
  }
}
