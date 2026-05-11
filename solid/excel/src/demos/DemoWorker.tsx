
import { onCleanup } from 'solid-js'
import { Table } from '../Table'
import { createSheetStore, type SheetStore } from '../sheet-store'
import { createWorkerSheet } from '../wasm-sheet-proxy'
import { defaultWorkerFactory } from '../wasm-sheet-worker-factory'

/**
 * 7C — Web Worker–backed sheet.
 *
 * Identical to the other WASM demos from the user's perspective, but the
 * actual `WasmSheet` instance lives in a dedicated Worker thread. The main
 * thread keeps a tiny `ISheet`-shaped proxy that:
 *
 *   - mirrors a local cache for sync reads,
 *   - posts mutations through `postMessage`,
 *   - hydrates the cache on first read via `read_initial`,
 *   - fires Solid signals when the worker pushes change diffs back.
 *
 * Heavy compute (long formula chains, big imports) runs off the main
 * thread, so scrolling / keyboard input stay smooth.
 */
export function DemoWorker() {
  const sheet = createWorkerSheet({ workerFactory: defaultWorkerFactory })
  const store = createSheetStore(sheet)
  onCleanup(() => store.dispose())

  seed(store)

  return (
    <div class="demo-page">
      <div class="demo-header">
        <h3>Worker-backed Sheet (7C)</h3>
        <p class="demo-desc">
          WASM runs in a Web Worker; the main thread only ferries diffs.
          Type into cells, create formulas — same Excel demo, just with
          the compute on a separate thread. Useful for very heavy
          recompute workloads (the UI stays responsive).
        </p>
      </div>
      <Table store={store} rows={10} cols={6} formulaBar />
    </div>
  )
}

function seed(store: SheetStore) {
  store.setText('A1', 'Item')
  store.setText('B1', 'Qty')
  store.setText('C1', 'Price')
  store.setText('D1', 'Total')

  store.setText('A2', 'Apple')
  store.setNumber('B2', 3)
  store.setNumber('C2', 1.5)
  store.setFormula('D2', '=B2*C2')

  store.setText('A3', 'Banana')
  store.setNumber('B3', 6)
  store.setNumber('C3', 0.5)
  store.setFormula('D3', '=B3*C3')

  store.setText('A4', 'Cherry')
  store.setNumber('B4', 10)
  store.setNumber('C4', 2)
  store.setFormula('D4', '=B4*C4')

  store.setText('A6', 'Grand total')
  store.setFormula('D6', '=SUM(D2,D3,D4)')
}
