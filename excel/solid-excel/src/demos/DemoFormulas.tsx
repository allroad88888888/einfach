
import { Show, createResource, onCleanup } from 'solid-js'
import { Table } from '../Table'
import { createSheetStore, type SheetStore } from '../sheet-store'
import { createWasmSheet } from '../wasm-sheet'
import { useT } from '../i18n'

/**
 * Demo 2: 公式演示 — 展示各种公式能力
 *
 * Uses the real Rust + WASM backend so SUM / AVERAGE / COUNT / MIN / MAX /
 * IF render real numbers on first paint. The other demos still use
 * `createJSSheet` (which has only a subset of the formula evaluator);
 * switching them is a one-line swap of the factory below.
 */
export function DemoFormulas() {
  const t = useT()
  const [storeRes] = createResource<SheetStore>(async () => {
    const sheet = await createWasmSheet()
    const store = createSheetStore(sheet)
    seed(store)
    exposeStoreForDebug(store)
    return store
  })
  onCleanup(() => {
    const store = storeRes()
    if (store && window.__einfachStore === store) {
      delete window.__einfachStore
    }
  })

  return (
    <Show
      when={storeRes()}
      fallback={<div class="demo-page"><p>Loading WASM backend…</p></div>}
    >
      {(store) => (
        <div class="demo-page">
          <div class="demo-header">
            <h3>{t('demo.formulas.title')}</h3>
            <p class="demo-desc">
              {t('demo.formulas.desc.beforeDiv')} <code>#DIV/0!</code>{' '}
              {t('demo.formulas.desc.afterDiv')}
            </p>
          </div>
          <Table store={store()} rows={18} cols={10} formulaBar toolbar />
        </div>
      )}
    </Show>
  )
}

/**
 * Debug-only: stash the WASM-backed SheetStore on `window.__einfachStore`
 * when the URL has `?debug=1` (or `?debug=render`). Mirrors DemoBlank's
 * exposure but here it's a WasmSheet underneath, so e2e specs can call
 * `store.raw.__debugPanicNextCallback()` for the panic regression test.
 * Cleared on demo unmount.
 */
declare global {
  interface Window {
    __einfachStore?: SheetStore
  }
}

function exposeStoreForDebug(store: SheetStore) {
  if (typeof window === 'undefined') return
  const debug = new URLSearchParams(window.location.search).get('debug')
  if (debug !== '1' && debug !== 'render') return
  window.__einfachStore = store
}

/** Seed the demo grid. Split out so the loading branch stays tiny. */
function seed(store: SheetStore) {
  // --- Section 1: 基础算术 ---
  store.setText('A1', 'Arithmetic')
  store.setText('A2', 'a')
  store.setText('B2', 'b')
  store.setText('C2', 'a + b')
  store.setText('D2', 'a * b')
  store.setText('E2', 'a / b')
  store.setText('F2', '(a+b)*2')

  store.setNumber('A3', 10)
  store.setNumber('B3', 3)
  store.setFormula('C3', '=A3+B3')
  store.setFormula('D3', '=A3*B3')
  store.setFormula('E3', '=A3/B3')
  store.setFormula('F3', '=(A3+B3)*2')

  store.setNumber('A4', 100)
  store.setNumber('B4', 0)
  store.setFormula('C4', '=A4+B4')
  store.setFormula('D4', '=A4*B4')
  store.setFormula('E4', '=A4/B4')   // #DIV/0!
  store.setFormula('F4', '=(A4+B4)*2')

  // --- Section 2: 内置函数 ---
  store.setText('A6', 'Functions')
  store.setText('A7', 'Data')
  store.setNumber('A8', 85)
  store.setNumber('A9', 92)
  store.setNumber('A10', 78)
  store.setNumber('A11', 95)
  store.setNumber('A12', 60)

  store.setText('C7', 'Function')
  store.setText('D7', 'Result')

  store.setText('C8', 'SUM')
  store.setFormula('D8', '=SUM(A8,A9,A10,A11,A12)')

  store.setText('C9', 'AVERAGE')
  store.setFormula('D9', '=AVERAGE(A8,A9,A10,A11,A12)')

  store.setText('C10', 'COUNT')
  store.setFormula('D10', '=COUNT(A8,A9,A10,A11,A12)')

  store.setText('C11', 'MIN')
  store.setFormula('D11', '=MIN(A8,A9,A10,A11,A12)')

  store.setText('C12', 'MAX')
  store.setFormula('D12', '=MAX(A8,A9,A10,A11,A12)')

  // --- Section 3: IF 条件 ---
  store.setText('A14', 'IF Condition')
  store.setText('A15', 'Score')
  store.setText('B15', 'Pass?')

  store.setNumber('A16', 85)
  store.setFormula('B16', '=IF(A16,1,0)')

  store.setNumber('A17', 0)
  store.setFormula('B17', '=IF(A17,1,0)')

  // --- Section 4: 公式链 ---
  store.setText('F6', 'Chain')
  store.setText('F7', 'Base')
  store.setText('G7', 'x2')
  store.setText('H7', 'x2+10')
  store.setText('I7', 'Final*3')

  store.setNumber('F8', 5)
  store.setFormula('G8', '=F8*2')
  store.setFormula('H8', '=G8+10')
  store.setFormula('I8', '=H8*3')
}
