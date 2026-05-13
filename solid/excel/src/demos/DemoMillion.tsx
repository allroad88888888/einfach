import { Show, createResource, onCleanup } from 'solid-js'
import { Table } from '../Table'
import type { SheetStore } from '../sheet-store'
import type { ImportCellWire, WorkerWorkbookClient } from '../wasm-workbook-proxy'
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
    __einfachBackend?: string
  }
}

/**
 * Debug-only: when `?debug=1` (or `?debug=render`) the active store is
 * stashed on `window.__einfachStore` so the Track P viewport e2e can
 * probe `activeSubscriptionCount()` from the browser side. Matches the
 * pattern used by DemoBlank / DemoFormulas / DemoLarge. Off otherwise.
 */
function exposeStoreForDebug(store: SheetStore, workbook: WasmWorkbookStore) {
  if (typeof window === 'undefined') return
  const debug = new URLSearchParams(window.location.search).get('debug')
  if (debug !== '1' && debug !== 'render') return
  window.__einfachStore = store
  window.__einfachWorkbookStore = workbook
  window.__einfachBackend = 'worker-workbook'
}

function clearStoreForDebug(store: SheetStore, workbook: WasmWorkbookStore) {
  if (typeof window === 'undefined') return
  if (window.__einfachStore === store) {
    delete window.__einfachStore
  }
  if (window.__einfachWorkbookStore === workbook) {
    delete window.__einfachWorkbookStore
  }
  if (window.__einfachBackend === 'worker-workbook') {
    delete window.__einfachBackend
  }
}

const ROWS = 1000
const COLS = 1000

export function DemoMillion() {
  const t = useT()
  const [workbookRes] = createResource<WasmWorkbookStore>(async () => {
    const workbook = await createWorkerWorkbookStore({
      workerFactory: defaultWorkbookWorkerFactory,
      sheets: ['Sheet1'],
      afterInit: seedWorkbook,
    })
    const store = workbook.activeStore()
    exposeStoreForDebug(store, workbook)
    return workbook
  })
  onCleanup(() => {
    const workbook = workbookRes()
    if (!workbook) return
    const store = workbook.activeStore()
    clearStoreForDebug(store, workbook)
    workbook.dispose()
  })

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
          <Table store={workbook().activeStore()} rows={ROWS} cols={COLS} virtualize formulaBar />
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
  const cells: ImportCellWire[] = []

  // 1) Numeric base + 49-deep chain in column A. Reading A50 walks 49
  //    levels; reading any cell mid-chain forces incremental lazy eval.
  cells.push({ sheet: 0, row: 0, col: 0, kind: 'number', value: 1 })
  for (let r = 2; r <= 50; r++) {
    cells.push({ sheet: 0, row: r - 1, col: 0, kind: 'formula', value: `=A${r - 1}+1` })
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
    cells.push({ sheet: 0, row, col, kind: 'number', value: idx })
  }

  // 3) Far-corner anchors so users see content at the deep corners.
  cells.push({
    sheet: 0,
    row: 499,
    col: 702,
    kind: 'text',
    value: 'You scrolled to AAA500',
  })
  cells.push({
    sheet: 0,
    row: 998,
    col: 999,
    kind: 'text',
    value: 'Bottom-right corner (col ALL, row 999)',
  })

  const session = await client.beginImport()
  try {
    const chunkSize = 500
    for (let i = 0; i < cells.length; i += chunkSize) {
      await client.importChunk(session, cells.slice(i, i + chunkSize))
    }
    await client.commitImport(session)
  } catch (err) {
    await client.cancelImport(session).catch(() => false)
    throw err
  }
}
