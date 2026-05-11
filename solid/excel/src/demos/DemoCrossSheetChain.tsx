import { For, Show, createEffect, createResource, createSignal, onCleanup } from 'solid-js'
import { Table } from '../Table'
import {
  createThreeSheetChainWorkbookStore,
  type WasmWorkbookStore,
} from '../wasm-workbook-store'

export function DemoCrossSheetChain() {
  const [lazyProbeState, setLazyProbeState] = createSignal('pending')
  const [workbookRes] = createResource<WasmWorkbookStore>(async () => {
    const workbook = await createThreeSheetChainWorkbookStore()
    seed(workbook)
    return workbook
  })

  createEffect(() => {
    const workbook = workbookRes()
    if (!workbook) return
    workbook.activeIdx()
    workbook.revision()
    queueMicrotask(() => {
      setLazyProbeState(workbook.formulaCacheState(1, 'C5'))
    })
  })

  onCleanup(() => workbookRes()?.dispose())

  return (
    <Show
      when={workbookRes()}
      fallback={<div class="demo-page"><p>Loading WASM workbook…</p></div>}
    >
      {(workbook) => (
        <div class="demo-page">
          <div class="demo-header">
            <h3>3-Sheet Dependency Chain</h3>
            <p class="demo-desc">
              <code>Sheet1!C2</code> → <code>Sheet2!C2</code> →{' '}
              <code>Sheet3!C2</code> → <code>Sheet1!B4</code>
            </p>
            <p class="demo-desc">
              Lazy probe: <code>Sheet2!C5</code> = <code>Sheet3!B4+5</code>,
              cache <code data-cache-state="Sheet2!C5">{lazyProbeState()}</code>
            </p>
          </div>

          <Show when={workbook().activeStore()} keyed>
            {(store) => <Table store={store} rows={10} cols={6} formulaBar />}
          </Show>

          <div class="sheet-tabs" role="tablist">
            <For each={workbook().sheets()}>
              {(meta) => {
                const isActive = () => workbook().activeIdx() === meta.idx
                return (
                  <button
                    type="button"
                    role="tab"
                    class={`sheet-tab ${isActive() ? 'sheet-tab-active' : ''}`}
                    onClick={() => workbook().setActiveIdx(meta.idx)}
                    aria-selected={isActive()}
                  >
                    {meta.name}
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      )}
    </Show>
  )
}

function seed(workbook: WasmWorkbookStore) {
  const sheet1 = workbook.sheetAt(0)!
  const sheet2 = workbook.sheetAt(1)!
  const sheet3 = workbook.sheetAt(2)!

  sheet1.setText('A1', 'Sheet1')
  sheet1.setText('A2', 'cell1')
  sheet1.setText('B2', 'result')
  sheet1.setFormula('C2', '=Sheet2!C2+1')
  sheet1.setText('A4', 'cell4')
  sheet1.setNumber('B4', 10)
  sheet1.setText('C4', 'source')

  sheet2.setText('A1', 'Sheet2')
  sheet2.setText('A2', 'cell2')
  sheet2.setText('B2', 'result')
  sheet2.setFormula('C2', '=Sheet3!C2+1')
  sheet2.setText('A5', 'lazy demo')
  sheet2.setText('B5', 'result')
  sheet2.setFormula('C5', '=Sheet3!B4+5')

  sheet3.setText('A1', 'Sheet3')
  sheet3.setText('A2', 'cell3')
  sheet3.setText('B2', 'result')
  sheet3.setFormula('C2', '=Sheet1!B4+1')
  sheet3.setText('A4', 'source')
  sheet3.setNumber('B4', 100)

  workbook.setActiveIdx(0)
}
